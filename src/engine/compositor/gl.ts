// WebGL2 compositor. Each layer is one full-frame pass that reads the picture so
// far and the layer texture, so every blend mode is computed exactly in the shader.
import { invertAffine, type FramePlan, type LayerPlan } from '../../core/render/plan.ts';
import type { BlendMode } from '../../core/model.ts';

export type LayerImage = TexImageSource | null;
export interface Compositor {
  readonly backend: 'webgl2' | 'canvas2d';
  /** Draw the plan at `scale` (1, 0.5 or 0.25 of sequence size). `images[i]` belongs to `plan.layers[i]`; null = media offline. */
  render(plan: FramePlan, images: readonly LayerImage[], scale: number): void;
  /** RGBA pixels of the last render, top row first. */
  readPixels(): Uint8Array;
  dispose(): void;
}

export const OFFLINE_RGB: [number, number, number] = [90, 22, 26];
const BLEND_INDEX: Record<BlendMode, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, darken: 5, lighten: 6, difference: 7 };

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform mat3 uInv;      // sequence pixels -> layer unit square
uniform vec4 uUv;       // visible part of the upright picture
uniform vec2 uOut;      // output size in pixels
uniform float uScale;   // output pixels per sequence pixel
uniform float uOpacity;
uniform int uRot;
uniform int uBlend;
out vec4 color;

vec3 blend(vec3 d, vec3 s) {
  if (uBlend == 1) return d * s;
  if (uBlend == 2) return 1.0 - (1.0 - d) * (1.0 - s);
  if (uBlend == 3) return mix(2.0 * d * s, 1.0 - 2.0 * (1.0 - d) * (1.0 - s), step(0.5, d));
  if (uBlend == 4) return min(d + s, 1.0);
  if (uBlend == 5) return min(d, s);
  if (uBlend == 6) return max(d, s);
  if (uBlend == 7) return abs(d - s);
  return s;
}

void main() {
  vec3 dst = texture(uDst, gl_FragCoord.xy / uOut).rgb;
  vec2 p = vec2(gl_FragCoord.x, uOut.y - gl_FragCoord.y) / uScale;
  vec2 unit = (uInv * vec3(p, 1.0)).xy;
  // Edge coverage from screen-space derivatives: exact on pixel-aligned edges, smooth on rotated ones.
  vec2 w = max(fwidth(unit), vec2(1e-6));
  vec2 edge = min(unit, 1.0 - unit) / w;
  float cover = clamp(min(edge.x, edge.y) + 0.5, 0.0, 1.0);
  vec2 t = mix(uUv.xy, uUv.zw, clamp(unit, 0.0, 1.0));
  if (uRot == 90) t = vec2(t.y, 1.0 - t.x);
  else if (uRot == 180) t = 1.0 - t;
  else if (uRot == 270) t = vec2(1.0 - t.y, t.x);
  vec4 src = texture(uSrc, t);
  float a = cover * uOpacity * src.a;
  color = vec4(mix(dst, blend(dst, src.rgb), a), 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(s));
  return s;
}

export class GlCompositor implements Compositor {
  readonly backend = 'webgl2' as const;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly srcTex: WebGLTexture;
  private targets: { tex: WebGLTexture; fbo: WebGLFramebuffer }[] = [];
  private width = 0;
  private height = 0;
  private front = 0;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    const program = gl.createProgram() as WebGLProgram;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader program failed to link');
    this.program = program;
    for (const name of ['uDst', 'uSrc', 'uInv', 'uUv', 'uOut', 'uScale', 'uOpacity', 'uRot', 'uBlend']) this.uniforms[name] = gl.getUniformLocation(program, name);
    this.srcTex = this.texture();
    gl.bindVertexArray(gl.createVertexArray());
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    const gl = this.gl;
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = [0, 1].map(() => {
      const tex = this.texture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer() as WebGLFramebuffer;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo };
    });
    gl.canvas.width = w;
    gl.canvas.height = h;
    this.width = w;
    this.height = h;
  }

  render(plan: FramePlan, images: readonly LayerImage[], scale: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(plan.width * scale));
    const h = Math.max(1, Math.round(plan.height * scale));
    this.resize(w, h);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform1i(u.uDst as WebGLUniformLocation, 0);
    gl.uniform1i(u.uSrc as WebGLUniformLocation, 1);
    gl.uniform2f(u.uOut as WebGLUniformLocation, w, h);
    gl.uniform1f(u.uScale as WebGLUniformLocation, w / plan.width);
    this.front = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.targets[0] as { fbo: WebGLFramebuffer }).fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    plan.layers.forEach((layer, i) => this.drawLayer(layer, images[i] ?? null));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, (this.targets[this.front] as { fbo: WebGLFramebuffer }).fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  private drawLayer(layer: LayerPlan, image: LayerImage): void {
    const inv = invertAffine(layer.matrix);
    if (!inv || layer.kind !== 'media') return;
    const gl = this.gl;
    const u = this.uniforms;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    if (image) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...OFFLINE_RGB, 255]));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, (this.targets[this.front] as { tex: WebGLTexture }).tex);
    const back = 1 - this.front;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.targets[back] as { fbo: WebGLFramebuffer }).fbo);
    gl.uniformMatrix3fv(u.uInv as WebGLUniformLocation, false, [inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1]);
    gl.uniform4f(u.uUv as WebGLUniformLocation, ...layer.uv);
    gl.uniform1f(u.uOpacity as WebGLUniformLocation, layer.opacity);
    gl.uniform1i(u.uRot as WebGLUniformLocation, image ? layer.rotation : 0);
    gl.uniform1i(u.uBlend as WebGLUniformLocation, BLEND_INDEX[layer.blend]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.front = back;
  }

  readPixels(): Uint8Array {
    const gl = this.gl;
    const { width: w, height: h } = this;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.targets[this.front] as { fbo: WebGLFramebuffer }).fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
