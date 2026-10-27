---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# Codebase Concerns

**Analysis Date:** 2026-10-27

Sources: direct inspection of `src/` (about 9.8k lines of TypeScript in `src/services`, `src/agent`, `src/gsd`, `src/domain`), `media/chat/*.js`, `package.json`, and the prior delivery audit in `.planning/AUDIT-2026-10-26.md`. Where the audit was written against v0.3.1 and the current tree no longer matches, this is noted.

## Tech Debt

**Webview UI is generated as large inline string blobs inside TypeScript:**
- Issue: Substantial webview markup and client script are built as single-line template/string literals in TypeScript rather than shipped as separate files. The chat view HTML and its inline `<script>` are assembled in `src/services/chat.ts` (the main HTML builder begins around line 840 and the memory, generation, and fleet sections are each a single `innerHTML` string on lines 844-847). The same file also contains a full client-side renderer for graph, memory table, and publication review.
- Files: `src/services/chat.ts` (951 lines), `src/services/panelView.ts`, `src/services/onboarding.ts`, `media/chat/chat.js`, `media/chat/markdown.js`
- Impact: Lines are hundreds of characters long, so diffs and code review are hard. Client logic cannot be linted or type-checked, and the same UI is partly duplicated between `media/chat/chat.js` and the inline script in `chat.ts`. Escaping mistakes in these strings are easy to introduce.
- Fix approach: Move webview client code into `media/` files loaded through the webview URI and a nonce-based CSP, and keep only the HTML shell in TypeScript. Add a type-checked client build or at least a lint step over `media/`.

**Oversized service modules:**
- Issue: A few modules own too many responsibilities.
- Files: `src/services/chat.ts` (951 lines), `src/services/chatBridge.ts` (830), `src/services/nearAiClient.ts` (754), `src/services/agentSession.ts` (576), `src/services/generationService.ts` (395), `src/agent/tools.ts` (374), `src/services/profileStore.ts` (341)
- Impact: Changes to the chat send path touch the same file as UI rendering, bridge messages, and persistence, which raises regression risk for every feature change.
- Fix approach: Split `chatBridge.ts` into message routing and per-feature handlers; split `nearAiClient.ts` into transport (fetch, retry, SSE/stream parsing) and API-surface modules.

**Silent error swallowing:**
- Issue: There are 13 empty or ignored `catch` blocks in non-test source (`grep -rn "catch {}\|catch (_\|catch {$"` over `src/`). Failures in these paths produce no log and no user-visible status.
- Files: run `grep -rn "catch" src --include=*.ts | grep -v src/test` to list them; they are concentrated in the store and bridge layers (`src/services/activityStore.ts`, `src/services/contextGraphStore.ts`, `src/services/agentOrchestrator.ts`, `src/services/resumableExecution.ts`).
- Impact: Persistence failures (activity history, agent ledger, resumable snapshots) can go unnoticed, so users may believe state was saved when it was not.
- Fix approach: At minimum, route each to the existing output channel with a short message. Where a failure is expected, comment why it is safe to ignore.

**Persistence writes whole snapshots on every change:**
- Issue: `persist()` rewrites the full state on each mutation rather than appending or batching.
- Files: `src/services/agentOrchestrator.ts` (line ~182), `src/services/resumableExecution.ts` (line ~17), `src/services/generationService.ts` (line ~349), `src/services/activityStore.ts` (queued writes around line ~110)
- Impact: Write amplification grows with history size. Concurrent mutations rely on the serialized write queue in `activityStore.ts`; the other stores do not show the same queueing, so overlapping calls can race.
- Fix approach: Serialize all store writes through one queue helper (as `activityStore.ts` does) and use temp-file-then-rename consistently (as `contextGraphStore.ts` line ~148 already does).

**Legacy panel code still shipped behind the Tools tab:**
- Issue: `src/services/chat.ts` still carries the pre-rebuild webview (`chatHtml2`, `teamStudioEnhancementHtml`, `memoryExplorerEnhancementHtml`) and its message handlers for team studio, multimodal "operations", generation previews, memory explorer, and wallet/staking (`src/services/teamStudio.ts`, `src/services/multimodalOrchestrator.ts`, `src/services/generationService.ts`, `src/services/stakingService.ts`, `src/services/walletAuthorization.ts`). `toolsHtml()` hides those sections with CSS, so users cannot reach them; the working versions of teams, attachments, image generation, and memory run in the sidebar chat (`media/chat/chat.js`, `src/services/agentSession.ts`). The hidden team studio still hard-codes `member-studio0001`, which `teamStudio.ts` rejects.
- Impact: Dead code and handlers that look live in review; a CSS change would expose controls that do not work. Wallet/staking is `StakingService.unavailable()`.
- Fix approach: Remove the hidden sections and their handlers from `chat.ts`, keep only the Tools tab's analytics, artifacts, and history, and delete the unused services once nothing imports them.

**Verified on 2026-10-27 (previously reported in `.planning/AUDIT-2026-10-26.md` against 0.3.1, now resolved):**
- GSD runs on the native runner (`src/services/agentSession.ts` with `src/gsd/tools.ts`) through `NearAiClient`; there is no `codex exec` bridge. `/gsd-map-codebase` ran live end to end on NEAR AI.
- Actual cost uses `POST /v1/billing/costs` keyed by the `inference-id` header (`NearAiClient.actualCostsUsd`), confirmed live.
- The header-based "TEE verified" badge is gone; **Verify signature** checks NEAR's signature and a TDX quote (`src/services/attestation.ts`), confirmed live against NEAR's gateway key.
- The privacy, spend, and action-policy guard (`OutboundGuard`) and the emergency stop run on every sidebar send (`src/services/chat.ts`, send handler). The spend limit is checked per message, not between turns of one run (documented in `SECURITY.md`).
- The Open-GSD runtime (`src/gsd/runtime.ts`) installs only when a workflow runs and none is present, into a per-version directory; updates are checked at startup and daily in NEAR AI projects. No reinstall loop.

## Known Bugs

No confirmed open bugs in the shipped paths as of this analysis. Earlier reports are listed above with their resolution.

## Security Considerations

**Agent shell inherits the full parent environment:**
- Risk: Commands the agent runs receive every variable from the extension host, including any API keys or tokens present in `process.env`.
- Files: `src/agent/shell.ts` (`shellEnv`, around lines 120-127; spawn at lines 40 and 112)
- Current mitigation: `ELECTRON_RUN_AS_NODE` is removed, `CI` is preserved, and pager and terminal variables are normalized.
- Recommendations: Allowlist the environment (PATH, HOME, LANG, TERM, and explicitly needed variables) instead of spreading `process.env`. Confirm that NEAR API keys are never placed in `process.env` by the extension.

**Sensitive-file guard covers file tools but not shell commands:**
- Risk: The agent can read `.env`, `.near-credentials`, `.ssh`, or key files with `cat` or `grep` in a shell command, bypassing the guard.
- Files: `src/agent/tools.ts` (`SENSITIVE_FILE` pattern, line ~45), `src/agent/shell.ts`, `src/agent/permissions.ts`
- Current mitigation: `SENSITIVE_FILE` blocks direct file-tool access to credential paths. `src/services/privacyPreflight.ts` checks outbound content for `.near-credentials` paths.
- Recommendations: Apply the same path policy to shell command arguments, or require explicit approval for any shell command that names a sensitive path. Treat the preflight check as a best-effort filter, not a boundary.

**Installer runs an external package at runtime:**
- Risk: The GSD installer runs `npx --yes @opengsd/gsd-core@<version> --claude --global` with the extension's environment, and the version is read from `npm view @latest`. A compromised or unexpected release is installed and executed without a checksum.
- Files: `src/gsd/runtime.ts` (lines ~53 and ~83)
- Current mitigation: The version is pinned to the value just looked up; there is a 300-second timeout and an abort signal.
- Recommendations: Pin a known-good version in the extension, verify the package integrity hash, and require explicit user consent before the first install.

**Webview content security policy is present:**
- Positive note: `src/services/panelView.ts`, `src/services/chat.ts`, and `src/services/onboarding.ts` each set a CSP with `default-src 'none'` and a per-load nonce. Keep this when moving webview scripts to files (see Tech Debt). The `style-src 'unsafe-inline'` in `chat.ts` and `onboarding.ts` should be tightened to a nonce or hash if styles are moved out of inline strings.

**Credentials storage:**
- Positive note: API keys and refresh tokens are kept in VS Code `SecretStorage` through `src/services/auth.ts`, scoped per organization and project, and the code does not read `~/.near-credentials`. Keep it that way.

## Performance Bottlenecks

**Stream idle and response timeouts:**
- Problem: Streaming responses rely on two timers (response timeout and idle timeout) with retry and backoff.
- Files: `src/services/nearAiClient.ts` (lines ~500, ~725, ~744)
- Cause: A stalled stream is detected only after the idle window elapses, so each attempt can wait the full idle period before retrying.
- Improvement path: Tune the idle window per model and surface a "stalled, retrying" state in the webview. Check that aborted attempts release their readers.

**Whole-state persistence on every mutation:**
- Problem: See Tech Debt. Stores rewrite full JSON on each change.
- Files: `src/services/agentOrchestrator.ts`, `src/services/resumableExecution.ts`, `src/services/generationService.ts`
- Cause: No incremental write or debounce.
- Improvement path: Debounce writes (for example 250 ms) and coalesce mutations during a single turn.

## Fragile Areas

**Chat webview script generated from TypeScript:**
- Files: `src/services/chat.ts`, `media/chat/chat.js`
- Why fragile: Two copies of client behavior exist, and the inline copy is not type-checked. Changing a message name in `chatBridge.ts` requires matching edits in both places with no compiler check.
- Safe modification: Define message types in one shared module imported by both host and client code, and change them there first.
- Test coverage: `src/test/sidebarChat.test.ts` and `src/test/chatSendPath.test.ts` check source text and structure rather than behavior in a running webview.

**Chat bridge message routing:**
- Files: `src/services/chatBridge.ts`
- Why fragile: One switch-style dispatcher handles many message types, and several handlers depend on state that some paths never set (the audit cites team and generation flows).
- Safe modification: Add a test per message type that starts from the state the real UI produces, not from seeded state.
- Test coverage: Gaps for message types that are routed but never reached from the UI.

**Shell process group handling:**
- Files: `src/agent/shell.ts` (spawns with `detached: true`, kills by process group in `killGroup`)
- Why fragile: Killing `-pid` with SIGKILL depends on the child being a process-group leader. Child processes that call `setsid` or daemonize can survive cancellation.
- Safe modification: Test cancellation with a child that spawns a grandchild. Keep the cleanup in `stopShell` and `killGroup` together.
- Test coverage: `src/test/agentTools.test.ts` covers basic shell use; no test was found for orphaned grandchildren.

**Source-text regex tests:**
- Files: `src/test/chatBridge.test.ts`, `src/test/staking.test.ts`, `src/test/walletAuthorization.test.ts`, `src/test/contextGraphProtocol.test.ts`
- Why fragile: These tests pass when source text matches a pattern, not when behavior is correct. They have passed for features that do not run (see Unreachable features above).
- Safe modification: Replace them with behavior tests that call the exported function and assert on output.

## Scaling Limits

**Context graph and activity history:**
- Current capacity: No bound is enforced on activity or graph size in the stores reviewed.
- Limit: Full-file rewrite on every change means latency grows with history size.
- Scaling path: Rotate activity files by month and cap graph node count, as the memory-slice UI already implies with its "bounded" wording.

**Agent fleet:**
- Current capacity: The fleet view always shows 0 agents, per the audit, so the real limit is unmeasured.
- Limit: Unknown; `src/services/agentOrchestrator.ts` persists the full agent list on every change.
- Scaling path: Measure with a synthetic fleet of 50 to 100 agents before exposing parallel runs.

## Dependencies at Risk

**Runtime `npx` install of Open-GSD:**
- Risk: See Security Considerations. The package is fetched at runtime, not bundled.
- Impact: Offline or network-restricted users cannot run GSD, and the install can change between runs.
- Migration plan: Vendor a pinned copy or document the install and its version in the extension settings.

**VS Code engine floor:**
- Risk: `package.json` sets `engines.vscode` to `>=1.101.0` (Node 22+), required by pdf.js 6; the e2e suite runs against current stable VS Code, not the floor.
- Impact: Incompatibility on older VS Code builds.
- Migration plan: Run `npm run check` against the minimum engine version in CI.

## Missing Critical Features

**Scanned PDFs and legacy Office formats:**
- Problem: Attachments read text from PDFs (text layer) and from .docx, .pptx, and .xlsx; scanned PDFs without a text layer and the binary .doc, .ppt, and .xls formats are not read.
- Blocks: Attaching scanned contracts or old spreadsheets; the user is told to export or re-save.

**Vector graphics from images:**
- Problem: The agent can write SVG markup with its file tools and generate raster images (`GenerateImage`, PNG only), but there is no tracing tool that turns a supplied raster image into SVG, and no built-in way to assemble a .pptx.
- Blocks: "Vectorize this logo" and slide-deck output without the user's own tooling.

**Real local runtimes are not exercised in tests:**
- Problem: Local and hybrid profiles (`src/services/providerFactory.ts`) are covered by unit tests and an end-to-end test against a fake OpenAI-compatible server, not against Ollama, LM Studio, or vLLM.
- Blocks: Confidence in tool calling on local models, whose tool-call support varies.

## Test Coverage Gaps

**Live and end-to-end tests:**
- What's not tested: `src/test/live.test.ts` and `src/test/e2e/suite.ts` require a live NEAR AI key or `xvfb-run`; they are not part of the default `npm test` run (`node --test dist/test/*.test.js`).
- Files: `src/test/live.test.ts`, `src/test/e2e/run.ts`, `src/test/e2e/suite.ts`
- Risk: Regressions in the real provider path or the VS Code webview may pass CI.
- Priority: High

**Webview behavior:**
- What's tested: `src/test/e2e/suite.ts` drives the real sidebar webview in VS Code (load under CSP, model list, a streamed agent reply with usage, an approval and Revert).
- What's not tested: Keyboard navigation and screen-reader live regions; the retry notice (`assistant-retry`) and Verify signature UI outside unit tests.
- Files: `media/chat/chat.js`
- Priority: Medium

**Coverage measurement:**
- What's not tested: No coverage tool is configured in `package.json`, so coverage is unknown.
- Files: `package.json`
- Risk: Untested branches in `src/services/nearAiClient.ts` and `src/services/auth.ts` cannot be identified.
- Priority: Medium

**Shell cancellation and grandchild processes:**
- What's not tested: Orphaned children after cancellation.
- Files: `src/agent/shell.ts`
- Risk: Background processes keep running after the user stops an agent.
- Priority: Medium

---

*Concerns audit: 2026-10-27*
