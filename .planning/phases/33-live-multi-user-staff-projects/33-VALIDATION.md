---
phase: "33"
slug: "live-multi-user-staff-projects"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-21"
---

# Phase 33: Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 33-RESEARCH.md, "Validation Architecture".

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` through `scripts/run-tests.mjs` (extension, Node 24); the hub's own `node:test` run in `hub/` (Node 26.13.1) |
| **Config file** | none; `tsconfig.json` compiles `src/**/*.ts` to `dist/`; `hub/scripts/build.mjs` bundles hub tests |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-tests.mjs dist/test/<file>.test.js` after `npx tsc -p tsconfig.json` |
| **Hub run command** | `cd hub && npm run build && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 600 env NODE_OPTIONS=--max-old-space-size=1536 node ../scripts/run-tests.mjs dist/test/<file>.test.js` on Node 26 |
| **Full suite command** | closing plan only, under the heavy lock: the same wrapper with `MemoryMax=6G`, `timeout 1800`, `npm test`; then e2e, `npm run verify:release`, `node scripts/secret-scan.mjs`, one at a time |
| **Estimated runtime** | quick: under 60 s per file; hub file: under 120 s; full suite: about 25 min |

Never bare `node --test` and never an uncapped `npm test`.

---

## Sampling Rate

- **After every task commit:** the new or changed test file through the quick command, plus `npm run lint`.
- **After every plan wave:** all new test files of the wave, `copyLint.test.js`, `architecture.test.js`, and the hub tests when the wave touched `hub/`.
- **Before `/gsd-verify-work`:** full suite, e2e, hub suite, `verify:release` and secret scan green once (closing plan).
- **Max feedback latency:** 120 seconds per task.
- Authorization, label leak, data integrity and boundary tests are blocking in every wave that touches them.

---

## Per-Requirement Verification Map

| Req | Behaviour | Plan (proposed) | Test type | Automated command (file) | File exists |
|-----|-----------|-----------------|-----------|--------------------------|-------------|
| POST-01 | `roster.require` kind, schema, add-only union, lead or deputy only, agent refused | 33-02 | unit | `dist/test/replicaRosterRequire.test.js` | W0 |
| POST-01 | Missing feature stops the project: no state, no append, store intact, resumes after update | 33-02 | integration | `dist/test/staffRequireGate.test.js` | W0 |
| POST-01 | Hub refuses appends (`needs-update`) and sessions of clients lacking a required feature; reads still served | 33-06 | hub | `hub: dist/test/require.test.js` | W0 |
| MUS-09 | Sync machine: every transition, a sentence and accessible name per state, no silent wait | 33-01, 33-08 | unit, fake timers | `dist/test/replicaSyncMachine.test.js` | W0 |
| MUS-09 | Live replicator: local-first push, `blobsCitedBy`, `join-request` fetch, witness findings, `restoring`, `needs-update` | 33-08 | unit and hub | `dist/test/staffLiveReplicator.test.js`, `hub: dist/test/liveReplicator.test.js` | W0 |
| MUS-09 | Editor binding: fuzzed interleavings, no echo, resync on mismatch, undo only own, header read-only, take or restore | 33-03 | unit, property | `dist/test/staffEditorBinding.test.js`, `staffEditorBindingAdapter.test.js` | W0 |
| MUS-09 | Show Who Wrote This: person or agent on a named person's machine | 33-03 | unit | `dist/test/staffAttributionView.test.js` | W0 |
| MUS-09 | Presence: sealed, expiry, opt-out, no product name in the base cell | 33-10 | unit | `dist/test/replicaPresence.test.js` | W0 |
| MUS-09 | Shared version acts, contested, settling, changed while deciding, agents never decide | 33-04 | integration | `dist/test/staffSharedVersionActs.test.js` | W0 |
| MUS-09 | Staff Room live: presence, sync sentence and one action, offline banner, contested card, N changes since, join-request card | 33-11 | unit (fake DOM) | `dist/test/staffRoomLive.test.js`, `staffRoomLivePage.test.js` | W0 |
| MUS-09 | Share with people step, hidden aliases, invitation file opening, hub commands, address store | 33-09 | unit | `dist/test/staffShare.test.js`, `staffMultiUserManifest.test.js` | partly |
| MUS-09 | WR-07 per entry, IN-06 caps, IN-02 rebuild check, `withheld` notice, restore mode | 33-05, 33-06 | hub and unit | `hub: blobMissingPerEntry`, `joinCap`, `restoreDrill`; `staffReplicaStartAgain.test.js` | partly |
| MUS-09 | Two- and three-person scenarios over a real hub; contested; late joiner from compaction | 33-01, 33-12 | scenario | `dist/test/staffLiveScenario.test.js` (`NEAR_AI_HUB_NODE`), `hub: liveScenarios` | W0 |
| MUS-09 | Two-compartment leak test over the hub, presence included | 33-12 | hub with byte capture | `hub: liveLeak` | W0 |
| MUS-09 | README and SECURITY sentences word for word, no em-dash | 33-13 | docs test | `dist/test/staffLiveDocs.test.js` | W0 |
| MUS-06 | A project that never shares behaves as before | all | unit | `staffReplicaParity.test.js`, `staffMultiUserManifest.test.js` | yes |

*Status: pending until execution.*

---

## Wave 0 Requirements

- [ ] `src/test/helpers/liveWorld.ts`: two or three devices with separate stores, keys and a fake transport; a fake bound document
- [ ] `src/test/helpers/hubChild.ts`: start the built hub as a child process on Node 26 (`NEAR_AI_HUB_NODE`), temporary state directory, fixture certificate, cleanup
- [ ] Seeded fuzz generator for interleaved edits (seed printed on failure)
- [ ] `hub/test/helpers/` live client over `memoryReplica`, presence capture route
- [ ] CI step providing Node 26 for the real-hub scenario (gate path)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Two people on two machines co-edit through a hub in the Compose stack | MUS-09 | Real network and two VS Code installs | UAT sheet in the closing plan: start the hub profile, share, invite, join, type in both, propose, approve elsewhere, compare digests |
| Cursors and Show Who Wrote This read well in light, dark and high contrast themes | MUS-09 | Visual | Open a bound product in each theme with a second person typing |
| Focused browser check of the decision dialog's contested and changed-while-deciding paths | MUS-09 | Authorization contract on a webview | Run the focused check named in the Staff Room plan |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 120 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
