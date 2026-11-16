# Phase 70: Capability vocabulary, manifests and one gate with a floor - Research

**Researched:** 2026-11-16
**Domain:** an offline, signed-policy authorization gate for an agent runtime (VS Code extension, TypeScript, `node:test`), with data classification labels and label-driven model routing
**Confidence:** HIGH on the in-repo findings (every discrete value below was read from source this session); MEDIUM on OCSF (read from the live schema API); MEDIUM-LOW on code-server and OS-keychain behaviour (one cited PR, no live test)

## Summary

The code already has most of the parts, and almost all of them are in the wrong place. There are exactly **two** call sites where an agent tool executes: `tool.run` in `AgentRun.executeCall` (`src/agent/loop.ts:696`) and `selected!.tool.run` in the cyber panel's step engine (`src/services/cyberRun.ts:392`). There is exactly **one** class that sends content to a model, `NearAiClient`, and all content-bearing requests go through its private `request()` with `POST` to four paths that the client already names (`BILLABLE_PATHS`, `src/services/nearAiClient.ts:148`). That makes the "one gate" achievable without touching every tool and without a new framework: put the tool gate in `executeCall` and `cyberRun`, put the route gate in `NearAiClient.request`, and keep today's `decidePermission`/`decidePermissionAsync` as the unchanged "settings layer" that the gate calls after the floor and the bundle ceiling. That layering is what lets D-10 hold: only **one** existing test pins behaviour the floor changes (`src/test/protectedPaths.test.ts:304`).

Four of the CONTEXT decisions rest on assumptions the code does not support, and the planner should settle them before writing plans (details and evidence in "Proposed amendments to CONTEXT", D-35 to D-44): (1) `attested-cloud` as written ("verified for this request") cannot be a pre-send check, because attestation today is an on-demand, after-the-fact, networked check of one answer (`src/services/agentSession.ts:696-701`); (2) `local-only` is not safe as written, because a "local" runtime URL may be any `https://` address (`src/extension.ts:294-295`); (3) a new MCP server default of "most restrictive" would silently change behaviour for every MCP server people already configured, contradicting D-10 (`src/mcp/tools.ts:43`); (4) `spend{usd}` cannot be signed, because the canonical JSON refuses fractions (`src/domain/team/canonical.ts:30-31`). Two operational gaps need a decision too: on code-server the device key lives in the browser (cited), so a cleared browser means an unverifiable bundle; and "Show Policy" cannot add a clearance, because editing the signed file breaks its signature.

Size: about 850 KB to 1.1 MB of diff including tests (Phase 69 part 1 was 958,828 bytes for 72 files, part 2 was 481,821 bytes). That needs three PRs after the planning PR, and the floor flip plus documentation should be its own small PR so it is never split from the docs (D-34).

**Primary recommendation:** Build `src/domain/gate/` first as pure, versioned, closed types with a frozen-vector test; wrap the existing deciders instead of rewriting them (floor above, settings layer unchanged below); add `manifest` as a required field on `AgentTool` so a tool cannot exist without one; put the route gate inside `NearAiClient.request` driven by an `AsyncLocalStorage` session context (the same pattern `withSpendTag` already uses); and ship the floor change, the `protectedPaths` test change and the SECURITY.md and README edits in one PR.

## User Constraints (from CONTEXT.md)

The full text of D-01 to D-34 is in `70-CONTEXT.md` (`<decisions>`), unchanged and not repeated here because it is 30 KB and the planner reads both files. They are locked unless this file proposes an amendment (last section). One-line index, verbatim section names:

- Where the code lives and how the relay shares it: D-01, D-02
- Capability vocabulary (GATE-01, research flag 1): D-03, D-04
- Manifests (GATE-02, GATE-03): D-05, D-06, D-07
- One gate for every execution path (GATE-04): D-08, D-09, D-10
- Policy bundle and its relation to settings (OFFL-01, OFFL-02, OFFL-03): D-11 to D-15
- The floor (GATE-05, GATE-06): D-16 to D-19
- Decision records (GATE-07): D-20, D-21
- Labels and scales (CLAS-01, CLAS-02): D-22 to D-26
- Clearance, dominance and the high-water mark (CLAS-03, CLAS-04): D-27 to D-29
- Routing by label (CLAS-05, CLAS-06, CLAS-07): D-30 to D-32
- UI: D-33
- Release and process: D-34

### Claude's Discretion (verbatim)
- File split inside `src/domain/gate/` and `src/gate/`, exported function names and test file names (following `src/test/gate*.test.ts`), as long as the decisions above hold.
- The exact OCSF class ids and field mapping (D-20), chosen by research.
- How the plans group into PRs, as long as D-34 holds.

### Deferred Ideas (OUT OF SCOPE, verbatim)
- DIDs, verifiable credentials as the source of clearance, grants and delegation that narrows: Phase 71.
- Execution backends, the sandbox and the guarded apply (which calls the label map update): Phase 72. Credential broker: Phase 73. Run contracts and run admission (OFFL-04): Phase 74. Request-bound signed approvals: Phase 80.
- Organization-issued bundles, anchor roots, status lists and the live per-level maximum offline age: milestones L4 and L5 (fields reserved here).
- A clearance and mapping editor UI, and Cedar or OPA style rich role rules: later, if needed.
- Adding workspace credential-file reads to the floor: open question for the owner (D-18).

## Project Constraints (from CLAUDE.md and the user's global rules)

There is no `CLAUDE.md` in the repo. Directives that bind this phase, from D-34, `docs/development-workflow.md` and the user's global rules:

- Tests on every change; every test command uses the memory cap `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>` (full suite and e2e: `MemoryMax=6G`, timeout 1800); one heavy run at a time; e2e only under `xvfb-run` with Wayland variables stripped.
- Plain language in anything a person reads; no em-dashes anywhere; "your organization", never "NEAR organization"; NEAR AI is only the provider.
- No new runtime dependencies; no local machine paths in repo files.
- NEAR keys: never delete, overwrite, truncate or edit a file under `~/.near-credentials`. Every floor test must use a fake home folder created in a temp directory, never the real home. A floor test that "touches" `~/.near-credentials` must only assert a refusal on command text, never execute the command.
- Verification cadence: smallest relevant unit or type check after each edit; broader suites at wave boundaries; one full suite at the phase boundary. Security, authorization, data-integrity and architectural-boundary checks (this whole phase) are immediately blocking.
- Never delete, skip or weaken a failing test to get green. The one deliberate test change (D-19) must be recorded as such in its plan.
- PRs: squash-merge, each diff under 950,000 bytes, a planning-only PR first, the floor change and its documentation in one PR.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| GATE-01 | One versioned vocabulary in `src/domain`, unknown verbs or fields refused | Section 5 (exact v1 schema, canonical-JSON constraints, `gpu` reserved, spend in integers); boundary test pattern in `src/test/teamBoundaries.test.ts` |
| GATE-02 | A manifest for every built-in tool, a test fails if any lacks one | Section 1: 40 built-in tools, how to enumerate (new `toolCatalog`), required `manifest` field on `AgentTool`, per-tool proposal table |
| GATE-03 | MCP manifests, undeclared tool most restrictive, stdio labelled, Tools page words | Section 5.3 and amendment D-38 (legacy servers keep today's behaviour); `src/mcp/tools.ts`, `src/services/mcpRegistry.ts`, `src/services/toolsDirectory.ts` |
| GATE-04 | One gate for every execution path, a test enumerates them, cards are transport | Section 1: two execution sites, `new AgentRun(` x3, source-scan test plus behavioural spy test |
| GATE-05 | A floor no mode, setting or delegation can override | Sections 3 and 4: exact lists, effect tags on `commandSafety`, floor above `decidePermission`; amendment D-43 (contexts) and D-44 (`team.md`) |
| GATE-06 | Fully-autonomous is "no approval within the grant", docs agree | Section 3.3 (the two code spots) and 3.5 (the one test and the SECURITY.md and README lines that change) |
| GATE-07 | Every decision recorded in an OCSF-shaped record | Section 6 (class 6003, OCSF 1.9.0, `ai_operation` profile, field table) |
| OFFL-01 | Decide with no network | Section 7 and Validation (network stubbed to throw); catalog staleness rule in Section 8 |
| OFFL-02 | Signed local bundle, fail closed, fresh install self-signs | Sections 5.4 and 7 (failure reason list from `PAYLOAD_FAILURES`, code-server finding, amendment D-39 and D-41) |
| OFFL-03 | Version, expiry, issuer, reserved anchor roots, status lists, max offline age | Section 5.4 (exact payload, reserved fields validated for shape, refused when unknown) |
| CLAS-01 | Labels in vocabulary and bundle, unknown scale, level or field refused | Section 5.5 and 5.6 (label shape, label map, resolution order) |
| CLAS-02 | Scale presets, mappings only by bundle | Section 5.5 (four presets, mapping shape, defaults) |
| CLAS-03 | Hand-written dominance evaluator, property test | Section 9.3 (exact algorithm incl. releasability and expiry) and Validation |
| CLAS-04 | Session high-water mark, inherit, sub-agents, declassify recorded | Section 9 (mark sharing through the run's grants object, rename tracking, chat metadata); amendment D-42 |
| CLAS-05 | Routing tiers per level | Section 5.5 (default table keyed by `scale/level`), Section 8 |
| CLAS-06 | Route decided before every request, local-only with no local model refused | Section 2 (single choke point in `NearAiClient.request`), amendment D-37 (loopback) |
| CLAS-07 | The product says plainly it is not accreditation | Section 12 (sentence-by-sentence check; amendment D-40 with replacement wording) |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Vocabulary, manifests, labels, dominance, routing tiers, bundle shape, `decide()`, floor facts, record shape | `src/domain/gate` (pure) | none | No `vscode`, no I/O, shared with the relay through `@ext/*` (D-01, D-02) |
| Bundle file, label map file, decision log, clock marker | `src/gate` (Node I/O, SecretStorage through `SecretStorageLike`) | none | Same split as `src/team` over `src/domain/team` |
| Tool gate call, approval card transport | `src/agent/loop.ts` (`executeCall`) | `src/services/agentSession.ts` (cards), `src/services/cyberRun.ts` | The only two `tool.run` sites |
| Route gate (model requests) | `NearAiClient.request` (`src/services/nearAiClient.ts`) | `src/services/providerFactory.ts` (tells each client what it is) | Single class sends all content; the model catalog is already cached on it (`rememberModels`) |
| Session high-water mark | `RunGrants`-like object shared by a run and its sub-agents | `ThreadMeta` for chats that outlive a run | `RunGrants.taintedAt` is already shared this way (`src/agent/permissions.ts:122-145`) |
| Label map lookup and updates | `src/gate` | `vscode.workspace.onDidRenameFiles` in `src/services` | No agent tool renames files (`CORE_TOOLS`, `src/agent/tools.ts:632`) |
| Status bar, commands, Tools page words | `src/services` (VS Code adapters) | `media/tools/tools.js` for display | Pattern: `src/services/team/teamStatusBar.ts`, `src/services/toolsDirectory.ts` |
| Docs (SECURITY.md, README) | repo root | none | Must land in the same PR as the floor (D-34) |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` (Ed25519), through the existing `signPayload` / `verifyPayload` | Node built-in; extension runs on VS Code's Node, tests on Node 24.22.3 [VERIFIED: `node --version` in this session] | Sign and verify the bundle and label map | One signer only (Phase 69 D-10); `src/domain/team/signedPayload.ts` |
| `node:test` + `node:assert/strict` | built-in | All tests | Repo standard: `npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js` |
| `node:async_hooks` `AsyncLocalStorage` | built-in | Carry the session label to the route gate | Already used for spend tags (`src/services/spendLedger.ts:27-33`) |
| `node:fs/promises`, `src/services/stateMirrorLock.ts` `withFileLock` | built-in / in repo | Bundle and map files, cross-window lock | Same pattern as identity creation (`src/team/identity.ts:138-160`) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `src/domain/team/canonical.ts` (`canonicalize`, `canonicalBytes`) | in repo | Hash the bundle for `bundleHash`, frozen vectors | Bundle hash in every decision record |
| `src/domain/team/secrets.ts` (`assertNoSecrets`) | in repo | Runs inside `signPayload`, refuses secret-like strings | Know its limits: credential handle names and path keys must not look secret (Pitfall 9) |
| `src/domain/redaction.ts` `redactSecrets` | in repo | Redact records before writing (D-21) | Decision log writer |
| `src/agent/glob.ts` `matchesGlob` | in repo (pure, 39 lines) | Path patterns in capabilities | Move or re-export under `src/domain` so the gate does not import `src/agent` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-written dominance and decide | Cedar or OPA WASM | 13.5 MB WASM and a dependency; D-28 and identity-research section 4.1 reject it [CITED: `.planning/research/platform-direction/identity-research.md` section 4.1] |
| New OCSF library | plain object builder | No OCSF npm package is needed; the shape is small. Zero-dependency (D-01) |

**Installation:** none. This phase adds no packages.

**Version verification:** not applicable (no external package). `npm view` was deliberately not run.

## Package Legitimacy Audit

No external packages are installed by this phase (D-34, "no new runtime dependencies"; the Standard Stack above is Node built-ins and in-repo modules). Packages removed due to [SLOP]: none. Packages flagged [SUS]: none. Nothing for the planner to gate behind `checkpoint:human-verify`. If a plan proposes any package (for example a JSON-schema validator), treat it as `[ASSUMED]` and refuse it: the vocabulary validator is hand-written like `src/domain/team/validate.ts`.

## 1. Execution path inventory (question 1)

### 1.1 Where a tool actually executes

[VERIFIED: grep of `tool.run(` over `src`, excluding tests] Four hits:

| Site | What it is | Gate placement |
|------|-----------|----------------|
| `src/agent/loop.ts:696` `const output = await tool.run(input, context);` | `AgentRun.executeCall`, used by the main chat run, every sub-agent, the benchmark runner and the cyber chat path | The gate call replaces lines 614-692 (the `forbidden`, `sensitive`, `risky`, `decidePermissionAsync`, card flow) |
| `src/services/cyberRun.ts:392` `output = await selected!.tool.run(parsed, runContext(input));` | Cyber panel step engine; decides with `decidePermission(capability, command, input.policy, rules, input.grants, undefined, intrusive)` at line 353; host tools run through `runHostTool` (line 380) | Same gate call before line 353's result is used; `hostTool` branch is a second effect site (shell) |
| `src/services/agentSession.ts:965` and `:970` `tool.run(input, toolContext)` | `yieldingSlot` wrapper around `Agent`/`Task`; it runs inside `executeCall`, so it is already behind the gate | Not a new site; the test allow-list names it |

Everything else that starts a process is extension code, not an agent tool: `src/gsd/runtime.ts` (`npm view`, `npx --yes ... --claude --global`), `src/agent/worktree.ts`, `src/services/stateGit.ts`, `src/services/codePushCheck.ts`, `src/team/runGit.ts`, `src/services/onlineHome.ts` (`gh`), `src/services/cyberTools.ts`, `src/services/cyberSandbox.ts`, `src/security/runtimes.ts`. The floor's own wording (D-16) already excludes extension code ("the extension's own code reads and writes these files directly", `src/domain/protectedPaths.ts:49-51`). The enumeration test should carry this list as an explicit allow-list so a new `child_process` import in `src/agent` or `src/mcp` fails the test.

`new AgentRun(` call sites outside tests [VERIFIED]: `src/services/agentSession.ts:424` (main), `src/services/agentSession.ts:1022` (sub-agent), `src/benchmark/runner.ts:42` (benchmark; also reached from `src/services/modelComparisonPanel.ts:255`, `src/benchmark/roleSuite.ts:93`, `src/services/teamStudioPanel.ts:137`). Tests construct `AgentRun` 34 times in 19 files [VERIFIED: grep count], so the gate option must be **optional with a safe default** (Pitfall 1), plus a source-scan test that the three production sites pass it.

### 1.2 Tools: 40 built-in plus MCP

[VERIFIED: names and capabilities read from the tool files] Built-in tools reach a run through `toolsFor` (`src/services/agentSession.ts:874-890`): `[...CORE_TOOLS, webFetchTool, webSearchTool(...), checkCitationsTool, checkOriginalityTool, ...GRAPHICS_TOOLS, ...media, ...security, ...cyber.tools(), ...mcpTools, ...teamKnowledge, ...memoryFor()]`, plus `gsdTools(...)` when sub-agents are available (line 895). Count: core 9, web 4, graphics 5, `GenerateImage` 1, `SecurityScan` 1, cyber probes 9, cyber exploit 2, `TeamKnowledge` and `Learn` 2, `Remember` and `Recall` 2, gsd 5 (`Skill`, `SlashCommand`, `AskUserQuestion`, `Agent`, `Task`) = **40**. MCP tools are created per connected server by `mcpAgentTools` (`src/mcp/tools.ts:28`), named `mcp__<server>__<tool>` (`mcpToolName`, line 13).

How a test enumerates them: there is **no registry function today**. `buildToolsDirectory` (`src/services/toolsDirectory.ts:~160`) rebuilds a list from the same objects, but it omits `TeamKnowledge`, `Learn` and every cyber tool [VERIFIED: its list is `CORE_TOOLS`, `webFetchTool`, `webSearchTool`, `checkCitationsTool`, `checkOriginalityTool`, `GRAPHICS_TOOLS`, `imageTool`, `securityTool`, `memoryTools`, `gsdTools`]. Recommendation: add `src/agent/toolCatalog.ts` exporting `builtInTools(stubs)` that returns all 40 (using stub clients like `toolsDirectory.ts` already does with `stubClient`), make `toolsDirectory.ts` use it (this also fixes the omission, which D-07 needs), and have a test compare `toolsFor(...)` names with `builtInTools()` plus dynamic sets. Add two static checks: (a) every file under `src` that contains `AgentTool<` object literals appears in an allow-list of files the catalog covers; (b) the `tool.run(` call-site allow-list above.

### 1.3 Proposed manifests for the 40 built-in tools (starting point for plans)

`capability` is today's shorthand (unchanged, D-04). `contexts` today means where the tool exists: `i` = interactive, `u` = unattended (a run with no person who can answer; D-43). Effects use vocabulary verbs; `from:` means filled from the call's input.

| Tool | capability | Effects | Hosts | Contexts | Notes |
|------|-----------|---------|-------|----------|-------|
| Read | read | `read{paths: from file_path}` | none | i,u | credential-file ask stays (D-18) |
| Write, Edit | workspaceWrite | `workspaceWrite{paths: from file_path}` | none | i,u | floor path rules apply |
| Glob, Grep | read | `read{paths: from path or "."}` | none | i,u | results can reveal labelled names (Section 9) |
| Bash | shell | `shell{cwd:"workspace"}` plus effects derived from the command by the classifier (publish, destroy, network, workspaceWrite) | from command | i,u | the manifest names the extractor `command`; the floor reads the classifier tags |
| BashOutput, KillShell, TodoWrite | read, plan, plan | `plan` | none | i,u | run's own state only |
| WebFetch | network | `network{hosts: from url host}` | any https host | i,u | `untrusted`, `autoSafe` |
| WebSearch | network | `network{hosts: [provider host]}` | provider's | i,u | `untrusted`, `autoSafe`; provider host comes from the provider object |
| CheckCitations, CheckOriginality | read | `plan` (they read pages already in memory; `CheckOriginality` may read `path`: add `read{paths: from path}`) | none | i,u | |
| VectorizeImage, RenderSvg, CreatePresentation, CreatePdf, CreateDocument | workspaceWrite | `workspaceWrite{paths: from output}` (Vectorize also `read{paths: from image}`) | none | i,u | |
| GenerateImage | mediaGeneration | `workspaceWrite{paths: from path}`, `network{hosts: [client base host]}`, `infer{...}` | the model host | i | needs a person when image review is on |
| SecurityScan | read | `read{paths:["**/package.json", "**/*lock*"]}`, `network{hosts:["api.osv.dev","osv.dev","endoflife.date","nvd.nist.gov"]}` | those four [VERIFIED: `grep` of `src/security/*.ts`] | i | consent is a project setting |
| CyberHttpProbe, CyberFingerprintProbe, CyberTlsProbe, CyberDnsProbe, CyberTcpProbe, CyberRobotsProbe | read | `network{hosts: from target}` | the engagement's scope | i | shorthand stays `read` (silent today, scope-checked); this is the documented exception to "manifest verbs match the shorthand" (Pitfall 10) |
| CyberSecretsProbe, CyberIacProbe, CyberDependencyProbe | read | `read{paths: from path}` | none | i | |
| CyberExploitTool, CyberPostExploitTool | shell | `shell{cwd:"workspace"}`, `network{hosts: from target}` | scope | i | engagement grant stays (`settings.engagement-grant`) |
| TeamKnowledge | read | `read` of the team graph (outside the workspace) | none | i,u | |
| Learn | sharedWrite | `workspaceWrite{paths:[team knowledge file]}` | none | i | **always asks in every mode today** (`src/agent/permissions.ts:196`); keep as `floor.shared-write` |
| Remember, Recall | plan, read | `plan` / `read` of the project memory graph | none | i,u | |
| Skill, SlashCommand | plan | `read{paths:[skill file]}` | none | i,u | |
| AskUserQuestion | plan | `plan` | none | i | needs a person: not allowed in `u` |
| Agent, Task | plan | `spawn{agent: from subagent_type}` | none | i,u | the child's calls are gated on their own |

## 2. Model request inventory (question 2)

### 2.1 Where content leaves for a model

[VERIFIED: grep of `streamCompletion|completeOnce|generateImage|editImage|describeImage|transcribeAudio|streamChat` outside tests]

| Request | Site | Reaches the client through |
|---------|------|----------------------------|
| Main chat agent turn | `src/agent/loop.ts:424` `streamCompletion` | `AgentRunOptions.client` from `clientFor(active, model)` (`src/services/chat.ts:868`) |
| Sub-agent turn | `src/agent/loop.ts:424`, `child = new AgentRun({ client: request.client ...})` (`agentSession.ts:1022-1023`) | the run's one client |
| Context summary | `src/agent/context.ts:102` | `request.client` |
| Auto-mode safety model | `src/agent/safetyModel.ts:137` `completeOnce` | `request.client` (private model chosen by `privateSafetyModel`, `chat.ts`) |
| Attachment reading (images, audio) | `src/agent/attachments.ts:120` and `:126`, called at `chat.ts:~868-870` and `:974` | `clientFor(active, model).client` |
| GenerateImage tool | `src/agent/extraTools.ts:109`, `:202-217` | `imageTool(request.client, ...)` |
| Generation skill | `src/services/generationService.ts:361-368` | not constructed anywhere in production (Section 2.3) |
| VS Code `@nearAi` participant | `src/services/chatParticipant.ts:133-136` | `clientFor(active, model)`; gated today by `OutboundGuard` (line 120) |
| Cyber roles | `src/services/cyberHandoff.ts:72`, `src/services/cyberAssembly.ts:218` `completeOnce` | caller-supplied client |
| Team builder | `src/services/teamStudioPanel.ts:103` `completeOnce`, `:137` role suite | `clientFor(active, ...)` |
| Model comparison and role suite | `src/benchmark/runner.ts:42`, `:132` | `options.clientFor(model)` |

Not content: `listModels`, `listModelPrivacy`, billing, `checkApiKey`, `verifyResponse` GETs (`src/services/nearAiClient.ts:331-413`, `:547-562`, `:773-774`).

### 2.2 The choke point

Every content request is a `POST` through the private `NearAiClient.request(path, init, overrides)` (`nearAiClient.ts:897`), with `overrides.model` set. The content-bearing paths are the four already named: `const BILLABLE_PATHS = new Set(['/chat/completions', '/images/generations', '/images/edits', '/audio/transcriptions']);` (`nearAiClient.ts:148`). The client already holds the model catalog for each id (`this.models`, filled by `rememberModels`, `nearAiClient.ts:~384-387`), including `privacyBoundary` (`'tee' | 'local' | 'cloud'`, derived by `modelPrivacy`, `nearAiClient.ts:1081-1086`). So the route check fits inside `request()` right where the spend check is (`nearAiClient.ts:907-911`), before `this.admit(...)`: no change to any caller.

Two things the client does not know and the guard needs, both cheap to add:
1. **What kind of client it is**: add `route?: 'near' | 'local'` to `NearAiClientOptions`, set in `src/services/providerFactory.ts:21` (`'near'` unless the profile is `local`) and `:24` (`'local'` for `localClient`). A `local` primary profile is the client on `provider === 'local'`.
2. **The session label of the caller**: use an `AsyncLocalStorage` like `withSpendTag` (`src/services/spendLedger.ts:27-33`, used at 8 production sites). `withSessionRoute({mark, actor}, fn)` wraps the run (`agentSession.ts` around `:485` and `:1052`, where `withSpendTag` already wraps). A request with **no** session context gets the project default label and is recorded as `route.no-session`; the enumeration test asserts every production caller above runs inside a context.

The existing `OutboundGuard` (`src/services/outboundGuard.ts`, used at `chat.ts:832`, `:957` and `chatParticipant.ts:120`) is today's "single check every outbound chat turn passes" for `nearAi.privacyMode` (`standard` or `tee-only`, `package.json` setting enum) and the data-class preflight. It only covers a user message's text, not sub-agents, summaries, safety checks, attachments or images. Keep it as the narrowing setting inside the bundle's routing (migration row 24); the new guard is the one that cannot be skipped.

### 2.3 Dormant provider-gate code

`AgentOrchestrator.invokeBoundTeam` (`src/services/agentOrchestrator.ts:191`), `MultimodalOrchestrator`, `GenerationService`, `ApprovalService` and `StakingService` each carry their own `PolicyGate`/`PrivacyPreflight` use, but none is imported by any production module [VERIFIED: grep for each class and module name outside `src/test` found only self-references and the one `type` import of `ApprovalService` in `generationService.ts`]. They are not execution paths today. The enumeration test should assert they stay unimported from `src/extension.ts`'s import graph, or are adapted to the gate when someone wires them. Do not spend plan effort converting them now.

### 2.4 Test enumeration

(a) A table test over `NearAiClient`: for every `request(` call in the file whose path is in `BILLABLE_PATHS`, a route-denied session context must make the call throw before `fetchFn` is called (a fake `fetchFn` records calls). (b) A source-scan test: every `streamCompletion`, `completeOnce`, `generateImage`, `editImage`, `describeImage`, `transcribeAudio`, `streamChat`, `streamChatEvents` call outside `nearAiClient.ts` is in a file on an allow-list that the plan keeps inside a `withSessionRoute`. (c) A scripted-run test per tier through `AgentRun` and through the safety model.

## 3. Today's permission logic and the migration (question 3)

### 3.1 Order of decision today

[VERIFIED: `src/agent/loop.ts:589-692`, `src/agent/permissions.ts:185-301`] In `executeCall`: parse input and title; `tool.forbidden` (key folder, refused with no card: `loop.ts:618-624`); `tool.sensitive` and `tool.risky` (`:625`); build the auto context for `auto` or unattended (`:627-628`); `decidePermissionAsync(tool.capability, command, policy, rules, grants, autoCtx)` (`:629`); then line 631, verbatim:

`const permission = decided.decision === 'deny' ? decided : risky ? { decision: 'ask' as const } : sensitive && decided.decision === 'allow' && this.options.policy.mode !== 'fully-autonomous' ? { decision: 'ask' as const } : decided;`

Inside `decidePermission`: emergency stop deny (`permissions.ts:186`); read and plan allow (`:187`); `network` plus `auto` plus `autoSafeTool` allow (`:194`); `sharedWrite` always asks (`:196`); `workspaceWrite` allow when `grants.edits` or mode is not `approve-risky` (`:197-200`); shell: deny list (`:202-205`), engagement grant (`:208-209`), per-run command grants (`:210`), allow list (`:211-212`), then **`if (policy.mode === 'fully-autonomous') return { decision: 'allow' };`** (`:213`), then the `auto` classifier (`:214-219`), else ask; every other capability: `return policy.mode === 'fully-autonomous' ? { decision: 'allow' } : { decision: 'ask' };` (`:222`). `decidePermissionAsync` adds the tainted download hold (`:241-243`), the unattended sub-agent upgrade (`:246-249`), then for `auto`: tainted data-carrying and network holds (`:272-279`), outside-workspace hold and project switch (`:282-290`), installs switch (`:291`), safety model (`:292-300`).

Constants the gate must keep byte-compatible: `DEFAULT_RULES` (`permissions.ts:35-38`):
`allowCommands: ['git status', 'git diff', 'git log', 'git show', 'git branch', 'ls', 'pwd', 'node --version', 'npm --version']`, `denyCommands: ['rm -rf /', 'rm -rf ~', 'git push --force', 'git push -f', 'mkfs', ':(){']`. Modes: `export type ActionPolicyMode = 'approve-risky' | 'mostly-autonomous' | 'auto' | 'fully-autonomous';` (`src/domain/policy.ts:21`). Cards that never offer "always allow": `const ALWAYS_ASKS_KINDS: ReadonlySet<string> = new Set(['credentials', 'destructive', 'leaves-machine']);` (`loop.ts:22`). The `grant` on a card is only set when `!risky` (`loop.ts:674`), and `lateApproval` turns a sub-agent's late allow into a run-wide grant (`agentSession.ts:1483-1500`).

### 3.2 Recommended layering (keeps D-10 true)

Do **not** rewrite `decidePermission`. The gate is a layer above it:

1. emergency stop deny, 2. bundle state (failed closed leaves floor, read, plan), 3. **floor** (refuse, or ask with no grant), 4. bundle ceiling (mode per context, context per verb, unattended MCP), 5. label dominance and route facts, 6. **settings layer = today's `decidePermissionAsync` unchanged** (modes, allow and deny lists, run grants, classifier, safety model, risk switches, taint holds, unattended upgrade, MCP approval), 7. record.

A floor "ask" is exactly today's `risky` path: it asks in every mode, an earlier grant does not cover it, the card has no `grant` and no allow rule (`loop.ts:631`, `:674`). So the loop change for the floor is small: compute floor reasons for every call (including in `fully-autonomous`), feed them as `risky`-like with a `floor` marker, and make the pending-card path for a sub-agent one-shot for floor asks (amendment D-43).

### 3.3 The two spots D-19 names

- `loop.ts:631`: the `this.options.policy.mode !== 'fully-autonomous'` clause on `sensitive`. For protected writes this becomes the floor (ask in every mode); for credential-file **reads** it stays as is (D-18).
- `permissions.ts:213` and `:222`: leave as they are inside the settings layer. Because the floor runs before them, nothing there changes, and `src/test/autoApproval.test.ts:105-115` (which compares `decidePermissionAsync` with `decidePermission` in `fully-autonomous`) stays green unchanged.

One cost the planner must not miss: today the classifier context (`autoContext`) is built only for `auto` or unattended (`loop.ts:627-628`). The floor needs `classifyCommand` for **every** shell call in **every** mode. Build a cheaper context for the floor (root, cwd, home, `packageScripts`, trusted roots) and keep `autoContext` for the settings layer. `autoContext` reads `package.json` and may resolve Open-GSD runtime paths (`loop.ts:709-735`); doing that on every shell call in every mode is acceptable but cache `package.json` per run.

### 3.4 Migration table: existing rule to gate rule id, and the tests that pin it

Tests are in `src/test/`. "Unchanged" means the test stays as is.

| # | Existing rule (source) | Gate rule id | Pinned by |
|---|------------------------|--------------|-----------|
| 1 | Emergency stop deny (`permissions.ts:186`, `policyGate.ts:18`, `outboundGuard.ts`) | `settings.emergency-stop` | agentBasics, autoApproval, cyberEmergencyStop, unattendedApproval, policyGate, policy, outboundGuard |
| 2 | Read and plan always allow (`:187`) | `settings.read-plan`; also what `bundle.failed-closed` leaves | agentBasics, agentTools (KillShell all modes), autoApproval |
| 3 | `autoSafe` web tools in `auto` (`:194`) | `settings.auto-safe-tool` | autoApproval, toolsPage, teamStudioPage |
| 4 | `sharedWrite` always asks (`:196`) | `floor.shared-write` (ask, no grant) | knowledgeTools, autoApproval |
| 5 | Edits: grant or mode (`:197-200`) | `settings.mode.edits`, `settings.run-grant.edits` | agentLoop, agentBasics, approvalStalls |
| 6 | Deny list (`:202-205`) | `settings.deny-list` | agentBasics (157-164), autoApproval (34-35), unattendedApproval (158), benchmarkRunner (136) |
| 7 | Engagement grant (`:208-209`, `intrusiveGrantDecision`) | `settings.engagement-grant` | cyberAssembly, cyberRun, cyberEmergencyStop |
| 8 | Per-run command grants (`:210`) | `settings.run-grant.command` | autoApproval (37), approvalStalls |
| 9 | Allow list, `isAutoAllowed`, `suggestAllowRule` | `settings.allow-rule` | autoApproval (250-265), approvalRisk |
| 10 | Fully-autonomous shell shortcut (`:213`) and other capabilities (`:222`) | `settings.mode.fully-autonomous`, `settings.mode.other` | autoApproval (95-115), policy, toolsPage; floor sits above both |
| 11 | `auto` classifier (`:214-219`) | `settings.auto.classifier` | autoApproval, commandSafety |
| 12 | Tainted download, data-carrying and network holds (`:241-243`, `:272-279`) | `taint.download`, `taint.carries-data`, `taint.network` | autoApproval, untrusted, unattendedApproval |
| 13 | Unattended sub-agent upgrade, `unattended.ts` | `settings.unattended-verification` | unattendedApproval, researchProfile |
| 14 | Outside-workspace and installs switches (`riskSwitches.ts`, `permissions.ts:282-291`) | `settings.risk.outside-workspace`, `settings.risk.installs` | approvalRisk, autoApproval |
| 15 | Safety model (`:292-300`) | `settings.safety-model` | autoApproval |
| 16 | `tool.forbidden` (key folder, `loop.ts:618-624`; `STATE_KEYS_PATH`, `namesStateKeys`, `shellReachesStateKeys`) | `floor.state-keys` (refuse, no card) | protectedPaths (115, 208, 222, 266), agentTools |
| 17 | `tool.risky` hooks (outside-content exfiltration URL, tainted network command, script naming the key folder, out-of-scope write after taint; MCP approval) | `taint.held`, `tool.risky.script-keys`, `settings.mcp-approval` | untrusted, protectedPaths (166), mcp (61) |
| 18 | `tool.sensitive` for protected writes (`protectedWrite`, `PROTECTED_WRITE`) | `floor.protected-write` (ask, every mode, no grant) | protectedPaths (25, 38, 80, **304 changes**), commandSafety |
| 19 | `tool.sensitive` for credential-file reads (`isSensitivePath`) | `settings.sensitive-read` (unchanged, D-18) | protectedPaths (48, 62, 304 read half) |
| 20 | Cards never offer "always allow" for credentials, destructive, leaves-machine (`loop.ts:22`, `offeredRule`) | `floor.no-always-allow` on publish and destroy; credentials stays | approvalRisk, autoApproval |
| 21 | MCP `approval` and `readOnly` mapping (`src/mcp/tools.ts:41-43`, `:53`) | `settings.mcp-approval` through the manifest (amendment D-38) | mcp, toolsPage |
| 22 | `nearAi.privacyMode`, `PrivacyPreflight`, `OutboundGuard` | `route.privacy-mode` (narrows inside the bundle's tiers) | outboundGuard, privacyPreflight, policyGate, approvalService, agentOrchestrator, multimodalOrchestration, generationService |
| 23 | Private members: `routeAllows`, `privateModelFor`, `attachmentTeeBlock` (`agentSession.ts:222-240`) | `route.member-private` | privateMembers, securityReview |
| 24 | Tools page status (`capabilityStatus` calls `decidePermission`, `toolsDirectory.ts:~93`) | unchanged; manifest words are added | toolsPage, teamStudioPage |
| 25 | Mode picker, `POLICY_OPTIONS` | unchanged | approvalPolicyPicker |

### 3.5 Tests that change, and tests that must not

Change (deliberately, same plan as the code and docs, D-19):
- `src/test/protectedPaths.test.ts:304`, "fully-autonomous reads credential files and writes into .git/, .planning/.near-ai/ and .near-ai/ without asking; the other modes ask". Split it. The two credential **reads** (`.env`, `deploy/id_ed25519`) and `cat .env` stay allowed in `fully-autonomous` (D-18). The four **writes** into `.git/hooks/pre-commit`, `.planning/.near-ai/settings.json`, `.near-ai/state/meta.json` (Edit) and the shell `printf x > .git/hooks/post-commit` now ask in `fully-autonomous`, with no allow rule and no grant; add the refusal case for a context with no person. The comment at lines 300-303 that says "This pins today's behaviour" must be rewritten.
- `src/test/teamSignedPayload.test.ts`: adding `label-map` to `PAYLOAD_PURPOSES` (`src/domain/team/signedPayload.ts:25`, today `['policy-bundle', 'grant', 'approval-answer', 'key-record']`) breaks the typed `SAMPLES: Record<PayloadPurpose, unknown>` at line 60 (compile error) and the literal at line 121 (`assert.deepEqual([...PAYLOAD_PURPOSES], ['policy-bundle', 'grant', 'approval-answer', 'key-record'])`). Add the key and the new literal in the plan that adds the purpose.
- Fixtures that build `AgentTool` objects need `manifest`: `autoApproval`, `approvalStalls`, `cyberRun`, `steering`, `mcp` (about 5 files; provide a `testTool()` helper).
- `src/test/teamBoundaries.test.ts`: add rules for `domain/gate` and `gate` (its `RULES` table, lines 52-61, is the pattern; `boundaryViolations` is exported).

Must stay unchanged (they prove D-10): everything else in the migration table, in particular `autoApproval.test.ts` (all), `agentLoop.test.ts`, `untrusted.test.ts`, `unattendedApproval.test.ts`, `mcp.test.ts`, `toolsPage.test.ts`, `commandSafety.test.ts`, `approvalRisk.test.ts`, `benchmarkRunner.test.ts`, and the 25 files that run `AgentRun` or `conversation.send` in `fully-autonomous` [VERIFIED: grep]. None of those run a floor command: their Bash commands are `pwd`, `ls`, `git status`, `git commit -m x`, `npm test`, `echo ... > file`, `curl -d @.env ...` (already held), so they need no edit as long as the default gate (Pitfall 1) is the same policy as production's default bundle.

## 4. Floor detection (question 4)

### 4.1 What the classifier gives and what it lacks

`classifyCommand(command, context)` returns `{ verdict: 'safe' | 'risky' | 'unknown', reason: string }` (`src/agent/commandSafety.ts:14-16`, entry at `:1182`), built with three helpers `safe`, `risky`, `unknown` that take only a reason (`:53-55`). The card's "kind" is recovered afterwards by regex on the reason's wording (`riskKindOf`, `src/domain/approvalRisk.ts:34-40`, kinds `RISK_KINDS = ['outside-workspace', 'destructive', 'leaves-machine', 'credentials', 'installs', 'unsure']`, `:7`). That is fine for a card sentence and **not** acceptable for a floor. Recommendation: add an optional `effects` tag to `CommandClassification` (`risky(reason, effects?)`, same for the two `unknown` returns named below), set it at the call sites listed in 4.3, and propagate it through every wrapper that rebuilds a result (for example `commandSafety.ts:625` `npm run` scripts, `:1083`, `:1093`, `:1108`, `:1112`: each does `risky(\`... ${inner.reason}\`)` and would drop the tag; pass `inner.effects`). A table test over every `risky(` site keeps this honest.

### 4.2 Credential stores outside the workspace

The file tools cannot reach them: `resolveInWorkspace` throws for anything outside the workspace and the read-only Open-GSD roots (`src/agent/workspace.ts:22-35`). So these rules only matter for **shell commands** (and for MCP and cyber host tools, which the gate cannot see into; say so in the manifest words). Follow `namesStateKeys`' honest heuristic (`src/domain/protectedPaths.ts:59-76`): a text check, plus resolving each word of the command against the shell's folder with `~` expanded (the machinery in `shellReachesStateKeys`, `src/agent/tools.ts:516-550`, which already does word resolution, `cd` bases, braces and globs). Put the pure matcher in `src/domain/gate/floor.ts` and the word-resolution adapter beside `shellReachesStateKeys`.

Today three separate regexes already describe credential paths: `SENSITIVE_FILE` (`src/agent/tools.ts:85`, workspace files such as `.env*`, `id_*`, `*.pem`), `KB_OR_SECRET` (`commandSafety.ts:320`: `.near-credentials`, `.near-kb`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker/config.json`, `.kbkey`, `state.vscdb`, `.git-credentials`, state folder) and `SENSITIVE_TEXT_BASE` (`:421`, adds `.env`, `id_*`, `.netrc`, `.npmrc`, `.pypirc`). The floor list below is a **new, separate** list for stores **outside** the workspace; workspace files like `.env` stay in `SENSITIVE_FILE` and keep today's behaviour (D-18).

**Confirmed list for D-16 (refuse with no card, every mode, every context):**

Must (named by D-16):
1. The project key folder: `STATE_KEYS_PATH`, `namesStateKeys`, `shellReachesStateKeys`, unchanged.
2. This extension's own storage: the folders `identity/` and `gate/` under the extension's global storage (`<globalStorage>/identity`, `<globalStorage>/gate`; the first holds `key-history.json` and the lock, `src/team/identity.ts:25-29`, `src/team/keyHistory.ts:27-29`). The adapter passes the real `globalStorageUri.fsPath`; the text matcher also matches the portable shape `globalStorage/vitalpoint.near-ai-vscode` (VS Code lowercases the extension id: publisher `VitalPoint`, name `near-ai-vscode`, from `package.json`).
3. `~/.near-credentials` (and its `.archive`).
4. SSH: the whole `~/.ssh/` folder (private keys `id_*`, `*.pem`; `known_hosts` and `config` come with it, deliberately).
5. Cloud and registry credential files: `~/.aws/` (credentials, config, sso cache), `~/.config/gcloud/`, `~/.azure/`, `~/.docker/config.json`, `~/.netrc`, `~/.git-credentials`.
6. OS keychain commands: `security find-generic-password`, `security find-internet-password`, `security dump-keychain`, `security export`, `secret-tool lookup`, `secret-tool search`.

Include because the classifier already treats them as credentials today (so the floor is consistent with what already asks) [VERIFIED: `commandSafety.ts:320`, `:421`]: `~/.gnupg/`, `~/.kube/`, `state.vscdb` and `state.vscdb.backup` (VS Code's own secrets database, which holds the encrypted SecretStorage including the device key: the most important single file after the extension's own folders), `.near-kb`, `.kbkey`, `~/.npmrc`, `~/.pypirc`.

Proposed additions, owner to confirm (all cheap; names come from general knowledge and are `[ASSUMED]`): `~/.config/gh/hosts.yml`, `~/.config/git/credentials`, `~/.cargo/credentials.toml`, `~/.terraform.d/credentials.tfrc.json`, `~/.local/share/keyrings/`, `~/Library/Keychains/`, `kwallet-query`, `cmdkey /list`, `pass show`, `gopass show`, and token printers `gh auth token`, `gcloud auth print-access-token`, `az account get-access-token`, `aws configure export-credentials`.

What the check cannot see, to be written in the floor's own words (same honesty as `namesStateKeys`): a path built at run time (variable, `$(...)`, base64, string arithmetic), a program that reads the store for the person (`git credential fill`, `ssh` itself using the key), a recursive walk from a parent folder, and anything an MCP server or the cyber host tools do. The real boundary arrives with Phase 72's sandbox.

### 4.3 Publishing and destruction: what to tag in `commandSafety.ts`

Tag `publish` at these existing `risky(` sites (line numbers from `commandSafety.ts`): `git push` `:539`; `git send-email` `:540` (channel `send`); gsd subrepo verbs `:509`; release-named scripts `:619` (`RELEASE_NAME`, `:447`); package manager `publish` and `unpublish` `:636` and the registry-account verbs `:637` (`publish, unpublish, deprecate, dist-tag, owner, adduser, login, logout, token, access, team, org, star, hook`); `npx vsce|ovsx publish` `:663` and `npx` release tools `:664`; `docker|podman push` and `image push` `:850` (but **not** `login` and `logout`, which are credentials); `kubectl|helm|oc` mutating verbs `:853` and `terraform|tofu|pulumi|cdk|serverless|sls` verbs `:854` (deploy); `gh|glab` release create, upload, edit, delete and `api` with a write method `:869-870` (release creation only; other `gh` writes stay settings-layer, see Open Question 3); the `vsce|ovsx|twine|gem|vercel|netlify|firebase|wrangler|fly|heroku|semantic-release|release-it|np|gh-pages` group `:880`; `cargo publish|yank|owner|login|logout` `:884`; `make` release targets `:896`; `near` transactions `:903` and cloud `aws|gcloud|az|gsutil` deploy verbs `:904`.

Tag `destroy` at: `git reset --hard|--merge|--keep` `:542`; `git clean` without dry run `:543`; `git rebase|filter-branch|filter-repo|replace` `:541` (history rewrite) and `git commit --amend` (today `unknown`, `:610`: tag the `unknown` return); `git branch` delete, move or force `:577`; `git tag` delete or move `:581`; `git stash drop|clear` `:584`; `git reflog expire|delete` `:595`; `git gc|prune` `:596`; `git update-ref` `:597`; disk destroyers `:773`; `rm -r` outside the workspace or decided at run time `:782`, `rm -r` of the workspace, `.git`, `.planning/.near-ai`, `.near-ai` `:783`, **and the `unknown` at `:786`** ("rm -r deletes folders inside the workspace") except the cases the classifier already calls scratch or build output (`:781`, `:786`); `rm` or `rmdir` outside the workspace `:790` and inside protected folders `:793`; `find -delete` `:797` and `find -exec rm` `:801`; `xargs rm` `:907`, `:1106`; `git push --force|-f|--delete|--mirror` is already `push`.

Same class, not named by D-17, recommend adding (owner to confirm, Open Question 2): `git checkout -- .`, `git checkout -f`, `git restore` of the worktree, `git switch --discard-changes` (`:545`, `:549`, `:556`: they discard uncommitted work like `reset --hard`).

Protected-path **writes** by shell commands are already detected: `facts.protectedWrite` (`commandSafety.ts:352`) feeds `risky('... where writes always ask')` at `:522`, `:793`, `:1125`. Tag those `protected-write`. The file tools use `protectedWrite()` (`src/agent/tools.ts:123-129`), which exempts `.planning/.near-ai/team.md` (`:126`); the floor must keep that exemption (amendment D-44).

### 4.4 Behaviour table for the floor

| Floor rule | `interactive` | no person (`unattended`, `routine`, `relay`) | card offers "always allow" | run-wide grant |
|-----------|---------------|---------------------------------------------|---------------------------|----------------|
| `floor.state-keys`, `floor.credential-store`, `floor.identity-files` | refused, no card | refused | no | no |
| `floor.protected-write`, `floor.publish`, `floor.destroy`, `floor.shared-write` | asks, every mode, including `fully-autonomous` | refused with a plain reason, recorded | no | no (a late approval of a sub-agent's card allows that call once) |
| workspace credential-file read (D-18) | settings layer, unchanged | settings layer | n/a | n/a |

The deny list still wins over a floor ask (a refusal is stricter), and `emergencyStop` first.

## 5. Capability grammar and exact v1 schemas (question 5)

### 5.1 Sources

IronClaw: each tool declares `effects` (for example `network`, `use_secret`, `external_write`), `default_permission` (`allow` or `ask`), an `origin_gate_matrix` (loop run, product call, automation), input schema, and credential handles with audience host and injection shape [CITED: `.planning/research/platform-direction/ironclaw-analysis.md` section 2.2]; recommendation R1 adds allowed hosts, credential handle names, and contexts `interactive`, `unattended`, `relay`, `routine`, with undeclared MCP tools most restrictive [CITED: same file, R1]. Hermes grammar: verb, resource, constraints, for example `shell{cwd:workspace}`, `network{hosts:[...]}`, `mcp{server, tools}`, `send{channel, chat}`, `schedule{max_per_day}`, `skill.write{scope}`, `spend{usd_per_run, usd_per_day}`, version it and reject unknown verbs [CITED: `.planning/research/platform-direction/hermes-analysis.md` section 6.2 H1]. A hardline blocklist nothing overrides [CITED: same file, line 95]. Authority-amplifying verbs withheld from leaves (delegate, memory, send_message, cronjob) become capabilities a child does not get unless delegated [CITED: same file, section 5.2].

Hard constraints from the signer that shape the schema [VERIFIED: `src/domain/team/canonical.ts:28-37`, `src/domain/team/signedPayload.ts:112-146`]: canonical JSON allows `null`, booleans, strings, **safe integers only** (`numbers must be safe integers`), nesting depth at most 16 (`MAX_DEPTH`), no lone surrogates; `signPayload` refuses a payload with a secret-like string or **key name** (`assertNoSecrets`); size limit `MAX_PAYLOAD_BYTES = 256 * 1024` (`signedPayload.ts:27`).

### 5.2 Vocabulary v1 (`gateVocabulary: 1`)

A capability is `{ verb, ...constraints }`. The same shape is a **request** (concrete values) and a **grant or ceiling** (patterns). Exact fields, all arrays non-empty where marked, every unknown field refused:

| verb | required constraints | optional | notes |
|------|----------------------|----------|-------|
| `read` | `paths: PathPattern[]` | | |
| `plan` | none | | |
| `workspaceWrite` | `paths: PathPattern[]` | | |
| `shell` | `cwd: "workspace" \| "anywhere"` | | |
| `network` | `hosts: HostPattern[]` | | `"*"` allowed in a ceiling only |
| `mcp` | `server: string`, `tools: string[]` | | `"*"` allowed in a ceiling |
| `send` | `channel: string` | | reserved for Phase 75+ |
| `publish` | `target: "git-remote" \| "registry" \| "container-registry" \| "release" \| "deploy" \| "chain" \| "*"` | | |
| `destroy` | `paths: PathPattern[]` | | |
| `spawn` | `agent: string` | | `"*"` allowed |
| `schedule` | none | `maxPerDay: integer` | Hermes' `max_per_day`; reserved |
| `skill.write` | `scope: "run" \| "project" \| "team" \| "user"` | | |
| `spend` | at least one of `nanoUsdPerRun: integer`, `nanoUsdPerDay: integer` | | amendment D-35: integers, not `usd` |
| `useSecret` | `handle: string` | `audience: HostPattern` | IronClaw's credential audience; reserved for Phase 73 |
| `infer` | `tier: "any-cloud" \| "attested-cloud" \| "local-only"`, `provider: string`, `model: string` | | `deny` is a decision, not a requestable tier |
| `gpu` | `device: string` | | reserved: parses, always refused |

`PathPattern`: project-relative POSIX glob matched with `matchesGlob` (`src/agent/glob.ts`, `*`, `**`, `?`, `[...]`, `{a,b}`), no `..`, no leading `/`, normalised with `normalizeRelative` (`src/domain/protectedPaths.ts:26`). `HostPattern`: lowercase host, `*.example.com`, or `*`; no scheme, port or path. A **manifest effect** may fill a constraint from the tool's input with a closed source form `{ "from": "input", "field": "<name>", "as": "path" \| "url-host" \| "literal" }` or the single extractor `{ "from": "command" }` for `Bash` (the classifier's effects fill the rest). No other source form exists in v1.

Refusal, plain words, one reason per failure, from a closed list in the same style as `PAYLOAD_FAILURES` (`signedPayload.ts:56-67`): unknown verb, unknown field, wrong type, empty list, unknown version (`vocabulary` not 1), `gpu` not available yet. Reuse the exact-key pattern of `src/domain/team/validate.ts` (`checkKeys`, `isRecord`, `isSafeIntegerInRange`; `validate.ts:35-52`) but copy the 20 lines into `src/domain/gate/shape.ts`: its `invalid()` hard-codes `TEAM_REJECTION_REASONS.invalidBody`, which is a team-specific message. A new version is added beside v1 (`gateVocabulary: 2`), never by editing v1 (D-03).

### 5.3 Manifests v1

```json
{ "manifestVersion": 1, "tool": "Write", "effects": [ { "verb": "workspaceWrite", "paths": [ { "from": "input", "field": "file_path", "as": "path" } ] } ],
  "hosts": [], "credentials": [], "contexts": ["interactive", "unattended"], "untrusted": false, "runsOn": "this-machine" }
```

Fields: `manifestVersion` (1), `tool` (the tool name), `effects` (at least one; `plan` is an effect), `hosts` (HostPattern[], the union a tool may contact), `credentials` (handle names matching `^[a-z][a-z0-9._-]{0,63}$`), `contexts` (closed: `interactive`, `unattended`, `relay`, `routine`), `untrusted` (boolean, today's `untrusted` flag), `runsOn` (`this-machine` or `remote`; stdio MCP is `this-machine`). Built-in manifests are code (a required `manifest` field on `AgentTool`, `src/agent/tools.ts:50-82`), so a tool cannot be added without one at compile time. They are not signed (they ship in the extension).

MCP: stored on `McpServerConfig` (`src/mcp/client.ts:9-19`, which today has `id, name, transport, command, args, approval, disabledTools`) as an optional `manifest`:
`{ manifestVersion: 1, server, runsOn, hosts, credentials, contexts, tools: { "<toolName>": { effects, contexts? } }, toolDefaults: "restrictive" \| "legacy" }`. The restrictive default effects are exactly D-06's: `shell{cwd:"anywhere"}`, `network{hosts:["*"]}`, `workspaceWrite{paths:["**"]}`, `destroy{paths:["**"]}`. A stdio server's contexts default to `["interactive"]` only. `McpServerConfig` lives in VS Code `globalState` (`SERVERS_KEY`, `mcpRegistry.ts:23`), so adding an optional field needs no migration of stored data (absent means `legacy`, amendment D-38).

### 5.4 Policy bundle v1 (the signed payload)

Signed with `signPayload(identity, 'policy-bundle', payload)` (purpose already exists, `signedPayload.ts:25`); the signer, `signedAt` and the signature are in the envelope, so `issuer` and `issuedAt` in the payload repeat them on purpose (D-12) and a test asserts they equal the envelope's.

```json
{ "bundleVersion": 1, "vocabulary": 1,
  "issuer": { "fingerprint": "dev-...", "publicKey": "<43 chars>" },
  "issuedAt": "2026-11-16T00:00:00.000Z", "expiresAt": "2027-11-16T00:00:00.000Z",
  "ceiling": { "maxMode": { "interactive": "fully-autonomous", "unattended": "fully-autonomous", "relay": "approve-risky", "routine": "approve-risky" },
               "contexts": { "<verb>": ["interactive", "unattended"] }, "unattendedMcp": [] },
  "scales": { "org": { "name": "Commercial", "levels": ["Public", "Internal", "Confidential", "Restricted"] }, "ca-protected": {...}, "ca-classified": {...}, "nato": {...} },
  "mappings": [], "clearances": [ { "scale": "org", "level": "Restricted", "compartments": [], "releasability": [] } ],
  "routing": { "levels": { "org/Public": "any-cloud", "org/Internal": "attested-cloud", ... }, "handling": { "local-only": "local-only" }, "compartments": {} },
  "defaultLabel": { "scale": "org", "level": "Public", "compartments": [], "releasability": [], "handling": [] },
  "anchorRoots": [], "statusLists": [], "maxOfflineAge": {} }
```

Notes: `maxMode` values are the four `ActionPolicyMode` strings; `relay` and `routine` default to `approve-risky` because no such context exists yet. Everything is integers or strings (no floats), depth under 16, size a few KB. Reserved fields `anchorRoots` (array of `{ root, proof }` shape-checked, empty), `statusLists` (array of `{ uri, purpose }`, empty), `maxOfflineAge` (object scale/level to whole seconds, empty) are validated for shape and ignored (D-12). An unknown field anywhere is refused. The bundle hash for records is `sha256` of `canonicalBytes(payload)`.

Failure vocabulary (D-13). The verifier's closed reasons are `malformed`, `unsupported-version`, `unknown-purpose`, `wrong-purpose`, `too-large`, `key-mismatch`, `bad-signature`, `unknown-key`, `key-revoked`, `key-rotated` [VERIFIED: `PAYLOAD_FAILURES`, `signedPayload.ts:56-67`]; the gate adds `missing`, `unparseable`, `expired`, `vocabulary-unknown`, `unknown-field`, `no-identity` and `clock-behind`. Each maps to one plain sentence naming the cause and the fix. Rotation: a bundle signed before a rotation still verifies (`key-rotated` only refuses payloads signed at or after the rotation), a revoked key refuses everything, so renewal after a rotation re-signs with the new key.

### 5.5 Labels, scales, mappings, routing tiers

Label: `{ scale: string, level: string, compartments: string[], releasability: string[], handling: string[] }`. `level` is the level's name from the scale's ordered list (D-22). `compartments` and `releasability` entries match `^[A-Z0-9][A-Z0-9_-]{0,31}$`, sorted, unique. `handling` is a closed list in v1: `local-only`, `attested-cloud-ok`. Unknown scale, level, handling value or field: refused.

Presets (D-23), each an ordered list, id then levels: `org`: Public, Internal, Confidential, Restricted. `ca-protected`: Protected A, Protected B, Protected C. `ca-classified`: Confidential, Secret, Top Secret. `nato`: NATO Unclassified, NATO Restricted, NATO Confidential, NATO Secret, Cosmic Top Secret. Routing keys are `scale/level`, so `org/Confidential` and `ca-classified/Confidential` are different keys. Mapping entry: `{ "from": { scale, level }, "covers": { scale, level } }`, meaning a clearance at or above `from` on its own scale covers labels up to and including `covers` on the other scale; none ships by default (CLAS-02).

Default routing table (CLAS-05, D-30): `org/Public` any-cloud; `org/Internal`, `org/Confidential`, `ca-protected/Protected A` and `nato/NATO Unclassified` attested-cloud; `org/Restricted`, `ca-protected/Protected B`, `ca-protected/Protected C`, every `ca-classified/*` and every NATO level above NATO Unclassified local-only. `routing.compartments` maps a compartment to `deny` (or any tier). `routing.handling` ships with only `"local-only": "local-only"`: a `handling` flag may only tighten unless your organization adds `"attested-cloud-ok"` to the bundle, otherwise a person could relax routing by labelling (Open Question 4).

### 5.6 Label map v1 (`.planning/.near-ai/labels.json`, purpose `label-map`)

Signed envelope, payload `{ "labelMapVersion": 1, "vocabulary": 1, "project": <Label>?, "entries": { "<project-relative path>": <Label> } }`. Folders end with `/`. Keys are normalised with `normalizeRelative`. Resolution order (CLAS-01, D-25): the file's own entry, then the nearest labelled ancestor folder, then the project entry, then the bundle `defaultLabel`. Limits to state in the plan: the whole signed envelope must stay under 256 KiB (`MAX_PAYLOAD_BYTES`), so refuse a label write that would pass about 200 KiB with a plain message; a path key that looks like a secret makes `signPayload` throw (`assertNoSecrets` also checks key names, `secrets.ts:89`), so catch `PayloadError` and say which path. The `label-map` purpose is a one-line addition to `PAYLOAD_PURPOSES` plus the test changes in 3.5; adding a purpose does not change any existing signature (the purpose is in the signed bytes, `signedPayload.ts:77-79`).

## 6. OCSF decision record (question 6)

[VERIFIED: live OCSF schema API, `https://schema.ocsf.io/api/version` returned `{"version":"1.9.0"}` and `/api/classes/api_activity`, `/api/objects/*`, this session]

Choice: **one class for everything, API Activity (`class_uid` 6003, `category_uid` 6 Application Activity)**, using the `ai_operation` profile (it adds `ai_agent`, `ai_model`, `delegation`, `message_context`; the schema's own description: "AI-specific attributes for model operations, retrieval systems, and agent activities") and `authorizations`. Rationale: one builder and one validator; OpenShell already emits `API:` (6003) for inference calls [CITED: `.planning/research/platform-direction/openshell-analysis.md` line 74]; the gate "API" is the use of a capability. Bundle load and verification events can use the same class with `api.operation: "policy.load"` now and move to class 5019 (Device Config State Change, which OpenShell uses as `CONFIG:`) later without changing the stored shape of the rest. Do not claim schema-validity: D-20 says "shaped after OCSF".

Why this also suits the later audit chain: OCSF `time` is an integer epoch in milliseconds, `severity_id`, `activity_id`, `action_id` are small integers, so a record is canonical-JSON-safe (integers only) and can be hashed and signed without a shape change.

Field mapping (decision record `recordVersion: 1`, kept in `unmapped.nearAi`, OCSF's own place for source-specific fields):

| Record need (D-20) | OCSF field | Value |
|-------------------|------------|-------|
| class and activity ids | `class_uid` 6003, `category_uid` 6, `activity_id`, `type_uid` = 600300 + `activity_id` | `activity_id`: 2 Read for `read` and `plan`, 1 Create or 3 Update for `workspaceWrite`, 4 Delete for `destroy`, 99 Other (with `activity_name` = the verb) for the rest |
| time | `time` | epoch ms integer |
| severity | `severity_id` | 1 Informational for allow, 3 Medium for ask and approve, 4 High for floor and denials |
| actor (person, agent session, sub-agent, device) | `actor.user.uid` = device fingerprint, `actor.session.uid` = conversation or run id; `ai_agent` = `{ name, uid, instance_uid, ai_model: { name, ai_provider } }` for an agent or sub-agent | |
| capability in vocabulary form, resource | `api.operation` = verb; `api.request.uid` = call id; `resources[]` = `[{ name, type, uid }]`; the full capability as `unmapped.nearAi.capability` | |
| outcome | `action_id` 1 Allowed or 2 Denied; `disposition_id` 1 Allowed, 2 Blocked, 8 Approved, 25 Rejected, 26 Unauthorized; `status_id` 1 Success or 2 Failure | `allowed`: 1/1; `asked`: 3 Observed with `status_detail` "waiting for a person"; `approved`: 1/8; `denied`: 2/25; `refused-by-floor`: 2/2; clearance failure: 2/26 |
| rule that decided | `authorizations[0]` = `{ decision, policy: { name: <rule id>, uid: <bundle hash>, version: "bundle-1", is_applied: true } }` | stable ids such as `floor.git-write` |
| bundle hash | `authorizations[0].policy.uid` and `unmapped.nearAi.bundleHash` | |
| session label | `metadata.data_classifications[]` = `{ confidentiality: "<scale>/<level>", confidentiality_id: 99, category_id: 99 }`; full label in `unmapped.nearAi.label` | the OCSF enum has no scale concept, so 99 Other |
| record id, versions | `metadata` = `{ version: "1.9.0", product: { name, vendor_name, version }, profiles: ["ai_operation"], uid, sequence }` (`product` needs `name` or `uid` per its own constraint) | |
| model routing | `api.operation: "infer"`, `ai_model: { name, ai_provider }`, tier in `unmapped.nearAi.tier` | |

OCSF lists `src_endpoint`, `cloud` and `osint` as required in the merged class view; `cloud` and `osint` come from profiles this record does not declare, and `src_endpoint` needs one of ip, name, uid and so on; use `{ name: "near-ai-vscode" }` [ASSUMED for the profile-origin of `cloud` and `osint`; the API response I read had no `profile` marker on them]. The record validator in `src/domain/gate/record.ts` should check only what the shape needs (class, ids, `type_uid` arithmetic, required keys, integer-only values, no secrets) and be pinned by a golden-file test. Records go to `<globalStorage>/gate/decisions/<project key>.jsonl` (D-21), never into the workspace.

## 7. SecretStorage, code-server and Linux without a keyring (question 7)

What exists: the extension already depends on SecretStorage for the API key (`SecretStorageLike`, `src/services/auth.ts:9-13`; `secrets.store(API_KEY_SECRET)`), for the transcript key (`transcriptKey`, `src/services/transcripts.ts:42-52`) and for the key history head (`KEY_HISTORY_HEAD_SECRET`, `src/team/keyHistory.ts:29`). Nobody who uses the extension today has a working install without it. The device key is `DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey'` (`identity.ts:20`) created by `loadOrCreateDeviceIdentity(secrets, { identityDir })` (`identity.ts:138-160`), which locks, creates, **reads back** and throws `The new identity key could not be read back from this computer's secret storage, so it was not used.` when SecretStorage does not hold it. No code in `src` handles a missing keyring (`grep -i "keyring|libsecret|safeStorage"` finds nothing).

code-server: its secret storage is browser-persisted, encrypted with a key the server provides: "secret storage had become browser-only, and the browser only persists storage if it gets a key from the server to do encryption" [CITED: https://github.com/coder/code-server/pull/6450]. The owner's own setup is a code-server container (project memory `code-server-location`). Consequences:
1. The create-on-install path works wherever the API key already works, so D-14 does not break current users on first run.
2. A **different browser, a cleared browser profile, or a new code-server container with the old data folder** loses the device key while the extension's `identity/key-history.json` and `gate/policy-bundle.json` on the server's disk remain. The key history head is also in SecretStorage, so `ensureCreatedRecord` archives the old history and starts a new key (`identity.ts:100-125` comment: "a history that is broken, or whose active key is not the person's stored key, is never repaired or deleted: archiveKeyHistory renames it beside the original"), after which the old bundle reads `unknown-key`. Per D-13 that means read and plan only until the person acts. For people on code-server that would repeat after every browser reset.
3. Hidden browser tabs lose their extension host about five minutes after disconnect (project memory), so activation-time work must be idempotent and lock-protected: two windows may both find no bundle. Use `withFileLock(<globalStorage>/gate, 'bundle.lock', ...)` as `identity.ts` does.

Desktop VS Code on Linux without a keyring: VS Code falls back according to its own platform rules; the extension cannot detect this beyond the read-back check above [ASSUMED: no documentation read this session for the basic-text fallback]. Fail-closed design when SecretStorage cannot hold the key: the gate enters state `identity-unavailable`, decides with floor plus read and plan only, the status bar and setup step say "NEAR AI could not save its signing key on this computer, so only reading and planning are allowed until it can" and the command offered is the retry; never retry on every decision; log one record. The current user is **not** locked out of their chats: only tools that change things stop, which is exactly what fail-closed means here, and it is the same message the Team Mode create path would show.

Recommended refinements (amendment D-39): (a) distinguish *no bundle* (fresh install: self-sign) from *a bundle that existed* by keeping a marker in SecretStorage next to D-15's clock marker (`nearAi.gate.lastValid` with the last valid bundle's hash and time). If the marker exists and the file is missing or fails, **do not self-sign silently** (an agent or hostile repo script that deletes the file must not reset the policy); only the person's Reset command does, and it is recorded. If the marker is **absent** too (new browser, fresh SecretStorage), that is a fresh install from the extension's point of view: self-sign. (b) When the signer is unknown (key lost) and the stored bundle equals the shipped default bundle (never customised), re-sign automatically and record it; if it was customised, ask. This removes the "every browser reset needs a manual fix" cost for people who never customised policy.

D-15 clock rule: store `{ at, hash }` of the last valid bundle in SecretStorage; compare expiry against `max(now, at)`. Without SecretStorage the clock rule cannot work and the state is already `identity-unavailable`.

## 8. Attestation, local and hybrid (question 8)

### 8.1 What attestation does today

`src/services/attestation.ts` verifies **one response, after the fact**: `GET /v1/signature/{chat_id}` then `GET /v1/attestation/report` with a fresh nonce, request and response hashes compared with SHA-256 of what was sent and received, EIP-191 signature recovered to the signing address, TDX quote verified against Intel's chain; it states what it does not check (platform TCB status and revocation, enclave measurements, NVIDIA verdict) [VERIFIED: header comment and `NOT_CHECKED_IN_EDITOR`, `attestation.ts:1-30`]. Its only caller is `AgentConversation.verifyRun(runId)` (`agentSession.ts:696-701`), which "checks NEAR's signature and TDX attestation for a run's final answer" for the last 20 runs (`:700` message: "only the last 20 are kept"), driven by a person's click. It runs for no request automatically, needs the network (two GETs), and gates nothing.

What marks a model as TEE before sending: `modelPrivacy(metadata)` returns `{ privacyBoundary: 'tee' }` when `metadata.attestationSupported === true && metadata.providerType !== 'external'` (`nearAiClient.ts:1081-1082`), else `'cloud'` with `forwardedTo`; local runtime models are forced to `'local'` (`listLocalModels`, `nearAiClient.ts:384-388`). The endpoint check is `isNearCloudEndpoint(baseUrl)` (`src/domain/config.ts:~21-33`). `routeAllows(route, model)` (`agentSession.ts:226-230`) already combines them for `privacy: private` team members: `return route.kind === 'near' && route.attestation && model.privacyBoundary === 'tee';`.

### 8.2 What `attested-cloud` can honestly mean

CLAS-05 and D-31 say "only NEAR AI Cloud models whose attestation and response signature verified for this request". That cannot be a precondition of sending (the signature exists only after the response, keyed by the response's `chat_id`). Recommended meaning (amendment D-36): **before sending**, the model must be `privacyBoundary === 'tee'` per the cached catalog and the route must be NEAR's own endpoint (`routeAllows`); an unknown model or an unloaded catalog counts as not private for every tier above `any-cloud`. **After each response**, run `verifyResponse` in the background when online, record `route.attestation.verified | failed | unavailable`, and on `failed` stop the run's further model requests at this tier and say why in the chat (the content already went to the enclave's claimed address, and the failed check says it may not have). Cache a verified attestation report per signing address for a short time (say 10 minutes, `[ASSUMED]`) so a 60-turn run does not make 120 extra requests. This keeps OFFL-01 true: the **decision** uses only the cached catalog and local data, the verification is a separate, recorded, networked check that never blocks the next decision on its own latency.

### 8.3 `local-only`

`local-only` uses today's profiles: `ProviderKind = 'near-ai' | 'local' | 'hybrid'` (`src/domain/auth.ts:17`); a `local` profile's primary client serves local models, a `hybrid` profile adds `localClient` for a second endpoint (`providerFactory.ts:14-25`); `clientFor(active, model)` picks the local client when the model's `privacyBoundary === 'local'` or the provider is `local` (`providerCache.ts:60-64`); `privateRouteFor` (`providerCache.ts:70-73`) returns `{ kind: 'local', attestation: false }` for local routes.

**Defect to settle (amendment D-37):** the setup prompt accepts any `https://` address as "Local runtime URL" (`src/extension.ts:294-295`, `validateInput: ... 'Use http://localhost, http://127.0.0.1, or an https:// URL.'`, and `isSecureEndpoint` allows https anywhere, `src/domain/config.ts:49-55`). A profile pointing at `https://some-server.example/v1` is typed `local` and all its models get `privacyBoundary: 'local'`. `local-only` ("no content leaves the machine") must therefore require the client's host to be loopback (`localhost`, `127.0.0.1`, `[::1]`, the same list as `LOOPBACK_HOSTS`, `config.ts:49`), or a host the bundle names in a new `routing.localHosts` list for people who run a model on their own LAN. Without this the CLAS-06 sentence "never sent to a cloud" is false for a misconfigured profile.

CLAS-06 flow: tier `local-only` plus no `route: 'local'` client configured, or no local model in the cached catalog, or the local host not loopback: the request throws a plain `RouteRefusedError` before `fetchFn`. Hybrid: the guard judges the client that the call is using, not the profile, because `clientFor` already routes by model.

## 9. Labels, the session mark, renames and chat metadata (question 9)

### 9.1 Where things live today

- A run's shared mutable state: `RunGrants` (`src/agent/permissions.ts:122-157`), one per run, shared with every sub-agent (`agentSession.ts:1022`, `grants`), already carrying `tainted` and `taintedAt` "shared with every sub-agent". Put the high-water mark in an object with the same lifetime (a `SessionMark` held by `RunGrants`, or beside it, constructed once per run). A child sharing the parent's object starts at the parent's mark and **also raises the parent's**, which is the safe reading of D-29 ("messages it sends and summaries it makes carry it": the lead consumes the child's report). State this in the plan, because D-29 literally says only "start at their parent's mark".
- A conversation across runs: `AgentConversation` (`agentSession.ts:~237`), id `conversationId`. Persist the mark with the chat so a restored chat keeps it: `ThreadMeta` (`src/services/threadStore.ts:29-52`) takes extra fields without validation changes (`validMeta` spreads the stored object, `:92-100`) but `mergeMeta` (`:82-89`) picks the newer whole meta, so a sync of a lower mark could overwrite a higher one: add a `label` field and make `mergeMeta` join labels (raise-only). `TranscriptSummary` (`src/services/transcripts.ts:5-9`) is the second place; keep it in sync or drop it from the list view.
- Chat UI: status messages to the webview go through `post`; show the label in the chat header next to the model (`media/chat/chat.js`).

### 9.2 What raises the mark

Reads through file tools: `Read` (path label), `Glob` and `Grep` (the labels of the paths **returned**: `GrepLine.file` attributes each line to a file, `src/agent/tools.ts:376`, and `Grep` already filters credential files per line, `:363-370`; do the same for files whose label the clearance does not dominate). Tool output: results from MCP, web and attachments take the session mark and, when a manifest or the label map labels their origin, raise it. Shell: best effort. The classifier knows which paths a command names (`pathFacts`), so a command that **names** a labelled path raises the mark; a command that reads one through a variable, a glob or a program cannot be seen (say so in D-40's wording). A Bash call in a project with any label above the default should not be treated as reading everything; that would make the mark useless.

Writes: after a successful `workspaceWrite` effect the gate raises the label map entry for that path to the mark (never lowers), batched and debounced (write the signed map at most every few seconds and at run end), and only when the mark is above the path's current label, so a fresh install with the default `org/Public` mark never touches `labels.json`. The map file is committed with the project, so avoid rewriting it for no change.

### 9.3 Dominance and join (exact algorithm, CLAS-03)

Clearance `C = { scale, level, compartments, releasability, expiresAt? }`, label `L`.
`dominates(C, L, bundle, now)` is true only when all hold: (1) `C.scale === L.scale`, or a mapping `{ from, covers }` has `from.scale === C.scale`, `covers.scale === L.scale`, `index(C.level) >= index(from.level)` and `index(L.level) <= index(covers.level)`; (2) for the same scale, `index(C.level) >= index(L.level)`, both indexes from the bundle's ordered list, an unknown level is false; (3) `L.compartments` is a subset of `C.compartments`; (4) if `L.releasability` is non-empty, it shares an element with `C.releasability` (an empty clearance releasability cannot read a releasability-restricted label); (5) `C.expiresAt` is absent or after `now`. Absent evidence of any of these is **no access**. A **mark** is a set of labels, one per scale; `join` takes, per scale, the higher level, the union of compartments, the union of handling, and the intersection of non-empty releasability sets (an empty set means unrestricted, so the other side's set wins). A mark is dominated when every element is. Property test: with a seeded pseudo-random generator (a 20-line xorshift in the test file, no dependency), generate bundles, clearances and labels, and assert `dominates` implies each of the five conditions and that removing any one clearance attribute never turns a denial into an allowance.

### 9.4 Renames, moves and copies (D-26)

No agent tool renames or moves files: `CORE_TOOLS` is `[readTool, writeTool, editTool, globTool, grepTool, bashTool, bashOutputTool, killShellTool, todoTool]` (`tools.ts:632`). So "renames through the agent's file tools" (D-26) means only: (a) `vscode.workspace.onDidRenameFiles` for Explorer renames and refactors, which updates the map entry; (b) shell `mv` and `git mv`, recognised from the classifier's parse of `WORKSPACE_WRITERS = new Set(['mkdir', 'touch', 'cp', 'mv', 'tee'])` (`commandSafety.ts:442`), best effort; (c) on load, entries whose path no longer exists are reported once as "labelled path missing" instead of silently dropped; (d) a file written by the model from labelled content (a copy through the model) takes the mark by the write rule above. A rename done by anything else loses the file's own entry but keeps its folder's label, as D-26 says; the label settings text must say it. Amendment D-42.

## 10. UI surfaces (question 10)

| Surface | Existing pattern | What to add |
|---------|------------------|-------------|
| Tools page | `buildToolsDirectory` (`src/services/toolsDirectory.ts`), `DirectoryTool.notes: string[]` (`:29`, built in `toolEntry` `:137-152`), rendered by `media/tools/tools.js` | `manifestWords: string[]` per tool and per MCP server, from one pure `describeManifest()` in `src/domain/gate/words.ts` (D-07). Cheapest display: push the words into `notes`, so the webview needs no change. Add `TeamKnowledge`, `Learn` and the cyber tools to the directory (via `toolCatalog`) |
| MCP page | `src/services/mcpView.ts` plus `media/mcp/mcp.js`; `McpServerStatus` (`mcpRegistry.ts:14-25`) | show the manifest words and the stdio sentence "Runs on this machine with your permissions"; a way to choose `restrictive` or declared effects when adding a server |
| Team member cards | `src/services/teamStudioPage.ts` (908 lines, members with `tools`) | words per tool name for each member's tool list |
| Status bar | `createTeamStatusBar` (`src/services/team/teamStatusBar.ts:56-70`): pure `statusText()` plus a thin VS Code wrapper, `createStatusBarItem('nearAi.team', Left, 50)`; others `nearAi.security` Right 90 (`securityScan.ts:45`), emergency stop Left 1000 (`emergencyStop.ts:71`) | `nearAi.gate` item: policy state (valid, renewing, failed closed with the one-sentence fix) and the session label; keep the text builder pure and tested |
| Setup view | `SETUP_STEPS` registry, `registerSetupStep(step, 'after')`, `registerSetupFacts` (`src/services/setupSteps.ts:1-60`) | a "Policy" step whose `isDone` is "bundle valid", showing the same sentence as the status bar |
| Commands | 44 commands in `package.json` `contributes.commands`; menus today only `commandPalette` and `view/title` | `NEAR AI: Set Label` (also `explorer/context`, a new menu contribution), `Lower This Chat's Label`, `Show Policy`, `Reset Policy to Defaults`, and amendment D-41 `Edit Policy` |

"Show Policy" must be read-only: the bundle is a signed file, and any edit invalidates it (D-33 says clearance editing is "through Show Policy", which cannot work: Open Question 1 and amendment D-41).

## 11. Size estimate and PR grouping (question 11)

Reference sizes [VERIFIED: `git diff` byte counts]: Phase 69 part 1 (`1cbcb9b`): 72 files, 958,828 bytes, of which source 272,765 bytes and tests 550,969 bytes (tests about twice the source). Part 2 (`f2ca69e`): 49 files, 481,821 bytes. Estimate for Phase 70 (`[ASSUMED]`, from lines per module below at about 55 bytes per line, tests at 2x): pure domain (`vocabulary`, `shape`, `manifest`, `words`, `labels`, `dominance`, `routing`, `bundle`, `floor`, `decide`, `record`) about 2,800 lines; `src/gate` stores and clock marker about 800; adapters in loop, cyber, MCP, client guard, session mark about 700; UI about 600; 40 manifests about 250; classifier effect tags about 150 changed lines; docs about 8 KB. Source about 330 KB, tests about 650 KB, total about 1.0 MB (range 0.85 to 1.2 MB). Over one PR; under three.

Recommended grouping (each PR leaves `main` green and the extension usable, D-34):

| PR | Contents | Size | Notes |
|----|----------|------|-------|
| 0 | planning only: CONTEXT, this research, VALIDATION, plans | docs | first, as Phase 69 did |
| 1 | pure foundation: `src/domain/gate/*` (vocabulary, shape, manifest, words, labels, dominance, routing, bundle, floor facts, decide skeleton, record), `label-map` purpose and its two test edits, boundary test rules, property and golden tests. No behaviour change | 350 to 450 KB | nothing imports it from `loop.ts` yet |
| 2a | the gate in shadow: `toolCatalog`, `manifest` on all 40 tools (required field), `src/gate` stores (bundle, clock marker, decision log), gate host, `AgentRun` and `cyberRun` call `decide` and record, but the floor rules are not enabled and every decision equals today's; MCP legacy manifests; Tools page words; status bar and bundle lifecycle; route guard and session context in `NearAiClient` | 450 to 600 KB | parity tests prove no change |
| 2b | **the floor flip plus documentation, never split**: enable floor rules, `commandSafety` effect tags, `protectedPaths.test.ts:304` rewrite, new floor tests, SECURITY.md and README edits | 100 to 200 KB | D-34 |
| 3 | labels and routing live: label map store and signing, session mark, dominance enforcement, tier enforcement in the guard, `ThreadMeta` label, commands (Set Label, Lower, Show, Reset, Edit Policy), chat label, SECURITY.md label section with the CLAS-07 wording | 400 to 550 KB | |

If 2a runs over 950,000 bytes, move the route guard and session context into PR 3 (they are independent of the tool gate).

## 12. CLAS-07 and D-27 against what the gate guarantees (question 12)

D-32 wording: "Labels and routing are an organizational control that helps prevent mistakes. They do not make this device accredited for classified information, and until verified credentials arrive your clearance is what you declared yourself." Sentence by sentence:

| Sentence | True of the code? | Gap |
|----------|-------------------|-----|
| "Labels and routing are an organizational control that helps prevent mistakes." | Yes | none |
| "They do not make this device accredited for classified information." | Yes (CLAS-07 requires it) | none |
| "...until verified credentials arrive your clearance is what you declared yourself." | Yes: the clearance is in the person's own device-signed bundle (D-27) | add that it is not an enforced boundary |

The wording is accurate but **incomplete**: it leaves out the guarantees that are the most likely to be over-read. What the gate does **not** guarantee, each found in code:
1. **Shell reads and network exits are heuristics.** Mark raising from shell reads works only for paths a command names; network tools at a `local-only` mark are refused for `network`, `send`, `publish` and MCP network effects, but a Bash command is judged by `NETWORK_COMMAND` (`src/agent/untrusted.ts`) and the classifier, text checks that "cannot see a path built at run time" (`protectedPaths.ts:66-73`). There is no OS sandbox around the shell until Phase 72 (SECURITY.md says so).
2. **`attested-cloud` is evidence after the fact**, not proof before sending (Section 8.2).
3. **`local-only` trusts the configured URL**: a "local" profile can point anywhere (Section 8.3).
4. **The labels and the bundle are signed by the person's own key**, held in the same editor storage as other secrets; a person who can write a bundle can write any clearance (D-27), and the label map can be deleted from the project by anything that can delete project files (the floor asks for writes under `.planning/.near-ai/` but a person can approve).
5. **MCP servers and the cyber host tools are opaque**: their manifests are declarations ("a claim for third-party MCP servers; it narrows what we allow, it does not prove what the server does" [CITED: `ironclaw-analysis.md` R1 risks]).

Recommended replacement wording, for use where labels are set and in SECURITY.md (amendment D-40): "Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary." Each sentence is checkable against a test or a documented limit above. A test should assert the exact string is present in SECURITY.md and in the label command's text (a docs-parity test, which the repo does not have yet; the existing pattern is `package.json` setting text checked by tests).

D-27's must-carry statement ("self-asserted ... must not be described as an enforced clearance boundary") is consistent with the code: the clearance is read from the bundle at `src/gate` load time, and nothing verifies it against anything else.

## Architecture Patterns

### System architecture

```
 person / model / sub-agent / panel step                       model request (any site, Section 2)
        |                                                               |
        v                                                               v
  AgentRun.executeCall (loop.ts:589)                       NearAiClient.request (nearAiClient.ts:897)
  cyberRun step (cyberRun.ts:353)                          content path? (BILLABLE_PATHS) -- no --> proceed
        |  parse + title                                         | yes
        v                                                        v
  tool facts: forbidden / sensitive / risky   --->   gate.route(sessionCtx.mark, client.route, catalog[model])
  command effects (classifier tags)                      | tier from bundle routing + handling + compartments
        |                                                | refuse -> RouteRefusedError (plain), record
        v                                                v
  gate.decide(request, bundle, context)  [src/domain/gate/decide.ts, pure]        send; later verify (record)
   1 emergency stop  2 bundle state (fail closed)  3 FLOOR  4 bundle ceiling
   5 label dominance 6 settings layer = decidePermissionAsync (unchanged)  7 record (OCSF)
        |
   allow --------> tool.run ----> raise mark from output / writes ----> label map (debounced, signed)
   ask  ---------> approval card (transport only; no grant, no always-allow when floor) --> reply --> record --> re-decide
   deny/refuse --> plain reason to the model and the person
```

### Recommended project structure

```
src/domain/gate/        # pure, no vscode, imports only src/domain
  vocabulary.ts shape.ts manifest.ts words.ts labels.ts dominance.ts routing.ts
  bundle.ts floor.ts decide.ts record.ts
src/gate/               # Node I/O + SecretStorageLike
  bundleStore.ts labelMapStore.ts decisionLog.ts clockMarker.ts sessionMark.ts host.ts
src/agent/toolCatalog.ts        # all 40 built-in tools, used by toolsDirectory and tests
src/services/gateStatusBar.ts gateCommands.ts   # VS Code adapters
src/test/gate*.test.ts
```

### Pattern: layer, do not rewrite
**What:** `decide()` calls the existing `decidePermissionAsync` as its settings layer and only adds floor, ceiling, labels and recording around it.
**Why:** it keeps `autoApproval.test.ts` and 25 `AgentRun` tests unchanged in meaning (D-10).

### Pattern: ambient session context for routing
**Example (follows `withSpendTag`, `src/services/spendLedger.ts:27-33`):**
```typescript
const routeContext = new AsyncLocalStorage<{ mark: SessionMark; actor: ActorRef }>();
export function withSessionRoute<T>(ctx: { mark: SessionMark; actor: ActorRef }, work: () => T): T { return routeContext.run(ctx, work); }
```

### Anti-patterns to avoid
- **A second signer or a second bundle format.** One `signPayload` (Phase 69 D-10).
- **Parsing reason text for a floor.** Use structured `effects` tags on the classifier result (Section 4.1).
- **Making `gate` required on `AgentRun`.** 19 test files would need edits for no gain; default it and scan production call sites.
- **Putting `AgentTool.manifest` as optional.** The compile error on a missing manifest is the cheapest enforcement of GATE-02.
- **Treating the OCSF record as a signed log now.** It carries `recordVersion: 1` so the later chain can sign it; do not add hashing chains in this phase.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Signing and verifying bundle and map | a new signer | `signPayload`, `verifyPayload`, `localKeyStatus` | purpose binding, rotation, revocation already tested (`teamSignedPayload.test.ts`, `teamKeyRotation.test.ts`) |
| Canonical form and hashes | `JSON.stringify` | `canonicalize`, `canonicalBytes` | sorted keys, integer-only, frozen vectors |
| Cross-window creation safety | ad hoc flags | `withFileLock` | the same race exists as for the device key (`identity.ts:130-160`) |
| Shell command effects | new shell parser | the existing lexer and classifier in `commandSafety.ts` (1,184 lines) plus tags | it already handles quoting, substitution, `cd`, xargs, find -exec |
| Word resolution against the shell's folder | new resolver | `shellReachesStateKeys` machinery (`tools.ts:516-550`) | handles `cd`, `{a,b}`, globs, links |
| Redaction in records | new regexes | `redactSecrets`, `findSecrets` | `src/domain/redaction.ts`, `src/domain/team/secrets.ts` |
| Spend and session tags | a new ambient store | `AsyncLocalStorage` in the style of `withSpendTag` | already proven across async generators in this repo |
| TEE and endpoint tests | new checks | `routeAllows`, `isNearCloudEndpoint`, `modelPrivacy` | already specify who counts as private |

**Key insight:** every hard part (signing, canonical bytes, shell text analysis, TEE status, session scoping) already exists and is tested; the phase is wiring plus a pure core, and the risk is in the seams (contexts, defaults, tags that get dropped by wrappers), not in new algorithms.

## Common Pitfalls

### Pitfall 1: A required `gate` option breaks 19 test files, an optional one is skipped in production
**What goes wrong:** 34 `new AgentRun(` calls in tests have no gate. **How to avoid:** optional option whose default is a gate built from the default bundle and the floor (same policy as a fresh install); a source-scan test asserts `agentSession.ts` (twice) and `benchmark/runner.ts` pass `gate:` explicitly. **Warning sign:** a production `AgentRun` with no `gate` property.

### Pitfall 2: The classifier tag is lost in a wrapper
**What goes wrong:** results are rebuilt as `risky(\`... ${inner.reason}\`)` (for example `npm run publish-script`), dropping `effects`, so the floor misses `npm run release`. **How to avoid:** every rebuild copies `inner.effects`; a table test runs each commandSafety `risky(` site wrapped in `npm run`, `bash -c`, `xargs`, `&&`, a pipe and a substitution.

### Pitfall 3: "unattended" means two things
**What goes wrong:** `AgentRunOptions.unattended` (`loop.ts:180`) is PERF-01's "a sub-agent nobody watches" auto-allow scope and is set for **every** sub-agent (`agentSession.ts:1024`). D-17's "context with no person present" is a different idea. If the gate maps sub-agents to the `unattended` context, every floor ask from a sub-agent becomes a refusal and the late-approval flow (`agentSession.ts:1483-1500`) is dead. **How to avoid:** amendment D-43: sub-agents of a chat run are `interactive`; `unattended` is for runs with no answerer (benchmark runner, later relay and routines); name the gate field `presence: 'person' | 'none'`.

### Pitfall 4: Late approval grants the floor action for the run
**What goes wrong:** `lateApproval` adds the exact command to `grants.commands` and sets `grants.edits` (`agentSession.ts:1495-1498`), which would make a floor action run silently next time. **How to avoid:** a floor card carries no `grant` (it already would not, as `risky`), and `lateApproval` must treat a floor card's allow as one-shot.

### Pitfall 5: `fully-autonomous` never builds the classifier context
**What goes wrong:** `autoContext` is built only for `auto` or unattended (`loop.ts:627-628`), so the floor would see no classification in `fully-autonomous`, the one mode it exists for. **How to avoid:** the floor builds its own cheap `CommandContext` for every shell call.

### Pitfall 6: `.planning/.near-ai/team.md` and `labels.json` are in the same folder
**What goes wrong:** the file tools exempt `team.md` from the protected-write rule (`tools.ts:126`); the shell classifier does not (it matches the folder regex, `commandSafety.ts:352`). D-17 says "everything `PROTECTED_WRITE` covers". **How to avoid:** amendment D-44: keep the exemption in the file-tool path and mirror it in the shell path, or the team builder and the Team Studio flows change behaviour; `labels.json` is covered as intended.

### Pitfall 7: A bundle deleted by an agent resets policy
**What goes wrong:** D-14's "no bundle means sign defaults" lets anything that deletes `<globalStorage>/gate/policy-bundle.json` reset a narrowed policy at next activation. **How to avoid:** the marker in SecretStorage (Section 7, amendment D-39) and the floor rule on the folder.

### Pitfall 8: Two windows race the first bundle
**What goes wrong:** two windows (or code-server tabs) both see no bundle and sign two. **How to avoid:** `withFileLock(<globalStorage>/gate, 'bundle.lock')` around check, sign, write, read back.

### Pitfall 9: Names that look like secrets cannot be signed
**What goes wrong:** `signPayload` runs `assertNoSecrets` over keys and values (`signedPayload.ts:131-137`, `secrets.ts:89`); a file called `sk-...` in a label map key, or a credential handle named like a token, fails with `PayloadError`. **How to avoid:** validate handles against `^[a-z][a-z0-9._-]{0,63}$` and catch `PayloadError` in the map writer, naming the path.

### Pitfall 10: Manifest verbs and the shorthand disagree
**What goes wrong:** cyber probes are `capability: 'read'` today (silent, scope-checked, `cyberProbes.ts:232`) but really connect to a target. If the gate re-derived the mode decision from the manifest's `network` effect, probes would start asking. **How to avoid:** D-04 holds: the settings layer keeps using `tool.capability`; add a test that for every tool the shorthand implied by its manifest equals `capability`, with an explicit short exception list (the six network probes).

### Pitfall 11: `decidePermission` is also called by the Tools page and the cyber engine
**What goes wrong:** `toolsDirectory.ts:~93` and `cyberRun.ts:353` call it directly. If the floor moved inside it, the Tools page would show floor results for a call with no input. **How to avoid:** floor stays in the gate; the directory keeps showing the settings layer plus manifest words.

### Pitfall 12: The relay compiles `src/domain/gate` too
**What goes wrong:** `relay/tsconfig.json` has `isolatedModules: true` and `paths: { "@ext/*": ["../src/*"] }`; plain `export { X } from` of a type fails under `isolatedModules`. **How to avoid:** `export type { ... }` for types; no `const enum`; no `vscode` import (the boundary test). The relay's own workspace test only forbids imports outside `relay/src/runner` (`relay/test/workspace.test.ts:140-165`); `relay/src/runner` does not exist yet, so nothing in the relay changes.

### Pitfall 13: A failed Team Enable can delete the key a bundle depends on
**What goes wrong:** `forgetCreatedDeviceIdentity` deletes a key it just created if the history holds only that key's own `created` record (`identity.ts:169`). If Team Enable creates the key first and the gate signs a bundle with it, a failed Enable orphans the bundle. **How to avoid:** the gate creates the identity first on a fresh install (then Enable sees `created: false` and never forgets it, `enable.ts:271-272`); the "signer unknown, bundle is the default" auto re-sign (D-39) covers the rest.

### Pitfall 14: Unlabelled content needs a clearance on the default label's scale
**What goes wrong:** a government bundle that drops the `org` clearance cannot read unlabelled files, because their label is `org/Public`. **How to avoid:** state it in the Show Policy text; the fresh bundle grants `org/Restricted` (D-27).

### Pitfall 15: `.near-ai/state/meta.json` is readable under the floor but not writable
**What goes wrong:** the test at `protectedPaths.test.ts:304` also `Read`s `.near-ai/state/meta.json` in `fully-autonomous`, which today runs without a card (`STATE_FOLDER_PATH` is "sensitive" for reads, `tools.ts:92-96`). D-17 adds a floor for **writes** only. **How to avoid:** keep that read as in D-18; the plan's rewritten test says so.

## Code Examples

### The gate's public shape (pure)
```typescript
// src/domain/gate/decide.ts (sketch; names are the planner's to choose)
export type GateOutcome = 'allow' | 'ask' | 'deny';
export interface GateDecision { outcome: GateOutcome; rule: string; reason?: string; offerAlwaysAllow: boolean; floor: boolean; capability: Capability }
export function decide(request: GateRequest, bundle: BundleState, context: GateContext, settings: SettingsLayer): Promise<GateDecision>;
// `settings` wraps decidePermissionAsync(...) so the pure module imports nothing from src/agent.
```

### The tool gate in `executeCall` (replaces loop.ts:614-692's decision logic)
```typescript
const facts = { forbidden, sensitive, risky };                       // today's three hooks, unchanged
const effects = await this.effectsOf(tool, input, command, context);  // manifest + classifier tags
const decision = await this.gate.decide({ actor, tool: tool.name, effects, facts, command, callId: call.id });
if (decision.outcome === 'deny') return this.finish(call.id, false, `Not allowed: ${decision.reason}`);
if (decision.outcome === 'ask') { /* card = transport; omit grant and allowRule when decision.floor */ }
```

### The route guard inside the client (follows the spend check at nearAiClient.ts:907-911)
```typescript
if (BILLABLE_PATHS.has(path) && (init.method ?? 'GET') === 'POST') {
  const verdict = this.options.routeGuard?.(path, overrides.model, this.models.get(overrides.model ?? ''), this.options.route);
  if (verdict && !verdict.allowed) throw new RouteRefusedError(verdict.reason);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-mode ad hoc checks scattered in loop, tools, classifier | one gate with a non-overridable floor (IronClaw "hard floor of never-auto-approve effects", Hermes "Hardline Blocklist") | design adopted 2026-11-15 | the floor survives any mode |
| `ActionCapability` (9 coarse values) | parameterised vocabulary verbs | this phase | host, path, server, spend are checkable |
| OCSF 1.x without AI objects | OCSF 1.9.0 with `ai_operation` profile (`ai_agent`, `ai_model`, `delegation`) | schema 1.9.0 current on 2026-11-16 | records can name agent, model, delegation lineage |

**Deprecated or not to copy:** IronClaw's auto-approve default on (`AUTO_APPROVE_DEFAULT_ENABLED: bool = true`) [CITED: `ironclaw-analysis.md` section 2.2]; Hermes' shared credential pool; any "agent-built tool" model.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | OCSF `cloud` and `osint` are required only because of profiles this record does not declare | 6 | the record validator would need two more fields |
| A2 | Desktop VS Code on Linux without a keyring falls back to a basic-text store or throws on `store`; the read-back check detects either | 7 | `identity-unavailable` could appear on a host that actually works, or be missed |
| A3 | A verified attestation report per signing address can be cached for about 10 minutes | 8.2 | per-turn verification cost, or a stale report accepted |
| A4 | The diff size estimates in section 11 (lines times 55 bytes, tests 2x) | 11 | PR grouping needs one more split |
| A5 | The additional credential-store names and token-printer commands in 4.2 ("Proposed additions") | 4.2 | a store missed or a harmless command refused; the list is data, cheap to change |
| A6 | No `extension.ts` import path reaches `AgentOrchestrator`, `MultimodalOrchestrator`, `GenerationService`, `ApprovalService`, `StakingService` | 2.3 | one more route site to guard (found by grep on class and module names only) |
| A7 | The contexts column for the 40 manifests (`i`, `u`) matches where each tool exists today | 1.3 | a tool refused in a context where it ran before |
| A8 | `git checkout --`, `git restore`, `git switch --discard-changes` belong with destruction | 4.3 | the floor is narrower or wider than the owner meant (Open Question 2) |

## Open Questions

1. **How does a person add a clearance?** D-33 says "editing through Show Policy", but the bundle is a signed file, so an edit breaks it. Recommend D-41: `Edit Policy` writes an unsigned draft in global storage, validates it with plain errors, signs and records it on Apply. Needs the owner's nod only if they prefer another route.
2. **Should discarding uncommitted work be on the floor?** D-17 lists `git reset --hard` and `git clean -f` but not `git checkout -- .` or `git restore .`, which lose the same work. Recommend yes (same class, cheap).
3. **Which GitHub writes are "publishing"?** D-17 names release creation. `gh pr create`, `gh pr merge`, `gh issue comment` send content to GitHub. Recommend: release verbs on the floor now, the rest stay in the settings layer and are listed for the owner.
4. **May a label relax routing?** `attested-cloud-ok` as a handling flag would let a person lower a tier by labelling. Recommend: ship without it (only `local-only` tightens); an organization adds the mapping to its bundle.
5. **Do `relay` and `routine` get their own manifests contexts now?** They are validated and reserved; no tool lists them until Phases 74 and 77.
6. **Hybrid profiles with two local endpoints or a LAN model.** D-37 adds `routing.localHosts`; the owner decides whether a LAN host may count as local-only.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | build and tests | yes | 24.22.3 | none needed |
| `systemd-run`, `choom`, `timeout` | memory cap (D-34) | yes | present on this machine | none; do not run tests without it |
| `xvfb-run` | e2e | yes | present | none |
| `node_modules` and `dist` in this worktree | compile and tests | **no** (absent here) | n/a | executors run `npm ci` in their own worktree; research ran no tests |

No network service is required by the phase's runtime logic (OFFL-01). The OCSF schema was read from `https://schema.ocsf.io` for this research only; the code embeds the few fields it needs and never fetches the schema.

## Validation Architecture

(`workflow.nyquist_validation` is absent from `.planning/config.json`, so it is treated as enabled.)

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` with `node:assert/strict`, TypeScript compiled by `tsc` |
| Config file | `tsconfig.json` (`rootDir: src`, `outDir: dist`); runner `scripts/run-tests.mjs` (per-run `TMPDIR`) |
| Quick run command | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js'` |
| Full suite command | same wrapper with `MemoryMax=6G`, `timeout 1800`, `npm test`; e2e: `npm run test:e2e` (xvfb, Wayland variables stripped) |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command (file) | File Exists? |
|--------|----------|-----------|--------------------------|-------------|
| GATE-01 | closed vocabulary; unknown verb, field, type, version refused; `gpu` refused; frozen vectors; integers only | unit + golden | `gateVocabulary.test.js` | Wave 0 |
| GATE-02 | every tool of `builtInTools()` has a valid manifest; shorthand matches except the listed probes; source scan finds no tool file outside the catalog | unit + scan | `gateManifests.test.js` | Wave 0 |
| GATE-03 | MCP: restrictive default effects, stdio label, never non-interactive unless named, legacy parity, manifest words | unit | `gateMcpManifests.test.js` (+ `mcp.test.js` unchanged) | Wave 0 |
| GATE-04 | `tool.run` call-site allow-list; `new AgentRun(` passes `gate`; scripted run per verb records a decision before execution; cyber path gated; card is transport (no card decides) | scan + integration | `gateEnumeration.test.js` | Wave 0 |
| GATE-05 | floor matrix: rule x mode x presence; no always-allow; no grant; refusal list incl. fake home credential stores; effect tags survive wrappers | unit + integration | `gateFloor.test.js`, `commandEffects.test.js` | Wave 0 |
| GATE-06 | fully-autonomous decisions inside grant; docs parity (SECURITY.md and README strings) | unit + docs | `gateFloor.test.js`, `gateDocs.test.js`; changed `protectedPaths.test.js` | partly (the changed test exists) |
| GATE-07 | one record per decision kind; shape validator; redaction; write failure never blocks; size rotation | unit | `gateRecords.test.js` | Wave 0 |
| OFFL-01 | every decision with `fetch`, `net`, `dns`, `http(s)` stubbed to throw | unit | `gateOffline.test.js` | Wave 0 |
| OFFL-02 | missing, unparseable, unsigned, tampered, wrong-purpose, revoked, rotated, expired, clock-behind, identity-unavailable each give floor plus read and plan and the plain sentence; fresh install self-signs; two-window lock; deleted-bundle marker; key-lost default re-sign | unit + integration | `gateBundle.test.js` | Wave 0 |
| OFFL-03 | version, expiry, issuer, reserved fields shape-checked, unknown field refused, renewal window | unit | `gateBundle.test.js` | Wave 0 |
| CLAS-01 | label shape, unknown scale, level, field refused; resolution order; unverified map raises only | unit | `gateLabels.test.js` | Wave 0 |
| CLAS-02 | four presets exactly; mappings only from bundle | unit | `gateLabels.test.js` | Wave 0 |
| CLAS-03 | dominance five conditions; property test with seeded generator | property | `gateDominance.test.js` | Wave 0 |
| CLAS-04 | mark raises, never lowers; sub-agent shares; writes inherit; rename moves entry; declassify records a reason | unit + integration | `gateMark.test.js` | Wave 0 |
| CLAS-05 | default routing table by `scale/level`; handling and compartments; join of two scales takes the strictest | unit | `gateRouting.test.js` | Wave 0 |
| CLAS-06 | guard before `fetchFn` on every content path; local-only with no local client or non-loopback host refused; mark rising mid-run refuses next request; hybrid; attestation after-the-fact record | integration | `gateRouteGuard.test.js` | Wave 0 |
| CLAS-07 | exact wording present in SECURITY.md and the label command text | docs | `gateDocs.test.js` | Wave 0 |
| boundary | `src/domain/gate` and `src/gate` import rules | scan | extend `teamBoundaries.test.js` | exists, edit |

### Sampling Rate
- **Per task commit:** the one or two `gate*.test.js` files the task touches (each under 30 seconds).
- **Per wave merge:** all `dist/test/gate*.test.js` plus the parity set `autoApproval`, `agentLoop`, `protectedPaths`, `untrusted`, `unattendedApproval`, `mcp`, `toolsPage`, `commandSafety`, `teamSignedPayload`, `teamBoundaries`.
- **Phase gate:** one full `npm test` and `npm run test:e2e`, once, before `/gsd-verify-work` (user's cadence rule; the security and authorization checks above are immediately blocking, not deferred).

### Wave 0 Gaps
- [ ] `src/test/gate*.test.ts` files listed above (none exist)
- [ ] a seeded xorshift helper in the property test file (no dependency)
- [ ] a fake-home helper and a `testTool()` fixture helper (shared test utilities)
- [ ] `src/agent/toolCatalog.ts` (production code the tests depend on)
- [ ] a docs-parity test pattern (new; repo has none for SECURITY.md)

## Security Domain

(`security_enforcement` is absent from config, so it is treated as enabled.)

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | no sign-in is added |
| V3 Session Management | partly | the "session" is an agent session: the mark's lifetime and sharing (Section 9.1) |
| V4 Access Control | **yes** | the gate: floor, ceiling, dominance, route; deny by default and fail closed |
| V5 Input Validation | **yes** | hand-written closed validators for vocabulary, manifest, bundle, label, label map; unknown fields refused |
| V6 Cryptography | **yes** | `node:crypto` Ed25519 through `signPayload` only; never hand-roll; canonical bytes |
| V7 Error Handling and Logging | **yes** | decision records, redaction, a write failure never changes a decision |
| V8 Data Protection | yes | classification routing; records and map never contain secrets (`assertNoSecrets`) |

### Known Threat Patterns
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Agent or script deletes or edits the bundle or map | Tampering | signature; fail closed; marker prevents silent reset; floor on `identity/` and `gate/`; map writes under `.planning/.near-ai/` are floor asks |
| Policy downgrade through a stale file | Tampering / Repudiation | `max(now, lastValid)` clock rule; expiry; `issuedAt` not after now |
| Replay of an old bundle after key rotation or revocation | Spoofing | `verifyPayload` key status rules (rotated vs revoked) |
| Prompt injection asks for publish, delete, key read | Elevation of Privilege | floor above every mode; taint holds stay |
| Label relaxation by an unverified teammate's map | Elevation of Privilege | unverified maps may only raise (D-25) |
| Content sent to a forwarded model at a strict tier | Information Disclosure | pre-send route check by cached catalog; unknown means not private |
| "Local" model URL that is remote | Information Disclosure | loopback requirement (D-37) |
| Shell reads or sends labelled content invisibly | Information Disclosure | documented limit (CLAS-07 wording); network-effect tools refused at strict marks; real boundary is Phase 72 |
| Secret in a decision record or manifest | Information Disclosure | `redactSecrets` before write; handle name pattern; `assertNoSecrets` on signing |
| Gate decision path blocks on the network | Denial of Service | OFFL-01 test; verification is out of band |
| Two windows corrupt the first bundle | Tampering / DoS | file lock |
| Hostile MCP server lies about effects | Spoofing | a manifest only narrows; undeclared tools restrictive; documented as a claim |

## Proposed amendments to CONTEXT

Each is a proposal with evidence and undo cost. D-01 to D-34 stay locked until the owner or orchestrator accepts these.

**D-35. `spend` uses whole numbers of nano-USD, not `usd`.** Evidence: canonical JSON accepts "safe integers" only (`src/domain/team/canonical.ts:30-31`, `numbers must be safe integers`); `signPayload` throws on a fraction and tells the caller to use "nano-USD or basis points" (`signedPayload.ts:128-129`); Phase 69's own sample is `budgetNanoUsd: 5_000_000_000` (`teamSignedPayload.test.ts:63`). Replace `spend{usd}` with `spend{nanoUsdPerRun, nanoUsdPerDay}`. Undo: costly after release (vocabulary field), free now.

**D-36. `attested-cloud` is decided before sending from the model's TEE status and NEAR's own endpoint, and verified after each response.** Evidence: attestation is on demand, after the fact, networked, for one answer (`agentSession.ts:696-701`, `attestation.ts:1-30`); the response signature does not exist before sending. Replace "whose attestation and response signature verified for this request" in D-31 with: pre-send `privacyBoundary === 'tee'` plus `isNearCloudEndpoint`; post-response `verifyResponse`, recorded, a failure stops further requests at that tier. CLAS-05's own wording should be edited to match. Undo: medium (routing semantics people rely on).

**D-37. `local-only` requires a loopback endpoint (or a host the bundle names).** Evidence: `src/extension.ts:294-295` accepts any `https://` URL for the local runtime and `LOOPBACK_HOSTS` exists at `src/domain/config.ts:49`. Add `routing.localHosts` (empty by default) to the bundle. Undo: cheap (bundle value), but needed before CLAS-06's "never sent to a cloud" is true.

**D-38. Existing MCP servers get `legacy` manifests that decide as today; "most restrictive" applies to servers added after this phase and to tools a declared manifest omits.** Evidence: today a tool the server calls read-only runs as capability `read` (silent) unless the server is "ask every call" (`src/mcp/tools.ts:43`), and `trusted` servers never ask (`mcp.test.ts:61` pins asking even in `fully-autonomous` only for the ask settings). D-06's blanket default would make every configured server ask for every tool and show a `destroy` effect, which D-10 forbids. `toolDefaults: "legacy"` is set on every stored server at first load (no data migration needed: absent means legacy). Undo: cheap.

**D-39. A missing bundle self-signs only on a true fresh install; a lost key re-signs only a never-customised default.** Evidence: code-server keeps secrets in the browser [CITED: coder/code-server PR 6450]; the key history head is in SecretStorage (`keyHistory.ts:29`) and a history whose key is gone is archived (`identity.ts` comment on `ensureCreatedRecord`), so a bundle can become unverifiable without tampering; and D-14 as written lets a deleted file reset a narrowed policy. Add the SecretStorage marker `nearAi.gate.lastValid`. Undo: cheap.

**D-40. CLAS-07 wording is extended** to say the checks cover what NEAR AI sends and its own file tools, not everything a shell command or add-on server does, and that the declared clearance is not an enforced boundary. Replacement text in Section 12. Evidence: `protectedPaths.ts:66-73`, `agentSession.ts:696-701`, `extension.ts:294-295`. Undo: cheap.

**D-41. Add `NEAR AI: Edit Policy` (draft, validate, sign, record) and make `Show Policy` read-only.** Evidence: the bundle is a signed file; D-27 requires a person to add a matching clearance "which is recorded", and D-33 leaves no editor. Undo: cheap.

**D-42. Rename tracking is `onDidRenameFiles` plus shell `mv` and `git mv` plus a missing-path report; there is no agent rename tool.** Evidence: `CORE_TOOLS` (`tools.ts:632`). D-26's intent holds; its wording ("renames through the agent's file tools") describes a tool that does not exist. Undo: cheap.

**D-43. Sub-agents of a person's run are in the `interactive` context; the gate carries `presence: 'person' | 'none'` and `unattended` means `none`.** Evidence: every sub-agent is built with the PERF-01 `unattended` scope (`agentSession.ts:1024`) yet its cards queue for a person (`agentSession.ts:1038-1041`, `lateApproval`). Floor asks from a sub-agent stay cards with no grant; a late allow is one-shot. Undo: medium.

**D-44. The floor keeps today's `team.md` exemption.** Evidence: `protectedWrite()` returns undefined for `.planning/.near-ai/team.md` (`tools.ts:126`) and SECURITY.md says "other than its `team.md`" (line ~96). `PROTECTED_WRITE` itself covers it. Undo: cheap.

## Sources

### Primary (HIGH confidence): files read this session
- `src/agent/loop.ts` (1-330, 330-810), `src/agent/permissions.ts` (all), `src/agent/tools.ts` (all), `src/agent/commandSafety.ts` (527-620, 770-910, structure), `src/agent/unattended.ts` (1-80), `src/agent/workspace.ts` (all), `src/agent/glob.ts`, `src/domain/policy.ts`, `src/domain/protectedPaths.ts`, `src/domain/riskSwitches.ts`, `src/domain/approvalRisk.ts` (1-90), `src/domain/privacy.ts`, `src/domain/config.ts` (15-40), `src/domain/auth.ts` (grep)
- `src/domain/team/signedPayload.ts`, `keyStatus.ts`, `canonical.ts` (1-60), `secrets.ts`, `validate.ts` (1-80)
- `src/team/identity.ts`, `src/team/keyHistory.ts`, `src/team/enable.ts` (262-300)
- `src/services/nearAiClient.ts` (structure, 300-424, 890-975), `providerCache.ts`, `providerFactory.ts`, `attestation.ts` (1-80), `agentSession.ts` (215-240, 690-730, 860-1060, 1483-1500), `chat.ts` (820-1010), `mcpRegistry.ts`, `toolsDirectory.ts`, `outboundGuard.ts`, `privacyPreflight.ts`, `policyGate.ts`, `cyberRun.ts` (325-420, 525-560), `spendLedger.ts` (15-60), `transcripts.ts`, `threadStore.ts` (25-100), `setupSteps.ts` (1-60), `team/teamStatusBar.ts`
- `src/mcp/client.ts`, `src/mcp/tools.ts`, `src/gsd/tools.ts`, `src/agent/webTools.ts`, `extraTools.ts`, `benchmark/runner.ts` (20-70)
- tests: `protectedPaths.test.ts` (290-340), `teamSignedPayload.test.ts` (55-125), `teamBoundaries.test.ts` (1-62), `autoApproval.test.ts` (95-135), `agentTools.test.ts` (125-175)
- `relay/tsconfig.json`, `relay/scripts/build.mjs`, `relay/test/workspace.test.ts` (grep), `package.json`, `docs/development-workflow.md` (head), `SECURITY.md` and `README.md` (lines named above)
- `.planning/` CONTEXT, REQUIREMENTS, ROADMAP Phase 70, STATE, PROJECT decisions 1-13, `platform-direction/` ironclaw, hermes, identity (section 4), openshell and spike (grep)

### Secondary (MEDIUM)
- OCSF schema API, version 1.9.0: `https://schema.ocsf.io/api/version`, `/api/classes/api_activity`, `/api/classes/device_config_state_change`, `/api/profiles/ai_operation`, `/api/objects/{authorization, policy, ai_agent, ai_model, delegation, data_classification, api, actor, metadata, product, resource_details, network_endpoint}`
- code-server PR "Enable secret storage": https://github.com/coder/code-server/pull/6450 (page text only, no storage location stated)

### Tertiary (LOW)
- General knowledge for the extra credential-store names in 4.2, desktop Linux keyring fallbacks, and the OCSF profile origin of `cloud` and `osint` (all tagged `[ASSUMED]` above)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new is installed and every reused module was read.
- Architecture (two execution sites, one request choke point, layering): HIGH, verified by grep and by reading the call sites.
- Floor lists and classifier tags: HIGH for the sites, MEDIUM for the exact owner-facing list (some entries are proposals).
- Pitfalls: HIGH for 1 to 6, 8 to 13 (read in code); MEDIUM for 7 and 14.
- OCSF mapping: MEDIUM (live schema read; profile requirements partly assumed).
- Attestation, code-server, keyring behaviour: MEDIUM-LOW (one citation, no live test).

**Research date:** 2026-11-16
**Valid until:** 2026-12-16 for the code findings if `main` does not change `loop.ts`, `permissions.ts`, `nearAiClient.ts` or `commandSafety.ts` (rebase and re-grep the line numbers before planning if it does); the OCSF version should be re-read if the schema moves past 1.9.
