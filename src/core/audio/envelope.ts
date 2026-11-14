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
  const samples = (ticks: number, cap: number): number => (ticks === Infinity ? cap : Math.min(cap, tickToSample(ticks, rate, 'floor')));
  // Audio crossfade transition: this clip fades in over its own start, and the clip before it
  // keeps playing into its handle underneath. Equal-power curves, so the level holds across the join.
  const track = project.sequences.flatMap((q) => q.tracks).find((t) => t.clips.includes(c));
  const next = track?.clips[track.clips.indexOf(c) + 1];
  const xIn = c.transitionIn?.type === 'crossfade' ? tickToSample(c.transitionIn.duration, rate) : 0;
  const xOutWanted = next && next.start === clipEnd(c) && next.transitionIn?.type === 'crossfade' ? tickToSample(next.transitionIn.duration, rate) : 0;
  const pre = xIn ? 0 : Math.min(samples(headRoom(project, c), HALF), start);
  const post = xOutWanted ? samples(tailRoom(project, c), xOutWanted) : samples(tailRoom(project, c), HALF);
  const fadeIn = tickToSample(c.audio?.fadeIn ?? 0, rate);
  const fadeOut = tickToSample(c.audio?.fadeOut ?? 0, rate);
  const gain = c.audio?.gain ?? 0;
  const fixed = typeof gain === 'number' ? dbToGain(gain) : null;
  return {
    from: start - pre, to: end + post, start,
    gainAt(n) {
      let g = fixed ?? dbToGain(evalParam(gain, sampleToTick(Math.min(Math.max(n - start, 0), end - start), rate)));
      if (xIn) {
        if (n < start + xIn) g *= Math.sin((Math.max(0, n - start) / xIn) * (Math.PI / 2));
      } else if (n < start + HALF) g *= Math.max(0, (n - (start - pre)) / (pre + HALF));
      if (xOutWanted) {
        if (n >= end) g *= Math.cos((Math.min(xOutWanted, n - end) / xOutWanted) * (Math.PI / 2));
      } else if (n >= end - HALF) g *= Math.max(0, (end + post - n) / (post + HALF));
      if (fadeIn > 0 && n < start + fadeIn) g *= Math.max(0, (n - start) / fadeIn);
      if (fadeOut > 0 && n > end - fadeOut) g *= Math.max(0, (end - n) / fadeOut);
      return g;
    },
  };
}
