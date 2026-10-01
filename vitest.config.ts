import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.claude/**', 'dist/**'],
    // Some suites build whole worlds; give them room on a busy machine.
    testTimeout: 30000,
  },
});
