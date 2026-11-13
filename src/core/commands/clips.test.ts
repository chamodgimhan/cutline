import { describe, expect, it } from 'vitest';
import { EditError } from '../command.ts';
import { findClip, makeClip } from '../model.ts';
import { ctxFor, layout, lock, project } from '../testkit.ts';
import { run } from '../testrun.ts';
import { addClips, linkClips, moveClips, removeClips, splitClips, unlinkClips, updateClips } from './clips.ts';

const ctx = () => ctxFor('n');
const clip = (id: string, start: number, duration: number, kind: 'video' | 'audio' = 'video') => makeClip({ id, kind, start, duration, mediaId: 'm' });

describe('addClips / removeClips', () => {
  it('adds into free space and keeps clips sorted', () => {
    const p = project({ V1: [['a', 0, 10], ['c', 30, 10]] });
    const q = run(p, addClips(p, ctx(), [{ trackId: 'V1', clip: clip('b', 10, 20) }]));
    expect(layout(q).V1).toEqual([['a', 0, 10, 0], ['b', 10, 20, 0], ['c', 30, 10, 0]]);
  });

  it('refuses overlap, zero length, negative start, wrong track kind, duplicate id, locked track, source overrun', () => {
    const p = project({ V1: [['a', 0, 10]], A1: [] });
    const add = (c: ReturnType<typeof clip>, track = 'V1', proj = p) => addClips(proj, ctx(), [{ trackId: track, clip: c }]);
    expect(() => add(clip('b', 5, 10))).toThrow(/overlap/);
    expect(() => add(clip('b', 20, 0))).toThrow(EditError);
    expect(() => add(clip('b', -1, 5))).toThrow(/before the beginning/);
    expect(() => add(clip('b', 20, 5), 'A1')).toThrow(/cannot go on/);
    expect(() => add(clip('a', 20, 5))).toThrow(/already/);
    expect(() => add(clip('b', 20, 5), 'V1', lock(p, 'V1'))).toThrow(/locked/);
    expect(() => add({ ...clip('b', 20, 5), sourceIn: 998 })).toThrow(/source media/);
    expect(() => add(clip('b', 20, 5), 'nope')).toThrow(/Track not found/);
  });

  it('removes clips with their linked partners, or alone when asked', () => {
    const p = project({ V1: [['v', 0, 10, 0, { linkId: 'L' }], ['x', 10, 5]], A1: [['a', 0, 10, 0, { linkId: 'L' }]] });
    expect(layout(run(p, removeClips(p, ctx(), ['v'])))).toEqual({ V1: [['x', 10, 5, 0]], A1: [] });
    expect(layout(run(p, removeClips(p, ctx(), ['v'], false))).A1).toHaveLength(1);
    expect(() => removeClips(lock(p, 'A1'), ctx(), ['v'])).toThrow(/locked/);
    expect(() => removeClips(p, ctx(), ['zz'])).toThrow(/not found/);
  });
});

describe('moveClips', () => {
  it('moves in time and clamps at zero', () => {
    const p = project({ V1: [['a', 10, 10], ['b', 30, 10]] });
    expect(layout(run(p, moveClips(p, ctx(), { ids: ['a'], delta: 5 }))).V1?.[0]).toEqual(['a', 15, 10, 0]);
    expect(layout(run(p, moveClips(p, ctx(), { ids: ['a', 'b'], delta: -100 }))).V1).toEqual([['a', 0, 10, 0], ['b', 20, 10, 0]]);
    expect(moveClips(p, ctx(), { ids: ['a'], delta: 0 }).isEmpty).toBe(true);
  });

  it('overwrites what it lands on: trims, splits and removes', () => {
    const p = project({ V1: [['a', 0, 10], ['b', 20, 30], ['c', 60, 4]] });
    // a lands in the middle of b: b splits around it.
    const q = run(p, moveClips(p, ctx(), { ids: ['a'], delta: 30 }));
    expect(layout(q).V1).toEqual([['b', 20, 10, 0], ['a', 30, 10, 0], ['n1', 40, 10, 20], ['c', 60, 4, 0]]);
    // b moved right covers c entirely and c disappears.
    const r = run(p, moveClips(p, ctx(), { ids: ['b'], delta: 35 }));
    expect(layout(r).V1).toEqual([['a', 0, 10, 0], ['b', 55, 30, 0]]);
    // partial overlap trims the head of the clip underneath.
    const s = run(p, moveClips(p, ctx(), { ids: ['a'], delta: 15 }));
    expect(layout(s).V1).toEqual([['a', 15, 10, 0], ['b', 25, 25, 5], ['c', 60, 4, 0]]);
  });

  it('changes track and carries linked clips along in time', () => {
    const p = project({ V1: [['v', 0, 10, 0, { linkId: 'L' }]], V2: [], A1: [['a', 0, 10, 0, { linkId: 'L' }]] });
    const q = run(p, moveClips(p, ctx(), { ids: ['v'], delta: 7, tracks: { v: 'V2' } }));
    expect(layout(q)).toEqual({ V1: [], V2: [['v', 7, 10, 0]], A1: [['a', 7, 10, 0]] });
    expect(() => moveClips(p, ctx(), { ids: ['v'], delta: 0, tracks: { v: 'A1' } })).toThrow(/cannot go on/);
    expect(() => moveClips(lock(p, 'V2'), ctx(), { ids: ['v'], delta: 0, tracks: { v: 'V2' } })).toThrow(/locked/);
    expect(() => moveClips(lock(p, 'A1'), ctx(), { ids: ['v'], delta: 5 })).toThrow(/locked/);
    expect(layout(run(lock(p, 'A1'), moveClips(lock(p, 'A1'), ctx(), { ids: ['v'], delta: 5, linked: false }))).V1).toEqual([['v', 5, 10, 0]]);
  });
});

describe('splitClips', () => {
  it('splits one clip and keeps source continuity', () => {
    const p = project({ V1: [['a', 10, 20, 100]] });
    const q = run(p, splitClips(p, ctx(), { ids: ['a'], at: 18 }));
    expect(layout(q).V1).toEqual([['a', 10, 8, 100], ['n1', 18, 12, 108]]);
  });

  it('refuses a split at an edge or outside the clip (no zero-length parts)', () => {
    const p = project({ V1: [['a', 10, 20]] });
    for (const at of [10, 30, 5, 99]) expect(() => splitClips(p, ctx(), { ids: ['a'], at })).toThrow(/no clip to split/);
  });

  it('splits linked clips together and gives the right halves their own link', () => {
    const p = project({ V1: [['v', 0, 10, 0, { linkId: 'L' }]], A1: [['a', 0, 10, 0, { linkId: 'L' }]] });
    const q = run(p, splitClips(p, ctx(), { ids: ['v'], at: 4 }));
    const seq = q.sequences[0]!;
    const [v2, a2] = [seq.tracks[0]!.clips[1]!, seq.tracks[1]!.clips[1]!];
    expect(v2.linkId).not.toBe('L');
    expect(v2.linkId).toBe(a2.linkId);
    expect(findClip(seq, 'v')?.clip.linkId).toBe('L');
  });

  it('razors every unlocked track under the time and leaves locked tracks alone', () => {
    const p = lock(project({ V1: [['a', 0, 10]], V2: [['b', 5, 10]], A1: [['c', 0, 10]] }), 'A1');
    const q = run(p, splitClips(p, ctx(), { at: 7 }));
    expect(layout(q).V1).toHaveLength(2);
    expect(layout(q).V2).toHaveLength(2);
    expect(layout(q).A1).toHaveLength(1);
  });

  it('handles speed, reverse and freeze', () => {
    const fast = project({ V1: [['a', 0, 10, 100, { speed: { num: 2, den: 1 } }]] });
    expect(layout(run(fast, splitClips(fast, ctx(), { ids: ['a'], at: 4 }))).V1).toEqual([['a', 0, 4, 100], ['n1', 4, 6, 108]]);
    const rev = project({ V1: [['a', 0, 10, 100, { reverse: true }]] });
    // Reversed: the first half on the timeline shows the later half of the source.
    expect(layout(run(rev, splitClips(rev, ctx(), { ids: ['a'], at: 4 }))).V1).toEqual([['a', 0, 4, 106], ['n1', 4, 6, 100]]);
    const still = project({ V1: [['a', 0, 10, 100, { freeze: true }]] });
    expect(layout(run(still, splitClips(still, ctx(), { ids: ['a'], at: 4 }))).V1).toEqual([['a', 0, 4, 100], ['n1', 4, 6, 100]]);
  });

  it('shifts keyframes so animation stays on the same content, and splits fades', () => {
    const key = { t: 6, v: 0.5, interp: 'linear' as const, in: [0, 0] as [number, number], out: [0, 0] as [number, number] };
    const p = project({ A1: [['a', 0, 10, 0, { audio: { gain: { keys: [key] }, fadeIn: 2, fadeOut: 3 } }]] });
    const q = run(p, splitClips(p, ctx(), { ids: ['a'], at: 4 }));
    const [l, r] = q.sequences[0]!.tracks[0]!.clips as [typeof q.sequences[0]['tracks'][0]['clips'][0], typeof q.sequences[0]['tracks'][0]['clips'][0]];
    expect(l.audio).toEqual({ gain: { keys: [key] }, fadeIn: 2, fadeOut: 0 });
    expect(r.audio).toEqual({ gain: { keys: [{ ...key, t: 2 }] }, fadeIn: 0, fadeOut: 3 });
  });
});

describe('updateClips / link / unlink', () => {
  it('changes properties but never ids, and respects locks', () => {
    const p = project({ V1: [['a', 0, 10]] });
    const q = run(p, updateClips(p, ctx(), ['a'], (c) => ({ ...c, id: 'hack', name: 'Hello', enabled: false })));
    expect(findClip(q.sequences[0]!, 'a')?.clip).toMatchObject({ name: 'Hello', enabled: false });
    expect(updateClips(p, ctx(), ['a'], (c) => c).isEmpty).toBe(true);
    expect(() => updateClips(lock(p, 'V1'), ctx(), ['a'], (c) => ({ ...c, name: 'x' }))).toThrow(/locked/);
  });

  it('links and unlinks', () => {
    const p = project({ V1: [['v', 0, 10]], A1: [['a', 0, 10]] });
    const q = run(p, linkClips(p, ctx(), ['v', 'a']));
    const seq = q.sequences[0]!;
    expect(findClip(seq, 'v')?.clip.linkId).toBe('n1');
    expect(findClip(seq, 'a')?.clip.linkId).toBe('n1');
    const r = run(q, unlinkClips(q, ctx(), ['a']));
    expect(findClip(r.sequences[0]!, 'v')?.clip.linkId).toBeNull();
    expect(() => linkClips(p, ctx(), ['v'])).toThrow(/at least two/);
    expect(() => unlinkClips(p, ctx(), ['v'])).toThrow(/not linked/);
  });
});
