---
description: Run the agent PR review team on a pull request and set the agent-review status
argument-hint: <pr-number>
---

Run the agent review team on pull request **#$ARGUMENTS** of this repository, then record the
result with `scripts/agent-review.mjs`. The full process is in `docs/development-workflow.md`
("The agent review gate"); follow it exactly.

Rules for the whole run:

- Work only in a git worktree for the PR's branch under `.claude/worktrees/<branch-name-with-dashes>`.
  If one exists, use it; otherwise create it with
  `git fetch origin <branch> && git worktree add .claude/worktrees/<name> origin/<branch>` (detached
  is fine for a review). Never check out, reset or edit the main checkout or local `main`.
- The review is read-only. Reviewers do not push fixes. Findings go into the review file.
- Never print, copy or store secrets. Never touch `~/.near-credentials`.

## 1. Gather

```bash
node scripts/agent-review.mjs gather $ARGUMENTS --out "$SCRATCH/pr-$ARGUMENTS"
```

(`$SCRATCH` is your scratchpad directory.) This writes `pr.json`, `diff.patch`, `checks.json` and
`files.txt`, prints the CI table, and prints the `Head-SHA` to review. If a CI job failed, the
review can still run, but say so in the summary: the merge gate will refuse until CI is green.
If CI is still running, start the reviewers anyway and re-check CI with `gather` at the end.

## 2. Spawn the reviewers in parallel (one message, several Agent calls)

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

## 3. Aggregate and write the review file

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

## 4. Submit

The review posts as the **reviewer identity**, not as the author, so the status is an
independent check. `NEAR_AI_REVIEW_TOKEN` must hold that identity's token (see
`docs/development-workflow.md`, "The reviewer identity"). Without it `submit` refuses, which is
correct: signing as the author would defeat the gate.

```bash
node scripts/agent-review.mjs submit $ARGUMENTS --review "$SCRATCH/pr-$ARGUMENTS/review.md"
```

This posts the file as a PR comment and sets the `agent-review` status on the head commit:
success only for `Verdict: PASS`, a matching `Head-SHA`, and no open `[BLOCKER]`. Any push to
the branch afterwards needs a new review (the status is tied to the commit).

**Never merge.** After a PASS, report and stop: the owner approves the PR and presses Merge.
Branch protection requires that approval, and an agent must not supply it.

Report back: the verdict, the comment URL, the counts per severity, and the blockers if any.
