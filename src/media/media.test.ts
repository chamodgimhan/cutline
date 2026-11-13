import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { updateMedia } from '../core/commands/tracks.ts';
import { ctxFor, project } from '../core/testkit.ts';
import { TICKS_PER_SECOND } from '../core/time.ts';
import { CLICK_AMP, FIXTURES, frameTiming, pcmBlock } from '../../tools/fixtures/build.ts';
import { readManifest } from '../../tools/fixtures/generate.ts';
import { drawFrame } from '../../tools/fixtures/frame.ts';
import { LosslessH264 } from '../../tools/fixtures/h264pcm.ts';
import { fixturePath, NodeFileSource } from '../../tools/nodeSource.ts';
import { ByteWriter, concatBytes } from './bytes.ts';
import { MediaLibrary } from './library.ts';
import { keyBefore, Mp4File, sampleAtTime } from './mp4/demuxer.ts';
import { mp4PcmReader, pcmToFloat, wavReader } from './pcm.ts';
import { describeMedia, displaySize, probe } from './probe.ts';
import { CountingSource, fingerprint, MediaError, MemorySource } from './source.ts';

const open = (name: string): NodeFileSource => new NodeFileSource(fixturePath(name + '.mp4'));
const spec = (name: string) => FIXTURES.find((f) => f.name === name)!;

async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(MediaError);
    return (e as Error).message;
  }
  throw new Error('expected a MediaError');
}

function wav(channels: number, rate: number, bits: number, data: Uint8Array, code = 1): Uint8Array {
  const le = (n: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 255);
  const fmt = [...le(code, 2), ...le(channels, 2), ...le(rate, 4), ...le((rate * channels * bits) / 8, 4), ...le((channels * bits) / 8, 2), ...le(bits, 2)];
  const w = new ByteWriter();
  w.ascii('RIFF').bytes(new Uint8Array(le(36 + data.length, 4))).ascii('WAVE').ascii('fmt ').bytes(new Uint8Array(le(16, 4))).bytes(new Uint8Array(fmt));
  w.ascii('data').bytes(new Uint8Array(le(data.length, 4))).bytes(data);
  return w.finish();
}

describe('probe', () => {
  it('reports duration, rational fps, size, rotation and audio for every clip fixture', async () => {
    const expected: Record<string, [number, number, boolean]> = { clip_24: [24, 1, false], clip_25: [25, 1, false], clip_2997: [30000, 1001, false], clip_60: [60, 1, false] };
    for (const [name, [num, den, vfr]] of Object.entries(expected)) {
      const info = await probe(open(name));
      expect(info.video, name).toMatchObject({ width: 320, height: 180, rotation: 0, fps: { num, den }, vfr, codec: 'avc1.42c028', frameCount: frameTiming(spec(name)).durations.length });
      expect(info.audio, name).toEqual({ sampleRate: 48000, channels: 2, codec: 'pcm' });
      const videoTicks = (frameTiming(spec(name)).durations.length * den * TICKS_PER_SECOND) / num;
      expect(info.duration, name).toBe(Math.max(2 * TICKS_PER_SECOND, videoTicks));
    }
  });

  it('detects variable frame rate and rotation', async () => {
    const vfr = await probe(open('vfr'));
    expect(vfr.video?.vfr).toBe(true);
    expect(vfr.video!.fps.num / vfr.video!.fps.den).toBeGreaterThan(20);
    const rot = await probe(open('rotated'));
    expect(rot.video).toMatchObject({ width: 320, height: 180, rotation: 90, vfr: false, fps: { num: 30, den: 1 } });
    expect(displaySize(rot.video!)).toEqual({ width: 180, height: 320 });
  });

  it('opens the 2-hour file by reading only its index', async () => {
    const src = new CountingSource(open('long_2h'));
    const t0 = performance.now();
    const info = await probe(src);
    const ms = performance.now() - t0;
    expect(info.duration).toBe(7200 * TICKS_PER_SECOND);
    expect(info.video).toMatchObject({ width: 64, height: 48, frameCount: 172800, fps: { num: 24, den: 1 } });
    expect(info.audio).toEqual({ sampleRate: 16000, channels: 1, codec: 'pcm' });
    console.log(`[budget] 2h open: ${ms.toFixed(0)} ms, ${(src.bytesRead / 1024).toFixed(0)} KiB of ${(src.size / 1048576).toFixed(0)} MiB read in ${src.reads} reads`);
    expect(src.bytesRead).toBeLessThan(src.size / 100);
    expect(ms).toBeLessThan(2000);
  });

  it('gives a readable error for corrupt, truncated, empty and foreign files', async () => {
    expect(await message(probe(open('corrupt')))).toMatch(/damaged or incomplete/);
    const good = new Uint8Array(fs.readFileSync(fixturePath('clip_24.mp4')));
    expect(await message(probe(new MemorySource(good.subarray(0, 300))))).toMatch(/damaged or incomplete/);
    expect(await message(probe(new MemorySource(new Uint8Array(4))))).toMatch(/empty or too small/);
    expect(await message(probe(new MemorySource(new TextEncoder().encode('just some text, not media at all'))))).toMatch(/not a video or audio file/);
    expect(await message(probe(new MemorySource(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))))).toMatch(/WebM and MKV/);
    // Index intact but the sample data cut off: reading a frame reports damage.
    const long = await Mp4File.open(open('long_2h'));
    const cut = new MemorySource(good.subarray(0, 5000));
    const file = await Mp4File.open(new MemorySource(good));
    const broken = Object.assign(Object.create(Mp4File.prototype), { source: cut, tracks: file.tracks }) as Mp4File;
    expect(await message(broken.readSample(file.video!, 40))).toMatch(/damaged or incomplete/);
    expect(long.video!.sampleCount).toBe(172800);
  });

  it('reads image dimensions and WAV headers', async () => {
    const png = new ByteWriter().u32(0x89504e47).u32(0x0d0a1a0a).u32(13).ascii('IHDR').u32(640).u32(360).zeros(8).finish();
    expect(await probe(new MemorySource(png))).toMatchObject({ container: 'image', duration: 0, video: { width: 640, height: 360 } });
    const info = await probe(new MemorySource(wav(2, 44100, 16, new Uint8Array(44100 * 4))));
    expect(info).toMatchObject({ container: 'wav', duration: TICKS_PER_SECOND, audio: { sampleRate: 44100, channels: 2 } });
    expect(await message(probe(new MemorySource(wav(2, 44100, 16, new Uint8Array(64), 85))))).toMatch(/WAV file/);
  });
});

describe('demuxer', () => {
  it('returns the exact encoded samples the generator wrote, with key frames marked', async () => {
    const file = await Mp4File.open(open('clip_24'));
    const v = file.video!;
    const enc = new LosslessH264(320, 180);
    for (let n = 0; n < 30; n++) {
      const want = enc.encode(drawFrame(320, 180, n), n % 24 === 0);
      expect(v.keys[n]).toBe(want.key ? 1 : 0);
      if (n % 7 === 0 || n === 24) expect(await file.readSample(v, n), `frame ${n}`).toEqual(want.data);
    }
    expect(keyBefore(v, 23)).toBe(0);
    expect(keyBefore(v, 24)).toBe(24);
    expect(keyBefore(v, 47)).toBe(24);
    expect(v.entry.description?.[0]).toBe(1);
  });

  it('maps times to frames, including variable frame rate', async () => {
    const cfr = (await Mp4File.open(open('clip_2997'))).video!;
    expect(cfr.timescale).toBe(30000);
    expect([sampleAtTime(cfr, 0), sampleAtTime(cfr, 1000), sampleAtTime(cfr, 1001), sampleAtTime(cfr, 59 * 1001 + 5), sampleAtTime(cfr, 9e9), sampleAtTime(cfr, -5)]).toEqual([0, 0, 1, 59, 59, 0]);
    const vfr = (await Mp4File.open(open('vfr'))).video!;
    // Cycle is 33, 17, 50, 33, 67, 16, 34, 50 ms: frame starts at 0, 33, 50, 100, 133, 200, 216, 250, 300.
    expect([0, 32, 33, 49, 50, 99, 100, 199, 200, 215, 216, 299, 300].map((t) => sampleAtTime(vfr, t))).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8]);
  });

  it('reads PCM by frame range across chunk boundaries, sample-exact', async () => {
    const file = await Mp4File.open(open('clip_24'));
    const reader = mp4PcmReader(file, file.audio!);
    expect(reader).toMatchObject({ sampleRate: 48000, channels: 2, frames: 96000, format: { bits: 16, littleEndian: true, float: false } });
    for (const [first, count] of [[0, 10], [47990, 20], [95990, 50], [12345, 4000]] as const) {
      const n = Math.min(count, 96000 - first);
      expect(await reader.read(first, count), `${first}+${count}`).toEqual(pcmBlock(48000, 2, first, n));
    }
    const [l, r] = pcmToFloat(await reader.read(47999, 3), reader.format, 2) as [Float32Array, Float32Array];
    expect(l[1]).toBeCloseTo(CLICK_AMP / 32768, 6);
    expect(r[1]).toBeCloseTo(CLICK_AMP / 32768, 6);
    const long = await Mp4File.open(open('long_2h'));
    const lr = mp4PcmReader(long, long.audio!);
    expect(await lr.read(16000 * 7199 - 5, 10)).toEqual(pcmBlock(16000, 1, 16000 * 7199 - 5, 10));
  });

  it('converts every PCM layout to float', () => {
    const f = (bytes: number[], bits: 8 | 16 | 24 | 32, littleEndian: boolean, float = false): number[] => [...pcmToFloat(new Uint8Array(bytes), { bits, littleEndian, float }, 1)[0]!];
    expect(f([0x00, 0x40, 0x00, 0xc0], 16, true)).toEqual([0.5, -0.5]);
    expect(f([0x40, 0x00, 0xc0, 0x00], 16, false)).toEqual([0.5, -0.5]);
    expect(f([0, 0, 0x40, 0, 0, 0xc0], 24, true)).toEqual([0.5, -0.5]);
    expect(f([0x40, 0, 0, 0xc0, 0, 0], 24, false)).toEqual([0.5, -0.5]);
    expect(f([0, 0, 0, 0x40], 32, true)).toEqual([0.5]);
    expect(f([192, 64], 8, true)).toEqual([0.5, -0.5]);
    expect(f([0, 0, 0, 0x3f], 32, true, true)).toEqual([0.5]);
    const stereo = pcmToFloat(new Uint8Array([0, 0x40, 0, 0xc0, 0, 0x20, 0, 0xe0]), { bits: 16, littleEndian: true, float: false }, 2);
    expect(stereo.map((c) => [...c])).toEqual([[0.5, 0.25], [-0.5, -0.25]]);
  });

  it('reads WAV frames', async () => {
    const data = new Uint8Array(new Int16Array([1, 2, 3, 4, 5, 6]).buffer);
    const r = await wavReader(new MemorySource(wav(2, 48000, 16, data)));
    expect(r.frames).toBe(3);
    expect(new Int16Array((await r.read(1, 5)).slice().buffer)).toEqual(new Int16Array([3, 4, 5, 6]));
  });
});

describe('media library', () => {
  it('fingerprints by content, not by path', async () => {
    const a = await fingerprint(open('clip_24'));
    expect(a).toBe(await fingerprint(new MemorySource(new Uint8Array(fs.readFileSync(fixturePath('clip_24.mp4'))))));
    expect(a).not.toBe(await fingerprint(open('clip_25')));
    expect(await fingerprint(open('clip_2997'))).not.toBe(await fingerprint(open('rotated')));
  });

  it('imports, goes offline, and relinks to the same file at a new path', async () => {
    const lib = new MediaLibrary();
    let changes = 0;
    lib.subscribe(() => changes++);
    const asset = await lib.importSource(open('clip_24'), 'm', 'clip_24.mp4', 'D:/shoot/clip_24.mp4');
    expect(asset).toMatchObject({ id: 'm', kind: 'video', duration: 2 * TICKS_PER_SECOND, video: { width: 320, height: 180, vfr: false }, audio: { sampleRate: 48000, channels: 2 } });
    expect(lib.status('m')).toBe('online');
    lib.detach('m');
    expect(lib.status('m')).toBe('offline');
    expect(() => lib.need(asset)).toThrow(/offline/);
    expect(await message(lib.relink(asset, open('clip_25'), 'E:/other.mp4'))).toMatch(/not the same/);
    expect(lib.status('m')).toBe('offline');
    expect(await lib.relink(asset, open('clip_24'), 'E:/moved/clip_24.mp4')).toEqual({ path: 'E:/moved/clip_24.mp4' });
    expect(lib.status('m')).toBe('online');
    expect(changes).toBeGreaterThanOrEqual(3);
  });

  it('can force a relink to different content, and the project rejects a file that is too short', async () => {
    const lib = new MediaLibrary();
    const asset = await lib.importSource(open('clip_24'), 'm', 'clip_24.mp4', '/a.mp4');
    const change = await lib.relink(asset, open('clip_60'), '/b.mp4', true);
    expect(change).toMatchObject({ path: '/b.mp4', video: { fps: { num: 60, den: 1 } } });
    expect(change.fingerprint).not.toBe(asset.fingerprint);
    const audioOnly = wav(1, 48000, 16, new Uint8Array(96000));
    expect(await message(lib.relink(asset, new MemorySource(audioOnly), '/c.wav', true))).toMatch(/is video but the chosen file is audio/);
    // A project using 2 s of this media cannot be relinked to a 1 s file.
    const p = project({ V1: [['a', 0, 2 * TICKS_PER_SECOND]] }, 2 * TICKS_PER_SECOND);
    expect(() => updateMedia(p, ctxFor(), 'm', { duration: TICKS_PER_SECOND })).toThrow(/Not enough source media/);
  });

  it('resolves a reopened project: found files come online, missing or changed ones stay offline', async () => {
    const lib = new MediaLibrary();
    const a = await describeMedia(open('clip_24'), 'a', 'a', fixturePath('clip_24.mp4'));
    const b = await describeMedia(open('clip_25'), 'b', 'b', '/gone/clip_25.mp4');
    const c = { ...(await describeMedia(open('clip_60'), 'c', 'c', fixturePath('clip_25.mp4'))) };
    const offline = await lib.resolve([a, b, c], async (m) => (fs.existsSync(m.path) ? new NodeFileSource(m.path) : null));
    expect(offline).toEqual(['b', 'c']);
    expect([lib.status('a'), lib.status('b'), lib.status('c')]).toEqual(['online', 'offline', 'offline']);
    expect(concatBytes([new Uint8Array(1)])).toHaveLength(1);
  });

  it('matches the manifest frame counts', () => {
    const m = readManifest();
    expect(m.clip_24?.frameCount).toBe(48);
    expect(m.vfr?.frameCount).toBe(frameTiming(spec('vfr')).durations.length);
  });
});
