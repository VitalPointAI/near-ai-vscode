---
schema_version: 1
open_count: 17
waived_count: 2
fixed_count: 7
total_count: 26
last_updated: 2026-11-05T04:05:17.121Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03 | stub | src/services/chat.ts | 133 | Composer input hint is intentional form guidance, not a missing implementation or data source. | open |  | 2026-10-25T21:24:32.938Z |  |
| 2 | 03 | stub | src/services/chat.ts | 133 | The composer retains an intentional input hint; this is native form guidance, not a missing data source. | open |  | 2026-10-25T21:30:51.100Z |  |
| 3 | 03 | stub | src/services/chat.ts | 163 | Intentional native input placeholder guidance in the retained chat HTML helper. | open |  | 2026-10-25T21:44:17.813Z |  |
| 4 | 03 | unrun-verify | src/services/chat.ts | 183 | Interactive VS Code extension-host smoke verification of command progress and artifact opening remains unavailable. | open |  | 2026-10-25T21:44:18.493Z |  |
| 5 | 05 | stub | src/services/chat.ts | 300 | Fail-closed wallet panel is intentionally unavailable until official NEAR AI staking configuration and callback contract are verified. | open |  | 2026-10-26T02:18:22.851Z |  |
| 6 | 05 | unrun-verify | src/services/chat.ts | 300 | Interactive VS Code wallet callback smoke verification is unavailable because no official callback contract is supplied. | open |  | 2026-10-26T02:18:23.507Z |  |
| 7 | 06 | unrun-verify | package.json |  | Full npm test and npm run package were not rerun after focused green verification per user instruction. | open |  | 2026-10-26T03:54:13.516Z |  |
| 8 | 06 | unrun-verify | .planning/phases/06-team-studio-and-multimodal-agent-skills/06-05-SUMMARY.md |  | npm run package was not rerun after final focused graph changes per user request. | open |  | 2026-10-26T04:09:14.720Z |  |
| 9 | 06 | unrun-verify | package.json |  | Full npm test and npm run package were not run after Plan 06 focused green verification per user instruction. | open |  | 2026-10-26T04:28:46.450Z |  |
| 10 | 06 | unrun-verify | .planning/phases/06-team-studio-and-multimodal-agent-skills/06-07-PLAN.md |  | Full npm run package gate was not run; requested lint and focused tests passed. | open |  | 2026-10-26T04:42:04.856Z |  |
| 11 | 06 | unrun-verify | .planning/phases/06-team-studio-and-multimodal-agent-skills/06-08-PLAN.md |  | Full npm run package verification was not run; requested lint, compile, and focused multimodal/chat suites passed. | open |  | 2026-10-26T04:53:31.061Z |  |
| 12 | 62 | stub | src/services/team/boardView.ts | 25 | BOARD_SCRIPTS and BOARD_STYLES name media/board files that plans 62-09 to 62-13 create; until then the board page loads empty | open |  | 2026-11-02T20:08:58.850Z |  |
| 13 | 61 | stub | src/services/team/memberCommands.ts | 646 | Join: one interim sentence for every not-ready catch-up reason; 61-20 gives each reason its own sentence and button | fixed |  | 2026-11-03T22:09:39.300Z | 2026-11-03T23:02:54.367Z |
| 14 | 62 | deviation | src/test/e2e/suite.ts |  | 62-21: the first planless phase (phase:63) is not on the first screen; 62-19 orders a column by phase then plan, so it is reachable by scrolling the board only. Owner or 62-22/62-24 to decide: planless phases first, compact cards, or accept | open |  | 2026-11-04T04:15:22.916Z |  |
| 15 | 62.1 | stub | src/domain/team/timeline.ts | 227 | Dot label is the card's a11yLabel placeholder until 62.1-02 writes the timeline sentence | fixed |  | 2026-11-04T22:53:03.099Z | 2026-11-04T23:11:58.978Z |
| 16 | 62.1 | stub | src/domain/team/timeline.ts | 23 | BoardTimeline.now and the percent fields are declared but not filled until 62.1-02 (D-13, D-14) | fixed |  | 2026-11-04T22:53:03.223Z | 2026-11-04T23:11:59.103Z |
| 17 | 62.1 | stub | media/board/timeline.js | 366 | The timeline view draws only the screen reader lists (milestones, phases, dots) with no canvas, positions or visible marks until 62.1-04 draws them from NearAiTimeline.geometry | fixed |  | 2026-11-04T23:41:15.609Z | 2026-11-05T00:45:24.778Z |
| 18 | 62.1 | stub | media/board/timeline.js | 350 | Folded finished milestones still list every dot and have no tile button in the page until 62.1-04 (the geometry already folds them) | fixed |  | 2026-11-04T23:41:15.742Z | 2026-11-05T00:45:24.903Z |
| 19 | 62.1 | stub | media/board/board.js | 565 | In Timeline a filter that matches nothing shows the board's filtered state in place of the timeline, not the opaque band over ghost dots, until 62.1-04 | fixed |  | 2026-11-04T23:41:15.871Z | 2026-11-05T00:45:25.032Z |
| 20 | 62.1 | stub | media/board/timeline.js | 440 | Zoom out, Zoom in, Fit milestone and Jump to now are drawn and follow the saved zoom, but do nothing when pressed until 62.1-06 wires them | fixed |  | 2026-11-05T00:45:25.161Z | 2026-11-05T02:06:04.481Z |
| 21 | 62.1 | deviation | media/board/board.js | 1226 | 62.1-08: crossing the 520 px breakpoint, board.js redraws inside its ResizeObserver callback and Chromium reports a ResizeObserver loop notice as a page error (pre-existing since 62-21, seen by 62-23); the timeline e2e logs it in its narrow step rather than failing on it | open |  | 2026-11-05T03:15:45.357Z |  |
| 22 | 62.1 | deviation | src/test/e2e/timelineSuite.ts |  | 62.1-08: this roadmap's Now step holds phase:63, a phase without plans that the board cannot mark done, so the teammate step reopens the latest done plan before it (the Now marker moves back) instead of finishing the Now step; owner to confirm, or let a planless phase be marked done | waived | Owner accepted on 2026-11-05 (relayed by the orchestrator): the teammate step reopens plan:62-27 so the Now marker moves back, and planless phases stay unmarkable as done | 2026-11-05T03:15:45.489Z | 2026-11-05T04:04:58.343Z |
| 23 | 62.1 | deviation | media/board/layout-probe.js |  | 62.1-08 (4c6c710): probe rule 12 does not judge a percent inside a milestone header held at the scroller edge against the dots that header hides (rule 1's held-header reading); the preview and the card are still judged against every percent | waived | Owner accepted on 2026-11-05 (relayed by the orchestrator): the rule 12 held-header reading of 4c6c710 stays | 2026-11-05T04:05:03.450Z | 2026-11-05T04:05:07.702Z |
| 24 | 62.1 | deviation | src/test/e2e/run.ts |  | 62.1-09: a timeline run without NEAR_AI_E2E_TIMELINE_PART empties .vscode-test/screens-timeline (62.1-08 design), so the full e2e removes the review frames; the 62.1-09 gate restored them from a copy. Run the two screenshot parts again after any full e2e, or keep frames when no part is given | open |  | 2026-11-05T04:05:07.866Z |  |
| 25 | 62.1 | deviation | media/board/board.css | 333 | 62.1-09: done dots use var(--vscode-charts-green, var(--vscode-testing-iconPassed)) instead of the UI-SPEC's testing.iconPassed, which is 2.0 to 1 on the light theme's canvas (probe rule 9 asks 3 to 1); owner to confirm the colour in the light and dark frames | open |  | 2026-11-05T04:05:16.961Z |  |
| 26 | 62.1 | deviation | media/board/timeline.js |  | 62.1-09: under 520 px, when no side is clear at the full view width (the Now dot between the Now pill and the rail's phase labels), the preview and the card go below or above from the dot's left edge to the view's right edge instead of the UI-SPEC's full view width; owner to confirm in the 480 px frames | open |  | 2026-11-05T04:05:17.121Z |  |

````json
[
  {
    "id": 1,
    "kind": "stub",
    "phase": "03",
    "file": "src/services/chat.ts",
    "line": 133,
    "description": "Composer input hint is intentional form guidance, not a missing implementation or data source.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-25T21:24:32.938Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 2,
    "kind": "stub",
    "phase": "03",
    "file": "src/services/chat.ts",
    "line": 133,
    "description": "The composer retains an intentional input hint; this is native form guidance, not a missing data source.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-25T21:30:51.100Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 3,
    "kind": "stub",
    "phase": "03",
    "file": "src/services/chat.ts",
    "line": 163,
    "description": "Intentional native input placeholder guidance in the retained chat HTML helper.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-25T21:44:17.813Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 4,
    "kind": "unrun-verify",
    "phase": "03",
    "file": "src/services/chat.ts",
    "line": 183,
    "description": "Interactive VS Code extension-host smoke verification of command progress and artifact opening remains unavailable.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-25T21:44:18.493Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 5,
    "kind": "stub",
    "phase": "05",
    "file": "src/services/chat.ts",
    "line": 300,
    "description": "Fail-closed wallet panel is intentionally unavailable until official NEAR AI staking configuration and callback contract are verified.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T02:18:22.851Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 6,
    "kind": "unrun-verify",
    "phase": "05",
    "file": "src/services/chat.ts",
    "line": 300,
    "description": "Interactive VS Code wallet callback smoke verification is unavailable because no official callback contract is supplied.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T02:18:23.507Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 7,
    "kind": "unrun-verify",
    "phase": "06",
    "file": "package.json",
    "line": null,
    "description": "Full npm test and npm run package were not rerun after focused green verification per user instruction.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T03:54:13.516Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 8,
    "kind": "unrun-verify",
    "phase": "06",
    "file": ".planning/phases/06-team-studio-and-multimodal-agent-skills/06-05-SUMMARY.md",
    "line": null,
    "description": "npm run package was not rerun after final focused graph changes per user request.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T04:09:14.720Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 9,
    "kind": "unrun-verify",
    "phase": "06",
    "file": "package.json",
    "line": null,
    "description": "Full npm test and npm run package were not run after Plan 06 focused green verification per user instruction.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T04:28:46.450Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 10,
    "kind": "unrun-verify",
    "phase": "06",
    "file": ".planning/phases/06-team-studio-and-multimodal-agent-skills/06-07-PLAN.md",
    "line": null,
    "description": "Full npm run package gate was not run; requested lint and focused tests passed.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T04:42:04.856Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 11,
    "kind": "unrun-verify",
    "phase": "06",
    "file": ".planning/phases/06-team-studio-and-multimodal-agent-skills/06-08-PLAN.md",
    "line": null,
    "description": "Full npm run package verification was not run; requested lint, compile, and focused multimodal/chat suites passed.",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-10-26T04:53:31.061Z",
    "resolved_at": null,
    "milestone": null
  },
  {
    "id": 12,
    "kind": "stub",
    "phase": "62",
    "file": "src/services/team/boardView.ts",
    "line": 25,
    "description": "BOARD_SCRIPTS and BOARD_STYLES name media/board files that plans 62-09 to 62-13 create; until then the board page loads empty",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-02T20:08:58.850Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  },
  {
    "id": 13,
    "kind": "stub",
    "phase": "61",
    "file": "src/services/team/memberCommands.ts",
    "line": 646,
    "description": "Join: one interim sentence for every not-ready catch-up reason; 61-20 gives each reason its own sentence and button",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-03T22:09:39.300Z",
    "resolved_at": "2026-11-03T23:02:54.367Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 14,
    "kind": "deviation",
    "phase": "62",
    "file": "src/test/e2e/suite.ts",
    "line": null,
    "description": "62-21: the first planless phase (phase:63) is not on the first screen; 62-19 orders a column by phase then plan, so it is reachable by scrolling the board only. Owner or 62-22/62-24 to decide: planless phases first, compact cards, or accept",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-04T04:15:22.916Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  },
  {
    "id": 15,
    "kind": "stub",
    "phase": "62.1",
    "file": "src/domain/team/timeline.ts",
    "line": 227,
    "description": "Dot label is the card's a11yLabel placeholder until 62.1-02 writes the timeline sentence",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-04T22:53:03.099Z",
    "resolved_at": "2026-11-04T23:11:58.978Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 16,
    "kind": "stub",
    "phase": "62.1",
    "file": "src/domain/team/timeline.ts",
    "line": 23,
    "description": "BoardTimeline.now and the percent fields are declared but not filled until 62.1-02 (D-13, D-14)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-04T22:53:03.223Z",
    "resolved_at": "2026-11-04T23:11:59.103Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 17,
    "kind": "stub",
    "phase": "62.1",
    "file": "media/board/timeline.js",
    "line": 366,
    "description": "The timeline view draws only the screen reader lists (milestones, phases, dots) with no canvas, positions or visible marks until 62.1-04 draws them from NearAiTimeline.geometry",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-04T23:41:15.609Z",
    "resolved_at": "2026-11-05T00:45:24.778Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 18,
    "kind": "stub",
    "phase": "62.1",
    "file": "media/board/timeline.js",
    "line": 350,
    "description": "Folded finished milestones still list every dot and have no tile button in the page until 62.1-04 (the geometry already folds them)",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-04T23:41:15.742Z",
    "resolved_at": "2026-11-05T00:45:24.903Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 19,
    "kind": "stub",
    "phase": "62.1",
    "file": "media/board/board.js",
    "line": 565,
    "description": "In Timeline a filter that matches nothing shows the board's filtered state in place of the timeline, not the opaque band over ghost dots, until 62.1-04",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-04T23:41:15.871Z",
    "resolved_at": "2026-11-05T00:45:25.032Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 20,
    "kind": "stub",
    "phase": "62.1",
    "file": "media/board/timeline.js",
    "line": 440,
    "description": "Zoom out, Zoom in, Fit milestone and Jump to now are drawn and follow the saved zoom, but do nothing when pressed until 62.1-06 wires them",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-11-05T00:45:25.161Z",
    "resolved_at": "2026-11-05T02:06:04.481Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 21,
    "kind": "deviation",
    "phase": "62.1",
    "file": "media/board/board.js",
    "line": 1226,
    "description": "62.1-08: crossing the 520 px breakpoint, board.js redraws inside its ResizeObserver callback and Chromium reports a ResizeObserver loop notice as a page error (pre-existing since 62-21, seen by 62-23); the timeline e2e logs it in its narrow step rather than failing on it",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-05T03:15:45.357Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  },
  {
    "id": 22,
    "kind": "deviation",
    "phase": "62.1",
    "file": "src/test/e2e/timelineSuite.ts",
    "line": null,
    "description": "62.1-08: this roadmap's Now step holds phase:63, a phase without plans that the board cannot mark done, so the teammate step reopens the latest done plan before it (the Now marker moves back) instead of finishing the Now step; owner to confirm, or let a planless phase be marked done",
    "status": "waived",
    "reason": "Owner accepted on 2026-11-05 (relayed by the orchestrator): the teammate step reopens plan:62-27 so the Now marker moves back, and planless phases stay unmarkable as done",
    "recorded_at": "2026-11-05T03:15:45.489Z",
    "resolved_at": "2026-11-05T04:04:58.343Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 23,
    "kind": "deviation",
    "phase": "62.1",
    "file": "media/board/layout-probe.js",
    "line": null,
    "description": "62.1-08 (4c6c710): probe rule 12 does not judge a percent inside a milestone header held at the scroller edge against the dots that header hides (rule 1's held-header reading); the preview and the card are still judged against every percent",
    "status": "waived",
    "reason": "Owner accepted on 2026-11-05 (relayed by the orchestrator): the rule 12 held-header reading of 4c6c710 stays",
    "recorded_at": "2026-11-05T04:05:03.450Z",
    "resolved_at": "2026-11-05T04:05:07.702Z",
    "milestone": "v0.6.0"
  },
  {
    "id": 24,
    "kind": "deviation",
    "phase": "62.1",
    "file": "src/test/e2e/run.ts",
    "line": null,
    "description": "62.1-09: a timeline run without NEAR_AI_E2E_TIMELINE_PART empties .vscode-test/screens-timeline (62.1-08 design), so the full e2e removes the review frames; the 62.1-09 gate restored them from a copy. Run the two screenshot parts again after any full e2e, or keep frames when no part is given",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-05T04:05:07.866Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  },
  {
    "id": 25,
    "kind": "deviation",
    "phase": "62.1",
    "file": "media/board/board.css",
    "line": 333,
    "description": "62.1-09: done dots use var(--vscode-charts-green, var(--vscode-testing-iconPassed)) instead of the UI-SPEC's testing.iconPassed, which is 2.0 to 1 on the light theme's canvas (probe rule 9 asks 3 to 1); owner to confirm the colour in the light and dark frames",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-05T04:05:16.961Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  },
  {
    "id": 26,
    "kind": "deviation",
    "phase": "62.1",
    "file": "media/board/timeline.js",
    "line": null,
    "description": "62.1-09: under 520 px, when no side is clear at the full view width (the Now dot between the Now pill and the rail's phase labels), the preview and the card go below or above from the dot's left edge to the view's right edge instead of the UI-SPEC's full view width; owner to confirm in the 480 px frames",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-11-05T04:05:17.121Z",
    "resolved_at": null,
    "milestone": "v0.6.0"
  }
]
````
