import { describe, expect, it } from 'vitest';
import type { Command } from './command.ts';
import { randomCommand, randomProject } from './fuzz.ts';
import { checkInvariants, lockedTracksUnchanged } from './invariants.ts';
import type { Project } from './model.ts';
import { parseProject, serializeProject } from './projectFile.ts';
import { idSource, rng } from './testkit.ts';

const SEQUENCES = 10_000;
const STEPS = 12;

describe('property: random command sequences', () => {
  it(`keeps every invariant over ${SEQUENCES} sequences and undoes back to the exact start`, () => {
    let applied = 0;
    let rejected = 0;
    const labels = new Set<string>();
    for (let s = 0; s < SEQUENCES; s++) {
      const r = rng(s + 1);
      const newId = idSource('i');
      const start = randomProject(r, newId);
      if (s === 0) expect(checkInvariants(start)).toEqual([]);
      const startJson = JSON.stringify(start);
      const done: Command[] = [];
      let p: Project = start;
      for (let i = 0; i < STEPS; i++) {
        const cmd = randomCommand(p, { newId }, r);
        if (!cmd) {
          rejected++;
          continue;
        }
        const next = cmd.apply(p);
        const errors = [...checkInvariants(next), ...lockedTracksUnchanged(p, next)];
        if (errors.length) throw new Error(`sequence ${s} step ${i} (${cmd.label}): ${errors.join('; ')}`);
        if (!cmd.isEmpty) {
          done.push(cmd);
          labels.add(cmd.label);
        }
        p = next;
        applied++;
      }
      const endJson = JSON.stringify(p);
      // Save/load in the middle of the property run: every reachable state must round-trip.
      if (s % 50 === 0 && JSON.stringify(parseProject(serializeProject(p))) !== endJson) expect(parseProject(serializeProject(p))).toEqual(p);
      let back = p;
      for (let i = done.length - 1; i >= 0; i--) back = (done[i] as Command).invert().apply(back);
      if (JSON.stringify(back) !== startJson) expect(back, `sequence ${s}: undo`).toEqual(start);
      let again = back;
      for (const cmd of done) again = cmd.apply(again);
      if (JSON.stringify(again) !== endJson) expect(again, `sequence ${s}: redo`).toEqual(p);
    }
    // The generator must actually exercise the commands, not just bounce off errors.
    expect(applied).toBeGreaterThan(SEQUENCES * STEPS * 0.5);
    expect(rejected).toBeGreaterThan(0);
    for (const label of ['Add clip', 'Delete', 'Move', 'Split', 'Trim', 'Ripple trim', 'Roll', 'Slip', 'Slide', 'Insert', 'Overwrite', 'Lift', 'Extract',
      'Ripple delete', 'Link', 'Unlink', 'Change clip', 'Add track', 'Delete track', 'Reorder tracks', 'Change track', 'Add marker', 'Delete marker',
      'Change marker', 'Set range', 'Import media', 'Relink media']) {
      expect(labels, label).toContain(label);
    }
  });
});
