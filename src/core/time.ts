// Time math. All model times are integer ticks; frame rates are rationals.

/** Ticks per second. Divides 24, 25, 30, 50, 60 fps, their /1.001 variants, and 44.1/48 kHz exactly. */
export const TICKS_PER_SECOND = 705_600_000;

export type Tick = number;

export interface Rational {
  num: number;
  den: number;
}

export const rational = (num: number, den = 1): Rational => {
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) throw new Error(`Bad rational ${num}/${den}`);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
};

export function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return Math.abs(a);
}

export const rationalEq = (a: Rational, b: Rational): boolean => a.num * b.den === b.num * a.den;

export type Rounding = 'floor' | 'round' | 'ceil';

/** Exact a * b / c on integers with the chosen rounding (BigInt inside, so no 2^53 overflow). */
export function mulDiv(a: number, b: number, c: number, mode: Rounding = 'floor'): number {
  if (c === 0) throw new Error('mulDiv: division by zero');
  let n = BigInt(a) * BigInt(b);
  let d = BigInt(c);
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  // Ties in 'round' go toward +infinity.
  if (mode === 'ceil') return -Number(floorDiv(-n, d));
  if (mode === 'round') return Number(floorDiv(2n * n + d, 2n * d));
  return Number(floorDiv(n, d));
}

function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d < 0n ? q - 1n : q;
}

/** Start tick of frame `frame` at `fps`. Exact for every supported rate. */
export const frameToTick = (frame: number, fps: Rational): Tick => mulDiv(frame, TICKS_PER_SECOND * fps.den, fps.num, 'round');

/** Index of the frame containing `tick` (or nearest / next, by mode). */
export const tickToFrame = (tick: Tick, fps: Rational, mode: Rounding = 'floor'): number =>
  mulDiv(tick, fps.num, TICKS_PER_SECOND * fps.den, mode);

/** Snap a tick to a frame boundary. */
export const snapToFrame = (tick: Tick, fps: Rational, mode: Rounding = 'round'): Tick => frameToTick(tickToFrame(tick, fps, mode), fps);

export const isOnFrame = (tick: Tick, fps: Rational): boolean => snapToFrame(tick, fps, 'floor') === tick;

/** Duration of one frame in ticks (rounded for rates the tick base does not divide). */
export const frameTicks = (fps: Rational): Tick => frameToTick(1, fps);

export const sampleToTick = (sample: number, sampleRate: number): Tick => mulDiv(sample, TICKS_PER_SECOND, sampleRate, 'round');

export const tickToSample = (tick: Tick, sampleRate: number, mode: Rounding = 'round'): number =>
  mulDiv(tick, sampleRate, TICKS_PER_SECOND, mode);

/** Boundary conversions for UI and media code. Never store the float result in the model. */
export const ticksToSeconds = (tick: Tick): number => tick / TICKS_PER_SECOND;
export const secondsToTicks = (seconds: number): Tick => Math.round(seconds * TICKS_PER_SECOND);

/** Convert a time in an arbitrary timescale (units per second) to ticks. */
export const unitsToTicks = (units: number, timescale: number): Tick => mulDiv(units, TICKS_PER_SECOND, timescale, 'round');

const isDropRate = (fps: Rational): boolean => fps.den === 1001 && (fps.num === 30000 || fps.num === 60000);

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/**
 * Timecode HH:MM:SS:FF. For 29.97 and 59.94 fps uses drop-frame (separator ';'),
 * so the displayed time tracks wall-clock time.
 */
export function formatTimecode(tick: Tick, fps: Rational): string {
  const neg = tick < 0;
  let frame = tickToFrame(Math.abs(tick), fps);
  const base = Math.round(fps.num / fps.den);
  const drop = isDropRate(fps);
  if (drop) {
    const dropPerMin = base / 15; // 2 at 29.97, 4 at 59.94
    const per10 = base * 600 - dropPerMin * 9;
    const perMin = base * 60 - dropPerMin;
    const tens = Math.floor(frame / per10);
    const rem = frame % per10;
    frame += dropPerMin * 9 * tens + (rem > dropPerMin ? dropPerMin * Math.floor((rem - dropPerMin) / perMin) : 0);
  }
  const ff = frame % base;
  const s = Math.floor(frame / base);
  return `${neg ? '-' : ''}${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}${drop ? ';' : ':'}${pad(ff, base > 99 ? 3 : 2)}`;
}

/** Parse HH:MM:SS:FF (or ;FF), also MM:SS:FF, SS:FF and a bare frame count. Returns null when malformed. */
export function parseTimecode(text: string, fps: Rational): Tick | null {
  const m = /^\s*(?:(?:(\d+):)?(\d+):)?(\d+)[:;](\d+)\s*$/.exec(text) ?? /^\s*()()()(\d+)\s*$/.exec(text);
  if (!m) return null;
  const [h, min, s, f] = [m[1], m[2], m[3], m[4]].map((x) => (x ? parseInt(x, 10) : 0)) as [number, number, number, number];
  const base = Math.round(fps.num / fps.den);
  let frame = ((h * 60 + min) * 60 + s) * base + f;
  if (isDropRate(fps)) {
    const dropPerMin = base / 15;
    const totalMin = h * 60 + min;
    frame -= dropPerMin * (totalMin - Math.floor(totalMin / 10));
  }
  return frameToTick(frame, fps);
}
