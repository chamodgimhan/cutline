// Waveform peaks: min/max per time bucket, built incrementally, stored as bytes.

export const PEAKS_PER_SECOND = 100;

export interface Peaks {
  /** Buckets per second. */
  rate: number;
  /** Per bucket, -127..127 (scaled from -1..1), all channels combined. */
  min: Int8Array;
  max: Int8Array;
}

export class PeakBuilder {
  private readonly bucket: number;
  private readonly min: number[] = [];
  private readonly max: number[] = [];
  private lo = 0;
  private hi = 0;
  private filled = 0;

  constructor(sampleRate: number, rate = PEAKS_PER_SECOND) {
    this.bucket = Math.max(1, Math.round(sampleRate / rate));
    this.rate = sampleRate / this.bucket;
  }
  readonly rate: number;

  /** Add the next block of audio (one array per channel, equal lengths). */
  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      for (const ch of channels) {
        const v = ch[i] as number;
        if (v < this.lo) this.lo = v;
        if (v > this.hi) this.hi = v;
      }
      if (++this.filled === this.bucket) this.flush();
    }
  }

  private flush(): void {
    const q = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));
    this.min.push(q(this.lo));
    this.max.push(q(this.hi));
    this.lo = 0;
    this.hi = 0;
    this.filled = 0;
  }

  finish(): Peaks {
    if (this.filled > 0) this.flush();
    return { rate: this.rate, min: Int8Array.from(this.min), max: Int8Array.from(this.max) };
  }
}

/** Largest absolute peak over buckets [from, to), as 0..1. Used to draw one pixel column. */
export function peakRange(p: Peaks, from: number, to: number): { min: number; max: number } {
  let lo = 0;
  let hi = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(p.min.length, Math.max(a + 1, Math.ceil(to)));
  for (let i = a; i < b; i++) {
    if ((p.min[i] as number) < lo) lo = p.min[i] as number;
    if ((p.max[i] as number) > hi) hi = p.max[i] as number;
  }
  return { min: lo / 127, max: hi / 127 };
}

export function encodePeaks(p: Peaks): Uint8Array {
  const n = p.min.length;
  const out = new Uint8Array(12 + n * 2);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x43504b31); // 'CPK1'
  v.setFloat32(4, p.rate);
  v.setUint32(8, n);
  out.set(new Uint8Array(p.min.buffer, p.min.byteOffset, n), 12);
  out.set(new Uint8Array(p.max.buffer, p.max.byteOffset, n), 12 + n);
  return out;
}

export function decodePeaks(bytes: Uint8Array): Peaks | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(8);
  if (v.getUint32(0) !== 0x43504b31 || bytes.length !== 12 + n * 2) return null;
  return { rate: v.getFloat32(4), min: new Int8Array(bytes.slice(12, 12 + n).buffer), max: new Int8Array(bytes.slice(12 + n).buffer) };
}

/** Byte-bounded least-recently-used cache. Phase 9 adds a persistent store behind the same shape. */
export class ByteCache {
  private readonly items = new Map<string, Uint8Array>();
  private used = 0;
  readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  get bytes(): number {
    return this.used;
  }
  get(key: string): Uint8Array | undefined {
    const v = this.items.get(key);
    if (v) {
      this.items.delete(key);
      this.items.set(key, v);
    }
    return v;
  }
  set(key: string, value: Uint8Array): void {
    const old = this.items.get(key);
    if (old) {
      this.used -= old.length;
      this.items.delete(key);
    }
    if (value.length > this.limit) return;
    this.items.set(key, value);
    this.used += value.length;
    for (const [k, v] of this.items) {
      if (this.used <= this.limit) break;
      this.items.delete(k);
      this.used -= v.length;
    }
  }
}
