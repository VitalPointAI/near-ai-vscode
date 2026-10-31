# Phase 60: Team core: identity, signed event log, git transport, roster - Context

**Gathered:** 2026-10-31
**Status:** Ready for planning
**Mode:** auto (owner instruction: answer from the spec, record decisions, do not ask). Spec phase 25 = this Phase 60.

<domain>
## Phase Boundary

A lead can turn on Team Mode for an initialised project, and two clones share one signed, append-only coordination log on the project's own git remote. Every client verifies every event (signature, device bound to author, author's role at that log position, body schema, referenced entities), roles are enforced on write and on read, invalid events are listed as rejected and never change state, and no secret is ever written.

Delivers: `src/domain/team/{types,permissions,materialize}.ts` (pure), `src/team/{identity,eventLog,transport,gitTransport}.ts` (Node I/O, no `vscode`), `src/services/team/{teamSession,teamCommands,teamStatusBar}.ts` (VS Code adapters), the roster event types, `NEAR AI: Enable Team Mode`, `NEAR AI: Verify Team Log` with rejected-event diagnostics, the `nearAi.team.pollSeconds` setting, and the "Team sync paused" state.

Not in this phase: invitations/join/removal flows and NEAR org calls (61), work items and the board (62), claims and leases (63), dispatch (64), integration (65), budgets (66), metrics/collab/team stop/relay (67). Their event types are declared in the type union now but their bodies are not accepted yet (see D-07).

</domain>

<decisions>
## Implementation Decisions

### Coordination storage and layout
- **D-01:** Storage is the orphan branch `near-ai/coordination` (owner decision 2, spec default). The ref is recorded in `team.json` (`coordination.ref`) so a custom ref such as `refs/near-ai/coordination` can be configured later without a format change. — **Reversibility:** costly — moving an existing team's log to another ref needs a copy-and-switch step for every member.
- **D-02:** Branch layout per spec 5.3: `events/<lamport 12-digit zero-padded>-<eventId>.json` (one file per event, canonical JSON, pretty-printing forbidden), `snapshots/<lamport>.json`, and `team.json` (genesis copy). Each append is one commit; a batch append (needed from Phase 63 for claim + leases) is several event files in one commit, and the API supports batches from the start.
- **D-03:** Total order is the first-parent commit order of the coordination branch (history is linear because pushes are never forced); within one commit, events are ordered by their file names. Lamport is a tiebreak for the relay (Phase 67) and a sanity check: a device's Lamport values must strictly increase, and an event whose Lamport is not greater than the highest Lamport seen before it is rejected. The `at` field is display only and never used for ordering. — **Reversibility:** one-way — every client's materialised state depends on this ordering rule; changing it later forks history interpretation.
- **D-04:** Coordination commits use a neutral identity `NEAR AI Team <coordination@near-ai.invalid>` so commit metadata never carries a member's email; attribution lives in the signed event. Commit messages are `team: <type> <eventId>` only.

### Event envelope and signing
- **D-05:** Envelope exactly as spec 5.2 (`v: 1`, `id: evt-<ulid>`, `teamId`, `type`, `lamport`, `at`, `author`, `device`, `prev`, `body`, `sig`). ULIDs are generated locally with `node:crypto` (no dependency); the ULID timestamp prefix exists only for uniqueness and is never used for ordering.
- **D-06:** Signing is Ed25519 (`node:crypto`) over canonical JSON of the envelope without `sig`: object keys sorted by UTF-16 code unit (JCS style), no whitespace, `undefined` and functions forbidden, numbers must be safe integers (money is integer nano-USD everywhere; floats are rejected by the canonicaliser). `sig` and public keys are base64url of the raw bytes (64-byte signature, 32-byte public key). Device fingerprint = `dev-` + first 32 hex chars of SHA-256 of the raw public key. — **Reversibility:** one-way — signatures over the canonical form are stored forever in the log; changing canonicalisation invalidates every existing event.
- **D-07:** The full `TeamEventType` union and the `TeamEventBody` map from spec 5.2 are declared in `src/domain/team/types.ts` now. Phase 60 implements validation for: `team.created`, `member.joined` (owner at genesis only in this phase), `member.role-changed`, `member.removed`, `device.added`, `device.revoked`, `member.availability`, `member.skills`, `policy.changed`, `snapshot.written`. Any other type is rejected with reason `unsupported event type for this version` until its phase adds a validator. Unknown `v` values are rejected the same way, and the diagnostics tell the user to update the extension.
- **D-08:** Event size limit 16 KB of canonical JSON; larger events are refused on write and rejected on read.

### Validation pipeline (every client, every event)
- **D-09:** Order of checks, first failure wins and is recorded as the reason: (1) envelope/body schema, (2) `teamId` matches, (3) device fingerprint bound to `author` by a roster event earlier in the log and not revoked at that position, (4) signature valid, (5) Lamport monotone rule (D-03), (6) `decideTeamAction(stateAtThatPosition, author, action)` permits it, (7) referenced entities exist (member ids, device ids). Rejected events go to `state.rejected` with `{ eventId, reason }` and never change any other state. `reduce(events)` is pure and deterministic: same committed sequence in, same state out.
- **D-10:** Genesis trust anchor (borrowed from the paused v0.5.0 design): `team.json` records `genesis.eventId` and `genesis.ownerDevice` (fingerprint + public key). A client accepts the log only if its first event is a `team.created` with that id, signed by that key, which also binds the owner member and device. A coordination branch whose first event does not match is refused entirely ("This coordination log does not belong to this project's team") rather than partly trusted.
- **D-11:** Removal and revocation are positional: events signed by a device after the `device.revoked` (or the member's `member.removed`) that precedes them in commit order are rejected. Events before stay valid.

### Roles and permissions
- **D-12:** `decideTeamAction(state, actorId, action)` in `src/domain/team/permissions.ts` implements the entire spec 6.3 matrix now (all actions, including those whose events arrive in later phases), returning `{ allowed: boolean; reason?: string }`. It is the single decision point, called both before writing (refuse locally with the reason) and when validating every incoming event. Policy-dependent cells (`peerMetricsVisible`, developer `integrator`) read `TeamPolicy`. A lead may not act on the owner (change role, remove). Exactly one owner exists; ownership transfer is out of scope for v0.6.0 (deferred).
- **D-13:** `TeamPolicy` defaults from spec 7 and owner decisions: `dispatchMode: 'offer'`, `offerTimeoutMinutes: 30`, `leaseTtlMinutes: 60`, `heartbeatMinutes: 10`, `enforceWip: true`, the spec `sharedPaths` list, `resources: ['integrator','deps','db-schema','release']`, `verifyCommands: ['npm run lint','npm test']`, `reviewPolicy: 'agent-then-human'`, `integrationMode: 'merge-train'`, `integrationBranch: 'main'` (overridable at enable time), `budgetPeriod: 'monthly'`, `unspentPolicy: 'return-to-pool'`, `safetyFactor: 1.25`, `overrunFactor: 1.5`, `reconcileTolerance: 0.05` (stored as basis points `500` to keep integers), `teeOnly: false`, `peerMetricsVisible: false`, `requireLeadConfirmation: true`, spec dispatch weights (stored as basis points). Policy lives in the signed log (`team.created`, later `policy.changed` by the owner only), never in settings.

### Device identity
- **D-14:** One Ed25519 key per device per team, generated with `node:crypto`. The private key (PKCS#8 DER, base64) is stored only in VS Code SecretStorage under `nearAi.team.deviceKey.<teamId>`; the public key and fingerprint go into roster events. Never in settings, the workspace, `team.json`, transcripts or audit. `src/team/identity.ts` takes a `SecretStorageLike` (existing interface in `src/services/auth.ts`, imported as a type only) so it stays `vscode`-free.
- **D-15:** Member ids are `mbr-<hex16>`, team ids `team-<hex32>`, from `crypto.randomBytes`.

### Git transport
- **D-16:** A dedicated bare mirror per team under extension global storage (`<globalStorage>/team/<teamId>/coordination.git`). Coordination fetches and commits never touch the user's working tree, index or branches. All git runs through one `runGit` helper with `GIT_TERMINAL_PROMPT=0`, a timeout and the user's existing credential helpers (no credentials handled by the extension). The remote is the project's git remote named in `team.json` (`coordination.remote`, default `origin`); its URL is read from the project repo at each sync, not stored in `team.json`.
- **D-17:** Append = fetch the branch into the mirror; materialise; validate the new event(s) against the head (refuse locally with the reason if invalid); build the commit with plumbing (`hash-object -w`, a temporary `GIT_INDEX_FILE` with `read-tree <head>` + `update-index --add --cacheinfo`, `write-tree`, `commit-tree -p <head>`); `git push <remote> <commit>:refs/heads/near-ai/coordination` without force. A non-fast-forward rejection means someone appended first: fetch, re-materialise, re-validate, retry up to 5 times with jittered exponential backoff (base 200 ms). An event that is no longer valid after re-validation is returned to the caller as a conflict with the reason (Phase 63 turns this into "taken by X"); it is never retried blindly. The first append (genesis) creates the orphan commit with no parent; if the branch already exists remotely, enabling stops with "This remote already has a coordination log".
- **D-18:** `CoordinationTransport` interface (`src/team/transport.ts`): `fetch(): Promise<CommittedEvent[]>` (events with their commit id and commit timestamp, in order), `append(events, revalidate): Promise<AppendResult>`, `onUpdate(listener)`, `status(): TransportStatus` (`'ok' | 'paused' | 'offline'` with a reason). The relay (Phase 67) implements the same interface. Commit timestamps are carried for later TTL logic (spec 6.15) but never used for ordering.
- **D-19:** Polling per spec 5.3: every `nearAi.team.pollSeconds` (setting, default 15) while the window is focused and Team Mode is active, 120 s when unfocused, plus an immediate fetch after any local append and on window focus. Board-visible and active-claim triggers are added in Phases 62 and 63.

### Enable Team Mode
- **D-20:** `NEAR AI: Enable Team Mode` (`nearAi.team.enable`) requires: an initialised NEAR AI project (`.planning/.near-ai/` exists), a git repository with at least one commit, and a configured remote (default `origin`). It asks for the team name (default: workspace folder name) and the owner's display name and email (defaults from `git config user.name` / `user.email`), then: generates the device key; writes `team.created` (team, owner member, owner device, policy) as the genesis event, and `member.joined` for the owner as spec 6.1 lists; pushes the coordination branch; writes `.planning/.near-ai/team.json`; and commits only that file on the current branch (`git add -f` because projects such as this one gitignore `.planning/.near-ai/`; `git commit --only` so nothing else the user staged is committed). It never pushes the user's code branch; it offers a "Push" button that runs `git push` only when clicked.
- **D-21:** `team.json` holds: `version: 1`, `teamId`, `name`, `coordination: { transport: 'git', ref, remote }`, `genesis: { eventId, ownerDevice: { fingerprint, publicKey } }`, optional `near: { organizationId, workspaceId }` (filled in Phase 61), and `createdAt` (display only). Policy is not duplicated there (the log is authoritative). No secrets, ever.
- **D-22:** Enabling on a project that already has `team.json` does not create a second team; it reports the existing team and (Phase 61) offers Join.

### Secrets (SEC-01)
- **D-23:** Defense in depth: every event body, `team.json` and every team audit entry passes `assertNoSecrets()` before it is written, which refuses (throws, nothing written) if any string matches the existing secret detectors in `src/domain/redaction.ts` plus explicit patterns for `sk-`, `rpt-`, `rt_`, `adm_`, `oc_`, `Bearer `, JWTs (`eyJ…`), and PEM/PKCS#8 private-key bodies. A canary test seeds unique canary strings into an API key, a reporting token, a refresh token, a device private key and a prompt, runs Enable Team Mode plus roster events end to end, and asserts none appears in the coordination branch (all blobs), `team.json`, settings or the audit store.

### Solo parity (TEAM-01)
- **D-24:** Without `.planning/.near-ai/team.json` nothing new runs at activation beyond one `fs.stat`: no mirror, no polling, no status bar item, no extra memory. Team commands are contributed and registered but only explain how to enable Team Mode when invoked without a team. The existing suite stays unchanged and green; a test asserts that activation in a solo project creates no team storage and starts no timers.

### Diagnostics, failures, audit
- **D-25:** `NEAR AI: Verify Team Log` (`nearAi.team.verifyLog`) re-fetches, replays and re-verifies the whole log from genesis, then shows the result (events, members, head, and the Rejected events list with reasons) in a dedicated `NEAR AI Team` output channel, with a notification summary. The status bar item (`Team: …`) shows `Team sync paused: remote unreachable` (with the git error reason in the tooltip, secrets redacted) when fetch/push fails, backing off exponentially to 10 minutes and retrying on focus. No empty `catch`: every failure is reported to the output channel or the user.
- **D-26:** Accepted roster events are mirrored into the existing `AuditStore` with a new audit event type `team-roster` (member attribution, no secrets). Rejected events are recorded in the output channel and diagnostics, not as audit events. Other team audit types (`claim`, `lease`, `integration`, `allocation`, `team-stop`) are added in their phases.
- **D-27:** Snapshots: the format (`snapshots/<lamport>.json`, signed materialised state with `coversThrough` event id and `stateHash`) and loader are built here; a snapshot is accepted provisionally and the client still replays from genesis in the background (verifyLog always replays fully). Writing is done by an owner or lead client every 500 events (the `integrator` lease does not exist until Phase 65; the snapshot writer moves to the integrator then).

### Testing
- **D-28:** Phase 60 success criterion 2 ("two VS Code instances on two clones") is proven in `node --test` with two independent team-core clients (no `vscode`) on two clones of one local bare repo; the two-window VS Code scenario is the Phase 67 e2e (`npm run test:e2e` gating starts in Phase 62). Concurrency test: N child-process clients (`node:child_process.fork`) appending concurrently to one local bare repo; assert every event is present exactly once, history is linear and no push was forced. Property tests use a small seeded PRNG written in the test (no dependency).

### Decisions added after research (60-RESEARCH.md open questions, decided by the orchestrator under the owner's standing instruction)
- **D-29:** `append` takes a builder, not pre-signed events: `append(build: (state, head) => TeamEvent[] | { conflict: string })`. On a lost push race the transport re-fetches, re-materialises and calls the builder again, which re-derives `lamport` (head lamport + 1 + i), `prev` and `sig`. A rejected or unpushed event never advances any Lamport high-water mark. `maxRetries` (default 5) and `baseDelayMs` (default 200) are options; tests may raise them.
- **D-30:** All policy fractions are integer basis points: `safetyFactorBp: 12500`, `overrunFactorBp: 15000`, `reconcileToleranceBp: 500`, and `dispatchWeightsBp` (3000, 2500, 1500, 1500, 1000, 500). `TeamPolicy` gains `developerMayIntegrate: false` for the policy-dependent integrator cell of the 6.3 matrix. This supersedes the float values listed in D-13.
- **D-31:** Event bodies for the 10 Phase 60 types are exactly as proposed in 60-RESEARCH.md (exact-key schemas, unknown keys rejected), except that members never carry plain email addresses: `emails` is replaced by `emailHashes`, each `sha256(teamId + ':' + lowercased trimmed email)` hex. Git-author attribution in later phases hashes the commit author email the same way. Plain emails are kept only in the local device's display cache, never in the log or `team.json`. — **Reversibility:** one-way — signed bodies are permanent in the log.
- **D-32:** A lead may not `device.added` or `device.revoked` a device of the owner (only the owner's own existing device may), in addition to D-12's rule that a lead may not change the owner's role or remove the owner.
- **D-33:** A rewritten coordination branch (the last-seen head is no longer an ancestor of the fetched head) is refused: the client keeps its last good state, pins the old head under a local quarantine ref, shows "The team's coordination log was rewritten on the remote; Team Mode is paused" and stops appending. Phase 60 has no automatic recovery. Snapshot races are harmless: a snapshot for a threshold that already has one is skipped by the CAS re-validation.
- **D-34:** The bare mirror sets `core.hooksPath` locally to an empty directory so the user's global hooks never run on coordination commits; fetches and pushes on one mirror are serialised by an in-process mutex, and the git error "incorrect old value provided" on fetch or push is treated as a retryable race. The remote URL is read at sync time and never stored, logged or displayed (it can embed credentials).

### Claude's Discretion
- Exact module split inside `src/team/` beyond the files listed in spec 5.1, the shape of helper functions, and output-channel wording (plain language, no em-dashes).
- Whether `teamStatusBar.ts` lives in `teamSession.ts` until Phase 62 adds board counts.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Spec (source of truth)
- `.planning/research/v0.6.0-team-mode-addendum.md` §3 (D1-D9), §4, §5.1-5.3, §6.1, §6.3, §6.14-6.15, §7, §8, §10 (phase 25 = Phase 60), §11 — envelope, transport, permissions matrix, data model, testing.

### Planning
- `.planning/ROADMAP.md` Phase 60 — goal, scope, success criteria.
- `.planning/REQUIREMENTS.md` — TEAM-01, TEAM-04, SEC-01, SEC-04.
- `.planning/PROJECT.md` "Current Milestone: v0.6.0 Team Mode" — constraints and owner decisions taken.
- `.planning/UX-CONTRACT.md` — privacy boundary (metadata only), verbosity, interruptibility.

### Borrowed design (not the encrypted KB)
- `.planning/milestones/v0.5.0-paused/research/ARCHITECTURE.md` §3 (entry envelope, canonical JSON signing, directory/roster stream validated at the roster version the author saw, sync transports) and the threat-model notes ("honest limits").
- `.planning/milestones/v0.5.0-paused/ROADMAP.md` Phases 19 to 21 — transport interface, signed membership chain, relay threat model.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md`, `TESTING.md` — layering, style, the empty-catch and write-queue concerns to avoid, test patterns (real git in temp dirs, `.invalid` emails).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/agent/worktree.ts` `git()` helper (execFile, `GIT_TERMINAL_PROMPT=0`, timeout): template for the team `runGit`.
- `src/services/auth.ts` `SecretStorageLike`: interface for device-key storage in `src/team/identity.ts` (type-only import).
- `src/domain/redaction.ts` (`redactSecrets` and detectors): basis for `assertNoSecrets()`.
- `src/services/reportingToken.ts` secret-move logic (`findPastedReportingTokens`): pattern for keeping team fields free of tokens.
- `src/services/auditStore.ts` + `src/domain/approval.ts` `AuditEvent`/`isAuditEventType`: add `team-roster`.
- `src/services/contextGraphStore.ts` temp-file-then-rename; `src/services/activityStore.ts` serialised write queue: patterns for `team.json` and local caches.
- `src/services/emergencyStop.ts`: model for a module status signal (Phase 67 team stop builds on it).

### Established Patterns
- `src/domain/*` pure and `vscode`-free; tests under `src/test/*.test.ts` with flat `test()` calls, real git in `mkdtemp` dirs, `.invalid` emails, header comment per file.
- Commands contributed in `package.json` and registered from `src/extension.ts` through a `register*` function per feature (e.g. `registerSpendTracking`).
- Activation is `workspaceContains:.planning/.near-ai/**`, so Team Mode code must be lazy for solo projects.

### Integration Points
- `src/extension.ts`: one `registerTeamMode(context)` call (no growth of `chat.ts`).
- `package.json` `contributes`: commands `nearAi.team.enable`, `nearAi.team.verifyLog` (other `nearAi.team.*` commands arrive with their phases), setting `nearAi.team.pollSeconds`.
- `scripts/` SBOM: no new runtime dependency in this phase.

</code_context>

<specifics>
## Specific Ideas

- Owner decision 1 (NEAR spend-limit semantics) belongs to Phase 61 research, not here.
- Phase numbering: Team Mode uses 60 to 67 because Phase 25 is the parallel 0.4.x cybersecurity harness; phase branches are `gsd/phase-NN-<slug>` from `gsd/milestone-v0.6.0-team-mode`, with one PR per phase against `main`.

</specifics>

<deferred>
## Deferred Ideas

- Ownership transfer between members (not in the spec's 6.3 matrix as an action) — candidate for a later 0.6.x release.
- Custom coordination ref (`refs/near-ai/coordination`) as the default — format supports it (D-01); switching the default waits for host compatibility evidence.

</deferred>

---

*Phase: 60-team-core-identity-signed-event-log-git-transport-roster*
*Context gathered: 2026-10-31*
