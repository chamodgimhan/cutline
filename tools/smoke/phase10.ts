// Phase 10 smoke (web build): watermark by frame hash, the About and Licence dialog, and no network access.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadPrivateKey, PRIVATE_KEY_FILE } from '../../keygen/keygen.ts';
import { PRODUCT, signLicense } from '../../src/core/license.ts';
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
  process.env.CUTLINE_BUILD = '1'; // these checks are about what ships: the production build
  const served = await serve();
  const browser = await launch();
  try {
    const harness = await openHarness(browser, served, failures);
    const w = await harness.evaluate(() => window.T.phase10.watermark());
    check(w.licensedHash === w.previewHash, 'with a licence the exported frame should equal renderFrame exactly (no watermark)');
    check(w.unlicensedHash !== w.previewHash && w.unlicensedHash === w.expectedMarkedHash, 'without a licence the exported frame should be renderFrame plus the watermark, exactly');
    check(w.changedOutside === 0 && (w.changedInside as number) > (w.boxPixels as number) * 0.9, `watermark changed ${w.changedInside} pixels inside its box of ${w.boxPixels} and ${w.changedOutside} outside`);
    check(w.movieState === 'done' && w.movieMismatches === 0, `watermarked movie export: ${w.movieState}, ${w.movieMismatches} frames differ from what was rendered`);
    await harness.close();

    // --- The app itself, with every request it makes recorded ---
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    const origin = new URL(served.app).origin;
    const requests: string[] = [];
    context.on('request', (r) => requests.push(r.url()));
    // What became of each request: answered by a server, or stopped before leaving (and why).
    const answered: string[] = [];
    const stopped = new Map<string, string>();
    context.on('response', (r) => answered.push(r.url()));
    context.on('requestfailed', (r) => stopped.set(r.url(), r.failure()?.errorText ?? ''));
    const page = await context.newPage();
    page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
    await page.goto(served.app);
    await page.waitForFunction(() => !!(window as unknown as Win).cutline?.app.actions.some((a: { id: string }) => a.id === 'file.save'));
    const st = <T>(expr: string): Promise<T> => page.evaluate((x) => new Function('app', `return ${x}`)((window as unknown as Win).cutline.app) as T, expr);
    const act = (id: string): Promise<void> => page.evaluate((x) => (window as unknown as Win).cutline.app.run(x), id);

    // About and Licence dialog.
    await act('help.about');
    const status = page.locator('[data-role=license-status]');
    check(/Not activated.*watermark/.test((await status.textContent()) ?? ''), `licence status at first: ${await status.textContent()}`);
    check(/Chamod Gimhan/.test((await page.locator('.dialog').textContent()) ?? ''), 'the About dialog should name the owner');
    await page.locator('.dialog textarea').fill('CUTLINE-not-a-real-key');
    await page.locator('.dialog [data-role=activate]').click();
    await page.waitForFunction(() => /not a Cutline licence key/.test(document.querySelector('[data-role=license-status]')?.textContent ?? ''));
    check((await st('app.license.state')) === 'none', 'a bad key must not activate');
    if (fs.existsSync(PRIVATE_KEY_FILE)) {
      const key = await signLicense({ product: PRODUCT, name: 'Smoke Test', edition: 'Pro', issued: '2026-11-14', expires: null }, await loadPrivateKey());
      // A tampered copy of a real key.
      await page.locator('.dialog textarea').fill(key.slice(0, 30) + (key[30] === 'A' ? 'B' : 'A') + key.slice(31));
      await page.locator('.dialog [data-role=activate]').click();
      await page.waitForFunction(() => /not valid|not a Cutline/.test(document.querySelector('[data-role=license-status]')?.textContent ?? ''));
      await page.locator('.dialog textarea').fill(key);
      await page.locator('.dialog [data-role=activate]').click();
      await page.waitForFunction(() => /Licensed to Smoke Test \(Pro\)/.test(document.querySelector('[data-role=license-status]')?.textContent ?? ''));
      await page.locator('.dialog [data-role=close]').click();
      // The key survives a restart, and exports then carry no watermark.
      await page.reload();
      await page.waitForFunction(() => (window as unknown as Win).cutline?.app.license.state === 'valid');
      await page.evaluate(() => {
        const { app } = (window as unknown as Win).cutline;
        app.exportDestination = async () => ({ kind: 'memory' });
        const add = app.exports.add.bind(app.exports);
        app.exports.add = (...args: unknown[]) => {
          app.lastWatermark = args[5];
          return add(...args);
        };
      });
      await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
      await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
      await page.locator('.bin .item').dblclick();
      await page.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
      await act('file.export');
      await page.locator('#exp-format').selectOption('png');
      const [d1] = await Promise.all([page.waitForEvent('download'), page.locator('.dialog [data-role=start]').click()]);
      check((await st('app.lastWatermark')) === false && d1.suggestedFilename().endsWith('.png'), 'licensed export should not ask for a watermark');
      await page.locator('.dialog [data-role=close]').click();
      await act('help.about');
      await page.locator('.dialog [data-role=deactivate]').click();
      await page.waitForFunction(() => /Not activated/.test(document.querySelector('[data-role=license-status]')?.textContent ?? ''));
      await page.locator('.dialog [data-role=close]').click();
      await act('file.export');
      await page.locator('#exp-format').selectOption('png');
      await Promise.all([page.waitForEvent('download'), page.locator('.dialog [data-role=start]').click()]);
      check((await st('app.lastWatermark')) === true, 'after deactivating, exports should be watermarked again');
      await page.locator('.dialog [data-role=close]').click();
    } else console.log('[note] no private key on this machine: activation with a real key was not exercised');

    // A little more of a normal session: play, edit, save a project.
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    await page.keyboard.press('Space');
    await page.keyboard.press('KeyM');
    // The page tries to reach the network in several ways; the policy must stop every one of them.
    const blocked = await page.evaluate(async () => {
      const tries: Record<string, string> = {};
      tries.fetch = await fetch('https://example.com/data.json').then(() => 'reached', () => 'blocked');
      tries.image = await new Promise<string>((r) => {
        const i = new Image();
        i.onload = () => r('reached');
        i.onerror = () => r('blocked');
        i.src = 'https://example.com/pixel.png';
      });
      tries.socket = await new Promise<string>((r) => {
        try {
          const s = new WebSocket('wss://example.com/socket');
          s.onopen = () => r('reached');
          s.onerror = () => r('blocked');
        } catch {
          r('blocked');
        }
      });
      tries.script = await new Promise<string>((r) => {
        const el = document.createElement('script');
        el.onload = () => r('reached');
        el.onerror = () => r('blocked');
        el.src = 'https://example.com/lib.js';
        document.head.append(el);
      });
      return tries;
    });
    check(Object.values(blocked).every((v) => v === 'blocked'), `network attempts: ${JSON.stringify(blocked)}`);
    const foreign = (u: string): boolean => !u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:');
    const left = answered.filter(foreign);
    const attempts = requests.filter(foreign);
    const notByPolicy = attempts.filter((u) => !/CSP|BLOCKED_BY_CLIENT/i.test(stopped.get(u) ?? ''));
    console.log(`[network] ${requests.length} requests in the session; ${attempts.length} aimed outside the app (the test's own attempts), all stopped by the content security policy; ${left.length} answered from outside`);
    check(left.length === 0, `requests left the app: ${left.slice(0, 5).join(', ')}`);
    check(notByPolicy.length === 0, `outside requests not stopped by the policy: ${notByPolicy.map((u) => `${u} (${stopped.get(u) ?? 'no failure'})`).join(', ')}`);
    check(requests.some((u) => u.endsWith('.woff2') || u.includes('Worker')) && requests.length > 3, 'the session did not load the app');
    await context.close();
  } finally {
    await browser.close();
    await served.close();
    delete process.env.CUTLINE_BUILD;
  }
  return failures;
}
