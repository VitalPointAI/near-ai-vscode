# External Integrations

**Analysis Date:** 2026-10-26

## APIs & External Services

**NEAR AI Cloud (primary inference provider):**
- Base URL: `https://cloud-api.near.ai/v1` by default, overridable via `nearAi.baseUrl` (`src/domain/config.ts`, `package.json`)
- Client: hand-written wrapper `NearAiClient` in `src/services/nearAiClient.ts` using global `fetch` (injectable via `fetchFn` option for tests)
- Auth: `Authorization: Bearer <api key>` header, sent in `request()` in `src/services/nearAiClient.ts`
- Endpoints called:
  - `GET /models` - model catalog (`listModels`)
  - `GET /models/pricing` - pricing metadata
  - `POST /chat/completions` - non-streaming and streaming chat (`streamChat`, `streamChatEvents`; body sets `stream: true` for streaming)
  - `POST /images/generations` - image generation (`generateImage`)
  - `POST /images/edits` - multipart image edit (`editImage`, `FormData` with an `image` part)
  - `GET /usage/{requestId}` - post-hoc usage and cost reconciliation (`reconcileUsage`)
- Response metadata: request id, provider, token counts, and verification or attestation status are read from response headers and bodies (`metadataFromHeaders`, `usageFromPayload`, `normalizeModelInfo` in `src/services/nearAiClient.ts`). Models can report TEE/verification fields (`verification_status`, `tee_status`, `attestation_status`).
- Provider wiring: `src/services/providerFactory.ts` (`createNearAiProvider`) resolves a provider from a validated organization profile. Dispatch is refused for `nearAccount` mode until token exchange exists.

**NEAR AI Cloud (console, web only):**
- `https://cloud.near.ai/` is opened with `vscode.env.openExternal` from `openApiKeyPortal()` in `src/extension.ts` so the user can create an API key. The extension does not call this host programmatically.

**NEAR blockchain (staking and entitlement, not live):**
- Domain model and guarded services exist in `src/domain/staking.ts` and `src/services/stakingService.ts`. The config carries `networkId`, `rpcEndpoint`, `validatorAccount`, and `entitlementEndpoint`. Endpoints must be `https:` (`safeEndpoint` in `src/domain/staking.ts`).
- `ReadOnlyStakingRpc` and `EntitlementReader` are interfaces (`src/services/stakingService.ts`). No concrete RPC or entitlement client was found in `src/`.
- The only runtime instance is `StakingService.unavailable()`, used in `src/services/chat.ts` and `src/extension.ts`. Status reads and staking writes therefore return "unavailable" in the shipped code path.
- Writes are gated: a fingerprinted transaction preview, explicit confirmation matching the fingerprint, a fresh approval, and a non-expired wallet session are all required before `signAndSend` (`src/services/stakingService.ts`).

**External wallet (NEAR account sign-in, stubbed):**
- `ExternalWalletAuthorizationBridge` in `src/services/walletAuthorization.ts` wraps an `ExternalWalletAdapter`. It creates a `wallet-state-*` UUID, a TTL of 5 minutes (clamped 1 s to 15 min), and tracks pending states.
- `UnavailableWalletAuthorization` is used when no adapter exists. No concrete wallet adapter is wired in the extension.
- `nearAi.authMode = nearAccount` reports `pending-near-sign-in` (`src/services/auth.ts`) and is not usable for inference.

**Open-GSD runtime (local process, not a network service):**
- `codex` CLI is spawned with `spawn` (no shell) in `src/services/gsdRunner.ts` to run `$gsd-<command>` inside the workspace. Commands are restricted to the catalog in `src/domain/gsdCommands.ts`.
- Output is parsed as JSON lines and redacted (`redactSecrets` in `src/domain/redaction.ts`).

**npm registry (`@opengsd/gsd-core`):**
- `src/services/gsdUpdater.ts` runs `npm list --global @opengsd/gsd-core --depth=0 --json`, `npm view @opengsd/gsd-core@latest version --json`, and `npx --yes @opengsd/gsd-core@latest --codex --global` (or `--local` in the workspace root).
- Checks run at activation and every 24 hours (`GSD_CHECK_INTERVAL_MS`). Controlled by `nearAi.autoInstallGsd` (default `true`).
- Requires network access to the npm registry and an installed npm/npx on the host.

## Data Storage

**Databases:**
- None. No database client, ORM, or SQL/NoSQL driver is present in `package.json` or `src/`.

**Local persistent state (JSON files, not a database):**
- File-backed stores that use `node:fs/promises` include `src/services/activityStore.ts`, `src/services/auditStore.ts`, `src/services/contextGraphStore.ts`, `src/services/profileStore.ts`, `src/services/resumableExecution.ts`, and `src/services/projectInitialization.ts`. `src/services/analyticsStore.ts` is a separate store for usage analytics.
- Project planning state is read and written under `.planning/` (`src/services/gsdStatus.ts`, `src/services/projectInitialization.ts`).

**File Storage:**
- Local filesystem only. Multimodal intake stages images and other files for upload (`src/services/multimodalIntake.ts`). Staged image bytes are kept out of durable telemetry, per the comment on `editImage`.

**Caching:**
- In-memory model cache in `NearAiClient` (`this.models`, `rememberModels`). No external cache service.

## Authentication & Identity

**Auth Provider:**
- NEAR AI Cloud API key, stored in VS Code `SecretStorage` (`src/services/auth.ts`, key `nearAi.apiKey`).
  - Saved and removed through `saveApiKey` / `removeApiKey` in `src/services/auth.ts`; the Setup UI that calls them is in `src/services/onboarding.ts` and `src/extension.ts`.
  - Per-project scoped keys (`saveScopedApiKey` / `getScopedApiKey`, `SCOPED_SECRET_VERSION = 2`) are defined in `src/services/auth.ts` and scope validation in `src/domain/auth.ts`.
- NEAR account sign-in: `nearAi.refreshToken` secret slot exists in `src/services/auth.ts`; the token exchange is pending.
- Credential handling: `trim()` and non-empty checks before storage; secrets never written to settings or the `.planning/` files.

**Webview security:**
- Webviews use a nonce-based CSP `default-src 'none'; script-src 'nonce-...'` (`src/services/onboarding.ts`).

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, Datadog, or similar SDK found.

**Logs:**
- Local audit and activity stores (`src/services/auditStore.ts`, `src/services/activityStore.ts`) and analytics (`src/services/analyticsStore.ts`). Text is passed through `src/domain/redaction.ts` before display or storage.
- Per-request usage and verification metadata are attached to chat responses (`UsageMetadata` in `src/services/nearAiClient.ts`).

## CI/CD & Deployment

**Hosting:**
- VS Code Marketplace / `.vsix` distribution. Publisher `VitalPoint`, name `near-ai-vscode` (`package.json`). No marketplace upload script found in the repo.
- Local install helper: `scripts/install-global-extension.mjs`.

**CI Pipeline:**
- Not detected. No `.github/workflows/`, `.gitlab-ci.yml`, or similar config in the repository root.

**Release verification:**
- `npm run verify:release` runs `npm run package` then `scripts/verify-release-content.mjs` to check packaged contents.

## Environment Configuration

**Required configuration at runtime:**
- NEAR AI Cloud API key (entered through Setup; stored in SecretStorage). Required for `apiKey` mode.
- `codex` CLI on PATH for Open-GSD commands.
- Network access to `cloud-api.near.ai` (inference), `cloud.near.ai` (key portal, browser only), and the npm registry (GSD auto-install).

**Optional settings:**
- `nearAi.baseUrl`, `nearAi.defaultModel`, `nearAi.actionPolicy`, `nearAi.autoInstallGsd`

**Secrets location:**
- VS Code SecretStorage (OS keychain-backed) for API keys and refresh tokens. Nothing is stored in `.env` by the extension. The repo's `.aws/` directory exists at the project root; its contents were not read and it is not referenced by the source.

## Webhooks & Callbacks

**Incoming:**
- None. The extension exposes no HTTP server or webhook receiver.

**Outgoing:**
- NEAR AI Cloud HTTPS endpoints listed above. No other outbound webhooks found.

---

*Integration audit: 2026-10-26*
