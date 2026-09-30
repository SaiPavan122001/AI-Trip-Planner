import { defineConfig } from 'vitest/config';

// The default run needs nothing installed or running. Tests that need a real
// PostgreSQL are named *.pg.test.ts and run with `npm run test:integration`.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.pg.test.ts'],
  },
});
