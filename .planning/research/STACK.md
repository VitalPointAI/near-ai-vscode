# Stack Research — Messaging relay with Teams and Signal adapters

**Domain:** Owner-hosted, multi-tenant messaging relay (webhook in → agent team run → message out), Node 26.13.1, adapters for Microsoft Teams and Signal
**Researched:** 2026-11-13
**Confidence:** MEDIUM overall (HIGH for facts confirmed in ≥2 independent fetched sources; MEDIUM for facts verified once via fetched official/npm/GitHub pages; see per-claim tiers in Sources). Claims known only from training data are listed at the end as phase-verify items and were NOT relied on for stack decisions.

> **Naming trap — three different "relays" in this repo's history.** This milestone's relay is the **new messaging relay** at `relay/`: receive inbound chat messages, drive an existing agent team, post results back. It is **not** (1) the paused v0.5.0 *ciphertext sync relay* (`.planning/milestones/v0.5.0-paused/REQUIREMENTS.md`, RELAY-01/02 — encrypted knowledge-base sync), and **not** (2) the planned `relayTransport.ts` board-sync transport on the unmerged Team Mode branch. Neither of those appears in this stack.

## Headline verdict

**The relay needs exactly one new runtime dependency (`jose`) plus Node 26 built-ins.** No HTTP framework, no Bot Framework SDK, no Agents SDK, no fetch library, no SQLite package, no test framework. The Teams adapter is ~200 lines of REST + JWT code the repo fully controls; the Signal adapter is a sidecar container (`signal-cli-rest-api`) the relay talks to with `fetch` and the built-in WebSocket client. Everything else the ecosystem would sell you is either retired, deprecated, redundant with a Node 26 built-in, or a supply-chain liability on a public-facing endpoint.

## Runtime baseline

| Item | Version | Verified | Notes |
|------|---------|----------|-------|
| Node.js | **26.13.1 'Lithium' (LTS)** | [nodejs.org release post](https://nodejs.org/en/blog/release/v26.13.1) — 2026-11-11, security release | Fixes 16 CVEs, 9 of them High, concentrated in **http2 and TLS** — the exact modules a public webhook server runs. Ship the relay on this patch, not on a stale 26.x. Bundled deps updated in this release: undici 8.12.4, SQLite 3.54.1, llhttp 9.4.4. EOL 2029-04-30 per owner decision. |
| engines pin | `"node": ">=26.13.1 <27"` in `relay/package.json` | owner decision + release page | Extension CI stays on Node 24 (owner decision); only the relay workspace pins 26. CI for `relay/` should install 26.13.1 explicitly. |
| TypeScript | `^5.7.2` (already a root devDependency) | `package.json` | No new dependency; relay workspace gets its own `tsconfig.json`. |

## Recommended Stack

### Core Technologies (relay workspace)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| **`node:http`** | built-in (Node 26.13.1) | Webhook server: `POST /api/messages` (Teams), inbound-from-signal endpoint, `/healthz` | The whole public surface is 2–4 routes. Hand-rolling the router (~100 lines: method match, path match, JSON body with a hard size limit, timeouts via `server.requestTimeout`/`headersTimeout`) keeps the attacker-controlled parsing path fully auditable and adds zero supply-chain surface. Alternatives only pay off when route count grows (see Stack Patterns). |
| **global `fetch`** (undici 8.12.4 in 26.13.1) | built-in | All outbound REST: Teams token fetch, Teams Connector reply calls, Signal sidecar send calls, JWKS fetch | Node's official guidance: built-in fetch is undici and is the right default; the standalone `undici` npm package is only for niche needs (custom Agents/diagnostics) not present here. Per-node 26.13.1 release, the built-in undici is freshly security-patched. Pair every call with `AbortSignal.timeout()` and pass `AbortSignal`s from run cancellation. |
| **global `WebSocket` client** | built-in, stable (unflagged since Node 22; certainly present in 26) | Subscribing to the Signal sidecar's inbound message stream (`/v1/receive/{number}`) | No `ws` package needed — the relay is a WebSocket *client* here, and the built-in client supports reconnect logic written in ~20 lines. |
| **`node:sqlite`** (`Database` class) | built-in, **Stability 1.2 — Release candidate** (Node 26 docs; `DatabaseSync` is a deprecated alias, DEP0210; SQLite engine bumped to 3.54.1 in 26.13.1) | Persistence: tenant allowlist, conversation/thread→run mapping, in-flight run state, spend ledger rows | Survives restarts (owner requirement), crash-safe writes with WAL, queryable, **no native build step** (better-sqlite3 would require node-gyp/toolchain in CI and in the container). Sync API is fine for a single-process relay at owner-scale. Use `database.backup()` for snapshots. |
| **`jose`** | **6.2.14** (npm, published 2 days ago; ~7,100 dependents; MIT; pure JS, zero transitive deps) | Inbound Bot Framework JWT verification + JWKS rotation: `createRemoteJWKSet()` + `jwtVerify()` | This is *the* security boundary of the Teams adapter, and JWKS handling is exactly where hand-rolled JWT code silently fails (key rotation timing, `kid` misses, alg confusion, clock skew). `jose` is the de-facto maintained JWT library for web-interoperable runtimes, uses Node's WebCrypto (`globalThis.crypto`, stable since Node 20 → fully Node 26 compatible), adds no native code and no transitive deps. Hand-rolling with `node:crypto` (`crypto.createPublicKey({ key: jwk, format: 'jwk' })` + `crypto.verify('RSA-SHA256', …)`) **is feasible** and documented below as the fallback — but a vetted implementation beats a bespoke one at the trust boundary. Verify its `engines` range at install time. |
| **`node:crypto`** | built-in | `timingSafeEqual` for tenant/requestor allowlist comparisons, `randomUUID()` for run IDs, HMAC (shared-secret checks on the Signal ingress hop), and the primitives if `jose` is ever dropped | Everything needed for the non-JWT crypto in this design is first-class in Node 26. |
| **`node:test` + `node:assert`** | built-in | Relay tests | Already the repo's runner (`"test": "node --test dist/test/*.test.js"`), so relay tests run the same way; no jest/vitest. JWT-validation tests can feed recorded Bot Framework token fixtures. |
| **`AbortController` / `AbortSignal.timeout()`** | built-in | Webhook timeouts, in-flight model-call cancellation mapped to run cancel/steer | Matches the steer/abort machinery `src/agent/loop.ts` already uses. |

### Teams adapter — verified protocol facts (build from these; no SDK)

All from [Bot Framework REST connector authentication](https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0) (Microsoft Learn, canonical, © 2026):

- **Outbound token (client credentials):**
  `POST https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token` — the `botframework.com` tenant shape verified live during research (`GET .../v2.0/.well-known/openid-configuration` → HTTP 200, 2026-11-13), `Content-Type: application/x-www-form-urlencoded`, body `grant_type=client_credentials&client_id=<APP_ID>&client_secret=<SECRET>&scope=https%3A%2F%2Fapi.botframework.com%2F.default`. Response carries `expires_in: 3600` — **cache the token ~55 min** (refresh before expiry; refresh proactively rather than on 401).
- **Outbound reply:** `POST <serviceUrl>/v3/conversations/{conversationId}/activities` with `Authorization: Bearer <token>`. The documented Teams example serviceUrl is `https://smba.trafficmanager.net/teams/...`. **Never hardcode serviceUrl** — take it from the inbound activity (and see the `serviceUrl` claim check below; it differs per tenant/region).
- **Inbound validation (every `POST /api/messages`, no exceptions):** `Authorization: Bearer <JWT>`; fetch OpenID metadata from `https://login.botframework.com/v1/.well-known/openidconfiguration` (static, hardcodable) whose `jwks_uri` is `https://login.botframework.com/v1/.well-known/keys`; then require **all** of: issuer == `https://api.botframework.com`; audience == the bot's Microsoft App ID; within validity with **5-minute clock skew**; RS256 signature from a key in the JWKS; **`serviceUrl` claim == activity's `serviceUrl`**; key cache refreshed **at least every 24 hours**; 403 on any failure. Endorsement checks for channel IDs are optional per config.
- **Multi-tenancy hook (phase-verify field paths):** enforce the tenant allowlist from `activity.conversation.tenantId` (Teams activities) **before** doing any work, and key sessions on tenant + conversation + thread + requestor AAD object id, as PROJECT.md specifies. Exact field paths (`conversation.tenantId`, `channelData.team.id`, threaded reply ids of the form `19:...;messageid=...`) are training-knowledge, not doc-verified here — one `console.log` against a real activity settles it in phase 1.
- **Group → 1:1 flow (phase-verify semantics):** replying into the originating thread = posting an activity with the thread-qualified conversation id; opening the private working thread = proactive message to the requestor, which requires the bot app to be **installed for that user (personal scope)** — plan the Azure app + Teams admin consent accordingly. These Teams-behavior specifics are the main items to verify live in the first Teams phase.

**SDK verdict — `botbuilder`/Bot Framework SDK: do not use.** Verified: Microsoft's Teams docs (updated 2026-11-03) state the Bot Framework SDK *"is no longer supported as an SDK for creating bots or agents"*; an archived Microsoft notice reports support tickets stopped 2025-12-31; `botframework-connector` on npm is 4.23.3, last published ~1 year ago. Building on a retired SDK for a security-critical adapter would be backwards.

**SDK verdict — Microsoft 365 Agents SDK (`@microsoft/agents-hosting`, 1.7.2, actively published; this is the current successor, and "Teams AI Library" / `@microsoft/teams.ai` was deprecated in June 2026 in favor of agent frameworks): do not use for this relay either.** The Agents SDK is the right answer when you want SDK-managed bot lifecycle, and it is what a *future migration* would target — but it pulls a substantial transitive dependency tree and models a single-bot app, while this relay is deliberately a thin, multi-tenant, allowlist-first webhook with its own session keys and its own approval/spend engine. The raw REST + `jose` path is ~200 lines and keeps the dependency story at one package. Revisit only if the relay later needs Teams message extensions, Adaptive Cards prompts, or Channels-heavy features.

### Signal adapter — verified protocol facts

From [AsamK/signal-cli](https://github.com/AsamK/signal-cli) (GPL-3.0, ~5.0k stars, active) and [bbernhard/signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) (MIT, ~2.9k stars):

- **signal-cli** is the only real self-hosted bridge (unofficial Java client over patched libsignal-service-java). Current line **v0.14.x** (v0.14.10 listed on release trackers, ~Oct 2026). **Needs JRE 25** for the JVM build, or the experimental GraalVM native binary. Hard operational rule from upstream: *"releases older than three months may not work correctly"* — Signal server changes break old clients. Pinning a version is not enough; the relay's upgrade runbook must bump signal-cli roughly quarterly.
- **Recommended topology: `bbernhard/signal-cli-rest-api` sidecar container, `MODE=json-rpc`** (a single JVM signal-cli daemon — fastest reliable mode; `json-rpc-native` exists but rides the experimental GraalVM build). The relay then needs **zero Signal-specific dependencies**: outbound = `POST /v2/send` (`{"message", "number", "recipients": [...or groupId]}`); inbound = subscribe to the websocket `/v1/receive/{number}` with the built-in WebSocket client.
- **Set `JSON_RPC_RECEIVE_MODE=manual`** on the sidecar: in the default `on-start` mode, messages arriving while no websocket subscriber is attached are *silently dropped*; in `manual` mode they stay queued server-side until the relay re-attaches. This directly answers "how does a thread survive the bot being restarted."
- **Set `JSON_RPC_IGNORE_ATTACHMENTS=true`** (and stories/avatars/stickers) so the bridge does not auto-download attacker-supplied files; fetch on demand only if a feature needs it.
- **Registration:** one-time — link as a secondary device via `GET /v1/qrcodelink?device_name=...` (scan from the owner's phone), or register a dedicated number (`register` → possible CAPTCHA → `verify CODE` / `--voice`). Persist the sidecar's config volume (`/home/.local/share/signal-cli`) or the number's identity keys are lost on container recreation.
- **Security boundary (matches PROJECT.md):** Signal E2E stops at the bridge. Everything arriving over that websocket is untrusted content under the repo's existing rules; the bridge container must never hold a NEAR AI key; the relay→sidecar hop stays on the compose-internal network.
- **Fallback if the wrapper container stagnates:** run the signal-cli JVM daemon directly (`signal-cli -a NUMBER jsonRpc` style daemon, JSON-RPC over TCP/unix socket) and speak JSON-RPC 2.0 from Node with `node:net` — still zero npm dependencies, at the cost of owning the JVM process and upgrade cadence. This is the escape hatch that makes the wrapper choice low-risk. (Phase-time check: confirm the wrapper's bundled signal-cli version is <3 months old at adoption.)

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| esbuild (already a root devDependency) | Optional bundling of `relay/` to a single `dist/relay.js` for the container | Same pattern as the extension's bundle; otherwise ship compiled tsc output. Not a new dependency. |
| Docker / docker-compose (or podman-compose) | Process topology below | Two services: relay + signal sidecar. |
| `@types/node@^26` (dev-only, verify minor at setup) | TypeScript for Node 26 globals (`fetch`, `WebSocket`, `node:sqlite`) | Root stays on `@types/node@^22` for the extension; the relay workspace carries its own. |
| gitsign/provenance not needed | — | Owner-hosted, single-tenant-operator deployment. |

## Installation

```bash
# relay/ gets its own package.json (npm workspace or standalone).
# Runtime dependencies — the entire list:
npm install jose              # ^6.2.14 — Teams inbound JWT/JWKS only

# Dev dependencies:
npm install -D typescript@^5.7.2 @types/node@^26
```

Everything else in the relay is Node 26 built-ins. `signal-cli-rest-api` arrives as a container image, not an npm package.

## Container & process topology

Verified image: **`gcr.io/distroless/nodejs26-debian13`** exists (distroless nodejs README lists nodejs22/24/26-debian13; entrypoint is `node`; use the `:nonroot` variant). Distroless = no shell, no package manager — smallest attack surface for an internet-facing box. If debugging-by-exec inside the container is ever needed, build a debug variant from `node:26.13.1-slim` instead of shipping one.

```yaml
# relay/deploy/docker-compose.yml (sketch)
services:
  relay:
    image: ghcr.io/<owner>/near-ai-relay:${TAG}      # multi-stage:
    #   build: node:26.13.1-slim → npm ci, tsc/esbuild
    #   final: gcr.io/distroless/nodejs26-debian13:nonroot
    environment: [TEAMS_APP_ID, TEAMS_APP_SECRET(FromEnv/mount), TENANT_ALLOWLIST, SIGNAL_BRIDGE_URL, ...]
    ports: ["443:8080"]          # TLS terminates at the reverse proxy in front
  signal-bridge:
    image: bbernhard/signal-cli-rest-api:<pinned tag>   # verify bundled signal-cli age at pin time
    environment: [MODE=json-rpc, JSON_RPC_RECEIVE_MODE=manual, JSON_RPC_IGNORE_ATTACHMENTS=true]
    volumes: ["signal-identity:/home/.local/share/signal-cli"]   # registration survives restarts
    # no published ports — reachable only from relay on the compose network
volumes: { signal-identity: {} }
```

The Teams adapter needs no sidecar — Teams traffic is plain HTTPS webhooks. Only Signal has a bridge process. SQLite lives on a relay volume (plus `database.backup()` snapshots).

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Raw REST + `jose` Teams adapter | `@microsoft/agents-hosting` (365 Agents SDK, 1.7.2, MIT, very active) | If the relay grows Teams-native features (message extensions, Adaptive-Card interactive prompts, rich channel support) or the owner prefers SDK-managed auth at the cost of a larger dependency tree. It is the correct migration target if raw REST ever feels under-supported. |
| Raw REST Teams adapter | `botbuilder` / `botframework-connector` 4.23.3 | **Never** — retired SDK, stale package. Listed only to close the question. |
| `node:http` micro-router | `hono` 4.13.x (MIT, published days ago, ~5k dependents, first-class Node adapter, zero-dep framework) | If the relay's own management/status API grows past ~6 routes or middleware needs accumulate. Hono is the *sanctioned* framework if one is ever wanted; it adds no native code. Express/Fastify rejected below. |
| `node:sqlite` | JSON files on disk | Only if the state model stays trivial — it won't (runs, spend rows, mappings, allowlist). JSON files lose atomicity across restarts exactly when the relay is killed mid-run. |
| `bbernhard/signal-cli-rest-api` sidecar | Direct signal-cli JVM daemon via `node:net` JSON-RPC | If the wrapper image's bundled signal-cli goes stale (>3 months) or the extra wrapper layer becomes a liability. Same zero-npm-dep property either way. |
| Distroless nonroot | `node:26.13.1-slim` final image | If the deployment needs a shell/package manager in the image (not recommended for the public relay). |
| Hosted Signal bot providers | — | Rejected by owner decision already: messages would leave owner infrastructure. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `botbuilder` / `botframework-connector` | Bot Framework SDK **retired** (no longer supported for bot creation; support tickets ended 2025-12-31; npm package stale ~1 year) | Raw Connector REST + `jose` |
| Teams AI Library (`@microsoft/teams.ai`) | **Deprecated June 2026** by Microsoft in favor of dedicated agent frameworks | The existing agent loop — that's what the relay drives |
| `express` / `fastify` / `nestjs` | Framework + transitive dependency tree on the attacker-controlled ingress for 2–4 routes; abstraction hides the timeout/body-limit behavior you must reason about on a public endpoint | `node:http` (~100-line router, fully auditable); `hono` if routes multiply |
| `axios`, `got`, `ky`, `node-fetch`, `undici` (npm) | Redundant with global `fetch` (undici 8.12.4, security-patched in 26.13.1); each is another advisory surface on a public service | `fetch` + `AbortSignal` |
| `jsonwebtoken` | Less actively maintained than `jose`; historic algorithm-confusion class of bugs; you'd configure it back toward what `jose` does by default | `jose@^6` |
| `ws`, `socket.io` | Relay is only a WebSocket **client** (to the Signal sidecar); built-in client suffices | global `WebSocket` |
| `better-sqlite3`, `sqlite3`, Prisma, Drizzle(+driver) | Native build steps (node-gyp/toolchain) in CI and container; ORM weight for ~4 tables | `node:sqlite` (`Database`) |
| `dotenv` | Node 26 loads env files natively (`node --env-file`); containers pass env directly | env / `--env-file` |
| `pino`/`winston` (for now) | Relay logging needs are JSON-lines to stdout; add structure with ~20 lines; a logger dependency is defensible later, not now | `console.log(JSON.stringify(...))` on stdout, log collection at the proxy |
| Copilot Studio / hosted bot platforms / Signal bot-API providers | Messages and identity leave owner infrastructure — violates the owner's stated constraint that the relay stays the only outward surface | Owner-hosted relay + adapters |
| Adding anything else "while we're at it" | Every runtime dep on a public multi-tenant endpoint is permanent attack surface with the owner's name on it | Justify each dep against a Node 26 built-in first |

## Stack Patterns by Variant

**If Teams is the only channel a tenant uses:** relay runs single-container (distroless), no sidecar, SQLite on a volume. Signal sidecar can be added later without relay changes — it's an adapter registration plus env.

**If Signal is enabled:** add the sidecar service as above; keep it off the public network; accept the quarterly signal-cli bump as a scheduled maintenance task (calendar it — upstream's 3-month compatibility window is a hard constraint, not a suggestion).

**If route count grows** (admin API, status streaming, per-tenant management): introduce `hono@^4` on the existing `node:http` server pattern (Hono's Node adapter wraps `node:http`; the ingress code shape stays recognizable). Do not migrate preemptively.

**If JWKS-edge paranoia wins:** drop `jose`, hand-verify with `node:crypto` (`createPublicKey({key, format:'jwk'})`, `verify('RSA-SHA256')`, manual iss/aud/exp/nbf/serviceUrl checks + 24h JWKS refresh) — but keep the verification test suite that feeds recorded Bot Framework tokens either way.

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| Node 26.13.1 | all recommended deps | Only `jose` is runtime npm code; pure JS over WebCrypto — no native bindings, no ABI coupling to the Node version. Verify `jose` engines at install. |
| `jose@^6.2.14` | Node ≥ WebCrypto-era runtimes (Node 20+ historically) | ESM-first; relay should be ESM (`"type": "module"`) or use dynamic import — match whatever `relay/tsconfig` picks; the extension bundles separately so no conflict. |
| `node:sqlite` (`Database`) | Node ≥ 26 (RC stability), SQLite 3.54.1 bundled in 26.13.1 | `DatabaseSync` is the deprecated alias — use `Database`. Enable WAL via `exec('PRAGMA journal_mode=WAL')`. |
| signal-cli v0.14.x | Signal server protocol — **must stay <3 months old** | Upgrade runbook item, not a lockfile item. |
| Teams Connector REST v3 | stable for years (v3.1/v3.2 protocol tables unchanged in current docs) | Low churn risk; watch MS Learn "developer announcements" feed during the phase. |

## Integration with the existing repo (what the relay imports/reuses)

- **Reuse as-is (import into `relay/` from `src/`):** the team format loader (`src/agent/teamMarkdown.ts`, `parseTeam` used by `test/fixtures/teams/`), the approval/policy engine (`src/domain/policy.ts`, `src/agent/permissions.ts` — the relay must apply the same approve-risky rules to actions triggered from chat), and the untrusted-input handling rules the extension already applies to chat content.
- **Needs a small extraction:** the spend-tracking arithmetic and the agent loop (`src/agent/loop.ts`) must be instantiable **headlessly** (no `vscode` imports, no VS Code chat surface). `src/services/chat.ts` is the VS Code surface and is *not* reused — the relay writes its own thin transport that turns loop output into adapter messages. Phase 1 task: audit which of `src/agent/*` / `src/domain/*` import `'vscode'` and extract a pure core (likely into a shared workspace folder both the extension and `relay/` compile from).
- **Per-thread workspaces, spend caps, runtime isolation** (PROJECT.md security list) map onto the `runs` table in `node:sqlite` — one row per run with workspace dir, budget, tenant/requestor identity carried from the validated Teams/Signal inbound identity.
- **Node/runtime split:** the extension keeps Node 24 CI and its zero-runtime-dependency bundle; the relay workspace is where Node 26 and the single `jose` dependency live. The two must not share a lockfile.

## Sources

- Node.js release post **26.13.1 'Lithium' (LTS)** — https://nodejs.org/en/blog/release/v26.13.1 — release date, security contents, bundled dep versions — **HIGH** (release page + version echoed in Node 26 docs header; corroborated)
- Node.js 26 docs, **SQLite module** — https://beta.docs.nodejs.org/sqlite (26.13.0 docs) — Stability 1.2 release candidate, `Database` class, `DatabaseSync` deprecated alias — **HIGH** (official docs, sqlite version cross-checked in 26.13.1 release notes)
- Microsoft Learn, **Authenticate requests with the Bot Connector API** — https://learn.microsoft.com/en-us/azure/bot-service/rest-api/bot-framework-rest-connector-authentication?view=azure-bot-service-4.0 — token endpoint/scope, `expires_in: 3600`, OpenID/JWKS URLs, issuer/audience/serviceUrl/skew/24h-refresh requirements — **HIGH** (page canonical, last updated 2024-10-09)
- Microsoft Learn, **Legacy Tools and SDKs for Teams app development** (updated 2026-11-03) — https://learn.microsoft.com/en-us/microsoftteams/platform/legacy-tools-sdks — Bot Framework SDK "no longer supported as an SDK for creating bots or agents; Teams SDK is the successor" — **HIGH** (corroborated by migration-guidance page + secondary blog)
- Microsoft Learn, **BF SDK → Agents SDK migration guidance** — https://learn.microsoft.com/en-us/microsoft-365/agents-sdk/bf-migration-guidance — Agents SDK is the evolution — **MEDIUM** (official MS doc, single fetch)
- npm **@microsoft/agents-hosting** — 1.7.2, published minutes before search — **MEDIUM** (npm page fetch 403'd; version via npm search listing only — pin exact version at install)
- npm **botframework-connector** — 4.23.3, last published ~1 year ago — **MEDIUM** (npm listing); Bot Framework SDK retirement corroboration (support ended 2025-12-31) — secondary blog (i3solutions.com) — **MEDIUM**
- Teams SDK blog, **AI libraries → agent frameworks** (2026-06-16) — https://microsoft.github.io/teams-sdk/blog/ai-libraries-to-agent-frameworks/ — `@microsoft/teams.ai` deprecated — **HIGH** (official MS org site, corroborated by the AI-Integrations page in the same docs)
- GitHub **AsamK/signal-cli** README — JRE 25, JSON-RPC daemon, 3-month freshness rule, GPLv3, register/link/captcha — **HIGH** (official README); latest version v0.14.10 via release trackers (newreleases.io / SourceForge) — **LOW** (secondhand trackers; confirm on the GitHub releases page at adoption)
- GitHub **bbernhard/signal-cli-rest-api** README — modes (`normal`/`native`/`json-rpc`/`json-rpc-native`), `POST /v2/send`, `/v1/receive/{number}` websocket, `JSON_RPC_RECEIVE_MODE=manual` queue-vs-drop semantics, attachment-ignore env vars, MIT — **HIGH** (official README); image release recency & bundled signal-cli age — **LOW** (pin-and-verify at adoption)
- npm **jose** — 6.2.14, published 2 days before search, MIT — **MEDIUM** (single npm listing; corroborated by panva/jose GitHub description in results)
- npm **hono** — 4.13.x, published days before search — **MEDIUM** (single npm listing) + hono.dev docs confirming Node adapter
- GitHub **GoogleContainerTools/distroless** nodejs README — `gcr.io/distroless/nodejs26-debian13` exists, entrypoint `node` — **HIGH** (official repo README; image existence to be confirmed by first pull)
- Node.js undici guidance (built-in fetch vs npm undici) — https://undici.nodejs.org/best-practices/undici-vs-builtin-fetch — **MEDIUM** (official project docs, single fetch)

**Items verified only against training knowledge — MUST be checked live in the first phase:** Teams activity field paths for tenant/thread/requestor ids; proactive-1:1 install requirements and thread-reply id semantics; Signal group-id wire format for `/v2/send`; `jose` and `@types/node@26` exact engines ranges at install.

---
*Stack research for: messaging relay + Teams/Signal adapters (Node 26.13.1)*
*Researched: 2026-11-13*
