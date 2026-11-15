// Long fuzz run: node tools/fuzz.ts [commands=100000]
// Applies random commands in long chains (1,000 per chain, so projects grow large), checks every invariant
// after each one, then undoes the whole chain back to the exact start and redoes it to the exact end.
// Writes fixtures/out/reports/fuzz.json for TEST_REPORT.md.
import type { Command } from '../src/core/command.ts';
import { randomCommand, randomProject } from '../src/core/fuzz.ts';
import { checkInvariants, lockedTracksUnchanged } from '../src/core/invariants.ts';
import type { Project } from '../src/core/model.ts';
import { parseProject, serializeProject } from '../src/core/projectFile.ts';
import { idSource, rng } from '../src/core/testkit.ts';
import { writeReport } from './report.ts';

const TARGET = Number(process.argv[2] ?? 100_000);
const CHAIN = 1_000;
const t0 = Date.now();
let applied = 0;
let rejected = 0;
let chains = 0;
let maxClips = 0;
const failures: string[] = [];
const labels = new Map<string, number>();

while (applied < TARGET && failures.length === 0) {
  const seed = 9_000 + chains++;
  const r = rng(seed);
  const newId = idSource('f');
  const start = randomProject(r, newId);
  const startJson = JSON.stringify(start);
  const done: Command[] = [];
  let p: Project = start;
  for (let i = 0; i < CHAIN && applied < TARGET; i++) {
    const cmd = randomCommand(p, { newId }, r);
    if (!cmd) {
      rejected++;
      continue;
    }
    const next = cmd.apply(p);
    const errors = [...checkInvariants(next), ...lockedTracksUnchanged(p, next)];
    if (errors.length) {
      failures.push(`chain seed ${seed}, step ${i} (${cmd.label}): ${errors.join('; ')}`);
      break;
    }
    if (!cmd.isEmpty) done.push(cmd);
    labels.set(cmd.label, (labels.get(cmd.label) ?? 0) + 1);
    p = next;
    applied++;
  }
  maxClips = Math.max(maxClips, p.sequences[0]?.tracks.reduce((n, t) => n + t.clips.length, 0) ?? 0);
  const endJson = JSON.stringify(p);
  if (JSON.stringify(parseProject(serializeProject(p))) !== endJson) failures.push(`chain seed ${seed}: save/load did not round-trip`);
  let back = p;
  for (let i = done.length - 1; i >= 0; i--) back = (done[i] as Command).invert().apply(back);
  if (JSON.stringify(back) !== startJson) failures.push(`chain seed ${seed}: undoing ${done.length} commands did not restore the start`);
  let again = back;
  for (const cmd of done) again = cmd.apply(again);
  if (JSON.stringify(again) !== endJson) failures.push(`chain seed ${seed}: redo did not reach the same end`);
}

const seconds = (Date.now() - t0) / 1000;
const result = { applied, rejected, chains, chainLength: CHAIN, maxClips, commandKinds: labels.size, seconds, failures };
writeReport('fuzz', result);
console.log(`fuzz: ${applied} commands applied (${rejected} refused as invalid) in ${chains} chains, ${labels.size} command kinds, largest project ${maxClips} clips, ${seconds.toFixed(1)} s`);
for (const f of failures) console.error(`FAIL fuzz: ${f}`);
process.exit(failures.length ? 1 : 0);
