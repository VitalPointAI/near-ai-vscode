---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 14
subsystem: gate
tags: [gate, status-bar, show-policy, reset-policy, setup-step, security-docs, docs-parity]

requires:
  - phase: 70-13
    provides: "every run path through a gate with a recorded decision; GateHost.reset() with no command"
  - phase: 70-12
    provides: "registerGate, GateHost (state, bundleState, onDidChange, reset, flush)"
  - phase: 70-11
    provides: "resetPolicyToDefaults (old file kept beside the new one), BundleStoreError, DecisionLog"
  - phase: 70-10
    provides: "MCP manifests, MANIFEST_IS_A_CLAIM_TEXT, RUNS_ON_THIS_MACHINE_TEXT"
provides:
  - "src/services/gateStatusBar.ts: gateStatusText, policyProblem, expiryDate, createGateStatusBar (item nearAi.gate, priority 49)"
  - "src/services/gateCommands.ts: nearAi.policy.show, nearAi.policy.reset, policyDocumentText, POLICY_LABELS_NOT_USED_TEXT, resetPolicy, POLICY_SETUP_STEP, policySetupStep"
  - "package.json: the two NEAR AI commands (Show Policy, Reset Policy to Defaults)"
  - "SECURITY.md section 'Your policy file and decision records' and updated MCP sections in SECURITY.md and README, with a README 'Your policy' bullet"
  - "src/test/gateCommands.test.ts (17 tests), src/test/gateDocs.test.ts (9 tests)"
affects: [70-15, 70-17, 70-21, 70-24]

actuals:
  tokens: 14200
  tasks: 3
  commits: 3
plan_head_before: e8c5f8353036b239e6776ef5817676c5d11d25fd
plan_head_after: 48a0d515e2e95718a3fc4c7f41e78e3ac0a57e6d

tech-stack:
  added: []
  patterns:
    - "Status words are one pure function over the bundle state and a clock (gateStatusText); the item and the setup step both read the same policyProblem sentence, so the two can never disagree"
    - "Show Policy is a TextDocumentContentProvider on the near-ai-policy scheme: the text is computed on open and nothing is ever written"
    - "Each policy surface (status bar, view, reset command, setup step) is set up on its own inside registerGate, so one that fails to register never stops activation or the gate"

key-files:
  created:
    - src/services/gateStatusBar.ts
    - src/test/gateCommands.test.ts
    - src/test/gateDocs.test.ts
  modified:
    - src/services/gateCommands.ts
    - package.json
    - SECURITY.md
    - README.md
    - src/test/helpers/vscodeStub.ts

key-decisions:
  - "A state that says valid but whose end has passed at the clock reads as expired in the status bar, the view and the setup step (policyProblem), the same as the host's own bundleState() does for decisions"
  - "A failed policy's view shows the bundle's sentence and 'only reading and planning', and no policy JSON; a valid policy's view puts POLICY_LABELS_NOT_USED_TEXT above the Scales, Clearances and Routing sections and the stored JSON after them"
  - "The Pitfall 14 sentence about unlabelled content is not written anywhere (a test checks the view never says 'unlabelled'); plan 21 adds it with live clearance checks"
  - "Reset Policy to Defaults: one confirm button 'Reset Policy' in a modal; a store error shows its own plain message, any other error shows a generic 'Nothing was changed' message"
  - "The Policy step is appended to the end of SETUP_STEPS with registerSetupStep; its detail is a getter so the menu shows the current sentence each time it opens"

patterns-established:
  - "Docs parity: gateDocs imports the code's constants and reads command names from package.json (category + title), so a changed string fails the test in the same PR"

requirements-completed: [OFFL-02, OFFL-03]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 14: The policy in the status bar, Show Policy, a confirmed Reset Policy to Defaults, a setup step and the docs Summary

**The person now sees the policy state at a glance (Policy, Policy: renewing, or Policy: reading only with the bundle's own cause-and-fix sentence and a warning background), can read the whole policy read-only, has one confirmed and recorded way to fix a failed policy, and SECURITY.md and README say exactly what the code does, kept in step by a test.**

## Performance

- **Tasks:** 3 of 3 (Task 1 tracer, Tasks 2 and 3 auto)
- **Files:** 3 created, 5 modified (about 56 KB of diff over the three commits)
- **Tracer gate:** the Task 1 verify command was green end to end before Task 2 started (auto-continue)

## Accomplishments

- `gateStatusText(state, now)` is pure and returns `{ text, tooltip, warning }`: "Policy" with "Your policy is signed and valid until <date>." for a valid policy, "Policy: renewing" in its last 30 days, "Policy: reading only" with the bundle's sentence and the warning background for every `BUNDLE_FAILURES` reason, and "Policy: checking" before the start has finished. `createGateStatusBar` makes the `nearAi.gate` item (Left, priority 49, command `nearAi.policy.show`); `registerGate` updates it on the host's `onDidChange`.
- `nearAi.policy.show` opens a read-only `near-ai-policy:` document: state, expiry, issuer fingerprint, bundle hash, the ceiling, `POLICY_LABELS_NOT_USED_TEXT`, then Scales (with `SCALE_PRESETS_CAVEAT_TEXT`), Clearances (with `CLEARANCE_SELF_ASSERTED_TEXT`), Routing tiers, the reserved fields and the stored JSON. A test shows the policy file and its folder are byte-identical after opening it.
- `nearAi.policy.reset` asks in a modal (the plan's plain words), then `host.reset()`: the old file is kept beside the new one, `policy.reset` is recorded in the open project's log, and the status bar and Policy step follow. Cancel changes nothing (bytes, folder listing and records all checked). A failure shows the store's plain message.
- The Policy step (`id: 'policy'`, "Check your policy", icon `shield`, command `nearAi.policy.show`) is added through `registerSetupStep`; `SETUP_STEPS` and `setupSteps.ts` are untouched. It is done when the policy is valid and its detail is the status bar's sentence when it is not.
- SECURITY.md has the new section (quoted below) and updated MCP text; README has a "Your policy" bullet and the MCP changes. `gateDocs` checks the exact strings.

## Task Commits

1. **Task 1 (tracer): the policy state in the status bar and a read-only Show Policy** - `e8ace38` (feat)
2. **Task 2: reset the policy to defaults, confirmed and recorded, and a setup step** - `9a588e5` (feat)
3. **Task 3: the policy file and decision records in SECURITY.md and README** - `48a0d51` (docs)

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Every run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Task 1 plan command (`npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateCommands.test.js dist/test/teamManifest.test.js dist/test/setupSteps.test.js`, plus gateActivation): tsc clean; 43 tests, 43 pass, 0 fail, 0 cancelled.
- Task 2 plan command (gateCommands, setupSteps, gateBundleStore, plus gateActivation): 73 tests, 73 pass, 0 fail, 0 cancelled.
- Task 3 plan command (gateDocs, gateCommands): 26 tests, 26 pass, 0 fail, 0 cancelled.
- Final run (gateCommands, gateDocs, setupSteps, teamManifest, gateBundleStore, gateActivation): tsc clean; 90 tests, 90 pass, 0 fail, 0 cancelled.
- Wider batches: the other test files that read SECURITY.md or README or use the vscode stub (agentTools, commandSafety, cyberDefensive, parallelTools, protectedPaths, relayIsolation, worktreeIsolation, untrusted, auto-review, secret-scan, gateEnumeration, gateOffline, teamCommands, teamSession): 198 tests, 196 pass, 0 fail, 0 cancelled, 2 skipped (existing); and 29 compiled test files matching package, manifest, command, palette, activation, extension, docs, plain, dash, boundary, setup, gate, onboarding, menu: 470 tests, 470 pass. The full `npm test` is not run here (PR boundary); e2e not run (the plan does not call for it).
- Acceptance: `node -e` reading package.json finds `nearAi.policy.show` with title `Show Policy`, category `NEAR AI` (and `nearAi.policy.reset`, `Reset Policy to Defaults`, `NEAR AI`). `grep -c "Your policy file and decision records" SECURITY.md` prints 1 (baseline 0). `git diff cbe4ef3 -- src/services/setupSteps.ts` is empty. gateDocs imports `CLEARANCE_SELF_ASSERTED_TEXT` and does not repeat it as a literal.

## The new SECURITY.md section in full

### Your policy file and decision records

Before a tool runs, NEAR AI checks the call against a signed policy file. This
is what that file and the records beside it do in this version.

- **Where it lives.** The policy file is kept in this extension's own storage
  on this computer, never in your project. It is not committed, synced or
  shared with the people you work with.
- **Who signs it.** Your own device key, held on this computer, signs it. A
  fresh install signs a default policy that allows what your settings allow, so
  nothing changes until a policy narrows it. Your settings can narrow what the
  policy allows and can never widen it.
- **When it cannot be trusted.** If the file is missing, unsigned, changed or
  expired, only reading and planning run until you run **NEAR AI: Reset Policy
  to Defaults**, and the project's key folder stays off limits in every case.
  The status bar says "Policy: reading only" with one sentence naming the cause
  and the fix. Deleting the file does not reset a policy: a file that has gone
  missing counts as a changed one. Only that command re-signs a policy that
  failed. It asks you to confirm, keeps the old file beside the new one, and
  records the reset.
- **Reading it.** **NEAR AI: Show Policy** opens the policy in plain words and
  as stored. The view is read only, and editing it changes nothing.
- **No network.** Nothing in a decision needs the network, so the policy
  works the same offline.
- **Decision records.** Each decision, allowed, asked or refused, is written
  to a record for the project in this extension's storage. A record names what
  was asked for, what was decided and why, never file contents, and secrets are
  removed from it. Records are not synced and are not put in your project, in
  the chat history or in the project's synced state. Each project's log rolls
  over at about 5 MB and keeps the last four older files.
- **What this version does not use yet.** The file also holds scales,
  clearances and routing tiers. This version stores and shows them and does not
  use them yet.
- **Your clearance is your own word.** Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary.

The MCP sections gained: servers added from this version on start with every tool undeclared (an undeclared tool asks in every mode except `fully-autonomous`, a tool the server marks as changing data still asks in every mode, and it runs only while you are there; servers added before behave as they did); the "What it does" menu on the MCP page; a local server runs on this machine with your permissions; and `MANIFEST_IS_A_CLAIM_TEXT` word for word.

## Deviations from Plan

**1. [Rule 3 - Blocking] `src/test/helpers/vscodeStub.ts` extended (not in the plan's file list).** The stub had no `Uri`, `EventEmitter`, `registerTextDocumentContentProvider`, `openTextDocument` or `showTextDocument`, and its status bar record had no id, name or priority, so neither the Show Policy view nor the `nearAi.gate` id could be tested. All additions are new members (`shownDocuments`, `contentProviders`, `id`, `name`, `priority`); no existing behaviour changed and no existing assertion needed an edit. Committed with Task 1.

**2. `POLICY_SETUP_STEP` is the step's fixed words, with `policySetupStep(host)` building the `SetupStep`.** A `SetupStep` needs the host's state to answer `isDone` and `detail`, so a module-level constant could not be one. `POLICY_SETUP_STEP` is a frozen `{ id, label, icon, command }` and `policySetupStep(host)` adds `isDone` and a `detail` getter. Behaviour is as the plan states.

**3. [Rule 2 - Missing critical] README MCP section also carries `MANIFEST_IS_A_CLAIM_TEXT`,** and the `Policy: checking` state exists, because the host is not started the instant the bar is created and an unstarted host reads as failed closed (it would have flashed a false warning).

**4. Show Policy has the icon `$(shield)`** in package.json (the plan names title and category only).

**5. Task 1 and Task 2 were split by hand.** I wrote `gateCommands.ts` in one pass, then committed Task 1 with the reset command, the setup step and the reset contribution removed and restored them for Task 2, so each commit contains only its own task.

**Total deviations:** 5 (1 blocking fixture, 1 shape note, 1 missing-critical, 2 notes). **Impact:** none on behaviour outside the new surfaces.

## Assertions changed on purpose

None. No existing test was edited.

## Carry-forwards honoured

- `GateHost.reset()` is now behind `nearAi.policy.reset`; a source scan in `gateCommands.test.ts` asserts the confirmed command is the only caller of `host.reset()` and that `resetPolicyToDefaults` is reached only from `bundleStore.ts` and `host.ts` (the prohibition on any other re-sign path).
- `manifest.effects-unknown`: this plan adds no decision path, so the invariant is unchanged.
- No em-dash and no "NEAR organization" in any new string or doc; a test checks the new SECURITY.md and README sections and the command titles.

## Decisions Made

See key-decisions. Left open or for later plans:

- **The status bar only refreshes on a host change** (start, reset) and when Show Policy is opened. A policy that expires while the window stays open is refused by every decision at once (the host re-checks the expiry), but the item keeps reading "Policy" until the next refresh. A timer was not added; plan 15 or a later plan can add a refresh on window focus if wanted.
- **The Policy step is appended to the end of the setup list.** The plan gave no position.
- Plan 17 changes the floor text, the Known limitations row about `fully-autonomous` and the MCP "every mode except `fully-autonomous`" wording with the code; plan 21 adds the Pitfall 14 sentence to the view and removes `POLICY_LABELS_NOT_USED_TEXT` when labels are live; plan 24 replaces the "does not use them yet" sentences. gateDocs asserts the floor text and the fully-autonomous row are unchanged now, so plan 17 must update those assertions with the text.
- Folder-path coverage in gate path matching (70-08) is still open, as in 70-12 and 70-13.

## Issues Encountered

A test regex of mine did not match compiled output (`(0, bundleStore_1.resetPolicyToDefaults)(`); fixed in the test. No product issue.

## Known Stubs

None.

## Threat Flags

None new. T-70-43 (editing the policy through the view): a read-only virtual document, tested to leave the file and its folder byte-identical. T-70-44 (a reset nobody can trace): a modal, the old file kept beside the new one, a `policy.reset` record, cancel tested to change nothing. T-70-45 (docs claiming more than the code does): `gateDocs` checks the exact constants and the code's numbers. T-70-SC: no package added.

## Next Phase Readiness

Plan 15 can rely on the two commands, the status bar item and the Policy step being registered by `registerGate` (each in its own guarded block), and on `gateDocs` keeping SECURITY.md and README in step with the code.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/services/gateStatusBar.ts, src/services/gateCommands.ts, src/test/gateCommands.test.ts, src/test/gateDocs.test.ts, SECURITY.md, README.md
- FOUND commits (ancestors of HEAD): e8ace38, 9a588e5, 48a0d51
