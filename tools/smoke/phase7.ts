// Phase 7 smoke: title and burned-in caption frames against stored hashes, and the caption UI.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCaptions, serialiseSrt, serialiseVtt } from '../../src/core/captions.ts';
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HASHES = path.join(ROOT, 'fixtures/text-hashes.json');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Win = { cutline: { app: any } };

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const eq = (got: unknown, want: unknown, what: string): void => check(JSON.stringify(got) === JSON.stringify(want), `${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  const update = process.env.CUTLINE_UPDATE === '1';
  const stored = fs.existsSync(HASHES) ? (JSON.parse(fs.readFileSync(HASHES, 'utf8')) as Record<string, string>) : {};
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);
    const t = await page.evaluate(() => window.T.phase7.titles());
    for (const [name, r] of Object.entries(t)) if (!update) check(stored[name] === r.hash, `${name}: frame hash ${r.hash} differs from stored ${stored[name]}`);
    if (update) {
      fs.writeFileSync(HASHES, JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.hash])), null, 1) + '\n');
      console.log(`[update] wrote ${Object.keys(t).length} title and caption hashes`);
    }
    // Where the text landed, as fractions of the frame: [left, top, right, bottom].
    const box = (name: string): number[] => t[name]?.box ?? [9, 9, 9, 9];
    check(t.plain?.box === null && t['caption.hiddenTrack']?.box === null, 'a frame without visible text changed');
    const d = box('title.default');
    check(Math.abs((d[0]! + d[2]!) / 2 - 0.5) < 0.02 && Math.abs((d[1]! + d[3]!) / 2 - 0.5) < 0.05, `default title is not centred: ${d}`);
    const tl = box('title.topLeft');
    check(tl[0]! >= 0.05 && tl[0]! < 0.12 && tl[1]! >= 0.05 && tl[3]! < 0.3 && tl[2]! < 0.7, `top-left title box ${tl}`);
    const br = box('title.bottomRight');
    check(br[2]! <= 0.9 && br[2]! > 0.84 && br[3]! <= 0.9 && br[1]! > 0.7 && br[0]! > 0.3, `bottom-right title with a 10% margin: ${br}`);
    const w = box('title.wrapped');
    check(w[0]! >= 0.04 && w[2]! <= 0.96 && w[3]! - w[1]! > 0.3, `wrapped title should span several lines inside the margins: ${w}`);
    const s = box('title.styled');
    check(s[2]! - s[0]! > d[2]! - d[0]! && s[3]! - s[1]! > d[3]! - d[1]!, `styled title (box, stroke, shadow) should cover more than the plain one: ${s} vs ${d}`);
    const [e, l] = [box('title.animated.early'), box('title.animated.late')];
    check(l[2]! - l[0]! > (e[2]! - e[0]!) * 1.5 && t['title.animated.early']?.hash !== t['title.animated.late']?.hash, `keyframed title should grow: ${e} then ${l}`);
    const c = box('caption.burnedIn');
    check(c[1]! > 0.65 && c[3]! <= 0.96 && Math.abs((c[0]! + c[2]!) / 2 - 0.5) < 0.02, `burned-in caption should sit bottom centre: ${c}`);
    const ch = box('caption.half');
    check(ch.every((v, i) => Math.abs(v - c[i]!) < 0.02), `caption at half preview size moved: ${ch} vs ${c}`);
    const both = box('caption.overTitle');
    check(both[1]! < 0.2 && both[3]! > 0.8, `title and caption together: ${both}`);
    eq(await page.evaluate(() => window.T.phase7.speechControl()), { without: false, with: true }, 'speech-to-text control');

    // --- The UI, with real input ---
    const ui = await browser.newPage({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
    ui.on('pageerror', (err) => failures.push(`page error: ${err.message}`));
    await ui.goto(served.url + '/index.html');
    await ui.waitForFunction(() => !!(window as unknown as Win).cutline);
    const st = <T>(expr: string): Promise<T> => ui.evaluate((x) => new Function('app', 'S', `return ${x}`)((window as unknown as Win).cutline.app, 705600000) as T, expr);
    const settle = (): Promise<void> => ui.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const canvas = ui.locator('canvas[data-role=timeline]');
    check(!(await st<string[]>('app.actions.map((a) => a.id)')).includes('caption.transcribe'), 'a transcribe action exists although no provider is configured');
    await ui.locator('.menubar [data-menu=Titles]').click();
    check((await ui.locator('.menu button').allTextContents()).every((label) => !/transcri/i.test(label)), 'the Titles menu shows a transcribe item with no provider');
    await ui.keyboard.press('Escape');

    await canvas.focus();
    await ui.keyboard.press('Control+KeyT');
    await settle();
    await ui.locator('#insp-text-text').fill('Opening\nTitle');
    await ui.keyboard.press('Tab');
    await settle();
    await ui.locator('#insp-text-size').fill('90');
    await ui.keyboard.press('Tab');
    await settle();
    await ui.locator('#insp-text-colour').fill('#FF8800');
    await ui.keyboard.press('Tab');
    await settle();
    await ui.locator('#insp-text-font').selectOption('Roboto Slab');
    await settle();
    eq(await st('(() => { const c = app.session.seq.tracks[0].clips[0]; return [c.kind, c.duration / S, c.text.text, c.text.size, c.text.color, c.text.font]; })()'), ['text', 5, 'Opening\nTitle', 90, '#ff8800', 'Roboto Slab'], 'add and edit a title');
    await ui.locator('#insp-text-colour').fill('orange');
    await ui.keyboard.press('Tab');
    await settle();
    check(/#rrggbb/.test(await st<string>('app.session.message')) && (await st('app.session.seq.tracks[0].clips[0].text.color')) === '#ff8800', 'a bad colour should be refused with a message');

    // Import an SRT file through the file input, then edit cues.
    await ui.setInputFiles('input[data-role=caption-import]', path.join(ROOT, 'fixtures/captions/good.srt'));
    await ui.waitForFunction(() => (window as unknown as Win).cutline.app.session.seq.tracks.some((tr: { kind: string; clips: unknown[] }) => tr.kind === 'caption' && tr.clips.length === 3));
    const cues = parseCaptions(fs.readFileSync(path.join(ROOT, 'fixtures/captions/good.srt'), 'utf8'));
    const cueText = `app.session.seq.tracks.find((t) => t.kind === 'caption').clips.map((c) => [c.start, c.start + c.duration, c.text.text])`;
    eq(await st(cueText), cues.map((q) => [q.start, q.end, q.text]), 'imported cues');
    for (const [ext, text] of [['Srt', serialiseSrt(cues)], ['Vtt', serialiseVtt(cues)]] as const) {
      const [download] = await Promise.all([ui.waitForEvent('download'), ui.evaluate((id) => (window as unknown as Win).cutline.app.run(id), `caption.export${ext}`)]);
      eq(fs.readFileSync(await download.path(), 'utf8'), text, `exported ${ext} sidecar file`);
      check(download.suggestedFilename().endsWith('.' + ext.toLowerCase()), `export file name ${download.suggestedFilename()}`);
    }
    // Split the first cue at 1.75 s (frame 53 at 30 fps), then merge the halves back.
    await ui.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      const first = app.session.seq.tracks.find((tr: { kind: string }) => tr.kind === 'caption').clips[0];
      app.session.select([first.id]);
      app.program.transport.seek(705600000 * 1.75);
      app.run('caption.split');
    });
    eq((await st<unknown[][]>(cueText)).slice(0, 2), [[cues[0]!.start, 1246560000, 'Hello'], [1246560000, cues[0]!.end, 'there.']], 'split caption');
    await ui.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      const track = app.session.seq.tracks.find((tr: { kind: string }) => tr.kind === 'caption');
      app.session.select([track.clips[0].id, track.clips[1].id]);
      app.run('caption.merge');
    });
    eq((await st<unknown[][]>(cueText))[0], [cues[0]!.start, cues[0]!.end, 'Hello\nthere.'], 'merge captions');
    // Retime by dragging a cue edge on the timeline: it stops at the next cue.
    await ui.evaluate(() => {
      const { app } = (window as unknown as Win).cutline;
      app.session.view.pxPerSecond = 100;
      app.session.view.scrollX = 0;
      app.session.emit();
    });
    await settle();
    const b = (await canvas.boundingBox()) as { x: number; y: number };
    const y = b.y + 24 + 20; // caption tracks are the top row
    await ui.mouse.move(b.x + 250, y);
    await ui.mouse.down();
    await ui.mouse.move(b.x + 200, y, { steps: 3 });
    await ui.mouse.move(b.x + 400, y, { steps: 3 });
    await ui.mouse.up();
    eq((await st<number[][]>(cueText))[0]?.[1], cues[1]!.start, 'dragging a cue end stops at the next cue');
    // Burn-in toggle.
    await ui.evaluate(() => (window as unknown as Win).cutline.app.run('caption.burnIn'));
    eq(await st(`app.session.seq.tracks.find((t) => t.kind === 'caption').hidden`), true, 'burn-in off hides the caption track from the picture');
    await ui.close();
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
