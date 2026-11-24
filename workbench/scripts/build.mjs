#!/usr/bin/env node
// Copied from hub/scripts/build.mjs and adapted for the workbench: builds only the tests, into dist/test/.
// The app itself is built by `theia build` (npm run build); the tests import the extension's Theia-free modules from source and leave
// every package external, so they load the workbench's own node_modules at run time. Output stays inside workbench/ (D-12).
import { build } from 'esbuild';
import { globSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPoints = [
  ...globSync('test/**/*.test.ts', { cwd: workbenchRoot }),
  ...globSync('test/**/*.test.mjs', { cwd: workbenchRoot }),
  ...globSync('test/helpers/*.ts', { cwd: workbenchRoot }),
].sort();

rmSync(path.join(workbenchRoot, 'dist'), { recursive: true, force: true });
if (entryPoints.length === 0) {
  console.error('workbench build: no test files found under test/');
  process.exit(1);
}
const result = await build({
  absWorkingDir: workbenchRoot,
  entryPoints,
  outdir: 'dist/test',
  outbase: 'test',
  platform: 'node',
  target: 'node26',
  format: 'esm',
  bundle: true,
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
});
// The app's package.json has no "type" (Theia's generated webpack configs are CommonJS), so mark the bundled tests as ES modules here.
writeFileSync(path.join(workbenchRoot, 'dist', 'package.json'), '{ "type": "module" }\n');
if (result.warnings.length > 0) {
  console.error(`workbench build: esbuild reported ${result.warnings.length} warning(s)`);
  process.exit(1);
}
