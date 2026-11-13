import { describe, expect, it } from 'vitest';
import { makeSequence } from '../model.ts';
import { ctxFor, layout, lock, project, testMedia } from '../testkit.ts';
import { run } from '../testrun.ts';
import {
  addMarker, addMedia, addSequence, addTrack, moveTrack, removeMarker, removeMedia, removeTrack, setProjectProps, setRange, setSequenceProps,
  setTrackProps, updateMarker, updateMedia,
} from './tracks.ts';

const ctx = () => ctxFor('n');
const names = (p: ReturnType<typeof project>): string[] => p.sequences[0]!.tracks.map((t) => t.name);

describe('tracks', () => {
  const p = project({ V1: [['a', 0, 10]], V2: [], A1: [['x', 0, 10]] });

  it('adds tracks with a sensible name at an index or at the end', () => {
    expect(names(run(p, addTrack(p, ctx(), { kind: 'video' })))).toEqual(['V1', 'V2', 'A1', 'V3']);
    expect(names(run(p, addTrack(p, ctx(), { kind: 'audio', index: 0 })))).toEqual(['A2', 'V1', 'V2', 'A1']);
    expect(names(run(p, addTrack(p, ctx(), { kind: 'caption', name: 'Subs', index: 99 })))).toEqual(['V1', 'V2', 'A1', 'Subs']);
  });

  it('removes a track with its clips and restores both on undo', () => {
    const q = run(p, removeTrack(p, ctx(), 'V1'));
    expect(layout(q)).toEqual({ V2: [], A1: [['x', 0, 10, 0]] });
    expect(() => removeTrack(lock(p, 'V1'), ctx(), 'V1')).toThrow(/locked/);
    expect(() => removeTrack(p, ctx(), 'zz')).toThrow(/not found/);
  });

  it('reorders tracks, clamping the index', () => {
    expect(names(run(p, moveTrack(p, ctx(), 'V1', 2)))).toEqual(['V2', 'A1', 'V1']);
    expect(names(run(p, moveTrack(p, ctx(), 'A1', -5)))).toEqual(['A1', 'V1', 'V2']);
    expect(names(run(p, moveTrack(p, ctx(), 'V1', 99)))).toEqual(['V2', 'A1', 'V1']);
    expect(moveTrack(p, ctx(), 'V2', 1).isEmpty).toBe(true);
  });

  it('sets lock, mute, solo, hide, name, volume and pan', () => {
    const q = run(p, setTrackProps(p, ctx(), 'A1', { locked: true, muted: true, solo: true, hidden: true, name: 'Dialogue', volume: -6, pan: 0.5 }));
    expect(q.sequences[0]!.tracks[2]).toMatchObject({ locked: true, muted: true, solo: true, hidden: true, name: 'Dialogue', volume: -6, pan: 0.5 });
    // A locked track can still be unlocked.
    const r = run(q, setTrackProps(q, ctx(), 'A1', { locked: false }));
    expect(r.sequences[0]!.tracks[2]!.locked).toBe(false);
    expect(setTrackProps(p, ctx(), 'A1', { muted: false }).isEmpty).toBe(true);
  });
});

describe('markers', () => {
  const p = project({ V1: [] });

  it('adds, updates and removes markers, kept sorted by time', () => {
    let q = run(p, addMarker(p, ctx(), { time: 50, name: 'B', id: 'mB' }));
    q = run(q, addMarker(q, ctx(), { time: 10, name: 'A', id: 'mA' }));
    expect(q.sequences[0]!.markers.map((m) => m.name)).toEqual(['A', 'B']);
    q = run(q, updateMarker(q, ctx(), 'mA', { time: 80, name: 'A2', duration: 5 }));
    expect(q.sequences[0]!.markers.map((m) => [m.name, m.time, m.duration])).toEqual([['B', 50, 0], ['A2', 80, 5]]);
    q = run(q, updateMarker(q, ctx(), 'mA', { time: -20 }));
    expect(q.sequences[0]!.markers[0]).toMatchObject({ id: 'mA', time: 0 });
    q = run(q, removeMarker(q, ctx(), 'mB'));
    expect(q.sequences[0]!.markers).toHaveLength(1);
  });

  it('rejects bad markers', () => {
    expect(() => addMarker(p, ctx(), { time: -1 })).toThrow(/before the start/);
    expect(() => removeMarker(p, ctx(), 'zz')).toThrow(/not found/);
    expect(() => updateMarker(p, ctx(), 'zz', { name: 'x' })).toThrow(/not found/);
  });
});

describe('sequence, media and project', () => {
  const p = project({ V1: [['a', 0, 10]] });

  it('sets and clears the in/out range, ordering the points', () => {
    const q = run(p, setRange(p, ctx(), 30, 10));
    expect(q.sequences[0]).toMatchObject({ inPoint: 10, outPoint: 30 });
    expect(run(q, setRange(q, ctx(), null, null)).sequences[0]).toMatchObject({ inPoint: null, outPoint: null });
    expect(() => setRange(p, ctx(), 5, 5)).toThrow(/same time/);
    expect(() => setRange(p, ctx(), -5, null)).toThrow();
  });

  it('changes sequence format and rejects nonsense', () => {
    const q = run(p, setSequenceProps(p, ctx(), { width: 1080, height: 1920, fps: { num: 30000, den: 1001 }, name: 'Vertical' }));
    expect(q.sequences[0]).toMatchObject({ width: 1080, height: 1920, name: 'Vertical' });
    expect(() => setSequenceProps(p, ctx(), { width: 0 })).toThrow();
  });

  it('adds, relinks and removes media; refuses to remove media in use', () => {
    let q = run(p, addMedia(p, ctx(), [testMedia('m2', 500), testMedia('m0', 300, 'audio')]));
    expect(q.media.map((m) => m.id)).toEqual(['m', 'm0', 'm2']);
    q = run(q, updateMedia(q, ctx(), 'm2', { path: '/new/place.mp4' }));
    expect(q.media[2]!.path).toBe('/new/place.mp4');
    q = run(q, removeMedia(q, ctx(), 'm0'));
    expect(q.media).toHaveLength(2);
    expect(() => removeMedia(q, ctx(), 'm')).toThrow(/is used in a sequence/);
    expect(() => removeMedia(q, ctx(), 'zz')).toThrow(/not found/);
    expect(() => updateMedia(q, ctx(), 'm', { duration: 5 })).toThrow(/source media/);
    expect(() => addMedia(q, ctx(), [testMedia('m', 5)])).toThrow();
  });

  it('adds a sequence and switches the active one', () => {
    let q = run(p, addSequence(p, ctx(), makeSequence('s2', { name: 'Second' })));
    q = run(q, setProjectProps(q, ctx(), { activeSequenceId: 's2', name: 'Renamed' }));
    expect(q).toMatchObject({ activeSequenceId: 's2', name: 'Renamed' });
    expect(() => setProjectProps(p, ctx(), { activeSequenceId: 'nope' })).toThrow();
  });
});
