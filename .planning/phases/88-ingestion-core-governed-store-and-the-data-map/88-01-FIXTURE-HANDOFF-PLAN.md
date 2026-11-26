---
phase: 88-ingestion-core-governed-store-and-the-data-map
plan: 01-fixture-handoff
type: execute
wave: 1
depends_on: []
autonomous: true
requirements: [DSEC-03, INV-04]
files_modified:
  - src/test/dataMapPanel.test.ts
  - src/test/integration/dataMapFixture.ts
  - src/test/integration/dataMapPanelFixture.ts
  - src/test/integration/dataPlatformHost.ts
  - src/test/integration/dataPlatformTracer.ts
  - src/test/integration/fixtures/phase-88/001-governed-catalog.sql
must_haves:
  truths:
    - "The approved synthetic trial's catalogue and panel can be exercised with the same fixture isolation on current main."
    - "The shipped extension carries no Data Map command, panel fixture, HTTP fixture or trial schema from this handoff."
  artifacts:
    - path: src/test/integration/dataPlatformTracer.ts
      provides: the existing explicitly invoked synthetic catalogue and panel tracer
  key_links:
    - from: src/test/integration/dataPlatformTracer.ts
      to: src/test/integration/fixtures/phase-88/001-governed-catalog.sql
      via: the existing fixture initialization in the intentionally selected trial
---

# Hand over the synthetic Data Map trial

<objective>
Keep the already verified Phase 88-01 trial reproducible on current main while 88-07 and 88-08
wait on their existing dependencies. The previously approved scope is disposable synthetic data.
This handoff carries the fixture and its checks in the existing test tree. The separately reviewed
production command, transport, rail and migration will follow the existing roadmap. This is the
standalone authorized fixture task and owns the shared test path while the broader draft is held.
</objective>

<tasks>
<task type="auto" tdd="true">
  <name>Preserve the existing trial without packaging its command or fixture code</name>
  <files>src/test/dataMapPanel.test.ts, src/test/integration/dataMapFixture.ts, src/test/integration/dataMapPanelFixture.ts, src/test/integration/dataPlatformHost.ts, src/test/integration/dataPlatformTracer.ts, src/test/integration/fixtures/phase-88/001-governed-catalog.sql</files>
  <read_first>Read 88-01-PLAN.md, the trial summary and released-content evidence at 306e13a8a, and the current extension packaging and test-runner exclusions.</read_first>
  <action>
    Before copying the fixture, run the existing panel test against its planned placement and record the missing-module failure.
    Port the fixture only from exact independent review at 306e13a8a, keeping the SQL bytes identical.
    Place its type contract and panel implementation under the existing integration test tree, where the
    extension package already excludes test files. Only change the imports and fixture path needed for
    this placement. Keep the three portable panel behavior checks and the explicit PostgreSQL/HTTP
    tracer. The fourth original portable check expected a shipping command. Replace that one
    expectation with a refusal of shipping activation and command contributions in package.json.
    The injected fixture callback still verifies registration and can open the test panel.
    Preserve its required fixture identifier, exact image checks, isolated socket and signed fact and
    authorization behavior. Keep it outside both the default test entry point and the `*.test.js`
    discovery pattern. Preserve recognized failures while reporting only fixed SQL diagnostics. Keep package.json, extension activation, the Workbench rail, existing
    code and default test selection intact. Carry no later plan drafts.
    Use only already approved fixture authority for database verification. If the exact disposable
    fixture cannot run within that scope, keep database reverification pending and retain the
    original evidence and byte comparisons. No live sources, real records, model calls or external
    network participate in this trial.
  </action>
  <verify>
    <automated>Under the normal cap run `npm run compile && node --test dist/test/dataMapPanel.test.js` and `npm run verify:release`. The existing release-content gate rejects test files in the VSIX. Inspect its packaged extension/package.json for absence of trial registration. Verify the trial paths and SQL bytes against 306e13a8a. Run `node --test dist/test/integration/dataPlatformTracer.js` only with the prior approval's exact disposable setup.</automated>
    <fails_when>The existing panel behavior expectations no longer hold, the packaged extension includes a trial command or artifact, the SQL or host behavior changes, or the handoff implies live catalogue support.</fails_when>
  </verify>
  <done>The synthetic catalogue and Data Map proof can be rerun from its isolated branch. The existing 88-07, 88-08, Phase 85 and Stage 1 acceptance dependencies remain open.</done>
</task>
</tasks>
