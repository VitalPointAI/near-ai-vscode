---
schema_version: 1
open_count: 11
waived_count: 0
fixed_count: 0
total_count: 11
last_updated: 2026-10-26T04:53:31.061Z
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
  }
]
````
