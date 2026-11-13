// Keyframe evaluation and editing. Times are ticks relative to the clip start.
import type { Interp, Keyframe, Param } from './model.ts';
import type { Tick } from './time.ts';

export const isAnimated = (p: Param): p is { keys: Keyframe[] } => typeof p !== 'number';

export const makeKey = (t: Tick, v: number, interp: Interp = 'linear'): Keyframe => ({ t, v, interp, out: [1 / 3, 0], in: [1 / 3, 0] });

/** Value of a cubic bezier segment at time fraction x (0..1), solving the time curve for its parameter. */
function bezier(k0: Keyframe, k1: Keyframe, x: number): number {
  const x1 = Math.min(1, Math.max(0, k0.out[0]));
  const x2 = 1 - Math.min(1, Math.max(0, k1.in[0]));
  const cubic = (p1: number, p2: number, u: number): number => 3 * (1 - u) * (1 - u) * u * p1 + 3 * (1 - u) * u * u * p2 + u * u * u;
  // The time curve is monotonic for handles within 0..1, so bisection always converges.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (cubic(x1, x2, mid) < x) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  const [p0, p3] = [k0.v, k1.v];
  const p1 = k0.v + k0.out[1];
  const p2 = k1.v + k1.in[1];
  const w = 1 - u;
  return w * w * w * p0 + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
}

/** Value of a parameter at clip-local time `t`. Holds the first/last key outside the keyed range. */
export function evalParam(p: Param, t: Tick): number {
  if (typeof p === 'number') return p;
  const keys = p.keys;
  const first = keys[0];
  if (!first) return 0;
  if (t <= first.t) return first.v;
  let lo = 0;
  let hi = keys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((keys[mid] as Keyframe).t <= t) lo = mid;
    else hi = mid - 1;
  }
  const k0 = keys[lo] as Keyframe;
  const k1 = keys[lo + 1];
  if (!k1 || k0.interp === 'hold') return k0.v;
  const x = (t - k0.t) / (k1.t - k0.t);
  return k0.interp === 'bezier' ? bezier(k0, k1, x) : k0.v + (k1.v - k0.v) * x;
}

/** Add or replace a key at `t`. A constant becomes animated, keeping its old value as the curve elsewhere. */
export function setKey(p: Param, t: Tick, v: number, interp?: Interp): Param {
  const keys = isAnimated(p) ? p.keys : [];
  const existing = keys.find((k) => k.t === t);
  const neighbour = [...keys].reverse().find((k) => k.t < t) ?? keys[0];
  const key = existing ? { ...existing, v, interp: interp ?? existing.interp } : makeKey(t, v, interp ?? neighbour?.interp ?? 'linear');
  return { keys: [...keys.filter((k) => k.t !== t), key].sort((a, b) => a.t - b.t) };
}

/** Remove the key at `t`. Removing the last key leaves a constant with that key's value. */
export function removeKey(p: Param, t: Tick): Param {
  if (!isAnimated(p)) return p;
  const keys = p.keys.filter((k) => k.t !== t);
  if (keys.length === p.keys.length) return p;
  return keys.length === 0 ? (p.keys[0]?.v ?? 0) : { keys };
}

/** Move a key in time and/or value. Refuses to land on another key's time. */
export function moveKey(p: Param, from: Tick, to: Tick, v?: number): Param {
  if (!isAnimated(p)) return p;
  const key = p.keys.find((k) => k.t === from);
  if (!key || (to !== from && p.keys.some((k) => k.t === to))) return p;
  return { keys: p.keys.map((k) => (k === key ? { ...k, t: to, v: v ?? k.v } : k)).sort((a, b) => a.t - b.t) };
}

/** Change a key's interpolation mode or bezier handles. */
export function editKey(p: Param, t: Tick, change: Partial<Pick<Keyframe, 'interp' | 'in' | 'out'>>): Param {
  if (!isAnimated(p)) return p;
  return { keys: p.keys.map((k) => (k.t === t ? { ...k, ...change } : k)) };
}

/** Set the value at `t`: edits the constant, or adds/updates a key when the parameter is animated. */
export function setValueAt(p: Param, t: Tick, v: number): Param {
  return isAnimated(p) ? setKey(p, t, v) : v;
}

/** Stop animating: collapse to the value at `t`. */
export const flatten = (p: Param, t: Tick): number => evalParam(p, t);
