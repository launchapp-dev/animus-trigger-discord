import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  minify: true,
  noExternal: ['@launchapp-dev/animus-plugin-sdk', 'discord.js'],
  outExtension: () => ({ js: '.cjs' }),
  // tsup respects the banner via config; CLI `--banner.js` is rejected.
  banner: {
    js: '#!/usr/bin/env node',
  },
});
