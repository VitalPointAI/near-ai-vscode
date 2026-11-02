# Contributing

Thanks for helping with NEAR AI for VS Code. This page has the rules every change follows. The
full process, including reviews, releases and recovery, is in
[docs/development-workflow.md](docs/development-workflow.md).

## Set up

```bash
npm ci
npm run check            # type check and unit tests
npm run test:e2e         # the extension in a real VS Code (needs xvfb-run on Linux)
npm run verify:release   # package the VSIX and check what it contains
```

CI uses Node.js 24.

## Branches

Nobody pushes to `main`, including the owner. Every change reaches `main` through a pull
request from a short-lived branch. Branch protection enforces this once the owner has applied the
required settings ([docs/development-workflow.md](docs/development-workflow.md), section 8).
Branch names:

| Branch | For |
| --- | --- |
| `feat/<short-name>` | a new feature or a visible improvement |
| `fix/<short-name>` | a bug fix |
| `chore/<short-name>` | tooling, CI, dependencies, refactoring with no visible change |
| `docs/<short-name>` | documentation only |
| `release/<x.y.z>` | a release: version bump and CHANGELOG |
| `hotfix/<x.y.z>` | an urgent fix released on its own |

Short names are lowercase words joined by hyphens, for example `fix/proxy-hint`.

## One worktree per branch

Several people and agents work on this repository at once, so each branch gets its own git
worktree instead of switching branches in one checkout:

```bash
git fetch origin
git worktree add -b fix/proxy-hint .claude/worktrees/fix-proxy-hint origin/main
cd .claude/worktrees/fix-proxy-hint
npm ci
```

`.claude/worktrees/` is ignored by git. Remove the worktree after the PR merges:
`git worktree remove .claude/worktrees/fix-proxy-hint`. Never edit, reset or switch branches in
another person's or agent's worktree, and never commit on a local `main`.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, where
type is `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `build`, `ci` or `perf`. The summary
says what changed for the user, in the present tense, for example
`fix(chat): announce waiting approvals when the window is in the background`.

PRs are squash-merged, so the PR title becomes the commit on `main`: write it in the same form.

## Pull requests

- Fill in the template: what and why, how you tested, the security and docs checkboxes, and how
  to roll it back.
- Keep a PR to one change. Small PRs are reviewed and merged faster.
- These must pass before a PR can merge: the CI jobs `lint`, `test`, `e2e`, `release-content`,
  `audit` and `secret-scan`, and the `agent-review` status. The branch must be up to date with
  `main`, without conflicts, and with every review conversation resolved.
- No new runtime dependencies. Third-party code the extension runs is vendored at build time
  (see SECURITY.md, "Dependencies").
- Never commit secrets, real API keys or private data, including in tests. A test file that needs
  a fake key is listed in `.github/secret-scan-allow.txt` with the scanner rules the fake key
  matches and a reason, or the line carries the marker `secret-scan: allow`.
- User-visible changes need a CHANGELOG entry written for users, and README or SECURITY.md
  updates when they change what those describe.

## Reporting security issues

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on the
repository's Security tab; [SECURITY.md](SECURITY.md#reporting-a-vulnerability) explains it and
what to do if the button is missing. Please do not describe a vulnerability in a public issue.
