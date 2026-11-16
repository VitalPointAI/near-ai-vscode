---
phase: 70-capability-vocabulary-manifests-and-one-gate-with-a-floor
plan: 05
subsystem: gate
tags: [manifest, mcp, restrictive-defaults, legacy, plain-words, pure-domain]

requires:
  - phase: 70-01
    provides: "parseCapability, CAPABILITY_VERBS, CREDENTIAL_HANDLE_PATTERN and the Parsed refusal type"
  - phase: 70-03
    provides: "GATE_CONTEXTS and GateContextName in bundle.ts"
provides:
  - "src/domain/gate/manifest.ts: MANIFEST_VERSION, ToolManifest, EffectTemplate, InputSource, RUNS_ON, GATE_RUN_CONTEXTS, parseToolManifest, effectsFor, McpManifest, parseMcpManifest, MCP_TOOL_DEFAULTS, RESTRICTIVE_EFFECTS, mcpToolEffects, shorthandFor (GATE-02, GATE-03)"
  - "src/domain/gate/words.ts: describeManifest, describeMcpManifest, RUNS_ON_THIS_MACHINE_TEXT, MANIFEST_IS_A_CLAIM_TEXT, contextLine (D-07)"
  - "src/test/gateManifestFormat.test.ts: 31 tests"
affects: [70-06, 70-08, 70-09, 70-10, 70-16]

actuals:
  tokens: 17000
  tasks: 2
  commits: 2
plan_head_before: ee8a2e2
plan_head_after: 90e4a10406d99adbcba5bff0c71392be2efd6972
commits: 2

tech-stack:
  added: []
  patterns:
    - "A template's input sources are replaced by stand-in values and the whole effect is checked by parseCapability, so an effect that could never be a real capability is refused when the manifest is read"
    - "A name from a server or a configuration is matched exactly and shown through plain(), which replaces control characters and the long dash and caps the length"
    - "Tool tables are built with Object.fromEntries, so a tool named __proto__ is an ordinary own entry"

key-files:
  created:
    - src/domain/gate/manifest.ts
    - src/domain/gate/words.ts
    - src/test/gateManifestFormat.test.ts
  modified: []

key-decisions:
  - "{ from: 'command' } is an effect entry of its own (Bash only, and only next to a shell effect), not a constraint value, so effectsFor can never return an empty list"
  - "A manifest must name at least one context; an empty contexts list is refused, because a tool that can run nowhere is a mistake, not a declaration"
  - "An undeclared tool under restrictive gets RESTRICTIVE_EFFECTS and only the interactive context, even when the server names unattended (D-06: never runs unattended)"
  - "A server or tool name containing a wildcard, a control character or more than 128 characters is never matched: it gets RESTRICTIVE_EFFECTS, not a looser match"
  - "Legacy contexts follow the transport: stdio is interactive only, a remote server is interactive and unattended; a manifest's own contexts win when one exists"
  - "shorthandFor precedence: sharedWrite, shell, mediaPublication, mediaGeneration, workspaceWrite (destroy counts here), network (network, mcp, send, infer, useSecret, spend, schedule), read, plan"

patterns-established:
  - "words.ts reads effects by verb and plain string fields only, so one function describes a template (tool manifest) and a capability (MCP tool entry)"

requirements-completed: [GATE-02, GATE-03]

duration: not captured
completed: 2026-11-16
status: complete
---

# Phase 70 Plan 05: Capability manifests v1 and their plain words Summary

**Tool manifests whose effects are filled from the call (a path from `file_path`, a host from a URL) and refused rather than widened when a field is missing, MCP server manifests with the restrictive and legacy defaults (a server configured before this phase decides exactly as today), and one words module that writes the same sentences for the Tools page and the gate.**

## Accomplishments

- `parseToolManifest` reads closed keys (`manifestVersion`, `tool`, `effects`, `hosts`, `credentials`, `contexts`, `untrusted`, `runsOn`), refuses an empty effects list (a `plan` effect counts), accepts empty `hosts` and `credentials`, and checks each effect template by swapping its sources for stand-in values and running the vocabulary's own parser in ceiling form. A typo, a `paths` field on `shell`, an unknown verb, a source from anywhere but `input`, or an `as` form the field does not take is refused when the manifest is read.
- `effectsFor(manifest, input)` fills `as: 'path'` and `as: 'literal'` from a string field and `as: 'url-host'` from the lowercase hostname of a URL, then checks the result in request mode. A missing field is `missing-field`; an empty, non-string, non-URL or inherited value is `wrong-type`; a `..` or absolute path, a wildcard and a bracketed IPv6 host are refused by the vocabulary. Nothing returns an empty or wildcard effect (T-70-17). Two fields giving the same value are named once.
- `parseMcpManifest` reads closed keys with `tools` mapping exact tool names to `{ effects, contexts? }` and `toolDefaults` of `restrictive` or `legacy`. `RESTRICTIVE_EFFECTS` deep-equals `shell{anywhere}`, `network{*}`, `workspaceWrite{**}`, `destroy{**}`.
- `mcpToolEffects` returns `{ effects, contexts, shorthand, defaults }`. Declared tool: its own entry, exact name only (`List`, `list ` and `lis` are not `list`, T-70-18). No manifest or `legacy`: `mcp{server, tools:[tool]}` with shorthand `read` when the tool is read-only and not destructive and the server does not ask every call, otherwise shorthand `network` plus `network{hosts:[host or *]}`, the same split as `src/mcp/tools.ts`. Restrictive: `RESTRICTIVE_EFFECTS`, interactive only.
- `describeManifest` and `describeMcpManifest` give sentences in a fixed order (where it runs, effects in verb order, sites sorted, whether it runs when nobody is watching). Every verb has a sentence, including "Can change files in this project", "Connects to api.github.com" and "Runs on this machine with your permissions". An MCP manifest's words always end with `MANIFEST_IS_A_CLAIM_TEXT`.
- `shorthandFor` gives the ActionCapability a manifest implies, for plan 08's agreement test (Pitfall 10).

## Task Commits

1. **Task 1 (tracer): the Write manifest parsed, filled from one call and described** - `23debc9` (feat)
2. **Task 2: MCP manifests with restrictive and legacy defaults, words for every verb, shorthandFor** - `90e4a10` (feat)

## Verification

Each run inside `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536`.

- Task 1: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateManifestFormat.test.js dist/test/teamBoundaries.test.js'`: 7 tests, 7 pass, 0 fail, 0 cancelled.
- Task 2 and plan level: `sh -c 'npx tsc -p tsconfig.json && node --test --test-concurrency=2 dist/test/gateManifestFormat.test.js dist/test/gateVocabulary.test.js dist/test/teamBoundaries.test.js'`: 56 tests, 56 pass, 0 fail, 0 cancelled (31 in gateManifestFormat). No full suite or e2e was run, as the plan asks.
- Acceptance: `grep -c "Runs on this machine with your permissions" src/domain/gate/words.ts` prints 1; `RESTRICTIVE_EFFECTS` deep-equals the four effects of D-06; the legacy split test names the two inputs `src/mcp/tools.ts` uses (the tool's read-only hint and the server's approval setting) and checks both shorthand results; `package.json` and `package-lock.json` are unchanged; `git grep` for the long dash over the new files is empty. teamBoundaries scans both new files (they import only `src/domain`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical] A wildcard in an MCP server or tool name**
- **Issue:** the vocabulary accepts a bare `*` as an `mcp` tool name in a ceiling, so a server naming a tool `*` would have been turned into `mcp{tools:['*']}` instead of being restricted.
- **Fix:** `mcpToolEffects` gives RESTRICTIVE_EFFECTS to any server or tool name containing `*`, a control character or over 128 characters (T-70-16, T-70-18). Tested with `a*b`, `*`, a newline and a 200 character name.
- **Committed in:** `90e4a10`

**2. [Rule 2 - Missing critical] A restrictive undeclared tool must never run unattended**
- **Issue:** the plan gives undeclared tools RESTRICTIVE_EFFECTS but does not say which contexts; D-06 says they never run unattended.
- **Fix:** under restrictive, an undeclared tool keeps only `interactive` from the server's contexts (so a server that names only `unattended` gives none). Tested.
- **Committed in:** `90e4a10`

**3. [Rule 1 - Bug] `from` was not checked on an input source**
- **Issue:** the first draft accepted `{ from: 'env', field, as }` because only the keys were checked.
- **Fix:** `from` must equal `input` (`not-allowed-here` otherwise); a test covers it.
- **Committed in:** `90e4a10`

**Interpretations the plan left open (decisions, not deviations):** `{ from: 'command' }` is an effect entry that needs a `shell` template beside it and a tool named `Bash`; an empty `contexts` list on a tool or server manifest is refused; `shorthandFor` counts `destroy` with `workspaceWrite` and the outward verbs other than `publish` as `network`; the manifest `hosts` list and literal network hosts are joined into one sorted "Connects to" sentence, and a network effect whose host comes from the call says "Connects to sites named in each call" only when no host is known; a context other than `interactive` (including the reserved `relay` and `routine`) reads as "Can also run when nobody is watching".

## Known Stubs

None. Nothing in the running extension imports these modules yet; plans 08, 09 and 10 wire them in.

## Threat Flags

None. All three mitigations of the plan's threat register hold as tested (T-70-16, T-70-17, T-70-18); no network, auth or file surface was added.

## Issues Encountered

- A first draft of `words.ts` came back with a literal long dash in the regex that strips it from names (the escape had been turned into the character on disk). It was replaced by the `the four-digit escape for the long dash` escape before the Task 2 commit; the committed files contain no long dash.

## Self-Check: PASSED

- FOUND: src/domain/gate/manifest.ts, src/domain/gate/words.ts, src/test/gateManifestFormat.test.ts
- FOUND: commits 23debc9 and 90e4a10 on feat/gate-vocabulary
- STATE.md, state.json and ROADMAP.md were not touched
