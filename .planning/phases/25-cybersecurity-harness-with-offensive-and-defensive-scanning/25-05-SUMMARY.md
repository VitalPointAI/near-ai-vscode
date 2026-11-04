---
phase: 25-cybersecurity-harness-with-offensive-and-defensive-scanning
plan: 05
subsystem: security
tags: [cybersecurity, run-engine, ledger, evidence, hash-chain, critic, host-tools, replay]

requires:
  - phase: 25-01
    provides: "createLedgerEntry/verifyChain/chainBreak, buildPtesReport, Engagement/EngagementRun/Finding, the engagement store"
  - phase: 25-02
    provides: "CyberProtocolDriver.askRole, parseStep, ROLE_PROMPTS, compactSteps, ProtocolStepRecord"
  - phase: 25-03
    provides: "TOOL_CATALOGUE, detectTool, installOffer, the built-in probes and their findings"
  - phase: 25-04
    provides: "decidePermission's IntrusiveStep, RunGrants.intrusiveEngagement, RateLimiter, checkBudget, the sandbox tiers"

provides:
  - "CyberLedgerStore: append-only JSONL per run, verify, breakAt, replay; a refusal is a new append, never an edit"
  - "CyberEvidenceStore: content-addressed blobs (SHA-256), hash path guard, re-hash on read, putAbsent for absence as evidence, prune that never touches the ledger"
  - "cyberCritic: verifyFinding (reproduction command or stored blob), reProbe bounded at 2 attempts, criticLabel that never renders unverified as clean"
  - "cyberRun: startCyberRun with the production checkAcceptance gate, four role calls, per-step decidePermission, scope-audited refusals, compaction, ledger-persisted findings, replayRun"
  - "cyberHostTools: HOST_TOOL_INVOCATION per-tool machine-readable argv, runHostTool with verbatim byte capture and absent-with-reason records, shellRunner"

affects: [25-06, 25-07, 25-08]

actuals:
  tokens: 38600
  tasks: 4
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Append-only store: fs.appendFile with the index and prevHash supplied by the store, so no caller can renumber a chain"
    - "Evidence is content-addressed and re-hashed on read, so a swapped blob is caught rather than trusted"
    - "Host-tool stdout bytes go to the store untouched; only the model-facing text is trimmed"
    - "Every run step is a ledger entry, including refusals, so a denied or out-of-scope step is auditable"
---

# Plan 25-05 — the run engine

## What landed

| Commit | Content |
|---|---|
| `595bee1` | `cyberLedgerStore.ts`, `cyberEvidenceStore.ts`, `cyberCritic.ts` + two test files |
| `de5c4f7` | `cyberRun.ts` four-role engine + `cyberRun.test.ts` |
| (final) | `cyberHostTools.ts` verbatim capture, wired into the run, `cyberHostTools.test.ts` |

## Requirements

- **CYBER-04** — four roles as separate model calls, through the JSON-in-text driver. `cyberRun.test.ts` asserts `driver.calls` is exactly `['planner', 'operator', 'critic', 'reporter']`, and an incompatible model yields `outcome: 'incompatible'` with a visible note and a still-verifying chain.
- **CYBER-05** — the critic verifies each finding against a reproduction command or a stored blob, and re-probes at most twice. Unverified findings are labelled, never silently trusted.
- **CYBER-11** — the ledger is append-only and tamper-evident (editing one character of one line fails verification), and `replayRun` re-renders findings from the chain with no tool invocation and no network import in the store.
- **D-27 evidence kind 2** — a detected host tool's stdout is stored byte-for-byte with its SHA-256 on the ledger entry, and an absent tool produces a named record carrying its install command.

## Decisions worth recording

**The operator and critic are real model calls, not just deterministic steps.** The first version executed the planner's steps directly and ran the critic as a pure function, which satisfied the behaviour but not D-20's "four roles, four calls". Both are now role calls; the deterministic work (permission, scope, verification) still happens around them, so a model that mangles the operator reply falls back to the planner's step rather than failing the run.

**Findings come from the tool's collector, not from parsing its text.** `RunTool.findings()` drains whatever the probe reported through `onFindings`; text extraction remains only as a fallback for tools without a collector. This keeps the run honest: the finding's `evidenceHash` is the blob the run actually stored.

**Absence is stored, not skipped.** `putAbsent` serialises a canonical `{installCommand, kind, reason, tool}` record through the same hashing path, so "nuclei is not installed" is a hash-chained fact rather than a gap in the evidence.

## Deviations from the plan

**1. [Rule 2 — missing critical functionality] `RunTool` gained `findings()` and `RunInput` gained `toolContext`, `hostTools`, `signal` is threaded.**
The plan's tool list had no way to carry a probe's structured findings into the run, and the run needs a `ToolContext` to execute any tool at all. Both are additive optional fields; a caller that supplies neither still runs (findings fall back to text extraction).

**2. [Rule 1 — bug] `onEvidence` in `reProbe` was skipped when the attempt already carried a hash.**
Each re-probe attempt must be recorded, or the chain covers only the upgraded finding and not the attempt that produced it. It now always runs.

**3. [Rule 3 — blocking] `checkAcceptance` recomputes the scope fingerprint from the engagement rather than trusting a stored one.**
`needsReacceptance` compares a stored `scope` string; the engagement's own `resolvedScope` is the source of truth at run start, so the gate fingerprints that. A stored acceptance whose scope drifted still fails, because the region/version/text comparisons run against the same snapshot.

**4. [Rule 1 — bug] `scopeIncludes` treats a non-listed port as out of scope.**
`urlInScope` in the domain returns true when a scope names no ports; the run's own check does the same, so a URL target resolved to port 443 is not refused for a scope that lists 443. A URL on 8443 against a 443-only scope is refused, which is the behaviour the scope-audited refusal test asserts.

## Verification

| Gate | Command | Result |
|---|---|---|
| Lint / typecheck | `npm run lint` | exit 0 |
| Plan tests | `node --test dist/test/cyber{ledger,critic,run,hostTools}.test.js` | 31 pass, 0 fail |
| Full suite | `npm run compile && node --test dist/test/*.test.js` | 715 tests, 707 pass, 0 fail, 8 skipped |

Acceptance greps:

| Criterion | Required | Actual |
|---|---|---|
| `askRole` in `cyberRun.ts` | ≥ 3 | 6 |
| `checkAcceptance` | ≥ 2 | 2 |
| `compactSteps` | ≥ 1 | 2 |
| `decidePermission` | ≥ 1 | 2 |
| `tool_calls`/`toolCalls` in `cyberRun.ts` | 0 | 0 |
| `incompatible` | ≥ 2 | 9 |
| `redactSecrets` | ≥ 1 | 5 |
| `evidenceHash` in `cyberRun.ts` | ≥ 2 | 17 |
| `appendFile` in the ledger store | ≥ 1 | 3 |
| `fetch`/`net.connect`/`tls.connect` in the ledger store | 0 | 0 |
| hash path guard | ≥ 1 | 1 |
| `putAbsent` in the ledger store | ≥ 2 | 1 (see below) |
| `REPROBE_ATTEMPTS` | ≥ 2 | 4 |
| `putAbsent`/`evidenceHash`/`installCommand` in host tools | ≥ 1 each | 1 / 5 / 4 |
| tool names in the invocation table | ≥ 4 | 5 |
| `provenance` | ≥ 2 | 4 |
| `from 'vscode'` imports | none | none |

**One gate is short of its stated number: `putAbsent` appears once in `cyberLedgerStore.ts`, where the plan asked for at least two.** The definition and the routing through `put` are the same call (`putAbsent` calls `this.put`), so the count is 1 rather than 2. The behaviour the criterion exists for — absence stored through the hashing path — is proven by the `absence is stored as a named, hash-chained record` test.

## Issues encountered

- `npm run compile` (not bare `tsc`) is required before a full test run; `scripts/vendor-libs.mjs` populates `vendor/pdfjs`, without which eight document/graphics tests fail. Worth stating in 25-08's release checklist.

## Next phase readiness

- **For 25-06:** `startCyberRun` takes `tools: RunTool[]` where a shell-capability entry is gated exactly like `CyberExploitTool`; pass `cyberExploitTools(...)` entries with `capability: 'shell'` and the run's `policy`/`grants`. `budget` and `limiter` are consulted before each step, and a budget stop records the `BudgetShortfall` names in the ledger.
- **For 25-07 (panel):** `onEvent` carries `step-started`/`step-finished`/`finding`/`notice`/`incompatible`/`done`; `requestApproval` is the one approval seam to bind to the chat card. `checkAcceptance` is the production gate the panel must show as a refusal, not a warning.
- **For 25-07 (report/export):** `replayRun(runId, ledger)` returns `{steps, findings, chainOk, chainBreak?}` — build exports from that, not from a second execution.

## Self-check: PASSED (with one numeric gate deviation noted)

Both plan test files pass (31/31), `npm run lint` exits 0, the full suite is 707 pass / 0 fail, all `from 'vscode'` gates are empty, and no dependency was added. The single shortfall is the `putAbsent` count of 1 vs the plan's ≥ 2 in `cyberLedgerStore.ts`; the definition and its single call site are correct and the behaviour is tested.
