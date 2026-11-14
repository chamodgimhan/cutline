// Phase 8 smoke: export every format, re-read the files, compare with the preview.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OUT_DIR } from '../fixtures/generate.ts';
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any } };

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);

    for (const format of ['mp4', 'webm'] as const) {
      const r = await page.evaluate((f) => window.T.phase8.movie(f), format);
      if (!r.supported) {
        console.log(`[export] ${format}: this machine has no encoder for it, so it is not offered and not tested`);
        continue;
      }
      check(r.state === 'done', `${format}: export ${r.state}: ${r.message}`);
      if (r.state !== 'done') continue;
      const worst = Math.min(...(r.psnr ?? [0]));
      console.log(`[export] ${format}: ${r.frames} frames, ${r.durationSeconds?.toFixed(3)} s, ${((r.size ?? 0) / 1024).toFixed(0)} KiB, PSNR vs preview ${r.psnr?.map((p) => p.toFixed(1)).join('/')} dB, click at sample ${r.clickAt}`);
      check(r.mismatches === 0, `${format}: ${r.mismatches} frames given to the encoder differ from renderFrame`);
      check(r.frames === 48 && Math.abs((r.durationSeconds ?? 0) - 2) < 0.001 && Math.abs((r.fps ?? 0) - 24) < 0.01, `${format}: ${r.frames} frames, ${r.durationSeconds} s, ${r.fps} fps`);
      check(worst >= 40, `${format}: decoded picture is ${worst.toFixed(1)} dB from the preview (need 40)`);
      // The click belongs at exactly 1 s (sample 48000), the same instant the picture shows frame 24. One frame is 2000 samples.
      check(Math.abs((r.clickAt ?? 0) - 48000) < 2000, `${format}: audio is ${(((r.clickAt ?? 0) - 48000) / 48).toFixed(1)} ms out of sync`);
      check(Math.abs((r.audioSeconds ?? 0) - 2) < 0.06, `${format}: audio lasts ${r.audioSeconds} s`);
    }

    const s = await page.evaluate(() => window.T.phase8.stills());
    check(JSON.stringify(s.states) === JSON.stringify(['done', 'done', 'done', 'done']), `still exports: ${JSON.stringify(s.states)}`);
    check(JSON.stringify(s.pngSize) === '[320,180]' && s.pngPsnr === Infinity, `PNG frame should equal the preview exactly: size ${s.pngSize}, PSNR ${s.pngPsnr}`);
    check(s.wavFrames === 96000 && (s.wavWorstLsb as number) <= 1, `WAV: ${s.wavFrames} frames, worst ${s.wavWorstLsb} LSB from the mix`);
    check(JSON.stringify(s.tallSize) === '[180,320]' && s.tallMatchesPreview === Infinity && s.reframeChanged === true, `vertical export: size ${s.tallSize}, vs preview ${s.tallMatchesPreview}, reframe changed ${s.reframeChanged}`);
    check((s.formats as string[]).includes('png') && (s.formats as string[]).includes('wav') && JSON.stringify(s.impossible) === '["png","wav"]', `formats offered: ${s.formats}; at an impossible size: ${s.impossible}`);

    const c = await page.evaluate(() => window.T.phase8.cancelAndFail());
    check(JSON.stringify(c.afterCancel) === '[]', `files left after cancelling: ${JSON.stringify(c.afterCancel)} (during: ${JSON.stringify(c.during)})`);
    check(JSON.stringify(c.states) === JSON.stringify(['cancelled', 'cancelled', 'failed']), `states ${JSON.stringify(c.states)}`);
    check(/could not be created in that location/.test(String(c.refusedMessage)) && /not enough disk space/.test(String(c.fullMessage)) && c.projectIntact === true, `messages: ${c.refusedMessage} / ${c.fullMessage}`);

    const b = await page.evaluate(() => window.T.phase8.batch());
    check(b.files.length === 20 && b.valid === 20 && b.states.every((x) => x === 'done'), `batch: ${b.files.length} files, ${b.valid} valid, frames ${b.frames.join(',')}`);
    check(b.files[0] === 'Clip - Part 01.mp4' && b.files[19] === 'Clip - Part 20.mp4', `batch names: ${b.files[0]} .. ${b.files[19]}`);

    const l = await page.evaluate(() => window.T.phase8.longExport(600));
    const mb = (n: number | string | null | undefined): string => (Number(n) / 1048576).toFixed(1);
    console.log(`[export] 10-minute export: ${l.state}, ${l.frames} frames in ${(Number(l.ms) / 1000).toFixed(1)} s, file ${mb(l.size)} MiB; page heap ${mb(l.heapFirst)} -> ${mb(l.heapLast)} MiB (max ${mb(l.heapMax)})`);
    check(l.state === 'done' && l.frames === 14400 && Math.abs(Number(l.duration) - 600) < 0.01, `10-minute export: ${l.state} ${l.message ?? ''}, ${l.frames} frames, ${l.duration} s`);
    check(l.bytesHeld === 0, 'a streamed export kept the file in memory');
    check(Number(l.heapMax) - Number(l.heapFirst) < 64 * 1048576, `page heap grew by ${mb(Number(l.heapMax) - Number(l.heapFirst))} MiB during a 10-minute export`);

    // --- The export dialog in the app ---
    const ui = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    ui.on('pageerror', (err) => failures.push(`page error: ${err.message}`));
    await ui.goto(served.app);
    await ui.waitForFunction(() => !!(window as unknown as Win).cutline);
    await ui.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
    await ui.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
    await ui.locator('.bin .item').dblclick();
    await ui.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
    // Headless Chrome has no save dialog to answer, so exports go to memory and arrive as downloads.
    await ui.evaluate(() => ((window as unknown as Win).cutline.app.exportDestination = async () => ({ kind: 'memory' })));
    await ui.locator('canvas[data-role=timeline]').focus();
    await ui.keyboard.press('Control+KeyE');
    await ui.locator('#exp-format').waitFor();
    const offered = await ui.locator('#exp-format option').evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    check(offered.includes('png') && offered.includes('wav') && offered.every((o) => (s.formats as string[]).includes(o)), `dialog offers ${offered}; this machine supports ${s.formats}`);
    await ui.locator('#exp-size').selectOption('custom');
    await ui.locator('#exp-width').fill('7');
    await ui.keyboard.press('Tab');
    await ui.locator('.dialog [data-role=start]').click();
    check(/between 16 and 8192/.test((await ui.locator('.dialog .warn').textContent()) ?? ''), 'a bad custom size should be refused with a message');
    await ui.locator('#exp-size').selectOption('vertical');
    await ui.locator('#exp-format').selectOption('png');
    await ui.locator('#exp-name').fill('poster');
    await ui.keyboard.press('Tab');
    const [file] = await Promise.all([ui.waitForEvent('download'), ui.locator('.dialog [data-role=start]').click()]);
    const png = fs.readFileSync(await file.path());
    check(file.suggestedFilename() === 'poster.png' && png.readUInt32BE(0) === 0x89504e47 && png.readUInt32BE(16) === 1080 && png.readUInt32BE(20) === 1920, `PNG export from the dialog: ${file.suggestedFilename()}, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    await ui.locator('.dialog [data-state=done]').waitFor();
    // Offline media: the export is refused with the reason, and the project is untouched.
    await ui.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      app.library.detach(app.session.project.media[0].id);
    });
    await ui.locator('.dialog [data-role=start]').click();
    check(/Relink this media before exporting.*clip_24/.test((await ui.locator('.dialog .warn').textContent()) ?? ''), 'export with offline media should be refused with a message');
    check((await ui.evaluate(() => (window as unknown as Win).cutline.app.session.seq.tracks[0].clips.length)) === 1, 'the project changed after a refused export');
    await ui.close();
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
