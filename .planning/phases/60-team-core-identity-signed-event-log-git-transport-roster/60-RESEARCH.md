# Phase 60: Team core: identity, signed event log, git transport, roster - Research

**Researched:** 2026-10-31
**Domain:** Node-only team core (Ed25519 signing, canonical JSON, append-only signed log, git plumbing over a bare mirror, role matrix) plus a thin VS Code adapter, inside an existing CommonJS TypeScript extension with zero new runtime dependencies.
**Confidence:** HIGH for crypto, canonical JSON, git plumbing and concurrency behaviour (all exercised against real `git 2.53.0` on Node 22.22.1 and Node 24.22.2); MEDIUM for hosted-remote behaviour (GitHub/GitLab wording), Windows and credential-helper edge cases (not testable here, tagged `[ASSUMED]`).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Storage is the orphan branch `near-ai/coordination` (owner decision 2, spec default). The ref is recorded in `team.json` (`coordination.ref`) so a custom ref such as `refs/near-ai/coordination` can be configured later without a format change. Reversibility: costly.
- **D-02:** Branch layout per spec 5.3: `events/<lamport 12-digit zero-padded>-<eventId>.json` (one file per event, canonical JSON, pretty-printing forbidden), `snapshots/<lamport>.json`, and `team.json` (genesis copy). Each append is one commit; a batch append (needed from Phase 63 for claim + leases) is several event files in one commit, and the API supports batches from the start.
- **D-03:** Total order is the first-parent commit order of the coordination branch (history is linear because pushes are never forced); within one commit, events are ordered by their file names. Lamport is a tiebreak for the relay (Phase 67) and a sanity check: a device's Lamport values must strictly increase, and an event whose Lamport is not greater than the highest Lamport seen before it is rejected. The `at` field is display only and never used for ordering. Reversibility: one-way.
- **D-04:** Coordination commits use a neutral identity `NEAR AI Team <coordination@near-ai.invalid>` so commit metadata never carries a member's email; attribution lives in the signed event. Commit messages are `team: <type> <eventId>` only.
- **D-05:** Envelope exactly as spec 5.2 (`v: 1`, `id: evt-<ulid>`, `teamId`, `type`, `lamport`, `at`, `author`, `device`, `prev`, `body`, `sig`). ULIDs are generated locally with `node:crypto` (no dependency); the ULID timestamp prefix exists only for uniqueness and is never used for ordering.
- **D-06:** Signing is Ed25519 (`node:crypto`) over canonical JSON of the envelope without `sig`: object keys sorted by UTF-16 code unit (JCS style), no whitespace, `undefined` and functions forbidden, numbers must be safe integers (money is integer nano-USD everywhere; floats are rejected by the canonicaliser). `sig` and public keys are base64url of the raw bytes (64-byte signature, 32-byte public key). Device fingerprint = `dev-` + first 32 hex chars of SHA-256 of the raw public key. Reversibility: one-way.
- **D-07:** The full `TeamEventType` union and the `TeamEventBody` map from spec 5.2 are declared in `src/domain/team/types.ts` now. Phase 60 implements validation for: `team.created`, `member.joined` (owner at genesis only in this phase), `member.role-changed`, `member.removed`, `device.added`, `device.revoked`, `member.availability`, `member.skills`, `policy.changed`, `snapshot.written`. Any other type is rejected with reason `unsupported event type for this version` until its phase adds a validator. Unknown `v` values are rejected the same way, and the diagnostics tell the user to update the extension.
- **D-08:** Event size limit 16 KB of canonical JSON; larger events are refused on write and rejected on read.
- **D-09:** Order of checks, first failure wins and is recorded as the reason: (1) envelope/body schema, (2) `teamId` matches, (3) device fingerprint bound to `author` by a roster event earlier in the log and not revoked at that position, (4) signature valid, (5) Lamport monotone rule (D-03), (6) `decideTeamAction(stateAtThatPosition, author, action)` permits it, (7) referenced entities exist (member ids, device ids). Rejected events go to `state.rejected` with `{ eventId, reason }` and never change any other state. `reduce(events)` is pure and deterministic: same committed sequence in, same state out.
- **D-10:** Genesis trust anchor: `team.json` records `genesis.eventId` and `genesis.ownerDevice` (fingerprint + public key). A client accepts the log only if its first event is a `team.created` with that id, signed by that key, which also binds the owner member and device. A coordination branch whose first event does not match is refused entirely ("This coordination log does not belong to this project's team") rather than partly trusted.
- **D-11:** Removal and revocation are positional: events signed by a device after the `device.revoked` (or the member's `member.removed`) that precedes them in commit order are rejected. Events before stay valid.
- **D-12:** `decideTeamAction(state, actorId, action)` in `src/domain/team/permissions.ts` implements the entire spec 6.3 matrix now (all actions, including those whose events arrive in later phases), returning `{ allowed: boolean; reason?: string }`. It is the single decision point, called both before writing (refuse locally with the reason) and when validating every incoming event. Policy-dependent cells (`peerMetricsVisible`, developer `integrator`) read `TeamPolicy`. A lead may not act on the owner (change role, remove). Exactly one owner exists; ownership transfer is out of scope for v0.6.0 (deferred).
- **D-13:** `TeamPolicy` defaults from spec 7 and owner decisions: `dispatchMode: 'offer'`, `offerTimeoutMinutes: 30`, `leaseTtlMinutes: 60`, `heartbeatMinutes: 10`, `enforceWip: true`, the spec `sharedPaths` list, `resources: ['integrator','deps','db-schema','release']`, `verifyCommands: ['npm run lint','npm test']`, `reviewPolicy: 'agent-then-human'`, `integrationMode: 'merge-train'`, `integrationBranch: 'main'` (overridable at enable time), `budgetPeriod: 'monthly'`, `unspentPolicy: 'return-to-pool'`, `safetyFactor: 1.25`, `overrunFactor: 1.5`, `reconcileTolerance: 0.05` (stored as basis points `500` to keep integers), `teeOnly: false`, `peerMetricsVisible: false`, `requireLeadConfirmation: true`, spec dispatch weights (stored as basis points). Policy lives in the signed log (`team.created`, later `policy.changed` by the owner only), never in settings.
- **D-14:** One Ed25519 key per device per team, generated with `node:crypto`. The private key (PKCS#8 DER, base64) is stored only in VS Code SecretStorage under `nearAi.team.deviceKey.<teamId>`; the public key and fingerprint go into roster events. Never in settings, the workspace, `team.json`, transcripts or audit. `src/team/identity.ts` takes a `SecretStorageLike` (existing interface in `src/services/auth.ts`, imported as a type only) so it stays `vscode`-free.
- **D-15:** Member ids are `mbr-<hex16>`, team ids `team-<hex32>`, from `crypto.randomBytes`.
- **D-16:** A dedicated bare mirror per team under extension global storage (`<globalStorage>/team/<teamId>/coordination.git`). Coordination fetches and commits never touch the user's working tree, index or branches. All git runs through one `runGit` helper with `GIT_TERMINAL_PROMPT=0`, a timeout and the user's existing credential helpers (no credentials handled by the extension). The remote is the project's git remote named in `team.json` (`coordination.remote`, default `origin`); its URL is read from the project repo at each sync, not stored in `team.json`.
- **D-17:** Append = fetch the branch into the mirror; materialise; validate the new event(s) against the head (refuse locally with the reason if invalid); build the commit with plumbing (`hash-object -w`, a temporary `GIT_INDEX_FILE` with `read-tree <head>` + `update-index --add --cacheinfo`, `write-tree`, `commit-tree -p <head>`); `git push <remote> <commit>:refs/heads/near-ai/coordination` without force. A non-fast-forward rejection means someone appended first: fetch, re-materialise, re-validate, retry up to 5 times with jittered exponential backoff (base 200 ms). An event that is no longer valid after re-validation is returned to the caller as a conflict with the reason (Phase 63 turns this into "taken by X"); it is never retried blindly. The first append (genesis) creates the orphan commit with no parent; if the branch already exists remotely, enabling stops with "This remote already has a coordination log".
- **D-18:** `CoordinationTransport` interface (`src/team/transport.ts`): `fetch(): Promise<CommittedEvent[]>` (events with their commit id and commit timestamp, in order), `append(events, revalidate): Promise<AppendResult>`, `onUpdate(listener)`, `status(): TransportStatus` (`'ok' | 'paused' | 'offline'` with a reason). The relay (Phase 67) implements the same interface. Commit timestamps are carried for later TTL logic (spec 6.15) but never used for ordering.
- **D-19:** Polling per spec 5.3: every `nearAi.team.pollSeconds` (setting, default 15) while the window is focused and Team Mode is active, 120 s when unfocused, plus an immediate fetch after any local append and on window focus. Board-visible and active-claim triggers are added in Phases 62 and 63.
- **D-20:** `NEAR AI: Enable Team Mode` (`nearAi.team.enable`) requires: an initialised NEAR AI project (`.planning/.near-ai/` exists), a git repository with at least one commit, and a configured remote (default `origin`). It asks for the team name (default: workspace folder name) and the owner's display name and email (defaults from `git config user.name` / `user.email`), then: generates the device key; writes `team.created` (team, owner member, owner device, policy) as the genesis event, and `member.joined` for the owner as spec 6.1 lists; pushes the coordination branch; writes `.planning/.near-ai/team.json`; and commits only that file on the current branch (`git add -f` because projects such as this one gitignore `.planning/.near-ai/`; `git commit --only` so nothing else the user staged is committed). It never pushes the user's code branch; it offers a "Push" button that runs `git push` only when clicked.
- **D-21:** `team.json` holds: `version: 1`, `teamId`, `name`, `coordination: { transport: 'git', ref, remote }`, `genesis: { eventId, ownerDevice: { fingerprint, publicKey } }`, optional `near: { organizationId, workspaceId }` (filled in Phase 61), and `createdAt` (display only). Policy is not duplicated there (the log is authoritative). No secrets, ever.
- **D-22:** Enabling on a project that already has `team.json` does not create a second team; it reports the existing team and (Phase 61) offers Join.
- **D-23:** Defense in depth: every event body, `team.json` and every team audit entry passes `assertNoSecrets()` before it is written, which refuses (throws, nothing written) if any string matches the existing secret detectors in `src/domain/redaction.ts` plus explicit patterns for `sk-`, `rpt-`, `rt_`, `adm_`, `oc_`, `Bearer `, JWTs (`eyJ…`), and PEM/PKCS#8 private-key bodies. A canary test seeds unique canary strings into an API key, a reporting token, a refresh token, a device private key and a prompt, runs Enable Team Mode plus roster events end to end, and asserts none appears in the coordination branch (all blobs), `team.json`, settings or the audit store.
- **D-24:** Without `.planning/.near-ai/team.json` nothing new runs at activation beyond one `fs.stat`: no mirror, no polling, no status bar item, no extra memory. Team commands are contributed and registered but only explain how to enable Team Mode when invoked without a team. The existing suite stays unchanged and green; a test asserts that activation in a solo project creates no team storage and starts no timers.
- **D-25:** `NEAR AI: Verify Team Log` (`nearAi.team.verifyLog`) re-fetches, replays and re-verifies the whole log from genesis, then shows the result (events, members, head, and the Rejected events list with reasons) in a dedicated `NEAR AI Team` output channel, with a notification summary. The status bar item (`Team: …`) shows `Team sync paused: remote unreachable` (with the git error reason in the tooltip, secrets redacted) when fetch/push fails, backing off exponentially to 10 minutes and retrying on focus. No empty `catch`: every failure is reported to the output channel or the user.
- **D-26:** Accepted roster events are mirrored into the existing `AuditStore` with a new audit event type `team-roster` (member attribution, no secrets). Rejected events are recorded in the output channel and diagnostics, not as audit events. Other team audit types (`claim`, `lease`, `integration`, `allocation`, `team-stop`) are added in their phases.
- **D-27:** Snapshots: the format (`snapshots/<lamport>.json`, signed materialised state with `coversThrough` event id and `stateHash`) and loader are built here; a snapshot is accepted provisionally and the client still replays from genesis in the background (verifyLog always replays fully). Writing is done by an owner or lead client every 500 events (the `integrator` lease does not exist until Phase 65; the snapshot writer moves to the integrator then).
- **D-28:** Phase 60 success criterion 2 ("two VS Code instances on two clones") is proven in `node --test` with two independent team-core clients (no `vscode`) on two clones of one local bare repo; the two-window VS Code scenario is the Phase 67 e2e (`npm run test:e2e` gating starts in Phase 62). Concurrency test: N child-process clients (`node:child_process.fork`) appending concurrently to one local bare repo; assert every event is present exactly once, history is linear and no push was forced. Property tests use a small seeded PRNG written in the test (no dependency).

### Claude's Discretion

- Exact module split inside `src/team/` beyond the files listed in spec 5.1, the shape of helper functions, and output-channel wording (plain language, no em-dashes).
- Whether `teamStatusBar.ts` lives in `teamSession.ts` until Phase 62 adds board counts.

### Deferred Ideas (OUT OF SCOPE)

- Ownership transfer between members (not in the spec's 6.3 matrix as an action) - candidate for a later 0.6.x release.
- Custom coordination ref (`refs/near-ai/coordination`) as the default - format supports it (D-01); switching the default waits for host compatibility evidence.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TEAM-01 | A lead can enable Team Mode on an initialised project; solo projects behave exactly as before. | Enable flow ordering and the `git add -f` + `commit --only` recipe (verified), lazy-activation design (D-24), `team.json` validation as untrusted input, solo-parity test design (Validation Architecture). |
| TEAM-04 | Every client verifies every coordination event's signature and the author's permission at that point in the log. | Ed25519 calls verified on Node 22, canonical JSON implementation and pitfalls, validation pipeline design with positional roster state, bulk read recipe, rewrite detection, two-clone and forgery test designs. |
| SEC-01 | No secret is written to the log, team.json, settings or audit. | Gap analysis of `redactSecrets` (it detects almost none of the required shapes), `assertNoSecrets` design as a write-side-only check, canary test design that scans every git object, remote-URL userinfo leakage, error redaction. |
| SEC-04 | Role permissions in section 6.3 are enforced on write and on read. | Matrix to action/event mapping, lead-vs-owner rules including device events, policy cells, table-driven test design, single `decideTeamAction` call sites. |
</phase_requirements>

## Summary

Everything Phase 60 needs exists in Node 22 built-ins and the system `git`; no dependency is needed. Ed25519 generate, JWK/SPKI raw-key export, PKCS#8 DER round trip, `sign(null, ...)`/`verify(null, ...)` and base64url encodings all work exactly as D-06/D-14 describe on Node 22.22.1 and 24.22.2. A 40-line canonical JSON function (default `Array.prototype.sort` already is UTF-16 code unit order) covers D-06 once it adds three guards the spec does not mention: a nesting-depth limit (a 16 KB event can nest 8000 levels and a naive recursive canonicaliser throws `RangeError`), lone-surrogate rejection, and `-0` rejection.

The git design in D-16/D-17 works, with five findings that change how the transport must be written. (1) The retried event must be rebuilt and re-signed, not re-sent: a losing writer's Lamport value and `prev` are stale, and under D-03 its own signed event would be rejected after rebase, so `append` must take a builder/revalidate callback that returns fresh signed events, not a fixed array. (2) A push can lose the compare-and-swap in three different wordings, and a local bare remote produced all three in testing: `[rejected] (non-fast-forward)`, `[rejected] (fetch first)` and `[remote rejected] (incorrect old value provided)`; the last is a retryable race even though it starts with `remote rejected`. (3) Several clients sharing one mirror directory on one machine make `git fetch` itself fail (`error: fetching ref refs/team/coordination failed: incorrect old value provided`), so serialise per mirror in-process and treat that fetch error as retryable. (4) The user's global git config leaks into the mirror: a global `core.hooksPath` with a failing `pre-push` hook broke the coordination push; set `core.hooksPath` locally on the mirror. (5) The configured retry budget of 5 is too small for a thundering herd in the concurrency test (a straggler needed 7 attempts with only 4 clients), so make it an option and let the test pass a larger value.

The existing code reuses well but has three traps: `redactSecrets` is a redactor that matches only `bearer ...`, `rpt-` and key/value forms, so it misses `sk-`, `rt_`, `adm_`, `oc_`, JWTs, PEM and PKCS#8 (and must not be edited, solo parity); `AuditStore` is not constructed anywhere in production code today (only tests) so Team Mode is its first runtime user and must dedupe on replay; and `src/agent/worktree.ts` `git()` trims output and drops exit codes, so it cannot be reused as `runGit`. Spec 5.2 does not actually define event bodies even though D-07 refers to "the `TeamEventBody` map from spec 5.2", and D-13's `safetyFactor: 1.25` / `overrunFactor: 1.5` are floats that D-06's canonicaliser will reject; both need explicit design decisions in planning (recommendations below).

**Primary recommendation:** Build bottom-up in this order, each step independently testable with `node --test`: `canonical` + `identity` (crypto), `types` + `permissions` + `secrets`, `materialize` (validation pipeline, incremental `applyEntry`), `runGit` + `gitTransport` (real git, two clones, then the fork concurrency test), `eventLog` (build/sign/append facade), then the VS Code adapters (`registerTeamMode`, enable, verify, status bar, audit mirror) and `package.json` contributions last.

## Architectural Responsibility Map

This is a VS Code extension, not a web app; tiers below are the extension's own layers plus the remote.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Canonical JSON, envelope/body schema, validation, `reduce`, role matrix | `src/domain/team/` (pure) | none | D8: testable under plain `node --test`, no I/O. `node:crypto` verify/hash is allowed here (precedent: `src/domain/auth.ts` imports `createHash`). |
| Device key generation, sign, key storage | `src/team/identity.ts` (Node) | SecretStorage via `SecretStorageLike` | Private key must only ever live in SecretStorage; module stays `vscode`-free by taking the interface. |
| Event build/sign/Lamport stamping/append orchestration | `src/team/eventLog.ts` | transport | Needs state head (accepted-only Lamport) and signer; no VS Code. |
| Git fetch/commit/push, polling cursor, rewrite detection | `src/team/gitTransport.ts` + `runGit` | project repo (read-only: remote URL) | Dedicated bare mirror; never touches the user's working tree. |
| Enable flow prompts, commit of `team.json`, notifications | `src/services/team/teamCommands.ts` | `teamSession.ts` | Only layer that may import `vscode`. |
| Polling timers, window-focus triggers, status bar, output channel | `src/services/team/teamSession.ts` / `teamStatusBar.ts` | `vscode.window.state` | Timers and UI belong in the adapter; core takes an injectable scheduler. |
| Audit mirroring of accepted roster events | `teamSession.ts` -> `AuditStore` | `src/domain/approval.ts` type union | Store is workspace-local (`.planning/.near-ai/audit.json`). |
| Trust anchor (genesis pin) | `.planning/.near-ai/team.json` in the code repo | local TOFU pin in extension storage | Anchor is only as strong as write access to the code branch; local pin catches later tampering. |
| Total order and CAS | Remote git ref | none | A non-force push of a descendant commit is the atomic compare-and-swap. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | Node 22.22.1 verified (also 24.22.2) | Ed25519 keygen/sign/verify, SHA-256, `randomBytes` for ULID and ids | Built in; D-05/D-06/D-14 require it; zero dependencies. [VERIFIED: node 22.22.1 experiments in this session] |
| `node:child_process` (`spawn`) | built in | `runGit` with stdin support, exit codes, timeout, AbortSignal | `execFile` cannot feed stdin to `hash-object --stdin`/`cat-file --batch`; `spawn` can. [VERIFIED: prototype ran 4-10 concurrent clients] |
| system `git` | 2.53.0 verified here | Mirror, plumbing, push CAS | Required by D-16/D-17. All commands used exist since git 2.0 except none newer [ASSUMED for old versions]. |
| `node:test` + `node:assert/strict` | built in | Tests | Repo standard (TESTING.md). |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:fs/promises`, `node:path`, `node:os` | built in | `team.json` atomic write (temp then rename), mirror dirs, `mkdtemp` in tests | Same pattern as `contextGraphStore.ts` and `auditStore.ts`. |
| `node:child_process` `fork` | built in | Concurrency test children | Verified to work under `node --test` with empty `execArgv`. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `git` CLI plumbing | `isomorphic-git` / `nodegit` | New runtime dependency and SBOM entry, no credential-helper reuse; rejected by CONTEXT (no new runtime dependency). |
| Hand-written validators | `zod` / `ajv` | New dependency; rejected. Use small exact-key validators. |
| `ulid` package | local 15-line ULID | D-05 mandates local generation. |

**Installation:** none. `npm install` is not part of this phase.

**Version verification:** no external packages, so the registry check is not applicable. Runtime facts verified: `git --version` = `git version 2.53.0`; `/usr/bin/node` = `v22.22.1` (OpenSSL 3.5.5); default PATH `node` = `v24.22.2`. The repo engine floor is `"vscode": ">=1.101.0"` [VERIFIED: package.json:21-23 `"engines": {` / `"vscode": ">=1.101.0"`], which `CONCERNS.md` ties to Node 22+ [CITED: .planning/codebase/CONCERNS.md "VS Code engine floor"].

## Package Legitimacy Audit

No external packages are installed in this phase (CONTEXT: "no new runtime dependency in this phase"; no devDependency is needed either).

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| none | - | - | - | - | - | - |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
 Enable Team Mode (command)                            Poll timer / window focus / after-append
        |                                                         |
        v                                                         v
 teamCommands.ts --prompts--> teamSession.ts  <--onUpdate-- CoordinationTransport (interface)
        |   (vscode adapter)      |  ^   |                         ^
        |                         |  |   +--> AuditStore (team-roster, deduped by event id)
        |                         |  +------> OutputChannel "NEAR AI Team", StatusBar item
        v                         v
   eventLog.ts  --build(state)--> signed events --append(build)--> gitTransport.ts
   (Lamport = state.head.lamport+1,                                   |
    sign w/ identity.ts; assertNoSecrets;                             |  per-mirror mutex
    size <= 16 KB)                                                    v
        ^                                             +---- runGit (spawn, GIT_TERMINAL_PROMPT=0, LC_ALL=C, timeout) ----+
        |                                             |  1 URL <- `git remote get-url --push <remote>` in project repo   |
   materialize.ts                                     |  2 fetch +ref:refs/team/coordination into bare mirror            |
   reduce / applyEntry                                |  3 rewrite check: old head is ancestor of new head?              |
   (schema -> teamId -> device -> sig ->              |  4 build commit: hash-object -w, temp GIT_INDEX_FILE,            |
    lamport -> decideTeamAction -> refs)              |    read-tree, update-index --cacheinfo, write-tree, commit-tree  |
        ^                                             |  5 push --porcelain <sha>:refs/heads/near-ai/coordination        |
        |                                             |  6 classify: ok | CAS-lost (retry+rebuild) | permanent | offline |
   permissions.ts (decideTeamAction)                  |  7 read: log --first-parent --reverse --raw -z + cat-file --batch|
   canonical.ts, secrets.ts, types.ts                 +------------------------------------------------------------------+
                                                                      |
                                                                      v
                                          project git remote: refs/heads/near-ai/coordination (orphan, linear)
                                          events/<12-digit lamport>-evt-<ulid>.json | snapshots/<lamport>.json | team.json
```

### Recommended Project Structure

```
src/domain/team/              # pure (node:crypto allowed for hash/verify only)
  types.ts                    # Role, TeamEventType (full union), TeamEventBody (implemented bodies + placeholders), TeamPolicy, TeamState, Member, DeviceKey
  canonical.ts                # canonicalize(), canonicalBytes(), MAX_DEPTH, limits
  secrets.ts                  # findSecrets()/assertNoSecrets() - write-side only, NOT used by reduce
  permissions.ts              # TeamAction union, decideTeamAction() (entire 6.3 matrix)
  policy.ts                   # defaultTeamPolicy(), policy field validators (basis-point integers)
  validate.ts                 # envelope + per-type body validators (exact keys), path-name validator
  materialize.ts              # createState(genesis), applyEntry(state, entry), reduce(entries, genesis), serialiseState(), stateHash()
src/team/                     # Node I/O, no vscode
  identity.ts                 # generateDeviceKey, loadDeviceKey(SecretStorageLike), sign, publicKeyOf, fingerprint
  ids.ts                      # ulid(), memberId(), teamId(), eventId()
  runGit.ts                   # spawn wrapper -> { code, stdout: Buffer, stderr: string }; env hardening; error classifier
  transport.ts                # CoordinationTransport, CommittedEntry, AppendResult, TransportStatus
  gitTransport.ts             # mirror lifecycle, fetch/read/append/push, rewrite detection, mutex, backoff helpers
  eventLog.ts                 # TeamLog: sync(), append(build), snapshot load/write, verifyAll()
src/services/team/            # vscode adapters
  teamSession.ts              # lifecycle, scheduler (setTimeout chain), focus handling, audit mirror, output channel
  teamCommands.ts             # nearAi.team.enable, nearAi.team.verifyLog; solo "how to enable" message
  teamStatusBar.ts            # (or folded into teamSession.ts)
src/test/                     # flat *.test.ts (one process per file)
  helpers/teamHarness.ts      # two-clone repo factory, MemorySecrets, client factory (no .test suffix: not run by the glob)
  helpers/teamAppendChild.ts  # fork target for the concurrency test
```

### Pattern 1: Ed25519 identity (verified calls)

**What:** Generate, export raw 32-byte public key, round-trip the PKCS#8 private key through SecretStorage, sign/verify with the `null` algorithm.
**When to use:** `identity.ts` and `domain/team/crypto` verification.
**Example:**

```typescript
// Source: calls executed on Node v22.22.1 and v24.22.2 in this session (all printed true / expected lengths)
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, KeyObject } from 'node:crypto';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // 12 bytes + 32 raw = 44-byte SPKI

export function generateDeviceKey(): { privateKey: KeyObject; publicKeyRaw: Buffer; secret: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url'); // 32 bytes
  const secret = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');            // 48-byte DER -> 64 chars, starts "MC4CAQAwBQYDK2VwBCIEI"
  return { privateKey, publicKeyRaw, secret };
}
export function loadPrivateKey(secret: string): KeyObject {
  const key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Stored team device key is not an Ed25519 key.'); // createPrivateKey also accepts RSA etc.
  return key;
}
export const publicKeyOf = (privateKey: KeyObject): Buffer => Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
export const publicKeyObject = (raw: Buffer): KeyObject => createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' }); // throws on length != 32
export const fingerprintOf = (raw: Buffer): string => `dev-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}`;
export const signBytes = (key: KeyObject, bytes: Buffer): string => edSign(null, bytes, key).toString('base64url'); // 86 chars, deterministic
export const verifyBytes = (pub: KeyObject, bytes: Buffer, sig: string): boolean => edVerify(null, bytes, pub, Buffer.from(sig, 'base64url')); // wrong-length sig returns false, does not throw
```

Verified facts: raw key via JWK `x` equals the last 32 bytes of the SPKI DER (`same raw true`); a 31-byte key throws `Failed to read asymmetric key`; an all-zero public key verifies `false`; signatures are deterministic; `JSON.stringify({key})` of a `KeyObject` prints `{}` (no accidental serialisation). Decoding is lenient: `Buffer.from(sig + '=', 'base64url')` equals the original, so enforce strict shapes before decoding: `sig` must match `^[A-Za-z0-9_-]{86}$`, public key `^[A-Za-z0-9_-]{43}$`, and round-trip (`Buffer.from(s,'base64url').toString('base64url') === s`) to reject non-canonical encodings. [VERIFIED: node 22.22.1]

### Pattern 2: Canonical JSON (JCS-style, safe integers only)

**What:** Recursive serialiser; sort keys with the default `Array.prototype.sort()` (which compares UTF-16 code units, exactly what D-06 says); strings through `JSON.stringify` (RFC 8259 escaping, lower-case `\u00xx` for controls, does not escape U+2028/2029 or non-ASCII, escapes lone surrogates as `\udXXX` only if you let it, so reject them instead).
**Pitfalls it must handle (all exercised):** `-0` (`Number.isSafeInteger(-0)` is true, `String(-0)` is `"0"`, so check `Object.is(v,-0)`); `2**53` and floats; `NaN`; `undefined`, functions, `bigint`, `Date`, class instances (only plain objects/null-prototype); sparse arrays; Symbol keys are silently skipped by `Object.keys` (acceptable, but keep schemas exact so they never matter); `JSON.parse('{"a":1,"a":2}')` keeps the last duplicate, so verify the file bytes equal `canonicalize(parsed)` and reject otherwise; `JSON.parse('{"__proto__":1}')` creates an own property, so never copy parsed objects with `Object.assign`/spread into `{}` and use exact-key validators.
**Depth:** a 16 KB event can nest 8000 arrays. `JSON.parse` handles it but a recursive canonicaliser throws `RangeError` (verified). Enforce `MAX_DEPTH = 16` while canonicalising (or in the schema pass first) and wrap parse+validate in `try/catch` mapping any exception to the rejected reason `malformed event`.
**Example:**

```typescript
// Source: implementation executed in this session (outputs: sorted keys, UTF-16 order {"Z","a","b","é","😀","ﬁ"}, -0 and 2**53 rejected)
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const MAX_DEPTH = 16;
export function canonicalize(value: unknown, path = '$', depth = 0): string {
  if (depth > MAX_DEPTH) throw new TypeError(`${path}: nested too deeply`);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError(`${path}: numbers must be safe integers`);
      return String(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new TypeError(`${path}: lone surrogate`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${Array.from({ length: value.length }, (_, i) => {
          if (!(i in value)) throw new TypeError(`${path}[${i}]: sparse array`);
          return canonicalize(value[i], `${path}[${i}]`, depth + 1);
        }).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`${path}: only plain objects are allowed`);
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => {
        if (LONE_SURROGATE.test(key)) throw new TypeError(`${path}: key has a lone surrogate`);
        if (record[key] === undefined) throw new TypeError(`${path}.${key}: undefined is not allowed`);
        return `${JSON.stringify(key)}:${canonicalize(record[key], `${path}.${key}`, depth + 1)}`;
      }).join(',')}}`;
    }
    default: throw new TypeError(`${path}: ${typeof value} is not allowed`);
  }
}
```

The blob written to git is exactly `canonicalize(envelopeWithSig)` with no trailing newline (git blobs are exact bytes; the string has no raw CR/LF so `core.autocrlf` is irrelevant). On read: parse, `canonicalize(parsed) === blobText` else reject `event file is not canonical`. The signature input is `Buffer.from(canonicalize(envelopeWithoutSig), 'utf8')`.

### Pattern 3: runGit

**What:** One `spawn`-based helper returning `{ code, stdout: Buffer, stderr }`; never `shell: true`; stdin is `'ignore'` unless `input` is given (a piped stdin that git never reads caused `EPIPE` crashes in the prototype).
**Environment (all additive to `process.env`):** `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C` (stderr classification is English; `--porcelain` stdout is already stable), `GCM_INTERACTIVE=never` (Git Credential Manager) [ASSUMED], neutral committer identity vars for commit-building calls only (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`; no user config needed, verified with an empty `HOME`). Use `killSignal: 'SIGKILL'`-style hard timeout (SIGTERM on a hung `ext::` helper worked in 1.5 s; git helpers like `ssh` can linger, so kill the process tree on Windows with `taskkill` only if needed [ASSUMED]).
**SSH:** do not override `GIT_SSH_COMMAND` (it would defeat the user's `core.sshCommand`/`-i` key). If the user has none set, `ssh -o BatchMode=yes -o ConnectTimeout=10` avoids passphrase prompts. Because the mirror is a different repo, project-local `core.sshCommand`, `http.*` and `credential.*` settings are not inherited; read `core.sshCommand` from the project repo and pass it through `GIT_SSH_COMMAND` only if set. [ASSUMED: git config scoping semantics; not exercised]
**Existing helper is not reusable:** `src/agent/worktree.ts` `git()` trims stdout, uses `execFile` (no stdin) and rejects with a plain `Error` that drops the exit code [VERIFIED: src/agent/worktree.ts:14-20, quote: `execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {` / `if (error) reject(new Error(\`git ${args[0]} failed: ${String(stderr).trim() || error.message}\`));`]. Use it only as the style template (timeout, `GIT_TERMINAL_PROMPT`).
**Testability:** make `runGit` an injected `GitRunner` function type so transport unit tests can inject faults (offline, auth failure, lock contention) alongside the real-git integration tests.

### Pattern 4: Mirror lifecycle (fetch, rewrite check, commit, push)

```typescript
// Verified command sequence (git 2.53.0). REF = 'refs/heads/near-ai/coordination' (from team.json coordination.ref), LOCAL = 'refs/team/coordination'.
// init (once):   git init --bare -q <mirror>
//                git --git-dir <mirror> config core.hooksPath <mirror>/hooks   # global hooksPath with failing pre-push broke the push in testing
//                git --git-dir <mirror> config gc.autoDetach false            # [ASSUMED] avoid detached background gc holding the dir
// URL:           git -C <project> remote get-url --push <remote>               # expands insteadOf (verified); exit 2 "No such remote"
// ref probe:     git ls-remote --exit-code <url> <REF>                         # exit 2 = ref absent (locale independent); 128 = error
// fetch:         git --git-dir <mirror> fetch --no-tags --quiet <url> +<REF>:<LOCAL>
//                  absent ref -> exit 128 "fatal: couldn't find remote ref ..." ; the leading + lets a rewritten branch land so YOU detect it
// rewrite check: old=$(rev-parse -q --verify LOCAL) BEFORE fetch; after: git merge-base --is-ancestor <old> LOCAL  (0 yes, 1 no, 128 unknown object)
// build commit:  GIT_INDEX_FILE=<unique tmp> read-tree <head>   (skip for genesis)
//                echo -n <canonical> | hash-object -w --stdin                  # --stdin implies no filters (autocrlf irrelevant)
//                update-index --add --cacheinfo 100644,<blob>,events/<12d>-<id>.json
//                write-tree ; commit-tree <tree> [-p <head>] -m "team: <type> <eventId>"   (identity env vars; commit.gpgsign does NOT affect commit-tree)
// push:          git --git-dir <mirror> push --porcelain <url> <commit>:<REF>   (never --force)
```

Push outcome classification (stdout lines of `--porcelain`, flag column is the first character; exit 1 on any `!`):

| Porcelain line (verified) | Meaning | Action |
|---|---|---|
| `*\t<sha>:<ref>\t[new branch]` / ` \t<a>..<b>` exit 0 | success | done |
| `=\t...\t[up to date]` exit 0 | our commit already there | treat as success (idempotent) |
| `!\t...\t[rejected] (non-fast-forward)` | someone appended first | fetch, rebuild, retry |
| `!\t...\t[rejected] (fetch first)` | remote has objects we lack (race) | fetch, rebuild, retry |
| `!\t...\t[remote rejected] (incorrect old value provided)` | server-side ref-lock race | fetch, rebuild, retry |
| `!\t...\t[remote rejected] (<other>)` (hook declined, protected branch, deny) | permanent | stop, show reason (genesis: "remote refuses the coordination branch") |
| no `!` line, stderr `could not read Username ... terminal prompts disabled` | auth | paused: "git needs credentials" |
| stderr `unable to access ... 403 / repository ... not found / Could not resolve host / Failed to connect / Permission denied (publickey)` | unreachable or denied | paused/offline with redacted reason |

At genesis a rejected push means the branch already exists: stop with "This remote already has a coordination log" (verified: divergent orphan genesis -> `[rejected] (non-fast-forward)`, exit 1).
Retry rules: on every retry re-fetch, re-run the full validation pipeline against the new head, and call the builder again so Lamport and `prev` are fresh and the event is re-signed. Before rebuilding, check whether the batch's event ids are already in the log (a push whose response was lost may have landed) and return success if so.

### Pattern 5: Bulk read of the log (one `git log`, one `cat-file --batch`)

```typescript
// Verified output shape (git 2.53.0): records are  \x01<sha>\0<ct>\0\n  then  :<mode> <mode> <oldsha> <newsha> <status>\0<path>\0 ...
// git --git-dir <mirror> log --first-parent --reverse --no-renames --raw -z --no-abbrev --format=%x01%H%x00%ct [<oldHead>..]<LOCAL>
//   - 405 commits parsed in 100 ms; works for the root commit (no --root flag needed); paths with quotes/non-ASCII are raw with -z
//   - files inside one commit come out in byte order of the path = the filename order D-03 requires
//   - a merge commit shows its diff against the FIRST parent (second-parent history is ignored, flag commits with >1 parent)
// sizes first:  printf '<blob>\n...' | git cat-file --batch-check='%(objectname) %(objecttype) %(objectsize)'   (skip blobs > 16 KB for events)
// contents:     printf '<blob>\n...' | git cat-file --batch   -> "<sha> blob <size>\n<bytes>\n" per object; missing -> "<sha> missing"
```

Process only `A` (added) entries under `events/`, `snapshots/` and the root `team.json`. A later commit that modifies (`M`), deletes (`D`) or adds an unexpected path is a repository-level anomaly: surface it as a diagnostic row (`reason: "history changed an existing coordination file"`), never as state. Read the blob named by the adding commit (the `newsha` column), never the head tree, so later tampering with a file cannot rewrite what a past event said. Incremental sync reads `oldHead..newHead` only after the ancestor check passes.

### Pattern 6: Validation pipeline and materializer shape

- `applyEntry(state, entry)` mutates a state the caller owns and returns a verdict (accepted or `{ eventId, reason }`); `reduce(entries, genesis)` builds a fresh state and folds. Copy-per-event is O(n^2) at 50k events; incremental polling must reuse the live state and only apply new entries. Serialising for hashing and snapshots goes through one `serialiseState()` that turns `Map`s into key-sorted arrays (Map iteration order is insertion order, which is the log order here, but sort anyway so snapshots are byte-stable).
- Check order is D-09. Reasons are fixed strings (tests assert them). Unparseable or non-canonical files are rejected with `eventId = <path>` and reason `malformed event`.
- State needed beyond spec 7 `TeamState`: `seenEventIds`, device index `fingerprint -> { memberId, publicKey, revokedAtEvent? }`, `highLamport` (accepted events only), genesis metadata, member `removedAt`. Rejected events must not move `highLamport` (otherwise a forged event with a huge Lamport poisons every later honest event).
- Lamport: honest builders use `state.head.lamport + 1 (+ i for a batch)`. Recommended extra rule (hardening, within D-03's spirit): reject `lamport > accepted high + 1000` as `lamport jump too large` so a member cannot push the 12-digit file name space to its limit. Also reject `lamport > 999999999999` and require the file name's lamport and event id to equal the envelope's.
- Duplicate event id (same id appearing twice) -> reject `duplicate event id` (replay of an old event within the same team; it is also caught by the Lamport rule).
- Verify cost: 10,000 verifies took about 5.2 s (0.5 ms each) and 10,000 canonicalise+sign about 2.2 s [VERIFIED: perf run]; creating the `KeyObject` per event is not the bottleneck (5.3 s vs 5.2 s). So: verify incrementally, yield to the event loop every ~200 events during a full replay in the extension host (`await new Promise(setImmediate)`), and treat `verifyLog` as an explicit, progress-reporting operation. A persistent "blob sha already signature-verified" cache is an optional later optimisation, not needed for correctness.
- Secret scanning is NOT a validation check on read. If it were, a new detector pattern in a later release would change which events are accepted and break the "same sequence in, same state out" guarantee across versions. Scan on write (throw) and, on read, only report a warning in `verifyLog`.

### Pattern 7: Event bodies (spec 5.2 lists types but no bodies; D-07 needs them)

Recommended exact-key bodies for the ten implemented types (all integers safe, strings length-capped, no free text beyond names/notes). These are design recommendations for the planner to confirm [ASSUMED].

| Type | Body | Authorisation (via `decideTeamAction`) | Reference checks |
|---|---|---|---|
| `team.created` | `{ name, ownerId, ownerName, ownerEmails: string[], ownerDevice: { fingerprint, publicKey }, policy: TeamPolicy, near?: {organizationId, workspaceId} }` | Only valid as the first event; author = `ownerId`; signed by `team.json` genesis key (D-10) | `ownerDevice.fingerprint == fingerprintOf(publicKey)`; equals the pinned anchor |
| `member.joined` | `{ memberId, name, emails: string[], role, device: { fingerprint, publicKey } }` | Phase 60: only `role: 'owner'`, only as the second event, only by the owner | memberId not present |
| `member.role-changed` | `{ memberId, role }` | `member.change-role`; target not owner; new role in lead/developer/reviewer/observer; no self-change | member exists, not removed |
| `member.removed` | `{ memberId }` | `member.remove`; target not owner | member exists, not removed |
| `device.added` | `{ memberId, device: { fingerprint, publicKey } }` | author's own active device (`memberId == author`) or lead/owner; a lead may not add devices for the owner (otherwise a lead can sign as owner) | member exists; fingerprint unused; derived fingerprint matches |
| `device.revoked` | `{ memberId, fingerprint }` | same rule as `device.added`; refuse revoking the member's last active device (use `member.removed`) | device bound to that member, not already revoked |
| `member.availability` | `{ availability, workingHours?: { tz, days: number[], start, end } }` | self only | - |
| `member.skills` | `{ memberId, skills: string[] }` | self, or lead/owner for others [ASSUMED] | member exists |
| `policy.changed` | `{ changes: Partial<TeamPolicy> }` | owner only (`policy.change`) | each key validated by `policy.ts` |
| `snapshot.written` | `{ coversThrough: eventId, lamport, stateHash, path }` | owner or lead (Phase 60 writer) | `coversThrough` exists in the log |

Policy storage: D-13's `safetyFactor: 1.25` and `overrunFactor: 1.5` are floats and the canonicaliser rejects floats (D-06). Store them as integer basis points (`safetyFactorBp: 12500`, `overrunFactorBp: 15000`) like `reconcileToleranceBp: 500`. Dispatch weights in basis points summing to 10000: roleFit 3000, fileAffinity 2500, continuity 1500, capacity 1500, budgetHeadroom 1000, criticalPath 500 (spec 6.6 formula). `allowedModels` has no stated default; use empty arrays per role meaning "no restriction" [ASSUMED]. Developer-integrator policy cell needs a field the spec 7 `TeamPolicy` does not have; add `developerMayIntegrate: false` [ASSUMED].

### Pattern 8: Permission matrix as data

`decideTeamAction(state, actorId, action)` returns `{ allowed, reason? }`. Implement the matrix as a `Record<ActionKind, Record<Role, Rule>>` table where a rule is `true | false | 'policy:<field>' | 'conditional'`, then a few explicit overrides (lead vs owner, self-only, own-work). The table-driven test enumerates every (role, action) cell. Spec 6.3 rows (copied from the spec, lines 227-242) map to action kinds: view board/own metrics; view all metrics (policy `peerMetricsVisible` for developer and reviewer); member invite/remove/change-role (owner Y, lead Y except on owner); create/edit/estimate item (developer only for own drafts); claim ready items (reviewer: review items only); assign others; manual lease; submit review (not own work for developer, reviewer); approve out-of-scope merge; hold `integrator` (developer by policy); set budgets/allocations (lead within team budget); request allocation (all except observer); `team.stop` (everyone but observer) vs `team.resume` (owner and lead only); change policy (owner only). Removed members are denied everything (look up `removedAt`). Roster self-service actions not in the matrix (`member.availability`, `device.add/revoke` by self) are allowed to the member themselves regardless of role.

### Pattern 9: Lazy activation and solo parity

`workspaceContains:.planning/.near-ai/**` already gates activation [VERIFIED: package.json:56-58 `"activationEvents": [` / `"workspaceContains:.planning/.near-ai/**"` / `],`], and `.planning/.near-ai/team.json` matches that glob, so a teammate's fresh clone of a team project activates the extension with no extra activation event. `registerTeamMode(context)` (one call in `src/extension.ts`, next to `registerSpendTracking(context, auth);` at line 56) must, synchronously: register the two commands, and nothing else. Asynchronously and only for the first workspace folder: `fs.stat(<root>/.planning/.near-ai/team.json)` with the failure reported to an output channel line (no empty catch); if present, load the heavy modules lazily with `await import('./team/teamSession')` (TypeScript with `module: commonjs` compiles this to a deferred `require`), start the session, create the status bar item, schedule the first poll. If absent: no timers, no mirror, no globalStorage writes, no status item. The command handlers also lazy-import. The e2e suite asserts every contributed command is registered [VERIFIED: src/test/e2e/suite.ts:53-55 `const contributed = (extension.packageJSON.contributes.commands as Array<{ command: string }>).map((entry) => entry.command);` / `assert.deepEqual(contributed.filter((command) => !registered.has(command)), [], 'contributed commands without a handler');`], so both commands must be registered at activation even in solo projects (D-24).

Commands show as `NEAR AI: Enable Team Mode` when contributed with `"category": "NEAR AI"` (existing entries use `{"command":"nearAi.compareModels","title":"Compare Models","category":"NEAR AI","icon":"$(beaker)"}`, package.json:199-204). Add the setting `nearAi.team.pollSeconds` (`type: number`, `default: 15`, `minimum: 5`, `maximum: 3600`, `"scope": "application"` so a workspace's `.vscode/settings.json` cannot make a client hammer the remote). Existing settings declare no scope; `application` is a deliberate difference. Re-read the setting on `onDidChangeConfiguration`.

### Anti-Patterns to Avoid

- **Re-sending a pre-signed event on retry:** stale Lamport/`prev`; the event would be rejected by D-03 after the rebase. Rebuild and re-sign.
- **Editing `src/domain/redaction.ts`:** changes solo behaviour in unrelated callers (it is imported by `nearAiClient.ts`, `chatBridge.ts`, `profileStore.ts`, `activityStore.ts`, `analyticsStore.ts`, `privacyPreflight.ts`, `agentActivity.ts` and `extension.ts`). Add `src/domain/team/secrets.ts` and reuse `redactSecrets` by difference.
- **`catch {}` swallowing:** CONCERNS.md lists 13 empty catches as debt; every new failure path goes to the output channel/status.
- **Persisting the remote URL or any git stderr unredacted:** URLs can carry `user:token@` userinfo. Store only the remote name; strip `//user[:pass]@` and run `redactSecrets` before any display, log, tooltip or audit.
- **Trusting `team.json` fields as arguments:** validate `remote` against `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`, `ref` against `^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$` or `^refs/near-ai/...$` without `..`, `teamId` against `^team-[0-9a-f]{32}$`; pass refs after `--`-safe positions; never build a shell string.
- **Reading event files from the head tree:** read the blob from the commit that added it.
- **One mutable shared mirror ref without serialisation:** see Pitfall 3.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Signature scheme | Any custom signing/hash chain | `node:crypto` Ed25519 | D-06; constant-time, standard, deterministic. |
| Git packing/transport | A packfile or HTTP client | `git` CLI | Reuses the user's credential helpers, proxies, SSH config. |
| Compare-and-swap | A lock service or lease on the branch | Non-force `git push` of a descendant commit | The remote ref update is the atomic CAS (D2). |
| Reading many blobs | One `git show` per event | `git log --raw -z` + `git cat-file --batch` | 405 commits in 100 ms; per-event spawns cost seconds, much worse on Windows. |
| Secret detection for code paths already covered | Re-deriving token regexes | Reuse `redactSecrets` by difference + one new additive pattern list | Single source of truth; patterns for `eyJ...`, `sk-`, PEM already exist in `agentActivity.ts:128-129` and `shell.ts:141` (not exported). |
| Atomic file write | `fs.writeFile` directly | temp file then `rename` (as `contextGraphStore.ts`, `auditStore.ts`) | Crash safety for `team.json`. |
| JSON Schema | `zod`/`ajv` | exact-key hand validators (~100 lines) | No new dependency. |

**Key insight:** the only genuinely custom code is the validation pipeline and canonicalisation; everything with a security or concurrency subtlety (signing, CAS, credentials, packing) is delegated to `node:crypto` and `git`.

## Runtime State Inventory

Not a rename/refactor/migration phase (greenfield modules plus additive hooks). Skipped. The only existing data touched is additive: one enum literal in `AuditEventType` and its duplicate list in `auditStore.ts`, plus a new `team.json` file.

## Common Pitfalls

### Pitfall 1: Stale Lamport after a lost race
**What goes wrong:** Client B built Lamport 11 on head 10; client A's event (Lamport 11) lands first; B re-pushes the same signed event on the new head; every client rejects it ("Lamport not greater than highest seen") and B believes it succeeded.
**Why it happens:** D-17 says "retry" but D-03 makes the Lamport position-dependent.
**How to avoid:** `append(build)` where `build(state, head)` returns freshly signed events (or a conflict reason) on every attempt; the facade computes `lamport = state.head.lamport + 1 + i` from accepted-only state. If the interface must keep the D-18 name, make `revalidate` that builder.
**Warning signs:** retry tests where the second client's event shows up under "Rejected events".

### Pitfall 2: Three CAS-loss wordings, one of them under "remote rejected"
**What goes wrong:** Only matching `non-fast-forward` treats `(fetch first)` and `[remote rejected] (incorrect old value provided)` as fatal; the concurrency test fails sporadically (observed in 2 of 3 runs with 6 clients: 3-7 remote-rejected lines per run).
**How to avoid:** classify via the porcelain table above; unknown `[remote rejected]` reasons are permanent, the listed lock-race reasons are retryable. [VERIFIED: local bare remote]. Hosted remotes (GitHub, GitLab) may use other wording for the same race [ASSUMED]; keep the retryable list in one constant and surface the raw redacted reason when unknown.

### Pitfall 3: Shared mirror directory under concurrent use
**What goes wrong:** With 10 processes sharing one mirror, `git fetch` failed 8-10 times per run with `error: fetching ref refs/team/coordination failed: incorrect old value provided`, plus extra non-fast-forward pushes. Two VS Code windows (or an agent and a window) on one machine share `<globalStorage>/team/<teamId>/coordination.git` under D-16.
**How to avoid:** (a) an in-process promise-chain mutex keyed by mirror path around fetch/commit/push; (b) treat that fetch error as retryable with a short jittered sleep; (c) unique temp index file per operation (`GIT_INDEX_FILE` inside the mirror dir with pid + random suffix, deleted in `finally`). A cross-process lock file is not required for correctness (all 10-client runs ended with every event once and a linear history) but (a)+(b) are. [VERIFIED: 3 runs of 10 clients x 5 events, 50/50 events each time]

### Pitfall 4: The user's global git config applies to the mirror
**What goes wrong:** Verified: a global `core.hooksPath` pointing at a failing `pre-push` hook makes the coordination push exit 1 (`PRE-PUSH-HOOK-RAN`). Also `push.followTags`, `url.*.insteadOf` and credential helpers apply (the helpers are wanted; the rest is noise).
**How to avoid:** `git config core.hooksPath <mirror>/hooks` at mirror init (verified to override); pass the URL explicitly with an explicit refspec so `push.default` and remote config do not matter. `commit.gpgsign=true` does not affect `commit-tree` (verified), so no signing prompt. `fetch.fsckObjects`/`transfer.fsckObjects` can be enabled on the mirror as cheap hardening [ASSUMED beneficial].

### Pitfall 5: Retry budget versus thundering herd
**What goes wrong:** With 4 clients started together and D-17's 6 total attempts (5 retries), the unluckiest client needed 7 attempts for its first event in 4 of 5 runs; with 8 clients the worst needed 6.
**How to avoid:** make `maxRetries` and `baseDelayMs` constructor options (defaults 5 and 200 per D-17); the concurrency test passes `maxRetries: 20, baseDelayMs: 25`. Assert on the end state only (every event once, linear), never on who won. Exhausted retries return `{ ok: false, kind: 'busy' }`, not a throw.

### Pitfall 6: Unobserved partial success
**What goes wrong:** The push lands but the response is lost (timeout/kill); the caller retries and appends a duplicate logical action (for example a second `member.availability`).
**How to avoid:** a rebuilt event gets a new id and signature (Pitfall 1), so the old event id cannot be searched for after a rebuild. Remember the commit sha of every attempt that was pushed; after each fetch, if any earlier attempt's commit sha is an ancestor of (or equal to) the new head (`git merge-base --is-ancestor <attemptSha> <head>`, verified to work), that attempt landed: return success and do not rebuild. Also treat porcelain `=` (up to date) as success.

### Pitfall 7: `EPIPE` and trimmed output
**What goes wrong:** Piping stdin to commands that never read it (`read-tree`) crashes the child with `EPIPE` (reproduced); trimming stdout breaks NUL-separated output.
**How to avoid:** `stdio[0] = 'ignore'` unless `input` is provided; return raw `Buffer` stdout; decode and split explicitly.

### Pitfall 8: Large flat `events/` directory
**What goes wrong:** Every append rewrites the root tree and the `events/` tree. Measured: events tree 76 KB at 1k events, 760 KB at 10k, 3.8 MB at 50k; append (read-tree through commit-tree) 270 ms, 705 ms, 1.1 s respectively; `ls-tree -r` stays under 120 ms. Network cost is mostly delta-compressed by git, local loose objects pile up.
**How to avoid:** acceptable for the spec's scale target (25 members, 10 appends/min sustained is about 14k events/day at the extreme; realistic teams are far lower). Document a soft limit of about 20k events per team, schedule `git gc --auto --quiet` inside the mirror mutex (for example every 100 successful operations and after `verifyLog`), and note that D-02's layout is locked; fan-out directories would need a layout version bump (relay in Phase 67 is the scale answer, spec 5.3).

### Pitfall 9: Credential prompts and hanging network
**What goes wrong:** `GIT_TERMINAL_PROMPT=0` stops terminal prompts only. SSH passphrase prompts, GUI askpass helpers and Git Credential Manager dialogs are separate. A hung host blocks until your timeout.
**How to avoid:** stdin `ignore`; `GCM_INTERACTIVE=never` [ASSUMED]; default `ssh -o BatchMode=yes` only when the user configured nothing; per-call timeouts (fetch/push 60 s, local plumbing 15 s) with `SIGKILL`; classification of the exact failures verified here: `fatal: could not read Username for 'http://...': terminal prompts disabled` (auth), `... returned error: 403`, `fatal: repository '...' not found`, `Could not resolve host`, `Failed to connect ... Could not connect to server`. Map to the status text `Team sync paused: remote unreachable` plus a redacted reason in the tooltip; auth gets the extra hint to run `git fetch` once in a terminal to cache credentials.

### Pitfall 10: `team.json` is attacker-influenced input
**What goes wrong:** `team.json` lives in the code repo; anyone who can push to the code branch can change `genesis.ownerDevice` and `coordination.remote`/`ref` and later joiners would trust a forged log, or an option-like `remote` such as `--upload-pack=...` reaches git.
**How to avoid:** strict validation at load (patterns above); a local trust-on-first-use pin of `{teamId, genesis.eventId, ownerDevice.fingerprint}` in extension storage that refuses a later `team.json` whose genesis differs from the pin; the genesis mismatch on the remote branch refuses the log wholesale (D-10). This is an honest limit: the anchor is exactly as strong as write control on the code branch.

### Pitfall 11: Enable flow partial failure
**What goes wrong:** D-20 pushes the coordination branch before committing `team.json`; a failing `commit-msg`/`pre-commit` hook (verified: exit 1, `commit-msg: rejected`) leaves a live team with no `team.json` in the repo, and `git add -f` has already staged the file.
**How to avoid:** order: preflight (including `ls-remote --exit-code` showing the branch is absent), generate keys and events in memory, store the key in SecretStorage, write `team.json` atomically, push, then commit. On commit failure keep `team.json` on disk, `git reset -q -- <file>` the staging, tell the user the exact manual command; a re-run of Enable finds `team.json` and reports the existing team (D-22). On push failure before any success, delete the stored key and `team.json`. After an ambiguous push failure, `ls-remote` to learn whether the branch exists before cleanup. Use a conventional commit message (`chore(team): enable NEAR AI Team Mode`) because projects with commitlint reject free-form text.

### Pitfall 12: AuditStore is unwired and not idempotent
**What goes wrong:** `AuditStore` has no non-test constructor call today [VERIFIED: grep `new AuditStore` over `src` excluding tests found nothing; `src/services/auditStore.ts:11` only defines the class], so Team Mode is its first runtime instance; `append` does not dedupe ids, so a replay on every startup would append every roster event again; the cap is 500 events (`MAX_EVENTS`).
**How to avoid:** derive the audit id from the team event id (`audit-team-<sha256(eventId).slice(0,16)>`, 80-char limit in `safeText`) and skip ids already present (`list({ type: 'team-roster' })`), or persist the last mirrored position; mirror only on first acceptance. `redactEvent` drops metadata keys matching `/(secret|token|key|password|prompt|command|context|output|path)/i`, so do not put `deviceKey`/`publicKey`-named keys there; use `memberId`, `role`, `eventType`, `eventId`, `lamport`. Add the literal in two places: `src/domain/approval.ts:9-12` and the array in `src/services/auditStore.ts:88`.

### Pitfall 13: Forward-compat divergence
**What goes wrong:** Between phases, a client that rejects a type it does not know ("unsupported event type for this version") and a newer client that accepts it will compute different states from the same log.
**How to avoid:** all eight Team Mode phases ship in one v0.6.0 release, so this only matters for dev builds; keep the diagnostic text telling the user to update the extension (D-07), and consider a `minClientProtocol` field later.

### Pitfall 14: Windows and path details [ASSUMED, not testable here]
Use `path.join` for the mirror, `--git-dir` with absolute paths, `windowsHide: true` on spawn, forward-slash paths inside the tree (`events/...`), no `:` or trailing dots in names (the ULID alphabet is safe), `core.longpaths` not required for the expected path length (~170 chars). CRLF is irrelevant because canonical JSON has no raw newlines. Tests that rely on POSIX hook scripts (the `pre-push` hooksPath test) should be skipped on `win32`.

## Code Examples

### Plumbing commit (genesis and normal), verified end to end

```typescript
// Source: executed against git 2.53.0 (genesis push [new branch], normal push fast-forward, batch commit with 2 events)
async function commitFiles(git: GitRunner, mirror: string, files: Record<string, string>, parent: string | undefined, message: string): Promise<string> {
  const index = path.join(mirror, `idx-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index, ...NEUTRAL_IDENTITY };
  try {
    if (parent) await must(git(['--git-dir', mirror, 'read-tree', parent], { env }));
    for (const [name, content] of Object.entries(files)) { // caller passes files already validated against the path regexes
      const blob = text(await must(git(['--git-dir', mirror, 'hash-object', '-w', '--stdin'], { env, input: content })));
      await must(git(['--git-dir', mirror, 'update-index', '--add', '--cacheinfo', `100644,${blob},${name}`], { env }));
    }
    const tree = text(await must(git(['--git-dir', mirror, 'write-tree'], { env })));
    return text(await must(git(['--git-dir', mirror, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env })));
  } finally { await rm(index, { force: true }); }
}
const NEUTRAL_IDENTITY = { GIT_AUTHOR_NAME: 'NEAR AI Team', GIT_AUTHOR_EMAIL: 'coordination@near-ai.invalid', GIT_COMMITTER_NAME: 'NEAR AI Team', GIT_COMMITTER_EMAIL: 'coordination@near-ai.invalid' };
```

### Ancestry check for a rewritten branch

```typescript
// Source: verified: old head ancestor of new head -> exit 0; forced rewrite -> exit 1; unknown object -> exit 128; old objects stay in the mirror after a '+' fetch
const old = await revParseOptional(mirror, LOCAL);                 // before fetch
await fetchInto(mirror, url, `+${REF}:${LOCAL}`);
const head = await revParseOptional(mirror, LOCAL);
if (old && head && old !== head) {
  const r = await git(['--git-dir', mirror, 'merge-base', '--is-ancestor', old, head]);
  if (r.code === 1) { await git(['--git-dir', mirror, 'update-ref', `refs/team/quarantine/${old.slice(0, 12)}`, old]); throw new CoordinationRewrittenError(old, head); }
  if (r.code !== 0) throw new Error(`could not compare coordination heads (exit ${r.code})`);
}
```

On `CoordinationRewrittenError`: set transport status `paused` with reason `The coordination branch was rewritten on the remote`, stop appending, keep the old state in memory, list it in `verifyLog` output, and do not auto-accept. Also keep a persisted pin of the last verified head (`<mirror>/../pin.json`: `{ head, lamport, eventCount }`) so a deleted mirror cannot silently reset the baseline; if the pin exists and the freshly fetched history does not contain `pin.head`, treat it as a rewrite. Forced-update recovery UX (an explicit "accept new history" action) is not in scope [Open Question 5].

### ULID without a dependency

```typescript
// Source: executed in this session (26 chars, matches /^[0-9A-HJKMNP-TV-Z]{26}$/)
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()): string {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = ENC[t % 32] + time; t = Math.floor(t / 32); }
  let bits = 0n; for (const b of randomBytes(10)) bits = (bits << 8n) | BigInt(b);
  let rand = ''; for (let i = 0; i < 16; i++) { rand = ENC[Number(bits & 31n)] + rand; bits >>= 5n; }
  return time + rand;
}
export const eventId = () => `evt-${ulid()}`;
export const memberId = () => `mbr-${randomBytes(8).toString('hex')}`;   // D-15
export const teamId = () => `team-${randomBytes(16).toString('hex')}`;    // D-15
```

### `assertNoSecrets` (write side only)

```typescript
// Source: redactSecrets verified at src/domain/redaction.ts:1-4 (quoted below); new patterns verified against generated PKCS#8 base64
// redactSecrets today: value.replace(/bearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]') then /\brpt-[A-Za-z0-9_-]{8,}/g and /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|authorization)\s*[:=]\s*)[^\s,;]+/gi
const EXTRA = [
  /\bsk-[A-Za-z0-9_-]{8,}/, /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/, /\brt_[A-Za-z0-9_-]{8,}/, /\badm_[A-Za-z0-9_-]{8,}/, /\boc_[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+\S+/i, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/_-]{43}/        // PKCS#8 Ed25519, base64 and base64url
];
export function findSecrets(value: unknown, path = '$'): string[] { /* walk strings AND keys of objects/arrays; return paths that match */ }
export function assertNoSecrets(value: unknown, what: string): void { const hits = findSecrets(value); if (hits.length) throw new SecretLeakError(`${what} contains a secret-like value at ${hits[0]}; nothing was written.`); } // message never echoes the value
// Detection by difference reuses the existing rules unchanged:  redactSecrets(s) !== s
```

`redactSecrets` as it stands detects only `bearer ...`, `rpt-` (8+ chars) and `api key/access token/refresh token/authorization` followed by `:` or `=`. It does NOT detect `sk-`, `rt_`, `adm_`, `oc_`, JWTs, PEM or PKCS#8 (other, non-exported detectors exist at `src/services/agentActivity.ts:128-129` (`sk-`, `gh*_`, `glpat-`, `AKIA`, `xox*-`, JWT, PEM) and `src/agent/shell.ts:141`). The `sk-`/`rt_`/`adm_`/`oc_` minimum lengths above are guesses at a safe lower bound [ASSUMED]; real NEAR token shapes should be confirmed with the owner, but any false positive only blocks a write (fail closed). Walk object keys as well as values, because the reporting-token precedent `findPastedReportingTokens` walks values recursively and a key can carry a secret too.

### Concurrency test skeleton (fork)

```typescript
// Source: fork under `node --test` verified on Node 22.22.1 (child execArgv is empty); end-state assertions verified with 4-10 clients
const children = clients.map((id) => fork(path.join(__dirname, 'helpers', 'teamAppendChild.js'), [remote, mirrorFor(id), id, String(EACH)]));
// each child: new TeamLog with real GitTransport({ maxRetries: 20, baseDelayMs: 25 }), appends EACH member.availability events, process.send(result)
// assertions on the BARE REMOTE after all exit 0:
//   files = git ls-tree -r --name-only refs/heads/near-ai/coordination | filter events/  -> length === N*EACH, all event ids distinct
//   git rev-list --parents <ref> : exactly one root, every other commit has exactly 1 parent (linear)
//   git config receive.denyNonFastForwards true on the remote beforehand: any force push would have failed a child
//   a fresh client's reduce() over the branch: accepted === N*EACH + 2 genesis events, rejected === []
```

Expected runtime on this machine (git 2.53, Node 22): 4 clients x 5 events with base delay 25 ms took 3.1-4.3 s over 5 runs; 6 x 4 with base 200 ms took 3.5-8.9 s; 10 clients sharing one mirror x 5 events with base 2 ms took 10.8-23.2 s. Recommended CI configuration: 4 clients x 5 events, `maxRetries: 20`, `baseDelayMs: 25`, test timeout 60 s, plus one smaller shared-mirror case (3 clients x 3 events) to cover Pitfall 3.

### Enable: commit only `team.json` on the current branch (verified)

```typescript
// Source: verified with a gitignored .planning/.near-ai/, an unrelated staged file and a failing commit-msg hook
await git(['add', '-f', '--', TEAM_JSON_REL], { cwd: projectRoot });                      // plain `git add` of an ignored path exits 1 "paths are ignored"
await git(['commit', '--only', '-m', 'chore(team): enable NEAR AI Team Mode', '--', TEAM_JSON_REL], { cwd: projectRoot });
// result: HEAD commit contains only team.json; the user's other staged file stays staged; hook failure -> exit 1 with the hook's stderr
// prechecks: `git rev-parse --verify -q HEAD` exit 1 = no commit yet; `git remote get-url <remote>` exit 2 = no such remote; `git symbolic-ref --short -q HEAD` = branch name
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `git commit` in a scratch worktree | `hash-object` + temp `GIT_INDEX_FILE` + `commit-tree` on a bare mirror | n/a (plumbing is stable) | No working tree, no user index, no hooks, no user identity needed. |
| Text parsing of push errors | `git push --porcelain` per-ref status lines | git 1.8.x | Locale-independent success/reject flags. |
| `git cat-file` per object | `cat-file --batch` / `--batch-check` | long standing | One process for all blobs. |
| `JSON.stringify` for signing | JCS-style canonical form | RFC 8785 | Deterministic bytes across versions and platforms. |

**Deprecated/outdated:** nothing in the chosen set. Node's `crypto.sign(null, ...)` for Ed25519 is the current API (no `algorithm` argument allowed for Ed25519).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Hosted remotes (GitHub/GitLab/Bitbucket) word CAS-loss and permanent-rejection push errors like a local bare repo; unknown `[remote rejected]` reasons are treated as permanent | Pitfall 2 | A retryable race is reported as a permanent failure (visible, not silent); mitigate with a single constant list and logging of the raw reason. |
| A2 | `GCM_INTERACTIVE=never` stops Git Credential Manager dialogs; VS Code's extension host has no controlling tty so ssh passphrase prompts cannot block beyond the timeout | Pattern 3, Pitfall 9 | A hung credential dialog until timeout. |
| A3 | Windows behaviour (spawn, path lengths, hooksPath test skip) is as described | Pitfall 14 | Windows-only failures found late; no Windows runner here. |
| A4 | `git fetch` triggers a possibly detached `gc --auto`/maintenance in the mirror (so `gc.autoDetach=false` plus explicit gc is wise) | Pattern 4, Pitfall 8 | Minor: leftover background gc holding files; harmless on Linux. |
| A5 | Only global/system git config (not the project's local `.git/config`) applies to the mirror, so `core.sshCommand`/`http.*`/`credential.*` set per project are not inherited | Pattern 3 | Teams using per-repo SSH keys or proxies see "paused" until a pass-through allow-list is added. |
| A6 | Event body shapes in Pattern 7, `developerMayIntegrate` policy field, empty `allowedModels` default, self-or-lead rule for `member.skills`, refusing to revoke a member's last device, and "lead may not add/revoke devices for the owner" | Pattern 7/8 | Planner/owner may prefer different rules; these are design choices spec 5.2/6.3 and D-12 leave open. |
| A7 | Minimum lengths in the `sk-`/`rt_`/`adm_`/`oc_` patterns and that those are the real NEAR token prefixes | `assertNoSecrets` | Too-loose misses a token shape; too-strict only blocks benign strings. |
| A8 | Git versions older than 2.0 are irrelevant (`update-index --cacheinfo mode,sha,path` comma form needs 2.0); verified only on 2.53.0 | Standard Stack | Very old git on a user machine fails with a clear git error; add a `git --version` preflight message. |
| A9 | SecretStorage values are shared across windows of the same VS Code profile on one machine, so two windows share one device key | Pattern 1 | If not shared, two windows would need two device keys; low impact. |
| A10 | Emails stored in `member.joined`/`team.created` are acceptable PII in an immutable git history | Open Questions | Privacy/GDPR concern; owner decision. |

## Open Questions (RESOLVED)

All resolved by the orchestrator on 2026-10-31 under the owner's standing instruction: Q1 builder append = CONTEXT D-29; Q2 basis points = D-30; Q3 event bodies and email hashes = D-31; Q4 owner device protection = D-32; Q5 rewritten branch = D-33; Q6 owner key loss = a second owner device or a lead re-binding is out of scope (no ownership transfer in v0.6.0, deferred in CONTEXT); handled as an explained error in 60-01 and 60-06; Q7 snapshot races = D-33 plus the 60-07 snapshot skip; Q8 release packaging = 60-11 `npm run verify:release`. The original questions follow for the record.

1. **`append(events, revalidate)` signature (D-18 vs D-03)**
   - What we know: a retried pre-signed event has stale Lamport/`prev` and will be rejected after rebase (Pitfall 1).
   - What's unclear: whether the owner accepts `revalidate` being a builder `(state) => events | conflict`.
   - Recommendation: adopt `append(build: (state, head) => Promise<{ events } | { conflict }>)`; keep the D-18 name by documenting that `revalidate` is the builder.

2. **Float fields in `TeamPolicy`**
   - What we know: D-06 rejects floats; D-13 lists `safetyFactor: 1.25`, `overrunFactor: 1.5`.
   - Recommendation: store as `safetyFactorBp: 12500`, `overrunFactorBp: 15000`, and rename `reconcileTolerance` to `reconcileToleranceBp: 500`; keep display conversion in adapters. Later phases reading these fields must use the Bp names.

3. **Event bodies were never specified**
   - What we know: spec 5.2 lists type names only; D-07 refers to a body map "from spec 5.2".
   - Recommendation: planner adopts or amends Pattern 7 in a plan "types and validators" and has it confirmed before execution, since bodies are signed forever (one-way).

4. **PII in the log**
   - What we know: roster events carry names and emails; D-04 only protects commit metadata.
   - Recommendation: make emails optional at Enable (default from git config but skippable), or store only the hash plus the display name; owner decision.

5. **Rewritten-branch recovery**
   - What we know: the client can detect and refuse (verified), but no accept-new-history path exists.
   - Recommendation: Phase 60 refuses and explains; a deliberate "re-trust" command is deferred (needs owner policy).

6. **Owner key loss**
   - What we know: one owner, no transfer (D-12), `policy.changed` is owner-only, owner devices can only be added by the owner's own device (recommendation A6).
   - Recommendation: document that losing every owner device freezes policy and role changes until ownership transfer ships; consider allowing the owner to register a second device immediately after Enable.

7. **Snapshot writer races**
   - What we know: two lead clients can both cross the 500-event threshold.
   - Recommendation: the builder re-checks "no snapshot at or after this Lamport yet" and returns a conflict (skip) otherwise.

8. **`dist` size and SBOM**
   - No dependency changes, so `scripts/extension-sbom.mjs` output should not change; the planner should confirm `npm run verify:release` still passes once at the phase gate (new `dist/team/*.js` files are picked up by the runtime JS walk automatically).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| git | whole phase | yes | 2.53.0 | none (hard requirement; show "git not found on PATH") |
| Node (PATH default) | build, tests | yes | v24.22.2 | - |
| Node 22 (engine floor) | floor validation | yes | v22.22.1 at `/usr/bin/node` | run the targeted team tests once with it |
| OpenSSL (via Node) | Ed25519 | yes | 3.5.5 | - |
| ssh client | SSH remote classification only | yes | OpenSSH_10.2p1 | tests use file/http remotes |
| xvfb-run | `npm run test:e2e` | yes | present | skip e2e locally; run at phase gate |
| VS Code test binary (`.vscode-test`) | e2e | not downloaded in this worktree | - | `npm run test:e2e` downloads it; needs network |
| Windows runner | path/hook assumptions | no | - | rely on CI if configured; mark Windows items as `[ASSUMED]` |
| `dist/` | single-file test runs | not built in this worktree | - | run `npx tsc -p tsconfig.json` (or `npm run compile`) first |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** e2e binary (download at gate), Windows (documented risk).

Verification baseline observed: `npm run lint` (`tsc -p tsconfig.json --noEmit`) completes in about 12 s on this machine. [VERIFIED: ran it]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` + `node:assert/strict` (no Jest/Vitest) [CITED: .planning/codebase/TESTING.md "Test Framework"] |
| Config file | none; scripts in `package.json` (`"lint": "tsc -p tsconfig.json --noEmit"`, `"test": "npm run compile && node --test dist/test/*.test.js"`, package.json:652-653) |
| Quick run command | `npx tsc -p tsconfig.json && node --test dist/test/teamCanonical.test.js` (substitute the file) |
| Targeted family run | `npx tsc -p tsconfig.json && node --test dist/test/team*.test.js` |
| Full suite command | `npm run check` (= `npm run lint && npm test`) |
| Floor check | the same targeted run with `/usr/bin/node` (v22.22.1) first on PATH |

Test file conventions to follow: flat top-level `test('sentence', ...)`, header comment per file, real git in `mkdtemp(path.join(tmpdir(), 'near-ai-team-'))` directories, `.invalid` emails, hand-written `MemorySecrets implements SecretStorageLike`, one `vscode` stub object per file mutated per test. Helpers live in `src/test/helpers/` (not matched by the `dist/test/*.test.js` glob; compiled output excluded from the VSIX by `.vscodeignore` `dist/test/**`).

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| TEAM-04 | Canonical JSON vectors: sorted keys, UTF-16 order, rejects floats/-0/undefined/depth/lone surrogate, byte-stable | unit | `node --test dist/test/teamCanonical.test.js` | Wave 0 |
| TEAM-04 | Ed25519 identity: generate, store/load via MemorySecrets, wrong-type key refused, sign/verify, tamper, strict base64url | unit | `node --test dist/test/teamIdentity.test.js` | Wave 0 |
| TEAM-04 | `reduce`: genesis anchor match/mismatch, bad signature, unbound device, revoked device (positional), removed member (positional), Lamport monotone and jump rule, duplicate id, unsupported type and `v`, size limit, non-canonical file | unit | `node --test dist/test/teamMaterialize.test.js` | Wave 0 |
| TEAM-04 | Determinism property: seeded PRNG generates valid+forged sequences; `serialiseState(reduce(x))` identical across runs and across incremental vs full; snapshot+tail equals full replay | property | `node --test dist/test/teamMaterialize.test.js` | Wave 0 |
| SEC-04 | Table-driven matrix: every role x every action cell, policy cells (`peerMetricsVisible`, developer integrator), lead cannot act on owner, removed member denied, one owner | unit | `node --test dist/test/teamPermissions.test.js` | Wave 0 |
| SEC-04 | Write-side refusal uses the same function (event not appended, reason returned) and read-side rejects the same forged event from a raw foreign writer | integration | `node --test dist/test/teamForgery.test.js` | Wave 0 |
| TEAM-04 | Two independent clients on two clones converge: A appends, B fetches, `serialiseState` identical; forged events rejected identically by both and listed with reasons | integration (real git) | `node --test dist/test/teamGitTransport.test.js` | Wave 0 |
| TEAM-04 | Transport behaviours: genesis create, "already has a coordination log", non-ff retry with rebuild, conflict returned when revalidation fails, offline -> paused, rewritten branch detected, global hooksPath ignored, permanent remote reject surfaced, idempotent landed-push | integration (real git + fault runner) | `node --test dist/test/teamGitTransport.test.js` | Wave 0 |
| TEAM-04 | Concurrency: N forked clients, every event once, linear history, remote `receive.denyNonFastForwards=true` | integration | `node --test dist/test/teamConcurrency.test.js` | Wave 0 |
| SEC-01 | `findSecrets`/`assertNoSecrets` table of positives (sk-, rpt-, rt_, adm_, oc_, Bearer, JWT, PEM, PKCS#8 base64 and base64url, key=value forms) and negatives (ids, ULIDs, fingerprints, base64url public keys); keys of objects scanned | unit | `node --test dist/test/teamSecrets.test.js` | Wave 0 |
| SEC-01 | Canary: unique canaries in API key, reporting token, refresh token, remote URL userinfo, prompt; real device key; run Enable + roster events; scan every git object (`git cat-file --batch-all-objects --batch`) in mirror and remote, `team.json`, stub settings, audit file, output channel text and status tooltip; negative case: canary typed into the team name is refused and nothing is written | integration | `node --test dist/test/teamEnable.test.js` | Wave 0 |
| TEAM-01 | Enable flow: preconditions (not initialised, no commit, no remote), writes `team.json`, commits only that file with other staged files untouched, never pushes the code branch, second Enable reports existing team | integration | `node --test dist/test/teamEnable.test.js` | Wave 0 |
| TEAM-01 | Solo parity: `registerTeamMode` with the vscode stub and no `team.json`: both commands registered, no timers created (spy on `setTimeout`/`setInterval`), no `globalStorage/team`, no status item, no output channel | unit | `node --test dist/test/teamSoloParity.test.js` | Wave 0 |
| TEAM-01 | Existing suite unchanged and green | regression | `npm test` | exists |
| TEAM-01/SEC | Audit mirror: `team-roster` accepted in both `AuditEventType` and `isAuditEventType`, idempotent across restarts, metadata redacted, rejected events never audited | unit | `node --test dist/test/teamAudit.test.js` | Wave 0 |
| TEAM-04 | Verify Team Log: full replay output lists events, members, head, rejected rows with reasons; status bar shows "Team sync paused: remote unreachable" with redacted tooltip when fetch fails, backs off to 10 min, retries on focus | unit with vscode stub + fake scheduler | `node --test dist/test/teamSession.test.js` | Wave 0 |
| manifest | `package.json` contributes both commands, `nearAi.team.pollSeconds` (default 15, min 5, scope application); every contributed command is registered | unit + e2e | `node --test dist/test/teamManifest.test.js`; `npm run test:e2e` once at the gate | Wave 0 |

### Sampling Rate (aligned with the global verification cadence)

- **Per task commit:** `npm run lint` plus the single test file for the changed module (`npx tsc -p tsconfig.json && node --test dist/test/<file>.test.js`).
- **Per wave merge:** `node --test dist/test/team*.test.js` (all team files, includes the git and fork tests, about 30-60 s expected) plus `npm run lint`.
- **Phase gate:** `npm run check` (full lint + full `npm test`), one run of the team tests under Node 22 (`/usr/bin/node`), `npm run test:e2e` once (command registration for the two new commands), `npm run verify:release` once. Security-critical checks (signature/permission/forgery/secret canary) are immediately blocking at every wave; do not weaken or delete a failing test to get green.

### Wave 0 Gaps

- [ ] `src/test/teamCanonical.test.ts`, `teamIdentity.test.ts`, `teamMaterialize.test.ts`, `teamPermissions.test.ts`, `teamSecrets.test.ts`, `teamForgery.test.ts`, `teamGitTransport.test.ts`, `teamConcurrency.test.ts`, `teamEnable.test.ts`, `teamSoloParity.test.ts`, `teamAudit.test.ts`, `teamSession.test.ts`, `teamManifest.test.ts`
- [ ] `src/test/helpers/teamHarness.ts` (bare remote + N clones factory with a `git remote` URL, `MemorySecrets`, client factory returning `{ log, transport, secrets }`, canary scanner over all git objects, seeded PRNG `mulberry32`) and `src/test/helpers/teamAppendChild.ts` (fork target)
- [ ] A `GitRunner` fault-injection wrapper for offline/auth/lock-contention cases
- [ ] No framework install needed

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication (identity of event authors) | yes | Ed25519 signatures, device-to-member binding through roster events, genesis anchor (D-06, D-10) |
| V3 Session Management | no | No sessions; device keys are long-lived per device per team |
| V4 Access Control | yes | `decideTeamAction` as the single decision point on write and on read (D-12); positional removal/revocation (D-11) |
| V5 Input Validation | yes | Exact-key hand validators, size/depth limits, path-name regexes, strict base64url, canonical-bytes equality, `team.json` field patterns |
| V6 Cryptography | yes | `node:crypto` only (Ed25519, SHA-256, `randomBytes`); no custom primitives |
| V7 Error Handling and Logging | yes | No empty catches; messages and tooltips pass `redactSecrets` and strip URL userinfo; `assertNoSecrets` messages never echo the value |
| V8 Data Protection | yes | Private key only in SecretStorage; `team.json` and log carry no secrets; PII (emails) caveat |
| V12 Files and Resources / V14 Configuration | partly | Mirror isolated from the working tree; `core.hooksPath` pinned; `pollSeconds` application-scoped |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged event (bad signature) | Spoofing/Tampering | Signature check (step 4); rejected with reason, no state change |
| Event signed by an unbound or revoked device, or with `author` of another member | Spoofing/Elevation | Device must be bound to `author` by an earlier roster event and not revoked at that position (steps 3, D-11) |
| Insufficient role (for example a developer writes `policy.changed`) | Elevation | `decideTeamAction` on read (step 6), same function refuses locally on write |
| Lead impersonates the owner via `device.added` for the owner | Elevation | Lead may not add/revoke owner devices (A6 recommendation) |
| Replay of another team's log or events onto this remote | Spoofing | `teamId` check and genesis anchor refusal (D-10); signed envelope includes `teamId` |
| Replay of an old event within the same team (re-promotion) | Tampering | Duplicate-id rejection and Lamport rule (events keep their old Lamport, not greater than the high mark) |
| Lamport poisoning (huge value) / log-space exhaustion | Denial | Rejected events never advance the high mark; jump cap; 12-digit file-name limit enforced |
| Malicious remote rewrites history (force push, reorder, drop events) | Tampering/Repudiation | Ancestor check of the last-seen head after every fetch plus persisted pin; refuse and flag (verified detection); old objects kept in quarantine ref |
| Malicious remote or member withholds events or floods bogus files | Denial | Not preventable; bound work (16 KB blobs via `--batch-check`, per-commit file cap, rejected-list cap in UI), status shows staleness. Honest limit documented |
| Key exfiltration | Information disclosure | Key only in SecretStorage; never in env, args, logs, `team.json`, audit; `KeyObject` does not stringify; PKCS#8 prefix pattern in `assertNoSecrets`; loader checks `asymmetricKeyType` |
| Secret leakage into events/`team.json`/audit | Information disclosure | `assertNoSecrets` before every write (throws, nothing written); canary test scans every git object; read-side scan is warning-only to keep `reduce` deterministic |
| Credentials in the remote URL (`https://user:token@host/...`) leaking through errors or tooltips | Information disclosure | Never store the URL; strip userinfo and apply `redactSecrets` to every git message shown or logged |
| Option/command injection through `team.json` (`remote`, `ref`) or event content | Tampering/Elevation | Field regexes; `spawn` with argument arrays, no shell; event-derived text never becomes a path or argument except the validated file-name pattern |
| Hostile local git config / hooks | Tampering | Mirror-local `core.hooksPath`; explicit URL and refspec; `commit.gpgsign` irrelevant to `commit-tree` |
| Prototype pollution / deep nesting in event JSON | Tampering/Denial | Exact-key validators over `JSON.parse` output, depth limit, parse+validate inside `try/catch` mapping to `malformed event` |
| Forged `team.json` in the code repo (TOFU weakness) | Spoofing | Local pin of `teamId` + genesis; mismatch refuses; documented as bounded by code-branch write access |
| Merge commits / non-first-parent content on the coordination branch | Tampering | Process the first-parent diff only; flag commits with more than one parent as an anomaly row |

## Sources

### Primary (HIGH confidence)
- Executed experiments in this session (Node v22.22.1 and v24.22.2, git 2.53.0, OpenSSL 3.5.5): Ed25519 calls; canonicalisation edge cases (`-0`, `2**53`, depth 8000 `RangeError`, UTF-16 sort, lone surrogates, duplicate keys, `__proto__`); verify/sign timings; plumbing commit/push on a bare mirror (genesis, normal, batch, divergent genesis, stale push in default/porcelain/`LC_ALL=de_DE` forms); `ls-remote --exit-code`, `fetch` missing-ref exit codes; `git log --first-parent --reverse --raw -z` parse; `cat-file --batch`/missing object; `merge-base --is-ancestor` on rewritten history; fork concurrency runs (separate and shared mirrors, 4-10 clients); hooksPath/gpgsign/insteadOf behaviour; auth/403/404/refused/hung-host failure texts; `git add -f` + `commit --only` with ignored dir, staged file and failing hook; tree-size and append-cost scaling to 50k events. Scratch scripts: `/home/aaron/.cache/claude-code-tmp/claude-1000/-home-aaron-projects-legacy-WSL-CanonicalGroupLimited-Ubuntu22-04LTS-79rhkp1fndgsc-home-vitalpointai-projects-near-ai-vscode/c9530351-8a06-4ecc-88ec-22eb8ca5144b/scratchpad/p60research/` (`crypto.js`, `canon.js`, `git1.js`, `child.js`, `conc.js`, `read.js`, `cfg.js`, `errs.js`, `commitonly.js`, `scale.js`, `perf.js`).
- In-repo source read this session: `src/services/auth.ts:8-12` (`SecretStorageLike`), `src/domain/approval.ts:9-12` (`AuditEventType`), `src/services/auditStore.ts` (whole file; `isAuditEventType` at line 88), `src/domain/redaction.ts:1-4`, `src/agent/worktree.ts:12-20`, `src/extension.ts` (activate, registration pattern, line 56), `package.json` (activation 56-58, commands 61-204, configuration, scripts 652-653), `src/test/e2e/suite.ts:52-55`, `src/gsd/runtime.ts:168-173`, `.planning` spec/context/requirements/state, `.planning/codebase/{CONVENTIONS,TESTING,CONCERNS}.md`, `.planning/milestones/v0.5.0-paused/research/ARCHITECTURE.md` section 3.8 (transport interface and "hooks disabled" git transport pattern), `.gitignore` (`.planning/.near-ai/` is ignored).

### Secondary (MEDIUM confidence)
- Spec `.planning/research/v0.6.0-team-mode-addendum.md` sections 5.1-5.3, 6.1, 6.3, 6.14-6.15, 7, 11 (source of truth for scope; body shapes absent).

### Tertiary (LOW confidence, `[ASSUMED]`)
- Hosted-remote push wording, Windows behaviour, credential-helper GUI behaviour, per-repo config scoping, token prefix lengths (see Assumptions Log).

## Project Constraints (from CLAUDE.md)

No `./CLAUDE.md` or `./.claude/CLAUDE.md` exists in this repository (checked). Applicable user-global directives (from `~/.claude/CLAUDE.md`): run the smallest relevant unit/type/lint checks after each edit; batch before wider integration suites; run the complete suite once at the phase boundary; keep security, authorization, data-integrity and boundary checks immediately blocking; never delete/skip/weaken a failing test to get green; browser/visual sweeps are non-blocking (none apply here). NEAR credential-key rules are unrelated to this phase (no key files are read or written). Project conventions to honour (from CONVENTIONS.md): 2-space indent, single quotes, semicolons, no trailing commas, `import type` for type-only imports, `node:` prefix for built-ins, no `console.*` in `src/`, no path aliases or barrels, domain stays `vscode`-free, errors never include secrets, no `any`.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - built-ins and system git, all exercised.
- Architecture: HIGH for crypto/canonical/git/concurrency; MEDIUM for adapter wiring (no extension-host run here) and body schemas (design recommendations).
- Pitfalls: HIGH where reproduced (CAS wordings, shared-mirror fetch failure, hooksPath, EPIPE, retry budget, depth RangeError); MEDIUM/LOW for hosted-remote, Windows and credential-GUI items.

**Research date:** 2026-10-31
**Valid until:** 2026-11-30 (git and Node behaviours are stable; re-check hosted-remote wording and any change to `AuditStore` wiring before execution).
