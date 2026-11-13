// Commands. A command is a list of primitive operations, each carrying the value
// before and after, so applying and inverting are mechanical and always exact.
import type { Clip, Id, Marker, MediaAsset, Project, Sequence, Track } from './model.ts';

export type SeqProps = Pick<Sequence, 'name' | 'width' | 'height' | 'fps' | 'sampleRate' | 'inPoint' | 'outPoint'>;
export type TrackProps = Omit<Track, 'id' | 'kind' | 'clips'>;
export type ProjectProps = Pick<Project, 'name' | 'activeSequenceId'>;

export type Op =
  | { t: 'clip'; seq: Id; track: Id; before: Clip | null; after: Clip | null }
  | { t: 'track'; seq: Id; before: { track: Track; index: number } | null; after: { track: Track; index: number } | null }
  | { t: 'trackProps'; seq: Id; track: Id; before: Partial<TrackProps>; after: Partial<TrackProps> }
  | { t: 'marker'; seq: Id; before: Marker | null; after: Marker | null }
  | { t: 'seqProps'; seq: Id; before: Partial<SeqProps>; after: Partial<SeqProps> }
  | { t: 'sequence'; before: { sequence: Sequence; index: number } | null; after: { sequence: Sequence; index: number } | null }
  | { t: 'media'; before: MediaAsset | null; after: MediaAsset | null }
  | { t: 'projectProps'; before: Partial<ProjectProps>; after: Partial<ProjectProps> };

/** Thrown when an edit is not possible. The message is safe to show to the user. */
export class EditError extends Error {
  override name = 'EditError';
}

const invertOp = (op: Op): Op => ({ ...op, before: op.after, after: op.before }) as Op;

const byStart = (a: Clip, b: Clip): number => a.start - b.start;

function mapSeq(p: Project, id: Id, fn: (s: Sequence) => Sequence): Project {
  let found = false;
  const sequences = p.sequences.map((s) => {
    if (s.id !== id) return s;
    found = true;
    return fn(s);
  });
  if (!found) throw new Error(`Command does not match project: no sequence ${id}`);
  return { ...p, sequences };
}

function setById<T extends { id: Id }>(list: T[], before: T | null, after: T | null, what: string): T[] {
  const id = (before ?? after)?.id;
  const at = list.findIndex((x) => x.id === id);
  if ((at >= 0) !== (before !== null)) throw new Error(`Command does not match project: ${what} ${id}`);
  if (before && after) return list.map((x, i) => (i === at ? after : x));
  if (before) return list.filter((_, i) => i !== at);
  return after ? [...list, after] : list;
}

function setAtIndex<T extends { id: Id }>(list: T[], before: { item: T; index: number } | null, after: { item: T; index: number } | null, what: string): T[] {
  const out = list.slice();
  if (before) {
    if (out[before.index]?.id !== before.item.id) throw new Error(`Command does not match project: ${what} ${before.item.id}`);
    out.splice(before.index, 1);
  }
  if (after) {
    if (after.index < 0 || after.index > out.length || out.some((x) => x.id === after.item.id)) throw new Error(`Command does not match project: ${what} ${after.item.id}`);
    out.splice(after.index, 0, after.item);
  }
  return out;
}

/** Apply a run of clip operations on one sequence in a single pass per track. */
function applyClipOps(p: Project, seqId: Id, ops: Extract<Op, { t: 'clip' }>[]): Project {
  const byTrack = new Map<Id, Extract<Op, { t: 'clip' }>[]>();
  for (const op of ops) {
    const list = byTrack.get(op.track);
    if (list) list.push(op);
    else byTrack.set(op.track, [op]);
  }
  return mapSeq(p, seqId, (s) => {
    const seen = new Set<Id>();
    const tracks = s.tracks.map((track) => {
      const list = byTrack.get(track.id);
      if (!list) return track;
      seen.add(track.id);
      const clips = new Map(track.clips.map((c) => [c.id, c]));
      for (const op of list) {
        const id = (op.before ?? op.after)?.id as Id;
        if (clips.has(id) !== (op.before !== null)) throw new Error(`Command does not match project: clip ${id}`);
        if (op.after) clips.set(id, op.after);
        else clips.delete(id);
      }
      return { ...track, clips: [...clips.values()].sort(byStart) };
    });
    if (seen.size !== byTrack.size) throw new Error('Command does not match project: track missing');
    return { ...s, tracks };
  });
}

function applyOp(p: Project, op: Exclude<Op, { t: 'clip' }>): Project {
  switch (op.t) {
    case 'track':
      return mapSeq(p, op.seq, (s) => ({
        ...s,
        tracks: setAtIndex(s.tracks, op.before && { item: op.before.track, index: op.before.index }, op.after && { item: op.after.track, index: op.after.index }, 'track'),
      }));
    case 'trackProps':
      return mapSeq(p, op.seq, (s) => {
        if (!s.tracks.some((t) => t.id === op.track)) throw new Error(`Command does not match project: track ${op.track}`);
        return { ...s, tracks: s.tracks.map((t) => (t.id === op.track ? { ...t, ...op.after } : t)) };
      });
    case 'marker':
      return mapSeq(p, op.seq, (s) => ({ ...s, markers: setById(s.markers, op.before, op.after, 'marker').slice().sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1)) }));
    case 'seqProps':
      return mapSeq(p, op.seq, (s) => ({ ...s, ...op.after }));
    case 'sequence':
      return {
        ...p,
        sequences: setAtIndex(p.sequences, op.before && { item: op.before.sequence, index: op.before.index }, op.after && { item: op.after.sequence, index: op.after.index }, 'sequence'),
      };
    case 'media':
      return { ...p, media: setById(p.media, op.before, op.after, 'media').slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
    case 'projectProps':
      return { ...p, ...op.after };
  }
}

export function applyOps(project: Project, ops: readonly Op[]): Project {
  let p = project;
  let run: Extract<Op, { t: 'clip' }>[] = [];
  const flush = (): void => {
    const first = run[0];
    if (!first) return;
    p = applyClipOps(p, first.seq, run);
    run = [];
  };
  for (const op of ops) {
    if (op.t === 'clip') {
      if (run[0] && run[0].seq !== op.seq) flush();
      run.push(op);
    } else {
      flush();
      p = applyOp(p, op);
    }
  }
  flush();
  return p;
}

export class Command {
  readonly label: string;
  readonly ops: readonly Op[];

  constructor(label: string, ops: readonly Op[]) {
    this.label = label;
    this.ops = ops;
  }

  /** Returns the project after this command. Throws if the command was built for a different state. */
  apply(project: Project): Project {
    return applyOps(project, this.ops);
  }

  /** The command that exactly undoes this one. */
  invert(): Command {
    return new Command(this.label, this.ops.map(invertOp).reverse());
  }

  get isEmpty(): boolean {
    return this.ops.length === 0;
  }

  /** One command doing `commands` in order. */
  static group(label: string, commands: readonly Command[]): Command {
    return new Command(label, commands.flatMap((c) => c.ops));
  }
}
