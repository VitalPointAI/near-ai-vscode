---
phase: "70"
slug: "capability-vocabulary-manifests-and-one-gate-with-a-floor"
status: draft
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
- **Before each PR and before `/gsd-verify-work`:** one full `npm test` and one `npm run test:e2e`, capped, one heavy run at a time.
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
| GATE-07 | one record per decision kind; shape validator; redaction; write failure never blocks; size rotation | unit | `gateRecords.test.js` | Wave 0 |
| OFFL-01 | every decision with `fetch`, `net`, `dns`, `http(s)` stubbed to throw | unit | `gateOffline.test.js` | Wave 0 |
| OFFL-02 | missing, unparseable, unsigned, tampered, wrong-purpose, revoked, rotated, expired, clock-behind, identity-unavailable each give floor plus read and plan and the plain sentence; fresh install self-signs; two-window lock; deleted-bundle marker; key-lost default re-sign | unit + integration | `gateBundle.test.js` | Wave 0 |
| OFFL-03 | version, expiry, issuer, reserved fields shape-checked, unknown field refused, renewal window | unit | `gateBundle.test.js` | Wave 0 |
| CLAS-01 | label shape, unknown scale, level, field refused; resolution order; unverified map raises only | unit | `gateLabels.test.js` | Wave 0 |
| CLAS-02 | four presets exactly; mappings only from bundle | unit | `gateLabels.test.js` | Wave 0 |
| CLAS-03 | dominance five conditions; property test with seeded generator | property | `gateDominance.test.js` | Wave 0 |
| CLAS-04 | mark raises, never lowers; sub-agent shares; writes inherit; rename moves entry; declassify records a reason | unit + integration | `gateMark.test.js` | Wave 0 |
| CLAS-05 | default routing table by `scale/level`; handling and compartments; join of two scales takes the strictest | unit | `gateRouting.test.js` | Wave 0 |
| CLAS-06 | guard before `fetchFn` on every content path; local-only with no local client or non-loopback host refused; mark rising mid-run refuses next request; hybrid; attestation after-the-fact record | integration | `gateRouteGuard.test.js` | Wave 0 |
| CLAS-07 | exact wording present in SECURITY.md and the label command text | docs | `gateDocs.test.js` | Wave 0 |
| boundary | `src/domain/gate` and `src/gate` import rules | scan | extend `teamBoundaries.test.js` | exists, edit |


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

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Your organization's security officer confirms the NATO list and the two Canadian scales | CLAS-02 | Sources are secondary; a person must confirm before relying on them | Read the presets in the bundle and SECURITY.md; record the confirmation |
| Fresh install on code-server signs its first bundle and the extension stays usable | OFFL-02 | Secrets live in the browser on code-server; covered by unit tests with stubs, confirmed by the owner on a real host BEFORE publishing any release that carries PR 2 (D-48) | Install the released 0.4.x on a clean code-server profile, open a project, run a chat and one edit |
| The status bar and refusal texts read plainly | OFFL-02, CLAS-06 | Wording judgement | Unplug the network, break the bundle, read the texts |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 120 seconds
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
