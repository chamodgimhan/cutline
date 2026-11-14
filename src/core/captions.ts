// Captions: SRT and WebVTT reading and writing, cue timing rules, and cue edits.
// On the timeline a cue is a clip of kind 'caption', so it moves, trims and ripples like any clip.
import { EditError, type Command } from './command.ts';
import { Draft, type EditCtx } from './draft.ts';
import { clipEnd, defaultTextProps, makeClip, type Clip, type Id, type Project, type TextProps } from './model.ts';
import { TICKS_PER_SECOND, type Tick } from './time.ts';

export interface Cue {
  start: Tick;
  end: Tick;
  text: string;
}

const MS = TICKS_PER_SECOND / 1000; // ticks per millisecond: exact, so file times round-trip
/** Shortest cue kept on import and allowed by cue edits. */
export const MIN_CUE = TICKS_PER_SECOND / 5;

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;
const ARROW = new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`);

function toTick(h: string | undefined, m: string, s: string, frac: string): Tick {
  return ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * TICKS_PER_SECOND + Number(frac.padEnd(3, '0')) * MS;
}

function stamp(t: Tick, sep: ',' | '.'): string {
  const ms = Math.round(t / MS);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

/**
 * Parse SRT or WebVTT. Tolerant: missing or wrong cue numbers, either decimal separator,
 * missing hours, stray blank lines, a byte-order mark, NOTE/STYLE/REGION blocks and cue
 * settings are all accepted. Blocks without a valid time line, with no text, or with an end
 * not after the start are skipped. Throws only when nothing usable is found.
 */
export function parseCaptions(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0 || /^(NOTE|STYLE|REGION)\b/.test((lines[0] ?? '').trim())) continue;
    const m = ARROW.exec(lines[at] as string) as RegExpExecArray;
    const start = toTick(m[1], m[2] as string, m[3] as string, m[4] as string);
    const end = toTick(m[5], m[6] as string, m[7] as string, m[8] as string);
    const body = lines.slice(at + 1).join('\n').replace(/\s+$/, '');
    if (end > start && body.trim()) cues.push({ start, end, text: body });
  }
  if (cues.length === 0) throw new EditError('No captions were found in that file. It should be an SRT or WebVTT file.');
  return cues;
}

export function serialiseSrt(cues: readonly Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function serialiseVtt(cues: readonly Cue[]): string {
  // A cue body may not contain "-->"; a blank line would end the cue.
  return 'WEBVTT\n\n' + cues.map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text.replace(/-->/g, '->').replace(/\n\s*\n/g, '\n')}\n`).join('\n');
}

/**
 * Apply the timing rules: sorted by start, no overlap (an earlier cue ends where the next one
 * starts), and no cue shorter than `min` (it is lengthened into the gap after it when there
 * is room, otherwise dropped).
 */
export function fitCues(cues: readonly Cue[], min: Tick = MIN_CUE): Cue[] {
  const sorted = cues.filter((c) => c.end > c.start && c.start >= 0).map((c) => ({ ...c })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Cue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i] as Cue;
    const prev = out[out.length - 1];
    if (prev && c.start < prev.end) c.start = Math.min(prev.end, c.end); // an overlapping cue waits for the one before it
    const next = sorted[i + 1];
    const limit = next ? Math.max(next.start, c.start) : Infinity;
    c.end = Math.min(c.end, Math.max(limit, c.start));
    if (c.end - c.start < min) c.end = Math.min(c.start + min, limit);
    if (c.end - c.start >= min) out.push(c);
  }
  return out;
}

export const captionStyle = (): TextProps => ({ ...defaultTextProps(), size: 44, weight: 400, valign: 'bottom', boxColor: '#000000b3', boxPadding: 10 });

/** Cues of a caption track, in order. */
export function trackCues(p: Project, trackId: Id, seqId?: Id): Cue[] {
  const seq = p.sequences.find((s) => s.id === (seqId ?? p.activeSequenceId));
  const track = seq?.tracks.find((t) => t.id === trackId && t.kind === 'caption');
  if (!track) throw new EditError('Choose a caption track first.');
  return track.clips.map((c) => ({ start: c.start, end: clipEnd(c), text: c.text?.text ?? '' }));
}

/** Put cues on a caption track, replacing whatever they land on. Timing rules are applied first. */
export function importCues(p: Project, ctx: EditCtx, trackId: Id, cues: readonly Cue[], style: TextProps = captionStyle()): Command {
  const d = new Draft(p, ctx);
  if (d.track(trackId).kind !== 'caption') throw new EditError('Captions can only go on a caption track.');
  const fitted = fitCues(cues);
  if (fitted.length === 0) throw new EditError('None of the captions in that file are long enough to use.');
  d.clearRange(trackId, (fitted[0] as Cue).start, (fitted[fitted.length - 1] as Cue).end);
  for (const c of fitted) d.put(trackId, makeClip({ id: ctx.newId(), kind: 'caption', start: c.start, duration: c.end - c.start, text: { ...style, text: c.text } }));
  return d.build('Import captions');
}

/** Split a cue in two at `at`. The text divides at `textAt` (a character index), or at the word nearest the middle. */
export function splitCue(p: Project, ctx: EditCtx, args: { id: Id; at: Tick; textAt?: number }): Command {
  const d = new Draft(p, ctx);
  const { track, clip } = d.need(args.id);
  if (clip.kind !== 'caption' || !clip.text) throw new EditError('Select a caption to split.');
  if (args.at - clip.start < MIN_CUE || clipEnd(clip) - args.at < MIN_CUE) throw new EditError('Both halves of a split caption must be at least 0.2 seconds long.');
  const text = clip.text.text;
  let cut = args.textAt;
  if (cut === undefined) {
    const spaces = [...text.matchAll(/\s+/g)].map((m) => m.index);
    cut = spaces.length ? spaces.reduce((best, i) => (Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2) ? i : best)) : text.length;
  }
  const left: Clip = { ...clip, duration: args.at - clip.start, text: { ...clip.text, text: text.slice(0, cut).trim() } };
  const right: Clip = { ...clip, id: ctx.newId(), start: args.at, duration: clipEnd(clip) - args.at, text: { ...clip.text, text: text.slice(cut).trim() } };
  d.put(track.id, left);
  d.put(track.id, right);
  return d.build('Split caption');
}

/** Merge captions on one track into a single cue from the first start to the last end. */
export function mergeCues(p: Project, ctx: EditCtx, ids: readonly Id[]): Command {
  const d = new Draft(p, ctx);
  const hits = ids.map((id) => d.need(id)).sort((a, b) => a.clip.start - b.clip.start);
  const first = hits[0];
  if (hits.length < 2 || !first || hits.some((h) => h.clip.kind !== 'caption' || h.track.id !== first.track.id)) throw new EditError('Select two or more captions on the same track to merge.');
  const picked = new Set(ids);
  const end = Math.max(...hits.map((h) => clipEnd(h.clip)));
  if (d.clips(first.track.id).some((c) => !picked.has(c.id) && c.start >= first.clip.start && c.start < end)) throw new EditError('There is another caption between the ones selected.');
  for (const h of hits.slice(1)) d.remove(h.clip.id);
  d.put(first.track.id, { ...first.clip, duration: end - first.clip.start, text: { ...(first.clip.text ?? captionStyle()), text: hits.map((h) => h.clip.text?.text ?? '').filter(Boolean).join('\n') } });
  return d.build('Merge captions');
}

/** Speech-to-text is supplied by a provider. None ships with Cutline; with none set, the app shows no control for it. */
export interface SpeechProvider {
  name: string;
  transcribe(audio: { sampleRate: number; channels: Float32Array[] }, onProgress?: (fraction: number) => void): Promise<Cue[]>;
}
