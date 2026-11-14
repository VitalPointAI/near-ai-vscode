---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 36
subsystem: docs-and-full-gate
tags: [review-gap-closure, readme, security, changelog, full-gate]
requires: ["27-26", "27-27", "27-28", "27-29", "27-30", "27-31", "27-32", "27-33", "27-34", "27-35"]
provides:
  - "README.md: the saveTranscripts row matches package.json; sync is turned on in each editor; the honest new-code text; the hardening described in plain words; Compare Models' Chosen for this project list and the clear command; five new or rewritten Troubleshooting entries"
  - "SECURITY.md: the accurate Anonymous commits paragraph; a new What sync trusts in the project folder section; the honest residual-risk and limitation rows for the recovery code; a deleted or rewound sync branch line"
  - "CHANGELOG.md (Unreleased): the sync entry names Sync Project Now, Show a New Recovery Code, Turn Off Project Sync and Put This Project's Code Online; a hardening bullet; the model choices and task list entries updated; the corrected known limit plus two new known limits"
affects: [27-16]
tech-stack:
  added: []
  patterns: ["docs say what the code does, including what a new recovery code does not do"]
key-files:
  created: []
  modified:
    - README.md
    - SECURITY.md
    - CHANGELOG.md
key-decisions:
  - "The honest recovery-code sentence is the same in README, SECURITY.md and CHANGELOG: anyone with the old code and read access to the repository can still open everything synced, including what is synced from now on, because the chats keep the same key; a way to change that key is planned."
  - "The join's kept folder is described in README and SECURITY.md (state.previous-<time>, holds not-carried.json when something could not be carried, never removed by the extension, can be deleted by hand once those conversations are open elsewhere)."
requirements-completed: [SYNC-08]
status: complete
commits: 1
plan_head_before: 9875e624bb8e77f5fdcee9062735f8701598713e
plan_head_after: 11006079ec3ed4dddbd23515cc8b61ac8b57ca6c
actuals:
  tokens: 5030
  tasks: 2
  commits: 1
---

# Phase 27 Plan 36: README, SECURITY.md and CHANGELOG say what the hardened sync does, and the full gate is green Summary

The three user-facing documents now match the code of plans 27-26 to 27-35, including the honest limit of a new recovery code, and the one full gate of this gap closure passed on a single run.

## What was done

**Task 1 (commit 1100607).** Closed REVIEW MINOR README.md:870, MINOR CHANGELOG.md:35, NIT SECURITY.md Anonymous commits, and the docs half of MAJOR syncFlows.ts:45.

- README: the `nearAi.agent.saveTranscripts` row now says full conversations, encrypted, in the project's git-ignored state folder, shared by every editor on this computer, never committed. The sync section says sync is turned on in each editor (a second editor on the same computer needs one click and shows no new code). "Other commands" lists Show a New Recovery Code, Turn Off Project Sync, Sync Project Now, Give This Project an Online Home and Put This Project's Code Online. New bullets: the honest new-code sentence; files in the project folder do not decide what sync does; a deleted or rewound sync branch is rebuilt; entering the recovery code is safe on a computer with chats. The model-choices text names the "Chosen for this project" list, "Use my settings", the command "NEAR AI: Clear This Project's Model Choices", that a cleared choice stays cleared after sync, and that one role changes only that role. Troubleshooting: "I lost the recovery code" rewritten; added "Chats are not saved in this project", "This conversation is running in another editor right now", "Entering the recovery code says a chat is running" and "Some conversations could not be added", using the exact sentences from the 27-28, 27-31 and 27-34 summaries.
- SECURITY.md: Anonymous commits no longer says git configuration is never read (sync never changes it or uses the name or email; git still reads global settings and the remote address; hooks, signing, helper transports, fsmonitor and the inherited git environment are off; mirror and hooks live in the editor's storage). New section "What sync trusts in the project folder". The residual-risk bullet and the limitations-table row now carry the honest sentence. A line on a deleted, replaced or rewound sync branch.
- CHANGELOG (Unreleased only): the sync entry names all four commands and per-editor turn-on; a hardening bullet; the model choices entry mentions the list and the clear command; the task list entry says a sub-agent's task is matched by its text first; the recovery-code known limit is corrected.

**Task 2.** The full gate ran once, alone, under `systemd-run MemoryMax=6G` with `choom -n 1000` and `timeout 1800` (available memory was 8G beforehand). It exited 0 on the first run, so nothing was fixed or re-run.

| Step | Result |
|------|--------|
| `npm run lint` | exit 0 |
| `npm test` | tests 2000, pass 1991, fail 0, cancelled 0, skipped 9, todo 0 |
| `npm run test:e2e` (xvfb) | both extension-host sessions exited 0; 14 `[project]` tests passed, 0 failed |
| `npm run verify:release` | "Release content verified: 332 entries, 252 runtime JavaScript files, and 50 required release assets." |
| `node scripts/secret-scan.mjs --range origin/main..HEAD` | "Secret scan clean: 879 tracked files and 193 commit(s)"; 0 findings; 8 allow-listed fixtures, all already on main |

The 9 skipped unit tests are the Windows-only conditional skips (`skip: process.platform === 'win32'`) on the key-file permission and link tests; none was skipped to get green. `.github/secret-scan-allow.txt` was not touched (no gate-path change), and no fixture needed changing.

Task 1's own automated check also passed before the commit (old sentences gone; the four command titles in the Unreleased section; "from now on" in SECURITY.md and README; "Clear This Project" in README; no em-dash on any added line; no "NEAR organization").

## Deviations from Plan

None. One note on the Task 2 precondition: `git status --porcelain` shows the three pre-existing unrelated modifications to `.planning/STATE.md`, `.planning/config.json` and `.planning/state.json`, which the orchestrator told me to leave unstaged. They are not code and did not affect the gate.

## Notes for the owner

- **Two existing tests were changed this run because the plans changed the behaviour they asserted:** the `stateRecovery` rewound-branch test (plan 27-30, now that a rewound sync branch is rebuilt without loss) and the `stateStores` outside-folder checkpoint test (commit 3eee70a, now that checkpoints allow only the project and the editor's own worktrees unless an outside folder is allowed explicitly). Neither was deleted, skipped or weakened.
- **Known follow-ups recorded, not fixed:** data-key rotation after a new recovery code (planned; stated in README, SECURITY.md and CHANGELOG known limits); a join can undo itself if another editor writes in the instant between the join's two folder renames, because conversation writes do not yet take a lock (added to the CHANGELOG known limits); error text from a failed reply in the Chat view stays in VS Code's own chat history (added to the CHANGELOG known limits); the agent-review workflow's own defects (separate PR).

## Review Dispositions

The complete map of every 27-REVIEW.md finding (29 findings, none rejected; two confirmed with a correction) is held in `27-36-PLAN.md`, `<review_dispositions>`, and is unchanged by this execution. Findings 23, 24 and 26 and the docs half of finding 6 are closed here by commit 1100607; data-key rotation (finding 6) remains the deferred follow-up. The dismissed items and the deferral of the agent-review workflow's defects are recorded in the same section.

## Next Phase Readiness

For plan 27-16: its Task 3 builds the 0.4.20 CHANGELOG section from the Unreleased section, so the recovery-code limit must keep the corrected sentence from this plan ("A new recovery code does not lock out the old one. Anyone with your old code and read access to the repository can still open everything synced, including what is synced from now on, because your chats keep the same key. A way to change that key is planned."). Plan 27-16's own wording about copies already on the git host is out of date. Its Task 2 owner check may add, if the owner wants, opening the project in a second editor and turning sync on there with one click. The Unreleased section now also carries two new known limits (a join can undo itself if another editor writes at the very instant of the folder swap; Chat-view error text stays in VS Code's own history) that 27-16 should carry into the 0.4.20 section. `package.json` was not bumped (the release PR does that).

## Known Stubs

None.

## Threat Flags

None. No code or network surface was added; the changes are documentation only.

## Self-Check: PASSED

- README.md, SECURITY.md and CHANGELOG.md are modified and committed; commit 1100607 is an ancestor of HEAD.
- Full gate log: exit 0 on one run.
