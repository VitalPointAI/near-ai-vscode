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
- **After every plan wave:** all new `state*`, `thread*`, `archive*`, `participantRecord`, `historyRetention`, `pickup`, `modelChoices`, `runMarkersForeign`, `activityShared`, `onlineHome`, `codePushCheck`, `syncControl` tests, plus the existing `profileStore`, `auth`, `conversations`, `privacy`, `agentFleet`, `modelComparisonPage`, `scratch` tests.
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
| SYNC-03 / D-15 | Sealed NEAR AI key copy: a second editor on the host uses the key with sync off; sentinel scan of the state home and output channel finds no plaintext key; tampered or swapped copy refused; unusable without the key file and SecretStorage; rotation and removal (plan 03 Task 3) | `stateApiKey` | ❌ W0 |
| SYNC-04 | Wrong code, tampered, truncated or swapped bundle is refused and state is byte-identical afterwards; the code is never logged | `stateRecovery`, `stateRestoreProfile` | ❌ W0 |
| SYNC-05 | Merge laws; git transport leaves the working tree, HEAD and branch untouched; never `main` | `stateMerge`, `stateSyncGit`, `stateTwoMachines` | ❌ W0 |
| SYNC-05 / D-09 | Leak scan of the tree, blobs, commits, messages and refs; opaque names; padding; AAD | `stateLeak`, `stateObjects` | ❌ W0 |
| D-09 | Anonymous author and committer identity; the person's git config is unchanged | `stateIdentity` | ❌ W0 |
| D-09 | The remote is a parameter (default `origin`); `nearAi.sync.remote` is not declared in this phase (D-09 defers the setting); `ext::` and other `::` transports are rejected | `stateRemote` | ❌ W0 |
| SYNC-09 / D-14 | Online home on click only: git init, fake VS Code GitHub session and fake GitHub API (no network), public or private asked every time, repo created, remote added, sync branch pushed; gh CLI and pasted empty-URL fallbacks; name taken, offline, permission errors; resume without a second repo; token never in args, files, messages or logs (plan 17) | `onlineHome` | ❌ W0 |
| SYNC-09 / D-14 | Separate code push: file list shown, secret file names and contents blocked (ported secret-scan rules, scanSecrets, SECRET_TOKENS), no force (plan 17) | `codePushCheck` | ❌ W0 |
| D-16 | Sync control rendered on panel open in all five states, click posts the turn-on (or set-up) message, accessible name, keyboard reachable, theme rules, prompt in the pick-up card and first-run screen dismissible (plan 18) | `syncControl` | ❌ W0 |
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
- [ ] The new test files named in the map above (including `onlineHome`, `codePushCheck`, `stateApiKey` and `syncControl`, which use fakes for the GitHub API and authentication and need no network)
- [ ] No framework install needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The same project opened in code-server and desktop VS Code shows the same chats, runs, comparisons and model choices | SYNC-01, SYNC-06 | Needs two real editors on the owner's host | Open the project in both editors, start a chat in one, reopen the other: the chat is listed with its full history |
| The pick-up card appears on a different interface and one click reopens the work | SYNC-07 | Real UI across two editors | After the step above, confirm the card shows the last chat, run state and GSD next step; click it; no model call is made |
| Second-machine restore with the recovery code | SYNC-04, SYNC-05 | Needs a second machine or clone | Turn sync on, record the code, clone on another path or machine, enter the code: chats, runs, comparisons, model choices and the API key are restored |
| Sync control visible on open | D-16 | Real panels in two editors and three themes | Open the project in code-server and in desktop VS Code: the sync control shows next to the profile control before any action, is reachable with Tab, and reads in light, dark and high-contrast themes |
| Same-host key with sync off | D-15 | Two real editors with separate secret storage | With sync off, use a project in code-server, then open it in desktop VS Code and send a message: no key prompt |
| Online home on a scratch folder | SYNC-09, D-14 | Needs a real GitHub account | Click 'No online home · Set up', choose private, check the repository and its near-ai/state branch on GitHub; the code push is offered separately and blocks a planted .env file |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
