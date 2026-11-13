---
phase: "27"
slug: "project-state-follows-the-project-across-interfaces-and-machines"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-13"
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: `27-RESEARCH.md` § Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | `node:test` + `node:assert/strict`, TypeScript compiled by `tsc` to `dist/` |
| **Config file** | `tsconfig.json` (`rootDir src`, `outDir dist`) |
| **Quick run command** | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/<name>.test.js'` |
| **Full suite command** | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 npm test` |
| **Estimated runtime** | quick ~30–90 s (tsc dominates); full suite several minutes |

Every test run must be capped as above, one heavy run at a time (owner's standing rule).

---

## Sampling Rate

- **After every task commit:** the task's own new test file (quick command), plus `npx tsc -p tsconfig.json --noEmit`.
- **After every plan wave:** all new `state*`, `thread*`, `archive*`, `participantRecord`, `historyRetention`, `pickup`, `modelChoices`, `runMarkersForeign`, `activityShared` tests, plus the existing `profileStore`, `auth`, `conversations`, `privacy`, `agentFleet`, `modelComparisonPage`, `scratch` tests.
- **Before `/gsd-verify-work`:** full `npm test` once, then `npm run test:e2e` once, then `npm run verify:release`. All capped and run one after another.
- **Always blocking per task:** security, key handling, migration, data integrity and any spend-path tests.
- **Max feedback latency:** ~90 s per task.

---

## Per-Task Verification Map

Filled in by the planner and executor from the requirement map below. Each task names its test file in `<automated>`.

| Req | Behavior | Test file (`dist/test/…`) | Wave 0 |
|-----|----------|---------------------------|--------|
| SYNC-01 | State home: paths, self-ignoring, atomic writes, two editors share one folder | `stateHome`, `stateStores` | ❌ W0 |
| SYNC-01 / D-07 | Thread log keeps the original messages before compaction; reopening replays every entry | `threadLog`, `threadReplay` | ❌ W0 |
| D-07 | `@near` participant turns are recorded (more than 20 turns, thread id in metadata) | `participantRecord` | ❌ W0 |
| D-07 | A thread continued on two machines merges with no lost entries | `threadMerge` | ❌ W0 |
| D-08 | The 5 most recent threads stay live; the setting is clamped from 1 to 50; archive round trip; never pruned | `historyRetention`, `threadArchive`, `archiveMerge`, `stateLazyFetch` | ❌ W0 |
| D-12 | A tool result over 2 MiB is shortened and shows a visible marker | `threadLog` | ❌ W0 |
| SYNC-02 | Migration is idempotent, never overwrites newer records, never deletes the source, re-encrypts old-key transcripts | `stateMigration` | ❌ W0 |
| SYNC-03 / D-10 | Data key with HKDF subkeys; SecretStorage copy; local key file mode 0600, ignored by git, never synced | `stateKeys` | ❌ W0 |
| SYNC-04 | Wrong code, tampered, truncated or swapped bundle is refused and state is byte-identical afterwards; the code is never logged | `stateRecovery`, `stateRestoreProfile` | ❌ W0 |
| SYNC-05 | Merge laws; git transport leaves the working tree, HEAD and branch untouched; never `main` | `stateMerge`, `stateSyncGit`, `stateTwoMachines` | ❌ W0 |
| SYNC-05 / D-09 | Leak scan of the tree, blobs, commits, messages and refs; opaque names; padding; AAD | `stateLeak`, `stateObjects` | ❌ W0 |
| D-09 | Anonymous author and committer identity; the person's git config is unchanged | `stateIdentity` | ❌ W0 |
| D-09 | The remote is a parameter; `nearAi.sync.remote` has `scope: machine`; `ext::` is rejected | `stateRemote` | ❌ W0 |
| SYNC-06 | Settings resolver precedence; apply writes project state; global choices are offered for import, not copied | `modelChoices`, `modelComparisonPage` | ❌ W0 / existing |
| SYNC-07 | Pick-up card states; the click never re-runs or spends | `pickup`, `runMarkersForeign` | ❌ W0 |
| SYNC-01 | `ActivityStore` with two writers | `activityShared` | ❌ W0 |
| SYNC-08 | CHANGELOG `## 0.4.20`, README, version bump | `node scripts/verify-release-content.mjs` | existing |
| (regression) | Opening the sidebar writes nothing into the folder | `npm run test:e2e` | existing |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/test/helpers/stateFixtures.ts`: temp project, a fake two-editor globalStorage with old-key transcripts, a local bare remote builder, `MemorySecrets`, a git-object scanner
- [ ] Fixtures: a builder for transcripts that trigger compaction (`compactConversation` with a fake client) and a fake `ChatResponseStream`
- [ ] The new test files named in the map above
- [ ] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The same project opened in code-server and desktop VS Code shows the same chats, runs, comparisons and model choices | SYNC-01, SYNC-06 | Needs two real editors on the owner's host | Open the project in both editors, start a chat in one, reopen the other: the chat is listed with its full history |
| The pick-up card appears on a different interface and one click reopens the work | SYNC-07 | Real UI across two editors | After the step above, confirm the card shows the last chat, run state and GSD next step; click it; no model call is made |
| Second-machine restore with the recovery code | SYNC-04, SYNC-05 | Needs a second machine or clone | Turn sync on, record the code, clone on another path or machine, enter the code: chats, runs, comparisons, model choices and the API key are restored |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
