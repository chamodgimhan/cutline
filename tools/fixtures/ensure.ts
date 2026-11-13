// Vitest global setup: make sure generated fixtures exist before any test runs.
import { ensureFixtures } from './generate.ts';

export default function setup(): void {
  ensureFixtures();
}
