// Phase 4 smoke: drives the real app with real pointer and key events and compares the model.
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import type { Project } from '../../src/core/model.ts';
import { ACTIONS } from '../../src/core/editor/actions.ts';
import { makeClip, makeTrack } from '../../src/core/model.ts';
import { project } from '../../src/core/testkit.ts';
import { frameTicks } from '../../src/core/time.ts';
import { OUT_DIR } from '../fixtures/generate.ts';
import { launch } from './browser.ts';
import { serve } from './server.ts';

const F = frameTicks({ num: 30, den: 1 });
// Rows at 30 px per second (one frame per pixel): ruler 0..24, V2 24..80, V1 80..136, A1 136..192.
const Y = { ruler: 10, V2: 50, V1: 100, A1: 160 };
const base = (): Project => project({ V1: [['a', 0, 30 * F, 30 * F], ['b', 30 * F, 30 * F, 30 * F], ['c', 90 * F, 30 * F, 30 * F]], V2: [], A1: [['x', 0, 30 * F, 30 * F]] }, 600 * F);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any; timeline: any } };
const fixture = (name: string): string => path.join(OUT_DIR, name + '.mp4');

/** Playwright key string for one of our combos, e.g. 'Ctrl+Shift+Z' -> 'Control+Shift+KeyZ'. */
function playwrightKey(combo: string): string {
  const parts = combo === '+' ? ['+'] : combo.split('+');
  const key = parts.pop() as string;
  const mods = parts.map((m) => (m === 'Ctrl' ? 'Control' : m));
  return [...mods, /^[A-Z]$/.test(key) ? `Key${key}` : key].join('+');
}

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const eq = (got: unknown, want: unknown, what: string): void => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const served = await serve();
  const browser = await launch();
  try {
    const page: Page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && failures.push(`console error: ${m.text()}`));
    await page.goto(served.url + '/index.html');
    await page.waitForFunction(() => !!(window as unknown as Win).cutline);

    const reset = (p: Project = base()): Promise<void> => page.evaluate((proj) => {
      const { app } = (window as unknown as Win).cutline;
      const s = app.session;
      app.program.transport.pause();
      s.history.reset(proj);
      s.selection.clear();
      s.view.pxPerSecond = 30;
      s.view.scrollX = 0;
      s.view.scrollY = 0;
      s.tool = 'select';
      s.snapping = true;
      s.linked = true;
      s.focus = 'timeline';
      s.activeTrackId = null;
      s.clipboard = null;
      app.lastAction = null;
      app.program.transport.loop = false;
      app.program.transport.seek(0);
      s.emit();
    }, p);
    /** Track -> [start, duration, sourceIn] in frames. */
    const frames = (track = 'V1'): Promise<number[][]> => page.evaluate(([t, f]) => {
      const seq = (window as unknown as Win).cutline.app.session.seq;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (seq.tracks.find((x: any) => x.id === t)?.clips ?? []).map((c: any) => [c.start / (f as number), c.duration / (f as number), c.sourceIn / (f as number)]);
    }, [track, F] as const);
    const state = <T>(expr: string): Promise<T> => page.evaluate((e) => new Function('app', `return ${e}`)((window as unknown as Win).cutline.app) as T, expr);
    const canvas = page.locator('canvas[data-role=timeline]');
    const box = async (): Promise<{ x: number; y: number }> => (await canvas.boundingBox()) as { x: number; y: number };
    /** Press at the first point, move through the rest, release. Coordinates are canvas pixels. */
    const drag = async (points: [number, number][], modifier?: 'Shift' | 'Alt'): Promise<void> => {
      const b = await box();
      const [first, ...rest] = points as [[number, number], ...[number, number][]];
      if (modifier) await page.keyboard.down(modifier);
      await page.mouse.move(b.x + first[0], b.y + first[1]);
      await page.mouse.down();
      for (const p of rest) await page.mouse.move(b.x + p[0], b.y + p[1], { steps: 4 });
      await page.mouse.up();
      if (modifier) await page.keyboard.up(modifier);
    };
    const tool = (key: string): Promise<void> => page.keyboard.press(`Key${key}`);

    // --- Import: picker, drag-and-drop, and a corrupt file ---
    await page.setInputFiles('input[data-role=import]', [fixture('clip_24'), fixture('corrupt')]);
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1 && (window as unknown as Win).cutline.app.session.message);
    check(/corrupt\.mp4: This file is damaged or incomplete/.test(await state<string>('app.session.message')), `corrupt import message: ${await state('app.session.message')}`);
    const dropped = await page.evaluateHandle(async (url) => {
      const dt = new DataTransfer();
      dt.items.add(new File([await (await fetch(url)).blob()], 'rotated.mp4', { type: 'video/mp4' }));
      return dt;
    }, served.url + '/fixtures/out/rotated.mp4');
    await page.dispatchEvent('[data-panel=media] .body > div', 'drop', { dataTransfer: dropped });
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 2);
    eq(await state('app.session.project.media.map((m) => [m.name, m.kind, m.video.rotation])'), [['clip_24.mp4', 'video', 0], ['rotated.mp4', 'video', 90]], 'imported media');
    eq(await page.locator('.bin .item').count(), 2, 'bin items');

    // --- Source monitor: open, mark, three-point overwrite and insert via buttons ---
    await page.locator('.bin .item', { hasText: 'clip_24' }).dblclick();
    const mediaId = await state<string>('app.session.source.mediaId');
    check(!!mediaId && (await state('app.session.focus')) === 'source', 'double-click opens the clip in the source monitor');
    await page.evaluate(([f]) => (window as unknown as Win).cutline.app.source.transport.seek(12 * (f as number)), [F]);
    await page.keyboard.press('KeyI');
    await page.evaluate(([f]) => (window as unknown as Win).cutline.app.source.transport.seek(36 * (f as number)), [F]);
    await page.keyboard.press('KeyO');
    eq(await state(`[app.session.source.inPoint / ${F}, app.session.source.outPoint / ${F}]`), [12, 36], 'source in/out from I and O');
    await page.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
    eq([await frames('v1'), await frames('a1')], [[[0, 24, 12]], [[0, 24, 12]]], 'overwrite from source');
    await page.locator('[data-monitor=source] button', { hasText: 'Insert' }).click();
    eq(await frames('v1'), [[0, 24, 12], [24, 24, 12]], 'insert from source at the playhead');
    // Space with the source monitor focused plays the source, not the sequence.
    await page.keyboard.press('Space');
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.source.transport.playing);
    check(!(await state('app.program.transport.playing')), 'space in the source monitor must not start the program');
    await page.keyboard.press('Space');

    // --- Drag from the bin to the timeline ---
    const b0 = await box();
    await page.locator('.bin .item', { hasText: 'rotated' }).dragTo(canvas, { targetPosition: { x: 300, y: Y.V2 } });
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.tracks[1].clips.length === 1);
    const placed = await state<number[]>('(() => { const c = app.session.seq.tracks[1].clips[0]; return [Math.round(c.start / app.session.frame), c.duration / app.session.frame]; })()');
    const pps = await state<number>('app.session.view.pxPerSecond');
    check(Math.abs((placed[0] as number) - Math.round((300 / pps) * 30)) <= 1 && placed[1] === 60, `bin drag placed the clip at frame ${placed[0]} for ${placed[1]} frames`);
    check(b0.x > 0, 'timeline canvas is laid out');

    // --- Tools with real pointer events; the model must equal the expected model ---
    await reset();
    await tool('V');
    await drag([[100, Y.V1], [110, Y.V1], [130, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 30, 30], [120, 30, 30]], 'select: move');
    eq(await state('app.session.history.entries()'), [{ label: 'Move', applied: true }], 'move is one undo step');
    await page.keyboard.press('Control+KeyZ');
    eq(await frames(), [[0, 30, 30], [30, 30, 30], [90, 30, 30]], 'undo after move');
    await drag([[100, Y.V1], [75, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 30, 30], [60, 30, 30]], 'select: move snaps to the neighbouring clip');
    await reset();
    await drag([[100, Y.V1], [100, Y.V2]]);
    eq([await frames('V1'), await frames('V2')], [[[0, 30, 30], [30, 30, 30]], [[90, 30, 30]]], 'select: move to another track');
    await reset();
    await drag([[90, Y.V1], [80, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 30, 30], [80, 40, 20]], 'select: trim in edge');
    await reset();
    await drag([[70, Y.V2], [10, Y.A1]]);
    eq(await state('[...app.session.selection].sort()'), ['a', 'b', 'x'], 'select: marquee');
    await reset();
    await drag([[15, Y.V1]]);
    await drag([[45, Y.V1]], 'Shift');
    eq(await state('[...app.session.selection].sort()'), ['a', 'b'], 'select: shift-click adds');
    await reset();
    await tool('C');
    await drag([[40, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 10, 30], [40, 20, 40], [90, 30, 30]], 'razor');
    await reset();
    await tool('B');
    await drag([[60, Y.V1], [50, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 20, 30], [80, 30, 30]], 'ripple');
    await reset();
    await tool('R');
    await drag([[30, Y.V1], [40, Y.V1]]);
    eq(await frames(), [[0, 40, 30], [40, 20, 40], [90, 30, 30]], 'roll');
    await reset();
    await tool('Y');
    await drag([[45, Y.V1], [55, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 30, 20], [90, 30, 30]], 'slip');
    await reset();
    await tool('U');
    await drag([[15, Y.V1], [25, Y.V1]]);
    eq(await frames(), [[10, 30, 30], [40, 20, 40], [90, 30, 30]], 'slide');
    await reset();
    await page.evaluate(() => ((window as unknown as Win).cutline.app.session.view.scrollX = 100));
    await tool('H');
    await drag([[200, Y.V1], [150, Y.V1]]);
    eq(await state('app.session.view.scrollX'), 150, 'hand scrolls');
    await reset();
    await tool('Z');
    await drag([[60, Y.V1]]);
    eq(await state('app.session.view.pxPerSecond'), 45, 'zoom tool');
    await reset();
    await tool('V');
    await drag([[20, Y.ruler], [47, Y.V1]]);
    eq(await state(`app.session.playhead / ${F}`), 47, 'ruler drag scrubs');
    // Escape cancels a drag in progress.
    await reset();
    const bb = await box();
    await page.mouse.move(bb.x + 100, bb.y + Y.V1);
    await page.mouse.down();
    await page.mouse.move(bb.x + 140, bb.y + Y.V1, { steps: 3 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    eq([await frames(), await state('app.session.history.canUndo')], [[[0, 30, 30], [30, 30, 30], [90, 30, 30]], false], 'escape cancels a drag');

    // --- Context menu and history panel ---
    await reset();
    await canvas.click({ button: 'right', position: { x: 45, y: Y.V1 } });
    await page.locator('.menu [data-action="edit.delete"]').click();
    eq(await frames(), [[0, 30, 30], [90, 30, 30]], 'context menu delete');
    await page.locator('.history button', { hasText: 'Start' }).click();
    eq((await frames()).length, 3, 'history panel jumps back to the start');
    await page.locator('.history button', { hasText: 'Delete' }).click();
    eq((await frames()).length, 2, 'history panel jumps forward');

    // --- Every action: through its menu item, and through each of its shortcuts ---
    const actions = await state<{ id: string; menu: string; keys: string[] }[]>('app.actions.map((a) => ({ id: a.id, menu: a.menu, keys: app.shortcuts.keysFor(a.id) }))');
    check(actions.length > ACTIONS.length, `UI actions are missing: ${actions.length} actions`);
    const prime = async (): Promise<void> => {
      await reset();
      await page.evaluate(([f]) => {
        const { app } = (window as unknown as Win).cutline;
        app.session.select(['b']);
        app.session.activeTrackId = 'V2';
        app.program.transport.seek(45 * (f as number));
      }, [F]);
    };
    for (const a of actions) {
      await prime();
      await page.locator(`.menubar [data-menu="${a.menu}"]`).click();
      await page.locator(`.menu [data-action="${a.id}"]`).click();
      check((await state('app.lastAction')) === a.id, `menu item ${a.id} did not run its action`);
      if (a.id === 'help.shortcuts') await page.locator('.dialog [data-role=close]').click();
      for (const combo of a.keys) {
        await prime();
        await canvas.focus();
        await page.keyboard.press(playwrightKey(combo));
        check((await state('app.lastAction')) === a.id, `shortcut ${combo} did not run ${a.id} (ran ${await state('app.lastAction')})`);
        if (a.id === 'help.shortcuts') await page.locator('.dialog [data-role=close]').click();
        if (a.id.startsWith('play.')) await page.evaluate(() => (window as unknown as Win).cutline.app.program.transport.pause());
      }
    }
    // Spot-check effects, not just dispatch.
    await prime();
    await page.keyboard.press('Control+KeyK');
    eq(await frames(), [[0, 30, 30], [30, 15, 30], [45, 15, 45], [90, 30, 30]], 'Ctrl+K splits at the playhead');
    await prime();
    await page.keyboard.press('Shift+Delete');
    eq(await frames(), [[0, 30, 30], [60, 30, 30]], 'Shift+Delete ripple deletes');

    // --- Buttons: tools, snapping, track flags, monitor transport ---
    await reset();
    for (const t of ['select', 'razor', 'ripple', 'roll', 'slip', 'slide', 'hand', 'zoom']) {
      await page.locator(`.tools [data-tool=${t}]`).click();
      check((await state('app.session.tool')) === t && (await page.locator(`.tools [data-tool=${t}]`).getAttribute('aria-pressed')) === 'true', `tool button ${t}`);
    }
    await page.locator('.tools [data-role=snap]').click();
    eq(await state('app.session.snapping'), false, 'snapping button');
    await page.locator('.head[data-track=A1] [data-flag="track.mute"]').click();
    await page.locator('.head[data-track=A1] [data-flag="track.solo"]').click();
    await page.locator('.head[data-track=V1] [data-flag="track.hide"]').click();
    await page.locator('.head[data-track=V1] [data-flag="track.lock"]').click();
    eq(await state('app.session.seq.tracks.map((t) => [t.id, t.locked, t.muted, t.solo, t.hidden])'), [['V1', true, false, false, true], ['V2', false, false, false, false], ['A1', false, true, true, false]], 'track header buttons');
    await page.locator('.tools [data-tool=select]').click();
    await drag([[100, Y.V1], [140, Y.V1]]);
    eq(await frames(), [[0, 30, 30], [30, 30, 30], [90, 30, 30]], 'a locked track does not change');
    await reset();
    await page.locator('[data-monitor=program] button[aria-label="Step forward"]').click();
    await page.locator('[data-monitor=program] button[aria-label="Step forward"]').click();
    await page.locator('[data-monitor=program] button[aria-label="Step back"]').click();
    eq(await state(`app.session.playhead / ${F}`), 1, 'monitor step buttons');
    await page.locator('[data-monitor=program] button', { hasText: /^In$/ }).click();
    eq(await state(`app.session.seq.inPoint / ${F}`), 1, 'monitor mark-in button');
    await page.locator('[data-monitor=program] button', { hasText: 'Loop' }).click();
    eq(await state('app.program.transport.loop'), true, 'loop button');
    await page.locator('[data-monitor=program] select').selectOption('0.5');
    eq(await state('app.program.transport.quality'), 0.5, 'preview quality');
    await page.locator('[data-monitor=program] button', { hasText: 'Play' }).click();
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.program.transport.playing);
    await page.locator('[data-monitor=program] button', { hasText: 'Pause' }).click();
    eq(await state('app.program.transport.playing'), false, 'play and pause buttons');

    // --- Typing in a field never fires a shortcut ---
    await reset();
    await drag([[45, Y.V1]]);
    const name = page.locator('.inspector input[type=text]');
    await name.click();
    await name.fill('');
    await page.keyboard.type('vcb zk jl mio 1 ,.;');
    await page.keyboard.press('Space');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Enter');
    eq(await state('[app.session.seq.tracks[0].clips[1].name, app.session.tool, app.session.seq.tracks[0].clips.length, app.session.seq.markers.length, app.program.transport.playing, app.session.seq.inPoint]'), ['vcb zk jl mio 1 ,.; ', 'select', 3, 0, false, null], 'typing in the name field');
    const scale = page.locator('#insp-scale-');
    await scale.click();
    await scale.fill('50');
    await page.keyboard.press('Tab');
    eq(await state('[app.session.seq.tracks[0].clips[1].video.scale, app.session.seq.tracks[0].clips.length]'), [0.5, 3], 'typing in a number field edits the clip');

    // --- Shortcut editor: rebind, conflict warning, typing in its filter, reset ---
    await canvas.focus();
    await page.keyboard.press('Control+Alt+KeyK');
    await page.locator('.dialog input').fill('marker');
    await page.keyboard.type('m');
    eq(await state('app.session.seq.markers.length'), 0, 'typing in the shortcut filter adds no marker');
    await page.locator('.dialog input').fill('Add Marker');
    await page.locator('.dialog .r[data-action="mark.add"] [data-role=record]').click();
    await page.keyboard.press('KeyQ');
    await page.locator('.dialog .r[data-action="mark.add"] [data-role=record]').click();
    await page.keyboard.press('Space');
    check(/Space is also used by "Play \/ Pause"/.test((await page.locator('.dialog .r[data-action="mark.add"] .warn').textContent()) ?? ''), 'conflict warning is shown');
    await page.locator('.dialog .r[data-action="mark.add"] [data-role=record]').click();
    await page.keyboard.press('KeyQ');
    await page.locator('.dialog [data-role=close]').click();
    await canvas.focus();
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('KeyM');
    eq(await state('app.session.seq.markers.length'), 1, 'rebound shortcut works and the old key no longer does');
    eq(await page.evaluate(() => JSON.parse(localStorage.getItem('cutline.shortcuts') ?? '{}')), { 'mark.add': ['Q'] }, 'shortcut overrides are saved');
    await page.keyboard.press('Control+Alt+KeyK');
    await page.locator('.dialog [data-role=reset]').click();
    await page.locator('.dialog [data-role=close]').click();

    // --- 2,000 clips: every frame while scrolling under 32 ms ---
    const big = base();
    big.sequences[0]!.tracks = ['V1', 'V2', 'A1', 'A2'].map((id) => {
      const t = makeTrack(id, id.startsWith('A') ? 'audio' : 'video', id);
      t.clips = Array.from({ length: 500 }, (_, i) => makeClip({ id: `${id}-${i}`, kind: t.kind === 'audio' ? 'audio' : 'video', mediaId: 'm', start: i * 20 * F, duration: 18 * F, name: `Clip ${i}` }));
      return t;
    });
    await reset(big);
    const perf = await page.evaluate(async () => {
      const { app, timeline } = (window as unknown as Win).cutline;
      const paints: number[] = [];
      const intervals: number[] = [];
      const counts: number[] = [];
      // Frame pacing of this browser when one pixel of the timeline canvas changes per frame: what any
      // repaint costs here (headless software compositing), to tell our cost from the environment's.
      const idle: number[] = [];
      const probe = document.querySelector('canvas[data-role=timeline]') as HTMLCanvasElement;
      for (let i = 0, prev = 0; i < 40; i++) {
        probe.getContext('2d')?.fillRect(i % 2, 0, 1, 1);
        const now = await new Promise<number>((r) => requestAnimationFrame(r));
        if (prev) idle.push(now - prev);
        prev = now;
      }
      let last = 0;
      for (let i = 0; i < 240; i++) {
        // First half: scroll through at normal zoom. Second half: zoomed out, hundreds of clips on screen at once.
        if (i === 120) app.session.view.pxPerSecond = 6;
        app.session.view.scrollX = i < 120 ? i * 37 : (i - 120) * 5;
        timeline.paintNow();
        paints.push(timeline.stats.paintMs);
        counts.push(timeline.stats.drawn);
        const now = await new Promise<number>((r) => requestAnimationFrame(r));
        if (last) intervals.push(now - last);
        last = now;
      }
      return { worstPaint: Math.max(...paints), meanPaint: paints.reduce((a, b) => a + b, 0) / paints.length, worstFrame: Math.max(...intervals), medianFrame: [...intervals].sort((a, b) => a - b)[intervals.length >> 1] as number, slowFrames: intervals.filter((v) => v > 32).length, frames: intervals.length, p95Frame: [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length * 0.95)] as number, idleFrame: [...idle].sort((a, b) => a - b)[Math.floor(idle.length * 0.95)] as number, drawn: Math.max(...counts), fewest: Math.min(...counts), clips: app.session.seq.tracks.reduce((n: number, t: { clips: unknown[] }) => n + t.clips.length, 0) };
    });
    console.log(`[budget] 2,000 clips: paint worst ${perf.worstPaint.toFixed(1)} ms, mean ${perf.meanPaint.toFixed(1)} ms; frame interval median ${perf.medianFrame.toFixed(1)} ms, ${perf.slowFrames} of ${perf.frames} over 32 ms, p95 ${perf.p95Frame.toFixed(1)} ms, worst ${perf.worstFrame.toFixed(1)} ms (one-pixel repaint: ${perf.idleFrame.toFixed(1)} ms); ${perf.fewest} to ${perf.drawn} clips drawn per frame (limit 32 ms)`);
    check(perf.clips === 2000, `budget project has ${perf.clips} clips`);
    check(perf.worstPaint < 32, `timeline paint took ${perf.worstPaint.toFixed(1)} ms with 2,000 clips`);
    check(perf.worstFrame < 32, `a frame took ${perf.worstFrame.toFixed(1)} ms while scrolling 2,000 clips (limit 32 ms)`);
    check(perf.fewest > 0 && perf.drawn > 300, `budget run drew ${perf.fewest} to ${perf.drawn} clips per frame: the view was not over the clips`);
    const b2 = await box();
    await page.mouse.move(b2.x + 300, b2.y + Y.V1);
    const before = await state<number>('app.session.view.scrollX');
    await page.mouse.wheel(0, 300);
    await page.keyboard.down('Shift');
    await page.mouse.wheel(0, 300);
    await page.keyboard.up('Shift');
    check((await state<number>('app.session.view.scrollX')) > before, 'shift-wheel scrolls the timeline');

    // --- Layout: drag a splitter, reload, sizes persist ---
    const split = page.locator('[data-split="Resize monitors and timeline"]');
    const sb = (await split.boundingBox()) as { x: number; y: number; width: number };
    await page.mouse.move(sb.x + sb.width / 2, sb.y + 2);
    await page.mouse.down();
    await page.mouse.move(sb.x + sb.width / 2, sb.y - 118, { steps: 5 });
    await page.mouse.up();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cutline.layout') ?? '{}').top as number);
    check(saved < 0.42 && saved > 0.2, `splitter drag changed the layout (top = ${saved})`);
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as Win).cutline);
    const rowsNow = await page.evaluate(() => (document.querySelector('.work') as HTMLElement).style.gridTemplateRows);
    check(rowsNow.startsWith(String(saved).slice(0, 5)), `layout restored after reload: ${rowsNow}`);
    await page.locator('[data-split="Resize media and source"]').focus();
    await page.keyboard.press('ArrowRight');
    check((await page.evaluate(() => JSON.parse(localStorage.getItem('cutline.layout') ?? '{}').cols[0] as number)) > 0.2, 'splitter responds to arrow keys');
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
