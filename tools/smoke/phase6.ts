// Phase 6 smoke: a frame hash per effect and transition, stack order, adjustment clips, speed sync.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.ts';
import { openHarness, serve } from './server.ts';

const HASHES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/effect-hashes.json');
interface Stats { mean: [number, number, number]; detail: number; grey: number; lumaSpread: number }
interface Fx { hash: string; stats: Stats; changed: boolean }

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message);
  };
  const update = process.env.CUTLINE_UPDATE === '1';
  const stored = fs.existsSync(HASHES) ? (JSON.parse(fs.readFileSync(HASHES, 'utf8')) as Record<string, string>) : {};
  const next: Record<string, string> = {};
  const hash = (name: string, value: string): void => {
    next[name] = value;
    if (!update) check(stored[name] === value, `${name}: frame hash ${value} differs from stored ${stored[name]}`);
  };
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);

    const e = await page.evaluate(() => window.T.phase6.effects());
    const base = e.baseStats as Stats;
    const types = e.types as string[];
    check(types.length === 11, `effects rendered: ${types.length}`);
    hash('base', e.base as string);
    for (const t of types) {
      const f = e[t] as Fx;
      hash(`effect.${t}`, f.hash);
      check(f.changed, `${t}: the effect did not change the frame`);
    }
    const s = (t: string): Stats => (e[t] as Fx).stats;
    const mean = (x: Stats): number => (x.mean[0] + x.mean[1] + x.mean[2]) / 3;
    check(mean(s('exposure')) > mean(base) * 1.5, `exposure +1 stop: mean ${mean(base).toFixed(1)} -> ${mean(s('exposure')).toFixed(1)}`);
    check(s('contrast').lumaSpread > base.lumaSpread * 1.2, 'contrast did not widen the tonal spread');
    check(s('saturation').grey < 1 && base.grey > 5, `saturation 0 should be grey (colour difference ${s('saturation').grey.toFixed(2)}, was ${base.grey.toFixed(2)})`);
    check(s('temperature').mean[0] > base.mean[0] && s('temperature').mean[2] < base.mean[2], 'temperature did not warm the picture');
    check(mean(s('curves')) > mean(base) + 10, 'curves midtone lift did not brighten');
    check((e.lutPsnr as number) > 35, `LUT (invert) differs from an inverted frame: ${(e.lutPsnr as number).toFixed(1)} dB`);
    check(s('blur').detail < base.detail * 0.6, `blur did not soften (detail ${base.detail.toFixed(2)} -> ${s('blur').detail.toFixed(2)})`);
    check(s('sharpen').detail > base.detail * 1.2, `sharpen did not add detail (${base.detail.toFixed(2)} -> ${s('sharpen').detail.toFixed(2)})`);
    const v = e.vignetteProbe as number[][];
    check(JSON.stringify(v[0]) === JSON.stringify(v[1]) && (v[2]?.[1] ?? 255) < (v[3]?.[1] ?? 0) * 0.5, `vignette: centre ${v[0]} vs ${v[1]}, corner ${v[2]} vs ${v[3]}`);
    check(JSON.stringify(e.keyedPixel) === '[0,0,0]', `chroma key left ${JSON.stringify(e.keyedPixel)} where the key colour was`);
    const kept = e.keptPixel as number[][];
    check(JSON.stringify(kept[0]) === JSON.stringify(kept[1]), `chroma key changed a pixel of another colour: ${JSON.stringify(kept)}`);
    check((e.flipPsnr as number) > 50, `flip is not a mirror image: ${e.flipPsnr} dB`);
    check(e.disabledSame === true, 'a disabled effect changed the frame');
    const order = e.order as { ab: string; ba: string; abGrey: number; baGrey: number };
    hash('order.saturation-then-temperature', order.ab);
    hash('order.temperature-then-saturation', order.ba);
    check(order.ab !== order.ba && order.baGrey < 1 && order.abGrey > 5, `stack order: grey measure ${order.abGrey.toFixed(2)} vs ${order.baGrey.toFixed(2)}`);
    hash('adjust.exposure', e.adjustHash as string);
    check((e.adjustPsnr as number) > 45 && e.emptyAdjustSame === true, `adjustment clip vs the same effect on the clip: ${e.adjustPsnr} dB; empty adjustment unchanged: ${e.emptyAdjustSame}`);
    check((e.fallbackFlipPsnr as number) > 40, `2D fallback flip: ${e.fallbackFlipPsnr} dB`);

    const t = await page.evaluate(() => window.T.phase6.transitions());
    for (const type of ['dissolve', 'dipBlack', 'dipWhite', 'wipe', 'slide']) {
      const r = t[type] as { hashes: [string, string]; mid: [number, number, number] };
      hash(`transition.${type}.25`, r.hashes[0]);
      hash(`transition.${type}.50`, r.hashes[1]);
      check(r.hashes[0] !== r.hashes[1], `${type}: the frame does not change as the transition runs`);
    }
    check((t.dissolvePsnr as number) > 40, `dissolve at 50% is not the average of both clips: ${t.dissolvePsnr} dB`);
    const dipB = (t.dipBlack as { mid: number[] }).mid;
    const dipW = (t.dipWhite as { mid: number[] }).mid;
    check(dipB.every((c) => c < 1) && dipW.every((c) => c > 254), `dips at 50%: black ${dipB}, white ${dipW}`);
    check(JSON.stringify(t.wipeCheck) === '[true,true,true]' && JSON.stringify(t.slideCheck) === '[true,true]', `wipe ${JSON.stringify(t.wipeCheck)}, slide ${JSON.stringify(t.slideCheck)}`);
    check(t.afterEqualsPlain === true, 'the frame after a transition differs from the plain cut');
    check((t.fadeOutPsnr as number) > 40, `fade out over a lower layer: ${t.fadeOutPsnr} dB`);

    // Speed: audio and picture stay together.
    const cases: [string, [number, number], boolean, boolean, number, number][] = [
      ['200%', [2, 1], false, false, 1, 6], ['50%', [1, 2], false, false, 1, 24], ['reverse', [1, 1], true, false, 1, 12],
      ['150% reverse', [3, 2], true, false, 1, 8], ['200% keep pitch', [2, 1], false, true, 42, 6],
    ];
    for (const [name, speed, reverse, keep, limitMs, seconds] of cases) {
      const r = await page.evaluate(([sp, rev, k]) => window.T.phase6.speedSync(sp, rev, k), [speed, reverse, keep] as const);
      console.log(`[speed] ${name}: ${r.clicks} clicks over ${r.seconds.toFixed(1)} s, worst offset from the picture ${r.worstMs.toFixed(2)} ms`);
      check(Math.abs(r.seconds - seconds) < 0.05, `${name}: clip is ${r.seconds} s long, expected ${seconds}`);
      // A time-stretcher smears single-sample clicks, so fewer survive the detector; their timing is what is checked.
      check(r.clicks >= (keep ? 5 : 9) && r.worstMs < limitMs, `${name}: ${r.clicks} clicks, worst ${r.worstMs.toFixed(2)} ms (limit ${limitMs})`);
    }
    if (update) {
      fs.writeFileSync(HASHES, JSON.stringify(next, null, 1) + '\n');
      console.log(`[update] wrote ${Object.keys(next).length} effect and transition hashes`);
    }
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
