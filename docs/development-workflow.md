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

Every change reaches `main` as a squash-merged PR: no direct pushes (the owner included), no
force pushes, no deletion, a linear history. GitHub enforces this through the branch protection
in section 8, which is part of the required configuration and is applied with the commands
there; until it is applied, only the scripts enforce these rules. Branch names:

| Branch | For |
| --- | --- |
| `feat/<short-name>` | a new feature or a visible improvement |
| `fix/<short-name>` | a bug fix |
| `chore/<short-name>` | tooling, CI, dependencies, refactoring with no visible change |
| `docs/<short-name>` | documentation only |
| `release/<x.y.z>` | a release: version bump, CHANGELOG, and README or SECURITY.md updates |
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
The PR title, followed by ` (#<number>)`, is the subject of the squash commit on `main`, so
write it as a conventional commit:
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
| `agent-review` | Commit status set by `near-ai-reviewer` from `.github/workflows/agent-review.yml` after CI passes (section 4) |
| One approval | Branch protection: one approving review, posted by `near-ai-reviewer` when the review passes; for a change to the gates, only after the owner approves (section 7) |
| Up to date | Branch protection ("require branches to be up to date"): rebase onto `main` and re-run |
| No conflicts | GitHub reports the PR mergeable |
| Conversations resolved | Branch protection: every review thread resolved |

These seven check names are the required status checks in the branch protection (section 8).
Renaming a CI job means updating branch protection, `scripts/lib/workflow.mjs` (`CI_CHECKS`) and
this page in the same PR.

## 3. CI: fast by design

`.github/workflows/ci.yml` runs on every PR into `main`, on every push to `main`, and by hand.

- The six jobs run **in parallel**; the slowest (e2e) takes a few minutes.
- `npm ci` uses the setup-node npm cache; the VS Code download for e2e is cached weekly.
- A new push to a PR **cancels** the superseded run. Runs on `main` (and runs started by hand)
  each get their own concurrency group, so none is ever cancelled or replaced while queued.
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
Findings are printed masked. Test fixtures with fake keys are listed in
`.github/secret-scan-allow.txt` with the rules their fake keys match and a reason; any other kind
of key in such a file is still reported. A single line can carry the marker
`secret-scan: allow`. Both are visible in review: the scan lists every marked line that matches
a rule (masked), and fails when a line let through by the marker or by the allowlist was added
by one commit and removed by a later one, since the PR's final diff would no longer show it. The
scan reads every file as text, even one `.gitattributes` marks as binary, and also checks the
PR's commit messages.

## 4. The agent review gate

Every PR needs a review that its author did not write. The review's result is recorded as a
**commit status** named `agent-review` on the PR's head commit, and branch protection requires it.
A push to the branch creates a new head commit without that status, so new commits always need a
new review.

**The reviewer is its own identity: `near-ai-reviewer`.** The authoring agents run `gh` as the
owner's account (`ALuhning`), an admin of the repository. If the gates trusted the owner's
`agent-review`, an authoring agent could post its own PASS: self-certification. So the only
account whose `agent-review` counts is `near-ai-reviewer` (`REVIEW_ACCOUNT` in
`scripts/lib/workflow.mjs`), whose token `NEAR_AI_REVIEW_TOKEN` exists only in the `agent-review`
environment and is used only by `.github/workflows/agent-review.yml`. Nothing on an authoring
machine holds it.

A commit status is not a strong signature: GitHub accepts an `agent-review` status from any
account or workflow with write access, and branch protection cannot require a particular account.
`merge-pr.mjs` and `tag-release.mjs` therefore count only the status set by `near-ai-reviewer`,
fixed in the scripts rather than taken from whoever runs them: a status set by the owner or any
other admin does not count, and they refuse when another account set one or when a check run uses
that name. `agent-review.mjs submit` refuses to post unless `gh` runs as `near-ai-reviewer`, so it
refuses on the owner's machine. Changing `REVIEW_ACCOUNT` changes the gate, so it goes through
review like any gate change. Merges outside `merge-pr.mjs` rely on trust in everyone with write
access.

The owner's account is still an admin, so policy still applies to agent sessions: they never set
`agent-review` by any route, never approve a deployment and never change settings, and the scripts
never do.

### How a PR gets reviewed

The review runs automatically after CI succeeds for a PR (see "The review runs automatically"
below). It gathers the PR, asks a model for a review, submits it as `near-ai-reviewer`, and approves
the PR when the result is success:

1. **Gather.** `node scripts/agent-review.mjs gather <number> --out <dir>` writes the PR
   metadata, the diff, the file list and the CI results to `<dir>` and prints the head SHA.
   Gathering only reads, so anyone can run it locally.
2. **Review.** `scripts/ci-review-prompt.mjs` builds the prompt and `scripts/ci-review-call.mjs`
   asks the review model. Each finding starts with a severity: `[BLOCKER]` (must not merge),
   `[MAJOR]`, `[MINOR]` or `[NIT]`. The reply must contain `Verdict: PASS` or `Verdict: FAIL` and
   `Head-SHA: <the reviewed commit>`.
3. **Submit.** `node scripts/agent-review.mjs submit <number> --review <file>` sets
   `agent-review` on the head commit to pending, posts the file as a PR comment (with a snapshot
   of CI), and only then sets the result. If the comment cannot be posted, the status stays
   pending and the merge gate refuses, so an earlier success on the same commit never survives a
   failed re-review.
4. **Approve.** When this review set `near-ai-reviewer`'s `agent-review` to success and the
   reviewed commit is still the head, the workflow approves that commit as `near-ai-reviewer`. A PR
   that changes the gates waits for the owner first (see "The review runs automatically").

To review (or re-review) by hand, trigger the workflow and read what it posted; never post the
status from your own machine:

```bash
gh workflow run agent-review.yml -f pr=<number>
```

In a Claude Code session, `/review-pr <number>` (`.claude/commands/review-pr.md`) does this: it
gathers the PR, triggers the workflow, waits for the run, and reports the status and the review
comment. It can also run the agent review team locally as an advisory second opinion; that
posts nothing (it checks its review file with `submit --dry-run`).

`agent-review` is **success** only when the file has exactly one verdict line and it reads
`Verdict: PASS`, its one `Head-SHA` line names the PR's current head, and it has no open
`[BLOCKER]` anywhere, code blocks included (a fixed one is written `[BLOCKER][RESOLVED]`).
Otherwise it is **failure** and the comment lists why. A tag counts however it is typed, as long
as GitHub shows it as one: escaped (`\[BLOCKER\]`), with spaces inside the brackets, in
fullwidth or other bracket characters, in bold, in any case, or with invisible characters
inside. A tag spelled with lookalike letters from another alphabet fails the review.

Verdict and Head-SHA lines inside code fences are ignored, so quoted code cannot fake them, and a
code fence left open fails the review rather than hiding what follows it. The file is read the
way GitHub shows it, and anything that could look different there fails the review: a fence
indented 4 or more spaces (GitHub shows it as text or code, never as a fence), a Verdict or
Head-SHA line inside an HTML comment (hidden on GitHub), inside a quote, a list item or an
indented block, and an HTML comment that is never closed. Use `--dry-run` to see the comment and
the status without posting; it works from any account.

The format of the review file is shown in `.claude/commands/review-pr.md`.

## 5. Merging

```
/merge-pr <number>
```

The merge agent runs `node scripts/merge-pr.mjs <number>` (first with `--dry-run`). The script:

- refuses unless the PR is open, not a draft, targets `main`, and its branch follows the naming
  rules;
- refuses unless every required check (the six CI jobs, `agent-review`, and anything else branch
  protection requires) is green on the current head, and no other check failed. The CI jobs
  count only from the `CI` workflow, so a job of the same name elsewhere cannot stand in for
  one, and `agent-review` counts only as a commit status set by `near-ai-reviewer`
  (`REVIEW_ACCOUNT`), whoever runs the script;
- refuses if the branch is behind `main`, has conflicts, or has unresolved conversations;
- for a `release/x.y.z` or `hotfix/x.y.z` PR, refuses unless the head's package.json is
  `x.y.z`, CHANGELOG.md has its section, and `vx.y.z` does not exist yet (pass `--no-tag` for a
  hotfix that was already tagged and released from its branch);
- then runs `gh pr merge --squash --delete-branch --match-head-commit <sha>` with the PR title
  and ` (#<number>)` as the subject. `--match-head-commit` stops the merge if someone pushed in
  the meantime, and `--repo` keeps `gh` from touching local branches or worktrees. A release PR
  is tagged only after GitHub confirms the merge and its squash commit.

When a PR changes the gates themselves (the workflows, the secret-scan allowlist, the gate
scripts or the agent commands), the script says so before merging: CI ran the PR's own copies
of those files, so the review must have covered what they change.

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
   - **build** has a read-only token. It checks that the tag matches package.json and points
     at a commit on `main` (or at the head of `hotfix/<x.y.z>`, see the hotfix section), runs
     the tests, builds and verifies the VSIX, and records the SHA-256 of the VSIX and of the
     release notes;
   - **release** creates the GitHub release named `<x.y.z>` with the VSIX, the checksum, and
     the CHANGELOG section as notes. It is the only job that can write to the repository, so it
     installs and runs nothing: it downloads the build's files and checks both checksums first;
   - **publish** runs in the protected `marketplace` environment. It **waits for the owner**:
     GitHub shows "Review deployments" on the run, and nothing is published until the owner
     approves. Its first step checks the VSIX against the checksum the build job recorded. It
     then installs the `vsce` pinned in package-lock.json with `npm ci --ignore-scripts` (no
     cache, no install scripts) and runs `vsce publish --packagePath <the verified VSIX>` with
     the `VSCE_PAT` secret, which is stored only in that environment.

The owner approves in the GitHub web UI: Actions, Release, the run, **Review deployments**,
tick `marketplace`, **Approve and deploy**. `gh run view` only shows the run; it cannot approve
it. Approving from a terminal needs the REST API:

```bash
repo=VitalPointAI/near-ai-vscode
env_id="$(gh api "repos/$repo/environments/marketplace" --jq .id)"
gh api -X POST "repos/$repo/actions/runs/<run-id>/pending_deployments" \
  -F "environment_ids[]=$env_id" -f state=approved -f comment="Publish <x.y.z>"
```

Rejecting it leaves the GitHub release in place and nothing published.

What the checksum covers: it shows that the VSIX the release and publish jobs use is the one the
build job made, so nothing can swap it on the way. It does not protect the build itself. The
build job runs `npm ci` with dependency install scripts and runs the tests, so a compromised
dependency could change the VSIX before its checksum is taken. That job has a read-only token
and no secrets, which limits what such a dependency could reach, but not what it could put in
the package.

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

**Main has unreleased work that must not ship yet.** Branch from the last release tag instead.
With `<last>` the last release (say 0.5.0) and `<next>` the next patch (0.5.1):

```bash
git fetch origin
git worktree add -b hotfix/<next> .claude/worktrees/hotfix-<next> v<last>
cd .claude/worktrees/hotfix-<next>
git checkout origin/main -- .github scripts .vscodeignore
git diff --cached --stat     # check what came over, see below
git commit -m "chore(release): bring the release workflow and gates from main"
# fix, bump to <next>, write the CHANGELOG section, commit
git push -u origin hotfix/<next>
gh pr create --base main --title "fix: ... (<next>)"
```

The `git checkout origin/main -- ...` step matters because CI and the Release workflow run the
files on the branch, not the ones on `main`, and an older tag may predate them (v0.4.12 and
earlier do). All three paths are needed:

- `.github` brings `workflows/ci.yml` and `workflows/release.yml`, and also
  `secret-scan-allow.txt`: the old tag already contains test fixtures with fake keys, and
  without the allowlist the `secret-scan` job fails on every run.
- `scripts` brings the scripts those workflows run (`secret-scan.mjs`, `lib/workflow.mjs`,
  `verify-release-content.mjs` and the rest).
- `.vscodeignore` keeps `.github/` (and the contributor docs) out of the VSIX. An older one
  does not, so `release-content` in CI and the `build` job of the Release workflow refuse the
  package.

Check the staged diff before committing: it should only add or update workflow and gate files.
If `main` changed a script the old code still relies on (for example the vendoring or SBOM
scripts), restore that file from the tag with `git checkout v<last> -- scripts/<file>`.

Run `/review-pr` on the PR as usual: the tag needs `agent-review` set by `near-ai-reviewer` on
the exact head commit you release. The PR's CI tests the hotfix merged with `main` (and does not
run at all while the PR has conflicts), so also run CI on the hotfix head itself and wait for it:

```bash
gh workflow run ci.yml --ref hotfix/<next>
gh run list --workflow ci.yml --branch hotfix/<next> --limit 1   # wait until it passes
```

Then tag the hotfix head. `tag-release.mjs` refuses unless the commit is the head of
`hotfix/<next>`, the newest CI run on that exact commit (not the PR's run) has finished with
all six jobs green, and the owner's `agent-review` on it is success. A run that is queued or
still running is waited for; one that was cancelled, failed to start or has a failed job is
refused, with the run id to re-run. The Release workflow also accepts only the head of
`hotfix/<version>`:

```bash
node scripts/tag-release.mjs <next> --sha "$(git rev-parse HEAD)"
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
  released, do not move the tag (once the tag rulesets in section 8 are applied, GitHub refuses
  that anyway); release the fix as the next patch. If only an outside service failed, re-run
  the job.
- **release failed:** the workflow never changes an existing GitHub release (no `--clobber`), so
  a re-run refuses if the failed run already created one. The owner checks the partial release
  in the web UI, deletes it if it is incomplete, then re-runs the failed jobs.
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

### The review runs automatically

`.github/workflows/agent-review.yml` produces the gate result and the approval without anyone
asking. It runs on `workflow_run` after CI succeeds for a PR, and on `workflow_dispatch`
(`gh workflow run agent-review.yml -f pr=<number>`) to review by hand. Its three jobs:

| Job | Environment | What it does |
| --- | --- | --- |
| `review` | `agent-review` (reviewer token, model key) | Skips a PR whose head moved after CI. Gathers the PR, asks the model, and sets `agent-review` as `near-ai-reviewer` on the reviewed commit. |
| `owner-approval` | `agent-review-gates` (owner is the required reviewer; no secrets) | Only when the review passed and the PR changes the gates or was too large to review whole. Lists the gate files and waits for the owner. |
| `approve` | `agent-review` | Approves the reviewed commit as `near-ai-reviewer`, only if the review passed, that commit is still the head, `near-ai-reviewer`'s `agent-review` on it is success, and, for a gate change, the owner approved `owner-approval`. A refusal by GitHub fails the job. |

- **The code that judges comes from `main`.** `workflow_run` and `workflow_dispatch` execute in
  the base repository on the default branch, and the jobs check out `main`, so the PR cannot
  change the review scripts or the prompt it is judged by.
- **The token is out of reach.** `NEAR_AI_REVIEW_TOKEN` and `REVIEW_MODEL_API_KEY` exist only in
  the `agent-review` environment, which deploys only from protected branches, and never in a PR's
  checkout or on an authoring machine. That is a repository setting, so it holds against the
  authoring agents only as long as nobody changes it: an admin account can widen the environment's
  branch policy. `can_admins_bypass: false` stops an admin skipping a required reviewer, nothing
  more. Check the settings with the commands in section 7.
- **The PR is data, not instructions.** Everything the author controls (title, branch,
  description, file names, diff) is wrapped in blocks marked with a random nonce, which the content
  cannot close, and the model is told it is data to review and never instructions. The diff is
  capped at 1 MB (`MAX_DIFF_BYTES` in `scripts/lib/ci-review.mjs`); files left out are named, and such a
  PR waits for the owner like a gate change.
- **The verdict is checked mechanically.** The reply is judged by the same `parseReview` and
  `reviewDecision` as any review file: an open BLOCKER, a missing or second verdict, a verdict for
  another commit, or a PASS whose recommendation is not MERGE all fail the gate. The workflow also
  requires the `## Recommendation:` heading (`requireRecommendation`); a hand-run
  `agent-review.mjs submit` does not.
- **Time limits.** The model call gives up when nothing arrives for 2 minutes
  (`REVIEW_IDLE_SECONDS`) and stops at 45 minutes in all (`REVIEW_TOTAL_SECONDS`), and it reads at
  most 16 MB of reply, streamed or not. A quiet model is tried up to three times; the overall
  limit, the token limit and an oversized reply are not retried. If the review job itself reaches its own limit
  (150 minutes), it ends without posting, so the PR has no `agent-review` result and stays
  blocked: start it again with `gh workflow run agent-review.yml -f pr=<n>`.
- **Gate changes need the owner.** A PR that touches a path in `GATE_PATHS`
  (`scripts/lib/workflow.mjs`: `.github/`, `scripts/lib/`, the review, merge, release and
  secret-scan scripts, `scripts/ci-review-*.mjs`, the gate tests in `scripts/test/`,
  `scripts/vendor-libs.mjs`, `SECURITY.md`, `.claude/commands/`) is reviewed
  as usual, but the approval waits for the owner's click. Every other PR is approved
  automatically when its review passes.

**How the owner approves a gate change.** Open the PR's "Agent review" run in the Actions tab
(the PR's checks link to it, or `gh run list --workflow agent-review.yml`). Read the review
comment on the PR first. Then, on the run page, choose **Review deployments**, tick
**agent-review-gates**, and choose **Approve and deploy**. The `approve` job then runs and posts
`near-ai-reviewer`'s approval. Choosing **Reject** leaves the PR unapproved.

Required setup, by the owner (in place for this repository; check it before relying on it):

1. **`agent-review` environment:** deployment branches "Protected branches" only, and
   `can_admins_bypass: false`. Secrets `NEAR_AI_REVIEW_TOKEN` and `REVIEW_MODEL_API_KEY`;
   variables `REVIEW_MODEL` (the model id) and `REVIEW_MODEL_BASE_URL` (an OpenAI-compatible
   endpoint, https only; default `https://cloud-api.near.ai/v1`). Keep them in the environment,
   not as repository secrets or variables, so nothing else can read them.
2. **`agent-review-gates` environment:** required reviewer the owner (`ALuhning`), deployment
   branches "Protected branches" only, `can_admins_bypass: false`, and **no secrets**.
3. **The reviewer token.** `NEAR_AI_REVIEW_TOKEN` is a fine-grained personal access token of the
   `near-ai-reviewer` account, which has write access to this repository as a collaborator. Scope
   it to this repository only, with: Pull requests read and write (comments and approvals),
   Commit statuses read and write, Contents read-only, Metadata read-only. Nothing else.
4. **Branch protection** requires one approving review (section 8), which `near-ai-reviewer`'s
   approval satisfies.

```bash
repo=VitalPointAI/near-ai-vscode
owner_id="$(gh api users/ALuhning --jq .id)"
gh api -X PUT "repos/$repo/environments/agent-review" --input - <<'JSON'
{"can_admins_bypass": false,
 "deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}}
JSON
gh api -X PUT "repos/$repo/environments/agent-review-gates" --input - <<JSON
{"reviewers": [{"type": "User", "id": $owner_id}], "prevent_self_review": false,
 "can_admins_bypass": false,
 "deployment_branch_policy": {"protected_branches": true, "custom_branch_policies": false}}
JSON
gh secret set NEAR_AI_REVIEW_TOKEN --env agent-review --repo "$repo"   # prompts for the value
gh secret set REVIEW_MODEL_API_KEY --env agent-review --repo "$repo"
gh variable set REVIEW_MODEL --env agent-review --repo "$repo" --body '<model-id>'
gh variable set REVIEW_MODEL_BASE_URL --env agent-review --repo "$repo" --body 'https://cloud-api.near.ai/v1'
# check
gh api "repos/$repo/environments/agent-review" --jq '{can_admins_bypass, deployment_branch_policy}'
gh api "repos/$repo/environments/agent-review-gates" --jq '{can_admins_bypass, deployment_branch_policy, rules: [.protection_rules[].type]}'
gh secret list --env agent-review-gates --repo "$repo"                 # must be empty
```

While the environment is unset the workflow fails, so `agent-review` stays absent and PRs stay
blocked. That is intentional: a gate that cannot run must not pass.

### First run (bootstrap)

GitHub runs `workflow_run` and `workflow_dispatch` workflows only from the default branch. The PR
that adds `agent-review.yml` (#12) is therefore not on `main` yet and cannot review itself, and
`main`'s older scripts trust a different account. That one PR is reviewed once by hand: the owner
runs **that PR's own** review scripts locally, as `near-ai-reviewer`.

`scripts/bootstrap-agent-review.mjs` runs the same code as the workflow
(`scripts/lib/auto-review.mjs`). It reads `GH_TOKEN`, `REVIEW_MODEL_API_KEY` and `REVIEW_MODEL`
from the environment only (never from arguments), refuses unless `gh api user` is
`near-ai-reviewer`, prints no secret, and removes its scratch directory. It posts the status only
as the model's review decides, and approves only when that review passed.

#12 changes the gates, so, as in the workflow, the approval is a separate step the owner takes
after reading the review: the first command reviews and stops; the second (`--approve-gates`) is
the owner's equivalent of approving `agent-review-gates`, and approves only if
`near-ai-reviewer`'s `agent-review` is success on the current head.

```bash
git fetch origin
git worktree add .claude/worktrees/bootstrap-review origin/feat/auto-agent-review
cd .claude/worktrees/bootstrap-review
read -rs -p 'near-ai-reviewer token: ' GH_TOKEN; echo
read -rs -p 'review model API key: ' REVIEW_MODEL_API_KEY; echo
export GH_TOKEN REVIEW_MODEL_API_KEY
export REVIEW_MODEL='<model-id>'                       # the value of the REVIEW_MODEL variable
export REVIEW_MODEL_BASE_URL='<base-url>'              # optional; default https://cloud-api.near.ai/v1
export GH_REPO=VitalPointAI/near-ai-vscode
gh api user --jq .login                                # must print near-ai-reviewer
node scripts/bootstrap-agent-review.mjs 12             # review; exits 2 and stops at the gate hold
# read the review comment on #12; only if it passed and you agree:
node scripts/bootstrap-agent-review.mjs 12 --approve-gates
unset GH_TOKEN REVIEW_MODEL_API_KEY
```

If the review fails, nothing is approved: fix the findings with a new commit and run the first
command again. Merge #12 with that branch's own gate, since `main`'s copy still trusts the old
account: from the same worktree, after `unset GH_TOKEN`, `node scripts/merge-pr.mjs 12 --dry-run`,
then without `--dry-run`. From then on every PR is reviewed by the workflow on `main`; the
bootstrap script is not needed again.

## 8. Repository settings (owner only)

This is the required configuration. The owner applies it once with the commands below; agents
never change it. Until a setting is applied, GitHub does not enforce it, so check with
`gh api repos/VitalPointAI/near-ai-vscode/branches/main/protection` and
`gh api repos/VitalPointAI/near-ai-vscode/rulesets` before relying on it.

- `main` protection: a PR is required with one approving review (the owner cannot approve their
  own PRs, so the approval comes from `near-ai-reviewer`, posted by the agent review workflow),
  required checks `lint`, `test`, `e2e`,
  `release-content`, `audit` and `secret-scan` from GitHub Actions, plus `agent-review`;
  branches must be up to date; admins included; linear history; no force pushes or deletion;
  conversations must be resolved.
- Merging: squash only, branches deleted after merge. The squash commit's subject is the PR
  title followed by ` (#<number>)`.
- Private vulnerability reporting turned on, so SECURITY.md's reporting link works.
- Environment `agent-review`: deployments only from protected branches, `can_admins_bypass:
  false`, with the `NEAR_AI_REVIEW_TOKEN` and `REVIEW_MODEL_API_KEY` secrets and the `REVIEW_MODEL`
  and `REVIEW_MODEL_BASE_URL` variables. Environment `agent-review-gates`: the owner as the
  required reviewer (an admin cannot skip it), protected branches only, no secrets. Commands in
  section 7, "The review runs automatically".
- Environment `marketplace`: the owner as the required reviewer, deployments only from `v*.*.*`
  tags, admins cannot bypass it (`can_admins_bypass: false`), and the `VSCE_PAT` secret stored
  in this environment only.
- Release tags: nobody can move or delete a `v*` tag, admins included, and only organization
  owners can create one. A tag push runs the `release.yml` of the tagged commit, so this is what
  keeps an unreviewed commit from carrying its own release workflow.

`main` protection (the six CI checks are pinned to GitHub Actions, app id 15368, so another app
cannot report them):

```bash
repo=VitalPointAI/near-ai-vscode
gh api -X PUT "repos/$repo/branches/main/protection" --input - <<'JSON'
{"required_status_checks": {"strict": true, "checks": [
   {"context": "lint", "app_id": 15368}, {"context": "test", "app_id": 15368},
   {"context": "e2e", "app_id": 15368}, {"context": "release-content", "app_id": 15368},
   {"context": "audit", "app_id": 15368}, {"context": "secret-scan", "app_id": 15368},
   {"context": "agent-review"}]},
 "enforce_admins": true,
 "required_pull_request_reviews": {"required_approving_review_count": 1, "dismiss_stale_reviews": true},
 "restrictions": null,
 "required_linear_history": true,
 "allow_force_pushes": false,
 "allow_deletions": false,
 "required_conversation_resolution": true}
JSON
```

Merging and vulnerability reporting:

```bash
repo=VitalPointAI/near-ai-vscode
gh api -X PATCH "repos/$repo" -F allow_squash_merge=true -F allow_merge_commit=false \
  -F allow_rebase_merge=false -F delete_branch_on_merge=true
gh api -X PUT "repos/$repo/private-vulnerability-reporting"
```

Release tags (two rulesets: one without any bypass for moving and deleting, one for creating).
Rulesets accept roles, teams and apps as bypass actors, not single accounts, so creating is
limited to the organization owner role; every organization owner can create a tag.

```bash
repo=VitalPointAI/near-ai-vscode
gh api -X POST "repos/$repo/rulesets" --input - <<'JSON'
{"name": "release tags are permanent", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "update"}, {"type": "deletion"}],
 "bypass_actors": []}
JSON
gh api -X POST "repos/$repo/rulesets" --input - <<'JSON'
{"name": "only owners create release tags", "target": "tag", "enforcement": "active",
 "conditions": {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}},
 "rules": [{"type": "creation"}],
 "bypass_actors": [{"actor_id": 1, "actor_type": "OrganizationAdmin", "bypass_mode": "always"}]}
JSON
```

The `marketplace` environment:

```bash
repo=VitalPointAI/near-ai-vscode
owner_id="$(gh api users/ALuhning --jq .id)"
gh api -X PUT "repos/$repo/environments/marketplace" --input - <<JSON
{"reviewers": [{"type": "User", "id": $owner_id}], "prevent_self_review": false,
 "can_admins_bypass": false,
 "deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
gh api -X POST "repos/$repo/environments/marketplace/deployment-branch-policies" \
  -f name='v*.*.*' -f type=tag
```

The `VSCE_PAT` is an Azure DevOps personal access token with the **Marketplace (Manage)** scope
for the `VitalPoint` publisher. The owner adds or rotates it with:

```bash
gh secret set VSCE_PAT --env marketplace --repo VitalPointAI/near-ai-vscode
```

which prompts for the value, so it never lands in shell history or a file.
