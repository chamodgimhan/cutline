// Desktop smoke: launches the real Electron shell with the built app and drives it.
// Skipped with a note when the Electron runtime is not installed (run node desktop/build.mjs --dir first).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron, type ElectronApplication, type Page } from 'playwright-core';
import { build } from 'vite';
import { OUT_DIR } from '../fixtures/generate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DESKTOP = path.join(ROOT, 'desktop');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any }; cutlineDesktop: any };

export const electronBinary = (): string | null => {
  const file = path.join(DESKTOP, 'node_modules/electron/path.txt');
  if (!fs.existsSync(file)) return null;
  const exe = path.join(DESKTOP, 'node_modules/electron/dist', fs.readFileSync(file, 'utf8').trim());
  return fs.existsSync(exe) ? exe : null;
};

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  // CUTLINE_PACKAGED=1 tests the packaged app (desktop/dist/win-unpacked) instead of the unpackaged shell.
  const packaged = process.env.CUTLINE_PACKAGED ? path.join(DESKTOP, 'dist/win-unpacked/Cutline.exe') : null;
  const exe = packaged ?? electronBinary();
  const base = packaged ? [] : [DESKTOP];
  if (!exe) {
    console.log('[desktop] Electron runtime is not installed here: the desktop shell was NOT launched or tested.');
    return failures;
  }
  if (!packaged) {
    await build({ root: ROOT, logLevel: 'error' });
    fs.rmSync(path.join(DESKTOP, 'app'), { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'dist'), path.join(DESKTOP, 'app'), { recursive: true });
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutline-desktop-'));
  const projectFile = path.join(tmp, 'smoke.cutline');
  const running: ElectronApplication[] = [];
  const launch = async (...args: string[]): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await _electron.launch({ executablePath: exe, args: [...base, `--user-data-dir=${path.join(tmp, 'profile')}`, ...args] });
    running.push(app);
    const page = await app.firstWindow();
    page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
    await page.waitForFunction(() => !!(window as unknown as Win).cutline?.app.actions.some((a: { id: string }) => a.id === 'file.save'), undefined, { timeout: 30_000 });
    return { app, page };
  };
  const st = <T>(page: Page, expr: string): Promise<T> => page.evaluate((x) => new Function('app', `return ${x}`)((window as unknown as Win).cutline.app) as T, expr);
  try {
    let { app, page } = await launch();
    // The shell: isolated page, no Node in it, loaded from its own protocol.
    const env = await page.evaluate(() => ({
      url: location.href, hasBridge: typeof (window as unknown as Win).cutlineDesktop === 'object', bridge: Object.keys((window as unknown as Win).cutlineDesktop).sort(),
      node: typeof (window as unknown as { require?: unknown }).require !== 'undefined' || typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    }));
    check(env.url === 'app://cutline/index.html' && env.hasBridge && !env.node, `shell environment: ${JSON.stringify(env)}`);
    check(env.bridge.length <= 12, `the preload API should stay narrow; it exposes ${env.bridge.length} functions: ${env.bridge}`);
    const prefs = await app.evaluate(({ BrowserWindow, Menu }) => {
      const w = BrowserWindow.getAllWindows()[0];
      const p = w?.webContents.getLastWebPreferences();
      return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox, title: w?.getTitle(), menu: !!Menu.getApplicationMenu() };
    });
    check(prefs.contextIsolation === true && prefs.nodeIntegration === false && prefs.sandbox === true && prefs.menu, `window preferences: ${JSON.stringify(prefs)}`);

    // Import by picker: the asset records the real path. Edit, then Save As through the (stubbed) native dialog.
    await page.setInputFiles('input[data-role=import]', path.join(OUT_DIR, 'clip_24.mp4'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.project.media.length === 1);
    check(path.resolve(await st<string>(page, 'app.session.project.media[0].path')) === path.join(OUT_DIR, 'clip_24.mp4'), `imported media path: ${await st(page, 'app.session.project.media[0].path')}`);
    await page.locator('.bin .item').dblclick();
    await page.locator('[data-monitor=source] button', { hasText: 'Overwrite' }).click();
    // A native menu item reaches the page as an action.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('action', 'mark.add'));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 1);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, projectFile);
    await page.evaluate(() => (window as unknown as Win).cutline.app.run('file.saveAs'));
    await page.waitForFunction(() => !(window as unknown as Win).cutline.app.session.history.dirty);
    const saved = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as { app: string; project: { sequences: { markers: unknown[]; tracks: { clips: unknown[] }[] }[] } };
    check(saved.app === 'cutline' && saved.project.sequences[0]?.markers.length === 1 && saved.project.sequences[0]?.tracks[0]?.clips.length === 1, 'the project file written through the native save dialog');
    // Closing with unsaved changes asks first; "Don't Save" then closes the window.
    await page.locator('canvas[data-role=timeline]').focus();
    await page.keyboard.press('KeyM');
    void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await page.locator('.dialog [data-answer="Cancel"]').waitFor();
    await page.locator('.dialog [data-answer="Cancel"]').click();
    check((await app.windows()).length === 1, 'cancelling the unsaved-changes prompt must keep the window open');
    const closed = app.waitForEvent('close');
    void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await page.locator(`.dialog [data-answer="Don't Save"]`).click();
    await closed;
    check(fs.existsSync(path.join(tmp, 'profile', 'window.json')), 'window size and position were not remembered');

    // Relaunch with the project file as the argument (what double-clicking a .cutline file does).
    ({ app, page } = await launch(projectFile));
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.markers.length === 1, undefined, { timeout: 8_000 });
    await page.locator('.dialog [data-answer="Discard"]').click({ timeout: 1500 }).catch(() => undefined); // no recovery prompt is expected
    // Its media is found again by path and read through the shell's media protocol.
    await page.waitForFunction(() => (window as unknown as Win).cutline.app.library.status((window as unknown as Win).cutline.app.session.project.media[0].id) === 'online', undefined, { timeout: 8_000 });
    const spec = await st<{ kind: string; url: string }>(page, 'app.spec(app.session.project.media[0])');
    check(spec.kind === 'url' && spec.url.startsWith('app://cutline/__media__/'), `media source after reopening: ${JSON.stringify(spec)}`);
    // The picture really decodes through that protocol: the program monitor shows the clip, not the offline placeholder.
    await page.evaluate(() => (window as unknown as Win).cutline.app.program.transport.seek(705600000 / 2));
    await page.waitForTimeout(1500);
    const pixel = await page.evaluate(() => {
      const c = (window as unknown as Win).cutline.app.program.renderer.readPixels() as Uint8Array;
      const w = (window as unknown as Win).cutline.app.program.canvas.width as number;
      const at = (Math.floor(((window as unknown as Win).cutline.app.program.canvas.height as number) * 0.8) * w + Math.floor(w * 0.5)) * 4;
      return [c[at], c[at + 1], c[at + 2]];
    });
    check(JSON.stringify(pixel) !== '[90,22,26]' && JSON.stringify(pixel) !== '[0,0,0]', `program monitor pixel after reopening: ${JSON.stringify(pixel)}`);
    // No network: attempts are refused, and a normal session made no outside request at all.
    const before = await page.evaluate(() => (window as unknown as Win).cutlineDesktop.blockedRequests() as Promise<string[]>);
    check(before.length === 0, `requests the shell had to block during a normal session: ${before.join(', ')}`);
    const tried = await page.evaluate(() => fetch('https://example.com/x').then(() => 'reached', () => 'blocked'));
    check(tried === 'blocked', 'a network request from the page was not blocked');
    const media = await page.evaluate(() => fetch('/__media__/' + encodeURIComponent('C:/Windows/win.ini')).then((r) => r.status, () => 0));
    check(media === 403 || media === 0, `a file the user never chose was readable through the media protocol (status ${media})`);
    // A second launch hands over to the first instead of opening another window.
    const second = await _electron.launch({ executablePath: exe, args: [...base, `--user-data-dir=${path.join(tmp, 'profile')}`] }).then(async (a) => {
      await a.waitForEvent('close', { timeout: 10_000 }).catch(() => undefined);
      return a.windows().length;
    }, () => 0);
    check(second === 0 && (await app.windows()).length === 1, 'a second launch opened another window');
    const done = app.waitForEvent('close');
    await app.evaluate(({ app: a }) => a.exit(0));
    await done;
    console.log(`[desktop] Electron shell launched and passed its smoke test (${packaged ? 'packaged app from desktop/dist/win-unpacked' : 'unpackaged'}).`);
  } finally {
    for (const a of running) await a.evaluate(({ app: x }) => x.exit(0)).catch(() => undefined);
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      // the profile can stay locked for a moment after exit; a leftover temp folder is harmless
    }
  }
  return failures;
}
