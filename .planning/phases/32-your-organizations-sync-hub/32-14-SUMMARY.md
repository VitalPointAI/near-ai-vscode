---
phase: 32-your-organizations-sync-hub
plan: 14
subsystem: hub
status: complete
tags: [hub, tls, secrets, workspace-boundary, node26]
requires: [32-01, 32-02, 32-03, 32-04, 32-05, 32-06, 32-07, 32-08, 32-09, 32-10, 32-11, 32-12, 32-13]
provides:
  - hub/ workspace (Node 26.13.1 guard, esbuild guard and app bundles, app metafile at dist/meta.json, no runtime dependency)
  - createHubServer({ tls, health, handler?, onSecureConnection?, onRejected? }) and listen(), TLS 1.3 only, 4 KiB header cap
  - sessionKeying(socket), SESSION_KEYING_LABEL, SESSION_KEYING_BYTES for the 32-20 session answer
  - generateKeyFile, readSigningKey, readEncryptionKey and the --generate-key command
  - HealthRegistry.setStoreProbe for 32-20
  - test helpers closure.ts (readHubSide, importsOf, hubSideClosure, closureOf, hubImportViolations), tlsFixture.ts (makeTlsFixture, tlsGet), hubProcess.ts (launchHub, startHubProcess)
affects: [32-17, 32-20, 32-27, 32-28]
tech-stack:
  added: []
  patterns: [copied relay modules with a source line, HUB_SIDE read from the extension boundary test text at run time, app bundle checked through its esbuild metafile]
key-files:
  created:
    - hub/package.json
    - hub/package-lock.json
    - hub/.npmrc
    - hub/.nvmrc
    - hub/tsconfig.json
    - hub/scripts/build.mjs
    - hub/scripts/check-node.mjs
    - hub/src/bin.ts
    - hub/src/main.ts
    - hub/src/nodeVersion.ts
    - hub/src/config.ts
    - hub/src/secrets.ts
    - hub/src/stateDir.ts
    - hub/src/startup.ts
    - hub/src/log/logger.ts
    - hub/src/log/redact.ts
    - hub/src/health.ts
    - hub/src/http/server.ts
    - hub/src/keys.ts
    - hub/test/workspace.test.ts
    - hub/test/config.test.ts
    - hub/test/secrets.test.ts
    - hub/test/stateDir.test.ts
    - hub/test/logging.test.ts
    - hub/test/health.test.ts
    - hub/test/tlsServer.test.ts
    - hub/test/keys.test.ts
    - hub/test/startup.test.ts
    - hub/test/helpers/closure.ts
    - hub/test/helpers/tlsFixture.ts
    - hub/test/helpers/hubProcess.ts
  modified:
    - .gitignore
decisions:
  - "Plain secrets (HUB_SIGNING_KEY etc.) are left to the secret loader by the config reader, so they are refused with the secret sentence (reason secrets) rather than as an unknown setting."
  - "The Redactor registers the whole secret value plus each PEM body line and the key part of a key line, so a log line carrying one line of a key or a bare seed is masked too."
  - "Startup checks the TLS pair with X509Certificate.checkPrivateKey and refuses a mismatched pair with reason tls in a plain sentence, before node:https sees it."
  - "printKeyFile lives in log/logger.ts so logger.ts stays the only stdout writer; --generate-key reads no settings and no secrets."
  - "sessionKeying wraps exportKeyingMaterial(32, 'near-ai-hub-session/v1') without a context (Node's types ask for one), so 32-20 and the tests share one call."
  - "hub.listening carries the hub writer id (public) and publicAddress; the encryption key is held for 32-20 and never logged."
metrics:
  duration: "about 1 h 10 min"
  completed: 2026-11-20
estimate:
  tokens: 90047
  tasks: 3
actuals:
  tokens: 48700
  tasks: 3
  commits: 4
plan_head_before: fc3e6f0811c89d01cc46531f64f96313b59a8943
plan_head_after: 4066441e27feaa8f9f9e7bcd2de0d596b7b3a55c
---

# Phase 32 Plan 14: Hub workspace Summary

A dependency-free `hub/` workspace beside `relay/` that starts from operator secret files, serves `/healthz` itself over TLS 1.3 only, prints its own key lines for the operator, logs only through the redacting logger, and can import nothing but node builtins, its own files and the extension's hub-side replica closure.

## What was built

- **Workspace (D-26):** `near-ai-hub` 0.1.0-dev, engines `>=26.13.1 <27`, no `dependencies` key, dev pins `@types/node` 26.6.6, esbuild 0.28.2, typescript 5.9.3 (the relay's exact versions), `allowScripts.esbuild` false. The lockfile's only non-dev package is the workspace. `scripts/build.mjs` builds `dist/bin.mjs`, `dist/app.mjs` (with `__HUB_VERSION__`) and the tests, and writes the app metafile to `dist/meta.json`. The app bundle's only externals are `node:crypto`, `node:fs`, `node:fs/promises`, `node:https`, `node:path` and `node:url`.
- **Copied relay modules (D-28):** bin, nodeVersion, check-node, build, config, secrets, stateDir, startup, logger, redact, health, http/server and main, each with a first line naming the relay file. No hub file imports from `relay/`.
- **Settings:** HUB_HOST (127.0.0.1), HUB_PORT (8443), HUB_STATE_DIR (absolute), HUB_PUBLIC_ADDRESS (empty means not set). Any other `HUB_` name stops startup; the four secret names and their `_FILE` settings belong to the secret loader.
- **Secrets (D-26, D-30, D-62):** HUB_TLS_CERT and HUB_TLS_KEY (kind `pem`, line breaks allowed, at most 64 KiB, must start `-----BEGIN `), HUB_SIGNING_KEY and HUB_ENCRYPTION_KEY (kind `line`), all required, read only from NAME_FILE, `$CREDENTIALS_DIRECTORY` or `/run/secrets`. No model credential.
- **Keys (D-30):** `near-ai-hub-signing-key:v1:<seed>` gives a PayloadSigner (fingerprintOf, writerIdOf); `near-ai-hub-encryption-key:v1:<seed>` gives the X25519 key through `x25519PrivateFromSeed` and a binding signature over `x25519BindingBytes`. `node dist/bin.mjs --generate-key signing|encryption` prints exactly one line and writes nothing.
- **Server (D-29, D-35):** `node:https`, minVersion and maxVersion TLSv1.3, maxHeaderSize 4096, the relay's timeouts and 1 s connection checks, `/healthz` in a literal table, other paths to `handler` (404 `{error, message}` without one), `onSecureConnection` hook. Health body `{version, uptimeSeconds, store}`, store `not-configured` until 32-20 sets a probe; a failing probe gives 503.
- **Boundary (D-27):** `helpers/closure.ts` reads HUB_SIDE from `src/test/replicaBoundaries.test.ts` text at run time (fails under 20 entries) and uses the same line rules as its importsOf (a test checks the regular expressions still match the extension's). The hub-side closure is all under `src/domain`, includes `team/canonical.ts`, excludes `replica/doc.ts` and reaches no editor API, Yjs, package or vendor path.
- **.gitignore:** `hub/state/`, `hub/secrets/`, `hub/**/*.db`, `hub/**/*.db-wal`, `hub/**/*.db-shm`.

## Tests

Hub suite: **110 tests, 110 pass, 0 fail** with `NEAR_AI_HUB_OLD_NODE` set to a Node 24.22.2 binary (0 skipped); without it the 3 older-Node tests skip with a printed reason. `npm run lint` (tsc) is clean. Per file: workspace 21, logging 23, secrets 15, stateDir 15, startup 10, health 9, keys 8, tlsServer 5, config 4.

### Failing-first evidence

- **Task 1:** `npm test` with only the tracer test and helpers written failed at the build (esbuild could not resolve `src/bin.ts`). After the copied modules: 1 of 1 pass.
- **Task 2:** the new tests run on the Task 1 tree: 89 tests, 86 pass, **3 fail**, the three `--generate-key` tests (the command did not exist). After adding it: 89 of 89 pass.
- **Task 2 teeth (D-66, stated mutations, run together then restored):** minVersion `TLSv1.2` in server.ts fails "a client limited to TLS 1.2 fails the handshake"; dropping `mac` from SENSITIVE_KEY_SUFFIXES fails the hub dropped-fields test; MAX_PEM_SECRET_BYTES 65537 fails the 64 KiB plus one byte test. 3 fail, 86 pass.
- **Task 3:** workspace test on the Task 2 tree: 21 tests, 19 pass, **2 fail**: the `.gitignore` test (hub paths not ignored) and the hub/test import scan (it read the planted dynamic `import('vscode')` and `require('left-pad')` strings in the teeth test as imports; the planted lines are now built from parts). After the `.gitignore` lines: 21 of 21 pass. The scanner teeth test plants vscode, yjs, a package, a bare builtin, a path into relay/, @ext files outside the closure, dynamic import, require, a side-effect import and the vendor path, and sees each reported; the metafile check is also fed a planted bundle and reports all 4 problems.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Typed wrapper for exportKeyingMaterial**
- **Found during:** Task 2 (lint)
- **Issue:** `@types/node` 26.6.6 declares the context argument of `exportKeyingMaterial` as required, so the two-argument call D-35 names did not type-check.
- **Fix:** `sessionKeying(socket)` in `hub/src/http/server.ts` makes the call without a context through one cast, and the test and 32-20 share it.
- **Commit:** 616bb6b6

**2. [Rule 1 - Bug] Literal em-dash in a test string**
- **Found during:** final scan
- **Issue:** the keys test's "no em-dash" check held the character itself.
- **Fix:** written as the `—` escape.
- **Commit:** 4066441e

**3. [Rule 2 - Correctness] Extra startup refusals**
- Startup refuses a mismatched or unreadable TLS pair (reason `tls`) and a damaged key line (reason `keys`) with plain sentences, and both are tested; the plan named the refusal sentences for settings and secrets only.

## Decisions

The owner accepted the 32-CONTEXT defaults; no checkpoint or one-way decision came up. Decisions made while building are in the frontmatter `decisions` list.

## Notes for later plans

- `.vscodeignore` does not leave `hub/` out yet, so a VSIX built now would hold hub files. D-33 gives that to 32-17 (with `.dockerignore` and `verify:release`).
- `hub/test/helpers/hubProcess.ts` starts a hub with fresh secret files and `HUB_PORT=0`; `launchHub` returns at once for refusal tests.
- The state directory test checks that no hub key line or seed is in the state folder, not that it is empty, so 32-20 can keep `hub.db` there.
- The CI job (`hub`, D-32) must set `NEAR_AI_HUB_OLD_NODE`; the workspace test fails in GitHub Actions without it.

## Known Stubs

- `hub/src/health.ts`: store reads `not-configured` until 32-20 calls `setStoreProbe`. Intentional per the plan.
- `hub/src/main.ts`: the encryption key is read and checked but not used until 32-20 (`void encryption`). Intentional.

## Threat Flags

None. No new surface beyond the plan's threat model: one TLS 1.3 port, file-only secrets, the loopback health check.

## Self-Check: PASSED

- All 31 created files and `.gitignore` present; commits 9374cc39, 616bb6b6, 3bc83fae and 4066441e are on the branch.
