# Testing rules

How to run the checks for this repository without slowing down or crashing the computer you work
on. CI runs the same checks on every pull request (see [the development workflow](development-workflow.md),
section 3).

## Cap the memory of every test run and heavy build

A runaway test or build can take all of the computer's memory, and the system then kills whatever
it picks, which has included the editor itself. So on Linux every test run and every heavy build
(the VSIX, the documentation site) runs inside a memory cap, at a low priority for the out-of-memory
killer, with a time limit:

```bash
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 \
  choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 <command>
```

- Focused runs (one test file, lint, one build): `MemoryMax=4G`, `timeout 300`.
- The full unit suite and the end-to-end tests: `MemoryMax=6G`, `timeout 1800`, and only one such
  heavy run at a time on the computer (agents share a lock file for this).
- The documentation site build: `MemoryMax=4G`, `timeout 900`,
  `NODE_OPTIONS=--max-old-space-size=2048`.

If a capped run is killed, the run uses too much memory: fix that. Never raise the cap above 6G
and never run uncapped instead.

## Run tests through the runner

Run test files only through `scripts/run-tests.mjs`, never with a bare `node --test`. The runner
gives each run its own temporary folder and removes it at the end; without it, tests that make
temporary workspaces fill the temporary folder over time.

```bash
npm run compile
node scripts/run-tests.mjs dist/test/<file>.test.js [--test-name-pattern <name>]
node scripts/run-tests.mjs scripts/test/<file>.test.mjs
```

## What to run when

- After a change: the focused tests for the files you changed, and `npm run lint`.
- Before you push: `npm run lint` and `npm test`, once, capped as above.
- When you change activation, commands or webviews: also the end-to-end tests,
  `npm run test:e2e` (on a desktop session, unset `WAYLAND_DISPLAY` and `XDG_SESSION_TYPE` so the
  test window uses the virtual display).
- When you change what ships in the VSIX: `npm run verify:release`.
- When you change the documentation or the docs site: `npm run docs:build`, which also fails on
  a broken link.

Never delete, skip or weaken a failing test to get a green run. A test that fails before a fix and
passes after it goes with every bug fix.
