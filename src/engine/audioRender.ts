// renderAudio: the single path from a project and a time range to samples.
// Playback and export both use it. Mixing runs in an OfflineAudioContext.
import { clipEnd, getMedia, getSequence, sourceSpan, type Clip, type Id, type Project, type Sequence, type Track } from '../core/model.ts';
import { tickToSample, type Tick } from '../core/time.ts';
import type { MediaSources } from './mediaSources.ts';

/** Extra source frames on each side so resampling never interpolates against silence at a chunk edge. */
const PAD = 16;

export function audibleTracks(seq: Sequence): Track[] {
  const audio = seq.tracks.filter((t) => t.kind === 'audio');
  const solo = audio.filter((t) => t.solo);
  return solo.length ? solo : audio.filter((t) => !t.muted);
}

async function clipNode(ctx: OfflineAudioContext, project: Project, media: MediaSources, c: Clip, n0: number, n1: number): Promise<AudioBufferSourceNode | null> {
  const asset = getMedia(project, c.mediaId);
  if (!asset?.audio || c.freeze) return null;
  const R = ctx.sampleRate;
  const cs = tickToSample(c.start, R);
  const a = Math.max(cs, n0);
  const b = Math.min(tickToSample(clipEnd(c), R), n1);
  if (b <= a) return null;
  const source = await media.audio(asset);
  if (!source) return null;
  const SR = source.sampleRate;
  const speed = c.speed.num / c.speed.den;
  const perOut = (SR * speed) / R; // source frames per output sample
  const need = Math.ceil((b - a) * perOut);
  const inFrame = tickToSample(c.sourceIn, SR);
  // Reversed clips read backwards from the source out point.
  const first = c.reverse ? tickToSample(c.sourceIn + sourceSpan(c, c.duration), SR) - Math.round((a - cs) * perOut) - need : inFrame + Math.round((a - cs) * perOut);
  const data = await source.read(first - PAD, need + 2 * PAD);
  const buffer = ctx.createBuffer(source.channels, need + 2 * PAD, SR);
  data.forEach((ch, i) => buffer.copyToChannel((c.reverse ? ch.reverse() : ch) as Float32Array<ArrayBuffer>, i));
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = speed;
  node.start((a - n0) / R, PAD / SR, need / SR);
  return node;
}

/**
 * Mix the sequence's audio for [range.start, range.end) into stereo at the sequence sample rate.
 * Returns [left, right]. Clips whose media is offline or unreadable are silent.
 */
export async function renderAudio(project: Project, range: { start: Tick; end: Tick }, media: MediaSources, seqId?: Id): Promise<[Float32Array, Float32Array]> {
  const seq = getSequence(project, seqId);
  const R = seq.sampleRate;
  const n0 = tickToSample(range.start, R);
  const n1 = tickToSample(range.end, R);
  const length = Math.max(0, n1 - n0);
  if (length === 0) return [new Float32Array(0), new Float32Array(0)];
  const ctx = new OfflineAudioContext(2, length, R);
  const jobs: Promise<void>[] = [];
  for (const track of audibleTracks(seq)) {
    for (const c of track.clips) {
      if (!c.enabled || !c.audio || clipEnd(c) <= range.start || c.start >= range.end) continue;
      jobs.push(clipNode(ctx, project, media, c, n0, n1).then((node) => void node?.connect(ctx.destination), () => undefined));
    }
  }
  await Promise.all(jobs);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}
