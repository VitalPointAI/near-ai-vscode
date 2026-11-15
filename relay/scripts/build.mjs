#!/usr/bin/env node
// Builds the relay with esbuild: the guard (dist/bin.mjs), the app (dist/app.mjs) and, unless --app-only, the tests (dist/test).
//
// The guard and the app are separate files on purpose: the guard checks the Node version and only then imports the app, so an older Node
// prints one plain sentence instead of failing on a module (node:sqlite) it does not have. The entries table below is the one place that
// names what gets built; Phase 71 appends the runner entry (format cjs, dist/runner.cjs) here.
import { build } from 'esbuild';
import { globSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const relayRoot = fileURLToPath(new URL('..', import.meta.url));
const appOnly = process.argv.slice(2).includes('--app-only');
const version = JSON.parse(readFileSync(path.join(relayRoot, 'package.json'), 'utf8')).version;

const common = {
  absWorkingDir: relayRoot,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  bundle: true,
  logLevel: 'warning',
  sourcemap: !appOnly,
  define: { __RELAY_VERSION__: JSON.stringify(version) },
};

const entries = [
  { entryPoints: ['src/bin.ts'], outfile: 'dist/bin.mjs' },
  { entryPoints: ['src/main.ts'], outfile: 'dist/app.mjs' },
];
if (!appOnly) {
  const testFiles = [...globSync('test/**/*.test.ts', { cwd: relayRoot }), ...globSync('test/fixtures/*.ts', { cwd: relayRoot })];
  if (testFiles.length > 0) entries.push({ entryPoints: testFiles, outdir: 'dist/test', outbase: 'test', packages: 'external' });
}

rmSync(path.join(relayRoot, 'dist'), { recursive: true, force: true });
let warnings = 0;
for (const entry of entries) {
  const result = await build({ ...common, ...entry });
  warnings += result.warnings.length;
}
if (warnings > 0) {
  console.error(`relay build: esbuild reported ${warnings} warning(s)`);
  process.exit(1);
}
