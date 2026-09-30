import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.pg.test.ts'],
    globalSetup: ['src/__tests__/support/pg-global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // One database, shared: files run one after another and clean up after themselves.
    fileParallelism: false,
  },
});
