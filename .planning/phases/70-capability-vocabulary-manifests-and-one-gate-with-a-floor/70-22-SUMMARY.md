---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 22
pr: 4c
subsystem: gate (session mark)
status: complete
tags: [gate, labels, session-mark, CLAS-04, CLAS-01, CLAS-06, GATE-07, D-26, D-29, D-54, D-60]
requires: ["70-28b (PR #85, open)"]
provides:
  - "src/domain/gate/dominance.ts: SessionMark (current, raise, lowerByPerson, onDidChange), sameMark"
  - "src/agent/permissions.ts: RunGrants.mark, RunGrants.outbound"
  - "src/agent/gateAdapter.ts: GatedCall.readLabels, .maySend, .mark; maySendOffMachine; NETWORK_AT_MARK_TEXT; markVerdictFor; markTierOf; markAboveDefault; raiseRunMark; recordMarkRaised"
  - "src/agent/gateLabels.ts: labelCheckFor, labelsOfPaths, projectLabelOf, scalesOf"
  - "src/agent/outboundCheck.ts: OutboundFingerprints, outboundPayload, OUTBOUND_MATCH_TEXT, OUTBOUND_UNREADABLE_TEXT, OUTBOUND_LIMITS_TEXT (D-60)"
  - "ToolContext.noteRead (Glob, Grep)"
  - "LabelSource.queueRaise / flushRaises, LabelReader.queueRaise / flushRaises, RAISE_WRITE_DELAY_MS; GateHost.writeRaises, signAgainForRaises, raisedEntryLabel, LABEL_RAISE_REFUSED_TEXT; gateCommands.labelRaiseRefused"
  - "rule id label.outbound-match on GATE_RULE_IDS"
affects: [70-23, 70-24, 70-28c]
tech-stack:
  added: []
  patterns: ["one hook, one carrier, one predicate (D-54)", "caller-side verdicts, decide() pure", "fingerprints with no getter and a placeholder toJSON"]
key-files:
  created: [src/agent/outboundCheck.ts, src/test/gateMark.test.ts, src/test/gateOutbound.test.ts, src/test/helpers/markFixtures.ts]
  modified: [src/domain/gate/dominance.ts, src/domain/gate/decide.ts, src/domain/gate/labelMap.ts, src/agent/permissions.ts, src/agent/loop.ts, src/agent/gateAdapter.ts, src/agent/gateLabels.ts, src/agent/tools.ts, src/services/agentSession.ts, src/benchmark/runner.ts, src/services/cyberRun.ts, src/services/cyberAssembly.ts, src/gate/labelMapStore.ts, src/gate/host.ts, src/gate/sessionMark.ts, src/services/gateCommands.ts, SECURITY.md, src/test/gateDecide.test.ts, src/test/gateRouteGuard.test.ts, src/test/gateDocs.test.ts]
decisions:
  - "D-60 (owner) recorded in 70-CONTEXT.md and built as plan 22 Task 4"
  - "A mark always holds at least the project's resolved label (never empty), so 'rose' is a plain comparison"
  - "A label map entry holds one label: a write takes the mark's label whose routing tier is strictest, the file's own scale winning a tie"
  - "Shell writes are seen from the command's text (redirects, cp, mv, install, tee), the same parse the scratch check uses; the classifier tags no write paths"
metrics:
  completed: 2026-11-17
  tasks: 4
estimate:
  tokens: 88046
actuals:
  tokens: 38000
  tasks: 4
  commits: 4
plan_head_before: d5e1348cf3a8d4abdfad86529bcf3808fc9b0709
plan_head_after: a40fa352
pr4c_base: d5e1348cf3a8d4abdfad86529bcf3808fc9b0709
---

# Phase 70 Plan 22: The session mark Summary

What any agent of a chat reads now raises the chat's mark at the loop's one hook (before the call runs, so a failed read counts), sub-agents share it, the chat's session routes read it so the next model request follows it, calls that may send data off this computer are refused at strict marks by the credential hold's own predicate, labelled text cannot leave in a network call's payload at Internal and Confidential (D-60), and files a labelled chat writes take its label.

PR4C_BASE: `d5e1348c` (the tip of `feat/gate-labels`, PR #85, open). Commits (plan 22 only): `7eab31b1` (D-60 plan amendment), `bb3e9f39` (Tasks 1 and 2), `24203902` (Task 3), `a40fa352` (Task 4). The PR #85 carry-overs `06d4e9bd`, `3c94b377`, `d3ff0894` sit between them and are not part of this plan.

## What was built

- **Tasks 1 and 2 (`bb3e9f39`).** `SessionMark` in the pure domain. `RunGrants.mark` and `.outbound`, shared with every sub-agent. `labelCheckFor` gives the label verdict and the labels of every path a call names (globs and an unbounded glob included); `GatedCall.readLabels` carries them to the loop, which raises the mark at the credential-read hook and records `label.mark-raised` with the whole mark only when it rose. Glob and Grep raise it by the paths they return (`ToolContext.noteRead`). `maySendOffMachine` is the one fail-closed predicate the credential hold and the new `label.network-at-mark` verdict share (a dominance verdict wins). Tool records carry `mark` while it is above the default label. `AgentConversation` keeps one mark per chat, made at the project's resolved label on the first run and raised by it on every later run; its routes read it. `runAgentInFolder` and cyber runs get a mark of their own at the project's label; a cyber step raises it through the same `raiseRunMark`.
- **Task 3 (`24203902`).** Writes take the mark: Write, Edit and graphics outputs (their `workspaceWrite` effects) and the targets a shell command's text shows queue a raise of the file's entry; the reader writes one signed batch at most every 3 seconds and at the run's end (the chat flushes in the run's `finally`). Nothing is queued at the default mark. An unverified or held map is never signed automatically: nothing is written, the raises are kept, the person is told once with Sign Again, which signs the file keeping only raises and then writes them.
- **Task 4, D-60 (`a40fa352`).** `OutboundFingerprints` (8-word shingle hashes of normalised text, short texts of 3 to 7 words whole, bounded at 200,000, no getter, `toJSON` gives a placeholder). The loop fingerprints the output of a call whose read labels need a tier other than any-cloud (never a sending call's output). At a mark that is attested-cloud, a call that may send is refused with `label.outbound-match` when any string of its arguments (and its URL-decoded form) or its command text carries a window; unreadable arguments or a full set count as a match. The refusal record names the tool and the label only. SECURITY.md carries `OUTBOUND_LIMITS_TEXT`, pinned by gateDocs.

## Red first

Each task's tests were run with the production change disabled in place, then restored: Tasks 1 and 2, 11 of 14 failing (raise, route, network verdict, run-local marks); Task 3, 4 of 19 failing (queueRaise switched off); Task 4, 3 of 7 failing (outbound verdict switched off) and the gateDocs pin failing with the SECURITY.md bullet removed.

## Tests

- `gateMark.test.ts`: 19 tests (tracer; sub-agents; Grep and Glob; shell and the variable gap; a failed read still raises; 44 sending forms refused at org/Restricted in all four modes and with nobody here, 16 local forms not; any-cloud parity; one predicate; own-level reads record nothing; cross-scale; SessionMark rules; a new chat at the project label; runAgentInFolder refused; cyber step; write inheritance, batching, at-or-above, unverified with Sign Again, cp and tee).
- `gateOutbound.test.ts`: 7 tests. `gateDocs`: 1 test added.
- Verify sets passed inside the cap: Tasks 1 and 2 set (gateMark, gateRouteGuard, agentLoop, gateCredentialReadHold, agentTools, untrusted, gateDecide, benchmarkRunner, cyberRun, cyberAssembly, gateLabelReads, gateRecordIds, gateCyberStep): 166 tests, 0 fail. Task 3 set (with gateLabelStore, gateFloorRuns, conversations): 122, 0 fail. Task 4 set: 72, 0 fail.

## Existing tests changed (intended)

- `gateDecide.test.ts`, "GATE_RULE_IDS lists every rule id once": `label.outbound-match` added to the list it checks, and the label rule count went from 3 to 4 (the owner's new id, D-60).
- `gateRouteGuard.test.ts`, "a main run and its sub-agent each request inside their own route": the last assertion said the mark is `[]` "until plan 22 gives a chat its mark"; it now says the chat starts at the project's resolved label, `['org/Public']`.
- gateCredentialReadHold, agentTools, untrusted, gateLabelStore, gateFloorRuns, agentLoop: unchanged and passing.

## Deviations from Plan

1. **[Rule 2] The mark is never empty.** The chat's mark is made at the project's resolved label when its first run starts (the conversation has no gate before that), so `raise` reports a rise by plain comparison and reading at the mark's level records nothing. Hence the gateRouteGuard change above.
2. **[Rule 3] `raise(labels, scales)`**, not `raise(markOrLabels, source)`: the join needs the policy's scales; the source goes to `raiseRunMark` and the record.
3. **[Rule 3] Shell writes come from the command's text.** The classifier tags no write paths (`cp a b` gives only a `shell` effect), so the loop reads the write targets with the parse the scratch check already used (now `commandWriteTargets`), keeping only project files changed since the command started.
4. **[Rule 2] One label per entry.** A map entry holds one label, so a multi-scale mark writes the label whose routing tier is strictest; another scale replaces the file's own only when it is stricter (`raisedEntryLabel`).
5. **Sending forms copied, not imported.** gateCredentialReadHold's lists are not exported (importing a test file would run its tests), so gateMark keeps its own copy of the forms plus `git push`, `curl https://example.org` and an unreadable command, and a test that both verdicts read `maySendOffMachine`.
6. **[Rule 2, D-60] The outbound refusal names the tool, not the command or URL**, since those carry the matched text.
7. **D-60 placement.** The SECURITY.md text is a bullet in the policy section for now; plan 24 places it in the new section.
8. **Graphics outputs** are covered by the same `workspaceWrite` effect path as Write and Edit; no separate graphics test.

## Known limits (documented, tested)

- A read or write a command's text does not show (a path in a variable) is not seen (gateMark pins the read gap).
- The outbound check does not catch a paraphrase, an encoding, or a program that sends the content itself (gateOutbound pins the paraphrase; SECURITY.md says all three).

## Threat Flags

None beyond the plan's register and T-70-140 (D-60).

## Self-Check: PASSED

Files exist (`src/agent/outboundCheck.ts`, `src/test/gateMark.test.ts`, `src/test/gateOutbound.test.ts`, `src/test/helpers/markFixtures.ts`); commits `7eab31b1`, `bb3e9f39`, `24203902`, `a40fa352` are ancestors of HEAD.
