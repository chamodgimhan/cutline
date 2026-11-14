// WebM muxer (VP9 or VP8 video, Opus audio). Streams clusters to a sink; only one cluster is held in memory.
import { ByteWriter, concatBytes } from '../bytes.ts';
import { colorCodes, type ColorInfo } from '../color.ts';
import type { Mp4Sink } from '../mp4/muxer.ts';

const enc = new TextEncoder();

/** EBML element: id bytes, size as an 8-byte vint, payload. */
function el(id: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concatBytes(payload);
  const w = new ByteWriter(body.length + 12);
  const idBytes = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  for (let i = idBytes - 1; i >= 0; i--) w.u8((id >>> (8 * i)) & 255);
  w.u8(0x01).u8(0).u8(0).u8(0).u32(body.length); // 8-byte size: room for any element
  return w.bytes(body).finish();
}
const uint = (id: number, v: number): Uint8Array => el(id, new ByteWriter(8).u64(v).finish());
const float = (id: number, v: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
};
const str = (id: number, s: string): Uint8Array => el(id, enc.encode(s));

/** Colour element: matrix, range (1 limited, 2 full), transfer, primaries. */
function colour(c: ColorInfo | undefined): Uint8Array[] {
  if (!c) return [];
  const k = colorCodes(c);
  return [el(0x55b0, uint(0x55b1, k.matrix), uint(0x55b9, k.fullRange ? 2 : 1), uint(0x55ba, k.transfer), uint(0x55bb, k.primaries))];
}

export interface WebmVideo {
  codec: 'V_VP9' | 'V_VP8';
  width: number;
  height: number;
  color?: ColorInfo;
}
export interface WebmAudio {
  sampleRate: number;
  channels: number;
  /** OpusHead identification header (the encoder's decoder-config description). */
  opusHead: Uint8Array;
}

interface Block {
  track: number;
  timeMs: number;
  key: boolean;
  data: Uint8Array;
}

const MAX_CLUSTER_MS = 5000;
const MAX_CLUSTER_BYTES = 4 * 1024 * 1024;

export class WebmMuxer {
  private readonly sink: Mp4Sink;
  private readonly tracks: Uint8Array[] = [];
  private videoTrack = 0;
  private started = false;
  private position = 0;
  private durationAt = 0;
  private pending: Block[] = [];
  private pendingBytes = 0;
  private lastMs = 0;

  constructor(sink: Mp4Sink) {
    this.sink = sink;
  }

  private write(b: Uint8Array): void {
    this.sink.write(b);
    this.position += b.length;
  }

  addVideoTrack(v: WebmVideo): number {
    const n = this.tracks.length + 1;
    this.videoTrack = n;
    this.tracks.push(el(0xae, uint(0xd7, n), uint(0x73c5, n), uint(0x83, 1), uint(0x9c, 0), str(0x86, v.codec), el(0xe0, uint(0xb0, v.width), uint(0xba, v.height), ...colour(v.color))));
    return n;
  }

  addAudioTrack(a: WebmAudio): number {
    const n = this.tracks.length + 1;
    const preSkip = a.opusHead.length >= 12 ? a.opusHead[10]! | (a.opusHead[11]! << 8) : 0;
    this.tracks.push(el(
      0xae, uint(0xd7, n), uint(0x73c5, n), uint(0x83, 2), uint(0x9c, 0), str(0x86, 'A_OPUS'), el(0x63a2, a.opusHead),
      uint(0x56aa, Math.round((preSkip / 48000) * 1e9)), uint(0x56bb, 80_000_000), // codec delay and seek pre-roll, in nanoseconds
      el(0xe1, float(0xb5, a.sampleRate), uint(0x9f, a.channels)),
    ));
    return n;
  }

  private begin(): void {
    if (this.started) return;
    this.started = true;
    this.write(el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)));
    // Segment of unknown size: everything that follows belongs to it.
    this.write(new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
    const info = el(0x1549a966, uint(0x2ad7b1, 1_000_000), str(0x4d80, 'Cutline'), str(0x5741, 'Cutline'), float(0x4489, 0));
    this.durationAt = this.position + info.length - 8; // the Duration payload is the last 8 bytes
    this.write(info);
    this.write(el(0x1654ae6b, ...this.tracks));
  }

  private flush(): void {
    const first = this.pending[0];
    if (!first) return;
    const base = Math.min(...this.pending.map((b) => b.timeMs));
    const blocks = this.pending.map((b) => {
      const head = new ByteWriter(4).u8(0x80 | b.track).u16((b.timeMs - base) & 0xffff).u8(b.key ? 0x80 : 0).finish();
      return el(0xa3, head, b.data);
    });
    this.write(el(0x1f43b675, uint(0xe7, base), ...blocks));
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Add one encoded frame or audio packet. `timeMs` is its presentation time. */
  addFrame(track: number, data: Uint8Array, timeMs: number, key: boolean): void {
    this.begin();
    const t = Math.max(0, Math.round(timeMs));
    const first = this.pending[0];
    // Clusters begin on video key frames, and before one gets too long or too big.
    if (first && ((track === this.videoTrack && key) || t - first.timeMs > MAX_CLUSTER_MS || this.pendingBytes > MAX_CLUSTER_BYTES)) this.flush();
    this.pending.push({ track, timeMs: t, key: key || track !== this.videoTrack, data: data.slice() });
    this.pendingBytes += data.length;
    this.lastMs = Math.max(this.lastMs, t);
  }

  /** Write what is left and record the duration. */
  finish(durationMs: number): void {
    this.begin();
    this.flush();
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, Math.max(durationMs, this.lastMs));
    this.sink.patch(this.durationAt, b);
  }
}
