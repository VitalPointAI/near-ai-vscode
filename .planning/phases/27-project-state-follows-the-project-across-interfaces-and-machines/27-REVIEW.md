## Agent review for #40

Verdict: FAIL
Head-SHA: b316b47921c5bfd07989b57b17858aaf67201420

### Summary
Phase 27: encrypted project state shared across editors, sync to a git branch with a recovery code, a GitHub online home, the pick-up card and the chat task-list fix. The cryptography holds up, and CI is green. It must not merge yet: files inside the project folder decide which git hooks and config sync runs and which key it uses, and two sync bugs can quietly break the recovery code or the online backup.

### Findings
- [BLOCKER] src/services/syncFlows.ts:156 (with stateGit.ts:48, syncFlows.ts:89, tools.ts:98): the sync hooks folder, the mirror repository and the sync on/off switch all live in `.near-ai/state/` inside the project. A cloned or pulled repository (force-added) or an agent with edit rights can plant a hook, a `mirror.git/config` (`core.sshCommand`, `credential.helper`) or key files, and the background sync then runs that code or encrypts chats under a key the attacker knows. Fix: hooks in a private temp folder, mirror in the extension's global storage, sync settings in editor storage, trust only key files this editor created or adopted, refuse a tracked state folder, add `.near-ai/state` (and any `*.git` segment) to PROTECTED_WRITE, with a regression test.
- [BLOCKER] src/services/syncFlows.ts:343 with stateSync.ts:466: a new recovery code made while sync is off (or raced by a scheduler sync) is overwritten by the old wrap on the next sync; the new code then fails on every new computer and the old code keeps working. Fix: carry a generation in the wrap and never replace a newer local wrap; set the pending mark when the wrap is written; one StateSync per project root; test "new code while off, then turn on".
- [BLOCKER] src/services/stateSync.ts:417: when the remote `near-ai/state` branch is gone (deleted, repo recreated, origin re-pointed), `sync/state.json` is not reset, so only new objects are pushed and every other computer is refused while this one says up to date. Fix: reset to a fresh state when there is no tip but history exists, or when the tip is not a descendant of the last seen tip; test delete-branch then restore.
- [MAJOR] src/services/syncFlows.ts:249 with stateRestore.ts:293 and stateKeys.ts:73: joining an online project during a live run loses writes, and other editors keep the old cached key and seal new lines unreadably. Refuse while runs are live, lock across copy and swap, key the cache on stateId.
- [MAJOR] src/services/stateRestore.ts:294: a join skips locked or unreadable threads and later deletes the only copy in `discardPreviousState`. Carry them over or fail the join.
- [MAJOR] src/services/syncFlows.ts:45: the new-code message understates the risk; the data key is never rotated, so the old code also opens everything pushed afterwards. Say so, or re-key.
- [MAJOR] src/services/stateSync.ts:226: `sync/state.json` is read once and written back whole with no cross-instance or cross-process lock.
- [MAJOR] src/agent/checkpoints.ts:100: checkpoints now live in the project, but loading accepts absolute paths anywhere on disk, so a tampered checkpoint turns Revert into a write or delete of any file. Restrict to the workspace or worktree.
- [MAJOR] src/agent/taskBoard.ts:61: the item-number step runs before text matching; `find("Task 1")` returns "Read the plan" (reproduced). Match text first, use the number only when nothing matches.
- [MAJOR] src/services/runMarkers.ts:206 with stateMigration.ts:189: run markers migrated from 0.4.19 have no writer, so a run cut off by the upgrade shows as running in another editor with no Resume.
- [MAJOR] src/services/chat.ts:280: "running in another editor" is shown but sending is not blocked and the view never refreshes; both editors can run one conversation and overwrite its marker.
- [MAJOR] src/services/settings.ts:38 with modelChoices.ts:126: a project choice outranks user settings with no visible way to clear it, and the settings descriptions still point to user settings.
- [MAJOR] src/services/modelComparisonPanel.ts:297: applying one role writes every resolved role into the project, freezing the others.
- [MINOR] src/agent/commandSafety.ts:319: KB_OR_SECRET and SENSITIVE_TEXT do not cover `.near-ai/state/keys/`, so a recursive read can carry the project key into a model request.
- [MINOR] src/services/agentSession.ts:408: the run-end task-list reminder costs one extra paid turn and can bury a closing question; skip it when the reply ends with a question.
- [MINOR] src/services/stateHome.ts:213: `updateMeta` read-modify-write is not locked across editors and can drop `keyCheck`.
- [MINOR] src/services/syncFlows.ts:313: `state.previous-*` is never removed after a pending join, and recovery picks a folder by name rather than time.
- [MINOR] src/services/activityStore.ts:181: a session skipped near a reload stays "running" until the next reload.
- [MINOR] media/chat/chat.js:1161: the history queue drains only on requestAnimationFrame, so a hidden view stalls approvals and live events.
- [MINOR] src/services/chat.ts:657: a failing migration re-runs before every message and History open.
- [MINOR] src/services/chatParticipant.ts:57: Chat-view replies are recorded with the cost footer and error text, which later reach the model.
- [MINOR] src/domain/redaction.ts:20: the recovery-code pattern also redacts upper-case hashes in cyber evidence.
- [MINOR] README.md:870: the `nearAi.agent.saveTranscripts` row still says chats stay on this machine; use package.json's wording.
- [MINOR] CHANGELOG.md:35: the sync entry does not name Sync Project Now, Show a New Recovery Code, Turn Off Project Sync or Put This Project's Code Online.
- [NIT] src/services/onlineHome.ts:150: a repository name starting with `-` is read as a gh flag; reject it or pass `--`.
- [NIT] SECURITY.md (Anonymous commits): "your git configuration is never read" overstates it; the repository remote and global git settings apply.
- [NIT] src/services/participantRecorder.ts:53: `finish` and `RecordedReply` are unused.
- [NIT] src/services/runMarkers.ts:128: `dispose()` is never called.
- [NIT] src/services/modelChoices.ts:98: a `statSync` on `choices.json` for every resolved setting; cache briefly.

### Dismissed
- Workflow review finding that the chatSendPath test reads the home-folder teams library : already fixed in f941930 on this branch.
- Workflow review finding on the owner's hands-on check after publishing : the owner chose this; it will be recorded in the PR description.
- Cryptography (nonce reuse, AAD, scrypt bounds, constant-time compares, remote-supplied names, anonymous commits, no forced push, token scope) : checked and sound.
- Tests weakened or skipped against origin/main : none found.

### Reviewers
code review (state, sync and keys, deep), code review (agent, chat, UI, settings, tests), security review, docs/changelog review; CI: green
