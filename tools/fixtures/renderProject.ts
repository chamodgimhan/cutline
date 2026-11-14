// The fixture project used by render checks: a small sequence exercising stacking,
// transform, crop, opacity, blend modes, rotation metadata, speed and reverse.
import { defaultVideoProps, makeClip, makeProject, makeSequence, makeTrack, type Clip, type MediaAsset, type Project, type VideoProps } from '../../src/core/model.ts';
import { TICKS_PER_SECOND as S } from '../../src/core/time.ts';

export const RENDER_FPS = 30;
/** Sequence frames whose pixels are hashed. */
export const RENDER_FRAMES = [0, 7, 20, 22, 31, 45, 59];

const video = (id: string, mediaId: string, start: number, duration: number, v: Partial<VideoProps> = {}, extra: Partial<Clip> = {}): Clip =>
  makeClip({ id, kind: 'video', mediaId, start: Math.round(start * S), duration: Math.round(duration * S), video: { ...defaultVideoProps(), ...v }, ...extra });

/** `assets` must contain media with ids clip_24, rotated and clip_60. */
export function renderProject(assets: MediaAsset[]): Project {
  const seq = makeSequence('seq', { width: 640, height: 360, fps: { num: RENDER_FPS, den: 1 } });
  const [v1, v2, v3] = [makeTrack('V1', 'video', 'V1'), makeTrack('V2', 'video', 'V2'), makeTrack('V3', 'video', 'V3')];
  v1.clips = [video('base', 'clip_24', 0, 2)];
  v2.clips = [video('tall', 'rotated', 0.5, 1, { scale: 0.5, x: 180, y: 20, opacity: 0.8, blend: 'screen' })];
  v3.clips = [
    video('rev', 'clip_60', 0, 0.5, { blend: 'difference', scale: 0.4, x: -60, y: 90 }, { reverse: true, speed: { num: 2, den: 1 } }),
    video('spin', 'clip_60', 1, 1, { rotation: 15, scale: 0.6, x: -100, y: 60, blend: 'multiply', crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0 }, anchorX: 0.25, anchorY: 0.75 }),
  ];
  seq.tracks = [v1, v2, v3];
  const p = makeProject(seq, 'Render fixture');
  p.media = [...assets].sort((a, b) => (a.id < b.id ? -1 : 1));
  return p;
}
