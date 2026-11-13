// Uncompressed audio: a common reader interface for PCM in MP4/MOV and WAV, plus sample conversion.
import { Mp4File, type Mp4Track } from './mp4/demuxer.ts';
import type { PcmFormat } from './mp4/parse.ts';
import { MediaError, type ByteSource } from './source.ts';

export interface PcmReader {
  sampleRate: number;
  channels: number;
  format: PcmFormat;
  /** Total frames (one sample per channel). */
  frames: number;
  /** Interleaved raw bytes for `count` frames from `first`. Short at the end. */
  read(first: number, count: number): Promise<Uint8Array>;
}

export function mp4PcmReader(file: Mp4File, track: Mp4Track): PcmReader {
  const pcm = track.entry.pcm;
  if (!pcm || !track.uniform) throw new Error('mp4PcmReader: not a PCM track');
  return {
    sampleRate: track.entry.sampleRate || track.timescale, channels: track.entry.channels, format: pcm, frames: track.sampleCount,
    read: (first, count) => file.readUniform(track, first, count),
  };
}

const NOT_WAV = 'This WAV file is damaged or uses a format that is not supported.';

/** Parse a RIFF/WAVE header. Supports integer PCM (8/16/24/32 bit) and 32-bit float. */
export async function wavReader(src: ByteSource): Promise<PcmReader> {
  const head = await src.read(0, Math.min(src.size, 65536));
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (o: number): string => String.fromCharCode(...head.subarray(o, o + 4));
  if (head.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new MediaError('corrupt', NOT_WAV);
  let fmt: { code: number; channels: number; rate: number; align: number; bits: number } | null = null;
  for (let p = 12; p + 8 <= head.length; ) {
    const id = tag(p);
    const size = v.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 24 <= head.length) {
      let code = v.getUint16(p + 8, true);
      if (code === 0xfffe && size >= 26 && p + 34 <= head.length) code = v.getUint16(p + 32, true); // WAVE_FORMAT_EXTENSIBLE sub-format
      fmt = { code, channels: v.getUint16(p + 10, true), rate: v.getUint32(p + 12, true), align: v.getUint16(p + 20, true), bits: v.getUint16(p + 22, true) };
    } else if (id === 'data') {
      if (!fmt) break;
      const float = fmt.code === 3;
      const bits = fmt.bits;
      if ((fmt.code !== 1 && !float) || (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) || (float && bits !== 32) || fmt.channels < 1 || fmt.rate < 1) {
        throw new MediaError('unsupported', NOT_WAV);
      }
      const dataAt = p + 8;
      const frameBytes = fmt.channels * (bits / 8);
      const frames = Math.floor(Math.min(size, src.size - dataAt) / frameBytes);
      return {
        sampleRate: fmt.rate, channels: fmt.channels, format: { bits, littleEndian: true, float }, frames,
        read: (first, count) => {
          const n = Math.max(0, Math.min(count, frames - first));
          return src.read(dataAt + first * frameBytes, n * frameBytes);
        },
      };
    }
    p += 8 + size + (size & 1);
  }
  throw new MediaError('corrupt', NOT_WAV);
}

/** Convert interleaved raw PCM to one Float32Array per channel, range -1..1. */
export function pcmToFloat(bytes: Uint8Array, format: PcmFormat, channels: number): Float32Array[] {
  const step = format.bits / 8;
  const frames = Math.floor(bytes.length / (step * channels));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = format.littleEndian;
  for (let c = 0; c < channels; c++) {
    const dst = out[c] as Float32Array;
    for (let i = 0, o = c * step; i < frames; i++, o += step * channels) {
      if (format.float) dst[i] = v.getFloat32(o, le);
      else if (step === 2) dst[i] = v.getInt16(o, le) / 32768;
      else if (step === 1) dst[i] = (v.getUint8(o) - 128) / 128;
      else if (step === 4) dst[i] = v.getInt32(o, le) / 2147483648;
      else {
        const [b0, b1, b2] = [v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2)];
        const u = le ? b0 | (b1 << 8) | (b2 << 16) : b2 | (b1 << 8) | (b0 << 16);
        dst[i] = ((u << 8) >> 8) / 8388608;
      }
    }
  }
  return out;
}
