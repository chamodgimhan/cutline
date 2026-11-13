// Byte and bit level writers/readers shared by muxers, demuxers and fixture encoders.

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private need(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.need(1);
    this.buf[this.length++] = v & 255;
    return this;
  }
  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
    return this;
  }
  u24(v: number): this {
    return this.u8(v >>> 16).u16(v & 0xffff);
  }
  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
    return this;
  }
  i32(v: number): this {
    this.need(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
    return this;
  }
  u64(v: number): this {
    return this.u32(Math.floor(v / 4294967296)).u32(v % 4294967296);
  }
  /** 16.16 fixed point. */
  fixed16(v: number): this {
    return this.i32(Math.round(v * 65536));
  }
  ascii(s: string): this {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  zeros(n: number): this {
    this.need(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.need(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** MSB-first bit writer with Exp-Golomb helpers (H.264 syntax). */
export class BitWriter {
  private out = new ByteWriter(1024);
  private cur = 0;
  private nbits = 0;

  bit(b: number): this {
    this.cur = (this.cur << 1) | (b & 1);
    if (++this.nbits === 8) {
      this.out.u8(this.cur);
      this.cur = 0;
      this.nbits = 0;
    }
    return this;
  }
  bits(v: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bit(Math.floor(v / 2 ** i) & 1);
    return this;
  }
  ue(v: number): this {
    const x = v + 1;
    const len = 32 - Math.clz32(x);
    this.bits(0, len - 1);
    return this.bits(x, len);
  }
  se(v: number): this {
    return this.ue(v <= 0 ? -2 * v : 2 * v - 1);
  }
  get aligned(): boolean {
    return this.nbits === 0;
  }
  alignZero(): this {
    while (this.nbits !== 0) this.bit(0);
    return this;
  }
  /** Only valid when byte aligned. */
  bytes(b: Uint8Array): this {
    if (this.nbits !== 0) throw new Error('BitWriter.bytes: not aligned');
    this.out.bytes(b);
    return this;
  }
  /** RBSP trailing bits: a stop bit then zero padding. */
  trailing(): this {
    this.bit(1);
    return this.alignZero();
  }
  finish(): Uint8Array {
    this.alignZero();
    return this.out.finish();
  }
}

export class BitReader {
  private pos = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) throw new Error('BitReader: out of data');
    const b = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return b;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 32) throw new Error('BitReader: bad Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : 0 - k / 2;
  }
  skip(n: number): void {
    this.pos += n;
  }
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Fast non-cryptographic 64-bit content hash as 16 hex chars (two FNV-1a 32 lanes). */
export function hashBytes(data: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const v = data[i] as number;
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x85ebca6b) + 0x9e3779b9;
    b = (b << 13) | (b >>> 19);
  }
  const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
  return hex(a) + hex(b);
}
