#!/usr/bin/env node
// Bundles the host-neutral engine code the workbench backend calls (D-15) from the repository's src/ into workbench/engine/.
// The team parser, since 71-10 the identity engine (tools/identity-entry.ts), and since 48.2-01 the compliance status engine (compliance.cjs). The team parser: tools/team-parser-entry.ts re-exports parseTeam from src/agent/teams, the same entry the extension calls,
// so the backend gives the extension's own refusals (D-16). The bundle is loaded lazily by the backend (extension/src/node/team-preview-reader.ts),
// from the app root it computes from its own location, never from the working folder (D-12). Nothing is written outside workbench/.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const workbenchRoot = fileURLToPath(new URL('..', import.meta.url));

// teams.cjs: the team parser. identity.cjs (71-10): did:webvh, credentials and device words for the identity service.
// compliance.cjs (48.2-01): the status engine's judgement (compliance/src/judgement.ts: rejudge and the evidence manifest check), so the
// session re-judges release evidence with the one engine, never a copy (D-11). 48.2-04 replaces the entry with tools/compliance-entry.ts.
for (const [entry, outfile] of [
  ['tools/team-parser-entry.ts', 'engine/teams.cjs'],
  ['tools/identity-entry.ts', 'engine/identity.cjs'],
  ['../compliance/src/judgement.ts', 'engine/compliance.cjs'],
]) {
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
    console.error(`build-engine: esbuild reported ${result.warnings.length} warning(s)`);
    process.exit(1);
  }
}
