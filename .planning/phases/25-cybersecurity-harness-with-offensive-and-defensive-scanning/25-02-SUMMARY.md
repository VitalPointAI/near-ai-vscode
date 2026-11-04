---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 02
subsystem: security
tags: [cybersecurity, json-in-text-protocol, parse-repair, bounded-retries, legal-gate, region-catalogue, disclaimer, timezone-detection]

requires:
  - phase: 25
    plan: 01
    provides: "src/domain/cyber.ts with the single DisclaimerAcceptance, Target, ResolvedScope, Verdict, Severity and DepthProfile declarations, plus isoTimestamp"
  - phase: all
    provides: "src/services/chatBridge.ts boundary-validation pattern, src/agent/tools.ts AgentTool seam, src/domain/redaction.ts"
provides:
  - "Step / StepRole / StepAction / StepSandbox / StepSafetyFlags — the one step schema all four role prompts share"
  - "parseStep, repairJson, validateStep, compactSteps, isModelIncompatible, MAX_STEP_REPAIRS, ROLE_PROMPTS, ProtocolParseError"
  - "RegionCode, REGION_CATALOGUE, REGION_CODES, regionEntry, detectRegion, DEFAULT_REGION, LEGAL_NAME_PROMPT"
  - "acceptanceRecord types: AcceptanceRecord, AcceptanceSnapshot, scopeFingerprint, needsReacceptance, publicSectorWarning"
  - "CyberProtocolDriver (askRole / stepsFromText / consecutiveFailures / isIncompatible) and the module-level stepsFromText"
affects: [25-05, 25-07, 25-08]

actuals:
  tokens: 12160
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Five-pass bounded JSON repair (fence strip, first-{ to last-} slice, comment strip outside strings, single->double quote, trailing-comma removal)"
    - "Hand-rolled field-by-field boundary validation returning a typed {ok, code, reason} union rather than throwing"
    - "Injected single-function completion seam (model + messages -> text) so the driver tests with a fake and 25-05 wires the real client"
    - "Typed visible failure as a return value (kind: 'incompatible'), never an exception, so the panel can render it"
    - "Region detection as a convenience with a visible override; unknown zone fails safe to us"
    - "Order-independent sorted fingerprint of a resolved scope for D-18 re-acceptance"

key-files:
  created:
    - src/domain/cyberProtocol.ts
    - src/domain/cyberLegal.ts
    - src/agent/cyberProtocolDriver.ts
    - src/test/cyberProtocol.test.ts
    - src/test/cyberProtocolDriver.test.ts
    - src/test/cyberLegal.test.ts
    - src/test/cyberDisclaimer.test.ts
  modified: []

key-decisions:
  - "D-19 CONFIRMED (auto-approved, mode: yolo, option `proceed`): JSON-in-text always with the proposed Step schema (role/action/target/tool/args/sandbox/expectedResult/safetyFlags), the five repair passes, and MAX_STEP_REPAIRS = 3. Rationale: D-19 is one-way — the protocol, its prompts, its tests and every recorded ledger are shaped by it, so adopting native tool calling later needs a second protocol plus a replay migration. Confirming it before cyberProtocol.ts was written was the point of the checkpoint."
  - "MAX_STEP_REPAIRS is a named exported constant used by both the driver default and the incompatibility predicate; no magic 3 appears inline."
  - "The Step `safetyFlags` object requires maxDurationMs (positive) and rateLimit (zero or positive) and a denyList string array, so a step cannot reach a tool without a duration and rate bound."
  - "validateStep takes an optional `inScope` checker and returns code 'out-of-scope'; the driver passes it on every parse, so a model-emitted step aimed outside the engagement is invalid before any tool sees it (T-25-32)."
  - "The five repair passes strip comments only outside string literals — a step target is often a URL whose `//` must survive (a naive comment strip would truncate https:// targets)."
  - "The twelve regional statements carry `ownerReview: 'pending-owner-review'` as data rather than a prose note, so a release check can find every unreviewed statement; they are plain-language statements, not legal advice (D-14, discretion item)."
  - "publicSectorWarning returns `string | undefined`, deliberately not a decision union, so no branch can refuse a target (D-15)."
  - "needsReacceptance compares region, the scope fingerprint, extensionVersion, and textVersion — all four, because a stale acceptance must never be replayable (T-25-08)."

patterns-established:
  - "Protocol driver owns no I/O: a CompleteFn injection point is the only model seam, which keeps the agent-layer module runnable under plain node --test"
  - "Corrective retry appends the rejected reply as an assistant turn plus one user correction, so the model sees its own failure in the conversation"
  - "Per-role consecutive-failure counters: one role's incompatibility does not poison another's budget"

requirements-completed: [CYBER-03, CYBER-04]

coverage:
  - id: D1
    description: "A step JSON object is extracted from prose, from a ```json fence, or from broken JSON (trailing commas, single quotes, comments) and repaired into a validated Step"
    requirement: CYBER-04
    verification:
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#a step JSON object inside prose is parsed into a validated step"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#a fenced json block is parsed, and trailing commas with single quotes are repaired"
        status: pass
    human_judgment: false
  - id: D2
    description: "A reply with no JSON, or valid JSON with a missing or mistyped field, fails visibly with a typed ProtocolParseError carrying a code and reason"
    requirement: CYBER-04
    verification:
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#text with no JSON object fails with a typed parse error"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#valid JSON with a missing required field fails with a typed parse error"
        status: pass
    human_judgment: false
  - id: D3
    description: "After the repair bound a role reports a typed incompatibility; the corrective turn is visible, the bound is never exceeded, and nothing is thrown"
    requirement: CYBER-04
    verification:
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#three consecutive role failures mark the model incompatible, two do not"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocolDriver.test.js#after the repair bound the role reports a typed incompatibility instead of throwing"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocolDriver.test.js#a broken first reply is corrected, and the retry carries a corrective user turn"
        status: pass
    human_judgment: false
  - id: D4
    description: "A step aimed outside the engagement scope is rejected before any tool runs, and context compaction preserves every evidence hash"
    requirement: CYBER-04
    verification:
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#a step aimed outside the engagement scope is invalid before any tool sees it"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#compacting steps keeps the last N in full and preserves every evidence hash"
        status: pass
      - kind: unit
        ref: "dist/test/cyberProtocolDriver.test.js#an out-of-scope step is rejected before it is returned, and replay parses what the panel shows"
        status: pass
    human_judgment: false
  - id: D5
    description: "Four distinct role prompts, each demanding a single JSON object and listing the Step fields; the critic requires a reproduction command or captured evidence"
    requirement: CYBER-04
    verification:
      - kind: unit
        ref: "dist/test/cyberProtocol.test.js#the four role prompts are distinct and each demands a single JSON object"
        status: pass
    human_judgment: false
  - id: D6
    description: "All twelve regional statements exist, each naming its statute and the own-or-authorized confirmation, versioned and flagged for owner review"
    requirement: CYBER-03
    verification:
      - kind: unit
        ref: "dist/test/cyberLegal.test.js#all twelve regions ship a statement naming the statute and the own-or-authorized confirmation"
        status: pass
    human_judgment: false
  - id: D7
    description: "Region detection maps representative IANA zones and fails safe to us; re-acceptance flips on region, scope, extension version, or text version and stays false when nothing changed"
    requirement: CYBER-03
    verification:
      - kind: unit
        ref: "dist/test/cyberLegal.test.js#locale detection maps representative timezones and falls back to us"
        status: pass
      - kind: unit
        ref: "dist/test/cyberLegal.test.js#re-acceptance flips on region, scope, extension version, or text version, and stays false otherwise"
        status: pass
    human_judgment: false
  - id: D8
    description: "No mode starts without an accepted record; declining leaves the target and scope untouched; a nameless acceptor is refused; a stale acceptance is refused until re-accepted"
    requirement: CYBER-03
    verification:
      - kind: unit
        ref: "dist/test/cyberDisclaimer.test.js#an accepted complete record allows passive, active, and intrusive modes"
        status: pass
      - kind: unit
        ref: "dist/test/cyberDisclaimer.test.js#declining leaves the target and scope untouched and creates no run"
        status: pass
      - kind: unit
        ref: "dist/test/cyberDisclaimer.test.js#an acceptance with no legal name is refused"
        status: pass
      - kind: unit
        ref: "dist/test/cyberDisclaimer.test.js#an acceptance from a changed extension version is refused until it is re-accepted"
        status: pass
    human_judgment: false
  - id: D9
    description: "Public-sector, .mil, metadata, and carrier-grade NAT targets produce a warning string and are never refused"
    requirement: CYBER-03
    verification:
      - kind: unit
        ref: "dist/test/cyberLegal.test.js#public-sector and metadata targets are warned, never blocked"
        status: pass
    human_judgment: false
  - id: D10
    description: "The twelve regional statement texts are legally correct for their jurisdictions and acceptable to ship"
    requirement: CYBER-03
    verification: []
    human_judgment: true
    rationale: "The statements are plain-language, non-advice summaries authored from the research table and marked `pending-owner-review`; only the owner or a lawyer can confirm each jurisdiction's statute naming, wording, and fitness to ship. The plan and D-14 both make this an explicit owner-review gate rather than a testable fact."

duration: 17min
completed: 2026-11-02
status: complete
---

# Phase 25 Plan 02: Model protocol and legal gate Summary

**JSON-in-text Step protocol with five repair passes and a bounded three-reply failure, plus a twelve-region legal catalogue whose gate refuses every mode until an acceptance matches the region, scope, extension version, and statement text.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-11-02T00:23:35Z
- **Completed:** 2026-11-02T00:40:07Z
- **Tasks:** 3 (1 auto-approved decision, 2 implementation)
- **Files modified:** 7 created, 1064 lines added

## Accomplishments

- `src/domain/cyberProtocol.ts` defines the one `Step` schema all four roles share and turns an untrusted reply into a validated step: it strips a fence (or slices first `{` to last `}`), applies four further repair passes, and validates every field by hand — role, action, sandbox enums, a positive `maxDurationMs`, a zero-or-positive `rateLimit`, a `denyList` array — before returning. Failures are a typed `ProtocolParseError` with a code (`no-json`, `invalid-json`, `invalid-step`, `out-of-scope`).
- The scope checker is a first-class part of validation, not the driver's afterthought: `validateStep` takes `inScope`, so a model that emits `https://attacker.invalid/` gets an `out-of-scope` rejection before any tool sees the step.
- `compactSteps` keeps the last N steps verbatim and compresses older ones to id/action/target/result/reasoning summaries while copying every `evidenceHashes` entry forward — the hashes a report cites are the one thing compaction may never drop.
- `ROLE_PROMPTS` holds four genuinely distinct prompts (planner chooses, operator executes, critic judges, reporter writes), each demanding exactly one JSON object with the Step fields listed; the critic prompt requires a reproduction command or captured evidence.
- `src/domain/cyberLegal.ts` ships all twelve regions with statute, plain statement, a shared `textVersion`, and an `ownerReview: 'pending-owner-review'` flag. `detectRegion` maps exact zones first (London→uk, Tokyo→jp, Kolkata→in, São Paulo→br, Johannesburg→za, Singapore→sg, Dubai→ae, Auckland→nz) then prefixes, and falls back to `us`.
- `needsReacceptance` compares all four D-18 inputs against an `AcceptanceRecord` that carries a sorted, order-independent `scopeFingerprint`, so a reordered host list is not a change but an added exclusion is.
- `publicSectorWarning` returns `string | undefined` for `.gov`/`.mil`/`.gov.uk`/`.gov.au`/`.gov.in`, `169.254.169.254`, and 100.64.0.0/10 — the signature itself makes a refusal unrepresentable.
- `src/agent/cyberProtocolDriver.ts` wires the schema to a `CompleteFn` seam. `askRole` retries by appending the rejected reply as an assistant turn plus one user correction, returns `{kind:'steps'}` with the repair count on success, and returns `{kind:'incompatible', role, reason, attempts}` after `MAX_STEP_REPAIRS` — a renderable value, not an exception. Per-role failure counters keep one role's bad model from poisoning another's budget.

## Task Commits

Each task was committed atomically:

1. **Task 1: Confirm the D-19 JSON-in-text protocol shape (one-way)** — no code commit (checkpoint:decision, auto-approved under `mode: yolo`)
2. **Task 2: JSON step protocol** — `256490b` (feat) — RED test written first, watched fail (`Cannot find module '../domain/cyberProtocol'`), then implemented to green
3. **Task 3: Legal catalogue + disclaimer gate + protocol driver** — `d147384` (feat)

**Plan metadata:** docs commit (25-02 SUMMARY) — see git log

## Files Created/Modified

- `src/domain/cyberProtocol.ts` — Step schema types, `ProtocolParseError`, `MAX_STEP_REPAIRS`, `isModelIncompatible`, `repairJson`, `validateStep`, `parseStep`, `compactSteps`, `ProtocolStepRecord`, `ROLE_PROMPTS`
- `src/domain/cyberLegal.ts` — `RegionCode`, `REGION_CATALOGUE`, `REGION_CODES`, `regionEntry`, `LEGAL_NAME_PROMPT`, `detectRegion`, `DEFAULT_REGION`, `AcceptanceSnapshot`, `AcceptanceRecord`, `scopeFingerprint`, `needsReacceptance`, `publicSectorWarning`
- `src/agent/cyberProtocolDriver.ts` — `CompletionMessage`, `CompleteFn`, `DriverOptions`, `StepSuccess`, `IncompatibleResult`, `AskRoleResult`, `stepsFromText`, `CyberProtocolDriver`
- `src/test/cyberProtocol.test.ts` — 8 top-level node:test cases (prose extraction, fence+repair, no-JSON, missing field, compaction, incompatibility, scope rejection, role prompts)
- `src/test/cyberProtocolDriver.test.ts` — 4 cases against a scripted fake `complete()` (first-try success, corrective retry, bounded incompatibility, out-of-scope + replay)
- `src/test/cyberLegal.test.ts` — 6 cases (twelve-region catalogue, detection, re-acceptance, fingerprint, public-sector warning, unknown region)
- `src/test/cyberDisclaimer.test.ts` — 4 cases via the local `gateRun` helper (all three modes, decline leaves target untouched, nameless refusal, stale version refusal)

## Decisions Made

**Task 1 — checkpoint:decision, auto-approved under `mode: yolo` (option `proceed`).**

- **D-19 confirmed.** The proposed Step schema (role/action/target/tool/args/sandbox/expectedResult/safetyFlags), the five repair passes (strip ```json fences, first-`{` to last-`}`, comment stripping, single→double quote normalization, trailing-comma removal), and `MAX_STEP_REPAIRS = 3` were all adopted unchanged. Rationale, as the plan requires recording: **D-19 is one-way.** The protocol, its prompts, its tests and every recorded ledger entry are shaped by the JSON-in-text decision, so switching to native tool calling later means a second protocol plus a replay migration over existing ledgers. Confirming the shape before `cyberProtocol.ts` existed was the whole point of the checkpoint, so Task 2 did not start until this was recorded.
- **Repair pass order is deliberate.** Fences are stripped before slicing so a fenced block with prose around it yields the object; comments are stripped only outside string literals, because a naive `//` strip truncates every `https://` target; quotes are normalized before trailing commas so a repaired single-quoted object parses on the same pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a fifth test file not named in `files_modified`**

- **Found during:** Task 3
- **Issue:** The plan's acceptance criterion requires `grep -c "incompatible" src/agent/cyberProtocolDriver.ts` ≥ 2, proving the typed failure exists, but neither `cyberDisclaimer.test.ts` nor `cyberLegal.test.ts` exercises the driver at all — the incompatibility branch would have been grep-proven only, never executed. The plan's own must_have ("After 3 consecutive parse-repair failures for one role the protocol reports model-incompatible and the failure is a visible, typed result — never a silent fallthrough") is a behavioural truth, not a string count.
- **Fix:** Added `src/test/cyberProtocolDriver.test.ts` with four cases against a scripted fake `complete()`: first-try success at zero repairs, a corrective retry that asserts the corrective user turn is appended, the bounded incompatibility result with `attempts === MAX_STEP_REPAIRS + 1`, and an out-of-scope rejection plus `stepsFromText` replay.
- **Files modified:** `src/test/cyberProtocolDriver.test.ts` (new)
- **Verification:** the file passes 4/4 and is included in the plan-level verification run.
- **Committed in:** `d147384`

**2. [Rule 1 - Bug] Two test fixtures were incomplete, not the implementation**

- **Found during:** Task 2 (RED→GREEN)
- **Issue:** Two first-draft assertions in `src/test/cyberProtocol.test.ts` failed against correct code. The fenced-repair fixture omitted `rateLimit` and `denyList`, so `validateStep` correctly rejected it as an incomplete `safetyFlags`; and the compaction fixture built `ProtocolStepRecord` literals without the required `compacted` field, so it did not type-check.
- **Fix:** Completed both fixtures (`rateLimit: 0, denyList: []` and `compacted: false`) rather than loosening the validator. The requirement that a Step carry a full `safetyFlags` object is the point of the schema; the fixture was wrong.
- **Files modified:** `src/test/cyberProtocol.test.ts`
- **Verification:** `node --test dist/test/cyberProtocol.test.js` → 8 pass, 0 fail.
- **Committed in:** `256490b`

**3. [Rule 1 - Bug] The disclaimer test's `gateRun` compared the region against itself**

- **Found during:** Task 3
- **Issue:** The first `gateRun` helper derived the current region from the stored acceptance (`region: acceptance.region` in both branches of a ternary), which makes the D-18 region trigger untestable — it can never differ.
- **Fix:** `RunRequest` now carries the engagement's current `region` explicitly and `gateRun` passes `attempt.region` into `needsReacceptance`, so a region change is a real input. The region-flip assertion itself lives in `cyberLegal.test.ts#re-acceptance flips on region, ...` and the disclaimer file asserts the version and refusal paths.
- **Files modified:** `src/test/cyberDisclaimer.test.ts`
- **Verification:** both test files pass 10/10 combined.
- **Committed in:** `d147384`

---

**Total deviations:** 3 adapted (1 missing-critical test file for a behavioural must_have, 2 test-fixture/helper bugs found and fixed against correct code)
**Impact on plan:** No production code outside the plan's `files_modified` was introduced; no new dependency, no `vscode` import in domain or driver, and no change to `src/domain/cyber.ts`. The one added file is test-only and closes a gap between the plan's grep gate and its behavioural must_have.

## Issues Encountered

- The plan's `<action>` for `cyberLegal.ts` was complete, but its `detectRegion` mapping prose ("America/* -> us") is ambiguous for `America/Sao_Paulo`; the plan's own entry lists it under `br`, so the exact-zone table wins over the `America/` prefix. This is structural, not a deviation.
- `publicSectorWarning` accepts `Target | string` because the panel (25-07) will call it from a target picker that may hold either; the string form parses through `new URL` and returns `undefined` rather than throwing on a malformed value.

## User Setup Required

None - no external service configuration required. No network access: the driver takes an injected `complete()` and the tests pass a scripted fake.

## Verification Results

Every acceptance criterion and the plan-level verification, run verbatim:

| Gate | Command | Result |
|---|---|---|
| Protocol tests | `node --test dist/test/cyberProtocol.test.js` | 8 pass, 0 fail |
| Driver tests | `node --test dist/test/cyberProtocolDriver.test.js` | 4 pass, 0 fail |
| Legal + disclaimer | `node --test dist/test/cyberLegal.test.js dist/test/cyberDisclaimer.test.js` | 10 pass, 0 fail |
| Plan-level | `npx tsc -p tsconfig.json && node --test dist/test/cyberProtocol.test.js dist/test/cyberProtocolDriver.test.js dist/test/cyberLegal.test.js dist/test/cyberDisclaimer.test.js` | exit 0, 22 pass, 0 fail |
| Lint | `npm run lint` | exit 0, no output |
| 25-01 regression | `node --test dist/test/cyberTracer.test.js dist/test/cyberEngagement.test.js` | 8 pass, 0 fail |
| `grep -c "MAX_STEP_REPAIRS" src/domain/cyberProtocol.ts` | ≥ 2 | 2 |
| `grep -R -l "from 'vscode'" src/domain/cyberProtocol.ts` | nothing | exit 1, no output |
| `grep -R -l "zod" src/domain/cyberProtocol.ts` | nothing | exit 1, no output |
| `grep -c "reproduction" src/domain/cyberProtocol.ts` | ≥ 1 | 1 |
| `grep -c "'uk'\|'us'\|...\|'ae'" src/domain/cyberLegal.ts` | ≥ 12 | 31 |
| `grep -c "169.254.169.254" src/domain/cyberLegal.ts` | ≥ 1 | 1 |
| `grep -c "incompatible" src/agent/cyberProtocolDriver.ts` | ≥ 2 | 3 |
| `grep -R -l "from 'vscode'" src/domain/cyberLegal.ts src/agent/cyberProtocolDriver.ts` | nothing | exit 1, no output |
| `DisclaimerAcceptance` declarations in `src/domain/cyberLegal.ts` | zero (imported from `cyber.ts`) | zero — `import type { DisclaimerAcceptance } from './cyber'` |

## Next Phase Readiness

- Ready for **25-05**: `CyberProtocolDriver`'s `DriverOptions.complete` is `(model, messages, signal?) => Promise<string>`; the handoff supplies a closure over `NearAiClient.completeOnce(...)` that returns `.text`. `messages` is `CompletionMessage[]` (`role: 'system' | 'user' | 'assistant'`, `content: string`) — narrower than the client's `AgentMessage[]`, so the adapter may need to pass plain chat messages.
- Ready for **25-05**: `askRole` returns `StepSuccess | IncompatibleResult`; render `kind: 'incompatible'` as a visible panel state naming the role and reason. `driver.stepsFromText(text)` re-parses a recorded reply for replay without a model call.
- Ready for **25-07**: `REGION_CODES`/`REGION_CATALOGUE` drive the modal's region picker and body text; `detectRegion(Intl.DateTimeFormat().resolvedOptions().timeZone)` seeds it and the override must stay visible. `LEGAL_NAME_PROMPT` is the copy above the D-17 name field. `publicSectorWarning(target)` returns a red-flag string or `undefined` — never a block.
- Ready for **25-07**: `scopeFingerprint(resolvedScope)` is what the panel must store beside the acceptance to make `needsReacceptance` work; the `AcceptanceRecord` type (`DisclaimerAcceptance` + `scope`) is the shape the engagement should persist.
- **Owner review gate:** all twelve `REGION_CATALOGUE` entries are `ownerReview: 'pending-owner-review'`. They are plain-language statements, not legal advice, and must be reviewed before release (D-14, discretion item). A release check can grep for that value.
- **Concern for 25-05:** `askRole` returns at most the single step parsed from one reply; a model that emits several steps in one reply has them available via `stepsFromText` but not through `askRole`. If the run loop wants multi-step replies, it should call `stepsFromText` on the raw reply rather than changing `askRole`'s contract.

## Self-Check: PASSED

Re-ran every acceptance criterion and the plan-level verification after the final code commit: `npx tsc -p tsconfig.json` exits 0, the four plan test files pass 22/22, `npm run lint` exits 0, 25-01's two test files still pass 8/8, all seven acceptance greps return the required counts or empty output, and neither `src/domain/cyberProtocol.ts`, `src/domain/cyberLegal.ts` nor `src/agent/cyberProtocolDriver.ts` imports `vscode` or any new dependency. All seven created files exist and both task commits (`256490b`, `d147384`) are ancestors of HEAD.
