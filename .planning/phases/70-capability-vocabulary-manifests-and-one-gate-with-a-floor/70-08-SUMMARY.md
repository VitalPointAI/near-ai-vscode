---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 08
subsystem: gate
tags: [manifests, tool-catalog, tools-page, shorthand-exceptions]

requires:
  - phase: 70-05
    provides: "ToolManifest, parseToolManifest, effectsFor, shorthandFor, describeManifest"
provides:
  - "AgentTool.manifest (optional until plan 09) and AgentTool.manifestInput, with declareManifest, fromArgument, withDefaultPath, INTERACTIVE_AND_UNATTENDED and INTERACTIVE_ONLY in src/agent/tools.ts (GATE-02, D-05)"
  - "22 built-in tools declaring a manifest next to their own definition"
  - "src/agent/toolCatalog.ts: builtInTools(stubs), SHORTHAND_EXCEPTIONS, CatalogStubs"
  - "Tools page lists the catalog and adds each tool's manifest words after today's notes (GATE-03, D-07)"
  - "src/test/gateManifests.test.ts (13 tests), data-driven over builtInTools()"
affects: [70-09, 70-12]

actuals:
  tokens: 8540
  tasks: 2
  commits: 2
plan_head_before: cbe4ef35be491e76bc108014454709dde85144eb
plan_head_after: f8b1ec469be73edf5fb8129177e3910ae5e6aa73

tech-stack:
  added: []
  patterns:
    - "A tool's manifest is declared next to the tool through declareManifest, which runs the same parser a bundle uses, so an invalid declaration stops the extension loading rather than failing a call"
    - "A manifest names the arguments the model sends (file_path, output_path), not the parsed fields; a test checks every named field is in the tool's parameters"
    - "A tool whose shorthand and manifest differ is named in SHORTHAND_EXCEPTIONS with a reason; the test also fails if an exception no longer differs"

key-files:
  created:
    - src/agent/toolCatalog.ts
    - src/test/gateManifests.test.ts
  modified:
    - src/agent/tools.ts
    - src/agent/webTools.ts
    - src/agent/webSearch.ts
    - src/agent/graphicsTools.ts
    - src/agent/extraTools.ts
    - src/agent/securityTool.ts
    - src/services/toolsDirectory.ts
    - src/services/toolsPage.ts
    - src/services/nearAiClient.ts

key-decisions:
  - "PR2_BASE is cbe4ef35be491e76bc108014454709dde85144eb, the origin/main commit holding PR 1 (#66) squash-merged; git merge-base HEAD origin/main prints the same id. The branch was cut from origin/main, not from the tip of feat/gate-vocabulary, so the plan's precondition was treated as met on the orchestrator's instruction"
  - "Manifests name raw call arguments (file_path, output_path, image_path, svg_path, url, path). Plan 12 must pass the model's raw arguments (after tool.manifestInput when present) to effectsFor, not the parsed input"
  - "No decision and no status changed: the settings layer and capabilityStatus still use tool.capability"

patterns-established:
  - "manifestInput: a manifest cannot say 'or the default', so a tool that applies a default writes it out for the gate"

requirements-completed: [GATE-02, GATE-03]

duration: one session
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 08: Manifests on 22 built-in tools, one catalog, words on the Tools page Summary

**All 22 built-in tools (9 core, 4 web, 5 graphics, GenerateImage, Remember, Recall, SecurityScan) now declare what they can do next to their own definition, `builtInTools()` holds them in the order a run is given them, and the Tools page adds each tool's plain-word manifest lines after its existing notes, with no decision or status changed.**

## Performance

- **Tasks:** 2 of 2
- **Files:** 2 created, 9 modified (11 files, +416 -28 over the plan's commits)
- **PR2_BASE:** `cbe4ef35be491e76bc108014454709dde85144eb` (origin/main with PR 1 squash-merged; `git merge-base HEAD origin/main` agrees)
- **`builtInTools().length`:** 22, in this order: Read, Write, Edit, Glob, Grep, Bash, BashOutput, KillShell, TodoWrite, WebFetch, WebSearch, CheckCitations, CheckOriginality, VectorizeImage, RenderSvg, CreatePresentation, CreatePdf, CreateDocument, GenerateImage, SecurityScan, Remember, Recall

## Accomplishments

- Core tools (Read, Write, Edit, Glob, Grep, Bash with the `{ from: 'command' }` marker, BashOutput, KillShell, TodoWrite) declare their manifests; the Tools page shows them, for example Write "Can change files in this project".
- Web, graphics, image, memory and security tools declare theirs; the catalog grew to 22 and the page now builds its built-in list from it.
- `gateManifests` walks the catalog: every manifest parses, is frozen deeply and names its tool; the shorthand agrees except for five named exceptions; every field a manifest reads is a real argument of its tool; effects are filled correctly from sample calls; the page words come last in each tool's notes and the page order equals the catalog order; the unattended set is exactly today's.

## Task Commits

1. **Task 1: Tracer, core tools, catalog, Tools page words** - `5e1b898` (feat)
2. **Task 2: web, graphics, image, memory and security tools, catalog grows** - `f8b1ec4` (feat)

**Plan metadata:** the commit that adds this SUMMARY.

## Verification

Exact plan command (inside the cap): `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateManifests.test.js dist/test/toolsPage.test.js dist/test/agentTools.test.js'`

- tsc clean; 43 tests, 41 pass, 0 fail, 0 cancelled, 2 skipped (the skips are existing toolsPage tests, not touched). `gateManifests` alone: 13 tests, 13 pass.
- Wider check of every test file that mentions search providers, the image/memory/security tools, NearAiClient, CORE_TOOLS or the Tools directory (42 files): 516 tests, 510 pass, 0 fail, 6 skipped.
- `git diff origin/main...HEAD -- src/test/toolsPage.test.ts` is empty; no assertion in any existing test was changed.
- The full `npm test` is not run here (the plan's verify is the focused set; the full gate is the PR boundary).

## Deviations from Plan

**1. [Rule 3 - Blocking] Precondition: branch base**
- The plan expected `feat/gate-shadow` to start from the tip of `feat/gate-vocabulary`; it starts from origin/main `cbe4ef3` (PR 1 squash-merged as #66). Treated as met per the orchestrator; PR2_BASE recorded above.

**2. [Rule 2 - Missing critical] `manifestInput` and a `**` default for calls with no path**
- The plan asked for the literal `.` when Glob or Grep has no path, but the manifest format has no "or default" and `.` is not a valid path pattern (it normalises to empty and is refused). A Glob with no path, the commonest call, would have been refused once the gate enforces. Added optional `AgentTool.manifestInput` and `withDefaultPath` (no path means `**`, the whole project, the same widest pattern `fromActionCapability` uses), used by Glob, Grep and CheckOriginality (a text-only call declares a read of `**`, which over-declares rather than hides). Tested.
- **Committed in:** 5e1b898, f8b1ec4

**3. [Rule 3 - Blocking] Hosts the manifests need were not reachable**
- `SearchProvider.host` (new optional field, set by the three providers) so WebSearch can name its provider's host; `NearAiClient.baseHost` (new getter) so GenerateImage can name its client's host; `DirectoryInput.webSearchHost` and `modelHost`, filled in `toolsPage.ts` from the real provider and active client so the page's words are true for this person. Files outside the plan's list: webSearch.ts, nearAiClient.ts, toolsPage.ts.
- With no provider (or a double with no host) WebSearch declares `plan` ("changes nothing outside this run"), because it only prints "not set up" and reaches nothing.
- A bracketed IPv6 address is not a host the format holds, so it is named `localhost` (loopback in practice).
- **Committed in:** f8b1ec4

**4. [Rule 1 - Bug in research table] SecurityScan hosts**
- The plan said to confirm the four hosts by grep in `src/security`. Only `api.osv.dev` and `endoflife.date` are contacted; `osv.dev` and `nvd.nist.gov` appear only as link text in the SBOM. The manifest names the two real hosts, so the Tools page does not claim reach the tool does not have.
- **Committed in:** f8b1ec4

**5. [Rule 2 - Missing critical] SecurityScan and RenderSvg declare what they really do**
- SecurityScan also declares `workspaceWrite{paths: ['sbom.cdx.json']}` (the scan writes the SBOM, via `SBOM_FILE`), and RenderSvg also declares `read{paths: from svg_path}` (same pattern as VectorizeImage). Without them the page would say these tools read or write less than they do (T-70-85).
- **Committed in:** f8b1ec4

**6. Five shorthand exceptions** (each with its reason in `SHORTHAND_EXCEPTIONS`; the test fails if one stops differing): BashOutput (read, manifest `plan`), CheckCitations (read, `plan`), Recall (read, `plan`), GenerateImage (mediaGeneration; no `infer` effect because the model is chosen per call, per the plan's own adjustment), SecurityScan (read; manifest writes and reaches two hosts).

**Impact:** no decision, status or setting changed. 3 added fields on existing types, all optional.

## Decisions Made

- Remember's manifest is `skill.write{scope: 'project'}` as the plan adjusted, so its Tools page line reads "Can change skills in this project". It is the plan's declared effect; the sentence is a little odd for a memory fact and may deserve its own wording later.
- Not declared, because the format cannot express them: CreatePresentation reading images named inside slides, CreatePdf and CreateDocument reading an optional `source_path`, SecurityScan's other lockfiles and manifest names beyond the plan's two globs, and the fixed version probes (`node --version` and similar) the scan runs. Plan 09 or the classifier work can decide whether any of these needs a richer template.
- A Glob or Grep given a folder passes the folder as written (`src`), not `src/**`. Whether a folder name covers its contents is for the gate's path matching (plans 11 and 12).

## Issues Encountered

None. One test of my own failed first (the `.` default described above) and led to deviation 2.

## Known Stubs

None. `STAND_IN_SEARCH` in `toolCatalog.ts` is a deliberate stand-in provider on the placeholder host `search.example`, used only when a caller passes no provider (tests); the Tools page passes the real provider's host or none.

## Threat Flags

None new. T-70-29 (words and gate read one declaration) and T-70-85 (manifest declaring fewer effects than the tool) are covered by the shared `describeManifest` path and the shorthand agreement test; deviations 4 and 5 close two under-declarations found while checking against the code. T-70-SC: no package added (`npm ci` only).

## Next Phase Readiness

Plan 09 can add the remaining tools to the catalog and make `manifest` required; the data-driven test will cover them unchanged. Plan 12's `gateToolCall` must call `effectsFor(tool.manifest, tool.manifestInput?.(raw) ?? raw)` with the model's raw arguments.

---
*Phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor*
*Completed: 2026-11-16*

## Self-Check: PASSED

- FOUND: src/agent/toolCatalog.ts, src/test/gateManifests.test.ts
- FOUND commits: 5e1b898, f8b1ec4 (ancestors of HEAD)
