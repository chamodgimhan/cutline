// Phase 9 smoke: save/open/recent, unsaved-changes prompt, crash recovery, offline media relink, error log, cache limits.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright-core';
import { OUT_DIR } from '../fixtures/generate.ts';
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any }; saved: Record<string, string> };

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const eq = (got: unknown, want: unknown, what: string): void => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const served = await serve();
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    const open = async (): Promise<Page> => {
      const p = await context.newPage();
      p.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
      await p.goto(served.url + '/index.html');
      await p.waitForFunction(() => !!(window as unknown as Win).cutline);
      return p;
    };
    /** Wait for the File actions (installed after the stored state has been read), then swap file dialogs for an in-page store. */
    const ready = async (p: Page): Promise<void> => {
      await p.waitForFunction(() => (window as unknown as Win).cutline.app.actions.some((a: { id: string }) => a.id === 'file.save'));
      await p.evaluate(() => {
        const w = window as unknown as Win;
        w.saved = JSON.parse(localStorage.getItem('test-files') ?? '{}');
        const keep = (): void => localStorage.setItem('test-files', JSON.stringify(w.saved));
        w.cutline.app.files = {
          open: async () => ({ name: 'picked.cutline', text: w.saved['picked.cutline'] ?? 'not a project', ref: 'picked.cutline' }),
          openRef: async (ref: string) => {
            if (!(ref in w.saved)) throw new Error('missing');
            return { name: ref, text: w.saved[ref], ref };
          },
          save: async (ref: string, text: string) => {
            if (ref === 'readonly.cutline') throw new DOMException('no', 'NotAllowedError');
            w.saved[ref] = text;
            keep();
          },
          saveAs: async (name: string, text: string) => {
            w.saved[name] = text;
            keep();
            return { name, ref: name };
          },
        };
        w.cutline.app.skipUnloadPrompt = true;
      });
    };
    const st = <T>(p: Page, expr: string): Promise<T> => p.evaluate((x) => new Function('app', 'saved', `return ${x}`)((window as unknown as Win).cutline.app, (window as unknown as Win).saved) as T, expr);
    const act = (p: Page, id: string): Promise<void> => p.evaluate((x) => (window as unknown as Win).cutline.app.run(x), id);
    const answer = (p: Page, label: string): Promise<void> => p.locator(`.dialog [data-answer="${label}"]`).click();
    const settle = (p: Page): Promise<void> => p.waitForTimeout(150);

    // --- Save, Save As, title, New, Open, unsaved-changes prompt, Recent ---
    let page = await open();
    await ready(page);
    check((await page.locator('.dialog').count()) === 0, 'a recovery prompt appeared on a clean first launch');
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('KeyM');
    check(/\(unsaved\)/.test(await page.title()), `title should show unsaved changes: ${await page.title()}`);
    await page.keyboard.press('Control+KeyS'); // never saved: this is Save As
    await page.waitForFunction(() => Object.keys((window as unknown as Win).saved).length === 1 && !(window as unknown as Win).cutline.app.session.history.dirty);
    const firstName = (await st<string[]>(page, 'Object.keys(saved)'))[0] as string;
    check(firstName.endsWith('.cutline') && !/\(unsaved\)/.test(await page.title()) && (await st(page, 'app.session.history.dirty')) === false, `after save: file ${firstName}, title ${await page.title()}`);
    eq(await st(page, `JSON.parse(saved[${JSON.stringify(firstName)}]).project.sequences[0].markers.length`), 1, 'saved file content');
    await st(page, `(saved['picked.cutline'] = saved[${JSON.stringify(firstName)}], 0)`);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('KeyM');
    await page.keyboard.press('Control+KeyS');
    await page.waitForFunction((n) => JSON.parse((window as unknown as Win).saved[n] ?? '{}').project?.sequences[0].markers.length === 2, firstName);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('KeyM');
    // Dirty + Open: the prompt appears; Cancel keeps everything.
    await act(page, 'file.open');
    await page.locator('.dialog [data-answer=Cancel]').waitFor();
    await answer(page, 'Cancel');
    await settle(page);
    eq(await st(page, '[app.session.seq.markers.length, app.session.history.dirty]'), [3, true], 'cancelling the unsaved-changes prompt');
    await act(page, 'file.open');
    await answer(page, "Don't Save");
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 1);
    eq(await st(page, '[app.session.history.dirty, app.session.history.canUndo, app.fileRef]'), [false, false, 'picked.cutline'], 'after opening a project');
    // New project with a clean state: no prompt.
    await act(page, 'file.new');
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 0);
    check((await page.locator('.dialog').count()) === 0, 'New asked about unsaved changes when there were none');
    // Dirty + New + Save in the prompt: saves, then starts fresh.
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('KeyM');
    await act(page, 'file.new');
    await answer(page, 'Save');
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 0 && Object.keys((window as unknown as Win).saved).length >= 2);
    // Recent projects.
    await act(page, 'file.recent');
    const recents = await page.locator('.dialog [data-recent]').allTextContents();
    check(recents.length >= 2 && recents.some((r) => r.startsWith('picked.cutline')), `recent projects: ${JSON.stringify(recents)}`);
    await page.locator('.dialog [data-recent="picked.cutline"]').click();
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 1);
    // A recent project that has gone: plain message, removed from the list, open project untouched.
    await st(page, `(delete saved['picked.cutline'], 0)`);
    await act(page, 'file.recent');
    await page.locator('.dialog [data-recent="picked.cutline"]').click();
    await page.waitForFunction(() => /could not be opened. It may have been moved or deleted/.test((window as unknown as Win).cutline.app.session.message ?? ''));
    eq(await st(page, 'app.session.seq.markers.length'), 1, 'project after a failed open');
    // A damaged project file and a failed save: messages, nothing lost.
    await st(page, `(saved['picked.cutline'] = '{"app":"cutline","schema":2,"project":{"sequences":"x"}}', 0)`);
    await act(page, 'file.open');
    await page.waitForFunction(() => /damaged/.test((window as unknown as Win).cutline.app.session.message ?? ''));
    eq(await st(page, 'app.session.seq.markers.length'), 1, 'project after opening a damaged file');
    await st(page, `(app.fileRef = 'readonly.cutline', 0)`);
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('KeyM');
    await page.keyboard.press('Control+KeyS');
    await page.waitForFunction(() => /could not be saved to its file/.test((window as unknown as Win).cutline.app.session.message ?? ''));
    eq(await st(page, '[app.session.seq.markers.length, app.session.history.dirty]'), [2, true], 'project after a failed save');
    // Error log: the failures above are in it, and it exports as a text file.
    const [log] = await Promise.all([page.waitForEvent('download'), act(page, 'help.exportLog')]);
    const logText = fs.readFileSync(await log.path(), 'utf8');
    check(/ERROR .*could not be opened\. It may have been moved/.test(logText) && /ERROR .*could not be saved to its file/.test(logText) && /damaged/.test(logText), 'exported error log is missing the failures');
    await page.close();

    // --- Crash recovery: edit, wait for an autosave, kill the page, relaunch ---
    page = await open();
    await ready(page);
    await page.evaluate(() => ((window as unknown as Win).cutline.app.autosaveMs = 300));
    await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
    await page.locator('.bin .item').dblclick();
    await page.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Control+Shift+KeyK');
    const before = await st<string>(page, 'JSON.stringify(app.session.project)');
    eq(await st(page, 'app.session.seq.tracks[0].clips.length'), 2, 'edits before the crash');
    await page.waitForTimeout(2500); // long enough for an autosave of exactly this state
    await page.close({ runBeforeUnload: false }); // the "kill": no save, no clean shutdown
    page = await open();
    await page.locator('.dialog [data-answer=Recover]').waitFor();
    check(/unsaved changes/.test((await page.locator('.dialog').textContent()) ?? ''), 'recovery prompt text');
    await answer(page, 'Recover');
    await ready(page);
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.tracks[0].clips.length === 2);
    eq(await st(page, 'JSON.stringify(app.session.project)'), before, 'the recovered project equals the work before the crash');
    eq(await st(page, '[app.session.history.dirty, app.library.status(app.session.project.media[0].id)]'), [true, 'offline'], 'recovered project is unsaved and its media offline');
    check(/offline/.test(await st<string>(page, 'app.session.message')), 'opening with offline media should say so');
    // Offline media comes back when its file is given again; it is not imported twice.
    await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.library.status((window as unknown as Win).cutline.app.session.project.media[0].id) === 'online');
    eq(await st(page, 'app.session.project.media.length'), 1, 'media count after relinking by importing the same file');
    // The explicit Relink button refuses a different file.
    await page.evaluate(() => (window as unknown as Win).cutline.app.library.detach((window as unknown as Win).cutline.app.session.project.media[0].id));
    await page.locator('.bin .item button', { hasText: 'Relink' }).waitFor();
    page.once('dialog', (d) => void d.dismiss());
    const pick = async (name: string): Promise<void> => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.bin .item button', { hasText: 'Relink' }).click()]);
      await chooser.setFiles(path.join(OUT_DIR, name));
    };
    await pick('clip_25.mp4');
    await page.waitForFunction(() => /not the same/.test((window as unknown as Win).cutline.app.session.message ?? ''));
    eq(await st(page, 'app.library.status(app.session.project.media[0].id)'), 'offline', 'relink with the wrong file');
    await pick('clip_24.mp4');
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.library.status((window as unknown as Win).cutline.app.session.project.media[0].id) === 'online');
    // Kill again, this time discard: a clean start, and no prompt on the launch after that.
    await page.evaluate(() => ((window as unknown as Win).cutline.app.autosaveMs = 300));
    await page.keyboard.press('KeyM');
    await page.waitForTimeout(2500);
    await page.close({ runBeforeUnload: false });
    page = await open();
    await page.locator('.dialog [data-answer=Discard]').waitFor();
    await answer(page, 'Discard');
    await ready(page);
    eq(await st(page, '[app.session.seq.tracks[0].clips.length, app.session.project.media.length]'), [0, 0], 'after discarding recovery');
    await page.close();
    page = await open();
    await ready(page);
    check((await page.locator('.dialog').count()) === 0, 'the recovery prompt came back after being discarded');
    await page.close();
    await context.close();

    // --- Cache limits ---
    const harness = await openHarness(browser, served, failures);
    const c = await harness.evaluate(() => window.T.phase9.cacheSoak(400));
    console.log(`[cache] 400 random frames over 8 files: at most ${c.maxOpen} decoders open (limit ${c.limitOpen}), ${((c.maxBytes ?? 0) / 1048576).toFixed(0)} MiB of frames (limit ${((c.limitBytes ?? 0) / 1048576).toFixed(0)}), ${c.thumbs} thumbnails, peaks ${c.peakBytes} of ${c.peakLimit} bytes`);
    check((c.maxOpen ?? 99) <= (c.limitOpen ?? 0) && (c.maxOpen ?? 0) >= 5, `open decoders ${c.maxOpen}, limit ${c.limitOpen}`);
    check((c.maxBytes ?? Infinity) <= (c.limitBytes ?? 0) && (c.maxFrames ?? 0) > 10, `cached frames ${c.maxFrames}, ${c.maxBytes} bytes, limit ${c.limitBytes}`);
    check((c.peakBytes ?? 9e9) <= (c.peakLimit ?? 0) && (c.thumbs ?? 0) <= 1500 && (c.thumbs ?? 0) >= 30, `peaks ${c.peakBytes}/${c.peakLimit}, thumbnails ${c.thumbs}`);
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
