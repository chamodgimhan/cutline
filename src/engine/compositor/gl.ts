// WebGL2 compositor. Each layer is a full-frame pass that reads the picture so far and the
// layer texture, so blend modes are exact. Effects run as passes on the layer's own texture
// first; transitions combine two isolated layers before they are blended in.
import { curveTable, effectDef, effectText, effectValue, parseCube, type Lut3d } from '../../core/effects.ts';
import type { BlendMode, Effect } from '../../core/model.ts';
import { invertAffine, type Affine, type FramePlan, type LayerPlan } from '../../core/render/plan.ts';
import { parseHex } from '../../theme/theme.ts';
import { EFFECT, EFFECT_INDEX, LAYER, TRANSITION, TRANSITION_INDEX, VERT } from './shaders.ts';

export type LayerImage = TexImageSource | null;
export type LayerImages = ReadonlyMap<LayerPlan, LayerImage>;
export interface Compositor {
  readonly backend: 'webgl2' | 'canvas2d';
  /** Draw the plan at `scale` (1, 0.5 or 0.25 of sequence size). A layer with no image (or null) draws as offline media. */
  render(plan: FramePlan, images: LayerImages, scale: number): void;
  /** RGBA pixels of the last render, top row first. */
  readPixels(): Uint8Array;
  dispose(): void;
}

export const OFFLINE_RGB: [number, number, number] = [90, 22, 26];
const BLEND_INDEX: Record<BlendMode, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, add: 4, darken: 5, lighten: 6, difference: 7 };

export const sizeOf = (image: TexImageSource): [number, number] => {
  const i = image as { displayWidth?: number; displayHeight?: number; width?: number; height?: number };
  return [i.displayWidth ?? i.width ?? 1, i.displayHeight ?? i.height ?? 1];
};

interface Program {
  program: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}
interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}
interface Source {
  tex: WebGLTexture;
  /** Texture rows run bottom-up (it was rendered, not uploaded). */
  flipped: boolean;
  rotation: number;
}

export class GlCompositor implements Compositor {
  readonly backend = 'webgl2' as const;
  private readonly gl: WebGL2RenderingContext;
  private readonly layer: Program;
  private readonly effect: Program;
  private readonly transition: Program;
  private readonly srcTex: WebGLTexture;
  private readonly curveTex: WebGLTexture;
  private readonly lutTex: WebGLTexture;
  private lutKey = '';
  private readonly luts = new Map<string, Lut3d | null>();
  private readonly comp: [Target, Target];
  private readonly scratch: [Target, Target, Target];
  private readonly fx: [Target, Target];
  private front = 0;
  private width = 0;
  private height = 0;
  private scale = 1;
  private seqW = 1;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.layer = this.build(LAYER, ['uDst', 'uSrc', 'uInv', 'uUv', 'uOut', 'uScale', 'uOpacity', 'uRot', 'uBlend', 'uIsolate']);
    this.effect = this.build(EFFECT, ['uTex', 'uCurve', 'uLut', 'uType', 'uP', 'uColor', 'uSize', 'uDir', 'uLutSize']);
    this.transition = this.build(TRANSITION, ['uA', 'uB', 'uOut', 'uType', 'uProgress']);
    this.srcTex = this.texture();
    this.curveTex = this.texture();
    this.lutTex = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 1, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    const t = (): Target => this.target();
    this.comp = [t(), t()];
    this.scratch = [t(), t(), t()];
    this.fx = [t(), t()];
    gl.bindVertexArray(gl.createVertexArray());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private build(frag: string, uniforms: string[]): Program {
    const gl = this.gl;
    const program = gl.createProgram() as WebGLProgram;
    for (const [type, source] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]] as const) {
      const s = gl.createShader(type) as WebGLShader;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(s));
      gl.attachShader(program, s);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Shader program failed to link');
    return { program, u: Object.fromEntries(uniforms.map((n) => [n, gl.getUniformLocation(program, n)])) };
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

  private target(): Target {
    const gl = this.gl;
    const tex = this.texture();
    const fbo = gl.createFramebuffer() as WebGLFramebuffer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w: 0, h: 0 };
  }

  /** Make a target the given size and bind it for drawing. */
  private into(t: Target, w: number, h: number): void {
    const gl = this.gl;
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      t.w = w;
      t.h = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, w, h);
  }

  private bind(unit: number, tex: WebGLTexture): void {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
  }

  /** Run a layer's enabled effects over `tex`. Returns the texture holding the result. */
  private effects(tex: WebGLTexture, w: number, h: number, layer: LayerPlan, radiusScale: number): WebGLTexture {
    const gl = this.gl;
    const e = this.effect;
    let current = tex;
    let next = 0;
    const pass = (type: number, p: [number, number, number, number], dir: [number, number] = [0, 0]): void => {
      const out = this.fx[next] as Target;
      this.into(out, w, h);
      gl.useProgram(e.program);
      this.bind(0, current);
      gl.uniform1i(e.u.uTex as WebGLUniformLocation, 0);
      gl.uniform1i(e.u.uCurve as WebGLUniformLocation, 2);
      gl.uniform1i(e.u.uLut as WebGLUniformLocation, 3);
      gl.uniform1i(e.u.uType as WebGLUniformLocation, type);
      gl.uniform4f(e.u.uP as WebGLUniformLocation, ...p);
      gl.uniform2f(e.u.uSize as WebGLUniformLocation, w, h);
      gl.uniform2f(e.u.uDir as WebGLUniformLocation, ...dir);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      current = out.tex;
      next = 1 - next;
    };
    for (const fx of layer.clip.effects) {
      if (!fx.enabled || !effectDef(fx.type)) continue;
      const v = (key: string): number => effectValue(fx, key, layer.localTime);
      const type = EFFECT_INDEX[fx.type] as number;
      if (fx.type === 'blur') {
        const r = v('radius') * radiusScale;
        pass(type, [r, 0, 0, 0], [1, 0]);
        pass(type, [r, 0, 0, 0], [0, 1]);
      } else if (fx.type === 'flip') {
        // Flip what the viewer sees: for media turned on its side, the stored axes are swapped.
        const turned = layer.rotation === 90 || layer.rotation === 270;
        pass(type, turned ? [v('vertical'), v('horizontal'), 0, 0] : [v('horizontal'), v('vertical'), 0, 0]);
      } else if (fx.type === 'curves') {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.curveTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, curveTable(['p0', 'p1', 'p2', 'p3', 'p4'].map(v)));
        pass(type, [0, 0, 0, 0]);
      } else if (fx.type === 'lut') {
        const size = this.useLut(fx);
        if (!size) continue; // no file chosen, or not a valid .cube: the effect does nothing
        gl.useProgram(e.program);
        gl.uniform1f(e.u.uLutSize as WebGLUniformLocation, size);
        pass(type, [v('mix'), 0, 0, 0]);
      } else if (fx.type === 'chromaKey') {
        let rgb: [number, number, number] = [0, 1, 0];
        try {
          const [r, g, b] = parseHex(effectText(fx, 'color'));
          rgb = [r, g, b];
        } catch {
          // not a colour: fall back to green
        }
        gl.useProgram(e.program);
        gl.uniform3f(e.u.uColor as WebGLUniformLocation, ...rgb);
        pass(type, [v('tolerance'), v('softness'), 0, 0]);
      } else {
        const keys = effectDef(fx.type)?.params.map((d) => v(d.key)) ?? [];
        pass(type, [keys[0] ?? 0, keys[1] ?? 0, keys[2] ?? 0, keys[3] ?? 0]);
      }
    }
    return current;
  }

  /** Bind the effect's LUT to unit 3. Returns its size, or 0 when there is no usable LUT. */
  private useLut(fx: Effect): number {
    const gl = this.gl;
    const text = effectText(fx, 'cube');
    if (!text) return 0;
    let lut = this.luts.get(text);
    if (lut === undefined) {
      try {
        lut = parseCube(text);
      } catch {
        lut = null;
      }
      if (this.luts.size > 8) this.luts.clear();
      this.luts.set(text, lut);
    }
    if (!lut) return 0;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    if (this.lutKey !== text) {
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, lut.size, lut.size, lut.size, 0, gl.RGB, gl.UNSIGNED_BYTE, lut.data);
      this.lutKey = text;
    }
    return lut.size;
  }

  /** The texture to place for a layer, with its effects applied. Null when the layer draws nothing. */
  private source(layer: LayerPlan, images: LayerImages): Source | null {
    const gl = this.gl;
    if (layer.kind === 'adjust') {
      if (!layer.clip.effects.some((e) => e.enabled)) return null;
      // An adjustment clip processes everything composited beneath it.
      return { tex: this.effects((this.comp[this.front] as Target).tex, this.width, this.height, layer, this.scale), flipped: true, rotation: 0 };
    }
    const image = images.get(layer) ?? null;
    if (!image && layer.kind === 'text') return null;
    this.bind(1, this.srcTex);
    let size: [number, number] = [1, 1];
    if (image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      size = sizeOf(image);
    } else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...OFFLINE_RGB, 255]));
    const tex = image ? this.effects(this.srcTex, size[0], size[1], layer, 1) : this.srcTex;
    return { tex, flipped: false, rotation: image ? layer.rotation : 0 };
  }

  /** Draw one placed texture: blended over the picture so far, or alone on transparent into `isolateTo`. */
  private place(src: Source, matrix: Affine, uv: readonly number[], opacity: number, blend: BlendMode, isolateTo: Target | null): void {
    const inv = invertAffine(matrix);
    if (!inv) return;
    const gl = this.gl;
    const u = this.layer.u;
    const back = 1 - this.front;
    this.into(isolateTo ?? (this.comp[back] as Target), this.width, this.height);
    gl.useProgram(this.layer.program);
    this.bind(0, (this.comp[this.front] as Target).tex);
    this.bind(1, src.tex);
    gl.uniform1i(u.uDst as WebGLUniformLocation, 0);
    gl.uniform1i(u.uSrc as WebGLUniformLocation, 1);
    gl.uniform2f(u.uOut as WebGLUniformLocation, this.width, this.height);
    gl.uniform1f(u.uScale as WebGLUniformLocation, this.width / this.seqW);
    gl.uniformMatrix3fv(u.uInv as WebGLUniformLocation, false, [inv[0], inv[1], 0, inv[2], inv[3], 0, inv[4], inv[5], 1]);
    const [u0, v0, u1, v1] = uv as [number, number, number, number];
    gl.uniform4f(u.uUv as WebGLUniformLocation, u0, src.flipped ? 1 - v0 : v0, u1, src.flipped ? 1 - v1 : v1);
    gl.uniform1f(u.uOpacity as WebGLUniformLocation, opacity);
    gl.uniform1i(u.uRot as WebGLUniformLocation, src.rotation);
    gl.uniform1i(u.uBlend as WebGLUniformLocation, BLEND_INDEX[blend]);
    gl.uniform1i(u.uIsolate as WebGLUniformLocation, isolateTo ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!isolateTo) this.front = back;
  }

  /** Render a layer alone into a scratch target (transparent where it is not). Null clears the target. */
  private isolate(target: Target, layer: LayerPlan | null, images: LayerImages): void {
    const gl = this.gl;
    this.into(target, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const src = layer && this.source(layer, images);
    if (layer && src) this.place(src, layer.matrix, layer.uv, layer.opacity, 'normal', target);
  }

  render(plan: FramePlan, images: LayerImages, scale: number): void {
    const gl = this.gl;
    const w = Math.max(1, Math.round(plan.width * scale));
    const h = Math.max(1, Math.round(plan.height * scale));
    if (gl.canvas.width !== w || gl.canvas.height !== h) {
      gl.canvas.width = w;
      gl.canvas.height = h;
    }
    Object.assign(this, { width: w, height: h, scale: w / plan.width, seqW: plan.width });
    this.front = 0;
    this.into(this.comp[0], w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const full: Affine = [plan.width, 0, 0, plan.height, 0, 0];
    for (const layer of plan.layers) {
      const tr = layer.transition;
      if (!tr) {
        const src = this.source(layer, images);
        if (src) this.place(src, layer.matrix, layer.uv, layer.opacity, layer.blend, null);
        continue;
      }
      // Transition: render both sides alone, combine them, then blend the result in.
      const [a, b, out] = this.scratch;
      this.isolate(a, tr.incoming ? tr.outgoing : layer, images);
      this.isolate(b, tr.incoming ? layer : null, images);
      this.into(out, w, h);
      const t = this.transition;
      gl.useProgram(t.program);
      this.bind(0, a.tex);
      this.bind(1, b.tex);
      gl.uniform1i(t.u.uA as WebGLUniformLocation, 0);
      gl.uniform1i(t.u.uB as WebGLUniformLocation, 1);
      gl.uniform2f(t.u.uOut as WebGLUniformLocation, w, h);
      gl.uniform1i(t.u.uType as WebGLUniformLocation, TRANSITION_INDEX[tr.type] ?? 0);
      gl.uniform1f(t.u.uProgress as WebGLUniformLocation, Math.min(1, Math.max(0, tr.progress)));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.place({ tex: out.tex, flipped: true, rotation: 0 }, full, [0, 0, 1, 1], 1, 'normal', null);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, (this.comp[this.front] as Target).fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  readPixels(): Uint8Array {
    const gl = this.gl;
    const { width: w, height: h } = this;
    const raw = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.comp[this.front] as Target).fbo);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    return out;
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
