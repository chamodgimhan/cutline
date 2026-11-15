// Results of test runs, kept as JSON so TEST_REPORT.md is generated from what actually ran.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPORT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/out/reports');

export function writeReport(name: string, data: unknown): void {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `${name}.json`), JSON.stringify({ name, at: new Date().toISOString(), ...(data as object) }, null, 2));
}

export function readReport<T>(name: string): (T & { at: string }) | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, `${name}.json`), 'utf8')) as T & { at: string };
  } catch {
    return null;
  }
}
