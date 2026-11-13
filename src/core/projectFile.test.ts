import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitClips } from './commands/clips.ts';
import { addMarker } from './commands/tracks.ts';
import { checkInvariants } from './invariants.ts';
import { parseProject, ProjectFileError, SCHEMA_VERSION, serializeProject } from './projectFile.ts';
import { ctxFor, project } from './testkit.ts';
import { TICKS_PER_SECOND } from './time.ts';

describe('project file', () => {
  it('saves and loads to a deep-equal project', () => {
    let p = project({ V1: [['a', 0, 100, 5, { linkId: 'L' }]], A1: [['b', 0, 100, 5, { linkId: 'L' }]], C1: [['c', 10, 20]] });
    p = splitClips(p, ctxFor(), { at: 40 }).apply(p);
    p = addMarker(p, ctxFor('k'), { time: 7, name: 'Here' }).apply(p);
    const text = serializeProject(p);
    expect(JSON.parse(text)).toMatchObject({ app: 'cutline', schema: SCHEMA_VERSION });
    expect(parseProject(text)).toEqual(p);
    expect(serializeProject(parseProject(text))).toBe(text);
  });

  it('migrates the v1 fixture', () => {
    const p = parseProject(fs.readFileSync('fixtures/projects/v1.cutline', 'utf8'));
    expect(checkInvariants(p)).toEqual([]);
    expect(p.name).toBe('Old holiday cut');
    const seq = p.sequences[0]!;
    expect(p.activeSequenceId).toBe(seq.id);
    expect(seq).toMatchObject({ name: 'Main', width: 1920, fps: { num: 30000, den: 1001 } });
    expect(seq.tracks.map((t) => [t.id, t.kind, t.locked, t.muted])).toEqual([['v1', 'video', false, false], ['a1', 'audio', true, true]]);
    const [c1, c2] = seq.tracks[0]!.clips;
    expect(c1).toMatchObject({ id: 'c1', mediaId: 'm1', start: 0, sourceIn: TICKS_PER_SECOND, duration: 2 * TICKS_PER_SECOND, speed: { num: 1, den: 1 }, linkId: null });
    expect(c1!.video).not.toBeNull();
    expect(c2).toMatchObject({ name: 'Wave', start: 2 * TICKS_PER_SECOND, duration: TICKS_PER_SECOND });
    expect(seq.tracks[1]!.clips[0]!.audio).toEqual({ gain: 0, fadeIn: 0, fadeOut: 0 });
    expect(p.media[0]).toMatchObject({ kind: 'video', video: { width: 1920, fps: { num: 30000, den: 1001 } }, audio: { sampleRate: 48000, channels: 2 } });
    expect(p.media[1]).toMatchObject({ kind: 'audio', video: null, audio: { sampleRate: 44100, channels: 1 } });
    expect(seq.markers).toEqual([{ id: 'k1', time: TICKS_PER_SECOND, duration: 0, name: 'Intro ends', color: 'marker' }]);
    // Migrated projects save in the current format and reload unchanged.
    expect(parseProject(serializeProject(p))).toEqual(p);
  });

  it('fills defaults for fields missing from a current-version file', () => {
    const p = project({ V1: [['a', 0, 10]] });
    const doc = JSON.parse(serializeProject(p));
    delete doc.project.sequences[0].tracks[0].clips[0].effects;
    delete doc.project.sequences[0].tracks[0].pan;
    delete doc.project.sequences[0].markers;
    expect(parseProject(JSON.stringify(doc))).toEqual(p);
  });

  it('gives a plain message for every kind of bad file', () => {
    const bad = (text: string): string => {
      try {
        parseProject(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectFileError);
        return (e as Error).message;
      }
      throw new Error('expected a ProjectFileError');
    };
    expect(bad('not json {')).toMatch(/not a Cutline project/);
    expect(bad('[1,2,3]')).toMatch(/not a Cutline project/);
    expect(bad('{"app":"other","schema":2}')).toMatch(/not a Cutline project/);
    expect(bad('{"app":"cutline"}')).toMatch(/no valid version/);
    expect(bad('{"app":"cutline","schema":999,"project":{}}')).toMatch(/newer version of Cutline/);
    expect(bad('{"app":"cutline","schema":2,"project":{"sequences":"x"}}')).toMatch(/damaged/);
    const overlapping = JSON.parse(serializeProject(project({ V1: [['a', 0, 10], ['b', 20, 10]] })));
    overlapping.project.sequences[0].tracks[0].clips[1].start = 5;
    expect(bad(JSON.stringify(overlapping))).toMatch(/damaged/);
    const broken = JSON.parse(serializeProject(project({ V1: [['a', 0, 10]] })));
    broken.project.sequences[0].tracks[0].clips[0].speed = null;
    expect(bad(JSON.stringify(broken))).toMatch(/damaged/);
    const nan = JSON.parse(serializeProject(project({ V1: [['a', 0, 10]] })));
    nan.project.sequences[0].tracks[0].clips[0].start = 'soon';
    expect(bad(JSON.stringify(nan))).toMatch(/damaged/);
  });
});
