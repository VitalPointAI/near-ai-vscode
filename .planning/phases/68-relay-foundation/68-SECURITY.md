---
phase: "68"
slug: "relay-foundation"
status: verified
# threats_open = count of OPEN threats at or above security_block_on severity (blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-11-15"
---

# Phase 68 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Verdict: **SECURED**. 36 of 36 threats resolved (34 mitigations verified in code, 2 accepted risks logged). `threats_open: 0`.

`.planning/config.json` sets neither `security_asvs_level` nor `security_block_on`, so the defaults apply: ASVS level 1 and block on `high`. Verification was done to ASVS level 2 depth (each mitigation checked at the boundary where it must act, not just for a matching pattern). Evidence is the code in this worktree at `4a576ef` (branch `feat/messaging-relay`), not the SUMMARY files.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| npm registry and nodejs.org -> `relay/node_modules`, nvm | packages and the Node binary installed for the relay | package tarballs (integrity-pinned), Node tarball |
| operator environment -> relay process | `RELAY_*` settings, argv, secret file paths | settings; never secret values (plain-env secrets refused) |
| HTTP client -> `/healthz` | loopback by default; container-internal port 8080, published on 127.0.0.1 only | request line and headers in; fixed five-field JSON out |
| relay process -> stdout | the only log sink | redacted metadata lines |
| repository -> public VSIX / git history | everything vsce packages is published; everything tracked is kept forever | source; must never include `relay/**`, state or secrets |
| other local users -> state directory | database holds queued message text and run records | message payloads (future), pseudonym key |
| tenant A records -> tenant B callers | every later phase reads state for one tenant | tenant-scoped rows |
| operator secret files -> relay memory -> logs | file permissions decide who else can read them | Teams secret, tenant keys, pseudonym key |
| registries / build context -> image -> host | base images by digest, allow-listed context, hardened runtime | image layers, env, mounted secrets |
| PR author -> CI and gate definitions; CI runner -> repo; repo -> VSIX | a PR runs some of its own gate files; release-content is the last check | workflow files, CI token |

---

## Threat Register

Status: `closed` = mitigation found in code (or accepted risk logged). No threat is open.

| Threat ID | Category | Component | Severity | Disposition | Evidence (file:line) | Status |
|-----------|----------|-----------|----------|-------------|----------------------|--------|
| T-68-01 | Elevation of privilege | `relay/src/bin.ts`, `relay/.npmrc` | high | mitigate | `relay/.npmrc:1` `engine-strict=true`; `relay/package.json:8-10` engines `>=26.13.1 <27`; `relay/src/nodeVersion.ts:8-12` refuses anything but 26.13.1+ 26.x (NaN fails closed); `relay/src/bin.ts:5-9` checks before importing the app; Docker `CMD` and healthcheck both run `/app/bin.mjs`. Ran `workspace.test.js` with `NEAR_AI_RELAY_OLD_NODE` set to the real Node 24.22.2: EBADENGINE, one-sentence refusal, 0 skipped | closed |
| T-68-02 | Information disclosure | `relay/src/health.ts` | medium | mitigate | `relay/src/health.ts:8-14,58` fixed five-key body; `relay/src/http/server.ts:42-46` 404 and 405 bodies are constants; `relay/test/health.test.ts:47,110,133` and `startup.test.ts:117` assert key set and no path echo | closed |
| T-68-03 | Denial of service | `relay/src/http/server.ts` | medium | mitigate | `server.ts:64-67` headersTimeout 5000, requestTimeout 10000, keepAliveTimeout 5000, maxHeadersCount 50; `server.ts:42-51` literal GET-only route table; `server.ts:31` `req.resume()` and no body parsing. See Advisory A3 (effective eviction is 30 s) | closed |
| T-68-04 | Information disclosure | `relay/src/log/redact.ts`, `logger.ts` | high | mitigate | `redact.ts:20-35` sensitive keys reduced to lengths; `redact.ts:53-76` registered values masked, longest first, mask before 500-char cap; `redact.ts:78-96` flat values only, phone-named fields labelled; `logger.ts:33-47` every field goes through `redactor.fields`. Grep of `relay/src`: the only `process.stdout` is `logger.ts:16`, the only `process.stderr` is `bin.ts:7` (fixed sentence); `logging.test.ts:190-230` fails the suite on any other output path. See Advisory A1 | closed |
| T-68-05 | Tampering | `relay/src/config.ts` | low | mitigate | `config.ts:27-31` unknown `RELAY_*` stops startup; `config.ts:36,43,50` host, port and absolute-path checks; errors name the variable, never the value (`startup.test.ts:191,203`) | closed |
| T-68-06 | Information disclosure | `.vscodeignore` | high | mitigate | `.vscodeignore:33-34` `relay/**` and `.dockerignore`. Ran real `vsce ls --no-dependencies` with live `relay/state/relay.db` and `relay/state/log-pseudonym.key` present: 328 entries, none matching relay, dockerignore, `.db`, `.key` or secret | closed |
| T-68-07 | Information disclosure | `.gitignore` | high | mitigate | `.gitignore:30-34`; `git check-ignore -v` confirms `relay/state/*`, `relay/secrets/*`, `relay/**/*.db`, `-wal`, `-shm` are ignored; `git ls-files relay` lists no state, key or secret file; no such file was ever added in `57bad82..HEAD`; `node scripts/secret-scan.mjs`: clean, 948 files | closed |
| T-68-08 | Tampering | root `package.json`, lockfile, `tsconfig.json` | medium | mitigate | `git diff 57bad82 HEAD` leaves all three untouched; direct check: no `workspaces`, no `dependencies`, no `relay` lock keys, `include` is `["src/**/*.ts"]`, `rootDir` is `src`; `src/test/relayIsolation.test.ts:30-46` (plus the six other cases, 8/8) ran and passed | closed |
| T-68-09 | Information disclosure | `relay/src/stateDir.ts`, `sqliteStore.ts` | high | mitigate | `main.ts:54` `process.umask(0o077)`; `stateDir.ts:46-47` create 0700 then chmod; `stateDir.ts:62-70,83-95` tighten own loose dir and entries to 0700/0600; `sqliteStore.ts:157-163` database pre-created 0600 so `-wal` and `-shm` inherit it; `stateDir.test.ts:219` proves all three files 0600 under umask 022 (ran, pass); container test proves state dir `700` uid 65532 and every file `600` in the running container | closed |
| T-68-10 | Tampering | `relay/src/stateDir.ts` | medium | mitigate | `stateDir.ts:51-53` symlinked dir refused; `:75-77` symlinked entry refused; `:57,78` other owner refused; `:145-158` private reads use `O_NOFOLLOW`, then `fstat` for regular file, owner and mode; `stateDir.test.ts:107-167,195` (ran, pass) | closed |
| T-68-11 | Repudiation | `relay/src/store/sqliteStore.ts` | high | mitigate | `sqliteStore.ts:243-253` every write is `BEGIN IMMEDIATE` ... `COMMIT`, method resolves after COMMIT; `:168` `PRAGMA synchronous = FULL`; `schema.ts:45` `UNIQUE (tenant_id, dedupe_key)`; `killDrill.test.ts:24` 15 rounds of `kill -9`, ran 15/15 pass. The pragma has no read-back test (see Advisory A5) | closed |
| T-68-12 | Tampering | relay state directory | medium | accept | Deferred by D-21 to Phase 71; limit stated in `relay/README.md:122-124` ("One relay per state directory ... until Phase 71 adds a lock"). Logged below | closed (accepted) |
| T-68-13 | Tampering | `relay/src/store/schema.ts` | medium | mitigate | `schema.ts:104-107` `user_version` above supported throws `newer-schema` before any migration; `:109-124` each migration and its `user_version` bump commit in one `BEGIN IMMEDIATE` transaction, rolled back on error; `schema.test.ts:88,126,198` (ran, pass) | closed |
| T-68-14 | Information disclosure | `relay/src/store/sqliteStore.ts` | medium | mitigate | `schema.ts:24-80` tenant-scoped primary keys (`runs`, `approvals`), `UNIQUE (tenant_id, dedupe_key)`, composite FK `approvals -> runs`, FK to `tenants`; `PRAGMA foreign_keys = ON` at `sqliteStore.ts:169`; `sqliteStore.ts:282-299` binding conflict instead of rebinding (`:291`); every statement at `:187-232` carries `tenant_id` except the intentional global ones (binding lookup, tenant list, health counts, expiry sweep); contract cases for cross-tenant calls pass. See Advisory A6 | closed |
| T-68-15 | Tampering | runs and approvals | low | mitigate | CHECK constraints `schema.ts:19,25,35,40,57,73-74`; compare-and-set at `sqliteStore.ts:212` (`ack ... AND state='claimed'`), `:215` (`transitionRun ... AND state = ?`), `:221-224` (`answerApproval ... AND state='pending' AND expires_at > ?`) | closed |
| T-68-16 | Tampering | `relay/src/store/sqliteStore.ts` | medium | mitigate | All 24 prepared statements at `sqliteStore.ts:187-232` bind values with `?`, and the one other statement (`:185`, requeue of claimed messages) is a constant. Only template-built SQL in `relay/src`: `schema.ts:117` `PRAGMA user_version = ${index + 1}`, an integer loop index, not external input (PRAGMA cannot be parameterised). Only `src/store/` imports `node:sqlite` | closed |
| T-68-17 | Information disclosure | `relay/src/secrets.ts` | high | mitigate | `secrets.ts:80-92` `refusePlainSecretEnv` refuses catalogue names and `NEAR_AI_KEY_<A-Z0-9_>` names given as plain values; `main.ts:92` calls it before `prepareStateDir` (`:100`) and `loadSecrets` (`:112`); `noLeak.test.ts:160,175,191` and `secrets.test.ts:106` (ran, pass). See Advisory A2 | closed |
| T-68-18 | Information disclosure | secret files | high | mitigate | `secrets.ts:104` open with `O_NONBLOCK`; `:115-121` `fstat` on the opened descriptor refuses non-regular files, any group or world bit, empty and over-16-KiB files; `secrets.test.ts:127,144,153,176` | closed |
| T-68-19 | Information disclosure | errors and logs | high | mitigate | `secrets.ts:60-67,94-141` every `SecretError` message carries the secret name and the `*_FILE` label only; `:174` each loaded value is registered with the Redactor immediately; `main.ts:118` logs names and a count only; `noLeak.test.ts:146,199,215` (ran, pass) search output, state files and entry names; the container test found the fake secret in no log line, image layer, env or exported byte | closed |
| T-68-20 | Information disclosure | phone numbers in logs | high | mitigate | `redact.ts:98-102` HMAC-SHA256 label over the digits; `:99` `phone:unlabelled` before the key exists; `redact.ts:87-89` phone-named fields always labelled; `main.ts:122` key installed after the state dir; `logging.test.ts` and `pseudonymKey.test.ts:105` (ran, pass). See Advisory A1 on bare digits | closed |
| T-68-21 | Spoofing | secret path | medium | accept | Link at a secret path is followed and the target is checked on the opened descriptor (`secrets.ts:104,115-121`; `secrets.test.ts:210,218`). Logged below | closed (accepted) |
| T-68-22 | Information disclosure | `log-pseudonym.key` | low | mitigate | `pseudonymKey.ts:40` written with `writePrivateFileAtomic` (`stateDir.ts:119-137`: `wx` 0600, fsync, rename, fsync dir); `pseudonymKey.ts:28` read with `readPrivateFile` (`O_NOFOLLOW`, owner and mode check, `stateDir.ts:140-163`); only the source is logged (`pseudonymKey.ts:24,35,41`); live file is `-rw-------` | closed |
| T-68-23 | Elevation of privilege | `relay/Dockerfile` final stage | high | mitigate | `Dockerfile:24` distroless `nodejs26-debian13:nonroot`; `:26-27` only two files plus an empty state dir are copied in; Ran the pinned image: `--entrypoint sh` fails with "executable file not found"; container suite test 'no shell' and 'exported filesystem' pass | closed |
| T-68-24 | Elevation of privilege | `relay/compose.yaml` | high | mitigate | `compose.yaml:15-21` user 65532:65532, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `pids_limit 128`, `mem_limit 512m`; `docker compose config` resolves the same; container suite 'running container' (ran, pass) reads `EROFS`, `CapEff` all zeros, `NoNewPrivs 1`, uid 65532 from inside | closed |
| T-68-25 | Tampering | base and sidecar images | high | mitigate | `Dockerfile:7` and `:24` and `compose.yaml:49` all pinned `@sha256:`; ran both Dockerfile base digests locally: build stage prints Node 26.13.1, final stage prints Node 26.13.1 and uid 65532; container suite asserts the pins and `checkNodeVersion` on the image's Node | closed |
| T-68-26 | Information disclosure | build context, layers, image env | high | mitigate | `.dockerignore:3-9` deny-all allow-list (`*` then six `relay/...` entries); `Dockerfile:9-13` copies only those paths; image `ENV` holds only `RELAY_STATE_DIR`, `RELAY_HOST`, `RELAY_PORT`; container suite plants a random fake secret in `relay/secrets` and finds it in no history line, image setting, env or exported byte (ran, pass; planted file removed) | closed |
| T-68-27 | Information disclosure | published port | medium | mitigate | `compose.yaml:24` `127.0.0.1:${NEAR_AI_RELAY_PUBLISH_PORT:-8080}:8080`; `docker compose config` shows `host_ip 127.0.0.1`; README states TLS ends at the operator's proxy | closed |
| T-68-28 | Tampering | Signal sidecar | medium | mitigate | `compose.yaml:48` `profiles: ["signal"]` (default services list is `relay` only); `:49` tag `0.101` plus digest; no `ports:` key; `:46` and `README.md` record the Phase 75 re-check date 2026-12-10. See Advisory A4 | closed |
| T-68-29 | Denial of service | state volume | high | mitigate | `Dockerfile:22,27` `/state-skel` made `0700` and copied `--chown=65532:65532 --chmod=0700`; `compose.yaml:31` named volume `relay-state`; container suite `kill -s KILL` test (ran, pass): same `instanceId`, `/healthz` 200 again | closed |
| T-68-30 | Tampering | `ci.yml`, `workflow.mjs`, `verify-release-content.mjs` | high | mitigate | `scripts/lib/workflow.mjs:573-584` `GATE_PATHS` matches `.github/`, `scripts/lib/`, `scripts/verify-release-content.mjs` and `SECURITY.md`; `agent-review.yml:143-172` holds the automatic approval until the owner approves `agent-review-gates`. This PR changes three gate paths, so the hold applies. Owner step still pending (see Pending Owner Actions) | closed |
| T-68-31 | Tampering | relay regressions | medium | mitigate | `ci.yml:150` `relay` job; `workflow.mjs:5` `CI_CHECKS` includes `relay`, consumed by the merge and tag gates (`release.mjs:12`, `review.mjs:14`, `workflow.mjs:426`); `relayIsolation.test.ts` 'the merge gates require the relay check' (ran, pass). The branch-protection half is an owner action, still pending | closed (code); owner action pending |
| T-68-32 | Information disclosure | published VSIX | high | mitigate | `scripts/verify-release-content.mjs:138-139` refuses `extension/relay` and `extension/.dockerignore`; applied to every VSIX entry at `:149-150`; regexes pinned by `relayIsolation.test.ts` 'the release check refuses relay files' (ran, pass) | closed |
| T-68-33 | Elevation of privilege | relay CI job | medium | mitigate | `ci.yml:21-22` workflow `permissions: contents: read`; `:160` `persist-credentials: false`; both actions pinned to full SHAs identical to the extension jobs; asserted by `relayIsolation.test.ts` 'CI runs the relay job ...' (ran, pass) | closed |
| T-68-34 | Tampering | npm install scripts in CI | medium | mitigate | `ci.yml:166` `npm ci --ignore-scripts`; `relay/package.json:26-28` `allowScripts.esbuild: false` (npm 11.20.0 on Node 26.13.1 documents `false` as always denied); `Dockerfile:10` `npm ci --ignore-scripts` | closed |
| T-68-SC | Tampering | npm installs in `relay/`, nvm, root `npm ci`, image build, CI | high (highest of the eight per-plan entries) | mitigate | Plan 01: owner approved the pins before any install (`68-01-SUMMARY.md` D-20 record: jose 6.2.17, @types/node 26.6.6); `relay/package.json` exact pins; `relay/package-lock.json` v3, integrity on every entry, one runtime package (`jose`); jose has no install scripts; esbuild is the only package with an install script and is denied. Plans 02-06: `git log` shows only plan 01 changed dependencies, plan 07 added one npm script; `relay/src` imports only `node:*` modules; `jose` is not imported or bundled (0 hits in `dist/app.mjs`, `dist/bin.mjs`). Plan 03: root manifest, lockfile and tsconfig are untouched by the phase (`git diff 57bad82 HEAD`). Plans 07 and 08: `npm ci --ignore-scripts` in the digest-pinned build stage and in CI, `npm audit --omit=dev --audit-level=high` (`ci.yml:167`) | closed |

**Totals:** 36 threats (T-68-01 to T-68-35, and T-68-SC covering eight per-plan entries). Closed 36, open 0. Blocking open (severity >= high): 0. Open below threshold: 0.

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-68-01 | T-68-12 | Two relays opening one state directory could double-process queues. No consumer of the queue exists until Phase 71, so nothing can be double-processed in Phase 68. The single-instance lock is deferred to Phase 71, where the first consumer lands (decision D-21 in `68-CONTEXT.md`). The limit is stated to operators in `relay/README.md:122-124`. A `relay_meta.instance_id` row exists now so the lock decision can build on it. Re-open if Phase 71 ships without the lock. | Owner, decision D-21 | 2026-11-14 |
| AR-68-02 | T-68-21 | A symbolic link at a secret path is followed, and the target is checked on the opened descriptor (regular file, no group or world bit). Whoever can place a link where the operator points the relay already controls the secret source, so refusing links would add no protection and would break Docker and systemd secret mounts that are links. | Plan 68-06 threat model (planner). No separate owner sign-off is recorded; the owner may confirm at PR review | 2026-11-14 |

Deferred by design, not an accepted risk of the code: the Signal sidecar tag and digest re-check belongs to Phase 75 before about 2026-12-10 (D-21). It is recorded in `relay/compose.yaml:46` and `relay/README.md`, and the container suite asserts the date is present. The date is 25 days after this audit.

---

## Advisories (non-blocking, no threat is open because of them)

| ID | Related | Observation | Suggested action |
|----|---------|-------------|------------------|
| A1 | T-68-04, T-68-20 | The sensitive-key list is an exact match on the normalised key. Probed with the real `Redactor`: `accessToken` and `clientSecret` with an unregistered value pass through unchanged, and a bare digit string such as `4155551234` in free text is not labelled (a `+` prefix or a `phone` field name is required; the plan's Pitfall 10 accepts this for dates and ids). Registered secrets are masked whatever the key. Today every log call site is code-controlled metadata, so nothing leaks now | Before Phase 69 logs real inbound auth data, match sensitive keys by containment (`token`, `secret`, `password`, `authorization`, `cookie`, `key`) instead of equality. Keep logging only ids, lengths and labels at call sites |
| A2 | T-68-17 | The plain-env refusal matches `^NEAR_AI_KEY_[A-Z0-9_]{1,64}$`. `NEAR_AI_KEY_acme` or a name past 64 characters is not refused, although the relay would never read it either. The test pins this (`secrets.test.ts:124`) and the README documents capitals | When Phase 71 first reads tenant keys, consider refusing any plain env name that starts with `NEAR_AI_KEY_`, whatever the case |
| A3 | T-68-03 | `headersTimeout = 5000` is enforced only on the connections check, which runs every 30 s by default. Measured: a client that stops after a partial request line was closed with `408` after 30024 ms, not 5 s. The hold time is still bounded, and `health.test.ts:155` asserts only the property values. There is no `maxConnections` | Set `server.connectionsCheckingInterval` to about 1000 ms and add a read-back test of the real close time before the port sits behind the Teams webhook (Phase 69) |
| A4 | T-68-28 | The `signal` service in `compose.yaml:47-58` has none of the relay's hardening (`user`, `read_only`, `cap_drop`, `no-new-privileges`, limits). It is off by default and publishes no port, which is all T-68-28 promised | Harden the sidecar in Phase 75 when it is wired, and register it as a threat then |
| A5 | T-68-11 | `PRAGMA synchronous = FULL` (`sqliteStore.ts:168`) is present but no test reads it back, and the kill drill cannot show it (its own comment says so) | Add a test that opens a store and compares the pragma, or accept the grep-level proof |
| A6 | T-68-14 | `acceptInbound` stores a message for `(tenant, channel, conversation)` without checking that the conversation is bound to that tenant, and `runs.message_id` is not a composite foreign key. Not exploitable now (nothing calls it but tests) and not part of the declared mitigation | Phase 69 (IDNT-03) must resolve the tenant through `getBinding` before `acceptInbound`; consider enforcing the binding inside the store |
| A7 | T-68-01 | The three real-Node-24 tests (guard sentence, `check-node`, EBADENGINE) skip unless `NEAR_AI_RELAY_OLD_NODE` is set, and the CI `relay` job does not set it. CI still covers `checkNodeVersion` and the `.npmrc` and `engines` content | Optional: have CI install a Node 24 alongside and set the variable |

---

## Unregistered Flags

All eight `## Threat Flags` sections in the `68-0N-SUMMARY.md` files say "None", and each of their threats maps to the register. Surface found during the audit that has no threat entry: the Signal sidecar's missing runtime hardening (Advisory A4), already inert while the profile is off. No other new attack surface was found: the only network listener is `GET /healthz` (plus `--healthcheck`, which calls it on loopback), and `jose` is declared but neither imported nor bundled in this phase.

## Pending Owner Actions (not code gaps)

- Approve the `agent-review-gates` run on the relay PR. This PR changes gate paths (`.github/workflows/ci.yml`, `scripts/lib/workflow.mjs`, `scripts/verify-release-content.mjs`), so the automatic approval waits for the owner (T-68-30). The PR is not opened yet.
- After the merge, add `relay` (app id 15368) to `main`'s branch protection with the command in `docs/development-workflow.md` section 8 (T-68-31). The merge and tag scripts already require it through `CI_CHECKS`; branch protection is the second layer. Recorded as pending in `.planning/STATE.md` lines 70 and 86.

## Root SECURITY.md

Not required to close any threat in this phase, but a short update is recommended in this PR. The file is the repository's report and some statements are now ambiguous or incomplete:

- `Dependencies` says "`package.json` declares no runtime dependencies". That stays true of the root manifest, but `relay/package.json` declares one (`jose` 6.2.17, exact pin, own lockfile, installed with scripts off, not imported or bundled yet, never in the VSIX). Say so in one sentence.
- `How changes reach a release` lists what CI runs. There is now a seventh job, `relay` (Node 26.13.1, `npm ci --ignore-scripts`, `npm audit` at high, type check, tests, container hardening tests). Add it, and note the install-scripts sentence there applies to the extension's build job.
- `Verify it yourself` lists what `verify:release` refuses. It now also refuses `relay/` and `.dockerignore`.
- Add a short "Messaging relay (foundation)" note: a separate service, not part of the extension, handles no Teams or Signal message yet, its only endpoint is `GET /healthz` returning five non-identifying fields (loopback by default, container port published on 127.0.0.1 only), secrets only from files, redacted logs. Bump `Last reviewed`.
- The PR template box ("does not change where data goes ... or SECURITY.md is updated") can be ticked without an edit, because no extension data flow changed. SECURITY.md is already a gate path, and this PR needs the owner's approval anyway, so editing it costs no extra approval.
- A full relay section (message text stored in the state directory, Teams webhook, tenant isolation, per-tenant keys) becomes mandatory when Phase 69 and later start receiving messages.

---

## Verification Log

Read-only on code. Commands run in this worktree under `systemd-run ... MemoryMax=4G ... choom -n 1000 ... timeout`, Node 26.13.1 by PATH prefix, no rebuild of `relay/dist` (it was newer than every source file):

- `node --test` over `workspace`, `logging`, `health`, `secrets`, `stateDir`, `pseudonymKey`, `noLeak`, `schema`, `sqliteStore`, `startup` (with `NEAR_AI_RELAY_OLD_NODE` = Node 24.22.2): 132 pass, 0 fail, 0 skipped.
- `killDrill.test.js`: 15 of 15 pass.
- `test/container/container.test.js` (builds the image, runs Compose, removes only its own image, project and temp files): 10 of 10 pass; no leftover container, image or volume, no `relay/secrets`.
- Root `dist/test/relayIsolation.test.js`: 8 of 8 pass.
- `vsce ls --no-dependencies` with live state files present; `git check-ignore -v`; `git ls-files`; `node scripts/secret-scan.mjs`; `docker compose config`; `docker run` of both pinned base digests; a probe of `Redactor`; a stalled-header connection against `createRelayServer`.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-11-15 | 36 | 36 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-11-15
