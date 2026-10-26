# Codebase Concerns

**Analysis Date:** 2026-10-26

## Tech Debt

**Auto-install of an unpinned external runtime on every activation:**
- Issue: `GsdUpdater` runs `npx --yes @opengsd/gsd-core@latest --codex --global` (and `--local` in the workspace) whenever the installed version is missing or older than the registry's `latest`. The `nearAi.autoInstallGsd` setting is declared in `package.json` and exposed through `readSettings()` in `src/services/settings.ts`, but nothing reads it before the install path runs.
- Files: `src/services/gsdUpdater.ts`, `src/extension.ts` (line `new GsdUpdater().start(context)`), `src/services/settings.ts`, `package.json` (`nearAi.autoInstallGsd`)
- Impact: The user-facing toggle is a no-op. Installs and updates happen without consent, and the version is unpinned, so the package's current `latest` runs with the user's privileges.
- Fix approach: Gate `GsdUpdater.start()` on `readSettings().autoInstallGsd`, or on the boolean from `vscode.workspace.getConfiguration('nearAi').get('autoInstallGsd')`. Pin to a verified version or a checksum, and show an explicit confirm step before the first global install.

**Dead and duplicated setup code in the extension entry point:**
- Issue: `runSetup()` in `src/extension.ts` (lines around 77-108) is never referenced. It duplicates the flow of `configureApiKey()`, and both route to `saveProfileCredential()`.
- Files: `src/extension.ts`
- Impact: Two divergent setup paths, one of them unreachable, invite drift. The "NEAR account sign-in" branch of `runSetup` is a non-functional message.
- Fix approach: Delete `runSetup` (or wire it to a command deliberately) and keep a single credential entry path.

**Very large files containing inline HTML, CSS and JavaScript as TypeScript strings:**
- Issue: `src/services/chat.ts` (887 lines) and `src/services/chatBridge.ts` (750 lines) embed the entire webview UI as template strings. Many lines in `chat.ts` exceed several hundred characters (for example the `renderCommands`, memory, generation, and fleet blocks around lines 754-790), and the script is effectively uncompiled and untyped.
- Files: `src/services/chat.ts`, `src/services/chatBridge.ts`, `src/services/onboarding.ts`, `src/services/panelView.ts`
- Impact: Front-end changes cannot be linted, type-checked, or diffed meaningfully. Accessibility and CSP regressions are hard to spot in review.
- Fix approach: Move webview scripts into separate `.js` (or bundled `.ts`) assets loaded via `webview.asWebviewUri`, keep the nonce-based CSP, and add a lint step for the webview bundle.

**Loose typing on process interfaces:**
- Issue: `GsdProcess.once` in `src/services/gsdRunner.ts` uses `(...args: any[]) => void`, and the repository has no other `@ts-ignore` markers, so `any` is confined to this seam.
- Files: `src/services/gsdRunner.ts`
- Impact: Low, but it removes type checking from process exit and error handling.
- Fix approach: Type listeners as `(code: number | null) => void` for `close` and `(err: Error) => void` for `error`.

**Repeated hand-rolled atomic-write pattern across stores:**
- Issue: At least eight services implement the same write-to-temp-then-rename sequence with a per-service write queue or none at all. Examples: `src/services/activityStore.ts`, `src/services/reputation.ts`, `src/services/teamStudio.ts`, `src/services/projectInitialization.ts`, `src/services/agentProfiles.ts`, `src/services/profileStore.ts`, `src/services/contextGraphStore.ts`, `src/services/multimodalOrchestrator.ts`, `src/services/generationService.ts`, `src/services/auditStore.ts`, `src/services/resumableExecution.ts`. Some use `${pid}` temp suffixes, others a fixed `.tmp` suffix; `src/services/handoff.ts` writes non-atomically.
- Files: listed above
- Impact: Concurrency and crash-safety behavior differs by store. `multimodalOrchestrator.ts` and `generationService.ts` do not clean up the temp file on failure.
- Fix approach: Extract one `atomicWriteJson(file, value)` helper in `src/services/` that uses a unique temp name and a best-effort cleanup, and migrate the stores to it.

**Stub staking subsystem wired into the live chat path:**
- Issue: `StakingService.unavailable()` is constructed in `src/services/chat.ts` (line 68) and in `src/extension.ts` status output. Its RPC and entitlement dependencies are "unavailable" stubs, so the wallet and staking surface always reports unavailable.
- Files: `src/services/stakingService.ts`, `src/services/walletAuthorization.ts`, `src/domain/staking.ts`, `src/services/chat.ts`
- Impact: Users can reach UI that cannot function. Code and tests exist for behavior that is never exercised in production wiring.
- Fix approach: Either hide the staking panel behind a feature flag until the RPC and entitlement providers exist, or document the stub explicitly in the UI.

## Security Considerations

**API keys can be sent over plaintext HTTP:**
- Risk: The bearer token is sent to whatever base URL the profile stores. Both `safeBaseUrl` implementations accept `http:` as well as `https:`: `src/services/profileStore.ts` (line ~302-305) and `src/services/chatBridge.ts` (line ~692). `NearAiClient.request()` in `src/services/nearAiClient.ts` attaches `authorization: Bearer <key>` to every request with no scheme check.
- Files: `src/services/nearAiClient.ts`, `src/services/profileStore.ts`, `src/services/chatBridge.ts`, `src/services/providerFactory.ts`
- Current mitigation: `safeBaseUrl` rejects strings containing "api key", "token", "secret", or "password", and rejects invalid URLs. Keys are kept in VS Code SecretStorage, not in project files.
- Recommendations: Require `https:` for any profile that carries a credential, with an explicit, logged opt-in for `http://localhost` only. Consider also rejecting a base URL changed through the `profile-update` message path without re-validation.

**Caller headers can override the authorization header:**
- Risk: In `NearAiClient.request()`, `headers: { authorization: ..., ...(init.headers ?? {}) }` lets any caller-supplied `authorization` key replace the bearer token. Current callers are internal, but the pattern is fragile.
- Files: `src/services/nearAiClient.ts` (`request` method)
- Current mitigation: Only internal call sites exist.
- Recommendations: Put `authorization` last so it cannot be overridden, or strip caller-supplied auth headers.

**Supply-chain exposure from `npx` with an unpinned `@latest` tag:**
- Risk: See the auto-install item under Tech Debt. Any compromise of the `@opengsd/gsd-core` publish path is executed on activation with `--global`, and the Codex runtime (`gsdRunner.ts` spawns `codex exec`) then runs against the workspace.
- Files: `src/services/gsdUpdater.ts`, `src/services/gsdRunner.ts`
- Current mitigation: `GSD_PACKAGE` is a constant, the version string is validated as `\d+\.\d+\.\d+`, and `execFile` is used without a shell.
- Recommendations: Pin a reviewed version range, verify integrity, and make network installs opt-in.

**Runtime state may be committed to git:**
- Risk: The extension writes `.planning/.near-ai/` (`auth-profiles.json`, `activity.json`, `audit.json`, `context-graphs.json`, `generation.json`, `generated/*.bin`) into the user's workspace. `/.gitignore` does not exclude `.planning/`, and it excludes only `node_modules/`, `dist/`, `*.vsix`, `.env*`, `.vscode-test/`, `.git-unusable-archive/`. Generated binary artifacts and profile metadata could be committed by mistake.
- Files: `src/services/profileStore.ts` (`filePath`), `src/services/generationService.ts` (`managedPath`, `ledgerPath`), `src/services/activityStore.ts`, `src/services/auditStore.ts`, `src/services/contextGraphStore.ts`, `src/services/handoff.ts` (`.planning/HANDOFF.json`), `.gitignore`
- Current mitigation: Credentials themselves go to SecretStorage, not files. `redactSecrets` in `src/domain/redaction.ts` and the prompt-redaction regexes in `activityStore.ts` and `analyticsStore.ts` scrub obvious secrets from stored text.
- Recommendations: Add `.planning/.near-ai/` to `.gitignore`, and consider writing this directory with mode `0o600`.

**Regex-based secret redaction is heuristic:**
- Risk: `src/domain/redaction.ts`, `src/services/chatBridge.ts` (lines ~147, 590-591, 634), `src/services/contextGraphMemory.ts` (line ~91), `src/services/memoryApproval.ts` (line ~15), and `src/services/stakingService.ts` (line ~219) each maintain separate, overlapping "unsafe text" regexes. They can drift, and a key format the regex does not recognize passes through to memory graphs and audit logs.
- Files: listed above
- Current mitigation: Multiple layers, and known key-name keywords are caught.
- Recommendations: Centralize into one exported pattern set in `src/domain/redaction.ts` and test it against sample key shapes.

**Webview content security policy is present but broad:**
- Risk: Both webviews set a CSP (`src/services/chat.ts` line ~747 and ~781, `src/services/onboarding.ts` line ~35) with a nonce-based `script-src`, which is good. `chat.ts` and `onboarding.ts` also set `retainContextWhenHidden: true`, and `panelView.ts` enables scripts with no CSP visible in the grep results.
- Files: `src/services/chat.ts`, `src/services/onboarding.ts`, `src/services/panelView.ts`
- Current mitigation: `default-src 'none'`, nonce scripts, `textContent` used for model output.
- Recommendations: Verify that `src/services/panelView.ts` sets a CSP, and check any `innerHTML` assignments (the `chat.ts` memory and generation sections use `innerHTML` with static markup only, but this should be re-audited on each change).

**Command-line invocation depends on PATH:**
- Risk: `officialGsdInvocation` in `src/services/gsdRunner.ts` executes the bare name `codex`, and `GsdUpdater` executes bare `npm` and `npx`. A malicious binary earlier in `PATH` would run.
- Files: `src/services/gsdRunner.ts`, `src/services/gsdUpdater.ts`
- Current mitigation: `shell: false` and fixed argument arrays.
- Recommendations: Resolve absolute binary paths where possible and surface the resolved path in the status output.

## Known Bugs and Functional Gaps

**Documented setting does not take effect:**
- Symptoms: Users who set `nearAi.autoInstallGsd` to `false` still see automatic installs.
- Files: `src/services/gsdUpdater.ts`, `src/extension.ts`, `src/services/settings.ts`
- Trigger: Any activation with `autoInstallGsd: false`.
- Workaround: None in the extension.

**NEAR account sign-in is not functional:**
- Symptoms: `nearAi.authMode` offers `nearAccount`, and `runSetup()` sets it, but the sign-in path reports that token exchange is "not yet configured". `ProfileStore` and `providerFactory.ts` throw "NEAR account sign-in is pending provider token exchange" for that mode.
- Files: `src/services/auth.ts` (`REFRESH_TOKEN_SECRET`), `src/services/providerFactory.ts`, `src/services/profileStore.ts`, `package.json`
- Trigger: Selecting "NEAR account sign-in" in setup or setting `nearAi.authMode` to `nearAccount`.
- Workaround: Use an API key (`nearAi.authMode: apiKey`).

**Unbounded HTTP requests with no timeout:**
- Symptoms: A stalled NEAR AI endpoint can leave a request pending indefinitely. Retries apply only to thrown errors and retryable status codes, not to timeouts.
- Files: `src/services/nearAiClient.ts` (`request` method, no `AbortSignal.timeout` or equivalent)
- Trigger: Network stall or a hung provider response.
- Workaround: The user can press Stop in the chat, which sends `assistant-cancelled`, but model-listing calls from setup have no such control.

**Legacy key migration path remains reachable:**
- Symptoms: `AuthService.importLegacyCredentials()` in `src/services/auth.ts` copies the unscoped `nearAi.apiKey` and `nearAi.refreshToken` secrets into project-scoped slots, but the legacy secrets are never deleted.
- Files: `src/services/auth.ts`
- Trigger: Explicit `confirmed` migration call.
- Workaround: None needed; the legacy secret remains readable in SecretStorage until removed manually.

## Performance Bottlenecks

**Full-file rewrite on every persisted mutation:**
- Problem: Every store serializes its entire ledger and rewrites the JSON file on each change. `activityStore.ts`, `teamStudio.ts`, `agentProfiles.ts`, `reputation.ts`, `projectInitialization.ts`, and `profileStore.ts` all do this, and `auditStore.ts` keeps `MAX_EVENTS` entries.
- Files: listed above
- Cause: Chosen storage format (single JSON document per store) with a write queue per instance.
- Improvement path: Append-only JSONL for activity and audit events, with periodic compaction.

**Layout of the graph view is O(n) per render and fixed to 720x420:**
- Problem: `renderGraph` in `src/services/chat.ts` (line ~865) rebuilds the SVG on every selection change and caps edges at 96, but node positions use a fixed 6-column grid. Large context graphs will overlap.
- Files: `src/services/chat.ts`
- Cause: Inline webview script with no virtualization or layout algorithm.
- Improvement path: Cap nodes in the server-side preview (already bounded in `contextGraph.ts`) and update the SVG incrementally.

## Fragile Areas

**Webview message protocol duplicated on both sides:**
- Files: `src/services/chatBridge.ts` (message parsing around lines 250-690), `src/services/chat.ts` (inline script, `window.addEventListener('message', ...)` around line 761)
- Why fragile: Message type strings (`assistant-delta`, `generation-preview`, `memory-slice-preview`, and others) are typed as a union in `chatBridge.ts` but hand-written as string literals in the webview script. A rename breaks the UI silently.
- Safe modification: Export the message type names from one module and reference them in both places, or add a contract test that parses the inline script.
- Test coverage: `src/test/chatBridge.test.ts` and `src/test/chat.test.ts` cover the bridge but not the inline script.

**Profile and project scoping identifiers:**
- Files: `src/domain/auth.ts` (`deriveProfileId`, `isProjectCredentialScope`), `src/services/auth.ts` (`scopedSecret`), `src/extension.ts` (`saveProfileCredential`)
- Why fragile: Secret keys are built from `projectId` and `profileId` by string interpolation (`nearAi.v2.<project>.<profile>.<kind>`). Scope validation happens in `assertScope`, but a stored `profileId` derived from a user-entered display name can collide after normalization.
- Safe modification: Keep scope validation as the only gate, and test collision behavior in `src/test/auth.test.ts`.

**Single-instance runner state:**
- Files: `src/services/gsdRunner.ts` (`active`, `activeCommand`)
- Why fragile: `GsdRunner.run()` throws if any process is active, and state is held on the instance. If the chat panel is disposed mid-run, the child process is not killed by `deactivate()`, which is an empty function in `src/extension.ts`.
- Safe modification: Track child processes in `context.subscriptions` and kill them on deactivate.

**Incomplete teardown in `deactivate`:**
- Files: `src/extension.ts` (`deactivate`)
- Why fragile: Body is a comment only, so the `GsdUpdater` interval, any active `GsdRunner` process, and in-flight generation polling are not cleaned up. `GsdUpdater.start()` does register its interval through `context.subscriptions`, so it is cleaned up by VS Code; the risk is limited to child processes.

## Scaling Limits

**Persisted history is capped by constants, not by budget:**
- Current capacity: `activityStore` and `agentOrchestrator` persist the last 50 agents and 20 events per agent; `generationService` keeps the last 50 operations and 50 artifacts; `multimodalOrchestrator` keeps 50 operations.
- Limit: Caps are counts, not bytes, so large prompts or artifact metadata can grow each file substantially.
- Scaling path: Add byte-size caps and truncate `safeText` fields more aggressively.

**Generated artifacts stored inline in the workspace:**
- Current capacity: `generationService.ts` writes binary outputs under `.planning/.near-ai/generated/` with `flag: 'wx'`, with no size ceiling in the code paths reviewed.
- Limit: Large video outputs can fill the workspace; the size of downloaded outputs is not bounded before `writeFile` in `generationService.ts`.
- Scaling path: Enforce a maximum artifact size before writing and stream writes for large payloads.

## Dependencies at Risk

**Build and test rely on `vsce` and `@types/vscode` 1.90 range:**
- Risk: `package.json` pins `@vscode/vsce` `^3.2.2` and `@types/vscode` `^1.90.0`, while `engines.vscode` is `>=1.90.0`. The VS Code fork ecosystem (the README says the panel targets "VS Code forks") may not expose `vscode.chat` at the minimum version; `extension.ts` guards this with `typeof vscode.chat?.createChatParticipant === 'function'`.
- Impact: Chat participant registration silently disappears on older hosts.
- Migration plan: Raise the minimum engine version when the chat participant API is required, or keep the guard and test the fallback path.

**Source tree includes compiled and packaged artifacts:**
- Risk: The project root contains 12 committed-looking `near-ai-vscode-0.1.x`/`0.2.x` `.vsix` files totaling several megabytes, plus `dist/`. `.gitignore` excludes `*.vsix` and `dist/`, but the files are present in the working tree and inflate every full-directory scan.
- Impact: Repository hygiene and accidental publication of stale builds.
- Migration plan: Move old `.vsix` builds to a release location outside the repository or keep only the latest one.

**Repository metadata is split:**
- Risk: The project root contains an empty `.git/` directory, a populated `.git-real/` directory, and an empty `.git-unusable-archive/`. `git` commands run from the project root report "not a git repository", and `.gitignore` references `.git-real/` and `.git-unusable-archive/` (which should not be in version control).
- Impact: Version control state is ambiguous, and tooling that relies on `git` at the root fails.
- Migration plan: Restore a single `.git` directory at the project root, and remove the archive directories once history is confirmed.

## Missing Critical Features

**No request timeout or cancellation for model listing:**
- Problem: `NearAiClient.listModels()` and `listModelsWithPricing()` accept an optional `AbortSignal` but no caller in the setup path passes a timeout.
- Blocks: Reliable validation in `ProfileStore.validate()` and `validateNearAiProvider()` in `src/services/providerFactory.ts`.

**No secret-scanning gate before publication of generated artifacts:**
- Problem: `generationService.ts` publishes outputs to a workspace path after a separate approval, but no content check runs on the published bytes.
- Blocks: Safe publication of generated content that may echo prompt text containing secrets.

## Test Coverage Gaps

**Untested modules with security or lifecycle impact:**
- What's not tested: `src/extension.ts` (activation, setup flows, `saveProfileCredential`), `src/services/gsdUpdater.ts` (install and version logic, auto-install gating), `src/services/handoff.ts` (checkpoint writing), `src/services/settings.ts` (`autoInstallGsd` read path), `src/services/panelView.ts`, `src/services/onboarding.ts`, `src/services/fleetView.ts`, `src/services/contextGraphMemory.ts`, `src/services/multimodalOrchestrator.ts`, `src/services/stakingService.ts`, `src/services/contextGraphStore.ts`.
- Files: as listed
- Risk: The auto-install bug and the unused setting were not caught because no test covers `gsdUpdater` activation. Credential-handling changes in `extension.ts` go unverified.
- Priority: High for `gsdUpdater.ts` and `extension.ts`; Medium for the rest.

**Domain modules without direct tests:**
- What's not tested: `src/domain/privacy.ts`, `src/domain/redaction.ts`, `src/domain/approval.ts`, `src/domain/routing.ts`, `src/domain/generation.ts`, `src/domain/multimodal.ts`, `src/domain/version.ts`, `src/domain/capabilities.ts`, `src/domain/analytics.ts`, `src/domain/agents.ts`.
- Files: as listed (tests for some of these behaviors may live in aggregate suites such as `src/test/policy.test.ts`)
- Risk: `redaction.ts` is the central secret filter, and its regressions would not be isolated.
- Priority: High for `redaction.ts` and `privacy.ts`; Medium for the rest.

**Webview inline script:**
- What's not tested: The browser-side script embedded in `src/services/chat.ts` and `src/services/onboarding.ts` has no automated tests.
- Files: `src/services/chat.ts`, `src/services/onboarding.ts`
- Risk: Message-type mismatches and accessibility regressions (keyboard handling, `aria-live` updates) ship unnoticed.
- Priority: Medium.

**Test runner convention:**
- What's not tested: `npm test` compiles to `dist/` and runs `node --test dist/test/*.test.js`. Test files live under `src/test/` and must match `*.test.ts` to be picked up. Any file that is not compiled is silently skipped.
- Files: `package.json` (`scripts.test`), `tsconfig.json`
- Risk: New test files placed outside `src/test/` will not run in CI.
- Priority: Low.

---

*Concerns audit: 2026-10-26*
