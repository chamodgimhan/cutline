// Snapping as pure functions: collect candidate times, then pick the nearest within a threshold.
import { clipEnd, type Id, type Sequence } from './model.ts';
import type { Tick } from './time.ts';

export type SnapKind = 'playhead' | 'marker' | 'range' | 'clip' | 'zero';

export interface SnapPoint {
  time: Tick;
  kind: SnapKind;
}

const PRIORITY: Record<SnapKind, number> = { playhead: 0, marker: 1, range: 2, clip: 3, zero: 4 };

export interface SnapOptions {
  /** Clips being dragged: their own edges are not targets. */
  exclude?: ReadonlySet<Id>;
  playhead?: Tick | null;
}

/** All snap targets in a sequence, sorted by time. */
export function collectSnapPoints(seq: Sequence, options: SnapOptions = {}): SnapPoint[] {
  const points: SnapPoint[] = [{ time: 0, kind: 'zero' }];
  if (options.playhead !== undefined && options.playhead !== null) points.push({ time: options.playhead, kind: 'playhead' });
  for (const m of seq.markers) {
    points.push({ time: m.time, kind: 'marker' });
    if (m.duration > 0) points.push({ time: m.time + m.duration, kind: 'marker' });
  }
  if (seq.inPoint !== null) points.push({ time: seq.inPoint, kind: 'range' });
  if (seq.outPoint !== null) points.push({ time: seq.outPoint, kind: 'range' });
  for (const t of seq.tracks) {
    if (t.hidden && t.kind === 'video') continue;
    for (const c of t.clips) {
      if (options.exclude?.has(c.id)) continue;
      points.push({ time: c.start, kind: 'clip' }, { time: clipEnd(c), kind: 'clip' });
    }
  }
  return points.sort((a, b) => a.time - b.time || PRIORITY[a.kind] - PRIORITY[b.kind]);
}

function nearest(points: readonly SnapPoint[], time: Tick): SnapPoint | null {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((points[mid] as SnapPoint).time < time) lo = mid + 1;
    else hi = mid;
  }
  let best: SnapPoint | null = null;
  // Candidates: the run of equal times at `lo`, and the run just before it.
  for (const start of [lo - 1, lo]) {
    const p = points[start];
    if (!p) continue;
    let pick = p;
    for (let i = start; i >= 0 && (points[i] as SnapPoint).time === p.time; i--) pick = points[i] as SnapPoint; // first of a run has top priority
    const d = Math.abs(pick.time - time);
    if (!best || d < Math.abs(best.time - time) || (d === Math.abs(best.time - time) && PRIORITY[pick.kind] < PRIORITY[best.kind])) best = pick;
  }
  return best;
}

export interface SnapResult {
  time: Tick;
  /** The target snapped to, or null when nothing was within the threshold. */
  point: SnapPoint | null;
}

/** Snap one time. `threshold` is the capture distance in ticks (from pixels, by the caller). */
export function snapTime(time: Tick, points: readonly SnapPoint[], threshold: Tick): SnapResult {
  const p = nearest(points, time);
  return p && Math.abs(p.time - time) <= threshold ? { time: p.time, point: p } : { time, point: null };
}

export interface SnapMoveResult {
  delta: Tick;
  point: SnapPoint | null;
  /** Index into `edges` of the edge that snapped, or -1. */
  edge: number;
}

/** Snap a move of several edges (a dragged clip's start and end): the closest edge-to-target pair wins. */
export function snapMove(edges: readonly Tick[], delta: Tick, points: readonly SnapPoint[], threshold: Tick): SnapMoveResult {
  let best: SnapMoveResult = { delta, point: null, edge: -1 };
  let bestDist = Infinity;
  edges.forEach((e, i) => {
    const p = nearest(points, e + delta);
    if (!p) return;
    const dist = Math.abs(p.time - (e + delta));
    if (dist <= threshold && (dist < bestDist || (dist === bestDist && best.point && PRIORITY[p.kind] < PRIORITY[best.point.kind]))) {
      best = { delta: p.time - e, point: p, edge: i };
      bestDist = dist;
    }
  });
  return best;
}
