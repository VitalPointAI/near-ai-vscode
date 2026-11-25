---
phase: 33-live-multi-user-staff-projects
plan: 15
status: complete
subsystem: the documents about live multi-user staff projects (README, SECURITY.md, the operator guide, the workbench README, CHANGELOG) and their docs test
tags: [docs, staff, live, security, hub, d-13, d-32, d-33, d-36, d-64, d-67, mus-09, post-01]
requires: [33-14, 33-24, 33-25, 33-26, 33-27, 33-28, 33.2-01, 33.2-02, 33.2-03, 33.2-04, 33.2-05, 33.2-06, 33.2-07]
provides: [staffLiveDocs.test.ts, "README: Work on a staff project with other people", "SECURITY.md: Multi-user staff projects", "SECURITY.md: Limits that remain", "CHANGELOG: ## Unreleased"]
affects: [33-16]
tech-stack:
  added: []
  patterns: [fixed sentences imported from the code, bold labels checked against the built staff code and package.json, copy rules applied to the flattened section]
key-files:
  created:
    - src/test/staffLiveDocs.test.ts
  modified:
    - README.md
    - SECURITY.md
    - relay/README.md
    - workbench/README.md
    - CHANGELOG.md
    - src/test/replicaCellLeak.test.ts
    - src/test/staffReplicaLabelLeak.test.ts
    - src/test/staffReplicaMembership.test.ts
    - src/test/staffReplicaStore.test.ts
key-decisions:
  - "The docs describe only what the native image runs today. Presence, native cursors and Show Who Wrote This are not run in SovAI (G435, 33-29 not executed), so the README and SECURITY say so instead of listing them as features."
  - "The README section sits under The Sterling workbench, because sharing is a SovAI session feature (D1: no Marketplace listing)."
  - "Re-admit your organization's server is named as the step; the button that does it is Trust your organization's server again in Share with people (the Staff Room's Re-admit button only shows the sentence)."
  - "The late joiner's text limit is stated as built: nothing fetches the earlier history after a late start, so the text can be incomplete (G430)."
  - "The Phase 33 Step 0 grep for nearAi.staff.shareWithPeople gave 0. The re-aim (D-58, D-64) replaced that command with the native Share with people section, so the check is superseded, not failed."
requirements: [MUS-09, POST-01]
requirements-completed: []
actuals:
  tokens: 30000
  tasks: 3
  commits: 3
plan_head_before: 72e95c9f
plan_head_after: e0ce7734
completed: 2026-11-25
---

# Phase 33 Plan 15: The documentation Summary

README, SECURITY.md, the operator guide, the workbench README and the CHANGELOG now describe live multi-user staff projects as built in SovAI, from the summaries of 33-14, 33-24 to 33-28 and 33.2-01 to 07. The three notices are carried word for word and checked against the code's constants. Each limit that is still open is stated plainly: the late joiner (G430), presence (G435), action-bound signing (G440) and the legacy-ledger conversion (G441).

## Base and branch

- `feat/phase-33-15-331-03` from `origin/feat/integration-gate-2` at `72e95c9f`.
- Step 0 (D-01): `CLEARANCE_SELF_ASSERTED_TEXT` 1, `LABELS_NOT_ACCREDITATION_TEXT` 1, `multiUserNoticeLines` 1, the README preview sentence 1, `## Multi-user staff projects (preview)` 1. `nearAi.staff.shareWithPeople` in package.json gave **0**. The re-aim amendment replaces that command with the native Share with people section (D-58), and the image registers no preview command (D-64), so this check is superseded.

## Sections changed

- **README.md**
  - New `### Work on a staff project with other people`, under `## The Sterling workbench`. It covers:
    - starting and joining: Share with people, the invitation file, six words, Admit, the welcome file;
    - signing with the person's passkey;
    - co-editing, with undo that takes back only your own changes, and Take This Change as My Edit or Restore;
    - the Staff Room, decisions and contested cards;
    - the status bar word, the offline banner and the update sentence;
    - post-quantum keys, trusting the server again, and the single-machine copy;
    - a plain "Not in SovAI yet" paragraph and the three notices.
  - In the staff paragraph, the 0.4.35 preview sentence and the `nearAi.staff.multiUserPreview` instruction are replaced by a pointer to the new section.
- **SECURITY.md (gate path, D-39)**
  - `## Multi-user staff projects` (retitled, no "(preview)"), with the three notices word for word.
  - New subsections: `Live sharing through your organization's server`, `Keys in a hosted session`, `Presence`, `Required features and older versions` (including why a 0.4.35 computer stalls), and `A person who joins late`.
  - "Off unless you turn it on" became "Turned on per project". "Only a person runs these steps" and "The invitation stays out of the project" now describe the native flows.
  - The invitations intro: the files still go from person to person, and now also pass through the server when one is connected.
  - `## Your organization's sync hub`:
    - The intro says SovAI connects to the hub.
    - Limit 1 became restore mode, followed by "Limit: a restore when the procedure is not followed".
    - New bullet "Re-admit your organization's server": the lead or deputy compares twelve words and chooses Trust your organization's server again.
    - Limit 2 is kept word for word (a fixture in the test).
    - Two new bullets under Connections and sessions: session keys and required features.
    - New `### Limits that remain`: WR-02 in cells the hub cannot open, checkpoints over 64 KiB, checkpoint order not recomputed, and a deleted store whose record remains.
- **relay/README.md**:
  - The operators-only sentence, the "arrives in a later release" sentences and "When members can connect projects from the editor" now describe Connect your organization's server and Re-admit your organization's server.
  - The restore drill keeps 33-07's `restore-mode` marker step.
- **workbench/README.md**: the Interface with Phase 47 table gains `STERLING_WORKBENCH` and a "Staff live services" row with the four `/services/sterling-staff-*` paths, and says how the backend reaches the hub.
- **CHANGELOG.md**: new `## Unreleased` with `### Work on a staff project with other people`. It has 13 bullets in people's words, including one for operators. It only adds lines (`git diff --numstat`: 46 added, 0 deleted).

## Deviations from Plan

1. **[Re-aim] Features not built are stated as not built.** The plan's README must-have lists presence, cursors and Show Who Wrote This. The native engine runs no presence (G435), and 33-29 (native cursors and Who Wrote This) has not run, so the documents say these are not in SovAI yet.
2. **[Rule 1] Four existing SECURITY tests read the old heading** `## Multi-user staff projects (preview)`: replicaCellLeak (2 places), staffReplicaLabelLeak, staffReplicaStore (2) and staffReplicaMembership. They now read `\n## Multi-user staff projects\n`. Every assertion is unchanged.
3. **Restore mode is already in relay/README.md** (33-07 wrote the marker step), so Task 2 only changed the sentences that said the editor could not connect, and the drill's opening line.
4. **The operator cannot show the twelve words.** Re-admitting compares twelve words derived from the hub's certificate pin (`serverPinWords`). The hub has no command that prints them, so the operator guide says so. Filed as G541 with the coordinator's reserved id, with POA&M g541 (a hub command that prints the words). **Closed later on this branch** (fix/g541-hub-pin-words): the hub's `--pin-words` prints the twelve words with `serverPinWords` itself, now on the hub side of the replica boundary, and `hub/test/api.test.ts` shows its line equals SovAI's words for the pin worked out with openssl and passes `readmitWordsMatch`. relay/README.md's re-admit steps use the command. The G541 row and POA&M g541 are removed.
5. **Tests first.** `staffLiveDocs.test.ts` was written before any document changed. RED: 15 of 15 failed on the unchanged documents. GREEN: 15 of 15.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0, choom and timeout.

| Run | Result |
|---|---|
| RED: `staffLiveDocs.test.js` on the unchanged documents | 15 tests, 0 passed, 15 failed |
| `npm run lint` | exit 0 |
| staffLiveDocs, gateDocs, changelogSections, copyLint, replicaCellLeak, staffReplicaLabelLeak, staffReplicaStore, staffReplicaMembership, hubIsolation, staffMultiUserCommands | **263 tests: 263 passed, 0 failed, 0 skipped** |

- Acceptance greps:
  - `Work on a staff project with other people` in README: 1.
  - `nearAi.staff.multiUserPreview` in README: 0.
  - `^## Multi-user staff projects (preview)` in SECURITY.md: 0.
  - `editor's hub commands` in SECURITY.md: 0.
  - `People cannot connect a staff project to it from the editor yet` in relay/README.md: 0.
  - `Re-admit your organization's server` in SECURITY.md: 1.
- **Tests added: 15** (staffLiveDocs). **Tests changed: 4 files** (the heading string only).

## Threat model

| Threat | As built |
|---|---|
| T-33-63 | The three notices are word for word, imported from the code. The copy rules (no compliance claim, em-dash or old product name) run on each section. Open limits are listed. |
| T-33-64 | No key text, PEM header, personal or company name. The secret scan runs in 33-16. |
| T-33-65 | The fixed sentences come from the code. Every bold label in the README and CHANGELOG sections is either a contributed command or a string literal in the built staff code. The staff service paths are read from `common/`. |
| T-33-SC | No package installed (`npm ci --ignore-scripts` of the lockfile). |

## Known Stubs

None.

## Gate files

- `SECURITY.md`. The integration PR waits for the owner's gate approval (D-39); 33-16 sends the run URL.

## Self-Check: PASSED

- `src/test/staffLiveDocs.test.ts` exists. Commits `69affec3`, `dd643c30` and `e0ce7734` are in HEAD (`git rev-list --count 72e95c9f..HEAD` = 3).

## Open conditions

- G430 (closes in Phase 33): a late joiner starts from a checkpoint only in the parts the server holds, and its product text is complete only once the earlier history arrives. Nothing fetches that history yet. The README, SECURITY.md and CHANGELOG say so.
- G435 (closes in Phase 33): SovAI runs no presence yet, so the Staff Room lists only the person. The documents say so.
- G440 (closes in Phase 33, blocks production): person-key signatures are not yet bound to one confirmed action. SECURITY.md states it as a limit.
- G441 (closes in Phase 33, blocks production): a conversion trusts any key that signed the legacy ledgers. SECURITY.md states it as a limit.
