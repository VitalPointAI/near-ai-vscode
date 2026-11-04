---
description: Run the agent review of a pull request (the agent-review workflow) and report its result
argument-hint: <pr-number>
---

Get the agent review of pull request **#$ARGUMENTS** of this repository and report it. The full
process is in `docs/development-workflow.md` ("The agent review gate"); follow it exactly.

The `agent-review` status is posted only by the reviewer identity, `near-ai-reviewer`, from
`.github/workflows/agent-review.yml`. This session runs `gh` as the owner's account, so it never
posts the status: `scripts/agent-review.mjs submit` refuses any account but `near-ai-reviewer`, and
the merge and release gates ignore a status from any other account. Trigger the workflow and read
what it posted.

Rules for the whole run:

- Work only in a git worktree for the PR's branch under `.claude/worktrees/<branch-name-with-dashes>`.
  If one exists, use it; otherwise create it with
  `git fetch origin <branch> && git worktree add .claude/worktrees/<name> origin/<branch>` (detached
  is fine for a review). Never check out, reset or edit the main checkout or local `main`.
- The review is read-only. Reviewers do not push fixes. Findings go into the report.
- Never print, copy or store secrets. Never touch `~/.near-credentials`.
- Never run `agent-review.mjs submit` without `--dry-run`, and never set the `agent-review` status
  any other way.

## 1. Gather (read-only)

```bash
node scripts/agent-review.mjs gather $ARGUMENTS --out "$SCRATCH/pr-$ARGUMENTS"
```

(`$SCRATCH` is your scratchpad directory.) This writes `pr.json`, `diff.patch`, `checks.json` and
`files.txt`, prints the CI table, and prints the head SHA. If a CI job failed, say so: the workflow
reviews automatically only after CI succeeds, and the merge gate refuses until CI is green.

## 2. Trigger the review workflow

The workflow also runs on its own after CI succeeds for the PR. To (re-)review by hand:

```bash
gh workflow run agent-review.yml -f pr=$ARGUMENTS
sleep 5
run_id=$(gh run list --workflow agent-review.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$run_id" --exit-status
```

The workflow runs from `main` with the reviewer's token from the `agent-review` environment, and
skips a workflow_run whose PR head moved after CI (the newer head gets its own run). If the
run fails before reviewing (for example the environment or a secret is missing), report the failing
step from `gh run view "$run_id" --log-failed`; do not try to post a status yourself.

## 3. Read the result

```bash
head=$(gh pr view $ARGUMENTS --json headRefOid --jq .headRefOid)
gh api "repos/{owner}/{repo}/commits/$head/statuses" \
  --jq '[.[] | select(.context == "agent-review" and .creator.login == "near-ai-reviewer")][0] | {state, description, target_url}'
```

`target_url` links the review comment; read it with `gh pr view $ARGUMENTS --comments`. Only this
status counts: one set by any other account is ignored by the gates.

If the review passed and the PR changes the gates (`GATE_PATHS` in `scripts/lib/workflow.mjs`),
the run's `owner-approval` job waits in the `agent-review-gates` environment. Tell the owner: read
the review comment, then on the run page choose Review deployments, tick agent-review-gates, and
Approve and deploy. Never approve it yourself.

Report back: the verdict (the status state), the comment URL, the recommendation, the counts per
severity, the blockers if any, and whether the approval was posted or is waiting for the owner. If
the status is missing or still pending, say so and give the run URL.

## Optional: a local second opinion (advisory, posts nothing)

When the owner asks for a deeper review than the workflow's model gives, run the review team
locally and report its findings alongside the workflow's result. It never changes the status.

### Spawn the reviewers in parallel (one message, several Agent calls)

Give each reviewer the worktree path, the gather directory, the head SHA, and this output
contract: a markdown list of findings, each line starting with a severity tag `[BLOCKER]`,
`[MAJOR]`, `[MINOR]` or `[NIT]`, then `path:line`, then what is wrong and the fix. BLOCKER means
"must not merge": a bug that breaks users, a security or privacy hole, data loss, a failing or
weakened test, a secret, a broken release, or missing required docs for a user-visible change.

1. **Code review.** A `gsd-code-reviewer` agent over the files in `files.txt` (standard depth;
   deep for changes to `src/agent/`, `src/security/`, approvals, privacy checks, spend limits or
   the release scripts). Alternatively run the `code-review` skill at `high` on the PR number.
2. **Security review.** Run the `security-review` skill in the PR worktree (its "pending changes"
   are the PR's commits against `origin/main`). Also check against SECURITY.md: does the change
   alter where data goes, what the agent may do without asking, credentials handling, network
   endpoints, or dependencies? If yes, SECURITY.md must be updated in the same PR.
3. **Docs and changelog review.** A general-purpose agent that checks: a user-visible change has
   a CHANGELOG entry in plain, user-facing prose (under the next version heading, or noted for
   the release PR); README and SECURITY.md are updated where behavior they describe changed;
   new settings and commands are documented; no em-dashes in docs; conventional commit messages.
4. **Release review** (only for `release/x.y.z` and `hotfix/x.y.z` PRs). Run
   `node scripts/prepare-release.mjs check` in the worktree; confirm the CHANGELOG section
   covers every user-visible change since the last tag (`git log v<last>..HEAD --oneline`) and
   that the version bump fits the changes (patch for fixes, minor for features).

### Aggregate and write the review file

Deduplicate the findings, keep the highest severity when reviewers disagree, and drop anything
you checked and found to be wrong (say why in one line under "Dismissed"). Write
`$SCRATCH/pr-$ARGUMENTS/review.md` in exactly this shape. The file must have exactly one
`Verdict:` line, reading `Verdict: PASS` or `Verdict: FAIL` with nothing else on it (PASS only
when there is no open BLOCKER), and exactly one `Head-SHA:` line with the full 40-character SHA.
Anything else, including a second verdict line or a code fence left open, fails the review.
Keep both lines at the start of a line, outside quotes, lists and HTML comments, and indent code
fences by at most 3 spaces.

```markdown
## Agent review for #<number>

Verdict: PASS
Head-SHA: <the 40-character head SHA from gather>

### Summary
<two to four sentences: what the PR does and whether it is safe to merge>

### Findings
- [MAJOR] src/foo.ts:42 ...
- [MINOR] ...

### Dismissed
- <what was checked, without a severity tag> : <why it is not a problem>

### Reviewers
code review, security review, docs/changelog review[, release review]; CI: <green | which jobs failed>
```

A BLOCKER fixed by a later commit is written `- [BLOCKER][RESOLVED] ... (fixed in <sha>)`, and
only counts as fixed when the review is re-run on the new head. Severity tags count anywhere in
the file, code blocks included, so a dismissed item must not keep its `[BLOCKER]` (or other)
tag: describe it in plain words under "Dismissed".

### Check the file, without posting

```bash
node scripts/agent-review.mjs submit $ARGUMENTS --review "$SCRATCH/pr-$ARGUMENTS/review.md" --dry-run
```

The dry run shows the comment and the status the file would produce (success only for
`Verdict: PASS`, a matching `Head-SHA`, and no open `[BLOCKER]`) and posts nothing. Report the
findings to the owner; if they warrant a change to the verdict, the fix is a new commit on the PR,
which the workflow then reviews again.
