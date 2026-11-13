// Track, marker, sequence, media and project commands.
import { EditError, type Command, type ProjectProps, type SeqProps, type TrackProps } from '../command.ts';
import { Draft, type EditCtx } from '../draft.ts';
import { makeTrack, type Id, type Marker, type MediaAsset, type Project, type Sequence, type TrackKind } from '../model.ts';
import type { Tick } from '../time.ts';

function pick<T extends object>(obj: T, like: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(like) as (keyof T)[]) out[k] = obj[k];
  return out;
}

export function addTrack(p: Project, ctx: EditCtx, args: { kind: TrackKind; name?: string; index?: number; id?: Id }): Command {
  const d = new Draft(p, ctx);
  const count = d.seq.tracks.filter((t) => t.kind === args.kind).length + 1;
  const prefix = args.kind === 'video' ? 'V' : args.kind === 'audio' ? 'A' : 'C';
  const track = makeTrack(args.id ?? ctx.newId(), args.kind, args.name ?? `${prefix}${count}`);
  const index = Math.min(Math.max(args.index ?? d.seq.tracks.length, 0), d.seq.tracks.length);
  d.op({ t: 'track', seq: d.seq.id, before: null, after: { track, index } });
  return d.build('Add track');
}

export function removeTrack(p: Project, ctx: EditCtx, trackId: Id): Command {
  const d = new Draft(p, ctx);
  const track = d.track(trackId);
  if (track.locked) throw new EditError(`Track "${track.name}" is locked. Unlock it before deleting.`);
  d.op({ t: 'track', seq: d.seq.id, before: { track, index: d.seq.tracks.indexOf(track) }, after: null });
  return d.build('Delete track');
}

/** Move a track to a new position in the stacking order. */
export function moveTrack(p: Project, ctx: EditCtx, trackId: Id, toIndex: number): Command {
  const d = new Draft(p, ctx);
  const track = d.track(trackId);
  const from = d.seq.tracks.indexOf(track);
  const index = Math.min(Math.max(toIndex, 0), d.seq.tracks.length - 1);
  if (index !== from) d.op({ t: 'track', seq: d.seq.id, before: { track, index: from }, after: { track, index } });
  return d.build('Reorder tracks');
}

/** Lock, mute, solo, hide, rename, volume, pan. */
export function setTrackProps(p: Project, ctx: EditCtx, trackId: Id, props: Partial<TrackProps>): Command {
  const d = new Draft(p, ctx);
  const track = d.track(trackId);
  const before = pick(track as TrackProps, props);
  if (JSON.stringify(before) !== JSON.stringify(props)) d.op({ t: 'trackProps', seq: d.seq.id, track: trackId, before, after: props });
  return d.build('Change track');
}

export function addMarker(p: Project, ctx: EditCtx, args: { time: Tick; name?: string; color?: string; duration?: Tick; id?: Id }): Command {
  const d = new Draft(p, ctx);
  if (args.time < 0) throw new EditError('A marker cannot be placed before the start.');
  const marker: Marker = { id: args.id ?? ctx.newId(), time: args.time, duration: args.duration ?? 0, name: args.name ?? '', color: args.color ?? 'marker' };
  d.op({ t: 'marker', seq: d.seq.id, before: null, after: marker });
  return d.build('Add marker');
}

function needMarker(seq: Sequence, id: Id): Marker {
  const m = seq.markers.find((x) => x.id === id);
  if (!m) throw new EditError('Marker not found.');
  return m;
}

export function removeMarker(p: Project, ctx: EditCtx, id: Id): Command {
  const d = new Draft(p, ctx);
  d.op({ t: 'marker', seq: d.seq.id, before: needMarker(d.seq, id), after: null });
  return d.build('Delete marker');
}

/** Move, rename, recolour or resize a marker. */
export function updateMarker(p: Project, ctx: EditCtx, id: Id, change: Partial<Omit<Marker, 'id'>>): Command {
  const d = new Draft(p, ctx);
  const before = needMarker(d.seq, id);
  const after = { ...before, ...change, id };
  if (after.time < 0) after.time = 0;
  if (JSON.stringify(before) !== JSON.stringify(after)) d.op({ t: 'marker', seq: d.seq.id, before, after });
  return d.build('Change marker');
}

/** In/out points, name, frame size, frame rate, sample rate. */
export function setSequenceProps(p: Project, ctx: EditCtx, props: Partial<SeqProps>, label = 'Change sequence'): Command {
  const d = new Draft(p, ctx);
  const before = pick(d.seq as SeqProps, props);
  if (JSON.stringify(before) !== JSON.stringify(props)) d.op({ t: 'seqProps', seq: d.seq.id, before, after: props });
  return d.build(label);
}

/** Set or clear the in/out range. Swaps the points if given in the wrong order. */
export function setRange(p: Project, ctx: EditCtx, inPoint: Tick | null, outPoint: Tick | null): Command {
  let [a, b] = [inPoint, outPoint];
  if (a !== null && b !== null && b < a) [a, b] = [b, a];
  if (a !== null && b !== null && a === b) throw new EditError('The in and out points cannot be at the same time.');
  return setSequenceProps(p, ctx, { inPoint: a, outPoint: b }, 'Set range');
}

export function addSequence(p: Project, ctx: EditCtx, sequence: Sequence): Command {
  const d = new Draft(p, ctx);
  d.op({ t: 'sequence', before: null, after: { sequence, index: p.sequences.length } });
  return d.build('Add sequence');
}

export function addMedia(p: Project, ctx: EditCtx, assets: readonly MediaAsset[]): Command {
  const d = new Draft(p, ctx);
  for (const m of assets) d.op({ t: 'media', before: null, after: m });
  return d.build('Import media');
}

export function removeMedia(p: Project, ctx: EditCtx, mediaId: Id): Command {
  const d = new Draft(p, ctx);
  const m = p.media.find((x) => x.id === mediaId);
  if (!m) throw new EditError('Media not found.');
  if (p.sequences.some((s) => s.tracks.some((t) => t.clips.some((c) => c.mediaId === mediaId)))) {
    throw new EditError(`"${m.name}" is used in a sequence. Remove its clips first.`);
  }
  d.op({ t: 'media', before: m, after: null });
  return d.build('Remove media');
}

/** Replace a media entry in place (relink to a new path, refreshed probe data). */
export function updateMedia(p: Project, ctx: EditCtx, mediaId: Id, change: Partial<Omit<MediaAsset, 'id'>>): Command {
  const d = new Draft(p, ctx);
  const before = p.media.find((x) => x.id === mediaId);
  if (!before) throw new EditError('Media not found.');
  d.op({ t: 'media', before, after: { ...before, ...change, id: mediaId } });
  return d.build('Relink media');
}

export function setProjectProps(p: Project, ctx: EditCtx, props: Partial<ProjectProps>): Command {
  const d = new Draft(p, ctx);
  d.op({ t: 'projectProps', before: pick(p as ProjectProps, props), after: props });
  return d.build('Change project');
}
