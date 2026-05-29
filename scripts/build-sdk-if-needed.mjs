#!/usr/bin/env node
// The TS SDK is installed from a git URL (`git+https://.../v0.1.0`). git
// installs don't run npm's `prepack` lifecycle, so the SDK's `dist/` isn't
// built. We detect that case post-install and build it once.
//
// No-op when:
//   - the SDK isn't installed (won't happen in normal flow)
//   - the SDK already has dist/index.js (npm publish, or a previous run)
//   - we're inside a publish flow where source files were filtered out

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sdkDir = join(root, 'node_modules', '@launchapp-dev', 'animus-plugin-sdk');

if (!existsSync(sdkDir)) {
  process.exit(0);
}
if (existsSync(join(sdkDir, 'dist', 'index.js'))) {
  process.exit(0);
}
const ourDist = join(root, 'dist', 'index.js');
const tscBinCheck = join(root, 'node_modules', '.bin', 'tsc');
if (!existsSync(tscBinCheck)) {
  // Production install without devDeps. A published plugin tarball should
  // already include its own dist/ bundle, so only warn when neither build
  // path exists.
  if (existsSync(ourDist)) {
    process.exit(0);
  }
  console.warn(
    '[animus-trigger-discord] SDK lacks dist/ and tsc is unavailable; ' +
      'skipping SDK build (the plugin bundle in dist/ should still work).',
  );
  process.exit(0);
}
const srcIndex = join(sdkDir, 'src', 'index.ts');
if (!existsSync(srcIndex)) {
  console.warn('[animus-trigger-discord] SDK src missing, cannot build');
  process.exit(0);
}

console.log('[animus-trigger-discord] building @launchapp-dev/animus-plugin-sdk from source...');

// Synthesize a tsconfig.build.json (the published SDK omits it via package
// `files`, but we just need a minimal one for tsc to emit dist/).
const tsconfigBuildPath = join(sdkDir, 'tsconfig.build.json');
if (!existsSync(tsconfigBuildPath)) {
  writeFileSync(
    tsconfigBuildPath,
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          outDir: 'dist',
          rootDir: 'src',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          declaration: true,
          declarationMap: false,
          sourceMap: false,
          isolatedModules: true,
        },
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
      },
      null,
      2,
    ),
  );
}

mkdirSync(join(sdkDir, 'dist'), { recursive: true });

const tscBin = join(root, 'node_modules', '.bin', 'tsc');
const res = spawnSync(tscBin, ['-p', 'tsconfig.build.json'], {
  cwd: sdkDir,
  stdio: 'inherit',
});
if (res.status !== 0) {
  console.error('[animus-trigger-discord] SDK build failed (exit ' + res.status + ')');
  process.exit(res.status ?? 1);
}
console.log('[animus-trigger-discord] SDK built.');
