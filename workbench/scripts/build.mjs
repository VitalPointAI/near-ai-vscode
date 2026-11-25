#!/usr/bin/env node
// Copied from hub/scripts/build.mjs and adapted for the workbench: builds only the tests, into dist/test/.
// The app itself is built by `theia build` (npm run build); the tests import the extension's Theia-free modules from source and leave
// every package external, so they load the workbench's own node_modules at run time. Output stays inside workbench/ (D-12).
import { build } from 'esbuild';
import { globSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));
const entryPoints = [
  ...globSync('test/**/*.test.ts', { cwd: workbenchRoot }),
  ...globSync('test/**/*.test.mjs', { cwd: workbenchRoot }),
  ...globSync('test/helpers/*.ts', { cwd: workbenchRoot }),
].sort();

// The tests call the engine bundle directly (the parser's own refusal is the expected text), so build it first, into engine/.
await import('../tools/build-engine.mjs');

// Tests that build shared projects with the repository's own code (src/test/helpers) bundle doc.ts and decodeHost.ts too. Both load a file by a
// path relative to their compiled place, which a test bundle does not keep, so the test build points them at the engine's own copies: the vendored
// Yjs and the decode worker that tools/build-engine.mjs wrote into engine/.
const ENGINE_PATHS = [
  { file: /[\\/]src[\\/]domain[\\/]replica[\\/]doc\.ts$/, from: "path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')", to: ['engine', 'vendor', 'yjs', 'yjs.cjs'] },
  { file: /[\\/]src[\\/]staff[\\/]replica[\\/]decodeHost\.ts$/, from: "path.join(__dirname, 'decodeWorker.js')", to: ['engine', 'decodeWorker.js'] },
];
const enginePaths = {
  name: 'engine-paths',
  setup(context) {
    for (const { file, from, to } of ENGINE_PATHS) {
      context.onLoad({ filter: file }, (args) => {
        const text = readFileSync(args.path, 'utf8');
        if (text.split(from).length !== 2) throw new Error(`workbench build: ${path.basename(args.path)} no longer loads its file through the path this build rewrites.`);
        return { contents: text.replace(from, JSON.stringify(path.join(workbenchRoot, ...to))), loader: 'ts' };
      });
    }
  },
};
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
  plugins: [enginePaths],
  // The repository's test helpers are CommonJS code that reads __dirname and require; the tests are ES modules, so both are defined for them.
  banner: {
    js: "import { createRequire as __sterlingRequire } from 'node:module'; import { fileURLToPath as __sterlingPath } from 'node:url'; import { dirname as __sterlingDir } from 'node:path'; const require = __sterlingRequire(import.meta.url); const __filename = __sterlingPath(import.meta.url); const __dirname = __sterlingDir(__filename);",
  },
});
// The app's package.json has no "type" (Theia's generated webpack configs are CommonJS), so mark the bundled tests as ES modules here.
writeFileSync(path.join(workbenchRoot, 'dist', 'package.json'), '{ "type": "module" }\n');
if (result.warnings.length > 0) {
  console.error(`workbench build: esbuild reported ${result.warnings.length} warning(s)`);
  process.exit(1);
}
