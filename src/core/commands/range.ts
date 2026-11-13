// Range commands: insert, overwrite, lift, extract, ripple delete.
import { EditError, type Command } from '../command.ts';
import { Draft, type EditCtx } from '../draft.ts';
import { clipEnd, type Id, type Project } from '../model.ts';
import type { Tick } from '../time.ts';
import type { Placement } from './clips.ts';

export interface PlaceArgs {
  at: Tick;
  /** Clips to place; each clip's start is set to `at`. */
  items: readonly Placement[];
}

function placed(args: PlaceArgs): { items: Placement[]; length: Tick } {
  if (args.items.length === 0) throw new EditError('Nothing to place.');
  if (args.at < 0) throw new EditError('Clips cannot start before the beginning of the sequence.');
  const items = args.items.map((it) => ({ trackId: it.trackId, clip: { ...it.clip, start: args.at } }));
  return { items, length: Math.max(...items.map((it) => it.clip.duration)) };
}

/** Insert: split whatever is under `at`, push everything after it later, drop the clips in. */
export function insertClips(p: Project, ctx: EditCtx, args: PlaceArgs): Command {
  const d = new Draft(p, ctx);
  const { items, length } = placed(args);
  d.splitAllAt(args.at);
  d.shiftFrom(args.at, length);
  for (const it of items) d.put(it.trackId, it.clip);
  return d.build('Insert');
}

/** Overwrite: replace whatever occupies the clips' span on their tracks. */
export function overwriteClips(p: Project, ctx: EditCtx, args: PlaceArgs): Command {
  const d = new Draft(p, ctx);
  const { items } = placed(args);
  for (const it of items) d.clearRange(it.trackId, it.clip.start, clipEnd(it.clip));
  for (const it of items) d.put(it.trackId, it.clip);
  return d.build('Overwrite');
}

export interface RangeArgs {
  start: Tick;
  end: Tick;
  /** Tracks to cut. Defaults to every unlocked track. */
  trackIds?: readonly Id[];
}

function checkRange(a: RangeArgs): void {
  if (a.start < 0 || a.end <= a.start) throw new EditError('Set an in point before the out point first.');
}

/** Lift: remove the range and leave a gap. */
export function liftRange(p: Project, ctx: EditCtx, args: RangeArgs): Command {
  checkRange(args);
  const d = new Draft(p, ctx);
  for (const id of args.trackIds ?? d.unlockedTracks().map((t) => t.id)) d.clearRange(id, args.start, args.end);
  return d.build('Lift');
}

/** Extract: remove the range on every unlocked track and close the gap. */
export function extractRange(p: Project, ctx: EditCtx, args: Omit<RangeArgs, 'trackIds'>): Command {
  checkRange(args);
  const d = new Draft(p, ctx);
  for (const t of d.unlockedTracks()) d.clearRange(t.id, args.start, args.end);
  d.shiftFrom(args.end, args.start - args.end);
  return d.build('Extract');
}

/**
 * Ripple delete: remove clips and pull later clips left to close each gap. If a
 * clip on another track is in the way, the gap closes only as far as it can.
 */
export function rippleDelete(p: Project, ctx: EditCtx, ids: readonly Id[], linked = true): Command {
  const d = new Draft(p, ctx);
  const hits = d.expand(ids, linked);
  if (hits.length === 0) throw new EditError('Nothing selected.');
  const spans = hits.map((h) => [h.clip.start, clipEnd(h.clip)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  for (const h of hits) d.remove(h.clip.id);
  for (const [a, b] of merged.reverse()) d.shiftFrom(b, -Math.min(b - a, d.maxLeftShift(b)));
  return d.build('Ripple delete');
}
