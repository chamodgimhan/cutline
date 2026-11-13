// ISO BMFF box builders. Pure functions returning bytes.
import { ByteWriter, concatBytes } from '../bytes.ts';

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload);
  const w = new ByteWriter(8 + body.length);
  w.u32(8 + body.length).ascii(type).bytes(body);
  return w.finish();
}

export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  const head = new ByteWriter(4).u8(version).u24(flags).finish();
  return box(type, head, ...payload);
}

const bw = (): ByteWriter => new ByteWriter(64);

export function ftyp(): Uint8Array {
  return box('ftyp', bw().ascii('isom').u32(0x200).ascii('isomiso2avc1mp41').finish());
}

export type Rotation = 0 | 90 | 180 | 270;

/** tkhd display matrix for a clockwise rotation of stored pixels. */
export function rotationMatrix(rot: Rotation, width: number, height: number): Uint8Array {
  const m: Record<Rotation, [number, number, number, number, number, number]> = {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, height, 0],
    180: [-1, 0, 0, -1, width, height],
    270: [0, -1, 1, 0, 0, width],
  };
  const [a, b, c, d, tx, ty] = m[rot];
  return bw().fixed16(a).fixed16(b).u32(0).fixed16(c).fixed16(d).u32(0).fixed16(tx).fixed16(ty).u32(0x40000000).finish();
}

export function mvhd(timescale: number, duration: number, nextTrackId: number): Uint8Array {
  const w = bw();
  w.u64(0).u64(0).u32(timescale).u64(duration);
  w.fixed16(1).u16(0x0100).zeros(10).bytes(rotationMatrix(0, 0, 0)).zeros(24).u32(nextTrackId);
  return fullBox('mvhd', 1, 0, w.finish());
}

export function tkhd(id: number, duration: number, width: number, height: number, rot: Rotation, audio: boolean): Uint8Array {
  const w = bw();
  w.u64(0).u64(0).u32(id).u32(0).u64(duration).zeros(8);
  w.u16(0).u16(0).u16(audio ? 0x0100 : 0).u16(0);
  w.bytes(rotationMatrix(rot, width, height)).fixed16(width).fixed16(height);
  return fullBox('tkhd', 1, 3, w.finish());
}

export function mdhd(timescale: number, duration: number): Uint8Array {
  return fullBox('mdhd', 1, 0, bw().u64(0).u64(0).u32(timescale).u64(duration).u16(0x55c4).u16(0).finish());
}

export function hdlr(audio: boolean): Uint8Array {
  const name = audio ? 'SoundHandler' : 'VideoHandler';
  return fullBox('hdlr', 0, 0, bw().u32(0).ascii(audio ? 'soun' : 'vide').zeros(12).ascii(name).u8(0).finish());
}

export function mediaHeader(audio: boolean): Uint8Array {
  return audio ? fullBox('smhd', 0, 0, bw().u32(0).finish()) : fullBox('vmhd', 0, 1, bw().zeros(8).finish());
}

export function dinf(): Uint8Array {
  return box('dinf', fullBox('dref', 0, 0, bw().u32(1).finish(), fullBox('url ', 0, 1)));
}

export function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const w = bw();
  w.u8(1).u8(sps[1] ?? 66).u8(sps[2] ?? 0).u8(sps[3] ?? 30).u8(0xff);
  w.u8(0xe1).u16(sps.length).bytes(sps).u8(1).u16(pps.length).bytes(pps);
  return box('avcC', w.finish());
}

/** Visual sample entry (avc1, vp09 ...) wrapping a codec configuration box. */
export function visualEntry(type: string, width: number, height: number, config: Uint8Array): Uint8Array {
  const w = bw();
  w.zeros(6).u16(1).zeros(16).u16(width).u16(height).u32(0x00480000).u32(0x00480000).u32(0).u16(1);
  w.zeros(32).u16(0x0018).u16(0xffff).bytes(config);
  return box(type, w.finish());
}

function audioEntry(type: string, channels: number, sampleRate: number, bits: number, config: Uint8Array): Uint8Array {
  const w = bw();
  w.zeros(6).u16(1).zeros(8).u16(channels).u16(bits).u32(0).u16(Math.min(sampleRate, 65535)).u16(0).bytes(config);
  return box(type, w.finish());
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  // 4-byte expandable length form, the most widely accepted.
  const n = body.length;
  return bw().u8(tag).u8(0x80 | (n >> 21)).u8(0x80 | ((n >> 14) & 127)).u8(0x80 | ((n >> 7) & 127)).u8(n & 127).bytes(body).finish();
}

/** mp4a entry for AAC with the given AudioSpecificConfig. */
export function mp4aEntry(channels: number, sampleRate: number, asc: Uint8Array, bitrate = 0): Uint8Array {
  const dsi = descriptor(5, asc);
  const dcd = descriptor(4, bw().u8(0x40).u8(0x15).u24(0).u32(bitrate).u32(bitrate).bytes(dsi).finish());
  const es = descriptor(3, bw().u16(0).u8(0).bytes(dcd).bytes(descriptor(6, new Uint8Array([2]))).finish());
  return audioEntry('mp4a', channels, sampleRate, 16, fullBox('esds', 0, 0, es));
}

/** Uncompressed little-endian integer PCM (ISO/IEC 23003-5). */
export function ipcmEntry(channels: number, sampleRate: number, bits: number): Uint8Array {
  return audioEntry('ipcm', channels, sampleRate, bits, fullBox('pcmC', 0, 0, new Uint8Array([1, bits])));
}

export function u32Table(type: string, version: number, rows: readonly (readonly number[])[], prefix: number[] = []): Uint8Array {
  const w = new ByteWriter(8 + rows.length * 8);
  for (const p of prefix) w.u32(p);
  w.u32(rows.length);
  for (const r of rows) for (const v of r) w.i32(v | 0);
  return fullBox(type, version, 0, w.finish());
}
