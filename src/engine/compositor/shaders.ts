// GLSL for the compositor: layer placement and blending, effects, transitions.

export const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Places one layer. uIsolate 0: blend over uDst (opaque result). 1: the layer alone on transparent. */
export const LAYER = `#version 300 es
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
uniform int uIsolate;
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
  if (uIsolate == 1) { color = vec4(src.rgb, a); return; }
  vec3 dst = texture(uDst, gl_FragCoord.xy / uOut).rgb;
  color = vec4(mix(dst, blend(dst, src.rgb), a), 1.0);
}`;

export const EFFECT_INDEX: Record<string, number> = { exposure: 1, contrast: 2, saturation: 3, temperature: 4, curves: 5, lut: 6, blur: 7, sharpen: 8, vignette: 9, chromaKey: 10, flip: 11 };

/** One effect pass over a texture. uP carries up to four parameters. */
export const EFFECT = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uTex;
uniform sampler2D uCurve;
uniform sampler3D uLut;
uniform int uType;
uniform vec4 uP;
uniform vec3 uColor;
uniform vec2 uSize;     // texture size in pixels
uniform vec2 uDir;      // blur direction
uniform float uLutSize;
out vec4 color;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec2 chroma(vec3 c) { return vec2(dot(c, vec3(-0.1146, -0.3854, 0.5)), dot(c, vec3(0.5, -0.4542, -0.0458))); }

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  if (uType == 11) {
    if (uP.x > 0.5) uv.x = 1.0 - uv.x;
    if (uP.y > 0.5) uv.y = 1.0 - uv.y;
  }
  vec4 c = texture(uTex, uv);
  if (uType == 1) c.rgb *= exp2(uP.x);
  else if (uType == 2) c.rgb = (c.rgb - 0.5) * (1.0 + uP.x) + 0.5;
  else if (uType == 3) c.rgb = mix(vec3(dot(c.rgb, LUMA)), c.rgb, uP.x);
  else if (uType == 4) c.rgb *= vec3(1.0 + 0.25 * uP.x, 1.0 - 0.25 * uP.y, 1.0 - 0.25 * uP.x);
  else if (uType == 5) c.rgb = vec3(texture(uCurve, vec2(c.r, 0.5)).r, texture(uCurve, vec2(c.g, 0.5)).r, texture(uCurve, vec2(c.b, 0.5)).r);
  else if (uType == 6) c.rgb = mix(c.rgb, texture(uLut, clamp(c.rgb, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb, uP.x);
  else if (uType == 7) {
    float radius = uP.x;
    if (radius > 0.01) {
      float sigma = max(radius / 2.0, 0.5);
      float stepSize = max(1.0, radius / 24.0);
      vec4 sum = vec4(0.0);
      float total = 0.0;
      for (float i = -24.0; i <= 24.0; i += 1.0) {
        float d = i * stepSize;
        if (abs(d) > radius) continue;
        float wgt = exp(-(d * d) / (2.0 * sigma * sigma));
        sum += texture(uTex, uv + uDir * d / uSize) * wgt;
        total += wgt;
      }
      c = sum / total;
    }
  }
  else if (uType == 8) {
    vec2 px = 1.0 / uSize;
    vec3 around = (texture(uTex, uv + vec2(px.x, 0.0)).rgb + texture(uTex, uv - vec2(px.x, 0.0)).rgb + texture(uTex, uv + vec2(0.0, px.y)).rgb + texture(uTex, uv - vec2(0.0, px.y)).rgb) * 0.25;
    c.rgb += (c.rgb - around) * uP.x * 2.0;
  }
  else if (uType == 9) {
    float d = distance(uv, vec2(0.5)) * 1.41421356;
    c.rgb *= 1.0 - uP.x * smoothstep(1.0 - uP.y, 1.0, d);
  }
  else if (uType == 10) {
    float d = distance(chroma(c.rgb), chroma(uColor));
    c.a *= smoothstep(uP.x * 0.5, uP.x * 0.5 + uP.y * 0.5 + 0.001, d);
  }
  color = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}`;

export const TRANSITION_INDEX: Record<string, number> = { dissolve: 0, dipBlack: 1, dipWhite: 2, wipe: 3, slide: 4 };

/** Combines two full-frame layers (straight alpha): A is leaving, B arriving, uProgress 0..1. */
export const TRANSITION = `#version 300 es
precision highp float;
uniform sampler2D uA;
uniform sampler2D uB;
uniform vec2 uOut;
uniform int uType;
uniform float uProgress;
out vec4 color;

void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec4 a = texture(uA, uv);
  vec4 b = texture(uB, uv);
  float p = uProgress;
  if (uType == 1 || uType == 2) {
    vec3 dip = vec3(uType == 2 ? 1.0 : 0.0);
    float alpha = max(a.a, b.a);
    color = p < 0.5 ? vec4(mix(a.rgb, dip, p * 2.0), alpha) : vec4(mix(dip, b.rgb, p * 2.0 - 1.0), alpha);
  } else if (uType == 3) {
    color = uv.x < p ? b : a;
  } else if (uType == 4) {
    // B slides in from the right over A.
    color = uv.x >= 1.0 - p ? texture(uB, vec2(uv.x - (1.0 - p), uv.y)) : a;
  } else {
    float alpha = mix(a.a, b.a, p);
    color = vec4((a.rgb * a.a * (1.0 - p) + b.rgb * b.a * p) / max(alpha, 1e-5), alpha);
  }
}`;
