// Serves the project through Vite for smoke suites and opens the harness page with fixtures loaded.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import { build, createServer, preview, type ViteDevServer } from 'vite';
import { ensureFixtures, OUT_DIR, readManifest } from '../fixtures/generate.ts';
import type { Harness } from './page/harness.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let built = false;

export interface Served {
  /** Dev server: the test harness page and fixtures. */
  url: string;
  /** Address of the app itself. With CUTLINE_BUILD=1 this is the production build, otherwise the dev server. */
  app: string;
  close(): Promise<void>;
}

export async function serve(): Promise<Served> {
  ensureFixtures();
  const server: ViteDevServer = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 5317, strictPort: false, hmr: false }, appType: 'mpa' });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5317;
  const url = `http://127.0.0.1:${port}`;
  if (process.env.CUTLINE_BUILD !== '1') return { url, app: `${url}/index.html`, close: () => server.close() };
  // Production build, built once per run and served as plain static files.
  if (!built) {
    await build({ root: ROOT, logLevel: 'error' });
    built = true;
  }
  const dist = await preview({ root: ROOT, logLevel: 'error', preview: { host: '127.0.0.1', port: 5327, strictPort: false } });
  const a = dist.httpServer.address();
  return { url, app: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 5327}/index.html`, close: async () => {
    await server.close();
    await new Promise<void>((r) => dist.httpServer.close(() => r()));
  } };
}

declare global {
  interface Window {
    T: Harness;
  }
}

/** Open the harness page with every fixture selected into its file input. Page errors are collected. */
export async function openHarness(browser: Browser, served: Served, errors: string[]): Promise<Page> {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console error: ${m.text()}`);
  });
  await page.goto(`${served.url}/tools/smoke/page/index.html`);
  await page.waitForFunction(() => window.T?.ready === true, undefined, { timeout: 30_000 });
  const files = Object.values(readManifest()).map((e) => path.join(OUT_DIR, e.file));
  await page.setInputFiles('#files', files);
  return page;
}
