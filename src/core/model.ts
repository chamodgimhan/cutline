// Project data model. Plain JSON-serialisable objects, treated as immutable:
// commands produce new objects and share everything they do not change.
import { mulDiv, type Rational, type Tick } from './time.ts';

export type Id = string;

export interface MediaAsset {
  id: Id;
  name: string;
  /** Absolute path (desktop) or a display name (web). */
  path: string;
  /** Content fingerprint used to recognise the file when relinking. */
  fingerprint: string;
  kind: 'video' | 'audio' | 'image';
  /** Zero for images, which have no time limit. */
  duration: Tick;
  video: { width: number; height: number; fps: Rational; rotation: 0 | 90 | 180 | 270; vfr: boolean } | null;
  audio: { sampleRate: number; channels: number } | null;
}

export type Interp = 'linear' | 'hold' | 'bezier';

export interface Keyframe {
  /** Time relative to the clip start. */
  t: Tick;
  v: number;
  /** How the value travels from this key to the next. */
  interp: Interp;
  /** Bezier handles as [time fraction 0..1, value offset] leaving this key and arriving at the next. */
  out: [number, number];
  in: [number, number];
}

/** An animatable value: a constant, or keyframes sorted by time. */
export type Param = number | { keys: Keyframe[] };

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'difference';
export type FitMode = 'fit' | 'fill' | 'stretch' | 'none';

export interface VideoProps {
  opacity: Param;
  /** Position offset in sequence pixels from centre; scale 1 = fitted size; rotation in degrees; anchor 0..1 of the clip box. */
  x: Param;
  y: Param;
  scale: Param;
  rotation: Param;
  anchorX: number;
  anchorY: number;
  /** Fractions 0..1 removed from each edge. */
  crop: { left: number; top: number; right: number; bottom: number };
  blend: BlendMode;
  fit: FitMode;
}

export interface AudioProps {
  /** Gain in decibels. */
  gain: Param;
  fadeIn: Tick;
  fadeOut: Tick;
}

export interface TextProps {
  text: string;
  font: string;
  size: number;
  weight: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  shadowColor: string;
  shadowBlur: number;
  shadowX: number;
  shadowY: number;
  boxColor: string;
  boxPadding: number;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  /** Safe margin kept clear on every side, as a fraction of the frame. */
  margin: number;
}

export interface Effect {
  id: Id;
  type: string;
  enabled: boolean;
  params: Record<string, Param | string | number[]>;
}

export interface Transition {
  type: string;
  duration: Tick;
  params: Record<string, number | string>;
}

export type ClipKind = 'video' | 'audio' | 'text' | 'adjust' | 'caption';
export type TrackKind = 'video' | 'audio' | 'caption';

export interface Clip {
  id: Id;
  kind: ClipKind;
  name: string;
  mediaId: Id | null;
  start: Tick;
  duration: Tick;
  /** Lowest source time used. Source out is derived from duration and speed. */
  sourceIn: Tick;
  speed: Rational;
  reverse: boolean;
  freeze: boolean;
  pitchKeep: boolean;
  enabled: boolean;
  /** Clips sharing a linkId are edited together (video with its audio). */
  linkId: Id | null;
  video: VideoProps | null;
  audio: AudioProps | null;
  text: TextProps | null;
  effects: Effect[];
  transitionIn: Transition | null;
  transitionOut: Transition | null;
  /**
   * Framing used when exporting to a different shape than the sequence (e.g. vertical): pan across the
   * part that would be cropped (-1..1 each way) and extra zoom. Null = centred.
   */
  reframe: { x: number; y: number; scale: number } | null;
}

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  hidden: boolean;
  /** Decibels and -1..1, audio tracks only. */
  volume: number;
  pan: number;
  /** Sorted by start, never overlapping. */
  clips: Clip[];
}

export interface Marker {
  id: Id;
  time: Tick;
  duration: Tick;
  name: string;
  color: string;
}

export interface Sequence {
  id: Id;
  name: string;
  width: number;
  height: number;
  fps: Rational;
  sampleRate: number;
  /** Compositing order: later video tracks draw on top. */
  tracks: Track[];
  markers: Marker[];
  inPoint: Tick | null;
  outPoint: Tick | null;
}

export interface Project {
  name: string;
  media: MediaAsset[];
  sequences: Sequence[];
  activeSequenceId: Id;
}

export const TRACK_ACCEPTS: Record<TrackKind, readonly ClipKind[]> = {
  video: ['video', 'text', 'adjust'],
  audio: ['audio'],
  caption: ['caption'],
};

export const defaultVideoProps = (): VideoProps => ({
  opacity: 1, x: 0, y: 0, scale: 1, rotation: 0, anchorX: 0.5, anchorY: 0.5,
  crop: { left: 0, top: 0, right: 0, bottom: 0 }, blend: 'normal', fit: 'fit',
});

export const defaultAudioProps = (): AudioProps => ({ gain: 0, fadeIn: 0, fadeOut: 0 });

export const defaultTextProps = (text = ''): TextProps => ({
  text, font: 'Roboto', size: 64, weight: 600, color: '#ffffff', strokeColor: '#000000', strokeWidth: 0,
  shadowColor: '#00000000', shadowBlur: 0, shadowX: 0, shadowY: 0, boxColor: '#00000000', boxPadding: 12,
  align: 'center', valign: 'middle', margin: 0.05,
});

export function makeClip(init: Pick<Clip, 'id' | 'kind' | 'start' | 'duration'> & Partial<Clip>): Clip {
  const k = init.kind;
  return {
    name: '', mediaId: null, sourceIn: 0, speed: { num: 1, den: 1 }, reverse: false, freeze: false, pitchKeep: false,
    enabled: true, linkId: null,
    video: k === 'video' || k === 'text' || k === 'adjust' ? defaultVideoProps() : null,
    audio: k === 'audio' ? defaultAudioProps() : null,
    text: k === 'text' || k === 'caption' ? defaultTextProps() : null,
    effects: [], transitionIn: null, transitionOut: null, reframe: null,
    ...init,
    // Older files may lack text fields added since: fill them in.
    ...(init.text ? { text: { ...defaultTextProps(), ...init.text } } : {}),
  };
}

export function makeTrack(id: Id, kind: TrackKind, name: string): Track {
  return { id, kind, name, locked: false, muted: false, solo: false, hidden: false, volume: 0, pan: 0, clips: [] };
}

export function makeSequence(id: Id, init: Partial<Sequence> = {}): Sequence {
  return { id, name: 'Sequence 1', width: 1920, height: 1080, fps: { num: 30, den: 1 }, sampleRate: 48000, tracks: [], markers: [], inPoint: null, outPoint: null, ...init };
}

export function makeProject(seq: Sequence, name = 'Untitled'): Project {
  return { name, media: [], sequences: [seq], activeSequenceId: seq.id };
}

export const clipEnd = (c: Clip): Tick => c.start + c.duration;

/** Source ticks covered by `duration` timeline ticks of this clip. */
export const sourceSpan = (c: Pick<Clip, 'speed' | 'freeze'>, duration: Tick): Tick =>
  c.freeze ? 0 : mulDiv(duration, c.speed.num, c.speed.den, 'floor');

export const clipSourceOut = (c: Clip): Tick => c.sourceIn + sourceSpan(c, c.duration);

/** Source time shown at timeline time `t` (clamped to the clip). */
export function sourceTimeAt(c: Clip, t: Tick): Tick {
  const local = Math.min(Math.max(t - c.start, 0), c.duration);
  if (c.freeze) return c.sourceIn;
  const off = sourceSpan(c, local);
  return c.reverse ? c.sourceIn + sourceSpan(c, c.duration) - off : c.sourceIn + off;
}

export function getSequence(p: Project, id: Id = p.activeSequenceId): Sequence {
  const s = p.sequences.find((x) => x.id === id);
  if (!s) throw new Error(`No sequence ${id}`);
  return s;
}

export const getMedia = (p: Project, id: Id | null): MediaAsset | undefined => (id === null ? undefined : p.media.find((m) => m.id === id));

/** Upper bound for a clip's source out; Infinity when the clip has no timed media. */
export function sourceLimit(p: Project, c: Pick<Clip, 'mediaId'>): number {
  const m = getMedia(p, c.mediaId);
  return m && m.kind !== 'image' ? m.duration : Infinity;
}

export function findClip(seq: Sequence, clipId: Id): { track: Track; clip: Clip } | undefined {
  for (const track of seq.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

export const sequenceEnd = (seq: Sequence): Tick => {
  let end = 0;
  for (const t of seq.tracks) {
    const last = t.clips[t.clips.length - 1];
    if (last) end = Math.max(end, clipEnd(last));
  }
  return end;
};

/** Clip under `time` on a track (start inclusive, end exclusive). Binary search. */
export function clipAt(track: Track, time: Tick): Clip | undefined {
  let lo = 0;
  let hi = track.clips.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = track.clips[mid] as Clip;
    if (time < c.start) hi = mid - 1;
    else if (time >= clipEnd(c)) lo = mid + 1;
    else return c;
  }
  return undefined;
}

const shiftParam = (p: Param, dt: Tick): Param => (typeof p === 'number' ? p : { keys: p.keys.map((k) => ({ ...k, t: k.t + dt })) });

/** Shift every keyframe in a clip by `dt` (used when the clip start moves relative to its content). */
export function shiftKeyframes(c: Clip, dt: Tick): Clip {
  if (dt === 0) return c;
  const v = c.video;
  return {
    ...c,
    video: v && { ...v, opacity: shiftParam(v.opacity, dt), x: shiftParam(v.x, dt), y: shiftParam(v.y, dt), scale: shiftParam(v.scale, dt), rotation: shiftParam(v.rotation, dt) },
    audio: c.audio && { ...c.audio, gain: shiftParam(c.audio.gain, dt) },
    effects: c.effects.map((e) => ({
      ...e,
      params: Object.fromEntries(Object.entries(e.params).map(([k, p]) => [k, typeof p === 'object' && !Array.isArray(p) ? shiftParam(p, dt) : p])),
    })),
  };
}
