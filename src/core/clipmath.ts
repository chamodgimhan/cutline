// Pure single-clip geometry: resizing either edge, splitting, slipping, and the
// media handle available on each side. Speed, reverse and freeze are handled here.
import { clipEnd, shiftKeyframes, sourceLimit, sourceSpan, type Clip, type Id, type Project } from './model.ts';
import { mulDiv, type Tick } from './time.ts';

/** True when the clip has no finite source to run out of (text, image, adjustment, caption, freeze). */
export const isUnbounded = (p: Project, c: Clip): boolean => c.freeze || sourceLimit(p, c) === Infinity;

/** Longest duration whose source span fits in `avail` source ticks. */
function maxDuration(c: Clip, avail: number): number {
  if (avail === Infinity) return Infinity;
  if (avail < 0) return 0;
  return mulDiv(avail + 1, c.speed.den, c.speed.num, 'ceil') - 1;
}

/** How many ticks the clip start may move earlier before running out of media. */
export function headRoom(p: Project, c: Clip): number {
  if (isUnbounded(p, c)) return Infinity;
  if (c.reverse) return maxDuration(c, sourceLimit(p, c) - c.sourceIn) - c.duration;
  return mulDiv(c.sourceIn, c.speed.den, c.speed.num, 'floor');
}

/** How many ticks the clip end may move later before running out of media. */
export function tailRoom(p: Project, c: Clip): number {
  if (isUnbounded(p, c)) return Infinity;
  if (c.reverse) return maxDuration(c, c.sourceIn + sourceSpan(c, c.duration)) - c.duration;
  return maxDuration(c, sourceLimit(p, c) - c.sourceIn) - c.duration;
}

function clampFades(c: Clip): Clip {
  if (!c.audio) return c;
  const fadeIn = Math.min(c.audio.fadeIn, c.duration);
  const fadeOut = Math.min(c.audio.fadeOut, c.duration - fadeIn);
  return fadeIn === c.audio.fadeIn && fadeOut === c.audio.fadeOut ? c : { ...c, audio: { ...c.audio, fadeIn, fadeOut } };
}

/** Move the clip start to `newStart`, keeping the end and the content in place. */
export function resizeHead(p: Project, c: Clip, newStart: Tick): Clip {
  const d = newStart - c.start;
  if (d === 0) return c;
  const duration = c.duration - d;
  let sourceIn = c.sourceIn;
  if (!isUnbounded(p, c) && !c.reverse) {
    sourceIn += d > 0 ? sourceSpan(c, d) : -mulDiv(-d, c.speed.num, c.speed.den, 'ceil');
  }
  return clampFades(shiftKeyframes({ ...c, start: newStart, duration, sourceIn }, -d));
}

/** Move the clip end to `newEnd`, keeping the start and the content in place. */
export function resizeTail(p: Project, c: Clip, newEnd: Tick): Clip {
  const duration = newEnd - c.start;
  if (duration === c.duration) return c;
  let sourceIn = c.sourceIn;
  if (!isUnbounded(p, c) && c.reverse) sourceIn = c.sourceIn + sourceSpan(c, c.duration) - sourceSpan(c, duration);
  return clampFades({ ...c, duration, sourceIn });
}

/** Split at timeline time `at` (strictly inside the clip). The right part gets `rightId`. */
export function splitClipAt(p: Project, c: Clip, at: Tick, rightId: Id): [Clip, Clip] {
  if (at <= c.start || at >= clipEnd(c)) throw new Error('splitClipAt: time outside clip');
  const left = resizeTail(p, c, at);
  const right = resizeHead(p, { ...c, id: rightId }, at);
  return [
    { ...left, transitionOut: null, audio: left.audio && { ...left.audio, fadeOut: 0 } },
    { ...right, transitionIn: null, audio: right.audio && { ...right.audio, fadeIn: 0 } },
  ];
}

/** Largest slip in each direction, in source ticks: [min, max] for the delta applied to sourceIn. */
export function slipRange(p: Project, c: Clip): [number, number] {
  if (sourceLimit(p, c) === Infinity) return [0, 0];
  const span = sourceSpan(c, c.duration);
  return [-c.sourceIn, sourceLimit(p, c) - span - c.sourceIn];
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
