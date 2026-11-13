import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BitReader } from '../../src/media/bytes.ts';
import { MemorySink } from '../../src/media/mp4/muxer.ts';
import { buildFixture, CLICK_AMP, corrupt, FIXTURES, frameTiming, pcmBlock } from './build.ts';
import { drawFrame, readCounter } from './frame.ts';
import { readManifest } from './generate.ts';
import { LosslessH264, nal } from './h264pcm.ts';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

describe('fixture generator', () => {
  const manifest = readManifest();
  const small = FIXTURES.filter((f) => f.seconds <= 10);

  it('regenerates every small fixture byte-identical to the manifest', () => {
    for (const spec of small) {
      const sink = new MemorySink();
      const info = buildFixture(spec, sink);
      const bytes = sink.bytes();
      const entry = manifest[spec.name];
      expect(entry, spec.name).toBeDefined();
      expect(sha(bytes), spec.name).toBe(entry?.sha256);
      expect(info.frameHashes, spec.name).toEqual(entry?.frameHashes);
      if (spec.name === 'clip_24') expect(sha(corrupt(bytes))).toBe(manifest.corrupt?.sha256);
    }
  });

  it('lists every required fixture', () => {
    for (const name of ['clip_24', 'clip_25', 'clip_2997', 'clip_60', 'vfr', 'rotated', 'long_2h', 'corrupt']) {
      expect(manifest[name], name).toBeDefined();
    }
    expect(manifest.long_2h?.frameCount).toBe(7200 * 24);
  });

  it('gives the expected frame counts', () => {
    const count = (name: string): number => frameTiming(FIXTURES.find((f) => f.name === name)!).durations.length;
    expect(count('clip_24')).toBe(48);
    expect(count('clip_25')).toBe(50);
    expect(count('clip_2997')).toBe(60);
    expect(count('clip_60')).toBe(120);
    const vfr = frameTiming(FIXTURES.find((f) => f.name === 'vfr')!);
    expect(new Set(vfr.durations).size).toBeGreaterThan(3);
    expect(vfr.durations.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
  });

  it('burns in a counter that reads back for every size', () => {
    for (const [w, h] of [[320, 180], [64, 48], [1920, 1080]] as const) {
      for (const n of [0, 7, 42, 1234, 172799]) {
        const f = drawFrame(w, h, n);
        expect(readCounter(w, (x, y) => (f.y[y * f.width + x] as number) > 128)).toBe(n);
      }
    }
    const f = drawFrame(320, 180, 5);
    expect(readCounter(320, () => false)).toBe(-1);
    expect(f.width).toBe(320);
    expect(f.height).toBe(192);
  });

  it('puts a one-sample click on each second and a 1 kHz tone between', () => {
    const pcm = new Int16Array(pcmBlock(48000, 2, 0, 96000).buffer);
    expect(pcm[0]).toBe(CLICK_AMP);
    expect(pcm[48000 * 2]).toBe(CLICK_AMP);
    expect(pcm[2 * 12]).toBe(8000); // quarter period: tone peak, left
    expect(pcm[2 * 12 + 1]).toBe(4000); // right is half level
    expect(pcm[2 * 48]).toBe(0); // one full period later
    const split = [...pcmBlock(48000, 2, 0, 1000), ...pcmBlock(48000, 2, 1000, 500)];
    expect(split).toEqual([...pcmBlock(48000, 2, 0, 1500)]);
  });

  it('encodes unchanged frames as a few bytes of skip', () => {
    const enc = new LosslessH264(64, 48);
    const f = drawFrame(64, 48, 0);
    const key = enc.encode(f, true);
    const same = enc.encode(f);
    expect(key.key).toBe(true);
    expect(key.data.length).toBeGreaterThan(12 * 384);
    expect(same.key).toBe(false);
    expect(same.data.length).toBeLessThan(16);
    const changed = enc.encode(drawFrame(64, 48, 1));
    expect(changed.data.length).toBeGreaterThan(384);
    expect(changed.data.length).toBeLessThan(12 * 384);
  });

  it('writes an SPS that parses back to the picture size', () => {
    const enc = new LosslessH264(320, 180);
    const r = new BitReader(enc.sps().subarray(4));
    r.ue(); r.ue(); r.ue(); r.ue(); r.bit();
    expect((r.ue() + 1) * 16).toBe(320);
    expect((r.ue() + 1) * 16).toBe(192);
    r.bit(); r.bit();
    expect(r.bit()).toBe(1);
    r.ue(); r.ue(); r.ue();
    expect(r.ue() * 2).toBe(12);
  });

  it('inserts emulation prevention bytes', () => {
    expect([...nal(3, 7, new Uint8Array([0, 0, 1, 0, 0, 0, 5]))]).toEqual([0x67, 0, 0, 3, 1, 0, 0, 3, 0, 5]);
  });
});
