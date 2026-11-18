---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 27
pr: 4e
subsystem: gate (trust badge, kept and documented)
status: complete
tags: [CLAS-08, CLAS-07, D-56, PR-4e]
requires: ["70-26"]
provides: ["ThreadMeta.trust with a weaker-wins merge and recordTrust", "replayed badges on reopened answers", "LayoutReport.trustBadges and the e2e badge test", "The trust badge on each answer in SECURITY.md, README's badge lines"]
affects: [70-28e]
tech-stack:
  added: []
  patterns: ["a synced record that only ever merges to the weaker state", "the view gets a lookup passed in, so src/domain/state imports nothing from the gate"]
key-files:
  created: []
  modified: [src/domain/gate/trustBadge.ts, src/services/threadStore.ts, src/domain/state/threadView.ts, src/services/agentSession.ts, media/chat/chat.js, media/chat/trustBadge.js, src/services/layoutProbe.ts, media/shared/layout-probe.js, src/test/e2e/suite.ts, SECURITY.md, README.md, scripts/generate-marketplace-screenshots.mjs, src/test/gateDocs.test.ts, src/test/gateTrustBadge.test.ts, src/test/helpers/chatPage.ts]
decisions:
  - "A record's reasons have every run of 16 or more hex characters replaced with (hidden), and a stored reason holding one is refused, so no address, fingerprint or hash is kept or synced"
  - "Keeping a badge does not count as using the chat: recordTrust leaves lastUsedAt alone, so a lowering's 'not used after it' check is not disturbed"
  - "In one window a newer result of the same run's answer replaces its record; any other write of the same key keeps the weaker state"
  - "The e2e badge test runs before the file-write test rather than right after the first streamed reply, so the cloud profile's spend account does not reach the Agent Activity test"
metrics:
  completed: 2026-11-18
  tasks: 3
estimate:
  tokens: 86045
actuals:
  tokens: 17300
  tasks: 3
  commits: 3
plan_head_before: 3ef2814010beaa92cff2e57bc9fd9ce781d3e2a1
rebased_onto: 0f1938fe03f9a07de9496bed960bc41a5981e350
plan_head_after: 6d562f1527b749f43f2947f50278698e1d1b9398
---

# Phase 70 Plan 27: The trust badge kept, seen end to end, and documented Summary

Plan 70-28e rebased the branch onto `origin/main` at `0f1938fe`; the hashes below are after that rebase.

A reopened chat shows each cloud answer's badge in the state its checks reached when the answer arrived (never stronger, across syncs too), the real chat page shows the badge end to end under xvfb and again after the view reloads, and SECURITY.md and README describe the badge word for word with the code.

## What was built

**Task 1 (`6b4021b9`), tracer.** `TrustRecord`, `trustRecordKey` (first 32 hex of the SHA-256 of the answer's text), `trustRecordOf`, `parseTrustRecord`, `weakerTrustRecord`, `mergeTrustRecords`, `newestTrustRecords` and `trustBadgeFromRecord` (replayed, with "This shows the check made when the answer arrived.") in `src/domain/gate/trustBadge.ts`. `ThreadMeta.trust` sits after `label`: `validMeta` keeps only records `parseTrustRecord` accepts; `mergeMeta` unions both copies by key and keeps the weaker state for a shared key whichever meta is newer (the label's raise-only merge is untouched); at most 200, newest by time. `ThreadStore.recordTrust(id, record, mode)` writes through `updateMeta` without moving `lastUsedAt`. The session keeps each badge when it settles (not while Checking now), in order and never blocking the run; it starts the badge after the chat is saved so the record has a meta to go in. `restore` passes `entriesToView` a lookup by `trustRecordKey`, which returns the replayed badge; chat.js draws it for a reopened assistant item. A webview reload in the same window replays the logged `trust-badge` messages.

**Task 2 (`0e902764`).** `LayoutReport.trustBadges` (state and title of each `.trust-badge`). The e2e project scenario's new test: no badge under the earlier local answers; profile `profile-e2e-cloud` (provider `near-ai`, the fake server, key `e2e-key`) selected; "Say hi" sent; `assistant-done` and a `trust-badge` with that run id and state `not-verified`; the probe (after the layout stress font) shows exactly `[{ state: 'not-verified', title: 'Not verified' }]`, `clipped` and `offenders` empty; `workbench.action.webview.reloadWebviewAction`, focus, the page's `chat-ready`, and the probe shows the badge again; the local profile is selected again and the provider cache cleared. The badge button is `data-must-read`, so the clipped check covers its title. The fake server needed no new route.

**Task 3 (`6d562f15`).** The SECURITY.md section and README lines below, the Known limitations row, the labels section's link, the screenshot script's badge, and gateDocs.

## E2E record

`npm run test:e2e` under `xvfb-run -a` with `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE` and `WAYLAND_SOCKET` removed, 6G cap, 1800 s, VS Code 1.144.1 from the local cache: exit 0. Project scenario 17 tests passed, including "✔ [project] the trust badge renders under a cloud answer in the real chat page, not under a local one, and comes back after the view reloads (CLAS-08)"; plain scenario 5 passed; no "✖" line.

## Verification

| Run (inside the cap, under the shared lock) | Result |
|---|---|
| Task 1 set (gateTrustBadge, threadMerge, threadLog, gateChatLabel, conversations, checkNow, teamBoundaries, steering, imageReview) | 182 tests, 0 failed |
| e2e (both scenarios) | exit 0, 22 passed |
| Task 3 set (`dist/test/gateDocs.test.js dist/test/gate*.test.js`) | 799 tests, 0 failed |

`grep -c "Verify signature"` prints 0 for SECURITY.md and README.md; `grep -c "The trust badge on each answer" SECURITY.md` prints 2 (the heading and the labels section's link); `grep -c recordTrust src/services/agentSession.ts` prints 1.

## SECURITY.md, the new section in full

> ### The trust badge on each answer
>
> Every answer of the lead agent that comes from a cloud model has a trust badge
> under it, in one of three states. An answer from a model on this computer has
> none.
>
> - **Verified private model**: This answer's signature and NEAR AI Cloud's
>   attestation were checked, and the connection that carried your request was
>   proven to end inside NEAR AI Cloud's private enclave.
> - **Model verified, connection not proven**: This answer's signature and NEAR AI
>   Cloud's attestation were checked, so a private model on NEAR AI Cloud sent it.
>   The connection that carried your request was not proven to end inside the
>   private enclave.
> - **Not verified**: NEAR AI could not show that a private model on NEAR AI Cloud
>   sent this answer. The reasons below say why.
>
> The badge is chosen only from checks that ran, and it never says more than they
> proved. A check that is still running, did not finish in time, could not be
> made or failed shows **Not verified**, and so does every later badge of a chat
> in which an earlier check failed, until **Check again** on that answer passes.
> **Verified private model** needs all of these: the model runs in a TEE on NEAR
> AI Cloud's own endpoint, NEAR AI returned a signature id for the answer, the
> answer's check passed, and your request went over a connection held to the key
> NEAR AI Cloud's attestation names. Requests are held to that key at a level that
> needs an attested cloud (see
> [Classification labels and routing](#classification-labels-and-routing)); at
> other levels the best an answer shows is **Model verified, connection not
> proven**.
>
> **When it is checked.** Each cloud answer from a TEE model is checked once,
> automatically, in the background, after it arrives. That costs one signature
> request per answer; an attestation report NEAR AI has already verified for the
> same signing key is reused for up to ten minutes. While the check runs the badge
> shows **Not verified** with "Checking now." A check that has not finished after
> 20 seconds shows **Not verified**, saying it could not be checked in time, so a
> badge never waits forever, for example offline; if the check finishes later,
> the badge changes. An answer from a model NEAR AI forwards to another provider is
> never checked, and its badge says where it is forwarded.
>
> **Lead answers only.** The badge is on the lead agent's answers only. A helper
> agent's answer is not shown to you as an answer, so it has no badge; each
> badge's details say that helper agents in the run may have used other models,
> each request routed by the chat's label and recorded. At a level that needs an
> attested cloud, every answer NEAR AI Cloud sends, tool-call turns and helper
> agents' answers included, is checked this way too, and a failed check stops
> those levels for the chat (see
> [Classification labels and routing](#classification-labels-and-routing)); the
> badge reuses that check, so it makes no second request.
>
> **What the check covers.** It follows NEAR's reference verifier
> (`nearai/nearai-cloud-verifier`) and checks that:
>
> 1. NEAR's signature (`/v1/signature/{chat_id}`) covers SHA-256 hashes equal to
>    the exact request this editor sent and the raw response it received. The
>    extension keeps only these hashes, not the text.
> 2. The signature (EIP-191, secp256k1) recovers to NEAR's signing address.
> 3. A fresh attestation report (`/v1/attestation/report`, with a random nonce
>    from the extension) contains a **genuine Intel TDX quote**. The quote is
>    signed by its attestation key. The Quoting Enclave's report vouches for that
>    key and is signed by the platform's PCK certificate. That certificate chains
>    to Intel's SGX Root CA, which the extension pins by fingerprint.
> 4. The quote's `report_data` binds the signing address and the fresh nonce, and
>    any GPU evidence echoes the nonce.
>
> The result names which key signed. **NEAR AI's gateway key** (seen for
> tool-calling responses) proves the exchange passed unaltered through NEAR's
> attested gateway. It does not by itself prove which enclave ran the model,
> since the model's TEE is attested separately in the same report. **The model's
> key** is signed inside the model's own TEE. Whether the connection was proven
> comes from the connection check described under
> [Classification labels and routing](#classification-labels-and-routing): NEAR AI
> Cloud's attestation must name the certificate the server presents, and the
> connection that carries your request must present it.
>
> **Check again and Show full attestation.** Click the badge, or press Enter or
> Space on it, to read why it shows its state and what was checked. **Check
> again** checks the answer again with a fresh report, never a reused one. On an
> answer whose failed check stopped the levels that need an attested cloud for
> the chat, it lifts that stop when the answer now checks out. **Show full
> attestation** opens the details in an editor tab as an untitled, read-only JSON
> document: the signed text and signature, the signing address and which
> component holds the key, every check result, the connection fact with its
> fingerprint, and the attestation report the check used. Nothing is written to
> your project or to a decision record. The full attestation is kept for the last
> 20 answers of the window that checked them.
>
> What is **not** checked in the editor, and the details say so:
>
> - the platform's TCB status and certificate revocation, which need Intel's
>   collateral;
> - which code the enclave runs (its measurements against NEAR's published
>   build);
> - NVIDIA's GPU attestation verdict.
>
> For those, use [cloud.near.ai/verify](https://cloud.near.ai/verify) or NEAR's
> verifier.
>
> **A reopened chat.** A chat reopened after a reload or a restart shows each
> answer's badge in the state its checks reached when the answer arrived, and
> says so; it has neither Check again nor Show full attestation. Answers saved
> before this version have no badge. The kept badges hold a state, plain reasons
> and a time, never a fingerprint, a signing address or the answer's text, and
> they sync with the chat; when two copies disagree about an answer, the weaker
> state is kept.

Known limitations row:

> | The trust badge's checks do not check TCB status or revocation, enclave measurements, or NVIDIA's verdict | Use cloud.near.ai/verify or NEAR's verifier for a full check |

## README, the changed lines in full

Under "Security and privacy":

> - A **trust badge** under each cloud answer says **Verified private model**,
>   **Model verified, connection not proven** or **Not verified**. It is set only
>   from checks that ran: NEAR's signature over the exact request and response, a
>   genuine, fresh Intel TDX quote that binds the signing key, and whether the
>   connection was proven to end inside the private enclave. Click it for the
>   reasons, Check again and the full attestation. See
>   [what it does and doesn't check](SECURITY.md#the-trust-badge-on-each-answer).

Under "Good to know":

> - **Privacy labels come from NEAR's model catalog.** Each cloud answer of the
>   lead agent has a **trust badge** (Verified private model; Model verified,
>   connection not proven; Not verified), checked once in the background from
>   NEAR's signature and a fresh Intel TDX quote in the editor; it does not check
>   TCB status, enclave measurements or NVIDIA's verdict (see
>   [what it does and doesn't check](SECURITY.md#the-trust-badge-on-each-answer)).

## Deviations from Plan

1. **[Rule 1] The badge starts after the chat is saved.** Started right after `assistant-done`, a first run's not-checked badge was kept before the thread had a meta, and the record was lost; it now starts after `saveTranscript`, a few milliseconds later.
2. **[Rule 2] Reasons are scrubbed of long hex runs** before they are kept, and `parseTrustRecord` refuses a reason that holds one: a failed check's summary can name the signing address.
3. **A same-text guard:** two answers with the same text share a key, so a write from another run keeps the weaker state; only a newer result of the same run's own answer replaces it.
4. **The e2e test's place.** It runs before "a file write asks for approval..." instead of right after "a message streams a reply...": after a run on a cloud-kind profile the shown spend account stays that profile's, which would change the Agent Activity test's "no spend section" check. Every later test runs on the local profile as before.
5. **Test helpers:** the page harness's document gained `createDocumentFragment` and nodes a `childNodes` getter (the reopened history is drawn through fragments).
6. **gateDocs:** plan 25's test of the old section now reads "The trust badge on each answer" with the new section's sentences for the automatic check at attested-cloud levels and Check again.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register (T-70-99 to T-70-101).

## Self-Check: PASSED

Commits `6b4021b9`, `0e902764` and `6d562f15` are ancestors of HEAD; the modified files exist.
