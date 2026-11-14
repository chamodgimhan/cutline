// Inspector sections for speed, transitions, keyframes and the effect stack of one clip.
import { EditError } from '../core/command.ts';
import { setClipSpeed, updateClips } from '../core/commands/clips.ts';
import { LANE_KEYS, LANE_LABELS, laneKeyFor, laneParam, withLaneParam, type LaneKey } from '../core/editor/lane.ts';
import {
  addEffect, AUDIO_TRANSITION, changeEffect, effectDef, EFFECTS, effectText, effectValue, makeEffect, moveEffect, parseCube, removeEffect, TRANSITION_LABELS, VIDEO_TRANSITIONS,
  withTransition,
} from '../core/effects.ts';
import { editKey, evalParam, isAnimated, removeKey, setKey, setValueAt } from '../core/keyframes.ts';
import type { Clip, Interp, Param } from '../core/model.ts';
import { gcd, TICKS_PER_SECOND } from '../core/time.ts';
import type { App } from './app.ts';
import { h } from './dom.ts';

let rippleSpeed = true;

export function fxFields(app: App, c: Clip): HTMLElement[] {
  const s = app.session;
  const local = (clip: Clip): number => Math.min(Math.max(s.playhead - clip.start, 0), clip.duration);
  const edit = (change: (clip: Clip) => Clip, label: string): void => void s.run(() => updateClips(s.project, s.ctx, [c.id], change, label));
  const row = (label: string, control: HTMLElement, id = label): HTMLElement[] => {
    control.id = `insp-${id.replace(/\W+/g, '-').toLowerCase()}`;
    return [h('label', { for: control.id }, label), control];
  };
  const num = (value: number, set: (v: number) => void, step = 0.01): HTMLInputElement => {
    const el = h('input', { type: 'number', step, value: String(Math.round(value * 1000) / 1000), onchange: () => Number.isFinite(Number(el.value)) && set(Number(el.value)) });
    return el;
  };
  const check = (on: boolean, set: (v: boolean) => void): HTMLInputElement => {
    const el = h('input', { type: 'checkbox', checked: on, onchange: () => set(el.checked) });
    return el;
  };
  const pick = (options: [string, string][], value: string, set: (v: string) => void): HTMLSelectElement => {
    const el = h('select', { onchange: () => set(el.value) }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    return el;
  };
  const out: HTMLElement[] = [];

  // Speed
  if (c.mediaId) {
    const speed = (change: Partial<Parameters<typeof setClipSpeed>[2]>): void =>
      void s.run(() => setClipSpeed(s.project, s.ctx, { id: c.id, speed: c.speed, ripple: rippleSpeed, linked: s.linked, frame: s.frame, ...change }));
    out.push(
      h('h3', {}, 'Speed'),
      ...row('Speed %', num((c.speed.num / c.speed.den) * 100, (v) => {
        const n = Math.round(v * 100);
        if (n <= 0) return s.notify('Speed must be more than zero.');
        const g = gcd(n, 10000);
        speed({ speed: { num: n / g, den: 10000 / g } });
      }, 1)),
      ...row('Reverse', check(c.reverse, (v) => speed({ reverse: v }))),
      ...row('Keep pitch', check(c.pitchKeep, (v) => speed({ pitchKeep: v }))),
      ...row('Ripple on speed change', check(rippleSpeed, (v) => (rippleSpeed = v)), 'speed-ripple'),
    );
  }

  // Transitions
  if (c.kind !== 'caption') {
    const types: [string, string][] = [['', 'None'], ...(c.kind === 'audio' ? [AUDIO_TRANSITION] : VIDEO_TRANSITIONS).map((t): [string, string] => [t, TRANSITION_LABELS[t] ?? t])];
    for (const edge of ['in', 'out'] as const) {
      if (c.kind === 'audio' && edge === 'out') continue; // an audio crossfade belongs to the incoming clip
      const cur = edge === 'in' ? c.transitionIn : c.transitionOut;
      const seconds = (cur?.duration ?? TICKS_PER_SECOND / 2) / TICKS_PER_SECOND;
      const set = (type: string, secs: number): void => {
        try {
          edit((clip) => withTransition(clip, edge, type || null, s.toFrameDelta(Math.round(secs * TICKS_PER_SECOND))), 'Set transition');
        } catch (e) {
          if (!(e instanceof EditError)) throw e;
          s.notify(e.message);
        }
      };
      out.push(
        ...(edge === 'in' ? [h('h3', {}, 'Transitions')] : []),
        ...row(`Transition ${edge}`, pick(types, cur?.type ?? '', (v) => set(v, seconds))),
        ...(cur ? row(`Transition ${edge} s`, num(seconds, (v) => set(cur.type, Math.max(0.04, v)), 0.1)) : []),
      );
    }
  }

  // Keyframes for the lane property
  const lane = laneKeyFor(c, s.laneKey);
  const param = lane && laneParam(c, lane);
  if (lane && param !== null && param !== undefined) {
    const t = local(c);
    const keys = isAnimated(param) ? param.keys : [];
    const here = keys.find((k) => k.t === t);
    const setParam = (p: (old: Param) => Param, label: string): void => edit((clip) => {
      const old = laneParam(clip, lane);
      return old === null ? clip : withLaneParam(clip, lane, p(old));
    }, label);
    const jump = (dir: 1 | -1): void => {
      const now = local(c);
      const k = dir > 0 ? keys.find((x) => x.t > now) : [...keys].reverse().find((x) => x.t < now);
      if (k) s.seek(c.start + k.t);
    };
    out.push(
      h('h3', {}, 'Keyframes'),
      ...row('Property', pick((c.audio ? ['gain'] : LANE_KEYS.filter((k) => k !== 'gain')).map((k): [string, string] => [k, LANE_LABELS[k as LaneKey]]), lane, (v) => {
        s.laneKey = v as LaneKey;
        s.emit();
      }), 'lane-property'),
      h('label', {}, `${keys.length} key${keys.length === 1 ? '' : 's'}`),
      h('div', {},
        h('button', { 'data-role': 'key-prev', title: 'Previous keyframe', onclick: () => jump(-1) }, '‹'),
        h('button', { 'data-role': 'key-toggle', 'aria-pressed': String(!!here), title: 'Add or remove a keyframe at the playhead', onclick: () => {
          // Read the playhead now: this panel is not rebuilt on every playhead move.
          const now = s.toFrameDelta(local(c));
          const exists = keys.some((k) => k.t === now);
          setParam((old) => (exists ? removeKey(old, now) : setKey(old, now, evalParam(old, now))), exists ? 'Remove keyframe' : 'Add keyframe');
        } }, here ? 'Remove key' : 'Add key'),
        h('button', { 'data-role': 'key-next', title: 'Next keyframe', onclick: () => jump(1) }, '›'),
        keys.length > 0 && h('button', { 'data-role': 'key-clear', title: 'Remove all keyframes, keeping the current value', onclick: () => setParam((old) => evalParam(old, t), 'Clear keyframes') }, 'Clear')),
    );
    if (here) {
      out.push(
        ...row('Interpolation', pick([['linear', 'Linear'], ['hold', 'Hold'], ['bezier', 'Bezier']], here.interp, (v) => setParam((old) => editKey(old, t, { interp: v as Interp }), 'Set interpolation'))),
        ...(here.interp === 'bezier'
          ? [
              ...row('Ease out %', num(here.out[0] * 100, (v) => setParam((old) => editKey(old, t, { out: [Math.min(1, Math.max(0, v / 100)), here.out[1]] }), 'Edit handle'), 1)),
              ...row('Handle out value', num(here.out[1], (v) => setParam((old) => editKey(old, t, { out: [here.out[0], v] }), 'Edit handle'))),
              ...row('Ease in %', num(here.in[0] * 100, (v) => setParam((old) => editKey(old, t, { in: [Math.min(1, Math.max(0, v / 100)), here.in[1]] }), 'Edit handle'), 1)),
              ...row('Handle in value', num(here.in[1], (v) => setParam((old) => editKey(old, t, { in: [here.in[0], v] }), 'Edit handle'))),
            ]
          : []),
      );
    }
  }

  // Effects (picture clips and adjustment clips)
  if (c.video) {
    const add = pick([['', 'Add effect…'], ...EFFECTS.map((e): [string, string] => [e.type, e.label])], '', (type) => type && edit((clip) => addEffect(clip, makeEffect(type, s.newId())), 'Add effect'));
    out.push(h('h3', {}, 'Effects'), ...row('Add', add, 'add-effect'));
    c.effects.forEach((fx, i) => {
      const def = effectDef(fx.type);
      if (!def) return;
      const change = (fn: Parameters<typeof changeEffect>[2], label: string): void => edit((clip) => changeEffect(clip, fx.id, fn), label);
      out.push(
        h('label', {}, `${i + 1}. ${def.label}`),
        h('div', { 'data-effect': fx.type },
          check(fx.enabled, (v) => change((e) => ({ ...e, enabled: v }), 'Enable / disable effect')),
          h('button', { title: 'Move up (applied earlier)', 'aria-label': `Move ${def.label} up`, onclick: () => edit((clip) => moveEffect(clip, fx.id, -1), 'Reorder effects') }, '↑'),
          h('button', { title: 'Move down (applied later)', 'aria-label': `Move ${def.label} down`, onclick: () => edit((clip) => moveEffect(clip, fx.id, 1), 'Reorder effects') }, '↓'),
          h('button', { title: 'Remove effect', 'aria-label': `Remove ${def.label}`, onclick: () => edit((clip) => removeEffect(clip, fx.id), 'Remove effect') }, '×')),
      );
      for (const d of def.params) {
        const set = (v: number): void => change((e) => {
          const old = e.params[d.key];
          const p: Param = typeof old === 'number' || (typeof old === 'object' && !Array.isArray(old)) ? (old as Param) : d.default;
          return { ...e, params: { ...e.params, [d.key]: setValueAt(p, local(c), Math.min(d.max, Math.max(d.min, v))) } };
        }, `Set ${d.label.toLowerCase()}`);
        const id = `${fx.type}-${i}-${d.key}`;
        out.push(...row(d.label, d.toggle ? check(effectValue(fx, d.key, local(c)) > 0.5, (v) => set(v ? 1 : 0)) : num(effectValue(fx, d.key, local(c)), set, d.step), id));
      }
      if (def.text?.kind === 'color') {
        const el = h('input', { type: 'color', value: effectText(fx, def.text.key) || def.text.default, onchange: () => change((e) => ({ ...e, params: { ...e.params, [def.text?.key ?? '']: el.value } }), 'Set colour') });
        out.push(...row(def.text.label, el, `${fx.type}-${i}-color`));
      } else if (def.text?.kind === 'cube') {
        const key = def.text.key;
        const el = h('input', { type: 'file', accept: '.cube', onchange: () => {
          void el.files?.[0]?.text().then((text) => {
            try {
              parseCube(text); // refuse a bad file here, with the reason, rather than silently doing nothing
              change((e) => ({ ...e, params: { ...e.params, [key]: text } }), 'Load LUT');
            } catch (e) {
              if (!(e instanceof EditError)) throw e;
              s.notify(e.message);
            }
          });
        } });
        out.push(...row(effectText(fx, key) ? 'LUT loaded' : def.text.label, el, `${fx.type}-${i}-cube`));
      }
    });
  }
  return out;
}
