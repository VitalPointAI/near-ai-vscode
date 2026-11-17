---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 16
subsystem: gate
tags: [floor, shell-classifier, effect-tags, credential-stores, shadow]

requires:
  - phase: 70-15
    provides: "PR 2 (#70), merged into main as f079b3d; main now at 93fa275 (0.4.28)"
provides:
  - "CommandEffect and CommandClassification.effects: publish, send, destroy and protected-write tags at every site, gathered through every wrapper"
  - "shellReachesCredentialStore in src/agent/tools.ts"
  - "floorFactsFor in src/agent/gateAdapter.ts, called for every shell call in every mode"
  - "GateRuntime.locations (home folder and global storage), set by the GateHost"
affects: [70-17]

pr3_base: 93fa275346f402a9490352b49031d3cc84e68f8c

actuals:
  tokens: 28234
  tasks: 3
  commits: 3
plan_head_before: 93fa275346f402a9490352b49031d3cc84e68f8c
plan_head_after: 4e4a6f599dc289d7dbd1c3e6ba9d1dad0d84e787

tech-stack:
  added: []
  patterns:
    - "Effects gathered in a per-call frame for the whole classifyCommand call, so no wrapper can drop a tag (Pitfall 2 fixed as a class)"
    - "First verdict wins, every part still read: an early verdict no longer stops effect collection"

key-files:
  created:
    - src/test/commandEffects.test.ts
    - src/test/gateCredentialStores.test.ts
  modified:
    - src/agent/commandSafety.ts
    - src/agent/gateAdapter.ts
    - src/agent/loop.ts
    - src/agent/tools.ts
    - src/domain/gate/decide.ts
    - src/domain/gate/floor.ts
    - src/gate/host.ts
    - src/services/gateCommands.ts

key-decisions:
  - "Effects are collected in a frame for the whole classifyCommand call instead of being copied by hand from inner.effects at each wrapper; risky() and unknown() still take effects"
  - "classifyText no longer returns at the first risky part: the first verdict decided is still the one returned, the rest of the line is read only for effects (verdict and reason parity: 36,792 classifications against the PR3_BASE build, 0 differences)"
  - "A protected-write fact is not set separately: workspaceWrite and destroy paths carry it, and floorFor's isFloorProtectedWrite keeps the team.md exemption in one place"
  - "A non-recursive rm of a scratch file (/tmp, the project's scratch folder) is not tagged destroy, matching the recursive rule"
  - "The floor's package.json read is cached per run and read again when its size or time changes, so a run cannot rewrite a script and then run it unseen"

requirements-completed: []

duration: 17 min
completed: 2026-11-17
status: complete
---

# Phase 70 Plan 16: The classifier tags publishing, destruction and protected writes, credential stores are detected, and the gate sees both for every shell call in shadow Summary

**`classifyCommand` now returns structured `effects` (publish with its target, send, destroy with paths, protected workspaceWrite) gathered through every wrapper; `shellReachesCredentialStore` resolves a command's words against a session home and global storage; `floorFactsFor` hands both to `decide()` for every shell call in every mode, and in shadow every decision is exactly today's.**

PR3_BASE: **`93fa275346f402a9490352b49031d3cc84e68f8c`** (main at 0.4.28). PR 2 (#70) was merged into main as f079b3d before this plan, so `feat/gate-floor` branches straight from main and no rebase is needed.

## Performance

- Duration: about 17 minutes of wall time for the three tasks (plus reading).
- Tasks: 3 of 3. Commits: 3 (measured from the ledger).
- Files: 2 created, 8 modified; 901 insertions, 68 deletions.

## Task Commits

1. **Task 1 (tracer): git push is tagged publish, survives npm run, reaches the gate in fully-autonomous** - `2f3b727` (feat)
2. **Task 2: every publish, destroy and protected-write site tagged, through every wrapper** - `0a669b3` (feat)
3. **Task 3: credential stores and the extension's own folders detected for every shell call** - `4e4a6f5` (feat)

Each task was red first: the new tests were compiled and run against the unchanged source and failed (Task 1: 3 of 4 failing; Task 2: 5 of 11; Task 3: 7 of 8, plus type errors), then passed after the change.

## What was built

### Effect tags (src/agent/commandSafety.ts)
- `CommandEffect` is a vocabulary `Capability` of verb `publish`, `send`, `destroy`, `workspaceWrite` or `network`; `CommandClassification.effects` is set only when there is one.
- Publish targets: `git-remote` (git push of any kind, gsd subrepo verbs), `registry` (npm/pnpm/yarn/bun publish and the registry-account verbs, vsce, ovsx, twine, gem, cargo), `container-registry` (docker and podman push, image push), `release` (gh and glab release create, upload, edit, delete, delete-asset, gh api writes on `/releases`, semantic-release, release-it, np, changeset, lerna, release-named scripts and make targets), `deploy` (kubectl, helm, oc, terraform, tofu, pulumi, cdk, serverless, sls, vercel, netlify, firebase, wrangler, fly, heroku, gh-pages, aws, gcloud, az, gsutil), `chain` (near transactions). `git send-email` is `send{channel: email}`.
- Destroy: git reset --hard/--merge/--keep, git clean (not a dry run; named paths or `**`), rebase, filter-branch, filter-repo, replace, commit --amend, branch delete or force, tag delete or force, stash drop and clear, reflog expire and delete, gc, prune, update-ref, the D-45 discards (checkout over files with the paths after `--`, checkout -f, restore of the worktree with its paths, switch --discard-changes and the other forced switches), recursive deletes outside scratch and build output, rm/rmdir/unlink outside the workspace, find -delete and -exec rm, xargs rm, and the disk destroyers.
- Protected writes: every `checkWrites` target, every redirect target, and rm of a protected path, tagged `workspaceWrite` with the project-relative path; `.planning/.near-ai/team.md` is tagged and the floor exempts it (D-44), `labels.json` is not exempt.
- No tag: gh pr create, gh pr merge, gh issue comment and other GitHub writes (D-46), docker and podman login and logout, rm -r of build output or a temporary folder, dry runs, an empty or whitespace command, rm -r with no operand.

### Credential stores (src/agent/tools.ts)
`shellReachesCredentialStore(command, context, { home, globalStorage })` returns `{ credentialStore?, identityFiles? }`. It runs the floor's text checks (`namesCredentialStore`, `namesIdentityFiles`, keychain commands), then resolves each word against the shell's folder, each `cd`/`pushd` target and a bare `cd` (home), with `~`, `$HOME` and `${HOME}` expanded, braces expanded, glob segments read as matching a store name, and the first 128 words resolved through links (realpath only: no file is opened or listed).

### The gate (src/agent/gateAdapter.ts and the loop)
`floorFactsFor({ command, root, cwd, home, globalStorage, packageScripts, trustedRoots, gsdPreambles })` returns `{ effects, facts: { credentialStore?, identityFiles? } }`. `gateToolCall` calls it for every call with a command, in every mode, adds the effects after the manifest's own (an unknown, empty effect list stays empty) and passes the facts as `floorFacts`; decide() is also given `runtime.locations`. The loop builds the cheap context per shell call (`floorShellContext`), with package.json read once per run and again only when it changes. `GateRuntime.locations` is new and optional; `GateHost.runtimeFor` sets the global storage and, when given, the home folder; the activation adapter passes `homedir()`.

## Verification

| Run (all inside the memory cap) | Result |
|---|---|
| Task 1 verify: tsc, commandEffects, commandSafety, autoApproval | 57 tests, 57 pass, 0 fail |
| Task 2 verify: commandEffects, commandSafety, approvalRisk, autoApproval, gsdPreamble, protectedPaths, teamStorage, autoAdvance | 107 tests, 107 pass, 0 fail |
| Task 3 verify: gateCredentialStores, commandEffects, protectedPaths, agentTools, gateFloor, gateEnumeration, gateRefusalRecords, gateHostStart, gateHostClock, gateActivation, gateCommands, gateDecide, gateNoFolder, gateOffline, agentLoop | 177 tests, 175 pass, 0 fail, 2 skipped (ripgrep not installed, existing) |
| Full `npm test` (6G, 1800s), once at the end | exit 0; 3248 tests, 3239 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before this plan) |
| Verdict and reason parity: 916 string literals from commandSafety, autoApproval, protectedPaths, gsdPreamble, approvalRisk and commandEffects tests, each plain and in 13 wrappers, under 3 contexts, classified by the PR3_BASE build and by this build | 36,792 classifications, 0 differences |

- `git diff 93fa275..HEAD -- src/test/commandSafety.test.ts src/test/autoApproval.test.ts src/test/approvalRisk.test.ts src/test/protectedPaths.test.ts src/test/agentTools.test.ts src/test/gateFloor.test.ts src/test/gateEnumeration.test.ts` is empty.
- `grep -n "homedir()" src/test/gateCredentialStores.test.ts src/test/commandEffects.test.ts` prints nothing. The credential test asserts its home starts with the run's temporary folder (and TMPDIR when set); no test runs a command.
- commandEffects has one row per research 4.3 site plus the six D-45 discards (164 rows: 96 publish, 56 destroy, 12 protected write), each run plain and wrapped ten ways (npm run, bash -c, sh -c, xargs, a pipe, &&, ||, ;, a subshell, $(...)); xargs is checked by kind of effect because what it deletes is decided at run time. A further test checks every tag parses as a vocabulary request capability.

## Deviations from Plan

### Context the plan predates
1. **[Precondition] PR 2 is merged, not open.** The precondition names `feat/gate-shadow` and its rebased tip. PR #70 was merged into main (f079b3d) before this plan, so per the orchestrator the branch was created from main at 93fa275 and PR3_BASE is that commit. No rebase is needed.
2. **[Names] Line numbers had drifted;** every site was found by its text. Gate tests build runtimes with `testGateRuntime` from `src/test/helpers/gatedRuns.ts`.

### Auto-fixed issues and additions
1. **[Rule 2 - Missing critical] Effects gathered as a class, not per wrapper.** Instead of copying `inner.effects` at each rebuild site (which the next wrapper written would forget, Pitfall 2), `classifyCommand` opens a frame and every tag lands in it, wherever the result goes. `risky(reason, effects)` and `unknown(reason, effects)` still exist as the plan asks. Commit 2f3b727.
2. **[Rule 2] An early verdict no longer hides later parts.** `classifyText` returned at the first risky part, so `cat ~/.ssh/config; git push`, `git push > /etc/out`, `sudo ls && git push`, a fork-bomb or curl-to-shell prefix all hid a later publish from the floor. The first verdict decided is still returned (parity above); the rest of the line is now read for effects only. Commit 0a669b3.
3. **[Rule 2] More wrappers than the plan names.** Effects are also read through sudo, doas, pkexec and `su -c`, eval, `bash -c`/`sh -c` (and -lc and the like, zsh, dash, ksh, fish, csh), `{ ... }` groups, if/then/else/while/until/do/!, exec, setsid, allow-listed parts (the allow list decides the verdict, never what the floor sees), the redirects of a pipe-into-xargs segment, and what follows an Open-GSD preamble when the runtime was not checked. Verdicts unchanged. Commit 0a669b3.
4. **[Rule 1] `npm run ship` read its body.** A release-like script name returned before its body was read, so `npm run ship` whose script is `git push` could not carry `git-remote`. Every pre/main/post script is now read; the name alone tags `publish{release}` only when the body shows no publish. Commit 2f3b727.
5. **[Rule 2] package.json read once per run, and again when it changes.** Strictly once would let a run rewrite a script and then run it unseen; the cache key is the file's size and time. Commit 2f3b727.
6. **[Rule 2] Unknown effects stay unknown.** A call whose manifest effects are empty (unknown, enforce) gets no command effects added, so a command can never turn "effects unknown" into known. Commit 2f3b727.
7. **[Scope] Files outside the plan's list:** `src/agent/loop.ts` (the per-call floor context), `src/domain/gate/decide.ts` (`GateRuntime.locations`), `src/domain/gate/floor.ts` (exports `credentialReason` and `identityFilesReason`), `src/gate/host.ts` (locations; optional `home` option), `src/services/gateCommands.ts` (passes `homedir()`). The runtime carries home and global storage because only the host knows global storage.
8. **[Choice] Paths in effects:** project-relative inside the workspace; `**` for the workspace itself, anything outside it, a path decided at run time, and history or ref operations (reset, rebase, branch, tag, reflog, gc). Every tag parses as a vocabulary request (tested).
9. **[Choice] Plain deletes:** rm of a scratch file (`/tmp`, the project's scratch folder) is not destroy, matching the recursive rule; rm of a protected file is a `workspaceWrite` (so deleting team.md is exempt like writing it, and labels.json asks); a recursive delete of a protected folder is `destroy` with its path, which the floor reads as `floor.protected-write`.
10. **[Choice] git branch:** only delete and force (`-d`, `-D`, `--delete`, `-f`, `--force`, `-M`, `-C`) are destroy; a plain rename, copy or upstream change stays risky with no tag.
11. **[Choice] Name-only publish targets** (release-named scripts, make targets, gsd release verbs, an npx tool called with a release word) are `release`.
12. **[Tooling] Test commands** used `node scripts/run-tests.mjs <files>` (the repo's runner, which gives each run its own TMPDIR) instead of a bare `node --test`, inside the same cap.

## Notes for plan 17

- **The bundle ceiling now sees command effects.** `ceilingRefusal` checks every verb in `request.effects`, in shadow too. With the default bundle (every verb but gpu in interactive and unattended) nothing changes, and no other bundle can exist today. A narrowed bundle that removes `publish`, `destroy`, `send` or `workspaceWrite` from a context would refuse matching shell calls as `bundle.ceiling.context`; that is arguably the ceiling's job, but it is a decision change to keep in mind.
- **What enforce will change:** every Bash call now carries its tags, so in enforce `git push`, `npm publish`, `rm -rf src`, `git reset --hard`, `git rebase --continue`, `git gc`, `git commit --amend` and the rest ask in every mode including fully-autonomous, and are refused with no person present. Look at `git rebase --continue` and `git gc` before enforcing (tagged per research 4.3, but routine).
- **Floor rule order:** `rm -rf .git` records `floor.protected-write` (it comes before `floor.destroy`); both ask.
- **Records:** the record's capability is still `effects[0]`, the manifest's own shell effect, so record shapes do not change.
- **FLOOR_CANNOT_SEE_TEXT** says the checks cannot see "a folder change followed by a bare file name"; `shellReachesCredentialStore` now does see `cd ~ && cat .netrc` and a shell already in the home folder. The sentence is still true of what remains (a path built at run time, a walk from a parent, a folder change in an earlier command the shell's folder does not show); plan 17's docs may want to say it more exactly.
- **Known limits to name:** nesting deeper than the classifier's limit (depth 4) yields no effects; `bash -c "$VAR"`, `source file`, text piped into `sh`, and wrappers the rules do not know (stdbuf, flock, watch) are not read; a script rewritten earlier in the same command line is read as it was.
- **A run with no host** (`unavailableGateRuntime`) has no locations, so word resolution has no home; the text checks still match `~/` and `$HOME/`. It is failed closed anyway.

## Owner questions for the PR 3 body

1. **D-46:** should `gh pr create`, `gh pr merge` and `gh issue comment` be publishing on the floor? Today they carry no tag and stay with the settings layer.
2. **Registry account verbs:** research 4.3 lists npm `login`, `logout`, `adduser` and `token` and cargo `login` and `logout` as publish, and they are tagged so; the plan says docker `login` and `logout` are not. One rule for both would be clearer.
3. **Scratch deletes:** a plain `rm` of a file in `/tmp` or the project's scratch folder is not destruction here (research 4.3 named no exception for :790).
4. **Routine git maintenance:** `git gc`, `git prune` and `git rebase --continue` are tagged destroy per research 4.3; confirm before enforce.

## Known Stubs

None.

## Threat Flags

None. No new network endpoint, auth path or schema. The new file-system access is `realpath` and `stat` on paths named in a command (and package.json read per run); no file a command names is opened or listed.

## Self-Check: PASSED

- FOUND: src/test/commandEffects.test.ts, src/test/gateCredentialStores.test.ts, this SUMMARY
- FOUND in HEAD's history: 2f3b727, 0a669b3, 4e4a6f5
