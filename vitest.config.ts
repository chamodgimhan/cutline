import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tools/fixtures/ensure.ts'],
    testTimeout: 120_000,
  },
});
