// Timeline geometry: rows, time <-> pixel mapping, hit testing, visible-clip queries.
// Pure, so the canvas view and the tests share one definition of where things are.
import { clipEnd, type Clip, type Id, type Sequence, type Track } from '../model.ts';
import { TICKS_PER_SECOND, type Tick } from '../time.ts';

export interface View {
  pxPerSecond: number;
  scrollX: number;
  scrollY: number;
}

export interface Metrics {
  rulerHeight: number;
  trackHeight: number;
  /** Distance from a clip edge within which a press grabs the edge. */
  edgeGrab: number;
}

export const DEFAULT_METRICS: Metrics = { rulerHeight: 24, trackHeight: 56, edgeGrab: 6 };

export interface Row {
  track: Track;
  /** Top of the row in content pixels (below the ruler, before vertical scroll). */
  y: number;
  height: number;
}

/** Rows top to bottom: captions, then video with the top layer first, then audio. */
export function rows(seq: Sequence, m: Metrics = DEFAULT_METRICS): Row[] {
  const order = [...seq.tracks.filter((t) => t.kind === 'caption'), ...seq.tracks.filter((t) => t.kind === 'video').reverse(), ...seq.tracks.filter((t) => t.kind === 'audio')];
  return order.map((track, i) => ({ track, y: i * m.trackHeight, height: m.trackHeight }));
}

/** X in the clip area (0 = left edge of the visible timeline) for a time. */
export const xOf = (tick: Tick, v: View): number => (tick / TICKS_PER_SECOND) * v.pxPerSecond - v.scrollX;

/** Time under an x in the clip area. Not snapped; never negative. */
export const tickAt = (x: number, v: View): Tick => Math.max(0, Math.round(((x + v.scrollX) / v.pxPerSecond) * TICKS_PER_SECOND));

export const pxToTicks = (px: number, v: View): Tick => Math.round((px / v.pxPerSecond) * TICKS_PER_SECOND);

/** Index range [from, to) of the clips of a track that intersect [t0, t1). Binary search: tracks may hold thousands. */
export function visibleRange(track: Track, t0: Tick, t1: Tick): [number, number] {
  const c = track.clips;
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clipEnd(c[mid] as Clip) <= t0) lo = mid + 1;
    else hi = mid;
  }
  const from = lo;
  hi = c.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((c[mid] as Clip).start < t1) lo = mid + 1;
    else hi = mid;
  }
  return [from, lo];
}

export interface Hit {
  area: 'ruler' | 'track' | 'empty';
  /** Raw time under the pointer. */
  tick: Tick;
  x: number;
  y: number;
  trackId: Id | null;
  clip: Clip | null;
  edge: 'in' | 'out' | null;
}

/** What is under a point of the clip area (x from its left edge, y from the top of the ruler). */
export function hitTest(seq: Sequence, v: View, x: number, y: number, m: Metrics = DEFAULT_METRICS): Hit {
  const tick = tickAt(x, v);
  const base = { tick, x, y, trackId: null, clip: null, edge: null };
  if (y < m.rulerHeight) return { ...base, area: 'ruler' };
  const cy = y - m.rulerHeight + v.scrollY;
  const row = rows(seq, m).find((r) => cy >= r.y && cy < r.y + r.height);
  if (!row) return { ...base, area: 'empty' };
  const grab = pxToTicks(m.edgeGrab, v);
  const [from, to] = visibleRange(row.track, tick - grab, tick + grab + 1);
  let best: { clip: Clip; edge: 'in' | 'out' | null; d: number } | null = null;
  for (let i = from; i < to; i++) {
    const c = row.track.clips[i] as Clip;
    // Narrow clips keep a body: edges take at most a third of the width each.
    const reach = Math.min(grab, Math.floor((c.duration - 1) / 3));
    const dIn = Math.abs(tick - c.start);
    const dOut = Math.abs(tick - clipEnd(c));
    const inside = tick >= c.start && tick < clipEnd(c);
    const cand = dIn <= reach && dIn <= dOut ? { clip: c, edge: 'in' as const, d: dIn } : dOut <= reach ? { clip: c, edge: 'out' as const, d: dOut } : inside ? { clip: c, edge: null, d: Infinity } : null;
    // Prefer the clip the pointer is inside when two edges meet at a cut.
    if (cand && (!best || (cand.d < best.d) || (cand.d === best.d && inside))) best = cand;
  }
  return { ...base, area: 'track', trackId: row.track.id, clip: best?.clip ?? null, edge: best?.edge ?? null };
}
