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

## Re-aim to native Theia (2026-11-23)

The rows above give the original plan numbers. Where a plan is superseded (33-10, 33-11, 33-13, 33-20, and 33-19 as the product path), the behaviour moves to the native plan named below. Workbench tests run with `npm --prefix workbench test` inside the same memory wrapper. The container and Playwright suite runs only in 33-30 and the close-out (D-65).

| Req | Behaviour | Plan | Test type | Automated command (file) | File exists |
|-----|-----------|------|-----------|--------------------------|-------------|
| MUS-09 | `session.certify` fold, person-key kinds refused from session keys, revocation, slots, no clock | 33-21 | unit | `dist/test/replicaSessionCertify.test.js`, `staffPersonKeySigning.test.js` | W0 |
| MUS-09 | Hub accepts certified session keys, `session-expired`, `person-key-required`, certificate limit | 33-22 | hub and real-hub client | `hub: sessionCertify`, `dist/test/staffHubSessionKey.test.js` | W0 |
| MUS-09 | Session key and certificate through KeyService, X25519 envelope, key-store secrets, keys dropped at stop | 33-23 | workbench unit | `workbench/test/staff/session-keys.test.ts`, `encryption-key.test.ts` | W0 |
| MUS-09, POST-01 | Native engine: one replicator per project per session, every 33-10 hook, client fan-out, bundle boundary | 33-24 | workbench unit and real hub | `workbench/test/staff/staff-live-engine.test.ts`, `backend-service-client.test.ts` | W0 |
| MUS-09 | Monaco binding: no echo, version guard, hash resync, own undo by every path, header, take or restore, one editing tab | 33-25 | workbench unit | `remote-bound-document.test.ts`, `monaco-bound-document.test.ts`, `bound-undo.test.ts` | W0 |
| MUS-09 | Native Staff Room: people, sentence, banner, contested, stamp and step-up, cards and rows | 33-26 | unit and workbench unit | `dist/test/staffRoomLive.test.js`, `staff-room-service.test.ts`, `staff-room-widget.test.ts` | W0 |
| MUS-09 | Share with people native, re-admit with twelve words, invitation open handler, extension stands back in the image | 33-27 | workbench unit and unit | `share-service.test.ts`, `dist/test/staffHubReadmit.test.js`, `staffMultiUserCommands.test.js` | partly |
| MUS-09 | Sterling status entry: word, sentence, warning look, nothing identifying | 33-28 | workbench unit | `staff-sync-status.test.ts` | W0 |
| MUS-09 | Native cursors with names as plain text, rate and expiry, Show Who Wrote This | 33-29 | workbench unit | `remote-cursors.test.ts`, `who-wrote-this.test.ts` | W0 |
| MUS-09 | Two people in two browsers: co-edit, cursor names, own undo, status; **blocking:** step-up decision, contested, changed while deciding, nothing secret on the wire | 33-30 | Playwright against built containers | `npm --prefix workbench run test:container` (`workbench/test/e2e/staff-live.spec.ts`) | W0 |

The manual check "two VS Code installs" above becomes two Sterling sessions on the lab stack, recorded in 33-UAT.md. The focused browser check of the decision paths is now the blocking part of 33-30.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency under 120 s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
