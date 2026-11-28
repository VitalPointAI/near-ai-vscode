---
phase: 88-ingestion-core-governed-store-and-the-data-map
plan: 01-fixture-handoff
completed: 2026-11-26
---

# Synthetic Data Map fixture handoff

The portable tests exercise inventory, disconnected and empty results, retries, and discarding
stale responses when the mission changes. They exercise the trial's registration through an
injected callback. A separate check verifies the shipping manifest omits the trial command.

## Verification scope

The tests-first compile at `5b1368b1a` found the absent fixture modules. Local verification uses
`npm run compile && node --test dist/test/dataMapPanel.test.js` for the portable checks
and `npm run verify:release` for the extension archive. The ordinary `npm test` entry point selects
`dist/test/*.test.js` and `scripts/test/*.test.mjs`. The opt-in PostgreSQL tracer under integration
requires the prior approval's exact disposable fixture and an explicit test invocation.

The existing release-content job runs the normal release verifier and uploads the VSIX for that
run. The verifier rejects both source and compiled test files in the archive. The packaged
`extension/package.json` can also be inspected for trial command contributions and activation.
The earlier isolated PostgreSQL and HTTP trials are historical evidence. This handoff records
local packaging and portable verification, and the exact revision's CI and independent approval
are recorded on the PR. Live Data Map acceptance remains with its roadmap phases.

## Open conditions

None.
