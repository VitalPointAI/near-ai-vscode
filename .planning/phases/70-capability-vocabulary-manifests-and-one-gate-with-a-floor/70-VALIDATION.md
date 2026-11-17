---
phase: "70"
slug: "capability-vocabulary-manifests-and-one-gate-with-a-floor"
status: draft
# Known draft until execution: the plan checker passed on 2026-11-16; sign-off is completed by /gsd-validate-phase after the phase runs (as with Phases 68 and 69).
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-16"
---

# Phase 70: Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` with `node:assert/strict`, TypeScript compiled by `tsc` |
| **Config file** | `tsconfig.json` (`rootDir: src`, `outDir: dist`); runner `scripts/run-tests.mjs` |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js'` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 npm test`; e2e: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 npm run test:e2e` under xvfb with Wayland variables stripped |
| **Estimated runtime** | quick: under 60 seconds per file; full suite and e2e: run once at the phase boundary |

---

## Sampling Rate

- **After every task commit:** the one or two `dist/test/gate*.test.js` files the task touches, through the quick run command.
- **After every plan wave:** all `dist/test/gate*.test.js` plus the parity set (`autoApproval`, `agentLoop`, `protectedPaths`, `untrusted`, `unattendedApproval`, `mcp`, `toolsPage`, `commandSafety`, `teamSignedPayload`, `teamBoundaries`) in one capped run.
- **Before each PR and before `/gsd-verify-work`:** one full `npm test` and one `npm run test:e2e`, capped, one heavy run at a time. Part 4 has five PRs (D-49), so this runs once in each close-out plan, 70-28a to 70-28e.
- **Immediately blocking:** floor, authorization, bundle signature and routing tests; never deferred to the phase gate.
- **Max feedback latency:** about 120 seconds per task.

---

## Requirement to Test Map (from 70-RESEARCH.md)
| Req ID | Behavior | Test Type | Automated Command (file) | File Exists? |
|--------|----------|-----------|--------------------------|-------------|
| GATE-01 | closed vocabulary; unknown verb, field, type, version refused; `gpu` refused; frozen vectors; integers only | unit + golden | `gateVocabulary.test.js` | Wave 0 |
| GATE-02 | every tool of `builtInTools()` has a valid manifest; shorthand matches except the listed probes; source scan finds no tool file outside the catalog | unit + scan | `gateManifests.test.js` | Wave 0 |
| GATE-03 | MCP: restrictive default effects, stdio label, never non-interactive unless named, legacy parity, manifest words | unit | `gateMcpManifests.test.js` (+ `mcp.test.js` unchanged) | Wave 0 |
| GATE-04 | `tool.run` call-site allow-list; `new AgentRun(` passes `gate`; scripted run per verb records a decision before execution; cyber path gated; card is transport (no card decides) | scan + integration | `gateEnumeration.test.js` | Wave 0 |
| GATE-05 | floor matrix: rule x mode x presence; no always-allow; no grant; refusal list incl. fake home credential stores; effect tags survive wrappers | unit + integration | `gateFloor.test.js`, `commandEffects.test.js` | Wave 0 |
| GATE-06 | fully-autonomous decisions inside grant; docs parity (SECURITY.md and README strings) | unit + docs | `gateFloor.test.js`, `gateDocs.test.js`; changed `protectedPaths.test.js` | partly (the changed test exists) |
| GATE-07 | one record per decision kind; shape validator; redaction; write failure never blocks; size rotation; part 4: an infer record per model request (short when routine, no host or path), every part 4 id named, label and route events | unit | `gateRecords.test.js`, `gateRecordIds.test.js`, `gateRouteGuard.test.js` | Wave 0 |
| OFFL-01 | every decision with `fetch`, `net`, `dns`, `http(s)` stubbed to throw; part 4: route decisions from cached facts only, binding refresh and answer checks out of band, badge checks settled by a timeout | unit | `gateOffline.test.js`, `gateRouteGuard.test.js`, `gateConnectionBinding.test.js`, `gateTrustBadge.test.js` | Wave 0 |
| OFFL-02 | missing, unparseable, unsigned, tampered, wrong-purpose, revoked, rotated, expired, clock-behind, identity-unavailable each give floor plus read and plan and the plain sentence; fresh install self-signs; two-window lock; deleted-bundle marker; key-lost default re-sign | unit + integration | `gateBundle.test.js` | Wave 0 |
| OFFL-03 | version, expiry, issuer, reserved fields shape-checked, unknown field refused, renewal window | unit | `gateBundle.test.js` | Wave 0 |
| CLAS-01 | label shape, unknown scale, level, field refused; resolution order; unverified map raises only and is never signed again without asking; an unreadable map holds reads; renames | unit + integration | `gateLabels.test.js`, `gateLabelStore.test.js` | Wave 0 |
| CLAS-02 | four presets exactly; mappings only from bundle | unit | `gateLabels.test.js` | Wave 0 |
| CLAS-03 | dominance five conditions; property test with seeded generator; part 4: refused on every read path (file tools, Glob and Grep, shell words, unknown effects, a failed-closed policy, cyber steps); clearances added by a signed draft | property + integration | `gateDominance.test.js`, `gateLabelReads.test.js`, `gateLabelCommands.test.js` | Wave 0 |
| CLAS-04 | mark raises at the shared hook, never lowers; sub-agent shares; writes inherit; runs with no chat get their own; kept with the chat; a merge is raise-only; a lowering from another copy applies only signed by a key valid then and only when it undoes no raise (higher other mark kept, forged, unsigned and revoked-key lowerings ignored, each recorded); declassify records a reason | unit + integration | `gateMark.test.js`, `gateChatLabel.test.js` | Wave 0 |
| CLAS-05 | default routing table by `scale/level`; handling and compartments; join of two scales takes the strictest | unit | `gateRouting.test.js` | Wave 0 |
| CLAS-06 | guard before `fetchFn` on every content path and every production site (4a); local-only with no local client or non-loopback host refused and hybrid judged per client (4b, D-57); mark rising mid-run refuses next request (4c); every strict refusal names the way out (4c) | integration | `gateRouteGuard.test.js`, `gateRouteTiers.test.js`, `gateMark.test.js` | Wave 0 |
| CLAS-05 (owner amplification) | attested-cloud sent only with a fresh bound connection fact, else local-only or refused before fetch (4a, with no source until 4d); the NEAR source against fixture reports and a local TLS server; the pinned handshake refuses another certificate before the request is written; refresh out of band, deduplicated; each attested answer checked afterwards through the 10-minute report cache, a failed check stops the level for the chat until Check again passes (4d) | unit + integration | `gateRouting.test.js`, `gateConnectionBinding.test.js`, `gateRouteTiers.test.js` (+ `attestation.test.js` unchanged in meaning) | Wave 0 |
| CLAS-07 | exact wording present in SECURITY.md and the label command text; each PR's docs say only what that PR enforces (4b: labels do not change routing yet; 4c: the labels and routing section; 4d: the connection and answer checks; 4e: the badge) | docs | `gateDocs.test.js`, `gateCommands.test.js`, `gateLabelCommands.test.js` | Wave 0 |
| CLAS-08 | three badge states from checks that ran; exhaustive never-stronger test; one check per answer, settled by a 20-second timeout; lead answers only; details and full attestation; theme rules; replayed on reload with a weaker-wins merge; rendered in the real chat page | unit + page harness + e2e | `gateTrustBadge.test.js`, `gateDocs.test.js`, the e2e badge test in `src/test/e2e/suite.ts` | Wave 0 |
| boundary | `src/domain/gate` and `src/gate` import rules | scan | extend `teamBoundaries.test.js` | exists, edit |


---

## Part 4 delivery map (replanned 2026-11-17, D-49)

Each of the ten requirements part 4 touches, the PR and plan that complete it, and the test files that prove it. The full map of every part is in COVERAGE.md ("Part 4 requirement map"); 70-28e fills in the merged PR numbers and the test files the plans actually created.

| Req ID | Completed in (PR, plan) | Earlier parts (PR, plan) | Test files | Gate before the PR opens |
|--------|-------------------------|--------------------------|------------|--------------------------|
| CLAS-01 | 4c, 23 | 4b, 20; 4c, 22 | `gateLabelStore`, `gateMark`, `gateChatLabel` | 70-28c full gate |
| CLAS-02 | 4c, 24 | PR 1, 02 and 03; 4b, 20 and 21 | `gateLabels`, `gateLabelStore`, `gateLabelCommands`, `gateDocs` | 70-28c full gate |
| CLAS-03 | 4b, 21 | 4b, 20 | `gateDominance`, `gateLabelReads`, `gateLabelCommands` | 70-28b full gate |
| CLAS-04 | 4c, 23 | 4c, 22 | `gateMark`, `gateChatLabel`, `teamSignedPayload` | 70-28c full gate |
| CLAS-05 | 4d, 25 | 4a, 19; 4b, 21 | `gateRouting`, `gateRouteTiers`, `gateConnectionBinding` | 70-28d full gate |
| CLAS-06 | 4c, 24 | 4a, 19; 4b, 21; 4c, 22 | `gateRouteGuard`, `gateRouteTiers`, `gateMark` | 70-28c full gate |
| CLAS-07 | 4e, 27 | 4b, 20 and 21; 4c, 24; 4d, 25 | `gateDocs`, `gateCommands`, `gateLabelCommands` | 70-28e full gate |
| CLAS-08 | 4e, 27 | 4e, 26 | `gateTrustBadge`, `gateDocs`, e2e badge test | 70-28e full gate with e2e |
| GATE-07 | 4d, 25 | 4a, 19; 4b, 20 and 21; 4c, 22 and 23 | `gateRecordIds`, `gateRecords`, `gateRouteGuard`, `gateLabelStore`, `gateChatLabel`, `gateRouteTiers` | 70-28d full gate |
| OFFL-01 | 4e, 26 | 4a, 19; 4d, 25 | `gateOffline`, `gateRouteGuard`, `gateConnectionBinding`, `gateTrustBadge` | 70-28e full gate |

---

## Per-Task Verification Map

Filled from the plans: every task's `<automated>` command runs one of the test files above under the memory cap. The plan checker confirms each requirement row above is proved by at least one task.

---

## Wave 0 Requirements

- [ ] `src/test/gate*.test.ts` files listed above (none exist yet)
- [ ] a seeded xorshift helper inside the dominance property test (no dependency)
- [ ] a fake-home helper and a `testTool()` fixture helper in `src/test/helpers/`
- [ ] `src/agent/toolCatalog.ts` (production code the enumeration tests depend on)
- [ ] a docs-parity test pattern for SECURITY.md and README (new)
- [ ] `src/test/helpers/attestationFixtures.ts` (quote fixtures shared by the attestation and connection binding tests; plan 25, PR 4d)

---

## Manual-Only Verifications

| Behavior | Requirement | When (part 4 PR) | Why Manual | Test Instructions |
|----------|-------------|------------------|------------|-------------------|
| Your organization's security officer confirms the NATO list and the two Canadian scales | CLAS-02 | after 4b ships (Set Label first offers the scales) | Sources are secondary; a person must confirm before relying on them | Read the presets in the bundle and SECURITY.md; record the confirmation |
| Fresh install on code-server signs its first bundle and the extension stays usable | OFFL-02 | before publishing every release that carries PR 2 or later, so each of 4a to 4e is a release blocker (D-48) | Secrets live in the browser on code-server; covered by unit tests with stubs, confirmed by the owner on a real host BEFORE publishing | Install the 0.4.x to be released on a clean code-server profile, open a project, run a chat and one edit |
| The status bar and refusal texts read plainly | OFFL-02, CLAS-06 | after 4b (clearance refusals) and 4c (route refusals, the chat's label) | Wording judgement | Unplug the network, break the bundle, label a file above your clearance and read the texts; read a Restricted file in a chat with no local model and read the refusal |
| What NEAR AI Cloud's attestation exposes about the connection key is confirmed against the live service | CLAS-05 | 4d | Plan 25's research step records the finding and its sources; a live comparison needs the network and a key | Read the "NEAR AI Cloud connection binding" finding in 70-25-SUMMARY.md and the 4d PR body; if the live comparison was not made there, run one Confidential chat on NEAR AI Cloud and read the answer's Verify signature result |
| The trust badge reads plainly in light, dark and high contrast themes | CLAS-08 | 4e | Visual judgement; the CSS test only proves theme variables and a high-contrast border | Switch between a light, a dark and a high contrast theme with a chat that has each badge state, click each badge and read its details |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 120 seconds
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
