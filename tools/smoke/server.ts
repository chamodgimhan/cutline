// Serves the project through Vite for smoke suites and opens the harness page with fixtures loaded.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from 'playwright-core';
import { createServer, type ViteDevServer } from 'vite';
import { ensureFixtures, OUT_DIR, readManifest } from '../fixtures/generate.ts';
import type { Harness } from './page/harness.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Served {
  url: string;
  close(): Promise<void>;
}

export async function serve(): Promise<Served> {
  ensureFixtures();
  const server: ViteDevServer = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 5317, strictPort: false, hmr: false }, appType: 'mpa' });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === 'object' && address ? address.port : 5317;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
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
