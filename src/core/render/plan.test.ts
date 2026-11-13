import { describe, expect, it } from 'vitest';
import { editKey, evalParam, flatten, makeKey, moveKey, removeKey, setKey, setValueAt } from '../keyframes.ts';
import { defaultVideoProps, type Clip, type Param, type Project } from '../model.ts';
import { project, testMedia } from '../testkit.ts';
import { applyAffine, clipSourceTime, fitBox, invertAffine, planFrame } from './plan.ts';

const near = (a: number[], b: number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i] as number, 6));
const withVideo = (extra: Partial<NonNullable<Clip['video']>>): Partial<Clip> => ({ video: { ...defaultVideoProps(), ...extra } });

function proj(tracks: Parameters<typeof project>[0], media = testMedia('m', 1000)): Project {
  const p = project(tracks);
  p.media = [media, testMedia('img', 0, 'image')];
  p.sequences[0] = { ...p.sequences[0]!, width: 1920, height: 1080 };
  return p;
}

describe('keyframes', () => {
  const keys = (list: [number, number, ('linear' | 'hold' | 'bezier')?][]): Param => ({ keys: list.map(([t, v, i]) => makeKey(t, v, i)) });

  it('evaluates constants, and holds outside the keyed range', () => {
    expect(evalParam(0.4, 123)).toBe(0.4);
    const p = keys([[10, 1], [20, 3]]);
    expect([evalParam(p, 0), evalParam(p, 10), evalParam(p, 20), evalParam(p, 99)]).toEqual([1, 1, 3, 3]);
    expect(evalParam({ keys: [] }, 5)).toBe(0);
  });

  it('interpolates linear and hold', () => {
    const p = keys([[0, 0], [10, 10, 'hold'], [20, 50], [30, 0]]);
    expect(evalParam(p, 5)).toBe(5);
    expect(evalParam(p, 10)).toBe(10);
    expect(evalParam(p, 19)).toBe(10);
    expect(evalParam(p, 20)).toBe(50);
    expect(evalParam(p, 25)).toBe(25);
  });

  it('interpolates bezier: default handles ease, flat handles overshoot nothing, value handles bend the curve', () => {
    const ease = keys([[0, 0, 'bezier'], [100, 100]]);
    expect(evalParam(ease, 50)).toBeCloseTo(50, 6);
    expect(evalParam(ease, 25)).toBeLessThan(25); // flat handles ease in and out
    expect(evalParam(ease, 25) + evalParam(ease, 75)).toBeCloseTo(100, 6);
    const straight: Param = { keys: [{ ...makeKey(0, 0, 'bezier'), out: [1 / 3, 100 / 3] }, { ...makeKey(100, 100), in: [1 / 3, -100 / 3] }] };
    expect(evalParam(straight, 25)).toBeCloseTo(25, 6);
    const slowIn: Param = { keys: [{ ...makeKey(0, 0, 'bezier'), out: [0.8, 0] }, { ...makeKey(100, 100), in: [0.2, 0] }] };
    expect(evalParam(slowIn, 50)).toBeLessThan(25);
    expect(evalParam(slowIn, 100)).toBe(100);
    const bulge: Param = { keys: [{ ...makeKey(0, 0, 'bezier'), out: [1 / 3, 60] }, { ...makeKey(90, 0), in: [1 / 3, 60] }] };
    expect(evalParam(bulge, 45)).toBeCloseTo(45, 6); // 0.75 * 60
    // Monotonic in time for any legal handles.
    let prev = -Infinity;
    for (let t = 0; t <= 100; t++) {
      const v = evalParam(slowIn, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('edits between keyframes: set, move, remove, change mode', () => {
    let p: Param = 5;
    expect(setValueAt(p, 10, 7)).toBe(7);
    p = setKey(p, 10, 1);
    p = setKey(p, 30, 3);
    p = setKey(p, 20, 9); // inserted between two keys
    expect((p as { keys: { t: number }[] }).keys.map((k) => k.t)).toEqual([10, 20, 30]);
    expect([evalParam(p, 15), evalParam(p, 25)]).toEqual([5, 6]);
    p = setValueAt(p, 20, 2); // editing at an existing key replaces its value
    expect(evalParam(p, 20)).toBe(2);
    p = setValueAt(p, 25, 8); // editing between keys adds one there
    expect((p as { keys: unknown[] }).keys).toHaveLength(4);
    p = moveKey(p, 25, 27, 4);
    expect(evalParam(p, 27)).toBe(4);
    expect(moveKey(p, 27, 30)).toBe(p); // cannot land on another key
    p = editKey(p, 10, { interp: 'hold' });
    expect(evalParam(p, 19)).toBe(1);
    p = removeKey(p, 20);
    p = removeKey(p, 27);
    p = removeKey(p, 30);
    expect(removeKey(p, 999)).toBe(p);
    expect(removeKey(p, 10)).toBe(1); // last key collapses to a constant
    expect(flatten(keys([[0, 0], [10, 10]]), 5)).toBe(5);
    // A new key inherits the mode of the key before it.
    expect((setKey(keys([[0, 0, 'hold']]), 5, 1) as { keys: { interp: string }[] }).keys[1]!.interp).toBe('hold');
  });
});

describe('fitBox', () => {
  it('fits, fills, stretches or keeps native size', () => {
    expect(fitBox('fit', 320, 180, 1920, 1080)).toEqual([1920, 1080]);
    expect(fitBox('fit', 180, 320, 1920, 1080)).toEqual([607.5, 1080]);
    near(fitBox('fill', 180, 320, 1920, 1080), [1920, (320 * 1920) / 180]);
    expect(fitBox('stretch', 180, 320, 1920, 1080)).toEqual([1920, 1080]);
    expect(fitBox('none', 180, 320, 1920, 1080)).toEqual([180, 320]);
  });
});

describe('planFrame', () => {
  it('stacks tracks bottom first and skips hidden tracks, disabled clips, gaps and zero opacity', () => {
    const p = proj({ V1: [['a', 0, 10]], V2: [['b', 5, 10]], V3: [['c', 0, 10, 0, { enabled: false }]], V4: [['d', 0, 10, 0, withVideo({ opacity: 0 })]], A1: [['x', 0, 10]] });
    expect(planFrame(p, 7).layers.map((l) => l.clipId)).toEqual(['a', 'b']);
    expect(planFrame(p, 2).layers.map((l) => l.clipId)).toEqual(['a']);
    expect(planFrame(p, 12).layers.map((l) => l.clipId)).toEqual(['b']);
    expect(planFrame(p, 50).layers).toEqual([]);
    p.sequences[0]!.tracks[0]!.hidden = true;
    expect(planFrame(p, 7).layers.map((l) => l.clipId)).toEqual(['b']);
    expect(planFrame(p, 7)).toMatchObject({ width: 1920, height: 1080 });
  });

  it('maps source time through speed, reverse and freeze', () => {
    const p = proj({
      V1: [['a', 10, 20, 100]], V2: [['b', 10, 20, 100, { speed: { num: 2, den: 1 } }]],
      V3: [['c', 10, 20, 100, { reverse: true }]], V4: [['d', 10, 20, 100, { freeze: true }]],
    });
    expect(planFrame(p, 15).layers.map((l) => l.sourceTime)).toEqual([105, 110, 114, 100]);
    expect(planFrame(p, 10).layers.map((l) => l.sourceTime)).toEqual([100, 100, 119, 100]);
    expect(planFrame(p, 29).layers.map((l) => l.sourceTime)).toEqual([119, 138, 100, 100]);
    expect(planFrame(p, 15).layers[0]!.localTime).toBe(5);
    const c = p.sequences[0]!.tracks[2]!.clips[0]!;
    expect(clipSourceTime(c, 20)).toBe(100);
  });

  it('places a fitted clip over the whole frame by default', () => {
    const l = planFrame(proj({ V1: [['a', 0, 10]] }), 0).layers[0]!;
    near(l.matrix, [1920, 0, 0, 1080, 0, 0]);
    expect(l.uv).toEqual([0, 0, 1, 1]);
    expect([l.opacity, l.blend, l.rotation, l.kind]).toEqual([1, 'normal', 0, 'media']);
  });

  it('applies position, scale, rotation about the anchor, and crop', () => {
    const corners = (extra: Partial<NonNullable<Clip['video']>>): number[][] => {
      const l = planFrame(proj({ V1: [['a', 0, 10, 0, withVideo(extra)]] }), 0).layers[0]!;
      return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => applyAffine(l.matrix, u!, v!));
    };
    near(corners({ x: 100, y: -50 }).flat(), [100, -50, 2020, -50, 2020, 1030, 100, 1030]);
    near(corners({ scale: 0.5 }).flat(), [480, 270, 1440, 270, 1440, 810, 480, 810]);
    // 90 degrees clockwise about the centre: the top-left corner goes to the top-right of the turned picture.
    near(corners({ rotation: 90 }).flat(), [1500, -420, 1500, 1500, 420, 1500, 420, -420]);
    // Anchor at the top-left: scaling pins that corner.
    near(corners({ scale: 0.5, anchorX: 0, anchorY: 0 }).flat(), [0, 0, 960, 0, 960, 540, 0, 540]);
    // Changing only the anchor does not move the layer.
    near(corners({ anchorX: 1, anchorY: 0.25 }).flat(), [0, 0, 1920, 0, 1920, 1080, 0, 1080]);
    // Crop removes edges in place: the remaining picture does not move.
    const cropped = planFrame(proj({ V1: [['a', 0, 10, 0, withVideo({ crop: { left: 0.25, top: 0, right: 0.25, bottom: 0.5 } })]] }), 0).layers[0]!;
    near([...applyAffine(cropped.matrix, 0, 0), ...applyAffine(cropped.matrix, 1, 1)], [480, 0, 1440, 540]);
    expect(cropped.uv).toEqual([0.25, 0, 0.75, 0.5]);
    expect(planFrame(proj({ V1: [['a', 0, 10, 0, withVideo({ crop: { left: 0.5, top: 0, right: 0.5, bottom: 0 } })]] }), 0).layers).toEqual([]);
  });

  it('fits rotated and odd-shaped media to the sequence', () => {
    const tall = testMedia('m', 1000);
    tall.video = { ...tall.video!, rotation: 90 };
    const l = planFrame(proj({ V1: [['a', 0, 10]] }, tall), 0).layers[0]!;
    expect(l.rotation).toBe(90);
    near(l.matrix, [607.5, 0, 0, 1080, (1920 - 607.5) / 2, 0]);
    const fill = planFrame(proj({ V1: [['a', 0, 10, 0, withVideo({ fit: 'fill' })]] }, tall), 0).layers[0]!;
    near([fill.matrix[0], fill.matrix[3]], [1920, (320 * 1920) / 180]);
  });

  it('evaluates keyframed properties at the clip-local time, and shows images at source time zero', () => {
    const opacity: Param = { keys: [makeKey(0, 0), makeKey(10, 1)] };
    const p = proj({ V1: [['a', 100, 20, 0, withVideo({ opacity })]], V2: [['i', 100, 20, 0, { mediaId: 'img' }]] });
    expect(planFrame(p, 105).layers[0]!.opacity).toBe(0.5);
    expect(planFrame(p, 100).layers.map((l) => l.clipId)).toEqual(['i']);
    expect(planFrame(p, 115).layers[1]!).toMatchObject({ clipId: 'i', sourceTime: 0 });
  });

  it('inverts affine maps', () => {
    const m = planFrame(proj({ V1: [['a', 0, 10, 0, withVideo({ rotation: 30, scale: 0.7, x: 40, y: 9 })]] }), 0).layers[0]!.matrix;
    const inv = invertAffine(m)!;
    const [x, y] = applyAffine(m, 0.3, 0.8);
    near(applyAffine(inv, x, y), [0.3, 0.8]);
    expect(invertAffine([0, 0, 0, 0, 5, 5])).toBeNull();
  });
});
