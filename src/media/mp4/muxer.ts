// MP4 muxer. Streams sample data to a sink and keeps only tables in memory.
// Used by export (H.264 + AAC) and by the fixture generator.
import { ByteWriter } from '../bytes.ts';
import * as B from './boxes.ts';

export interface Mp4Sink {
  /** Append bytes at the end of the output. */
  write(data: Uint8Array): void;
  /** Overwrite bytes at an absolute position already written. */
  patch(position: number, data: Uint8Array): void;
}

export interface Mp4TrackConfig {
  kind: 'video' | 'audio';
  /** Units per second for this track's durations. */
  timescale: number;
  /** Complete sample entry box (avc1, mp4a, ipcm ...). */
  sampleEntry: Uint8Array;
  width?: number;
  height?: number;
  rotation?: B.Rotation;
  /** Set for constant-size samples of duration 1 (PCM): bytes per sample. */
  fixedSampleSize?: number;
}

interface Track {
  cfg: Mp4TrackConfig;
  sizes: number[];
  sampleCount: number;
  stts: [number, number][]; // [count, delta]
  ctts: [number, number][]; // [count, offset]
  anyCts: boolean;
  keys: number[]; // 1-based sample numbers
  allKeys: boolean;
  chunkOffsets: number[];
  chunkSamples: number[];
  duration: number;
}

export interface Mp4MuxerOptions {
  /** Buffer sample data and put moov before mdat. Only for small outputs. */
  faststart?: boolean;
}

const MOVIE_TIMESCALE = 90_000;
const MDAT_HEADER = 16;

function pushRun(runs: [number, number][], value: number, count = 1): void {
  const last = runs[runs.length - 1];
  if (last && last[1] === value) last[0] += count;
  else runs.push([count, value]);
}

export class Mp4Muxer {
  private readonly sink: Mp4Sink;
  private readonly faststart: boolean;
  private readonly tracks: Track[] = [];
  private readonly held: Uint8Array[] = [];
  private mdatStart = 0;
  private dataBytes = 0;
  private lastTrack = -1;
  private started = false;
  private finished = false;

  constructor(sink: Mp4Sink, options: Mp4MuxerOptions = {}) {
    this.sink = sink;
    this.faststart = options.faststart ?? false;
  }

  /** Returns the track index used by addSample / addFixed. */
  addTrack(cfg: Mp4TrackConfig): number {
    if (this.started) throw new Error('Mp4Muxer: addTrack after first sample');
    this.tracks.push({
      cfg, sizes: [], sampleCount: 0, stts: [], ctts: [], anyCts: false, keys: [], allKeys: true,
      chunkOffsets: [], chunkSamples: [], duration: 0,
    });
    return this.tracks.length - 1;
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    if (this.faststart) return;
    const head = B.ftyp();
    this.sink.write(head);
    this.mdatStart = head.length;
    this.sink.write(new ByteWriter(16).u32(1).ascii('mdat').u64(0).finish());
  }

  private put(index: number, data: Uint8Array, samples: number): Track {
    if (this.finished) throw new Error('Mp4Muxer: write after finish');
    const t = this.tracks[index];
    if (!t) throw new Error(`Mp4Muxer: no track ${index}`);
    this.begin();
    if (this.lastTrack !== index) {
      t.chunkOffsets.push(this.dataBytes); // relative to mdat payload, fixed up in finish()
      t.chunkSamples.push(0);
      this.lastTrack = index;
    }
    t.chunkSamples[t.chunkSamples.length - 1] = (t.chunkSamples[t.chunkSamples.length - 1] ?? 0) + samples;
    this.dataBytes += data.length;
    if (this.faststart) this.held.push(data.slice());
    else this.sink.write(data);
    return t;
  }

  /** Add one sample. ctsOffset = presentation time minus decode time, in track units. */
  addSample(index: number, data: Uint8Array, duration: number, key = true, ctsOffset = 0): void {
    const t = this.put(index, data, 1);
    if (t.cfg.fixedSampleSize) throw new Error('Mp4Muxer: use addFixed for fixed-size tracks');
    t.sizes.push(data.length);
    t.sampleCount++;
    pushRun(t.stts, duration);
    pushRun(t.ctts, ctsOffset);
    if (ctsOffset !== 0) t.anyCts = true;
    if (key) t.keys.push(t.sampleCount);
    else t.allKeys = false;
    t.duration += duration;
  }

  /** Add a block of fixed-size samples (PCM frames). */
  addFixed(index: number, data: Uint8Array): void {
    const size = this.tracks[index]?.cfg.fixedSampleSize;
    if (!size || data.length % size !== 0) throw new Error('Mp4Muxer: bad fixed-size block');
    const n = data.length / size;
    const t = this.put(index, data, n);
    t.sampleCount += n;
    pushRun(t.stts, 1, n);
    t.duration += n;
  }

  private trak(t: Track, id: number, base: number): Uint8Array {
    const c = t.cfg;
    const audio = c.kind === 'audio';
    const offsets = t.chunkOffsets.map((o) => o + base);
    const big = offsets.some((o) => o > 0xffffffff);
    const stsc: number[][] = [];
    t.chunkSamples.forEach((n, i) => {
      if (i === 0 || t.chunkSamples[i - 1] !== n) stsc.push([i + 1, n, 1]);
    });
    const stsz = new ByteWriter(12 + t.sizes.length * 4).u32(c.fixedSampleSize ?? 0).u32(t.sampleCount);
    for (const s of t.sizes) stsz.u32(s);
    const co = new ByteWriter(4 + offsets.length * 8).u32(offsets.length);
    for (const o of offsets) if (big) co.u64(o); else co.u32(o);
    const stbl = B.box(
      'stbl',
      B.fullBox('stsd', 0, 0, new ByteWriter(4).u32(1).finish(), c.sampleEntry),
      B.u32Table('stts', 0, t.stts),
      ...(t.allKeys ? [] : [B.u32Table('stss', 0, t.keys.map((k) => [k]))]),
      ...(t.anyCts ? [B.u32Table('ctts', 1, t.ctts)] : []),
      B.u32Table('stsc', 0, stsc),
      B.fullBox('stsz', 0, 0, stsz.finish()),
      B.fullBox(big ? 'co64' : 'stco', 0, 0, co.finish()),
    );
    const movieDur = Math.round((t.duration * MOVIE_TIMESCALE) / c.timescale);
    return B.box(
      'trak',
      B.tkhd(id, movieDur, c.width ?? 0, c.height ?? 0, c.rotation ?? 0, audio),
      B.box('mdia', B.mdhd(c.timescale, t.duration), B.hdlr(audio), B.box('minf', B.mediaHeader(audio), B.dinf(), stbl)),
    );
  }

  private moov(base: number): Uint8Array {
    let dur = 0;
    for (const t of this.tracks) dur = Math.max(dur, Math.round((t.duration * MOVIE_TIMESCALE) / t.cfg.timescale));
    return B.box('moov', B.mvhd(MOVIE_TIMESCALE, dur, this.tracks.length + 1), ...this.tracks.map((t, i) => this.trak(t, i + 1, base)));
  }

  /** Write the index. After this the file is complete. */
  finish(): void {
    if (this.finished) return;
    this.begin();
    this.finished = true;
    if (this.faststart) {
      const head = B.ftyp();
      const probe = this.moov(0);
      const big = head.length + probe.length + 8 + this.dataBytes > 0xffffffff;
      if (big) throw new Error('Mp4Muxer: faststart output too large');
      this.sink.write(head);
      this.sink.write(this.moov(head.length + probe.length + 8));
      this.sink.write(new ByteWriter(8).u32(8 + this.dataBytes).ascii('mdat').finish());
      for (const h of this.held) this.sink.write(h);
      this.held.length = 0;
      return;
    }
    this.sink.patch(this.mdatStart + 8, new ByteWriter(8).u64(MDAT_HEADER + this.dataBytes).finish());
    this.sink.write(this.moov(this.mdatStart + MDAT_HEADER));
  }

  /** Total bytes of sample data accepted so far. */
  get bytesWritten(): number {
    return this.dataBytes;
  }
}

/** In-memory sink for tests and small outputs. */
export class MemorySink implements Mp4Sink {
  private w = new ByteWriter(1 << 16);
  write(data: Uint8Array): void {
    this.w.bytes(data);
  }
  patch(position: number, data: Uint8Array): void {
    this.patches.push([position, data.slice()]);
  }
  private patches: [number, Uint8Array][] = [];
  bytes(): Uint8Array {
    const out = this.w.finish();
    for (const [p, d] of this.patches) out.set(d, p);
    return out;
  }
}
