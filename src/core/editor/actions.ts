// Action registry: every menu item, button and shortcut is one of these.
import { addClips, freezeFrame, linkClips, moveClips, removeClips, splitClips, unlinkClips, updateClips, type Placement } from '../commands/clips.ts';
import { extractRange, insertClips, liftRange, overwriteClips, rippleDelete } from '../commands/range.ts';
import { addMarker, addTrack, moveTrack, removeMarker, removeTrack, setRange, setTrackProps } from '../commands/tracks.ts';
import { captionStyle, mergeCues, splitCue } from '../captions.ts';
import { EditError } from '../command.ts';
import { clipEnd, defaultTextProps, makeClip, sequenceEnd, type Id, type TrackKind } from '../model.ts';
import { TICKS_PER_SECOND } from '../time.ts';
import type { Tick } from '../time.ts';
import { TOOLS, type Session } from './session.ts';

export type Menu = 'File' | 'Edit' | 'Clip' | 'Mark' | 'Sequence' | 'Titles' | 'Playback' | 'View' | 'Tools' | 'Track' | 'Help';

export interface Action {
  id: string;
  label: string;
  menu: Menu;
  /** Default shortcuts, e.g. 'Ctrl+Shift+Z', 'Space', 'Delete'. */
  keys: string[];
  run(s: Session): void;
  /** Shown ticked in menus when true. */
  checked?(s: Session): boolean;
}

const selected = (s: Session): Id[] => {
  if (s.selection.size === 0) throw new EditError('Select a clip first.');
  return [...s.selection];
};

function copy(s: Session): void {
  const hits = s.selectedClips();
  if (hits.length === 0) throw new EditError('Select a clip first.');
  s.clipboard = { items: hits.map((h) => ({ trackId: h.track.id, clip: h.clip })), origin: Math.min(...hits.map((h) => h.clip.start)) };
}

/** Fresh copies of clipboard clips, moved so the earliest starts at `at`, with their links kept among themselves. */
function fresh(s: Session, items: readonly Placement[], origin: Tick, at: Tick): Placement[] {
  const links = new Map<Id, Id>();
  return items.map((it) => {
    let linkId = it.clip.linkId;
    if (linkId !== null) {
      if (!links.has(linkId)) links.set(linkId, s.newId());
      linkId = links.get(linkId) as Id;
    }
    return { trackId: it.trackId, clip: { ...it.clip, id: s.newId(), start: it.clip.start - origin + at, linkId } };
  });
}

/** Place copies, overwriting what is underneath, as one undo step; select them. */
function placeCopies(s: Session, items: Placement[], label: string): void {
  if (items.some((it) => !s.seq.tracks.some((t) => t.id === it.trackId))) throw new EditError('The track these clips came from no longer exists.');
  s.history.group(label, () => {
    for (const it of items) s.history.execute(liftRange(s.project, s.ctx, { start: it.clip.start, end: clipEnd(it.clip), trackIds: [it.trackId] }));
    s.history.execute(addClips(s.project, s.ctx, items));
  });
  s.select(items.map((it) => it.clip.id));
}

/** Three-point edit from the source monitor. */
function fromSource(s: Session, mode: 'insert' | 'overwrite'): void {
  const asset = s.sourceAsset();
  const { inPoint, outPoint } = s.seq;
  const at = inPoint ?? s.toFrame(s.playhead);
  const length = inPoint !== null && outPoint !== null ? outPoint - inPoint : undefined;
  const items = s.clipsFromMedia(asset, s.source, undefined, length);
  const cmd = (mode === 'insert' ? insertClips : overwriteClips)(s.project, s.ctx, { at, items });
  s.history.execute(cmd);
  s.select(items.map((it) => it.clip.id));
  s.seek(at + (items[0]?.clip.duration ?? 0));
}

function mark(s: Session, edge: 'in' | 'out' | 'clear'): void {
  if (s.focus === 'source') {
    const t = s.source.playhead;
    if (edge === 'clear') s.source = { ...s.source, inPoint: null, outPoint: null };
    else if (edge === 'in') s.source = { ...s.source, inPoint: t, outPoint: s.source.outPoint !== null && s.source.outPoint <= t ? null : s.source.outPoint };
    else s.source = { ...s.source, outPoint: t, inPoint: s.source.inPoint !== null && s.source.inPoint >= t ? null : s.source.inPoint };
    s.emit();
    return;
  }
  const t = s.toFrame(s.playhead);
  const { inPoint, outPoint } = s.seq;
  if (edge === 'clear') s.history.execute(setRange(s.project, s.ctx, null, null));
  else if (edge === 'in') s.history.execute(setRange(s.project, s.ctx, t, outPoint !== null && outPoint <= t ? null : outPoint));
  else s.history.execute(setRange(s.project, s.ctx, inPoint !== null && inPoint >= t ? null : inPoint, t));
}

function range(s: Session): { start: Tick; end: Tick } {
  const { inPoint, outPoint } = s.seq;
  if (inPoint === null || outPoint === null) throw new EditError('Set an in point and an out point first.');
  return { start: inPoint, end: outPoint };
}

function jump(s: Session, points: Tick[], dir: 1 | -1): void {
  const t = s.playhead;
  const next = dir > 0 ? points.find((p) => p > t) : [...points].reverse().find((p) => p < t);
  if (next !== undefined) s.seek(next);
}

function activeTrack(s: Session): Id {
  if (!s.activeTrackId) throw new EditError('Click a track header first.');
  return s.activeTrackId;
}

const toggleTrack = (s: Session, prop: 'locked' | 'muted' | 'solo' | 'hidden'): void => {
  const id = activeTrack(s);
  const t = s.seq.tracks.find((x) => x.id === id);
  s.history.execute(setTrackProps(s.project, s.ctx, id, { [prop]: !t?.[prop] }));
};

const addTrackOf = (kind: TrackKind) => (s: Session): void => {
  // Video tracks stack upwards (end of the list); audio and caption tracks go after their own kind.
  const last = s.seq.tracks.map((t) => t.kind).lastIndexOf(kind);
  s.history.execute(addTrack(s.project, s.ctx, { kind, index: last < 0 ? s.seq.tracks.length : last + 1 }));
};

const a = (id: string, label: string, menu: Menu, keys: string[], run: (s: Session) => void, checked?: (s: Session) => boolean): Action => ({ id, label, menu, keys, run, checked });

export const ACTIONS: readonly Action[] = [
  a('edit.undo', 'Undo', 'Edit', ['Ctrl+Z'], (s) => void s.history.undo()),
  a('edit.redo', 'Redo', 'Edit', ['Ctrl+Shift+Z', 'Ctrl+Y'], (s) => void s.history.redo()),
  a('edit.cut', 'Cut', 'Edit', ['Ctrl+X'], (s) => {
    copy(s);
    s.history.execute(removeClips(s.project, s.ctx, selected(s), s.linked));
  }),
  a('edit.copy', 'Copy', 'Edit', ['Ctrl+C'], copy),
  a('edit.paste', 'Paste', 'Edit', ['Ctrl+V'], (s) => {
    if (!s.clipboard) throw new EditError('Nothing to paste.');
    placeCopies(s, fresh(s, s.clipboard.items, s.clipboard.origin, s.toFrame(s.playhead)), 'Paste');
  }),
  a('edit.duplicate', 'Duplicate', 'Edit', ['Ctrl+D'], (s) => {
    const hits = s.selectedClips();
    if (hits.length === 0) throw new EditError('Select a clip first.');
    const origin = Math.min(...hits.map((h) => h.clip.start));
    const end = Math.max(...hits.map((h) => clipEnd(h.clip)));
    placeCopies(s, fresh(s, hits.map((h) => ({ trackId: h.track.id, clip: h.clip })), origin, end), 'Duplicate');
  }),
  a('edit.delete', 'Delete', 'Edit', ['Delete', 'Backspace'], (s) => s.history.execute(removeClips(s.project, s.ctx, selected(s), s.linked))),
  a('edit.rippleDelete', 'Ripple Delete', 'Edit', ['Shift+Delete'], (s) => s.history.execute(rippleDelete(s.project, s.ctx, selected(s), s.linked))),
  a('edit.selectAll', 'Select All', 'Edit', ['Ctrl+A'], (s) => s.select(s.seq.tracks.filter((t) => !t.locked).flatMap((t) => t.clips.map((c) => c.id)))),
  a('edit.deselect', 'Deselect All', 'Edit', ['Ctrl+Shift+A'], (s) => s.select([])),

  a('clip.split', 'Split at Playhead', 'Clip', ['Ctrl+K'], (s) =>
    s.history.execute(splitClips(s.project, s.ctx, s.selection.size ? { at: s.toFrame(s.playhead), ids: [...s.selection], linked: s.linked } : { at: s.toFrame(s.playhead) }))),
  a('clip.splitAll', 'Split All Tracks at Playhead', 'Clip', ['Ctrl+Shift+K'], (s) => s.history.execute(splitClips(s.project, s.ctx, { at: s.toFrame(s.playhead) }))),
  a('clip.link', 'Link (Relink Audio)', 'Clip', ['Ctrl+L'], (s) => s.history.execute(linkClips(s.project, s.ctx, selected(s)))),
  a('clip.unlink', 'Unlink (Detach Audio)', 'Clip', ['Ctrl+Shift+L'], (s) => s.history.execute(unlinkClips(s.project, s.ctx, selected(s)))),
  a('clip.enable', 'Enable / Disable', 'Clip', ['Shift+E'], (s) => s.history.execute(updateClips(s.project, s.ctx, selected(s), (c) => ({ ...c, enabled: !c.enabled }), 'Enable / disable'))),
  a('clip.nudgeLeft', 'Nudge Left One Frame', 'Clip', ['Alt+ArrowLeft'], (s) => s.history.execute(moveClips(s.project, s.ctx, { ids: selected(s), delta: -s.frame, linked: s.linked }))),
  a('clip.nudgeRight', 'Nudge Right One Frame', 'Clip', ['Alt+ArrowRight'], (s) => s.history.execute(moveClips(s.project, s.ctx, { ids: selected(s), delta: s.frame, linked: s.linked }))),
  a('clip.freeze', 'Freeze Frame at Playhead', 'Clip', ['Shift+F'], (s) => s.history.execute(freezeFrame(s.project, s.ctx, { id: selected(s)[0] as Id, at: s.toFrame(s.playhead), linked: s.linked }))),
  a('clip.linkedSelection', 'Linked Selection', 'Clip', ['Shift+L'], (s) => {
    s.linked = !s.linked;
    s.emit();
  }, (s) => s.linked),

  a('mark.in', 'Mark In', 'Mark', ['I'], (s) => mark(s, 'in')),
  a('mark.out', 'Mark Out', 'Mark', ['O'], (s) => mark(s, 'out')),
  a('mark.clear', 'Clear In and Out', 'Mark', ['Alt+X'], (s) => mark(s, 'clear')),
  a('mark.goIn', 'Go to In', 'Mark', ['Shift+I'], (s) => s.seq.inPoint !== null && s.seek(s.seq.inPoint)),
  a('mark.goOut', 'Go to Out', 'Mark', ['Shift+O'], (s) => s.seq.outPoint !== null && s.seek(s.seq.outPoint)),
  a('mark.add', 'Add Marker', 'Mark', ['M'], (s) => s.history.execute(addMarker(s.project, s.ctx, { time: s.toFrame(s.playhead) }))),
  a('mark.delete', 'Delete Marker at Playhead', 'Mark', ['Ctrl+Alt+M'], (s) => {
    const m = s.seq.markers.find((x) => x.time === s.toFrame(s.playhead));
    if (!m) throw new EditError('There is no marker at the playhead.');
    s.history.execute(removeMarker(s.project, s.ctx, m.id));
  }),
  a('mark.next', 'Next Marker', 'Mark', ['Shift+M'], (s) => jump(s, s.seq.markers.map((m) => m.time), 1)),
  a('mark.prev', 'Previous Marker', 'Mark', ['Ctrl+Shift+M'], (s) => jump(s, s.seq.markers.map((m) => m.time), -1)),

  a('seq.insert', 'Insert from Source', 'Sequence', [','], (s) => fromSource(s, 'insert')),
  a('seq.overwrite', 'Overwrite from Source', 'Sequence', ['.'], (s) => fromSource(s, 'overwrite')),
  a('seq.lift', 'Lift', 'Sequence', [';'], (s) => s.history.execute(liftRange(s.project, s.ctx, range(s)))),
  a('seq.extract', 'Extract', 'Sequence', ["'"], (s) => s.history.execute(extractRange(s.project, s.ctx, range(s)))),
  a('seq.addVideoTrack', 'Add Video Track', 'Sequence', [], addTrackOf('video')),
  a('seq.addAudioTrack', 'Add Audio Track', 'Sequence', [], addTrackOf('audio')),
  a('seq.addCaptionTrack', 'Add Caption Track', 'Sequence', [], addTrackOf('caption')),

  a('track.lock', 'Lock / Unlock Track', 'Track', [], (s) => toggleTrack(s, 'locked')),
  a('track.mute', 'Mute / Unmute Track', 'Track', [], (s) => toggleTrack(s, 'muted')),
  a('track.solo', 'Solo Track', 'Track', [], (s) => toggleTrack(s, 'solo')),
  a('track.hide', 'Hide / Show Track', 'Track', [], (s) => toggleTrack(s, 'hidden')),
  a('track.delete', 'Delete Track', 'Track', [], (s) => s.history.execute(removeTrack(s.project, s.ctx, activeTrack(s)))),
  a('track.up', 'Move Track Up', 'Track', [], (s) => s.history.execute(moveTrack(s.project, s.ctx, activeTrack(s), s.seq.tracks.findIndex((t) => t.id === s.activeTrackId) + 1))),
  a('track.down', 'Move Track Down', 'Track', [], (s) => s.history.execute(moveTrack(s.project, s.ctx, activeTrack(s), s.seq.tracks.findIndex((t) => t.id === s.activeTrackId) - 1))),

  a('title.add', 'Add Title at Playhead', 'Titles', ['Ctrl+T'], (s) => {
    const track = s.targetTrack('video');
    if (!track) throw new EditError('Add or unlock a video track first.');
    const clip = makeClip({ id: s.newId(), kind: 'text', start: s.toFrame(s.playhead), duration: s.toFrameDelta(5 * TICKS_PER_SECOND), text: defaultTextProps('Title') });
    s.history.execute(overwriteClips(s.project, s.ctx, { at: clip.start, items: [{ trackId: track.id, clip }] }));
    s.select([clip.id]);
  }),
  a('caption.add', 'Add Caption at Playhead', 'Titles', ['Ctrl+Alt+C'], (s) => {
    s.history.group('Add caption', () => {
      if (!s.seq.tracks.some((t) => t.kind === 'caption' && !t.locked)) s.history.execute(addTrack(s.project, s.ctx, { kind: 'caption' }));
      const track = s.targetTrack('caption');
      if (!track) throw new EditError('Unlock the caption track first.');
      const clip = makeClip({ id: s.newId(), kind: 'caption', start: s.toFrame(s.playhead), duration: s.toFrameDelta(2 * TICKS_PER_SECOND), text: { ...captionStyle(), text: 'Caption' } });
      s.history.execute(overwriteClips(s.project, s.ctx, { at: clip.start, items: [{ trackId: track.id, clip }] }));
      s.select([clip.id]);
    });
  }),
  a('caption.split', 'Split Caption at Playhead', 'Titles', [], (s) => s.history.execute(splitCue(s.project, s.ctx, { id: selected(s)[0] as Id, at: s.toFrame(s.playhead) }))),
  a('caption.merge', 'Merge Captions', 'Titles', [], (s) => s.history.execute(mergeCues(s.project, s.ctx, selected(s)))),

  a('play.toggle', 'Play / Pause', 'Playback', ['Space'], (s) => s.clock.toggle()),
  a('play.reverse', 'Shuttle Reverse', 'Playback', ['J'], (s) => s.clock.shuttle(-1)),
  a('play.stop', 'Stop', 'Playback', ['K'], (s) => s.clock.shuttle(0)),
  a('play.forward', 'Shuttle Forward', 'Playback', ['L'], (s) => s.clock.shuttle(1)),
  a('play.stepBack', 'Step Back One Frame', 'Playback', ['ArrowLeft'], (s) => s.clock.step(-1)),
  a('play.stepForward', 'Step Forward One Frame', 'Playback', ['ArrowRight'], (s) => s.clock.step(1)),
  a('play.stepBack10', 'Step Back Ten Frames', 'Playback', ['Shift+ArrowLeft'], (s) => s.clock.step(-10)),
  a('play.stepForward10', 'Step Forward Ten Frames', 'Playback', ['Shift+ArrowRight'], (s) => s.clock.step(10)),
  a('play.start', 'Go to Start', 'Playback', ['Home'], (s) => s.seek(0)),
  a('play.end', 'Go to End', 'Playback', ['End'], (s) => s.seek(sequenceEnd(s.seq))),
  a('play.prevEdit', 'Previous Edit', 'Playback', ['ArrowUp'], (s) => jump(s, s.editPoints(), -1)),
  a('play.nextEdit', 'Next Edit', 'Playback', ['ArrowDown'], (s) => jump(s, s.editPoints(), 1)),
  a('play.loop', 'Loop In to Out', 'Playback', ['Ctrl+Alt+L'], (s) => {
    s.clock.loop = !s.clock.loop;
    s.emit();
  }, (s) => s.clock.loop),

  a('view.zoomIn', 'Zoom In', 'View', ['='], (s) => s.setZoom(s.view.pxPerSecond * 1.5)),
  a('view.zoomOut', 'Zoom Out', 'View', ['-'], (s) => s.setZoom(s.view.pxPerSecond / 1.5)),
  a('view.zoomFit', 'Zoom to Fit', 'View', ['\\'], (s) => s.zoomToFit()),
  a('view.snapping', 'Snapping', 'View', ['N'], (s) => {
    s.snapping = !s.snapping;
    s.emit();
  }, (s) => s.snapping),

  ...TOOLS.map((tool, i) =>
    a(`tool.${tool}`, `${tool[0]?.toUpperCase()}${tool.slice(1)} Tool`, 'Tools', [['V', 'C', 'B', 'R', 'Y', 'U', 'H', 'Z'][i] as string], (s) => s.setTool(tool), (s) => s.tool === tool)),
];

/** Run an action by id. Impossible edits become a message on the session. Returns false for an unknown id. */
export function runAction(s: Session, id: string, extra: readonly Action[] = []): boolean {
  const action = [...ACTIONS, ...extra].find((x) => x.id === id);
  if (!action) return false;
  try {
    action.run(s);
  } catch (e) {
    if (!(e instanceof EditError)) throw e;
    s.notify(e.message);
  }
  return true;
}
