import { defineConfig } from 'vitest/config';

// Root Vitest config. Tests run in a Node environment; browser integration tests
// launch a real local Chromium via the browser package's remote-adapter.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/release/**'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
  },
});
