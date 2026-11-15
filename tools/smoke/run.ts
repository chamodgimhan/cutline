// CLI: node tools/smoke/run.ts [suite ...]   Runs browser smoke suites, prints failures only.
import { writeReport } from '../report.ts';

const SUITES: Record<string, () => Promise<{ run: () => Promise<string[]> }>> = {
  phase0: () => import('./phase0.ts'),
  phase2: () => import('./phase2.ts'),
  phase3: () => import('./phase3.ts'),
  phase4: () => import('./phase4.ts'),
  phase5: () => import('./phase5.ts'),
  phase6: () => import('./phase6.ts'),
  phase7: () => import('./phase7.ts'),
  phase8: () => import('./phase8.ts'),
  phase9: () => import('./phase9.ts'),
  phase10: () => import('./phase10.ts'),
  phase11: () => import('./phase11.ts'),
  desktop: () => import('./desktop.ts'),
  drift: () => import('./drift.ts'),
  soak: () => import('./soak.ts'),
};


const wanted = process.argv.slice(2);
// Long-running suites run only when named.
const LONG = new Set(['drift', 'soak']);
const names = wanted.length ? wanted : Object.keys(SUITES).filter((n) => !LONG.has(n));
let failed = 0;
for (const name of names) {
  const load = SUITES[name];
  if (!load) {
    console.error(`unknown suite: ${name}`);
    process.exit(2);
  }
  const t0 = Date.now();
  let failures: string[];
  // Lines a suite prints in [brackets] are its measurements; they go into the report with the result.
  const notes: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => {
    const line = a.map(String).join(' ');
    if (line.startsWith('[')) notes.push(line);
    log(...a);
  };
  try {
    failures = await (await load()).run();
  } catch (e) {
    failures = [`crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`];
  }
  console.log = log;
  writeReport(`smoke-${name}`, { ok: failures.length === 0, seconds: (Date.now() - t0) / 1000, failures, notes });
  for (const f of failures) console.error(`FAIL ${name}: ${f}`);
  failed += failures.length;
  console.log(`${name}: ${failures.length ? 'FAILED' : 'ok'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
process.exit(failed ? 1 : 0);
