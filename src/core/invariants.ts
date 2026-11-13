// Model invariants. Returned as plain messages; an empty list means the project is valid.
import { clipEnd, clipSourceOut, sourceLimit, TRACK_ACCEPTS, type Project, type Track } from './model.ts';

const isTick = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

export function checkInvariants(p: Project): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const uniq = (id: string, what: string): void => {
    if (ids.has(id)) errors.push(`duplicate id ${id} (${what})`);
    ids.add(id);
  };
  for (const m of p.media) {
    uniq(m.id, 'media');
    if (!isTick(m.duration) || m.duration < 0) errors.push(`media ${m.id}: bad duration`);
  }
  if (!p.sequences.some((s) => s.id === p.activeSequenceId)) errors.push('active sequence missing');
  for (const seq of p.sequences) {
    uniq(seq.id, 'sequence');
    if (seq.fps.num <= 0 || seq.fps.den <= 0 || seq.width <= 0 || seq.height <= 0 || seq.sampleRate <= 0) errors.push(`sequence ${seq.id}: bad format`);
    for (const pt of [seq.inPoint, seq.outPoint]) if (pt !== null && (!isTick(pt) || pt < 0)) errors.push(`sequence ${seq.id}: bad in/out point`);
    if (seq.inPoint !== null && seq.outPoint !== null && seq.outPoint <= seq.inPoint) errors.push(`sequence ${seq.id}: out point before in point`);
    for (const mk of seq.markers) {
      uniq(mk.id, 'marker');
      if (!isTick(mk.time) || mk.time < 0 || !isTick(mk.duration) || mk.duration < 0) errors.push(`marker ${mk.id}: negative or fractional time`);
    }
    for (const track of seq.tracks) {
      uniq(track.id, 'track');
      let prevEnd = 0;
      for (const c of track.clips) {
        uniq(c.id, 'clip');
        const at = `clip ${c.id}`;
        if (![c.start, c.duration, c.sourceIn].every(isTick)) errors.push(`${at}: non-integer time`);
        if (c.start < 0 || c.sourceIn < 0) errors.push(`${at}: negative time`);
        if (c.duration <= 0) errors.push(`${at}: zero or negative duration`);
        if (c.start < prevEnd) errors.push(`${at}: overlaps or is out of order on track ${track.id}`);
        prevEnd = Math.max(prevEnd, clipEnd(c));
        if (c.speed.num <= 0 || c.speed.den <= 0) errors.push(`${at}: bad speed`);
        if (!TRACK_ACCEPTS[track.kind].includes(c.kind)) errors.push(`${at}: ${c.kind} clip on ${track.kind} track`);
        if (c.mediaId !== null) {
          if (!p.media.some((m) => m.id === c.mediaId)) errors.push(`${at}: media ${c.mediaId} missing from pool`);
          else if (clipSourceOut(c) > sourceLimit(p, c)) errors.push(`${at}: source range runs past the end of its media`);
        }
        if (c.audio && (c.audio.fadeIn < 0 || c.audio.fadeOut < 0)) errors.push(`${at}: negative fade`);
      }
    }
  }
  return errors;
}

/** Locked tracks present in both projects must be identical apart from the lock flag itself. */
export function lockedTracksUnchanged(before: Project, after: Project): string[] {
  const errors: string[] = [];
  for (const seq of before.sequences) {
    const next = after.sequences.find((s) => s.id === seq.id);
    for (const t of seq.tracks) {
      if (!t.locked) continue;
      const u: Track | undefined = next?.tracks.find((x) => x.id === t.id);
      if (!u) {
        errors.push(`locked track ${t.id} was removed`);
        continue;
      }
      if (u.clips !== t.clips && JSON.stringify(u.clips) !== JSON.stringify(t.clips)) errors.push(`locked track ${t.id} changed`);
    }
  }
  return errors;
}
