# Phase 68: Relay foundation - Context

**Gathered:** 2026-11-14
**Status:** Ready for planning
**Source:** Owner chose "plan now, I decide" (2026-11-14). The decisions below were made by the planning agent on the owner's behalf from the milestone research (`.planning/research/STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`) and the locked decisions in `STATE.md`. The owner can change any of them; each is marked with how hard it is to undo.

<domain>
## Phase Boundary

The relay exists as its own runnable service before any chat traffic: the `relay/` workspace, its config and secret loading, its state directory and durable store, `/healthz`, a log redaction layer, and a hardened container. No Teams or Signal message handling (Phases 69-75). No import of the agent core yet (Phase 71 composes it), but the layout must let Phase 71 import `src/agent/` without restructuring.

The extension is not changed by this phase, except for build hygiene: the root package, its bundle, `.vscodeignore`, lint and tests must ignore `relay/`.
</domain>

<decisions>
## Implementation Decisions

### Workspace and runtime (locked in STATE.md, restated)
- **D-01:** `relay/` has its own `package.json`, its own `package-lock.json`, its own `tsconfig.json`, and `engines: { "node": ">=26.13.1 <27" }`. Exactly one runtime dependency: `jose`. Tests use `node:test`. No HTTP framework, no SQLite package, no dotenv.
- **D-02:** An older runtime refuses to start twice over: `engine-strict=true` in `relay/.npmrc` for installs, and a startup check of `process.versions.node` that exits non-zero with a plain message. The VSIX never contains `relay/`; the extension keeps Node 24 and its zero-dependency bundle. CI gains a separate relay job on Node 26.13.1. *Undo: cheap.*
- **D-03:** Node 26.13.1 is not installed on the owner's dev host (only Node 24). Plans install it through nvm for development and tests (`nvm install 26.13.1`) and never change the default Node used by the extension's scripts. *Undo: cheap.*

### Storage (research flag 1)
- **D-04:** The durable store is `node:sqlite` (the `Database` class, not the deprecated `DatabaseSync` alias), WAL mode, one database file in the state directory. All access goes through a small `RelayStore` interface (runs, conversation bindings, tenant registry, pending approvals, message queues) so no caller touches SQL.
- **D-05:** The named fallback, if `node:sqlite` changes before release: a JSON-file-per-tenant store behind the same `RelayStore` interface, written atomically (temp file, fsync, rename). Phase 68 does not build it. It writes the interface contract tests so a fallback can be dropped in and proven by the same suite. *Undo: costly (storage format), which is why the interface and contract tests come first.*
- **D-06:** Restart loses nothing: every queue and run-record write is committed before it is acknowledged. A kill -9 drill test (child process, killed mid-write) proves no queued message or run record is lost or duplicated.

### State directory
- **D-07:** One state directory, set by `RELAY_STATE_DIR` (default `relay/state/` in dev, `/var/lib/near-ai-relay` in the container). It is git-ignored, created with mode 0700, and the relay refuses to start if it is group- or world-accessible or owned by another user. Files inside are 0600.

### Secrets
- **D-08:** Secrets come only from files: `$CREDENTIALS_DIRECTORY` (systemd `LoadCredential`), `/run/secrets/` (Docker/Podman secrets), or an explicit `<NAME>_FILE` path. A secret passed as a plain environment value is refused, because env values show up in `docker inspect` and process listings. No vault client in v0.7.0; a vault feeds the same files through its agent. *Undo: cheap.*
- **D-09:** The relay refuses a secret file that is group- or world-readable. Required secrets missing means fail fast at startup with the secret's name only, never its value. Secrets are held in memory, never written to the state directory, never logged.
- **D-10:** Secret classes named now even though later phases use them: Teams bot app secret, tenant NEAR AI API keys, Signal registration material (the sidecar's config volume, which is itself the credential).

### Logging
- **D-11:** One logger with a redaction layer in front of every sink, from the first commit: it drops `Authorization` headers, secret values (every loaded secret is registered and masked if it ever appears), message text, and phone numbers (stable hash label). It logs metadata only: ids, lengths, verdicts, timings.

### Health check
- **D-12:** `GET /healthz` returns JSON: `version`, `uptimeSeconds`, `teams` and `signal` component states (`not-configured`, `ok`, `down`), and `inFlightRuns`. In Phase 68 both components report `not-configured`; later phases plug real probes into the same registry. It contains no tenant names, ids or secrets, so it can be served on the main port.

### Container and where it runs
- **D-13:** The relay runs on the owner's own Linux host with Docker Compose (Podman compatible). The final image is `gcr.io/distroless/nodejs26-debian13:nonroot`, pinned by digest: no shell, no package manager. Multi-stage build; the build stage may use a full Node 26.13.1 image.
- **D-14:** Container hardening: read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, non-root uid, the state directory as the only writable volume, secrets mounted as Compose secrets.
- **D-15:** The relay speaks plain HTTP on an internal port. TLS for the public Teams webhook ends at the owner's reverse proxy, which the runbook documents (Phase 76 finishes the runbook). *Undo: cheap.*
- **D-16:** The Signal sidecar (`bbernhard/signal-cli-rest-api`, `MODE=json-rpc`) is in the Compose file, pinned to an exact version tag plus digest, behind a Compose profile that is off by default. Phase 75 checks the bundled signal-cli age and wires it.

### Decisions from research (2026-11-14, made on the owner's behalf)
- **D-17 (amends D-07):** Podman can create the state directory as 0755 and the image has no shell to fix it. If the relay's own uid owns the directory and it is a real directory (not a symlink), the relay tightens it to 0700 and logs that it did. It still refuses to start if another user owns it or it is a symlink.
- **D-18 (D-11 detail):** The phone-number pseudonym key comes from an optional secret file; without one, the relay creates a random key once and stores it 0600 in the state directory.
- **D-19:** `relay` becomes a required CI check. Because that changes gate paths and branch protection, the PR waits for the owner's `agent-review-gates` approval and the owner re-applies branch protection (a human-action checkpoint).
- **D-20:** Package pins are checked by a human before the first install in `relay/` (`jose` 6.2.17 and `@types/node` 26.6.6 are only days old; fallbacks 6.2.15 and 26.6.5).
- **D-21:** The single-instance lock on the state directory is deferred to Phase 71. The Signal sidecar pin (`0.101`, signal-cli 0.14.8) is re-checked in Phase 75 before about 2026-12-10.

### Claude's discretion
- Module layout inside `relay/src/`, the config file format, the router shape, and the exact table schema, as long as D-04's interface holds.
</decisions>

<canonical_refs>
## Canonical References

- `.planning/REQUIREMENTS.md`: RELAY-01..04 and the naming-trap note
- `.planning/ROADMAP.md`: Phase 68 success criteria and research flags
- `.planning/research/STACK.md`: Node 26.13.1, `jose`, `node:sqlite`, distroless image, Compose sketch
- `.planning/research/ARCHITECTURE.md`: relay layout, the loop/host seam (Phase 71 relies on it), build order step 1
- `.planning/research/PITFALLS.md`: C8 secrets, logging redaction, restart drills
</canonical_refs>

<specifics>
## Specific Ideas

- The naming trap: this relay is not the paused v0.5.0 ciphertext sync relay and not `relayTransport.ts` on the Team Mode branch.
- User-facing words follow the repo rules: say "your organization", no em-dashes in docs.
</specifics>

<deferred>
## Deferred Ideas

- JSON-file-per-tenant store implementation (only if `node:sqlite` shifts).
- Vault client (a vault agent writing files covers it).
- Full operator runbook (Phase 76).
</deferred>

---

*Phase: 68-relay-foundation*
*Context gathered: 2026-11-14*
