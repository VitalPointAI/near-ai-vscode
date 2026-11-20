#!/usr/bin/env node
// Copied from relay/scripts/build.mjs and adapted for the hub (D-26, D-28).
// Builds the hub with esbuild: the guard (dist/bin.mjs), the app (dist/app.mjs) and, unless --app-only, the tests (dist/test).
//
// The guard and the app are separate files on purpose: the guard checks the Node version and only then imports the app, so an older Node
// prints one plain sentence instead of failing on a module it does not have. The entries table below is the one place that names what gets
// built. The app entry also writes its esbuild metafile to dist/meta.json, so test/workspace.test.ts can check every input and every external
// import of the bundle the hub really runs (D-27).
import { build } from 'esbuild';
import { globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = fileURLToPath(new URL('..', import.meta.url));
const appOnly = process.argv.slice(2).includes('--app-only');
const version = JSON.parse(readFileSync(path.join(hubRoot, 'package.json'), 'utf8')).version;

const common = {
  absWorkingDir: hubRoot,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  bundle: true,
  logLevel: 'warning',
  sourcemap: !appOnly,
  define: { __HUB_VERSION__: JSON.stringify(version) },
};

const entries = [
  { entryPoints: ['src/bin.ts'], outfile: 'dist/bin.mjs' },
  { entryPoints: ['src/main.ts'], outfile: 'dist/app.mjs', metafile: true, metaOut: 'dist/meta.json' },
];
if (!appOnly) {
  const testFiles = [...globSync('test/**/*.test.ts', { cwd: hubRoot }), ...globSync('test/fixtures/*.ts', { cwd: hubRoot })];
  if (testFiles.length > 0) entries.push({ entryPoints: testFiles, outdir: 'dist/test', outbase: 'test', packages: 'external' });
}

rmSync(path.join(hubRoot, 'dist'), { recursive: true, force: true });
let warnings = 0;
for (const { metaOut, ...entry } of entries) {
  const result = await build({ ...common, ...entry });
  warnings += result.warnings.length;
  if (metaOut !== undefined) writeFileSync(path.join(hubRoot, metaOut), `${JSON.stringify(result.metafile, null, 2)}\n`);
}
if (warnings > 0) {
  console.error(`hub build: esbuild reported ${warnings} warning(s)`);
  process.exit(1);
}
