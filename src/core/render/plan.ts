// Frame plan: which layers are visible at a tick and exactly where they go.
// Pure geometry; the compositor (GL or 2D) only executes the plan.
import { evalParam } from '../keyframes.ts';
import { clipAt, getMedia, getSequence, sourceSpan, type BlendMode, type Clip, type FitMode, type Id, type Project } from '../model.ts';
import type { Tick } from '../time.ts';

/** 2D affine map: x' = a*u + c*v + e, y' = b*u + d*v + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

export interface LayerPlan {
  clipId: Id;
  trackId: Id;
  kind: 'media' | 'text' | 'adjust';
  mediaId: Id | null;
  /** Source time whose frame is shown. */
  sourceTime: Tick;
  /** Time since the clip start, for keyframed properties. */
  localTime: Tick;
  /** Clockwise rotation metadata of the media, applied when sampling. */
  rotation: 0 | 90 | 180 | 270;
  opacity: number;
  blend: BlendMode;
  /** Maps the unit square (the visible, cropped part of the picture) to sequence pixels. */
  matrix: Affine;
  /** Visible part of the upright picture as [u0, v0, u1, v1]. */
  uv: [number, number, number, number];
  clip: Clip;
}

export interface FramePlan {
  width: number;
  height: number;
  layers: LayerPlan[];
}

/** Size of the picture box before the clip's own scale, for a fit mode. */
export function fitBox(mode: FitMode, mw: number, mh: number, W: number, H: number): [number, number] {
  if (mode === 'stretch') return [W, H];
  if (mode === 'none') return [mw, mh];
  const s = mode === 'fill' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
  return [mw * s, mh * s];
}

/** Source time shown at clip-local time, with reverse reading from the far end. */
export function clipSourceTime(c: Clip, local: Tick): Tick {
  if (c.freeze) return c.sourceIn;
  const off = sourceSpan(c, local);
  // Reversed clips start on the last frame, which begins just before the source out point.
  return c.reverse ? Math.max(c.sourceIn, c.sourceIn + sourceSpan(c, c.duration) - off - 1) : c.sourceIn + off;
}

export function layerMatrix(c: Clip, local: Tick, boxW: number, boxH: number, W: number, H: number): { matrix: Affine; uv: LayerPlan['uv'] } | null {
  const v = c.video;
  if (!v) return null;
  const crop = v.crop;
  const cw = (1 - crop.left - crop.right) * boxW;
  const ch = (1 - crop.top - crop.bottom) * boxH;
  if (cw <= 0 || ch <= 0) return null;
  const s = evalParam(v.scale, local);
  const th = (evalParam(v.rotation, local) * Math.PI) / 180;
  const cos = Math.cos(th) * s;
  const sin = Math.sin(th) * s;
  // The anchor is the pivot for scale and rotation; moving it does not move an untransformed layer.
  const ox = crop.left * boxW - v.anchorX * boxW;
  const oy = crop.top * boxH - v.anchorY * boxH;
  const tx = W / 2 + evalParam(v.x, local) + (v.anchorX - 0.5) * boxW;
  const ty = H / 2 + evalParam(v.y, local) + (v.anchorY - 0.5) * boxH;
  return {
    matrix: [cos * cw, sin * cw, -sin * ch, cos * ch, tx + cos * ox - sin * oy, ty + sin * ox + cos * oy],
    uv: [crop.left, crop.top, 1 - crop.right, 1 - crop.bottom],
  };
}

/** Layers visible at `tick`, bottom first. */
export function planFrame(project: Project, tick: Tick, seqId?: Id): FramePlan {
  const seq = getSequence(project, seqId);
  const layers: LayerPlan[] = [];
  for (const track of seq.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    const c = clipAt(track, tick);
    if (!c || !c.enabled || !c.video) continue;
    const local = tick - c.start;
    const opacity = Math.min(1, Math.max(0, evalParam(c.video.opacity, local)));
    if (opacity <= 0 && c.kind !== 'adjust') continue;
    let box: [number, number] = [seq.width, seq.height];
    let rotation: LayerPlan['rotation'] = 0;
    const media = getMedia(project, c.mediaId);
    if (c.kind === 'video') {
      if (!media?.video) continue;
      rotation = media.video.rotation;
      const swap = rotation === 90 || rotation === 270;
      box = fitBox(c.video.fit, swap ? media.video.height : media.video.width, swap ? media.video.width : media.video.height, seq.width, seq.height);
    }
    const geo = layerMatrix(c, local, box[0], box[1], seq.width, seq.height);
    if (!geo) continue;
    layers.push({
      clipId: c.id, trackId: track.id, kind: c.kind === 'video' ? 'media' : c.kind === 'text' ? 'text' : 'adjust', mediaId: c.mediaId,
      sourceTime: media?.kind === 'image' ? 0 : clipSourceTime(c, local), localTime: local, rotation, opacity, blend: c.video.blend, ...geo, clip: c,
    });
  }
  return { width: seq.width, height: seq.height, layers };
}

/** Inverse of an affine map, or null when it is degenerate. */
export function invertAffine(m: Affine): Affine | null {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export const applyAffine = (m: Affine, u: number, v: number): [number, number] => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
