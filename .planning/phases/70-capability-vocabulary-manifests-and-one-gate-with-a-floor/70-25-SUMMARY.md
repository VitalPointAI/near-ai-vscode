---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 25
pr: 4d
subsystem: gate (attested-cloud routing)
status: complete
tags: [CLAS-05, OFFL-01, GATE-07, CLAS-07, D-36, D-50, D-55, PR-4d]
requires: ["70-28c"]
provides: ["NearConnectionBinding and pinnedFetch", "attestedTlsFingerprint and AttestationReportCache", "the after-answer check, its stop and Check again", "CONNECTION_BINDING_TEXT and the SECURITY.md text", "the last PR #87 review fixes"]
affects: [70-28d, 70-26, 70-27]
tech-stack:
  added: []
  patterns: ["a pin on the request's own TLS options, so it holds on every route VS Code gives node:https", "facts read from memory at decision time, checks out of band (OFFL-01)"]
key-files:
  created: [src/test/gateConnectionBinding.test.ts, src/test/helpers/attestationFixtures.ts]
  modified: [src/services/attestation.ts, src/services/connectionBinding.ts, src/services/nearAiClient.ts, src/services/providerFactory.ts, src/gate/sessionMark.ts, src/services/agentSession.ts, media/chat/chat.js, src/domain/gate/routing.ts, src/services/gateCommands.ts, SECURITY.md, src/gate/chatLabel.ts, src/gate/host.ts, src/agent/outboundCheck.ts, src/agent/gateAdapter.ts, src/services/threadStore.ts, src/domain/gate/lowerings.ts, src/domain/gate/record.ts, src/domain/gate/decide.ts]
decisions:
  - "NEAR_TLS_FINGERPRINT_KIND is public-key-sha256 and the attestation role is the gateway's, from NEAR AI Cloud's own source and verifier"
  - "The binding is proved per host and pinned per connection; a bound fact is checked again after 8 minutes, any other after 30 seconds, and a check with no private model listed keeps no fact"
  - "A report that cannot be fetched is unavailable, never failed"
  - "Check again re-checks every failed answer of the run (tool-call turns and helpers included) with a fresh report"
  - "outboundCause is an optional record field, not a new rule id, so a rolled-back 4d never leaves records older code cannot name (D-49)"
metrics:
  completed: 2026-11-18
  tasks: 3
estimate:
  tokens: 106056
actuals:
  tokens: 56750
  tasks: 3
  commits: 5
plan_head_before: 0dcfd0c08a1adbfe3f6fab2d5d7e37840917c3ee
plan_head_after: d65977f2
---

# Phase 70 Plan 25: Attested-cloud over a proven connection Summary

NEAR AI Cloud's gateway attestation binds the public key of the certificate its endpoint serves, so content at attested-cloud levels (Internal, Confidential, Protected A, NATO Unclassified) can again go to a private NEAR AI Cloud model, but only after a fresh background check proves that binding and only over a connection pinned to that key; every such answer is checked afterwards, a failed check stops those levels for the chat, and Check again clears it.

PR4D_BASE: `0dcfd0c08a1adbfe3f6fab2d5d7e37840917c3ee` (origin/main after PR 4c, #87, merged as `0dcfd0c`). Branch `feat/gate-attested-routing`, started from that commit.

## NEAR AI Cloud connection binding

Researched on 2026-11-18, before any binding code. Downloaded sources were read as text in a scratch folder outside the repository and never run.

**(a) What the editor already parsed.** `src/services/attestation.ts` read `tls_cert_fingerprint` from an attestation and, when present, expected report_data bytes 0 to 31 to be sha256(signing address bytes followed by the fingerprint bytes), bytes 32 to 63 the fresh nonce. It never asked for the fingerprint, so it never saw one. Source: this repository at PR4D_BASE.

**(b) What NEAR AI Cloud's attestation binds.**
- The fingerprint is in the **gateway's** attestation (`gateway_attestation`), and only when the report is asked for with `include_tls_fingerprint=true`. The response then also carries `tls_certificate` (the PEM the gateway reads from `TLS_CERT_PATH`). Model attestations do not carry it. Sources: github.com/nearai/cloud-api at commit `0cd238f5`, `crates/api/src/routes/attestation/report.rs` (the `include_tls_fingerprint` query parameter, "SHA-256 hash of the TLS certificate's SPKI", `tls_certificate`); github.com/nearai/nearai-cloud-verifier at commit `94554726` (2026-08-10), `ts/domain_verifier.ts`, `ts/model_verifier.ts` (`fetchReport(..., includeTls)`, `verifyGatewayTlsBinding`).
- It is the SHA-256 of the certificate's **public key** (the DER SubjectPublicKeyInfo), not of the whole certificate: cloud-api `crates/services/src/attestation/environment.rs` `compute_spki_hash` hashes `tbs_certificate.subject_pki.raw`; the verifier's `ts/tls_verifier.ts` compares the live certificate's SPKI hash. So `NEAR_TLS_FINGERPRINT_KIND = 'public-key-sha256'` and the attestation role is `gateway`.
- report_data: bytes 0 to 31 are sha256(signing address bytes, fingerprint bytes), bytes 32 to 63 the caller's nonce, exactly what this editor already checked (cloud-api `crates/services/src/attestation/report_data.rs`, which also says NEAR's backends all bind the fingerprint now and a strict verifier refuses a report without it).
- Where TLS ends: NEAR's verifier says its TLS check "proves that a specific inference proxy's TLS certificate is held inside the TEE", and its domain verifier, run by default against `cloud-api.near.ai`, "confirms the gateway's attested TLS material matches what the host serves on :443" (nearai-cloud-verifier README, "Domain Verification (gateway TLS)" and "TLS Verifier"). The gateway reads its certificate inside its own enclave. NEAR does not state in these sources how its load balancing works; its TLS verifier fetches the report and reads the certificate over one connection "to avoid round-robin mismatches", which suggests more than one gateway may answer.
- Not checked by NEAR's own verifier either: whether `tls_certificate` and `tls_cert_fingerprint` name the same key (the domain verifier compares the PEM's whole-certificate hash with the live one, the TLS verifier the public key). This editor uses only the fingerprint the quote binds.

**(c) Proxies, VS Code and code-server.** VS Code's proxy support (`http.proxySupport`, default `override`) replaces `https.request` in the extension host with a version that resolves a proxy for every request and, in `override` mode, swaps the request's own agent for its proxy agent (github.com/microsoft/vscode-proxy-agent at commit `3afbc6db` (2026-11-04), `src/index.ts` `createHttpPatch`; `src/agent.ts` `PacProxyAgent.connect`). The request's own TLS options, `checkServerIdentity` included, still reach the TLS socket: a direct connection uses Node's https agent with them, and an HTTPS proxy is reached through a CONNECT tunnel inside which TLS runs end to end to the server (`HttpsProxyAgent`). So the pin is put on the request itself, not only on its agent, and it holds on every route; a proxy that ends TLS itself presents its own certificate and is refused. `tls.connect` is only patched to add certificate authorities (`createTlsPatch`), never routed through a proxy, so the background probe goes direct; behind a proxy-only network it fails and the answer is unknown (content at these levels stays on this computer). code-server runs the same VS Code server extension host, so the same patch applies there and the requests leave from the code-server host, not the browser. Confidence: medium (read from source, no live proxy test).

**(d) Live comparison.** On 2026-11-18 one TLS connection at a time (five in all) was made to `cloud-api.near.ai:443` from this session: TLS 1.3, a Let's Encrypt certificate for `CN=cloud-api.near.ai` valid 2026-10-01 to 2026-12-30, an EC key. The certificate's SHA-256 starts `56:64:58:01`, its public-key hash starts `73862c25`; all five connections (the name resolves to two addresses) presented the same public key. Node's `getPeerCertificate().pubkey` is not the DER SPKI NEAR hashes (it differed), so the code hashes the SPKI taken from the certificate itself. Full values are not written here so no 64-hex value enters the repository. No NEAR AI API key was available in the session's environment, so **no attestation report was fetched and the live comparison of the attested fingerprint with the served key was not made**; it is left for a person (70-VALIDATION.md, Manual-Only Verifications: one Confidential chat on NEAR AI Cloud, then read the answer's Verify signature row).

**Finding for this release.** NEAR AI Cloud's attestation does expose the binding: the gateway's quote binds the public key of the certificate its endpoint serves. So content at levels that need an attested cloud can go to a private NEAR AI Cloud model again, but only when a fresh check of that binding passes and the request's own connection presents that same key; otherwise it stays on this computer.

## What was built

**Task 1 (`f1b82ba2`).** `attestedTlsFingerprint` proves the gateway attestation's `tls_cert_fingerprint` (quote to Intel's root, report_data binds sha256(address, fingerprint) and this check's nonce) through `reportDataBinds`, the one byte check `verifyResponse` also uses. `NearConnectionBinding.refresh` asks for `/attestation/report?model=<a TEE model>&nonce=<new>&signing_algo=ecdsa&include_tls_fingerprint=true`, proves it, opens its own TLS connection and compares the presented public key; one refresh per host, 5-second timeout. `pinnedFetch` runs the normal host name check, then refuses any other key with `ConnectionNotBoundError` before a byte is written; the check is on the request's own options as well as its agent, so VS Code's proxy agent keeps it. The client reads only the cached fact, starts a background refresh when it is missing or old, sends attested-cloud requests through `fetchFor`, and turns a refused handshake into `route.connection-not-bound` (host marked not-bound, the refusal recorded). The provider factory gives a source only to a NEAR client on NEAR AI Cloud's own endpoint. Records hold the connection state only. The quote fixtures moved to `src/test/helpers/attestationFixtures.ts`; `git diff f1b82ba2^..f1b82ba2 -- src/test/attestation.test.ts` shows only import lines and the removed helper bodies.

**Task 2 (`7eacaed8`).** `AttestationReportCache` (10 minutes per signing address, injected clock). The client checks each answer it sent at attested-cloud in the background, keeps the newest 50 checks by chat id (`answerCheck(chatId)`, for plan 26), records `route.attestation-checked` (verified, failed, unavailable) and sets the chat's stop on a failure unless the chat is closed. The conversation's attestation state is replaced (and the old one marked closed) on a new or reopened chat. Check again (`verifyRun`) re-checks the failed answers with a fresh report; when all pass the stop is cleared and `route.attestation-cleared` recorded. The page shows Check again under a failed result.

**Task 3 (`bd28a88e`, `d65977f2`).** `CONNECTION_BINDING_TEXT`; the refusal sentences; Show Policy; SECURITY.md (below).

**Review fixes (`c80242f0`), asked for by the coordinator after Task 3:** the nine last findings of PR #87's review, each with a test (see Deviations, item 9).

## SECURITY.md, as written

Classification labels and routing, the paragraph that replaced the interim one:

> **Attested cloud in this version.** Levels whose tier is attested-cloud (Internal, Confidential, Protected A and NATO Unclassified by default) may go only to a private model on NEAR AI Cloud's own endpoint, and only over a proven connection:
>
> Content at a level that needs an attested cloud goes to NEAR AI Cloud only when NEAR AI Cloud's attestation shows that the connection ends inside the private enclave: the enclave's attestation must name the certificate the server presents, and the connection that carries your request must present that certificate. When this cannot be shown, content at those levels stays on this computer, and a request with no model on this computer is refused.
>
> NEAR AI Cloud's attestation names the key of the certificate its endpoint serves, so from this release content at these levels can reach a private NEAR AI Cloud model again, whenever that check passes. NEAR AI makes the check in the background, never while a request waits, and repeats it every few minutes; a check older than ten minutes no longer counts. After each such answer, NEAR AI also checks the answer's signature and NEAR AI Cloud's attestation (see Checking a response's signature). If that check fails, nothing more at these levels is sent to NEAR AI Cloud from that chat until **Check again** under that answer passes; a new chat or a window reload also starts without the stop, and the failure stays in the decision log. A check that cannot be made, for example offline, changes nothing. Behind a proxy that inspects encrypted traffic, the connection cannot be proven, so content at these levels stays on this computer. Protected B stays on this computer because no CCCS Medium assessment of NEAR AI Cloud was found, unless your organization changes its policy.

Checking a response's signature:

> Only the final answer of a run is offered for verification. Tool-call turns are signed the same way; they are checked only at a level that needs an attested cloud, as below.
>
> At a level that needs an attested cloud (see Classification labels and routing), every answer NEAR AI Cloud sends, tool-call turns and helper agents' answers included, is checked this way automatically, in the background, after it arrives. The final answer's result shows under it, and a failed check of any answer of the run shows there too. For these automatic checks a report NEAR AI has already verified for the same signing key is reused for up to ten minutes. A failed check shows **Check again**, which checks the failed answers again with a fresh report.

Known limitations, two new rows:

> | The check of an answer's attestation and signature runs after the answer, so it cannot stop that answer's request; a failed check stops the next ones. | The connection is proven before anything is sent, and each request is pinned to it |
> | The check that a connection ends inside the enclave relies on NEAR AI Cloud's attestation and Intel's root of trust. Like the answer check, it does not check the platform's TCB status, certificate revocation or which code the enclave runs. | Use cloud.near.ai/verify or NEAR's verifier for a full check |

The policy section's Model requests bullet now says: "Content at a level whose tier needs an attested cloud model goes to NEAR AI Cloud only over a connection proven to end inside its private hardware; otherwise it stays on this computer." Show Policy's `POLICY_ROUTING_TEXT` ends: "Levels that need an attested cloud go to a private NEAR AI Cloud model only over a connection proven to end inside its private hardware; otherwise they stay on this computer."

## Verification

| Run (inside the cap) | Result |
|---|---|
| Task 1 set (gateConnectionBinding, attestation, gateRouteTiers, gateRouteGuard, gateOffline, providerFactory, privateMembers, nearAiClient) | 92 tests, 0 failed |
| Task 2 set plus neighbours (adds conversations, checkNow, agentLoop) | 135 tests, 0 failed |
| Task 3 set (`dist/test/gate*.test.js`, gateDocs, gateCommands) | 746 tests, 0 failed |
| `npm run lint && npm test` (6G, 1800 s, under the shared lock), after the review fixes | exit 0; 3786 tests, 3777 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before) |

`grep -c "export function attestedTlsFingerprint" src/services/attestation.ts` prints 1; `grep -c "relies on NEAR AI Cloud's attestation and Intel's root of trust" SECURITY.md` prints 1. No test reaches NEAR AI Cloud: the binding tests use fixture reports, a local TLS server on 127.0.0.1 with the cyber fixture certificate, and fake fetches.

## Deviations from Plan

1. **[Rule 3, research] `include_tls_fingerprint=true` added to the report request.** The plan's path omitted it; without it NEAR AI Cloud returns no fingerprint at all (research (b)).
2. **[Rule 1] Node's `getPeerCertificate().pubkey` is not the DER SPKI NEAR hashes** (the live probe showed they differ), so `peerFingerprint` hashes the SPKI exported from the certificate itself.
3. **[Rule 1] A report that cannot be fetched is `unavailable`, never `failed`** in `verifyResponse` (it was `failed`), as D-55 requires of an offline check. Its summary text is unchanged.
4. **[Design, recorded] Refresh timing.** A bound fact is checked again after 8 minutes, any other state after 30 seconds (an early "no private model yet" or a mismatch recovers without waiting 8 minutes); a check with no private model listed keeps no fact; a check also starts once the catalog first lists a private model, since at client creation the catalog is usually empty. A source that gives no pinned fetch cannot carry an attested request (refused, never sent unpinned).
5. **[Design, recorded] Check again covers every failed answer of the run,** tool-call turns and sub-agents included (a sub-agent's route shares the run's listener); a run that ended without a row gets one when a check fails, so there is always a Check again to press.
6. **Unknown-binding sentence order.** "NEAR AI checks the connection in the background, so try again in a moment; until then, content at this level stays on this computer." keeps every binding sentence ending in "stays on this computer.", which gateRouting pins.
7. **Tests that changed with the behaviour (none weakened):** gateRouting's "no sentence promises a check that does not exist yet" now pins that the unknown sentence names the background check that exists, and that the other two promise none; gateDocs drops the interim phrases the plan removes and pins the new ones; gateLabelCommands follows the new `POLICY_ROUTING_TEXT`; gateRouteGuard's fake fetch answers the background report GET and counts it apart from content (the "only the two local requests were sent" assertion is unchanged, and a new one says the only other requests were report GETs).
8. **[Rule 1] `src/gate/sessionMark.ts` imported types from `services`** (Task 2), which teamBoundaries forbids; it now names the two shapes it needs itself (fixed in `c80242f0`).
9. **[Coordinator] The last PR #87 review findings, one commit (`c80242f0`), each with a test:**
   1. `judgeChatLowering` rejects a verified target that is not below its from-mark (`not-lower`) or is below the project's label as this computer last ran the chat (`below-project`; runs note it with `noteChatProjectMark`).
   2. Lowering times are parsed and compared as times; either one unreadable is `unreadable-time`. The test shows the old text comparison read an earlier use as later.
   3. The outbound check also matches the payload joined in order (object keys placed after the values so consecutive arguments stay adjacent); each text is split into words once and windows of each size slide over them without copying.
   4. A `label.network-at-mark` record names the tool, never the command; each `label.outbound-match` refusal records `outboundCause` (match, earlier, unchecked, pending, full, unreadable, reads-and-sends), an optional field so the record stays version 1 and no new rule id is needed.
   5. The host keeps at most 1,000 judged lowerings and at most 32 projects of 2,000 paths of refused raises, each path's labels joined; `writeRaises` decides that nothing rises only under the writer's lock (the cached view now only decides whether to tell the person). The two "review 1" race tests now inject the other writer just before this host's write takes the lock, since no view is read before it any more; their assertions are unchanged.
   6. Every label event with a mark records the mark's strictest label (`recordLabelEvent` works it out with the shared `strictestLabelOf`); a chat in view that has not run gets `CHAT_NOT_RUN_TEXT`.
   7. `setChatLabel` re-reads inside the store's lock; a lowering whose from-mark a sync has since exceeded keeps the higher label without the lowering, and the chat is raised to it and told (`LOWERING_OVERTAKEN_TEXT`). The structural test allows exactly this second raise line in agentSession.
   8. `route.attestation-failed` and `route.no-session` name Lower This Chat's Label.
   9. The feeder regex includes `addEarlier` and allows only agentSession's restore line; a new test shows an unsigned lowering survives a reload.
10. **Not done here:** STATE.md, ROADMAP.md and REQUIREMENTS.md were not updated in this branch, as with the earlier part 4 plans; the coordinator updates them on main.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register: the new network surface (a background GET of the attestation report and one TLS probe per check, both to the NEAR AI Cloud host the client already uses) is T-70-90 to T-70-93.

## Self-Check: PASSED

`src/services/connectionBinding.ts`, `src/test/gateConnectionBinding.test.ts` and `src/test/helpers/attestationFixtures.ts` exist; commits `f1b82ba2`, `7eacaed8`, `bd28a88e`, `c80242f0` and `d65977f2` are ancestors of HEAD.
