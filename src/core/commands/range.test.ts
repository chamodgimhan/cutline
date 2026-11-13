import { describe, expect, it } from 'vitest';
import { makeClip } from '../model.ts';
import { ctxFor, layout, lock, project } from '../testkit.ts';
import { run } from '../testrun.ts';
import { extractRange, insertClips, liftRange, overwriteClips, rippleDelete } from './range.ts';

const ctx = () => ctxFor('n');
const v = (id: string, duration: number, sourceIn = 0) => makeClip({ id, kind: 'video', start: 0, duration, sourceIn, mediaId: 'm' });
const a = (id: string, duration: number) => makeClip({ id, kind: 'audio', start: 0, duration, mediaId: 'm' });

describe('insertClips', () => {
  const p = project({ V1: [['a', 0, 20], ['b', 20, 10]], A1: [['x', 0, 30]], V2: [['k', 25, 5]] });

  it('splits what is under the insert point and pushes everything later on all tracks', () => {
    const q = run(p, insertClips(p, ctx(), { at: 10, items: [{ trackId: 'V1', clip: v('new', 8) }] }));
    expect(layout(q)).toEqual({
      V1: [['a', 0, 10, 0], ['new', 10, 8, 0], ['n1', 18, 10, 10], ['b', 28, 10, 0]],
      A1: [['x', 0, 10, 0], ['n2', 18, 20, 10]],
      V2: [['k', 33, 5, 0]],
    });
  });

  it('inserts video and audio together, at a cut, and at the very start', () => {
    const q = run(p, insertClips(p, ctx(), { at: 20, items: [{ trackId: 'V1', clip: v('nv', 5) }, { trackId: 'A1', clip: a('na', 5) }] }));
    expect(layout(q).V1).toEqual([['a', 0, 20, 0], ['nv', 20, 5, 0], ['b', 25, 10, 0]]);
    expect(layout(q).A1).toEqual([['x', 0, 20, 0], ['na', 20, 5, 0], ['n1', 25, 10, 20]]);
    const r = run(p, insertClips(p, ctx(), { at: 0, items: [{ trackId: 'V1', clip: v('nv', 5) }] }));
    expect(layout(r).V1?.[0]).toEqual(['nv', 0, 5, 0]);
    expect(layout(r).A1).toEqual([['x', 5, 30, 0]]);
  });

  it('does not move locked tracks, and refuses a locked target or an empty edit', () => {
    const q = lock(p, 'A1');
    expect(layout(run(q, insertClips(q, ctx(), { at: 10, items: [{ trackId: 'V1', clip: v('new', 8) }] }))).A1).toEqual([['x', 0, 30, 0]]);
    expect(() => insertClips(lock(p, 'V1'), ctx(), { at: 10, items: [{ trackId: 'V1', clip: v('new', 8) }] })).toThrow(/locked/);
    expect(() => insertClips(p, ctx(), { at: 10, items: [] })).toThrow(/Nothing to place/);
    expect(() => insertClips(p, ctx(), { at: -1, items: [{ trackId: 'V1', clip: v('new', 8) }] })).toThrow(/before the beginning/);
  });
});

describe('overwriteClips', () => {
  const p = project({ V1: [['a', 0, 20], ['b', 20, 10], ['c', 30, 10]], A1: [['x', 0, 40]] });

  it('replaces what is underneath on the target track only', () => {
    const q = run(p, overwriteClips(p, ctx(), { at: 15, items: [{ trackId: 'V1', clip: v('new', 20) }] }));
    expect(layout(q)).toEqual({ V1: [['a', 0, 15, 0], ['new', 15, 20, 0], ['c', 35, 5, 5]], A1: [['x', 0, 40, 0]] });
  });

  it('splits a clip it lands inside and works in empty space', () => {
    const q = run(p, overwriteClips(p, ctx(), { at: 5, items: [{ trackId: 'A1', clip: a('na', 10) }] }));
    expect(layout(q).A1).toEqual([['x', 0, 5, 0], ['na', 5, 10, 0], ['n1', 15, 25, 15]]);
    const r = run(p, overwriteClips(p, ctx(), { at: 100, items: [{ trackId: 'V1', clip: v('far', 10) }] }));
    expect(layout(r).V1).toHaveLength(4);
  });
});

describe('liftRange / extractRange', () => {
  const p = project({ V1: [['a', 0, 20], ['b', 20, 10], ['c', 30, 10]], A1: [['x', 5, 30]] });

  it('lift leaves a gap', () => {
    const q = run(p, liftRange(p, ctx(), { start: 10, end: 32 }));
    expect(layout(q)).toEqual({ V1: [['a', 0, 10, 0], ['c', 32, 8, 2]], A1: [['x', 5, 5, 0], ['n1', 32, 3, 27]] });
  });

  it('lift can target chosen tracks', () => {
    const q = run(p, liftRange(p, ctx(), { start: 10, end: 32, trackIds: ['A1'] }));
    expect(layout(q).V1).toEqual(layout(p).V1);
  });

  it('extract closes the gap on every unlocked track', () => {
    const q = run(p, extractRange(p, ctx(), { start: 10, end: 32 }));
    expect(layout(q)).toEqual({ V1: [['a', 0, 10, 0], ['c', 10, 8, 2]], A1: [['x', 5, 5, 0], ['n1', 10, 3, 27]] });
    const locked = lock(p, 'A1');
    expect(layout(run(locked, extractRange(locked, ctx(), { start: 10, end: 32 }))).A1).toEqual([['x', 5, 30, 0]]);
  });

  it('rejects an empty or backwards range, and does nothing over empty time', () => {
    expect(() => liftRange(p, ctx(), { start: 10, end: 10 })).toThrow(/in point before the out point/);
    expect(() => extractRange(p, ctx(), { start: 12, end: 3 })).toThrow(/in point before the out point/);
    expect(liftRange(p, ctx(), { start: 500, end: 600 }).isEmpty).toBe(true);
  });
});

describe('rippleDelete', () => {
  it('removes a clip and closes the gap on all tracks', () => {
    const p = project({ V1: [['a', 0, 10], ['b', 10, 10], ['c', 20, 10]], A1: [['x', 25, 5]] });
    expect(layout(run(p, rippleDelete(p, ctx(), ['b'])))).toEqual({ V1: [['a', 0, 10, 0], ['c', 10, 10, 0]], A1: [['x', 15, 5, 0]] });
  });

  it('removes linked partners and several separate clips at once', () => {
    const p = project({
      V1: [['a', 0, 10, 0, { linkId: 'L' }], ['b', 10, 10], ['c', 20, 10], ['d', 30, 10]],
      A1: [['x', 0, 10, 0, { linkId: 'L' }], ['y', 30, 10]],
    });
    const q = run(p, rippleDelete(p, ctx(), ['a', 'c']));
    expect(layout(q)).toEqual({ V1: [['b', 0, 10, 0], ['d', 10, 10, 0]], A1: [['y', 10, 10, 0]] });
  });

  it('closes the gap only as far as other tracks allow', () => {
    const p = project({ V1: [['a', 0, 10], ['b', 10, 10], ['c', 20, 10]], A1: [['x', 0, 16], ['y', 22, 5]] });
    expect(layout(run(p, rippleDelete(p, ctx(), ['b'])))).toEqual({ V1: [['a', 0, 10, 0], ['c', 14, 10, 0]], A1: [['x', 0, 16, 0], ['y', 16, 5, 0]] });
  });

  it('respects locks and empty selections', () => {
    const p = project({ V1: [['a', 0, 10], ['b', 10, 10]], A1: [['x', 15, 5]] });
    expect(() => rippleDelete(lock(p, 'V1'), ctx(), ['a'])).toThrow(/locked/);
    expect(() => rippleDelete(p, ctx(), [])).toThrow(/Nothing selected/);
    const q = lock(p, 'A1');
    expect(layout(run(q, rippleDelete(q, ctx(), ['a']))).A1).toEqual([['x', 15, 5, 0]]);
  });
});
