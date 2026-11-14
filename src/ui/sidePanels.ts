// Small panels: audio meters, history, and the shortcut editor dialog.
import { comboOf } from '../core/editor/shortcuts.ts';
import { color } from '../theme/theme.ts';
import type { App } from './app.ts';
import { fill, framed, h } from './dom.ts';

const FLOOR_DB = -60;

/** Peak meters for the program output: one bar per channel with a peak-hold line. */
export function metersPanel(app: App): HTMLElement {
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Audio level meters' });
  const t = app.program.transport;
  const hold = [0, 0];
  const level = [0, 0];
  let last: number | null = null;
  const draw = (): void => {
    const w = canvas.clientWidth;
    const hgt = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== hgt) {
      canvas.width = w;
      canvas.height = hgt;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = color.bg0;
    ctx.fillRect(0, 0, w, hgt);
    const bar = Math.max(4, (w - 6) / 2);
    const yOf = (amp: number): number => {
      const db = amp > 0 ? 20 * Math.log10(amp) : FLOOR_DB;
      return hgt * (1 - Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB)));
    };
    for (let ch = 0; ch < 2; ch++) {
      const x = ch * (bar + 6);
      const y = yOf(level[ch] as number);
      ctx.fillStyle = (level[ch] as number) >= 1 ? color.meterHigh : (level[ch] as number) > 0.5 ? color.meterMid : color.meterLow;
      ctx.fillRect(x, y, bar, hgt - y);
      ctx.fillStyle = color.text;
      ctx.fillRect(x, yOf(hold[ch] as number), bar, 1);
    }
  };
  const tick = (): void => {
    // Exact peaks: the largest sample among those played since the previous reading.
    const now = t.playing ? t.audioTime : null;
    const peaks = now !== null && last !== null ? t.peaksBetween(last, now) : [0, 0];
    last = now;
    for (let ch = 0; ch < 2; ch++) {
      level[ch] = peaks[ch] as number;
      hold[ch] = Math.max(level[ch] as number, (hold[ch] as number) * 0.985); // peak hold decays slowly
    }
    draw();
    if (t.playing || hold[0]! > 0.001 || hold[1]! > 0.001) requestAnimationFrame(tick);
    else running = false;
  };
  let running = false;
  t.subscribe(() => {
    if (running || !t.playing) return;
    running = true;
    requestAnimationFrame(tick);
  });
  new ResizeObserver(draw).observe(canvas);
  return h('div', { class: 'meters' }, canvas);
}

/** Undo history: click a step to go back or forward to it. */
export function historyPanel(app: App): HTMLElement {
  const root = h('div', { class: 'history', role: 'list' });
  let shown = '';
  const render = framed(() => {
    const entries = app.session.history.entries();
    const applied = app.session.history.appliedCount;
    const sig = entries.map((e) => e.label).join('|') + applied;
    if (sig === shown) return;
    shown = sig;
    const step = (label: string, count: number): HTMLElement =>
      h('button', { class: `${count > applied ? 'undone' : ''}${count === applied ? ' current' : ''}`, 'data-step': count, onclick: () => app.session.history.jumpTo(count) }, label);
    fill(root, step('Start', 0), ...entries.map((e, i) => step(e.label, i + 1)));
  });
  app.session.subscribe(render);
  render();
  return root;
}

/** Dialog to view and change shortcuts, with conflict warnings. */
export function openShortcutEditor(app: App): void {
  const map = app.shortcuts;
  const list = h('div', { class: 'list' });
  const filter = h('input', { type: 'text', placeholder: 'Filter actions', 'aria-label': 'Filter actions', oninput: () => render() });
  let recording: string | null = null;
  const label = (id: string): string => app.actions.find((a) => a.id === id)?.label ?? id;

  function render(): void {
    const q = filter.value.trim().toLowerCase();
    fill(list, ...app.actions.filter((a) => !q || a.label.toLowerCase().includes(q) || a.menu.toLowerCase().includes(q)).map((a) => {
      const keys = map.keysFor(a.id);
      const clash = keys.flatMap((k) => map.usedBy(k, a.id).map((other) => `${k} is also used by "${label(other)}"`));
      return h('div', { class: 'r', 'data-action': a.id },
        h('span', {}, `${a.menu}: ${a.label}`),
        h('kbd', {}, recording === a.id ? 'Press keys…' : keys.join('  ') || 'None'),
        h('button', { 'data-role': 'record', onclick: () => {
          recording = recording === a.id ? null : a.id;
          render();
        } }, recording === a.id ? 'Cancel' : 'Change'),
        h('button', { 'data-role': 'clear', onclick: () => {
          map.set(a.id, []);
          app.saveShortcuts();
          render();
        } }, 'Clear'),
        clash.length ? h('div', { class: 'warn', role: 'alert' }, clash.join('. ')) : null);
    }));
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (recording) recording = null;
      else return close();
      e.preventDefault();
      return render();
    }
    if (!recording) return void e.stopPropagation(); // keys typed in the dialog never reach the editor
    const combo = comboOf(e);
    e.preventDefault();
    e.stopPropagation();
    if (!combo) return;
    map.set(recording, [combo]);
    app.saveShortcuts();
    recording = null;
    render();
  };
  const back = h('div', { class: 'dialog-back', onpointerdown: (e: Event) => e.target === back && close() },
    h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' },
      h('h2', {}, 'Keyboard shortcuts'), filter, list,
      h('div', { class: 'foot' },
        h('button', { 'data-role': 'reset', onclick: () => {
          map.reset();
          app.saveShortcuts();
          render();
        } }, 'Reset all to defaults'),
        h('button', { 'data-role': 'close', onclick: () => close() }, 'Done'))));
  function close(): void {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
  }
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  render();
  filter.focus();
}
