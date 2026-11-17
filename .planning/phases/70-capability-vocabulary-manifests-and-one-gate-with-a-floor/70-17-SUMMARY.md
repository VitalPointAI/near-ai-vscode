---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 17
subsystem: gate
tags: [floor, enforce, fully-autonomous, late-approval, trusted-roots, docs]

requires:
  - phase: 70-16
    provides: "command effect tags, shellReachesCredentialStore, floorFactsFor, GateRuntime.locations (PR3_BASE 93fa275)"
provides:
  - "decide() with no floor mode: the floor is enforced in every mode and context"
  - "ApprovalRequest.floor and the one-shot late approval (floorApprovalsOnce, a WeakMap keyed by the run's RunGrants)"
  - "awaitingApprovalMessage(floor) in src/agent/loop.ts"
  - "readCallPaths in src/agent/gateAdapter.ts: trusted-folder reads are known reads; file-tool paths that name a credential store or the identity folders are floor facts"
  - "effectsOfCall(tool, raw, root) and async effectsOfStep(tool, raw, root, readOnlyRoots, locations): no stand-ins"
  - "FLOOR_EFFECTS_CANNOT_SEE_TEXT beside a rewritten FLOOR_CANNOT_SEE_TEXT"
  - "src/test/gateFloorRuns.test.ts"
affects: [70-18, PR 3 body]

pr3_base: 93fa275346f402a9490352b49031d3cc84e68f8c

actuals:
  tokens: 45512
  tasks: 3
  commits: 4
plan_head_before: fbfccd55f7d6365707cfdbdbd3e611ad619668ee
plan_head_after: 9e76b0c3c12684c7ac95384d5a2abfed38d67354

tech-stack:
  added: []
  patterns:
    - "A late floor approval lives beside RunGrants (WeakMap), never in it, keyed by tool, folder, shell folder and canonical arguments, and is used up by one call"
    - "A trusted-folder read is rewritten as a read of `**` (judged at least as strictly as a project read) and the record names the file by folder name and inner path"
    - "Each documented gap of the publishing and destruction checks is asserted to be a real gap, so the text cannot drift in either direction"

key-files:
  created:
    - src/test/gateFloorRuns.test.ts
  modified:
    - src/domain/gate/decide.ts
    - src/domain/gate/floor.ts
    - src/domain/gate/record.ts
    - src/agent/gateAdapter.ts
    - src/agent/loop.ts
    - src/gate/host.ts
    - src/services/agentSession.ts
    - src/services/cyberAssembly.ts
    - src/services/cyberRun.ts
    - src/services/approvalPolicy.ts
    - media/chat/chat.js
    - package.json
    - SECURITY.md
    - README.md
    - src/test/protectedPaths.test.ts
    - src/test/gateDecide.test.ts
    - src/test/gateDocs.test.ts
    - src/test/approvalPolicyPicker.test.ts
    - src/test/helpers/gatedRuns.ts
    - "this phase's gate tests: gateEnumeration, gatePathCover, gateRefusalRecords, gateHostStart, gateHostClock, gateNoFolder, gateActivation, gateCredentialStores, commandEffects"

key-decisions:
  - "The floor has no mode: FloorMode, GateOptions.floorMode, GateRuntime.floorMode, RuntimeRequest.floorMode and GateDecision.shadowFloor are removed; the record format keeps its optional shadowFloor field so 0.4.28 records still read, and nothing writes it"
  - "A call whose effects are unknown is still refused by the floor when what it names (floor facts or command text) reaches a credential store or the identity folders; the loop's own forbidden hook keeps its own path"
  - "Trusted folders: the run's readOnlyRoots (the Open-GSD runtime) for chat calls, an engagement's resolved scope paths for cyber steps; an argument read only by read effects whose real path lies inside one is written as `**`; writes are never rewritten"
  - "A floor card's reason keeps the settings layer's own words when it would have asked anyway, then the floor's sentence"
  - "The page shows no 'Allow this command for this run' on a floor card (it would grant nothing)"
  - "Full auto's picker summary, description and confirmation dialog now say what still asks"

requirements-completed: [GATE-04, GATE-05, GATE-06]

duration: 31 min
completed: 2026-11-17
status: complete
---

# Phase 70 Plan 17: The floor is enforced in every mode, with one-shot late approvals and docs that match Summary

**decide() has no floor mode any more: in every approval mode, fully-autonomous included, protected writes, publishing, destruction and shared-knowledge writes ask with no grant and no "always allow" (refused when nobody is there), key and credential stores are refused with no card, a sub-agent's floor card approved late runs that exact call once, trusted folders outside the project keep being readable, and SECURITY.md and README say exactly this in the same branch.**

## Performance

- Duration: about 31 minutes of wall time (03:28 to 03:59 UTC), plus reading.
- Tasks: 3 of 3. Commits: 4 (measured from the ledger: `fbfccd5..9e76b0c`).
- Files: 1 test file created, 28 files modified; 1157 insertions, 256 deletions.

## Task Commits

1. **Task 1 (tracer): the floor is enforced, the one test that pinned the old behaviour changed on purpose** - `2da49a0` (feat!)
2. **Task 2: the floor through real runs, one-shot late approvals, trusted folders** - `c02ccca` (test, with one decide() fix)
3. **Task 3: SECURITY.md and README describe the enforced floor** - `732fef9` (docs, with the floor's texts and Full auto's UI copy)
4. **Follow-up: the old option is named in tests only by construction, so `grep -rn floorMode src` prints nothing** - `9e76b0c` (test)

The tracer gate after Task 1 re-ran its verify end to end (87 of 87) before Task 2 started. Red first: Task 2's new tests were run with the floor's asks disabled (3 of 6 failed), with only the one-shot consumption disabled (the late-approval test failed), and with the trusted-folder rewrite and path facts disabled (both new tests failed); Task 3's gateDocs checks were run against the old SECURITY.md and README (5 of 14 failed). Each probe was a temporary edit restored with `git checkout -- <file>`.

## What was built

### The floor, enforced (D-19, GATE-05)
- `decide()` has no options that change the floor. A floor refusal denies with no card; a floor ask asks with `floor: true`, `offerAlwaysAllow: false`, `allowGrant: false`, or, with presence none, is refused with "Nobody is here to approve this, and it always needs a person: ...". The deny list (a settings deny) and the emergency stop still come first.
- Every former shadow site is switched in the same commit: the lead run and the sub-agent run in `agentSession.ts`, the cyber panel in `cyberAssembly.ts`, `unattendedRuntimeFor` (comparison and team-studio panels, presence none), `unavailableGateRuntime` (loop, cyberRun and benchmark fallback), and the consumers `effectsOfCall` and `effectsOfStep` (no stand-in: an unfillable call is `manifest.effects-unknown`). A source scan in gateDecide fails if any product file under `src` names a floor mode again.
- New in decide(): a call whose effects are unknown is still refused by the floor when its floor facts or command name a credential store or the identity folders (found by gateFloorRuns; the loop's own `forbidden` refusal keeps its path, so gateRefusalRecords is unchanged).

### Cards and late approvals (GATE-04, D-43, Pitfall 4)
- The loop puts `floor: { callKey }` on the ApprovalRequest of a floor ask and never a grant or an allow rule; an allow, allow-run or allow-always runs that one call and grants nothing.
- `floorApprovalsOnce(grants)` keeps late floor approvals beside the run's grants. `lateApproval` adds the card's key for a floor card (never `grants.commands`, `grants.edits` or an allow rule) and tells the lead `decision="allowed-once"`; `gateToolCall` asks decide() again, and when the call is still a floor ask and its key is present, it removes the key, records `approved` with "A person approved this exact call once, after the run had moved on.", and the loop runs it with no card. The next identical call asks again. The key is the tool, the call's folder, the shell's folder and the arguments in a fixed order.
- `awaitingApprovalMessage(true)` says the call would be allowed once, not for the rest of the run; other cards keep their words.
- The page is told `floor: true` and shows no "Allow this command for this run" on a floor card.
- A floor card's reason keeps the settings layer's own reason when it would have asked anyway (`git push changes a remote repository...`), followed by the floor's sentence.

### Trusted folders (carry-forward 2 from the PR #70 review)
- `readCallPaths` reads a file tool's path arguments before the manifest is filled. A path that names a credential store or the identity folders (as written or as it resolves) becomes a floor fact, so it is refused with no card. An argument read only by `read` effects whose real path (links followed, through the tools' own resolver) lies in a trusted folder is written as `**`, and the record names the file as `<folder name>/<inner path>`, never the machine path. Writes are never rewritten, and a path outside every trusted folder stays unknown.
- Chat calls pass the run's `readOnlyRoots` (the Open-GSD runtime). Cyber steps pass the engagement's resolved scope paths (found by `cyberLiveScan`: its secrets probe reads the scope folder).
- The teams folder is not a file-tool root (the tools refuse it, as before); it is read through the shell, whose effects are always known, and is decided exactly as a shell read of a project file (asserted).

### Docs and UI copy (GATE-06, D-34)
- SECURITY.md's section, Known limitations row and MCP section, README's guard rails, MCP paragraph and `nearAi.actionPolicy` row, rewritten (quoted below).
- `FLOOR_CANNOT_SEE_TEXT` now says what plan 16's checks see (the shell's folder and any `cd`/`pushd` earlier in the same command) and drops "a folder change followed by a bare file name". New `FLOOR_EFFECTS_CANNOT_SEE_TEXT` names the gaps of the publishing and destruction checks; gateDocs asserts each named gap is real today (`bash -c "$CMD"`, `source`, piped into `sh`, `stdbuf`, `flock`, `watch`, five levels of nesting give no tag) and that the named wrappers are read (sudo, `bash -c`, xargs, subshell, four levels).
- Full auto's picker summary ("Runs without asking; publishing, deleting and .git writes still ask. Throwaway only."), its description and the `nearAi.actionPolicy` enumDescription, and the confirmation dialog say what still asks.

### The new SECURITY.md section, in full

> ### What the agent can do without asking
>
> Under the default `approve-risky` policy, reads and searches run freely, and file changes and commands ask first. A command runs without asking only if it matches `nearAi.agent.allowCommands` and is written as plain words. That rules out quotes, `~`, variables, globs, newlines, pipes, redirects and substitution. It must also use no absolute or `..` paths, and no git options that write files, read outside the repository, or delete refs.
>
> In every mode, `fully-autonomous` included, these always ask, with no **Always allow** and no grant for the rest of the run, even after **Allow edits for this run** or an allow-list entry that matches:
>
> - writing into `.git/`, where hooks and config would run on the next git command;
> - writing into `.planning/.near-ai/` (other than its `team.md`) or into `.near-ai/` (other than its `scratch/` and `attachments/` folders);
> - publishing: git push, package and extension publishing, release creation, container image push, deploy commands, and sending email;
> - destruction: recursive deletes outside scratch and build folders, `git reset --hard`, `git clean`, discarding uncommitted changes, history rewrites (`git commit --amend`, `git rebase` including `--continue`, `git gc` and the like), and deleting branches and tags;
> - writing to the knowledge your team shares (the Learn tool).
>
> Approving one of these runs that one call. When a helper agent's card is approved after the helper has moved on, that exact call (the same tool and arguments, from the same folder) may run once more; the next one asks again. In a run with nobody to answer (a model comparison, a role test, a benchmark), they are refused. The deny list still refuses a command first, and the emergency stop refuses everything.
>
> In every mode these are refused, with no card: the project's key folder (below), the NEAR key folder in your home folder (`~/.near-credentials`), SSH keys (`~/.ssh`), cloud and registry credential files (`~/.aws`, `~/.config/gcloud`, `~/.azure`, `~/.docker/config.json`, `~/.kube`, `~/.netrc`, `~/.git-credentials`, `~/.gnupg`, `~/.npmrc`, `~/.pypirc`), operating-system keychain commands that print a secret, VS Code's own secrets database, and this extension's own identity and policy files in its storage. This holds for the file tools and for shell commands alike.
>
> Reading a file inside the project that looks like a credential (`.env`, private keys, SSH, AWS, or NEAR credential files), through any path or symlink, asks first in every mode except `fully-autonomous`, where it runs without asking (see Known limitations). The holds after outside content apply in every mode (see "Outside content and prompt injection").
>
> The checks that keep agents out of key and credential folders read the text of a command, following the shell's folder and any cd or pushd earlier in the same command. They cannot see a path built while the command runs (from a variable or $(...)), what a script or an npm script the command starts does, a program that reads a store for you (for example git credential fill), a walk down from a parent folder, or anything an add-on server or the cyber host tools do inside themselves. There is no operating-system sandbox around the shell yet, so a determined command can still get past them.
>
> The checks that find publishing, destruction and protected writes in a shell command also read its text, through npm run scripts and wrappers such as bash -c, sudo, xargs, pipes and subshells. They do not see a command built while it runs (bash -c "$CMD"), a file run with source or piped into sh, a script written or changed earlier on the same line (it is read as it was before the line ran), commands nested more than four levels deep, or wrappers they do not know, such as stdbuf, flock or watch. Under fully-autonomous such a command runs without asking.

(The key folder paragraph that follows is unchanged.)

### The new Known limitations row, in full

> | Under `fully-autonomous`, the agent runs commands and reads likely credential files inside the project without asking | Writes into `.git/`, `.planning/.near-ai/` and `.near-ai/`, publishing and destruction still ask, with no "always allow", and the key folder and credential stores are refused. The command checks read text, and there is no sandbox around the shell yet, so a command they cannot read runs (see "What the agent can do without asking"). Intended for throwaway workspaces |

### The new README `nearAi.actionPolicy` row, in full

> | `nearAi.actionPolicy` | `approve-risky` | `approve-risky`: edits and commands ask first. `mostly-autonomous`: edits run, commands ask. `auto`: edits run, and commands run when they pass the safety check (fixed rules for clear cases, a private TEE model for the rest; risky or uncertain commands ask, with the reason). `fully-autonomous`: everything runs except deny-listed commands, including reading credential files inside the project; writes into `.git/` and NEAR AI's state folders, publishing and destruction still ask with no "always allow", and the key folder and credential stores are refused (intended for throwaway workspaces; actions held after the agent read outside content still ask; see SECURITY.md, "What the agent can do without asking"). You can also switch it from the picker next to the model in the chat's bottom bar (Ask before edits / Edits auto / Auto / Full auto); it writes user settings, or the workspace or folder settings when the value is set there, asks before Full auto, and shows "Stopped" while the emergency stop is on. |

## The deliberately changed test (D-19)

`src/test/protectedPaths.test.ts`:
- Before: `fully-autonomous reads credential files and writes into .git/, .planning/.near-ai/ and .near-ai/ without asking; the other modes ask`.
- After: `fully-autonomous reads credential files without asking but asks before writing into .git/, .planning/.near-ai/ and .near-ai/; the other modes ask`.
- The two credential reads, the `.near-ai/state/meta.json` Read and `cat .env` still run with no card. The Write to `.git/hooks/pre-commit`, the Write to `.planning/.near-ai/settings.json`, the Edit of `.near-ai/state/meta.json` and the Bash `printf x > .git/hooks/post-commit` each ask with no `allowRule`, no `grant` and a `floor` marker; denying leaves every file unchanged. A presence-none case (the benchmark runtime) refuses the same four writes with "Nobody is here to approve this" and writes nothing. The comment above it is rewritten. The old combined command `cat .env && printf x > .git/hooks/post-commit` is split into two calls so the read and the write can be checked apart. The other-mode half is unchanged. The only other line changed in the file is its import (`testGateRuntime`).

## Every other test touched, and why

None of these was weakened; each still tests what it tested, against the enforced floor.

| Test file | Change | Why |
|---|---|---|
| `helpers/gatedRuns.ts` | `testGateRuntime` and `testGateHost` drop `floorMode: 'shadow'` | the field no longer exists; every test runtime now runs the enforced floor (the real behaviour). The full suite stayed green except the two items in Deviations, both fixed in code |
| `gateDecide.test.ts` | the shadow-mode test is replaced by one with the same inputs asserting the enforced outcomes; "enforce is the default" folded into "decide() ignores the old shadow option"; the unavailable-state case drops its shadow option; new source scan and unknown-effects refusal tests | plan Task 1 (the shadow cases the option's removal retires) |
| `gateEnumeration.test.ts` | `floorMode` removed from runtime requests; the three stand-in tests become "unknown, no stand-in" tests with the same inputs; the absolute-path Write test asserts the floor ask and its record instead of `shadowFloor`; the host-request and `runGateFor` checks assert no floor mode exists | this phase's tests of the shadow option |
| `gatePathCover.test.ts` | `effectsOfCall` loses its runtime argument; the `/` case asserts `[]` instead of the shadow stand-in | same |
| `gateRefusalRecords.test.ts` | the loops over `['shadow', 'enforce']` become one enforced pass | same; assertions unchanged |
| `gateHostStart`, `gateHostClock`, `gateNoFolder`, `gateActivation` | `floorMode` removed from requests and `decide()` options | compile only |
| `gateCredentialStores.test.ts` | "in shadow, every mode decides as today and records what the floor would have refused" becomes "in every mode ... is refused by the floor with no card" (same commands) | plan 16's shadow test, now enforced |
| `commandEffects.test.ts` | "git push as a shadow publish ... decides exactly as today" becomes "with a person it asks with no shortcut, with nobody it is refused" (same inputs; still checks the settings layer was asked twice) | same |
| `gateDocs.test.ts` | the "plan 17 changes them" test replaced by the floor docs checks; the two MCP assertions now expect "every mode, `fully-autonomous` included" and the absence of the old phrase | plan Task 3 |
| `approvalPolicyPicker.test.ts` | the pinned Full auto one-line summary updated to the new text | the old summary ("Everything runs except your deny list") is no longer true; the test is as strict as before |

## Verification

| Run (all inside the memory cap) | Result |
|---|---|
| Task 1 verify (protectedPaths, gateDecide, gateFloor, gateEnumeration), then the tracer gate re-run | 87 tests, 87 pass |
| Full suite after Task 1 (discovery run) | 3249 tests, 2 fail (autoApproval card reason, cyberLiveScan scope read), both fixed in code before the commit |
| Task 1 files plus steering, autoApproval, cyberLiveScan | 160 tests, 160 pass |
| Task 2 verify: the plan's parity set (gate*, commandEffects, autoApproval, agentLoop, protectedPaths, untrusted, unattendedApproval, mcp, toolsPage, commandSafety, approvalRisk, approvalStalls, agentBasics, benchmarkRunner, knowledgeTools, cyberRun) | 652 tests, 652 pass, 0 fail, 0 cancelled |
| Task 3 verify plus gateFloor, approvalPolicyPicker, config | 64 tests, 64 pass |
| Full `npm test` (6G, 1800 s), once at the end | exit 0; 3262 tests, 3253 pass, 0 fail, 0 cancelled, 9 skipped (the same 9 as before this plan) |

- `grep -rn "floorMode" src` prints nothing.
- `grep -n "homedir()" src/test/gateFloorRuns.test.ts` prints nothing. Every folder the file uses is asserted to be under the temporary folder; the shell's `HOME` is a `fakeHome()`; the credential-store and identity commands are refused before anything runs (and would only have reached the stand-ins).
- gateFloorRuns: 7 floor rules x 4 modes x 2 presences = 56 cases (count asserted), plus the restrictive add-on server tool in the same 8 combinations, plus allow-run, late approval, deny list, emergency stop, allow-list, trusted folders and file-tool credential paths.

## Deviations from Plan

### Context the plan predates
1. **[Names] More shadow sites than the plan lists.** `GateDecision.shadowFloor` and its record plumbing, the plan-16 shadow tests (commandEffects, gateCredentialStores) and seven gate test files that passed `floorMode` were updated with the option's removal. `record.ts` keeps its optional `shadowFloor` field (0.4.28 wrote it; the record format is versioned), with its comment saying nothing sets it.
2. **[Names] `effectsOfStep` became async and takes the trusted folders** instead of a stand-in; `effectsOfCall` lost its runtime argument.
3. **[Order] Task 2's code landed in Task 1's commit.** The one-shot late approval and the awaiting text are in `2da49a0` because the card's `floor` marker and the loop change belong together; red first was shown afterwards with temporary edits that disabled each mechanism (see Task Commits).

### Auto-fixed issues
1. **[Rule 1] A floor card lost the specific reason** (`autoApproval`: the card for `git push` in auto said only the floor's generic sentence). The card now carries the settings layer's reason followed by the floor's. `2da49a0`.
2. **[Rule 1] Cyber file probes read outside the project** (`cyberLiveScan`: the secrets probe on the engagement's scope folder became `manifest.effects-unknown`). Engagement scope paths are trusted read folders for cyber steps. `2da49a0`.
3. **[Rule 2] Trusted folders outside the project** (carry-forward 2): `readCallPaths`, above. `2da49a0`.
4. **[Rule 2] File-tool paths that name a credential store or the identity folders** are floor facts, so `Read ~/.ssh/id_ed25519` (or the real home path) is refused with no card instead of asked as unknown. A project folder literally named `~` would also be refused; judged acceptable. `2da49a0`, and the decide() part in `c02ccca`.
5. **[Rule 2] "For this run" on a floor card** would have granted nothing; the page no longer offers it. `2da49a0`.
6. **[Rule 2] Full auto's UI copy** promised "every file edit and shell command will run without asking"; picker summary, description, enumDescription and confirmation now say what still asks. `732fef9`.
7. **[Rule 1] The first decide() fix moved every floor refusal ahead of unknown effects,** which turned gateRefusalRecords' planted `forbidden` case into a floor refusal. That was not intended, so the code was narrowed (only refusals from what the call names: facts and command text), not the test. `c02ccca`.

### Behaviour changes to know about (fail-closed, intended mechanism)
- A file-tool call naming a path outside the project and every trusted folder now asks (`manifest.effects-unknown`) with a person, where before it reached the tool, which refused the path. Approving still ends in the tool's "outside the workspace" error. With nobody present it is refused.
- A restrictive add-on server tool (new servers' undeclared tools) is `manifest.effects-unknown` in every mode, not `floor.destroy`: its manifest (shell anywhere, any host, write and destroy `**`) cannot be filled for a concrete call. It asks in every mode with no shortcut and is refused with nobody, as the docs say; its card is not marked as a floor card.
- A tool that changes data on a local MCP server (stdio, no web address) now asks before every call in every mode, even when the server is marked trusted: its legacy manifest names any host (`*`), which a concrete call cannot fill. Documented in SECURITY.md and README.
- Every Bash call carries plan 16's tags, so `git rebase --continue` and `git gc` ask in every mode, including fully-autonomous, and are refused with nobody. Tagging left as plan 16 made it (owner question below).

## Owner questions for the PR 3 body

1. **Routine git maintenance (carried from plan 16):** `git gc`, `git prune` and `git rebase --continue` are destruction on the floor, so they now ask in every mode, Full auto included. Keep, or move them off the floor?
2. **Paths outside the project:** a file-tool call naming a path outside the project and every trusted folder now shows a card the tool would refuse anyway. Should the loop refuse such calls up front (the tool's own "outside the workspace" message, no card) instead of asking? Safer-and-quieter, but it is a second refusal path.
3. **Local MCP servers marked trusted:** their data-changing tools now ask every call because their manifest names any host. Accept, or give a local server's legacy manifest a narrower effect (it runs on this machine with the person's permissions)?
4. **Restrictive add-on tools record `manifest.effects-unknown`, not `floor.destroy`.** Same outcome for the person; should the record name the floor instead?
5. **D-46 and the registry account verbs (carried from plan 16):** `gh pr create`, `gh pr merge` and `gh issue comment` stay off the floor; npm/cargo login and logout are publish while docker login is not.
6. **A late floor approval's key includes the folder:** a helper in its own worktree whose card is approved late can run the call once from that worktree; the lead running the same call from the main folder asks again. Intended (safer); confirm.
7. **The `CHANGELOG.md` entry** for the enforced floor is left to the release PR (`prepare-release`); a new "Unreleased" section would also need the policy wording gateDocs checks.

## Known Stubs

None.

## Threat Flags

None. No new endpoint or schema. New file-system access: `realpath` of the paths a file tool's call names (the same resolution the tools already do), and nothing is opened. The one-shot approval set is in memory only, per run.

## Self-Check: PASSED

- FOUND: src/test/gateFloorRuns.test.ts, this SUMMARY
- FOUND in HEAD's history: 2da49a0, c02ccca, 732fef9, 9e76b0c
