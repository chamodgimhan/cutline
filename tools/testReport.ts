// Writes TEST_REPORT.md and SHORTCUTS.md from the results in fixtures/out/reports (npm run report).
// Nothing here is typed in by hand: counts, timings and failures come from the last real runs, and a run
// that has no result file is reported as not run.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReport, REPORT_DIR } from './report.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
type Smoke = { ok: boolean; seconds: number; failures: string[]; notes: string[] };
type Unit = { numTotalTests: number; numPassedTests: number; numFailedTests: number; startTime: number; testResults: { name: string; endTime: number; assertionResults: { status: string; fullName: string; failureMessages: string[] }[] }[] };
type Fuzz = { applied: number; rejected: number; chains: number; chainLength: number; maxClips: number; commandKinds: number; seconds: number; failures: string[] };
type Actions = { actions: { id: string; label: string; menu: string; keys: string[] }[] };

const SUITES = ['phase0', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'phase9', 'phase10', 'phase11', 'desktop', 'drift', 'soak'];
const PURPOSE: Record<string, string> = {
  phase0: 'Fixtures decode in Chrome; frame counters and clicks', phase2: 'Import, probe, decode, VFR, thumbnails, waveforms', phase3: 'Render check (stored frame hashes), playback sync, transport',
  phase4: 'Editing UI, tools, shortcuts, 2,000-clip timeline budget', phase5: 'Audio mix, meters, loudness', phase6: 'Effects, transitions, speed, keyframes (frame hashes)', phase7: 'Titles and captions',
  phase8: 'Export: MP4, WebM, PNG, WAV vs preview', phase9: 'Save/open, recovery, relink, cache limits', phase10: 'Licensing, watermark, no network (production build)', phase11: 'End-to-end workflow, 50 cycles, keyboard-only (production build)',
  desktop: 'Electron shell (packaged app when CUTLINE_PACKAGED=1)', drift: '10-minute playback sync', soak: '30-minute playback soak: sync and memory',
};

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
};
const section = (file: string, heading: string): string[] => {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.replace(/^#+\s*/, '') === heading);
  if (at < 0) return [];
  const end = lines.findIndex((l, i) => i > at && /^#{1,2} /.test(l));
  return lines.slice(at + 1, end < 0 ? undefined : end).filter((l) => l.trim());
};
const day = (iso: string | undefined): string => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '');

// The unit tests are quick, so they run now; failures are recorded, not fatal.
fs.mkdirSync(REPORT_DIR, { recursive: true });
try {
  execSync(`npx vitest run --silent --reporter=json --outputFile=${JSON.stringify(path.join(REPORT_DIR, 'unit.json'))}`, { cwd: ROOT, stdio: 'ignore' });
} catch {
  // a failing test still writes the result file
}

const out: string[] = [];
const allFailures: string[] = [];
out.push('# Cutline test report', '', `Generated ${day(new Date().toISOString())} from commit ${sh('git rev-parse --short HEAD')} by \`npm run report\`. Machine: ${os.type()} ${os.release()}, ${os.cpus()[0]?.model.trim() ?? 'unknown CPU'}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, node ${process.version}.`, '');

out.push('## Summary', '', '| Check | Result | Time | Run at |', '|---|---|---|---|');
const unit = readReport<Unit>('unit');
if (unit) {
  const ms = Math.max(...unit.testResults.map((r) => r.endTime)) - unit.startTime;
  out.push(`| Unit tests (${unit.testResults.length} files) | ${unit.numPassedTests} of ${unit.numTotalTests} passed${unit.numFailedTests ? `, **${unit.numFailedTests} failed**` : ''} | ${(ms / 1000).toFixed(1)} s | ${day(new Date(unit.startTime).toISOString())} |`);
  for (const f of unit.testResults) for (const a of f.assertionResults) if (a.status === 'failed') allFailures.push(`unit: ${a.fullName}: ${a.failureMessages[0]?.split('\n')[0] ?? ''}`);
} else out.push('| Unit tests | **not run** | | |');
const fuzz = readReport<Fuzz>('fuzz');
if (fuzz) {
  out.push(`| Fuzz: random commands | ${fuzz.failures.length ? '**failed**' : 'passed'}: ${fuzz.applied.toLocaleString('en')} applied | ${fuzz.seconds.toFixed(1)} s | ${day(fuzz.at)} |`);
  allFailures.push(...fuzz.failures.map((f) => `fuzz: ${f}`));
} else out.push('| Fuzz: random commands | **not run** | | |');
for (const name of SUITES) {
  const r = readReport<Smoke>(`smoke-${name}`);
  if (!r) {
    out.push(`| Smoke ${name}: ${PURPOSE[name]} | **not run** | | |`);
    continue;
  }
  out.push(`| Smoke ${name}: ${PURPOSE[name]} | ${r.ok ? 'passed' : `**failed (${r.failures.length})**`} | ${r.seconds.toFixed(1)} s | ${day(r.at)} |`);
  allFailures.push(...r.failures.map((f) => `${name}: ${f}`));
}
out.push('');

if (fuzz) {
  out.push('## Fuzz', '', `${fuzz.applied.toLocaleString('en')} random commands applied (${fuzz.rejected.toLocaleString('en')} more were refused as invalid, which is also checked) across ${fuzz.commandKinds} command kinds, in ${fuzz.chains} chains of up to ${fuzz.chainLength} steps; largest project ${fuzz.maxClips} clips. After every command all invariants were checked (no overlaps, no negative times, source ranges inside media, unique ids, locked tracks unchanged). Each chain was then saved and reloaded, undone back to its exact start and redone to its exact end.`, '');
}

out.push('## Measurements', '', 'Lines printed by each smoke suite while it ran.', '');
for (const name of SUITES) {
  const r = readReport<Smoke>(`smoke-${name}`);
  if (r?.notes.length) out.push(`**${name}**`, '', ...r.notes.map((n) => `- ${n.replace(/^\[[^\]]*\]\s*/, (m) => `${m.trim()} `)}`), '');
}

out.push('## Failures', '');
out.push(...(allFailures.length ? allFailures.map((f) => `- ${f}`) : ['None in the runs above.']), '');
out.push('## Known bugs', '', 'Copied from PROGRESS.md, each with how to reproduce it.', '');
const bugs = section('PROGRESS.md', 'Known bugs');
out.push(...(bugs.length ? bugs : ['None.']), '');
out.push('## Known limits', '', 'Copied from the README.', '');
out.push(...section('README.md', 'Known limits'), '');
fs.writeFileSync(path.join(ROOT, 'TEST_REPORT.md'), out.join('\n'));

const actions = readReport<Actions>('actions');
if (actions) {
  const doc = ['# Cutline keyboard shortcuts', '', 'Generated from the actions in the running app (`npm run report`). Help → Keyboard Shortcuts in the app lists every action and lets you change any shortcut.', ''];
  const menus = [...new Set(actions.actions.map((a) => a.menu))];
  for (const m of menus) {
    doc.push(`## ${m}`, '', '| Action | Shortcut |', '|---|---|');
    for (const a of actions.actions.filter((x) => x.menu === m)) doc.push(`| ${a.label.replace(/\|/g, '\\|')} | ${a.keys.map((k) => `\`${k}\``).join(', ') || '—'} |`);
    doc.push('');
  }
  fs.writeFileSync(path.join(ROOT, 'SHORTCUTS.md'), doc.join('\n'));
}
console.log(`report: TEST_REPORT.md (${allFailures.length} failures listed)${actions ? ', SHORTCUTS.md' : ''}`);
