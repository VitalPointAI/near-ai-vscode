---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 26
pr: 4e
subsystem: gate (trust badge)
status: complete
tags: [CLAS-08, OFFL-01, D-51, D-56, PR-4e]
requires: ["70-28d"]
provides: ["trustBadgeFor and the three states", "the badge on the page (media/chat/trustBadge.js)", "the automatic check with its 20-second timeout", "Check again and Show full attestation"]
affects: [70-27, 70-28e]
tech-stack:
  added: []
  patterns: ["one pure function chooses the state from checks that ran; an exhaustive test shows a worse input never makes it stronger", "every badge post names its own run id"]
key-files:
  created: [src/domain/gate/trustBadge.ts, media/chat/trustBadge.js, src/services/trustDetails.ts, src/test/gateTrustBadge.test.ts]
  modified: [src/services/agentSession.ts, src/services/nearAiClient.ts, src/services/attestation.ts, src/gate/sessionMark.ts, src/services/chat.ts, src/services/chatBridge.ts, src/services/panelView.ts, media/chat/chat.js, media/chat/chat.css, src/test/helpers/chatPage.ts, src/test/helpers/fakeDom.ts, src/test/helpers/vscodeStub.ts, src/test/attestation.test.ts, src/test/gateChatLabel.test.ts, src/test/gateRouteTiers.test.ts]
decisions:
  - "Verified private model needs the request to have gone over the connection pinned to a fresh bound fact (usage.connectionPinned), not only a bound fact on the usage: at any-cloud the request is not pinned, so its answer is at best Model verified, connection not proven"
  - "A failed badge check of an answer the route did not check (any-cloud) sets no stop, but every later badge of the chat is Not verified until Check again on that answer passes"
  - "Show full attestation opens an untitled JSON document and marks the tab read-only for the session where VS Code supports it"
metrics:
  completed: 2026-11-18
  tasks: 3
estimate:
  tokens: 92048
actuals:
  tokens: 35200
  tasks: 3
  commits: 3
plan_head_before: 0333533cf7dba39ed1e96d4019313fe3e3be4541
rebased_onto: 0f1938fe03f9a07de9496bed960bc41a5981e350
plan_head_after: aec4129a1626b38f55f1730d56c72d6b3c7ed48d
---

# Phase 70 Plan 26: The trust badge Summary

Every lead-agent answer that came through a cloud client now shows a trust badge with one of the owner's three states (Verified private model; Model verified, connection not proven; Not verified), chosen by one pure function from the checks that actually ran, checked once in the background, settled after 20 seconds even offline, and clickable for a plain explanation, Check again and the full attestation.

PR4E_BASE: `0333533cf7dba39ed1e96d4019313fe3e3be4541` (origin/main with PR 4d merged as #89, `542cc54b`, and #90 and #91 after it). Branch `feat/gate-trust-badge`, started from that commit. Plan 70-28e rebased it onto `origin/main` at `0f1938fe` (#92 and release 0.4.32, #93, landed meanwhile); the hashes below are after that rebase.

## What was built

**Task 1 (`dca96bd3`), tracer.** `src/domain/gate/trustBadge.ts`: `TRUST_BADGE_STATES`, `TRUST_BADGE_TITLES`, `TRUST_BADGE_TEXT`, `BADGE_CHECK_TIMEOUT_MS` (20 s), `TrustBadgeFacts`, `TrustBadge`, `trustBadgeFor`, `trustBadgeRank`. The session posts `{ type: 'trust-badge', runId, badge }` after the lead run's `assistant-done` for every answer not through a local client; the Verify signature offer is gone. `media/chat/trustBadge.js` draws one `button.trust-badge` per answer (data-state, an aria-hidden icon, the title in words, `aria-label` "Trust: <title>. Show details", `aria-expanded`); chat.js draws it only under `replies.get(runId)`. panelView loads the kit before chat.js and the page harness runs the real kit.

**Task 2 (`c86d6381`).** `NearAiClient.verificationFor(model, evidence, { fresh })` returns the route's own check of the chat id (plan 25) or runs one through the 10-minute report cache and keeps it apart from the route's checks (so `answerCheck` still means "checked by the route"). The session starts that check after the first badge, with a `BADGE_CHECK_TIMEOUT_MS` timer (injectable, unref'd); the timeout posts Not verified with the in-time reason and a later result posts again. A failed check of any answer in the chat makes later badges Not verified (the route's failures as before, plus the badge's own failures, kept for the whole chat). `checkAgain(runId)` runs `verifyRun` (fresh, never the cache, still clears plan 25's stop) and returns the badge; `chat.ts` posts it as `trust-badge`. The page's result row and its Check again are gone.

**Task 3 (`aec4129a`).** The badge's details (explanation, reasons, the helper-agent sentence, "Not checked in the editor: ..." with the pointer to cloud.near.ai/verify), Check again (`verify-response`) and Show full attestation (`trust-details`); Escape closes and refocuses; a `replayed` badge has neither button and says the full attestation is kept only while the window that checked it is open. `parseChatWebviewMessage` accepts `trust-details` with exactly `type`, `runId` and the optional `conversationId`. `VerificationResult` carries `signed` (text and signature) and `report` (verified or reused; the 10-minute cache keeps the report in memory). `src/services/trustDetails.ts` builds the JSON (badge, signed text, signature, signing address, who holds the key, every check, the not-checked list, the connection fact with its fingerprint and time and whether the request was held to it, the report) and opens it untitled in a preview tab, then runs `workbench.action.files.setActiveEditorReadonlyInSession`. A run no longer kept gets the plain message and a Check again button. CSS: theme variables only, one rule per state, a focus outline, a high-contrast border; the old `.verify` rules are removed.

## Verification

| Run (inside the cap, under the shared lock) | Result |
|---|---|
| Task 1 set (gateTrustBadge, checkNow, steering, imageReview, syncControl, conversations, teamBoundaries) | 139 tests, 0 failed |
| Task 2 set plus gateChatLabel and checkNow (gateTrustBadge, attestation, gateRouteTiers, gateConnectionBinding, conversations, agentLoop) | 128 tests, 0 failed |
| Task 3 set plus gateChatLabel and gateRouteTiers (conversations, attestation, responsivePanels, syncControl, checkNow) | 170 tests, 0 failed |

The exhaustive test checks 1,152 combinations (boundary 4, endpoint 2, signature id 2, 6 verification outcomes, 6 connection states, earlier failure 2) and asserts that number. `grep -c "response-verifiable"` and `grep -c "response-verification"` print 0 in agentSession.ts, chat.ts and chat.js; `grep -c "innerHTML\|insertAdjacentHTML\|outerHTML" media/chat/trustBadge.js` prints 0. No test reaches NEAR AI Cloud: the fake server signs with the recorded quote fixtures.

## Deviations from Plan

1. **[Rule 2, CLAS-08 prohibition] Verified private model needs the pinned connection.** Plan 25 puts the binding fact on the usage of every request through a client with a binding source, but only an attested-cloud request is sent over the connection pinned to that fact's key. A bound fact on an unpinned request proves nothing about that request's connection (a proxy that ends TLS would not be caught), so the client now marks `usage.connectionPinned` and the badge's `connectionFresh` is that flag. Task 2's first behaviour ("a TEE answer at org/Public ... goes to Verified private model") is therefore tested at org/Confidential, where the request is pinned; at org/Public the same answer is Model verified, connection not proven, with the reason "your request was not sent over a connection held to the key NEAR AI Cloud's attestation names". Raised as an owner question for 28e.
2. **Tests that pinned the old row, changed with it (none weakened):** `attestation.test.ts` "the chat offers Verify only for TEE-private cloud answers" now asserts a badge under each cloud answer (forwarded ones too) and none under a local one, and Check again still verifies through the client; `gateChatLabel.test.ts` review 89.4 now asserts the badge goes only under its own run's answer (it no longer waits, since a badge is always posted after its answer; one for an unknown run draws nothing, as this plan requires); `gateRouteTiers.test.ts` reads run ids and results from `trust-badge` messages in five places (first test now also asserts Checking now, then Verified private model; the failed test asserts the failure reason).
3. **`gateRouteTiers.test.ts` "a request at any-cloud starts no automatic check"** asserted 0 signature requests. The owner's decision of 2026-11-16 (each cloud answer from a TEE model is checked once) makes that 1: the test now asserts exactly one signature request, still no `route.attestation-checked` record, no route check and no stop.
4. **Extra reason sentences** beyond the plan's list, each needed by a fact the plan names: another endpoint than NEAR AI Cloud's, a model the catalog does not place, a forwarded model with no provider named, "It was not checked", and "can no longer be checked again" for a run no longer kept.
5. **A failed badge check at any-cloud sets no stop** (the stop belongs to the route's checks, D-55), but it counts as "an earlier check in this chat failed" for later badges until Check again on that answer passes.
6. **Check again calls `client.verifyResponse`**, which is what `verificationFor(..., { fresh: true })` does; test fakes without `verificationFor` keep working.
7. **`signed` added beside `report`** on `VerificationResult` and `AnswerCheckResult`, for the "signature text" the details must show. The details builder is its own file (`src/services/trustDetails.ts`) so it is tested with the vscode stub without loading chat.ts.
8. **Test helpers:** `FakeNode` gained `replaceChildren`, `press` and `focus`; the vscode stub's `openTextDocument` opens untitled text documents. `NearAiClient` gained `nearEndpoint` and `catalogEntry` (read-only, no fetch).

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: the new webview message `trust-details` is T-70-97 (checked by the bridge), the details document is T-70-98 (untitled, nothing written).

## Self-Check: PASSED

The four created files exist; commits `dca96bd3`, `c86d6381` and `aec4129a` are ancestors of HEAD.
