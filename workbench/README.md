# Sterling workbench (Eclipse Theia)

The workbench opens to Sterling Sovereign AI Canadian Defence Edition. Get Started shows the Sterling logo for the active theme and opens a native Team Studio preview with four packaged samples.

It is its own package (`sterling-workbench`, Theia 1.77.0, Node 26.13.1 or later in the 26 line) and its own image: UBI 9 minimal with the upstream Node 26 binary, native addons built on UBI, user `10001:0`, port 3000, `GET /healthz`. It never ships in the VS Code extension.

## Run locally

From the root of this checkout, build and start the workbench with Docker.

```sh
docker build -f workbench/Dockerfile -t sterling-workbench .
docker run --detach --name sterling-workbench \
  --env STERLING_LISTEN_HOST=0.0.0.0 \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  --publish 127.0.0.1:18771:3000 sterling-workbench
```

Open [Get Started](http://127.0.0.1:18771/) and select **Explore a sample team**. Reopen the page with the home icon at the top of the right sidebar or **SovAI: Get Started** in the command palette. **SovAI: Open Team Studio Preview** also opens the sample. Use the sample picker to switch between two valid teams, a sample without a team, and a sample with an invalid team. Select a member to see their role, reporting line, and instructions.

Use `docker stop sterling-workbench` and `docker start sterling-workbench` to stop and restart the same container.

**Publish it on `127.0.0.1` only.** Run locally, the workbench has no sign-in and includes a terminal, so anyone who can reach its port gets a shell as the container's user. Inside the container it listens on `127.0.0.1` by default, which a port mapping cannot reach; `STERLING_LISTEN_HOST=0.0.0.0` makes it listen on every interface so the mapping works, and the safety then comes from `--publish 127.0.0.1:…`. Never use `-p 3000:3000` or publish it on a shared host. Without sign-in in front (no `STERLING_OPENBAO_ADDR`), the image refuses to listen on any address other than loopback until you pass `--env STERLING_PREVIEW_NO_SIGN_IN=accept` to confirm this.

The container runs as user `10001` in group `0`; only its home `/home/sterling` and workspace `/home/sterling/workspace` are writable. Its runtime holds only the Node binary and production dependencies: the Theia CLI, bundlers, compilers and the browser test tools stay in the build stage. The examples are synthetic. The workbench has no host workspace mounts, provider credentials, or agent run controls.

An air-gapped build mirrors the digest-pinned base images through the builder's registry-mirror setting and points npm at a registry mirror with `--build-arg NPM_REGISTRY=<url>`.

## Develop and test

Workbench commands run on Node 26.13.1 or later in the 26 line.

```sh
npm --prefix workbench ci --ignore-scripts
npm --prefix workbench run lint
npm --prefix workbench test                        # unit tests, no Docker
npx --prefix workbench playwright install chromium   # once
npm --prefix workbench run test:container          # builds the image, checks it and opens Get Started in Chromium
```

`test:container` builds its own image tag and removes it afterwards; set `WORKBENCH_TEST_IMAGE` to test an image you built already (it is never removed). An air-gapped run sets `PLAYWRIGHT_BROWSERS_PATH` to a mirrored copy of the browsers.

## Settings

Every setting is an environment variable read once when the backend starts. In hosted mode an invalid value stops the workbench with one line that names the setting; Retry cannot fix configuration.

| Setting | Default | Meaning | Set by | Rule |
|---|---|---|---|---|
| `STERLING_LISTEN_HOST` | `127.0.0.1` | The address Theia listens on inside the container. | The pod, only when the proxy cannot reach `127.0.0.1` | In local mode a non-loopback value needs `STERLING_PREVIEW_NO_SIGN_IN=accept`. |
| `STERLING_PREVIEW_NO_SIGN_IN` | unset | Local mode only: `accept` confirms that a non-loopback bind is published on `127.0.0.1` only. | A person running the image locally | Any other value refuses a non-loopback bind in local mode. Ignored in hosted mode. |
| `STERLING_OPENBAO_ADDR` | unset (local mode) | Your organization's OpenBao. Setting it turns on hosted mode; nothing else does. | Phase 47 | `https:`, or `http:` only to `127.0.0.1`, `[::1]` or `localhost`; no user name, password, query, fragment or path. |
| `STERLING_OPENBAO_CA_FILE` | unset (the system roots) | The CA bundle (PEM) that signs OpenBao's certificate, mounted read-only from cert-manager. | Phase 47 | Must be readable by user `10001`, or the workbench stops at start. |
| `STERLING_OPENBAO_JWT_MOUNT` | `jwt` | The jwt auth mount. | Phase 47 | Lower-case letters, digits, `-` or `_`; no `/` or `..`. |
| `STERLING_OPENBAO_JWT_ROLE` | `sterling-workbench` | The session's ordinary role: KV, data keys and the token self paths. | Phase 47 | Letters, digits, `.`, `-` or `_`. |
| `STERLING_OPENBAO_STEPUP_ROLE` | `sterling-workbench-stepup` | The role that alone may sign, bound to the step-up `acr`. | Phase 47 (47-07) | As the role above, and different from it. |
| `STERLING_OPENBAO_KV_MOUNT` | `kv` | The KV version 2 mount for per-person secrets. | Phase 47 | As the jwt mount. |
| `STERLING_OPENBAO_TRANSIT_MOUNT` | `transit` | The Transit mount for the person's long-term keys. | Phase 47 | As the jwt mount. |
| `STERLING_STEPUP_ACR` | unset (signing off) | The `acr` your identity provider issues after a fresh passkey or security key sign-in. Unset means signing is not set up on this site. | Phase 47 (the realm) | Compared exactly. |
| `STERLING_STEPUP_MAX_AGE_SECONDS` | `300` | How old that sign-in (`auth_time`) may be when the person signs. | Phase 47 | A whole number from 1 to 3600. |
| `STERLING_OPEN_VSX_URL` | unset (no gallery) | One extension gallery address. | Phase 47 | One address on the `STERLING_OPENBAO_ADDR` address rule; no wildcard host. |
| `STERLING_MODEL_SERVERS` | unset (none) | The model server addresses, as a JSON array of strings, for example `["https://models.example:8443/v1"]`. Unset, empty or `[]` means none. | Phase 47 (`siteEnv.modelServers`, rendered with `toJson`) | At most 32 addresses, each on the same rule. Anything that is not a JSON array of strings, a comma-separated list included, stops the workbench. |

Read from each request, never from the environment: `X-Forwarded-Access-Token` (the identity provider's JWT with `sub`, `aud`, `email`, `exp`, and for signing `acr` and `auth_time`), `X-Auth-Request-Email` and `X-Auth-Request-User`, on every HTTP request and on each WebSocket upgrade. Read from the environment in hosted mode: `THEIACLOUD_SESSION_USER`, the person the session was started for; it is required, and it must name the same person as the headers (compared by email, ignoring case), or the session is failed with "This session was started for someone else".

## Interface with Phase 47

The names below are final. Phase 47 configures and deploys them; a change to any of them changes both phases together. This section is the one place Phase 47 reads them.

| Item | As built |
|---|---|
| Image | The `release` target of `workbench/Dockerfile`: UBI 9 minimal with the upstream Node 26 binary and the release's verified VSIX bundled at `/plugins`. The Release workflow publishes it at `ghcr.io/<owner>/<repository>@sha256:…` (the repository name lower-cased) and records that reference on each GitHub release; in its `publish` job, in the protected `container-release` environment, it signs the digest with your organization's cosign key and attests the CycloneDX SBOM, then verifies both. Deploy it by digest only. `sterling-workbench` is the local and CI tag of the default (development) target, which has no bundled VSIX; it is never published. |
| Port and health | Port 3000; `GET /healthz` answers `200 ok` with no cookie and says nothing about the session; the image's `HEALTHCHECK` runs `node /app/bin/healthcheck.mjs`. |
| User and writable paths | User `10001`, group `0` (any UID in group 0 works); writable `/home/sterling` (with the workspace `/home/sterling/workspace`) and `/tmp`; the app tree `/app` is read-only. |
| Bind | `127.0.0.1` by default. oauth2-proxy in the same pod reaches it there, so keep the default; set `STERLING_LISTEN_HOST=0.0.0.0` only if the proxy is outside the pod, and then a network policy must make port 3000 reachable from the proxy alone. |
| Headers | oauth2-proxy with `pass_access_token` and `set_xauthrequest`: `X-Forwarded-Access-Token`, `X-Auth-Request-Email`, `X-Auth-Request-User`. `THEIACLOUD_SESSION_USER` per session from the operator. |
| jwt auth | Mount `STERLING_OPENBAO_JWT_MOUNT` (`jwt`). Role `STERLING_OPENBAO_JWT_ROLE` (`sterling-workbench`): `role_type=jwt`, `user_claim=sub`, `bound_audiences` `sterling-sessions`, `token_no_default_policy`, `token_policies` `sterling-workbench`, a short renewable token (Phase 47: 15 minutes, renewable to 8 hours); one entity per person. The workbench logs in with `{"role": <role>, "jwt": <forwarded token>}`, reads the entity from `auth/token/lookup-self`, renews at half the lease with `auth/token/renew-self` and revokes with `auth/token/revoke-self` when the session stops. |
| Step-up role | `STERLING_OPENBAO_STEPUP_ROLE` (`sterling-workbench-stepup`; Phase 47 leaves it unset and uses this default): the same mount, audience and `user_claim=sub` (so the same entity), `bound_claims` requiring the step-up `acr`, `token_ttl`, `token_max_ttl` and `token_explicit_max_ttl` equal to `STERLING_STEPUP_MAX_AGE_SECONDS`, and `token_policies` `sterling-workbench` and `sterling-workbench-sign`. Its token stops working when the window ends and OpenBao then refuses to sign, so the workbench keeps no step-up token: for each signature it logs in with the fresh forwarded token, signs with the token it gets and revokes that token. |
| KV paths | Logical `<kv>/users/<entity_id>/<service>/<account>`; API `<kv>/data/users/…` and `<kv>/metadata/users/…`. Each of `<service>` and `<account>` is encoded as `u` followed by the base64url (no padding) of its UTF-8 bytes, so no string leaves the person's prefix; the layout is fixed once a site stores secrets, and a change needs a per-site migration. Calls: `GET` and `POST` on `data/…` (body `{"data":{"password":…}}`), `GET …?list=true` and `GET` on `metadata/…`, `DELETE` on `metadata/…` (all versions). |
| Policy for `sterling-workbench` | `<kv>/data/users/{{identity.entity.id}}/*` and `<kv>/metadata/users/{{identity.entity.id}}/*`: create, read, update, delete, list. `<transit>/datakey/wrapped/kek-{{identity.entity.id}}` and `<transit>/decrypt/kek-{{identity.entity.id}}`: update. `auth/token/lookup-self`: read. `auth/token/renew-self` and `auth/token/revoke-self`: update. No `transit/sign`. |
| Policy `sterling-workbench-sign` | `<transit>/sign/person-{{identity.entity.id}}`: update. Nothing else; only the step-up role carries it, and the token self paths come from `sterling-workbench` beside it. |
| Transit keys | `person-<entity_id>` (`ed25519`, the signing key) and `kek-<entity_id>` (`aes256-gcm96`, wraps data keys), both non-exportable, created by Phase 47 at enrolment. The workbench calls only `sign`, `datakey/wrapped` and `decrypt`; it never creates, rotates, exports, configures or deletes a key, and a missing key is the plain refusal "Your signing key is not set up yet. Ask your administrator." Signatures come back without the `vault:vN:` prefix. |
| OpenBao address | `STERLING_OPENBAO_ADDR` over https with `STERLING_OPENBAO_CA_FILE`; plain http only to a loopback address (an OpenBao agent or proxy in the pod). |
| Step-up sign-in | The command "Sterling: Confirm with your passkey or security key" opens `/oauth2/start?rd=<this page>&acr_values=<STERLING_STEPUP_ACR>&max_age=0` on the same origin. oauth2-proxy needs its alpha config with `loginURLParameters` for `acr_values` (allow the step-up value), `max_age` (allow `^[0-9]+$`) and `prompt` (allow `login`), and `cookie_refresh` so the forwarded token is not stale. The realm must issue `acr` and `auth_time` in the access token. |
| `THEIA_HOSTS` | Set it to the public host name when the proxy rewrites `Host`; Theia refuses a WebSocket whose `Origin` host differs from `Host` otherwise. |
| `STERLING_MODEL_SERVERS`, `STERLING_OPEN_VSX_URL` | As in Settings. They are the backend request allow list, exact origins only; with neither set the workbench calls out to nothing. `STERLING_MODEL_SERVERS` is a JSON array of strings, the form `deploy/charts/sterling-sessions/templates/site-env.yaml` renders. `workbench/test/site-env-contract.test.ts` reads every rendered `STERLING_*` value from `workbench/test/fixtures/site-env.rendered.json` with the workbench's own settings readers, and `deploy/test/render-sessions.test.mjs` checks that fixture against the chart render, so a format change on either side fails a test. |
| Sign-in keys | Sign-in is by passkeys or hardware security keys only, with phone passkeys first. The workbench never asks for a credential, never builds a WebAuthn relying-party ID, and never assumes a per-site one: the identity provider owns the ceremony. |

### What Phase 47 closes

- Enforce step-up in OpenBao: the `sterling-workbench-stepup` role's bound claims require the step-up `acr` and its token lives no longer than the window. The workbench's own `acr` and `auth_time` check is a guard and a clear message, not the enforcement, because it reads a header it cannot verify.
- Keep each person's email unique and immutable in the identity provider: the person check compares emails.
- Keep the access token small: Node refuses request headers over 16 KiB, so a token with many role mappings fails every request.
- Keep port 3000 pod-local: a reachable port 3000 bypasses the proxy and its sign-in.
- Keep one host name per site: SecretStorage keys start with the page's host name, so a rename leaves earlier secrets behind.
- Do not assume a per-site relying-party ID in the workbench; passkeys belong to the identity provider's host.

## Browser harness and air-gapped runs

`npm --prefix workbench run test:container` needs Docker with BuildKit and Playwright's pinned Chromium. It builds the image once (or uses `WORKBENCH_TEST_IMAGE`), runs the container suite one file at a time with every container capped at 3 GB (OpenBao at 512 MB), and removes only what it made. The hosted suite runs the digest-pinned `openbao-test` image in dev mode with a TLS listener signed by a throwaway test CA, signs JWTs with a throwaway test key that OpenBao trusts, and sends the three proxy headers itself, so it needs no Keycloak, no oauth2-proxy and no internet. It mounts a test-only extension, `test/fixtures/secret-probe`, which never enters the image.

For an air-gapped run:

- Point `PLAYWRIGHT_BROWSERS_PATH` at a mirrored copy of the pinned Playwright browsers.
- Build with `--build-arg NPM_REGISTRY=<your registry mirror>`. This relies on npm rewriting the lockfile's `registry.npmjs.org` addresses to the configured registry; confirm it on the first build against your internal mirror.
- Mirror the digest-pinned base images through the builder's registry-mirror setting. No `FROM` line takes a build argument, so the fit check sees and pin-checks every base.

A container without OpenBao (local mode) has no durable secret store: the image does not build the OS keyring module, so it shows "Secrets are unavailable" and a save fails visibly. It never keeps secrets in memory.

## Run the existing extension in Theia

Build the same image as above. From this checkout, run `npm ci` and `npm run package` to build a VSIX with the Theia command fixes. Unpack that VSIX into the ignored local plugin directory, then start a separate container with that directory mounted read-only. The VSIX runs with a new container-side workspace and no host home or provider credentials. The local session disables automatic GSD installation.

```sh
mkdir -p workbench/local-plugins
unzip -q ./near-ai-vscode-*.vsix 'extension/*' -d workbench/local-plugins

docker run --detach --name sterling-workbench-vsix \
  --publish 127.0.0.1:18874:3000 \
  --mount "type=bind,source=$PWD/workbench/local-plugins,target=/plugins,readonly" \
  --env THEIA_DEFAULT_PLUGINS=local-dir:///plugins \
  --env STERLING_LISTEN_HOST=0.0.0.0 \
  --env STERLING_PREVIEW_NO_SIGN_IN=accept \
  sterling-workbench --session-preference nearAi.autoInstallGsd=false
```

Open [the VSIX workbench](http://localhost:18874/) using `localhost` so Theia can use separate `*.webview.localhost` origins. From the command palette choose **NEAR AI: Set Up**, **NEAR AI: Team Studio**, or **NEAR AI: Open Chat**. The compatibility container is for synthetic projects. It has no durable secret store, so it shows "Secrets are unavailable" and an extension's saved secrets fail visibly instead of living in memory.

The Release workflow builds the `release` target, which bundles the release's verified VSIX at `/plugins` the same way.

## Documentation and Compliance

The right sidebar opens both views in Theia. Documentation search uses the guides packaged in the image. Links to included topics open in place. Other links open in your browser.

The Compliance view displays an evidence bundle's recorded states and source, with filters for level, state and control. The image starts without evidence. From a trusted checkout, run `npm --prefix docs-site run compliance:refresh` to verify the evidence manifest and write the public dashboard projection. Add the following read-only bind mount when starting the local container.

```sh
--mount "type=bind,source=$PWD/docs-site/static/compliance,target=/app/lib/frontend/compliance,readonly"
```

Mount only the public projection written by the [documentation site's evidence refresh](../docs-site/README.md). The container's user must be able to read its dashboard, `refresh.json` and public control text. The view shows states only when `refresh.json` records a verified manifest for the same commit as the dashboard. It reports missing, invalid, unverified or old bundles, and shows no evidence counts until a verified projection is available. The view shows the states the bundle recorded when it was built; it does not recompute them.

## Research

Theia provides both a VS Code extension host and native application extensions. The native widget uses the Theia workbench and calls the backend through Theia JSON-RPC. See [Theia native extensions](https://theia-ide.org/docs/authoring_extensions/), [Theia JSON-RPC](https://theia-ide.org/docs/json_rpc/), and [VS Code extension support](https://theia-ide.org/docs/authoring_vscode_extensions/).

The parser carries over directly. The current VS Code extension declares VS Code 1.101 or later and also uses webview panels and the chat participant API. The container includes the pinned Theia VS Code extension host for running the VSIX alongside the native widget. Native ports also need to wire real project selection, workspace file access, and writes through the new host.

## Results

The browser container builds from the pinned dependencies and runs on localhost. Chromium verified that the widget opens, both valid projects load, member details show the reporting line, missing and invalid projects display their own messages, and returning to a valid project restores the roster. The backend uses the existing parser without changes.

See [Theia migration and acceptance](MIGRATION.md) for the full extension cutover.
