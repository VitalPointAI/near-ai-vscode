---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 09
subsystem: gate
tags: [manifests, tool-catalog, mcp, team-studio, required-field]

requires:
  - phase: 70-08
    provides: "AgentTool.manifest (optional), manifestInput, declareManifest, builtInTools (22), SHORTHAND_EXCEPTIONS, gateManifests"
provides:
  - "All 40 built-in tools declare a manifest next to their own definition (gsd 5, cyber probes 9, cyber exploit 2, TeamKnowledge, Learn added here)"
  - "Every MCP agent tool carries a legacy manifest from mcpToolManifest (mcpToolEffects, D-38), runsOn remote for http servers"
  - "AgentTool.manifest is required: a tool without one does not compile (GATE-02, D-05)"
  - "builtInTools() returns all 40 in the toolsFor order; CATALOG_TOOL_FILES, TOOL_DEFINING_FILES, OFFERED_ONLY_IN_CONTEXT, GSD_TOOL_NAMES"
  - "Team member cards show each tool's manifest words (StudioTool.words, DirectoryTool.words) (GATE-03, D-07)"
  - "src/test/helpers/gateFixtures.ts: testManifest, testTool, fakeHome"
affects: [70-10, 70-11, 70-12]

actuals:
  tokens: 10395
  tasks: 3
  commits: 3
plan_head_before: ba5faa28eb77bdc28067af81da4501f88820ef62
plan_head_after: 9b5468e4ad4f79cd1b96ded2ad4bc387d1ac4264

tech-stack:
  added: []
  patterns:
    - "A tool that takes a target the manifest cannot read as written gets a manifestInput that writes the default or the normal form out (Agent: general-purpose; exploit tools: a bare host gets a scheme; file probes: no folder means **)"
    - "A test asks the real AgentConversation.toolsFor for its tools and compares names and order with the catalog, so a tool added to a run but not to the catalog fails"
    - "A source scan lists every file that mentions AgentTool< (CATALOG_TOOL_FILES); a new tool file fails until it is catalogued"

key-files:
  created:
    - src/test/helpers/gateFixtures.ts
  modified:
    - src/gsd/tools.ts
    - src/agent/cyberProbes.ts
    - src/agent/cyberExploitTools.ts
    - src/agent/knowledgeTools.ts
    - src/mcp/tools.ts
    - src/agent/tools.ts
    - src/agent/toolCatalog.ts
    - src/services/toolsDirectory.ts
    - src/services/teamStudioPage.ts
    - media/teams/teams.js
    - src/test/gateManifests.test.ts
    - src/test/cyberRun.test.ts
    - src/test/steering.test.ts

key-decisions:
  - "The Tools page and the team studio's pickers keep listing the tools every run has (27 entries: the 22 from plan 08 and the 5 gsd tools). The cyber probes, exploit steps, TeamKnowledge and Learn are in the catalog but left off both (OFFERED_ONLY_IN_CONTEXT), so no page status changes and the studio does not start or stop warning about tools it did or did not know. Showing them is a one-line change in toolsDirectory if the owner wants them listed"
  - "A cyber probe's manifest reads the argument as the probe parses it (trimmed url, hostname, host; root defaults to ** when blank). The six network probes are named shorthand exceptions (capability read, manifest network)"
  - "The exploit tools' target is 'a host or a URL'; manifestInput gives a bare host a scheme so one `url-host` source reads both. A target that is neither is refused when effects are filled"
  - "MCP legacy manifests: effects, contexts and hosts come from mcpToolEffects(undefined, facts) with the same facts capability is computed from; a name the format cannot hold (a `*`, over 128 characters) gets the restrictive effects and interactive only, so a server still connects. runsOn is remote for http and this-machine for stdio"
  - "Learn declares skill.write{scope: team} (its shorthand sharedWrite agrees); TeamKnowledge, Skill, SlashCommand and AskUserQuestion declare plan, per the plan's adjustment"

patterns-established:
  - "declareManifest takes an optional runsOn so a remote MCP tool says so in its words"

requirements-completed: [GATE-02, GATE-03]

duration: 12 min
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 09: Manifests on every built-in and MCP tool, required field, member card words Summary

**All 40 built-in tools and every MCP tool now declare what they can do, `AgentTool.manifest` is a required field so a tool without one does not compile, the catalog holds the whole set in the order a run is given it (checked against the real `toolsFor`), and a team member's tool list shows each tool's manifest words.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-11-16T18:22Z
- **Completed:** 2026-11-16T18:34Z
- **Tasks:** 3 of 3
- **Files:** 1 created, 13 modified (487 insertions, 29 deletions over the plan's commits)
- **`builtInTools().length`:** 40, in this order: Read, Write, Edit, Glob, Grep, Bash, BashOutput, KillShell, TodoWrite, WebFetch, WebSearch, CheckCitations, CheckOriginality, VectorizeImage, RenderSvg, CreatePresentation, CreatePdf, CreateDocument, GenerateImage, SecurityScan, nine Cyber probes (Http, Tls, Dns, Tcp, Robots, Secrets, Iac, Dependency, Fingerprint), CyberExploitTool, CyberPostExploitTool, TeamKnowledge, Learn, Remember, Recall, Skill, SlashCommand, AskUserQuestion, Agent, Task

## Accomplishments

- gsd tools: Skill, SlashCommand and AskUserQuestion declare `plan` (AskUserQuestion interactive only); Agent and Task declare `spawn` of the agent the call names, with a written-out `general-purpose` when none is named and a refusal for a name the format cannot hold.
- Cyber: the nine probes and two exploit steps declare the target they connect to (`network`) or the folder they read, interactive only; the six network probes are named shorthand exceptions with reasons. TeamKnowledge (`plan`, exception) and Learn (`skill.write` team, agrees with `sharedWrite`).
- MCP: `mcpToolManifest` builds each tool's legacy manifest from the same facts its `capability` comes from; a test proves `capability` equals the legacy shorthand for every approval setting and both transports.
- Member cards: `DirectoryTool.words` and `StudioTool.words` carry the manifest sentences; `media/teams/teams.js` shows them beside each tool.
- `manifest` is required on `AgentTool`; `gateFixtures.ts` supplies `testManifest`, `testTool`, `fakeHome`.
- Tests: `gateManifests` is now 27 tests (was 13): 40 tools in order and once each, a real `toolsFor` run compared with the catalog, the source scan, deep-frozen manifests that throw when mutated, cyber/knowledge/gsd effects, MCP legacy manifests including the restrictive fallback, member card words, the fixtures.

## Task Commits

1. **Task 1 (tracer): gsd tool manifests and their words on team member cards** - `ad98bfc` (feat)
2. **Task 2: manifests on the cyber, knowledge and MCP tools, catalog holds all 40** - `2c3bbe7` (feat)
3. **Task 3: make the manifest required, fixtures, catalog and source scans** - `9b5468e` (feat)

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Each run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Task 1 plan command (`tsc` + gateManifests, teamStudioPage, toolsPage): tsc clean; 61 tests, 61 pass, 0 fail, 0 cancelled.
- Task 2 plan command (gateManifests, mcp, knowledgeTools, cyberRun, toolsPage; I added teamStudioPage): 96 tests, 96 pass, 0 fail.
- Task 3 plan command (gateManifests, autoApproval, approvalStalls, cyberRun, steering, mcp, agentLoop, toolsPage, teamBoundaries): tsc clean; 142 tests, 142 pass, 0 fail, 0 cancelled.
- Wider batch of 95 test files whose names match cyber, gate, tool, team, knowledge, mcp, agent, steer, approval, permission, loop, webview or teams: 1288 tests, 1286 pass, 0 fail, 0 cancelled, 2 skipped (existing ripgrep-not-installed skips).
- Acceptance: `grep -n "manifest?:" src/agent/tools.ts` prints nothing; `grep -c "  manifest: ToolManifest" src/agent/tools.ts` prints 1.
- The full `npm test` is not run here; it belongs to the PR boundary.

## Deviations from Plan

**1. [Rule 3 - Blocking] The Tools page took the gsd tools from a second place**
- **Found during:** Task 1. With the gsd tools in the catalog, `buildToolsDirectory` would have listed them twice (it appended `gsdTools(...)` after the catalog).
- **Fix:** `toolsDirectory.ts` (not in the plan's file list) now takes every tool from the catalog and applies the "Offered once Open-GSD is installed" note by name (`GSD_TOOL_NAMES`). The page's contents and order are unchanged.
- **Commit:** ad98bfc

**2. [Rule 3 - Blocking] The page and the studio would have gained 13 tools**
- **Found during:** Task 2. The catalog now holds the cyber, TeamKnowledge and Learn tools. Listing them on the Tools page would add entries with statuses the plan says not to change, and `reviewDraft` would stop warning that a member's `TeamKnowledge` is "not a built-in tool" (an existing behaviour).
- **Fix:** `OFFERED_ONLY_IN_CONTEXT` in `toolCatalog.ts` names them and `toolsDirectory.ts` leaves them off the page, as before. See key-decisions.
- **Commit:** 2c3bbe7

**3. [Rule 2 - Missing critical] `manifestInput` for Agent, the exploit tools and the file probes**
- A call with no `subagent_type` starts general-purpose, an exploit `target` may be a bare host, and a blank probe `root` means the engagement's own folder. A manifest cannot say "or the default" (the 70-08 finding), so each tool writes the normal form out (`manifestInput`), as 70-08's Glob and Grep do. Without it a valid call would have been refused once the gate enforces.
- **Commit:** ad98bfc, 2c3bbe7

**4. `declareManifest` gained an optional `runsOn`** so an http MCP tool says "Runs on another machine". Built-in tools are unchanged (default `this-machine`).
- **Commit:** 2c3bbe7

**5. Fixture additions: fewer than the plan expected.** `tsc` listed one inline tool without a manifest (`cyberRun.test.ts`), plus `steering.test.ts` builds one cast `as never` (invisible to `tsc`, added by hand). `autoApproval`, `approvalStalls` and `mcp` build no inline tools (mcp uses the real `mcpAgentTools`), so they needed no edit.

**Total deviations:** 5 (2 blocking, 1 missing-critical, 2 notes). **Impact:** no decision, status or setting changed.

## Assertions changed on purpose

All in `src/test/gateManifests.test.ts`, the file plan 08 created, because they hard-coded a catalog of 22 that this plan grows to 40. No assertion in any other existing test changed.

1. `EXPECTED_ORDER` now lists all 40 tools in the `toolsFor` order (it listed 22).
2. The test "the catalog holds the 22 built-in tools... and the page lists them in that order" became "the catalog holds all 40... and the page lists the ones every run has in that order" (the page list is the 40 minus `OFFERED_ONLY_IN_CONTEXT`, i.e. the same 27 entries as before).
3. The unattended test now also excludes `AskUserQuestion`, `Learn` and the cyber tools (interactive only); the 22 original tools' contexts are unchanged.
4. The "page carries the words after today's notes" loop skips the 13 tools the page does not list (and asserts they are absent).

`steering.test.ts` changed one line: the inline tool gained `manifest: testManifest('Read', 'read')` (the line is shown as removed and added because it is a single-line object); `cyberRun.test.ts` the same on its one tool. Neither assertion changed.

## Decisions Made

See key-decisions. Left for later plans: plan 12 passes the model's raw arguments through `tool.manifestInput?.(raw) ?? raw` before `effectsFor` (the exploit tools' `targetAsUrl` and the probes' trimming depend on it); the cyber tools' `hosts` field is empty because the hosts are the engagement's and come from the call.

## Issues Encountered

None. The full-run test of `toolsFor` passed first time (the catalog order already matched).

## Known Stubs

None. The catalog builds the cyber, knowledge and gsd tools with stand-ins that are never run (`unavailable()` throws if one is called); the Tools page does not list the cyber and knowledge ones.

## Threat Flags

None new. T-70-27 (a tool without a manifest) is closed three ways: the required field, the 40-tool catalog compared with a real `toolsFor`, and the `AgentTool<` source scan. T-70-28 (a manifest changed at run time): the deep freeze is asserted for every tool and a mutation throws. T-70-SC: no package added.

## Next Phase Readiness

Plan 10 onward can read `tool.manifest` on every tool, built-in or MCP, without a null check. Plan 12's gate must apply `manifestInput` to the raw arguments, as noted above.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/test/helpers/gateFixtures.ts
- FOUND commits: ad98bfc, 2c3bbe7, 9b5468e (ancestors of HEAD)
