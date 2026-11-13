// Clip commands: add, remove, move, split, property updates, link and unlink.
import { splitClipAt } from '../clipmath.ts';
import { EditError, type Command } from '../command.ts';
import { Draft, type EditCtx } from '../draft.ts';
import { clipEnd, type Clip, type Id, type Project } from '../model.ts';
import type { Tick } from '../time.ts';

export interface Placement {
  trackId: Id;
  clip: Clip;
}

/** Add clips into free space. Fails if any would overlap an existing clip. */
export function addClips(p: Project, ctx: EditCtx, items: readonly Placement[]): Command {
  const d = new Draft(p, ctx);
  for (const it of items) {
    if (d.find(it.clip.id)) throw new EditError('That clip is already in the sequence.');
    d.put(it.trackId, it.clip);
  }
  return d.build(items.length === 1 ? 'Add clip' : 'Add clips');
}

/** Remove clips and leave the gap. */
export function removeClips(p: Project, ctx: EditCtx, ids: readonly Id[], linked = true): Command {
  const d = new Draft(p, ctx);
  for (const hit of d.expand(ids, linked)) d.remove(hit.clip.id);
  return d.build('Delete');
}

export interface MoveArgs {
  ids: readonly Id[];
  /** Time offset applied to every moved clip. Clamped so nothing starts before zero. */
  delta: Tick;
  /** Destination track per clip id, for clips changing track. */
  tracks?: Readonly<Record<Id, Id>>;
  linked?: boolean;
}

/** Move clips in time and/or to other tracks. Whatever they land on is overwritten. */
export function moveClips(p: Project, ctx: EditCtx, args: MoveArgs): Command {
  const d = new Draft(p, ctx);
  const hits = d.expand(args.ids, args.linked ?? true);
  if (hits.length === 0) throw new EditError('Nothing selected.');
  const minStart = Math.min(...hits.map((h) => h.clip.start));
  const delta = Math.max(args.delta, -minStart);
  const moving = new Set(hits.map((h) => h.clip.id));
  const placed = hits.map((h) => ({ trackId: args.tracks?.[h.clip.id] ?? h.track.id, clip: { ...h.clip, start: h.clip.start + delta }, from: h.track.id }));
  if (delta === 0 && placed.every((x) => x.trackId === x.from)) return d.build('Move');
  for (const h of hits) d.remove(h.clip.id);
  for (const x of placed) d.clearRange(x.trackId, x.clip.start, clipEnd(x.clip), moving);
  for (const x of placed) d.put(x.trackId, x.clip);
  return d.build('Move');
}

export interface SplitArgs {
  at: Tick;
  /** Clips to split. Omit to split every clip under `at` on unlocked tracks. */
  ids?: readonly Id[];
  linked?: boolean;
}

/** Cut clips in two at a time. Returns the ids of the new right-hand parts via the command ops. */
export function splitClips(p: Project, ctx: EditCtx, args: SplitArgs): Command {
  const d = new Draft(p, ctx);
  const hits = args.ids
    ? d.expand(args.ids, args.linked ?? true)
    : d.unlockedTracks().flatMap((track) => d.clips(track.id).filter((c) => c.start < args.at && clipEnd(c) > args.at).map((clip) => ({ track, clip })));
  const relink = new Map<Id, Id>();
  let count = 0;
  for (const { track, clip } of hits) {
    if (args.at <= clip.start || args.at >= clipEnd(clip)) continue;
    const [left, right] = splitClipAt(p, clip, args.at, ctx.newId());
    let linkId = right.linkId;
    if (linkId !== null) {
      linkId = relink.get(linkId) ?? ctx.newId();
      relink.set(right.linkId as Id, linkId);
    }
    d.put(track.id, left);
    d.put(track.id, { ...right, linkId });
    count++;
  }
  if (count === 0) throw new EditError('There is no clip to split at that time.');
  return d.build('Split');
}

/** Apply `change` to each clip (inspector edits, effects, text, enable/disable). Ids are preserved. */
export function updateClips(p: Project, ctx: EditCtx, ids: readonly Id[], change: (c: Clip) => Clip, label = 'Change clip'): Command {
  const d = new Draft(p, ctx);
  for (const id of ids) {
    const { track, clip } = d.need(id);
    const next = change(clip);
    if (next !== clip) d.put(track.id, { ...next, id: clip.id });
  }
  return d.build(label);
}

/** Link clips so they move, trim and delete together. */
export function linkClips(p: Project, ctx: EditCtx, ids: readonly Id[]): Command {
  const d = new Draft(p, ctx);
  const hits = d.expand(ids, true);
  if (hits.length < 2) throw new EditError('Select at least two clips to link.');
  const linkId = ctx.newId();
  for (const { track, clip } of hits) d.put(track.id, { ...clip, linkId });
  return d.build('Link');
}

/** Break the link groups the given clips belong to. */
export function unlinkClips(p: Project, ctx: EditCtx, ids: readonly Id[]): Command {
  const d = new Draft(p, ctx);
  const hits = d.expand(ids, true).filter((h) => h.clip.linkId !== null);
  if (hits.length === 0) throw new EditError('Those clips are not linked.');
  for (const { track, clip } of hits) d.put(track.id, { ...clip, linkId: null });
  return d.build('Unlink');
}
