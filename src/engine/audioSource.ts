// Audio decode in chunks. PCM is read straight from the file; compressed audio
// goes through WebCodecs one window at a time with a small bounded cache.
import { Mp4File, sampleAtTime, type Mp4Track } from '../media/mp4/demuxer.ts';
import { mp4PcmReader, pcmToFloat, wavReader, type PcmReader } from '../media/pcm.ts';
import { MediaError, type ByteSource } from '../media/source.ts';

/** Packets decoded before the first wanted one so codec state has settled. */
const PREROLL_PACKETS = 3;
const MAX_WINDOWS = 24;

export class AudioSource {
  readonly sampleRate: number;
  readonly channels: number;
  /** Total frames at `sampleRate`. */
  readonly frames: number;
  private readonly pcm: PcmReader | null;
  private readonly file: Mp4File | null;
  private readonly track: Mp4Track | null;
  private readonly windows = new Map<number, Float32Array[]>();
  private readonly windowFrames: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(init: { sampleRate: number; channels: number; frames: number; pcm?: PcmReader; file?: Mp4File; track?: Mp4Track }) {
    this.sampleRate = init.sampleRate;
    this.channels = init.channels;
    this.frames = init.frames;
    this.pcm = init.pcm ?? null;
    this.file = init.file ?? null;
    this.track = init.track ?? null;
    this.windowFrames = init.sampleRate;
  }

  static async open(source: ByteSource): Promise<AudioSource> {
    const head = await source.read(0, 12);
    const tag = (o: number): string => String.fromCharCode(...head.subarray(o, o + 4));
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      const pcm = await wavReader(source);
      return new AudioSource({ sampleRate: pcm.sampleRate, channels: pcm.channels, frames: pcm.frames, pcm });
    }
    const file = await Mp4File.open(source);
    const track = file.audio;
    if (!track) throw new MediaError('unsupported', 'This file has no audio.');
    if (track.entry.codec === 'pcm') {
      const pcm = mp4PcmReader(file, track);
      return new AudioSource({ sampleRate: pcm.sampleRate, channels: pcm.channels, frames: pcm.frames, pcm });
    }
    const sampleRate = track.entry.sampleRate || track.timescale;
    const config = AudioSource.config(track);
    let ok: boolean;
    try {
      ok = typeof AudioDecoder !== 'undefined' && (await AudioDecoder.isConfigSupported(config)).supported === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new MediaError('unsupported', `This computer cannot decode this audio format (${track.entry.fourcc.trim()}).`);
    const frames = Math.max(0, Math.round((track.duration * sampleRate) / track.timescale));
    return new AudioSource({ sampleRate, channels: track.entry.channels, frames, file, track });
  }

  private static config(track: Mp4Track): AudioDecoderConfig {
    return {
      codec: track.entry.codec, sampleRate: track.entry.sampleRate || track.timescale, numberOfChannels: track.entry.channels,
      ...(track.entry.description ? { description: track.entry.description } : {}),
    };
  }

  /** `count` frames from `first`, one Float32Array per channel. Silence outside the file. */
  async read(first: number, count: number): Promise<Float32Array[]> {
    const out = Array.from({ length: this.channels }, () => new Float32Array(count));
    const from = Math.max(0, first);
    const to = Math.min(this.frames, first + count);
    if (to <= from) return out;
    if (this.pcm) {
      const data = pcmToFloat(await this.pcm.read(from, to - from), this.pcm.format, this.channels);
      data.forEach((ch, c) => out[c]?.set(ch, from - first));
      return out;
    }
    for (let w = Math.floor(from / this.windowFrames); w * this.windowFrames < to; w++) {
      const win = await this.window(w);
      const base = w * this.windowFrames;
      const a = Math.max(from, base);
      const b = Math.min(to, base + this.windowFrames);
      win.forEach((ch, c) => out[c]?.set(ch.subarray(a - base, b - base), a - first));
    }
    return out;
  }

  private window(w: number): Promise<Float32Array[]> {
    const hit = this.windows.get(w);
    if (hit) {
      this.windows.delete(w);
      this.windows.set(w, hit);
      return Promise.resolve(hit);
    }
    const job = this.queue.then(async () => {
      const again = this.windows.get(w);
      if (again) return again;
      const win = await this.decodeWindow(w);
      this.windows.set(w, win);
      for (const k of this.windows.keys()) {
        if (this.windows.size <= MAX_WINDOWS) break;
        this.windows.delete(k);
      }
      return win;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async decodeWindow(w: number): Promise<Float32Array[]> {
    const track = this.track as Mp4Track;
    const file = this.file as Mp4File;
    const base = w * this.windowFrames;
    const win = Array.from({ length: this.channels }, () => new Float32Array(this.windowFrames));
    const toUnits = (frame: number): number => (frame * track.timescale) / this.sampleRate;
    const firstPacket = Math.max(0, sampleAtTime(track, toUnits(base)) - PREROLL_PACKETS);
    const lastPacket = Math.min(track.sampleCount - 1, sampleAtTime(track, toUnits(base + this.windowFrames)) + 1);
    let failed: Error | null = null;
    const decoder = new AudioDecoder({
      output: (data) => {
        // Position from the timestamp we assigned: the packet's presentation time in frames.
        const start = Math.round((data.timestamp * this.sampleRate) / 1e6) - base;
        const n = data.numberOfFrames;
        const tmp = new Float32Array(n);
        for (let c = 0; c < Math.min(this.channels, data.numberOfChannels); c++) {
          data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
          const a = Math.max(0, -start);
          const b = Math.min(n, this.windowFrames - start);
          if (b > a) win[c]?.set(tmp.subarray(a, b), start + a);
        }
        data.close();
      },
      error: (e) => (failed = e),
    });
    decoder.configure(AudioSource.config(track));
    for (let s = firstPacket; s <= lastPacket; s++) {
      const data = await file.readSample(track, s);
      if (decoder.state !== 'configured') break;
      const timestamp = Math.round(((track.pts[s] as number) * 1e6) / track.timescale);
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, data }));
    }
    if (decoder.state === 'configured') await decoder.flush().catch((e: Error) => (failed = e));
    if (decoder.state !== 'closed') decoder.close();
    if (failed) throw new MediaError('corrupt', 'Part of the audio could not be decoded. The file may be damaged.');
    return win;
  }
}
