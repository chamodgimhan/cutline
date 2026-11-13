// A Draft is a scratch copy of one sequence's clips. Edit functions change the
// draft, then build() diffs it against the original into a validated Command.
import { splitClipAt, resizeHead, resizeTail } from './clipmath.ts';
import { Command, EditError, type Op } from './command.ts';
import { checkInvariants } from './invariants.ts';
import { clipEnd, getSequence, TRACK_ACCEPTS, type Clip, type Id, type Project, type Sequence, type Track } from './model.ts';
import type { Tick } from './time.ts';

export interface EditCtx {
  /** Source of ids for clips, tracks and markers the edit creates. */
  newId: () => Id;
  /** Sequence to edit; defaults to the active one. */
  seqId?: Id;
}

export interface Located {
  track: Track;
  clip: Clip;
}

function explain(errors: string[]): string {
  const e = errors[0] ?? '';
  if (e.includes('overlaps')) return 'Clips would overlap.';
  if (e.includes('source range')) return 'Not enough source media for that edit.';
  if (e.includes('negative time')) return 'Clips cannot start before the beginning of the sequence.';
  if (e.includes('duration')) return 'A clip cannot have zero length.';
  if (e.includes('track')) return 'That clip type does not belong on this track.';
  return 'That edit is not possible.';
}

export class Draft {
  readonly project: Project;
  readonly seq: Sequence;
  readonly newId: () => Id;
  private readonly work = new Map<Id, Map<Id, Clip>>();
  private readonly sortedCache = new Map<Id, Clip[]>();
  private readonly extra: Op[] = [];

  constructor(project: Project, ctx: EditCtx) {
    this.project = project;
    this.seq = getSequence(project, ctx.seqId);
    this.newId = ctx.newId;
  }

  track(id: Id): Track {
    const t = this.seq.tracks.find((x) => x.id === id);
    if (!t) throw new EditError('Track not found.');
    return t;
  }

  /** Current clips of a track, sorted by start. */
  clips(trackId: Id): Clip[] {
    const w = this.work.get(trackId);
    if (!w) return this.track(trackId).clips;
    let s = this.sortedCache.get(trackId);
    if (!s) {
      s = [...w.values()].sort((a, b) => a.start - b.start);
      this.sortedCache.set(trackId, s);
    }
    return s;
  }

  find(clipId: Id): Located | undefined {
    for (const track of this.seq.tracks) {
      const w = this.work.get(track.id);
      const clip = w ? w.get(clipId) : track.clips.find((c) => c.id === clipId);
      if (clip) return { track, clip };
    }
    return undefined;
  }

  need(clipId: Id): Located {
    const hit = this.find(clipId);
    if (!hit) throw new EditError('Clip not found.');
    return hit;
  }

  private writable(trackId: Id): Map<Id, Clip> {
    const track = this.track(trackId);
    if (track.locked) throw new EditError(`Track "${track.name}" is locked.`);
    let w = this.work.get(trackId);
    if (!w) {
      w = new Map(track.clips.map((c) => [c.id, c]));
      this.work.set(trackId, w);
    }
    this.sortedCache.delete(trackId);
    return w;
  }

  /** Add or replace a clip on a track. */
  put(trackId: Id, clip: Clip): void {
    const track = this.track(trackId);
    if (!TRACK_ACCEPTS[track.kind].includes(clip.kind)) throw new EditError(`A ${clip.kind} clip cannot go on a ${track.kind} track.`);
    const old = this.find(clip.id);
    if (old && old.track.id !== trackId) this.writable(old.track.id).delete(clip.id);
    this.writable(trackId).set(clip.id, clip);
  }

  remove(clipId: Id): void {
    const hit = this.need(clipId);
    this.writable(hit.track.id).delete(clipId);
  }

  /** The clip and everything linked to it. With `follow` false, just the clip. */
  linked(clipId: Id, follow = true): Located[] {
    const hit = this.need(clipId);
    if (!follow || hit.clip.linkId === null) return [hit];
    const out: Located[] = [];
    for (const track of this.seq.tracks) for (const clip of this.clips(track.id)) if (clip.linkId === hit.clip.linkId) out.push({ track, clip });
    return out;
  }

  /** Expand a selection with linked clips, without duplicates. */
  expand(ids: readonly Id[], follow = true): Located[] {
    const seen = new Set<Id>();
    const out: Located[] = [];
    for (const id of ids) {
      for (const hit of this.linked(id, follow)) {
        if (seen.has(hit.clip.id)) continue;
        seen.add(hit.clip.id);
        out.push(hit);
      }
    }
    return out;
  }

  unlockedTracks(): Track[] {
    return this.seq.tracks.filter((t) => !t.locked);
  }

  /** Remove everything in [a, b) on a track: trims partial overlaps, splits a clip that spans the range. */
  clearRange(trackId: Id, a: Tick, b: Tick, keep: ReadonlySet<Id> = new Set()): void {
    if (b <= a) return;
    for (const c of this.clips(trackId).slice()) {
      if (keep.has(c.id) || clipEnd(c) <= a || c.start >= b) continue;
      const before = c.start < a;
      const after = clipEnd(c) > b;
      if (before && after) {
        const [left, rest] = splitClipAt(this.project, c, a, this.newId());
        this.put(trackId, left);
        this.put(trackId, resizeHead(this.project, rest, b));
      } else if (before) this.put(trackId, { ...resizeTail(this.project, c, a), transitionOut: null });
      else if (after) this.put(trackId, { ...resizeHead(this.project, c, b), transitionIn: null });
      else this.remove(c.id);
    }
  }

  /** Largest distance clips starting at or after `from` can move left without hitting earlier clips. */
  maxLeftShift(from: Tick, ignore: ReadonlySet<Id> = new Set()): number {
    let room = Infinity;
    for (const track of this.unlockedTracks()) {
      let stayEnd = 0;
      let first: Clip | undefined;
      for (const c of this.clips(track.id)) {
        if (ignore.has(c.id)) continue;
        if (c.start >= from) {
          first = c;
          break;
        }
        stayEnd = clipEnd(c);
      }
      if (first) room = Math.min(room, first.start - stayEnd);
    }
    return room;
  }

  /** Move every clip starting at or after `from` on unlocked tracks by `delta`. */
  shiftFrom(from: Tick, delta: Tick, ignore: ReadonlySet<Id> = new Set()): void {
    if (delta === 0) return;
    for (const track of this.unlockedTracks()) {
      for (const c of this.clips(track.id).slice()) if (c.start >= from && !ignore.has(c.id)) this.put(track.id, { ...c, start: c.start + delta });
    }
  }

  /** Split every clip crossing `at` on unlocked tracks (used before an insert). */
  splitAllAt(at: Tick): void {
    for (const track of this.unlockedTracks()) {
      const c = this.clips(track.id).find((x) => x.start < at && clipEnd(x) > at);
      if (!c) continue;
      const [l, r] = splitClipAt(this.project, c, at, this.newId());
      this.put(track.id, l);
      this.put(track.id, r);
    }
  }

  /** Queue a non-clip operation (applied after clip changes). */
  op(op: Op): void {
    this.extra.push(op);
  }

  /** Diff against the original and return a validated command. Throws EditError if the result is invalid. */
  build(label: string): Command {
    const ops: Op[] = [];
    const adds: Op[] = [];
    for (const [trackId, w] of this.work) {
      const original = new Map(this.track(trackId).clips.map((c) => [c.id, c]));
      for (const [id, before] of original) {
        const after = w.get(id) ?? null;
        if (after !== before) ops.push({ t: 'clip', seq: this.seq.id, track: trackId, before, after });
      }
      for (const [id, after] of w) if (!original.has(id)) adds.push({ t: 'clip', seq: this.seq.id, track: trackId, before: null, after });
    }
    const cmd = new Command(label, [...ops, ...adds, ...this.extra]);
    const errors = checkInvariants(cmd.apply(this.project));
    if (errors.length) throw new EditError(explain(errors));
    return cmd;
  }
}
