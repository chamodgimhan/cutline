// Tool gestures: a press on the timeline starts one, moves update a live preview,
// release commits it as a single undo step. Pure: pixels come in through a Hit.
import { splitClips, moveClips } from '../commands/clips.ts';
import { rippleTrim, rollEdit, slideClip, slipClip, trimClip } from '../commands/trim.ts';
import { EditError, type Command } from '../command.ts';
import { clipEnd, type Id } from '../model.ts';
import { collectSnapPoints, snapMove, snapTime, type SnapPoint } from '../snap.ts';
import type { Tick } from '../time.ts';
import { pxToTicks, rows, type Hit, type Metrics, DEFAULT_METRICS } from './layout.ts';
import type { Session } from './session.ts';

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export interface Gesture {
  move(hit: Hit): void;
  end(): void;
  cancel(): void;
  /** Time of the snap target currently captured, for the indicator line. */
  snapLine: Tick | null;
  /** Rubber-band rectangle in clip-area pixels while marquee selecting. */
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
}

const SNAP_PX = 8;
const DRAG_PX = 3;

/** A gesture that edits the project: each move replaces the previous preview. */
function editGesture(s: Session, label: string, build: (hit: Hit, g: Gesture) => Command | null): Gesture {
  s.history.beginGroup(label);
  const g: Gesture = {
    snapLine: null,
    marquee: null,
    move(hit) {
      s.history.cancelGroup();
      s.history.beginGroup(label);
      try {
        const cmd = build(hit, g);
        if (cmd) s.history.execute(cmd);
      } catch (e) {
        if (!(e instanceof EditError)) throw e; // an impossible position simply shows no change
      }
      s.emit();
    },
    end() {
      g.snapLine = null;
      s.history.endGroup();
      s.emit();
    },
    cancel() {
      g.snapLine = null;
      s.history.cancelGroup();
      s.emit();
    },
  };
  return g;
}

/** A gesture that changes only view or selection state. */
function plainGesture(s: Session, move: (hit: Hit, g: Gesture) => void, end: (g: Gesture) => void = () => undefined): Gesture {
  const g: Gesture = {
    snapLine: null,
    marquee: null,
    move(hit) {
      move(hit, g);
      s.emit();
    },
    end() {
      end(g);
      g.marquee = null;
      s.emit();
    },
    cancel() {
      g.marquee = null;
      s.emit();
    },
  };
  return g;
}

function points(s: Session, exclude: ReadonlySet<Id>): SnapPoint[] {
  return s.snapping ? collectSnapPoints(s.seq, { exclude, playhead: s.playhead }) : [];
}

/** Snap one time to targets, then to the frame grid. */
function snapped(s: Session, tick: Tick, pts: readonly SnapPoint[], g: Gesture): Tick {
  const r = snapTime(tick, pts, pxToTicks(SNAP_PX, s.view));
  g.snapLine = r.point ? r.time : null;
  return r.point ? r.time : s.toFrame(tick);
}

/** Start the gesture for the current tool at `hit`. Null when a press there does nothing. */
export function beginGesture(s: Session, hit: Hit, mods: Mods, m: Metrics = DEFAULT_METRICS): Gesture | null {
  if (hit.area === 'ruler') {
    s.seek(hit.tick);
    return plainGesture(s, (h) => s.seek(h.tick));
  }
  if (s.tool === 'hand') {
    const start = { ...s.view };
    return plainGesture(s, (h) => {
      // The pointer x is in view pixels, so the scroll delta is the raw pointer movement.
      s.view.scrollX = Math.max(0, start.scrollX - (h.x - hit.x));
      s.view.scrollY = Math.max(0, start.scrollY - (h.y - hit.y));
    });
  }
  if (s.tool === 'zoom') {
    s.setZoom(s.view.pxPerSecond * (mods.alt ? 1 / 1.5 : 1.5), hit.tick);
    return null;
  }
  const clip = hit.clip;
  if (hit.trackId) s.activeTrackId = hit.trackId;
  const linked = s.linked && !mods.alt;
  const min = s.frame;

  if (s.tool === 'razor') {
    if (clip) s.run(() => splitClips(s.project, s.ctx, mods.shift ? { at: s.toFrame(hit.tick) } : { at: s.toFrame(hit.tick), ids: [clip.id], linked }));
    return null;
  }

  if (!clip) {
    if (s.tool !== 'select') return null;
    // Marquee: select every clip the rectangle touches. A plain click clears the selection.
    const before = mods.shift ? [...s.selection] : [];
    if (!mods.shift) s.select([]);
    return plainGesture(s, (h, g) => {
      g.marquee = { x0: Math.min(hit.x, h.x), y0: Math.min(hit.y, h.y), x1: Math.max(hit.x, h.x), y1: Math.max(hit.y, h.y) };
      const [t0, t1] = [Math.min(hit.tick, h.tick), Math.max(hit.tick, h.tick)];
      const top = g.marquee.y0 - m.rulerHeight + s.view.scrollY;
      const bottom = g.marquee.y1 - m.rulerHeight + s.view.scrollY;
      const ids = rows(s.seq, m).filter((r) => r.y < bottom && r.y + r.height > top && !r.track.locked)
        .flatMap((r) => r.track.clips.filter((c) => c.start < t1 && clipEnd(c) > t0).map((c) => c.id));
      s.select([...before, ...ids]);
    });
  }

  const id = clip.id;
  const edge = hit.edge;
  const grabbed = edge === 'out' ? clipEnd(clip) : clip.start;

  if (edge && (s.tool === 'select' || s.tool === 'ripple' || s.tool === 'roll')) {
    if (!s.selection.has(id)) s.select([id]);
    const pts = points(s, new Set([id]));
    const fn = s.tool === 'ripple' ? rippleTrim : s.tool === 'roll' ? rollEdit : trimClip;
    const label = s.tool === 'ripple' ? 'Ripple trim' : s.tool === 'roll' ? 'Roll' : 'Trim';
    return editGesture(s, label, (h, g) => fn(s.project, s.ctx, { id, edge, to: snapped(s, grabbed + (h.tick - hit.tick), pts, g), linked, minDuration: min }));
  }

  if (s.tool === 'slip') {
    if (!s.selection.has(id)) s.select([id]);
    // Dragging right pulls earlier source into view, like sliding the film under the window.
    const perTick = clip.speed.num / clip.speed.den;
    return editGesture(s, 'Slip', (h) => slipClip(s.project, s.ctx, { id, by: -Math.round(s.toFrameDelta(h.tick - hit.tick) * perTick), linked }));
  }
  if (s.tool === 'slide') {
    if (!s.selection.has(id)) s.select([id]);
    return editGesture(s, 'Slide', (h) => slideClip(s.project, s.ctx, { id, delta: s.toFrameDelta(h.tick - hit.tick), linked, minDuration: min }));
  }
  if (s.tool !== 'select') return null;

  // Select tool on a clip body: click selects, drag moves the selection.
  const wasSelected = s.selection.has(id);
  if (mods.shift) s.select([id], 'toggle');
  else if (!wasSelected) s.select([id]);
  const moving = s.selectedClips();
  if (moving.length === 0) return null;
  const ids = moving.map((x) => x.clip.id);
  const edges = moving.flatMap((x) => [x.clip.start, clipEnd(x.clip)]);
  const pts = points(s, new Set(ids));
  const homeTrack = s.seq.tracks.find((t) => t.clips.some((c) => c.id === id));
  let dragged = false;
  const g = editGesture(s, 'Move', (h, gest) => {
    if (!dragged && Math.abs(h.x - hit.x) < DRAG_PX && Math.abs(h.y - hit.y) < DRAG_PX) return null;
    dragged = true;
    const raw = h.tick - hit.tick;
    const snap = snapMove(edges, raw, pts, pxToTicks(SNAP_PX, s.view));
    gest.snapLine = snap.point ? snap.point.time : null;
    const delta = snap.point ? snap.delta : s.toFrameDelta(raw);
    // Over another track of the same kind: clips from the grabbed clip's track go there.
    const target = s.seq.tracks.find((t) => t.id === h.trackId);
    const tracks: Record<Id, Id> = {};
    if (target && homeTrack && target.id !== homeTrack.id && target.kind === homeTrack.kind) {
      for (const x of moving) if (x.track.id === homeTrack.id) tracks[x.clip.id] = target.id;
    }
    return moveClips(s.project, s.ctx, { ids, delta, tracks, linked: false });
  });
  const end = g.end;
  g.end = () => {
    end();
    // A click (no drag) on one of several selected clips narrows the selection to it.
    if (!dragged && wasSelected && !mods.shift) s.select([id]);
  };
  return g;
}

/** Clip under a point for hover feedback: which edge cursor a tool would show. */
export function cursorFor(s: Session, hit: Hit): 'default' | 'ew-resize' | 'col-resize' | 'grab' | 'crosshair' | 'zoom-in' {
  if (s.tool === 'hand') return 'grab';
  if (s.tool === 'zoom') return 'zoom-in';
  if (s.tool === 'razor') return hit.clip ? 'crosshair' : 'default';
  if (hit.edge && (s.tool === 'select' || s.tool === 'ripple')) return 'ew-resize';
  if (hit.edge && s.tool === 'roll') return 'col-resize';
  return 'default';
}
