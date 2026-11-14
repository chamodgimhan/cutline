import { describe, expect, it } from 'vitest';
import { clipAudio } from './audio/envelope.ts';
import { timeStretch } from './audio/timestretch.ts';
import { freezeFrame, setClipSpeed } from './commands/clips.ts';
import {
  addEffect, changeEffect, curveTable, EFFECTS, effectText, effectValue, makeEffect, moveEffect, parseCube, removeEffect, VIDEO_TRANSITIONS, withTransition,
} from './effects.ts';
import { editKey, evalParam, makeKey } from './keyframes.ts';
import type { Clip, Param } from './model.ts';
import { pictureLayers, planFrame } from './render/plan.ts';
import { ctxFor, layout, lock, project } from './testkit.ts';
import { run } from './testrun.ts';
import { TICKS_PER_SECOND as S } from './time.ts';

const clipOf = (p: ReturnType<typeof project>, id: string): Clip => p.sequences[0]!.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

describe('effects', () => {
  it('defines all eleven effects with defaults inside their ranges', () => {
    expect(EFFECTS.map((e) => e.type)).toEqual(['exposure', 'contrast', 'saturation', 'temperature', 'curves', 'lut', 'blur', 'sharpen', 'vignette', 'chromaKey', 'flip']);
    for (const def of EFFECTS) {
      const e = makeEffect(def.type, 'e1');
      for (const d of def.params) expect(effectValue(e, d.key, 0), `${def.type}.${d.key}`).toBe(d.default);
    }
    expect(effectText(makeEffect('chromaKey', 'k'), 'color')).toBe('#00ff00');
    expect(() => makeEffect('sparkle', 'x')).toThrow(/Unknown effect/);
  });

  it('clamps values to the range and evaluates keyframed parameters', () => {
    const e = makeEffect('exposure', 'e');
    expect(effectValue({ ...e, params: { stops: 99 } }, 'stops', 0)).toBe(4);
    expect(effectValue({ ...e, params: { stops: { keys: [makeKey(0, 0), makeKey(10, 2)] } } }, 'stops', 5)).toBe(1);
    expect(effectValue({ ...e, params: {} }, 'stops', 0)).toBe(0);
  });

  it('adds, removes, changes and reorders a stack without touching the original clip', () => {
    const c = clipOf(project({ V1: [['a', 0, 10]] }), 'a');
    const three = ['exposure', 'blur', 'flip'].reduce((clip, t, i) => addEffect(clip, makeEffect(t, `e${i}`)), c);
    expect(c.effects).toEqual([]);
    expect(three.effects.map((e) => e.type)).toEqual(['exposure', 'blur', 'flip']);
    expect(moveEffect(three, 'e2', -2).effects.map((e) => e.id)).toEqual(['e2', 'e0', 'e1']);
    expect(moveEffect(three, 'e0', 99).effects.map((e) => e.id)).toEqual(['e1', 'e2', 'e0']);
    expect(moveEffect(three, 'e0', -1)).toBe(three);
    expect(removeEffect(three, 'e1').effects.map((e) => e.id)).toEqual(['e0', 'e2']);
    expect(changeEffect(three, 'e1', (e) => ({ ...e, enabled: false })).effects[1]!.enabled).toBe(false);
  });

  it('builds tone curves: identity stays identity, lifted midtones brighten, never overshoots', () => {
    const id = curveTable([0, 0.25, 0.5, 0.75, 1]);
    for (const x of [0, 1, 64, 128, 200, 255]) expect(Math.abs(id[x]! - x)).toBeLessThanOrEqual(1);
    const lifted = curveTable([0, 0.25, 0.8, 0.75, 1]);
    expect(lifted[128]).toBe(204);
    const steep = curveTable([0, 0, 1, 1, 1]);
    for (let x = 1; x < 256; x++) expect(steep[x]!).toBeGreaterThanOrEqual(steep[x - 1]!);
    expect([steep[0], steep[255]]).toEqual([0, 255]);
  });

  it('parses .cube files and explains what is wrong with bad ones', () => {
    const rows = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1'];
    const lut = parseCube(`# made by a grader\nTITLE "Test"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n\n${rows.join('\r\n')}\n`);
    expect(lut.size).toBe(2);
    expect([...lut.data.slice(0, 6)]).toEqual([0, 0, 0, 255, 0, 0]);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/should have 8 colour rows but has 1/);
    expect(() => parseCube('0 0 0\n1 1 1')).toThrow(/valid 3D size/);
    expect(() => parseCube('LUT_1D_SIZE 4\n0 0 0')).toThrow(/1D LUT/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0\n')).toThrow(/not three numbers/);
    expect(() => parseCube('')).toThrow(/valid 3D size/);
  });

  it('edits bezier handles on a key', () => {
    let p: Param = { keys: [makeKey(0, 0, 'bezier'), makeKey(100, 100)] };
    const before = evalParam(p, 25);
    p = editKey(p, 0, { out: [0.9, 0] });
    p = editKey(p, 100, { in: [0.1, 0] });
    expect(evalParam(p, 25)).toBeLessThan(before);
    expect(evalParam(editKey(p, 0, { interp: 'linear' }), 25)).toBe(25);
  });
});

describe('transitions', () => {
  it('accepts the right transition types per clip kind and keeps the duration inside the clip', () => {
    const p = project({ V1: [['v', 0, 100]], A1: [['a', 0, 100]] });
    for (const t of VIDEO_TRANSITIONS) expect(withTransition(clipOf(p, 'v'), 'in', t, 30).transitionIn).toEqual({ type: t, duration: 30, params: {} });
    expect(withTransition(clipOf(p, 'v'), 'out', 'dissolve', 500).transitionOut?.duration).toBe(100);
    expect(withTransition(clipOf(p, 'a'), 'in', 'crossfade', 20).transitionIn?.type).toBe('crossfade');
    expect(() => withTransition(clipOf(p, 'a'), 'in', 'wipe', 20)).toThrow(/cannot be used/);
    expect(() => withTransition(clipOf(p, 'v'), 'in', 'crossfade', 20)).toThrow(/cannot be used/);
    expect(withTransition({ ...clipOf(p, 'v'), transitionIn: { type: 'wipe', duration: 5, params: {} } }, 'in', null, 0).transitionIn).toBeNull();
  });

  it('plans an incoming clip with the outgoing one running on underneath', () => {
    const p = project({ V1: [['a', 0, 100, 50], ['b', 100, 100, 300, { transitionIn: { type: 'dissolve', duration: 40, params: {} } }]] });
    const l = planFrame(p, 110).layers[0]!;
    expect(l).toMatchObject({ clipId: 'b', sourceTime: 310, transition: { type: 'dissolve', progress: 0.25, incoming: true } });
    expect(l.transition!.outgoing).toMatchObject({ clipId: 'a', sourceTime: 160 }); // 10 ticks into a's tail handle
    expect(pictureLayers(planFrame(p, 110)).map((x) => x.clipId)).toEqual(['a', 'b']);
    expect(planFrame(p, 140).layers[0]!.transition).toBeNull();
    expect(planFrame(p, 99).layers[0]).toMatchObject({ clipId: 'a', transition: null });
  });

  it('fades in from nothing when there is no adjoining clip, and out to nothing at the end', () => {
    const p = project({ V1: [['b', 100, 100, 0, { transitionIn: { type: 'dipBlack', duration: 20, params: {} }, transitionOut: { type: 'dissolve', duration: 50, params: {} } }]] });
    expect(planFrame(p, 105).layers[0]!.transition).toEqual({ type: 'dipBlack', progress: 0.25, outgoing: null, incoming: true });
    expect(planFrame(p, 175).layers[0]!.transition).toEqual({ type: 'dissolve', progress: 0.5, outgoing: null, incoming: false });
    expect(planFrame(p, 130).layers[0]!.transition).toBeNull();
  });

  it('crossfades audio with equal power, the outgoing clip playing into its handle', () => {
    const T = S / 48000;
    const p = project({ A1: [['a', 0, 4800 * T, 1000 * T], ['b', 4800 * T, 4800 * T, 20000 * T, { transitionIn: { type: 'crossfade', duration: 960 * T, params: {} } }]] }, 100000 * T);
    const [a, b] = p.sequences[0]!.tracks[0]!.clips.map((c) => clipAudio(p, c, 48000)) as [ReturnType<typeof clipAudio>, ReturnType<typeof clipAudio>];
    expect([a.to, b.from]).toEqual([4800 + 960, 4800]);
    for (const n of [4800, 5000, 5280, 5600, 5759]) expect(a.gainAt(n) ** 2 + b.gainAt(n) ** 2, `n=${n}`).toBeCloseTo(1, 9);
    expect(a.gainAt(4799)).toBe(1);
    expect(b.gainAt(4800)).toBe(0);
    expect(b.gainAt(5760)).toBe(1);
  });
});

describe('speed and freeze', () => {
  const ctx = () => ctxFor('n');

  it('changes length to keep the same source, stopping at the next clip unless rippling', () => {
    const p = project({ V1: [['a', 0, 40, 100], ['b', 60, 20]], A1: [['x', 90, 10]] });
    const fast = run(p, setClipSpeed(p, ctx(), { id: 'a', speed: { num: 2, den: 1 } }));
    expect(layout(fast).V1).toEqual([['a', 0, 20, 100], ['b', 60, 20, 0]]);
    expect(clipOf(fast, 'a').speed).toEqual({ num: 2, den: 1 });
    const slow = run(p, setClipSpeed(p, ctx(), { id: 'a', speed: { num: 1, den: 2 } }));
    expect(layout(slow).V1?.[0]).toEqual(['a', 0, 60, 100]); // wanted 80, stopped by b
    const rippled = run(p, setClipSpeed(p, ctx(), { id: 'a', speed: { num: 1, den: 2 }, ripple: true }));
    expect(layout(rippled)).toEqual({ V1: [['a', 0, 80, 100], ['b', 100, 20, 0]], A1: [['x', 130, 10, 0]] });
    const back = run(p, setClipSpeed(p, ctx(), { id: 'a', speed: { num: 2, den: 1 }, ripple: true, reverse: true, pitchKeep: true }));
    expect(layout(back).V1).toEqual([['a', 0, 20, 100], ['b', 40, 20, 0]]);
    expect(clipOf(back, 'a')).toMatchObject({ reverse: true, pitchKeep: true });
  });

  it('keeps linked audio in step, rounds to frames, and rejects silly speeds and locked tracks', () => {
    const p = project({ V1: [['v', 0, 90, 0, { linkId: 'L' }]], A1: [['a', 0, 90, 0, { linkId: 'L' }]] });
    const q = run(p, setClipSpeed(p, ctx(), { id: 'v', speed: { num: 4, den: 1 }, frame: 10 }));
    expect(layout(q)).toEqual({ V1: [['v', 0, 20, 0]], A1: [['a', 0, 20, 0]] });
    expect(clipOf(q, 'a').speed).toEqual({ num: 4, den: 1 });
    expect(() => setClipSpeed(p, ctx(), { id: 'v', speed: { num: 100, den: 1 } })).toThrow(/between/);
    expect(() => setClipSpeed(lock(p, 'A1'), ctx(), { id: 'v', speed: { num: 2, den: 1 } })).toThrow(/locked/);
  });

  it('freezes the frame under the playhead to the end of the clip', () => {
    const p = project({ V1: [['v', 10, 40, 100, { linkId: 'L' }]], A1: [['a', 10, 40, 100, { linkId: 'L' }]] });
    const q = run(p, freezeFrame(p, ctx(), { id: 'v', at: 25 }));
    expect(layout(q).V1).toEqual([['v', 10, 15, 100], ['n1', 25, 25, 115]]);
    expect(clipOf(q, 'n1')).toMatchObject({ freeze: true, linkId: null });
    expect(planFrame(q, 45).layers[0]!.sourceTime).toBe(115);
    expect(() => freezeFrame(p, ctx(), { id: 'v', at: 10 })).toThrow(/inside the clip/);
  });
});

describe('timeStretch', () => {
  const R = 48000;
  const tone = Float32Array.from({ length: R }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / R));
  const zeroCrossings = (x: Float32Array): number => x.reduce((n, v, i) => n + (i > 0 && v >= 0 !== x[i - 1]! >= 0 ? 1 : 0), 0);

  it('changes length but not pitch or level', () => {
    for (const speed of [2, 0.5, 1.5]) {
      const [out] = timeStretch([tone], speed, R) as [Float32Array];
      expect(out.length).toBe(Math.round(R / speed));
      // A 1 kHz tone crosses zero 2000 times a second whatever the speed.
      const perSecond = (zeroCrossings(out.subarray(2000, out.length - 2000)) / (out.length - 4000)) * R;
      expect(Math.abs(perSecond - 2000), `speed ${speed}`).toBeLessThan(40);
      const rms = Math.sqrt(out.subarray(2000, out.length - 2000).reduce((s, v) => s + v * v, 0) / (out.length - 4000));
      expect(Math.abs(rms - 0.5 / Math.SQRT2), `speed ${speed}`).toBeLessThan(0.05);
    }
  });

  it('keeps events at their scaled position, treats channels alike, and passes speed 1 through', () => {
    const click = new Float32Array(R);
    click[24000] = 1;
    const [l, r] = timeStretch([click, click], 2, R) as [Float32Array, Float32Array];
    const at = l.indexOf(Math.max(...l));
    expect(Math.abs(at - 12000)).toBeLessThan(R * 0.03);
    expect(l).toEqual(r);
    expect(timeStretch([tone], 1, R)[0]).toEqual(tone);
    expect(timeStretch([new Float32Array(0)], 2, R)[0]!.length).toBe(0);
  });
});
