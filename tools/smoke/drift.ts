// Long run: 10 minutes of real-time playback; audio, timeline and picture must stay within one frame.
// Not part of the default suite list (it takes 10 minutes): npm run smoke drift
import { launch } from './browser.ts';
import { checkSync } from './phase3.ts';
import { openHarness, serve } from './server.ts';

export async function run(): Promise<string[]> {
  const failures: string[] = [];
  const served = await serve();
  const browser = await launch();
  try {
    const page = await openHarness(browser, served, failures);
    const r = await page.evaluate(() => window.T.playback.sync(600));
    checkSync(r, '10 min', 24, (ok, message) => {
      if (!ok) failures.push(message);
    });
  } finally {
    await browser.close();
    await served.close();
  }
  return failures;
}
