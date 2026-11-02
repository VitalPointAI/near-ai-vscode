# Development workflow

How a change gets from an idea to the Visual Studio Marketplace. The short rules are in
[CONTRIBUTING.md](../CONTRIBUTING.md); this page explains the whole flow, the gates, the scripts
and slash commands behind them, and what to do when something goes wrong.

```
branch + worktree -> commits -> PR -> CI (6 jobs) + agent review -> merge agent -> main
                                                                        |
                         release/x.y.z PR -> merge -> tag vX.Y.Z -> Release workflow
                                                                        |
                                    GitHub release (VSIX) -> owner approves -> Marketplace
```

## 1. Branches and worktrees

`main` is protected: no direct pushes (the owner included), no force pushes, no deletion, a
linear history, and every change arrives as a squash-merged PR. Branch names:

| Branch | For |
| --- | --- |
| `feat/<short-name>` | a new feature or a visible improvement |
| `fix/<short-name>` | a bug fix |
| `chore/<short-name>` | tooling, CI, dependencies, refactoring with no visible change |
| `docs/<short-name>` | documentation only |
| `release/<x.y.z>` | a release: version bump, CHANGELOG, README |
| `hotfix/<x.y.z>` | an urgent fix released on its own |

Each branch lives in its own worktree under `.claude/worktrees/<name>` (ignored by git), so
several people and agents can work at once without touching each other's files:

```bash
git fetch origin
git worktree add -b feat/team-mode .claude/worktrees/feat-team-mode origin/main
cd .claude/worktrees/feat-team-mode && npm ci
```

Agents never check out, reset or commit on a local `main`, and never edit a worktree another
session owns. Remove your worktree after the merge: `git worktree remove .claude/worktrees/<name>`.
Merged branches are deleted on GitHub automatically.

## 2. Pull requests

Open the PR early (as a draft if it is not ready) so CI runs on every push. Fill in the
template: what and why, test evidence, the security and docs checkboxes, and a rollback note.
The PR title is the squash commit's message on `main`, so write it as a conventional commit:
`fix(chat): ...`, `feat(spend): ...`.

A PR can merge only when all of these hold:

| Gate | Where it comes from |
| --- | --- |
| `lint` | CI: `npm run lint` (TypeScript type check) |
| `test` | CI: `npm test` (unit tests, including the workflow scripts' tests) |
| `e2e` | CI: the extension in a real VS Code under xvfb, in a NEAR AI project and in a plain folder |
| `release-content` | CI: `npm run verify:release` (package the VSIX, build the SBOM, check its contents); the VSIX is kept as a build artifact for 7 days |
| `audit` | CI: `npm audit --omit=dev --audit-level=high` |
| `secret-scan` | CI: `scripts/secret-scan.mjs` over all tracked files and every line the PR's commits add |
| `agent-review` | Commit status set by `scripts/agent-review.mjs` after the agent review team (section 4) |
| Up to date | Branch protection ("require branches to be up to date"): rebase onto `main` and re-run |
| No conflicts | GitHub reports the PR mergeable |
| Conversations resolved | Branch protection: every review thread resolved |

These seven check names are the required status checks in branch protection. Renaming a CI job
means updating branch protection, `scripts/lib/workflow.mjs` (`CI_CHECKS`) and this page in the
same PR.

## 3. CI: fast by design

`.github/workflows/ci.yml` runs on every PR into `main`, on every push to `main`, and by hand.

- The six jobs run **in parallel**; the slowest (e2e) takes a few minutes.
- `npm ci` uses the setup-node npm cache; the VS Code download for e2e is cached weekly.
- A new push to a PR **cancels** the superseded run. Runs on `main` always finish.
- `audit` and `secret-scan` do not install anything.
- Every action is pinned to a full commit SHA; the workflow token is read-only and checkouts do
  not keep credentials.

Run the same checks locally before pushing: `npm run lint && npm test`, plus `npm run test:e2e`
or `npm run verify:release` when your change touches what they cover.

### The secret scan

`scripts/secret-scan.mjs` looks for private keys (PEM blocks, NEAR `ed25519:` secret keys), AWS,
GitHub, npm, Slack, Anthropic, OpenAI, Google and Stripe keys, and files that should never be
committed (`.env`, `id_rsa`, `.near-credentials/`, `.p12`). It scans every commit in the PR, not
only the final diff, because a PR's commits stay public on GitHub even after a squash merge.
Findings are printed masked. Test fixtures with fake keys are listed, with a reason, in
`.github/secret-scan-allow.txt`; a single line can carry the marker `secret-scan: allow`. Both
are visible in review.

## 4. The agent review gate

The owner's agents use the owner's GitHub account, and GitHub does not let an account approve
its own PR. So the review team's result is recorded as a **commit status** named
`agent-review` on the PR's head commit, and branch protection requires it. A push to the branch
creates a new head commit without that status, so new commits always need a new review.

### Running the review team from Claude Code

In a Claude Code session in this repository, run:

```
/review-pr <number>
```

The command (`.claude/commands/review-pr.md`) does the following:

1. **Gather.** `node scripts/agent-review.mjs gather <number> --out <dir>` writes the PR
   metadata, the diff, the file list and the CI results to `<dir>` and prints the head SHA.
2. **Review in parallel.** It spawns, in one step:
   - a code reviewer: the `gsd-code-reviewer` agent (the agent behind the GSD `gsd-code-review`
     skill) over the changed files, or the `code-review` skill at `high` on the PR;
   - a security reviewer: the `security-review` skill in a worktree of the PR branch, plus a
     check that SECURITY.md still matches what the code does;
   - a docs and changelog reviewer: CHANGELOG entry in user-facing prose for visible changes,
     README and SECURITY.md updated where needed, no em-dashes, conventional commits;
   - for release PRs, a release reviewer: `node scripts/prepare-release.mjs check` and a
     CHANGELOG that covers every visible change since the last tag.
3. **Aggregate.** It merges the findings into one review file. Each finding starts with a
   severity: `[BLOCKER]` (must not merge), `[MAJOR]`, `[MINOR]` or `[NIT]`. The file must contain
   `Verdict: PASS` or `Verdict: FAIL` and `Head-SHA: <the reviewed commit>`.
4. **Submit.** `node scripts/agent-review.mjs submit <number> --review <file>` posts the file as
   a PR comment (with a snapshot of CI) and sets `agent-review` on the head commit.

`agent-review` is **success** only when the file says `Verdict: PASS`, its `Head-SHA` is the
PR's current head, and it has no open `[BLOCKER]` (a fixed one is written
`[BLOCKER][RESOLVED]`). Otherwise it is **failure** and the comment lists why. Text inside code
fences is ignored, so quoted code cannot fake a verdict. Use `--dry-run` to see the comment
and the status without posting.

The format of the review file is shown in `.claude/commands/review-pr.md`.

## 5. Merging

```
/merge-pr <number>
```

The merge agent runs `node scripts/merge-pr.mjs <number>` (first with `--dry-run`). The script:

- refuses unless the PR is open, not a draft, targets `main`, and its branch follows the naming
  rules;
- refuses unless every required check (the six CI jobs, `agent-review`, and anything else branch
  protection requires) is green on the current head, and no other check failed;
- refuses if the branch is behind `main`, has conflicts, or has unresolved conversations;
- then runs `gh pr merge --squash --delete-branch --match-head-commit <sha>` with the PR title
  as the subject. `--match-head-commit` stops the merge if someone pushed in the meantime, and
  `--repo` keeps `gh` from touching local branches or worktrees.

It never uses `--admin` and never changes branch protection. A refusal names each reason and
the fix (for example `gh pr update-branch <number> --rebase`, then CI and a new review).

## 6. Releasing

```
/release <x.y.z>
```

1. The release agent creates `release/<x.y.z>` in its own worktree from `origin/main` and runs
   `node scripts/prepare-release.mjs bump <x.y.z>` (package.json and package-lock.json).
2. It writes the `## <x.y.z>` CHANGELOG section for users, in the style of earlier entries, and
   updates README and SECURITY.md if the release changes what they describe.
3. `node scripts/prepare-release.mjs check` confirms the branch name, both version fields, a
   version higher than the last tag, and the CHANGELOG section.
4. It opens the PR `chore(release): <x.y.z>`. CI and `/review-pr` run as for any PR.
5. `/merge-pr` squash-merges it, waits for CI on the new `main` commit, and tags that commit
   `v<x.y.z>` (`scripts/tag-release.mjs` does the same by hand, and can retry a missed tag).
6. The tag starts `.github/workflows/release.yml`:
   - **build** checks that the tag matches package.json and is on `main`, runs the tests,
     builds and verifies the VSIX, records its SHA-256, and creates the GitHub release named
     `<x.y.z>` with the VSIX, the checksum, and the CHANGELOG section as notes;
   - **publish** runs in the protected `marketplace` environment. It **waits for the owner**:
     GitHub shows "Review deployments" on the run, and nothing is published until the owner
     approves. It then checks the VSIX checksum and runs
     `npx vsce publish --packagePath <the verified VSIX>` with the `VSCE_PAT` secret, which is
     stored only in that environment.

The owner approves from the run page (Actions, Release, the run, "Review deployments") or with
`gh run view <run-id>`. Rejecting it leaves the GitHub release in place and nothing published.

## 7. Recovery

### Undo a merged PR

Revert it with a PR, never by pushing to `main`:

```bash
gh pr revert <number>          # opens a revert PR
```

or, in a fresh worktree, `git revert <squash-sha>` on a `fix/revert-<name>` branch and open a
PR. The revert goes through the same gates (they are quick for a revert). Note in the revert PR
anything a revert does not undo, such as data a released version already wrote.

### CI is red on main

Every commit on `main` passed CI as a PR, so red on `main` usually means a flaky test, an
outside change (a new VS Code release in e2e, a new advisory in `npm audit`, an OSV.dev outage
during the SBOM step), or two PRs that each passed but conflict in behavior.

1. Look at the failing job. If it is infrastructure only (a download or network failure),
   re-run just that job: `gh run rerun <run-id> --failed`.
2. If a merged PR broke it, revert that PR (above). Fix forward only if the fix is small and
   obvious, in a `fix/` branch.
3. If an outside change broke it (new advisory, new VS Code), open a `fix/` or `chore/` PR that
   addresses it. Do not skip, weaken or delete the failing check to get green.
4. Do not tag a release while `main` is red; `merge-pr.mjs` and `tag-release.mjs` refuse anyway.

### A bad version reached users: hotfix

The Marketplace never lets a version number be reused or overwritten, so a fix always ships as a
new patch version (for example 0.4.12 replaces a broken 0.4.11).

**Usual case: main can be released.** Branch `hotfix/<next-patch>` from `origin/main`, fix it,
bump the version and CHANGELOG with `scripts/prepare-release.mjs`, and go through PR, review and
`/merge-pr`, which tags and starts the release.

**Main has unreleased work that must not ship yet.** Branch from the last release tag instead:

```bash
git worktree add -b hotfix/0.4.13 .claude/worktrees/hotfix-0.4.13 v0.4.12
# fix, bump to 0.4.13, write the CHANGELOG section, commit
git push -u origin hotfix/0.4.13
gh pr create --base main --title "fix: ... (0.4.13)"
```

CI and `/review-pr` run on the PR as usual. When both are green, tag the hotfix head (the Release
workflow accepts a tag on the head of `hotfix/<version>`):

```bash
node scripts/tag-release.mjs 0.4.13 --sha "$(git rev-parse HEAD)"
```

After the release, bring the fix into `main`: update the PR (`gh pr update-branch`), resolve any
conflicts in the hotfix worktree, let the gates pass again, and merge it with
`node scripts/merge-pr.mjs <number> --no-tag`, since the release is already tagged.

### Roll back the Marketplace

There is no "unpublish one version" that users reliably follow. Options, best first:

1. Release a fixed patch (hotfix above). This is the normal answer.
2. Republish the previous good code as a new patch: revert the bad change on `main`, release the
   result as the next patch version.
3. Users who need the old version now can use **Install Another Version...** in the Extensions
   view, or install the earlier VSIX from its GitHub release.
4. `vsce unpublish` removes the whole extension; it is for emergencies such as a leaked key in
   the package, and only the owner decides it.

### The Release workflow failed

- **build failed:** fix the cause in a PR. If the tag points at a commit that should not be
  released, do not move the tag; release the fix as the next patch. If only an outside service
  failed, re-run the job.
- **publish failed** (expired `VSCE_PAT`, Marketplace outage): fix the cause (for a token, the
  owner updates the secret, see below), then re-run the failed job:
  `gh run rerun <run-id> --failed`. It publishes the same verified VSIX and needs the owner's
  approval again.
- **The tag was never created** (merge-pr stopped while waiting for CI): run
  `node scripts/tag-release.mjs <x.y.z>` once CI on `main` is green.

### A secret was committed

Revoke or rotate the key first: removing it from git does not make it safe, since the commit is
public. Then remove it in a PR. For a NEAR key, never delete the key file or the on-chain access
key from an agent session; the owner handles that.

## 8. Repository settings (owner only)

These are applied once by the owner; agents never change them.

- `main` protection: required checks `lint`, `test`, `e2e`, `release-content`, `audit`,
  `secret-scan`, `agent-review`; branches must be up to date; admins included; linear history;
  no force pushes or deletion; conversations must be resolved.
- Merging: squash only, the PR title as the commit message, branches deleted after merge.
- Environment `marketplace`: the owner as the required reviewer, deployments only from `v*.*.*`
  tags, and the `VSCE_PAT` secret stored in this environment only.

The `VSCE_PAT` is an Azure DevOps personal access token with the **Marketplace (Manage)** scope
for the `VitalPoint` publisher. The owner adds or rotates it with:

```bash
gh secret set VSCE_PAT --env marketplace --repo VitalPointAI/near-ai-vscode
```

which prompts for the value, so it never lands in shell history or a file.
