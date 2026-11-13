// Trim commands: trim, ripple trim, roll, slip, slide. Every function clamps the
// requested amount to what neighbours and source media allow.
import { clamp, headRoom, resizeHead, resizeTail, slipRange, tailRoom } from '../clipmath.ts';
import { EditError, type Command } from '../command.ts';
import { Draft, type EditCtx, type Located } from '../draft.ts';
import { clipEnd, type Clip, type Id, type Project } from '../model.ts';
import type { Tick } from '../time.ts';

export type Edge = 'in' | 'out';

export interface TrimArgs {
  id: Id;
  edge: Edge;
  /** New timeline time for the edge. */
  to: Tick;
  linked?: boolean;
  /** Shortest duration a clip may be trimmed to (one frame, from the UI). Defaults to one tick. */
  minDuration?: Tick;
}

const neighbours = (d: Draft, hit: Located, group: ReadonlySet<Id>): { prev?: Clip; next?: Clip } => {
  const list = d.clips(hit.track.id).filter((c) => c.id === hit.clip.id || !group.has(c.id));
  const i = list.findIndex((c) => c.id === hit.clip.id);
  return { prev: list[i - 1], next: list[i + 1] };
};

/** Allowed [min, max] movement of one clip edge, from its own length and media. */
function edgeLimits(p: Project, c: Clip, edge: Edge, min: Tick): [number, number] {
  return edge === 'in' ? [-Math.min(headRoom(p, c), c.start), c.duration - min] : [min - c.duration, tailRoom(p, c)];
}

/** Trim one edge. Stops at the neighbouring clip. */
export function trimClip(p: Project, ctx: EditCtx, args: TrimArgs): Command {
  const d = new Draft(p, ctx);
  const min = args.minDuration ?? 1;
  const primary = d.need(args.id).clip;
  const hits = d.linked(args.id, args.linked ?? true);
  const group = new Set(hits.map((h) => h.clip.id));
  let delta = args.to - (args.edge === 'in' ? primary.start : clipEnd(primary));
  for (const h of hits) {
    const [lo, hi] = edgeLimits(p, h.clip, args.edge, min);
    const { prev, next } = neighbours(d, h, group);
    const gapLo = args.edge === 'in' && prev ? clipEnd(prev) - h.clip.start : -Infinity;
    const gapHi = args.edge === 'out' && next ? next.start - clipEnd(h.clip) : Infinity;
    delta = clamp(delta, Math.max(lo, gapLo), Math.min(hi, gapHi));
  }
  if (delta !== 0) {
    for (const h of hits) {
      d.put(h.track.id, args.edge === 'in' ? resizeHead(p, h.clip, h.clip.start + delta) : resizeTail(p, h.clip, clipEnd(h.clip) + delta));
    }
  }
  return d.build('Trim');
}

/** Trim one edge and move everything after it so no gap opens or closes. */
export function rippleTrim(p: Project, ctx: EditCtx, args: TrimArgs): Command {
  const d = new Draft(p, ctx);
  const min = args.minDuration ?? 1;
  const primary = d.need(args.id).clip;
  const hits = d.linked(args.id, args.linked ?? true);
  const group = new Set(hits.map((h) => h.clip.id));
  const edgeDelta = args.to - (args.edge === 'in' ? primary.start : clipEnd(primary));
  // Change in duration: trimming the head later shortens, trimming the tail later lengthens.
  let grow = args.edge === 'in' ? -edgeDelta : edgeDelta;
  for (const h of hits) {
    const room = args.edge === 'in' ? headRoom(p, h.clip) : tailRoom(p, h.clip);
    grow = clamp(grow, min - h.clip.duration, room);
  }
  const from = Math.max(...hits.map((h) => clipEnd(h.clip)));
  if (grow < 0) grow = -Math.min(-grow, d.maxLeftShift(from, group));
  if (grow !== 0) {
    d.shiftFrom(from, grow, group);
    for (const h of hits) {
      const c = h.clip;
      const next = args.edge === 'in' ? { ...resizeHead(p, c, c.start - grow), start: c.start } : resizeTail(p, c, clipEnd(c) + grow);
      d.put(h.track.id, next);
    }
  }
  return d.build('Ripple trim');
}

export interface RollArgs {
  id: Id;
  edge: Edge;
  to: Tick;
  linked?: boolean;
  minDuration?: Tick;
}

/** Move the cut between two adjoining clips: one gets longer, the other shorter. */
export function rollEdit(p: Project, ctx: EditCtx, args: RollArgs): Command {
  const d = new Draft(p, ctx);
  const min = args.minDuration ?? 1;
  const primary = d.need(args.id);
  const cut = args.edge === 'in' ? primary.clip.start : clipEnd(primary.clip);
  const seen = new Set<Id>();
  const pairs: { track: Id; a?: Clip; b?: Clip; prevEnd: number; nextStart: number }[] = [];
  for (const h of d.linked(args.id, args.linked ?? true)) {
    if (seen.has(h.track.id)) continue;
    const list = d.clips(h.track.id);
    const a = list.find((c) => clipEnd(c) === cut);
    const b = list.find((c) => c.start === cut);
    if (!a && !b) continue;
    seen.add(h.track.id);
    const before = list.filter((c) => clipEnd(c) <= cut && c !== a).pop();
    const after = list.find((c) => c.start >= cut && c !== b);
    pairs.push({ track: h.track.id, a, b, prevEnd: before ? clipEnd(before) : 0, nextStart: after ? after.start : Infinity });
  }
  const main = pairs.find((x) => x.track === primary.track.id);
  if (!main?.a || !main.b) throw new EditError('There is no adjoining clip to roll against.');
  let delta = args.to - cut;
  for (const x of pairs) {
    if (x.a) delta = clamp(delta, min - x.a.duration, x.b ? tailRoom(p, x.a) : Math.min(tailRoom(p, x.a), x.nextStart - cut));
    if (x.b) delta = clamp(delta, x.a ? -headRoom(p, x.b) : -Math.min(headRoom(p, x.b), cut - x.prevEnd), x.b.duration - min);
  }
  if (delta !== 0) {
    for (const x of pairs) {
      if (x.a) d.put(x.track, resizeTail(p, x.a, cut + delta));
      if (x.b) d.put(x.track, resizeHead(p, x.b, cut + delta));
    }
  }
  return d.build('Roll');
}

/** Change which part of the source a clip shows without moving it. `by` is in source ticks. */
export function slipClip(p: Project, ctx: EditCtx, args: { id: Id; by: Tick; linked?: boolean }): Command {
  const d = new Draft(p, ctx);
  const hits = d.linked(args.id, args.linked ?? true);
  let by = args.by;
  for (const h of hits) {
    const [lo, hi] = slipRange(p, h.clip);
    by = clamp(by, lo, hi);
  }
  if (by !== 0) for (const h of hits) d.put(h.track.id, { ...h.clip, sourceIn: h.clip.sourceIn + by });
  return d.build('Slip');
}

/** Move a clip between its neighbours; the neighbours are trimmed to follow it. */
export function slideClip(p: Project, ctx: EditCtx, args: { id: Id; delta: Tick; linked?: boolean; minDuration?: Tick }): Command {
  const d = new Draft(p, ctx);
  const min = args.minDuration ?? 1;
  const hits = d.linked(args.id, args.linked ?? true);
  const group = new Set(hits.map((h) => h.clip.id));
  let delta = args.delta;
  const plan = hits.map((h) => {
    const { prev, next } = neighbours(d, h, group);
    const a = prev && clipEnd(prev) === h.clip.start ? prev : undefined;
    const b = next && next.start === clipEnd(h.clip) ? next : undefined;
    const lo = a ? min - a.duration : (prev ? clipEnd(prev) : 0) - h.clip.start;
    const hi = b ? b.duration - min : next ? next.start - clipEnd(h.clip) : Infinity;
    delta = clamp(delta, Math.max(lo, b ? -headRoom(p, b) : -Infinity), Math.min(hi, a ? tailRoom(p, a) : Infinity));
    return { h, a, b };
  });
  if (delta !== 0) {
    for (const { h, a, b } of plan) {
      if (a) d.put(h.track.id, resizeTail(p, a, clipEnd(a) + delta));
      if (b) d.put(h.track.id, resizeHead(p, b, b.start + delta));
      d.put(h.track.id, { ...h.clip, start: h.clip.start + delta });
    }
  }
  return d.build('Slide');
}
