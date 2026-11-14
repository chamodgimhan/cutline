// Entry point: builds the window (menu bar, resizable panels, status bar) around one App.
import { App } from './app.ts';
import { binPanel } from './bin.ts';
import { h, load, save } from './dom.ts';
import { inspectorPanel } from './inspector.ts';
import { menuBar } from './menus.ts';
import { monitorPanel } from './monitor.ts';
import { historyPanel, metersPanel, openShortcutEditor } from './sidePanels.ts';
import { installStyles } from './styles.ts';
import { timelinePanel } from './timeline.ts';

interface Layout {
  /** Fraction of the height given to the top row. */
  top: number;
  /** Fractions of the width for bin, source, program, inspector. */
  cols: number[];
}
const DEFAULT_LAYOUT: Layout = { top: 0.5, cols: [0.2, 0.3, 0.3, 0.2] };
const MIN = 0.08;

const panel = (title: string, body: HTMLElement, ...header: HTMLElement[]): HTMLElement =>
  h('section', { class: 'panel', 'aria-label': title, 'data-panel': title.toLowerCase() }, h('header', {}, h('span', { class: 'grow' }, title), ...header), h('div', { class: 'body' }, body));

export function mount(root: HTMLElement): App {
  installStyles();
  const app = new App();
  app.actions.push({ id: 'help.shortcuts', label: 'Keyboard Shortcuts…', menu: 'Help', keys: ['Ctrl+Alt+K'], run: () => openShortcutEditor(app) });

  const saved = load<Layout>('cutline.layout', DEFAULT_LAYOUT);
  const layout: Layout = { top: saved.top > MIN && saved.top < 1 - MIN ? saved.top : DEFAULT_LAYOUT.top, cols: saved.cols?.length === 4 ? saved.cols : [...DEFAULT_LAYOUT.cols] };
  const bin = binPanel(app);
  const timeline = timelinePanel(app);
  const top = h('div', { class: 'row' });
  const work = h('div', { class: 'work' });

  const apply = (): void => {
    work.style.gridTemplateRows = `${layout.top}fr auto ${1 - layout.top}fr`;
    top.style.gridTemplateColumns = layout.cols.map((c) => `${c}fr`).join(' auto ');
    save('cutline.layout', layout);
  };
  /** A draggable (and arrow-key adjustable) divider. `move` receives the change as a fraction of the container. */
  const splitter = (dir: 'v' | 'h', name: string, move: (delta: number) => void): HTMLElement => {
    const el = h('div', { class: `split ${dir}`, role: 'separator', tabindex: '0', 'aria-label': name, 'aria-orientation': dir === 'v' ? 'vertical' : 'horizontal', 'data-split': name });
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      let last = dir === 'v' ? e.clientX : e.clientY;
      const onMove = (m: PointerEvent): void => {
        const now = dir === 'v' ? m.clientX : m.clientY;
        move((now - last) / (dir === 'v' ? top.clientWidth : work.clientHeight));
        last = now;
        apply();
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', () => el.removeEventListener('pointermove', onMove), { once: true });
    });
    el.addEventListener('keydown', (e) => {
      const step = e.key === (dir === 'v' ? 'ArrowLeft' : 'ArrowUp') ? -0.02 : e.key === (dir === 'v' ? 'ArrowRight' : 'ArrowDown') ? 0.02 : 0;
      if (!step) return;
      e.preventDefault();
      e.stopPropagation();
      move(step);
      apply();
    });
    return el;
  };
  /** Move width between two neighbouring columns, keeping both above the minimum. */
  const shift = (i: number) => (delta: number): void => {
    const [a, b] = [layout.cols[i] as number, layout.cols[i + 1] as number];
    const d = Math.min(Math.max(delta, MIN - a), b - MIN);
    layout.cols[i] = a + d;
    layout.cols[i + 1] = b - d;
  };

  top.append(
    h('div', { class: 'stack' }, panel('Media', bin.body, ...bin.header), panel('History', historyPanel(app))),
    splitter('v', 'Resize media and source', shift(0)),
    panel('Source', monitorPanel(app, 'source')),
    splitter('v', 'Resize source and program', shift(1)),
    panel('Program', monitorPanel(app, 'program')),
    splitter('v', 'Resize program and inspector', shift(2)),
    panel('Inspector', inspectorPanel(app)),
  );
  const bottom = h('div', { class: 'row', style: 'grid-template-columns: 1fr 64px' }, panel('Timeline', timeline.body), panel('Meters', metersPanel(app)));
  work.append(top, splitter('h', 'Resize monitors and timeline', (d) => {
    layout.top = Math.min(1 - MIN, Math.max(MIN, layout.top + d));
  }), bottom);

  const message = h('span', { class: 'msg', role: 'status', 'aria-live': 'polite' });
  const info = h('span', {});
  let clear = 0;
  app.session.subscribe(() => {
    if (app.session.message && app.session.message !== message.textContent) {
      message.textContent = app.session.message;
      clearTimeout(clear);
      clear = window.setTimeout(() => {
        message.textContent = '';
        app.session.message = null;
      }, 6000);
    }
    info.textContent = `${app.session.tool} tool · ${app.session.selection.size} selected · snapping ${app.session.snapping ? 'on' : 'off'}`;
  });
  root.append(menuBar(app), work, h('footer', { class: 'status' }, info, message));
  apply();
  window.addEventListener('keydown', (e) => void app.key(e));
  // Stop the browser from navigating to a file dropped outside the bin.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  Object.assign(window, { cutline: { app, timeline } });
  app.program.transport.refresh();
  return app;
}

const rootEl = document.getElementById('app');
if (rootEl) mount(rootEl);
