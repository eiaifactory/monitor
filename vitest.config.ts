import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'browser', include: ['test/browser/**/*.test.ts'], environment: 'happy-dom' } },
      { test: { name: 'node', include: ['test/core/**/*.test.ts', 'test/deno/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
