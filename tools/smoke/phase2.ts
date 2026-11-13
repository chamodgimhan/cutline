// Phase 2 smoke: frame-accurate decode of every fixture in headless Chrome.
import { TICKS_PER_SECOND } from '../../src/core/time.ts';
import { FIXTURES, frameTiming } from '../fixtures/build.ts';
import { readManifest } from '../fixtures/generate.ts';
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const manifest = readManifest();
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);

    // Frame N of every fixture: stored hash, burned-in counter, displayed size, presentation time.
    for (const spec of FIXTURES) {
      const entry = manifest[spec.name];
      const all = Object.keys(entry?.frameHashes ?? {}).map(Number);
      const indices = spec.hashFrames === 'sparse' ? [0, 10007, 90063, 170119, 172799].filter((i) => all.includes(i)) : all;
      const got = await page.evaluate(([n, idx]) => window.T.phase2.frames(n, idx), [spec.name, indices] as const);
      const { timescale, durations } = frameTiming(spec);
      const starts: number[] = [];
      durations.reduce((t, d) => (starts.push(t), t + d), 0);
      const rotated = spec.rotation === 90;
      check(got.length === indices.length && indices.length >= 4, `${spec.name}: decoded ${got.length} of ${indices.length} frames`);
      for (const f of got) {
        check(f.hash === entry?.frameHashes?.[f.index], `${spec.name} frame ${f.index}: hash ${f.hash} differs from stored`);
        check(f.counter === f.index, `${spec.name} frame ${f.index}: burned-in counter reads ${f.counter}`);
        check(f.shown === f.index, `${spec.name} frame ${f.index}: displayed counter reads ${f.shown}`);
        check(f.width === (rotated ? spec.height : spec.width) && f.height === (rotated ? spec.width : spec.height), `${spec.name}: displayed size ${f.width}x${f.height}`);
        check(f.time === Math.round(((starts[f.index] as number) * TICKS_PER_SECOND) / timescale), `${spec.name} frame ${f.index}: time ${f.time}`);
      }
    }

    // VFR: sequence times map to the frame on screen at that presentation time.
    const vfr = await page.evaluate(() => window.T.phase2.indicesAtMs('vfr', [0, 32, 33, 49, 50, 99, 100, 199, 200, 215, 216, 299, 300, 1999]));
    check(JSON.stringify(vfr) === JSON.stringify([0, 0, 1, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 52]), `vfr time mapping: ${JSON.stringify(vfr)}`);

    // Random seeks equal sequential decode.
    for (const name of ['clip_24', 'clip_60', 'vfr', 'rotated']) {
      const r = await page.evaluate((n) => window.T.phase2.seekTest(n, 7, 60), name);
      check(r.mismatches.length === 0, `${name}: random seeks differ from sequential decode at frames ${r.mismatches.join(',')}`);
      check(r.sequentialRestarts <= 1, `${name}: sequential decode restarted the decoder ${r.sequentialRestarts} times`);
      check(r.restarts > 5, `${name}: seek test did not exercise seeking (${r.restarts} restarts)`);
    }

    const bound = await page.evaluate(() => window.T.phase2.cacheBound('clip_60'));
    check(bound.max <= bound.limit && bound.limit === 4, `frame cache held ${bound.max} frames, limit ${bound.limit}`);

    // Budgets: 2-hour open and seeks; 1080p scrub.
    const long = await page.evaluate(() => window.T.phase2.seekTimes('long_2h', [0, 100_000, 172_799, 86_400, 12]));
    check(JSON.stringify(long.counters) === JSON.stringify([0, 100_000, 172_799, 86_400, 12]), `long_2h counters ${JSON.stringify(long.counters)}`);
    check(long.openMs < 3000, `long_2h open took ${long.openMs.toFixed(0)} ms`);
    const hd = await page.evaluate(() => window.T.phase2.seekTimes('hd_1080', [45, 3, 59, 17, 31, 8, 52, 29, 14, 38]));
    const worst = Math.max(...hd.seekMs.slice(1));
    console.log(`[budget] 2h open in browser: ${long.openMs.toFixed(0)} ms; seeks ${long.seekMs.map((m) => m.toFixed(0)).join('/')} ms`);
    console.log(`[budget] 1080p scrub: worst ${worst.toFixed(0)} ms, mean ${(hd.seekMs.slice(1).reduce((a, b) => a + b, 0) / (hd.seekMs.length - 1)).toFixed(0)} ms (limit 150)`);
    check(worst <= 150, `1080p scrub worst case ${worst.toFixed(0)} ms exceeds 150 ms`);
    check(JSON.stringify(hd.counters) === JSON.stringify([45, 3, 59, 17, 31, 8, 52, 29, 14, 38]), `hd_1080 counters ${JSON.stringify(hd.counters)}`);

    // Audio: chunked PCM reads are sample-exact, including past both ends and deep into the long file.
    const a1 = await page.evaluate(() => window.T.phase2.audioExact('clip_24', 48000, 2, [[0, 4800], [47990, 30], [95000, 2000], [-100, 300], [20000, 50000]]));
    const a2 = await page.evaluate(() => window.T.phase2.audioExact('long_2h', 16000, 1, [[16000 * 3600 - 10, 40], [16000 * 7200 - 50, 100]]));
    check(a1.length === 0, `clip_24 audio: ${a1.join('; ')}`);
    check(a2.length === 0, `long_2h audio: ${a2.join('; ')}`);
    const aac = await page.evaluate(() => window.T.phase2.aacRoundTrip());
    if (!aac.supported) console.log('[note] AAC encode not available in this browser; compressed-audio decode check skipped');
    else {
      check(Math.abs((aac.clickAt ?? 0) - 48000) <= 64, `AAC round trip: click found at ${aac.clickAt}, expected 48000`);
      check(Math.abs((aac.toneRms ?? 0) - 8000 / 32768 / Math.SQRT2) < 0.02, `AAC round trip: tone RMS ${aac.toneRms}`);
    }

    // Worker: peaks and thumbnails, cached.
    const j = await page.evaluate(() => window.T.phase2.jobs('clip_24'));
    check(j.buckets === 200 && j.rate === 100, `peaks: ${j.buckets} buckets at ${j.rate}/s`);
    check(j.clickPeak === Math.round((30000 / 32768) * 127) / 127, `peaks: click bucket ${j.clickPeak}`);
    check(j.tonePeak === 31 / 127 && j.toneMin === -31 / 127, `peaks: tone bucket ${j.toneMin}..${j.tonePeak}`);
    check(j.cachedEqual === true && j.cacheBytes === 412, `peaks cache: equal=${j.cachedEqual} bytes=${j.cacheBytes}`);
    check(j.thumbW === 85 && j.thumbH === 48 && j.thumbCached === true, `thumbnail ${j.thumbW}x${j.thumbH} cached=${j.thumbCached}`);
    check(/MediaError: .*(damaged|not a video)/.test(String(j.missing)), `worker error message: ${j.missing}`);
    const jr = await page.evaluate(() => window.T.phase2.jobs('rotated'));
    check(jr.thumbW === 27 && jr.thumbH === 48, `rotated thumbnail ${jr.thumbW}x${jr.thumbH}`);

    // Errors are plain messages.
    const e = await page.evaluate(() => window.T.phase2.errors());
    for (const k of ['corruptProbe', 'corruptVideo', 'corruptAudio'] as const) check(/^MediaError: This file is damaged or incomplete/.test(e[k] ?? ''), `${k}: ${e[k]}`);
    check(/^MediaError: This file uses a video format \(zzzz\) that Cutline cannot decode/.test(e.unknownCodec ?? ''), `unknownCodec: ${e.unknownCodec}`);
    check(/^MediaError: This computer cannot decode this video format/.test(e.undecodable ?? ''), `undecodable: ${e.undecodable}`);
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
