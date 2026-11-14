// Phase 5 smoke: audio mixdown, sync after edits, click-free cuts, meters, loudness.
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);

    const m = await page.evaluate(() => window.T.phase5.mixdown());
    console.log(`[audio] mixdown vs independent calculation: worst ${m.worstLsb.toFixed(3)} LSB over ${m.samples} samples; at the cut ${m.cutLsb.toFixed(3)} LSB`);
    check(m.samples === 96000 && m.worstLsb <= 1, `mixdown is off by ${m.worstLsb.toFixed(3)} LSB`);
    check(m.panRight < 1e-6 && m.panLeft > 0.2, `pan hard left: left ${m.panLeft}, right ${m.panRight}`);

    const c = await page.evaluate(() => window.T.phase5.cuts());
    console.log(`[audio] largest step at cuts ${c.maxStep.toFixed(4)} (tone slope ${c.toneSlope.toFixed(4)}, an unfaded cut would be ${c.rawStep.toFixed(4)})`);
    check(c.maxStep < c.toneSlope * 1.5, `sample jump of ${c.maxStep.toFixed(4)} at a cut`);

    for (const seed of [11, 12]) {
      const e = await page.evaluate((s) => window.T.phase5.editsKeepSync(s), seed);
      console.log(`[audio] seed ${seed}: ${e.edits} edits, ${e.clips} clips, ${e.clicks} clicks of ${e.expected} expected, worst offset ${e.worstMs.toFixed(3)} ms`);
      check(e.edits === 50 && e.invalid.length === 0, `seed ${seed}: ${e.edits} edits, invariants ${e.invalid.join('; ')}`);
      check(e.clicks >= 10 && e.clicks >= e.expected * 0.9 && e.clicks <= e.expected + 2, `seed ${seed}: heard ${e.clicks} clicks, picture implies ${e.expected}`);
      check(e.worstMs < 1, `seed ${seed}: a click is ${e.worstMs.toFixed(3)} ms from its frame after 50 edits`);
    }

    const mt = await page.evaluate(() => window.T.phase5.meters());
    check(mt.meter[0] === mt.computed[0] && mt.meter[1] === mt.computed[1] && mt.meter[0] > 0.1, `meter peaks ${mt.meter} differ from computed ${mt.computed}`);
    check(mt.scrubs >= 1 && mt.scrubsOff === 0, `audio scrub bursts: ${mt.scrubs} on, ${mt.scrubsOff} off`);

    const l = await page.evaluate(() => window.T.phase5.loudness());
    // Reference: 1 kHz at amplitude 8000/32768 left and half that right is 10*log10((L^2 + R^2) / 2) = -14.29 LUFS.
    console.log(`[audio] fixture loudness ${l.fixture.toFixed(2)} LUFS (reference -14.29); normalise -9 dB clip: ${l.before.toFixed(2)} -> ${l.after.toFixed(2)} LUFS`);
    check(Math.abs(l.fixture + 14.29) <= 0.2, `fixture loudness ${l.fixture.toFixed(2)} LUFS, reference -14.29`);
    check(Math.abs(l.before - (l.fixture - 9)) < 0.2 && Math.abs(l.after + 16) <= 0.2, `normalise: before ${l.before.toFixed(2)}, after ${l.after.toFixed(2)}, target -16`);
    check(l.undo === 'Normalise to -16 LUFS' && Math.abs(l.gain - (-16 - l.fixture)) < 0.2, `normalise gain ${l.gain}, undo label ${l.undo}`);
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
