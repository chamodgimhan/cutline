import { describe, expect, it } from 'vitest';
import { splitClips } from '../commands/clips.ts';
import { makeKey } from '../keyframes.ts';
import { ctxFor, project } from '../testkit.ts';
import { TICKS_PER_SECOND as S } from '../time.ts';
import { balance, clipAudio, dbToGain, EDGE_RAMP, gainToDb } from './envelope.ts';
import { LoudnessMeter, normaliseGain } from './loudness.ts';

const R = 48000;
const T = S / R; // ticks per sample
const sine = (amp: number, hz: number, seconds: number, rate = R): Float32Array => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));

describe('gain helpers', () => {
  it('converts decibels both ways', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6.020599913279624)).toBeCloseTo(0.5, 12);
    expect(dbToGain(-200)).toBe(0);
    expect(gainToDb(0.5)).toBeCloseTo(-6.0206, 4);
    expect(gainToDb(0)).toBe(-Infinity);
  });

  it('pans by balance with unity at centre', () => {
    expect(balance(0)).toEqual([1, 1]);
    expect(balance(-1)).toEqual([1, 0]);
    expect(balance(1)).toEqual([0, 1]);
    expect(balance(0.5)).toEqual([0.5, 1]);
  });
});

describe('clipAudio', () => {
  const audio = (extra: object = {}) => ({ audio: { gain: 0, fadeIn: 0, fadeOut: 0, ...extra } });

  it('crossfades across a cut in continuous material so the two halves sum to exactly one', () => {
    let p = project({ A1: [['a', 1000 * T, 4000 * T, 5000 * T]] }, 20000 * T);
    p = splitClips(p, ctxFor(), { at: 3000 * T }).apply(p);
    const [l, r] = p.sequences[0]!.tracks[0]!.clips.map((c) => clipAudio(p, c, R));
    expect([l!.to, r!.from]).toEqual([3000 + EDGE_RAMP / 2, 3000 - EDGE_RAMP / 2]);
    for (let n = 2900; n < 3100; n++) {
      const sum = (n < l!.to ? l!.gainAt(n) : 0) + (n >= r!.from ? r!.gainAt(n) : 0);
      expect(sum, `sample ${n}`).toBeCloseTo(1, 12);
    }
    expect(l!.gainAt(2000)).toBe(1);
  });

  it('fades a free edge, using source handle before the clip when there is some', () => {
    const p = project({ A1: [['a', 1000 * T, 4000 * T, 5000 * T], ['b', 9000 * T, 1000 * T, 0]] }, 20000 * T);
    const a = clipAudio(p, p.sequences[0]!.tracks[0]!.clips[0]!, R);
    expect([a.from, a.to, a.start]).toEqual([936, 5064, 1000]);
    expect(a.gainAt(936)).toBe(0);
    expect(a.gainAt(1000)).toBe(0.5);
    expect(a.gainAt(1064)).toBe(1);
    expect(a.gainAt(5064)).toBe(0);
    // No source before sourceIn 0: the ramp sits wholly inside the clip.
    const b = clipAudio(p, p.sequences[0]!.tracks[0]!.clips[1]!, R);
    expect(b.from).toBe(9000);
    expect([b.gainAt(9000), b.gainAt(9032), b.gainAt(9064)]).toEqual([0, 0.5, 1]);
    // A clip at time zero cannot start early either.
    const z = project({ A1: [['z', 0, 1000 * T, 500 * T]] }, 20000 * T);
    expect(clipAudio(z, z.sequences[0]!.tracks[0]!.clips[0]!, R).from).toBe(0);
  });

  it('applies clip gain, keyframed gain and user fades', () => {
    const p = project({ A1: [['a', 0, 48000 * T, 1000 * T, audio({ gain: -6.020599913279624, fadeIn: 4800 * T, fadeOut: 9600 * T })]] }, 200000 * T);
    const a = clipAudio(p, p.sequences[0]!.tracks[0]!.clips[0]!, R);
    expect(a.gainAt(24000)).toBeCloseTo(0.5, 9);
    expect(a.gainAt(2400)).toBeCloseTo(0.25, 9);
    expect(a.gainAt(48000 - 4800)).toBeCloseTo(0.25, 9);
    expect(a.gainAt(0)).toBe(0);
    const keyed = project({ A1: [['a', 0, 48000 * T, 1000 * T, audio({ gain: { keys: [makeKey(0, 0), makeKey(48000 * T, -20)] } })]] }, 200000 * T);
    const k = clipAudio(keyed, keyed.sequences[0]!.tracks[0]!.clips[0]!, R);
    expect(k.gainAt(24000)).toBeCloseTo(dbToGain(-10), 9);
    expect(k.gainAt(40000)).toBeLessThan(k.gainAt(20000));
  });
});

describe('LoudnessMeter', () => {
  const measure = (channels: Float32Array[], rate = R, block = 4096): number => {
    const m = new LoudnessMeter(rate);
    const n = channels[0]!.length;
    for (let i = 0; i < n; i += block) m.push(channels.map((c) => c.subarray(i, Math.min(n, i + block))));
    return m.integrated();
  };

  it('reads the reference levels of BS.1770: a full-scale 997 Hz sine in one channel is -3.01 LUFS', () => {
    expect(measure([sine(1, 997, 5), new Float32Array(5 * R)])).toBeCloseTo(-3.01, 1);
    expect(measure([sine(1, 997, 5), sine(1, 997, 5)])).toBeCloseTo(0.0, 1);
    // EBU Tech 3341 case 1: stereo 1 kHz at -23 dBFS reads -23 LUFS.
    const a = 10 ** (-23 / 20);
    expect(Math.abs(measure([sine(a, 1000, 20), sine(a, 1000, 20)]) + 23)).toBeLessThan(0.1);
  });

  it('gives the same answer at 44.1 kHz and for any block size', () => {
    const a = 10 ** (-23 / 20);
    expect(Math.abs(measure([sine(a, 1000, 10, 44100), sine(a, 1000, 10, 44100)], 44100) + 23)).toBeLessThan(0.1);
    const x = sine(0.3, 440, 6);
    expect(measure([x, x], R, 37)).toBeCloseTo(measure([x, x], R, 48000), 9);
  });

  it('gates out silence and quiet passages (EBU Tech 3341 cases 3 and 5 style)', () => {
    const tone = (db: number, s: number): Float32Array => sine(10 ** (db / 20), 1000, s);
    const join = (...parts: Float32Array[]): Float32Array => {
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((o, p) => (out.set(p, o), o + p.length), 0);
      return out;
    };
    // 10 s at -36, 60 s at -23, 10 s at -36: the relative gate drops the quiet parts.
    const gated = join(tone(-36, 10), tone(-23, 60), tone(-36, 10));
    expect(Math.abs(measure([gated, gated]) + 23)).toBeLessThan(0.1);
    // Leading and trailing silence does not pull the reading down.
    const padded = join(new Float32Array(10 * R), tone(-23, 20), new Float32Array(10 * R));
    expect(Math.abs(measure([padded, padded]) + 23)).toBeLessThan(0.1);
    expect(measure([new Float32Array(R * 2)])).toBe(-Infinity);
    expect(measure([sine(0.5, 1000, 0.2)])).toBe(-Infinity);
  });

  it('computes the gain needed to hit a target', () => {
    expect(normaliseGain(-23, -16)).toBe(7);
    expect(normaliseGain(-9.5, -14)).toBe(-4.5);
    expect(normaliseGain(-Infinity, -14)).toBe(0);
  });
});
