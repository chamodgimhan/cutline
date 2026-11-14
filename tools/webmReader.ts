// Minimal WebM reader for tests: parses a whole file in memory into tracks and blocks.
import { colorFromCodes, type ColorInfo } from '../src/media/color.ts';

export interface WebmTrack {
  number: number;
  type: 'video' | 'audio';
  codecId: string;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  codecPrivate: Uint8Array | null;
  color: ColorInfo | null;
}
export interface WebmBlock {
  track: number;
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}
export interface WebmFile {
  docType: string;
  durationMs: number;
  tracks: WebmTrack[];
  blocks: WebmBlock[];
}

const CONTAINERS = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0, 0xe1, 0x1f43b675, 0x1a45dfa3, 0x55b0]);

export function parseWebm(data: Uint8Array): WebmFile {
  const out: WebmFile = { docType: '', durationMs: 0, tracks: [], blocks: [] };
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dec = new TextDecoder();
  let scale = 1_000_000;
  let cluster = 0;
  let track: WebmTrack | null = null;
  let colour = [1, 1, 1, 1]; // primaries, transfer, matrix, range
  const vint = (p: number, keepMarker: boolean): [number, number] => {
    const first = data[p] as number;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & (0xff >> len);
    let unknown = !keepMarker && v === 0xff >> len;
    for (let i = 1; i < len; i++) {
      const b = data[p + i] as number;
      if (b !== 0xff) unknown = false;
      v = v * 256 + b;
    }
    return [unknown ? -1 : v, len];
  };
  const num = (p: number, n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + (data[p + i] as number);
    return v;
  };
  const walk = (start: number, end: number): void => {
    let p = start;
    while (p < end) {
      const [id, idLen] = vint(p, true);
      const [size, sizeLen] = vint(p + idLen, false);
      const body = p + idLen + sizeLen;
      const stop = size < 0 ? end : body + size;
      if (stop > data.length) throw new Error('WebM element runs past the end of the file');
      if (id === 0xae) {
        track = { number: 0, type: 'video', codecId: '', width: 0, height: 0, sampleRate: 0, channels: 0, codecPrivate: null, color: null };
        colour = [1, 1, 1, 1];
        out.tracks.push(track);
      }
      if (CONTAINERS.has(id)) walk(body, stop);
      else if (id === 0x4282) out.docType = dec.decode(data.subarray(body, stop));
      else if (id === 0x2ad7b1) scale = num(body, size);
      else if (id === 0x4489) out.durationMs = (size === 8 ? view.getFloat64(body) : view.getFloat32(body)) * (scale / 1e6);
      else if (id === 0xe7) cluster = num(body, size);
      else if (id === 0xa3) {
        const [n, nLen] = vint(body, false);
        out.blocks.push({ track: n, timeMs: (cluster + view.getInt16(body + nLen)) * (scale / 1e6), key: ((data[body + nLen + 2] as number) & 0x80) !== 0, data: data.subarray(body + nLen + 3, stop) });
      } else if (track) {
        if (id === 0xd7) track.number = num(body, size);
        else if (id === 0x83) track.type = num(body, size) === 2 ? 'audio' : 'video';
        else if (id === 0x86) track.codecId = dec.decode(data.subarray(body, stop));
        else if (id === 0xb0) track.width = num(body, size);
        else if (id === 0xba) track.height = num(body, size);
        else if (id === 0x9f) track.channels = num(body, size);
        else if (id === 0xb5) track.sampleRate = size === 8 ? view.getFloat64(body) : view.getFloat32(body);
        else if (id === 0x63a2) track.codecPrivate = data.subarray(body, stop);
        else if (id === 0x55b1 || id === 0x55b9 || id === 0x55ba || id === 0x55bb) {
          colour[[0x55bb, 0x55ba, 0x55b1, 0x55b9].indexOf(id)] = num(body, size);
          track.color = colorFromCodes(colour[0] as number, colour[1] as number, colour[2] as number, colour[3] === 2);
        }
      }
      p = stop;
    }
  };
  walk(0, data.length);
  return out;
}
