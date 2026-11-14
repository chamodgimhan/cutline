// Inspector: properties of the selected clip, or of the sequence when nothing is selected.
import { updateClips } from '../core/commands/clips.ts';
import { setSequenceProps } from '../core/commands/tracks.ts';
import { evalParam, setValueAt } from '../core/keyframes.ts';
import type { BlendMode, Clip, FitMode, VideoProps } from '../core/model.ts';
import { formatTimecode } from '../core/time.ts';
import type { App } from './app.ts';
import { fill, framed, h } from './dom.ts';

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
    const sig = one ? `${one.id}:${JSON.stringify([one.name, one.enabled, one.start, one.duration, one.video])}:${one.video && typeof one.video.opacity !== 'number' ? s.playhead : ''}` : `${hits.length}:${JSON.stringify([s.seq.name, s.seq.width, s.seq.height, s.seq.fps, s.seq.sampleRate])}`;
    if (sig === shown || (root.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT' && shown.split(':')[0] === sig.split(':')[0])) return;
    shown = sig;
    fill(root, ...(one ? clipFields(one) : hits.length > 1 ? [h('div', { class: 'none' }, `${hits.length} clips selected.`)] : sequenceFields()));
  });
  s.subscribe(render);
  render();
  return root;
}
