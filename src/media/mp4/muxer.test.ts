import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter, ByteWriter, concatBytes, hashBytes } from '../bytes.ts';
import { ipcmEntry, rotationMatrix } from './boxes.ts';
import { MemorySink, Mp4Muxer } from './muxer.ts';

interface Box { type: string; start: number; size: number; body: Uint8Array }

function parse(data: Uint8Array): Box[] {
  const out: Box[] = [];
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let p = 0; p + 8 <= data.length; ) {
    let size = v.getUint32(p);
    let head = 8;
    if (size === 1) {
      size = v.getUint32(p + 8) * 4294967296 + v.getUint32(p + 12);
      head = 16;
    }
    const type = String.fromCharCode(...data.subarray(p + 4, p + 8));
    out.push({ type, start: p, size, body: data.subarray(p + head, p + size) });
    p += size;
  }
  return out;
}
const find = (data: Uint8Array, ...path: string[]): Uint8Array => {
  let cur = data;
  for (const t of path) {
    const b = parse(cur).find((x) => x.type === t);
    if (!b) throw new Error('missing box ' + t);
    cur = b.body;
  }
  return cur;
};
const u32 = (b: Uint8Array, o: number): number => new DataView(b.buffer, b.byteOffset).getUint32(o);

function mux(faststart: boolean): Uint8Array {
  const sink = new MemorySink();
  const m = new Mp4Muxer(sink, { faststart });
  const a = m.addTrack({ kind: 'audio', timescale: 48000, sampleEntry: ipcmEntry(2, 48000, 16), fixedSampleSize: 4 });
  const b = m.addTrack({ kind: 'audio', timescale: 1000, sampleEntry: ipcmEntry(1, 48000, 16) });
  m.addFixed(a, new Uint8Array(40).fill(1));
  m.addSample(b, new Uint8Array([9, 9, 9]), 10, true);
  m.addSample(b, new Uint8Array([8, 8]), 10, false, 5);
  m.addFixed(a, new Uint8Array(8).fill(2));
  m.addSample(b, new Uint8Array([7]), 20, true);
  m.finish();
  return sink.bytes();
}

describe('Mp4Muxer', () => {
  for (const faststart of [false, true]) {
    it(`writes consistent tables (faststart=${faststart})`, () => {
      const file = mux(faststart);
      const top = parse(file);
      expect(top.map((b) => b.type)).toEqual(faststart ? ['ftyp', 'moov', 'mdat'] : ['ftyp', 'mdat', 'moov']);
      expect(top.reduce((n, b) => n + b.size, 0)).toBe(file.length);
      const traks = parse(find(file, 'moov')).filter((b) => b.type === 'trak');
      expect(traks).toHaveLength(2);
      const stbl = (i: number): Uint8Array => find(traks[i]!.body, 'mdia', 'minf', 'stbl');
      // Track B: three samples in two chunks; offsets point at the right bytes.
      const stco = find(stbl(1), 'stco');
      expect(u32(stco, 4)).toBe(2);
      expect(file[u32(stco, 8)]).toBe(9);
      expect(file[u32(stco, 8) + 3]).toBe(8);
      expect(file[u32(stco, 12)]).toBe(7);
      const stsz = find(stbl(1), 'stsz');
      expect([u32(stsz, 4), u32(stsz, 8), u32(stsz, 12), u32(stsz, 16), u32(stsz, 20)]).toEqual([0, 3, 3, 2, 1]);
      const stts = find(stbl(1), 'stts');
      expect([u32(stts, 4), u32(stts, 8), u32(stts, 12), u32(stts, 16), u32(stts, 20)]).toEqual([2, 2, 10, 1, 20]);
      const stss = find(stbl(1), 'stss');
      expect([u32(stss, 4), u32(stss, 8), u32(stss, 12)]).toEqual([2, 1, 3]);
      expect(u32(find(stbl(1), 'ctts'), 4)).toBe(3);
      // Track A: fixed-size samples, 10 then 2 per chunk.
      const stszA = find(stbl(0), 'stsz');
      expect([u32(stszA, 4), u32(stszA, 8)]).toEqual([4, 12]);
      const stcoA = find(stbl(0), 'stco');
      expect(file[u32(stcoA, 8)]).toBe(1);
      expect(file[u32(stcoA, 12)]).toBe(2);
      const stsc = find(stbl(0), 'stsc');
      expect([u32(stsc, 4), u32(stsc, 8), u32(stsc, 12), u32(stsc, 20), u32(stsc, 24)]).toEqual([2, 1, 10, 2, 2]);
      const mdhd = find(traks[1]!.body, 'mdia', 'mdhd');
      expect(u32(mdhd, 20)).toBe(1000);
      expect(u32(mdhd, 28)).toBe(40);
    });
  }

  it('rejects misuse', () => {
    const m = new Mp4Muxer(new MemorySink());
    const t = m.addTrack({ kind: 'audio', timescale: 48000, sampleEntry: ipcmEntry(2, 48000, 16), fixedSampleSize: 4 });
    expect(() => m.addFixed(t, new Uint8Array(3))).toThrow();
    expect(() => m.addSample(9, new Uint8Array(1), 1)).toThrow();
    m.addFixed(t, new Uint8Array(4));
    expect(() => m.addTrack({ kind: 'audio', timescale: 1, sampleEntry: new Uint8Array() })).toThrow();
    m.finish();
    expect(() => m.addFixed(t, new Uint8Array(4))).toThrow();
  });

  it('builds rotation matrices', () => {
    const m = new DataView(rotationMatrix(90, 320, 180).buffer);
    expect([m.getInt32(0), m.getInt32(4), m.getInt32(12), m.getInt32(16), m.getInt32(24)]).toEqual([0, 65536, -65536, 0, 180 * 65536]);
  });
});

describe('bytes', () => {
  it('round-trips Exp-Golomb codes', () => {
    const w = new BitWriter();
    const values = [0, 1, 2, 7, 25, 30, 255, 65535, 172800];
    for (const v of values) w.ue(v);
    for (const v of [0, 1, -1, 5, -300]) w.se(v);
    w.trailing();
    const r = new BitReader(w.finish());
    for (const v of values) expect(r.ue()).toBe(v);
    for (const v of [0, 1, -1, 5, -300]) expect(r.se()).toBe(v);
    expect(r.bit()).toBe(1);
  });

  it('writes big-endian integers and grows', () => {
    const w = new ByteWriter(1);
    w.u8(1).u16(0x0203).u24(0x040506).u32(0x0708090a).u64(0x0102030405).fixed16(1.5).ascii('ab').zeros(2);
    expect([...w.finish()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0, 0, 0, 1, 2, 3, 4, 5, 0, 1, 0x80, 0, 97, 98, 0, 0]);
    expect(concatBytes([new Uint8Array([1]), new Uint8Array([2, 3])])).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('hashes content, not length alone', () => {
    const a = hashBytes(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(hashBytes(new Uint8Array([1, 2, 3])));
    expect(a).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
    expect(hashBytes(new Uint8Array(3))).not.toBe(hashBytes(new Uint8Array(4)));
  });
});
