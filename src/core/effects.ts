// Effect and transition definitions, the pure edits on an effect stack, and LUT/curve data.
import { EditError } from './command.ts';
import { evalParam } from './keyframes.ts';
import type { Clip, Effect, Id, Param, Transition } from './model.ts';
import type { Tick } from './time.ts';

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown as a checkbox (0 or 1). */
  toggle?: boolean;
}

export interface EffectDef {
  type: string;
  label: string;
  params: ParamDef[];
  /** Non-numeric settings: a colour ('#rrggbb') or the text of a .cube file. */
  text?: { key: string; label: string; kind: 'color' | 'cube'; default: string };
}

const p = (key: string, label: string, min: number, max: number, def: number, step = 0.01, toggle = false): ParamDef => ({ key, label, min, max, step, default: def, toggle });

export const EFFECTS: readonly EffectDef[] = [
  { type: 'exposure', label: 'Exposure', params: [p('stops', 'Stops', -4, 4, 0)] },
  { type: 'contrast', label: 'Contrast', params: [p('amount', 'Amount', -1, 1, 0)] },
  { type: 'saturation', label: 'Saturation', params: [p('amount', 'Amount', 0, 2, 1)] },
  { type: 'temperature', label: 'Temperature and Tint', params: [p('temp', 'Temperature', -1, 1, 0), p('tint', 'Tint', -1, 1, 0)] },
  { type: 'curves', label: 'Curves', params: [p('p0', 'Blacks', 0, 1, 0), p('p1', 'Shadows', 0, 1, 0.25), p('p2', 'Midtones', 0, 1, 0.5), p('p3', 'Highlights', 0, 1, 0.75), p('p4', 'Whites', 0, 1, 1)] },
  { type: 'lut', label: 'LUT (.cube)', params: [p('mix', 'Mix', 0, 1, 1)], text: { key: 'cube', label: 'LUT file', kind: 'cube', default: '' } },
  { type: 'blur', label: 'Blur', params: [p('radius', 'Radius', 0, 40, 4, 0.5)] },
  { type: 'sharpen', label: 'Sharpen', params: [p('amount', 'Amount', 0, 2, 0.5)] },
  { type: 'vignette', label: 'Vignette', params: [p('amount', 'Amount', 0, 1, 0.5), p('size', 'Size', 0, 1, 0.5)] },
  { type: 'chromaKey', label: 'Chroma Key', params: [p('tolerance', 'Tolerance', 0, 1, 0.3), p('softness', 'Softness', 0, 1, 0.1)], text: { key: 'color', label: 'Key colour', kind: 'color', default: '#00ff00' } },
  { type: 'flip', label: 'Flip', params: [p('horizontal', 'Horizontal', 0, 1, 1, 1, true), p('vertical', 'Vertical', 0, 1, 0, 1, true)] },
];

export const effectDef = (type: string): EffectDef | undefined => EFFECTS.find((e) => e.type === type);

export function makeEffect(type: string, id: Id): Effect {
  const def = effectDef(type);
  if (!def) throw new EditError('Unknown effect.');
  const params: Effect['params'] = Object.fromEntries(def.params.map((d) => [d.key, d.default]));
  if (def.text) params[def.text.key] = def.text.default;
  return { id, type, enabled: true, params };
}

/** Numeric value of an effect parameter at clip-local time, clamped to its range. */
export function effectValue(e: Effect, key: string, local: Tick): number {
  const d = effectDef(e.type)?.params.find((x) => x.key === key);
  const raw = e.params[key];
  const v = typeof raw === 'number' || (typeof raw === 'object' && !Array.isArray(raw)) ? evalParam(raw as Param, local) : (d?.default ?? 0);
  return d ? Math.min(d.max, Math.max(d.min, v)) : v;
}

export const effectText = (e: Effect, key: string): string => (typeof e.params[key] === 'string' ? (e.params[key] as string) : '');

// Stack edits: each returns a new clip.
export const addEffect = (c: Clip, e: Effect): Clip => ({ ...c, effects: [...c.effects, e] });
export const removeEffect = (c: Clip, id: Id): Clip => ({ ...c, effects: c.effects.filter((e) => e.id !== id) });
export const changeEffect = (c: Clip, id: Id, change: (e: Effect) => Effect): Clip => ({ ...c, effects: c.effects.map((e) => (e.id === id ? change(e) : e)) });
export function moveEffect(c: Clip, id: Id, by: number): Clip {
  const i = c.effects.findIndex((e) => e.id === id);
  const j = Math.min(c.effects.length - 1, Math.max(0, i + by));
  if (i < 0 || i === j) return c;
  const list = c.effects.slice();
  list.splice(j, 0, ...list.splice(i, 1));
  return { ...c, effects: list };
}

export const VIDEO_TRANSITIONS = ['dissolve', 'dipBlack', 'dipWhite', 'wipe', 'slide'] as const;
export const AUDIO_TRANSITION = 'crossfade';
export const TRANSITION_LABELS: Record<string, string> = { dissolve: 'Cross Dissolve', dipBlack: 'Dip to Black', dipWhite: 'Dip to White', wipe: 'Wipe', slide: 'Slide', crossfade: 'Audio Crossfade' };

/** Set or clear a clip's transition. The duration is kept inside the clip. */
export function withTransition(c: Clip, edge: 'in' | 'out', type: string | null, duration: Tick): Clip {
  const allowed: readonly string[] = c.kind === 'audio' ? [AUDIO_TRANSITION] : VIDEO_TRANSITIONS;
  if (type !== null && !allowed.includes(type)) throw new EditError('That transition cannot be used on this clip.');
  const t: Transition | null = type === null ? null : { type, duration: Math.max(1, Math.min(duration, c.duration)), params: {} };
  return edge === 'in' ? { ...c, transitionIn: t } : { ...c, transitionOut: t };
}

/** 256-entry tone curve through five evenly spaced control points (monotone cubic, so it never overshoots). */
export function curveTable(points: readonly number[]): Uint8Array {
  const n = points.length;
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push(((points[i + 1] as number) - (points[i] as number)) * (n - 1));
  const m: number[] = points.map((_, i) => (i === 0 ? (d[0] as number) : i === n - 1 ? (d[n - 2] as number) : (d[i - 1] as number) * (d[i] as number) <= 0 ? 0 : ((d[i - 1] as number) + (d[i] as number)) / 2));
  for (let i = 0; i < n - 1; i++) {
    // Fritsch-Carlson limiter keeps each segment monotone.
    const s = d[i] as number;
    if (s === 0) m[i] = m[i + 1] = 0;
    else {
      const [a, b] = [(m[i] as number) / s, (m[i + 1] as number) / s];
      const k = a * a + b * b;
      if (k > 9) {
        m[i] = (3 / Math.sqrt(k)) * a * s;
        m[i + 1] = (3 / Math.sqrt(k)) * b * s;
      }
    }
  }
  const out = new Uint8Array(256);
  for (let x = 0; x < 256; x++) {
    const pos = (x / 255) * (n - 1);
    const i = Math.min(n - 2, Math.floor(pos));
    const t = pos - i;
    const h = 1 / (n - 1);
    const y = (2 * t ** 3 - 3 * t * t + 1) * (points[i] as number) + (t ** 3 - 2 * t * t + t) * h * (m[i] as number) + (-2 * t ** 3 + 3 * t * t) * (points[i + 1] as number) + (t ** 3 - t * t) * h * (m[i + 1] as number);
    out[x] = Math.round(Math.min(1, Math.max(0, y)) * 255);
  }
  return out;
}

export interface Lut3d {
  size: number;
  /** RGB bytes, red changing fastest (the .cube order). */
  data: Uint8Array;
}

/** Parse a .cube 3D LUT. Throws EditError with a plain message for anything malformed. */
export function parseCube(text: string): Lut3d {
  let size = 0;
  let lo = 0;
  let hi = 1;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = Number(parts[1]);
    else if (parts[0] === 'LUT_1D_SIZE') throw new EditError('This is a 1D LUT. Cutline needs a 3D .cube file.');
    else if (parts[0] === 'DOMAIN_MIN') lo = Number(parts[1]);
    else if (parts[0] === 'DOMAIN_MAX') hi = Number(parts[1]);
    else if (/^[-+.\d]/.test(line)) {
      if (parts.length !== 3 || parts.some((v) => !Number.isFinite(Number(v)))) throw new EditError('This LUT file has a line that is not three numbers.');
      values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
    }
  }
  if (!Number.isInteger(size) || size < 2 || size > 129) throw new EditError('This LUT file does not state a valid 3D size.');
  if (values.length !== size ** 3 * 3) throw new EditError(`This LUT file should have ${size ** 3} colour rows but has ${values.length / 3}.`);
  if (!(hi > lo)) throw new EditError('This LUT file has an invalid value range.');
  return { size, data: Uint8Array.from(values, (v) => Math.round(Math.min(1, Math.max(0, (v - lo) / (hi - lo))) * 255)) };
}
