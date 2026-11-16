---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 10
subsystem: gate
tags: [manifests, mcp, restrictive-default, stdio-label, declare-flow, mcp-page, tools-page]

requires:
  - phase: 70-09
    provides: "AgentTool.manifest required, mcpToolManifest (legacy), gateFixtures"
provides:
  - "McpServerConfig.manifest (optional): restrictive for a server saved for the first time, absent (legacy) for one configured before (GATE-03, D-06, D-38)"
  - "mcpToolDecision, mcpToolCapability, serverManifest, newServerManifest in src/mcp/tools.ts; every MCP agent tool's manifest and capability come from the server's manifest"
  - "McpRegistry.declareMcpToolEffects(server, tool, 'reads' | 'changes-remote' | 'unknown'), McpServerStatus.manifestWords and toolChoices"
  - "describeMcpTools and mcpToolChoiceOf in src/domain/gate/words.ts"
  - "MCP page: a 'What it does' menu per tool and the server's words; Tools page: each server's words"
  - "src/test/gateMcpManifests.test.ts (20 tests)"
affects: [70-11, 70-12]

actuals:
  tokens: 10940
  tasks: 2
  commits: 2
plan_head_before: 6711bd5b2d9af3ef5f2895ec3112ffcd16c65c9e
plan_head_after: 97f254714f93e643173e10e0dd635ee3697322aa

tech-stack:
  added: []
  patterns:
    - "A stored manifest is parsed again every time it is read; one that does not parse reads as the restrictive manifest, never as no manifest (a damaged settings file cannot widen a server)"
    - "The MCP capability stays two-valued (read or network) as before: read when the tool's effects are only the call on the server, network otherwise or when the server asks every call"
    - "A server's words are ordered: where it runs, what it can do, each declared tool by name sorted, when it may run, and always last the declaration sentence"

key-files:
  created:
    - src/test/gateMcpManifests.test.ts
  modified:
    - src/mcp/client.ts
    - src/mcp/tools.ts
    - src/services/mcpRegistry.ts
    - src/services/mcpView.ts
    - src/services/toolsDirectory.ts
    - src/domain/gate/words.ts
    - media/mcp/mcp.js
    - media/mcp/mcp.css
    - media/tools/tools.js
    - src/test/mcp.test.ts
    - src/test/toolsPage.test.ts

key-decisions:
  - "A server saved for the first time gets { runsOn: this-machine for stdio else remote, contexts: [interactive], tools: {}, toolDefaults: restrictive }. Editing keeps the stored manifest (the page's save message carries none); a legacy server stays legacy when edited. Moving a server from remote to a local command sets runsOn this-machine and contexts interactive only"
  - "The first declaration on a server with no manifest creates one with toolDefaults legacy, contexts from defaultMcpContexts(transport), so every tool the person did not declare keeps today's behaviour (D-38)"
  - "reads and changes-remote reuse mcpToolEffects(undefined, facts) with readOnly true or false, so the declared effects are exactly the legacy ones (the call on the server, plus the server's host without its port for changes-remote)"
  - "Only a tool the connected server lists, by exact name, can be declared. A server that is not connected refuses with 'Connect it to see its tools'; a name with a * is refused (it can never be matched, so it stays restrictive)"
  - "A server set to ask before every call is never quieter than network, even for a tool declared as only reading; the tool's own risky() hints are unchanged, so a tool whose hints say it changes data still asks after being declared as reading"
  - "No page control names another context for a stdio server (the plan asks only that the manifest can); the words say whether a manifest names one"

patterns-established:
  - "mcpToolCapability is the one place the settings layer's word for an MCP tool is computed; the agent tool and the Tools page both call it"

requirements-completed: [GATE-03]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 10: MCP manifests, restrictive for new servers, a declare flow and words on both pages Summary

**A server added from now on is stored with a restrictive manifest (undeclared tools may do anything but only while you are there, and a stdio server says "Runs on this machine with your permissions"), a server configured before has no manifest and behaves exactly as today, and the MCP page lets the person declare per tool whether it only reads or changes data on the server, with the words in a fixed order ending in the sentence that NEAR AI cannot check them.**

## Performance

- **Tasks:** 2 of 2 (Task 1 tracer, Task 2 auto)
- **Files:** 1 created, 11 modified (562 insertions, 18 deletions over the plan's commits)
- **Tracer gate:** the Task 1 verify command was green end to end before Task 2 started, so the tracer gate passed (auto-continue)

## Accomplishments

- `McpServerConfig.manifest`. `McpRegistry.save` stores the restrictive manifest only for an id it has not seen; it carries a stored manifest over an edit and leaves a legacy server without one.
- `mcpToolManifest` and the capability of every MCP agent tool now come from the server's manifest through `mcpToolEffects`: an undeclared tool of a restrictive server has `RESTRICTIVE_EFFECTS`, the shorthand network and the interactive context only; a legacy server decides exactly as before (tested for all three approval settings, both transports, a read-only and a changing tool).
- `McpServerStatus.manifestWords` (the words, ending with `MANIFEST_IS_A_CLAIM_TEXT`) and `toolChoices`; the Tools page directory carries `words` for each server and uses `mcpToolCapability`, so its status for an MCP tool agrees with the agent tool.
- `declareMcpToolEffects` and the `declare` message in `mcpView.ts` (checked: stored server id, tool name a non-empty string of at most 200 characters, one of three choices; then the registry checks the server lists that exact tool and parses the whole manifest again before storing).
- The MCP page (`media/mcp/mcp.js`) shows the words under each server and a "What it does" menu per tool, all with `textContent`; the declaration sentence sits beside the menu. The Tools page shows the same words.

## Task Commits

1. **Task 1 (tracer): restrictive for new servers, legacy for existing ones** - `6becfb1` feat(gate): MCP manifests, restrictive for new servers and legacy for existing ones
2. **Task 2: the declare flow and the words** - `97f2547` feat(gate): declare what each MCP tool does, in plain words

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Each run inside the cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c '...'`).

- Task 1 plan command plus toolsPage and gateManifestFormat (`npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateMcpManifests.test.js dist/test/mcp.test.js dist/test/gateManifests.test.js dist/test/toolsPage.test.js dist/test/gateManifestFormat.test.js`): tsc clean; 81 tests, 81 pass, 0 fail, 0 cancelled.
- Task 2 plan command plus gateManifests and gateManifestFormat (`... dist/test/gateMcpManifests.test.js dist/test/mcp.test.js dist/test/toolsPage.test.js dist/test/gateManifests.test.js dist/test/gateManifestFormat.test.js`): tsc clean; 94 tests, 94 pass, 0 fail, 0 cancelled.
- Wider batch of 109 compiled test files whose names match mcp, webview, media, css, page, tool, gate, a11y, access, layout, team, knowledge, cyber, agent, approval, permission, loop, steer, doc, word, plain, dash, style or csp: 1457 tests, 1455 pass, 0 fail, 0 cancelled, 2 skipped (the existing ripgrep-not-installed skips).
- Acceptance: `grep -c "declare" src/services/mcpView.ts` is 2 and the case validates the server (`!known`), the tool name and the choice before calling the registry; the full `npm test` is not run here (PR boundary); e2e not run (the plan does not call for it).

## Deviations from Plan

**1. [Rule 3 - Blocking] `mcp.test.ts` fixture (two lines added, no assertion changed)**
- **Found during:** Task 1. `registryWithServer` creates its server through `registry.save`, which now stores a restrictive manifest, so `lookup_part` would no longer be a read and the existing "legacy servers ask, run read-only tools silently" assertions would fail.
- **Fix:** after saving, the fixture sets the stored config back to one with no manifest (a server configured before manifests existed, D-38), with a comment. Every assertion is as it was; all of them pass.
- **Commit:** 6becfb1

**2. [Rule 3 - Blocking] `toolsPage.test.ts` fixture** gained `manifestWords: [], toolChoices: {}` because `McpServerStatus` has two new required fields. No assertion changed.
- **Commit:** 6becfb1

**3. [Rule 2 - Missing critical] Files outside the plan's list.** `src/domain/gate/words.ts` (new `describeMcpTools` and `mcpToolChoiceOf`, existing functions untouched, so the per-tool lines sit in one place beside the other words), `src/services/toolsDirectory.ts` and `media/tools/tools.js` (the plan says the Tools page shows the words and its status must keep agreeing with the agent tool), `media/mcp/mcp.css` (a few lines so the words and menu do not overflow a narrow panel), `src/test/toolsPage.test.ts` (above).
- **Commit:** 6becfb1 and 97f2547

**4. [Rule 1 - Bug avoided] Capability of a declared tool.** `shorthandFor` of an effects list holding only an `mcp` effect is `network` (the vocabulary counts `mcp` as outward), but the plan says a tool declared as only reading has the shorthand read. `mcpToolCapability` therefore returns `read` when a tool's effects are only the call on the server and `network` otherwise, as the legacy split already did. `McpToolEffects.shorthand` from `mcpToolEffects` (plan 05) is unchanged and still says `network` for such a tool; plan 12 must decide from effects, not from that field, for a declared MCP tool.
- **Commit:** 6becfb1

**5. A server set to ask before every call stays at `network` for a declared-reading tool** (not in the plan; it keeps what "ask before every call" means).

**Total deviations:** 5 (2 blocking fixture edits, 1 missing-critical file additions, 1 bug avoided, 1 note). **Impact:** no existing decision, status or setting changed for a server configured before this plan.

## Assertions changed on purpose

None. `mcp.test.ts` and `toolsPage.test.ts` have fixture lines added (deviations 1 and 2); every assertion in both is unchanged and passes.

## Decisions Made

See key-decisions. Left for later plans: the gate itself (plan 12) must refuse a tool outside its manifest's contexts and an MCP tool outside the interactive context unless the server is named in `ceiling.unattendedMcp`; nothing here enforces that yet, it only records it in the manifest and the words. There is no page control to name another context for a stdio server; a manifest can name one (the words then say "Can also run when nobody is watching"), and a bundle or a later plan can add the control.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None.

## Threat Flags

None new. T-70-30 (undeclared tool of a new server running quietly or unattended): restrictive effects, shorthand network and interactive only, asserted for stdio and http. T-70-31 (crafted declare message or manifest): the message is validated in `mcpView.ts`, the registry refuses a tool the server does not list, a `*` name, a bad choice and a server that is not connected, the whole manifest is parsed again before storing, and a stored manifest that does not parse reads as the restrictive one. T-70-32 (server text in the page): `textContent` only, with a source check on `mcp.js` and `tools.js` for `innerHTML` and its relatives. T-70-SC: no package added.

## Next Phase Readiness

Plan 11 and plan 12 can read `tool.manifest` of an MCP tool with the server's declared effects, contexts and `untrusted: true`. The status object carries `manifestWords`; the stored manifest is `McpServerConfig.manifest` and `serverManifest(config)` (in `src/mcp/tools.ts`) gives the parsed, fail-closed one.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/test/gateMcpManifests.test.ts
- FOUND commits: 6becfb1, 97f2547 (ancestors of HEAD)
