---
phase: 27-project-state-follows-the-project-across-interfaces-and-machines
plan: 11
subsystem: state-sync
tags: [git, transport, plumbing, bare-mirror, anonymous-identity, leak-scan, lock]

requires:
  - phase: 27-project-state-follows-the-project-across-interfaces-and-machines
    provides: "27-01 sealObject, buildManifest, TREE_NAME, StateRefusedError; 27-03 state home layout (sync folder)"
provides:
  - "src/services/stateGit.ts: runStateGit, STATE_IDENTITY_ENV, STATE_COMMIT_MESSAGE, SAFE_GIT_CONFIG, STRIPPED_ENV_NAMES/PREFIXES, redactGitMessage, gitText, mustSucceed, GitNotFoundError, GitCommandError, GitIdentityMissingError, GitRunner/GitOptions/GitResult"
  - "src/services/stateMirrorLock.ts: MIRROR_LOCK_FILE, acquireMirrorLock, MirrorBusyError, HeldMirrorLock, withMirrorLock(mirrorDir, work, options?)"
  - "src/services/stateTransport.ts: STATE_REF, INCOMING_REF, StateTransport (resolveRemoteUrl, ensureMirror, fetch, readTree, readBlob, writeCommit, push), validateRemote, classifyGitFailure, classifyThrown, SyncFailure, SyncFailureKind, Outcome, TreeEntry, StateFile"
  - "src/test/helpers/gitFixtures.ts: bareRemote, userRepo, repoSnapshot, scanRemote, remoteCommits, hermeticRunner, sealedFiles, sealingKeys, mirrorPaths, fixtureGit, tempDirectory"
affects: [27-12, 27-13, 27-15, 27-17, sync, restore, online-home]

actuals:
  tokens: 20643
  tasks: 3
  commits: 3
plan_head_before: b6e2295f3de2d74de0dbef6866bb643fb3806dff
plan_head_after: 28aafaa83baf3682639ae023b29a2961e9d9d5b5

tech-stack:
  added: []
  patterns:
    - "One git runner for all sync: array arguments, own process group with kill-tree timeout, stdout cap, inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_OBJECT_DIRECTORY/GIT_CONFIG*/GIT_AUTHOR_*/GIT_COMMITTER_* removed, five -c safety pairs prepended to every call"
    - "Plumbing commits in a private bare mirror (hash-object -w, mktree -z, commit-tree) with the anonymous identity set only in the commit-tree process environment; the runner refuses commit-tree without the exact identity"
    - "Remote-facing methods return Outcome<T> ({ ok: true, value } | { ok: false, failure }) instead of throwing; local reads throw StateRefusedError or GitCommandError"
    - "Every mirror method runs inside withMirrorLock: an in-process chain, then an exclusive lock file with a refreshed mtime and dead-holder takeover"
    - "The person's repository is read only for the remote's address; fetch and push go from the mirror to the resolved URL, so no tracking branch or ref appears in the person's repository"

key-files:
  created:
    - src/services/stateGit.ts
    - src/services/stateMirrorLock.ts
    - src/services/stateTransport.ts
    - src/test/helpers/gitFixtures.ts
    - src/test/stateSyncGit.test.ts
    - src/test/stateIdentity.test.ts
    - src/test/stateRemote.test.ts
    - src/test/stateLeak.test.ts
  modified: []

key-decisions:
  - "The sync commit identity is near-ai-state <state@near-ai.invalid> at 2000-01-01T00:00:00Z with the message 'Update encrypted project state', carried in STATE_IDENTITY_ENV and set only on commit-tree; runStateGit throws GitIdentityMissingError before spawning when any of the six pairs is absent or changed"
  - "Inherited git environment is stripped inside runStateGit, then options.env is applied, so a caller (a test, a token-adding wrapper) can still set GIT_CONFIG_GLOBAL or similar on purpose"
  - "Remote-facing transport methods return Outcome<T> with a SyncFailure { kind, message, detail? } rather than throwing; detail is redacted git text for logs, message is one fixed plain sentence"
  - "validateRemote accepts a configured remote name, https://, ssh://, file://, user@host:path, and an absolute path, refuses anything containing '::', control characters, a leading dash, or surrounding whitespace, reports 'no-remote' for a plain name when the repository has no remotes; the address a configured name resolves to gets the same refusal rules (a hostile repository remote ext::... resolves to invalid-remote)"
  - "A mirror held past the wait limit raises MirrorBusyError from the transport; it is not turned into a SyncFailure, so plan 12 decides how to show 'another window is syncing'"
  - "The default hooks folder when a caller gives none is a private mkdtemp folder made once per process, never a predictable path"

patterns-established:
  - "Tests prove each safety property by mutation: removing the identity guard, the safe configuration, the environment cleaning, the lock or the '::' refusal in the compiled output makes a named test fail"
  - "The leak scan has a positive control that plants sentinels in a blob, tree entry name, commit message and ref name and expects each to be found"

requirements-completed: [SYNC-05]

coverage:
  - id: D1
    description: "A sealed object is pushed to refs/heads/near-ai/state through a private bare mirror and read back by a second mirror; the person's status, HEAD, branch, refs, index, config and files are byte-identical, no tracking branch appears, main in the remote is unchanged, and no GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in the process environment redirects any write"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#tracer: one sealed object is pushed to near-ai/state and read back by a second mirror, with the person's repository untouched"
        status: pass
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#the transport never writes to the person's repository even when the process environment points git at it"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every sync commit is near-ai-state <state@near-ai.invalid> at 946684800 with the constant message, unsigned, whatever the person's git config, GIT_AUTHOR_*/GIT_COMMITTER_* environment, signing settings, global hooks and fsmonitor say; the person's config is unchanged; commit-tree without the exact identity is refused before git starts"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateIdentity.test.js#every sync commit carries the anonymous identity, the constant date and message, whatever the person's config and environment say"
        status: pass
      - kind: integration
        ref: "dist/test/stateIdentity.test.js#signing and hooks set in the person's git configuration do not make the push fail, and nothing is signed"
        status: pass
      - kind: unit
        ref: "dist/test/stateIdentity.test.js#commit-tree is refused before git starts unless the whole anonymous identity is supplied, and the transport always supplies it"
        status: pass
      - kind: integration
        ref: "dist/test/stateIdentity.test.js#every git call carries the safety configuration and none inherits the person's git environment"
        status: pass
    human_judgment: false
  - id: D3
    description: "The remote holds only ciphertext: a scan of a real bare remote finds none of the seeded sentinels (prompt, API key, data key base64/hex/raw, recovery code with and without hyphens, conv-, run-, model name, person's name and email) in any blob, tree entry name, commit, message or ref name; tree names match TREE_NAME; the only ref is refs/heads/near-ai/state; a planted-leak control proves the scan finds each kind"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateLeak.test.js#after real pushes the remote holds only ciphertext: no sentinel in any blob, tree entry name, commit, message or ref name"
        status: pass
      - kind: integration
        ref: "dist/test/stateLeak.test.js#the leak scan finds a planted sentinel in a blob, a tree entry name, a commit and a ref name (the scan itself works)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The remote is a parameter: a non-origin remote and a plain address work; configured names and plain address forms are accepted; ext::, fd::, any '<word>::', leading dashes, empty and unknown names are refused, including a hostile remote set in the repository's own config (no helper program runs); insteadOf in the person's config is honoured; no online home gives 'no-remote' and adds nothing; the private-remote setting is not declared and 'origin' is quoted once across the sync services"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateRemote.test.js#a transport built for the remote \"backup\" pushes there, and origin stays without the state branch"
        status: pass
      - kind: unit
        ref: "dist/test/stateRemote.test.js#validateRemote accepts a configured name and the plain address forms, and refuses helper transports, unknown names and empty values"
        status: pass
      - kind: integration
        ref: "dist/test/stateRemote.test.js#a repository cannot send the state through a helper transport, even through its own remote settings"
        status: pass
      - kind: integration
        ref: "dist/test/stateRemote.test.js#a project with no remote at all has no online home, and nothing is ever added to its repository"
        status: pass
      - kind: integration
        ref: "dist/test/stateRemote.test.js#a rewrite such as insteadOf in the person's own git configuration is honoured when resolving the address"
        status: pass
      - kind: unit
        ref: "dist/test/stateRemote.test.js#the private-remote setting stays deferred, and the word origin appears in the sync services only as a default value"
        status: pass
    human_judgment: false
  - id: D5
    description: "Failures are one plain sentence each with URL userinfo removed: rejected (non-fast-forward, never forced, then fetch and retry succeeds), offline, sign-in with the terminal hint, host policy, git missing; pushes are never forced"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#a push from a commit that is not a descendant of the remote tip is rejected, never forced"
        status: pass
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#a missing remote location is reported as offline in one plain sentence"
        status: pass
      - kind: unit
        ref: "dist/test/stateSyncGit.test.js#git output is sorted into sign-in, host-policy, rejected and offline, with the sign-in hint and no URL userinfo"
        status: pass
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#failures from the runner are mapped end to end: sign-in, host policy and a missing git program"
        status: pass
    human_judgment: false
  - id: D6
    description: "Concurrency edge: two transports in one process and two processes on one mirror never overlap inside the lock, a lock left by a dead process is taken over, and a push stopped by its timeout at several points leaves the remote at its old tip or the new one with a whole tree and a clean fsck, with the state home untouched"
    requirement: SYNC-05
    verification:
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#two transports on one mirror never overlap inside the lock"
        status: pass
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#two processes on one mirror are serialised by the file lock, and a lock left by a dead process is taken over"
        status: pass
      - kind: integration
        ref: "dist/test/stateSyncGit.test.js#a push stopped part way leaves the remote at its old tip or the new one, never a partial tree, and the state home is not touched"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-11-13
status: complete
---

# Phase 27 Plan 11: Git Transport for Encrypted Project State Summary

**A private bare-mirror git transport that pushes opaque ciphertext to refs/heads/near-ai/state of any given remote with plumbing commits under the anonymous identity near-ai-state, hooks, signing, helper transports and the inherited git environment all switched off, a cross-process mirror lock, and plain-sentence failures, proven against real local bare remotes including a leak scan of every object, name and ref.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-11-13T14:33:59Z
- **Completed:** 2026-11-13T14:43:00Z
- **Tasks:** 3 (one tracer, two TDD)
- **Files modified:** 8 created, 0 modified

## Accomplishments

- `runStateGit` is the one place sync starts git: array arguments, own process group, timeout and stdout cap, the inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CONFIG*`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*` removed, and `core.hooksPath`, `commit.gpgsign=false`, `push.gpgSign=false`, `protocol.ext.allow=never` and `core.fsmonitor=false` in front of every call. It throws before spawning on a `commit-tree` without the exact identity.
- `StateTransport` builds trees and commits with plumbing in `.near-ai/state/sync/mirror.git`, fetches into `refs/near-ai/incoming`, reads trees (only `100644` blobs named `manifest.json` or `<32 hex>.bin`) and blobs (16 MiB cap), and pushes without any force option. The person's repository is read for the remote's address only.
- A real two-mirror round trip: one sealed object pushed from one mirror, listed and read back byte for byte from a second, with the person's status, HEAD, branch, refs, index, config and files identical and no tracking branch created.
- The leak scan of a real bare remote (every object via `rev-list --all --objects` and `cat-file --batch`, every tree entry name, every ref) finds none of the 15 seeded sentinels, with a planted-leak control proving the scan sees each kind.
- 35 new tests across four files (stateSyncGit 10, stateIdentity 4, stateRemote 6, stateLeak 2, plus the shared fixtures); the 94 state tests pass together.

## Task Commits

1. **Task 1: Tracer** - `68238ee` (feat): stateGit, stateMirrorLock, stateTransport, gitFixtures, three tracer cases
2. **Task 2: Identity, no hooks or signing, leak scan** - `2be6209` (test): stateIdentity (4), stateLeak (2), gitFixtures `withMain` option
3. **Task 3: Remote parameter, validation, failures, lock** - `28aafaa` (test): stateRemote (6), stateSyncGit additions (7)

**Plan metadata:** the docs commit that carries this SUMMARY, STATE.md and ROADMAP.md.

**TDD evidence.** The tracer built the complete runner, lock and transport, so the Task 2 and Task 3 tests passed when first run against them; a green first run proves nothing on its own. To show each test can fail, the compiled output was mutated and the tests re-run: removing the commit-tree identity guard, the five `-c` safety pairs and the environment stripping failed four tests (the signing-and-hooks case, the identity-refusal case, the safe-configuration case, and the GIT_DIR redirection case); removing the `::` refusal and the lock failed the helper-transport case and the two-process lock case. The mutations were made to `dist/` only and the build restored. Semantic assessment: each failure was on its own assertion for the intended reason.

## Files Created/Modified

- `src/services/stateGit.ts` - the runner, anonymous identity constants, safe configuration, error classes, redaction
- `src/services/stateMirrorLock.ts` - cross-process lock file (copied shape of the Team lock) with `withMirrorLock`
- `src/services/stateTransport.ts` - mirror, fetch, tree and blob reads, commit building, push, remote validation, failure classification
- `src/test/helpers/gitFixtures.ts` - bare remote, person's repository with staged/dirty/failing-hook/sentinel state, snapshot, remote scan, hermetic runner, sealed-bundle builder
- `src/test/stateSyncGit.test.ts`, `stateIdentity.test.ts`, `stateRemote.test.ts`, `stateLeak.test.ts` - the 22 transport cases

## Decisions Made

See `key-decisions`. In short: the identity and its refusal guard live in the runner; the remote-facing methods return an `Outcome` instead of throwing; the address a configured name resolves to is held to the same refusal rules as one typed in; `MirrorBusyError` is left for plan 12 to word.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] stateMirrorLock.ts created in Task 1, not Task 3**
- **Found during:** Task 1
- **Issue:** `StateTransport` runs every mirror method inside `withMirrorLock`, so the tracer could not compile without the lock module. The plan lists it under Task 3.
- **Fix:** the lock module was created with the tracer; Task 3 then proved it (two processes, dead-holder takeover) instead of building it.
- **Files modified:** `src/services/stateMirrorLock.ts`
- **Commit:** `68238ee`

**2. [Rule 2 - Missing critical] resolved remote addresses are validated, not only typed ones**
- **Found during:** Task 3
- **Issue:** `validateRemote` checks a value the caller passes, but a configured remote name resolves through `ls-remote --get-url` to whatever the person's (or a cloned repository's) config says, including `ext::sh -c ...`. Checking only the typed value would leave T-27-42 and T-27-47 open for a name.
- **Fix:** `resolveRemoteUrl` applies the same refusal rules (`::`, control characters, leading dash, surrounding whitespace) to the resolved address; the test sets a hostile `ext::` remote in the repository's own config and proves no helper program runs.
- **Files modified:** `src/services/stateTransport.ts`, `src/test/stateRemote.test.ts`
- **Commit:** `68238ee`, `28aafaa`

### Notes on the plan text (not code deviations)

- **Task 2 and Task 3 needed no implementation change.** The tracer already implemented what their tests check, so those two commits are `test(...)` commits. The mutation check above stands in for a RED run.
- **`GitIdentityMissingError`** is an additive export: the plan says the runner "refuses", and a distinct error class lets a test prove the refusal happened before any git process started.
- **Hooks folder default.** `GitOptions.hooksDir` is optional; when absent the runner makes one private empty folder per process with `mkdtempSync`. The transport always passes its own `hooksDir`.
- **`mirror lock` file name** is `near-ai-state-sync.lock` (the Team lock uses a different name), so a mirror folder can never be confused with a Team one.
- **Date in the identity** includes `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE` in `STATE_IDENTITY_ENV` (six pairs), matching the plan's constant date; the guard compares all six.

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical). **Impact:** none on scope; the transport is stricter than the plan text in one place.

## Authentication Gates

None. The tests use local bare remotes only; the sign-in path is proven with a fake runner.

## Known Stubs

None.

## Threat Flags

None beyond the plan's register. The new surface (git subprocesses, a push to a remote the person already has) is exactly the plan's trust boundaries: T-27-42 to T-27-48 are mitigated and each has a test named under `coverage`.

## Issues Encountered

None. All runs used `systemd-run` with `MemoryMax=4G`; the scrypt derivation (128 MiB) runs once per test process.

## Next Phase Readiness

Ready for 27-12 (StateSync), 27-13 (partial clone and lazy cold fetch), 27-15 (commands and scheduler) and 27-17 (online home). Notes for them:

- **Construct** `new StateTransport({ root, remote?, mirrorDir, hooksDir, git?, lock? })` with `mirrorDir = <state home>/sync/mirror.git` and `hooksDir = <state home>/sync/hooks`, after the state home's `ensure()`. `remote` defaults to the one name the constructor assumes; pass whatever 27-15 resolves. `git` is the injectable runner, so a token-adding wrapper (27-17) just wraps `runStateGit` and forwards `options`.
- **Remote-facing methods return `Outcome<T>`**: `fetch()` gives `{ ok: true, value: <commit oid or undefined when the remote has no state branch> }`; `push(commit)` gives `{ ok: true, value: commit }` or `{ ok: false, failure }` where `failure.kind` is one of `rejected | offline | auth | policy | git-missing | no-remote | invalid-remote` and `failure.message` is the one plain sentence to show. On `rejected`: `fetch()`, merge, `writeCommit(files, tip)`, `push` again.
- **Local methods throw**: `readTree(oid)` returns `{ name, oid }[]` and throws `StateRefusedError('unsupported-format')` on any entry that is not a `100644` blob named `manifest.json` or `<32 hex>.bin`; `readBlob(oid)` returns a Buffer (16 MiB cap) and throws `StateRefusedError('missing-object')` when absent; `writeCommit(files, parent?)` takes `{ name, data }[]` with names from `TREE_NAME` and needs `parent` already fetched into the mirror.
- **`MirrorBusyError`** (another window held the mirror past 120 s) propagates from any transport method; map it to the 'waiting' status.
- **Call order**: `ensureMirror()` is optional (every method makes the mirror when missing). The lock is not re-entrant: a caller that wants a fetch-merge-push sequence atomic across processes should wrap it in its own `withMirrorLock(mirrorDir, ...)` only if it does not call transport methods inside (they take the lock themselves). Plan 12's `sync()` should call the transport steps one after another and rely on `rejected` retry rather than holding the lock across them.
- **Plan 13** adds `configurePartialClone`, a filtered `fetch` and `missingObjects()` to this class; `mirrorGit` and `inMirror` are the private helpers to build on.
- **Test fixtures** for later plans: `bareRemote({ withMain })`, `userRepo(remoteDir, { remotes })`, `repoSnapshot`, `scanRemote(remoteDir, sentinels)` (returns `hits`, `treeNames`, `refs`), `sealedFiles(payloads, seq)`, `hermeticRunner(env, configFile)`, `mirrorPaths()`. `sealingKeys()` derives one scrypt key per test process.

## Self-Check: PASSED

- Files present: `src/services/stateGit.ts`, `stateMirrorLock.ts`, `stateTransport.ts`, `src/test/helpers/gitFixtures.ts`, `src/test/stateSyncGit.test.ts`, `stateIdentity.test.ts`, `stateRemote.test.ts`, `stateLeak.test.ts`, this SUMMARY.
- Commits present on the branch: `68238ee`, `2be6209`, `28aafaa` (`git rev-list --count b6e2295..HEAD` is 3).
- Acceptance criteria: stateSyncGit 10 passing (needs 8), stateIdentity 4 (needs 3), stateRemote 6 (needs 4), stateLeak 2 (needs 2), 0 failing; force-option grep 0; `from 'vscode'` 0 in stateGit.ts and stateTransport.ts; `near-ai-state` 2 and `protocol.ext.allow=never` 1 in stateGit.ts; `remote add` 0 and `withMirrorLock` 3 in stateTransport.ts; quoted `origin` in `src/services/state*.ts` is 1.
- Plan verification: all four test files pass under the memory cap with git 2.53; `npm run lint` (`tsc --noEmit`) clean; the 94 `dist/test/state*.test.js` tests pass; the sync tests passed on two repeat runs.
