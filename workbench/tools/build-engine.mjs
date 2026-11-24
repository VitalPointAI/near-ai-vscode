#!/usr/bin/env node
// Bundles the host-neutral engine code the workbench backend calls (D-15) from the repository's src/ into workbench/engine/.
// Today that is the team parser: tools/team-parser-entry.ts re-exports parseTeam from src/agent/teams, the same entry the extension calls,
// so the backend gives the extension's own refusals (D-16). The bundle is loaded lazily by the backend (extension/src/node/team-preview-reader.ts),
// from the app root it computes from its own location, never from the working folder (D-12). Nothing is written outside workbench/.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));

const result = await build({
  absWorkingDir: workbenchRoot,
  entryPoints: ['tools/team-parser-entry.ts'],
  outfile: 'engine/teams.cjs',
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'cjs',
  logLevel: 'warning',
});
if (result.warnings.length > 0) {
  console.error(`build-engine: esbuild reported ${result.warnings.length} warning(s)`);
  process.exit(1);
}
