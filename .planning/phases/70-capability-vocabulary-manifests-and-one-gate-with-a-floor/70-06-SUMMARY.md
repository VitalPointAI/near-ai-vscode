---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 06
subsystem: gate
tags: [floor, decide, ocsf, decision-record, offline, pure-domain]

requires:
  - phase: 70-01
    provides: "Capability, parseCapability, fromActionCapability and the Parsed refusal type"
  - phase: 70-03
    provides: "BundleState, GateContextName, FAILED_CLOSED_VERBS, defaultBundlePayload, bundleHash"
  - phase: 70-04
    provides: "ROUTE_RULES and decideRoute, used by the offline test and the rule id list"
  - phase: 70-05
    provides: "tool and MCP manifests whose effects and contexts feed GateRequest"
provides:
  - "src/domain/gate/floor.ts: FLOOR_RULES, FloorRule, FLOOR_RULE_ORDER, CREDENTIAL_STORES, KEYCHAIN_COMMANDS, EXTENSION_STORAGE_FOLDERS, EXTENSION_STORAGE_TEXT, FLOOR_CANNOT_SEE_TEXT, isFloorProtectedWrite, namesCredentialStore, FloorVerdict, floorFor (GATE-05, D-16, D-17, D-44)"
  - "src/domain/gate/decide.ts: Presence, ActorRef, GateRequest, GateDecision, SettingsLayer, SettingsAnswer, FloorMode, GateOptions, GateRuntime, DecisionSink, decide, effectiveMode, GATE_RULE_IDS (GATE-04, GATE-06, OFFL-01)"
  - "src/domain/gate/record.ts: RECORD_VERSION, OCSF_VERSION, OCSF_API_ACTIVITY, DECISION_OUTCOMES, DecisionRecord, DecisionRecordInput, buildDecisionRecord, validateDecisionRecord, redactRecord (GATE-07, D-20, D-21)"
  - "src/test/gateDecide.test.ts, gateFloor.test.ts, gateRecords.test.ts, gateOffline.test.ts"
affects: [70-07, 70-08, 70-11, 70-12, 70-13, 70-17, 70-20, 70-22]

actuals:
  tokens: 23000
  tasks: 3
  commits: 3
plan_head_before: 9e3b07466634d7d1f07ffce76519b124dbd692e0
plan_head_after: 6fcc54e39a567818c66f5b71f2c3c03986aeefc4
commits: 3

tech-stack:
  added: []
  patterns:
    - "The settings layer is a function parameter (today's decidePermissionAsync later), so the pure gate imports nothing from src/agent"
    - "A floor ask is never undone by a later layer: it carries offerAlwaysAllow false and allowGrant false, and only a deny from the settings layer or the emergency stop can beat it"
    - "Records are redacted inside buildDecisionRecord, so no caller can write an unredacted one by forgetting a step"
    - "Network stubs in a test replace properties of the real module object (import x = require), because an import * namespace is a read-only copy"

key-files:
  created:
    - src/domain/gate/floor.ts
    - src/domain/gate/decide.ts
    - src/domain/gate/record.ts
    - src/test/gateDecide.test.ts
    - src/test/gateFloor.test.ts
    - src/test/gateRecords.test.ts
    - src/test/gateOffline.test.ts
  modified: []

key-decisions:
  - "Layer order in decide(): emergency stop, bundle state, floor, bundle ceiling, labels, settings layer. Shadow mode relaxes only the floor; a failed-closed bundle and the ceiling apply in both modes, as plan 12 expects (a valid bundle changes nothing, an invalid one fails closed)"
  - "A floor ask that nobody can answer (presence none) is recorded as refused-by-floor, because the floor decided it; a denial from the settings layer stays denied"
  - "The label layer is a slot: GateRequest carries an optional labelVerdict (rule and plain reason) worked out by the caller; plans 20 and 22 compute it from the mark and the clearances"
  - "Legacy facts keep today's line 631: risky asks in every mode with no run-wide grant (rule taint.held); sensitive turns an allow into an ask unless the effective mode is fully-autonomous (rule settings.sensitive-read), so workspace credential-file reads are not a floor verdict (D-18)"

patterns-established:
  - "One request that matches exactly one rule per floor rule, so a matrix proves the rule and not a neighbour"

requirements-completed: [GATE-04, GATE-05, GATE-06, GATE-07, OFFL-01]

duration: not captured
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 06: The floor, one decide(), and the decision record Summary

**A pure decide() that layers emergency stop, bundle state, floor, bundle ceiling, labels and today's settings logic (handed in as a function), with a floor that refuses key and credential stores and asks a person, with no always-allow and no grant, before protected writes, publishing, destroying and shared writes in every mode, plus an OCSF-shaped, redacted, integer-only decision record and a test that runs decisions with the network stubbed to throw.**

## Performance

- **Duration:** not captured (start time was not recorded)
- **Completed:** 2026-11-16
- **Tasks:** 3
- **Files modified:** 7 (all created)

## Accomplishments

- `floor.ts` names the seven rules in a fixed order (three refusals, then four asks), so one call always records the same rule and a refusal beats an ask. `floorFor` reads effects, the legacy `forbidden` hook, floor facts and the command text, and a workspace credential-file read (`.env`, `deploy/id_ed25519`) is never a verdict.
- The credential text check (`namesCredentialStore`) matches the confirmed D-16 list after `~/`, `$HOME/`, `${HOME}/` or a literal home folder, VS Code's `state.vscdb` and its backup anywhere, and the six keychain commands. It reads text only and never runs a command; `FLOOR_CANNOT_SEE_TEXT` says what it cannot see. This extension's `identity` and `gate` storage folders are matched by the portable form `globalStorage/vitalpoint.near-ai-vscode` or by the real folder the adapter names.
- `decide()` is async only because the settings layer is. Floor refusals deny with no card; floor asks come back with `offerAlwaysAllow` false and `allowGrant` false in all four modes; with presence none a floor ask becomes a deny with "Nobody is here to approve this, and it always needs a person: ...". A deny from the settings layer (deny list) and the emergency stop still win.
- A failed-closed bundle lets read and plan through to the settings layer and denies any other effect (and an empty effect list) with `bundle.failed-closed` and the bundle's own sentence. The ceiling caps the mode per context (`effectiveMode`), refuses a verb absent from `ceiling.contexts` or not listed for the context, a tool whose manifest does not list the context, and an MCP server outside the interactive context that is not in `unattendedMcp`.
- Shadow mode returns today's decision (only `floor.state-keys` refuses, as `tool.forbidden` does) and puts the enforced floor verdict in `shadowFloor`; enforce is the default.
- `buildDecisionRecord` makes the OCSF 1.9.0 API Activity record (class 6003, category 6, `type_uid` 600300 plus the activity, profile `ai_operation`) with `recordVersion` 1 under `unmapped.nearAi`, redacted before it exists. `validateDecisionRecord` checks the class arithmetic, required keys, versions, whole numbers (through `canonicalize`) and secret-like strings (`findSecrets`), and claims nothing about full OCSF validity. One frozen golden canonical record pins recordVersion 1.
- `gateOffline.test.ts` replaces `fetch`, `net.connect`, `net.createConnection`, `dns.lookup`, `dns.promises.lookup`, `http.request` and `https.request` with throwing, counting stubs and runs 48 floor decisions, a signed-bundle check, two route decisions (including the empty catalog edge) and a record: each of the seven stubs was called 0 times.

## Task Commits

1. **Task 1: tracer, a protected write in fully-autonomous goes through decide() to an ask with no grant and a valid record** - `9cb0fd3` (feat)
2. **Task 2: the whole floor, presence, failed-closed bundles, the ceiling, shadow mode, and the floor matrix** - `99d27eb` (feat)
3. **Task 3: the OCSF record in full, redaction, a frozen golden record, and decisions with the network stubbed to throw** - `6fcc54e` (feat)

## Verification

Every command ran inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`. No full suite and no e2e were run, as the plan asks.

- Task 1: `npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateDecide.test.js dist/test/teamBoundaries.test.js`: 9 tests, 9 pass, 0 fail, 0 cancelled.
- Task 2: `... dist/test/gateFloor.test.js dist/test/gateDecide.test.js dist/test/teamBoundaries.test.js`: 33 tests, 33 pass, 0 fail, 0 cancelled. The matrix asserts exactly 56 cases (7 rules x 4 modes x 2 presences). `grep -rn "homedir()" src/test/gateFloor.test.ts` prints nothing.
- Task 3 and plan level: `... dist/test/gateRecords.test.js dist/test/gateOffline.test.js dist/test/gateDecide.test.js dist/test/gateFloor.test.js dist/test/gateVocabulary.test.js dist/test/gateLabels.test.js dist/test/gateDominance.test.js dist/test/gateBundle.test.js dist/test/gateRouting.test.js dist/test/gateLabelMap.test.js dist/test/gateManifestFormat.test.js dist/test/teamSignedPayload.test.js dist/test/teamBoundaries.test.js`: 215 tests, 215 pass, 0 fail, 0 cancelled.
- `package-lock.json` is unchanged and no package was added. No existing test assertion was changed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] floor.state-keys also reads effect paths and the command text**
- **Found during:** Task 2
- **Issue:** the plan names the three refusal facts (`stateKeys`, `credentialStore`, `identityFiles`) but a file-tool read or write of `.near-ai/state/keys/...` carries no fact, only an effect path, and a shell command only text. Today's `tool.forbidden` covers both, so a gate that waited for a fact would be weaker than the code it replaces.
- **Fix:** `floorFor` also matches `read`, `workspaceWrite` and `destroy` effect paths against `STATE_KEYS_PATH`, runs `namesStateKeys` over the command, and accepts today's `forbidden` string as the state-keys reason. The credential-store and identity-files rules read the command text the same way.
- **Files modified:** `src/domain/gate/floor.ts`
- **Commit:** `99d27eb`

**2. [Rule 1 - Bug] Test stubs could not replace the network modules**
- **Found during:** Task 3
- **Issue:** `import * as net from 'node:net'` compiles to a read-only namespace copy, so replacing `net.connect` threw "Cannot set property connect ... only a getter".
- **Fix:** `gateOffline.test.ts` uses `import net = require('node:net')` (and the same for dns, http, https), which returns the real module object.
- **Files modified:** `src/test/gateOffline.test.ts`
- **Commit:** `6fcc54e`

**Interpretations the plan left open (decisions, not deviations):**

- The label layer is a slot: `GateRequest.labelVerdict` (rule and plain reason) is applied after the ceiling and before the settings layer, in both modes. Plans 20 and 22 compute it from the mark and the clearances.
- Rule `bundle.ceiling.mode` is recorded when the ceiling lowered the mode and the settings layer then asked with a `settings.mode.*` rule: the card exists because the bundle capped the mode.
- In a failed-closed state `effectiveMode` reports approve-risky, and an empty effect list is denied (nothing proves it is read or plan).
- The legacy `risky` hook records rule `taint.held`; the `sensitive` clause uses the effective mode (equal to the setting mode under the default bundle).
- The `.planning/.near-ai/team.md` exemption matches the exact file at the project root or under any parent folder, as the file tool's `endsWith` does, but only at a path boundary; `team.md.bak` and `labels.json` are covered.
- OCSF ids: `asked` is written with `action_id` 3 and `disposition_id` 3 (the plan's 3 for an ask), `status_id` 1; allowed and approved are status 1, denied and refused are status 2. The activity name for read, plan, workspace write and destroy is Read, Update, Delete, and for every other verb the verb itself.
- Extra exports beyond the plan's list, all small: `namesIdentityFiles`, `VSCODE_SECRET_FILES`, `FloorLocations`, `FloorFacts`, `FloorInput`, `LabelVerdict`, `ActorKind`, `outcomeOf` (maps a decision to its recorded outcome; a floor deny is refused-by-floor).

**Research A5 names not added (carried to the PR 3 body as an owner question):** `~/.config/gh/hosts.yml`, `~/.config/git/credentials`, `~/.cargo/credentials.toml`, `~/.terraform.d/credentials.tfrc.json`, `~/.local/share/keyrings/`, `~/Library/Keychains/`, `kwallet-query`, `cmdkey /list`, `pass show`, `gopass show`, and the token printers `gh auth token`, `gcloud auth print-access-token`, `az account get-access-token`, `aws configure export-credentials`.

## Known Stubs

None. Nothing in the running extension imports `floor.ts`, `decide.ts` or `record.ts` yet; plans 12 and 13 wire them in shadow and plan 17 enforces the floor. The label verdict is an input the caller supplies, not a stub.

## Threat Flags

None. All five mitigations of the plan's threat register hold as tested (T-70-19 matrix, T-70-20 credential refusal, T-70-21 presence none, T-70-22 redaction and validator, T-70-23 offline stubs); no network, auth or file surface was added.

## Issues Encountered

None beyond the test-stub fix above.

## Next Phase Readiness

Plans 07 and later can call `decide()` with a real `SettingsLayer`. The owner should confirm for the PR 3 body: the A5 list above, and whether an ask record should carry action_id 3 (Observed) with disposition_id 3 as written, since the research text lists "3 Observed" without naming which field.

## Self-Check: PASSED

- FOUND: `src/domain/gate/floor.ts`, `src/domain/gate/decide.ts`, `src/domain/gate/record.ts`
- FOUND: `src/test/gateDecide.test.ts`, `src/test/gateFloor.test.ts`, `src/test/gateRecords.test.ts`, `src/test/gateOffline.test.ts`
- FOUND commits: `9cb0fd3`, `99d27eb`, `6fcc54e`
