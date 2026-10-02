import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  bundle: true,
  splitting: false,
  clean: true,
  noExternal: [/^@agentdeck\//, 'zod'],
});
