import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captionStyle, fitCues, importCues, mergeCues, MIN_CUE, parseCaptions, serialiseSrt, serialiseVtt, splitCue, trackCues, type Cue } from './captions.ts';
import { moveClips } from './commands/clips.ts';
import { rippleDelete } from './commands/range.ts';
import { rippleTrim, trimClip } from './commands/trim.ts';
import { planFrame } from './render/plan.ts';
import { ctxFor, layout, project } from './testkit.ts';
import { run } from './testrun.ts';
import { TICKS_PER_SECOND as S } from './time.ts';

const read = (name: string): string => fs.readFileSync(`fixtures/captions/${name}`, 'utf8');
const sec = (cues: Cue[]): [number, number, string][] => cues.map((c) => [c.start / S, c.end / S, c.text]);

describe('SRT and WebVTT', () => {
  it('round-trips well-formed files byte for byte', () => {
    const srt = read('good.srt');
    expect(serialiseSrt(parseCaptions(srt))).toBe(srt);
    const vtt = read('good.vtt');
    expect(serialiseVtt(parseCaptions(vtt))).toBe(vtt);
    expect(sec(parseCaptions(srt))).toEqual([[1, 2.5, 'Hello there.'], [2.5, 4.04, 'Two lines\nin this one.'], [3723.004, 3725, '<i>Italic</i> tags and — punctuation, kept as is.']]);
  });

  it('converts between the formats without losing a cue, a millisecond or a character', () => {
    const cues = parseCaptions(read('good.srt'));
    expect(parseCaptions(serialiseVtt(cues))).toEqual(cues);
    expect(parseCaptions(serialiseSrt(parseCaptions(read('good.vtt'))))).toEqual(cues);
    expect(serialiseVtt(cues)).toBe(read('good.vtt'));
  });

  it('reads malformed SRT, keeps every usable cue, and what it writes reads back the same', () => {
    const cues = parseCaptions(read('malformed.srt'));
    expect(sec(cues)).toEqual([
      [1, 2.5, 'Dot separators, short fractions and CRLF.'],
      [3, 4, 'No hours, a bad number and trailing settings.'],
      [12, 13, 'No spaces around the arrow.'],
    ]);
    expect(parseCaptions(serialiseSrt(cues))).toEqual(cues);
    expect(parseCaptions(serialiseVtt(cues))).toEqual(cues);
  });

  it('skips WebVTT notes, styles, cue names and settings', () => {
    const cues = parseCaptions(read('extras.vtt'));
    expect(sec(cues)).toEqual([[1, 2, '<v Speaker>Voice tag kept.'], [2, 3, 'Plain cue.']]);
    expect(parseCaptions(serialiseVtt(cues))).toEqual(cues);
  });

  it('keeps text that would break the format readable', () => {
    const odd: Cue[] = [{ start: 0, end: S, text: 'a --> b\n\nafter a blank line' }];
    expect(parseCaptions(serialiseVtt(odd))[0]!.text).toBe('a -> b\nafter a blank line');
  });

  it('says so when a file holds no captions', () => {
    for (const bad of ['', 'just some text', 'WEBVTT\n\nNOTE nothing here', '1\n00:00:05,000 --> 00:00:01,000\nbackwards']) expect(() => parseCaptions(bad)).toThrow(/No captions were found/);
  });
});

describe('cue timing rules', () => {
  const cue = (a: number, b: number, text = 'x'): Cue => ({ start: a * S, end: b * S, text });

  it('sorts, removes overlap and enforces the minimum duration', () => {
    expect(sec(fitCues([cue(5, 6, 'b'), cue(1, 3, 'a')]))).toEqual([[1, 3, 'a'], [5, 6, 'b']]);
    // Overlap: the earlier cue yields.
    expect(sec(fitCues([cue(1, 4, 'a'), cue(3, 5, 'b')]))).toEqual([[1, 3, 'a'], [3, 5, 'b']]);
    // Too short with room after it: lengthened to the minimum.
    expect(sec(fitCues([cue(1, 1.05, 'a'), cue(4, 5, 'b')]))).toEqual([[1, 1.2, 'a'], [4, 5, 'b']]);
    // Too short with no room: dropped. Same start: the first one has no time left.
    expect(sec(fitCues([cue(1, 1.05, 'a'), cue(1.1, 2, 'b')]))).toEqual([[1.1, 2, 'b']]);
    expect(sec(fitCues([cue(1, 2, 'a'), cue(1, 3, 'b')]))).toEqual([[1, 3, 'b']]);
    expect(fitCues([cue(-1, 2), { start: 5, end: 5, text: 'zero' }])).toEqual([]);
    expect(MIN_CUE).toBe(S / 5);
  });

  it('imports onto a caption track, replacing what is there, and exports the same cues', () => {
    const p = project({ V1: [['v', 0, 10 * S]], C1: [['old', 2 * S, 2 * S]] }, 100 * S);
    const cues = parseCaptions(read('good.srt')).slice(0, 2);
    const q = run(p, importCues(p, ctxFor('c'), 'C1', cues));
    expect(trackCues(q, 'C1')).toEqual(cues);
    expect(q.sequences[0]!.tracks[1]!.clips[0]).toMatchObject({ kind: 'caption', text: { text: 'Hello there.', valign: 'bottom' } });
    expect(() => importCues(p, ctxFor(), 'V1', cues)).toThrow(/caption track/);
    expect(() => trackCues(p, 'V1')).toThrow(/caption track/);
    expect(sec(trackCues(run(p, importCues(p, ctxFor('c'), 'C1', [cue(6, 6.01)])), 'C1'))[1]).toEqual([6, 6.2, 'x']); // a too-short cue is lengthened
    expect(() => importCues(p, ctxFor(), 'C1', [cue(-1, 2)])).toThrow(/long enough/);
  });

  it('splits a cue with its text, and refuses halves that are too short', () => {
    const p = project({ C1: [['c', S, 2 * S, 0, { text: { ...captionStyle(), text: 'one two three four' } }]] });
    const q = run(p, splitCue(p, ctxFor('n'), { id: 'c', at: 2 * S }));
    expect(trackCues(q, 'C1')).toEqual([{ start: S, end: 2 * S, text: 'one two' }, { start: 2 * S, end: 3 * S, text: 'three four' }]);
    const at = run(p, splitCue(p, ctxFor('n'), { id: 'c', at: 2 * S, textAt: 3 }));
    expect(trackCues(at, 'C1').map((c) => c.text)).toEqual(['one', 'two three four']);
    expect(() => splitCue(p, ctxFor(), { id: 'c', at: S + S / 10 })).toThrow(/at least 0.2 seconds/);
  });

  it('merges cues on one track, and refuses when another cue is in between', () => {
    const p = project({ C1: [['a', 0, S, 0, { text: { ...captionStyle(), text: 'A' } }], ['b', 2 * S, S, 0, { text: { ...captionStyle(), text: 'B' } }], ['c', 4 * S, S, 0, { text: { ...captionStyle(), text: 'C' } }]], C2: [['z', 0, S]] });
    expect(trackCues(run(p, mergeCues(p, ctxFor(), ['b', 'a'])), 'C1')).toEqual([{ start: 0, end: 3 * S, text: 'A\nB' }, { start: 4 * S, end: 5 * S, text: 'C' }]);
    expect(() => mergeCues(p, ctxFor(), ['a', 'c'])).toThrow(/another caption between/);
    expect(() => mergeCues(p, ctxFor(), ['a', 'z'])).toThrow(/same track/);
    expect(() => mergeCues(p, ctxFor(), ['a'])).toThrow(/two or more/);
  });

  it('shifts, retimes and ripples with every other edit, never overlapping', () => {
    const p = project({ V1: [['v1', 0, 4 * S], ['v2', 4 * S, 4 * S]], C1: [['a', S, S], ['b', 2 * S, S], ['c', 5 * S, S]] }, 100 * S);
    expect(layout(run(p, moveClips(p, ctxFor(), { ids: ['c'], delta: S }))).C1?.[2]).toEqual(['c', 6 * S, S, 0]);
    expect(layout(run(p, trimClip(p, ctxFor(), { id: 'a', edge: 'out', to: 9 * S }))).C1?.[0]).toEqual(['a', S, S, 0]); // stops at b
    expect(layout(run(p, trimClip(p, ctxFor(), { id: 'c', edge: 'in', to: 0 }))).C1?.[2]).toEqual(['c', 3 * S, 3 * S, 0]);
    expect(layout(run(p, rippleDelete(p, ctxFor(), ['v1']))).C1).toEqual([['a', S, S, 0], ['b', 2 * S, S, 0], ['c', 3 * S, S, 0]]); // b blocks the rest of the gap
    expect(layout(run(p, rippleTrim(p, ctxFor(), { id: 'v1', edge: 'out', to: 6 * S }))).C1?.[2]).toEqual(['c', 7 * S, S, 0]);
  });
});

describe('burned-in captions in the frame plan', () => {
  it('adds the cue under the playhead above the picture, unless the track is hidden or the cue is empty', () => {
    const p = project({ C1: [['a', S, S, 0, { text: { ...captionStyle(), text: 'Hi' } }], ['e', 3 * S, S]], V1: [['v', 0, 10 * S]] });
    const layers = planFrame(p, S + 5).layers;
    expect(layers.map((l) => [l.kind, l.clipId])).toEqual([['media', 'v'], ['text', 'a']]);
    expect(layers[1]!.matrix).toEqual([1920, 0, 0, 1080, 0, 0]);
    expect(planFrame(p, 3 * S + 5).layers).toHaveLength(1);
    expect(planFrame(p, 2 * S + 5).layers).toHaveLength(1);
    p.sequences[0]!.tracks[0]!.hidden = true;
    expect(planFrame(p, S + 5).layers).toHaveLength(1);
  });
});
