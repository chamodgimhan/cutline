// Source and program monitors: the engine canvas, a scrub bar and transport controls.
import { sequenceEnd } from '../core/model.ts';
import { formatTimecode } from '../core/time.ts';
import type { PreviewScale } from '../engine/renderer.ts';
import type { App } from './app.ts';
import { framed, h } from './dom.ts';

const SCRUB_STEPS = 10_000;

export function monitorPanel(app: App, which: 'source' | 'program'): HTMLElement {
  const eng = which === 'source' ? app.source : app.program;
  const t = eng.transport;
  const seq = () => (which === 'source' ? app.sourceProjectNow().sequences[0]! : app.session.seq);
  const focus = (): void => {
    app.session.focus = which === 'source' ? 'source' : 'timeline';
  };
  const act = (id: string) => (): void => {
    focus();
    app.run(id);
  };
  const tc = h('span', { class: 'tc', 'aria-label': 'Timecode' });
  const scrub = h('input', {
    type: 'range', min: 0, max: SCRUB_STEPS, step: 1, 'aria-label': `${which} position`,
    oninput: () => t.seek(Math.round((Number(scrub.value) / SCRUB_STEPS) * sequenceEnd(seq()))),
  });
  const play = h('button', { onclick: act('play.toggle'), title: 'Play / Pause (Space)' }, 'Play');
  const loop = h('button', { onclick: act('play.loop'), title: 'Loop between in and out' }, 'Loop');
  const quality = h(
    'select',
    { 'aria-label': 'Preview quality', title: 'Preview quality', onchange: () => {
      t.quality = Number(quality.value) as PreviewScale;
      t.refresh();
    } },
    h('option', { value: '1' }, 'Full'), h('option', { value: '0.5' }, 'Half'), h('option', { value: '0.25' }, 'Quarter'),
  );
  const bar = h(
    'div', { class: 'bar' }, tc,
    h('button', { onclick: act('play.stepBack'), title: 'Step back one frame (Left)', 'aria-label': 'Step back' }, '‹'),
    play,
    h('button', { onclick: act('play.stepForward'), title: 'Step forward one frame (Right)', 'aria-label': 'Step forward' }, '›'),
    h('button', { onclick: act('mark.in'), title: 'Mark in (I)' }, 'In'),
    h('button', { onclick: act('mark.out'), title: 'Mark out (O)' }, 'Out'),
    h('span', { class: 'grow' }),
    ...(which === 'source'
      ? [h('button', { onclick: act('seq.insert'), title: 'Insert at playhead (,)' }, 'Insert'), h('button', { onclick: act('seq.overwrite'), title: 'Overwrite at playhead (.)' }, 'Overwrite')]
      : [loop, quality]),
  );
  const root = h('div', { class: 'monitor', 'data-monitor': which, onpointerdown: focus }, h('div', { class: 'stage' }, eng.canvas), h('div', { class: 'scrub' }, scrub), bar);
  const update = framed(() => {
    const s = seq();
    const end = sequenceEnd(s);
    tc.textContent = formatTimecode(t.playhead, s.fps);
    if (document.activeElement !== scrub) scrub.value = String(end > 0 ? Math.round((t.playhead / end) * SCRUB_STEPS) : 0);
    play.textContent = t.playing ? 'Pause' : 'Play';
    loop.setAttribute('aria-pressed', String(t.loop));
  });
  app.session.subscribe(update);
  t.subscribe(update);
  update();
  return root;
}
