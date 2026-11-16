---
phase: 69-team-mode-reconciliation-identities-and-signed-events-on-mai
plan: 06
subsystem: team-mode
tags: [team-mode, preview-gate, manifest, context-key, plain-words, boundary-test]

requires:
  - phase: 69-05
    provides: registerTeamMode, TeamSession, the status bar and the vscode test stub on main
provides:
  - "Setting nearAi.team.preview (boolean, false, application scope) and the two menus.commandPalette entries"
  - "Context key nearAi.team.active (TEAM_ACTIVE_CONTEXT), set when a team session starts and cleared when it is disposed"
  - "teamManifest.test.ts for main (no merge base) and teamBoundaries.test.ts (no vscode, no package, no editor service in the team core)"
  - "Phase 60 plain-words strings from 0f5ea20 and f6890da where the rule allows, command titles unchanged"
affects: [69-07, 69-08, 69-10]

actuals:
  tokens: 10100
  tasks: 3
  commits: 3
plan_head_before: 31bdffea721bb8ccddfe08608ab4930a783651f2
plan_head_after: 2500199a21a08f191004bf881411c9d6ea843ac

tech-stack:
  added: []
  patterns:
    - "A feature gate lives in menus.commandPalette only: registration and activation ignore the setting, so a project that already has a team is never a dead end"
    - "The session reports start and dispose through one optional dependency (activeChanged), so the headless team code never touches vscode"

key-files:
  created:
    - src/test/teamManifest.test.ts
    - src/test/teamBoundaries.test.ts
  modified:
    - package.json
    - src/services/team/teamSession.ts
    - src/services/team/teamCommands.ts
    - src/services/team/teamStatusBar.ts
    - src/team/gitTransport.ts
    - src/test/helpers/vscodeStub.ts
    - src/test/teamSoloParity.test.ts
    - src/test/teamSession.test.ts
    - src/test/teamCommands.test.ts
    - src/test/teamGitTransport.test.ts

key-decisions:
  - "The context key is set by TeamSession through an optional activeChanged dependency: true after the first sync of start(), false in dispose(). createVscodeTeamSession supplies the setContext call, so src/team and src/domain/team stay untouched and a solo project never calls it"
  - "A failed setContext is written to the NEAR AI Team channel, never swallowed and never fatal to the session"
  - "Phase 60 text is copied by hand and only where all three conditions of D-19, D-24 and D-31 hold; the tooltip structure of Phase 60 is kept whole"

patterns-established:
  - "teamManifest.test.ts asserts the manifest against its own expected contents; no git history is read"
  - "teamBoundaries.test.ts scans sources from the repository root (not dist) and proves the scanner with planted violations"

requirements-completed: [TMR-02, TMR-03]

duration: 35min
completed: 2026-11-15
status: complete
---

# Phase 69 Plan 06: Preview gate, plain words and the team core boundary Summary

**Enable Team Mode is hidden from the Command Palette until `nearAi.team.preview` is on, Verify Team Log shows whenever the setting is on or a team session runs (`nearAi.team.active`), Phase 60's visible text is in plain words with every command title unchanged, and a test pins "no vscode, no package, no editor service" for `src/domain/team` and `src/team`.**

## Accomplishments

- Task 1 (tracer): `package.json` gains `nearAi.team.preview` (boolean, default false, application scope, plain description) right after `pollSeconds`, and `contributes.menus.commandPalette` with exactly `nearAi.team.enable` when `config.nearAi.team.preview` and `nearAi.team.verifyLog` when `config.nearAi.team.preview || nearAi.team.active`. `teamSession.ts` exports `TEAM_ACTIVE_CONTEXT`; `TeamSession` calls an optional `activeChanged(true)` after `start()` has waited for the first sync and `activeChanged(false)` in `dispose()`, and `createVscodeTeamSession` passes the `setContext` call. The vscode stub records `setContextCalls` and `contextKeys` and handles `setContext` without touching registered-command dispatch. `teamManifest.test.ts` comes from `ae5e9e1` with the merge-base test removed and replaced by: no `dependencies` key, the preview setting contract, the exact palette entries, and the when clause naming `TEAM_ACTIVE_CONTEXT`. `teamSoloParity.test.ts` adds: both commands registered with preview false, a team project with preview false records `setContext(nearAi.team.active, true)` then `false` after dispose, and a solo project records no `setContext` call.
- Task 2: plain-words strings (list below). Exact assertions in `teamSession.test.ts`, `teamCommands.test.ts` and `teamGitTransport.test.ts` were changed to the new exact text, none loosened; the busy reason, which no test pinned, now has an exact assertion in the existing busy test.
- Task 3: `teamBoundaries.test.ts` (5 tests). It scans every `.ts` under `src/domain/team` (7 files) and `src/team` (9 files) from the repository root for static imports, re-exports, side-effect imports, dynamic `import()` and `require()`, and reports `file:line specifier  reason`. No violation exists in the ported code, so no code changed for it. The scanner is proven by planted text (vscode, a package, an editor service, a value import of `services/auth`, a multi-line import, a dynamic import and a `require`) and by a comment-only text that must report nothing.

## Phase 60 strings: taken

| Replacement | Source | Why it qualifies |
|-------------|--------|------------------|
| `PAUSED_UNREACHABLE_TEXT` 'Team sync paused: offline' | 0f5ea20 | verbatim old text present, no later feature, no command title |
| `PAUSED_REWRITTEN_TEXT` 'Team sync paused: record changed' | 0f5ea20 | same |
| `PAUSED_MISSING_TEXT` 'Team sync paused: team record missing' | 0f5ea20 | same |
| `PAUSED_REFUSED_TEXT` 'Team record not trusted' (also the start of the refusal warning, which uses the constant) | 0f5ea20 | same |
| Busy reason 'The team record changed too often while saving. Try again in a moment.' (both places) | f6890da | same |
| `PUSH_ACTION` 'Push' to 'Share with my team' | 0f5ea20 | the button of Enable's own push |
| Enable confirmation: 'team.json is committed on main. Push it when you are ready so teammates can see the team.' becomes 'Team Mode is on for X. Share it so teammates can see the team.' with the git detail line kept in the channel; with no branch the notification is 'Team Mode is on for X.' | 0f5ea20 | Enable's own text; git words move to the channel |
| Push success 'Pushed main to origin.' becomes the notification 'Shared with your team.' (the old line stays in the channel) | 0f5ea20 | Enable's own text |
| `EMAIL_PROMPT` 'Your email is kept only as a scrambled code (a salted hash) in the team record, never as plain text.' | 0f5ea20 | no later feature, no command title |
| Verify progress title 'Checking the team record' | 0f5ea20 | the old text 'Verifying the team log' is not the command title |
| Verify result 'The team record passed its check: N events, ...' | 0f5ea20 | old 'Team log verified:' is not the command title |
| Verify result 'The team record was checked and has problems: ...' with 'The record failed its safety check. Choose Show details to see why.' for a refused log (the reason stays in the channel report as 'Log refused: ...') | 0f5ea20 | main's announcement already carries a Show details button |

## Phase 60 strings: refused

| Replacement | Source | Reason |
|-------------|--------|--------|
| Retitle 'Verify Team Log' to 'Check Team Record' (package.json, `guarded` title) | 0f5ea20 | D-31: the title is kept as named; not recorded as a follow-up |
| `VERIFY_ACTION` 'Check the team' | 0f5ea20 | the old text is the command title |
| `VERIFY_SENTENCE` 'Click to check the team.' and the four status tooltips (`UNREACHABLE_TOOLTIP` and the others) | 0f5ea20 | main's tooltips keep their own structure (the reason in the tooltip, 'Click to run Verify Team Log.'); the texts that name the command title stay with it, and the unreachable tooltip's board sentences do not exist on main |
| 'Verify Team Log: name (id)' report header, 'Verify Team Log failed:' and 'Verify Team Log could not finish:' | 0f5ea20 | contain the command title |
| `READ_ONLY_TEXT` 'not yet approved ... You can look at the board. Ask your lead to approve this computer' | 0f5ea20 | names the board and an approval flow (later phases) |
| Refusal warning 'does not belong to this project's team ... ask your lead' | 0f5ea20 | names a lead action that Phase 60 has no flow for; only the `PAUSED_REFUSED_TEXT` constant change reaches it |
| `share()` with Try again and Show details, `SHARE_FAILED_TEXT`, `ENABLE_PLAIN_TEXT` (including the invite and Join Team sentence), `enableStopped` | 0f5ea20 | new behaviour and buttons, not replacements of existing text, and some name Join and invites |
| IMPORT_NOW_ACTION, import failure details, JOIN and member text | 0f5ea20, f6890da | later-phase features (import, join, invite, link, removal) that do not exist on main |
| The failed-push notification (`pushed.message`) | 0f5ea20 | the replaced text is not a verbatim string in the file and is still asserted as is by teamCommands.test.ts |

## Test evidence

Each run under `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'` after a clean `npx tsc -p tsconfig.json` (which also serves as the lint, `tsc --noEmit`).

| Command (after `npx tsc -p tsconfig.json &&`) | Tests | Pass | Fail |
|-----------------------------------------------|-------|------|------|
| Task 1: `node --test --test-concurrency=2 dist/test/teamManifest.test.js dist/test/teamSoloParity.test.js dist/test/teamSession.test.js dist/test/relayIsolation.test.js` | 48 | 48 | 0 |
| Task 2: `node --test --test-concurrency=2 dist/test/teamSession.test.js dist/test/teamCommands.test.js dist/test/teamGitTransport.test.js dist/test/teamManifest.test.js` | 82 | 82 | 0 |
| Task 3: `node --test dist/test/teamBoundaries.test.js dist/test/teamManifest.test.js` | 13 | 13 | 0 |
| Extra, after the last commit: `node --test --test-concurrency=2 dist/test/team*.test.js dist/test/relayIsolation.test.js` | 527 | 527 | 0 |

0 cancelled, 0 skipped in every run. The full root `npm test` and e2e are the plan 08 gate and were not run here.

Acceptance checks: palette entries print exactly as planned; preview prints `boolean false application`; `grep -c merge-base src/test/teamManifest.test.ts` is 0; `grep -c "nearAi.team.active" src/services/team/teamSession.ts` is 2; the verifyLog title prints `Verify Team Log`; `teamBoundaries.test.ts` has 5 tests and 7 mentions of `stateMirrorLock`. Against baseline 4e5dbb9, the only modified (not added) paths are `package.json`, `src/domain/approval.ts`, `src/extension.ts` and `src/services/auditStore.ts`.

## Task Commits

1. Task 1: `8f22969` feat(team): Enable Team Mode behind the nearAi.team.preview setting; Verify Team Log shows whenever a team is active (D-13, D-24, D-27)
2. Task 2: `5af3834` fix(team): plain words in the Team Mode status bar, Enable and sync messages (Phase 60 strings from 0f5ea20, f6890da)
3. Task 3: `2500199` test(team): the team core imports no vscode, no editor service beyond the shared lock, and no new dependency (D-18)

## Deviations from Plan

None - plan executed as written. Two notes that are not deviations:

- The plan lists `teamManifest.test.ts` as a ported file, but plan 05 did not bring it across, so it was created from `git show ae5e9e1:src/test/teamManifest.test.ts` and then edited as Task 1 describes.
- Commit trailer: the plan names `Claude Opus 5.5`; the commits carry `Claude Sonnet 5.5`, the model that actually ran, as the owner rules require.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None. T-69-13 is covered by the application scope and the manifest test, T-69-14 by `teamBoundaries.test.ts`, and no package was added (T-69-SC).

## Self-Check: PASSED

- Created files exist: `src/test/teamManifest.test.ts`, `src/test/teamBoundaries.test.ts`.
- Commits `8f22969`, `5af3834` and `2500199` are ancestors of HEAD.
- `git status --porcelain` showed no unexpected files before this summary was written.
