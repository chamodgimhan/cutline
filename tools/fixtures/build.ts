// Fixture definitions and the builder that turns one into MP4 bytes.
import { hashBytes } from '../../src/media/bytes.ts';
import { avcC, ipcmEntry, visualEntry, type Rotation } from '../../src/media/mp4/boxes.ts';
import { Mp4Muxer, type Mp4Sink } from '../../src/media/mp4/muxer.ts';
import { drawFrame, visibleI420 } from './frame.ts';
import { LosslessH264 } from './h264pcm.ts';

export interface FixtureSpec {
  name: string;
  width: number;
  height: number;
  /** Rational frame rate; ignored when frameDurations is set. */
  fpsNum: number;
  fpsDen: number;
  /** Variable frame rate: cycle of frame durations in ms (timescale 1000). */
  vfrCycleMs?: number[];
  seconds: number;
  sampleRate: number;
  channels: 1 | 2;
  rotation?: Rotation;
  faststart: boolean;
  /** Frames whose visible I420 hash is recorded in the manifest. */
  hashFrames: 'few' | 'sparse';
}

const clip = (name: string, fpsNum: number, fpsDen: number, extra: Partial<FixtureSpec> = {}): FixtureSpec => ({
  name, width: 320, height: 180, fpsNum, fpsDen, seconds: 2, sampleRate: 48000, channels: 2, faststart: true, hashFrames: 'few', ...extra,
});

export const VFR_CYCLE_MS = [33, 17, 50, 33, 67, 16, 34, 50];

export const FIXTURES: readonly FixtureSpec[] = [
  clip('clip_24', 24, 1),
  clip('clip_25', 25, 1),
  clip('clip_2997', 30000, 1001),
  clip('clip_60', 60, 1),
  clip('vfr', 0, 1, { vfrCycleMs: VFR_CYCLE_MS }),
  clip('rotated', 30, 1, { rotation: 90 }),
  clip('hd_1080', 30, 1, { width: 1920, height: 1080 }),
  clip('long_2h', 24, 1, { width: 64, height: 48, seconds: 7200, sampleRate: 16000, channels: 1, faststart: false, hashFrames: 'sparse' }),
];

export const TONE_HZ = 1000;
export const TONE_AMP = 8000;
export const CLICK_AMP = 30000;

/** Interleaved s16le PCM for frames [start, start+count): 1 kHz tone, one-sample click each second. */
export function pcmBlock(sampleRate: number, channels: number, start: number, count: number): Uint8Array {
  const period = sampleRate / TONE_HZ;
  if (!Number.isInteger(period)) throw new Error('pcmBlock: sample rate must be a multiple of 1 kHz');
  const table = new Int16Array(period);
  for (let i = 0; i < period; i++) table[i] = Math.round(Math.sin((2 * Math.PI * i) / period) * TONE_AMP);
  const out = new Uint8Array(count * channels * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < count; i++) {
    const n = start + i;
    const tone = table[n % period] as number;
    const click = n % sampleRate === 0;
    for (let c = 0; c < channels; c++) {
      // Right channel carries the tone at half level so channel order is testable.
      view.setInt16((i * channels + c) * 2, click ? CLICK_AMP : c === 0 ? tone : tone >> 1, true);
    }
  }
  return out;
}

/** Frame presentation times and durations in track units. */
export function frameTiming(spec: FixtureSpec): { timescale: number; durations: number[] } {
  if (spec.vfrCycleMs) {
    const durations: number[] = [];
    for (let t = 0, i = 0; t < spec.seconds * 1000; i++) {
      const d = spec.vfrCycleMs[i % spec.vfrCycleMs.length] as number;
      durations.push(d);
      t += d;
    }
    return { timescale: 1000, durations };
  }
  const count = Math.ceil((spec.seconds * spec.fpsNum) / spec.fpsDen);
  return { timescale: spec.fpsNum, durations: new Array<number>(count).fill(spec.fpsDen) };
}

export interface FixtureInfo {
  frameCount: number;
  audioFrames: number;
  /** Frame index -> hash of the visible I420 bytes. */
  frameHashes: Record<string, string>;
}

function wantsHash(spec: FixtureSpec, n: number, count: number): boolean {
  if (spec.hashFrames === 'sparse') return n === 0 || n === count - 1 || n % 10007 === 0;
  return n === 0 || n === 1 || n === count - 1 || n === count >> 1 || n % 13 === 0;
}

/** Encode a fixture into `sink`. Deterministic: same spec, same bytes. */
export function buildFixture(spec: FixtureSpec, sink: Mp4Sink): FixtureInfo {
  const enc = new LosslessH264(spec.width, spec.height);
  const mux = new Mp4Muxer(sink, { faststart: spec.faststart });
  const { timescale, durations } = frameTiming(spec);
  const sps = enc.sps();
  const video = mux.addTrack({
    kind: 'video', timescale, width: spec.width, height: spec.height, rotation: spec.rotation ?? 0,
    sampleEntry: visualEntry('avc1', spec.width, spec.height, avcC(sps, enc.pps())),
  });
  const audio = mux.addTrack({
    kind: 'audio', timescale: spec.sampleRate, fixedSampleSize: spec.channels * 2,
    sampleEntry: ipcmEntry(spec.channels, spec.sampleRate, 16),
  });
  const frameHashes: Record<string, string> = {};
  const keyEvery = spec.vfrCycleMs ? 24 : Math.round(spec.fpsNum / spec.fpsDen) * (spec.seconds > 60 ? 2 : 1);
  const totalAudio = spec.seconds * spec.sampleRate;
  let audioDone = 0;
  let videoTime = 0; // track units
  for (let n = 0; n < durations.length; n++) {
    const d = durations[n] as number;
    // Interleave: flush audio up to the start of each second of video.
    const second = Math.floor(videoTime / timescale);
    const audioTarget = Math.min(totalAudio, second * spec.sampleRate);
    if (audioTarget > audioDone) {
      mux.addFixed(audio, pcmBlock(spec.sampleRate, spec.channels, audioDone, audioTarget - audioDone));
      audioDone = audioTarget;
    }
    const frame = drawFrame(spec.width, spec.height, n);
    const { data, key } = enc.encode(frame, n % keyEvery === 0);
    mux.addSample(video, data, d, key);
    if (wantsHash(spec, n, durations.length)) frameHashes[n] = hashBytes(visibleI420(frame, spec.width, spec.height));
    videoTime += d;
  }
  if (totalAudio > audioDone) mux.addFixed(audio, pcmBlock(spec.sampleRate, spec.channels, audioDone, totalAudio - audioDone));
  mux.finish();
  return { frameCount: durations.length, audioFrames: totalAudio, frameHashes };
}

/** Deterministically damaged copy of a valid file: header kept, index destroyed, tail cut. */
export function corrupt(valid: Uint8Array): Uint8Array {
  const out = valid.slice(0, Math.min(valid.length, 4096));
  let x = 0x2545f491;
  for (let i = 24; i < out.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    if (i < 2048) out[i] = (out[i] as number) ^ (x >>> 24);
  }
  return out;
}
