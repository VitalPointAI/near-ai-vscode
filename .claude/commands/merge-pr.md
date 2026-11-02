---
description: Merge a pull request when every gate passes (squash, delete branch, tag releases)
argument-hint: <pr-number>
---

Act as the merge agent for pull request **#$ARGUMENTS**.

1. Run the gate in dry-run mode first:

   ```bash
   node scripts/merge-pr.mjs $ARGUMENTS --dry-run
   ```

2. If it refuses, do **not** work around it. Report each reason and the fix:
   - a CI job failed: link the job, summarize the error, and hand it back to the branch's author
     (or fix it in the branch's worktree if you were asked to);
   - `agent-review` missing, failing, or stale after new commits: run `/review-pr $ARGUMENTS`;
   - branch behind main: `gh pr update-branch $ARGUMENTS --rebase`, then wait for CI and re-run
     `/review-pr` (the new head needs its own review);
   - merge conflicts: resolve them in the branch's worktree, never on `main`;
   - unresolved conversations: answer or resolve them first.

3. When the dry run passes, merge for real:

   ```bash
   node scripts/merge-pr.mjs $ARGUMENTS
   ```

   This squash-merges with the PR title as the commit subject and deletes the remote branch.
   It passes `--repo`, so `gh` does not touch any local branch or worktree.

4. For a `release/x.y.z` or `hotfix/x.y.z` PR the script then waits for CI on the squash commit
   and tags it `vx.y.z`. The Release workflow builds the VSIX and the GitHub release. The
   Marketplace `publish` job then **waits for the owner's approval**: tell the owner the run URL
   (`gh run list --workflow release.yml --limit 1`) and that they approve it under
   "Review deployments". Never approve it yourself.

5. Afterwards remove the branch's local worktree if this session created it
   (`git worktree remove .claude/worktrees/<name>`), never one another session owns.

Never use `gh pr merge --admin`, never push to `main`, and never change branch protection to get
a PR through.
