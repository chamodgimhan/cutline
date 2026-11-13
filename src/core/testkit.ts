// Helpers for tests and fuzzing: deterministic ids and random numbers, small project builders.
import type { EditCtx } from './draft.ts';
import { makeClip, makeProject, makeSequence, makeTrack, type Clip, type ClipKind, type Id, type MediaAsset, type Project, type TrackKind } from './model.ts';

/** Counter-based id source: prefix1, prefix2, ... */
export function idSource(prefix = 'n'): () => Id {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export const ctxFor = (prefix = 'n'): EditCtx => ({ newId: idSource(prefix) });

/** Small fast seeded generator (mulberry32). Returns floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const testMedia = (id: Id, duration: number, kind: MediaAsset['kind'] = 'video'): MediaAsset => ({
  id, name: id, path: `/media/${id}.mp4`, fingerprint: `fp-${id}`, kind, duration,
  video: kind === 'audio' ? null : { width: 320, height: 180, fps: { num: 30, den: 1 }, rotation: 0, vfr: false },
  audio: kind === 'image' ? null : { sampleRate: 48000, channels: 2 },
});

/** [id, start, duration, sourceIn?, extra?] */
export type ClipSpec = [Id, number, number, number?, Partial<Clip>?];

const kindOf = (track: string): TrackKind => (track.startsWith('A') ? 'audio' : track.startsWith('C') ? 'caption' : 'video');
const clipKindOf: Record<TrackKind, ClipKind> = { video: 'video', audio: 'audio', caption: 'caption' };

/**
 * Build a project from a track map, e.g. { V1: [['a', 0, 10]], A1: [['b', 0, 10]] }.
 * Track ids equal their names. Clips use media 'm' (duration 1000) unless overridden; captions use none.
 */
export function project(tracks: Record<string, ClipSpec[]>, mediaDuration = 1000): Project {
  const seq = makeSequence('seq');
  for (const [name, specs] of Object.entries(tracks)) {
    const kind = kindOf(name);
    const t = makeTrack(name, kind, name);
    t.clips = specs
      .map(([id, start, duration, sourceIn = 0, extra = {}]) =>
        makeClip({ id, kind: clipKindOf[kind], start, duration, sourceIn, mediaId: kind === 'caption' ? null : 'm', ...extra }))
      .sort((a, b) => a.start - b.start);
    seq.tracks.push(t);
  }
  const p = makeProject(seq);
  p.media = [testMedia('m', mediaDuration)];
  return p;
}

/** Compact view of a sequence for assertions: track -> [id, start, duration, sourceIn][]. */
export function layout(p: Project): Record<string, [Id, number, number, number][]> {
  const out: Record<string, [Id, number, number, number][]> = {};
  for (const t of p.sequences[0]?.tracks ?? []) out[t.id] = t.clips.map((c) => [c.id, c.start, c.duration, c.sourceIn]);
  return out;
}

export function lock(p: Project, trackId: Id): Project {
  return { ...p, sequences: p.sequences.map((s) => ({ ...s, tracks: s.tracks.map((t) => (t.id === trackId ? { ...t, locked: true } : t)) })) };
}
