import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  minify: true,
  // tsup respects the banner via config; CLI `--banner.js` is rejected.
  banner: {
    js: '#!/usr/bin/env node',
  },
});
