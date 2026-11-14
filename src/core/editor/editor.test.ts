import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../invariants.ts';
import { findClip } from '../model.ts';
import { layout, lock, project, testMedia } from '../testkit.ts';
import { frameTicks } from '../time.ts';
import { ACTIONS, runAction } from './actions.ts';
import { Session } from './session.ts';
import { comboOf, isTypingTarget, ShortcutMap } from './shortcuts.ts';

const F = frameTicks({ num: 30, den: 1 });

/** V1: a b c (10 frames each, a+x linked), V2 empty, A1: x y, with one marker and a 600-frame source clip. */
function session(): Session {
  const p = project(
    { V1: [['a', 0, 10 * F, 0, { linkId: 'L' }], ['b', 10 * F, 10 * F, 20 * F], ['c', 30 * F, 10 * F]], V2: [], A1: [['x', 0, 10 * F, 0, { linkId: 'L' }], ['y', 20 * F, 10 * F]] },
    600 * F,
  );
  p.media.push(testMedia('src', 300 * F));
  p.sequences[0]!.markers = [{ id: 'mk', time: 15 * F, duration: 0, name: '', color: 'marker' }];
  const s = new Session(p);
  s.source = { mediaId: 'src', inPoint: 30 * F, outPoint: 50 * F, playhead: 40 * F };
  return s;
}
const frames = (s: Session): Record<string, [string, number, number, number][]> =>
  Object.fromEntries(Object.entries(layout(s.project)).map(([k, v]) => [k, v.map(([id, a, b, c]) => [id, a / F, b / F, c / F] as [string, number, number, number])]));
const act = (s: Session, id: string): void => {
  expect(runAction(s, id), id).toBe(true);
  expect(checkInvariants(s.project), id).toEqual([]);
};

describe('actions', () => {
  it('has unique ids, labels, and no two actions on one default shortcut', () => {
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
    expect(ACTIONS.every((a) => a.label.length > 0)).toBe(true);
    expect(new ShortcutMap(ACTIONS).conflicts()).toEqual([]);
    expect(runAction(session(), 'no.such.action')).toBe(false);
  });

  it('runs every action on a fresh session without throwing, and undo restores the project', () => {
    for (const action of ACTIONS) {
      const s = session();
      const before = s.project;
      s.select(['b']);
      s.activeTrackId = 'V2';
      s.clock.seek(15 * F);
      act(s, action.id);
      while (s.history.undo());
      expect(s.project, action.id).toEqual(before);
    }
  });

  it('turns an impossible edit into a message instead of an exception', () => {
    const s = session();
    for (const id of ['edit.delete', 'edit.copy', 'edit.paste', 'clip.link', 'seq.lift', 'track.delete', 'mark.delete']) {
      s.message = null;
      act(s, id);
      expect(s.message, id).toBeTruthy();
    }
    s.source.mediaId = null;
    act(s, 'seq.insert');
    expect(s.message).toMatch(/source monitor/);
    expect(s.history.canUndo).toBe(false);
  });

  it('edit: delete, ripple delete, cut, copy, paste, duplicate, select all', () => {
    let s = session();
    s.select(['a']);
    act(s, 'edit.delete'); // linked audio goes too
    expect(frames(s)).toMatchObject({ V1: [['b', 10, 10, 20], ['c', 30, 10, 0]], A1: [['y', 20, 10, 0]] });
    s.select(['b']);
    act(s, 'edit.rippleDelete');
    expect(frames(s).V1).toEqual([['c', 20, 10, 0]]);
    expect(frames(s).A1).toEqual([['y', 10, 10, 0]]);

    s = session();
    s.select(['b']);
    act(s, 'edit.copy');
    s.clock.seek(50 * F);
    act(s, 'edit.paste');
    expect(frames(s).V1?.[3]).toEqual([[...s.selection][0], 50, 10, 20]);
    expect(s.history.undoLabel).toBe('Paste');
    s.clock.seek(5 * F);
    act(s, 'edit.paste'); // lands on a and b: overwrites
    expect(frames(s).V1?.map((c) => [c[1], c[2]])).toEqual([[0, 5], [5, 10], [15, 5], [30, 10], [50, 10]]);
    act(s, 'edit.undo');
    s.select(['b']);
    act(s, 'edit.cut');
    expect(frames(s).V1?.map((c) => c[0])).not.toContain('b');
    expect(s.clipboard?.items[0]?.clip.id).toBe('b');

    s = session();
    s.select(['a']); // duplicate a linked pair: the copies are linked to each other, not to the originals
    act(s, 'edit.duplicate');
    const copies = s.selectedClips();
    expect(copies.map((h) => [h.track.id, h.clip.start / F])).toEqual([['V1', 10], ['A1', 10]]);
    expect(copies[0]!.clip.linkId).toBe(copies[1]!.clip.linkId);
    expect(copies[0]!.clip.linkId).not.toBe('L');
    act(s, 'edit.selectAll');
    expect(s.selection.size).toBe(6);
    act(s, 'edit.deselect');
    expect(s.selection.size).toBe(0);
  });

  it('clip: split, link, unlink, enable, nudge', () => {
    const s = session();
    s.clock.seek(15 * F);
    act(s, 'clip.split'); // nothing selected: every track under the playhead
    expect(frames(s).V1?.map((c) => [c[1], c[2]])).toEqual([[0, 10], [10, 5], [15, 5], [30, 10]]);
    s.select(['c', 'y']);
    act(s, 'clip.link');
    expect(findClip(s.seq, 'c')?.clip.linkId).toBe(findClip(s.seq, 'y')?.clip.linkId);
    act(s, 'clip.unlink');
    expect(findClip(s.seq, 'c')?.clip.linkId).toBeNull();
    s.select(['c']);
    act(s, 'clip.enable');
    expect(findClip(s.seq, 'c')?.clip.enabled).toBe(false);
    act(s, 'clip.nudgeRight');
    act(s, 'clip.nudgeRight');
    act(s, 'clip.nudgeLeft');
    expect(findClip(s.seq, 'c')?.clip.start).toBe(31 * F);
    act(s, 'clip.linkedSelection');
    expect(s.linked).toBe(false);
  });

  it('mark: in, out, clear, go to, markers; and the source monitor when it has focus', () => {
    const s = session();
    s.clock.seek(12 * F);
    act(s, 'mark.in');
    s.clock.seek(22 * F);
    act(s, 'mark.out');
    expect([s.seq.inPoint, s.seq.outPoint]).toEqual([12 * F, 22 * F]);
    s.clock.seek(30 * F);
    act(s, 'mark.in'); // an in point past the out point drops the out point
    expect([s.seq.inPoint, s.seq.outPoint]).toEqual([30 * F, null]);
    act(s, 'mark.goIn');
    expect(s.playhead).toBe(30 * F);
    act(s, 'mark.clear');
    expect(s.seq.inPoint).toBeNull();
    act(s, 'mark.add');
    expect(s.seq.markers.map((m) => m.time / F)).toEqual([15, 30]);
    act(s, 'mark.prev');
    expect(s.playhead).toBe(15 * F);
    act(s, 'mark.next');
    expect(s.playhead).toBe(30 * F);
    act(s, 'mark.delete');
    expect(s.seq.markers).toHaveLength(1);
    s.focus = 'source';
    const undoCount = s.history.appliedCount;
    act(s, 'mark.in');
    expect(s.source).toMatchObject({ inPoint: 40 * F, outPoint: 50 * F });
    act(s, 'mark.clear');
    expect(s.source).toMatchObject({ inPoint: null, outPoint: null });
    expect(s.history.appliedCount).toBe(undoCount); // source marks are not project edits
  });

  it('sequence: three-point insert and overwrite, lift, extract, add tracks', () => {
    let s = session();
    s.clock.seek(5 * F);
    act(s, 'seq.insert'); // 20 source frames from 30, video + linked audio
    expect(frames(s).V1?.slice(0, 3).map((c) => [c[1], c[2], c[3]])).toEqual([[0, 5, 0], [5, 20, 30], [25, 5, 5]]);
    expect(frames(s).A1?.[1]?.slice(1)).toEqual([5, 20, 30]);
    expect(s.playhead).toBe(25 * F);
    expect(s.selectedClips().map((h) => h.clip.linkId)[0]).toBe(s.selectedClips()[1]!.clip.linkId);

    s = session();
    s.clock.seek(12 * F);
    act(s, 'mark.in');
    s.clock.seek(18 * F);
    act(s, 'mark.out');
    act(s, 'seq.overwrite'); // sequence range (6 frames) limits the edit: source in + 6
    expect(frames(s).V1?.map((c) => [c[1], c[2], c[3]])).toEqual([[0, 10, 0], [10, 2, 20], [12, 6, 30], [18, 2, 28], [30, 10, 0]]);
    act(s, 'seq.lift');
    expect(frames(s).V1?.map((c) => [c[1], c[2]])).toEqual([[0, 10], [10, 2], [18, 2], [30, 10]]);
    act(s, 'edit.undo');
    act(s, 'seq.extract');
    expect(frames(s).V1?.map((c) => [c[1], c[2]])).toEqual([[0, 10], [10, 2], [12, 2], [24, 10]]);
    act(s, 'seq.addVideoTrack');
    act(s, 'seq.addAudioTrack');
    act(s, 'seq.addCaptionTrack');
    expect(s.seq.tracks.map((t) => t.name)).toEqual(['V1', 'V2', 'V3', 'A1', 'A2', 'C1']);
  });

  it('track: lock, mute, solo, hide, move, delete act on the active track', () => {
    const s = session();
    s.activeTrackId = 'A1';
    for (const id of ['track.lock', 'track.mute', 'track.solo', 'track.hide']) act(s, id);
    expect(s.seq.tracks[2]).toMatchObject({ locked: true, muted: true, solo: true, hidden: true });
    act(s, 'track.lock');
    s.activeTrackId = 'V2';
    act(s, 'track.down');
    expect(s.seq.tracks.map((t) => t.id)).toEqual(['V2', 'V1', 'A1']);
    act(s, 'track.up');
    act(s, 'track.delete');
    expect(s.seq.tracks.map((t) => t.id)).toEqual(['V1', 'A1']);
    expect(s.activeTrackId).toBeNull();
  });

  it('playback, view and tools', () => {
    const s = session();
    act(s, 'play.toggle');
    expect(s.clock.playing).toBe(true);
    act(s, 'play.stop');
    expect(s.clock.playing).toBe(false);
    act(s, 'play.end');
    expect(s.playhead).toBe(40 * F);
    act(s, 'play.prevEdit');
    expect(s.playhead).toBe(30 * F);
    act(s, 'play.start');
    act(s, 'play.nextEdit');
    expect(s.playhead).toBe(10 * F);
    act(s, 'play.loop');
    expect(s.clock.loop).toBe(true);
    const z = s.view.pxPerSecond;
    act(s, 'view.zoomIn');
    expect(s.view.pxPerSecond).toBe(z * 1.5);
    act(s, 'view.zoomOut');
    act(s, 'view.zoomFit');
    expect(s.view.pxPerSecond).toBeCloseTo((1000 - 40) / (40 / 30), 6);
    act(s, 'view.snapping');
    expect(s.snapping).toBe(false);
    act(s, 'tool.razor');
    expect(s.tool).toBe('razor');
    expect(ACTIONS.find((x) => x.id === 'tool.razor')?.checked?.(s)).toBe(true);
  });
});

describe('session', () => {
  it('makes ids that never collide and drops deleted clips from the selection', () => {
    const s = session();
    const ids = new Set(Array.from({ length: 50 }, () => s.newId()));
    expect(ids.size).toBe(50);
    s.select(['a', 'b']);
    runAction(s, 'edit.delete');
    expect([...s.selection]).toEqual([]);
    runAction(s, 'edit.undo');
    s.select(['b'], 'add');
    s.select(['b'], 'toggle');
    expect(s.selection.size).toBe(0);
  });

  it('builds clips from media for the target tracks, on whole frames', () => {
    const s = session();
    const src = s.project.media.find((m) => m.id === 'src')!;
    const items = s.clipsFromMedia(src, { inPoint: 10 * F + 7, outPoint: 20 * F + 9 });
    expect(items.map((i) => [i.trackId, i.clip.kind, i.clip.duration / F, i.clip.sourceIn])).toEqual([['V1', 'video', 10, 10 * F + 7], ['A1', 'audio', 10, 10 * F + 7]]);
    expect(s.clipsFromMedia(src, { inPoint: null, outPoint: null }, 'V2', 4 * F).map((i) => [i.trackId, i.clip.duration / F])).toEqual([['V2', 4], ['A1', 4]]);
    expect(() => s.clipsFromMedia(src, { inPoint: 5, outPoint: 6 })).toThrow(/shorter than one frame/);
    const locked = new Session(lock(lock(s.project, 'V1'), 'V2'));
    expect(locked.clipsFromMedia(src, { inPoint: null, outPoint: null }).map((i) => i.trackId)).toEqual(['A1']);
    expect(s.clipsFromMedia(testMedia('still', 0, 'image'), { inPoint: null, outPoint: null })[0]!.clip.duration).toBe(150 * F);
  });

  it('keeps the anchor time still when zooming', () => {
    const s = session();
    s.view.scrollX = 100;
    const x = (20 / 30) * s.view.pxPerSecond - s.view.scrollX;
    s.setZoom(300, 20 * F);
    expect((20 / 30) * 300 - s.view.scrollX).toBeCloseTo(x, 6);
    s.setZoom(1e9);
    expect(s.view.pxPerSecond).toBe(2400);
  });
});

describe('shortcuts', () => {
  const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey', boolean>> = {}, code?: string) =>
    ({ key: k, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it('names combos the same way on every platform', () => {
    expect(comboOf(key('z', { ctrlKey: true }))).toBe('Ctrl+Z');
    expect(comboOf(key('Z', { metaKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Z');
    expect(comboOf(key(' '))).toBe('Space');
    expect(comboOf(key('ArrowLeft', { shiftKey: true }))).toBe('Shift+ArrowLeft');
    expect(comboOf(key('Delete', { shiftKey: true }))).toBe('Shift+Delete');
    expect(comboOf(key('≈', { altKey: true }, 'KeyX'))).toBe('Alt+X');
    expect(comboOf(key(';'))).toBe(';');
    expect(comboOf(key('+', { shiftKey: true }))).toBe('+');
    expect(comboOf(key('Shift', { shiftKey: true }))).toBeNull();
  });

  it('resolves every default shortcut to its action', () => {
    const map = new ShortcutMap(ACTIONS);
    for (const a of ACTIONS) for (const k of a.keys) expect(map.actionFor(k), k).toBe(a.id);
    expect(map.actionFor('Ctrl+Alt+F12')).toBeNull();
  });

  it('applies overrides, reports conflicts, and resets', () => {
    const map = new ShortcutMap(ACTIONS, { 'edit.undo': ['Ctrl+U'] });
    expect(map.actionFor('Ctrl+U')).toBe('edit.undo');
    expect(map.actionFor('Ctrl+Z')).toBeNull();
    expect(map.usedBy('Space', 'edit.undo')).toEqual(['play.toggle']);
    map.set('mark.add', ['Space', 'Space']);
    expect(map.conflicts()).toEqual([{ combo: 'Space', actions: ['mark.add', 'play.toggle'] }]);
    expect(map.toJSON()).toEqual({ 'edit.undo': ['Ctrl+U'], 'mark.add': ['Space'] });
    map.set('play.toggle', []);
    expect(map.conflicts()).toEqual([]);
    map.reset('edit.undo');
    expect(map.keysFor('edit.undo')).toEqual(['Ctrl+Z']);
    map.reset();
    expect(map.toJSON()).toEqual({});
  });

  it('knows where the user is typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'range' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget({ tagName: 'CANVAS' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
