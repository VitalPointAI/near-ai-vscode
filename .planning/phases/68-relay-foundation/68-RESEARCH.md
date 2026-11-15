# Phase 68: Relay foundation - Research

**Researched:** 2026-11-14
**Domain:** Standalone Node 26 service workspace (`relay/`): `node:sqlite` store, file-only secrets, redacting logger, `/healthz`, distroless container, CI and release hygiene in a repo whose root is a VS Code extension on Node 24
**Confidence:** HIGH (almost every load-bearing claim was reproduced this session in a scratch Node 26.13.1 install, a real Docker 29.1.3 build and run, and `vsce ls`; the exceptions are tagged `[ASSUMED]`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Workspace and runtime (locked in STATE.md, restated)**
- **D-01:** `relay/` has its own `package.json`, its own `package-lock.json`, its own `tsconfig.json`, and `engines: { "node": ">=26.13.1 <27" }`. Exactly one runtime dependency: `jose`. Tests use `node:test`. No HTTP framework, no SQLite package, no dotenv.
- **D-02:** An older runtime refuses to start twice over: `engine-strict=true` in `relay/.npmrc` for installs, and a startup check of `process.versions.node` that exits non-zero with a plain message. The VSIX never contains `relay/`; the extension keeps Node 24 and its zero-dependency bundle. CI gains a separate relay job on Node 26.13.1. *Undo: cheap.*
- **D-03:** Node 26.13.1 is not installed on the owner's dev host (only Node 24). Plans install it through nvm for development and tests (`nvm install 26.13.1`) and never change the default Node used by the extension's scripts. *Undo: cheap.*

**Storage (research flag 1)**
- **D-04:** The durable store is `node:sqlite` (the `Database` class, not the deprecated `DatabaseSync` alias), WAL mode, one database file in the state directory. All access goes through a small `RelayStore` interface (runs, conversation bindings, tenant registry, pending approvals, message queues) so no caller touches SQL.
- **D-05:** The named fallback, if `node:sqlite` changes before release: a JSON-file-per-tenant store behind the same `RelayStore` interface, written atomically (temp file, fsync, rename). Phase 68 does not build it. It writes the interface contract tests so a fallback can be dropped in and proven by the same suite. *Undo: costly (storage format), which is why the interface and contract tests come first.*
- **D-06:** Restart loses nothing: every queue and run-record write is committed before it is acknowledged. A kill -9 drill test (child process, killed mid-write) proves no queued message or run record is lost or duplicated.

**State directory**
- **D-07:** One state directory, set by `RELAY_STATE_DIR` (default `relay/state/` in dev, `/var/lib/near-ai-relay` in the container). It is git-ignored, created with mode 0700, and the relay refuses to start if it is group- or world-accessible or owned by another user. Files inside are 0600.

**Secrets**
- **D-08:** Secrets come only from files: `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential`), `/run/secrets/` (Docker/Podman secrets), or an explicit `<NAME>_FILE` path. A secret passed as a plain environment value is refused, because env values show up in `docker inspect` and process listings. No vault client in v0.7.0; a vault feeds the same files through its agent. *Undo: cheap.*
- **D-09:** The relay refuses a secret file that is group- or world-readable. Required secrets missing means fail fast at startup with the secret's name only, never its value. Secrets are held in memory, never written to the state directory, never logged.
- **D-10:** Secret classes named now even though later phases use them: Teams bot app secret, tenant NEAR AI API keys, Signal registration material (the sidecar's config volume, which is itself the credential).

**Logging**
- **D-11:** One logger with a redaction layer in front of every sink, from the first commit: it drops `Authorization` headers, secret values (every loaded secret is registered and masked if it ever appears), message text, and phone numbers (stable hash label). It logs metadata only: ids, lengths, verdicts, timings.

**Health check**
- **D-12:** `GET /healthz` returns JSON: `version`, `uptimeSeconds`, `teams` and `signal` component states (`not-configured`, `ok`, `down`), and `inFlightRuns`. In Phase 68 both components report `not-configured`; later phases plug real probes into the same registry. It contains no tenant names, ids or secrets, so it can be served on the main port.

**Container and where it runs**
- **D-13:** The relay runs on the owner's own Linux host with Docker Compose (Podman compatible). The final image is `gcr.io/distroless/nodejs26-debian13:nonroot`, pinned by digest: no shell, no package manager. Multi-stage build; the build stage may use a full Node 26.13.1 image.
- **D-14:** Container hardening: read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, non-root uid, the state directory as the only writable volume, secrets mounted as Compose secrets.
- **D-15:** The relay speaks plain HTTP on an internal port. TLS for the public Teams webhook ends at the owner's reverse proxy, which the runbook documents (Phase 76 finishes the runbook). *Undo: cheap.*
- **D-16:** The Signal sidecar (`bbernhard/signal-cli-rest-api`, `MODE=json-rpc`) is in the Compose file, pinned to an exact version tag plus digest, behind a Compose profile that is off by default. Phase 75 checks the bundled signal-cli age and wires it.

### Claude's Discretion
- Module layout inside `relay/src/`, the config file format, the router shape, and the exact table schema, as long as D-04's interface holds.

### Deferred Ideas (OUT OF SCOPE)
- JSON-file-per-tenant store implementation (only if `node:sqlite` shifts).
- Vault client (a vault agent writing files covers it).
- Full operator runbook (Phase 76).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RELAY-01 | Own workspace, own lockfile, exactly one runtime dependency (`jose`), Node 26.13.1, `engines` pinned so an older runtime refuses to start; extension keeps Node target and zero-dependency bundle | Standalone (not an npm workspace) package; `engine-strict` refusal verified on Node 24 (EBADENGINE); unbundled `bin.mjs` guard verified (a single bundle fails with a SyntaxError first); root hygiene list (`.vscodeignore`, `.gitignore`, `verify-release-content`, CI job) with exact lines |
| RELAY-02 | Health check reports version, uptime, Teams verifier and Signal sidecar state, in-flight runs | `node:http` `GET /healthz` with a component registry; field list fixed by D-12; container `HEALTHCHECK` through `bin.mjs --healthcheck` verified healthy in distroless |
| RELAY-03 | All state in one git-ignored directory readable only by the relay's OS user; restart loses no queued message or in-flight run record | `node:sqlite` WAL + `synchronous=FULL`, `BEGIN IMMEDIATE` transactions, 0600 file creation (verified `-wal`/`-shm` inherit mode), kill -9 child-process drill pattern (15 rounds passed), container `kill -s KILL` restart verified |
| RELAY-04 | Container without shell or package manager; every secret read at startup from an operator source and never in image, state directory listing or log line | Distroless digest pinned and verified running Node v26.13.1; file-only secret loader (tested), redactor (tested), Compose secrets caveats (uid/gid/mode ignored, host owner kept), no-shell test pattern |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

No `CLAUDE.md` exists in the repo or the worktree. The owner's global `~/.claude/CLAUDE.md` and memory apply:

- NEAR keys under `~/.near-credentials` are never deleted, overwritten or edited by any task. Relay tests must use fake secret values written to temp directories only. `[VERIFIED: /home/aaron/.claude/CLAUDE.md as injected into this session]`
- Development verification cadence: run the smallest relevant check after an edit (one test file plus `tsc --noEmit`), batch before broader suites, run the complete suites once at the phase boundary. Security, secrets, migrations and data-integrity checks are immediately blocking (all of Phase 68 is that kind of work). Never weaken a failing test to get green.
- Cap test memory (owner memory `cap-test-memory`): every test command is wrapped `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>`; one heavy run at a time. This wrapper was exercised this session with `node --test` and works on this host.
- Owner memory `organization-naming`: user-facing text says "your organization", never "NEAR organization". No em-dashes in docs (CONTEXT specifics).
- `feat/messaging-relay` is a valid branch name for `scripts/merge-pr` (`BRANCH_PATTERN` allows `feat/`). A PR that touches `.github/**`, `scripts/lib/**`, `scripts/test/**` or `scripts/verify-release-content.mjs` is a gate change and waits for the owner's approval (see Root Hygiene).

## Summary

Phase 68 builds a self-contained Node 26 service in `relay/` that does nothing but prove the foundation: it starts only on Node 26.13.1+, creates and verifies a private state directory, opens a WAL SQLite store behind a `RelayStore` interface, loads secrets only from files, logs through a redacting logger, serves `GET /healthz`, and ships as a hardened distroless container. Everything below was exercised for real on this host (scratch Node 26.13.1 via a throwaway `NVM_DIR`, `node:sqlite`, esbuild, Docker 29.1.3 multi-stage build, Compose 2.40.3, Podman 5.7.0 rootless, `vsce ls`), so the recommendations are measurements, not folklore.

Five findings change how the plan must be written. (1) `@types/node` 26.6.6 (the newest) declares only `DatabaseSync`, not `Database`, so D-04's "use `Database`" needs a three-line ambient declaration or `tsc` fails. (2) A single bundled entry cannot do the D-02 runtime check: ESM links static imports first, so on Node 24 `import { Database } from 'node:sqlite'` throws a `SyntaxError` before any guard runs; the guard must be a separate unbundled file that dynamically imports the app. (3) Without a `relay/**` line in `.vscodeignore`, `vsce` packages `relay/state/relay.db` and `relay/secrets/*` into the VSIX (reproduced). (4) Docker Compose ignores `uid`/`gid`/`mode` on file-based secrets and keeps the host file's owner and mode, so the default uid 65532 cannot read a 0400 secret owned by the operator (reproduced, EACCES); and a named volume mounted over a path that does not exist in the image is root-owned and unwritable by 65532 (reproduced), so the image must contain the state directory. (5) Podman's build produced a 0755 state directory where Docker produced 0700, so D-07's "refuse if group/world accessible" would reject a fresh Podman volume unless the relay tightens its own directory first (a decision for the owner, see Open Questions).

Phase 71's import of `src/agent/` needs no restructuring if the layout reserves `relay/src/runner/` as the only importer, uses a `@ext/*` tsconfig path to `../src/*`, and builds with esbuild (one build script, an entries table). This was verified: `tsc` type-checks `@ext/agent/loop` and esbuild bundles `loop`, `teams`, `checkpoints` into a 180 kB CJS runner that runs. Two typing frictions were measured for Phase 71 (a `Thenable` global and a `BlobPart` error under `@types/node` 26.6.6) and are recorded as handoff notes.

**Primary recommendation:** Build `relay/` as a standalone ESM package with one esbuild build script (guard `bin.mjs` unbundled, `app.mjs` bundled, tests bundled per file, `tsc --noEmit` for types), a `RelayStore` async interface with a contract-test suite and a `node:sqlite` implementation (WAL, `synchronous=FULL`, 0600 pre-created file, `BEGIN IMMEDIATE`), a file-only secret loader and redactor, then the container and CI job; make the root repo changes (`.vscodeignore`, `.gitignore`, `verify-release-content`, `ci.yml`, `CI_CHECKS`, docs) in one reviewed slice and tell the owner up front that they are gate changes.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Startup guard (Node version, strict env, state dir, secrets) | Relay process (`bin.mjs` then `main`) | Install-time `engine-strict` | Fail before opening any socket or file; two independent refusals per D-02 |
| `/healthz` | Relay HTTP server (`node:http`) | Container `HEALTHCHECK` (calls `bin.mjs --healthcheck`) | Public surface is 1 route; no framework per D-01 |
| Durable state (runs, bindings, tenants, approvals, queues) | Database / Storage (`node:sqlite` file in state dir) | `RelayStore` interface in the relay process | Callers never see SQL; fallback store must satisfy the same contract tests (D-04, D-05) |
| Secret custody | Operator-supplied files (systemd credentials, Compose secrets, `<NAME>_FILE`) | Relay memory only | Env values and image layers are leak surfaces (D-08); the relay never persists secrets (D-09) |
| Log redaction | Relay process (one logger, redactor in front of the only sink) | Test guard that forbids other output paths | Retrofitting redaction never catches everything (PITFALLS C8) |
| TLS termination | Operator's reverse proxy (host) | none | D-15; the relay binds loopback or the container-internal port only |
| Isolation of the relay from the extension | Repo/build tier (`.vscodeignore`, `.gitignore`, verify-release-content, CI job split) | Separate lockfile and tsconfig | The VSIX must never contain `relay/`; the extension toolchain must never compile it |
| Container hardening | Image (distroless, no shell) | Compose (read-only, cap_drop, no-new-privileges, tmpfs, limits) | Defense in depth: even a compromised process has no shell, no package manager, no writable rootfs |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js | 26.13.1 (LTS "Lithium", bundles SQLite 3.54.1) | Runtime | `[VERIFIED: nvm ls-remote shows v26.13.1 (Latest LTS: Lithium); distroless image run printed v26.13.1 3.54.1]` |
| `node:sqlite` `Database` | built in, Stability 1.2 release candidate | Durable store | `[CITED: nodejs.org/docs/latest-v26.x/api/sqlite.html]` "Stability: 1.2 - Release candidate"; `DatabaseSync` is a deprecated alias (DEP0210); in 26.13.1 `Database === DatabaseSync` `[VERIFIED: node -e this session]` and no warning is printed |
| `node:http`, global `fetch`, `node:test`, `node:crypto` | built in | Server, healthcheck client, tests, HMAC pseudonyms | D-01: no framework, no test framework |
| `jose` | 6.2.17 exact (see Legitimacy Audit) | The one runtime dependency (used from Phase 69) | ESM-only (`"type": "module"`), zero dependencies, no install scripts, MIT `[VERIFIED: npm view jose]` |

### Supporting (dev only)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `typescript` | 5.9.3 exact | `tsc --noEmit` type check | Same version the root lockfile resolves (`package-lock.json` node_modules/typescript 5.9.3), so root and relay agree. npm latest is 7.0.2 `[VERIFIED: npm view typescript version]`; do not adopt it in this phase |
| `@types/node` | 26.6.6 exact | Node 26 types | Newest 26.x `[VERIFIED: npm view]`. Lacks `Database` (see Pitfall 1). Root stays on ^22 |
| `esbuild` | 0.28.2 exact | Build script (guard, app, tests) | Same version as root devDependency (`package.json` devDependencies `"esbuild": "0.28.2"`). Postinstall is not needed (see Pitfall 8) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| esbuild for everything | `tsc` emit with NodeNext | Works for 68 but Phase 71 would force a second toolchain: root `src/agent/*` is CommonJS with extensionless imports and uses `__dirname`/`require` (`src/agent/graphics.ts:11,29`, `src/agent/documents.ts:30`), which a NodeNext ESM emit cannot consume without extra package.json trickery |
| esbuild for everything | Node native type stripping (`node --test src/x.test.ts`) | Zero build step for 68 tests, but Phase 71 tests that import root source fail on extensionless specifiers; one toolchain avoids a later switch |
| Bundle `jose` into `app.mjs` | Ship `node_modules` in the final image | Bundling keeps the final image to `/app/*.mjs` only; the lockfile still gets `npm audit` in CI. Recommended |
| Compose `secrets:` | bind-mount a directory at `/run/secrets` | The directory mount tolerates missing optional files, but D-14 says Compose secrets; use Compose secrets with a variable path (see Code Examples) |

**Installation (relay only, Node 26.13.1 on PATH):**
```bash
cd relay
npm install --save-exact jose@6.2.17
npm install --save-dev --save-exact typescript@5.9.3 @types/node@26.6.6 esbuild@0.28.2
npm install-scripts deny esbuild   # records "allowScripts": {"esbuild": false}; verified, see Pitfall 8
```

**Version verification (this session):** `npm view jose version` = 6.2.17 (published 2026-11-09); `@types/node` latest 26.6.6 (2026-10-28); `esbuild@0.28.2` (2026-08-08); `typescript` registry latest 7.0.2, root lock 5.9.3. `jose` has no `engines` field `[VERIFIED: npm view jose engines returned nothing]`; it is ESM-only (`"type": "module"`).

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| jose | npm | multi-year (6.2.17 published 2026-11-09) | ~230M/wk | github.com/panva/jose | SUS ("too-new": latest version 5 days old) | Flagged. `jose` [WARNING: flagged as suspicious, verify before using.] Planner adds one `checkpoint:human-verify` before the first `npm install` in `relay/`. Long-lived project already in the root lockfile as a transitive dev dependency (6.2.13). Alternative pin that clears the age signal: 6.2.15 (2026-11-01), which already contains the JWKS negative-cache and JWE decompression fixes; 6.2.16/6.2.17 are small fixes (`jwt` negative `maxTokenAge`, JWS/JWE option exposure) |
| @types/node | npm | multi-year (26.6.6 published 2026-10-28) | ~627M/wk | github.com/DefinitelyTyped/DefinitelyTyped | SUS ("too-new") | Flagged. `@types/node` [WARNING: flagged as suspicious, verify before using.] Same single human-verify checkpoint. 26.6.5 (2026-10-09) is the older pin if the owner wants age; both declare `DatabaseSync` only |
| esbuild | npm | multi-year | ~420M/wk | github.com/evanw/esbuild | OK | Approved. Has a `postinstall` (`node install.js`) which npm 11.20 skips by default; esbuild works without it `[VERIFIED: npx esbuild --version after install]` |
| typescript | npm | multi-year | ~420M/wk | github.com/microsoft/TypeScript | OK | Approved |

**Packages removed due to SLOP verdict:** none
**Packages flagged SUS:** `jose`, `@types/node` (both on "too-new" only; planner inserts one `checkpoint:human-verify` before the first install). No package has a network-reaching `postinstall` (`npm view ... scripts.postinstall`: only esbuild's `node install.js`, which is the documented binary-selection step).

The package names above come from the owner-approved milestone research (`STACK.md`, D-01) and the root lockfile, and were confirmed by `gsd-tools query package-legitimacy check`; the registry existence check alone is not treated as verification.

## Architecture Patterns

### System Architecture Diagram

```
  operator                                  host (own Linux box)
 ──────────                ┌─────────────────────────────────────────────────────────────┐
 secrets files ──────────▶ │  compose: relay (distroless, uid 65532, read-only rootfs)   │
  (0400/0600)  /run/secrets│                                                             │
 $CREDENTIALS_DIRECTORY    │  node /app/bin.mjs   (unbundled guard, NO static imports)   │
 <NAME>_FILE               │     │ 1. process.versions.node in [26.13.1, 27) else exit 1  │
                           │     ▼ 2. dynamic import('./app.mjs')                        │
                           │  app.mjs (bundled: relay code + jose)                       │
                           │     │                                                       │
                           │     ├─ config.ts      env strict: unknown RELAY_* -> exit   │
                           │     ├─ stateDir.ts    lstat/uid/mode check, 0700, umask 077 │
                           │     ├─ secrets.ts     NAME_FILE > $CREDENTIALS_DIRECTORY >  │
                           │     │                 /run/secrets; refuse plain env, bad   │
                           │     │                 mode; register values in Redactor     │
                           │     ├─ log/redact.ts  ──▶ log/logger.ts ──▶ stdout (JSONL)  │
                           │     ├─ store/         RelayStore interface                  │
                           │     │    └ sqliteStore.ts  WAL + synchronous=FULL           │
                           │     │         └──────────────▶ /var/lib/near-ai-relay      │ ◀─ named volume
                           │     │                          relay.db(-wal,-shm) 0600     │    (only writable
                           │     └─ http/server.ts GET /healthz (JSON)                   │     path; + tmpfs /tmp)
                           │             ▲   component registry: teams, signal = not-configured
                           │             │   inFlightRuns gauge = 0
                           │  signal sidecar (compose profile "signal", off by default)  │
                           └─────────────┼───────────────────────────────────────────────┘
                              127.0.0.1:8080 ──▶ operator's reverse proxy (TLS, D-15, Phase 76)
                              compose healthcheck: node /app/bin.mjs --healthcheck
```

### Recommended Project Structure

```
relay/
├── package.json            # private, "type": "module", engines, 1 dependency (jose), exact dev pins, allowScripts
├── package-lock.json       # separate lockfile (root has no "workspaces" and must not gain one)
├── .npmrc                  # engine-strict=true
├── .nvmrc                  # 26.13.1
├── tsconfig.json           # noEmit; module preserve; moduleResolution bundler; strict only; paths @ext/* -> ../src/*
├── Dockerfile              # multi-stage, build context is the repo root (see .dockerignore)
├── compose.yaml            # relay service + signal profile
├── scripts/
│   ├── build.mjs           # esbuild entries table (guard, app, tests; Phase 71 appends runner)
│   └── check-node.mjs      # same version rule for dev scripts (build, tests) on the wrong Node
├── src/
│   ├── bin.ts              # guard: version check, then dynamic import of ./app.mjs (variable specifier)
│   ├── main.ts             # composition root, becomes app.mjs: config -> state dir -> secrets -> logger -> store -> health -> server
│   ├── nodeVersion.ts      # pure checkNodeVersion(version) (unit tested; bin.ts inlines the same logic)
│   ├── config.ts           # strict RELAY_* env parsing
│   ├── stateDir.ts         # private directory creation and verification
│   ├── secrets.ts          # file-only loader
│   ├── log/redact.ts, log/logger.ts
│   ├── health.ts           # HealthRegistry (components, gauges)
│   ├── http/server.ts      # node:http server, timeouts, route table
│   ├── store/relayStore.ts # the interface and its record types (no SQL anywhere else)
│   ├── store/sqliteStore.ts, store/schema.ts   # statements and ordered migrations (PRAGMA user_version)
│   ├── types/node-sqlite-database.d.ts         # ambient `Database` (Pitfall 1)
│   └── runner/             # empty in 68; the ONLY folder that may import @ext/* (Phase 71)
├── test/
│   ├── contract/relayStore.contract.ts   # suite factory reused by any store implementation
│   ├── fixtures/crashWriter.ts           # child process for the kill -9 drill (separate esbuild entry)
│   └── *.test.ts
├── state/                  # git-ignored runtime state (dev default)
└── secrets/                # git-ignored; Compose file-secret sources for local runs
```

### Pattern 1: Guard entry plus bundled app (D-02)
**What:** `dist/bin.mjs` is transpiled only (no bundling, no static imports); it checks `process.versions.node` and then does `await import(entry)` with `entry` held in a variable so neither `tsc` nor esbuild follows it. `dist/app.mjs` is the bundle that statically imports `node:sqlite`.
**When to use:** always; the container `CMD`, `npm start`, and the Compose healthcheck all go through `bin.mjs`.
**Why:** `[VERIFIED: this session]` a single bundle on Node 24 fails with `SyntaxError: The requested module 'node:sqlite' does not provide an export named 'Database'` before any code runs; the two-file form on Node 24 printed the plain message and exited 1.

### Pattern 2: Narrow `RelayStore`, compound operations, async methods
**What:** The interface exposes named operations per aggregate and a few compound operations that must be atomic (for example accept an inbound message: enqueue plus create run record in one transaction), never a generic `transaction(fn)` and never SQL. Methods return `Promise` even though `node:sqlite` is synchronous, so a file-per-tenant fallback (async fs) can implement the same contract. `[ASSUMED: design recommendation inside the discretion D-04 grants]`
**When to use:** every later phase adds methods here, never a second access path.

### Pattern 3: Ack after COMMIT
**What:** the only acknowledgement that crosses a process boundary (HTTP response, log line "accepted") is emitted after `COMMIT` returned. The kill -9 test makes this literal: the child prints `ack N` only after commit and the parent kills it at a chosen N.
**Source:** D-06; the pattern below was run 15 rounds, all green.

### Pattern 4: Strict configuration
**What:** `RELAY_*` environment variables are parsed against a closed list; an unknown `RELAY_` name or a malformed value exits 1 with the variable name. A typo of `RELAY_STATE_DIR` must never fall back to the default directory silently. `[ASSUMED: recommendation]`

### Anti-Patterns to Avoid
- **One bundled entry with a runtime version check inside it:** the check can never run on the wrong Node (Pattern 1 evidence).
- **`import { DatabaseSync } from 'node:sqlite'` to satisfy `@types/node`:** contradicts D-04; use the ambient declaration instead.
- **Letting SQLite create the database file:** it is created with the process umask (0644 here); pre-create it 0600 and set `process.umask(0o077)` first.
- **A second logging path** (`console.log`, `process.stdout.write`, `util.inspect(error)` of objects holding headers) outside the logger: add a test that greps `relay/src` for them.
- **Adding `workspaces` to the root `package.json`:** it would merge lockfiles, violating RELAY-01.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Durable atomic storage | JSON files with ad hoc fsync | `node:sqlite` WAL (fallback only if Node changes it, D-05) | Atomic multi-row commits, recovery after kill -9 verified |
| JWT/JWKS (Phase 69) | custom JWT verification | `jose` | The only runtime dependency, exactly for this |
| Version comparison | semver parsing library | 10 lines on `process.versions.node` (tested pattern above) | One range only; no dependency permitted (D-01) |
| Health route framework | router/middleware package | `node:http` with a literal route table | 1 route now, 3-4 later (STACK.md) |
| PID 1 signal handling | tini/dumb-init in the image | explicit `SIGTERM`/`SIGINT` handlers (verified: `docker compose stop` returned in 0.23 s); `init: true` in Compose is an optional extra | Node as PID 1 gets no default signal action |
| Shell-based container healthcheck | `curl`/`wget` | `node /app/bin.mjs --healthcheck` (verified healthy in distroless) | There is no shell or curl in the image |
| Secret masking in logs | regex over every log line only | registered-value replacement plus key-based drop (tested Redactor below) | Value registration catches secrets in unexpected fields |

**Key insight:** every "extra" the ecosystem offers here (frameworks, loggers, dotenv, SQLite packages) adds supply-chain surface on an internet-facing box; D-01 already says no, and Node 26 built-ins cover each need.

## Common Pitfalls

### Pitfall 1: `Database` is not in `@types/node`
**What goes wrong:** `import { Database } from 'node:sqlite'` fails `tsc` with `TS2305: Module '"node:sqlite"' has no exported member 'Database'` `[VERIFIED: reproduced]`. `@types/node` 26.6.6 declares `class DatabaseSync` and `class StatementSync` only (`node_modules/@types/node/sqlite.d.ts:253`, `:857` in the scratch install), though the 26.13.1 runtime exports `Database` and `Statement` `[VERIFIED: Object.keys(require('node:sqlite'))]`.
**How to avoid:** add `relay/src/types/node-sqlite-database.d.ts` (Code Examples). If a later `@types/node` adds `Database`, `tsc` reports a duplicate declaration, which is the right alarm to delete the file.
**Warning signs:** a plan that says "use `DatabaseSync` because types".

### Pitfall 2: Version guard defeated by static imports
See Pattern 1. Also needs `export {}` in `bin.ts` (otherwise `TS1375` for top-level `await`) `[VERIFIED: docker build failed on it]`, and a variable specifier (`TS2307` on `import('./app.mjs')`) `[VERIFIED]`.

### Pitfall 3: `relay/` ships inside the VSIX
**What goes wrong:** `.vscodeignore` is a deny list; a new top-level folder is included by default. `vsce ls --no-dependencies` on a copy of the repo with fake `relay/package.json`, `relay/Dockerfile`, `relay/state/relay.db` and `relay/secrets/bot_secret` listed all of them; after appending `relay/**` none were listed `[VERIFIED: reproduced this session with @vscode/vsce 3.2.2]`.
**How to avoid:** append `relay/**` to `.vscodeignore`; add the matching forbidden pattern to `verify-release-content.mjs`; add a root test (precedent: `src/test/cyberFixtures.test.ts:139-141` and `src/test/responsivePanels.test.ts:83` already assert `.vscodeignore` lines).

### Pitfall 4: Compose secret ownership and the uid 65532 default
**What goes wrong:** Compose file-based secrets are bind mounts that keep the host file's owner and mode; Compose warns "secrets `uid`, `gid` and `mode` are not supported, they will be ignored" `[VERIFIED: docker compose 2.40.3]`. A 0400 file owned by uid 1000 read by uid 65532 gave `EACCES`; the same file read as `user: "1000:1000"` worked `[VERIFIED]`.
**How to avoid:** the runbook and the Compose comment give the operator two options: `sudo chown 65532:65532` the secret files and keep `0400`, or set `user: "${RELAY_UID}:${RELAY_GID}"` to the operator's uid (then the state volume is created for that uid by a bind mount the operator owns). Podman rootless: `--userns=keep-id:uid=65532,gid=65532` made a host-owned 0400 secret read as uid 65532 `[VERIFIED: podman 5.7.0]`. The secret loader must turn `EACCES` into a message that names the secret and says the file must be owned by the relay's user (never fall through silently to the next source; tested).
**Do not use** `uid`, `gid`, `mode` keys on Compose secrets.

### Pitfall 5: State volume ownership
**What goes wrong:** a named volume mounted at a path that does not exist in the image is created root-owned 0755; uid 65532 then gets `EACCES` writing it `[VERIFIED]`.
**How to avoid:** the final stage creates the directory from the build stage: `COPY --from=build --chown=65532:65532 --chmod=0700 /state-skel /var/lib/near-ai-relay`. Docker copied that mode and owner into the new volume (700, uid 65532, writable) `[VERIFIED]`. Podman 5.7.0 rootless produced mode 755 owner 65532 for the same Dockerfile and for a fresh named volume `[VERIFIED]`. Hence the Open Question about tightening.

### Pitfall 6: SQLite sidecar files and file modes
**What goes wrong:** `-wal` and `-shm` take the mode of the main database file: a database created under umask 022 gave 644/644/644; one pre-created with mode 0600 gave 600/600/600 even under umask 022 `[VERIFIED]`.
**How to avoid:** `process.umask(0o077)` first thing in `main`, and pre-create `relay.db` with `openSync(path, 'a', 0o600)` before `new Database`. Test asserts every file in the state directory is 0600 after a write and a checkpoint.

### Pitfall 7: kill -9 does not prove power-loss durability
**What goes wrong:** "Transactions are durable across application crashes regardless of the synchronous setting or journal mode" while "A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash" `[CITED: sqlite.org/pragma.html#pragma_synchronous]`. The drill therefore passes under any setting; it proves atomicity and ack-after-commit, not fsync.
**How to avoid:** set `PRAGMA synchronous = FULL` on every connection (WAL mode itself persists in the file, `synchronous` is set per connection by this design, `[ASSUMED]` for the per-connection scope: the fetched docs did not state it) and say in the test header what the drill does and does not prove. FULL adds a WAL sync per commit, acceptable at owner scale; `/tmp` here is tmpfs so local timing means nothing.

### Pitfall 8: npm 11.20 skips dependency install scripts
**What goes wrong:** with Node 26.13.1's npm 11.20.0, `npm install` ends with "esbuild@0.28.2 (postinstall: node install.js)" listed as not covered by `allowScripts`; esbuild still works `[VERIFIED]`.
**How to avoid:** run `npm install-scripts deny esbuild` once; it records `"allowScripts": {"esbuild": false}` in `relay/package.json` and the next `npm ci` is silent `[VERIFIED]`. In the Dockerfile build stage use `npm ci --ignore-scripts` anyway.

### Pitfall 9: `nvm install` side effects on the owner's shell
**What goes wrong:** `nvm install` creates the `default` alias only when none exists (`~/.nvm/nvm.sh:2199-2213`, "default already set"), and the owner's default is 24 (`~/.nvm/alias/default` contains `24`), so the default stays. But it re-resolves the computed aliases: in a scratch nvm directory after the install, `node -> stable -> 26.13`, `lts/*` -> 26.13.1 `[VERIFIED: nvm ls in scratch]`. Separately, `nvm use` repoints `~/.nvm/current` when `NVM_SYMLINK_CURRENT=true` (`nvm.sh:3971-3973`); `~/.nvm/current` currently points at `versions/node/v24.22.2` and `command -v node` in agent shells resolves through it.
**How to avoid:** install with `env -u NVM_SYMLINK_CURRENT`, never run `nvm alias default`, then assert `readlink ~/.nvm/current` and `cat ~/.nvm/alias/default` are unchanged. Never rely on `nvm use` in test commands (it is a shell function, and not available through `systemd-run`); prepend the Node 26 bin directory to PATH instead (Environment Availability).

### Pitfall 10: Phone-number redaction false positives
**What goes wrong:** a bare regex such as `\+?\d[\d\s().-]{6,18}\d` also matches dates (`2026-11-14`) and long numeric ids, hashing them. `[ASSUMED: derived by inspection of the regex]`
**How to avoid:** free text rule requires a leading `+`; known phone fields are marked by the caller with a `phone()` field type so they are always labelled. Test with a date and a 10-digit id that must not change.

### Pitfall 11: EACCES test run as root
**What goes wrong:** a test that chmods a secret 0000 and expects `EACCES` passes for a normal user and fails as root (CI containers). Guard with `process.getuid() !== 0` and `skip` otherwise.

### Pitfall 12: Compose `up` fails if a declared secret file is missing
**What goes wrong:** `docker compose config` passes with an absent file; `up` fails at mount time. Declare secret sources with `${RELAY_SECRETS_DIR:-./secrets}/<name>` `[VERIFIED: config interpolates]`; the container smoke test supplies a temp directory with fake values.

### Pitfall 13: Build context and `.dockerignore`
**What goes wrong:** the context is the repo root (Phase 71 needs `src/`), so without an allow-list the context holds `.git`, `.planning`, `relay/state`, `relay/secrets`. **How to avoid:** a root `.dockerignore` of `*` followed by `!relay/package.json`, `!relay/package-lock.json`, `!relay/.npmrc`, `!relay/tsconfig.json`, `!relay/scripts`, `!relay/src` (verified building this way); Phase 71 adds `!src/agent` etc.

## Code Examples

All snippets below were run in scratch builds this session unless marked otherwise.

### Ambient `Database` declaration
```ts
// relay/src/types/node-sqlite-database.d.ts
import 'node:sqlite';
declare module 'node:sqlite' {
  // @types/node 26.6.6 declares only the deprecated DatabaseSync alias; Node 26.13.1 exports Database (same class).
  export class Database extends DatabaseSync {}
}
```

### Guard entry
```ts
// relay/src/bin.ts   (built with bundle:false; no static imports)
export {};
const [major = 0, minor = 0, patch = 0] = process.versions.node.split('.').map(Number);
if (!(major === 26 && (minor > 13 || (minor === 13 && patch >= 1)))) {
  process.stderr.write(`near-ai-relay needs Node 26.13.1 or a later 26.x; this is Node ${process.versions.node}. Install it and start again.\n`);
  process.exit(1);
}
const entry = './app.mjs'; // a variable so neither tsc nor esbuild follows it: the app (and node:sqlite) loads only after the check
await import(entry);
```

### Build script with an entries table
```js
// relay/scripts/build.mjs   (Phase 71 appends the runner entry: format 'cjs', file dist/runner.cjs)
import { build } from 'esbuild';
const common = { platform: 'node', target: 'node26', logLevel: 'warning', sourcemap: true };
await build({ ...common, entryPoints: ['src/bin.ts'], outfile: 'dist/bin.mjs', format: 'esm', bundle: false });
await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/app.mjs', format: 'esm', bundle: true });
// tests: one bundle per file, node_modules left external (jose resolves at test time); node: builtins stay external automatically
await build({ ...common, entryPoints: ['test/*.test.ts', 'test/fixtures/*.ts'], outdir: 'dist/test', outbase: 'test', format: 'esm', bundle: true, packages: 'external' });
```
Verified: `node:sqlite` stays an external `import { Database } from "node:sqlite"`; `jose` bundled into a 21 kB output.

### relay/tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2023", "lib": ["ES2023"],
    "module": "preserve", "moduleResolution": "bundler",
    "types": ["node"], "strict": true, "noEmit": true,
    "skipLibCheck": true, "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "paths": { "@ext/*": ["../src/*"] }
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```
Do not add `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` or other flags stricter than the root's `strict: true`: in Phase 71, `tsc` follows `@ext/*` imports into root files and would check them under relay's flags (root `tsconfig.json` lines 3-13 are `strict` only).

### Store open and the commit pattern
```ts
import { closeSync, openSync } from 'node:fs';
import { Database } from 'node:sqlite';

export function openStore(file: string): Database {
  closeSync(openSync(file, 'a', 0o600));                  // so relay.db, -wal and -shm are all 0600
  const db = new Database(file, { timeout: 5000 });       // busy timeout default is 0
  db.exec('PRAGMA journal_mode = WAL');                   // persistent in the file
  db.exec('PRAGMA synchronous = FULL');                   // per connection: set on every open
  db.exec('PRAGMA foreign_keys = ON');                    // (constructor option default is already true)
  return db;
}
export function enqueueWithRun(db: Database, n: number): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const q = db.prepare('INSERT INTO queue (dedupe, body) VALUES (?, ?)').run(`msg-${n}`, `body ${n}`);
    db.prepare('INSERT INTO runs (queue_id, state) VALUES (?, ?)').run(q.lastInsertRowid, 'queued');
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
```
`node:sqlite` API facts `[CITED: nodejs.org/docs/latest-v26.x/api/sqlite.html]`: constructor options `open`, `readOnly`, `enableForeignKeyConstraints` (default true), `timeout` (default 0), `defensive` (default true), `allowExtension` (default false); `database.exec`, `prepare`, `close`, `isOpen`, `isTransaction`; statements `run()` returns `{changes, lastInsertRowid}`, `get()` returns the first row or `undefined`, `all()` an array, `iterate()` an iterator. There is no transaction helper: use `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. Prepare statements once in the store constructor and reuse them. Integers outside the safe range throw `ERR_OUT_OF_RANGE` unless `readBigInts` is set: keep timestamps as epoch milliseconds (safe).

### kill -9 drill (parent test and child writer)
Child (`test/fixtures/crashWriter.ts`, its own esbuild entry): opens the store, loops `enqueueWithRun`, and writes `ack N\n` to stdout only after the call returned. Parent:
```ts
const child = spawn(process.execPath, [new URL('./fixtures/crashWriter.js', import.meta.url).pathname, file], { stdio: ['ignore', 'pipe', 'inherit'] });
// read stdout, track the last "ack N"; when acked >= killAt: child.kill('SIGKILL'); resolve on exit with signal SIGKILL
const db = openStore(file);                                    // reopen = WAL recovery
// assert: rows >= acked and rows <= acked + 1 (only the in-flight transaction may be extra);
//         distinct dedupe keys == rows (no duplicates); runs rows == queue rows (atomic pair);
//         every msg-1..msg-acked present; PRAGMA integrity_check = 'ok'
```
Run 15 rounds with different kill points (5, 12, 19, ...): 15/15 passed in 0.5 s under the memory-cap wrapper. Assert on the real store module, not on source shape.

### Secret loader (tested, 6 cases)
Behaviour fixed by the test: order `NAME_FILE`, `$CREDENTIALS_DIRECTORY/<name>`, `/run/secrets/<name>`; plain env `NAME` set and non-empty is refused (message names `NAME`, never the value); the file is opened once and checked with `fstat` on the same descriptor (regular file, `(mode & 0o077) === 0`, size 1..16384, one trailing newline stripped, no embedded line breaks); `ENOENT` falls through to the next source, any other open error (including `EACCES`) stops startup with the secret's name. No owner check on secret files: a file with no group/other bits that the process can read is owned by it or readable through a capability the container drops; systemd documents credential access as "restricted to the service's user" `[CITED: systemd.io/CREDENTIALS]` but not the exact mode, so no mode is assumed beyond "no group/other bits".
```ts
const st = fstatSync(fd);                                   // same descriptor we read from: no check/read race
if (!st.isFile()) throw new SecretError(`secret ${name}: not a regular file`);
if ((st.mode & 0o077) !== 0) throw new SecretError(`secret ${name}: file is readable or writable by group or others; run chmod 600 (or 400) on it`);
```

### Redactor (tested)
`Redactor.register(name, value)` stores secrets of length >= 8; `string()` replaces every registered value with `[secret:<name>]`, replaces phone-looking text with `phone:<8 hex of HMAC-SHA256>` and truncates to 500 chars; `fields()` drops `authorization`, `cookie`, `x-api-key`, `text`, `message`, `body`, `content`, `prompt`, `password`, `secret`, `token` (key compared lowercase, punctuation stripped), keeping only `<key>Length`. The logger accepts only flat `string | number | boolean | null` fields so nested objects (an activity, a headers map) cannot be logged at all. The pseudonym key must be stable across restarts (D-11 "stable hash label"): see Open Question 2.

### Dockerfile (built and run, 2 stages)
```dockerfile
FROM docker.io/library/node:26.13.1-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
WORKDIR /build/relay
COPY relay/package.json relay/package-lock.json relay/.npmrc ./
RUN npm ci --ignore-scripts
COPY relay/tsconfig.json ./
COPY relay/scripts ./scripts
COPY relay/src ./src
RUN npx tsc -p tsconfig.json && node scripts/build.mjs
RUN mkdir -m 0700 /state-skel

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531
COPY --from=build --chown=0:0 --chmod=0555 /build/relay/dist/ /app/
COPY --from=build --chown=65532:65532 --chmod=0700 /state-skel /var/lib/near-ai-relay
ENV RELAY_STATE_DIR=/var/lib/near-ai-relay
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node"]
CMD ["/app/bin.mjs"]
```
Notes: the tests directory is built into `dist/test` by the same script, so the Docker build should call a build target that skips tests (for example `node scripts/build.mjs --app-only`). Digests recorded 2026-11-14: distroless index digest above `[VERIFIED: docker buildx imagetools inspect; the pulled image ran Node v26.13.1, SQLite 3.54.1, uid 65532, Entrypoint ["/nodejs/bin/node"], WorkingDir /home/nonroot]`; `node:26.13.1-slim` index digest above (identical for `26.13.1-trixie-slim`). To re-pin: `docker buildx imagetools inspect gcr.io/distroless/nodejs26-debian13:nonroot` (reads the registry, pulls nothing) and confirm `docker run --rm <image>@<digest> -p process.version` prints a version >= 26.13.1 before committing the digest, because the relay refuses older runtimes.

### Compose (hardening verified; relay service and signal profile)
```yaml
name: near-ai-relay
services:
  relay:
    build: { context: .., dockerfile: relay/Dockerfile }
    image: near-ai-relay:local
    user: "65532:65532"                  # or the operator's uid; see Pitfall 4
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    restart: unless-stopped
    pids_limit: 128
    mem_limit: 512m
    ports: ["127.0.0.1:8080:8080"]       # loopback only; the reverse proxy is on the host (D-15)
    environment:
      RELAY_HOST: 0.0.0.0                # container-internal; the published port stays on loopback
      RELAY_PORT: "8080"
      RELAY_STATE_DIR: /var/lib/near-ai-relay
      TEAMS_APP_SECRET_FILE: /run/secrets/teams_app_secret
    volumes: ["relay-state:/var/lib/near-ai-relay"]
    tmpfs: ["/tmp:size=16m,uid=65532,gid=65532,mode=0700"]
    secrets: [teams_app_secret]
    healthcheck:
      test: ["CMD", "/nodejs/bin/node", "/app/bin.mjs", "--healthcheck"]
      interval: 15s
      timeout: 3s
      retries: 3
      start_period: 5s
  signal:
    profiles: ["signal"]                 # off by default (D-16); `docker compose --profile signal up`
    image: docker.io/bbernhard/signal-cli-rest-api:0.101@sha256:2cf09d66a86fdd210e42ee91662216364acc27da1163a8c44167a77ea3a6559a
    environment: { MODE: json-rpc, JSON_RPC_RECEIVE_MODE: manual, JSON_RPC_IGNORE_ATTACHMENTS: "true" }
    volumes: ["signal-config:/home/.local/share/signal-cli"]   # the registration is this volume: treat it as the credential
    # no published ports: reachable only from the relay on the compose network
secrets:
  teams_app_secret:
    file: ${RELAY_SECRETS_DIR:-./secrets}/teams_app_secret
volumes:
  relay-state:
  signal-config:
```
Verified: with this shape `docker compose config --services` lists only `relay`, and `--profile signal` adds `signal`; a built distroless image under `read_only`, `cap_drop: [ALL]`, `no-new-privileges` ran with `CapEff 0`, `NoNewPrivs 1`, root writes `EROFS`, state volume writable and 0600 files; `docker compose kill -s KILL` then `up -d` kept the SQLite rows; healthcheck reported `healthy`; `docker compose exec relay ls` failed with "executable file not found". The sidecar block was not started here; its read-only/cap-drop hardening is a Phase 75 task (the image runs an s6 supervisor), and the Phase 75 plan re-pins the tag.

### No-shell test (RELAY-04)
```bash
docker run --rm --entrypoint sh near-ai-relay:test -c 'echo hi'
# -> exit 127 (docker run), stderr: exec: "sh": executable file not found in $PATH   [VERIFIED on the distroless base]
id=$(docker create near-ai-relay:test); docker export "$id" | tar -t | grep -E '(^|/)(sh|bash|dash|busybox|npm|npx|apt|apt-get|dpkg|curl|wget)$'   # must print nothing
docker image inspect near-ai-relay:test --format '{{.Config.User}} {{json .Config.Env}}'   # 65532:65532, no *_SECRET/*_TOKEN/*_KEY
```
A second assertion walks `docker history --no-trunc` and the exported file list for the fake secret values the test planted in `relay/secrets` of the build context (they must be absent: `.dockerignore` keeps the folder out).

### CI job (add to `.github/workflows/ci.yml`, same pinned action SHAs as the other jobs)
```yaml
  relay:
    name: relay
    runs-on: ubuntu-latest
    timeout-minutes: 15
    defaults:
      run:
        working-directory: relay
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: '26.13.1'
          cache: npm
          cache-dependency-path: relay/package-lock.json
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=high
      - run: npm run lint
      - run: npm test
      - run: npm run test:container
```
`actions/node-versions` lists 26.13.1 for linux x64 `[VERIFIED: versions-manifest.json]`; the SHA pins are copied from `ci.yml:33-39`. The existing top-level `env: NODE_VERSION: '24'` (`ci.yml:24-25`) stays untouched; the relay job names its own version so `scripts/test/workflow-files.test.mjs` (which only checks the concurrency block of `ci.yml`) keeps passing.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `DatabaseSync` / `StatementSync` | `Database` / `Statement`, old names deprecated aliases (DEP0210/DEP0211) | Node 26 docs | Runtime has both names today; types lag |
| `--experimental-sqlite` | no flag; Stability 1.2 release candidate | v25.7.0 | No `ExperimentalWarning` printed in 26.13.1 `[VERIFIED]` |
| npm runs dependency install scripts | npm 11.20 blocks them unless `allowScripts` | npm 11.x | Record decisions in `package.json` |
| Compose secrets with `uid/gid/mode` | not supported outside Swarm; ignored | Compose 2.x | Fix ownership on the host |
| `distroless/nodejs22/24` | `nodejs26-debian13` exists | 2026 | Pin by digest and verify Node >= 26.13.1 at pin time |

**Deprecated/outdated:** `better-sqlite3`, `dotenv`, `ws`, Bot Framework SDK (STACK.md "What NOT to Use"); nothing in this phase uses them.

## Root Hygiene: Exact Changes to the Extension Repo

All lines were read this session.

| File | Current state | Change | Evidence |
|------|--------------|--------|----------|
| `tsconfig.json` (root) | `"rootDir": "src"`, `"include": ["src/**/*.ts"]` (lines 6, 14) | None. `npm run lint` is `tsc -p tsconfig.json --noEmit` (`package.json:837`), so it never sees `relay/` | `[VERIFIED: tsconfig.json:6,14; package.json:837]` |
| ESLint | none exists in the repo | None. Static check is the TypeScript compiler | `[VERIFIED: ls eslint* .eslint* found nothing; .planning/codebase/CONVENTIONS.md "No ESLint configuration is present"]` |
| `package.json` (root) | no `workspaces`, no `dependencies` | None. Do not add `workspaces` | `[VERIFIED: node -e on package.json]` |
| `.vscodeignore` | 31 lines; `src/**`, `test/**`, `scripts/**` listed; no `relay` | Append `relay/**` (one line, for example under the workflow-files comment block at line 28) | `[VERIFIED: .vscodeignore:6-8,28-31; vsce ls reproduction]` |
| `scripts/verify-release-content.mjs` | `forbiddenPatterns` array lines 135-146 | Add `/^extension\/relay(?:\/|$)/,` before line 146 | `[VERIFIED: lines 135-146 quoted: "/^extension\/(?:src|test|scripts|node_modules)(?:\/|$)/,"]`. This file is a gate path |
| `.gitignore` | has `node_modules/`, `dist/`, `.env`, `.env.*` unanchored (lines 1-5), so `relay/node_modules`, `relay/dist` and `relay/.env*` are already ignored | Add `relay/state/` and `relay/secrets/` (and `*.db`, `*.db-wal`, `*.db-shm` under `relay/`) | `[VERIFIED: .gitignore:1-5]` |
| `.dockerignore` (new, repo root) | none | Allow-list as in Pitfall 13 | verified build |
| `scripts/run-tests.mjs` | `spawn(process.execPath, ['--test', ...process.argv.slice(2)], ...)` with per-run TMPDIR cleanup (line 17) | None. Root `npm test` globs `dist/test/*.test.js scripts/test/*.test.mjs` (`package.json:838`), which cannot match `relay/dist/test/`. Reuse it from relay: `node ../scripts/run-tests.mjs dist/test/*.test.js` (it runs whatever Node executes it) | `[VERIFIED: run-tests.mjs:17; package.json:838]` |
| `npm run verify:release` | `npm run package && node scripts/verify-release-content.mjs` (`package.json:846`) | None beyond the forbidden pattern. It is the proof that the VSIX has no `relay/`; run once at the phase gate (needs root `npm ci` on Node 24 and `unzip`, present) | `[VERIFIED]` |
| `scripts/secret-scan.mjs` | scans every tracked file, so `relay/` is covered automatically; file-name rules cover `.env*`, `id_*`, `*.p12|pfx|keystore` only (`workflow.mjs:610-615`) | None. Test fixtures with fake secrets must not look like real tokens; if a fixture must, add its path to `.github/secret-scan-allow.txt` or use the `secret-scan: allow` marker. Track no real file under `relay/secrets/` | `[VERIFIED: workflow.mjs:595-616]` |
| `.github/workflows/ci.yml` | six jobs; header says do not rename them without updating branch protection, `CI_CHECKS` and `docs/development-workflow.md` (lines 1-4) | Add the `relay` job (Code Examples) and update the header comment | `[VERIFIED: ci.yml:1-4,24-25,33-39]` |
| `scripts/lib/workflow.mjs:5` | `export const CI_CHECKS = Object.freeze(['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan']);` | Recommended: add `'relay'`. Merge/tag gates read this list; `scripts/test/fake-github.mjs` and `merge.test.mjs` derive from `CI_CHECKS`, so tests follow automatically | `[VERIFIED: workflow.mjs:5; fake-github.mjs:18]` |
| `docs/development-workflow.md`, `CONTRIBUTING.md:67` | "seven check names" (line 68; the table lists six CI jobs plus `agent-review`), "six jobs" (lines 76, 344), branch-protection JSON (lines ~557-562) | Update counts and add the `relay` row and the `{"context": "relay", "app_id": 15368}` entry | `[VERIFIED: grep]` |

**Gate consequence (important for the plan and the owner):** `GATE_PATHS` (`scripts/lib/workflow.mjs:573-584`) contains `/^\.github\//`, `/^scripts\/lib\//`, `/^scripts\/test\//` and `verify-release-content`. Any PR that edits `ci.yml`, `workflow.mjs`, `verify-release-content.mjs` or `scripts/test/**` is a gate change: `merge-pr` points it out and the automatic review approves only after the owner approves the `agent-review-gates` environment. Branch protection itself is applied only by the owner ("agents never change it", `docs/development-workflow.md` section 8); making `relay` required means the owner re-runs the `gh api -X PUT .../branches/main/protection` block with one more context. Plan a `checkpoint:human-action` for that, and keep the two non-gate checks (a root test `src/test/relayIsolation.test.ts` asserting `relay/**` in `.vscodeignore`, and relay-side hygiene tests) in the same PR so the isolation is protected even before the owner applies the setting.

## Phase 71 Handoff: How `src/agent/` Will Be Imported Without Restructuring

Recommendation (verified end to end in a scratch tree that copied the real `src/`):

1. **Layout:** keep `relay/src/runner/` empty in 68; it is the only folder allowed to import `@ext/*`. Add a test that greps `relay/src` for `@ext/` and `../../src/` outside `runner/` and fails. `[ARCHITECTURE.md: "runner/ isolated: the only folder that imports src/agent/*"]`
2. **Alias:** `relay/tsconfig.json` `paths: { "@ext/*": ["../src/*"] }`. esbuild reads it from `tsconfig.json` automatically.
3. **Build:** the runner is a separate esbuild entry with `format: 'cjs'`, `outfile: 'dist/runner.cjs'`. It runs in its own child process (ARCHITECTURE: runner child per run), so its module format is independent of the ESM relay. A CJS bundle of `@ext/agent/loop`, `@ext/agent/teams`, `@ext/agent/checkpoints` built to 180 kB and ran (`function function function`); the same entry as ESM also bundled. CJS is the safer default because root sources use `__dirname` and `require` (`src/agent/graphics.ts:11` `export const VENDOR_DIR = path.join(__dirname, '..', '..', 'vendor');`, `:29` `return require(path.join(VENDOR_DIR, file)) as T;`, `src/agent/documents.ts:30`). In any bundle `__dirname` is the bundle's folder, so `VENDOR_DIR` points two levels above the bundle: the runner either avoids the graphics/document tools or the image places `vendor/` accordingly (a Phase 71 decision).
4. **Type-check friction measured under `@types/node` 26.6.6 (not under 22.20.5 or 24.19.2):** `src/services/nearAiClient.ts(459,35) TS2322: Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'BlobPart'` (source line 459: `form.append('file', new Blob([audio], { type: mimeType }), fileName);`), and under all three versions `src/services/reportingToken.ts(103,187) TS2304: Cannot find name 'Thenable'` (a vscode global). Options for Phase 71 without touching the extension: a one-line `type Thenable<T> = PromiseLike<T>;` ambient file in `relay/src/types/`, and either pin relay `@types/node` to `^24` (identical behaviour to root, verified clean) or give the runner its own tsconfig. Do not resolve this in 68; just do not create a layout that blocks it (a second `tsconfig.runner.json` can be added without moving files).
5. **Dockerfile context** is already the repo root, so Phase 71 only adds `!src/agent` (and what it imports) to `.dockerignore` and a `COPY src ./src` line.

## Runtime State Inventory

Not a rename/refactor/migration phase. Omitted deliberately; the only existing-state touch points are nvm aliases and `~/.nvm/current` (Pitfall 9).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 26.13.1 | everything in `relay/` | Not in `~/.nvm` (only v24.22.1, v24.22.2); installable | nvm lists v26.13.1 (Latest LTS); scratch install verified (npm 11.20.0) | Install via nvm (Task 0) |
| nvm | Node 26 install | yes (`~/.nvm/nvm.sh`, default alias 24) | n/a | Absolute-path tarball from nodejs.org |
| Docker | image build, container tests | yes | 29.1.3, rootful daemon, cgroup v2 | Podman |
| Docker Compose | compose tests | yes | 2.40.3 | n/a |
| Podman | optional parity check | yes, rootless | 5.7.0 (`podman compose` delegates to the docker-compose plugin, so Podman was verified at build/run level only, not through Compose) | skip |
| systemd-run, choom, timeout | the memory-cap wrapper | yes | systemd 259 | none (required by owner rule) |
| unzip, rsync, gh, git | `verify:release`, tooling | yes | present | none |
| Registry access | digest pinning, pulls | yes (gcr.io, docker.io, Docker Hub API, GitHub API) | n/a | none |

**Dev install (D-03) and how to run commands with Node 26 without changing the default:**
```bash
source ~/.nvm/nvm.sh
env -u NVM_SYMLINK_CURRENT nvm install 26.13.1       # does NOT change `default` (stays 24)
readlink ~/.nvm/current; cat ~/.nvm/alias/default    # must still read versions/node/v24.22.2 and 24
echo 26.13.1 > relay/.nvmrc
```
Every relay command in plans, tests and UAT then uses an absolute PATH prefix, never `nvm use` (it is a shell function and does not exist under `systemd-run`):
```bash
N26="$HOME/.nvm/versions/node/v26.13.1/bin"
systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- \
  timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 PATH="$N26:$PATH" npm test --prefix relay
```
This exact shape was run this session (scratch install path instead of `$N26`) and worked. `nvm exec 26.13.1 <cmd>` also works interactively (verified in the scratch `NVM_DIR`) but only where `nvm.sh` is sourced. Docker builds and `docker compose` are not capped by this wrapper (the cap applies to the CLI); they get `mem_limit` in Compose and run one at a time.

**Missing dependencies with no fallback:** none.
**Missing with fallback:** Node 26.13.1 (install step).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `node:test` + `node:assert/strict` on Node 26.13.1 (same runner family as the root repo) |
| Config file | none; `relay/scripts/build.mjs` bundles `test/**/*.test.ts` to `relay/dist/test/` |
| Quick run command | `N26=...; <cap wrapper> env PATH="$N26:$PATH" sh -c 'cd relay && npm run lint && node scripts/build.mjs && node --test dist/test/<file>.test.js'` |
| Full suite command | `<cap wrapper> env PATH="$N26:$PATH" npm test --prefix relay` (`test` = `node scripts/check-node.mjs && node scripts/build.mjs && node ../scripts/run-tests.mjs dist/test/*.test.js`) |
| Container suite | `npm run test:container` (needs Docker; builds the image, runs the shell/permission/secret/restart checks); not part of the default `npm test` locally, but run by the CI job and at the phase gate |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RELAY-01 | `relay/package.json` engines is exactly `>=26.13.1 <27`; `dependencies` keys are exactly `['jose']`; no optional/peer deps; `.npmrc` has `engine-strict=true`; lock has exactly one non-dev package (`node_modules/jose`) | unit | `node --test dist/test/workspace.test.js` | Wave 0 |
| RELAY-01 | `checkNodeVersion`: 24.22.2 refused; 26.13.0 refused; 26.13.1, 26.14.0 accepted; 27.0.0 refused; `bin.mjs` run under `RELAY_TEST_OLD_NODE` exits 1 with the plain message (skipped when unset) | unit + optional integration | `node --test dist/test/nodeGuard.test.js` | Wave 0 |
| RELAY-01 | Extension isolation: `.vscodeignore` contains `relay/**`; root `package.json` has no `workspaces`/`dependencies`; root lockfile unchanged by relay; `ci.yml` has a `relay` job using `26.13.1` with a SHA-pinned `setup-node` | unit (root, Node 24) | `npm test` root, file `src/test/relayIsolation.test.ts` | Wave 0 |
| RELAY-01 | VSIX contains no `relay/` entry | build check, phase gate only | `npm run verify:release` (root, Node 24) | exists, needs the forbidden pattern |
| RELAY-02 | `/healthz` JSON has exactly `version`, `uptimeSeconds`, `teams`, `signal`, `inFlightRuns`; `teams`/`signal` are `not-configured`; `inFlightRuns` is 0; probe plug-in turns a component `ok`/`down`; no tenant names, ids or secrets in the body; non-GET gets 405, unknown path 404 without echo | unit/integration (server on port 0) | `node --test dist/test/health.test.js` | Wave 0 |
| RELAY-02 | Spawned `dist/bin.mjs` serves `/healthz` and `--healthcheck` exits 0; SIGTERM exits 0 promptly | integration (child process, temp state dir) | `node --test dist/test/startup.test.js` | Wave 0 |
| RELAY-03 | `RelayStore` contract suite (every aggregate round-trips; idempotent enqueue by dedupe key; FIFO per conversation; claim/ack and redelivery of unacked after reopen; compare-and-set run transitions; compound accept is atomic) run against `sqliteStore` on a temp file | contract | `node --test dist/test/sqliteStore.test.js` | Wave 0 |
| RELAY-03 | kill -9 drill (15 rounds): acked implies present, no duplicates, atomic pair, `integrity_check` ok | integration (child process) | `node --test dist/test/killDrill.test.js` | Wave 0 |
| RELAY-03 | State dir: created 0700; refuses wrong owner (use a root-owned dir such as `/usr`), refuses group/world bits (or tightens per Open Question 1), refuses symlink; all files 0600 after write and checkpoint; `relay.db` created 0600 under umask 022 | unit | `node --test dist/test/stateDir.test.js` | Wave 0 |
| RELAY-03 | Schema: `PRAGMA user_version` migrations apply once; a database newer than the code refuses to open; `instance_id` row identical across kill/restart | unit | `node --test dist/test/schema.test.js` | Wave 0 |
| RELAY-04 | Secret loader (6 cases above plus precedence and `$CREDENTIALS_DIRECTORY`); required-missing exits with the name only | unit | `node --test dist/test/secrets.test.js` | Wave 0 |
| RELAY-04 | Redactor and logger (key drop, value masking, phone label stable and not applied to dates, flat fields only); source guard: no `console.`/`process.stdout.write` in `relay/src` outside the logger | unit | `node --test dist/test/logging.test.js` | Wave 0 |
| RELAY-04 | No-leak run: start `bin.mjs` with fake secrets through `NAME_FILE`; after startup, healthz calls and shutdown the fake values appear in none of: captured stdout/stderr, any file under the state directory, the directory listing names; a plain-env secret makes it exit non-zero with the name and without the value | integration | `node --test dist/test/noLeak.test.js` | Wave 0 |
| RELAY-04 | Container: Dockerfile `FROM` lines are digest-pinned and the final stage is `gcr.io/distroless/nodejs26-debian13:nonroot@sha256:...`; `docker run --entrypoint sh` fails; export has none of sh/bash/busybox/npm/apt/dpkg/curl/wget; `Config.User` is 65532; image env and history contain no fake secret; hardened run is healthy, writes outside the volume fail, volume files 0600; `kill -s KILL` then restart keeps the instance id; `docker compose config --format json` shows `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, `127.0.0.1` publish, signal service only under profile `signal` with `:<tag>@sha256:` | container | `npm run test:container` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run lint` plus the one test file of the changed module (under the cap wrapper).
- **Per wave merge:** full relay `npm test` (no container tests unless the Dockerfile/Compose/secrets changed in that wave).
- **Phase gate (once):** relay `npm test`, `npm run test:container`, root `npm run lint`, root `npm test`, root `npm run verify:release`, `node scripts/secret-scan.mjs`, then `/gsd-verify-work`. Security, secrets, data-integrity and boundary checks (secrets, redaction, state dir, kill drill, isolation) are immediately blocking inside waves, per the owner's cadence rule.

### Wave 0 Gaps
- [ ] The whole `relay/` workspace (package.json, lockfile, tsconfig, build and check-node scripts, `.npmrc`, `.nvmrc`)
- [ ] `relay/test/contract/relayStore.contract.ts` and the `sqliteStore` test that runs it
- [ ] `relay/test/fixtures/crashWriter.ts` (separate esbuild entry)
- [ ] Root: `src/test/relayIsolation.test.ts`, `.vscodeignore` line, `verify-release-content` pattern, `.gitignore`, `.dockerignore`
- [ ] Framework install: Node 26.13.1 via nvm, then `npm ci` in `relay/`; root `npm ci` on Node 24 (the worktree has no `node_modules`) for the root checks

## Security Domain

`security_enforcement` is not set to false in `.planning/config.json`, so this section applies.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (no inbound auth until Phase 69) | n/a; `/healthz` carries no identity or data |
| V4 Access Control | yes | OS-level: state dir 0700 and owned by the relay uid, files 0600, secret files refused if group/world accessible, non-root uid 65532 |
| V5 Input Validation | yes | Strict `RELAY_*` env parser (unknown names and bad values exit); closed route table; method allow-list; request/headers timeouts on `node:http` |
| V6 Cryptography | yes | `node:crypto` HMAC-SHA256 for the pseudonym label; no custom crypto; `jose` is declared but first used in Phase 69 |
| V7 Error Handling and Logging | yes | One redacting logger, flat metadata fields, no message text, no secret values, no phone numbers |
| V8 Data Protection | yes | Secrets only in memory; never in image layers, env, state dir or logs |
| V14 Configuration | yes | Digest-pinned base images, read-only rootfs, `cap_drop: [ALL]`, `no-new-privileges`, no shell, loopback publish, pinned sidecar tag plus digest |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Secret in environment visible in `docker inspect` or `/proc/<pid>/environ` | Information disclosure | Refuse plain env values; file-only sources (D-08); tested |
| Secret file readable by other local users | Information disclosure | `fstat` mode check refuses any group/other bit; Compose owner fix (Pitfall 4) |
| Secret value echoed by an error, log field or crash message | Information disclosure | Errors name the secret only; registered-value masking in the redactor; no-leak integration test |
| State directory or database readable by another user | Information disclosure | 0700 dir, owner check, 0600 files, umask 077, pre-created 0600 database |
| Wrong runtime (older Node with unpatched http2/TLS CVEs) started anyway | Elevation of privilege | `engine-strict` plus guard entry (STACK.md: 26.13.1 fixes 16 CVEs, 9 High in http2/TLS) |
| Image compromise gives an attacker a shell or package manager | Elevation of privilege | Distroless (verified no sh/npm/apt/dpkg), non-root, read-only rootfs, no capabilities |
| Supply-chain swap of base image tag | Tampering | Digest pins in Dockerfile and Compose; re-pin procedure with version check |
| `relay/state` or `relay/secrets` committed or packaged | Information disclosure | `.gitignore`, `.vscodeignore relay/**`, `verify-release-content` pattern, secret-scan, `.dockerignore` allow-list |
| Log injection or message text in logs | Repudiation / disclosure | Flat typed fields only, truncation, text/body keys dropped |
| Two relays on one state directory | Tampering | See Open Question 4 |
| Health endpoint information leak | Information disclosure | Fixed five-field body; no tenant ids or names (D-12) |

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `PRAGMA synchronous` must be set on every connection (per-connection scope); the SQLite page excerpt fetched did not state the scope | Pitfall 7, store example | Low: setting it on every open is harmless either way |
| A2 | Async `RelayStore` methods plus named compound operations (instead of a transaction callback) is the right interface shape for a later file-based fallback | Pattern 2 | Medium: a sync interface would be simpler now but harder to back with async fs; owner already left shape to discretion |
| A3 | Strict unknown-`RELAY_*` env rejection is acceptable operationally | Pattern 4 | Low: an operator typo fails fast instead of silently using a default |
| A4 | Phone regex false positives on dates and long ids as described | Pitfall 10 | Low: caught by the proposed test |
| A5 | Persisting a random HMAC pseudonym key in the state directory (or taking it from a secret file) is acceptable for "stable hash label" | Open Question 2 | Medium: it is a second kind of persisted sensitive-ish value; an ephemeral key makes labels unstable across restarts |
| A6 | `bbernhard/signal-cli-rest-api` tag `0.101` bundles signal-cli 0.14.8 (from the GitHub release note "updated signal-cli to v0.14.8"); image contents were not pulled or inspected | Compose | Medium: affects the 3-month freshness window only; Phase 75 re-verifies |
| A7 | systemd credential files for a non-root service are owned by that user (the docs fetched say only "restricted to the service's user") | Secret loader | Low: the loader does not check the owner, only that no group/other bits are set |
| A8 | Relay package version string and where it is read from (bundled `package.json` import or an esbuild define) | `/healthz` version | Low |

## Open Questions

1. **Refuse or tighten a too-open state directory? (touches D-07)**
   - What we know: D-07 says refuse if group/world-accessible or owned by another user. Docker honored `--chmod=0700` on the image directory; Podman 5.7.0 rootless produced 0755 for the same Dockerfile and for a fresh named volume (verified). Under strict refusal a Podman user cannot start the relay on a fresh volume and there is no shell to `chmod` with.
   - What's unclear: whether the owner accepts a small softening.
   - Recommendation: refuse if owned by another user, a symlink, or not a directory; if owned by the relay's uid and too open, `chmod 0700` it, re-check, log one metadata line, and continue. This only ever reduces access and keeps the intent of D-07. If the owner wants the literal rule, keep strict refusal and document `podman unshare chmod 0700` in the runbook.

2. **Where does the stable pseudonym key live (D-11 "stable hash label")?**
   - Recommendation: an optional secret `log_pseudonym_key` from the normal secret sources; if absent the relay generates a random 32-byte key once and stores it 0600 in the state directory (`relay_meta`) so labels stay stable across restarts. It is not a D-10 credential class and is useless without the logs, but the owner should know a non-secret-file value is persisted. Confirm.

3. **Make `relay` a required CI check and update branch protection?**
   - Recommendation: yes. Add `'relay'` to `CI_CHECKS`, update the two docs, and give the owner the one-line `gh api` addition (owner-only action). Until then the relay job still runs and the merge gate (which reads `CI_CHECKS`) enforces it.

4. **Single-instance guard on the state directory.**
   - What we know: two relays sharing a state directory would double-process queues once later phases exist. `PRAGMA locking_mode = EXCLUSIVE` would refuse the second opener but also blocks operators from reading the database with the `sqlite3` CLI; not tested here.
   - Recommendation: do not decide in 68; add the `relay_meta.instance_id` row now and a lock decision in Phase 71 when the first consumer exists. Document it as a known limitation.

5. **Which `signal-cli-rest-api` pin?**
   - Stable tag `0.101` (2026-09-25, digest `sha256:2cf09d66a86fdd210e42ee91662216364acc27da1163a8c44167a77ea3a6559a`, signal-cli 0.14.8 per release notes, released 2026-09-10, so it passes upstream's "older than three months" line around 2026-12-10). Upstream signal-cli is already 0.14.10 (2026-11-07) and Docker Hub carries newer unversioned `...-ci` builds (latest 2026-11-10) but no newer release tag. Recommendation: pin `0.101@sha256:...` now, record the expiry date in the Compose comment, and let Phase 75 re-pin to the next release tag.

6. **`jose` pin and the SUS flag.** Pin 6.2.17 and add the human-verify checkpoint, or pin 6.2.15 (14 days old, contains the JWKS/JWE fixes). Owner's call at the checkpoint.

## Suggested Plan Slicing (non-binding)

1. **Foundation slice:** Node 26 install (human-verify), `relay/` skeleton (package.json, lockfile, tsconfig, build, check-node, `.npmrc`, `.nvmrc`), guard entry, config, root hygiene (`.vscodeignore`, `.gitignore`, `.dockerignore`, `src/test/relayIsolation.test.ts`).
2. **State slice:** state dir, `RelayStore` interface, contract suite, `sqliteStore`, schema/migrations, kill -9 drill.
3. **Secrets and logging slice:** secret loader, redactor, logger, no-leak test.
4. **Health slice:** registry, server, `--healthcheck`, graceful shutdown.
5. **Container slice:** Dockerfile, Compose (+ signal profile), container tests.
6. **CI and gates slice (gate change, owner approval):** `ci.yml` relay job, `CI_CHECKS`, `verify-release-content` pattern, docs; checkpoint for the owner's branch-protection update; phase-gate verification.

## Sources

### Primary (HIGH confidence, reproduced this session)
- Scratch Node 26.13.1 via a throwaway `NVM_DIR` (nvm install, `nvm exec`, `node:sqlite` exports, WAL/umask file modes, kill -9 drill, esbuild bundling, tsc settings, engine-strict on Node 24, guard behavior on Node 24)
- Docker 29.1.3, Compose 2.40.3, Podman 5.7.0: distroless run, no-shell check, hardened run, secrets ownership, volume copy-up, kill/restart, healthcheck, profile behavior
- `@vscode/vsce` 3.2.2 `ls` reproduction; `npm view` for jose, @types/node, esbuild, typescript; `gsd-tools query package-legitimacy check`
- Repo files read: `.vscodeignore`, `.gitignore`, `tsconfig.json`, `package.json` (scripts 834-851), `scripts/run-tests.mjs`, `scripts/secret-scan.mjs`, `scripts/verify-release-content.mjs`, `scripts/lib/workflow.mjs` (1-8, 566-616), `.github/workflows/ci.yml`, `release.yml` (header), `scripts/test/workflow-files.test.mjs`, `docs/development-workflow.md` (55-80, 525-570), `src/agent/graphics.ts`, `src/agent/documents.ts`, `src/services/nearAiClient.ts:459`, `src/services/reportingToken.ts:103`

### Secondary (MEDIUM confidence, official docs fetched)
- https://nodejs.org/docs/latest-v26.x/api/sqlite.html (stability, `Database`/`DatabaseSync`, options, methods)
- https://www.sqlite.org/pragma.html#pragma_synchronous and https://www.sqlite.org/wal.html (durability statements, WAL persistence, same-host requirement, `-wal`/`-shm`)
- https://systemd.io/CREDENTIALS/ (`$CREDENTIALS_DIRECTORY`, `LoadCredential=`, restricted to the service's user, non-swappable memory)
- https://raw.githubusercontent.com/actions/node-versions/main/versions-manifest.json (26.13.1 available); `git ls-remote` for the `setup-node` v7.1.0 SHA
- GitHub releases API: `bbernhard/signal-cli-rest-api` 0.101 notes; `AsamK/signal-cli` release dates; `panva/jose` release notes; Docker Hub tags API

### Tertiary (LOW confidence)
- None relied on. Milestone research (`STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`) is built upon, not re-derived; its sidecar environment variables (`JSON_RPC_RECEIVE_MODE=manual`, `JSON_RPC_IGNORE_ATTACHMENTS=true`) are carried as written there.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, versions read from the registry and run; SUS flags are recency only.
- Architecture: HIGH for build, guard, store, container, CI (all executed); MEDIUM for the `RelayStore` interface shape (design judgment).
- Pitfalls: HIGH, nearly all reproduced.
- Signal sidecar pin: MEDIUM (image not pulled; bundled signal-cli taken from release notes).

**Research date:** 2026-11-14
**Valid until:** 2026-12-05 (fast-moving: digests, `jose` patch releases, the signal-cli 3-month window, `@types/node` adding `Database`)
