// Source monitor: a media file is previewed as a one-clip project, so the source and
// program monitors share one renderer and one transport.
import { makeClip, makeProject, makeSequence, makeTrack, type MediaAsset, type Project } from './model.ts';
import { TICKS_PER_SECOND } from './time.ts';

/** Length shown for stills, which have no duration of their own. */
export const STILL_DURATION = 5 * TICKS_PER_SECOND;

export function sourceProject(asset: MediaAsset): Project {
  const v = asset.video;
  const turned = v && (v.rotation === 90 || v.rotation === 270);
  const seq = makeSequence('source', {
    name: asset.name, width: v ? (turned ? v.height : v.width) : 640, height: v ? (turned ? v.width : v.height) : 360,
    fps: v && asset.kind === 'video' ? v.fps : { num: 30, den: 1 }, sampleRate: asset.audio?.sampleRate ?? 48000,
  });
  const duration = asset.kind === 'image' ? STILL_DURATION : asset.duration;
  if (v) {
    const t = makeTrack('V', 'video', 'V1');
    t.clips = [makeClip({ id: 'source-v', kind: 'video', mediaId: asset.id, start: 0, duration, linkId: 'source' })];
    seq.tracks.push(t);
  }
  if (asset.audio) {
    const t = makeTrack('A', 'audio', 'A1');
    t.clips = [makeClip({ id: 'source-a', kind: 'audio', mediaId: asset.id, start: 0, duration, linkId: 'source' })];
    seq.tracks.push(t);
  }
  const p = makeProject(seq, asset.name);
  p.media = [asset];
  return p;
}
