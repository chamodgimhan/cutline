import { describe, expect, it } from 'vitest';
import { collectSnapPoints, snapMove, snapTime } from './snap.ts';
import { project } from './testkit.ts';

function seq() {
  const s = project({ V1: [['a', 10, 20], ['b', 50, 10]], A1: [['x', 12, 8]] }).sequences[0]!;
  return { ...s, markers: [{ id: 'mk', time: 40, duration: 5, name: '', color: 'marker' }], inPoint: 30, outPoint: 100 };
}

describe('snapping', () => {
  it('collects clip edges, markers, range, playhead and zero, sorted', () => {
    const pts = collectSnapPoints(seq(), { playhead: 30 });
    expect(pts.map((p) => p.time)).toEqual([0, 10, 12, 20, 30, 30, 30, 40, 45, 50, 60, 100]);
    // Equal times are ordered by priority: playhead first.
    expect(pts.filter((p) => p.time === 30).map((p) => p.kind)).toEqual(['playhead', 'range', 'clip']);
  });

  it('skips excluded clips and hidden video tracks', () => {
    const pts = collectSnapPoints(seq(), { exclude: new Set(['a']) });
    expect(pts.some((p) => p.time === 10)).toBe(false);
    const s = seq();
    const hidden = { ...s, tracks: s.tracks.map((t) => (t.id === 'V1' ? { ...t, hidden: true } : t)) };
    expect(collectSnapPoints(hidden).map((p) => p.time)).toEqual([0, 12, 20, 30, 40, 45, 100]);
  });

  it('snaps to the nearest point inside the threshold only', () => {
    const pts = collectSnapPoints(seq(), { playhead: 30 });
    expect(snapTime(11, pts, 2)).toEqual({ time: 10, point: { time: 10, kind: 'clip' } });
    expect(snapTime(11.5, pts, 2).time).toBe(12);
    expect(snapTime(28, pts, 2).point?.kind).toBe('playhead');
    expect(snapTime(25, pts, 2)).toEqual({ time: 25, point: null });
    expect(snapTime(500, pts, 2).point).toBeNull();
    expect(snapTime(-1, pts, 2).point?.kind).toBe('zero');
    expect(snapTime(5, [], 2)).toEqual({ time: 5, point: null });
  });

  it('snaps a move by whichever edge is closest', () => {
    const pts = collectSnapPoints(seq(), { exclude: new Set(['b']) });
    // b is [50, 60); moving by -11 puts its start at 39 (1 from marker 40) and its end at 49.
    expect(snapMove([50, 60], -11, pts, 3)).toEqual({ delta: -10, point: { time: 40, kind: 'marker' }, edge: 0 });
    // moving by -16: start 34, end 44 -> end is 1 from marker end 45.
    expect(snapMove([50, 60], -16, pts, 3)).toEqual({ delta: -15, point: { time: 45, kind: 'marker' }, edge: 1 });
    expect(snapMove([50, 60], 15, pts, 3)).toEqual({ delta: 15, point: null, edge: -1 });
  });
});
