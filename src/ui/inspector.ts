// Inspector: properties of the selected clip, or of the sequence when nothing is selected.
import { updateClips } from '../core/commands/clips.ts';
import { setSequenceProps, setTrackProps } from '../core/commands/tracks.ts';
import { isTypingTarget } from '../core/editor/shortcuts.ts';
import { evalParam, setValueAt } from '../core/keyframes.ts';
import type { BlendMode, Clip, FitMode, VideoProps } from '../core/model.ts';
import { formatTimecode, TICKS_PER_SECOND } from '../core/time.ts';
import type { App } from './app.ts';
import { fill, framed, h } from './dom.ts';
import { fxFields } from './inspectorFx.ts';
import { textFields } from './textUi.ts';

const BLENDS: BlendMode[] = ['normal', 'multiply', 'screen', 'overlay', 'add', 'darken', 'lighten', 'difference'];
const FITS: FitMode[] = ['fit', 'fill', 'stretch', 'none'];
const RATES: [string, number, number][] = [['23.976', 24000, 1001], ['24', 24, 1], ['25', 25, 1], ['29.97', 30000, 1001], ['30', 30, 1], ['50', 50, 1], ['59.94', 60000, 1001], ['60', 60, 1]];
type Animated = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';

export function inspectorPanel(app: App): HTMLElement {
  const s = app.session;
  const root = h('div', { class: 'inspector' });
  let shown = '';

  const row = (label: string, control: HTMLElement): HTMLElement[] => {
    const id = `insp-${label.replace(/\W+/g, '-').toLowerCase()}`;
    control.id = id;
    return [h('label', { for: id }, label), control];
  };
  const number = (value: number, set: (v: number) => void, step = 1): HTMLInputElement => {
    const el = h('input', { type: 'number', step, value: String(Math.round(value * 1000) / 1000), onchange: () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) set(v);
    } });
    return el;
  };
  const select = <T extends string>(options: readonly T[], value: T, set: (v: T) => void): HTMLSelectElement => {
    const el = h('select', { onchange: () => set(el.value as T) }, ...options.map((o) => h('option', { value: o, selected: o === value }, o)));
    return el;
  };

  function clipFields(c: Clip): HTMLElement[] {
    const local = Math.min(Math.max(s.playhead - c.start, 0), c.duration);
    const edit = (change: (clip: Clip) => Clip, label: string): void => void s.run(() => updateClips(s.project, s.ctx, [c.id], change, label));
    const video = (change: (v: VideoProps, clip: Clip) => VideoProps, label: string): void =>
      edit((clip) => (clip.video ? { ...clip, video: change(clip.video, clip) } : clip), label);
    // Animated values are edited at the playhead: a constant stays a constant, a keyed value gets a key there.
    const anim = (key: Animated, label: string, scale = 1, step = 1): HTMLElement[] =>
      row(label, number(evalParam(c.video?.[key] ?? 0, local) * scale, (v) => video((p, clip) => ({ ...p, [key]: setValueAt(p[key], Math.min(Math.max(s.playhead - clip.start, 0), clip.duration), v / scale) }), `Set ${label.toLowerCase()}`), step));
    const crop = (side: 'left' | 'top' | 'right' | 'bottom'): HTMLElement[] =>
      row(`Crop ${side} %`, number((c.video?.crop[side] ?? 0) * 100, (v) => video((p) => ({ ...p, crop: { ...p.crop, [side]: Math.min(100, Math.max(0, v)) / 100 } }), 'Crop')));
    const name = h('input', { type: 'text', value: c.name, onchange: () => edit((clip) => ({ ...clip, name: name.value }), 'Rename clip') });
    const enabled = h('input', { type: 'checkbox', checked: c.enabled, onchange: () => edit((clip) => ({ ...clip, enabled: enabled.checked }), 'Enable / disable') });
    const out: HTMLElement[] = [
      h('h3', {}, `${c.kind} clip`), ...row('Name', name), ...row('Enabled', enabled),
      ...row('Start', h('span', {}, formatTimecode(c.start, s.seq.fps))), ...row('Duration', h('span', {}, formatTimecode(c.duration, s.seq.fps))),
    ];
    if (c.video) {
      out.push(
        h('h3', {}, 'Transform'), ...anim('x', 'Position X'), ...anim('y', 'Position Y'), ...anim('scale', 'Scale %', 100), ...anim('rotation', 'Rotation °', 1, 0.1),
        ...anim('opacity', 'Opacity %', 100),
        ...row('Anchor X %', number(c.video.anchorX * 100, (v) => video((p) => ({ ...p, anchorX: v / 100 }), 'Set anchor'))),
        ...row('Anchor Y %', number(c.video.anchorY * 100, (v) => video((p) => ({ ...p, anchorY: v / 100 }), 'Set anchor'))),
        ...row('Blend', select(BLENDS, c.video.blend, (v) => video((p) => ({ ...p, blend: v }), 'Set blend mode'))),
        ...row('Fit', select(FITS, c.video.fit, (v) => video((p) => ({ ...p, fit: v }), 'Set fit'))),
        h('h3', {}, 'Crop'), ...crop('left'), ...crop('top'), ...crop('right'), ...crop('bottom'),
      );
    }
    const a = c.audio;
    const track = s.seq.tracks.find((t) => t.clips.some((x) => x.id === c.id));
    if (a && track) {
      const audio = (change: (p: NonNullable<Clip['audio']>, clip: Clip) => NonNullable<Clip['audio']>, label: string): void =>
        edit((clip) => (clip.audio ? { ...clip, audio: change(clip.audio, clip) } : clip), label);
      const seconds = (ticks: number): number => ticks / TICKS_PER_SECOND;
      const fade = (v: number, clip: Clip): number => Math.min(clip.duration, Math.max(0, s.toFrameDelta(Math.round(v * TICKS_PER_SECOND))));
      out.push(
        h('h3', {}, 'Audio'),
        ...row('Gain dB', number(evalParam(a.gain, local), (v) => audio((p, clip) => ({ ...p, gain: setValueAt(p.gain, Math.min(Math.max(s.playhead - clip.start, 0), clip.duration), Math.min(24, Math.max(-96, v))) }), 'Set gain'), 0.5)),
        ...row('Fade in s', number(seconds(a.fadeIn), (v) => audio((p, clip) => ({ ...p, fadeIn: fade(v, clip) }), 'Set fade in'), 0.1)),
        ...row('Fade out s', number(seconds(a.fadeOut), (v) => audio((p, clip) => ({ ...p, fadeOut: fade(v, clip) }), 'Set fade out'), 0.1)),
        h('h3', {}, `Track ${track.name}`),
        ...row('Track volume dB', number(track.volume, (v) => void s.run(() => setTrackProps(s.project, s.ctx, track.id, { volume: Math.min(24, Math.max(-96, v)) })), 0.5)),
        ...row('Track pan', number(track.pan, (v) => void s.run(() => setTrackProps(s.project, s.ctx, track.id, { pan: Math.min(1, Math.max(-1, v)) })), 0.1)),
      );
    }
    out.push(...textFields(app, c), ...fxFields(app, c));
    return out;
  }

  function sequenceFields(): HTMLElement[] {
    const q = s.seq;
    const set = (props: Parameters<typeof setSequenceProps>[2]): void => void s.run(() => setSequenceProps(s.project, s.ctx, props));
    const name = h('input', { type: 'text', value: q.name, onchange: () => set({ name: name.value }) });
    const rate = RATES.find(([, n, d]) => n * q.fps.den === d * q.fps.num)?.[0] ?? '30';
    return [
      h('h3', {}, 'Sequence'), ...row('Name', name),
      ...row('Width', number(q.width, (v) => set({ width: Math.round(v) }))), ...row('Height', number(q.height, (v) => set({ height: Math.round(v) }))),
      ...row('Frame rate', select(RATES.map((r) => r[0]), rate, (v) => {
        const r = RATES.find((x) => x[0] === v);
        if (r) set({ fps: { num: r[1], den: r[2] } });
      })),
      ...row('Sample rate', select(['44100', '48000'], String(q.sampleRate) as '44100' | '48000', (v) => set({ sampleRate: Number(v) }))),
      h('div', { class: 'none' }, 'Select a clip to edit its properties.'),
    ];
  }

  const render = framed(() => {
    const hits = s.selectedClips();
    const one = hits.length === 1 ? hits[0]?.clip : undefined;
    // Rebuild only when what is shown changes, and never under the user's cursor while typing.
    const sig = one ? `${one.id}:${JSON.stringify([one.name, one.enabled, one.start, one.duration, one.video, one.audio, one.text, one.effects, one.transitionIn, one.transitionOut, one.speed, one.reverse, one.pitchKeep, s.laneKey, s.seq.tracks.map((t) => [t.volume, t.pan])])}:${JSON.stringify([one.video, one.audio, one.effects]).includes('"keys"') ? s.playhead : ''}` : `${hits.length}:${JSON.stringify([s.seq.name, s.seq.width, s.seq.height, s.seq.fps, s.seq.sampleRate])}`;
    if (sig === shown) return;
    shown = sig;
    // Rebuilding must not disturb typing: keep focus on the same field, and keep text the user has not committed yet.
    const active = root.contains(document.activeElement) ? (document.activeElement as HTMLInputElement) : null;
    const typed = active && isTypingTarget(active) && active.dataset.built !== undefined && active.value !== active.dataset.built ? active.value : null;
    fill(root, ...(one ? clipFields(one) : hits.length > 1 ? [h('div', { class: 'none' }, `${hits.length} clips selected.`)] : sequenceFields()));
    for (const el of root.querySelectorAll<HTMLInputElement>('input, textarea')) el.dataset.built = el.value;
    const again = active?.id ? root.querySelector<HTMLInputElement>(`#${CSS.escape(active.id)}`) : null;
    if (again) {
      again.focus();
      if (typed !== null) again.value = typed;
    }
  });
  // Text put back after a rebuild was not typed into the new element, so the browser will not announce it:
  // commit it ourselves when the user leaves the field or presses Enter.
  const commit = (e: Event): void => {
    const el = e.target as HTMLInputElement;
    if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.dataset.built !== undefined && el.value !== el.dataset.built) el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  root.addEventListener('focusout', commit);
  root.addEventListener('keydown', (e) => e.key === 'Enter' && commit(e));
  // Once a field's value has been committed, the model's version of it (clamped, rounded) is what should show.
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset) el.dataset.built = el.value;
  });
  s.subscribe(render);
  render();
  return root;
}
