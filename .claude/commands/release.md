---
description: Prepare a release/x.y.z PR (version bump, CHANGELOG, README) for the merge agent
argument-hint: <x.y.z> [hotfix]
---

Prepare release **$ARGUMENTS** of the extension. If the arguments include `hotfix`, this is a
hotfix: use a `hotfix/<x.y.z>` branch instead of `release/<x.y.z>` (step 2). The full flow is
in `docs/development-workflow.md` ("Releasing"). Publishing to the Marketplace always waits for
the owner's approval in GitHub; never try to publish from this session.

1. **Pick the version.** Find the last release tag on GitHub, not in local tags, which can be
   stale: `git fetch origin --tags` and `git ls-remote --tags origin 'v*'` (the highest
   `v<x.y.z>`), then read `git log v<last>..origin/main`.
   Patch (x.y.Z) for fixes and small improvements, minor (x.Y.0) for new features. If the
   argument disagrees with the changes, say so before going on.

2. **Create the branch in its own worktree**, from the latest main:

   ```bash
   git fetch origin
   git worktree add -b release/<x.y.z> .claude/worktrees/release-<x.y.z> origin/main
   ```

   For a hotfix use `hotfix/<x.y.z>` (see "A bad version reached users: hotfix" in the workflow
   doc for when to branch from the last tag instead). A hotfix branched from an older tag must
   first bring over the release workflow and the gates from main, in its own commit, because CI
   and the Release workflow run the copies on the branch:

   ```bash
   git checkout origin/main -- .github scripts .vscodeignore
   git commit -m "chore(release): bring the release workflow and gates from main"
   ```

   `.github` carries the workflows and the secret-scan allowlist for the fake keys already in
   old test fixtures, `scripts` the scripts the workflows run, and `.vscodeignore` keeps
   `.github/` and `.claude/` out of the VSIX. Without any one of them CI or the Release workflow
   fails. Do everything below inside that worktree.

3. **Bump the version** (package.json and package-lock.json together):

   ```bash
   node scripts/prepare-release.mjs bump <x.y.z>
   ```

4. **Write the CHANGELOG section** `## <x.y.z>` at the top of `CHANGELOG.md`. Follow the style
   of the existing entries: a short opening paragraph on what the release is about, then one
   bullet per user-visible change, starting with a bold sentence that says what the user now
   gets, then what was wrong before and how it behaves now. Plain language, no internal names,
   no em-dashes. Cover every user-visible commit since the last tag; leave out internal-only
   changes. Update README (features, settings, troubleshooting) and SECURITY.md where the release
   changes what they describe.

5. **Verify locally:**

   ```bash
   node scripts/prepare-release.mjs check
   npm run lint && npm test
   npm run verify:release
   ```

6. **Commit and open the PR:**

   ```bash
   git commit -am "chore(release): <x.y.z>"
   git push -u origin release/<x.y.z>
   gh pr create --base main --title "chore(release): <x.y.z>" --body-file <filled PR template>
   ```

   The PR body is the CHANGELOG section plus the template's checklist.

7. Wait for CI, then run `/review-pr <number>`, then `/merge-pr <number>`. The merge agent tags
   the squash commit `v<x.y.z>`, which starts the Release workflow. Tell the owner the Release
   run URL so they can approve the `publish` job in the GitHub web UI ("Review deployments").
