// Headless Chrome launcher for smoke tests. Uses the system browser through
// playwright-core (no browser download). Software GL keeps render hashes stable.
import * as fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';

const CANDIDATES = [
  process.env.CUTLINE_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findBrowser(): string {
  for (const c of CANDIDATES) if (c && fs.existsSync(c)) return c;
  throw new Error('No Chrome or Edge found. Set CUTLINE_CHROME to a Chromium executable.');
}

export async function launch(): Promise<Browser> {
  return chromium.launch({
    executablePath: findBrowser(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  });
}

/** A blank page in a secure context (localhost) with no real network behind it. */
export async function blankPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ body: '<!doctype html><title>t</title>', contentType: 'text/html' }));
  await page.goto('http://localhost:9/');
  return page;
}

export type PageCounts = { heapMiB: number; nodes: number; listeners: number };

/** Live JS heap, DOM nodes and event listeners of a page, measured after a full garbage collection. */
export async function pageCounts(page: Page): Promise<PageCounts> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  const m = (name: string): number => metrics.find((x) => x.name === name)?.value ?? Number.NaN;
  return { heapMiB: m('JSHeapUsedSize') / 2 ** 20, nodes: m('Nodes'), listeners: m('JSEventListeners') };
}
