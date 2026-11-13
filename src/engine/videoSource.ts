// Frame-accurate video decode over WebCodecs with a bounded frame cache.
// Frames are addressed by presentation index; times map to the frame on screen at that time.
import { mulDiv, TICKS_PER_SECOND, type Tick } from '../core/time.ts';
import { keyBefore, Mp4File, sampleAtTime, type Mp4Track } from '../media/mp4/demuxer.ts';
import { MediaError, type ByteSource } from '../media/source.ts';

export interface VideoSourceOptions {
  /** Upper bound for decoded frames kept in memory. */
  cacheBytes?: number;
  hardwareAcceleration?: HardwareAcceleration;
}

const DEFAULT_CACHE = 256 * 1024 * 1024;
/** Frames fed past the target before forcing a flush, to ride out decoder reordering. */
const LOOKAHEAD = 6;
/** Frames before a seek target that are kept; earlier ones in the GOP are decoded and dropped. */
const KEEP_BEFORE = 6;
/** Largest single read used to fetch a run of samples. */
const MAX_BLOCK = 48 * 1024 * 1024;

interface Waiter {
  index: number;
  resolve: () => void;
  reject: (e: Error) => void;
}

export class VideoSource {
  readonly file: Mp4File;
  readonly track: Mp4Track;
  readonly maxFrames: number;
  private readonly config: VideoDecoderConfig;
  private readonly presOf: Uint32Array; // decode index -> presentation index
  private readonly cache = new Map<number, VideoFrame>();
  private decoder: VideoDecoder | null = null;
  private keepFrom = 0; // frames below this index are not cached during a seek
  private lastOut = -1; // highest presentation index output since the last restart
  private readonly reordered: boolean;
  private fedUntil = -1; // last decode-order index fed since the last key-frame start, -1 = must restart
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Decoder restarts from a key frame (for performance tests). */
  seeks = 0;

  private constructor(file: Mp4File, track: Mp4Track, config: VideoDecoderConfig, options: VideoSourceOptions) {
    this.file = file;
    this.track = track;
    this.config = config;
    this.presOf = new Uint32Array(track.sampleCount);
    track.order.forEach((decodeIndex, pres) => (this.presOf[decodeIndex] = pres));
    this.reordered = track.order.some((d, i) => d !== i);
    const frameBytes = track.width * track.height * 1.5;
    this.maxFrames = Math.max(4, Math.min(240, Math.floor((options.cacheBytes ?? DEFAULT_CACHE) / frameBytes)));
  }

  static async open(source: ByteSource, options: VideoSourceOptions = {}): Promise<VideoSource> {
    const file = await Mp4File.open(source);
    const track = file.video;
    if (!track) throw new MediaError('unsupported', 'This file has no video.');
    const config: VideoDecoderConfig = {
      codec: track.entry.codec, codedWidth: track.width, codedHeight: track.height,
      hardwareAcceleration: options.hardwareAcceleration ?? 'no-preference', optimizeForLatency: true,
      ...(track.entry.description ? { description: track.entry.description } : {}),
    };
    let ok: boolean;
    try {
      ok = typeof VideoDecoder !== 'undefined' && (await VideoDecoder.isConfigSupported(config)).supported === true;
    } catch {
      ok = false;
    }
    if (!ok) throw new MediaError('unsupported', `This computer cannot decode this video format (${track.entry.fourcc.trim()}).`);
    return new VideoSource(file, track, config, options);
  }

  get frameCount(): number {
    return this.track.sampleCount;
  }
  get cachedFrames(): number {
    return this.cache.size;
  }

  /** Presentation index of the frame on screen at source time `tick`. */
  indexAt(tick: Tick): number {
    return sampleAtTime(this.track, mulDiv(tick, this.track.timescale, TICKS_PER_SECOND, 'floor'));
  }

  /** Presentation index of the key frame at or before the frame shown at `tick` (cheap to decode alone). */
  keyIndexAt(tick: Tick): number {
    const decodeIndex = this.track.order[this.indexAt(tick)] as number;
    return this.presOf[keyBefore(this.track, decodeIndex)] as number;
  }

  /** Source time at which frame `index` starts. */
  timeOf(index: number): Tick {
    const s = this.track.order[index];
    return mulDiv(this.track.pts[s ?? 0] ?? 0, TICKS_PER_SECOND, this.track.timescale, 'round');
  }

  /** The frame shown at `tick`. The caller owns the returned frame and must close() it. */
  frameAt(tick: Tick): Promise<VideoFrame> {
    return this.frame(this.indexAt(tick));
  }

  /** Frame by presentation index. The caller owns the returned frame and must close() it. */
  frame(index: number): Promise<VideoFrame> {
    const i = Math.max(0, Math.min(this.frameCount - 1, index));
    const hit = this.touch(i);
    if (hit) return Promise.resolve(hit.clone());
    const job = this.queue.then(async () => {
      if (this.closed) throw new MediaError('missing', 'The video was closed.');
      const again = this.touch(i);
      if (again) return again.clone();
      await this.decodeTo(i);
      const f = this.touch(i);
      if (!f) throw new MediaError('corrupt', 'A video frame could not be decoded. The file may be damaged.');
      return f.clone();
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  private touch(i: number): VideoFrame | undefined {
    const f = this.cache.get(i);
    if (f) {
      this.cache.delete(i);
      this.cache.set(i, f);
    }
    return f;
  }

  private store(i: number, frame: VideoFrame): void {
    if (this.cache.has(i) || this.closed) {
      frame.close();
      return;
    }
    this.cache.set(i, frame);
    for (const [k, old] of this.cache) {
      if (this.cache.size <= this.maxFrames) break;
      if (k === this.waiter?.index) continue;
      old.close();
      this.cache.delete(k);
    }
    if (this.waiter?.index === i) {
      this.waiter.resolve();
      this.waiter = null;
    }
  }

  /** Copy a decoder-owned frame into plain memory so holding it cannot starve the decoder's buffer pool. */
  private async adopt(frame: VideoFrame): Promise<void> {
    const index = frame.timestamp;
    this.lastOut = Math.max(this.lastOut, index);
    if (index < this.keepFrom) return frame.close();
    try {
      if (frame.format === null) return this.store(index, frame);
      const buf = new Uint8Array(frame.allocationSize());
      await frame.copyTo(buf);
      const rect = frame.visibleRect;
      const copy = new VideoFrame(buf, {
        format: frame.format, codedWidth: rect?.width ?? frame.codedWidth, codedHeight: rect?.height ?? frame.codedHeight,
        timestamp: index, colorSpace: frame.colorSpace,
      });
      frame.close();
      this.store(index, copy);
    } catch {
      this.store(index, frame);
    }
  }

  private fail(error: Error): void {
    this.fedUntil = -1;
    try {
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    } catch {
      // already closed
    }
    this.decoder = null;
    this.waiter?.reject(error);
    this.waiter = null;
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder;
    const pending = new Set<Promise<void>>();
    const d = new VideoDecoder({
      output: (frame) => {
        const p = this.adopt(frame).finally(() => pending.delete(p));
        pending.add(p);
      },
      error: () => this.fail(new MediaError('corrupt', 'A video frame could not be decoded. The file may be damaged.')),
    });
    d.configure(this.config);
    this.decoder = d;
    this.fedUntil = -1;
    return d;
  }

  private async feed(decoder: VideoDecoder, from: number, to: number): Promise<void> {
    // One read for the whole run when the samples sit close together in the file.
    const { offsets, sizes } = this.track;
    const start = offsets[from] ?? 0;
    const span = to >= from ? (offsets[to] ?? 0) + (sizes[to] ?? 0) - start : 0;
    let wanted = 0;
    for (let s = from; s <= to; s++) wanted += sizes[s] ?? 0;
    const block = to > from && span > 0 && span <= MAX_BLOCK && span <= wanted * 2 ? await this.file.source.read(start, span) : null;
    for (let s = from; s <= to; s++) {
      const at = (offsets[s] as number) - start;
      const data = block && block.length === span ? block.subarray(at, at + (sizes[s] as number)) : await this.file.readSample(this.track, s);
      if (decoder.state !== 'configured') return;
      decoder.decode(new EncodedVideoChunk({ type: this.track.keys[s] ? 'key' : 'delta', timestamp: this.presOf[s] as number, data }));
      this.fedUntil = s;
    }
  }

  private async decodeTo(index: number): Promise<void> {
    const target = this.track.order[index] as number;
    let decoder = this.ensureDecoder();
    const key = keyBefore(this.track, target);
    // Already fed but not out yet: the decoder is still holding it, so feed on rather than restart.
    const held = this.fedUntil >= target && index > this.lastOut;
    const canRoll = held || (this.fedUntil >= key - 1 && this.fedUntil >= 0 && this.fedUntil < target);
    if (canRoll) this.keepFrom = 0;
    else {
      // Jump: restart at the key frame. reset() drops queued work; outputs already produced stay cached.
      decoder.reset();
      decoder.configure(this.config);
      this.fedUntil = -1;
      this.lastOut = -1;
      this.keepFrom = index - KEEP_BEFORE;
      this.seeks++;
    }
    const arrived = new Promise<void>((resolve, reject) => (this.waiter = { index, resolve, reject }));
    arrived.catch(() => undefined);
    try {
      const from = this.fedUntil < 0 ? key : this.fedUntil + 1;
      const to = Math.min(this.frameCount - 1, Math.max(target, this.fedUntil) + (this.reordered ? LOOKAHEAD : 0));
      await this.feed(decoder, from, to);
      decoder = this.decoder ?? decoder;
      // Wait for the frame; if the decoder goes idle without producing it, flush to force it out.
      const idle = new Promise<'idle'>((resolve) => {
        const check = (): void => {
          if (decoder.state !== 'configured' || decoder.decodeQueueSize === 0) setTimeout(() => resolve('idle'), 25);
          else decoder.addEventListener('dequeue', check, { once: true });
        };
        check();
      });
      const first = await Promise.race([arrived.then(() => 'frame' as const), idle]);
      if (first === 'idle' && !this.cache.has(index) && decoder.state === 'configured') {
        await decoder.flush();
        this.lastOut = -1;
        this.fedUntil = -1; // after a flush the next chunk must be a key frame
        await Promise.race([arrived, new Promise((r) => setTimeout(r, 500))]);
      } else await arrived;
    } finally {
      this.waiter = null;
    }
  }

  /** Close the decoder and release every cached frame. */
  close(): void {
    this.closed = true;
    this.fail(new MediaError('missing', 'The video was closed.'));
    for (const f of this.cache.values()) f.close();
    this.cache.clear();
  }
}
