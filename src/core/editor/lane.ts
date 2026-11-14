// Keyframe lane: which animatable property of a clip the timeline shows and edits.
import { isAnimated } from '../keyframes.ts';
import type { Clip, Keyframe, Param } from '../model.ts';
import type { Tick } from '../time.ts';

export const LANE_KEYS = ['opacity', 'x', 'y', 'scale', 'rotation', 'gain'] as const;
export type LaneKey = (typeof LANE_KEYS)[number];
export const LANE_LABELS: Record<LaneKey, string> = { opacity: 'Opacity', x: 'Position X', y: 'Position Y', scale: 'Scale', rotation: 'Rotation', gain: 'Gain' };

/** The property a clip actually has for the chosen lane: audio clips only have gain, picture clips everything else. */
export const laneKeyFor = (c: Clip, wanted: LaneKey): LaneKey | null => (c.audio ? 'gain' : c.video ? (wanted === 'gain' ? 'opacity' : wanted) : null);

export function laneParam(c: Clip, key: LaneKey): Param | null {
  if (key === 'gain') return c.audio?.gain ?? null;
  return c.video?.[key] ?? null;
}

export function withLaneParam(c: Clip, key: LaneKey, p: Param): Clip {
  if (key === 'gain') return c.audio ? { ...c, audio: { ...c.audio, gain: p } } : c;
  return c.video ? { ...c, video: { ...c.video, [key]: p } } : c;
}

/** The key of a clip's lane nearest to clip-local time `local`, if one is within `tolerance`. */
export function keyNear(c: Clip, key: LaneKey, local: Tick, tolerance: Tick): Keyframe | null {
  const p = laneParam(c, key);
  if (!p || !isAnimated(p)) return null;
  let best: Keyframe | null = null;
  for (const k of p.keys) if (Math.abs(k.t - local) <= tolerance && (!best || Math.abs(k.t - local) < Math.abs(best.t - local))) best = k;
  return best;
}
