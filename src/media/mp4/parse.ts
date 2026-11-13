// MP4/MOV box walking and sample-entry parsing: codec strings and decoder configuration.
import { MediaError } from '../source.ts';

export interface BoxRef {
  type: string;
  /** Payload (after the header). */
  body: Uint8Array;
}

const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const u32 = (b: Uint8Array, o: number): number => view(b).getUint32(o);
export const u16 = (b: Uint8Array, o: number): number => view(b).getUint16(o);
export const i32 = (b: Uint8Array, o: number): number => view(b).getInt32(o);
export const u64 = (b: Uint8Array, o: number): number => view(b).getUint32(o) * 4294967296 + view(b).getUint32(o + 4);
export const fourcc = (b: Uint8Array, o: number): string => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/** Child boxes of a container payload. Stops quietly at the first malformed header. */
export function children(data: Uint8Array, start = 0): BoxRef[] {
  const out: BoxRef[] = [];
  let p = start;
  while (p + 8 <= data.length) {
    let size = u32(data, p);
    let head = 8;
    if (size === 1 && p + 16 <= data.length) {
      size = u64(data, p + 8);
      head = 16;
    } else if (size === 0) size = data.length - p;
    if (size < head || p + size > data.length) break;
    out.push({ type: fourcc(data, p + 4), body: data.subarray(p + head, p + size) });
    p += size;
  }
  return out;
}

export const child = (data: Uint8Array, type: string, start = 0): Uint8Array | undefined => children(data, start).find((b) => b.type === type)?.body;

export function path(data: Uint8Array, ...types: string[]): Uint8Array | undefined {
  let cur: Uint8Array | undefined = data;
  for (const t of types) {
    if (!cur) return undefined;
    cur = child(cur, t);
  }
  return cur;
}

export interface PcmFormat {
  bits: 8 | 16 | 24 | 32;
  littleEndian: boolean;
  float: boolean;
}

export interface SampleEntry {
  fourcc: string;
  /** WebCodecs codec string, or 'pcm' for uncompressed audio decoded in-app. */
  codec: string;
  /** Decoder configuration record for WebCodecs `description`, when the codec needs one. */
  description: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  pcm: PcmFormat | null;
}

const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

function hevcCodec(c: Uint8Array): string {
  const b1 = c[1] ?? 0;
  const space = ['', 'A', 'B', 'C'][b1 >> 6] ?? '';
  let compat = u32(c, 2);
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const constraints: string[] = [];
  for (let i = 6; i < 12; i++) constraints.push((c[i] ?? 0).toString(16));
  while (constraints.length && constraints[constraints.length - 1] === '0') constraints.pop();
  return `hvc1.${space}${b1 & 31}.${(rev >>> 0).toString(16)}.${b1 & 0x20 ? 'H' : 'L'}${c[12] ?? 0}${constraints.length ? '.' + constraints.join('.') : ''}`;
}

function descriptors(data: Uint8Array, out: Map<number, Uint8Array>): void {
  let p = 0;
  while (p + 2 <= data.length) {
    const tag = data[p++] as number;
    let len = 0;
    for (let i = 0; i < 4 && p < data.length; i++) {
      const b = data[p++] as number;
      len = (len << 7) | (b & 127);
      if (!(b & 128)) break;
    }
    const body = data.subarray(p, Math.min(data.length, p + len));
    out.set(tag, body);
    if (tag === 3) descriptors(body.subarray(3), out); // ES_Descriptor: id(2) flags(1) then children
    if (tag === 4) descriptors(body.subarray(13), out); // DecoderConfig: 13 fixed bytes then DecoderSpecificInfo
    p += len;
  }
}

function opusHead(dops: Uint8Array): Uint8Array {
  // dOps is big-endian; the Ogg OpusHead that WebCodecs expects is little-endian.
  const out = new Uint8Array(8 + dops.length);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, dops[1] ?? 2]);
  const v = new DataView(out.buffer);
  v.setUint16(10, u16(dops, 2), true);
  v.setUint32(12, u32(dops, 4), true);
  v.setInt16(16, view(dops).getInt16(8), true);
  out.set(dops.subarray(10), 18);
  return out;
}

const PCM_FOURCC: Record<string, PcmFormat> = {
  sowt: { bits: 16, littleEndian: true, float: false },
  twos: { bits: 16, littleEndian: false, float: false },
  in24: { bits: 24, littleEndian: false, float: false },
  in32: { bits: 32, littleEndian: false, float: false },
  fl32: { bits: 32, littleEndian: false, float: true },
};

function parseVideoEntry(type: string, body: Uint8Array): SampleEntry {
  const base = { fourcc: type, width: u16(body, 24), height: u16(body, 26), sampleRate: 0, channels: 0, pcm: null };
  const kids = children(body, 78);
  const cfg = (t: string): Uint8Array | undefined => kids.find((k) => k.type === t)?.body;
  const avcC = cfg('avcC');
  if ((type === 'avc1' || type === 'avc3') && avcC) {
    return { ...base, codec: `avc1.${hex2(avcC[1] ?? 0)}${hex2(avcC[2] ?? 0)}${hex2(avcC[3] ?? 0)}`, description: avcC };
  }
  const hvcC = cfg('hvcC');
  if ((type === 'hvc1' || type === 'hev1') && hvcC) return { ...base, codec: hevcCodec(hvcC), description: hvcC };
  const vpcC = cfg('vpcC');
  if ((type === 'vp09' || type === 'vp08') && vpcC) {
    const codec = type === 'vp08' ? 'vp8' : `vp09.${hex2(vpcC[4] ?? 0)}.${String(vpcC[5] ?? 10).padStart(2, '0')}.${String((vpcC[6] ?? 0x80) >> 4).padStart(2, '0')}`;
    return { ...base, codec, description: null };
  }
  const av1C = cfg('av1C');
  if (type === 'av01' && av1C) {
    const b1 = av1C[1] ?? 0;
    const b2 = av1C[2] ?? 0;
    const depth = b2 & 0x40 ? (b2 & 0x20 ? 12 : 10) : 8;
    return { ...base, codec: `av01.${b1 >> 5}.${String(b1 & 31).padStart(2, '0')}${b2 & 0x80 ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`, description: null };
  }
  return { ...base, codec: `unknown:${type}`, description: null };
}

function parseAudioEntry(type: string, body: Uint8Array): SampleEntry {
  const version = u16(body, 8);
  const childAt = version === 1 ? 44 : version === 2 ? 64 : 28;
  let kids = children(body, childAt);
  const wave = kids.find((k) => k.type === 'wave');
  if (wave) kids = [...kids, ...children(wave.body)];
  const cfg = (t: string): Uint8Array | undefined => kids.find((k) => k.type === t)?.body;
  const base = { fourcc: type, width: 0, height: 0, sampleRate: u16(body, 24), channels: u16(body, 16), pcm: null, description: null };
  const bits = u16(body, 18);
  const esds = cfg('esds');
  if (type === 'mp4a' && esds) {
    const d = new Map<number, Uint8Array>();
    descriptors(esds.subarray(4), d);
    const oti = d.get(4)?.[0] ?? 0x40;
    const asc = d.get(5);
    if (oti === 0x6b || oti === 0x69) return { ...base, codec: 'mp3' };
    if (asc && asc.length >= 2) {
      let aot = (asc[0] as number) >> 3;
      if (aot === 31) aot = 32 + ((((asc[0] as number) & 7) << 3) | ((asc[1] as number) >> 5));
      return { ...base, codec: `mp4a.40.${aot}`, description: asc };
    }
    return { ...base, codec: 'mp4a.40.2' };
  }
  const dops = cfg('dOps');
  if (type === 'Opus' && dops) return { ...base, codec: 'opus', sampleRate: 48000, channels: dops[1] ?? base.channels, description: opusHead(dops) };
  const dfla = cfg('dfLa');
  if (type === 'fLaC' && dfla) {
    const desc = new Uint8Array(dfla.length);
    desc.set([0x66, 0x4c, 0x61, 0x43]);
    desc.set(dfla.subarray(4), 4);
    return { ...base, codec: 'flac', description: desc };
  }
  if (type === '.mp3') return { ...base, codec: 'mp3' };
  const pcmC = cfg('pcmC');
  if ((type === 'ipcm' || type === 'fpcm') && pcmC) {
    const size = pcmC[5] ?? 16;
    if (size !== 8 && size !== 16 && size !== 24 && size !== 32) throw new MediaError('unsupported', `This file uses ${size}-bit PCM audio, which is not supported.`);
    return { ...base, codec: 'pcm', pcm: { bits: size, littleEndian: ((pcmC[4] ?? 0) & 1) === 1, float: type === 'fpcm' } };
  }
  const fixed = PCM_FOURCC[type];
  if (fixed) return { ...base, codec: 'pcm', pcm: fixed };
  if (type === 'lpcm' || type === 'raw ' || type === 'NONE') {
    if (version === 2) throw new MediaError('unsupported', 'This file uses a QuickTime PCM layout that is not supported.');
    return { ...base, codec: 'pcm', pcm: { bits: bits === 8 ? 8 : 16, littleEndian: false, float: false } };
  }
  return { ...base, codec: `unknown:${type}` };
}

/** Parse the first entry of an stsd box payload. */
export function parseSampleEntry(stsd: Uint8Array, handler: string): SampleEntry {
  const entry = children(stsd, 8)[0];
  if (!entry) throw new MediaError('corrupt', 'This file is damaged: a track has no format description.');
  return handler === 'vide' ? parseVideoEntry(entry.type, entry.body) : parseAudioEntry(entry.type, entry.body);
}

/** Clockwise rotation in degrees from a tkhd display matrix (at `o` in the tkhd payload). */
export function matrixRotation(b: Uint8Array, o: number): 0 | 90 | 180 | 270 {
  const [a, bb, c, d] = [i32(b, o), i32(b, o + 4), i32(b, o + 12), i32(b, o + 16)];
  if (a === 0 && d === 0) return bb > 0 && c < 0 ? 90 : bb < 0 && c > 0 ? 270 : 0;
  return a < 0 && d < 0 ? 180 : 0;
}
