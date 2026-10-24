import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Web composables are unit-tested from the root tests directory; resolve their
// runtime dependencies (pinia/vue) through the web workspace package.
const webModules = (...parts: string[]) => path.resolve(__dirname, 'apps/web/node_modules', ...parts);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^pinia$/, replacement: webModules('pinia', 'dist', 'pinia.mjs') },
      { find: /^vue$/, replacement: webModules('vue', 'dist', 'vue.runtime.esm-bundler.js') },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
