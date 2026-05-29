#!/usr/bin/env node
// `prepare` runs:
//   - after `npm install` in this repo (no-op if dist exists)
//   - after `npm install <git-url>` in a consumer (this is the path Animus
//     uses when installing the plugin from a tag tarball — `dist/` is shipped
//     in published npm builds, but for git installs the consumer needs to
//     build the binary themselves before the manifest probe works)
//   - before `npm publish` / `npm pack` (ensures dist/ is fresh in the
//     tarball)
//
// No-op when:
//   - dist/index.cjs already exists AND we're not in a publish flow
//   - tsup is not installed (e.g. minimal CI step that only consumes dist/)

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const distIndex = join(root, 'dist', 'index.cjs');
const tsupBin = join(root, 'node_modules', '.bin', 'tsup');

if (existsSync(distIndex)) {
  process.exit(0);
}
if (!existsSync(tsupBin)) {
  // Likely the publish flow's `npm pack` step on a clean tree; let the
  // explicit `npm run build` (which CI runs) handle it. Silently skip
  // instead of failing the lifecycle.
  process.exit(0);
}

console.log('[animus-trigger-discord] building dist/ via tsup...');
const res = spawnSync(tsupBin, [], { cwd: root, stdio: 'inherit' });
if (res.status !== 0) {
  console.error('[animus-trigger-discord] build failed (exit ' + res.status + ')');
  process.exit(res.status ?? 1);
}
