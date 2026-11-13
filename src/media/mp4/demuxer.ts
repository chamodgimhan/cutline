// MP4/MOV demuxer. Reads only the index (moov) up front; sample data is read by range on demand.
import { MediaError, type ByteSource } from '../source.ts';
import { child, children, fourcc, i32, matrixRotation, parseSampleEntry, path, u32, u64, type SampleEntry } from './parse.ts';

/** Fixed-size, fixed-duration samples (PCM): kept per chunk, never expanded per sample. */
export interface UniformSamples {
  sampleSize: number;
  chunkOffsets: Float64Array;
  /** First sample index of each chunk, plus a final entry equal to the sample count. */
  chunkFirst: Float64Array;
}

export interface Mp4Track {
  id: number;
  kind: 'video' | 'audio';
  entry: SampleEntry;
  timescale: number;
  /** Stored (unrotated) size. */
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  sampleCount: number;
  /** Subtract from composition times to get presentation time (edit list), in track units. */
  ptsOffset: number;
  /** Presentation duration in track units. */
  duration: number;
  uniform: UniformSamples | null;
  // Per-sample tables in decode order (empty when `uniform` is set).
  offsets: Float64Array;
  sizes: Uint32Array;
  /** Presentation time of each sample in track units, edit list applied. */
  pts: Float64Array;
  durations: Uint32Array;
  keys: Uint8Array;
  /** Sample indices sorted by presentation time. */
  order: Uint32Array;
}

const MAX_MOOV = 512 * 1024 * 1024;
const MAX_SAMPLES = 40_000_000;
const DAMAGED = 'This file is damaged or incomplete: its index could not be read.';

const isType = (t: string): boolean => /^[\x20-\x7e]{4}$/.test(t);

async function findMoov(src: ByteSource): Promise<Uint8Array> {
  let pos = 0;
  let sawFtyp = false;
  for (let guard = 0; guard < 10_000 && pos + 8 <= src.size; guard++) {
    const head = await src.read(pos, 16);
    if (head.length < 8) break;
    let size = u32(head, 0);
    const type = fourcc(head, 4);
    if (size === 1 && head.length >= 16) size = u64(head, 8);
    else if (size === 0) size = src.size - pos;
    if (!isType(type) || size < 8) break;
    if (type === 'ftyp' || type === 'moov' || type === 'mdat' || type === 'free' || type === 'wide') sawFtyp = true;
    if (type === 'moov') {
      if (size > MAX_MOOV || pos + size > src.size) throw new MediaError('corrupt', DAMAGED);
      const all = await src.read(pos, size);
      return all.subarray(u32(head, 0) === 1 ? 16 : 8);
    }
    pos += size;
  }
  if (!sawFtyp) throw new MediaError('unsupported', 'This file is not a video or audio file Cutline can open.');
  throw new MediaError('corrupt', DAMAGED);
}

function parseTrack(trak: Uint8Array, movieTimescale: number): Mp4Track | null {
  const tkhd = child(trak, 'tkhd');
  const mdia = child(trak, 'mdia');
  const mdhd = mdia && child(mdia, 'mdhd');
  const hdlr = mdia && child(mdia, 'hdlr');
  const stbl = mdia && path(mdia, 'minf', 'stbl');
  if (!tkhd || !mdhd || !hdlr || !stbl) return null;
  const handler = fourcc(hdlr, 8);
  if (handler !== 'vide' && handler !== 'soun') return null;
  const v1 = tkhd[0] === 1;
  const id = u32(tkhd, v1 ? 20 : 12);
  const matrixAt = v1 ? 52 : 40;
  const timescale = u32(mdhd, mdhd[0] === 1 ? 20 : 12);
  const stsd = child(stbl, 'stsd');
  const stts = child(stbl, 'stts');
  const stsc = child(stbl, 'stsc');
  const stsz = child(stbl, 'stsz');
  const stco = child(stbl, 'stco');
  const co64 = child(stbl, 'co64');
  if (!stsd || !stts || !stsc || !stsz || !(stco || co64) || timescale === 0) throw new MediaError('corrupt', DAMAGED);
  const entry = parseSampleEntry(stsd, handler);

  const chunkCount = u32((stco ?? co64) as Uint8Array, 4);
  const chunkOffsets = new Float64Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) chunkOffsets[i] = stco ? u32(stco, 8 + i * 4) : u64(co64 as Uint8Array, 8 + i * 8);
  const fixedSize = u32(stsz, 4);
  const sampleCount = u32(stsz, 8);
  if (sampleCount > MAX_SAMPLES && fixedSize === 0) throw new MediaError('unsupported', 'This file is too long to open.');

  // Samples per chunk, expanded from the run-length stsc table.
  const perChunk = new Uint32Array(chunkCount);
  const runs = u32(stsc, 4);
  for (let r = 0; r < runs; r++) {
    const first = u32(stsc, 8 + r * 12) - 1;
    const next = r + 1 < runs ? u32(stsc, 8 + (r + 1) * 12) - 1 : chunkCount;
    const n = u32(stsc, 12 + r * 12);
    for (let c = Math.max(0, first); c < Math.min(next, chunkCount); c++) perChunk[c] = n;
  }

  // Edit list: one leading empty edit (delay) and/or a media start offset.
  let ptsOffset = 0;
  const elst = path(trak, 'edts', 'elst');
  if (elst) {
    const ev1 = elst[0] === 1;
    const n = u32(elst, 4);
    let delay = 0;
    for (let i = 0, p = 8; i < n; i++, p += ev1 ? 20 : 12) {
      const dur = ev1 ? u64(elst, p) : u32(elst, p);
      const mediaTime = ev1 ? (u32(elst, p + 8) === 0xffffffff ? -1 : u64(elst, p + 8)) : i32(elst, p + 4);
      if (mediaTime < 0) delay += Math.round((dur * timescale) / movieTimescale);
      else {
        ptsOffset = mediaTime - delay;
        break;
      }
    }
  }

  const base = {
    id, kind: handler === 'vide' ? ('video' as const) : ('audio' as const), entry, timescale,
    width: entry.width || i32(tkhd, matrixAt + 36) >> 16, height: entry.height || i32(tkhd, matrixAt + 40) >> 16,
    rotation: matrixRotation(tkhd, matrixAt), sampleCount, ptsOffset,
  };
  const sttsRuns = u32(stts, 4);
  const empty = { offsets: new Float64Array(0), sizes: new Uint32Array(0), pts: new Float64Array(0), durations: new Uint32Array(0), keys: new Uint8Array(0), order: new Uint32Array(0) };

  if (fixedSize > 0 && sttsRuns <= 1 && base.kind === 'audio') {
    const chunkFirst = new Float64Array(chunkCount + 1);
    for (let c = 0; c < chunkCount; c++) chunkFirst[c + 1] = (chunkFirst[c] as number) + (perChunk[c] as number);
    const delta = sttsRuns ? u32(stts, 12) : 1;
    // Sample-table units: one PCM frame per sample; the entry may count bytes per channel instead (QuickTime).
    return { ...base, ...empty, duration: sampleCount * delta - ptsOffset, uniform: { sampleSize: fixedSize, chunkOffsets, chunkFirst } };
  }

  const offsets = new Float64Array(sampleCount);
  const sizes = new Uint32Array(sampleCount);
  let s = 0;
  for (let c = 0; c < chunkCount && s < sampleCount; c++) {
    let off = chunkOffsets[c] as number;
    for (let k = perChunk[c] as number; k > 0 && s < sampleCount; k--, s++) {
      const size = fixedSize || u32(stsz, 12 + s * 4);
      offsets[s] = off;
      sizes[s] = size;
      off += size;
    }
  }
  const pts = new Float64Array(sampleCount);
  const durations = new Uint32Array(sampleCount);
  let t = 0;
  s = 0;
  for (let r = 0; r < sttsRuns && s < sampleCount; r++) {
    const delta = u32(stts, 12 + r * 8);
    for (let k = u32(stts, 8 + r * 8); k > 0 && s < sampleCount; k--, s++) {
      pts[s] = t - ptsOffset;
      durations[s] = delta;
      t += delta;
    }
  }
  const ctts = child(stbl, 'ctts');
  if (ctts) {
    s = 0;
    for (let r = 0, n = u32(ctts, 4); r < n && s < sampleCount; r++) {
      const off = i32(ctts, 12 + r * 8);
      for (let k = u32(ctts, 8 + r * 8); k > 0 && s < sampleCount; k--, s++) pts[s] = (pts[s] as number) + off;
    }
  }
  const stss = child(stbl, 'stss');
  const keys = new Uint8Array(sampleCount).fill(stss ? 0 : 1);
  if (stss) for (let i = 0, n = u32(stss, 4); i < n; i++) keys[u32(stss, 8 + i * 4) - 1] = 1;
  const order = new Uint32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) order[i] = i;
  if (ctts) order.sort((a, b) => (pts[a] as number) - (pts[b] as number));
  let end = 0;
  for (let i = 0; i < sampleCount; i++) end = Math.max(end, (pts[i] as number) + (durations[i] as number));
  return { ...base, uniform: null, offsets, sizes, pts, durations, keys, order, duration: end };
}

export class Mp4File {
  readonly source: ByteSource;
  readonly tracks: Mp4Track[];

  private constructor(source: ByteSource, tracks: Mp4Track[]) {
    this.source = source;
    this.tracks = tracks;
  }

  /** Open a file: locate and parse the index. Reads a few headers plus the moov box, nothing else. */
  static async open(source: ByteSource): Promise<Mp4File> {
    const moov = await findMoov(source);
    let tracks: Mp4Track[];
    try {
      const mvhd = child(moov, 'mvhd');
      const movieTimescale = mvhd ? u32(mvhd, mvhd[0] === 1 ? 20 : 12) : 1000;
      tracks = children(moov).filter((b) => b.type === 'trak').map((b) => parseTrack(b.body, movieTimescale || 1000)).filter((t): t is Mp4Track => t !== null);
    } catch (e) {
      if (e instanceof MediaError) throw e;
      throw new MediaError('corrupt', DAMAGED);
    }
    if (tracks.length === 0) throw new MediaError('unsupported', 'This file has no video or audio tracks.');
    return new Mp4File(source, tracks);
  }

  get video(): Mp4Track | undefined {
    return this.tracks.find((t) => t.kind === 'video' && t.sampleCount > 0);
  }
  get audio(): Mp4Track | undefined {
    return this.tracks.find((t) => t.kind === 'audio' && t.sampleCount > 0);
  }

  /** Bytes of one sample (decode-order index) of a per-sample track. */
  async readSample(track: Mp4Track, index: number): Promise<Uint8Array> {
    const size = track.sizes[index];
    const offset = track.offsets[index];
    if (size === undefined || offset === undefined) throw new MediaError('corrupt', 'This file is damaged: a frame is missing.');
    const data = await this.source.read(offset, size);
    if (data.length !== size) throw new MediaError('corrupt', 'This file is damaged or incomplete: part of its content is missing.');
    return data;
  }

  /** Raw bytes for `count` fixed-size samples starting at `first` (PCM tracks). */
  async readUniform(track: Mp4Track, first: number, count: number): Promise<Uint8Array> {
    const u = track.uniform;
    if (!u) throw new Error('readUniform: not a uniform track');
    const n = Math.max(0, Math.min(count, track.sampleCount - first));
    const out = new Uint8Array(n * u.sampleSize);
    let done = 0;
    // Binary search the chunk containing `first`.
    let lo = 0;
    let hi = u.chunkOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((u.chunkFirst[mid] as number) <= first) lo = mid;
      else hi = mid - 1;
    }
    for (let c = lo; done < n && c < u.chunkOffsets.length; c++) {
      const start = first + done;
      const inChunk = start - (u.chunkFirst[c] as number);
      const take = Math.min(n - done, (u.chunkFirst[c + 1] as number) - start);
      if (take <= 0) continue;
      const bytes = await this.source.read((u.chunkOffsets[c] as number) + inChunk * u.sampleSize, take * u.sampleSize);
      if (bytes.length !== take * u.sampleSize) throw new MediaError('corrupt', 'This file is damaged or incomplete: part of its audio is missing.');
      out.set(bytes, done * u.sampleSize);
      done += take;
    }
    return out;
  }
}

/** Position in presentation order of the sample shown at `time` (track units): greatest pts <= time, clamped. */
export function sampleAtTime(track: Mp4Track, time: number): number {
  let lo = 0;
  let hi = track.order.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((track.pts[track.order[mid] as number] as number) <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Decode-order index of the key frame to start decoding from to reach decode-order sample `index`. */
export function keyBefore(track: Mp4Track, index: number): number {
  let i = index;
  while (i > 0 && !track.keys[i]) i--;
  return i;
}
