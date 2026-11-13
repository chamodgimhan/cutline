import { describe, expect, it } from 'vitest';
import { ctxFor, layout, lock, project } from '../testkit.ts';
import { run } from '../testrun.ts';
import { rippleTrim, rollEdit, slideClip, slipClip, trimClip } from './trim.ts';

const ctx = () => ctxFor('n');

describe('trimClip', () => {
  const p = project({ V1: [['a', 10, 20, 50], ['b', 40, 10, 0]] });

  it('trims the in edge and moves the source in point with it', () => {
    expect(layout(run(p, trimClip(p, ctx(), { id: 'a', edge: 'in', to: 15 }))).V1?.[0]).toEqual(['a', 15, 15, 55]);
    expect(layout(run(p, trimClip(p, ctx(), { id: 'a', edge: 'in', to: 4 }))).V1?.[0]).toEqual(['a', 4, 26, 44]);
  });

  it('trims the out edge', () => {
    expect(layout(run(p, trimClip(p, ctx(), { id: 'a', edge: 'out', to: 22 }))).V1?.[0]).toEqual(['a', 10, 12, 50]);
  });

  it('stops at the neighbour, at the media limits, at zero, and at the minimum length', () => {
    expect(layout(run(p, trimClip(p, ctx(), { id: 'a', edge: 'out', to: 90 }))).V1?.[0]).toEqual(['a', 10, 30, 50]);
    expect(layout(run(p, trimClip(p, ctx(), { id: 'b', edge: 'in', to: 0 }))).V1?.[1]).toEqual(['b', 40, 10, 0]); // no head handle
    const q = project({ V1: [['a', 5, 20, 50]] }, 80);
    expect(layout(run(q, trimClip(q, ctx(), { id: 'a', edge: 'in', to: -50 }))).V1?.[0]).toEqual(['a', 0, 25, 45]);
    expect(layout(run(q, trimClip(q, ctx(), { id: 'a', edge: 'out', to: 500 }))).V1?.[0]).toEqual(['a', 5, 30, 50]); // media ends at 80
    expect(layout(run(q, trimClip(q, ctx(), { id: 'a', edge: 'out', to: 0 }))).V1?.[0]).toEqual(['a', 5, 1, 50]);
    expect(layout(run(q, trimClip(q, ctx(), { id: 'a', edge: 'in', to: 999, minDuration: 4 }))).V1?.[0]).toEqual(['a', 21, 4, 66]);
  });

  it('is a no-op command when nothing can change', () => {
    expect(trimClip(p, ctx(), { id: 'b', edge: 'in', to: 30 }).isEmpty).toBe(true);
    expect(() => trimClip(lock(p, 'V1'), ctx(), { id: 'a', edge: 'out', to: 20 })).toThrow(/locked/);
  });

  it('trims linked clips by the same amount, limited by the tightest one', () => {
    const q = project({ V1: [['v', 10, 20, 50, { linkId: 'L' }]], A1: [['a', 10, 20, 3, { linkId: 'L' }]] });
    const r = run(q, trimClip(q, ctx(), { id: 'v', edge: 'in', to: 0 }));
    expect(layout(r)).toEqual({ V1: [['v', 7, 23, 47]], A1: [['a', 7, 23, 0]] });
    expect(layout(run(q, trimClip(q, ctx(), { id: 'v', edge: 'in', to: 0, linked: false }))).V1).toEqual([['v', 0, 30, 40]]);
  });

  it('respects speed and reverse when computing source and limits', () => {
    const fast = project({ V1: [['a', 10, 10, 100, { speed: { num: 2, den: 1 } }]] }, 200);
    expect(layout(run(fast, trimClip(fast, ctx(), { id: 'a', edge: 'in', to: 13 }))).V1).toEqual([['a', 13, 7, 106]]);
    expect(layout(run(fast, trimClip(fast, ctx(), { id: 'a', edge: 'out', to: 999 }))).V1).toEqual([['a', 10, 50, 100]]);
    const rev = project({ V1: [['a', 10, 10, 100, { reverse: true }]] }, 200);
    // Reversed: extending the out edge reveals earlier source.
    expect(layout(run(rev, trimClip(rev, ctx(), { id: 'a', edge: 'out', to: 25 }))).V1).toEqual([['a', 10, 15, 95]]);
    expect(layout(run(rev, trimClip(rev, ctx(), { id: 'a', edge: 'in', to: 0 }))).V1).toEqual([['a', 0, 20, 100]]);
    const text = project({ C1: [['t', 10, 10]] });
    expect(layout(run(text, trimClip(text, ctx(), { id: 't', edge: 'in', to: 2 }))).C1).toEqual([['t', 2, 18, 0]]);
  });
});

describe('rippleTrim', () => {
  const p = project({ V1: [['a', 0, 20, 10], ['b', 20, 10]], A1: [['x', 25, 5]], V2: [['k', 5, 10]] });

  it('shortens the out edge and pulls later clips on every track', () => {
    const q = run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'out', to: 16 }));
    expect(layout(q)).toEqual({ V1: [['a', 0, 16, 10], ['b', 16, 10, 0]], A1: [['x', 21, 5, 0]], V2: [['k', 5, 10, 0]] });
  });

  it('lengthens the out edge and pushes later clips', () => {
    const q = run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'out', to: 26 }));
    expect(layout(q).V1).toEqual([['a', 0, 26, 10], ['b', 26, 10, 0]]);
    expect(layout(q).A1).toEqual([['x', 31, 5, 0]]);
  });

  it('ripples the in edge: the clip keeps its start, loses its head', () => {
    const q = run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'in', to: 6 }));
    expect(layout(q).V1).toEqual([['a', 0, 14, 16], ['b', 14, 10, 0]]);
    const r = run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'in', to: -4 }));
    expect(layout(r).V1).toEqual([['a', 0, 24, 6], ['b', 24, 10, 0]]);
  });

  it('is limited by media, by minimum length and by clips in the way on other tracks', () => {
    expect(layout(run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'in', to: -500 }))).V1?.[0]).toEqual(['a', 0, 30, 0]);
    expect(layout(run(p, rippleTrim(p, ctx(), { id: 'a', edge: 'out', to: -500 }))).V1?.[0]).toEqual(['a', 0, 1, 10]);
    const blocked = project({ V1: [['a', 0, 20], ['b', 20, 10]], A1: [['w', 0, 18], ['x', 20, 5]] });
    // x can only move left by 2 before it hits w.
    expect(layout(run(blocked, rippleTrim(blocked, ctx(), { id: 'a', edge: 'out', to: 10 })))).toEqual({ V1: [['a', 0, 18, 0], ['b', 18, 10, 0]], A1: [['w', 0, 18, 0], ['x', 18, 5, 0]] });
  });

  it('leaves locked tracks untouched', () => {
    const q = lock(p, 'A1');
    expect(layout(run(q, rippleTrim(q, ctx(), { id: 'a', edge: 'out', to: 16 }))).A1).toEqual([['x', 25, 5, 0]]);
  });
});

describe('rollEdit', () => {
  const p = project({ V1: [['a', 0, 20, 10], ['b', 20, 20, 30], ['c', 50, 5]] });

  it('moves the cut both ways from either side', () => {
    expect(layout(run(p, rollEdit(p, ctx(), { id: 'b', edge: 'in', to: 25 }))).V1).toEqual([['a', 0, 25, 10], ['b', 25, 15, 35], ['c', 50, 5, 0]]);
    expect(layout(run(p, rollEdit(p, ctx(), { id: 'a', edge: 'out', to: 12 }))).V1).toEqual([['a', 0, 12, 10], ['b', 12, 28, 22], ['c', 50, 5, 0]]);
  });

  it('clamps to handles and to the minimum length', () => {
    expect(layout(run(p, rollEdit(p, ctx(), { id: 'b', edge: 'in', to: -99 }))).V1?.[0]).toEqual(['a', 0, 1, 10]);
    expect(layout(run(p, rollEdit(p, ctx(), { id: 'b', edge: 'in', to: 999, minDuration: 2 }))).V1?.[1]).toEqual(['b', 38, 2, 48]);
    const tight = project({ V1: [['a', 0, 20, 10], ['b', 20, 20, 3]] });
    expect(layout(run(tight, rollEdit(tight, ctx(), { id: 'b', edge: 'in', to: 0 }))).V1).toEqual([['a', 0, 17, 10], ['b', 17, 23, 0]]);
  });

  it('needs an adjoining clip', () => {
    expect(() => rollEdit(p, ctx(), { id: 'c', edge: 'in', to: 48 })).toThrow(/no adjoining clip/);
    expect(() => rollEdit(p, ctx(), { id: 'a', edge: 'in', to: 2 })).toThrow(/no adjoining clip/);
  });

  it('rolls the matching cut on linked tracks', () => {
    const q = project({
      V1: [['a', 0, 20, 10, { linkId: 'L1' }], ['b', 20, 20, 30, { linkId: 'L2' }]],
      A1: [['x', 0, 20, 10, { linkId: 'L1' }], ['y', 20, 20, 30, { linkId: 'L2' }]],
    });
    const r = run(q, rollEdit(q, ctx(), { id: 'b', edge: 'in', to: 24 }));
    expect(layout(r).A1).toEqual([['x', 0, 24, 10], ['y', 24, 16, 34]]);
  });
});

describe('slipClip', () => {
  const p = project({ V1: [['a', 10, 20, 50]] }, 100);

  it('changes the source range only, clamped to the media', () => {
    expect(layout(run(p, slipClip(p, ctx(), { id: 'a', by: 7 }))).V1).toEqual([['a', 10, 20, 57]]);
    expect(layout(run(p, slipClip(p, ctx(), { id: 'a', by: 500 }))).V1).toEqual([['a', 10, 20, 80]]);
    expect(layout(run(p, slipClip(p, ctx(), { id: 'a', by: -500 }))).V1).toEqual([['a', 10, 20, 0]]);
  });

  it('does nothing for clips without timed media', () => {
    const q = project({ C1: [['t', 0, 10]] });
    expect(slipClip(q, ctx(), { id: 't', by: 5 }).isEmpty).toBe(true);
  });
});

describe('slideClip', () => {
  const p = project({ V1: [['a', 0, 20, 10], ['b', 20, 10, 40], ['c', 30, 20, 30]] });

  it('moves the clip and trims both neighbours to follow', () => {
    expect(layout(run(p, slideClip(p, ctx(), { id: 'b', delta: 5 }))).V1).toEqual([['a', 0, 25, 10], ['b', 25, 10, 40], ['c', 35, 15, 35]]);
    expect(layout(run(p, slideClip(p, ctx(), { id: 'b', delta: -5 }))).V1).toEqual([['a', 0, 15, 10], ['b', 15, 10, 40], ['c', 25, 25, 25]]);
  });

  it('clamps to neighbour length and handles', () => {
    expect(layout(run(p, slideClip(p, ctx(), { id: 'b', delta: 999 }))).V1).toEqual([['a', 0, 39, 10], ['b', 39, 10, 40], ['c', 49, 1, 49]]);
    expect(layout(run(p, slideClip(p, ctx(), { id: 'b', delta: -999 }))).V1).toEqual([['a', 0, 1, 10], ['b', 1, 10, 40], ['c', 11, 39, 11]]);
    const noHandle = project({ V1: [['a', 0, 20], ['b', 20, 10], ['c', 30, 20, 2]] });
    expect(layout(run(noHandle, slideClip(noHandle, ctx(), { id: 'b', delta: -9 }))).V1?.[1]).toEqual(['b', 18, 10, 0]);
  });

  it('moves within a gap when there is no adjoining neighbour', () => {
    const q = project({ V1: [['a', 0, 10], ['b', 20, 10], ['c', 40, 10]] });
    expect(layout(run(q, slideClip(q, ctx(), { id: 'b', delta: 99 }))).V1).toEqual([['a', 0, 10, 0], ['b', 30, 10, 0], ['c', 40, 10, 0]]);
    expect(layout(run(q, slideClip(q, ctx(), { id: 'b', delta: -99 }))).V1?.[1]).toEqual(['b', 10, 10, 0]);
  });
});
