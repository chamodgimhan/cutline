// Random projects and random commands for property tests and fuzzing.
import { EditError, type Command } from './command.ts';
import { addClips, linkClips, moveClips, removeClips, splitClips, unlinkClips, updateClips } from './commands/clips.ts';
import { extractRange, insertClips, liftRange, overwriteClips, rippleDelete } from './commands/range.ts';
import { addMarker, addMedia, addTrack, moveTrack, removeMarker, removeTrack, setRange, setTrackProps, updateMarker, updateMedia } from './commands/tracks.ts';
import { rippleTrim, rollEdit, slideClip, slipClip, trimClip } from './commands/trim.ts';
import type { EditCtx } from './draft.ts';
import { makeClip, makeProject, makeSequence, makeTrack, type Clip, type Id, type Project, type Track, type TrackKind } from './model.ts';
import { testMedia } from './testkit.ts';

type Rnd = () => number;
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rnd, list: readonly T[]): T | undefined => list[Math.floor(r() * list.length)];
const chance = (r: Rnd, p: number): boolean => r() < p;

const SPEEDS = [{ num: 1, den: 1 }, { num: 1, den: 1 }, { num: 2, den: 1 }, { num: 1, den: 2 }, { num: 3, den: 2 }];

function randomClip(r: Rnd, id: Id, kind: TrackKind, start: number): Clip {
  const duration = int(r, 1, 40);
  if (kind === 'caption') return makeClip({ id, kind: 'caption', start, duration });
  if (kind === 'video' && chance(r, 0.15)) return makeClip({ id, kind: chance(r, 0.5) ? 'text' : 'adjust', start, duration });
  return makeClip({
    id, kind, start, duration, mediaId: kind === 'video' && chance(r, 0.1) ? 'img' : 'm', sourceIn: int(r, 0, 800),
    speed: pick(r, SPEEDS) ?? { num: 1, den: 1 }, reverse: chance(r, 0.15), freeze: chance(r, 0.05),
  });
}

/** A small valid project: a few tracks of each kind with scattered clips, some linked. */
export function randomProject(r: Rnd, newId: () => Id): Project {
  const seq = makeSequence('seq');
  const kinds: TrackKind[] = ['video', 'video', 'audio', 'audio', 'caption'];
  kinds.slice(0, int(r, 2, 5)).forEach((kind, i) => {
    const t = makeTrack(`t${i}`, kind, `${kind[0]?.toUpperCase()}${i}`);
    let at = int(r, 0, 10);
    for (let n = int(r, 0, 6); n > 0; n--) {
      const c = randomClip(r, newId(), kind, at);
      t.clips.push(c);
      at += c.duration + (chance(r, 0.5) ? 0 : int(r, 1, 15));
    }
    seq.tracks.push(t);
  });
  // Link a few video clips to audio clips.
  const v = seq.tracks.find((t) => t.kind === 'video')?.clips ?? [];
  const a = seq.tracks.find((t) => t.kind === 'audio')?.clips ?? [];
  for (let i = 0; i < Math.min(v.length, a.length, 2); i++) {
    const linkId = newId();
    (v[i] as Clip).linkId = linkId;
    (a[i] as Clip).linkId = linkId;
  }
  const p = makeProject(seq);
  p.media = [testMedia('img', 0, 'image'), testMedia('m', 1000)];
  return p;
}

/** One random edit against the current project, or null if that edit is not possible there. */
export function randomCommand(p: Project, ctx: EditCtx, r: Rnd): Command | null {
  const seq = p.sequences[0];
  if (!seq) return null;
  const tracks = seq.tracks;
  const clips = tracks.flatMap((t) => t.clips);
  const clip = pick(r, clips);
  const track = pick(r, tracks) as Track | undefined;
  const id = clip?.id ?? 'none';
  const ids = clips.filter(() => chance(r, 0.2)).map((c) => c.id);
  const some = ids.length ? ids : [id];
  const t = int(r, -5, 420);
  const linked = chance(r, 0.8);
  const edge = chance(r, 0.5) ? 'in' : 'out';
  const fresh = (): { trackId: Id; clip: Clip }[] => (track ? [{ trackId: track.id, clip: randomClip(r, ctx.newId(), track.kind, Math.max(0, t)) }] : []);
  const edits: (() => Command)[] = [
    () => addClips(p, ctx, fresh()),
    () => removeClips(p, ctx, some, linked),
    () => moveClips(p, ctx, { ids: some, delta: int(r, -60, 60), linked, tracks: clip && track && chance(r, 0.3) ? { [clip.id]: track.id } : undefined }),
    () => splitClips(p, ctx, chance(r, 0.5) ? { at: t } : { at: clip ? clip.start + int(r, 0, clip.duration) : t, ids: [id], linked }),
    () => trimClip(p, ctx, { id, edge, to: t, linked, minDuration: int(r, 1, 3) }),
    () => rippleTrim(p, ctx, { id, edge, to: t, linked }),
    () => rollEdit(p, ctx, { id, edge, to: clip ? (edge === 'in' ? clip.start : clip.start + clip.duration) + int(r, -20, 20) : t, linked }),
    () => slipClip(p, ctx, { id, by: int(r, -100, 100), linked }),
    () => slideClip(p, ctx, { id, delta: int(r, -30, 30), linked }),
    () => insertClips(p, ctx, { at: t, items: fresh() }),
    () => overwriteClips(p, ctx, { at: t, items: fresh() }),
    () => liftRange(p, ctx, { start: t, end: t + int(r, 0, 60), trackIds: chance(r, 0.5) && track ? [track.id] : undefined }),
    () => extractRange(p, ctx, { start: t, end: t + int(r, 0, 60) }),
    () => rippleDelete(p, ctx, some, linked),
    () => linkClips(p, ctx, some),
    () => unlinkClips(p, ctx, some),
    () => updateClips(p, ctx, some, (c) => ({ ...c, name: `n${int(r, 0, 9)}`, enabled: chance(r, 0.8), speed: chance(r, 0.2) ? (pick(r, SPEEDS) ?? c.speed) : c.speed })),
    () => addTrack(p, ctx, { kind: pick(r, ['video', 'audio', 'caption'] as const) ?? 'video', index: int(r, 0, 6) }),
    () => removeTrack(p, ctx, tracks.length > 2 ? (track?.id ?? '') : 'keep-some-tracks'),
    () => moveTrack(p, ctx, track?.id ?? '', int(r, 0, 5)),
    () => setTrackProps(p, ctx, track?.id ?? '', { locked: chance(r, 0.4), muted: chance(r, 0.5), solo: chance(r, 0.2), hidden: chance(r, 0.2) }),
    () => addMarker(p, ctx, { time: t, name: 'mk', duration: chance(r, 0.3) ? int(r, 1, 20) : 0 }),
    () => removeMarker(p, ctx, pick(r, seq.markers)?.id ?? ''),
    () => updateMarker(p, ctx, pick(r, seq.markers)?.id ?? '', { time: t, name: 'moved' }),
    () => setRange(p, ctx, chance(r, 0.2) ? null : t, chance(r, 0.2) ? null : t + int(r, -10, 80)),
    () => addMedia(p, ctx, [testMedia(ctx.newId(), int(r, 1, 500))]),
    () => updateMedia(p, ctx, 'm', { duration: int(r, 900, 1100), path: `/moved/${int(r, 0, 9)}.mp4` }),
  ];
  try {
    return (pick(r, edits) as () => Command)();
  } catch (e) {
    if (e instanceof EditError) return null;
    throw e;
  }
}
