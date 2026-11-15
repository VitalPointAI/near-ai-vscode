---
phase: 68-relay-foundation
verified: 2026-11-15T11:40:00Z
status: human_needed
score: 4/4 must-haves verified
covered_files:
  - .github/workflows/ci.yml
  - .planning/phases/68-relay-foundation/68-01-PLAN.md
  - .planning/phases/68-relay-foundation/68-01-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-02-PLAN.md
  - .planning/phases/68-relay-foundation/68-02-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-03-PLAN.md
  - .planning/phases/68-relay-foundation/68-03-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-04-PLAN.md
  - .planning/phases/68-relay-foundation/68-04-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-05-PLAN.md
  - .planning/phases/68-relay-foundation/68-05-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-06-PLAN.md
  - .planning/phases/68-relay-foundation/68-06-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-07-PLAN.md
  - .planning/phases/68-relay-foundation/68-07-SUMMARY.md
  - .planning/phases/68-relay-foundation/68-08-PLAN.md
  - .planning/phases/68-relay-foundation/68-08-SUMMARY.md
  - relay/Dockerfile
  - relay/compose.yaml
  - relay/src/health.ts
  - relay/src/main.ts
  - relay/src/secrets.ts
  - relay/src/stateDir.ts
  - relay/src/store/sqliteStore.ts
covered_digest: "v4:sha256:69b1dd7af4aa1c93ee56b38cf9ac9327464027f26b9dd3fd70d66ff473504d25"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "D-19 (68-08 Task 3): after the PR exists, the owner approves the agent-review-gates environment for it, and after merge re-applies main's branch protection with the `relay` required status check (the command is in docs/development-workflow.md section 8)."
    expected: "The relay job runs and passes on the PR; `relay` is listed as a required check on main; a PR with a red relay job cannot merge."
    why_human: "Owner-only action on GitHub settings; cannot happen before the PR exists. Not a code gap."
  - test: "Optional, on the first CI run: confirm the `relay` job (npm ci, audit, lint, test, test:container) is green on the GitHub runner."
    expected: "All steps pass on Node 26.13.1 including the container suite (which needs Docker)."
    why_human: "The container suite (10 tests, needs Docker) was deliberately not re-run in this verification; its result rests on the 68-08 gate record plus static checks below."
---

# Phase 68: Relay foundation Verification Report

**Phase Goal:** An operator runs the relay as their own host-side service: its own workspace, its own state directory, its own hardened container, before any chat traffic is accepted.
**Verified:** 2026-11-15
**Status:** human_needed (all four success criteria hold in the code; the only open item is the owner-only D-19 action)
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths (ROADMAP success criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Clean checkout installs the relay on Node 26.13.1, `engines` pinned so an older runtime refuses, separate lockfile, exactly one new runtime dependency (`jose`); extension keeps its Node target and zero-dependency bundle (RELAY-01) | VERIFIED | `relay/package.json`: `engines.node ">=26.13.1 <27"`, `dependencies` = `{jose: 6.2.17}` only. `relay/.npmrc` has `engine-strict=true`; `relay/.nvmrc` 26.13.1. `relay/package-lock.json` is separate (runtime packages in the lock: `node_modules/jose` only). Root `package.json` has no `dependencies` key, engines is `vscode` only, root lockfile untouched. Ran `dist/bin.mjs` under Node 24.22.2: printed "near-ai-relay needs Node 26.13.1 or a later 26.x release; this is Node 24.22.2..." and exited 1. `src/bin.ts` guard + `scripts/check-node.mjs` share `src/nodeVersion.ts`. `.vscodeignore` has `relay/**` and `.dockerignore`. Relay suite tests cover EBADENGINE under old Node, lockfile shape, and the import boundary. Root `dist/test/relayIsolation.test.js` run on Node 24: 8/8 pass. |
| 2 | `GET /healthz` reports version, uptime, Teams verifier and Signal sidecar state, in-flight run count (RELAY-02) | VERIFIED | Started the built relay on Node 26.13.1 and curled it: `200 {"version":"0.7.0-dev","uptimeSeconds":1,"teams":"not-configured","signal":"not-configured","inFlightRuns":0}`. `inFlightRuns` is wired to `store.countRuns(IN_FLIGHT_RUN_STATES)` in `main.ts` (real query, not a literal). `HealthRegistry` takes real probes per component with a timeout; both report `not-configured` in this phase by design (D-12, later phases plug probes). 503 when the store count fails. `--healthcheck` flag used by the Compose healthcheck. health.test.ts passes. |
| 3 | Killing the relay with queued messages and in-flight run records and restarting loses nothing; all state lives in one git-ignored directory readable only by the relay's OS user (RELAY-03) | VERIFIED | `sqliteStore.ts`: WAL, `PRAGMA synchronous = FULL`, message + run written in one transaction, acknowledged after COMMIT. `killDrill.test.ts` (15 rounds, child killed with SIGKILL after `ack N`) passes in the 147/147 run: every acked message and run survives, no duplicates, integrity check ok. `stateDir.ts`: creates 0700, refuses symlinks, other-owner dirs/entries, tightens own open dir/files (D-17). Live run: state dir 700, `relay.db`, `-wal`, `-shm`, `log-pseudonym.key` all 600. `git check-ignore` confirms `relay/state/`, `relay/secrets/` ignored; `.gitignore` also covers `*.db`, `-wal`, `-shm`. Contract suite covers tenants, bindings, queues, runs, approvals; schema versioning and stable instance id across kill -9. |
| 4 | Image built without shell or package manager; every secret read at startup from an operator-supplied source and never in the image, state directory listing or a log line (RELAY-04) | VERIFIED (container run not re-run here, see note) | `relay/Dockerfile`: final stage `gcr.io/distroless/nodejs26-debian13:nonroot@sha256:...`, both stages digest-pinned, `USER 65532`, only `bin.mjs` and `app.mjs` copied, no secret, ENTRYPOINT is the node binary. `compose.yaml`: `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, uid 65532, loopback publish, tmpfs /tmp, secret via Compose secret and `TEAMS_APP_SECRET_FILE`; state volume only writable mount; Signal sidecar in profile `signal`, tag + digest pinned, no ports. `secrets.ts`: file-only sources (`{NAME}_FILE`, `$CREDENTIALS_DIRECTORY`, `/run/secrets`), plain env value refused (`refusePlainSecretEnv`, runs before the state dir is touched), group/world-readable file refused, empty/short/multi-line refused, error messages name the secret and never a value, every value registered with the Redactor on read. `logger.ts` is the sole stdout writer in `relay/src` (grep: only `logger.ts` and the pre-logger version sentence in `bin.ts` write output). `noLeak.test.ts` runs the real relay with a fake secret and asserts it appears in no output, state file, or entry name. The container suite (`test/container/container.test.ts`, 10 tests: shell absent, filesystem export has no shell/package manager, no fake secret in any layer, hardening flags on the running container, kill -9 of the container) exists and asserts the claim; I did not run it (requires Docker; instructed not to). |

**Score:** 4/4 truths verified (0 present-but-behavior-unverified)

### Requirements Coverage

Plan frontmatter IDs: 68-01 RELAY-01/02; 68-02 RELAY-02/04; 68-03 RELAY-01; 68-04 RELAY-03; 68-05 RELAY-03; 68-06 RELAY-04; 68-07 RELAY-04/02/03; 68-08 RELAY-01..04. All four ROADMAP IDs are claimed by at least one plan; REQUIREMENTS.md traceability maps exactly RELAY-01..04 to Phase 68; no orphans.

| Requirement | Source Plans | Status | Evidence |
|-------------|-------------|--------|----------|
| RELAY-01 workspace, own lockfile, one dep, Node 26.13.1 pin, extension untouched | 68-01, 68-03, 68-08 | SATISFIED | Truth 1; CI `relay` job on 26.13.1; `CI_CHECKS` includes relay; verify-release-content refuses relay files |
| RELAY-02 health check | 68-01, 68-02, 68-07, 68-08 | SATISFIED | Truth 2 (verifier/sidecar states are `not-configured` until Phases 69-75, per D-12) |
| RELAY-03 single private git-ignored state dir, restart loses nothing | 68-04, 68-05, 68-07, 68-08 | SATISFIED | Truth 3 |
| RELAY-04 shell-less image, secrets from operator source, never leaked | 68-02, 68-06, 68-07, 68-08 | SATISFIED | Truth 4 |

### Required Artifacts / Key Links

| Artifact | Status | Details |
|----------|--------|---------|
| `relay/src/main.ts` composition root | VERIFIED, WIRED | order: config, plain-secret refusal, state dir, secrets, pseudonym key, store, health + server; health reads real store count |
| `relay/src/stateDir.ts`, `store/sqliteStore.ts`, `store/schema.ts` | VERIFIED, WIRED | imported by main; `openSqliteStore(<stateDir>/relay.db)` |
| `relay/src/secrets.ts`, `log/redact.ts`, `log/logger.ts` | VERIFIED, WIRED | `loadSecrets(..., redactor)` registers values; logger is the sole sink |
| `relay/Dockerfile`, `relay/compose.yaml`, root `.dockerignore` | VERIFIED (static) | allow-list context, digest pins |
| `.github/workflows/ci.yml` `relay` job, `scripts/lib/workflow.mjs` CI_CHECKS | VERIFIED | job on 26.13.1, SHA-pinned actions, `npm ci --ignore-scripts`, audit, lint, test, test:container |
| `.vscodeignore`, `.gitignore`, `scripts/verify-release-content.mjs` | VERIFIED | relay excluded from VSIX, state/secrets ignored |

### Behavioral Spot-Checks (run in this verification)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Relay unit suite on Node 26.13.1 | `npm test` in `relay/` (capped, once) | 147 pass, 0 fail, 0 skipped | PASS |
| Live start, `/healthz`, state modes | built `dist/bin.mjs`, curl | 200 with the five fields; dir 700, files 600; clean SIGTERM stop | PASS |
| Old Node refusal | `dist/bin.mjs` on Node 24.22.2 | plain sentence, exit 1 | PASS |
| Extension isolation | `node --test dist/test/relayIsolation.test.js` (Node 24) | 8/8 pass | PASS |
| Debt markers (TBD/FIXME/XXX/TODO/HACK) in relay and ci.yml | grep | none | PASS |

Not re-run (by instruction, one heavy run at a time): the container suite (10/10 claimed), the root full suite (2055 pass claimed), `verify:release`, secret scan. Their claimed results are consistent with the code read, and the isolation test that guards the release patterns passes.

### Anti-Patterns Found

None blocking. No debt markers, no stub implementations, no stray `console` use in `relay/src`.

### Notes (not gaps)

- Tenant NEAR AI keys (`NEAR_AI_KEY_*`) are refused as plain env values and the file route is defined, but no startup code loads them yet; there are no tenants in this phase (Phase 70 registry). Consistent with CONTEXT D-10 ("secret classes named now even though later phases use them"). The Teams secret is optional until Phases 69/71.
- `log-pseudonym.key` appears in the state directory listing. It is relay-generated (D-18), not an operator secret, 0600, and its value is registered with the redactor.
- Bookkeeping to finish at phase close: REQUIREMENTS.md still shows RELAY-01..04 as unchecked, and ROADMAP shows 7/8 plans (68-08 is `checkpoint-pending`, correctly, until the owner acts).

### Human Verification Required

1. **D-19 owner action (68-08 Task 3).** Test: once the PR exists, approve the `agent-review-gates` environment, and after merge re-apply main's branch protection including the `relay` required check. Expected: relay job green and required on main. Why human: GitHub settings, owner-only.
2. **First CI run of the `relay` job.** Test: confirm the job is green on the runner, including the Docker container suite I did not re-run. Why human: needs the PR and a Docker-capable runner.

### Gaps Summary

No gaps. The phase goal is achieved in the code: a separately-locked Node 26 workspace that refuses older runtimes, a live `/healthz`, a crash-safe private state directory, file-only secret loading with a single redacting log sink, and a digest-pinned distroless image with a hardened Compose project. Status is `human_needed` solely because of the owner-only D-19 checkpoint.

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
