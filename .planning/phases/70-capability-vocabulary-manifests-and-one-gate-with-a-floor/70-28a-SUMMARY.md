---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 28a
pr: 4a
subsystem: release close-out
status: complete
tags: [close-out, PR 4a, CHANGELOG, SECURITY.md, gate]
requires: ["70-19"]
provides:
  - "CHANGELOG ## Unreleased entry for part 4a"
  - "SECURITY.md Model requests bullet, README policy bullet and Show Policy line for the route check, pinned by gateDocs and gateCommands"
  - "The PR 4a body (written for the coordinator, who opens the PR)"
affects: [70-20, 70-28b]
key-files:
  created: [.planning/phases/70-capability-vocabulary-manifests-and-one-gate-with-a-floor/70-28a-SUMMARY.md]
  modified: [CHANGELOG.md, SECURITY.md, README.md, src/services/gateCommands.ts, src/test/gateDocs.test.ts, src/test/gateCommands.test.ts]
decisions:
  - "origin/main was brought in with a merge, not a rebase (coordinator instruction: no force push)."
  - "Log growth is not measured again; 70-19-SUMMARY.md holds the numbers, re-measured after the owner's answer."
  - "The coordinator pushes and opens the PR; this plan writes the body only."
metrics:
  completed: 2026-11-17
---

# Phase 70 Plan 28a: Close-out of PR 4a Summary

PR 4a is ready for the coordinator to push and open. main is merged in, the CHANGELOG has its `## Unreleased` entry, and SECURITY.md, the README and Show Policy now say what the route check does. The new sentences are pinned by tests. The full gate passed once inside the memory cap, and the PR body is written. Nothing was pushed, opened or merged.

## Merged check (precondition)

- PR #76 is MERGED, with merge commit `2e287a8e7fedc0ee9bce5e7499e7a1be6567248a`.
- `git merge-base --is-ancestor 2e287a8 origin/main` exited 0.
- `origin/main` was at `44b2cfa` (#79, the merge-pr fix). #78 (planning only) had not merged.

## Bringing main in

- The coordinator chose a merge, not the plan's `git rebase --onto` (no force push).
- `git merge origin/main` made `d7952a5` with no conflict.
- #79 only touches `scripts/lib/merge.mjs` and its tests, so the PR diff against main holds only 4a's own changes.

`git log --oneline origin/main..HEAD` before this SUMMARY's commit:

```
c07924a docs(changelog): part 4a, a route check before every model request
761da37 docs(gate): SECURITY.md, README and Show Policy say every model request is routed and recorded in its own log
d7952a5 Merge origin/main into feat/gate-route-check (brings in #79)
192510c docs(70-19): summary updated for the model-request log and the shorter short record
e5813cf feat(gate): model requests get a log of their own, and the short record writes nothing twice
023b5bd docs(70-19): summary of the route check, session routes and model request records (PR 4a)
8518e84 feat(gate): every model request leaves a record, and part 4's ids are named
2aa0604 feat(gate): every model request runs inside a session route
ca04772 feat(gate): the route check at the client's one choke point, with attested-cloud held to a proven binding
```

## What this plan changed

- **CHANGELOG.md:** a new `## Unreleased` section at the top, because the 0.4.29 release had moved the last one. It covers:
  - every model request is checked before it is sent, whatever sends it;
  - on a fresh install nothing changes where requests go, and routing by label comes later;
  - each request leaves a short record (about 1 KB) in a log of its own that never holds content, a server address or a path, rolls over like the decision log, and is never synced or put in the project;
  - Show Policy says the routing is in use.
- **SECURITY.md** "Your policy file and decision records" has a new **Model requests** bullet:
  - the route check and where requests come from;
  - only local facts are used;
  - the default label applies on a fresh install;
  - a refused request is not sent and says why;
  - attested-cloud levels stay on this computer for now;
  - the log of its own at `gate/model-requests/`, with the same rotation, never synced, never in the project;
  - what a routine record holds (each item once), what a refused one adds, and that a record never names content, an endpoint address or a file path.

  "What this version does not use yet" now names only the scales and clearances.
- **README.md:** the "Your policy" bullet says every model request is checked against its routing, leaves a record in a log of its own, and that nothing changes on a fresh install.
- **Show Policy:** the line above the scales (`POLICY_LABELS_NOT_USED_TEXT`) now says this version checks every model request against the routing below, at the default label, and does not use the scales and clearances yet.
- **Tests, red first** (3 failing before the docs changed, then all 42 passing):
  - `gateDocs.test.ts` (+2): pins the SECURITY.md and README sentences, the folder name equal to `MODEL_REQUESTS_DIR`, and holds the old "routing not used" sentence out.
  - `gateCommands.test.ts`: three added assertions in the Show Policy test. Nothing was removed.

## Log growth (D-52)

These are the numbers in 70-19-SUMMARY.md, re-measured after the owner chose a log of its own and the shorter short record. They are not measured again here.

| Record | Bytes |
|---|---|
| Short, agent | 1,095 |
| Short, sub-agent | 1,099 |
| Short, person | 989 |
| Full | 1,898 |
| Tool decision | 1,281 |

| Day | Model-request log rolls over after | Tool-decision log rolls over after | One shared log, before |
|---|---|---|---|
| Median | 9.1 days | 10.1 days | 4.3 days |
| 75th percentile | 4.9 days | 5.4 days | 2.3 days |
| 90th percentile | 1.9 days | 2.1 days | 0.9 days |
| Busiest project day | 1.2 days | 1.4 days | 0.6 days |

The tool-decision figures are an estimate (one decision per agent turn, a lower bound).

## Gate (each run once, one at a time, inside the cap)

| Gate | Command | Result |
|---|---|---|
| Lint and suite | `npm run lint && npm test` (6G, 1800 s) | exit 0; 3,499 tests, 3,490 pass, 0 fail, 0 cancelled, 9 skipped (live tests that need a key) |
| e2e | `xvfb-run -a npm run test:e2e`, `WAYLAND_DISPLAY`, `WAYLAND_SOCKET` and `XDG_SESSION_TYPE` unset (6G, 1800 s) | exit 0; 21 passing across both scenarios (16 project, 5 plain), 0 failing; `NODE_OPTIONS` was accepted by the launch |
| Release content | `npm run verify:release` (4G, 900 s) | exit 0; "Release content verified: 393 entries, 313 runtime JavaScript files, and 50 required release assets." |
| Secret scan | `node scripts/secret-scan.mjs --range origin/main..HEAD` (4G, 900 s) | exit 0; "Secret scan clean: 1252 tracked files and 10 commit(s)", 9 allowlisted fixtures |

## Budget

- `package.json` and `package-lock.json` are unchanged against `origin/main`, and the branch sits on top of `origin/main`.
- PR diff (`git diff origin/main...HEAD`) before this SUMMARY: 217,774 bytes, 32 files, 1,905 insertions and 118 deletions.
- Projected after review (times 2.2): about 479,000 bytes, under the 950,000 byte budget and the ~650 KB target.
- The code without `.planning` is 192,672 bytes.

## PR

The coordinator opens the PR. The body is in the coordinator's scratch file `pr-4a-body.md`. It follows `.github/pull_request_template.md` and contains:

- what changes: D-24, D-31, D-36, D-49, D-50, D-52 and D-53, the "route check" and the "short record";
- the log-growth tables;
- the owner questions: the short record, the 5 MB size, and the `connection` field;
- the D-48 release blocker section;
- the test totals and every changed test;
- the diff size;
- the rollback.

The PR number is not known here.

## Review round 1 (PR #81, 5 minor findings)

Main was merged in again first: `git merge origin/main` brought in #78 (the planning PR, `5f6b9cf`) with no conflict. Main's plan files were kept as they are, and this PR's summaries are unchanged by the merge.

Each fix was seen failing first: with the five fixes switched off in place, 5 tests failed; restored, all passed. All five fixes are in commit `b882b3d`.

1. **One list of content paths.**
   - `CONTENT_PATHS` is the only list, and `BILLABLE_PATHS` is that same set.
   - `needsRouteCheck` checks every request that is not a GET, except the named `NON_CONTENT_POST_PATHS` (`/billing/costs`, `/check_api_key`).
   - A test fails if the sets drift, or if the client writes a POST to a path on neither list. It also shows a POST to an unlisted path being refused while the key check passes.
2. **The request-site scan reads the syntax tree.** Coverage is decided by the shape of the code around each call. A call counts as covered when it is:
   - the work argument of `withSessionRoute`;
   - inside a local function used only as that work;
   - inside a hook of `new AgentRun({...})`;
   - inside a class method whose every call is covered;
   - in `loop.ts`, inside an AgentRun method other than the constructor.

   Each `inside` entry names the call in its caller that reaches it (`via`). The sites that used to call unwrapped when there was no gate host now wrap in the default route, and the cybersecurity role call is wrapped where it is made.

   Planted unwrapped calls are reported with their file and line: in the chat session, the attachment read, Team Studio (its work also called directly), the cyber hand-off, and a new file. That is exactly 5 findings.
3. **The deciding label on every refusal.** `routeRecordFor` writes the label that decided a refusal: the default label when the mark is empty, otherwise the mark's label whose tier decided. Data classifications name each level once. The SECURITY.md sentence and its gateDocs pin say the default label case and the no-label case.
4. **A throwing routing table or mark** gives `routeCheckFailed()`: `route.deny` with `ROUTE_CHECK_FAILED_TEXT`. It is recorded with no label and thrown as a plain `RouteRefusedError`. There is a test for it.
5. **The default route is cleared at deactivation.** `setDefaultSessionRoute` returns a function that clears the route only while it is still the one set, and `registerGate` adds it to the context's subscriptions. A test in `gateActivation.test.ts` covers set, cleared on dispose, and a replaced host that does not clear its replacement.

### Tests changed in this round

- `gateRouteGuard.test.ts`:
  - The scan test was replaced by the syntax-tree version. It is stricter: the old checks are all still made, and planted calls in files that wrap elsewhere are now caught.
  - `productionSources` returns the text as written, so line numbers are real. The client-construction scan strips comments itself.
  - The short-record test passes `routing` in the record context.
  - 3 tests were added.
- `gateActivation.test.ts`: 1 test was added. It starts by clearing the default route, because the earlier tests in that file activate hosts without deactivating them.
- `gateDocs.test.ts`: 2 phrases were added to the SECURITY.md pin.

### Gate after the round

| Gate | Result |
|---|---|
| `npm run lint && npm test` (6G) | exit 0; 3,503 tests, 3,494 pass, 0 fail, 0 cancelled, 9 skipped |
| e2e under xvfb, Wayland variables unset (6G) | exit 0; 21 passing, 0 failing |
| Range secret scan | see the report; run after this commit |

## Deviations from Plan

1. **Merge instead of rebase** (coordinator): `git merge origin/main` (commit `d7952a5`) instead of `git rebase --onto origin/main <PR4A_BASE>`. As a result `origin/main..HEAD` lists the merge commit too. The PR diff still holds only 4a's changes.
2. **No new log measurement** (coordinator): the numbers come from 70-19-SUMMARY.md, which used the spend ledger with counts only.
3. **The PR is not pushed or opened** (coordinator): Task 3's push, `gh pr create` and CI watch are left to the coordinator. The body is written instead.
4. **Docs beyond the plan's file list** (coordinator): SECURITY.md, README.md and the Show Policy line were updated in this close-out, with new pins in gateDocs and gateCommands. The plan listed only CHANGELOG.md.
5. **Correction to 70-19-SUMMARY.md:** the e2e count there now reads 21 tests. The earlier "23" and "26" counted VS Code download lines.

## Self-Check: PASSED

Commits `d7952a5`, `761da37` and `c07924a` and this SUMMARY's commit are on HEAD. CHANGELOG.md has exactly one `## Unreleased`. The four gates exited 0. The range secret scan ran after the SUMMARY was committed, so it covers all 10 commits.
