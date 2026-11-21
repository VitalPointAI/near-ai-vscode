---
phase: 44-accreditation-evidence-and-compliance-dashboard
plan: 01
subsystem: compliance
tags: [oscal, ajv, status-engine, tracer, vsix-exclusion, node-type-stripping]

requires: []
provides:
  - "compliance/ package skeleton (Node 24 type stripping, tsc --noEmit, own lockfile, exact pins)"
  - "model.ts contract: STATES, STATE_WORDS, RESPONSIBILITIES, REASONS, FRESHNESS, NS, PROP_NAMES, OSCAL_VERSION, SOURCE_DIRS, SOURCE_FILES, FORBIDDEN_STATUS_NAMES, ALLOWED_STATUS_FORM, shared types, sourcePathForReport"
  - "computeStatus (the only State producer), evaluateTestRule, evaluateObservationRule, buildDashboard"
  - "vendored OSCAL 1.2.1 complete schema with SHA-256; validateOscal, validateOurs, loadJson, modelOf, findStatusFields"
  - "compliance/** and docs/security/** kept out of the VSIX (.vscodeignore + verify-release-content)"
affects: [44-04, 44-05, 44-06, 44-07, 44-08, 44-10, 44-13, 44-14, 44-15, 44-17, 44-18]

actuals:
  tokens: 90606    # chars/4 over the added diff lines, the vendored 267,611-byte schema included; 23,703 without it
  tasks: 3
  commits: 3
plan_head_before: 932f73c9db34fc18b44f45e812a35cd68d249ce3
plan_head_after: 14fcb6217e0a1e09ac8ab2f7ecb7c43d6a98a42c

tech-stack:
  added: ["typescript 5.9.3", "@types/node 22.20.5", "ajv 8.20.0", "ajv-formats 3.0.1 (all devDependencies, all already in the root lockfile with the same integrity)"]
  patterns:
    - "Erasable TypeScript run by Node 24 type stripping, explicit .ts imports, tsc --noEmit as lint"
    - "One pure status function; every other module produces RuleResults or arranges rows"
    - "Per-model OSCAL wrapper schemas that $ref into one vendored complete schema"
    - "Gate pattern lists tested by parsing the gate script's own literal list"

key-files:
  created:
    - compliance/package.json
    - compliance/package-lock.json
    - compliance/tsconfig.json
    - compliance/.npmrc
    - compliance/README.md
    - compliance/src/model.ts
    - compliance/src/rules.ts
    - compliance/src/status.ts
    - compliance/src/dashboard.ts
    - compliance/src/validate.ts
    - compliance/src/collectors/types.ts
    - compliance/schemas/oscal_complete_schema.json
    - compliance/schemas/SOURCES.json
    - compliance/schemas/evidence-rule.schema.json
    - compliance/test/tracer.test.ts
    - compliance/test/oscalValid.test.ts
    - compliance/test/noStatus.test.ts
    - compliance/test/fixtures/tracer/catalog.json
    - compliance/test/fixtures/tracer/component.json
    - compliance/test/fixtures/tracer/evidence-rules.json
    - compliance/test/fixtures/tracer/report-passed.ndjson
    - compliance/test/fixtures/tracer/report-skipped.ndjson
  modified:
    - .gitignore
    - .vscodeignore
    - scripts/verify-release-content.mjs

key-decisions:
  - "@types/node pinned at 22.20.5 (already in the root lockfile) instead of a new 24.x release, so no first-install checkpoint"
  - "One vendored file, oscal_complete_schema.json of OSCAL 1.2.1, with per-model wrappers built in validate.ts"
  - "The no-status walk allows only a status prop with value withdrawn on a control under catalogs/ (no ns, or the standard OSCAL ns)"
  - "All compliance tests sit flat in compliance/test/*.test.ts, so the package test script never changes"
  - "In 44-01 a declared limitation, an unsettled question or a self-signed decision where an official must sign each turn a would-be Met or Stale into Not met with its own reason; 44-04 gives each its final rule"
  - "A result counts as passed only with passed true and reason met; a head-window result with no commit, or one dated more than 5 minutes ahead of the clock, is not fresh"
  - "Vendored OSCAL documents (ours: false) must be on the 1.2 line; generated ones must be stamped exactly 1.2.1"

patterns-established:
  - "computeStatus is the only State producer: even a control with no implementing component gets its state by calling computeStatus with no statements"
  - "Evidence rule results carry reason codes from REASONS; the dashboard copies states, it never invents one"

requirements-completed: [ACCR-01, ACCR-04, ACCR-06, ACCR-07]

coverage:
  - id: D1
    description: "Tracer: one fixture control reaches Met, Not met (skipped, not run) and Stale in the dashboard JSON from evidence alone"
    requirement: ACCR-06
    verification:
      - kind: unit
        ref: "compliance/test/tracer.test.ts (14 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Vendored OSCAL 1.2.1 schema with recorded SHA-256; OSCAL and own-schema validators; safe JSON loader; evidence-rule schema"
    requirement: ACCR-01
    verification:
      - kind: unit
        ref: "compliance/test/oscalValid.test.ts (11 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "No source file under compliance/ can carry a status, state or met key or prop"
    requirement: ACCR-06
    verification:
      - kind: unit
        ref: "compliance/test/noStatus.test.ts (8 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "compliance/ and docs/security/ never ship in the VSIX"
    requirement: ACCR-07
    verification:
      - kind: unit
        ref: "compliance/test/noStatus.test.ts#verify-release-content refuses a VSIX entry under extension/compliance/ or extension/docs/security/"
        status: pass
      - kind: integration
        ref: "npm run verify:release (3083 entries verified, 0 entries under extension/compliance or extension/docs/security)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Reason sentences and README wording (plain words, no compliance claim, your organization decides)"
    verification: []
    human_judgment: true
    rationale: "Wording quality is a reader's judgement; 44-05's word lint will check the phrase list mechanically"

duration: 15min
completed: 2026-11-21
status: complete
---

# Phase 44 Plan 01: Compliance package skeleton and status tracer Summary

**A new `compliance/` package where one fixture control travels from an OSCAL catalogue through a component statement, an evidence rule and a per-test report row to a computed Met, Not met or Stale in the dashboard JSON, validated offline against the vendored OSCAL 1.2.1 schema, with no status allowed in any source file and nothing of it shipping in the VSIX.**

## Performance

- **Duration:** about 15 min
- **Started:** 2026-11-21T18:05:50Z
- **Completed:** 2026-11-21T18:20:00Z
- **Tasks:** 3 of 3
- **Files:** 22 created, 3 modified

## Accomplishments

- The package skeleton: `"type": "module"`, Node `>=24 <27`, erasable TypeScript checked by `tsc --noEmit`, scripts `lint`, `test`, `cli`, exact devDependencies, `.npmrc` copied from relay. `npm --prefix compliance ci --ignore-scripts` succeeds; every one of the nine locked packages has the same version and integrity as in the root lockfile.
- The shared contract in `model.ts`, the rule evaluators, the status engine and the dashboard builder. The tracer proves Met, Not met (test-skipped, test-not-run, no-statement, no-rules, missing-result), Stale and your organization's responsibility from evidence alone.
- The vendored OSCAL 1.2.1 complete schema, per-model validators, strict validators for our own schemas, the 1.2.1 stamp check, `loadJson` with a 16 MiB cap and prototype-key refusal, and `evidence-rule.schema.json`.
- `findStatusFields` and its test; `.vscodeignore` and `verify-release-content.mjs` keep `compliance/` and `docs/security/` out of the extension; `compliance/out/` is git-ignored; the package README.

## Contract names as built

`compliance/src/model.ts`:
- `NS = 'urn:near-ai-vscode:compliance'`, `OSCAL_VERSION = '1.2.1'`.
- `STATES` (met, partly-met, not-met, stale, not-applicable, your-organizations-responsibility), `State`, `STATE_WORDS` (Met, Partly met, Not met, Stale, Not applicable, Your organization's responsibility).
- `RESPONSIBILITIES` (product, shared, your-organization, inherited, not-applicable), `Responsibility`.
- `REASONS` (22 codes: met, no-statement, no-rules, missing-result, test-missing-file, test-missing-name, test-skipped, test-todo, test-failed, test-not-run, observation-failed, stale, your-organization, inherited, not-applicable, not-applicable-unreviewed, partly-statements, limitation, unsettled, self-signed, risk-accepted, appliance-only), `ReasonCode`, plus `ReasonPlaceholder` ('date' | 'reason' | 'text' | 'question' | 'provider').
- `FRESHNESS` { head: 'head', audit: 24 h, settings: 7 d, harness: 30 d, document: 365 d, attestation: 365 d } in milliseconds, `WindowKind`.
- `PROP_NAMES` (a frozen array of the 13 names), `PropName`.
- `SOURCE_DIRS`, `SOURCE_FILES`, `FORBIDDEN_STATUS_NAMES`, `ALLOWED_STATUS_FORM` { dir: 'catalogs', propName: 'status', value: 'withdrawn', on: 'control' }.
- Types `Statement` { id, description, yourOrganizationDoes?, limitation?, unsettled?, requiresOfficialSignature? }, `EvidenceRule`, `TestReportRow`, `Observation`, `RuleResult`, `TailoringRecord` { level, control, component, reason, reviewer, reviewedAt }, `VerifiedRiskAcceptance` { id, gap, controls, levels?, reason, namedPerson, issuedAt, expiresAt }, `StatusInput` (with `now: Date`), `StatusOutcome` { state, reason, detail? }, `ComponentRow`, `DashboardRow`, `Dashboard`, `LevelInput`, `ComponentInput` { id, implemented: { control, responsibility, statements, inheritedFrom? }[] }, `DashboardInput`.
- `sourcePathForReport(file, packagePrefix?)`: idempotent (mapping a mapped path changes nothing), normalizes `\` and a leading `./`, and strips a prefix already present.

`compliance/src/rules.ts`: `evaluateTestRule(rule, rows, context)`, `evaluateObservationRule(rule, observations, context)`, `RuleContext` { commit, collectedAt, packagePrefix?, runUrl? }, `OBSERVATION_WINDOWS` (audit, settings, harness, document/documents, attestation/attestations; any other collector is judged against the head), `windowForCollector(id)`.

`compliance/src/status.ts`: `computeStatus(input)`, `isFresh(result, head, now)`, `FUTURE_TOLERANCE_MS` (5 min).

`compliance/src/dashboard.ts`: `buildDashboard(input)`, `DASHBOARD_SCHEMA_VERSION` (1).

`compliance/src/validate.ts`: `OSCAL_MODELS`, `OscalModel`, `OSCAL_ROOT_DEFINITIONS`, `OSCAL_SCHEMA_DIRECTIVE_DEFINITION`, `SCHEMAS_DIR`, `OSCAL_SCHEMA_FILE`, `MAX_ERRORS` (5), `createValidators(schemasDir?)` returning { oscalValidator, oursValidator, validateOscal, validateOurs }, `validateOscal(doc, model, { ours })`, `validateOurs(doc, schemaName)`, `modelOf(doc)`, `loadJson(path, { maxBytes })`, `DEFAULT_MAX_JSON_BYTES`, `PROTOTYPE_KEYS`, `findStatusFields(rootDir)` returning `StatusField[]` { file, path, name, kind: 'key' | 'prop' }, `ValidationResult` { ok, errors: string[] }.

`compliance/src/collectors/types.ts`: `FetchJson`, `CollectorContext` { now, commit, runUrl?, fetchJson?, readFile }, `Collector<Input>` { id, window, collect(input, context) }, `CollectorResult` { collector, observations, errors }.

## The four planning choices

1. `@types/node` 22.20.5, the version the root lockfile already carries, not a new 24.x release (no first-install checkpoint; Node 22 types are a subset of what Node 24 runs). Reversible.
2. One vendored file, `oscal_complete_schema.json` of OSCAL 1.2.1, with per-model root wrappers built in `validate.ts` that `$ref` into the complete schema's own definitions. Reversible.
3. The no-status walk allows exactly one form: a prop named `status` with value `withdrawn` on a control (an element of a `controls` array, enhancements included) in a file under `catalogs/`, with no `ns` or the standard OSCAL `ns`. Any other value, place, folder or our own `ns` fails. Reversible.
4. All compliance tests flat in `compliance/test/*.test.ts` (collector tests `collector<Name>.test.ts`).

## OSCAL schema facts (measured)

- Downloaded from `https://github.com/usnistgov/OSCAL/releases/download/v1.2.1/oscal_complete_schema.json` at 2026-11-21T18:11:18Z, 267,611 bytes.
- SHA-256 `f53c67f5f64cc49c9b3512834d2baa2f8da841cf2cc0c361e6d77ecce0f3d077`, equal to the research value; recorded in `schemas/SOURCES.json` and re-checked by a test.
- The complete schema is draft-07 with `$id` `http://csrc.nist.gov/ns/oscal/1.0/1.2.1/oscal-complete-schema.json`, a root `oneOf` of eight branches, and 142 definitions. Root definitions:
  - catalog: `oscal-complete-oscal-catalog:catalog`
  - profile: `oscal-complete-oscal-profile:profile`
  - component-definition: `oscal-complete-oscal-component-definition:component-definition`
  - system-security-plan: `oscal-complete-oscal-ssp:system-security-plan`
  - assessment-plan: `oscal-complete-oscal-ap:assessment-plan`
  - assessment-results: `oscal-complete-oscal-ar:assessment-results`
  - plan-of-action-and-milestones: `oscal-complete-oscal-poam:plan-of-action-and-milestones`
  - mapping-collection: `oscal-complete-oscal-mapping:mapping-collection`
  - every root also allows `$schema` through `json-schema-directive`.

## Task Commits

1. **Task 1: tracer** - `eda54ecf` (feat)
2. **Task 2: OSCAL schema, validators, evidence-rule schema, collector types** - `00389b23` (feat)
3. **Task 3: no-status walk, VSIX exclusions, git-ignored output, README** - `14fcb621` (feat)

## Tests (first on the base, then after)

- RED on the base: `tracer.test.ts` failed (modules `dashboard.ts`, `status.ts`, `rules.ts` missing); `oscalValid.test.ts` failed (`validate.ts` missing); `noStatus.test.ts` failed (`findStatusFields` not exported), and its VSIX test failed again until the patterns were added.
- Tracer feedback gate (auto mode, automated verify only): Task 1's verify re-run passed (lint clean, 14 of 14), then expansion continued.
- Final: `node scripts/run-tests.mjs compliance/test/noStatus.test.ts compliance/test/oscalValid.test.ts compliance/test/tracer.test.ts` 33 tests, 33 pass, 0 fail; `npm --prefix compliance test` the same 33; `npm --prefix compliance run lint` clean.
- `npm run verify:release` (under the shared heavy lock, 4G cap): exit 0, "Release content verified: 3083 entries (13.55 MiB), 554 runtime JavaScript files, and 69 required release assets"; 0 entries under `extension/compliance` or `extension/docs/security`.
- Existing tests that read `.vscodeignore` or `verify-release-content.mjs` (compiled): layoutProbePackaging, staffIntegration, hubIsolation, cyberFixtures, responsivePanels, docsSiteIsolation, relayIsolation: 63 of 63 pass. `scripts/test/zip.test.mjs`: 3 of 3 pass.

## Decisions Made

See key-decisions above. Beyond the four planning choices, the 44-01 behaviour of the inputs 44-04 finalizes: a declared limitation, an unsettled question (from the input or any statement) and a self-signed decision where a statement requires an official's signature each turn a would-be Met or Stale into Not met with its own reason and detail; tailoring records and risk acceptances are accepted but change nothing yet; responsibility `not-applicable` is Not met (not-applicable-unreviewed). When several components implement a control, the control row takes the worst component state (44-04's `aggregateControl` replaces this).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] noStatus test assumed walk order**
- **Found during:** Task 3
- **Issue:** the prop-name test expected findings in file-name order; the walk follows `SOURCE_DIRS` order (profiles before components).
- **Fix:** the test sorts findings by file before comparing (order is not a requirement); the forbidden-pattern parser also skips `//` comment lines inside the list.
- **Files modified:** compliance/test/noStatus.test.ts
- **Commit:** 14fcb621

**2. [Rule 3 - Blocking] evidence-rule schema under ajv strictRequired**
- **Found during:** Task 2
- **Issue:** strict mode refuses `required` names not defined beside them, so a `not: { required: [...] }` exclusion would not compile.
- **Fix:** each `oneOf` branch defines `kind` (const), its own part (`$ref`) and the other part as `false`, with `required: ["kind", <part>]`.
- **Files modified:** compliance/schemas/evidence-rule.schema.json
- **Commit:** 00389b23

### Other differences to note

- **Branch:** executed on `feat/phase-44-01-tracer` from `feat/phase-44-compliance` (932f73c9) as the orchestrator directed, not the plan's `feat/phase-44-01-skeleton-tracer` from `feat/phase-44-accreditation`.
- **Commits:** one commit per task as the phase brief requires, instead of separate test and feat commits; RED runs are recorded above.
- **Additive contract fields:** `ComponentRow` and `DashboardRow` carry an optional `detail` (the placeholder values, for example the stale date) emitted only when present. 44-05's strict `dashboard.schema.json` must allow it (an object of placeholder name to string) or drop it when it adds `reasonText`.
- **Extra exports** beyond the contract list (all additive): `ReasonPlaceholder`, `PropName`, `RuleContext`, `OBSERVATION_WINDOWS`, `windowForCollector`, `isFresh`, `FUTURE_TOLERANCE_MS`, `SCHEMAS_DIR`, `OSCAL_SCHEMA_FILE`, `OSCAL_ROOT_DEFINITIONS`, `OSCAL_SCHEMA_DIRECTIVE_DEFINITION`, `MAX_ERRORS`, `ValidationResult`, `Validators`, `DEFAULT_MAX_JSON_BYTES`, `PROTOTYPE_KEYS`, `StatusField`.
- `REQUIREMENTS.md`, `STATE.md` and `ROADMAP.md` were not touched (worktree mode; the requirement ids are shared with later plans).

**Total deviations:** 2 auto-fixed (1 bug in a new test, 1 blocking schema form). **Impact:** none on the contract.

## Issues Encountered

None.

## Owner actions

- `scripts/verify-release-content.mjs` is a gate file: the integration PR carries the owner's gate approval for its two new patterns.

## Known Stubs

None. The `cli` script names `src/cli.ts`, which 44-06 adds (planned in the contract, not a stub that blocks this plan's goal).

## Threat Flags

None beyond the plan's threat model (T-44-01 to T-44-04 and T-44-SC are mitigated as planned: prototype-key refusal and byte cap in loadJson; schema hash checked before commit and by a test; the no-status walk; the VSIX exclusions proved by verify:release; only packages already in the root lockfile, installed with `--ignore-scripts`, exact pins, lockfile committed).

## Notes for later plans

- Every worktree needs `npm --prefix compliance ci --ignore-scripts` before lint or tests (compliance/node_modules is git-ignored by the root `node_modules/` rule).
- `validate.ts` imports `{ Ajv }` from `ajv` and uses `addFormatsModule.default` from `ajv-formats` (both CommonJS under nodenext).
- `validateOurs` schema names match `^[a-z0-9][a-z0-9-]{0,63}$` and load `schemas/<name>.schema.json`; any new `*.schema.json` is compiled strictly by `oscalValid.test.ts` automatically.
- `findStatusFields` throws on a source file that is not valid JSON (naming it) and checks key and prop names case-insensitively.
- `TestReportRow.status` is the test outcome from the report (contract), not an assessment; reports are not source files and are never walked.
- `computeStatus` counts a passed result only when its reason is `met`; collectors and rule evaluators must keep that pairing.
- The generated VSIX `near-ai-vscode-0.4.35.vsix` and `vendor/`, `dist/`, `sbom.cdx.json` from verify:release are left in this worktree (all git-ignored).

## Next Phase Readiness

Ready for the rest of wave 1 and for wave 2 (44-04 appends to `model.ts` and extends `computeStatus` without changing its signature).

## Self-Check: PASSED

- All 22 created files exist; the three commits `eda54ecf`, `00389b23` and `14fcb621` are ancestors of HEAD.
- Acceptance criteria re-run: status.ts and package-lock.json present; `export function computeStatus` 1; NS string in model.ts 1; `"type": "module"` 1; schema hash line 1; `strict: false` 1; `"additionalProperties": false` 4; `^compliance/\*\*$` 1; `^docs/security/\*\*$` 1; `^compliance/out/$` 1; "compliance" in verify-release-content 2; "security" 2.
