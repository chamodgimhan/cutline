// Long run: 30 minutes of real-time playback (npm run smoke soak). Audio, timeline and picture must stay
// in sync the whole way, and the page must not keep memory once playback has stopped.
import { launch, pageCounts } from './browser.ts';
import { checkSync } from './phase3.ts';
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
    const before = await pageCounts(page);
    const r = await page.evaluate(() => window.T.playback.sync(1800, 'long_2h', 24, 320, 240));
    checkSync(r, '30 min', 24, check);
    const after = await pageCounts(page);
    console.log(`[soak 30 min] heap ${before.heapMiB.toFixed(1)} -> ${after.heapMiB.toFixed(1)} MiB, DOM nodes ${before.nodes} -> ${after.nodes}, listeners ${before.listeners} -> ${after.listeners}`);
    check(after.heapMiB - before.heapMiB < 16, `heap grew ${(after.heapMiB - before.heapMiB).toFixed(1)} MiB over the soak`);
    check(after.nodes - before.nodes < 50 && after.listeners - before.listeners < 20, `DOM nodes ${before.nodes} -> ${after.nodes}, listeners ${before.listeners} -> ${after.listeners}`);
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
