// Probe: container detection and the facts the editor needs about a file.
import type { MediaAsset } from '../core/model.ts';
import { gcd, mulDiv, TICKS_PER_SECOND, unitsToTicks, type Rational, type Tick } from '../core/time.ts';
import { Mp4File, type Mp4Track } from './mp4/demuxer.ts';
import { wavReader } from './pcm.ts';
import { fingerprint, MediaError, type ByteSource } from './source.ts';

export interface MediaInfo {
  container: 'mp4' | 'wav' | 'image';
  duration: Tick;
  video: {
    /** Stored size; swap for display when rotation is 90 or 270. */
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
    fps: Rational;
    vfr: boolean;
    codec: string;
    frameCount: number;
  } | null;
  audio: { sampleRate: number; channels: number; codec: string } | null;
}

const STANDARD_RATES: Rational[] = [
  { num: 24000, den: 1001 }, { num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30000, den: 1001 }, { num: 30, den: 1 },
  { num: 48, den: 1 }, { num: 50, den: 1 }, { num: 60000, den: 1001 }, { num: 60, den: 1 }, { num: 120, den: 1 },
];

/** Frame rate and whether the track is variable frame rate. */
export function analyseFrameRate(track: Mp4Track): { fps: Rational; vfr: boolean } {
  const d = track.durations;
  const n = d.length;
  if (n === 0) return { fps: { num: 30, den: 1 }, vfr: false };
  let min = Infinity;
  let max = 0;
  let total = 0;
  // The last sample's duration is often a filler value; leave it out when there are others.
  const used = n > 1 ? n - 1 : n;
  for (let i = 0; i < used; i++) {
    const v = d[i] as number;
    min = Math.min(min, v);
    max = Math.max(max, v);
    total += v;
  }
  if (min === max && min > 0) {
    const g = gcd(track.timescale, min);
    return { fps: { num: track.timescale / g, den: min / g }, vfr: false };
  }
  const avg = total > 0 ? (used * track.timescale) / total : 30;
  let best = STANDARD_RATES[0] as Rational;
  for (const r of STANDARD_RATES) if (Math.abs(r.num / r.den - avg) < Math.abs(best.num / best.den - avg)) best = r;
  const near = Math.abs(best.num / best.den - avg) / avg < 0.005;
  // Jitter of one timescale unit (e.g. 33/34 ms at 30 fps) is rounding, not variable frame rate.
  if (max - min <= 1 && near) return { fps: best, vfr: false };
  const fps = near ? best : { num: Math.max(1, Math.round(avg * 1000)), den: 1000 };
  const g = gcd(fps.num, fps.den);
  return { fps: { num: fps.num / g, den: fps.den / g }, vfr: true };
}

function imageSize(head: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length > 24 && v.getUint32(0) === 0x89504e47) return { width: v.getUint32(16), height: v.getUint32(20) };
  if (head.length > 30 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    const kind = String.fromCharCode(...head.subarray(12, 16));
    if (kind === 'VP8X') return { width: 1 + (v.getUint16(24, true) | (v.getUint8(26) << 16)), height: 1 + (v.getUint16(27, true) | (v.getUint8(29) << 16)) };
    if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (kind === 'VP8L') {
      const b = v.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (head.length > 4 && v.getUint16(0) === 0xffd8) {
    for (let p = 2; p + 9 < head.length; ) {
      if (v.getUint8(p) !== 0xff) return null;
      const marker = v.getUint8(p + 1);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: v.getUint16(p + 7), height: v.getUint16(p + 5) };
      p += 2 + v.getUint16(p + 2);
    }
  }
  return null;
}

/** Inspect a file. Throws MediaError with a plain message for anything that cannot be used. */
export async function probe(src: ByteSource): Promise<MediaInfo> {
  if (src.size < 12) throw new MediaError('corrupt', 'This file is empty or too small to be a media file.');
  const head = await src.read(0, 12);
  const tag = (o: number): string => String.fromCharCode(...head.subarray(o, o + 4));
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    const wav = await wavReader(src);
    return { container: 'wav', duration: mulDiv(wav.frames, TICKS_PER_SECOND, wav.sampleRate, 'round'), video: null, audio: { sampleRate: wav.sampleRate, channels: wav.channels, codec: 'pcm' } };
  }
  const size = imageSize(await src.read(0, Math.min(src.size, 262144)));
  if (size) {
    if (size.width < 1 || size.height < 1) throw new MediaError('corrupt', 'This image is damaged.');
    return { container: 'image', duration: 0, video: { ...size, rotation: 0, fps: { num: 30, den: 1 }, vfr: false, codec: 'image', frameCount: 1 }, audio: null };
  }
  if (new DataView(head.buffer, head.byteOffset).getUint32(0) === 0x1a45dfa3) {
    throw new MediaError('unsupported', 'WebM and MKV files cannot be imported. Convert the file to MP4 first.');
  }
  const file = await Mp4File.open(src);
  const v = file.video;
  const a = file.audio;
  if (v && v.entry.codec.startsWith('unknown:')) throw new MediaError('unsupported', `This file uses a video format (${v.entry.fourcc.trim()}) that Cutline cannot decode.`);
  if (a && a.entry.codec.startsWith('unknown:') && !v) throw new MediaError('unsupported', `This file uses an audio format (${a.entry.fourcc.trim()}) that Cutline cannot decode.`);
  const audioOk = a && !a.entry.codec.startsWith('unknown:') ? a : undefined;
  if (!v && !audioOk) throw new MediaError('unsupported', 'This file has no video or audio Cutline can use.');
  const duration = Math.max(v ? unitsToTicks(v.duration, v.timescale) : 0, audioOk ? unitsToTicks(audioOk.duration, audioOk.timescale) : 0);
  if (duration <= 0) throw new MediaError('corrupt', 'This file has no playable content.');
  return {
    container: 'mp4', duration,
    video: v ? { width: v.width, height: v.height, rotation: v.rotation, ...analyseFrameRate(v), codec: v.entry.codec, frameCount: v.sampleCount } : null,
    audio: audioOk ? { sampleRate: audioOk.entry.sampleRate || audioOk.timescale, channels: audioOk.entry.channels, codec: audioOk.entry.codec } : null,
  };
}

/** Size as shown on screen, after rotation metadata. */
export const displaySize = (v: { width: number; height: number; rotation: number }): { width: number; height: number } =>
  v.rotation === 90 || v.rotation === 270 ? { width: v.height, height: v.width } : { width: v.width, height: v.height };

/** Probe a file and build its media pool entry. */
export async function describeMedia(src: ByteSource, id: string, name: string, path: string): Promise<MediaAsset> {
  const info = await probe(src);
  return {
    id, name, path, fingerprint: await fingerprint(src), duration: info.duration,
    kind: info.container === 'image' ? 'image' : info.video ? 'video' : 'audio',
    video: info.video && { width: info.video.width, height: info.video.height, fps: info.video.fps, rotation: info.video.rotation, vfr: info.video.vfr },
    audio: info.audio && { sampleRate: info.audio.sampleRate, channels: info.audio.channels },
  };
}
