# Phase 46: Native Theia foundation - Context

**Gathered:** 2026-11-23
**Status:** Decided on the owner's behalf from the accepted hosting design. The owner was not available for questions; the planning agent took the design's decision or its stated default on every point and recorded it here. Points the owner should confirm are listed at the end under "For the owner to confirm", each with the default the plans use.
**Source:** ADR Ingest Express Path (`.planning/research/multiuser-hosting/DESIGN.md`, format narrative). The ingest parser returned no decisions for DESIGN.md (its decisions are in tables), so this file was written by hand from DESIGN.md sections 2, 6, 7, 8, 9, 10, 13, 14 and 15, `RESEARCH.md` beside it, the Theia spike (local branch `docs/theia-container-release`, and PR #162 on `feat/theia-foundation-review`), the #162 reviews (agent review and the owner's independent review of 2026-11-23), `compliance/README.md` "Adding a resource", `compliance/resources.json`, `scripts/resource-check.mjs`, and the coherence vocabulary (`.planning/research/coherence/GLOSSARY.md`), against `origin/main` at ebe68976.

<domain>
## Phase Boundary

Phase 46 is the design's phase (a): it turns the Theia spike into a real, tested product foundation that Phase 32.1 native, Phase 33 native and the deployment stack (Phase 47) build on. It owns **product code in this repository only**.

In scope (DESIGN section 8):
- **P1** The spike's Theia extension and app move out of `.planning/spikes/theia-team-studio/` into a workspace package with its own build, lockfile, tests and CI job.
- **P2** One backend JSON-RPC service pattern for native widgets to call engine code in the backend, with the same refusals the extension host gives.
- **P3** `OpenBaoKeyStoreService` rebinding Theia's `KeyStoreService`, with the OS-keyring fallback for single-machine installs.
- **P4** `KeyService` for OpenBao Transit sign, wrapped data keys and decrypt; refuses long-term signing without a fresh `acr` and `auth_time`.
- **P5** Session identity: the forwarded sign-in token and `THEIACLOUD_SESSION_USER`, OpenBao jwt login, renewal, ending with the session, step-up re-authentication.
- **P8** Registry, Open VSX and model server addresses configurable to internal mirrors; every update check and telemetry off in the image.
- **P9** A browser test harness against the built container.
- **P10 (image build part only)** The workbench image built on a digest-pinned UBI 9 base, with a CycloneDX SBOM, a vulnerability scan and a signature with your organization's key (no keyless signing).
- **P11** One Node major for the workbench image and the hub.
- Every new npm package, image and action gets a passing entry in `compliance/resources.json` (D9), and the copy lint's brand rule accepts the Sterling edition names (DESIGN section 15, item 2).

Not in this phase:
- Phase 47 (deployment): Helm values, Theia Cloud install and the hardening list (section 11), Keycloak realm as code, OpenBao policies, roles, Transit key creation and audit device, cert-manager, the offline bundle, the hub as a Kubernetes Deployment, runbooks.
- Phase 48: load test, OSCAL component definitions and evidence rules for the hosted components.
- Phase 32.1 native (section 9.1) and Phase 33 native (section 9.2), including P6 (certified session sub-keys, cell keys wrapped to the person's key-encryption key) and P7 (hub roster entry kind for person and session keys).
- The rest of P10: retiring Marketplace publishing, moving the compliance package and assessor evidence from the VSIX to the image, publishing releases by digest. Existing VSIX releases keep working unchanged in this phase.
- The Defence Team mode in `src/domain/org/modes.ts` (D11, O1b): planned with 32.1 native.
</domain>

<decisions>
## Implementation Decisions

### Owner decisions carried in (2026-11-23)
- **D-01 (owner, D1):** Theia (Sterling-branded edition; the Sterling and SovAI names are intended) is the sole development target. Releases ship as a versioned container image published by digest. In this phase the image is built, scanned, given an SBOM and signed; the release cutover is later (see Deferred).
- **D-02 (owner, D2):** On-premise and fully air-gapped. Nothing in the image needs the internet at run time; the image build can use internal mirrors (npm registry and base-image registry configurable).
- **D-03 (owner, D4):** One person, one Theia session (Theia Cloud, `sessionsPerUser: 1`). The workbench backend serves exactly one person; it never multiplexes people.
- **D-04 (owner, D5):** Secrets live in OpenBao, per person. Single-machine installs fall back to the OS keyring through the same interface. No secret is held only in memory: if neither store is available the workbench says so and saving a secret fails visibly.
- **D-05 (owner, D6):** No passwords. The workbench never shows a password prompt; step-up re-authentication goes back to the identity provider (Keycloak, Phase 47) with `max_age` or `acr_values`.
- **D-06 (owner, D7):** Hosted sessions offer only model servers your organization's policy lists and never scan or listen for servers. In this phase model server addresses come from configuration and the backend makes no discovery calls; reading them from the organization-signed policy follows Phase 41.
- **D-07 (owner, D9):** Every new resource passes `node scripts/resource-check.mjs` before it is used. A resource that needs the internet or uses unvalidated cryptography is never a plain `pass`.
- **D-08 (owner, D10, D11):** Vocabulary: "your organization", never the provider's name in front of "organization"; NEAR AI is only an AI service; Sterling and SovAI are the intended edition and command-category names; no generic "project" word for what a work area holds; one Defence Team mode (not built here).
- **D-09 (owner, O2 to O6 accepted):** HAProxy ingress; one shared parent domain for passkeys; re-enrolment only where policy says hardware only; pin Theia Cloud upstream; volume size and idle timeout per site. None changes product code here, except that the workbench must not assume a per-site relying-party ID.

### Package and build (P1, P11)
- **D-10:** The workbench lives in a new top-level folder `workbench/`, a package like `hub/` and `relay/`: its own `package.json` and lockfile, exact versions, `npm ci --ignore-scripts` with named native rebuilds only, its own CI job modelled on the `hub` job (presence check, lint, test, container build and checks). Nothing remains only under `.planning/spikes/`. The spike folder keeps a short README pointing to `workbench/` (deleting it needs the owner's approval).
- **D-11:** The source of the move is the Sterling spike on local branch `docs/theia-container-release` (the superset the design cites: Get Started, rail, four work-area pages, Portfolio, Resource Inventory, Compliance, Documentation, Team Studio preview). PR #162 (`feat/theia-foundation-review`) is the reviewed subset; its review findings apply to the moved code (D-12). If #162 merges first, the move starts from `main` plus the extra files from `docs/theia-container-release`. The local branch is not on origin: the executor reads it with `git show docs/theia-container-release:<path>`.
- **D-12 (from the #162 reviews):** The moved code fixes: the image binds to `127.0.0.1` by default and listening on every interface needs an explicit setting (the Theia Cloud pod sets it); the runtime image carries no dev dependencies; node-pty is rebuilt for the terminal or the terminal package dropped (default: rebuild); the build writes only inside `workbench/` (no `../../../dist`), and the backend finds engine bundles relative to its own package, never `process.cwd()`; the Team preview reader compares against the realpath of its fixture directory; the two command handlers in `src/extension.ts` and `src/services/modelComparisonPanel.ts` attach a `.catch()` that reports the error (if #162 has not already).
- **D-13 (P11):** One Node major for the workbench image and the hub. Default: Node 26 for both (the hub already requires `>=26.13.1 <27`), provided research confirms Theia 1.77's backend and native addons run on Node 26. If they do not, the plan records the evidence and the owner decides (see "For the owner to confirm"). The hub moves toward a UBI 9 base in the same change only if that is a base swap with its existing container test passing; otherwise it is noted for Phase 47.
- **D-14:** Theia stays pinned at exactly 1.77.0 (all `@theia/*` the same version). An upgrade is its own change.

### Backend service pattern (P2)
- **D-15:** One pattern for every native widget that calls engine code: a `common/` interface and path constant, a backend `ConnectionHandler` with `RpcConnectionHandler`, and a frontend proxy, as the spike's `TeamPreviewService` already does. The pattern is a small shared helper (one function or module), not a framework. The engine code it calls is the existing host-neutral code under `src/`, bundled with esbuild into `workbench/` (the spike's `build:parser` approach, made to write inside the package).
- **D-16:** "The same refusals the extension host gives": the backend service calls the same engine entry point the extension calls, and refusal results cross the RPC as plain data with their reason, never as thrown host objects. The tracer slice is the Team preview service moved onto the shared helper; one refusal path is shown end to end.

### Durable secrets (P3)
- **D-17:** `OpenBaoKeyStoreService` implements Theia 1.77's `KeyStoreService` contract and replaces it with `rebind(KeyStoreService)` in a backend module. Every `SecretStorage` call from the compatibility host and every Theia AI credential then reads and writes OpenBao KV v2 at logical path `kv/users/<entity_id>/<service>/<account>` (API path `kv/data/users/...`; mount configurable, default `kv`). `<service>` and `<account>` are encoded so no value can escape the person's prefix.
- **D-18:** The store is chosen at start: OpenBao when `STERLING_OPENBAO_ADDR` is set; otherwise the OS keyring (Theia's own keytar-backed implementation, built for the image's Node); otherwise the workbench starts with secrets unavailable and says so. Never a silent in-memory fallback.
- **D-19:** The OpenBao token used for KV is the session identity's token (P5), held in backend memory only and never sent to the frontend or written to disk.

### Long-term keys (P4)
- **D-20:** `KeyService` (backend) offers `sign(message)`, `generateWrappedDataKey()` and `unwrapDataKey(wrapped)` against Transit: `transit/sign/<signing key>`, `transit/datakey/wrapped/<kek>` and `transit/decrypt/<kek>`. Key names are fixed per person from the OpenBao entity id: signing key `person-<entity_id>` (ed25519), key-encryption key `kek-<entity_id>` (aes256-gcm96). The workbench never creates, rotates, exports or deletes Transit keys; if a key is missing it says so and refuses.
- **D-21:** `sign` refuses unless the forwarded token's `acr` equals the configured step-up value and `auth_time` is within the configured window (`STERLING_STEPUP_ACR`, `STERLING_STEPUP_MAX_AGE_SECONDS`, default 300). The refusal names the fix ("Confirm with your passkey or security key") and the frontend can start the step-up sign-in. Unwrapping data keys needs an active session, not step-up. (Owner, 2026-11-23: phone passkeys first; the text says "passkey or security key" because the site's `signInKeys` policy, Phase 47 D-57, allows passkeys or only hardware keys; the step-up `acr` means a fresh WebAuthn ceremony, not a hardware key.)

### Session identity (P5)
- **D-22:** At session start the backend reads the forwarded access token (header `X-Forwarded-Access-Token` from oauth2-proxy with `pass_access_token`; `X-Auth-Request-Email` and `X-Auth-Request-User` from `set_xauthrequest`) and `THEIACLOUD_SESSION_USER`, checks that they name the same person, and logs in to OpenBao `auth/<jwt mount>/login` with the token and the configured role. It keeps the OpenBao token in memory, renews it while the session is active, and revokes it (`auth/token/revoke-self`) when the session stops. How the headers reach Theia's backend (the token arrives on the HTTP upgrade of the WebSocket, and is refreshed by oauth2-proxy) is a research item.
- **D-23:** The identity part of the session state machine (DESIGN section 7) is implemented in the backend and visible to the person: `identity` to `active` (token issued) or `failed` (token missing, person mismatch, OpenBao unreachable: a plain reason and Retry; no secret is read); `active` renews; `stopping` drops the token. `identity` has a timeout; no state waits silently. Pod-level states (`pooled`, `requested`, `starting`, `claimed`, `idle-warned`) belong to Theia Cloud (Phase 47).
- **D-24:** Step-up: the workbench starts an OIDC re-authentication through oauth2-proxy (`/oauth2/start` with `max_age` or `acr_values`) and then reads the new token. If research shows oauth2-proxy cannot pass these, the plan states the fallback and it goes to the owner list. The design marks this **[unverified]**.
- **D-25:** Local mode: with no OpenBao address configured (single-machine install, the local Docker preview), session identity is "this computer", the OS keyring store is used, and `KeyService` reports long-term keys unavailable. Hosted mode is chosen only by configuration, never inferred from a missing header; in hosted mode a missing header is `failed`.

### Air gap and egress (P8)
- **D-26:** In the image: Theia telemetry off; every update check off (Theia, the VS Code extension host, plugin and Open VSX update checks); the Open VSX address from `STERLING_OPEN_VSX_URL` (empty means no extension gallery); the AI packages pulled in by `@theia/plugin-ext` (`@theia/ai-core`, `@theia/ai-mcp`) with no default outbound providers; model server addresses from `STERLING_MODEL_SERVERS` only. A container test proves no outbound connection is attempted at start and during the browser smoke (the container on a network with no route out, asserting no connection attempts outside the allow list).
- **D-27:** The image build takes the npm registry and base-image registry from build arguments so an air-gapped build can use internal mirrors; defaults are the public ones for CI.

### Browser harness (P9)
- **D-28:** Playwright against the built container, as a test inside `workbench/` (not the root e2e job), on `127.0.0.1` with a random port. Covers: Get Started opens; one native widget round-trips through the backend service; a secret saved survives a container restart against a test OpenBao; no outbound calls. Browsers come from the pinned Playwright release; the harness documents how to use a mirrored browser for air-gapped runs.
- **D-29:** The test OpenBao is a pinned `openbao/openbao` image by digest in dev mode, used only by tests (scope `test` in the register). Phase 47 owns production OpenBao.

### Image build (P10 image part)
- **D-30:** Runtime base: a UBI 9 Node.js minimal image pinned by digest (DESIGN section 10: Debian and Alpine fail for Protected B). Non-root user, writable workspace and home only, no package-manager caches or lists left in layers, `EXPOSE 3000`, a healthcheck.
- **D-31:** CI builds the image on every PR touching `workbench/`, writes a CycloneDX SBOM with the pinned Syft and scans it with the pinned Grype (the `relay-image-scan` job's tools), and records the digest. Signing with your organization's key uses cosign in key mode (key in a protected environment secret, never keyless) on pushes to `main` only, and the signature and SBOM attestation are verified in the same job. The release cutover is deferred.

### Compliance fit and copy (D9, section 15)
- **D-32:** `scripts/resource-check.mjs` learns the new manifests: `workbench/package.json` in `PACKAGE_FILES` and `workbench/Dockerfile` in `IMAGE_FILES`. It is a gate file: the change is minimal and owner approval is requested in the PR. Every direct dependency, image and action added gets an entry in `compliance/resources.json`, with the licence notes from the #162 review: Theia EPL-2.0 elected; `jschardet` LGPL-2.1+, `@vscode/codicons` CC-BY-4.0, and lockfile entries without a licence (`buffers`, `busboy`, `fuzzy`, `streamsearch`, `union`, `xmlhttprequest-ssl`) recorded as conditions on the Theia entries. Component id: `extension` (the product) until Phase 48 adds a workbench component.
- **D-33:** The copy lint's brand rule (GLOSSARY section 5, rule 3) accepts "Sterling" and "SovAI" as the edition and command-category names in the workbench package's user strings, and the lint scans the workbench's browser sources. "NEAR AI" stays the provider's spelling; "your organization" stays the user word. The baseline ratchet is kept.

### Claude's Discretion
- File layout inside `workbench/`, test file names, the shared RPC helper's name.
- Whether the Team preview fixtures ship as the sample in the image (default: yes, as today, plus test fixtures).
- Exact Playwright version (pinned, at least two weeks old) and whether Theia's own Playwright helpers fit.
</decisions>

<interface_contract>
## Interface with Phase 47

Phase 47's assumptions, each confirmed or corrected. Phase 46 produces these; Phase 47 configures and deploys them. Neither phase changes them without updating the other's plan.

| Phase 47 assumed | Phase 46 answer |
|---|---|
| Image by digest | **Confirmed.** `sterling-workbench`, built from `workbench/Dockerfile` on a digest-pinned UBI 9 Node base, referenced as `<registry>/sterling-workbench@sha256:…`, signed with your organization's cosign key, CycloneDX SBOM attached as an attestation. Port 3000; binds `127.0.0.1` unless `STERLING_LISTEN_HOST` is set (the pod sets `0.0.0.0` behind oauth2-proxy). Non-root; writable paths are the workspace volume and home (exact paths final in the plan); an HTTP health path on the same port. |
| The session reads `THEIACLOUD_SESSION_USER` | **Confirmed.** It must name the same person as the token headers, or the session goes to `failed`. |
| The sign-in token arrives via oauth2-proxy `pass_access_token` / `set_xauthrequest` headers | **Confirmed.** Headers read: `X-Forwarded-Access-Token` (Keycloak JWT with `sub`, `aud`, `acr`, `auth_time`), `X-Auth-Request-Email`, `X-Auth-Request-User`. Phase 47 must also keep emails unique and immutable (hardening item 12). |
| OpenBao jwt auth role bound to the Keycloak audience with `user_claim=sub` | **Confirmed.** Mount from `STERLING_OPENBAO_JWT_MOUNT` (default `jwt`), role from `STERLING_OPENBAO_JWT_ROLE` (default `sterling-workbench`); short, renewable token TTL; one entity per person. The workbench calls `auth/token/renew-self` and `auth/token/revoke-self`, so the policy must allow both. |
| Per-person secrets at `kv/users/<entity>/...` | **Confirmed, with the KV v2 API detail.** Logical path `kv/users/<entity_id>/<service>/<account>`; the policy must grant `kv/data/users/{{identity.entity.id}}/*` and `kv/metadata/users/{{identity.entity.id}}/*` (read, create, update, delete, list) to that entity only. Mount from `STERLING_OPENBAO_KV_MOUNT` (default `kv`). |
| Keys at `transit/sign/<person>` and `transit/datakey/wrapped/<kek>` | **Corrected: names fixed, and decrypt added.** `transit/sign/person-{{identity.entity.id}}` (ed25519), `transit/datakey/wrapped/kek-{{identity.entity.id}}` and `transit/decrypt/kek-{{identity.entity.id}}` (aes256-gcm96), all `update`. Phase 47 creates the keys at enrolment, non-exportable; the workbench never creates, rotates or deletes them. Mount from `STERLING_OPENBAO_TRANSIT_MOUNT` (default `transit`). |
| Long-term signing needs a fresh `acr` / `auth_time` | **Confirmed.** `STERLING_STEPUP_ACR` (the `acr` Keycloak issues after a fresh WebAuthn step-up with a passkey or security key, whichever the site's `signInKeys` policy allows; Phase 47 defines it in the realm) and `STERLING_STEPUP_MAX_AGE_SECONDS` (default 300). The realm must issue `acr` and `auth_time` in the access token, and oauth2-proxy must allow re-authentication with `max_age` or `acr_values` (unverified, D-24). |
| Registry, Open VSX and model addresses set by environment variables | **Confirmed.** `STERLING_OPEN_VSX_URL` (empty means no gallery), `STERLING_MODEL_SERVERS` (format final in the plan; replaced by the signed policy after Phase 41). The image registry is a deployment concern: the image itself pulls nothing at run time. Build-time mirrors are build arguments (`NPM_REGISTRY`, `BASE_REGISTRY`, names final in the plan). |
| (added) TLS to OpenBao | `STERLING_OPENBAO_ADDR` (HTTPS) and `STERLING_OPENBAO_CA_FILE` (CA bundle mounted from cert-manager). Setting the address turns on hosted mode. |
| (added) Hub and image share one Node major, moving toward UBI 9 | **Confirmed as the target.** Node 26 for both if Theia 1.77 runs on it (D-13); the workbench image is UBI 9 from day one; the hub base swap lands here only if it is a plain swap, otherwise in Phase 47. |
</interface_contract>

<canonical_refs>
- **Step-up enforcement (reconciled with Phase 47, 2026-11-23):** signing logs in to the jwt role `sterling-workbench-stepup` (bound `acr`, TTL no longer than the step-up window; defined in 47-07) with the fresh forwarded token for each signature and revokes that token after use; the ordinary `sterling-workbench` session token never signs. Setting `STERLING_OPENBAO_STEPUP_ROLE` names the role.
- **Third-party images:** Phase 47's tag-triggered `deploy-images.yml` publishes rebuilt third-party images (Theia Cloud, oauth2-proxy, Postgres) with the same organization key in the same `container-release` environment; the workbench image itself is published only by the Release workflow.

## Canonical References
- `.planning/research/multiuser-hosting/DESIGN.md` (sections 2, 6, 7, 8, 9, 10, 13, 14, 15) and `RESEARCH.md`.
- Spike: `git show docs/theia-container-release:.planning/spikes/theia-team-studio/<path>` (README.md, MIGRATION.md, Dockerfile, package.json, extension/); PR #162 (`feat/theia-foundation-review`) and its review comments (`gh pr view 162 --comments`).
- `compliance/README.md` ("Adding a resource"), `compliance/resources.json`, `compliance/schemas/resources.schema.json`, `scripts/resource-check.mjs`.
- `.planning/research/coherence/GLOSSARY.md` (section 5), `src/test/copyLint.test.ts`, `src/test/helpers/copyLintScan.ts`.
- `.github/workflows/ci.yml` (`hub` and `relay-image-scan` jobs), `hub/package.json`, `hub/Dockerfile`, `compliance/ci/install-tool.sh`.
- Theia 1.77.0 sources: `packages/core/src/node/key-store-server.ts`, `packages/plugin-ext/src/main/browser/secrets-main.ts`, the JSON-RPC docs.
</canonical_refs>

<specifics>
## Specific Ideas
- The tracer slice: the moved workbench builds in `workbench/`, the Team preview service runs on the shared RPC helper, and the browser harness opens Get Started and the Team preview against the built container in CI.
- Secrets and keys follow on the tracer; the key store is exercised by the harness against a test OpenBao.
- The interface table above is the only place Phase 47 reads; names in it are final once this phase's plans land.
</specifics>

<deferred>
## Deferred Ideas
- Release cutover (rest of P10): retire Marketplace publishing, publish releases by digest, move the compliance package and assessor evidence to the image. Default: its own follow-up after Phase 46, before 32.1 native ships.
- P6 and P7: Phase 33 native.
- Defence Team mode and its words (O1b): with 32.1 native.
- A `workbench` OSCAL component and evidence rules: Phase 48.
- Reading model servers from the organization-signed policy: after Phase 41.
</deferred>

<scope_fence>
## Scope Fence
- Product code only under `workbench/`, the two `src/` command handlers named in D-12, `scripts/resource-check.mjs` (two list entries), `compliance/resources.json`, the copy lint files, `.github/workflows/ci.yml` (one new job) and the signing step. No Helm charts, Keycloak realm, OpenBao policy files, runbooks or bundle scripts (Phase 47).
- No change to the VS Code extension's behaviour beyond D-12's error reporting; VSIX releases keep working.
- No new framework: the RPC helper, key store and key service are plain Theia modules using Node's `fetch` for OpenBao (no OpenBao client library unless research shows a need, which then needs a register entry).
</scope_fence>

## Success Criteria
The Phase 46 roadmap entry, criteria 1 to 6.

## Risk Summary
- Theia 1.77 on Node 26 is unverified (DESIGN P11). Research checks; the fallback is an owner decision.
- The forwarded token on the WebSocket upgrade, and step-up through oauth2-proxy, are unverified (DESIGN 6.8 and section 12).
- A UBI 9 Node 26 image by digest is unverified; FIPS mode is a host property (Phase 47).
- Theia's plugin host and AI packages may make outbound calls not listed here; the no-egress container test is the backstop.

## Amendments after research (46-RESEARCH.md, 2026-11-23)
These refine the decisions above; where they differ, these win.
- **D-34 (amends D-13, D-30):** Theia 1.77 supports Node 26 (its CI matrix runs 24 and 26; the native addons are N-API). Red Hat publishes no Node 26 for UBI 9, so the image uses `ubi9/ubi-minimal` pinned by digest with the upstream Node 26.13.1 binary copied from the digest-pinned `node:26.13.1-slim` image (declared as a `FROM ... AS` stage so the fit check sees it), plus `libatomic`. Native addons are built on UBI in the build stage. The first task of the first plan is a Node 26 smoke of the built image (Get Started opens; drivelist and node-pty load): that is the D-13 evidence.
- **D-35 (amends D-13):** The hub keeps Node 26 (already); moving the hub to UBI is not a plain base swap (its container test forbids a shell and a package manager), so it goes to Phase 47.
- **D-36 (amends D-18):** A container has no OS keyring. Theia's default key store silently falls back to memory when keytar fails, so the workbench overrides the loader (`getKeytar()`) as well as rebinding: inside the image the store is OpenBao or "secrets unavailable" (stated to the person); the OS keyring applies only to a single-machine install outside a container. No in-memory fallback anywhere.
- **D-37 (amends D-17):** The key store is used by VSIX `SecretStorage` (service name includes the page host name), the `@theia/ai-mcp` OAuth store and core's `CredentialsService`. AI provider API keys are preferences in 1.77, not key-store entries: out of scope here. The entity id comes from `auth/token/lookup-self` after login.
- **D-38 (resolves D-24):** oauth2-proxy v7.15.x forwards `max_age`, `acr_values` and `prompt` from `/oauth2/start` only when listed under `loginURLParameters` in its alpha (YAML) configuration; Phase 47 must use alpha config. The backend reads the token from Theia's `EarlyExpressMiddleware` (every HTTP request) and `MessagingListenerContribution.onDidWebSocketUpgrade`; one process-wide latest token is correct for a one-person backend.
- **D-39 (amends D-27):** `FROM ${ARG}` lines are skipped by the fit check, so base-image mirrors are not build arguments: `FROM` lines stay literal and digest-pinned, and an air-gapped build uses the builder's registry-mirror configuration. The npm registry stays a build argument.
- **D-40 (amends D-31):** Cosign 3.1.x ships as a bare binary; `compliance/ci/install-tool.sh` gains a `binary` archive kind and `tool-pins.json` a cosign entry (gate change, owner approval). The new `workbench` CI job is not a required check at first (like `compliance`).
- **D-41 (amends D-28):** Plain `@playwright/test` (pinned, at least two weeks old), not `@theia/playwright`. The restart test uses a tiny fixture VSIX that writes and reads a secret through `SecretStorage`, against the test OpenBao (`openbao/openbao` 2.7.x by digest, dev mode, jwt auth with static `jwt_validation_pubkeys` so tests need no Keycloak). The no-egress test reuses the outbound-recording approach of `hub/test/noOutbound.test.ts`.
- **D-42 (D-26 detail):** Telemetry is off by default with no sink; `@theia/vsx-registry` is not in the image, so no gallery exists unless added; core already refuses frontend-originated backend requests not allowed by a `BackendRequestAllowedContribution`. `STERLING_OPEN_VSX_URL` is therefore reserved and documented, and the egress test is the proof.
- **D-43 (UI, planning note):** No UI-SPEC for this phase (the UI gate was skipped as `--skip-ui`). The existing Sterling pages move unchanged; the only new person-facing text is the session identity status (`failed` with its reason and Retry), "secrets unavailable", and the step-up refusal ("Confirm with your passkey or security key"). That text uses the GLOSSARY words, no em-dashes, "your organization", and passes the copy lint. Page design work belongs to 32.1 and 33 native.
- **Interface additions for Phase 47:** use oauth2-proxy alpha config with `loginURLParameters` for `max_age`/`acr_values`/`prompt`; set `THEIA_HOSTS` if the proxy rewrites Host (Theia checks Origin against Host on the WebSocket); with the sidecar in the same pod, the workbench may stay on `127.0.0.1` and `STERLING_LISTEN_HOST` is only needed if the proxy reaches it by pod address. The workbench calls `auth/token/lookup-self` too, so the policy must allow it.

## For the owner to confirm

**Accepted by the owner, 2026-11-23:** every default below is accepted as written ("defaults are fine"). Items stay listed for traceability; none is open.
1. **Folder and image name:** `workbench/` and `sterling-workbench`.
2. **Node major and base (P11, D-34):** Node 26 for both the workbench and the hub, with the upstream Node 26 binary on UBI 9 minimal (Red Hat has no Node 26 for UBI 9 yet). The alternative is Red Hat's Node 24 image for both, which would move the hub back from 26. Default: upstream Node 26 on UBI 9.
2b. **Base-image mirrors (D-39):** through the builder's registry-mirror setting, not a `FROM` argument. Default as listed.
2c. **No keyring in the container (D-36):** a container without OpenBao has no durable secret store and says so. Default as listed.
2d. **Cosign tooling (D-40):** a cosign pin in `tool-pins.json` and a `binary` kind in `install-tool.sh`; images pushed on `main` go to ghcr.io for signing. Default as listed; the `workbench` job is not a required check at first.
3. **Spike folder:** keep a pointer README under `.planning/spikes/theia-team-studio/` instead of deleting it.
4. **Release cutover timing:** the rest of P10 as its own follow-up phase after 46; VSIX releases continue until then.
5. **Register component:** workbench resources under the existing `extension` component until Phase 48 adds a workbench component.
6. **Signing key custody in CI:** cosign key in a protected GitHub environment secret, signing only on `main`; an HSM-backed key is a Phase 47 option.
7. **Gate-file changes:** `scripts/resource-check.mjs` (two list entries) and `compliance/resources.json` need your approval in the PR.

## Version safety follow-up (owner, 2026-11-24)

The owner approved version safety on 2026-11-24 ("go"): "the application should always keep itself up to date". People never update anything. An administrator updates a site by importing a signed bundle. The policy side is Phase 32.1 (D-60 to D-69 in `32.1-CONTEXT.md`). This phase owns the workbench side of 32.1 D-66 as plan 46-09; Phase 47 owns the site side as 47-32. Decided on the owner's behalf from the approved brief; the one point to confirm is 32.1 V6.

- **D-44 (the image knows its release):** The image build writes `/opt/sterling/release.json`: `{ format: "sterling-release/1", version, reads: { policy: [...] } }`. `version` is the root `package.json` version. `reads.policy` is computed by `workbench/tools/release-facts.mjs` from the compiled engine: `FEATURE_IDS`, plus `policy-bundle@<POLICY_DOCUMENT_VERSION>` and `vocabulary@<GATE_VOCABULARY_VERSION>` (the same list as 32.1-30's `policyFeaturesRead()`, held equal by 32.1-30's parity test). An image cannot know its own digest, so the file has none.
- **D-45 (the signed release file):** The Release workflow's publish job, after it signs the image, writes `sterling-release.json`: the image's facts plus `digest`. It signs the file with your organization's cosign key in key mode (`cosign sign-blob --bundle sterling-release.json.sigstore.json`, the signed-file form 47-06's `verifySignedFile` checks) in the protected `container-release` environment, and uploads both as release assets. This is a new shared, signed format, so it follows 32.1 D-60: the site refuses a `format` it does not read (47-32).
- **D-46 (a running session sees the site's release):** A backend `SiteReleaseWatcher` reads its own facts once and the site's file `/etc/sterling/release/release.json` (the ConfigMap `sterling-release`, mounted by 47-32) at start and every 60 seconds. States: `none` (no site file: a single machine or the VS Code build; never a notice), `current`, `update-ready`, `moving`. A malformed site file is never a reason to stop: the state stays as it was. In `update-ready` the frontend shows, once per site release, "A new version of Sterling is ready. Save your work; it will reload when you're idle", and a status entry "New version ready" with that sentence as its tooltip. If the site file returns to the session's own release (the import was rolled back), the state returns to `current` and the notice goes.
- **D-47 (the move: idle stop or sign-in, never mid-work without warning):** The idle stop is Theia Cloud's own (activity tracker `timeoutAfter`, 47-12); the next start runs the AppDefinition's new image. At sign-in, meaning a browser connects when no other browser is connected, in `update-ready` and with no unsaved editor after restore, the backend stops its own session through Theia Cloud's stop request (`DELETE /service/session` with `{ appId, sessionName, user }` from the operator's `THEIACLOUD_*` variables), using the person's forwarded token (D-22), never logged. The page says "Moving to the new version of Sterling. This takes about a minute." and returns to the start page. Any failure (refused, timeout of 10 seconds, missing variables) returns to `update-ready`: the notice stays and the idle stop still moves the session. At most one move is tried per site release per session. Research step first, in 46-09: confirm against the pinned Theia Cloud 1.2.0 source (`e2d201fd`) that the service accepts the forwarded token for that request. If it does not, the move happens only at the idle stop and at a sign-in after it (the notice stays true), the gap is recorded as a Phase 47 follow-up, and no broader token is ever used.
- **Interface with Phase 47, item 11 (new):** every session pod mounts ConfigMap `sterling-release` (key `release.json`) read-only at `/etc/sterling/release`, without `subPath`, so the kubelet updates the file in a running pod (47-32). The workbench also reads `STERLING_SITE_RELEASE_FILE` to move that path in tests only.
</content>
