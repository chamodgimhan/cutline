import { describe, expect, it } from 'vitest';
import { ByteCache, decodePeaks, encodePeaks, PeakBuilder, peakRange } from './peaks.ts';

describe('peaks', () => {
  it('records min and max per bucket across channels and blocks', () => {
    const b = new PeakBuilder(1000, 100); // 10 samples per bucket
    const l = new Float32Array(25).fill(0.1);
    const r = new Float32Array(25).fill(-0.2);
    l[3] = 1;
    r[14] = -1;
    b.push([l.subarray(0, 7), r.subarray(0, 7)]);
    b.push([l.subarray(7), r.subarray(7)]);
    const p = b.finish();
    expect(p.rate).toBe(100);
    expect([...p.max]).toEqual([127, 13, 13]);
    expect([...p.min]).toEqual([-25, -127, -25]);
    expect(peakRange(p, 0, 2)).toEqual({ min: -1, max: 1 });
    expect(peakRange(p, 2, 3).max).toBeCloseTo(13 / 127);
    expect(peakRange(p, 50, 60)).toEqual({ min: 0, max: 0 });
  });

  it('round-trips through bytes and rejects damaged data', () => {
    const b = new PeakBuilder(48000);
    b.push([Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10))]);
    const p = b.finish();
    const bytes = encodePeaks(p);
    expect(decodePeaks(bytes)).toEqual(p);
    expect(decodePeaks(bytes.subarray(0, 20))).toBeNull();
    expect(decodePeaks(new Uint8Array(40))).toBeNull();
  });
});

describe('ByteCache', () => {
  it('never exceeds its limit and evicts least recently used first', () => {
    const c = new ByteCache(100);
    c.set('a', new Uint8Array(40));
    c.set('b', new Uint8Array(40));
    expect(c.get('a')).toBeDefined(); // a is now most recent
    c.set('c', new Uint8Array(40));
    expect(c.bytes).toBe(80);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBeDefined();
    c.set('a', new Uint8Array(10));
    expect(c.bytes).toBe(50);
    c.set('huge', new Uint8Array(500));
    expect(c.get('huge')).toBeUndefined();
    expect(c.bytes).toBeLessThanOrEqual(100);
  });
});
