import { describe, expect, it } from 'vitest';
import {
  formatTimecode, frameTicks, frameToTick, isOnFrame, mulDiv, parseTimecode, rational, rationalEq, sampleToTick, secondsToTicks, snapToFrame,
  TICKS_PER_SECOND, tickToFrame, tickToSample, unitsToTicks,
} from './time.ts';

const RATES = [rational(24000, 1001), rational(24), rational(25), rational(30000, 1001), rational(30), rational(50), rational(60000, 1001), rational(60)];

describe('time', () => {
  it('has a tick base every supported rate divides exactly', () => {
    for (const fps of RATES) expect((TICKS_PER_SECOND * fps.den) % fps.num).toBe(0);
    for (const sr of [44100, 48000]) expect(TICKS_PER_SECOND % sr).toBe(0);
    expect(frameTicks(rational(30000, 1001))).toBe(23543520);
  });

  it('round-trips frames through ticks at every rate, far into a long timeline', () => {
    for (const fps of RATES) {
      for (const f of [0, 1, 2, 1799, 1800, 107892, 1_000_000, 10_000_000]) {
        const t = frameToTick(f, fps);
        expect(Number.isSafeInteger(t)).toBe(true);
        expect(tickToFrame(t, fps)).toBe(f);
        expect(tickToFrame(t + frameTicks(fps) - 1, fps)).toBe(f);
        expect(tickToFrame(t - 1, fps)).toBe(f - 1);
        expect(isOnFrame(t, fps)).toBe(true);
      }
    }
  });

  it('snaps to frames with each rounding mode', () => {
    const fps = rational(25);
    const ft = frameTicks(fps);
    expect(snapToFrame(ft * 3 + 1, fps, 'floor')).toBe(ft * 3);
    expect(snapToFrame(ft * 3 + 1, fps, 'ceil')).toBe(ft * 4);
    expect(snapToFrame(ft * 3 + ft / 2, fps, 'round')).toBe(ft * 4);
    expect(snapToFrame(ft * 3 + ft / 2 - 1, fps, 'round')).toBe(ft * 3);
    expect(isOnFrame(ft * 3 + 1, fps)).toBe(false);
  });

  it('does exact integer mulDiv with floor, ceil and round, including negatives', () => {
    expect(mulDiv(7, 1, 2, 'floor')).toBe(3);
    expect(mulDiv(7, 1, 2, 'ceil')).toBe(4);
    expect(mulDiv(7, 1, 2, 'round')).toBe(4);
    expect(mulDiv(-7, 1, 2, 'floor')).toBe(-4);
    expect(mulDiv(-7, 1, 2, 'ceil')).toBe(-3);
    expect(mulDiv(-7, 1, 2, 'round')).toBe(-3);
    expect(mulDiv(5, 1, 3, 'round')).toBe(2);
    expect(mulDiv(9_007_199_254_740_991, 1001, 1001)).toBe(9_007_199_254_740_991);
    expect(() => mulDiv(1, 1, 0)).toThrow();
  });

  it('converts samples and arbitrary timescales', () => {
    expect(sampleToTick(48000, 48000)).toBe(TICKS_PER_SECOND);
    expect(sampleToTick(1, 44100)).toBe(16000);
    expect(tickToSample(sampleToTick(123457, 44100), 44100)).toBe(123457);
    expect(unitsToTicks(1001, 30000)).toBe(frameTicks(rational(30000, 1001)));
    expect(secondsToTicks(0.5)).toBe(TICKS_PER_SECOND / 2);
  });

  it('normalises rationals and rejects bad ones', () => {
    expect(rational(60, 2)).toEqual({ num: 30, den: 1 });
    expect(rationalEq(rational(30000, 1001), { num: 60000, den: 2002 })).toBe(true);
    expect(() => rational(0)).toThrow();
    expect(() => rational(29.97)).toThrow();
  });

  it('formats non-drop timecode', () => {
    const fps = rational(25);
    expect(formatTimecode(0, fps)).toBe('00:00:00:00');
    expect(formatTimecode(frameToTick(25 * 3661 + 7, fps), fps)).toBe('01:01:01:07');
    expect(formatTimecode(-frameToTick(30, fps), fps)).toBe('-00:00:01:05');
    expect(formatTimecode(frameToTick(47, rational(24000, 1001)), rational(24000, 1001))).toBe('00:00:01:23');
  });

  it('formats drop-frame timecode for 29.97 and 59.94', () => {
    const fps = rational(30000, 1001);
    const tc = (f: number): string => formatTimecode(frameToTick(f, fps), fps);
    expect(tc(1799)).toBe('00:00:59;29');
    expect(tc(1800)).toBe('00:01:00;02');
    expect(tc(17981)).toBe('00:09:59;29');
    expect(tc(17982)).toBe('00:10:00;00');
    expect(tc(107892)).toBe('01:00:00;00');
    const f60 = rational(60000, 1001);
    expect(formatTimecode(frameToTick(3600, f60), f60)).toBe('00:01:00;04');
  });

  it('parses timecode back to the same tick', () => {
    for (const fps of RATES) {
      for (const f of [0, 1, 1799, 1800, 1801, 17982, 107892, 250001]) {
        const t = frameToTick(f, fps);
        expect(parseTimecode(formatTimecode(t, fps), fps)).toBe(t);
      }
    }
    expect(parseTimecode('1:02', rational(25))).toBe(frameToTick(27, rational(25)));
    expect(parseTimecode('12', rational(25))).toBe(frameToTick(12, rational(25)));
    expect(parseTimecode('abc', rational(25))).toBeNull();
    expect(parseTimecode('', rational(25))).toBeNull();
  });
});
