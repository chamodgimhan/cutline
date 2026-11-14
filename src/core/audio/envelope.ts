// Per-clip audio gain: clip gain (keyframed), user fades, and the short automatic
// crossfade at every edit that keeps cuts from clicking. Pure math on sample indices.
import { headRoom, tailRoom } from '../clipmath.ts';
import { evalParam } from '../keyframes.ts';
import { clipEnd, type Clip, type Project } from '../model.ts';
import { sampleToTick, tickToSample } from '../time.ts';

/** Length in samples of the automatic crossfade centred on each cut. */
export const EDGE_RAMP = 128;
const HALF = EDGE_RAMP / 2;

export const dbToGain = (db: number): number => (db <= -120 ? 0 : 10 ** (db / 20));
export const gainToDb = (gain: number): number => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

/** Left and right gains for a pan of -1..1. Centre is unity on both sides. */
export const balance = (pan: number): [number, number] => [Math.min(1, 1 - pan), Math.min(1, 1 + pan)];

export interface ClipAudio {
  /** Audible range in sequence samples. It reaches up to half a ramp past each clip edge when the source has handle there. */
  from: number;
  to: number;
  /** Clip start in sequence samples (where source time equals sourceIn for a forward clip). */
  start: number;
  /** Gain multiplier at sequence sample `n` (may be fractional for resampled sources). */
  gainAt(n: number): number;
}

/**
 * Shape of a clip's audio at `rate`. At a cut between two clips with handles, one ramps out
 * while the other ramps in over the same samples; their gains sum to one, so a cut inside
 * continuous material is inaudible and bit-transparent. A clip edge next to silence gets a
 * plain short fade.
 */
export function clipAudio(project: Project, c: Clip, rate: number): ClipAudio {
  const start = tickToSample(c.start, rate);
  const end = tickToSample(clipEnd(c), rate);
  const room = (ticks: number): number => (ticks === Infinity ? HALF : Math.min(HALF, tickToSample(ticks, rate, 'floor')));
  const pre = Math.min(room(headRoom(project, c)), start);
  const post = room(tailRoom(project, c));
  const fadeIn = tickToSample(c.audio?.fadeIn ?? 0, rate);
  const fadeOut = tickToSample(c.audio?.fadeOut ?? 0, rate);
  const gain = c.audio?.gain ?? 0;
  const fixed = typeof gain === 'number' ? dbToGain(gain) : null;
  return {
    from: start - pre, to: end + post, start,
    gainAt(n) {
      let g = fixed ?? dbToGain(evalParam(gain, sampleToTick(Math.min(Math.max(n - start, 0), end - start), rate)));
      if (n < start + HALF) g *= Math.max(0, (n - (start - pre)) / (pre + HALF));
      if (n >= end - HALF) g *= Math.max(0, (end + post - n) / (post + HALF));
      if (fadeIn > 0 && n < start + fadeIn) g *= Math.max(0, (n - start) / fadeIn);
      if (fadeOut > 0 && n > end - fadeOut) g *= Math.max(0, (end - n) / fadeOut);
      return g;
    },
  };
}
