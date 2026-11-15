// Phase 11 smoke (production build): one end-to-end workflow through the real UI, 50 open/edit/close cycles
// with memory counts, and a keyboard-only pass through every panel.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright-core';
import { Mp4File } from '../../src/media/mp4/demuxer.ts';
import { MemorySource } from '../../src/media/source.ts';
import { OUT_DIR } from '../fixtures/generate.ts';
import { launch, pageCounts } from './browser.ts';
import { writeReport } from '../report.ts';
import { serve } from './server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const S = 705_600_000;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any }; saved: Record<string, string> };

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  process.env.CUTLINE_BUILD = '1';
  const served = await serve();
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    /** Open the app with project files kept in localStorage instead of file dialogs. */
    const open = async (): Promise<Page> => {
      const p = await context.newPage();
      p.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
      await p.goto(served.app);
      await p.waitForFunction(() => !!(window as unknown as Win).cutline?.app.actions.some((a: { id: string }) => a.id === 'file.save'));
      await p.evaluate(() => {
        const w = window as unknown as Win;
        w.saved = JSON.parse(localStorage.getItem('test-files') ?? '{}');
        const keep = (): void => localStorage.setItem('test-files', JSON.stringify(w.saved));
        w.cutline.app.files = {
          open: async () => ({ name: 'work.cutline', text: w.saved['work.cutline'], ref: 'work.cutline' }),
          openRef: async (ref: string) => ({ name: ref, text: w.saved[ref], ref }),
          save: async (ref: string, text: string) => void ((w.saved[ref] = text), keep()),
          saveAs: async (_name: string, text: string) => ((w.saved['work.cutline'] = text), keep(), { name: 'work.cutline', ref: 'work.cutline' }),
        };
        w.cutline.app.skipUnloadPrompt = true;
        w.cutline.app.exportDestination = async () => ({ kind: 'memory' }); // headless Chrome has no save dialog to answer
      });
      await p.locator('.dialog [data-answer="Discard"]').click({ timeout: 1000 }).catch(() => undefined);
      return p;
    };
    const st = <T>(p: Page, expr: string): Promise<T> => p.evaluate((x) => new Function('app', `return ${x}`)((window as unknown as Win).cutline.app) as T, expr);
    const settle = (p: Page): Promise<void> => p.waitForTimeout(150);
    const exportMp4 = async (p: Page, name: string): Promise<Uint8Array> => {
      await p.locator('canvas[data-role=timeline]').focus();
      await p.keyboard.press('Control+KeyE');
      await p.locator('#exp-format').selectOption('mp4');
      await p.locator('#exp-range').selectOption('inout');
      await p.locator('#exp-name').fill(name);
      await p.keyboard.press('Tab');
      const [file] = await Promise.all([p.waitForEvent('download', { timeout: 120_000 }), p.locator('.dialog [data-role=start]').click()]);
      await p.locator('.dialog [data-role=close]').click();
      return new Uint8Array(fs.readFileSync(await file.path()));
    };

    // --- Workflow: import, cut, captions, colour, export ---
    let page = await open();
    // The shortcut reference (SHORTCUTS.md) is generated from the actions the running app really has.
    writeReport('actions', { actions: await page.evaluate(() => (window as unknown as Win).cutline.app.actions.map((a: { id: string; label: string; menu: string; keys: string[] }) => ({ id: a.id, label: a.label, menu: a.menu, keys: a.keys }))) });
    await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
    await page.locator('.bin .item').dblclick();
    await page.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 15; i++) await page.keyboard.press('ArrowRight'); // half a second (the sequence runs at 30 fps)
    await page.keyboard.press('Control+KeyK');
    await page.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      app.session.select(app.session.seq.tracks.flatMap((t: { clips: { id: string; start: number }[] }) => t.clips.filter((c) => c.start === 0).map((c) => c.id)));
    });
    await page.keyboard.press('Shift+Delete'); // ripple delete the first half second
    const cut = await st<number[][]>(page, "app.session.seq.tracks.filter((t) => t.kind !== 'caption' && t.clips.length).map((t) => t.clips.map((c) => [c.start, c.duration]).flat())");
    check(cut.length >= 1 && cut.every((c) => c[0] === 0 && Math.abs((c[1] as number) - 1.5 * S) < S / 48), `after the cut: ${JSON.stringify(cut)}`);
    await page.setInputFiles('input[data-role=caption-import]', path.join(ROOT, 'fixtures/captions/good.srt'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.tracks.some((t: { kind: string; clips: unknown[] }) => t.kind === 'caption' && t.clips.length > 0));
    await page.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      const v = app.session.seq.tracks.find((t: { kind: string }) => t.kind === 'video').clips[0];
      app.session.select(app.session.seq.tracks.flatMap((t: { clips: { id: string; linkId: string | null }[] }) => t.clips.filter((c) => c.linkId === v.linkId).map((c) => c.id)));
    });
    await settle(page);
    // The whole linked clip is selected (picture and sound); the inspector shows the picture part.
    check((await page.locator('[data-panel=inspector]').textContent())?.includes('clips selected') === false, 'a linked clip should open in the inspector, not as "2 clips selected"');
    await page.locator('#insp-add-effect').selectOption('saturation');
    await settle(page);
    check((await st<string[]>(page, "app.session.seq.tracks.find((t) => t.kind === 'video').clips[0].effects.map((e) => e.type)")).includes('saturation'), 'colour effect was not added');
    // Export the edited 1.5 s (In at the start, Out at 45 frames); one imported cue sits an hour in.
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('KeyI');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('KeyO');
    const first = await exportMp4(page, 'first');
    const mp4 = await Mp4File.open(new MemorySource(first));
    const video = mp4.tracks.find((t) => t.kind === 'video');
    const audio = mp4.tracks.find((t) => t.kind === 'audio');
    const secs = video ? video.duration / video.timescale : 0;
    check(!!video && !!audio && Math.abs(secs - 1.5) < 0.1, `exported movie: ${mp4.tracks.length} tracks, ${secs.toFixed(3)} s of video`);

    // --- Save, close, reopen, relink, export again: the same file comes out ---
    await page.keyboard.press('Control+KeyS');
    await page.waitForFunction(() => !(window as unknown as Win).cutline.app.session.history.dirty);
    const savedProject = await st<string>(page, 'JSON.stringify(app.session.project)');
    await page.close();
    page = await open();
    await page.evaluate(() => (window as unknown as Win).cutline.app.run('file.open'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
    check((await st<string>(page, 'JSON.stringify(app.session.project)')) === savedProject, 'the reopened project differs from the one saved');
    await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4')); // relink by content
    await page.waitForFunction(() => {
      const { app } = (window as unknown as Win).cutline;
      return app.library.status(app.session.project.media[0].id) === 'online';
    });
    check((await st<number>(page, 'app.session.project.media.length')) === 1, 'relinking added a second asset');
    const second = await exportMp4(page, 'second');
    check(first.length === second.length && Buffer.from(first).equals(Buffer.from(second)), `export after reopening differs: ${first.length} vs ${second.length} bytes`);
    console.log(`[workflow] import, cut, ${await st(page, "app.session.seq.tracks.find((t) => t.kind === 'caption').clips.length")} captions, colour, export ${first.length} bytes; reopened export identical: ${Buffer.from(first).equals(Buffer.from(second))}`);

    // --- 50 open/edit/close cycles: memory, DOM nodes and listeners must not grow ---
    const cycle = async (): Promise<void> => {
      await page.evaluate(() => (window as unknown as Win).cutline.app.run('file.open'));
      await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
      await page.locator('canvas[data-role=timeline]').focus();
      await page.keyboard.press('KeyM');
      await page.keyboard.press('Control+KeyK');
      await page.evaluate(() => (window as unknown as Win).cutline.app.run('file.new'));
      await page.locator(`.dialog [data-answer="Don't Save"]`).click();
      await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 0);
    };
    await page.keyboard.press('Control+KeyS'); // relinking changed the project; start the cycles from a saved state
    await page.waitForFunction(() => !(window as unknown as Win).cutline.app.session.history.dirty);
    for (let i = 0; i < 5; i++) await cycle();
    const early = await pageCounts(page);
    for (let i = 5; i < 50; i++) await cycle();
    const late = await pageCounts(page);
    console.log(`[cycles] after 5 / 50 open-edit-close cycles: heap ${early.heapMiB.toFixed(1)} / ${late.heapMiB.toFixed(1)} MiB, DOM nodes ${early.nodes} / ${late.nodes}, listeners ${early.listeners} / ${late.listeners}`);
    check(late.heapMiB - early.heapMiB < 8, `heap grew ${(late.heapMiB - early.heapMiB).toFixed(1)} MiB over 45 cycles`);
    check(late.nodes - early.nodes < 100 && late.listeners - early.listeners < 30, `DOM nodes ${early.nodes} -> ${late.nodes}, listeners ${early.listeners} -> ${late.listeners}`);

    // --- Keyboard only: Tab reaches every panel, every stop shows a focus ring, nothing traps focus ---
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const reached = new Set<string>();
    const noRing: string[] = [];
    let stops = 0;
    for (; stops < 400; stops++) {
      await page.keyboard.press('Tab');
      const f = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return { panel: el.closest('[data-panel]')?.getAttribute('data-panel') ?? 'none', ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0, what: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? ''}]` };
      });
      if (!f) continue;
      if (reached.has(f.panel) && f.panel === 'media' && reached.size > 3) break; // wrapped round
      reached.add(f.panel);
      if (!f.ring) noRing.push(f.what);
    }
    const panels = ['media', 'source', 'program', 'inspector', 'timeline'];
    check(panels.every((p) => reached.has(p)), `Tab reached panels: ${[...reached].join(', ')} (expected ${panels.join(', ')})`);
    check(noRing.length === 0, `focused without a visible focus ring: ${noRing.slice(0, 8).join(', ')}`);
    console.log(`[keyboard] ${stops} Tab stops reached ${[...reached].join(', ')}; ${noRing.length} without a focus ring`);
    await context.close();
  } finally {
    await browser.close();
    await served.close();
    delete process.env.CUTLINE_BUILD;
  }
  return failures;
}
