// Test-only helper: apply a command and assert invariants and exact undo.
import { expect } from 'vitest';
import type { Command } from './command.ts';
import { checkInvariants, lockedTracksUnchanged } from './invariants.ts';
import type { Project } from './model.ts';

export function run(p: Project, c: Command): Project {
  const next = c.apply(p);
  expect(checkInvariants(next)).toEqual([]);
  expect(lockedTracksUnchanged(p, next)).toEqual([]);
  expect(c.invert().apply(next)).toEqual(p);
  return next;
}
