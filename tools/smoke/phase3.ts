// Phase 3 smoke: render check against stored hashes, fallback compositor, scrub budget, playback.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RENDER_FRAMES } from '../fixtures/renderProject.ts';
import { launch } from './browser.ts';
import type { SyncResult } from './page/playback.page.ts';
import { openHarness, serve } from './server.ts';

const HASHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/render-hashes.json');
type Stored = Record<string, { full: string; half: string }>;

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1] ?? 0;

/** Audio heard, transport timeline and frames drawn must agree to within one frame, start to finish. */
export function checkSync(r: SyncResult, label: string, fps: number, check: (ok: boolean, message: string) => void): void {
  const frameMs = 1000 / fps;
  const worstClick = Math.max(...r.clickErrorMs.map(Math.abs));
  const n = r.lagFrames.length;
  const head = median(r.lagFrames.slice(0, Math.ceil(n / 10)));
  const tail = median(r.lagFrames.slice(-Math.ceil(n / 10)));
  console.log(
    `[sync ${label}] ${r.clickErrorMs.length} clicks, worst audio/timeline error ${worstClick.toFixed(2)} ms; picture lag median ${median(r.lagFrames).toFixed(2)} frames ` +
      `(first tenth ${head.toFixed(2)}, last tenth ${tail.toFixed(2)}); ${(r.presented / r.seconds).toFixed(1)} fps drawn, ${r.dropped} dropped`,
  );
  check(r.clickErrorMs.length >= r.seconds * 0.9, `${label}: heard ${r.clickErrorMs.length} clicks in ${r.seconds} s`);
  check(worstClick < frameMs, `${label}: audio is ${worstClick.toFixed(1)} ms from the timeline (one frame is ${frameMs.toFixed(1)} ms)`);
  check(median(r.lagFrames) < 1 && median(r.lagFrames) >= 0, `${label}: picture lags audio by ${median(r.lagFrames).toFixed(2)} frames`);
  check(Math.abs(tail - head) < 1, `${label}: picture lag drifted from ${head.toFixed(2)} to ${tail.toFixed(2)} frames`);
  check(r.counterOk, `${label}: the frame on screen after pausing is not the frame under the playhead`);
  check(Math.abs(r.endSecond - r.seconds) < 1.5, `${label}: played ${r.endSecond.toFixed(2)} s of timeline in ${r.seconds} s`);
  check(r.presented / r.seconds > fps * 0.5, `${label}: only ${(r.presented / r.seconds).toFixed(1)} fps drawn`);
}

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const update = process.env.CUTLINE_UPDATE === '1';
  const stored: Stored = fs.existsSync(HASHES) ? (JSON.parse(fs.readFileSync(HASHES, 'utf8')) as Stored) : {};
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);

    // Render check: fixed frames of the fixture project against stored hashes.
    const r = await page.evaluate((f) => window.T.phase3.renderCheck(f), RENDER_FRAMES);
    check(r.backend === 'webgl2' && r.fallback === 'canvas2d', `backends: ${r.backend} / ${r.fallback}`);
    const next: Stored = {};
    for (const f of r.results) {
      next[f.frame] = { full: f.hash, half: f.half };
      if (!update) {
        check(stored[f.frame]?.full === f.hash, `render frame ${f.frame}: hash ${f.hash} differs from stored ${stored[f.frame]?.full}`);
        check(stored[f.frame]?.half === f.half, `render frame ${f.frame} at half size: hash differs from stored`);
      }
      check(f.size === 640 * 360 * 4 + 320 * 180 * 4, `render frame ${f.frame}: wrong output size`);
      // The base clip is 24 fps under a 30 fps sequence: sequence frame n shows source frame floor(n * 24 / 30).
      check(f.counter === Math.floor((f.frame * 24) / 30), `render frame ${f.frame}: base clip shows source frame ${f.counter}`);
      check(f.fallbackPsnr >= 30, `render frame ${f.frame}: 2D fallback differs too much from GL (${f.fallbackPsnr.toFixed(1)} dB)`);
    }
    check(new Set(r.results.map((f) => f.hash)).size === r.results.length, 'render frames are not all different');
    if (update) {
      fs.writeFileSync(HASHES, JSON.stringify(next, null, 1) + '\n');
      console.log(`[update] wrote ${Object.keys(next).length} render hashes`);
    }
    console.log(`[info] 2D fallback vs GL: ${r.results.map((f) => f.fallbackPsnr.toFixed(0)).join('/')} dB`);

    const off = await page.evaluate(() => window.T.phase3.offlinePixel());
    check(JSON.stringify(off) === JSON.stringify([90, 22, 26]), `offline media pixel ${JSON.stringify(off)}`);

    // Scrub budget through renderFrame on the 1080p fixture.
    const order = [45, 3, 59, 17, 31, 8, 52, 29, 14, 38];
    const s = await page.evaluate((f) => window.T.phase3.scrub(f), order);
    const worst = Math.max(...s.ms);
    console.log(`[budget] 1080p scrub through renderFrame: worst ${worst.toFixed(0)} ms, mean ${(s.ms.reduce((a, b) => a + b, 0) / s.ms.length).toFixed(0)} ms (limit 150)`);
    check(worst <= 150, `1080p scrub worst case ${worst.toFixed(0)} ms exceeds 150 ms`);
    check(JSON.stringify(s.counters) === JSON.stringify(order), `scrub showed frames ${JSON.stringify(s.counters)}`);

    // renderAudio: exact samples, chunk-independent, sums tracks, honours mute and solo.
    const m = await page.evaluate(() => window.T.playback.audioMix());
    check(m.length === 96000 && m.chunkLength === 96000 && m.empty === 0, `audio mix lengths ${m.length}/${m.chunkLength}/${m.empty}`);
    for (const k of ['left', 'right', 'chunkLeft', 'sum', 'muted', 'solo', 'offline'] as const) check((m[k] as number) <= 1 / 65536, `audio mix "${k}" is off by ${m[k]}`);

    const c = await page.evaluate(() => window.T.playback.controls());
    const expectControls: Record<string, unknown> = {
      seek: [30, 30, false], step: [28, 28], half: [160, 90, 28], shuttle: [1, 2, false, true, true], reverse: [-1, -2, true, true],
      end: [false, true, 119], restart: [true, true], loop: [true, true, true, true], events: true,
    };
    for (const [k, want] of Object.entries(expectControls)) check(JSON.stringify(c[k]) === JSON.stringify(want), `transport ${k}: ${JSON.stringify(c[k])}, expected ${JSON.stringify(want)}`);

    // Sync over 20 s here; the 10-minute run is the separate "drift" suite.
    checkSync(await page.evaluate(() => window.T.playback.sync(20)), '20 s', 24, check);
    const hd = await page.evaluate(() => window.T.playback.sync(5, 'hd_1080', 30, 1920, 1080));
    console.log(`[fps] 1080p playback: ${(hd.presented / hd.seconds).toFixed(1)} fps drawn of 30 (${hd.dropped} dropped), software GL`);
    check(hd.clickErrorMs.length >= 1 && hd.clickErrorMs.every((e) => Math.abs(e) < 33), `1080p playback: audio clicks off by ${hd.clickErrorMs.map((e) => e.toFixed(1))} ms`);
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
