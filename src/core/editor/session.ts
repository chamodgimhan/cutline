// Editor session: everything the UI edits through. Pure state and logic; the
// playback clock is injected so this runs the same in tests and in the app.
import { EditError, type Command } from '../command.ts';
import type { EditCtx } from '../draft.ts';
import { History } from '../history.ts';
import { clipEnd, getMedia, getSequence, makeClip, sequenceEnd, type Clip, type Id, type MediaAsset, type Project, type Sequence, type Track } from '../model.ts';
import { STILL_DURATION } from '../monitor.ts';
import { frameTicks, snapToFrame, TICKS_PER_SECOND, type Tick } from '../time.ts';
import type { Placement } from '../commands/clips.ts';
import type { LaneKey } from './lane.ts';

export type Tool = 'select' | 'razor' | 'ripple' | 'roll' | 'slip' | 'slide' | 'hand' | 'zoom';
export const TOOLS: readonly Tool[] = ['select', 'razor', 'ripple', 'roll', 'slip', 'slide', 'hand', 'zoom'];

/** What the session needs from playback. The app passes the Transport; tests pass a stub. */
export interface Clock {
  readonly playhead: Tick;
  readonly playing: boolean;
  loop: boolean;
  seek(tick: Tick): void;
  toggle(): void;
  pause(): void;
  shuttle(direction: -1 | 0 | 1): void;
  step(frames: number): void;
  refresh(): void;
}

/** A clock that only holds a position, for tests and before the engine is ready. */
export function parkedClock(): Clock {
  const c = {
    playhead: 0, playing: false, loop: false,
    seek(t: Tick): void {
      c.playhead = Math.max(0, t);
    },
    toggle(): void {
      c.playing = !c.playing;
    },
    pause(): void {
      c.playing = false;
    },
    shuttle(d: -1 | 0 | 1): void {
      c.playing = d !== 0;
    },
    step(): void {},
    refresh(): void {},
  };
  return c;
}

export const MIN_ZOOM = 0.5; // pixels per second
export const MAX_ZOOM = 2400;

export class Session {
  readonly history: History;
  clock: Clock;
  selection = new Set<Id>();
  tool: Tool = 'select';
  snapping = true;
  /** Linked clips are edited together unless this is off. */
  linked = true;
  /** Property shown in the timeline's keyframe lane. */
  laneKey: LaneKey = 'opacity';
  /** Which panel shortcuts like mark in/out apply to. */
  focus: 'timeline' | 'source' = 'timeline';
  view = { pxPerSecond: 80, scrollX: 0, scrollY: 0, width: 1000 };
  clipboard: { items: Placement[]; origin: Tick } | null = null;
  source: { mediaId: Id | null; inPoint: Tick | null; outPoint: Tick | null; playhead: Tick } = { mediaId: null, inPoint: null, outPoint: null, playhead: 0 };
  /** Track that header buttons and track menu items act on. */
  activeTrackId: Id | null = null;
  /** Last message for the user (errors from edits that were not possible). */
  message: string | null = null;
  private counter = 0;
  private readonly listeners = new Set<() => void>();

  constructor(project: Project, clock: Clock = parkedClock()) {
    this.history = new History(project);
    this.clock = clock;
    this.history.subscribe(() => this.afterChange());
  }

  get project(): Project {
    return this.history.project;
  }
  get seq(): Sequence {
    return getSequence(this.project);
  }
  get playhead(): Tick {
    return this.clock.playhead;
  }
  get frame(): Tick {
    return frameTicks(this.seq.fps);
  }

  /** A fresh id not used anywhere in the project. */
  newId = (): Id => {
    const used = new Set<Id>();
    for (const m of this.project.media) used.add(m.id);
    for (const s of this.project.sequences) {
      for (const t of s.tracks) {
        used.add(t.id);
        for (const c of t.clips) {
          used.add(c.id);
          if (c.linkId) used.add(c.linkId);
        }
      }
      for (const m of s.markers) used.add(m.id);
    }
    let id: Id;
    do id = `i${++this.counter}`;
    while (used.has(id));
    return id;
  };

  get ctx(): EditCtx {
    return { newId: this.newId };
  }

  /** Build and run an edit. An impossible edit becomes a message, never an exception. Returns whether it ran. */
  run(build: () => Command): boolean {
    try {
      const cmd = build();
      this.history.execute(cmd);
      return !cmd.isEmpty;
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      this.notify(e.message);
      return false;
    }
  }

  notify(message: string): void {
    this.message = message;
    this.emit();
  }

  /** After any project change: drop selected ids that no longer exist, redraw the monitor. */
  private afterChange(): void {
    const alive = new Set(this.seq.tracks.flatMap((t) => t.clips.map((c) => c.id)));
    for (const id of this.selection) if (!alive.has(id)) this.selection.delete(id);
    if (this.activeTrackId && !this.seq.tracks.some((t) => t.id === this.activeTrackId)) this.activeTrackId = null;
    this.clock.refresh();
    this.emit();
  }

  select(ids: Iterable<Id>, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    if (mode === 'replace') this.selection.clear();
    let all = [...ids];
    if (this.linked) {
      // Linked selection: picking a clip picks everything linked to it.
      const clips = this.seq.tracks.flatMap((t) => t.clips);
      const links = new Set(clips.filter((c) => all.includes(c.id) && c.linkId !== null).map((c) => c.linkId));
      all = [...new Set([...all, ...clips.filter((c) => links.has(c.linkId)).map((c) => c.id)])];
    }
    for (const id of all) {
      if (mode === 'toggle' && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit();
  }

  selectedClips(): { track: Track; clip: Clip }[] {
    return this.seq.tracks.flatMap((track) => track.clips.filter((c) => this.selection.has(c.id)).map((clip) => ({ track, clip })));
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.emit();
  }

  /** Snap a time to the sequence frame grid. */
  toFrame(tick: Tick): Tick {
    return Math.max(0, snapToFrame(tick, this.seq.fps));
  }

  /** Snap a signed distance to whole frames. */
  toFrameDelta(delta: Tick): Tick {
    return snapToFrame(delta, this.seq.fps);
  }

  seek(tick: Tick): void {
    this.clock.seek(this.toFrame(tick));
    this.emit();
  }

  /** Every clip edge and the sequence ends, sorted: the stops for "next/previous edit". */
  editPoints(): Tick[] {
    const set = new Set<Tick>([0, sequenceEnd(this.seq)]);
    for (const t of this.seq.tracks) for (const c of t.clips) set.add(c.start).add(clipEnd(c));
    return [...set].sort((a, b) => a - b);
  }

  setZoom(pxPerSecond: number, anchorTick: Tick = this.playhead): void {
    const before = (anchorTick / TICKS_PER_SECOND) * this.view.pxPerSecond - this.view.scrollX;
    this.view.pxPerSecond = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerSecond));
    // Keep the anchor time under the same pixel.
    this.view.scrollX = Math.max(0, (anchorTick / TICKS_PER_SECOND) * this.view.pxPerSecond - before);
    this.emit();
  }

  zoomToFit(): void {
    const seconds = Math.max(1, sequenceEnd(this.seq) / TICKS_PER_SECOND);
    this.view.pxPerSecond = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (this.view.width - 40) / seconds));
    this.view.scrollX = 0;
    this.emit();
  }

  /** Lowest unlocked track of a kind: where new material goes by default. */
  targetTrack(kind: Track['kind']): Track | undefined {
    const active = this.seq.tracks.find((t) => t.id === this.activeTrackId);
    if (active && active.kind === kind && !active.locked) return active;
    return this.seq.tracks.find((t) => t.kind === kind && !t.locked);
  }

  /**
   * Clips for placing a media file (or the marked part of it) on the timeline: video on
   * `videoTrack` and linked audio on the audio target. `length` limits the duration (three-point edits).
   */
  clipsFromMedia(asset: MediaAsset, range: { inPoint: Tick | null; outPoint: Tick | null }, videoTrack?: Id, length?: Tick): Placement[] {
    const total = asset.kind === 'image' ? STILL_DURATION : asset.duration;
    const sourceIn = asset.kind === 'image' ? 0 : Math.min(range.inPoint ?? 0, total);
    let duration = Math.max(0, Math.min(range.outPoint ?? total, total) - sourceIn);
    if (length !== undefined) duration = Math.min(duration, length);
    // Whole frames only, so cuts land on the sequence grid.
    duration = snapToFrame(duration, this.seq.fps, 'floor');
    if (duration <= 0) throw new EditError('The marked part of the source is shorter than one frame.');
    const items: Placement[] = [];
    const v = asset.video ? (videoTrack ? this.seq.tracks.find((t) => t.id === videoTrack) : this.targetTrack('video')) : undefined;
    const a = asset.audio ? this.targetTrack('audio') : undefined;
    const linkId = v && a ? this.newId() : null;
    const base = { mediaId: asset.id, name: asset.name, start: 0, duration, sourceIn, linkId };
    if (v && v.kind === 'video') items.push({ trackId: v.id, clip: makeClip({ ...base, id: this.newId(), kind: 'video' }) });
    if (a) items.push({ trackId: a.id, clip: makeClip({ ...base, id: this.newId(), kind: 'audio' }) });
    if (items.length === 0) throw new EditError(asset.video ? 'Add or unlock a video track first.' : 'Add or unlock an audio track first.');
    return items;
  }

  sourceAsset(): MediaAsset {
    const asset = getMedia(this.project, this.source.mediaId);
    if (!asset) throw new EditError('Open a clip in the source monitor first.');
    return asset;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of this.listeners) fn();
  }
}
