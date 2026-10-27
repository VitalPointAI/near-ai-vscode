---
last_mapped_commit: 0dd12e6e15b0daf804d8c3d1d896241992426082
last_mapped_at: 2026-10-27
---
# External Integrations

**Analysis Date:** 2026-10-27

## APIs & External Services

**NEAR AI Cloud (primary inference provider):**
- Service: NEAR AI Cloud OpenAI-compatible API, default base URL `https://cloud-api.near.ai/v1` (`src/domain/config.ts` `DEFAULT_BASE_URL`; overridable via `nearAi.baseUrl` and `NEAR_AI_BASE_URL`)
- Client: custom `fetch`-based client `NearAiClient` in `src/services/nearAiClient.ts` (no SDK package)
- Endpoints used (paths relative to base URL):
  - `GET /models` - model catalog (`nearAiClient.ts`, ~line 167)
  - `GET /models/pricing` - preferred pricing source when it returns rows (~line 210)
  - `POST /chat/completions` - chat and streaming completions (~line 247)
  - `POST /images/generations` - image generation for the `GenerateImage` agent tool (~line 226)
  - `POST /audio/transcriptions` - multipart speech-to-text (~line 237)
  - `GET /signature/{chat_id}?model=&signing_algo=ecdsa` - per-response signature (`src/services/attestation.ts`)
  - `GET /attestation/report?model=&nonce=&signing_algo=ecdsa&signing_address=` - TEE attestation report (`src/services/attestation.ts`)
  - A billing/costs path under `/billing/costs` is referenced in tests (`src/test/`) for spend reconciliation
- Auth: API key stored in VS Code SecretStorage; sent as a bearer credential by `NearAiClient`. Key entered through the `nearAi.setup` flow (`src/extension.ts`, `src/services/auth.ts`)
- Routing metadata: responses carry the upstream provider (e.g. `anthropic`, `openrouter.ai`) so the UI can label a model as private (TEE) or forwarded (`src/services/nearAiClient.ts` line ~59)
- Privacy enforcement: `nearAi.privacyMode = tee-only` blocks forwarded models (`src/services/privacyPreflight.ts`, `src/services/outboundGuard.ts`)
- Model defaults (from `package.json` configuration):
  - Chat: `z-ai/glm-5.3`
  - Deep sub-agent tier: `moonshotai/kimi-k3`
  - Standard sub-agent tier: `z-ai/glm-5.3`
  - Fast sub-agent tier: `z-ai/glm-5.3-flash`
  - Vision: `z-ai/glm-5.3-flash`
  - Transcription: `openai/whisper-large-v3`
  - Image generation: `black-forest-labs/FLUX.2-klein-4B`

**Local OpenAI-compatible runtime (optional):**
- Service: any user-run OpenAI-compatible server on loopback (`http://localhost` or `http://127.0.0.1`)
- Config: `localBaseUrl` on `local` or `hybrid` profiles (`src/services/providerFactory.ts`, `src/domain/auth.ts`)
- Client: same `NearAiClient`; calls `GET /models` to list local models, all labelled as running on this machine (`nearAiClient.ts` ~line 183)
- Non-loopback `http://` URLs are rejected (`isSecureEndpoint` in `src/extension.ts`, `src/domain/config.ts`)

**Open-GSD package registry (npm):**
- Service: npm registry, package `@opengsd/gsd-core`
- Used for: discovering latest version (`npm view @opengsd/gsd-core@latest version --json`) and installing via `npx --yes @opengsd/gsd-core@<version> --claude --global` (`src/gsd/runtime.ts` lines ~53, ~83)
- Install target: extension storage, with `CLAUDE_CONFIG_DIR` set to the extension-managed directory; the user's `~/.claude` is not modified
- Controlled by `nearAi.autoInstallGsd` (default `true`)

**Remote web fetch (agent tool):**
- `src/gsd/tools.ts` lets the agent fetch `https://` URLs only; `http:` and other schemes are refused (lines ~133, ~159). Private/internal address targets are blocked by the same tool's guard.

**NEAR blockchain RPC and staking (read-only, currently gated):**
- Staking domain: `src/domain/staking.ts`, `src/services/stakingService.ts`
- Requires verified `rpcEndpoint` and `entitlementEndpoint` values (both must be `https:`), otherwise staking reports "unavailable"
- Read calls: `readNativeBalance`, `readPoolBalance`, `readTransactionStatus` via a `ReadOnlyStakingRpc` interface
- Default state: `StakingService.unavailable()` wires unavailable RPC and entitlement stubs; no default RPC URL is hard-coded
- Wallet bridge: `src/services/walletAuthorization.ts` is an external-wallet-only interface. Its default implementation throws on `connect()` and `signAndSend()`; no keys are managed by the extension

**Browser hand-off:**
- `https://cloud.near.ai/` opened via `vscode.env.openExternal` for account/key management (`src/extension.ts` line ~217)

**Attestation verification (local):**
- `src/services/attestation.ts` verifies Intel TDX quotes locally against a trusted root (`trustedRoot` option). Platform TCB status, certificate revocation collateral, enclave measurements, and NVIDIA GPU attestation are explicitly not checked (`NOT_CHECKED_IN_EDITOR`).

## Data Storage

**Databases:**
- None. No database client or ORM is present in `package.json` or `src/`.

**Local persistent state (filesystem):**
- Per-project runtime state: `.planning/.near-ai/` (profile metadata, activity, audit). Git-ignored (`.gitignore`). Services: `src/services/profileStore.ts`, `src/services/activityStore.ts`, `src/services/auditStore.ts`, `src/services/analyticsStore.ts`, `src/services/contextGraphStore.ts`
- Handoff file: `.planning/HANDOFF.json` (git-ignored)
- Chat transcripts: VS Code extension storage on the local machine, never inside the project (`nearAi.agent.saveTranscripts`; `src/services/transcripts.ts`)
- Checkpoints: `src/agent/checkpoints.ts`
- Open-GSD runtime: extension storage under `NEAR_GSD_HOME` override or default extension path (`src/gsd/runtime.ts`, `src/gsd/host.ts`)

**File Storage:**
- Local filesystem only. Attachments handled by `src/agent/attachments.ts` and `src/services/multimodalIntake.ts`.

**Caching:**
- In-memory and provider cache: `src/services/providerCache.ts`
- No external cache service (no Redis or Memcached)

## Authentication & Identity

**Auth Provider:**
- NEAR AI Cloud API key, with optional refresh-token flow
  - Stored in VS Code SecretStorage (`src/services/auth.ts`, `SecretStorageLike` interface)
  - Refresh token stored under its own secret slot (`REFRESH_TOKEN_SECRET`)
  - Hybrid profiles keep the local runtime's optional key in a separate slot (`localKeyScope` in `src/domain/auth.ts`)
  - Project-scoped credential scopes: `ProjectCredentialScope` (`src/domain/auth.ts`)
- Organization/team profiles: `src/domain/auth.ts` `OrganizationProfile`, team management via `src/services/agentTeams.ts`, `src/services/teamStudio.ts`
- No OAuth provider, SSO, or identity vendor SDK in use
- Credentials are never written to project files or sent to agents as configuration text (per onboarding copy in `src/services/onboarding.ts`)

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, Datadog, or similar SDK detected.

**Logs:**
- VS Code output/console logging from the extension host
- Local audit log: `src/services/auditStore.ts` (stored under `.planning/.near-ai/`)
- Spend and analytics recorded locally: `src/services/analyticsStore.ts`; `nearAi.dailySpendLimitUsd` enforced client-side

## CI/CD & Deployment

**Hosting:**
- VS Code Marketplace distribution as `.vsix` (`near-ai-vscode-0.4.0.vsix` present at repo root; `.vsix` files are git-ignored)
- Publisher: `VitalPoint`

**CI Pipeline:**
- No CI configuration file detected in the repository root (no `.github/workflows` checked in this scope). Release verification is local: `npm run verify:release`.

## Environment Configuration

**Required env vars:**
- None required for normal extension use. Configuration is entered through VS Code settings and the Set Up command.
- Optional for tests and live runs: `NEAR_AI_API_KEY`, `NEAR_AI_BASE_URL`, `NEAR_LIVE_EVAL`, `NEAR_LIVE_GSD`, `NEAR_LIVE_TRACE`, `NEAR_LIVE_EVAL_OUT`, `NEAR_GSD_HOME`

**Secrets location:**
- VS Code SecretStorage (API key, refresh token, hybrid local key)
- Repo-level `.env` and `.env.*` are git-ignored. Their presence is noted only; contents were not read.
- `.aws/` directory exists at repo root; contents not read or recorded.

## Webhooks & Callbacks

**Incoming:**
- None. The extension exposes no HTTP server endpoints. `node:http` is used only in tests and loopback validation.

**Outgoing:**
- NEAR AI Cloud REST calls listed above (`/chat/completions`, `/models`, `/models/pricing`, `/images/generations`, `/audio/transcriptions`, attestation and signature endpoints)
- npm registry calls for Open-GSD version and install
- Arbitrary `https://` fetches only when the agent invokes the web-fetch tool (`src/gsd/tools.ts`)

---

*Integration audit: 2026-10-27*
