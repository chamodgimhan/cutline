// renderAudio: the single path from a project and a time range to samples.
// Playback and export both use it. Mixing runs in an OfflineAudioContext.
import { clipAudio, dbToGain, EDGE_RAMP } from '../core/audio/envelope.ts';
import { LoudnessMeter } from '../core/audio/loudness.ts';
import { timeStretch } from '../core/audio/timestretch.ts';
import { clipEnd, getMedia, getSequence, sourceSpan, type Clip, type Id, type Project, type Sequence, type Track } from '../core/model.ts';
import { sampleToTick, TICKS_PER_SECOND, tickToSample, type Tick } from '../core/time.ts';
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
  const shape = clipAudio(project, c, R);
  const a = Math.max(shape.from, n0);
  const b = Math.min(shape.to, n1);
  if (b <= a) return null;
  const source = await media.audio(asset);
  if (!source) return null;
  const SR = source.sampleRate;
  const speed = c.speed.num / c.speed.den;
  const perOut = (SR * speed) / R; // source frames per output sample
  const need = Math.ceil((b - a) * perOut);
  const inFrame = tickToSample(c.sourceIn, SR);
  // Reversed clips read backwards from the source out point.
  const first = c.reverse ? tickToSample(c.sourceIn + sourceSpan(c, c.duration), SR) - Math.round((a - shape.start) * perOut) - need : inFrame + Math.round((a - shape.start) * perOut);
  let data = await source.read(first - PAD, need + 2 * PAD);
  let step = perOut; // source frames per output sample, as held in the buffer
  if (c.pitchKeep && speed !== 1) {
    // Keep pitch: stretch the samples themselves and play them at normal rate.
    // shortcut: each chunk is stretched on its own, so a faint artefact is possible where 0.4 s chunks join; upgrade to a per-clip streaming stretcher if it is audible.
    if (c.reverse) data.forEach((ch) => ch.reverse());
    data = timeStretch(data, speed, SR);
    step = SR / R;
  }
  const frames = data[0]?.length ?? 0;
  const lead = Math.round((PAD * step) / perOut);
  const buffer = ctx.createBuffer(2, Math.max(1, frames), SR);
  // Gain (clip gain, fades, edit crossfade) is applied here per sample; mono is spread to both sides.
  const gains = new Float32Array(frames);
  for (let j = 0; j < frames; j++) gains[j] = shape.gainAt(a + (j - lead) / step);
  for (let ch = 0; ch < 2; ch++) {
    const src = (data[Math.min(ch, data.length - 1)] as Float32Array).slice();
    if (c.reverse && step === perOut) src.reverse();
    for (let j = 0; j < src.length; j++) src[j] = (src[j] as number) * (gains[j] as number);
    buffer.copyToChannel(src as Float32Array<ArrayBuffer>, ch);
  }
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.playbackRate.value = step === perOut ? speed : 1;
  node.start((a - n0) / R, lead / SR, ((b - a) * step) / SR);
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
    const out = ctx.createGain();
    out.gain.value = dbToGain(track.volume);
    if (track.pan === 0) out.connect(ctx.destination);
    else {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.min(1, Math.max(-1, track.pan));
      out.connect(pan).connect(ctx.destination);
    }
    // Clips reach past their edges: half an edit crossfade, or a whole audio crossfade transition.
    const reach = sampleToTick(EDGE_RAMP, R) + Math.max(0, ...track.clips.map((x) => x.transitionIn?.duration ?? 0));
    for (const c of track.clips) {
      if (!c.enabled || !c.audio || clipEnd(c) + reach <= range.start || c.start - reach >= range.end) continue;
      jobs.push(clipNode(ctx, project, media, c, n0, n1).then((node) => void node?.connect(out), () => undefined));
    }
  }
  await Promise.all(jobs);
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

/** Integrated loudness (LUFS) of the mix over a range, measured in bounded chunks. */
export async function measureLoudness(project: Project, range: { start: Tick; end: Tick }, media: MediaSources, seqId?: Id): Promise<number> {
  const meter = new LoudnessMeter(getSequence(project, seqId).sampleRate);
  const step = 10 * TICKS_PER_SECOND;
  for (let t = range.start; t < range.end; t += step) meter.push(await renderAudio(project, { start: t, end: Math.min(range.end, t + step) }, media, seqId));
  return meter.integrated();
}

/** Loudness of one clip's own audio: no clip gain, fades, track volume or other clips. */
export function measureClipLoudness(project: Project, clipId: Id, media: MediaSources): Promise<number> {
  const seq = getSequence(project);
  for (const track of seq.tracks) {
    const c = track.clips.find((x) => x.id === clipId);
    if (!c?.audio) continue;
    const bare = { ...c, enabled: true, audio: { gain: 0, fadeIn: 0, fadeOut: 0 } };
    const alone: Project = { ...project, sequences: [{ ...seq, tracks: [{ ...track, muted: false, solo: false, volume: 0, pan: 0, clips: [bare] }] }], activeSequenceId: seq.id };
    return measureLoudness(alone, { start: c.start, end: clipEnd(c) }, media);
  }
  return Promise.resolve(-Infinity);
}
