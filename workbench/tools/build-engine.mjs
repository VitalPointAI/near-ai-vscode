#!/usr/bin/env node
// Bundles the host-neutral engine code the workbench backend calls (D-15) from the repository's src/ into workbench/engine/, one bundle per entry:
// - teams.cjs: tools/team-parser-entry.ts re-exports parseTeam from src/agent/teams, the same entry the extension calls, so the backend gives the
//   extension's own refusals (D-16). Loaded lazily by extension/src/node/team-preview-reader.ts.
// - identity.cjs (71-10): tools/identity-entry.ts, did:webvh, credentials and device words for the identity service.
// - staff.cjs: tools/staff-engine-entry.ts, the staff backend's engine (Phase 33 D-51): session keys, the keyring, the replica project and the live
//   replicator. Loaded lazily by extension/src/node/staff/staff-engine.ts.
// - decodeWorker.js: the replica's memory-capped decode worker, which decodeHost.ts starts from beside the bundle that holds it (staff.cjs).
// - vendor/yjs: the repository's vendored Yjs build (vendor/yjs/yjs.cjs, written by scripts/vendor-libs.mjs, `npm run compile`), copied only when
//   its SHA-256 is the one scripts/crdt-vendor.json pins, with its LICENSES.txt. doc.ts loads it from beside the bundle: the one path expression in
//   doc.ts is rewritten for the bundle, and the build stops if that expression is not found exactly once.
// Each bundle is loaded from the app root the backend computes from its own location, never from the working folder (D-12). Nothing is written
// outside workbench/.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.resolve(workbenchRoot, '..');

// doc.ts loads Yjs from <repo>/vendor/yjs relative to its compiled file; in the bundle that file is engine/staff.cjs (or engine/decodeWorker.js).
const YJS_FROM_SOURCE = "path.join(__dirname, '..', '..', '..', 'vendor', 'yjs', 'yjs.cjs')";
const YJS_FROM_BUNDLE = "path.join(__dirname, 'vendor', 'yjs', 'yjs.cjs')";
const yjsBesideBundle = {
  name: 'yjs-beside-bundle',
  setup(context) {
    context.onLoad({ filter: /[\\/]src[\\/]domain[\\/]replica[\\/]doc\.ts$/ }, (args) => {
      const text = readFileSync(args.path, 'utf8');
      if (text.split(YJS_FROM_SOURCE).length !== 2) throw new Error('build-engine: doc.ts no longer loads Yjs through the one path this build rewrites.');
      return { contents: text.replace(YJS_FROM_SOURCE, YJS_FROM_BUNDLE), loader: 'ts' };
    });
  },
};

const bundles = [
  { entry: 'tools/team-parser-entry.ts', outfile: 'engine/teams.cjs' },
  { entry: 'tools/identity-entry.ts', outfile: 'engine/identity.cjs' },
  { entry: 'tools/staff-engine-entry.ts', outfile: 'engine/staff.cjs' },
  { entry: '../src/staff/replica/decodeWorker.ts', outfile: 'engine/decodeWorker.js' },
];

for (const { entry, outfile } of bundles) {
  const result = await build({
    absWorkingDir: workbenchRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'cjs',
    logLevel: 'warning',
    plugins: [yjsBesideBundle],
  });
  if (result.warnings.length > 0) {
    console.error(`build-engine: esbuild reported ${result.warnings.length} warning(s) for ${entry}`);
    process.exit(1);
  }
}

// The vendored Yjs, hash-checked against its pin. Without it the live engine refuses to fold shared text, so the build stops with the fix.
const pin = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'crdt-vendor.json'), 'utf8')).output;
const vendored = path.join(repoRoot, pin.file);
if (!existsSync(vendored)) {
  console.error(`build-engine: ${pin.file} is missing. Run \`node scripts/vendor-libs.mjs\` (part of \`npm run compile\`) at the repository root first.`);
  process.exit(1);
}
const actual = createHash('sha256').update(readFileSync(vendored)).digest('hex');
if (actual !== pin.sha256) {
  console.error(`build-engine: ${pin.file} does not match scripts/crdt-vendor.json (sha256 ${actual}), so it was not copied.`);
  process.exit(1);
}
const target = path.join(workbenchRoot, 'engine', 'vendor', 'yjs');
mkdirSync(target, { recursive: true });
copyFileSync(vendored, path.join(target, 'yjs.cjs'));
copyFileSync(path.join(path.dirname(vendored), 'LICENSES.txt'), path.join(target, 'LICENSES.txt'));
