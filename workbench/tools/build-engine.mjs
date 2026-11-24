#!/usr/bin/env node
// Bundles the host-neutral engine code the workbench backend calls (D-15) from the repository's src/ into workbench/engine/, one bundle per entry:
// - teams.cjs: tools/team-parser-entry.ts re-exports parseTeam from src/agent/teams, the same entry the extension calls, so the backend gives the
//   extension's own refusals (D-16). Loaded lazily by extension/src/node/team-preview-reader.ts.
// - staff.cjs: tools/staff-engine-entry.ts, the session-key and keyring names of the staff backend (Phase 33 D-51). Loaded lazily by
//   extension/src/node/staff/staff-engine.ts.
// Each bundle is loaded from the app root the backend computes from its own location, never from the working folder (D-12). Nothing is written
// outside workbench/.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));

const bundles = [
  { entry: 'tools/team-parser-entry.ts', outfile: 'engine/teams.cjs' },
  { entry: 'tools/staff-engine-entry.ts', outfile: 'engine/staff.cjs' },
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
  });
  if (result.warnings.length > 0) {
    console.error(`build-engine: esbuild reported ${result.warnings.length} warning(s) for ${entry}`);
    process.exit(1);
  }
}
