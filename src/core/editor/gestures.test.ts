import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants.ts';
import { makeKey } from '../keyframes.ts';
import { defaultVideoProps, makeClip, makeTrack, type Project } from '../model.ts';
import { layout, lock, project } from '../testkit.ts';
import { frameTicks, TICKS_PER_SECOND as S } from '../time.ts';
import { beginGesture, cursorFor, type Mods } from './gestures.ts';
import { keyNear, laneKeyFor } from './lane.ts';
import { hitTest, rows, tickAt, visibleRange, xOf, type Hit } from './layout.ts';
import { Session, type Tool } from './session.ts';

const F = frameTicks({ num: 30, den: 1 });
const none: Mods = { shift: false, alt: false, ctrl: false };

/** 30 px per second, so one frame is one pixel. Rows: V2 at y 24..80, V1 at 80..136, A1 at 136..192. */
function session(p?: Project): Session {
  const s = new Session(p ?? project({ V1: [['a', 0, 30 * F, 30 * F], ['b', 30 * F, 30 * F, 30 * F], ['c', 90 * F, 30 * F, 30 * F]], V2: [], A1: [['x', 0, 30 * F, 30 * F]] }, 600 * F));
  s.view = { pxPerSecond: 30, scrollX: 0, scrollY: 0, width: 800 };
  return s;
}
const Y = { V2: 50, V1: 100, A1: 160, ruler: 10 };
const at = (s: Session, x: number, y: number): Hit => hitTest(s.seq, s.view, x, y);
const frames = (s: Session, track = 'V1'): number[][] => (layout(s.project)[track] ?? []).map(([, a, b, c]) => [a / F, b / F, c / F]);

/** Press at (x0, y0), move through the points, release. Returns the session for chaining. */
function drag(s: Session, tool: Tool, from: [number, number], to: [number, number][], mods: Mods = none): Session {
  s.setTool(tool);
  const g = beginGesture(s, at(s, ...from), mods);
  for (const p of to) g?.move(at(s, ...p));
  g?.end();
  expect(checkInvariants(s.project)).toEqual([]);
  return s;
}

describe('layout', () => {
  it('orders rows captions, video top-down, audio; maps time and pixels both ways', () => {
    const p = project({ V1: [], V2: [], A1: [], C1: [], A2: [] });
    expect(rows(p.sequences[0]!).map((r) => [r.track.id, r.y])).toEqual([['C1', 0], ['V2', 56], ['V1', 112], ['A1', 168], ['A2', 224]]);
    const v = { pxPerSecond: 100, scrollX: 250, scrollY: 0 };
    expect(xOf(5 * S, v)).toBe(250);
    expect(tickAt(250, v)).toBe(5 * S);
    expect(tickAt(-9999, v)).toBe(0);
  });

  it('hit-tests ruler, clip bodies, edges, gaps and empty space', () => {
    const s = session();
    expect(at(s, 40, Y.ruler)).toMatchObject({ area: 'ruler', tick: 40 * F });
    expect(at(s, 15, Y.V1)).toMatchObject({ area: 'track', trackId: 'V1', edge: null, clip: { id: 'a' } });
    expect(at(s, 2, Y.V1)).toMatchObject({ edge: 'in', clip: { id: 'a' } });
    expect(at(s, 28, Y.V1)).toMatchObject({ edge: 'out', clip: { id: 'a' } });
    expect(at(s, 31, Y.V1)).toMatchObject({ edge: 'in', clip: { id: 'b' } }); // at a cut, the side the pointer is on
    expect(at(s, 62, Y.V1)).toMatchObject({ edge: 'out', clip: { id: 'b' } }); // just past the end still grabs the edge
    expect(at(s, 75, Y.V1)).toMatchObject({ area: 'track', clip: null });
    expect(at(s, 15, Y.V2)).toMatchObject({ area: 'track', trackId: 'V2', clip: null });
    expect(at(s, 15, 400)).toMatchObject({ area: 'empty', trackId: null });
    s.view.scrollX = 30;
    expect(at(s, 15, Y.V1).clip?.id).toBe('b');
    s.view.scrollY = 56;
    expect(at(s, 15, Y.V2).trackId).toBe('V1');
  });

  it('keeps a body on very narrow clips', () => {
    const s = session(project({ V1: [['n', 30 * F, 3 * F]] }));
    expect(at(s, 31, 50)).toMatchObject({ clip: { id: 'n' }, edge: null }); // one track only, so it is the first row
    expect(at(s, 30, 50).edge).toBe('in');
  });

  it('finds the visible clips of a 2,000-clip track by binary search', () => {
    const t = makeTrack('V1', 'video', 'V1');
    t.clips = Array.from({ length: 2000 }, (_, i) => makeClip({ id: 'c' + i, kind: 'video', start: i * 10, duration: 8 }));
    expect(visibleRange(t, 5000, 5100)).toEqual([500, 510]);
    expect(visibleRange(t, 5008, 5010)).toEqual([501, 501]); // a gap
    expect(visibleRange(t, 0, 1)).toEqual([0, 1]);
    expect(visibleRange(t, 99999, 100000)).toEqual([2000, 2000]);
  });
});

describe('tool gestures', () => {
  it('select: click selects, shift toggles, click on empty clears', () => {
    const s = session();
    drag(s, 'select', [15, Y.V1], []);
    expect([...s.selection]).toEqual(['a']);
    drag(s, 'select', [45, Y.V1], [], { ...none, shift: true });
    expect([...s.selection].sort()).toEqual(['a', 'b']);
    drag(s, 'select', [15, Y.V1], []); // plain click on one of several narrows to it
    expect([...s.selection]).toEqual(['a']);
    drag(s, 'select', [75, Y.V1], []);
    expect(s.selection.size).toBe(0);
    expect(s.history.canUndo).toBe(false);
    expect(s.activeTrackId).toBe('V1');
  });

  it('select: drag moves a clip, one undo step, overwriting what it lands on', () => {
    const s = drag(session(), 'select', [100, Y.V1], [[110, Y.V1], [140, Y.V1], [130, Y.V1]]);
    expect(frames(s)).toEqual([[0, 30, 30], [30, 30, 30], [120, 30, 30]]);
    expect(s.history.entries()).toEqual([{ label: 'Move', applied: true }]);
    s.history.undo();
    expect(frames(s)[2]).toEqual([90, 30, 30]);
    const t = drag(session(), 'select', [100, Y.V1], [[60, Y.V1]]); // lands on the tail of b, which is cut back
    expect(frames(t)).toEqual([[0, 30, 30], [30, 20, 30], [50, 30, 30]]);
  });

  it('select: drag snaps to clip edges and shows where; snapping can be turned off', () => {
    const s = session();
    s.setTool('select');
    const g = beginGesture(s, at(s, 100, Y.V1), none)!;
    g.move(at(s, 75, Y.V1)); // start would be 65: within 8 px of b's end at 60
    expect(frames(s)[2]).toEqual([60, 30, 30]);
    expect(g.snapLine).toBe(60 * F);
    g.move(at(s, 90, Y.V1));
    expect(g.snapLine).toBeNull();
    g.cancel();
    expect(frames(s)[2]).toEqual([90, 30, 30]);
    expect(s.history.canUndo).toBe(false);
    s.snapping = false;
    drag(s, 'select', [100, Y.V1], [[75, Y.V1]]);
    expect(frames(s)[2]).toEqual([65, 30, 30]);
  });

  it('select: drag to another track of the same kind, never to the wrong kind', () => {
    const s = drag(session(), 'select', [100, Y.V1], [[100, Y.V2]]);
    expect(frames(s, 'V2')).toEqual([[90, 30, 30]]);
    const t = drag(session(), 'select', [100, Y.V1], [[100, Y.A1]]);
    expect(frames(t)).toHaveLength(3);
    expect(frames(t, 'A1')).toHaveLength(1);
  });

  it('select: drag an edge trims, stopping at the neighbour; marquee selects what it touches', () => {
    const s = drag(session(), 'select', [90, Y.V1], [[80, Y.V1]]); // c's in edge, earlier
    expect(frames(s)[2]).toEqual([80, 40, 20]);
    drag(s, 'select', [60, Y.V1], [[200, Y.V1]]); // b's out edge can only reach c
    expect(frames(s)[1]).toEqual([30, 50, 30]);
    const m = session();
    m.setTool('select');
    const g = beginGesture(m, at(m, 70, Y.V2), none)!;
    g.move(at(m, 50, Y.A1));
    expect(g.marquee).toEqual({ x0: 50, y0: Y.V2, x1: 70, y1: Y.A1 });
    expect([...m.selection]).toEqual(['b']);
    g.move(at(m, 10, Y.A1));
    expect([...m.selection].sort()).toEqual(['a', 'b', 'x']);
    g.end();
    expect(g.marquee).toBeNull();
  });

  it('razor: click splits the clip; shift splits every track', () => {
    const s = drag(session(), 'razor', [40, Y.V1], []);
    expect(frames(s)).toEqual([[0, 30, 30], [30, 10, 30], [40, 20, 40], [90, 30, 30]]);
    const t = drag(session(), 'razor', [10, Y.V1], [], { ...none, shift: true });
    expect(frames(t)).toHaveLength(4);
    expect(frames(t, 'A1')).toHaveLength(2);
    const u = drag(session(), 'razor', [75, Y.V1], []);
    expect(u.history.canUndo).toBe(false);
  });

  it('ripple: trimming an edge moves everything after it', () => {
    const s = drag(session(), 'ripple', [60, Y.V1], [[50, Y.V1]]);
    expect(frames(s)).toEqual([[0, 30, 30], [30, 20, 30], [80, 30, 30]]);
    expect(s.history.undoLabel).toBe('Ripple trim');
  });

  it('roll: moves the cut between two clips', () => {
    const s = drag(session(), 'roll', [30, Y.V1], [[40, Y.V1]]);
    expect(frames(s)).toEqual([[0, 40, 30], [40, 20, 40], [90, 30, 30]]);
    const t = drag(session(), 'roll', [89, Y.V1], [[80, Y.V1]]); // c has no neighbour: nothing happens
    expect(t.history.canUndo).toBe(false);
  });

  it('slip: changes the source under a clip; slide: moves it between its neighbours', () => {
    const s = drag(session(), 'slip', [45, Y.V1], [[55, Y.V1]]);
    expect(frames(s)).toEqual([[0, 30, 30], [30, 30, 20], [90, 30, 30]]);
    const t = drag(session(), 'slide', [15, Y.V1], [[25, Y.V1]]); // a slides right; b gives way
    expect(frames(t)).toEqual([[10, 30, 30], [40, 20, 40], [90, 30, 30]]);
  });

  it('hand scrolls, zoom zooms about the pointer, ruler drag scrubs the playhead', () => {
    const s = session();
    s.view.scrollX = 100;
    drag(s, 'hand', [200, Y.V1], [[150, Y.V1 + 20]]);
    expect([s.view.scrollX, s.view.scrollY]).toEqual([150, 0]);
    s.view.scrollX = 0;
    drag(s, 'zoom', [60, Y.V1], []);
    expect(s.view.pxPerSecond).toBe(45);
    expect(xOf(60 * F, s.view)).toBeCloseTo(60, 6);
    drag(s, 'zoom', [60, Y.V1], [], { ...none, alt: true });
    expect(s.view.pxPerSecond).toBe(30);
    s.view.scrollX = 0;
    drag(s, 'select', [20, Y.ruler], [[47, Y.V1]]);
    expect(s.playhead).toBe(47 * F);
    expect(s.history.canUndo).toBe(false);
  });

  it('linked clips follow; alt edits one alone; locked tracks refuse quietly', () => {
    const p = project({ V1: [['v', 30 * F, 30 * F, 30 * F, { linkId: 'L' }]], A1: [['x', 30 * F, 30 * F, 30 * F, { linkId: 'L' }]] }, 600 * F);
    const row = (id: string, q: Session): number => 24 + (rows(q.seq).find((r) => r.track.id === id)?.y ?? 0) + 20;
    const t = session(p);
    drag(t, 'select', [60, row('V1', t)], [[50, row('V1', t)]]);
    expect(frames(t)).toEqual([[30, 20, 30]]);
    expect(frames(t, 'A1')).toEqual([[30, 20, 30]]);
    const u = session(p);
    drag(u, 'select', [60, row('V1', u)], [[50, row('V1', u)]], { ...none, alt: true });
    expect(frames(u, 'A1')).toEqual([[30, 30, 30]]);
    const w = session(lock(p, 'A1'));
    drag(w, 'select', [45, row('V1', w)], [[80, row('V1', w)]]);
    expect(frames(w)).toEqual([[30, 30, 30]]);
    expect(w.history.canUndo).toBe(false);
  });

  it('drags a keyframe in the lane of a selected clip, in whole frames, inside the clip', () => {
    const keys = { keys: [makeKey(5 * F, 0.2), makeKey(20 * F, 1)] };
    const s = session(project({ V1: [['a', 30 * F, 30 * F, 30 * F, { video: { ...defaultVideoProps(), opacity: keys } }]] }, 600 * F));
    s.select(['a']);
    const laneY = 24 + 56 - 6; // bottom band of the first row
    drag(s, 'select', [35, laneY], [[42, laneY]]);
    const opacity = s.seq.tracks[0]!.clips[0]!.video!.opacity as { keys: { t: number }[] };
    expect(opacity.keys.map((k) => k.t / F)).toEqual([12, 20]);
    expect(s.history.undoLabel).toBe('Move keyframe');
    expect(layout(s.project).V1).toEqual([['a', 30 * F, 30 * F, 30 * F]]);
    drag(s, 'select', [42, laneY], [[500, laneY]]); // cannot leave the clip, cannot land on another key
    expect((s.seq.tracks[0]!.clips[0]!.video!.opacity as { keys: { t: number }[] }).keys.map((k) => k.t / F)).toEqual([20, 30]);
    // Away from a key, the lane band still moves the clip.
    drag(s, 'select', [50, 50], [[60, 50]]);
    expect(layout(s.project).V1?.[0]?.[1]).toBe(40 * F);
    expect(keyNear(s.seq.tracks[0]!.clips[0]!, 'opacity', 21 * F, 2 * F)?.t).toBe(20 * F);
    expect(laneKeyFor(s.seq.tracks[0]!.clips[0]!, 'gain')).toBe('opacity');
  });

  it('chooses a cursor per tool and target', () => {
    const s = session();
    expect(cursorFor(s, at(s, 28, Y.V1))).toBe('ew-resize');
    expect(cursorFor(s, at(s, 15, Y.V1))).toBe('default');
    s.setTool('roll');
    expect(cursorFor(s, at(s, 31, Y.V1))).toBe('col-resize');
    s.setTool('razor');
    expect(cursorFor(s, at(s, 15, Y.V1))).toBe('crosshair');
    s.setTool('hand');
    expect(cursorFor(s, at(s, 15, Y.V1))).toBe('grab');
    s.setTool('zoom');
    expect(cursorFor(s, at(s, 15, Y.V1))).toBe('zoom-in');
  });
});
