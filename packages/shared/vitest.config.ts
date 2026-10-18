import { defineConfig } from 'vitest/config';

// Only the sources' tests. Vitest 3 and later no longer skip `dist/` by default,
// and the compiled copies there cannot find their fixtures.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
