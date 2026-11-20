---
phase: 41-organization-policy-foundation-f1
plan: 11
subsystem: copy lint (src/test)
status: complete
tags: [copy-lint, glossary, ratchet, baseline, fnd-07]
requires: [41-06 (MODES, term)]
provides:
  - src/test/helpers/copyLintScan.ts (COPY_RULES, GLOSSARY_WORDS, ALLOWED_CONTEXTS, MODEL_INSTRUCTIONS, DISTINCTIVE_MODE_WORDS, modeWordsFromTable, COMPLIANCE_CLAIMS, ALLOWED_CLAIM_CONTEXTS, extractPackage, extractCopy, htmlText, isHumanText, isNameList, copySourceFiles, countHits, scanRepository, compareWithBaseline, increaseMessage, checkTightness, baselineText, readBaseline, writeBaselineAndFail)
  - src/test/copyLint.test.ts (28 tests)
  - src/test/copy-lint-baseline.json (67 files)
affects: [41-09, 41-10 (their new copy must pass the lint at the wave 3 merge), 41-15 (sets NEAR_AI_BASELINE_TIGHT=1)]
tech-stack:
  added: []
  patterns: [ratchet baseline counted per file and rule, write mode that always fails, longest-phrase-wins matching, allowed-context tables checked against the tree]
key-files:
  created:
    - src/test/helpers/copyLintScan.ts
    - src/test/copyLint.test.ts
    - src/test/copy-lint-baseline.json
  modified: []
decisions:
  - "Sources are parsed with the TypeScript parser (createSourceFile, syntax only, as src/test/helpers/toolRunScan.ts already does), not by balancing parentheses by hand; same sources and same result, no regex literal pitfalls."
  - "Sources read beyond the plan's list, all user copy: package displayName and description, configuration section titles, chat participant name and command descriptions, showInputBox calls, title/aria-label/placeholder/alt attribute values in built HTML, media/cyber/cyber.html, and message records named *_REJECTIONS, *_PROBLEMS or with a qualifier after REFUSALS/FAILURES (ROUTE_REFUSALS_NAMED_AHEAD)."
  - "Not copy: ids with a separator and class lists (isNameList), page script selector/event/attribute/class arguments and comparison values, and five model instructions listed in MODEL_INSTRUCTIONS (each checked to be exported where listed)."
  - "Glossary nouns also match their plural (tiers, endpoints, profiles); hits overlap-resolve longest first, so export-endpoint is not also endpoint and model passport is not also passport."
  - "A brand title prefix counts once (Near AI: First Project is one brand hit, not two)."
  - "Re-recording is one documented step: run the copy lint once with NEAR_AI_WRITE_BASELINE=1 (writes, then fails on purpose), review the diff, run again without it."
metrics:
  duration: ~55 min
  completed: 2026-11-20
actuals:
  tokens: 16000
  tasks: 3
  commits: 3
plan_head_before: 97a9bd229f899f1e0b8065c20260c3a57e76f5f4
plan_head_after: ba7ac6f1
---

# Phase 41 Plan 11: Copy lint with a recorded baseline Summary

One test reads every user copy source (package.json, show*Message, quick pick and input box calls, webview panel titles, exported text constants and message records, host-built HTML in services, page scripts and HTML under media outside media/vendor), counts seven rules per file, and fails on any count above the checked-in baseline; every rule has a planted hit, and mode words come from MODES at test time.

## What was built

- **copyLintScan.ts** (pure apart from reading files under the repository root, no vscode): the seven `COPY_RULES`; `extractCopy` per source kind; `GLOSSARY_WORDS` (glossary sections 1 to 3 plus the D-64 export-control words, each with the user word to suggest; the words left out as ordinary English are listed in a comment); `ALLOWED_CONTEXTS` (trust details pane, Tools page and its script, the label module `src/domain/gate/labels.ts` for CGP/ITAR/EAR, the rules page `policyEditor.ts` and `media/policy/policy.js` for the D-64 words); rule 2 from `modeWordsFromTable()` (multi-word `word` and `also` values of MODES plus `DISTINCTIVE_MODE_WORDS`); rule 3 brand spellings and title prefix; rule 5 the provider's name before organization; rule 6 a bare team; rule 7 `COMPLIANCE_CLAIMS` with the sentence-negation check and an empty `ALLOWED_CLAIM_CONTEXTS`; `compareWithBaseline`, `increaseMessage` (rule, file, what to use instead, moved counts move with their code), `checkTightness`, `baselineText`, `writeBaselineAndFail`.
- **copyLint.test.ts**: 28 tests: planted hits for every source kind and rule, allowed contexts on both sides, the table files checked to exist, the ratchet, the baseline format, the write mode, the tightness check in both modes, and the repository against its baseline.
- **copy-lint-baseline.json**: today's counts, 67 files.

## Re-recording the baseline (one step)

From the repository root, after `npm run compile`, inside the usual memory wrapper:

`NEAR_AI_WRITE_BASELINE=1 node scripts/run-tests.mjs dist/test/copyLint.test.js`

It writes `src/test/copy-lint-baseline.json` from the current scan and then fails on purpose ("baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE"). Review the diff, then run again without the flag. Per the plan, a new hit from 41-09 or 41-10 copy at the wave 3 merge is fixed in that copy with the glossary's user word; re-record only to move a count with code that moved or to drop counts a fix removed. 41-15 runs the file with `NEAR_AI_BASELINE_TIGHT=1`, which fails on any stale count (it passes today).

## Baseline totals (recorded at base 97a9bd22)

| Rule | Total | Top files |
|---|---|---|
| glossary | 187 | package.json 42, media/teams/teams.js 19, src/domain/gate/trustBadge.ts 12 |
| mode-word | 84 | src/domain/replica/rosterMembers.ts 19, src/domain/replica/roster.ts 18, src/staff/replica/membership.ts 13 |
| brand | 6 | src/services/onboarding.ts 5, src/services/cyberPanel.ts 1 |
| em-dash | 9 | media/chat/chat.js 5, media/teams/teams.js 2 |
| provider-organization | 0 | (planted hits only) |
| bare-team | 330 | media/teams/teams.js 184, package.json 21, media/staffRoom/staffRoom.js 16 |
| compliance-claim | 3 | src/domain/gate/routing.ts 2, src/domain/staff/obs/read.ts 1 |

Ten files with the most hits (all rules): media/teams/teams.js 205, package.json 66, src/domain/replica/rosterMembers.ts 23, src/domain/replica/roster.ts 21, media/staffRoom/staffRoom.js 16, src/services/onboarding.ts 15, src/services/teamUpdateCommands.ts 14, media/chat/chat.js 13, src/domain/replica/rosterCells.ts 13, src/staff/replica/membership.ts 13.

Most mode-word hits are "Roster" and "Staff lead" in the Phase 32 replica messages; those files were only read.

## Tests

- RED first, each task: Task 1 on the base did not compile (no `./helpers/copyLintScan`); Task 2 on the Task 1 code did not compile (no `extractCopy`, `copySourceFiles`); Task 3 on the Task 2 code did not compile (no `modeWordsFromTable`, `DISTINCTIVE_MODE_WORDS`, `COMPLIANCE_CLAIMS`, `ALLOWED_CLAIM_CONTEXTS`, `checkTightness`, `modeWords`/`claimContexts` options). After each implementation only the repository test failed until the baseline was re-recorded with the write mode.
- Task 1 verify: copyLint 6/6. Task 2: copyLint 20/20. Task 3: copyLint, orgModes and staffDoctrine 61/61, `npm run lint` exit 0. Also copyLint 28/28 with `NEAR_AI_BASELINE_TIGHT=1`.
- Acceptance greps: no em-dash in the three files; `"brand"` and `"bare-team"` present in the baseline; `NEAR_AI_BASELINE_TIGHT` in the test; `ALLOWED_CLAIM_CONTEXTS` and `trustDetails.ts` in the helper; no mode word spelled in the helper.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 - Bug] Names counted as copy**
- Found during: Task 2 and Task 3 review of the real hits. Page-script class lists ("room-process room-squads", "team-dot dot-${...}") and id strings in message records ("hub-revoked") were counted. Added `isNameList` (an id with a separator, or lower-case words beside such ids), with planted cases in the page-script and constants tests.
- Commits: 8de8ceff, ba7ac6f1.

**2. [Rule 2 - Correctness] Model instructions are not user copy**
- `TEAM_BUILDER_PROMPT`, `REFINE_PROMPT`, `ROLE_PROMPTS` and two benchmark prompts match the `*_PROMPT` constant pattern but are instructions to a model. They are listed in `MODEL_INSTRUCTIONS` with reasons; a test checks each is exported where the table says, so a rename cannot hide copy silently.
- Commit: 8de8ceff.

### Other choices (defaults taken)
- The wider source list and the plural matching in the frontmatter decisions.
- Host-built HTML is read only in src/services as the plan says; no other folder builds webview HTML today (src/staff/staffHost.ts and src/domain/replica/rosterView.ts only mention tags in comments or role patterns).
- The bare-team rule skips a qualifier joined by a hyphen too ("agent-team").

## Notes for the wave 3 merge

- The baseline was recorded at 97a9bd22. Copy 41-09 and 41-10 add can raise counts; run the copy lint once after merging. A new hit is fixed in that copy; only a count that moved with code is re-recorded (the one step above).
- Phase 32 files (src/domain/replica, src/staff/replica, src/services/staffMultiUserCommands.ts) are counted in the baseline; if the Phase 32 work changes their copy, their counts move with it.

## Known Stubs

None. `ALLOWED_CLAIM_CONTEXTS` starts empty on purpose (Phase 44 adds its compliance pages).

## Threat Flags

None beyond the plan's register. T-41-110: two-row proof-word context plus the Tools and rules page rows, each file checked to exist. T-41-111: the write mode always fails, tightness enforced with NEAR_AI_BASELINE_TIGHT=1. T-41-112: rule 5 planted in three spellings and both organization spellings. T-41-113: rule 7 planted, negated sentences and listed contexts only. T-41-SC: no package installed.

## Self-Check: PASSED

- Files: src/test/helpers/copyLintScan.ts, src/test/copyLint.test.ts, src/test/copy-lint-baseline.json present.
- Commits 38f65dee, 8de8ceff, ba7ac6f1 are ancestors of HEAD on feat/phase-41-11-copy-lint.
