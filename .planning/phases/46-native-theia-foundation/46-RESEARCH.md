# Phase 46: Native Theia foundation - Research

**Researched:** 2026-11-23
**Domain:** Eclipse Theia 1.77.0 browser product (Node backend, inversify modules, JSON-RPC), OpenBao (KV v2, Transit, jwt auth) from a session backend, oauth2-proxy token forwarding, UBI 9 container build and supply chain (SBOM, scan, key-mode signing), Playwright against a container, this repository's compliance fit gate.
**Confidence:** HIGH for Theia internals, OpenBao API shapes, oauth2-proxy step-up, the repository's gates. MEDIUM for the UBI 9 + Node 26 image recipe (the pieces were run, the assembled build was not) and for cosign v3 key-mode flags (not run).

Tag key: `[VERIFIED: ...]` = the caller's "[verified]" (read in source this session, or run this session). `[CITED: ...]` = official documentation read this session. `[ASSUMED]` = the caller's "[unverified]". In-repo discrete values are quoted verbatim beside the path and lines they came from.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Owner decisions carried in (2026-11-23)
- **D-01 (owner, D1):** Theia (Sterling-branded edition; the Sterling and SovAI names are intended) is the sole development target. Releases ship as a versioned container image published by digest. In this phase the image is built, scanned, given an SBOM and signed; the release cutover is later (see Deferred).
- **D-02 (owner, D2):** On-premise and fully air-gapped. Nothing in the image needs the internet at run time; the image build can use internal mirrors (npm registry and base-image registry configurable).
- **D-03 (owner, D4):** One person, one Theia session (Theia Cloud, `sessionsPerUser: 1`). The workbench backend serves exactly one person; it never multiplexes people.
- **D-04 (owner, D5):** Secrets live in OpenBao, per person. Single-machine installs fall back to the OS keyring through the same interface. No secret is held only in memory: if neither store is available the workbench says so and saving a secret fails visibly.
- **D-05 (owner, D6):** No passwords. The workbench never shows a password prompt; step-up re-authentication goes back to the identity provider (Keycloak, Phase 47) with `max_age` or `acr_values`.
- **D-06 (owner, D7):** Hosted sessions offer only model servers your organization's policy lists and never scan or listen for servers. In this phase model server addresses come from configuration and the backend makes no discovery calls; reading them from the organization-signed policy follows Phase 41.
- **D-07 (owner, D9):** Every new resource passes `node scripts/resource-check.mjs` before it is used. A resource that needs the internet or uses unvalidated cryptography is never a plain `pass`.
- **D-08 (owner, D10, D11):** Vocabulary: "your organization", never the provider's name in front of "organization"; NEAR AI is only an AI service; Sterling and SovAI are the intended edition and command-category names; no generic "project" word for what a work area holds; one Defence Team mode (not built here).
- **D-09 (owner, O2 to O6 accepted):** HAProxy ingress; one shared parent domain for passkeys; re-enrolment only where policy says hardware only; pin Theia Cloud upstream; volume size and idle timeout per site. None changes product code here, except that the workbench must not assume a per-site relying-party ID.

#### Package and build (P1, P11)
- **D-10:** The workbench lives in a new top-level folder `workbench/`, a package like `hub/` and `relay/`: its own `package.json` and lockfile, exact versions, `npm ci --ignore-scripts` with named native rebuilds only, its own CI job modelled on the `hub` job (presence check, lint, test, container build and checks). Nothing remains only under `.planning/spikes/`. The spike folder keeps a short README pointing to `workbench/` (deleting it needs the owner's approval).
- **D-11:** The source of the move is the Sterling spike on local branch `docs/theia-container-release` (the superset the design cites: Get Started, rail, four work-area pages, Portfolio, Resource Inventory, Compliance, Documentation, Team Studio preview). PR #162 (`feat/theia-foundation-review`) is the reviewed subset; its review findings apply to the moved code (D-12). If #162 merges first, the move starts from `main` plus the extra files from `docs/theia-container-release`. The local branch is not on origin: the executor reads it with `git show docs/theia-container-release:<path>`.
- **D-12 (from the #162 reviews):** The moved code fixes: the image binds to `127.0.0.1` by default and listening on every interface needs an explicit setting (the Theia Cloud pod sets it); the runtime image carries no dev dependencies; node-pty is rebuilt for the terminal or the terminal package dropped (default: rebuild); the build writes only inside `workbench/` (no `../../../dist`), and the backend finds engine bundles relative to its own package, never `process.cwd()`; the Team preview reader compares against the realpath of its fixture directory; the two command handlers in `src/extension.ts` and `src/services/modelComparisonPanel.ts` attach a `.catch()` that reports the error (if #162 has not already).
- **D-13 (P11):** One Node major for the workbench image and the hub. Default: Node 26 for both (the hub already requires `>=26.13.1 <27`), provided research confirms Theia 1.77's backend and native addons run on Node 26. If they do not, the plan records the evidence and the owner decides (see "For the owner to confirm"). The hub moves toward a UBI 9 base in the same change only if that is a base swap with its existing container test passing; otherwise it is noted for Phase 47.
- **D-14:** Theia stays pinned at exactly 1.77.0 (all `@theia/*` the same version). An upgrade is its own change.

#### Backend service pattern (P2)
- **D-15:** One pattern for every native widget that calls engine code: a `common/` interface and path constant, a backend `ConnectionHandler` with `RpcConnectionHandler`, and a frontend proxy, as the spike's `TeamPreviewService` already does. The pattern is a small shared helper (one function or module), not a framework. The engine code it calls is the existing host-neutral code under `src/`, bundled with esbuild into `workbench/` (the spike's `build:parser` approach, made to write inside the package).
- **D-16:** "The same refusals the extension host gives": the backend service calls the same engine entry point the extension calls, and refusal results cross the RPC as plain data with their reason, never as thrown host objects. The tracer slice is the Team preview service moved onto the shared helper; one refusal path is shown end to end.

#### Durable secrets (P3)
- **D-17:** `OpenBaoKeyStoreService` implements Theia 1.77's `KeyStoreService` contract and replaces it with `rebind(KeyStoreService)` in a backend module. Every `SecretStorage` call from the compatibility host and every Theia AI credential then reads and writes OpenBao KV v2 at logical path `kv/users/<entity_id>/<service>/<account>` (API path `kv/data/users/...`; mount configurable, default `kv`). `<service>` and `<account>` are encoded so no value can escape the person's prefix.
- **D-18:** The store is chosen at start: OpenBao when `STERLING_OPENBAO_ADDR` is set; otherwise the OS keyring (Theia's own keytar-backed implementation, built for the image's Node); otherwise the workbench starts with secrets unavailable and says so. Never a silent in-memory fallback.
- **D-19:** The OpenBao token used for KV is the session identity's token (P5), held in backend memory only and never sent to the frontend or written to disk.

#### Long-term keys (P4)
- **D-20:** `KeyService` (backend) offers `sign(message)`, `generateWrappedDataKey()` and `unwrapDataKey(wrapped)` against Transit: `transit/sign/<signing key>`, `transit/datakey/wrapped/<kek>` and `transit/decrypt/<kek>`. Key names are fixed per person from the OpenBao entity id: signing key `person-<entity_id>` (ed25519), key-encryption key `kek-<entity_id>` (aes256-gcm96). The workbench never creates, rotates, exports or deletes Transit keys; if a key is missing it says so and refuses.
- **D-21:** `sign` refuses unless the forwarded token's `acr` equals the configured step-up value and `auth_time` is within the configured window (`STERLING_STEPUP_ACR`, `STERLING_STEPUP_MAX_AGE_SECONDS`, default 300). The refusal names the fix ("Confirm with your passkey or security key") and the frontend can start the step-up sign-in. Unwrapping data keys needs an active session, not step-up.

#### Session identity (P5)
- **D-22:** At session start the backend reads the forwarded access token (header `X-Forwarded-Access-Token` from oauth2-proxy with `pass_access_token`; `X-Auth-Request-Email` and `X-Auth-Request-User` from `set_xauthrequest`) and `THEIACLOUD_SESSION_USER`, checks that they name the same person, and logs in to OpenBao `auth/<jwt mount>/login` with the token and the configured role. It keeps the OpenBao token in memory, renews it while the session is active, and revokes it (`auth/token/revoke-self`) when the session stops. How the headers reach Theia's backend (the token arrives on the HTTP upgrade of the WebSocket, and is refreshed by oauth2-proxy) is a research item.
- **D-23:** The identity part of the session state machine (DESIGN section 7) is implemented in the backend and visible to the person: `identity` to `active` (token issued) or `failed` (token missing, person mismatch, OpenBao unreachable: a plain reason and Retry; no secret is read); `active` renews; `stopping` drops the token. `identity` has a timeout; no state waits silently. Pod-level states (`pooled`, `requested`, `starting`, `claimed`, `idle-warned`) belong to Theia Cloud (Phase 47).
- **D-24:** Step-up: the workbench starts an OIDC re-authentication through oauth2-proxy (`/oauth2/start` with `max_age` or `acr_values`) and then reads the new token. If research shows oauth2-proxy cannot pass these, the plan states the fallback and it goes to the owner list. The design marks this **[unverified]**.
- **D-25:** Local mode: with no OpenBao address configured (single-machine install, the local Docker preview), session identity is "this computer", the OS keyring store is used, and `KeyService` reports long-term keys unavailable. Hosted mode is chosen only by configuration, never inferred from a missing header; in hosted mode a missing header is `failed`.

#### Air gap and egress (P8)
- **D-26:** In the image: Theia telemetry off; every update check off (Theia, the VS Code extension host, plugin and Open VSX update checks); the Open VSX address from `STERLING_OPEN_VSX_URL` (empty means no extension gallery); the AI packages pulled in by `@theia/plugin-ext` (`@theia/ai-core`, `@theia/ai-mcp`) with no default outbound providers; model server addresses from `STERLING_MODEL_SERVERS` only. A container test proves no outbound connection is attempted at start and during the browser smoke (the container on a network with no route out, asserting no connection attempts outside the allow list).
- **D-27:** The image build takes the npm registry and base-image registry from build arguments so an air-gapped build can use internal mirrors; defaults are the public ones for CI.

#### Browser harness (P9)
- **D-28:** Playwright against the built container, as a test inside `workbench/` (not the root e2e job), on `127.0.0.1` with a random port. Covers: Get Started opens; one native widget round-trips through the backend service; a secret saved survives a container restart against a test OpenBao; no outbound calls. Browsers come from the pinned Playwright release; the harness documents how to use a mirrored browser for air-gapped runs.
- **D-29:** The test OpenBao is a pinned `openbao/openbao` image by digest in dev mode, used only by tests (scope `test` in the register). Phase 47 owns production OpenBao.

#### Image build (P10 image part)
- **D-30:** Runtime base: a UBI 9 Node.js minimal image pinned by digest (DESIGN section 10: Debian and Alpine fail for Protected B). Non-root user, writable workspace and home only, no package-manager caches or lists left in layers, `EXPOSE 3000`, a healthcheck.
- **D-31:** CI builds the image on every PR touching `workbench/`, writes a CycloneDX SBOM with the pinned Syft and scans it with the pinned Grype (the `relay-image-scan` job's tools), and records the digest. Signing with your organization's key uses cosign in key mode (key in a protected environment secret, never keyless) on pushes to `main` only, and the signature and SBOM attestation are verified in the same job. The release cutover is deferred.

#### Compliance fit and copy (D9, section 15)
- **D-32:** `scripts/resource-check.mjs` learns the new manifests: `workbench/package.json` in `PACKAGE_FILES` and `workbench/Dockerfile` in `IMAGE_FILES`. It is a gate file: the change is minimal and owner approval is requested in the PR. Every direct dependency, image and action added gets an entry in `compliance/resources.json`, with the licence notes from the #162 review: Theia EPL-2.0 elected; `jschardet` LGPL-2.1+, `@vscode/codicons` CC-BY-4.0, and lockfile entries without a licence (`buffers`, `busboy`, `fuzzy`, `streamsearch`, `union`, `xmlhttprequest-ssl`) recorded as conditions on the Theia entries. Component id: `extension` (the product) until Phase 48 adds a workbench component.
- **D-33:** The copy lint's brand rule (GLOSSARY section 5, rule 3) accepts "Sterling" and "SovAI" as the edition and command-category names in the workbench package's user strings, and the lint scans the workbench's browser sources. "NEAR AI" stays the provider's spelling; "your organization" stays the user word. The baseline ratchet is kept.

### Claude's Discretion
- File layout inside `workbench/`, test file names, the shared RPC helper's name.
- Whether the Team preview fixtures ship as the sample in the image (default: yes, as today, plus test fixtures).
- Exact Playwright version (pinned, at least two weeks old) and whether Theia's own Playwright helpers fit.

### Deferred Ideas (OUT OF SCOPE)
- Release cutover (rest of P10): retire Marketplace publishing, publish releases by digest, move the compliance package and assessor evidence to the image. Default: its own follow-up after Phase 46, before 32.1 native ships.
- P6 and P7: Phase 33 native.
- Defence Team mode and its words (O1b): with 32.1 native.
- A `workbench` OSCAL component and evidence rules: Phase 48.
- Reading model servers from the organization-signed policy: after Phase 41.

(Scope fence from CONTEXT.md, also binding: product code only under `workbench/`, the two `src/` command handlers named in D-12, `scripts/resource-check.mjs` (two list entries), `compliance/resources.json`, the copy lint files, `.github/workflows/ci.yml` (one new job) and the signing step. No Helm charts, Keycloak realm, OpenBao policy files, runbooks or bundle scripts (Phase 47). No new framework: the RPC helper, key store and key service are plain Theia modules using Node's `fetch` for OpenBao (no OpenBao client library unless research shows a need, which then needs a register entry).)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-T-01 | `workbench/` package, own lockfile/build/tests/CI job; nothing only under `.planning/spikes/`; #162 fixes | Spike file inventory and Dockerfile read (section Architecture); #162 review findings mapped to exact lines; build-output-inside-package pattern; runtime `node lib/backend/main.js` (no `@theia/cli` at run time) |
| FND-T-02 | One shared JSON-RPC pattern; refusals as plain data | Spike `team-preview-backend-module.ts` and frontend binding read; `ServiceResult` shape; Pattern 1 |
| FND-T-03 | `KeyStoreService` rebind; per-person KV or OS keyring; survives restart; never memory-only | `KeyStoreService` interface quoted; default silently falls back to memory (must be overridden); consumers in the 1.77 image identified; KV v2 API; Pattern 2 |
| FND-T-04 | `KeyService` Transit sign / wrapped data key / unwrap; fresh `acr` and `auth_time` | Transit API shapes; `datakey/wrapped` returns ciphertext only; step-up check placement |
| FND-T-05 | Session identity from forwarded token + `THEIACLOUD_SESSION_USER`; jwt login; renew/revoke; `failed` + Retry; step-up | Header capture seams (`EarlyExpressMiddleware`, `MessagingListenerContribution`); OpenBao jwt/token API; oauth2-proxy `loginURLParameters` resolves D-24 |
| FND-T-06 | Open VSX and model addresses from config; telemetry and update checks off; no outbound proven by container test | Telemetry default `off`, no sink; no vsx-registry in image; `BackendRequestAllowedContribution`; reuse `hub/test/noOutbound.test.ts` hook |
| FND-T-07 | Playwright harness against built container in CI | Plain `@playwright/test` 1.65.0 recommended; `window.theia.container`; fixture-VSIX route for the real SecretStorage path |
| FND-T-08 | One Node major with the hub | Theia 1.77 supports Node 26 (CI matrix); UBI 9 has no Node 26 (run evidence); recipe |
| FND-T-09 | Digest-pinned UBI 9 image, CycloneDX SBOM, scan, key-mode signature on `main` | Digests; `relay-image-scan` pattern; cosign 3.1.4 pin and the `install-tool.sh` gap |
| FND-T-10 | Register entries, fit check covers workbench manifests; copy lint accepts Sterling names | `resource-check.mjs` discovery limits (3 traps); register entry list; copy lint scan roots |
</phase_requirements>

## Summary

Theia 1.77.0 is a good base for this phase and nearly everything CONTEXT.md assumes holds, but research found a set of facts that change how some decisions are implemented. The most important: (1) **there is no Red Hat Node 26 on UBI 9 today.** The `nodejs:26` module stream is not in the UBI repositories (a run of `microdnf module enable nodejs:26` on the current `ubi9/ubi-minimal` fails with "Unable to resolve argument 'nodejs:26'") and `registry.access.redhat.com/ubi9/nodejs-26*` returns 404. The working recipe is UBI 9 minimal (digest-pinned) plus the upstream Node 26.13.1 binary taken from the `docker.io/library/node` image the hub and relay already pin (run: it starts on UBI 9 once `libatomic` is installed). (2) Theia's default `KeyStoreServiceImpl` **silently falls back to an in-memory store** when keytar fails to load, so D-18's "never silent in-memory" needs an override of one protected method, not just a rebind. (3) The oauth2-proxy question (D-24) is **answered yes**: v7.15.6 passes `max_age`, `acr_values` or `prompt` from the `/oauth2/start` query to the identity provider when they are listed under `loginURLParameters` in its alpha (YAML) config; the legacy flags cannot do it. (4) Three traps in `scripts/resource-check.mjs` would let image pins and registry entries go wrong silently (`FROM ${ARG}` is skipped, `COPY --from=image` is not seen, first-party workspace packages in `dependencies` need an entry).

Theia 1.77.0's own CI builds and runs its headless, browser and electron test suites on Node 24 and Node 26 (engines `>=24`), the native addons that matter (`drivelist`, `keytar`, `node-pty`, `@parcel/watcher`) are all N-API (ABI-stable; Node 26 reports `napi=10`), and 1.77 is ES modules throughout. Node 26 is therefore supported, not just plausible, but Theia's own browser smoke runs only on Node 24: the first plan task must start the built image on Node 26 and open Get Started before anything else is built on it.

Header capture for session identity is simple: oauth2-proxy sends `X-Forwarded-Access-Token` on every upstream request, and Theia gives two backend seams that see headers (`EarlyExpressMiddleware` for every HTTP request, `MessagingListenerContribution.onDidWebSocketUpgrade` per WebSocket). The backend is single-user, so one process-wide "latest forwarded token" is correct. OpenBao needs only plain HTTPS calls (no client library). Everything the phase adds can be tested in three layers: fast Theia-free unit tests against a fake OpenBao, a container suite against a real dev-mode `openbao/openbao` image (pinned `2.7.3`, digest below), and one Playwright run.

**Primary recommendation:** Build `workbench/` on Node 26.13.1 (copied from the repo's existing digest-pinned `node:26.13.1-slim` stage) on `ubi9/ubi-minimal@sha256:08d4c70f...`, compile natives (`drivelist`, `node-pty`) in a UBI 9 build stage, run `node lib/backend/main.js` directly, keep all OpenBao, identity and key logic in Theia-free TypeScript modules with thin inversify wrappers, and use plain `@playwright/test` 1.65.0 with a tiny fixture VSIX to prove the real `SecretStorage` to OpenBao path survives a restart.

### Corrections and additions to CONTEXT.md (planner: read first)

| # | Finding | Effect on plans |
|---|---------|-----------------|
| C1 | No UBI 9 Node 26 image or module (run evidence below). | D-30 "UBI 9 Node.js minimal image" cannot be literal for Node 26. Use `ubi9/ubi-minimal` plus the upstream binary (recipe in Pattern 5), or, if the owner prefers a Red Hat built Node, Node 24 for workbench AND hub (hub change, out of scope). Owner item O-1. |
| C2 | `FROM ${ARG}` lines are skipped by `discover()` (`scripts/resource-check.mjs:79`), so a base image given through an ARG is neither pin-checked nor registered, and its register entry would be reported stale. | D-27's `BASE_REGISTRY` build argument must not be in `FROM`. Keep literal digest-pinned `FROM` lines; mirrors go through the builder's registry-mirror configuration. `NPM_REGISTRY` may stay an ARG. Owner item O-2. |
| C3 | `discover()` reads only `FROM` lines of Dockerfiles, not `COPY --from=<image>`. | Declare the node image as `FROM ... AS node` and `COPY --from=node`. Same for the test OpenBao image (stage `openbao-test`). |
| C4 | The first-party extension package must be listed in `workbench/package.json` `dependencies` for Theia to find it (the collector reads only `dependencies` and `peerDependencies`). | `discover()` will demand `npm:@near-ai/theia-team-preview` (or whatever it is renamed to). Add one `pass` entry, licence "MIT (this repository)". |
| C5 | A container has no D-Bus secret service, so the OS keyring branch of D-18 cannot work inside the image. | In the image: OpenBao or "secrets unavailable". The keyring branch is for non-container single-machine runs; unit-test it through the protected `getKeytar()` seam. Do not build keytar into the image (needs `libsecret` at build and run time). Owner item O-3. |
| C6 | In the 1.77 image only three things use `KeyStoreService`: core `CredentialsService` (so VSIX `SecretStorage`), `@theia/ai-mcp` (MCP OAuth tokens, service name `theia-ai-mcp-oauth`), and nothing else. AI provider API keys are preferences, not key store entries, and no provider package is in the image. | Test the two real consumers. Do not claim "every AI credential" until a provider package is added. |
| C7 | The pod and the proxy share one pod (`templateDeployment.yaml`: containers `oauth2-proxy` and the app). | `STERLING_LISTEN_HOST=0.0.0.0` may be unnecessary in Theia Cloud: the proxy can reach `127.0.0.1` in the pod. The proxy's upstream address is not in the repo templates [ASSUMED]. Tell Phase 47: keep 127.0.0.1 if the upstream is loopback; a pod-reachable port 3000 would bypass the proxy. |
| C8 | Theia 1.77 has its own WebSocket guard: a per-process connection-token cookie and an Origin-equals-Host check (or a `THEIA_HOSTS` allow-list). | Phase 47 must set `THEIA_HOSTS` if the proxy rewrites Host. Add to the interface table. |
| C9 | `transit/datakey/wrapped` returns only the wrapped key. | `generateWrappedDataKey()` returns ciphertext; getting a usable key is `unwrapDataKey` (a `decrypt` call). Policy needs both paths (already in the interface table). |
| C10 | OpenBao login response sample has no `entity_id`; the token docs do list `entity_id` on `lookup-self`. | After login, call `GET auth/token/lookup-self` and read `data.entity_id`. |
| C11 | Theia core has no health endpoint. | `/healthz` is two lines in the backend module (an early middleware route returning 200). |
| C12 | The copy lint's brand rule never flags "Sterling" or "SovAI" (`BRANDS` only knows NEAR AI and VS Code). What actually blocks the workbench is that the lint does not scan `workbench/` at all and that new files must start at zero hits on all seven rules. | D-33 is a scan-root change plus one positive test plus the GLOSSARY text, not a rule loosening. |
| C13 | `install-tool.sh` accepts only `zip` and `tar.gz`; cosign ships a bare `cosign-linux-amd64`. | A `binary` archive kind (about six lines) plus a `cosign` pin and TOOLS.md entry; needs the owner's tool approval (TOOLS.md precedent). Owner item O-4. |

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Sign-in, token refresh, forwarding `X-Forwarded-Access-Token` | Edge proxy (oauth2-proxy sidecar, Phase 47) | Identity provider (Keycloak) | The proxy owns the OIDC code flow and sends the token on every upstream request; the workbench only reads it |
| Session identity (read headers, check person, jwt login, renew, revoke, state machine) | API / Backend (Theia node backend) | Browser (shows state, Retry, step-up button) | The OpenBao token must live only in backend memory (D-19) |
| Secret storage (KV v2 paths, encoding, list/delete) | API / Backend (`KeyStoreService`) | Database / Storage (OpenBao) | `SecretStorage` plaintext transits the browser (secrets-main.ts runs in the frontend), but persistence and per-person scoping are backend and OpenBao |
| Long-term signing and data-key wrapping | Database / Storage (OpenBao Transit; private keys never leave) | API / Backend (`KeyService` client and freshness check) | Private keys never enter the session (FND-T-04) |
| Step-up re-authentication | Edge proxy (`/oauth2/start?...`) | Browser (navigates), Backend (reads new token) | Only the proxy and Keycloak can run a new WebAuthn ceremony |
| Native widgets and Get Started pages | Browser (Theia frontend modules) | API / Backend (RPC services) | Widgets render; engine code runs in the backend |
| Engine code (team parser etc.) | API / Backend (esbuild bundle of host-neutral `src/`) | None | The refusals must be the engine's own, returned as data |
| Egress policy (allow-list, telemetry off) | API / Backend (`BackendRequestAllowedContribution`, preferences) | Container network (Phase 47 NetworkPolicy) | Theia mediates frontend-originated requests; the container test is the backstop |
| Image build, SBOM, scan, signature | CI (GitHub Actions, protected environment for the key) | Registry | Not a runtime tier |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@theia/core`, `editor`, `filesystem`, `monaco`, `navigator`, `plugin-ext-vscode`, `preferences`, `terminal`, `workspace` | 1.77.0 exactly (D-14) | Theia browser app (the spike's runtime dependency set) | [VERIFIED: spike `package.json` and `package-lock.json`, registry `@theia/core@1.77.0`, published 2026-11-05] |
| `@theia/cli` | 1.77.0 (devDependency) | `theia build` only; never in the runtime image | [VERIFIED: spike `package.json`]; `theia start` is just `fork(lib/backend/main.js)` [VERIFIED: `@theia/application-manager` `application-package-manager.js` `startBrowser`] |
| Node.js | 26.13.1 (latest 26.x on nodejs.org, 2026-11-10; Active LTS) | Runtime for workbench and hub | [VERIFIED: nodejs.org `index.json`]; Theia 1.77 supports it [CITED: Theia `ci-cd.yml` matrix `node: [24.x, 26.x]`; root `package.json` `"engines": {"node": ">=24"}`] |
| `typescript` | 5.9.3 | Compile the extension (decorators and metadata need `tsc`, not esbuild) | [VERIFIED: spike and hub both pin it; already in register] |
| `esbuild` | 0.28.2 | Bundle the host-neutral engine from `src/` into `workbench/` | [VERIFIED: hub and spike pin it; already in register] |
| `@types/node` | 26.6.6 (as the hub) | Types | [VERIFIED: `hub/package.json`]; that `tsc` is clean against Theia 1.77's typings with 26 types is [ASSUMED] (Theia itself stays on 24) |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@playwright/test` | 1.65.0 (published 2026-11-05, 18 days old; 1.65.1 is 10 days old and too new for the "two weeks" rule) | Browser harness | FND-T-07. Dependency is `playwright@1.65.0`; licence Apache-2.0; engines node >=20 [VERIFIED: registry] |
| `node:test` + `scripts/run-tests.mjs` | built in | Unit and container tests | Same runner as hub (`hub/package.json` `"test"`); keeps TMPDIR cleanup |
| `node:https` / `node:http` | built in | OpenBao client | Per-connection `ca` (the CA bundle in `STERLING_OPENBAO_CA_FILE`), timeouts, any method. Global `fetch` cannot take a custom CA without the `undici` package (a new dependency). CONTEXT.md says `fetch`; `node:https` is the same "no library" idea and keeps `NODE_EXTRA_CA_CERTS` out of the image. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| plain `@playwright/test` | `@theia/playwright` 1.77.0 (deps `@playwright/test ^1.63.0`, `fs-extra`, `tslib`) | It is page objects for stock Theia DOM (menus, explorer, editors). The Sterling pages and rail are custom, and one extra dependency means one more register entry. Use plain Playwright; take only ideas (wait for the shell) from it. |
| upstream Node 26 binary on `ubi9/ubi-minimal` | Red Hat `nodejs:24` module (`ubi9/nodejs-24-minimal`, FIPS-capable system OpenSSL) | Splits the Node major from the hub (P11) unless the hub moves to 24. Revisit when Red Hat publishes `ubi9/nodejs-26-minimal` (the source already exists: `sclorg/s2i-nodejs-container` `26-minimal/Dockerfile.rhel9`). |
| `node:https` client | `undici` or an OpenBao SDK | A new dependency plus register entry for about 150 lines of calls. No need. |

**Installation (workbench/):**
```bash
# exact pins, lockfile committed, scripts off (D-10); named rebuilds only
npm ci --ignore-scripts
npm_config_build_from_source=true npm_config_nodedir=/usr/local npm rebuild drivelist node-pty
```
**Version verification (run 2026-11-23):** `@theia/core@1.77.0` published 2026-11-05T18:51Z; `@playwright/test` 1.65.0 published 2026-11-05, 1.65.1 2026-11-13 (registry `time`); `esbuild` 0.28.2 and `typescript` 5.9.3 already pinned by the hub.

## Package Legitimacy Audit

Run with `gsd-tools query package-legitimacy check --ecosystem npm ...` on 2026-11-23.

| Package | Registry | Age (pinned version) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@theia/core`, `editor`, `filesystem`, `monaco`, `navigator`, `plugin-ext-vscode`, `preferences`, `terminal`, `workspace`, `cli` | npm | 1.77.0 is 18 days old; the packages are years old | 19.9k to 38.5k per week | github.com/eclipse-theia/theia | SUS (reason `too-new`, from the version date only) | Approved by owner decision D-14 and used by the reviewed spike; that decision is the human verification, so no extra `checkpoint:human-verify` beyond confirming the lockfile resolves to the registry tarballs. No `postinstall` on any of these directly. |
| `esbuild` | npm | 2026-08-08 | 443M/wk | github.com/evanw/esbuild | OK | Approved (already in register). `install` script exists; `--ignore-scripts` skips it, as in the hub. |
| `typescript` | npm | 2026-07-08 | 451M/wk | github.com/microsoft/TypeScript | OK | Approved (already in register) |
| `@types/node` | npm | 2026-10-28 | 671M/wk | DefinitelyTyped | SUS (`too-new`, latest only) | Exact pin 26.6.6 is the hub's; approved |
| `@playwright/test` | npm | 1.65.0 is 18 days old | 139M/wk | github.com/microsoft/playwright | SUS (`too-new` applies to 1.65.1; the check could not take a version suffix) | Approved at 1.65.0. Registry: `license Apache-2.0`, no scripts. Browsers come from the Playwright CDN at test time, not from npm. |
| `node-pty`, `drivelist`, `keytar`, `@parcel/watcher` (transitive, rebuilt or prebuilt) | npm | 2025-12 / 2024-04 / 2022-02 / 2026-07 | 6.3M / 103k / 4.0M / 62M per week | microsoft/node-pty, balena-io-modules/drivelist, atom/node-keytar, parcel-bundler/watcher | OK | Transitive. `node-pty` has `postinstall node scripts/post-install.js` (permission fix) and `install node scripts/prebuild.js \|\| node-gyp rebuild`: run through the named `npm rebuild`, never through a blanket install. |

**Packages removed due to [SLOP] verdict:** none. (The check printed SLOP for the string `@playwright/test@1.65.0` only because it does not parse a version suffix; the bare name exists.)
**Packages flagged as suspicious [SUS]:** the ten `@theia/*` packages, `@types/node` and `@playwright/test`, all for recency only (see dispositions). No package was discovered through web search; all names come from the spike lockfile, the hub, or the Theia and Playwright registry pages.

Images and tools (not npm; legitimacy is by digest):
| Item | Pin (resolved 2026-11-23) |
|------|---------------------------|
| `registry.access.redhat.com/ubi9/ubi-minimal:latest` | `sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352` (index digest; RHEL 9.9; `openssl-libs-3.5.9-1.el9_9`) [VERIFIED: registry HEAD and a run] |
| `docker.io/library/node:26.13.1-slim` | `sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc` (already pinned in `hub/Dockerfile:10` and `relay/Dockerfile:7`, both `FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef2... AS build`) |
| `docker.io/openbao/openbao:2.7.3` | `sha256:ba4b133eb9586630024e71a617e66f37f29cc3534cdd46a6233e098ceded8dc9` (index digest; amd64, arm64, ppc64le, s390x, arm, riscv64; pushed 2026-11-19) [VERIFIED: Docker Hub API] |
| cosign 3.1.4 `cosign-linux-amd64` | sha256 `424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa` (from `cosign_checksums.txt` of release v3.1.4, 2026-10-20) [VERIFIED: release asset read] |
| Syft 1.57.2, Grype 0.122.1 | already pinned in `compliance/ci/tool-pins.json` |

## Architecture Patterns

### System Architecture Diagram

```
 person's browser --HTTPS--> oauth2-proxy (sidecar, Phase 47) --HTTP, adds X-Forwarded-Access-Token on EVERY request--> Theia backend (this phase)
                                    |                                                                                      |
                              OIDC code flow                         +-------------------------------+---------------------+---------------------------+
                              (Keycloak; step-up via                 | EarlyExpressMiddleware        | MessagingListener         | RpcConnectionHandler      |
                               /oauth2/start?max_age=..              | (every HTTP request)          | .onDidWebSocketUpgrade    | services (one per widget) |
                               &acr_values=..)                       +---------------+---------------+------------+--------------+------------+--------------+
                                                                                     v                            v                           |
                                                                           SessionIdentity (one per process: latest token, claims, state)     |
                                                                                     | state: identity -> active | failed ; stopping (onStop)  v
                                                                                     v                                              engine bundle (esbuild of src/,
                                                          OpenBaoClient (node:https, CA file, timeouts)                              relative to own package)
                                      login POST auth/<jwt>/login | lookup-self | renew-self | revoke-self
                                      KV v2: GET/POST/DELETE kv/data|metadata/users/<entity>/<enc service>/<enc account>
                                      Transit: sign/person-<entity>, datakey/wrapped/kek-<entity>, decrypt/kek-<entity>
                                                                                     ^
   VSIX SecretStorage (plugin host) -> browser CredentialsService -> /services/keyStore RPC -> KeyStoreService (rebound) ----+
   @theia/ai-mcp OAuth store (backend) -> KeyStoreService (rebound) -----------------------------------------------------------+
   no OpenBao address configured: keyring branch (keytar, never memory) or "secrets unavailable"
```

### Recommended Project Structure
```
workbench/
├── package.json            # app: exact @theia/* 1.77.0, devDeps, "theia" config, scripts; lockfile committed
├── package-lock.json
├── .npmrc                  # engine-strict=true, save-exact=true (as hub/.npmrc)
├── Dockerfile              # stages: node, build (UBI), runtime (UBI), openbao-test (never built by the product build)
├── Dockerfile.dockerignore # allow-list; keeps the root .dockerignore (pinned by a hub test) untouched
├── README.md               # build, run, env table, mirror notes, how to run the harness
├── extension/              # @near-ai/theia-team-preview (rename allowed), the one first-party Theia extension
│   ├── package.json  tsconfig.json
│   ├── assets/  fixtures/
│   └── src/{common,browser,node}/       # moved from the spike; shared helpers in common/ and node/
├── engine/                 # generated: esbuild output of host-neutral src/ (git-ignored)
├── tools/                  # build-engine.mjs (esbuild, writes into engine/), build-sterling-documentation.mjs
├── bin/                    # healthcheck.mjs (node), start.sh
├── scripts/build.mjs       # unit-test build (esbuild, like hub/scripts/build.mjs)
└── test/
    ├── *.test.ts           # fast unit tests (Theia-free modules, fake OpenBao over node:http)
    ├── container/*.test.ts # docker: image hardening, restart persistence, no-egress
    ├── e2e/*.spec.ts + playwright.config.ts
    └── fixtures/secret-probe/   # 20-line fixture VSIX (package.json + extension.js)
```
Keep the logic that needs tests in modules that import no `@theia/*` (OpenBao client, identity state machine, path encoding, JWT claim reader, key freshness check); the inversify classes are thin wrappers. That makes the unit layer fast and independent of loading Theia.

### Pattern 1: One backend service helper (P2, D-15, D-16)
**What:** Two small functions, one in `src/node`, one in `src/browser`, plus a result type in `src/common`. The spike's `TeamPreviewService` is the template.
**When to use:** every native widget that calls engine code.
```ts
// common/service-result.ts  (plain data, safe to send over RPC)
export type ServiceResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'refused'; readonly reason: string; readonly fix?: string };

// node/backend-service.ts   [pattern from the spike's team-preview-backend-module.ts]
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common/messaging';
import type { interfaces } from '@theia/core/shared/inversify';
export function bindBackendService<T extends object>(bind: interfaces.Bind, id: symbol, path: string, make: (ctx: interfaces.Context) => T): void {
  bind(id).toDynamicValue(make).inSingletonScope();
  bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(path, () => ctx.container.get<T>(id))).inSingletonScope();
}

// browser/frontend-service.ts   [pattern from the spike's team-preview-frontend-module.ts, its `bind(TeamPreviewService).toDynamicValue(...ServiceConnectionProvider.createProxy...)` line]
import { ServiceConnectionProvider } from '@theia/core/lib/browser/messaging/service-connection-provider.js';
export function bindFrontendService<T>(bind: interfaces.Bind, id: symbol, path: string): void {
  bind(id).toDynamicValue(ctx => ServiceConnectionProvider.createProxy<T>(ctx.container, path)).inSingletonScope();
}
```
Rule that satisfies D-16: a service method never throws for an expected refusal; it returns `{kind:'refused', reason}` built from the engine's own message. The tracer is `readProject` (spike result type `ready | missing | invalid`): `invalid` carries the parser's own message, which is the message the extension shows. Convert it to `ServiceResult` or keep the three-way type and add a test that one refusal text crosses the real RPC unchanged.

### Pattern 2: Rebinding `KeyStoreService` and never falling back to memory (P3, D-17, D-18)
Theia binds the service in core's backend module [VERIFIED: `@theia/core/lib/node/backend-application-module.js:98`]:
`bind(KeyStoreService).to(KeyStoreServiceImpl).inSingletonScope();` and the RPC handler resolves it lazily at line 99 (`ctx.container.get(KeyStoreService)`), so a rebind is honoured. Extension backend modules load after the modules of the packages they depend on [VERIFIED: `ExtensionPackageCollector.collectPackage` pushes dependencies before dependents], so `rebind` finds the original binding.
```ts
// node/key-store-module.ts
import { ContainerModule } from '@theia/core/shared/inversify';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
  rebind(KeyStoreService).toDynamicValue(ctx => chooseKeyStore(ctx)).inSingletonScope(); // OpenBao | keyring | unavailable
});
```
The interface to implement, quoted [VERIFIED: `packages/core/src/common/key-store.ts`]:
```ts
export const keyStoreServicePath = '/services/keyStore';
export interface KeyStoreService {
    setPassword(service: string, account: string, password: string): Promise<void>;
    getPassword(service: string, account: string): Promise<string | undefined>;
    deletePassword(service: string, account: string): Promise<boolean>;
    findPassword(service: string): Promise<string | undefined>;
    findCredentials(service: string): Promise<Array<{ account: string, password: string }>>;
    keys(service: string): Promise<string[]>;
}
```
**The silent fallback to defeat** [VERIFIED: `lib/node/key-store-server.js`, source `key-store-server.ts` `getKeytar`]: the default catches any keytar load or probe error, sets `this.keytarImplementation = new InMemoryCredentialsProvider()` and only logs a warning. For the keyring branch subclass `KeyStoreServiceImpl` and override the protected `getKeytar()` to rethrow (or, equivalently, implement the interface directly). A thrown error reaches the frontend as a rejected RPC, so `SecretStorage.store` rejects visibly (D-04, D-18). For "unavailable", bind an implementation whose six methods all throw one plain sentence.
**Consumers actually in the image (C6)** [VERIFIED: grep of the 1.77 tarballs]: `@theia/core` `CredentialsService`, which `@theia/plugin-ext` `secrets-main.ts` uses; `@theia/ai-mcp` `mcp-oauth-credential-store.js` and `mcp-oauth-client-provider-factory.js` (service name `theia-ai-mcp-oauth`, accounts like `<encoded server>:<encoded scope>:tokens`). Two consequences:
- `SecretsMainImpl` runs in the browser and uses `service = ${window.location.hostname}-${extensionId}` (quoted from `secrets-main.ts`: `` `${window.location.hostname}-${extensionId}` ``) and `JSON.stringify({extensionId, content: value})` as the value. The hostname is part of the KV path, so `localhost` and `127.0.0.1` are different stores, and a site rename orphans secrets. SecretStorage plaintext crosses the person's own browser; only the OpenBao token must stay out of it (D-19).
- Account strings are arbitrary (quotes, slashes, colons). **Encode each path segment** as `u` + base64url (never empty, no `/`, `.` or `..`, injective, reversible for `keys()` and `findCredentials()`); property-test round trip and that no input escapes `users/<entity>/`.
**KV v2 calls** [CITED: openbao.org/docs/api/secret/kv/kv-v2]: read `GET /v1/kv/data/<path>` (response `data.data`), write `POST /v1/kv/data/<path>` body `{"data":{...}}`, list `GET /v1/kv/metadata/<path>?list=true` (response `data.keys`, folders end in `/`), delete `DELETE /v1/kv/metadata/<path>` (removes all versions; `DELETE .../data/...` is a soft delete that keeps the value recoverable, so use metadata for `deletePassword`). A missing secret answers 404 [ASSUMED: standard Vault behaviour, not stated on the page]; map 404 on read to `undefined`.

### Pattern 3: Session identity and header capture (P5, D-22, D-23)
Two seams see request headers, both verified in the 1.77 tarball:
- `EarlyExpressMiddleware` (`@theia/core/lib/node/backend-application`): handlers pushed in `BackendApplicationContribution.initialize()` run before `express.static()`, for every HTTP request. This is exactly how core's `BrowserConnectionTokenBackendContribution` sets its cookie. Use it to call `identity.observe(req.headers)`.
- `MessagingListenerContribution.onDidWebSocketUpgrade(request: http.IncomingMessage, socket)` fires per WebSocket with the upgrade request's headers (socket.io `socket.request`). Use it for the same `observe`.
Because the backend serves one person (D-03), keep one process-wide record: latest `X-Forwarded-Access-Token`, parsed claims (`sub`, `email`, `exp`, `acr`, `auth_time`), and the time it was seen. oauth2-proxy adds the header to every upstream request when `pass_access_token` is set [VERIFIED: `legacy_options.go:216` "pass OAuth access_token to upstream via X-Forwarded-Access-Token header", `:250-251`]; the token in the header is whatever the proxy's session holds at that request, so the page load and any later HTTP request refreshes the record. A WebSocket that lives for hours carries only its connect-time token, which is why the HTTP seam matters.
**State machine** (this is the identity slice of DESIGN section 7; make it one pure module with a table-driven test):

| State | Trigger in | Leaves to |
|-------|-----------|-----------|
| `local` (no `STERLING_OPENBAO_ADDR`) | start | terminal; never inferred from a missing header (D-25) |
| `identity` | start in hosted mode | `active` (login ok); `failed` (no token within the timeout; person mismatch; OpenBao unreachable or refuses) |
| `active` | login ok | `active` (renew at about half the TTL; a 403 on renew re-logs-in with the latest unexpired forwarded token); `failed` (renew and re-login both fail, with the reason); `stopping` |
| `failed` | any failure above | `identity` (Retry; same code path as start) |
| `stopping` | `BackendApplicationContribution.onStop` | `stopped` after `revoke-self` (best effort within Theia's `SHUTDOWN_TIMEOUT_MS`; swallow errors) |
`onStop` runs on SIGINT and SIGTERM [VERIFIED: `backend-application.js:117-118` registers both; `backend-application.d.ts` documents `gracefulShutdown`], so a Kubernetes stop revokes the token. The state and its plain reason go to the frontend through a normal Pattern 1 service (with a client callback or polling); never the token.
**Person check:** compare `THEIACLOUD_SESSION_USER` (set per session by the operator [VERIFIED: `templateDeployment.yaml` `THEIACLOUD_SESSION_USER`]) with `X-Auth-Request-Email` (case-insensitive) and with the token's `email` claim when present; any difference is `failed: person mismatch`.
**Token handling:** decode the payload with `Buffer.from(seg, 'base64url')`; no JWT library. The signature is never trusted locally: the OpenBao jwt login verifies it. The `acr` and `auth_time` read for step-up are therefore a guard on the workbench side only (see Pitfall 5).
**OpenBao calls** [CITED: openbao.org/docs/api/auth/jwt, /auth/token]:
- Login: `POST /v1/auth/<mount>/login` body `{"role":"<role>","jwt":"<access token>"}` → `auth.client_token`, `auth.lease_duration`, `auth.renewable` (the doc sample has no `entity_id`: use lookup).
- Entity: `GET /v1/auth/token/lookup-self` → `data.entity_id`, `data.ttl`, `data.renewable`.
- Renew: `POST /v1/auth/token/renew-self` (optional `{"increment":"1h"}`) → new `auth.lease_duration`. Revoke: `POST /v1/auth/token/revoke-self` (revokes the token and its children).
- Token header: the docs use `X-Vault-Token` [CITED]; `Authorization: Bearer` and `X-OpenBao-Token` are [ASSUMED] to work; use `X-Vault-Token`.
- Role facts for Phase 47's policy: `bound_audiences`, `user_claim` (required, becomes the entity alias name), `bound_claims` (exact match; `bound_claims_type: glob` allows `*`), `token_ttl`, `token_max_ttl`, `token_policies` [CITED]. Keycloak access tokens often carry `aud: account`; the realm needs an audience mapper (Phase 47).

### Pattern 4: Step-up through oauth2-proxy (D-21, D-24) — resolved
oauth2-proxy `OAuthStart` passes the whole `/oauth2/start` query to `LoginURLParams(overrides)` [VERIFIED: `oauthproxy.go` v7.15.6, `OAuthStart` calls `p.doOAuthStart(rw, req, req.URL.Query())`]. `LoginURLParams` forwards a query parameter only if the provider has a `loginURLParameters` rule for that name and the value matches an `allow` rule [VERIFIED: `providers/provider_data.go:102-126`]. The rule `name` is a free string, so `max_age`, `acr_values` and `prompt` all work; the page does not list `max_age` or `acr_values` as examples [CITED: oauth2-proxy.github.io alpha-config], and the legacy `--acr-values` flag is fixed per proxy and "unavailable" with alpha config. So:
```yaml
# Phase 47, oauth2-proxy alpha config
providers:
- id: keycloak
  loginURLParameters:
  - name: acr_values
    allow: [{ value: "<STERLING_STEPUP_ACR value>" }]
  - name: max_age
    allow: [{ pattern: '^[0-9]+$' }]
  - name: prompt
    allow: [{ value: login }]
```
The workbench step-up action is a top-level navigation to `/oauth2/start?rd=<current page>&acr_values=<acr>&max_age=0` (a same-origin link; the proxy's `rd` rule applies). After the redirect back, the page load carries the new token and Pattern 3 reads the new `acr` and `auth_time`. That Keycloak then issues the requested `acr` and refreshes `auth_time` for `max_age=0` is [ASSUMED]; Phase 47's realm and the e2e step there prove it. Note the proxy must be set with `cookie_refresh` or the token it forwards can be stale; Keycloak supports refresh [CITED: oauth2-proxy overview].
**Fallback if Phase 47 cannot use alpha config:** a `prompt=login` fixed default is not enough (no `acr`); the fallback is two proxy routes (a second `/step-up` upstream-less path configured with a fixed `acr_values`) and is an owner decision. State it in the interface table as "alpha config required".

### Pattern 5: UBI 9 image with Node 26 (P11, P10; C1, C2, C3)
Evidence from runs on 2026-11-23: on `ubi9/ubi-minimal@sha256:08d4c70f...`, `microdnf module enable nodejs:20`, `:22` and `:24` resolve, `:26` fails with `Unable to resolve argument 'nodejs:26'`; `microdnf repoquery nodejs` after enabling 24 shows `nodejs-1:24.22.1-5.module+el9.8.0`. `registry.access.redhat.com/v2/ubi9/nodejs-26/tags/list` and `nodejs-26-minimal` return 404 (22 and 24 return 200). The upstream binary from `node:26.13.1-slim` runs on UBI 9: `ldd` reported only `libatomic.so.1 => not found`; after `microdnf install libatomic` it printed `26.13.1 3.5.9 glibc=2.34`. Node 26.13.1 refuses `--enable-fips` unless an OpenSSL `fips` provider is configured [CITED: nodejs/node v26.13.1 `doc/api/crypto.md:7150-7190`, "FIPS mode"], which matches the existing X8 condition on the hub image; FIPS is not an FND-T requirement and stays a condition in the register.
Native addons must be built against the glibc they will run on, so the build stage is UBI too (a Debian-built addon can reference a newer glibc than 2.34). UBI repos carry `gcc-c++-11.5.0`, `make-4.3`, `python3-3.9.25`, `libatomic` (all resolved by `microdnf repoquery`). The four addons are N-API, so GCC 11 is enough: Node 26's `common.gypi` asks addons for `-std=gnu++20` (line 601) which GCC 11 accepts, and N-API addons never include `v8.h` (the "GCC before 13" problem in Theia's CI is about V8 headers). That all four compile on UBI GCC 11 is [ASSUMED] until built; `python3.12` is the fallback if node-gyp complains about Python 3.9.
```dockerfile
# workbench/Dockerfile (skeleton; literal FROM lines so resource-check sees and pin-checks them)
FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS node
FROM registry.access.redhat.com/ubi9/ubi-minimal@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352 AS build
ARG NPM_REGISTRY=https://registry.npmjs.org/
RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install gcc-c++ make python3 libatomic tar gzip && microdnf clean all
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/include/node /usr/local/include/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm
# npm ci --ignore-scripts (all deps), named rebuilds, esbuild engine bundle, tsc, theia build, then:
#   npm prune --omit=dev   (no @theia/cli, typescript, esbuild, puppeteer in the runtime tree)
FROM registry.access.redhat.com/ubi9/ubi-minimal@sha256:08d4c70f1baf6537a0728656cf7942d561e74a35916509d205b6519861266352 AS runtime
RUN microdnf -y --nodocs --setopt=install_weak_deps=0 install libatomic && microdnf clean all && rm -rf /var/cache/* /var/log/dnf*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
# COPY --from=build the pruned app tree, chown 10001:0 g+rwX (arbitrary-UID friendly)
USER 10001:0
EXPOSE 3000
HEALTHCHECK CMD ["node","/app/bin/healthcheck.mjs"]
ENTRYPOINT ["/bin/sh","-c","exec node lib/backend/main.js --hostname \"${STERLING_LISTEN_HOST:-127.0.0.1}\" --port 3000 /home/sterling/workspace"]
# Declared only so resource-check sees the pin; BuildKit never builds an unreferenced stage. The container test reads this FROM line.
FROM docker.io/openbao/openbao:2.7.3@sha256:ba4b133eb9586630024e71a617e66f37f29cc3534cdd46a6233e098ceded8dc9 AS openbao-test
```
Use `workbench/Dockerfile.dockerignore` (BuildKit's per-Dockerfile ignore file; the spike already does) so the root `.dockerignore`, which `hub/test/dockerContext.test.ts` pins, is untouched. Build context is the repo root because the engine bundle reads `src/`. Mirrors: keep `NPM_REGISTRY` as an ARG (npm replaces the `registry.npmjs.org` host of lockfile URLs with the configured registry by default, `replace-registry-host=npmjs` [ASSUMED: npm docs, confirm in the first build with a throwaway registry]); mirror base images with the builder's registry-mirror configuration, not with ARGs in `FROM` (C2).
Hub: a UBI swap is **not** a plain base swap: `hub/test/container/container.test.ts` asserts no shell and no package manager (`FORBIDDEN_TOOLS = new Set(['sh', 'bash', 'dash', 'busybox', 'npm', 'npx', 'apt', 'apt-get', 'dpkg', 'curl', 'wget'])`), which UBI minimal violates. Record "hub base swap: Phase 47" as D-13 allows. FND-T-08 is satisfied by the major: both on 26.

### Pattern 6: Egress (P8, D-26)
What 1.77 does and does not do [VERIFIED by reading the tarballs]:
- Telemetry: `@theia/telemetry` (a hard dependency of `plugin-ext`) defaults `telemetry.telemetryLevel` to `'off'` (`telemetry-preferences.js`) and its backend module binds a `TelemetrySink` contribution point with no sink, so nothing is ever sent. Pin `telemetry.telemetryLevel: "off"` in the app's default preferences anyway and test the value.
- Open VSX: `@theia/vsx-registry` is not in the spike's lockfile, so there is no gallery and no `VSX_REGISTRY_URL` use (that package reads `process.env['VSX_REGISTRY_URL']?.trim() || 'https://open-vsx.org'`). Keep it out of the image. `STERLING_OPEN_VSX_URL` is then only an allow-list entry for the backend request facade (below) and a documented hook for a later gallery.
- No update checker exists in the browser target (the updater is electron only and `@theia/electron` is not installed). Other string literals with URLs in core, plugin-ext, ai-core and ai-mcp are links the user clicks, not requests, except `plugin-github-resolver.js` (a `github:` plugin source only fetched if someone configures one) and the plugin deployer's `THEIA_DEFAULT_PLUGINS` / `THEIA_PLUGINS` (leave unset or `local-dir://`).
- AI: `@theia/ai-core` registers no model provider (providers are separate `@theia/ai-*` packages, none installed) and `ai-features.mcp.mcpServers` is user configuration; MCP servers and any OAuth they need are the only outbound AI paths, and only when a person configures a server.
- Frontend-originated requests through the backend are filtered by `BackendRequestFacade`: `request()` throws `Request to URL '...' is not allowed. The URL does not match any allowed pattern.` unless a `BackendRequestAllowedContribution.getAllowedUrlPatterns()` returns a matching pattern [VERIFIED: `lib/node/request/backend-request-facade.js`]. With no contribution everything is refused. Contribute exactly the configured addresses: `STERLING_OPEN_VSX_URL` (if set) and the hosts of `STERLING_MODEL_SERVERS`. (The pattern matcher accepts only `http:` and `https:` and exact host or `*.suffix`.)
- Backend-side proof: reuse the hub's recording hook. `hub/test/noOutbound.test.ts:35-84` (`const HOOK = ...`) wraps `net.Socket.prototype.connect`, `tls.connect`, `dns.lookup`, `dns.promises.lookup`, `dgram.createSocket` and `globalThis.fetch`, appends one line per attempt to the file named by `NEAR_AI_TEST_OUTBOUND_LOG`, and is loaded with `--import` through `NODE_OPTIONS`. Copy the hook into the workbench container test, mount it read-only and pass `NODE_OPTIONS=--import /hook.mjs`; it is inherited by the plugin host and other forked children. Unlike the hub, the workbench legitimately connects to its own loopback and the test OpenBao: the test asserts every logged target is in the allow list. Run the container on a `docker network create --internal` network with the OpenBao container and a second container (the Playwright browser, or `docker exec`) so there is also no route out. Browser side: record `page.on('request')` and assert every URL's origin is the workbench origin (or `data:`/`blob:`).
- Listening: `--hostname` default is `localhost`, port default 3000 [VERIFIED: `backend-application.js:40-41,67-68`]. The image entrypoint above maps `STERLING_LISTEN_HOST` to it.

### Anti-Patterns to Avoid
- **`FROM ${BASE}` and `COPY --from=<image>`:** invisible to the compliance gate (C2, C3).
- **Subclassing `KeyStoreServiceImpl` without overriding `getKeytar`:** keeps the silent memory fallback.
- **Building into `../../../dist` or reading `process.cwd()`:** the #162 findings; use paths from `import.meta.url`.
- **Requiring the parser at module load:** the #162 reviewer noted a missing bundle then crashes backend start. Load lazily inside the call so a missing build becomes the "sample unavailable" refusal.
- **Putting the OpenBao token or the forwarded token in any RPC payload, log line, error text or `docker inspect` visible env.**
- **Treating a missing header as "local mode".** Hosted mode is chosen only by `STERLING_OPENBAO_ADDR` (D-25).
- **A blanket `npm ci` (with scripts) or a blanket `npm rebuild`:** it would run `puppeteer` (downloads Chrome), `@theia/ffmpeg` and others. Named rebuilds only.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-widget RPC plumbing | A bespoke socket protocol | `RpcConnectionHandler` + `ServiceConnectionProvider.createProxy` | Already how core services work; the spike proves it |
| Secret persistence | Files or an encrypted blob in the workspace volume | OpenBao KV v2 via the rebound `KeyStoreService` | The volume must hold no secrets (DESIGN section 7); the keyring branch reuses `KeyStoreServiceImpl` |
| OIDC login, refresh, step-up UI | Any password or login form | oauth2-proxy + Keycloak, step-up via `/oauth2/start` | D-05; oauth2-proxy already supports the parameters |
| Egress allow-list for frontend requests | A new request interceptor | `BackendRequestAllowedContribution` | Core already refuses everything not contributed |
| Outbound recording in tests | A packet capture setup | `hub/test/noOutbound.test.ts` HOOK | Already proven; catches fetch, net, tls, dns, udp |
| Container test hygiene | New helpers | `hub/test/container/container.test.ts` (`run`, `mustRun`, `freePort`, random suffix, `after` cleanup of exactly its own objects, never skips without Docker) | Same rules the repo already enforces |
| SBOM and scan | New tools | Syft 1.57.2 and Grype 0.122.1 through `compliance/ci/install-tool.sh` | Pinned and hash-checked already |
| JWT verification | A JOSE library | OpenBao's jwt login verifies; the backend only base64url-decodes claims | No dependency, no unvalidated crypto in the product |
| Time-limited HTTP client | A wrapper library | `node:https` with `AbortSignal.timeout` | About 150 lines for all calls |

**Key insight:** every piece of this phase is a thin adapter between a Theia seam and a documented HTTP API; the risk is not in code volume but in the seams being slightly different from what the design assumed (Section "Corrections"). Keep the adapters small and test them against the real services.

## Runtime State Inventory

Phase 46 moves the spike code into `workbench/` (a move, not a rename of a deployed thing).

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None. The spike has no deployed datastore; Theia's in-memory credential store is lost on restart by design | None; secrets begin in OpenBao |
| Live service config | None. PR #162 is unmerged and the spike branch is local only | None |
| OS-registered state | None | None |
| Secrets/env vars | The spike read none. New names this phase introduces: `STERLING_LISTEN_HOST`, `STERLING_OPENBAO_ADDR`, `STERLING_OPENBAO_CA_FILE`, `STERLING_OPENBAO_JWT_MOUNT` (default `jwt`), `STERLING_OPENBAO_JWT_ROLE` (default `sterling-workbench`), `STERLING_OPENBAO_KV_MOUNT` (default `kv`), `STERLING_OPENBAO_TRANSIT_MOUNT` (default `transit`), `STERLING_STEPUP_ACR`, `STERLING_STEPUP_MAX_AGE_SECONDS` (default 300), `STERLING_OPEN_VSX_URL`, `STERLING_MODEL_SERVERS` | Document once in `workbench/README.md`; these are the interface Phase 47 reads |
| Build artifacts | The spike's `node_modules/`, `lib/`, `src-gen/` and webpack outputs are git-ignored and not committed; the local `local-plugins/` is ignored | None. Pointer README stays under `.planning/spikes/theia-team-studio/` |

## Common Pitfalls

### Pitfall 1: Silent in-memory secrets
**What goes wrong:** keytar cannot load in a container, the default service logs a warning and keeps secrets in memory; they vanish on restart.
**Why it happens:** `getKeytar()` catches everything (quoted above).
**How to avoid:** Pattern 2. **Warning signs:** a log line `OS level credential store could not be accessed. Using in-memory credentials provider`; the restart test is the proof.

### Pitfall 2: Secrets keyed by browser hostname
**What goes wrong:** the `SecretStorage` service name starts with `window.location.hostname`; reaching the app as `localhost` then `127.0.0.1`, or after a DNS change, shows an empty store.
**How to avoid:** the harness and the docs use one hostname; say so in the README; do not "fix" it in Theia code (a change there is not ours).

### Pitfall 3: Header and cookie guards of Theia 1.77
**What goes wrong:** WebSocket upgrades are rejected (a) when the `theia-connection-token` cookie is absent (set on the first HTTP page load, `SameSite=Strict`), and (b) when `Origin`'s host differs from the `Host` header and `THEIA_HOSTS` is unset [VERIFIED: `ws-origin-validator.js`, `browser-connection-token.js`]. A proxy that rewrites `Host`, or a test client that connects without loading the page first, fails.
**How to avoid:** Playwright always loads the page first (it does); Phase 47 sets `THEIA_HOSTS=<public host>`; add it to the interface table. Do not re-implement either guard.

### Pitfall 4: Token header size and staleness
Node's default header limit is 16 KiB, so a Keycloak access token with many role mappings can fail the whole request [ASSUMED]; keep the realm's token lean (Phase 47). A WebSocket carries only its connect-time token; refresh the record from HTTP requests too (Pattern 3).

### Pitfall 5: `acr`/`auth_time` read from an unverified header
The workbench cannot verify the token it reads; only the OpenBao login does. If Theia's port were reachable around the proxy, a forged header could pass the workbench's freshness guard but could not obtain an OpenBao token for another person. So the freshness check is a guard and a UX message, not the enforcement. Enforcement belongs in OpenBao: Phase 47 should give the signing policy only to a role whose `bound_claims` require the step-up `acr` (a second jwt role, e.g. `sterling-stepup`, whose token the workbench uses only for `transit/sign`). Put this in the interface table as a Phase 47 recommendation; the plan here implements the guard and names the gap. Keep port 3000 pod-local (C7).

### Pitfall 6: `datakey/wrapped` has no plaintext
`generateWrappedDataKey()` returns only the ciphertext (`vault:v1:...`). To use the key now, call `unwrapDataKey` on it. Do not switch to `datakey/plaintext` to save a call: that returns the plaintext key and the wrapped one together and widens the policy.

### Pitfall 7: Transit signature format
`sign` returns `data.signature` as `vault:v1:<base64>` [CITED: Transit docs]. Strip the prefix and decode before handing 64 raw bytes to a verifier; ed25519 ignores `hash_algorithm`. Whether to send raw message or prehashed is the caller's contract (tests with a known vector).

### Pitfall 8: Resource-check traps (C2, C3, C4) and `where` drift
`entryProblems`/`check` demand that each entry's `where` equals the files that use the resource, so adding `workbench/package.json` or `workbench/Dockerfile` forces edits to `npm:esbuild`, `npm:typescript`, `npm:@types/node` and `image:docker.io/library/node` (their `where` arrays and, for the node image, its text: it says "nothing from it but the built files reaches the final image", which stops being true when the node binary is copied into the runtime stage; change `purpose`, `scope` to `runtime` and the conditions). A runtime-scope entry must be `pass-with-conditions` unless `airGap` is `ok` and crypto is not `unvalidated` [VERIFIED: `scripts/resource-check.mjs`, `entryProblems`]. The nine runtime `@theia/*` packages live in `dependencies`, so they must have `scope: runtime`.

### Pitfall 9: Heavy local runs
`theia build` and the image build are the heavy steps (the spike gives the build 1536 MB of old-space heap). One at a time, under the cap in the Validation section; the machine had about 6 GB free during this research.

### Pitfall 10: `workflow-files.test.mjs` rules for jobs with an `environment:`
Jobs holding an `environment:` or a write token must not run npm install scripts or restore an npm cache (`scripts/test/workflow-files.test.mjs:59-70`, "release jobs that hold a write token or VSCE_PAT run no npm install scripts and no npm cache"). That test reads `release.yml`, but follow it for the signing job: it loads the image artifact the build job made (`docker load`), pushes, signs and verifies; it runs no `npm`.

## Code Examples

### Header capture (Pattern 3) [VERIFIED seams: `browser-connection-token.js` and `messaging-listeners.d.ts`]
```ts
// node/forwarded-token-contribution.ts
import { inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application';
import { MessagingListenerContribution } from '@theia/core/lib/node/messaging/messaging-listeners';
import type * as http from 'http';
import { SessionIdentity } from './session-identity.js'; // Theia-free, unit tested

@injectable()
export class ForwardedTokenContribution implements BackendApplicationContribution, MessagingListenerContribution {
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;
  @inject(SessionIdentity) protected readonly identity!: SessionIdentity;
  initialize(): void { this.early.handlers.push((req, _res, next) => { this.identity.observe(req.headers); next(); }); }
  onDidWebSocketUpgrade(request: http.IncomingMessage): void { this.identity.observe(request.headers); }
  async onStop(): Promise<void> { await this.identity.stop(); } // revoke-self
}
```

### Transit and KV request shapes (all `X-Vault-Token: <session token>`, TLS with the CA file) [CITED: OpenBao API docs]
```text
POST   /v1/auth/jwt/login                      {"role":"sterling-workbench","jwt":"<access token>"}
GET    /v1/auth/token/lookup-self              -> data.entity_id
POST   /v1/auth/token/renew-self               {} -> auth.lease_duration
POST   /v1/auth/token/revoke-self
GET    /v1/kv/data/users/<entity>/<u+b64url service>/<u+b64url account>     -> data.data.password
POST   /v1/kv/data/users/<entity>/<...>/<...>  {"data":{"password":"..."}}
GET    /v1/kv/metadata/users/<entity>/<u+b64url service>?list=true          -> data.keys
DELETE /v1/kv/metadata/users/<entity>/<...>/<...>
POST   /v1/transit/sign/person-<entity>        {"input":"<base64 message>"}   -> data.signature "vault:v1:..."
POST   /v1/transit/datakey/wrapped/kek-<entity>  {}                           -> data.ciphertext
POST   /v1/transit/decrypt/kek-<entity>        {"ciphertext":"vault:v1:..."}  -> data.plaintext (base64)
```

### Dev-mode OpenBao for tests (D-29) [VERIFIED: `.release/docker/docker-entrypoint.sh` v2.7.3 lines 59-61 pass `-dev-root-token-id="$BAO_DEV_ROOT_TOKEN_ID"` and `-dev-listen-address="${BAO_DEV_LISTEN_ADDRESS:-"0.0.0.0:8200"}"`]
```text
docker run -d --network <internal net> --name <suffix>-bao -e BAO_DEV_ROOT_TOKEN_ID=<random> <ref from the openbao-test FROM line> server -dev
```
Test setup through the HTTP API with the root token: mount `kv` (type `kv`, `options.version=2`) and `transit`; create the two keys for the test entity (`person-<id>` type `ed25519`, `kek-<id>` type `aes256-gcm96`); enable a `jwt` auth with `jwt_validation_pubkeys` (a test RSA or EC public key, so no Keycloak and no discovery URL); write the templated policy (`kv/data/users/{{identity.entity.id}}/*`, `kv/metadata/users/{{identity.entity.id}}/*`, transit paths, `auth/token/renew-self`, `revoke-self`, `lookup-self`); create role `sterling-workbench` (`role_type=jwt`, `bound_audiences`, `user_claim=sub`). Sign test JWTs with `node:crypto` (no library). Dev mode is in-memory and unsealed: the workbench container restarts, OpenBao does not, which is exactly the persistence claim.

### Fixture VSIX for the real SecretStorage path (FND-T-03 end to end)
A directory `workbench/test/fixtures/secret-probe/` (about 20 lines) with `package.json` (`engines.vscode`, one `activationEvents: ["onCommand:secretProbe.save","onCommand:secretProbe.read"]`, two commands) and `extension.js` calling `context.secrets.store('probe','<value>')` and `context.secrets.get('probe')` then `vscode.window.showInformationMessage(value)`. Mounted read-only at `/plugins` with `THEIA_DEFAULT_PLUGINS=local-dir:///plugins` as the spike README does. Playwright runs the command from the command palette and reads the notification. Nothing test-only enters the product.

### Playwright against the container (FND-T-07)
```ts
// workbench/test/e2e/playwright.config.ts
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', timeout: 120_000, workers: 1, use: { baseURL: process.env.WORKBENCH_URL, trace: 'off' }, reporter: [['list']] });
```
The container suite starts the image on a random `127.0.0.1` port (as `container.test.ts` does with `freePort()`), exports `WORKBENCH_URL`, and runs `npx playwright test` as a child process, or the specs are called through `node:test` + the Playwright library API. `window.theia.container` is set by the generated frontend [VERIFIED: `frontend-generator.js:159`, `(window['theia'] = window['theia'] || {}).container = container;`], useful for waiting on readiness, but its service ids are module-private symbols, so do not try to `get` them from the page. Browser for CI: `npx playwright install --with-deps chromium` (CDN at test time); air-gapped runs set `PLAYWRIGHT_BROWSERS_PATH` to a mirrored copy (document in the README).

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Theia runtime packages as CommonJS | All runtime packages ES modules | 1.77.0 [CITED: Theia CHANGELOG 1.77.0, #18216] | The spike's `"type": "module"` extension with `.js` import suffixes is right; `lib/` imports in 1.77 tarballs end in `.js` |
| Node 22 supported | `engines.node >=24`; CI matrix 24 and 26; Node 24 "recommended default" | Theia PR #17936, merged 2026-08-27 | Node 26 is supported; Theia's Playwright and production smoke run on 24 only |
| Vault `LIST` method only | `GET ...?list=true` and `SCAN` | OpenBao docs | Use GET with `list=true`; no custom method needed |
| `docs/api-docs` URLs on openbao.org | `openbao.org/docs/api/...` (the old `api-docs` URLs redirect) | 2026 | Link the new paths |
| oauth2-proxy flags for login parameters | Alpha config `loginURLParameters` with `allow` rules | v7.x (present in v7.15.6) | Needed for step-up; Theia Cloud's default config is legacy flags (Phase 47) |

**Deprecated/outdated:** Theia Electron builds are not used; `theia start` is a convenience wrapper over `node lib/backend/main.js`.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The four N-API addons (`drivelist`, `node-pty`, `keytar` if built, `@parcel/watcher` prebuilt) compile and load on UBI 9 GCC 11.5 with Node 26 headers and Python 3.9 | Pattern 5 | First image build fails; fallback `python3.12`, or gcc-toolset-13 |
| A2 | The pinned upstream Node binary is acceptable as "UBI 9 base" for FND-T-09 and D-30 | Summary C1 | Owner may want Red Hat built Node (then Node 24 for both, a hub change) |
| A3 | `npm ci --registry <mirror>` rewrites lockfile `registry.npmjs.org` URLs (default `replace-registry-host=npmjs`) | Pattern 5 | Air-gapped build still tries npmjs.org; add an `.npmrc` setting |
| A4 | A missing KV secret returns 404 | Pattern 2 | Wrong "not found" mapping; test against real OpenBao catches it |
| A5 | `Authorization: Bearer` and `X-OpenBao-Token` are accepted | Pattern 3 | None if `X-Vault-Token` is used |
| A6 | Keycloak issues the requested `acr` and refreshes `auth_time` for `max_age=0` through oauth2-proxy | Pattern 4 | Step-up does not work; Phase 47 realm test must prove it |
| A7 | The oauth2-proxy upstream in Theia Cloud is pod loopback | C7 | Phase 47 may still need `0.0.0.0` |
| A8 | Cosign 3.1.4 key mode needs `--tlog-upload=false` (and a no-signing-config switch) to avoid public log use, verify with `--insecure-ignore-tlog` | Validation, O-4 | Signing fails or leaks an entry to a public log; run `cosign sign --help` first |
| A9 | `@types/node` 26.6.6 compiles Theia 1.77 typings | Standard Stack | Use 24 types |
| A10 | Token header size limit (16 KiB) can be hit by large Keycloak tokens | Pitfall 4 | None if tokens stay small |
| A11 | `--hostname` in the pod can be `127.0.0.1` | C7 | See A7 |
| A12 | UBI `microdnf` has no `module list`; `module enable` of a missing stream is the error we saw; Red Hat will publish `ubi9/nodejs-26*` later | Pattern 5 | Re-run the check at plan time; if published, the base can be swapped for it |

## Open Questions (RESOLVED)

Each question below is decided; the decision reference follows it. Items marked for the owner stay on the owner's confirmation list in 46-CONTEXT.md with the default the plans use.

1. RESOLVED by CONTEXT D-34 (default: upstream Node 26.13.1 on digest-pinned `ubi9/ubi-minimal`; owner confirm item 2; 46-01's first implementation task is the evidence gate). **Node 26 binary versus Red Hat built Node (owner, O-1).**
   - Known: no `nodejs:26` on UBI today; the upstream binary runs on UBI 9; hub/relay stay on 26 (their base is distroless).
   - Unclear: whether "UBI 9 Node.js minimal image" in D-30 allows an upstream binary on UBI 9 minimal.
   - Recommendation: proceed with the recipe; record the FIPS condition in the register (same as hub X8); re-check for `ubi9/nodejs-26-minimal` at plan time and swap if it exists.
2. RESOLVED by CONTEXT D-39 (literal digest-pinned `FROM` lines; base-image mirrors through the builder's registry-mirror setting; `NPM_REGISTRY` stays a build argument; owner confirm item 2b). **Mirrors for base images (owner, O-2).** D-27 names a `BASE_REGISTRY` ARG; recommendation is literal `FROM` plus builder mirror configuration (C2), `NPM_REGISTRY` stays an ARG.
3. RESOLVED by CONTEXT D-36 (inside the image the store is OpenBao or "secrets unavailable", stated to the person; the OS keyring only outside a container; owner confirm item 2c). **Keyring branch in a container (O-3).** The local Docker preview cannot use the OS keyring; it shows "secrets unavailable" unless `STERLING_OPENBAO_ADDR` is set. Confirm, or provide a documented dev OpenBao for local previews.
4. RESOLVED by CONTEXT D-40 (cosign 3.1.4 pinned in `tool-pins.json`, a `binary` kind in `install-tool.sh`, owner approval in the PR; owner confirm items 2d and 6). Where the signed image lives was settled by PR #165: the Release workflow publishes one GHCR repository on release tags in the protected `container-release` environment, and 46-06 signs that image there (no second publishing path). **cosign (O-4).** Approve cosign 3.1.4 as a pinned CI tool (like Syft and Grype), the `binary` archive kind in `install-tool.sh`, and a decision on where a `main` push goes (default `ghcr.io/<owner>/sterling-workbench`, pushed with plain `docker login` and `docker push`, no new action). Owner steps: generate the key pair, put the private key and password in a protected environment secret, commit the public key.
5. RESOLVED by the CONTEXT default recorded in D-40 (the `workbench` job is not a required check at first; `CI_CHECKS` unchanged; said in `docs/development-workflow.md`). **Should the `workbench` CI job be a required check?** `CI_CHECKS` (`scripts/lib/workflow.mjs:5`) is `['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan', 'relay', 'hub', 'docs']`, matched to branch protection. Default: add the job, leave it out of `CI_CHECKS` until the owner has seen it stable (the `compliance` job precedent), and say so in `docs/development-workflow.md`.
6. RESOLVED by the CONTEXT defaults (D-07, D-29, D-40): CI tools follow the Syft and Grype precedent (pinned in `tool-pins.json`, reviewed in TOOLS.md); the test OpenBao is registered through its `openbao-test` FROM stage; Playwright browsers are a condition on the `@playwright/test` entry. **Third-party tools in scripts are not discoverable by `resource-check`** (cosign, Playwright browsers, the dev OpenBao started by tests are only discovered where they sit in a `FROM` line). Syft and Grype have no register entries either; follow that precedent for cosign and note it in TOOLS.md. The OpenBao test image is registered through its `FROM` stage.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | image build, container suite | yes | 29.1.3 (Compose 2.40.3) | none (suite fails loudly, like the hub's) |
| Node | scripts, unit tests | yes (24.22.3 locally; CI uses 26.13.1) | 24.22.3 | `.nvmrc` / setup-node 26.13.1 for hub-parity runs |
| Python, g++ (host) | not needed on host | yes | 3.14.4 / 15.2.0 | the UBI build stage supplies its own |
| `registry.access.redhat.com` reachable | image build | yes (pulled during research) | - | internal mirror at air-gapped sites |
| Playwright Chromium | harness | yes locally (`~/.cache/ms-playwright/chromium-12xx`); CI installs it | - | `PLAYWRIGHT_BROWSERS_PATH` mirror |
| Syft 1.57.2, Grype 0.122.1 | scan | via `install-tool.sh` in CI | pinned | none |
| cosign | signing | not pinned yet | 3.1.4 chosen | owner approval needed (O-4) |
| `systemd-run`, `choom`, `timeout` | local heavy runs | yes | - | - |

**Missing with no fallback:** none for planning. **Missing with fallback:** cosign pin (blocks only the signing task).

## Validation Architecture

Nyquist validation is enabled (key absent in `.planning/config.json`). Heavy commands are wrapped as the owner requires; call this `CAP`:
`CAP = systemd-run --user --scope -q -p MemoryMax=4G choom -n 1000 -- timeout 900`
One heavy run at a time (build, container suite, Playwright).

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` through `scripts/run-tests.mjs` (as hub); esbuild builds the test files (as `hub/scripts/build.mjs`); `@playwright/test` 1.65.0 for the browser spec |
| Config file | `workbench/scripts/build.mjs` (new), `workbench/test/e2e/playwright.config.ts` (new) |
| Quick run command | `cd workbench && CAP npm test` (unit only, no Docker, seconds) |
| Full suite command | `cd workbench && CAP npm run test:container` (image build, OpenBao, restart, egress, Playwright), plus `node scripts/resource-check.mjs` and the root `npm test` for the copy lint |

### Phase Requirements to Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FND-T-01 | Presence check, lint (`tsc --noEmit`) and unit run from `workbench/`; the build and scripts write only under `workbench/` (a test scans `package.json` scripts and `tools/*.mjs` outfiles for `..`); backend finds the engine relative to its package with `process.cwd()` elsewhere; realpath fixture check; image binds `127.0.0.1` by default and `0.0.0.0` only with `STERLING_LISTEN_HOST`; no `@theia/cli`, `typescript`, `esbuild` or `puppeteer` in the image's `node_modules` | unit + container | `cd workbench && CAP npm test` ; `CAP npm run test:container` | Wave 0 |
| FND-T-01 (src/) | `nearAi.setup` and `nearAi.compareModels` handlers return `undefined` and report a rejection | unit (existing stub) | `CAP node scripts/run-tests.mjs dist/test/modelComparisonPage.test.js dist/test/setupSteps.test.js` after `npm run compile` | extend existing (`src/test/helpers/vscodeStub.ts:223` `registerCommand`) |
| FND-T-02 | One service built with the shared helper: refusal text crosses the real RPC unchanged; engine bundle missing gives the refusal, not a crash | unit (helper) + Playwright (Team preview round trip) | `CAP npm test`; `CAP npm run test:container` | Wave 0 |
| FND-T-03 | KV path encoding (round trip, injective, never escapes `users/<entity>/`, never empty); six methods against a fake OpenBao; keyring branch via the `getKeytar` seam; "unavailable" throws; real path: fixture VSIX stores a secret, workbench container restarted, secret read back | unit + container | `CAP npm test`; `CAP npm run test:container` | Wave 0 |
| FND-T-04 | `sign`, `generateWrappedDataKey`, `unwrapDataKey` against real dev OpenBao with the test keys; sign refused with stale `auth_time`, wrong or absent `acr`; refused with a plain message when the key is missing; no Transit key admin call is ever made (fake server records paths) | unit (fake) + container (real) | as above | Wave 0 |
| FND-T-05 | Identity state machine table (every transition above; timeout; Retry; person mismatch; missing header in hosted mode is `failed`, in local mode never); renew and re-login after a 403; `revoke-self` on `onStop`; token never in any RPC result or log (scan captured logs for the token string); real jwt login against dev OpenBao with a test-signed JWT | unit + container | as above | Wave 0 |
| FND-T-06 | Preference default `telemetry.telemetryLevel` is `off`; image has no `@theia/vsx-registry`; request allow-list contains exactly the configured URLs (empty by default); container on an `--internal` network with the recording hook logs only allow-listed targets through start, restart and the Playwright smoke; browser requests all same-origin | container | `CAP npm run test:container` | Wave 0 |
| FND-T-07 | Playwright opens Get Started; the Team preview widget lists and reads a project through the backend; secret restart persistence; no external requests | e2e | `CAP npm run test:container` (starts the image, runs `npx playwright test`) | Wave 0 |
| FND-T-08 | `workbench/package.json` `engines.node` is `>=26.13.1 <27` (as hub); image reports Node 26.x; hub unchanged | unit + container | `CAP npm test` | Wave 0 |
| FND-T-09 | Dockerfile `FROM` lines are digest-pinned and the UBI line matches the register; CycloneDX SBOM written by Syft from the built image and non-empty; Grype run recorded (reporting, like `relay-image-scan`); the signing job (main only) signs, verifies and attests with the key, using no keyless flags (workflow test: no `id-token: write` and no `--yes` without `--key` in that job) | CI + workflow-file test | CI job; `CAP node scripts/run-tests.mjs scripts/test/workflow-files.test.mjs` | extend existing |
| FND-T-10 | `node scripts/resource-check.mjs` passes with `workbench/package.json` and `workbench/Dockerfile` listed (extend `scripts/test/resource-check.test.mjs` for the two new list entries and for the `FROM ${...}` skip); copy lint scans `workbench/extension/src/browser/**` and `workbench/extension/src/common/**`, accepts "Sterling", "SovAI" and "Sterling Sovereign AI" in titles (one positive case in `src/test/copyLint.test.ts` next to line 201), and stays at zero new hits | unit | `CAP node scripts/resource-check.mjs`; `CAP npm test` (root) | extend existing |

### Sampling Rate
- **Per task commit:** the unit quick run (`workbench` `npm test`) plus the touched root test file; `node scripts/resource-check.mjs` when a manifest or Dockerfile changed.
- **Per wave merge:** the container suite once (it builds the image), plus `npm run lint` in `workbench/`.
- **Phase gate:** root `npm test`, hub and relay suites untouched but run once, `node scripts/resource-check.mjs`, container suite, Playwright; CI `workbench` and image-scan jobs green on the PR.

### Wave 0 Gaps
- [ ] `workbench/scripts/build.mjs`, `workbench/package.json` test scripts, `workbench/test/helpers/` (fake OpenBao server, JWT signer using `node:crypto`, outbound HOOK copied from `hub/test/noOutbound.test.ts:35-84`)
- [ ] `workbench/test/container/*.test.ts` (hygiene as `hub/test/container/container.test.ts`), `workbench/test/e2e/*`, `workbench/test/fixtures/secret-probe/`
- [ ] First task, before anything else: build the Dockerfile skeleton and open Get Started on Node 26 with `drivelist` and `node-pty` rebuilt. This is the evidence gate for D-13; if it fails, stop and report to the owner.
- [ ] Framework install: `@playwright/test` 1.65.0 and `npx playwright install chromium`

## Security Domain

`security_enforcement` is not set in `.planning/config.json`, so it is enabled.

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | No passwords; OIDC through oauth2-proxy and Keycloak; OpenBao jwt login verifies the signature, audience and role; step-up by re-authentication |
| V3 Session Management | yes | OpenBao token renewed and revoked with the session; held only in backend memory; Theia's own connection-token cookie and Origin check stay on |
| V4 Access Control | yes | Per-person KV prefix by templated policy (Phase 47) plus path encoding in the client so no value escapes the prefix; one person per pod |
| V5 Input Validation | yes | Encode path segments; validate `STERLING_*` values (URLs https, no credentials; numbers bounded); refuse unknown shapes from OpenBao |
| V6 Cryptography | yes | Never hand-roll: signing and key wrapping only through OpenBao Transit; no JOSE or crypto library added; test JWTs use `node:crypto` in tests only |
| V7 Error handling and logging | yes | No token, secret or entity id beyond the minimum in logs; refusal messages are plain and carry no secret |
| V14 Configuration | yes | Non-root, no dev dependencies, digest-pinned bases, localhost bind by default, no outbound beyond the allow list |

### Known Threat Patterns for this stack
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged `X-Forwarded-Access-Token` by a client that reaches port 3000 around the proxy | Spoofing | Keep the port pod-local (C7); OpenBao verifies the signature; enforce step-up in OpenBao, not in the workbench (Pitfall 5) |
| Secret path escape through `service`/`account` (`..`, `/`) | Tampering, Info disclosure | `u` + base64url segments; property test |
| In-memory secret loss presented as success | Repudiation / Integrity | Override `getKeytar`; restart test |
| Token leakage into RPC, logs, `docker inspect` | Info disclosure | Token stays in the backend; secrets pass by file or env only for the CA path; log scan test |
| `acr` replay from an old token | Elevation | Check `auth_time` window and `acr`; real enforcement via a bound-claims role |
| Supply chain: lifecycle scripts | Tampering | `npm ci --ignore-scripts`, named rebuilds, digest-pinned bases, hash-pinned tools, register gate |
| Unlisted egress (plugin, MCP, telemetry) | Info disclosure | Telemetry off, no registry package, request allow-list, recording-hook container test |
| Open workbench with a shell reachable on an interface | Elevation | Default bind `127.0.0.1`; the explicit setting; Phase 47 NetworkPolicy |

## Sources

### Primary (HIGH confidence)
- Theia v1.77.0 source and registry tarballs read this session: `@theia/core` `lib/common/key-store.js`, `lib/node/key-store-server.js`, `lib/node/backend-application-module.js` (lines 98-99), `lib/node/backend-application.js` (lines 40-41, 67-68, 117-118), `lib/node/messaging/websocket-endpoint.js`, `messaging-listeners.js`, `lib/node/ws-request-validators.js`, `lib/node/hosting/*`, `lib/node/request/backend-request-facade.js`; `@theia/plugin-ext` `lib/main/browser/secrets-main.js`; `@theia/ai-mcp` `lib/node/mcp-oauth-*.js`; `@theia/telemetry` preferences and backend module; `@theia/application-manager` `application-package-manager.js` and `generator/frontend-generator.js:159`; `@theia/application-package` `extension-package-collector.js`; `@theia/vsx-registry` `vsx-environment-impl.js`.
- Theia `.github/workflows/ci-cd.yml`, `playwright.yml`, `production-smoke-test.yml` at v1.77.0; `CHANGELOG.md` 1.77.0; PR #17936 (Node 26 support); root `package.json` engines.
- Theia Cloud `templateDeployment.yaml` (main): one pod, containers `oauth2-proxy` and the app, `THEIACLOUD_SESSION_USER`.
- oauth2-proxy v7.15.6 source: `oauthproxy.go` (`OAuthStart`, `doOAuthStart`), `providers/provider_data.go` (`LoginURLParams`), `pkg/apis/options/legacy_options.go`; docs: configuration overview and alpha-config pages.
- OpenBao docs (openbao.org/docs/api/auth/jwt, /auth/token, /secret/kv/kv-v2, /secret/transit) and `.release/docker/docker-entrypoint.sh` v2.7.3; Docker Hub tag API for `openbao/openbao`.
- Red Hat registry (tags lists, index digests), Red Hat catalog API, RHSA-2026:98522; `sclorg/s2i-nodejs-container` `26-minimal/Dockerfile.rhel9`.
- Runs this session (Docker 29.1.3, memory-capped): UBI minimal module resolution, repoquery of build packages, upstream Node binary on UBI 9, `node --enable-fips` message, Node 26 `process.versions`.
- Node.js v26.13.1 `doc/api/crypto.md` (FIPS mode); nodejs.org `dist/index.json`; npm registry metadata for the packages in the audit; cosign v3.1.4 release assets and `cosign_checksums.txt`.
- This repository (all read this session): `scripts/resource-check.mjs`, `compliance/resources.json`, `compliance/README.md`, `compliance/ci/install-tool.sh`, `tool-pins.json`, `TOOLS.md`, `.github/workflows/ci.yml` and `release.yml`, `hub/Dockerfile`, `hub/package.json`, `hub/test/container/container.test.ts`, `hub/test/noOutbound.test.ts`, `scripts/run-tests.mjs`, `scripts/lib/workflow.mjs`, `scripts/test/workflow-files.test.mjs`, `src/test/helpers/copyLintScan.ts`, `src/test/copyLint.test.ts`, `.dockerignore`, the spike files on `docs/theia-container-release`, PR #162 reviews.

### Secondary (MEDIUM confidence)
- Web search summaries for cosign v3 key-mode flags (not run), RHEL 9 `nodejs:26` module existence in full RHEL (errata only).

### Tertiary (LOW confidence)
- None used as authority; items from training knowledge are in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, versions and digests read from registries this session; Node 26 support from Theia CI.
- Architecture: HIGH for seams (read in tarballs); MEDIUM for the UBI image recipe (components run, assembled build not run).
- Pitfalls: HIGH; each is tied to a quoted file or a run.

**Research date:** 2026-11-23
**Valid until:** 2026-12-07 for the image digests and Playwright and cosign versions (re-pin at plan time); 30 days for Theia and OpenBao API facts.
