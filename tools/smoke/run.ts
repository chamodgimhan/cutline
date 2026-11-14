// CLI: node tools/smoke/run.ts [suite ...]   Runs browser smoke suites, prints failures only.
const SUITES: Record<string, () => Promise<{ run: () => Promise<string[]> }>> = {
  phase0: () => import('./phase0.ts'),
  phase2: () => import('./phase2.ts'),
  phase3: () => import('./phase3.ts'),
  phase4: () => import('./phase4.ts'),
  drift: () => import('./drift.ts'),
};

export {};

const wanted = process.argv.slice(2);
// Long-running suites run only when named.
const LONG = new Set(['drift']);
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
  try {
    failures = await (await load()).run();
  } catch (e) {
    failures = [`crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`];
  }
  for (const f of failures) console.error(`FAIL ${name}: ${f}`);
  failed += failures.length;
  console.log(`${name}: ${failures.length ? 'FAILED' : 'ok'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
process.exit(failed ? 1 : 0);
