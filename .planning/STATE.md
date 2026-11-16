---
gsd_state_version: "1.0"
milestone: v0.7.0
milestone_name: Governed agent platform and messaging relay
current_plan: 8
status: executing
stopped_at: Phase 70 PR 1 (#66, plans 01 to 07) open with the owner-directed review fixes; plans 08 onward wait for PR 1 on main
last_updated: "2026-11-16T14:29:02.000Z"
state_head: 40a3182d32b057cb0afad76a4cc002590245202d
progress:
  total_phases: 21
  completed_phases: 1
  total_plans: 95
  completed_plans: 59
  percent: 5
last_activity: 2026-11-16
current_phase: 70
current_phase_name: "Capability vocabulary, manifests and one gate with a floor"
last_activity_desc: Phase 70 plans 01 to 07 executed, PR 1 opened as #66 with the owner-directed review fixes (vocabulary v1, labels v1 and presets, policy bundle v1, route decision and label map v1, tool and MCP manifests v1, the floor, decide() and the decision record); before that: Owner's agent authorization decisions recorded (PROJECT.md Platform direction 14-17; CRED-08 added to Phase 73, 134 requirements; L4 drafts ANCH-09..15 for function-call keys on on-chain calls only) and PR #63's leftover review points fixed in the Phase 70 files
---

# Project State

## Current position

Milestone: v0.7.0 Governed agent platform and messaging relay (Phases 68-84), replanned 2026-11-15 from the owner's platform direction (`.planning/PROJECT.md`, "Platform direction"). The roadmap's v0.7.0 section opens with the order of work across every stream.
Phase 68 (Relay foundation): complete, verified and merged as PR #50 (052d5cf, 2026-11-15). The owner added `relay` to main's branch protection the same day (D-19, done).
0.4.x line: 0.4.22 published 2026-11-14; 0.4.23 merged (PR #51) and published 2026-11-15 (release PR #52, tag v0.4.23); 0.4.24 is next (the four #46 review minors and three documentation mismatches). Phase 27 shipped as 0.4.20; its record stays open until the owner's host check.
Phase 69 (Team Mode reconciliation): planned 2026-11-15, 15 plans in 15 waves over two PRs (69-01..08 port the Phase 60 core and the per-person identity, 69-09..15 add device.rotated, the payload signer, key history and the v0.6.0 disposition). Decisions D-01..D-29 were made on the owner's behalf and are recorded in 69-CONTEXT.md with their undo cost. All 15 plans are executed: PR 1 (#59) is merged on main (1cbcb9b) and PR 2 (plans 09-15, `feat/team-signed-payloads`, rebased onto main) is open. Next step: the owner reviews and merges PR 2; nothing else in Phase 69 is pending.
Phase 70 (Capability vocabulary, manifests and one gate with a floor): planned 2026-11-16 on `docs/phase-70-plan`, 28 plans in 28 waves for 18 requirements (GATE-01..07, OFFL-01..03, CLAS-01..08). After the planning PR: PR 1 plans 01-07 (`feat/gate-vocabulary`, pure domain, no behaviour change), PR 2 plans 08-15 (`feat/gate-shadow`, manifests, signed policy file, gate on every path in shadow; an invalid policy file fails closed), PR 3 plans 16-18 (`feat/gate-floor`, the floor with SECURITY.md and README), PR 4 plans 19-28 (`feat/gate-labels`, route check, labels, high-water mark, routing tiers, the pre-send connection binding in plan 25, the trust badge in plans 26 and 27). The owner ratified CLAS-05 on 2026-11-16 with a pre-send check that the connection is bound to the enclave (else local-only) and added CLAS-08, the trust badge on every cloud answer. Decisions D-01..D-48 were made on the owner's behalf in 70-CONTEXT.md with their undo cost; D-48: no release carrying PR 2 is published before the owner's fresh code-server check. Plans 70-01 to 70-07 are executed on `feat/gate-vocabulary`: PR 1 (#66, nothing in the extension calls the new code yet) is open with the owner-directed review fixes. Next step: the owner merges #66, then plans 70-08 onward (PR 2, `feat/gate-shadow`).
Current Plan: 8
Total Plans in Phase: 28
Plans 69-01 to 69-08 done on `feat/team-core-on-main` (the pure domain core, then the git transport, runner and identities, then the event log, team.json, audit mirror and Enable, all from ae5e9e1, byte-identical, 97, 96 and 82 tests green; then fix 3e11c0e on main's file lock under the team's own lock name, `team.json` refusing sync's branch names, and the team-versus-sync isolation test; then the VS Code adapters, `registerTeamMode` in activation with solo parity, and fix 9e49bc5; then the `nearAi.team.preview` setting with the Command Palette gating and the `nearAi.team.active` context key, the plain-words Phase 60 strings with the command titles kept, and the manifest and import boundary tests; then one Ed25519 identity per person per install, the D-22 rollback rule and the Team Mode e2e in a real window); plan 69-08 pushed the branch and opened PR #59 into main (all eight required checks and the agent review green; merged by the owner as 1cbcb9b); plans 69-09 to 69-15 (device.rotated, the payload signer and key status, the local signed key history, the identity writing its own history, rotation and revocation of the person's key, the v0.6.0 disposition record, then the rebase onto main, the gate and PR 2) are done on `feat/team-signed-payloads`.
Identity design (owner, 2026-11-15; PROJECT.md Platform direction decisions 8-13): standard DIDs, verifiable credentials for authority, clearance, roles and compartments, classification labels with routing by label, delegation that narrows at every link, and roots-only anchoring. Folded into Phase 70 (CLAS-01..07), Phase 71 (now "Identities, credentials and delegation that only narrows": VCRD-01..07, DLGT-08, a research step first) and the L4 and L5 outlines. Phase 69 is unchanged.
Agent authorization on NEAR (owner, 2026-11-16; PROJECT.md Platform direction decisions 14-17; evidence `.planning/research/platform-direction/agent-authz-prior-art.md`): NEAR function-call access keys only for agents' and nodes' on-chain calls (option (a)), off-chain capabilities in private credentials checked by Phase 73's broker (option (b), a public key registry with hashed names, declined), the automatic trust badge check, and the designs borrowed from prior art. Folded into Phase 73 (CRED-08, research flags 4 and 5), a Phase 71 research flag (9), the Phase 70 trust badge plans (now the owner's decision) and L4 (draft ANCH-09..15 and research flags 8-13).

Next, in order:
1. The Phase 69 planning PR is merged (PR #57, c1730bf). The relay housekeeping PR (`fix/relay-housekeeping`) carries: new phase numbers in the relay README, Compose file, build script and tests; the Signal sidecar re-pin (by 2026-12-10); and PR #50's second-review minors (the `relay` check skips when `relay/package.json` is missing on any branch, so key the skip to hotfix branches; redactor field-name collisions after normalising; README promises tenant key files nothing reads yet; 68-VALIDATION.md still draft; ackMessage id check).
2. The 0.4.24 patch (the #46 review minors, the three documentation mismatches, and PR #51's deferred image-review minors); the owner's Phase 27 host check (27-UAT test 8 onward) and the 27-16 summary.
3. Phase 69 is planned (15 plans, two PRs): merge its planning PR, then `/gsd-execute-phase 69`.
4. In parallel when wanted: `/gsd-plan-phase 28` (secure development workflow step). Phase 72 plans from the OpenShell spike result.
5. Owner action (open, acknowledged 2026-11-15): ask NEAR in writing, through your NEAR AI contact, whether the private shard will accept third-party contracts and data, and when account view keys ship. The answer decides when L4's confidential anchor backend (ANCH-07) is built.

## Accumulated Context

### Roadmap Evolution

- 2026-11-16: The owner's agent authorization decisions (PROJECT.md, Platform direction decisions 14-17; evidence `.planning/research/platform-direction/agent-authz-prior-art.md`). CRED-08 added to Phase 73 (the broker checks a signed, request-bound invocation in the UCAN 1.0 shape against the agent's private credentials, with audience binding, 403 `insufficient_scope` and a receipt per use): 133 to 134 active v0.7.0 requirements, Phase 73 has 8, nothing re-mapped. L4 drafts ANCH-09..15 added (function-call keys for on-chain calls only, non-empty subset narrowing, a person adds and removes keys with the removal command shown, the registry contract's double check, small allowance and cheap methods, dedicated DID-bound rotated keys, fail-closed chain reads), with L4 research flags 8-13 from the prior-art risks. CLAS-08's automatic check (one signature request per answer, the attestation reused for 10 minutes) is now the owner's decision. PR #63's leftover review points fixed in the Phase 70 files.
- 2026-11-16: The owner ratified CLAS-05 with an amplification (attested-cloud levels also need a pre-send check that the connection key is bound to the enclave, else local-only) and added CLAS-08 (a trust badge on every cloud answer: Verified private model; Model verified, connection not proven; Not verified). Phase 70 has 18 requirements and 28 plans; 133 active v0.7.0 requirements (132 to 133).
- 2026-11-15: Identity, credential and classification design folded in (PROJECT.md, Platform direction decisions 8-13; evidence `.planning/research/platform-direction/identity-research.md`). Added CLAS-01..07 to Phase 70 and VCRD-01..07 and DLGT-08 to Phase 71 (117 to 132 active requirements, nothing re-mapped); revised DLGT-01, DLGT-03, DLGT-07, OFFL-03, OFFL-04 and IDNT-05; Phase 71 renamed "Identities, credentials and delegation that only narrows" and given a research step first (JCS conformance, `did:webvh` hosting and caching, status list sizing). L4 drafts revised for roots-only anchoring (ANCH-01..05) with ANCH-07 (confidential backend interface) and ANCH-08 (HQ roles) added; L5 drafts NODE-01, NODE-02 and FED-01 revised, FED-05..08 added (edge sync, per-level maximum offline age, stapled status lists, second-site issuers). The research's twelve open risks are in the research flags of Phases 70, 71 and 74 and L4 and L5. VCRD, not CRED: CRED-xx is the credential broker. Calimero Network evaluated the same day (`calimero-evaluation.md`): not now; its encrypted git transport recommendation is in the L2 and L5 flags.
- 2026-11-15: v0.7.0 replanned and renamed "Governed agent platform and messaging relay" after the owner accepted the platform direction (no IronClaw fork; our engine gains the DID governance layer; offline gate; edge grouping and HQ federation; Theia container appliance first; NVIDIA and AMD GPUs). New Stage 1 Phases 69-74 (Team Mode reconciliation, gate with a floor, delegation, execution backends with a guarded apply, credential broker, run contracts). Relay phases renumbered: 69 to 75, 70 to 76, 71 to 77, 71.1 to 78, 72 to 79, 73 to 80, 74 to 81, 75 to 82, 75.1 to 83, 76 to 84 (the phase folders for 71.1 and 75.1 were renamed). 117 active requirements; RUNL-05 retired for APRV-01..04. Phases 28 (secure development workflow step) and 29 (cleanup member) added to the 0.4.x line. Six later milestones outlined (L1-L6). The OpenShell spike passed (20 of 20 key-folder escapes blocked; downloads keep symlinks, so the apply step treats changes as untrusted).
- 2026-11-15: Phases 71.1 (Messaging setup view) and 75.1 (Telegram) inserted; WhatsApp dropped.
- Phase 27 inserted 2026-11-13 in the 0.4.x line, ahead of v0.7.0 Phase 68: project state follows the project across interfaces and machines, shipping as release 0.4.20 (SYNC-01…08). Its decisions are in 27-CONTEXT.md. Shipped 2026-11-14 (PR #40, release PR #41).
- Milestone v0.7.0 added 2026-11-13: Messaging relay, Teams and Signal. Phases 68-76 mapped all 45 requirements then defined (later 54 with SETUP and TGRM).
- Phase numbering starts at 68: branch-shipped phases end at 26; the unmerged `feat/team-fix-pass` branch claims Phases 60-67 for v0.6.0; 68 keeps both honest.
- Phase 26 completed on branch perf/research-runs: Performance, faster agent and research runs (PERF-01…07, 5 plans, verified).
- Phase 25 (Cybersecurity harness, CYBER-01…12) moved 2026-11-13 out of the 0.4.x line into its own milestone v0.8.0 Cybersecurity. All 8 plans are executed; 25-UAT.md is parked at test 2, and the owner's review of the 12 regional disclaimers is still to do. Owner 2026-11-15: deferred until everything else in this plan is finished; it may move to its own product.

### Locked decisions (encode, do not re-litigate)

- Platform direction (owner, 2026-11-15; verbatim in PROJECT.md): no IronClaw fork; our TypeScript engine gains the DID trust and governance layer; the gate works fully offline from a signed local copy and fails closed; edge devices group locally and federate to HQ; Theia container appliance first, desktop second, VS Code extension kept while cheap; IronClaw, Hermes Agent and OpenShell are design sources only (plus OpenShell's policy format and prover); NVIDIA and AMD GPUs, arm64 and amd64, linked machines, HQ cluster and NEAR AI Cloud burst.
- Phase 68 stands as built.
- Relay = workspace `relay/`, owner-hosted, multi-tenant; Node 26.13.1 and a separate lockfile; the extension stays on Node 24 with a zero-dependency bundle.
- Exactly one relay runtime dependency: `jose`. No HTTP framework, no Bot Framework SDK, no SQLite package (`node:sqlite`, JSON-file-per-tenant fallback), no test framework (`node:test`).
- Signal via a pinned `signal-cli-rest-api` sidecar; pin the exact signal-cli version.
- Group visibility result-only; work detail stays in the requester's private chat.
- The bot is an external app installed by a customer admin; it never joins the customer's Microsoft organization.
- Per-tenant budget cap always on; per-conversation cap defaults to unlimited.
- Every relay run executes under a contract in a sandbox (EXEC-11, CTRT-07); the relay never gets a container runtime socket.

### Owner answers 2026-11-15 (were open decisions)

- IN-04: the relay blanks a message's text once it is acknowledged (Phase 75).
- Phase 69 lands only the Team Mode identity, signed log and permissions foundations; Phases 61, 62 and 62.1 go to milestone L2. `feat/team-fix-pass` is archived on GitHub (4207080, loose files committed first).
- ~~DID method `did:near`~~ revised and owner-confirmed later on 2026-11-15: `did:key` (Ed25519) for agents and machines, `did:webvh` for people and your organization's root; no `did:near` (two incompatible specifications already hold the name). Still one persistent identity per team member, with per-run grants under it (Phase 71).
- Identity, credentials and classification (owner, 2026-11-15; PROJECT.md decisions 8-13): DID documents minimal and DID Core 1.0 conformant with no custom authority blocks; authority, clearance, roles and compartments as VC 2.0 credentials with `eddsa-jcs-2022` and Bitstring Status List, a narrow profile on `node:crypto` with zero runtime dependencies (Digital Bazaar packages as devDependencies for cross-checks only), atomic and threshold credentials first, SD-JWT VC and BBS later; labels `{scale, level, compartments, releasability, handling}` with clearance dominance, a session high-water mark, scale presets (commercial, two Canadian government scales, NATO) and routing tiers per level (Restricted, Protected B and C and classified levels local only by default unless your organization approves); the gate prevents mistakes and does not accredit a device; delegation narrows on level, roles, compartments, expiry and depth at every link with nothing revoked in the chain.
- On chain (owner-confirmed 2026-11-15): NEAR's Confidential Intents private shard takes no third-party contracts or data today, so nothing readable goes on chain; one anchor account per organization writes 32-byte Merkle roots to public NEAR at fixed intervals, behind an interface that moves to a NEAR confidential backend when NEAR allows it; the chain is checked once per run (lease) and the local gate decides every action; offline edge devices fail closed after a per-level maximum offline age; HQ is issuer, DID host, status list publisher and only anchor writer, with an offline root key and pre-rotation. Calimero Network was evaluated the same day as a possible private layer (`.planning/research/platform-direction/calimero-evaluation.md`): not now (NEAR integration and peer-to-peer sync removed; 1.0 is a release-candidate confidential cloud on Intel TDX only, no offline groups, dev mode only on our AMD and NVIDIA hardware, no independent audit); revisit only if HQ moves onto Intel TDX hosting and Calimero ships a stable, audited 1.0 that supports our hardware.
- Stage 1 phases ship in 0.4.x releases as they land; 0.7.0 at the milestone's end.
- v0.8.0 Cybersecurity is deferred until everything else in this plan is finished; it may move to its own product.
- Everyone must pair before a run (PAIR-02); unpaired people get no default contract.
- Signal sidecar: re-pin by 2026-12-10 in the relay housekeeping PR.
- Later milestones in the order L1-L6; mixed NVIDIA and AMD groups may stop at per-vendor pools with request balancing (POOL-01).
- GATE-05 accepted: fully-autonomous asks before writes into `.git/` and `.near-ai/` state.
- v0.7.0 stays one milestone with three stage gates.
- AMD first: the first test hardware is an AMD Ryzen AI Max (Strix Halo) machine; every hardware-dependent step (OpenShell bring-up and GPU passthrough in Phase 72, relay images in Phase 84, the L1 appliance and local inference) is proven on AMD first, NVIDIA GB10 arm64 follows without blocking it.

### Owner decisions 2026-11-16 (agent authorization on NEAR)

Verbatim in PROJECT.md, Platform direction decisions 14-17; evidence `.planning/research/platform-direction/agent-authz-prior-art.md`.

- NEAR function-call access keys are used for agents' and nodes' on-chain calls only (option (a)): each agent or node that may write on chain gets a function-call key on your organization's account, scoped to the registry contract and only the methods its grant allows, with a small allowance; narrowing is a subset of the parent key's method list and a narrowed list is never empty (on NEAR an empty list means every method); keys are added and removed only by a person's full-access key (whether the orchestrator may prepare additions for a person to sign is an open L4 question), and the product shows the exact removal command rather than deleting keys itself (agents never delete keys on chain); the registry contract also checks the signing key against the delegation chain and revocation (both must allow; a revocation in either wins); registry methods are cheap and move no value; on-chain keys are dedicated, bound to the agent's DID by a credential (not the device key itself) and rotated. L4: ANCH-09..15.
- Off-chain capabilities (external APIs, model providers, messaging channels) are not put in the public key list, since anyone can read an account's keys and method names and that would reveal your organization's capability map (against decision 13); they stay authorized by private Verifiable Credentials checked by the Phase 73 broker, with only Merkle roots on chain (CRED-08). Option (b), a public key registry for off-chain capabilities with hashed names, was considered and declined (hashes still show key count, timing and tree shape; NEP-413 expects full-access keys; an empty list means every method; the 2,000-byte method-name cap; key sprawl and staking cost; revocation only as fast as the lease; two sources of truth).
- The trust badge check runs automatically on every answer from a TEE model, one signature request per answer, the attestation reused for 10 minutes (CLAS-08; already in Phase 70 plans 24-27).
- Borrowed from prior art: UCAN 1.0's invocation format (issuer, subject, command, arguments, proof chain, nonce, short expiry), its receipts for the audit trail and its revocation rules; ERC-7715 typed permission shapes and human-readable approval; ERC-7710 one enforcer per restriction type; MCP 2025-11-25 audience binding at the broker (one audience per credential and lease, the agent's token never passed through, 403 `insufficient_scope` so a person can grant more); RFC 9421 signed HTTP requests against replay elsewhere. Any reuse of NEP-413's message format uses our own tag and recipient, documented, because NEP-413 expects full-access keys.

### Naming trap

- This milestone's relay is the messaging relay at `relay/`: NOT the paused v0.5.0 ciphertext sync relay (RELAY-01/02 archived in `.planning/milestones/v0.5.0-paused/`) and NOT `relayTransport.ts` board sync (unmerged branch; superseded by L5's federation transport).
- REQ-ID collisions: v0.5.0 used RELAY-01/02 for ciphertext sync (scoped as "v0.7.0 RELAY-01/02"). v0.6.0 uses TEAM-01..04 and SETUP-01 with other meanings; carried v0.6.0 ids take a `TM-` prefix (TMR-04).

### Reuse pointers

- Durable restart: `src/services/runMarkers.ts` (NOT `runActivity.ts`); `AUTO_RESUME_WITHIN_MS`=12h, `MAX_AUTO_RESUMES`=3.
- `src/agent/` has zero `vscode` imports: the reuse surface for headless composition. `src/services/chat.ts` is UI-bound; the relay must NOT import it.
- Team Mode core (identity, signed log, permissions) on the archive branch: `src/team/`, `src/domain/team/` (Phase 60 SUMMARY files are the spec).
- Local models and private routing to build on: `src/domain/auth.ts` (local and hybrid profiles), `src/services/providerFactory.ts`, `privateRouteFor` in `src/services/providerCache.ts`, `src/domain/privacy.ts`.
- OpenShell spike: `.planning/research/platform-direction/openshell-spike.md` and `openshell-spike/` (policies, DID drafts, the delegation verifier draft, escape tests).

### Research flags (embedded in phases)

- Phase 69: per-file port strategy from a 0.4.11 fork; two private git mirrors (Team Mode and sync) must not collide.
- Phase 70: capability grammar, label format and policy bundle format (high undo cost); how the relay shares the vocabulary; a fresh install's default label keeps today's routing; NATO preset and the two Canadian scales confirmed by your organization's security officer; Protected B local only by default (no CCCS Medium assessment of NEAR AI Cloud found); not accreditation.
- Phase 71: research step first (JCS conformance against the W3C vectors, `did:webvh` hosting and caching before HQ exists, status list sizing); spend as running totals; threshold credentials leak the maximum level when all are shown; revocation lag until `validUntil`; not post-quantum (name the cryptosuite in every proof); one clock helper for expiry.
- Phase 71: (9) keep the device binding credential able to name a NEAR account, a public key and its allowed methods, so L4's DID-bound on-chain keys need no profile change.
- Phase 72: start with an in-extension integration spike; OpenShell 0.1.x pinning and attestations; gateway size; AMD GPU needs a Strix Halo hardware test; macOS untested.
- Phase 73: signed invocations in the UCAN 1.0 shape with audience binding and receipts (where the invocation is signed, the nonce record, one broker with OpenShell's endpoint binding, NEP-413 layout only with our own tag and recipient); the broker as a single point of failure and the one store of every real credential.
- Phase 74: clock trust for expiry on edge devices without network time (also used by Phase 71's credential expiry).
- Phase 76: Teams field paths against a live tenant; proactive 1:1 install scope (highest derail risk; fallback carried to Phases 81 and 84).
- Phase 77: headless composition with gate and contracts is a spike; Teams in-group streaming is undocumented (post-don't-stream fallback).
- Phase 82: pin and verify signal-cli; arm64 sidecar image.
- L2: encrypt Team Mode event payloads to member device keys over the existing git transport, signatures and hashes in clear (Calimero evaluation's recommendation).
- L4: NEAR confidential shard takes no third-party contracts or data today, permissioned trust model, conflicting secondary claims; Calimero not now (revisit conditions recorded); roots written at fixed intervals so timing reveals nothing; HQ issuer key compromise; not post-quantum; anchoring cost. From the prior-art report (2026-11-16): privacy of the public key list, key sprawl and staking cost, revocation latency, the key-adding power as the prime target (how the orchestrator adds keys without holding a full-access key), the broker as a single point of failure, the other NEAR rules (NEP-413 needs full-access keys, the method-name cap, stolen keys spending their allowance, two sources of truth, untrusted free RPC), and how the registry contract checks a delegation chain with nothing readable on chain.
- L5: offline revocation lag and per-level maximum offline age; device clocks drift offline; federation over the encrypted git transport.

### Blockers/Concerns

- `feat/team-fix-pass` is archived on GitHub at 4207080 (its five loose files were committed first); Phase 69 ports from it.
- Signal sidecar pin: re-checked 2026-11-15 (0.101 is still the newest stable release; signal-cli 0.14.8 expires about 2026-12-10). Next check 2026-12-01; if no newer release exists then, the owner decides how to re-pin before 2026-12-10.

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 261113-lbo | fix the chat task list not checking off finished tasks | 2026-11-13 | a770848 | [261113-lbo-fix-the-chat-task-list-not-checking-off-](./quick/261113-lbo-fix-the-chat-task-list-not-checking-off-/) |

## Notes

- v0.5.0 (trusted-source knowledge base) is paused and moving to a separate project. Archive: `.planning/milestones/v0.5.0-paused/`. Code: local branch `gsd/phase-13-sovereignty-gate-post-quantum-cryptography-and-the-encrypted` (not pushed).
- Release checklist for 0.4.x: tsc, lint, full `npm test`, full `npm run test:e2e` (both scenarios), `npm run verify:release`, then publish only with the owner's OK for that version.

## Session

**Last session:** 2026-11-15T22:12:24.647Z
**Stopped at:** Completed 69-15-PLAN.md (PR 2 open from feat/team-signed-payloads into main, rebased and gated; waiting for the owner's review and merge)
**Resume file:** None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 27 P02 | 13 min | 3 tasks | 12 files |
| Phase 27 P01 | 8 min | 3 tasks | 7 files |
| Phase 27 P03 | 11min | 3 tasks | 15 files |
| Phase 27 P04 | 11 min | 3 tasks | 12 files |
| Phase 27 P09 | 28min | 3 tasks | 11 files |
| Phase 27 P11 | 9 min | 3 tasks | 8 files |
| Phase 27 P05 | 10 min | 3 tasks | 9 files |
| Phase 27 P17 | 11 min | 3 tasks | 7 files |
| Phase 27 P06 | 20 min | 3 tasks | 14 files |
| Phase 27 P07 | 10 min | 3 tasks | 9 files |
| Phase 27 P08 | 6 min | 2 tasks | 6 files |
| Phase 27 P10 | 16 min | 3 tasks | 10 files |
| Phase 27 P12 | 70min | 3 tasks | 12 files |
| Phase 27 P13 | 65min | 3 tasks | 11 files |
| Phase 27 P14 | 40min | 3 tasks | 13 files |
| Phase 27 P15 | 30 min | 3 tasks | 21 files |
| Phase 27 P18 | 25min | 3 tasks | 14 files |
| Phase 27 P19 | 8 min | 2 tasks | 3 files |
| Phase 27 P20 | 25 min | 2 tasks | 4 files |
| Phase 27 P21 | 25min | 2 tasks | 2 files |
| Phase 27 P22 | 34 min | 3 tasks | 10 files |
| Phase 68 P01 | 70min | 3 tasks | 15 files |
| Phase 68 P02 | 25min | 2 tasks | 7 files |
| Phase 68 P03 | 10min | 2 tasks | 3 files |
| Phase 68 P04 | 35min | 2 tasks | 9 files |
| Phase 68 P05 | 25min | 3 tasks | 6 files |
| Phase 68 P06 | 30min | 3 tasks | 9 files |
| Phase 68 P07 | 40min | 3 tasks | 6 files |
| Phase 69 P01 | 25min | 2 tasks | 10 files |

## Decisions

- [Phase 27]: 27-02: mergeRecordSets is a set function (family grouping, dedupe by rev, supersede, tombstones, canonical fork placement), not a pairwise fold, so merge order cannot change the result
- [Phase 27]: 27-02: the newest tombstone of each id is always kept and liveRecords() hides it; thread entries are keyed by (thread,id) and the earliest copy is kept
- [Phase 27]: 27-01: recovery code is 256 random bits, 52 Crockford characters in 13 groups of 4, zero pad bits refused when non-zero (owner, D-18); sync format is symmetric-only so post-quantum safe by construction
- [Phase 27]: 27-01: kdf bounds also cap scrypt memory at 256 MiB; the 1 MiB manifest cap binds before the 10 000-entry cap (about 5 000 entries)
- [Phase 27]: 27-03: exclusive create is temp file plus hard link (wx fallback), so a reader never sees a partial key or meta file; ensure() repairs a missing inner .gitignore
- [Phase 27]: 27-03: a SecretStorage data key is trusted only against meta.keyCheck; transcriptKey() is the writer path, dataKey() the non-creating reader path
- [Phase 27]: 27-03: the sealed NEAR AI key copy is asked once per scope per host, released only to its sealed endpoint; no sync remote setting declared (D-09)
- [Phase 27]: 27-04: run liveness across editors by writer id plus 30 s heartbeat; the pid is trusted only for the same editor, any other editor's run is live while its marker is under 3 minutes old — A pid from another editor lives in another pid namespace (code-server container); trusting it caused double spend
- [Phase 27]: 27-04: only this editor's cut-off markers reach autoResumeChoice; another editor's cut-off run keeps its Resume button (SYNC-07); markers written to the old per-extension storage by 0.4.19 are no longer read — Spending money on a foreign run always takes the person's click (D-03)
- [Phase 27]: 27-04: checkpoints are format 2 (root-relative inside the project, absolute and marked outside), a relative path that is absolute or climbs out is refused on load; sub-agent worktrees stay in the editor's own storage — Checkpoints must be portable between editors and machines without a revert ever writing outside the project (T-27-17)
- [Phase 27]: 27-09: import offer lists only settings with no project choice, so an existing project choice is never replaced by the import
- [Phase 27]: 27-09: applying with no folder open and no explicit workspace value is refused rather than writing user settings (D-06)
- [Phase 27]: Sync commit identity is near-ai-state at the constant date 2000-01-01, set only on commit-tree; runStateGit refuses commit-tree without all six identity pairs
- [Phase 27]: Remote-facing StateTransport methods return Outcome<T> with a SyncFailure of one plain sentence; local reads throw StateRefusedError; MirrorBusyError propagates for the caller to word
- [Phase 27]: Remote addresses are validated when typed and again when a configured name resolves, so a hostile repository remote such as ext:: is refused
- [Phase 27]: Inherited GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_CONFIG*, GIT_AUTHOR_* and GIT_COMMITTER_* are stripped inside runStateGit before options.env is applied
- [Phase 27]: 27-05: new thread entries chain from the entry the conversation last wrote or was opened at (ThreadStore.cover), not the log's global main-line tip, so a continuation made elsewhere becomes a branch — Chaining from the global tip would adopt another editor's concurrent entries into this conversation's lineage; an un-covered store re-chains from the start and entry ids dedupe
- [Phase 27]: 27-05: the thread log is captured before manageContext and on every save; a capture failure never stops a run, and managed messages are marked logged only when their originals were captured — The log must hold the untrimmed originals (D-07) without ever making a model run depend on disk writes
- [Phase 27]: 27-05: the history list and panel read only the state home; sessions saved under an editor's globalStorage stay unlisted until plan 10's migration — The old transcript store stays only for its key helpers; migration re-seals old transcripts under the project data key
- [Phase 27]: 27-17: the online-home flow keeps the GitHub token in one local variable (API Authorization header, or a runner wrapper adding GIT_CONFIG_* to the git child environment for https://github.com/ only) and saves only step, method, repo and startedAt; progress step is the last one finished and resume checks getRepo before it would ever create
- [Phase 27]: 27-17: the person's own code push uses a separate plain git runner (their hooks and config) behind a file list and secret check, and is its own question after the sync step; a folder inside another repository and a pasted address with a password or token are refused
- [Phase 27]: 27-06: the conversation log pins reopened-thread transcript entries when it trims live output, so no history is cut off
- [Phase 27]: 27-06: tool steps are paired with results by nearest earlier call id, and a tool card loads its output (textContent in a pre) only when first opened
- [Phase 27]: 27-06: a reopened thread reaches the page in batches of 200 and is drawn 50 per animation frame; later host messages queue behind it
- [Phase 27]: 27-07: reopening an archived thread touches it (lastUsedAt = now) so it ranks first; restores asked for by the rank rule or crash recovery keep its own last-use time
- [Phase 27]: 27-07: archive removal of live files is refused when log size, context.enc or meta.enc changed since the snapshot; retention also restores archived threads the rank rule puts live
- [Phase 27]: 27-08: a prompt that never reached the model (no folder, no profile, held back by the outbound guard) is not stored; a pre-0.4.20 session's one-time seed is stored even then
- [Phase 27]: 27-08: Chat view thread tail match also requires the preceding user text to equal the newest prompt and only considers a live newest chat-view thread; otherwise a new thread starts
- [Phase 27]: 27-08: a thread with a log and no saved context is reopened by building its context from the log main line; a run adds the panel system prompt when history has none
- [Phase 27]: Each record kind merges by its own id and rule (thread entries by union, markers by last sign of life, checkpoints and comparisons when absent or later, spend by entry id and version), so a rerun writes nothing and editor order does not matter
- [Phase 27]: Spend lines are selected by entry id, not by the project tag on each line, and unionLog is keyed by (entry id, version): later versions of a ledger entry carry no project tag and the first line holds the entry's time and path
- [Phase 27]: The old transcript key is read from SecretStorage without creating one; a sealed transcript with no key is counted locked and retried at the next start; the source folder is opened read-only
- [Phase 27]: Migration runs at activation only for a NEAR AI project, otherwise on the first chat send, history list or Compare Models open, and before saved tabs reopen; it logs counts only
- [Phase 27]: Sync pushes through the transport without holding the mirror lock itself; an in-process queue serialises sync/pull/unlock and MirrorBusyError is the waiting outcome
- [Phase 27]: SyncOutcome gains a failed kind carrying the transport SyncFailure so offline, sign-in and policy failures reach the scheduler
- [Phase 27]: Remote index entry counts must be covered by what this computer holds after reading every listed object, and the manifest state id must equal the project's; otherwise the bundle is refused before any write
- [Phase 27]: A changed local record is built as an edit of the remote head (makeRecord base) so one writer never forks against itself; spend months are united by line, not decided by newer-wins
- [Phase 27]: unlockFromRemote verifies the unwrap and manifest before the state home exists; a computer with remote state and no key of its own is refused as locked, never given a fresh key
- [Phase 27]: One cold object per thread: an archive is added as a cold object only when the remote index lists none for the thread; later entries travel hot or beside the archive
- [Phase 27]: Hot consolidation is built from the old hot objects, kept only if it holds every entry and record they held plus what the push sends; cold objects are never consolidated away; the 200-object rule is replaced by 20 hot objects or twice the live size
- [Phase 27]: Size limits stop new uploads and never delete: a warning from 500 MB, no new cold object from 1 GiB or 3500 listed objects, and the message says how many conversations stay on this computer only
- [Phase 27]: An archive that cannot be opened is explained in plain words and opens nothing; every write to that thread is refused, so an empty view is never saved over it; the archive files are not touched
- [Phase 27]: 27-14: the pick-up card shows only for a pointer from another editor newer than the last seen; its click calls only openSaved (never resume, auto-resume or a model request); a run marker carries waitingSince while a prompt is open
- [Phase 27]: Consent comes before the recovery code in turn-on: what the git host can and cannot see is confirmed first, and the wrap is written only after the person says the code is saved, so declining anywhere writes nothing.
- [Phase 27]: A remote address's userinfo is never written to the mirror config or passed as a git argument: git gets the credentialed form per call as a url insteadOf rewrite in its environment, and automatic syncs ask GitHub silently (only a click may prompt).
- [Phase 27]: A new recovery code is carried by a pending flag and named by the sealed index, so an older computer adopts the newer wrap instead of pushing its own back.
- [Phase 27]: Joining a synced project from a computer with chats builds a re-keyed copy beside the state home and swaps by two renames, keeping the original until a sync worked.
- [Phase 27]: 27-18: the sync control reuses 27-15's status and commands; Needs attention shows its plain sentence with one Sync Project Now button; the Turn on sync invitation appears only while sync is off, once on screen (first-run screen or pick-up card), dismissal stored per project in workspaceState nearAi.sync.promptDismissed
- [Phase 27]: 27-18: the first-run invitation goes into the whole welcome section so a computer with no connected profile yet still sees it; the pick-up card also shows 'Checking for updates…' while the pull on open runs
- [Phase 27]: 27-19: an older build's comparison mode run is read as rerun by one frozen LEGACY_RUN_MODES table inside parseSavedRun; every reader (store, migration, sync records) goes through it, guarded by a source test
- [Phase 27]: 27-20: default branch moves only away from near-ai/state, only after a pushed code result; pasted address names the setting (no API); sync still pushes near-ai/state only
- [Phase 27]: 27-21: code push holds NEAR AI per-person records back by default; allowlist team.md, project.json, verifiers.json; tracked records named or blocked on public
- [Phase 27]: 27-22: the profile and sync chips wrap their own text at every width (never an ellipsis) and the bar wraps at every width; a row break up to 480 px puts the pickers on the next row
- [Phase 27]: 27-22: controls a person must read whole carry data-must-read; the test-only layout probe reports clipped ones and the extension-host layout test fails on them in all five sync states at every side bar width
- [Phase 68]: D-20 answered by the owner: relay pins jose 6.2.17 and @types/node 26.6.6 (newest pair)
- [Phase 68]: Relay prints nothing and exits 1 on any failed start until plan 02's redacting logger exists (D-11)
- [Phase 68]: Redaction order is secrets, then phones, then the 500-character cut; the Logger keeps time, level and event reserved and writes colliding field names as field_{key}
- [Phase 68]: onRejected receives only a plain upper-case method token or OTHER, so client text cannot reach a log line
- [Phase 68]: Plan 68-04: schema v1 holds all five aggregates; crash writer is permit-driven so a kill lands within one message of the last ack; claimed messages return to queued on open
- [Phase 68]: 68-05: a conversation binding is never moved to another tenant (binding-conflict); approval answers succeed only strictly before expiresAt
- [Phase 68]: 68-06: plain-secret refusal runs before the state directory is created; secrets come only from {NAME}_FILE, CREDENTIALS_DIRECTORY or /run/secrets; phone-label key is SHA-256 of LOG_PSEUDONYM_KEY or a 0600 log-pseudonym.key created once
- [Phase 68]: 68-07: relay image code folder staged as /app-skel in the build stage (files 0444, folder 0555) because COPY --chmod also hit the /app folder
- [Phase 68]: 68-07: container suite checks files and links for shells and package managers, not the base image's empty etc/dpkg and var/lib/dpkg folders; docker build runs without --memory (BuildKit has no such flag)
- [Platform, 2026-11-15]: Owner accepted the platform direction (PROJECT.md, "Platform direction", decisions 1-6): no IronClaw fork, our engine gains the DID governance layer, offline gate from a signed local copy that fails closed, edge grouping and HQ federation, Theia container appliance first, outside projects as design sources only, the OpenShell spike, the v0.7.0 replan, NVIDIA and AMD GPUs with linked machines and a NEAR AI Cloud burst
- [Platform, 2026-11-15]: v0.7.0 stays one milestone (owner asked for v0.7.0 to be replanned; Phase 68 ships as v0.7.0; the relay depends on the governance phases in one chain) in three stages with a gate before the relay runs tools; relay phases renumbered 75-84
- [Platform, 2026-11-15]: Team Mode's Phase 60 core lands on main in Phase 69, ported onto current main rather than merging the 0.4.11-based branch; Phases 61, 62 and 62.1 wait for milestone L2 unless the owner decides otherwise
- [Platform, 2026-11-15]: The OpenShell spike's apply-path finding (downloads keep symlinks) makes the guarded apply a requirement (EXEC-03); the prover cannot prove sub-folder narrowing, so generated policies use a fixed file-path vocabulary (EXEC-05)
- [Platform, 2026-11-15]: Identity, credential and classification design approved by the owner (PROJECT.md, Platform direction decisions 8-13): standard minimal DIDs, VC 2.0 credentials with `eddsa-jcs-2022` and Bitstring Status List in a zero-dependency narrow profile, classification labels with clearance dominance, high-water mark and routing by label, delegation narrowing at every link; folded into Phases 70 and 71 and L4 and L5
- [Platform, 2026-11-15]: DID methods `did:key` (agents, machines) and `did:webvh` (people, your organization's root) replace `did:near`; owner-confirmed the same day
- [Platform, 2026-11-15]: Roots-only anchoring on public NEAR behind an anchor interface until NEAR's confidential shard accepts third-party data; owner-confirmed; asking NEAR in writing stays an open owner action
- [Platform, 2026-11-15]: Verifiable credentials get the prefix VCRD because CRED is the credential broker (Phase 73); the `eddsa-jcs-2022` proof is a second proof format on Phase 69's one signer, so Phase 69's plans do not change
- [Platform, 2026-11-16]: NEAR function-call access keys only for agents' and nodes' on-chain calls (option (a)): per agent or node, on your organization's account, scoped to the registry contract and the grant's methods, small allowance, non-empty subset narrowing, added and removed only by a person's full-access key (or the orchestrator under delegated authority) with the removal command shown, double check in the registry contract, cheap value-free methods, dedicated DID-bound rotated keys (PROJECT.md decision 14; L4 ANCH-09..15)
- [Platform, 2026-11-16]: Off-chain capabilities stay in private credentials checked by Phase 73's broker, never in the public key list; option (b), a public key registry with hashed names, considered and declined (PROJECT.md decision 15; CRED-08)
- [Platform, 2026-11-16]: The trust badge check runs automatically on every answer from a TEE model, one signature request per answer, the attestation reused for 10 minutes (PROJECT.md decision 16; CLAS-08)
- [Platform, 2026-11-16]: Borrowed from prior art: UCAN 1.0 invocations, receipts and revocation rules, ERC-7715 permission shapes and approval, ERC-7710 one enforcer per restriction, MCP 2025-11-25 audience binding at the broker, RFC 9421 request signatures; NEP-413's layout only with our own tag and recipient (PROJECT.md decision 17)
