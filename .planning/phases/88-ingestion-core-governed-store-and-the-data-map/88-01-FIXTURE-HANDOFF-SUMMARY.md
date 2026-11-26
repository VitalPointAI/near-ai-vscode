---
phase: 88-ingestion-core-governed-store-and-the-data-map
plan: 01-fixture-handoff
completed: 2026-11-26
---

# Synthetic Data Map fixture handoff

The synthetic catalogue and panel trial now live in the repository's test tree. The SQL is
byte-identical to the original independently reviewed trial at `306e13a8a`. The host, tracer,
panel and type files change only imports and the path to the SQL fixture. The portable tests
exercise loading authorized inventory as plain text, disconnected and empty results, retries,
and discarding stale responses when the mission changes. The registration check confirms the
trial's command is absent from the shipping manifest.

The tests-first compile at `5b1368b1a` found the absent fixture modules. The completed compile,
four portable checks and normal release verifier passed after the port. Inspection of the actual
VSIX checked its manifest, extension entry point and archive inventory. The resulting package
has 3,175 entries and SHA-256
`f45ddc552e2a8a809c49d1f01236835881a4476599c10bba27ca8b4f29900a5c`.
Independent source review passed. The original disposable PostgreSQL and HTTP trial supplied two
passing integration cases on the same SQL and logic. This handoff reran the portable checks and
confirmed that invoking the explicit tracer without the approved fixture is refused.

## Open conditions

None.
