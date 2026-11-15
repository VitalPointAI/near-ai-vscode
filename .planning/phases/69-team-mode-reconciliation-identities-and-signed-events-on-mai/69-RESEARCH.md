# Phase 69: Team Mode reconciliation: identities and signed events on main - Research

**Researched:** 2026-11-15
**Domain:** Porting a verified Ed25519 identity, signed append-only event log, role matrix and git coordination transport onto `main`, and extending it with one reusable payload signer and key rotation or revocation
**Confidence:** HIGH for the port (every claim below was checked against the archive branch and `main` this session); MEDIUM for the TMR-05 design (it is a design, not a port; the one soft spot is flagged in "Decisions to revisit")

Every claim carries a tag. `[VERIFIED: ...]` means opened or run this session. `[CITED: ...]` means official documentation. `[ASSUMED]` means not checked here and listed in the Assumptions Log. No package is installed by this phase, so the package legitimacy gate has nothing to check.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** TMR-01 is already done by the owner: `origin/feat/team-fix-pass` is on GitHub at 4207080, whose commit "archive uncommitted work before pushing the branch as an archive" holds the loose files. The phase only verifies and records this (branch exists on the remote at that commit, the legacy worktree has no uncommitted changes left, or the remaining ones are listed) in the phase's disposition record. No code task depends on anything else. *Undo: not applicable (a record).*
- **D-02:** Port by re-applying files, not by cherry-picking commits. The Phase 60 work is 111 interleaved commits, almost entirely new files (`src/domain/team/*`, `src/team/*`, `src/services/team/*`, test helpers and `src/test/team*.test.ts`); it touched existing files only in five small places (`src/extension.ts` two lines, `src/domain/approval.ts` one audit type, `src/services/auditStore.ts` one line, `package.json` contributions, and `src/test/helpers/vscodeStub.ts` as a new helper). New files are taken from the archive branch with `git show <sha>:<path>`; the five small edits are re-applied by hand onto main's current versions. `src/agent/permissions.ts` was not changed by Phase 60 and is not touched. *Undo: cheap.*
- **D-03:** The base is the end of Phase 60 on the branch (`ae5e9e1`, "complete phase 60 after real-window UAT re-test"), not the branch tip. Later commits on the same files are taken only when they fix Phase 60 behaviour (the `fix(team): ...` commits, for example 3e11c0e "two windows on one team mirror take turns, and an append always commits on the state it was built from"); commits that add Phase 61, 62 or 62.1 behaviour (invites, joins after genesis, sealed keys, NEAR org, work items, assignment) are left out. Research classifies every later commit that touches a Phase 60 file as "fix, take" or "later phase, leave" with a reason, and the plans follow that list. *Undo: cheap (each fix is separable).*
- **D-04:** The event type union stays as Phase 60 declared it (all types named, only the ten Phase 60 bodies accepted; any other type is rejected with "unsupported event type for this version"), plus whatever new types TMR-05 needs (D-09). L2 will add the later bodies on top. *Undo: cheap.*
- **D-05:** Phase 60's tests come across with the code and must pass on main unchanged in meaning; where main's helpers or APIs moved since 0.4.11 the tests are adapted, never weakened. Phase 60's success criteria are re-verified on main by running them, not assumed from the branch's VERIFICATION.md (TMR-02). *Undo: not applicable.*
- **D-06:** Phase 60 kept one key per device per team (`nearAi.team.deviceKey.<teamId>`). Phase 70 needs a solo person (no team) to sign their first policy bundle on a fresh install, and the owner chose one persistent `did:near` identity per member (Phase 71). So the key moves up one level: **one Ed25519 device identity per person per install**, stored only in SecretStorage under one name (`nearAi.identity.deviceKey`), created on first need, and used by Team Mode for every team this install joins (the roster binds this key's fingerprint as the member's device). Team Mode never ships the per-team key on main, so there is nothing to migrate. Consequence accepted: the same device fingerprint appears in every team the person is in; a `did:near` identity is global anyway. *Undo: costly once released (the key name and the fingerprint end up in logs and signed payloads), cheap before the first release that contains this phase.*
- **D-07:** The identity module stays `vscode`-free: it takes the existing type-only `SecretStorageLike`. The private key never leaves the closure-held `KeyObject` and SecretStorage: never in settings, the workspace, `team.json`, the log, transcripts, audit or fixtures. *Undo: not applicable (a rule).*
- **D-08:** One interface for every signed thing that is not a team event: `signPayload(identity, purpose, payload)` and a never-throwing `verifyPayload(...)`, in `src/domain/team/` (pure; the private-key half in `src/team/identity.ts`). The signature covers a domain-separated input: a fixed prefix naming this product, a version and the **purpose** (a closed list: `policy-bundle`, `grant`, `approval-answer`, with room to add; unknown purposes are refused) followed by the canonical JSON bytes (Phase 60's canonicaliser, D-06 of Phase 60: sorted keys, safe integers only). So a signature made for one purpose can never be replayed as another, and none can be replayed as a team event. The signed envelope names the signer by device fingerprint and public key, and carries an optional member id slot so Phase 71 can add the `did:near` identifier without changing the format. Team events keep their own signing input from Phase 60 (the envelope without `sig`), because their `teamId`, `type` and `v` fields already separate them. *Undo: costly. Policy bundles, grants and approval records signed through it outlive a change; the format carries a version so a later one can be added beside it.*
- **D-09:** Key rotation and revocation are signed events, and every check honours them through one key-status lookup. In a team: the existing `device.revoked` (positional, Phase 60 D-11) and a new `device.rotated` event signed by the old key (or by the owner or a lead) naming the new key, in one event so there is no moment with two active keys or none. For a person with no team, the same two records live in a local, append-only, signed key history in extension global storage, so a solo policy bundle (Phase 70) is checked the same way. `verifyPayload` takes the key status from that lookup: a revoked key is refused for everything; a rotated-out key is refused for anything signed after the rotation; the result says why in plain words. *Undo: medium; the key history format is local but signed payloads depend on its rules.*
- **D-10:** Phase 69 builds the interface and proves it with tests over sample payloads of each purpose (no real policy, grant or approval format). Phases 70, 71 and 80 call it and must not add a second signer. *Undo: cheap.*
- **D-11:** Team Mode's coordination mirror (`<globalStorage>/team/<teamId>/coordination.git`, Phase 60 D-16) and Phase 27's sync mirror (`<storage>/sync-mirrors/<project key>/mirror.git`) are different folders, so they never share a mirror. The team transport's cross-process lock uses main's existing `acquireFileLock` / `withFileLock` from `src/services/stateMirrorLock.ts` with its own lock file name in the team mirror folder, instead of porting the branch's `mirrorProcessLock.ts`; one lock implementation in the product. A test runs a team sync and a state sync on one project at the same time and shows neither waits for or touches the other's mirror or lock. *Undo: cheap.*
- **D-12:** The two features also must not share a branch on the project's remote. Sync owns `refs/heads/near-ai/state` and `refs/near-ai/incoming` (`src/services/stateTransport.ts`). `team.json` is attacker-influenced, and its coordination ref pattern would today accept `refs/heads/near-ai/state`, so `team.json` validation refuses any coordination ref equal to or under a sync ref, and the team transport uses its own incoming and quarantine ref names that cannot collide. *Undo: cheap.*
- **D-13:** Phase 60's commands come across with their ids unchanged (`nearAi.team.enable`, `nearAi.team.verifyLog`, setting `nearAi.team.pollSeconds`); they do not collide with main's agent-team commands (`nearAi.teams.*`, Team Studio). Without invitations (Phase 61, milestone L2) a team on main can only hold its owner, so the two commands are hidden from the Command Palette unless a new boolean setting `nearAi.team.preview` (default false, application scope) is on. A project that already has `team.json` still starts its session and status bar whatever the setting says, so a team project is never silently ignored. *Undo: cheap (flip the default or drop the `when` clause).*
- **D-14:** A project with no `team.json` does exactly what it does today: one `fs.stat` at activation and nothing else (Phase 60 D-24). The full suite stays green, and the Phase 60 solo-parity test plus a canary test (no secret in the log, `team.json`, settings or audit) run on main (TMR-03). *Undo: not applicable.*
- **D-15:** `team.json` stays at `.planning/.near-ai/team.json` (Phase 60 D-21) because Enable Team Mode commits it with the project so every clone can find its team. Research checks how main treats `.planning/.near-ai/` since 0.4.11 (protected paths, Phase 26 state layout, Phase 27 sync) and the plans follow what main does; if main's sync would copy or rewrite `team.json`, the plan keeps the two apart. *Undo: medium (moving the pointer later needs a migration for every team project).*
- **D-16:** The disposition record is one planning document, `.planning/research/v0.6.0-disposition.md`, with one row per v0.6.0 phase (60-67, 62.1) and per v0.6.0 requirement: landed in Phase 69, carried to the Team Mode milestone L2, folded into a named v0.7.0 phase, or retired, with the reason. Carried ids that collide with v0.7.0 ids take the `TM-` prefix (TM-TEAM-01..04, TM-SETUP-01). REQUIREMENTS.md and ROADMAP.md link to it. Starting point: REQUIREMENTS.md line "Carried from v0.6.0" (TM-TEAM-01, TM-TEAM-04, SEC-01, SEC-04 land here). *Undo: cheap (a document).*
- **D-17:** The phase lands on `main` through the normal reviewed PR and ships in the next 0.4.x release (owner, 2026-11-15: Stage 1 phases ship in 0.4.x as they land). The release itself is not a plan in this phase. *Undo: not applicable.*
- **D-18:** Repo rules apply to every plan: tests on every change; every test command uses the memory cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>`; full suite and e2e with MemoryMax=6G and timeout 1800), one heavy run at a time; e2e only under xvfb with Wayland variables stripped; plain language, no em-dashes, "your organization" never "NEAR organization"; `src/domain/team/*` and `src/team/*` never import `vscode`; no new runtime dependency in the extension. *Undo: not applicable.*

### Claude's Discretion

- File split inside `src/domain/team/` for the payload signer and key status (one new file or two), and the exact names of exported functions, as long as D-08 and D-09 hold.
- Order of porting within the plans, as long as each plan leaves main green.
- Test file names for new tests, following the `src/test/team*.test.ts` pattern.

### Deferred Ideas (OUT OF SCOPE)

- Invitations, joining, removal, NEAR organization calls, sealed key delivery (Phase 61), the board and work items (Phases 62, 62.1), and Phases 63-67: milestone L2, on the archive branch.
- `did:near` documents, member identities above device keys, grants: Phase 71.
- Policy bundle format and the gate: Phase 70. Request-bound approvals: Phase 80.
- Board sync over the relay (`relayTransport.ts`): superseded by L5's federation transport.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| TMR-01 | `feat/team-fix-pass` preserved on GitHub as an archive branch; loose files committed or recorded | Section "Q7": `git ls-remote origin refs/heads/feat/team-fix-pass` returns 4207080ca394d36cf36bbed37b179d8f8400b721; the legacy worktree is clean; archive commit contents listed |
| TMR-02 | Phase 60 core runs on `main`, re-verified against Phase 60's success criteria, no `vscode` import, no new runtime dependency | Q1 (what to take), Q2 (drift: none breaking, one behavioural), Q4 (isolation), the port-then-adapt order, Validation Architecture rows for each of the five Phase 60 criteria |
| TMR-03 | No team file means no change; full suite green; canary finds no secret in log, `team.json`, settings or audit | Q2 and Q3 (activation, e2e command check, manifest), `teamSoloParity` and the canary tests, secret-scan finding (no Phase 60 file trips main's scanner) |
| TMR-04 | Disposition for every v0.6.0 phase and requirement; `TM-` prefix on collisions | Q6: all 9 phase rows and all 34 requirement ids with proposed dispositions; collision list including the near collisions D-16 does not name |
| TMR-05 | One interface signs and verifies any canonical payload; rotation and revocation are signed events later checks honour | Q5: envelope, signing input, key status lookup, `device.rotated`, solo key history, constraints from Phases 70, 71, 80 and the DID drafts, and the soft spots in D-08 and D-09 |
</phase_requirements>

## Summary

The port is safer than it looks. Phase 60 is 47 non-planning files, 43 of them new; only `package.json`, `src/extension.ts`, `src/domain/approval.ts` and `src/services/auditStore.ts` pre-exist, and their edits re-apply cleanly because the lines Phase 60 touched are unchanged on `main`. Every import the Phase 60 code takes from an existing module still exists with the same shape (`SecretStorageLike`, `redactSecrets`, `AuditStore`, the audit types). The toolchain is unchanged between 0.4.11 and `main` (same `tsconfig.json`, TypeScript, `@types/vscode`, `engines.vscode`). One behavioural drift exists: `main`'s `redactSecrets` is broader than the 0.4.11 one, and Phase 60's write-side secret detector calls it; a 120,000-sample check this session found it still passes generated keys, fingerprints and ids (one 86-character signature in 20,000 matched, which is exactly the case the existing `sig` key exemption covers). The strongest evidence that the port is cheap: `patch --dry-run` applies the one important later fix (3e11c0e) to the `ae5e9e1` file with no rejects.

Of the 97 later commits that touch a Phase 60 file, only three groups fix Phase 60 behaviour: 3e11c0e (two windows on one mirror), 9e49bc5 with its test 35ac2b9 (a load-dependent flaky dedupe key in `teamSession`), and an optional plain-words subset of 0f5ea20 and f6890da. Everything else (53 Phase 61, 33 Phase 62 or 62.1, 6 merge or non-team commits) is later-phase behaviour and stays on the archive. Main's `stateMirrorLock.ts` is a drop-in replacement for the branch's `mirrorProcessLock.ts`: same algorithm (the main file says it was "shaped after the Team transport's lock, copied"), same `acquireFileLock`/`MirrorBusyError`/`HeldMirrorLock` shapes, different lock file name.

TMR-05 is the real design work and the part with a high undo cost. The recommended shape follows D-08 and D-09 with four corrections, collected under "Decisions to revisit": the signer must accept any Ed25519 signer (Phase 71 gives every agent its own key, DLGT-01), "signed after the rotation" depends on a signing time the key holder controls, rolling back Enable must never delete the now-shared identity key, and the review gate's 1,000,000-byte diff budget (`MAX_DIFF_BYTES`) is about two thirds used by the port alone, so the work should land as more than one PR.

**Primary recommendation:** Port Phase 60 exactly as it stood at `ae5e9e1` first (per-team key, green on `main`, this is the TMR-02 evidence), add fixes 3e11c0e (lock swapped to `acquireFileLock`) and 9e49bc5, then in separate plans move to the per-person identity, add `device.rotated`, the payload signer, the key status lookup and the solo key history, then the isolation tests and the disposition record. Split into at least two PRs so each stays well under the 1,000,000-byte agent-review diff cap.

## Decisions to revisit

None of D-01..D-18 is wrong enough to block planning. These are the places where a fact found this session changes how a decision should be applied. The first four matter most.

1. **D-09, "a rotated-out key is refused for anything signed after the rotation" rests on a clock the key holder controls.** A payload outside the team log (a policy bundle, a grant) has no log position; the only "after" available is the `signedAt` the signer wrote into it. A person holding a copied old key can backdate it. This is not fixable by design for offline verification; it is fixable in wording and in what the product tells people. Apply D-09 as: revoked means refused for everything (no time test, this is the answer to "I think the key was copied"); rotated means refused when the claimed `signedAt` is at or after the rotation time, and the result and the documentation say plainly that rotation retires a key and only revocation stops a copied one. In a team, the roster gives a trusted order for events (positional, D-11), but payloads still use the claimed time. `[ASSUMED]` that the owner accepts this; it is the standard limit of signing without a trusted timestamp.
2. **D-08, the interface must take any Ed25519 signer, not only "the person's device identity".** Phase 71's DLGT-01 requires every agent to have its own Ed25519 key with its own NEAR implicit account, and DLGT-03 has grants signed by the delegator, who can be an agent. If `signPayload` is typed to the device identity (which carries a `teamId` today), Phase 71 would add a second signer, which D-10 forbids. Type it to a small structural `PayloadSigner { fingerprint; publicKey; sign(bytes) }` (the existing `DeviceIdentity` already has exactly these members apart from `teamId`, which goes away under D-06), and key the status lookup by fingerprint plus public key, so an agent-key source can be added beside the roster and the local history. Add an internal fourth purpose `key-record` for the local history records (the list is closed but D-08 already allows room to add).
3. **D-06 makes `enable.ts` rollback dangerous.** Phase 60's rollback calls `forgetDeviceIdentity(secrets, teamId)` after a failed genesis push (`ae5e9e1:src/team/enable.ts:150`, tests at `teamEnable.test.ts` lines 366 to 375 and 418 to 431 assert "the device key is gone"). With one shared key that call would delete the key that earlier policy bundles, grants and other teams depend on. Rule to carry into the plans: Enable calls `loadOrCreateDeviceIdentity` and remembers whether it created the key; rollback forgets the key only if this call created it and nothing was signed with it yet (no key history, no other team on this install); the "unconfirmed push keeps the key" case (WR-01) is unchanged. Adapt those tests, do not delete them: add "a failed Enable leaves an identity that existed before untouched".
4. **D-17 as one PR will exceed the agent-review diff budget.** `scripts/lib/ci-review.mjs:12` says `export const MAX_DIFF_BYTES = 1_000_000;` and `capDiff` leaves out whole file sections past it; `scripts/ci-review-run.mjs` then holds the PR for the owner (`result.omitted.length > 0` makes `gate` true). The Phase 60 sources and tests at `ae5e9e1` are 238,770 bytes of source and 420,322 bytes of tests and helpers, about 659 KB, before any TMR-05 code, new tests or `.planning` files in the same PR. Plan at least two feature PRs (pure domain and team I/O with their tests; then services, wiring and TMR-05) and keep `.planning` summaries out of them where the workflow allows.
5. **D-12, the refusal rule should cover more than "equal or under".** Also refuse a coordination ref that is a proper prefix of the sync ref (`refs/heads/near-ai` matches today's pattern and would make git refuse one of the two pushes with a directory/file ref conflict), anything equal to or under `refs/near-ai/incoming`, and compare case-insensitively (a case-insensitive remote or clone folds `State` and `state`). The team's own local refs (`refs/team/coordination`, `refs/team/incoming`, `refs/team/quarantine/`) already cannot collide with sync's, so the second half of D-12 is already true; add a test that pins it.
6. **D-13, hiding "Verify Team Log" in a team project is a small mistake.** A project that already has a team starts its session whatever the setting says, but its person then has no palette entry to check the log unless `nearAi.team.preview` is on. Hide only Enable behind the preview setting; show Verify Team Log when the preview setting is on or a session is running (set a context key such as `nearAi.team.active` when a session starts). Low cost, avoids a visible dead end.
7. **D-03, only one of the `fix(team)` commits is a Phase 60 behaviour fix.** The others (plain-words commits 0f5ea20, f6890da, 642b700, 7cb4dcf, and the Team Board fixes) are mostly later-phase text. See Q1 for the exact list; the third group is optional.
8. **D-16, more ids collide than the two families it names.** v0.7.0's REQUIREMENTS.md uses `TEAM-` (Teams channel) and `SETUP-` (messaging setup), which D-16 handles. In addition the shipped v0.4.0 archive (`.planning/milestones/v0.4.0-phases/`) already used `SEC-01`, `SEC-02`, `SEC-03`, `UX-01` and `UX-02` with other meanings, and v0.7.0 has `BUDG-01..04` next to v0.6.0's `BUDGET-01..05`. Not a conflict inside the live REQUIREMENTS.md, but the disposition record should say so; recommendation in Q6.
9. **D-06, a consequence worth stating to the owner.** The one device fingerprint and public key now appear in the signed log of every team and, because the coordination branch lives on the project's own remote, in a public repository if the project's remote is public. This links a person across projects. It is the accepted consequence in D-06; the disposition record and the preview Enable text should say it in plain words. Also, on a shared code-server the SecretStorage "install" can be one identity used by several people (see pitfalls); L2's SHRD-02 and SHRD-03 own the recovery side.

## Architectural Responsibility Map

This is a VS Code extension plus a git remote, so the tiers are: pure domain core (`src/domain`), Node I/O core without the editor (`src/team`), VS Code adapters (`src/services`), the editor manifest (`package.json`), and the project's git remote.

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Canonical JSON, event and payload signing input, verification | `src/domain/team` (pure) | none | Pure bytes in and out; the relay and Phase 70 can reuse it with no editor |
| Key status lookup (roster and local history) | `src/domain/team` (pure functions over state) | `src/team` (reads the history file) | The lookup is a function of state; only loading the history file is I/O |
| Private key creation, loading, signing | `src/team/identity.ts` | SecretStorage through the type-only `SecretStorageLike` | Key never leaves the closure-held `KeyObject` |
| Permission matrix and `device.rotated` rule | `src/domain/team/permissions.ts` | none | One decision point for write and read (Phase 60 D-12) |
| Local solo key history file | `src/team` (I/O) | `src/services` supplies the folder (`globalStorageUri`) | Core stays editor-free; the adapter passes a path |
| Cross-process locks for mirror and key history | `src/services/stateMirrorLock.ts` (existing) | `src/team` imports it | One lock implementation in the product (D-11) |
| Coordination mirror, fetch, append, push | `src/team/gitTransport.ts` | the project's git remote | Compare-and-swap push on `refs/heads/near-ai/coordination` |
| `team.json` parsing and reserved ref refusal | `src/team/teamFile.ts` | none | Attacker-influenced input is validated in the I/O core before any use |
| Commands, status bar, preview setting, palette hiding | `src/services/team` and `package.json` | none | Only these touch `vscode` |
| Activation cost for solo projects | `src/extension.ts` (one `registerTeamMode`) | `teamCommands.ts` does one `fs.stat` | Solo parity (D-14) |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` (Ed25519 `generateKeyPairSync`, `sign`, `verify`, SHA-256) | built in (Node 24.22.2 here; the extension runs on the editor's Node) | Signatures, fingerprints, ULID randomness | Phase 60 already uses it for the whole core; no dependency `[VERIFIED: ae5e9e1:src/team/identity.ts imports from 'node:crypto']` |
| `node:fs/promises`, `node:child_process`, `node:os`, `node:path` | built in | Atomic writes, git, locks | Same |
| system `git` | 2.53.0 here | Coordination mirror, plumbing commands | Phase 60 transport runs the user's own git `[VERIFIED: git --version]` |
| `node:test` runner through `scripts/run-tests.mjs` | Node 24 | Tests | The repo's only test runner `[VERIFIED: scripts/run-tests.mjs, package.json scripts.test]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `src/services/stateMirrorLock.ts` (`acquireFileLock`, `withFileLock`, `MirrorBusyError`) | in repo | Cross-process lock for the team mirror and the key history | Replaces the branch's `mirrorProcessLock.ts` (D-11) |
| `src/test/helpers/gitFixtures.ts`, `syncFixtures.ts`, `stateFixtures.ts` | in repo | Real-git fixtures for the isolation test | The team-and-sync-at-once test |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `acquireFileLock` inside the transport's existing `exclusive()` | `withFileLock` replacing both the in-process and file lock | `withFileLock` is shorter, but the branch's tests (3e11c0e) and its busy handling are written around `exclusive()` returning `undefined` on busy; keep that structure and swap only the acquire call |
| Hard-coding the reserved sync refs in `teamFile.ts` | Importing `STATE_REF` and `INCOMING_REF` from `src/services/stateTransport.ts` | Importing couples a pure parser to the sync transport; hard-code two string constants and pin them with a test that imports the real constants |

**Installation:** none. No new runtime or dev dependency (the existing `relayIsolation.test.ts` already asserts the manifest has no `dependencies` key `[VERIFIED: src/test/relayIsolation.test.ts:32-34]`).

**Version verification:** not applicable, nothing is installed. Toolchain parity checked: `git diff 6f779f3 HEAD -- package.json tsconfig.json` shows only the version bump and no change to `engines`, `typescript`, `@types/vscode` or compiler options `[VERIFIED: git diff]`.

## Package Legitimacy Audit

No external package is installed or added by this phase. `node:crypto` and the other imports are Node built-ins, and the lock reuse is an in-repo module.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | n/a | n/a | n/a | n/a | n/a | n/a |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Research Findings

### Q1. Post-Phase-60 commits on Phase 60 files (D-03)

**Method.** The 47 non-planning files Phase 60 changed are `git diff --name-only ec53121^ ae5e9e1 -- . ':!.planning'` (listed in Appendix A). `git log ae5e9e1..origin/feat/team-fix-pass` over exactly those paths returns 97 commits `[VERIFIED: git log, counted]`. The branch has 777 commits above the fork point 6f779f3 `[VERIFIED: git rev-list --count 6f779f3..origin/feat/team-fix-pass]` (the roadmap's "776" plus the archive commit). `ae5e9e1` is 674 commits before the tip.

**Result: 5 commits are Phase 60 fixes or optional Phase 60 polish (T1: 1 commit, T2: 2, T3: 2); the other 92 are later-phase or unrelated. The RED test commit `2ce4981` does not touch a Phase 60 file, so it is outside the 97 but goes with T1.**

| # | Commit(s) | Verdict | Reason | Applies to the ae5e9e1 file? |
|---|-----------|---------|--------|------------------------------|
| T1 | `3e11c0e` (and its RED test commit `2ce4981`, which touches only the new file `src/test/teamSharedMirror.test.ts`) | **Take** | Real Phase 60 bug found by `teamConcurrency` under load: two windows of one VS Code share one mirror folder, so an append could land an event with a stale position, the trusted head could look like a rewrite, and entries could be applied twice. The fix adds invariants plus a cross-process lock | `patch --dry-run` of the `src/team/gitTransport.ts` part on the `ae5e9e1` file applies all 12 hunks with offsets of up to 10 lines and fuzz 1 on two, no rejects `[VERIFIED: patch --dry-run this session]`. The diff holds no Phase 61 or 62 code (it touches `gitTransport.ts` and four new files only). `AppendFailureKind` already includes `'busy'` at `ae5e9e1` (`team/transport.ts:17`) and the transport already returns it (`gitTransport.ts:706`, `:710`) `[VERIFIED: grep over the extracted ae5e9e1 tree]`, so no `types.ts` or `transport.ts` change |
| T2 | `9e49bc5` and its test commit `35ac2b9` | **Take** | Root cause of an intermittent `teamSession` failure ("3 !== 1 / 2 !== 1 paused writes under load"): the dedupe key included git's raw reason, which carries the connect time. `sameFailureKey` strips time and byte figures. Same flake would hit CI on `main` | `teamSession.ts`: hunks 1 and 2 apply with offsets; hunk 3 (the one line `const key = ...status.reason ?? ''...`, line 323 in the `ae5e9e1` file) needs a one-line manual edit; hunk 4 (the `key-install` warning) is Phase 61 code that does not exist at `ae5e9e1` and must be skipped `[VERIFIED: patch --dry-run, 2 of 4 hunks failed, causes read]` |
| T3 | `0f5ea20` and `f6890da` (optional) | **Take the Phase 60 strings only, planner's call** | "Plain words" polish: status bar sentences ("Team sync paused: remote unreachable" becomes "...: offline", "log rewritten" becomes "record changed"), fixed plain tooltips, `VERIFY_SENTENCE`, "Verify Team Log" becomes "Check Team Record" (id unchanged), "team log changed too often" becomes "team record changed too often". The status bar shows in any team project, so the developer terms are user-visible; the repo rule is plain language | Does **not** apply as a patch: the hunks sit beside Phase 61 and 62 code (`removedText`, `OPEN_BOARD_COMMAND`, share flow, import failures). Hand-copy the string constants and update the assertions in `teamSession`, `teamCommands`, `teamManifest` tests deliberately (not weakening: they assert the new wording) |

**Left on the archive (92 commits).**

| Group | Commits | Reason |
|-------|---------|--------|
| Phase 61 invitations, joining, sealed keys, organization link, membership UI (53) | `adf7424 18c44f5 ea1efdc 014feb0 76cfe28 be525a2 33e6175 2f333ba f9a5677 8679aaa a9ba014 058ad2f 3c3a475 6c6e3a4 24fe8d5 029c1b2 2cb7510 42d43b3 0f069d9 346a1cb d29203e ca69a07 b6f002c cdfaac5 0ad3a81 a72be6a 2a82873 020dff5 bdbd0fb 5848bb7 8ac43ad c078d2c 54af90d b1f035f 8cc8b05 66f5ae0 1d25cbf fa7db9c a5965e1 fe0d122 8d38627 d30d97f d796826 984e31c 60cb85a 27b358c 8eb0816 83de689 3db137e 889a718 3cf3f63 87f3d04 9fb9c07` | Add `member.invited`, join after genesis, `member.key-sealed`, NEAR link, invite and join commands, the sidebar Team section. `2f333ba` ("key rotation and the lead's attention list") is rotation of a member's sealed NEAR key, not of a device key, so it is not the TMR-05 `device.rotated`. `cdfaac5` (the `restartSession` slot) only matters once Join exists. `b6f002c` pins the NEAR link. `2a82873`, `5848bb7`, `8ac43ad` word Phase 61 sentences "your organization" (Phase 60 text has no "NEAR organization" `[VERIFIED: grep over ae5e9e1 team sources]`) |
| Phase 62 and 62.1 work items, board, assignment (33) | `0f67102 6f9b9cf 3a7cc6d c774ab3 95127b7 0ca6994 7a76a8a 2f103e7 5091dce ca65f9a c19a59d 22a5101 ade1b2d ac2ce6b cb23b59 bc0c3ea 0b9cda9 3bf3079 cf72101 101ec90 36950bd 7a6ba7d 84f093b 9840154 954e34d 5ec1474 40d2b91 6145c35 250507c 54092d7 10aebf3 d24cf56 3cfd9f6` | Eight work item events, snapshots carrying items, GSD import, Team Board, assignment. `cb23b59` (cap `--wasm-max-mem-pages` for the fake NEAR server's `fetch`) is only needed by Phase 61 and 62 rig tests; Phase 60 tests do not `fetch`. `0b9cda9` adds `maxStdoutBytes` to `runGit` for the planning import only |
| Non-team commits that only touch `package.json` or `src/extension.ts` (6) | `d637578 403c06e aab035e ddbde73 6f779f3 85bfec9` | Spend fixes, the 0.4.11 release, the proxy suggestion and merges. All of that content is already on `main` (0.4.11 and later) |

**Files to take from `ae5e9e1` wholesale, not from the tip.** At the tip `materialize.ts`, `types.ts`, `validate.ts`, `permissions.ts`, `eventLog.ts`, `teamFile.ts`, `secrets.ts`, `identity.ts`, `enable.ts` and `auditMirror.ts` all carry Phase 61 and 62 bodies, so cherry-picking from the tip entangles. Re-applying the `ae5e9e1` version of each file and then hand-adding T1, T2 and (optionally) T3 is the clean path.

**Do not touch main's own team files.** `main` already has `src/test/teamStudio.test.ts`, `teamStudioPage.test.ts`, `teamInvocation.test.ts`, `agentTeams.test.ts`, `teamStorage.test.ts`, `teamKnowledge*.test.ts`, `teamUpdate*.test.ts`, `teamBuilder.test.ts`, `teamGraph.test.ts`, `teamWorking.test.ts` and the services `teamStudio*.ts`, `teamStorage.ts`, `teamUpdates.ts` `[VERIFIED: ls src/test, src/services, src/domain]`. The archive has older versions of some of these (Team Studio, Invocation). A glob such as `git checkout ae5e9e1 -- 'src/test/team*.test.ts'` would overwrite them. Use the explicit 47-file list in Appendix A. No Phase 60 file name collides with an existing `main` file `[VERIFIED: ls compared against the list]`.

**Can 3e11c0e's `mirrorProcessLock.ts` be replaced by `stateMirrorLock.ts`? Yes, as a drop-in.**

| Item | Branch `mirrorProcessLock.ts` | `main` `stateMirrorLock.ts` |
|------|-------------------------------|-----------------------------|
| Acquire | `acquireMirrorLock(mirrorDir, options)` fixed file name | `acquireFileLock(dir, fileName, options)`; `acquireMirrorLock` is a wrapper over it with the sync file name |
| Options | `MirrorLockTimings {staleMs, refreshMs, waitMs}` plus `sleep`, `random` | identical, plus optional `busy` factory |
| Held lock | `HeldMirrorLock { release() }` | identical |
| Busy error | `MirrorBusyError` (message "this team") | `MirrorBusyError` (message "this project"); the transport catches the class and uses its own `MIRROR_BUSY_*_REASON` text, so the message is not shown |
| Defaults | stale 60 s, refresh 5 s, wait 120 s | identical (`DEFAULT_LOCK_STALE_MS = 60_000`, `DEFAULT_LOCK_REFRESH_MS = 5_000`, `DEFAULT_LOCK_WAIT_MS = 120_000`) |
| Lock file name | `near-ai-sync.lock` | `export const MIRROR_LOCK_FILE = 'near-ai-state-sync.lock';` (sync) |
| In-process chain | none (the transport keeps its own `mirrorLocks` map) | `withFileLock` keeps a map keyed by the full lock path |

`[VERIFIED: both files read in full this session; main's header says "Shaped after the Team transport's lock (unmerged branch, copied, never imported)"]`. What changes in the port: in `GitTransport.exclusive()` call `acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE, { ...this.lockTimings, sleep: this.sleep, random: this.random })` with `TEAM_MIRROR_LOCK_FILE = 'near-ai-team-sync.lock'` exported from `gitTransport.ts`; catch `MirrorBusyError` from `../services/stateMirrorLock`; `src/test/helpers/mirrorLockChild.ts` calls `acquireFileLock` with the same name; `teamSharedMirror.test.ts` imports the constant from the transport instead of `MIRROR_LOCK_FILE`. `stateMirrorLock.ts` imports only `node:` modules, so `src/team` stays `vscode`-free. A runtime import from `src/team` into `src/services` is new (today only type imports of `../services/auth` exist); it is acceptable because the module header states it never imports `vscode`, and a boundary test (Validation Architecture) pins that. `stateLocks.ts` already reuses `withFileLock` with a `busy` factory, so reuse is the established pattern `[VERIFIED: src/services/stateLocks.ts:10 and 39]`.

### Q2. Drift between 0.4.11 and main that could break the ported code

Imports the Phase 60 source and test files take from modules that already existed on `main` (everything else imported is a Node built-in or another Phase 60 file) `[VERIFIED: grep of from-clauses over all 47 files at ae5e9e1]`:

| Import (Phase 60 file) | Status on main | Note |
|------------------------|----------------|------|
| `redactSecrets` from `../redaction` (`domain/team/secrets.ts:5`), `../domain/redaction` (`team/runGit.ts:3`) | Exists, same signature `redactSecrets(value: string): string` (`src/domain/redaction.ts:27`) | **Behaviour broader.** Main added `SECRET_ASSIGNMENT` (JSON-quoted names, `secret`/`password` names), `SECRET_TOKENS`, and two recovery-code patterns. `looksSecret` in `secrets.ts` flags a string when `redactSecrets(text) !== text`. Experiment this session over main's `redaction.ts`: 120,000 generated values (public keys, 64-byte signatures, `dev-` fingerprints, `mbr-` ids, `team-` ids, hex digests) gave 1 hit, an 86-character signature containing `sk-` followed by 20 or more base64url characters. Team code never scans a signature under any key except `sig`, which `isExemptKeyMaterial` exempts from the token patterns, so it is covered. Benign text such as "npm run lint" and "the password was changed" is unchanged; "password: hunter2" is redacted. Re-run `teamSecrets`, `teamValidate`, `teamLog`, `teamEnable` to confirm |
| `SecretStorageLike` type from `../services/auth` (`team/identity.ts:5`, `team/enable.ts:11`, `services/team/teamSession.ts:14`, `test/helpers/teamHarness.ts`) | Exists, same members: `get`, `store`, `delete` (`src/services/auth.ts:9-13`) | unchanged |
| `AuditEvent`, `AuditFilter` types from `domain/approval` (`teamSession.ts:9`, `team/auditMirror.ts:7`) and `AuditEventType` | Exist (`src/domain/approval.ts:9-12`, `:97`) | Phase 60's edit (add `'team-roster'`) re-applies: the lines are identical to the ones Phase 60 changed |
| `AuditStore` from `../auditStore` (`teamSession.ts:13`, `new AuditStore(root)`) | Exists, constructor `(workspaceRoot?, now = Date.now)`, still writes `.planning/.near-ai/audit.json` (`auditStore.ts:46`) | Main only changed the temp-file suffix to `randomBytes(8)`; `isAuditEventType` list (line 88) is the one Phase 60 extended and is unchanged, so the one-line edit re-applies |
| `vscode` API (`teamCommands`, `teamSession`, `teamStatusBar`) | Same `@types/vscode 1.101.0` and `engines.vscode >=1.101.0` as 0.4.11 `[VERIFIED: git diff]` | no API drift possible from the toolchain |

**Test runner and discovery on main.** `npm test` is `npm run compile && node scripts/run-tests.mjs dist/test/*.test.js scripts/test/*.test.mjs`; the runner spawns `node --test` with `TMPDIR` pointed at a per-run folder it removes at the end `[VERIFIED: package.json, scripts/run-tests.mjs]`. Files are flat `src/test/*.test.ts` compiled by `tsc` to `dist/test/`; helpers live in `src/test/helpers/` with no `.test.` suffix, so the glob does not run them; there is no config file and no lint other than `tsc --noEmit` (`npm run lint`). `node --test` isolates each test file in its own process by default, which the solo-parity test relies on (it inspects `require.cache`). Main has no vscode stub helper; tests that load vscode-importing modules install `Module._load` overrides inline (`approvalPolicyPicker.test.ts:183`, `activityView.test.ts:50`), so the ported `helpers/vscodeStub.ts` does not collide `[VERIFIED: ls src/test/helpers, grep _load]`. Helper names `MemorySecrets` and `gitIn` exist in both `teamHarness.ts` and main's `stateFixtures.ts`; import one under an alias in any test that uses both.

**Lint and architecture rules.** `npm run lint` is `tsc -p tsconfig.json --noEmit`; there is no ESLint and no test that enforces "no `vscode` in `src/domain` or `src/team`" or "domain imports nothing from services" (Phase 60 had none either, enforced by review). D-18 makes it a rule, so add one boundary test (Validation Architecture, W0-4). The CI also runs `secret-scan`: `node scripts/secret-scan.mjs` scans every tracked file and every line added in the PR range against `SECRET_RULES` in `scripts/lib/workflow.mjs`. All 47 Phase 60 files at `ae5e9e1` pass those rules with no allowlist entry (checked by running `scanLine` over them) `[VERIFIED: node script over the extracted files, no output]`. Fixtures are built from `randomBytes` at run time (`teamCanary.ts:19-31`), so no literal key exists. New tests and this document must not contain a literal PEM private-key header or a long `sk-` token.

**Other drift seen and judged harmless.** Main's `.gitignore` already lists `.planning/.near-ai/` and Enable uses `git add -f` for `team.json` at `ae5e9e1:src/team/enable.ts:307`; `activationEvents` already contains `workspaceContains:.planning/.near-ai/**`, which covers `team.json`; Node 24 here and the editor's Node (engines unchanged) both have the crypto APIs used; `git` 2.53.0 runs the plumbing the transport uses.

### Q3. `extension.ts` and `package.json` on main

**`src/extension.ts`.** Phase 60's two lines are an import and a call. On `main`, the import goes after `import { registerSpendTracking } from './services/spendTracking';` (line 32) and the call `registerTeamMode(context);` goes after `registerSpendTracking(context, auth);` (line 130) and before `registerSpendingLimits(context, auth);` (line 131), the same neighbours as at `ae5e9e1` `[VERIFIED: grep -n on src/extension.ts]`. `registerTeamMode(context)` returns a handle, is lazy, and for a solo project does one `fs.stat` (`teamSoloParity.test.ts:84`).

**`package.json` contributions.** Contribution sections on main are `commands` (42 entries), `viewsContainers`, `views`, `chatParticipants`, `configuration` and `menus`; `menus` holds only `view/title` today and has no `commandPalette` key `[VERIFIED: python read of package.json]`. Phase 60's diff appends two entries to `contributes.commands` (`nearAi.team.enable`, title "Enable Team Mode", icon `$(organization)`; `nearAi.team.verifyLog`, title "Verify Team Log", icon `$(verified)`; both category "NEAR AI") and one setting `nearAi.team.pollSeconds` (number, default 15, minimum 5, maximum 3600, scope application) at the end of the configuration properties; re-apply by hand (the diff context lines differ because main has more commands and settings) `[VERIFIED: git diff ec53121^ ae5e9e1 -- package.json]`.

To hide the commands (D-13), add a `commandPalette` array under `menus`:

```json
"menus": {
  "view/title": [ ... unchanged ... ],
  "commandPalette": [
    { "command": "nearAi.team.enable", "when": "config.nearAi.team.preview" },
    { "command": "nearAi.team.verifyLog", "when": "config.nearAi.team.preview || nearAi.team.active" }
  ]
}
```

and add the setting:

```json
"nearAi.team.preview": {
  "type": "boolean",
  "default": false,
  "scope": "application",
  "description": "Shows the Team Mode commands in the Command Palette. Team Mode is an early preview: until invitations arrive, a team holds only its owner."
}
```

VS Code documents that a `when` clause can read any boolean setting with the `config.` prefix, and that `menus.commandPalette` takes a `when` condition to control whether a command is visible in the palette `[CITED: code.visualstudio.com/api/references/when-clause-contexts and /api/references/contribution-points]`. That `config.` works for an `application`-scope setting is standard behaviour but not stated on those pages `[ASSUMED: A3]`; the e2e run can confirm it (see Validation Architecture, an optional probe). The `nearAi.team.active` key is set with `vscode.commands.executeCommand('setContext', ...)` in `teamSession` start and cleared on dispose, the only `vscode`-touching addition.

**Tests that enumerate package.json and what changes.** No test on main enumerates all commands or all settings. The tests that read `package.json` check specific entries: `setupSteps.test.ts:402-409` (two named commands), `syncFlows.test.ts:717` and `syncControl.test.ts:379` (sync entries), `config.test.ts:23`, `stateHome.test.ts:137`, `relayIsolation.test.ts:32` (no `workspaces`, no `dependencies`). The e2e test "activates in a project set up with the extension and registers every contributed command" (`src/test/e2e/suite.ts:50`) checks that every contributed command has a handler, which holds because `registerTeamMode` registers both team commands unconditionally (as at `ae5e9e1`). The ported `teamManifest.test.ts` is the equivalent contract test and must change in three places: (a) assert the `commandPalette` entries and the new setting (type boolean, default false, scope application, plain description, no em-dash); (b) its "dependencies equal those at the merge base with main" test runs `git merge-base HEAD main`, which on a branch of `main` returns `HEAD` itself and compares the manifest with itself; replace it with the two assertions `manifest.dependencies === undefined` and `devDependencies` deep-equal to a literal captured from `origin/main` (or simply rely on `relayIsolation.test.ts` for the first); (c) it asserts titles "Enable Team Mode" and "Verify Team Log", which T3 may rename.

### Q4. Mirror and ref isolation (research flag 2, D-11, D-12, D-15)

| Thing | Team Mode (`ae5e9e1`) | Phase 27 sync (main) | Can one touch the other? |
|-------|----------------------|----------------------|--------------------------|
| Mirror folder | `<globalStorage>/team/<teamId>/coordination.git` (`teamStorageDir` and `path.join(storage, 'coordination.git')`); `teamId` must match `/^team-[0-9a-f]{32}$/` (`validate.ts:11`) so it cannot traverse | `<globalStorage>/sync-mirrors/<mirrorFolderName(root)>/mirror.git`; `mirrorFolderName` is the first 16 hex of SHA-256 of the resolved project root (`syncFlows.ts:300-302`); `syncCommands.ts:136` sets `mirrorRoot: path.join(context.globalStorageUri.fsPath, 'sync-mirrors')` | No. Different parent folders under one `globalStorage`; neither name derives from the other |
| Lock file | `near-ai-team-sync.lock` inside `coordination.git` (new name after the swap) | `near-ai-state-sync.lock` inside `mirror.git` (`MIRROR_LOCK_FILE`), and `stateLocks.ts` uses `<project>/.near-ai/locks/<name>.lock` | No. Different directories, and `withFileLock` keys its in-process chain by the full path |
| Local refs inside the mirror | `refs/team/coordination` (`LOCAL_REF`), `refs/team/incoming` (`INCOMING_REF`), `refs/team/quarantine/` | `refs/near-ai/incoming` (`INCOMING_REF`) | No. Different namespaces; they never share a mirror anyway |
| Remote branch | default `refs/heads/near-ai/coordination` (`DEFAULT_COORDINATION_REF`), value taken from `team.json` `coordination.ref` | `refs/heads/near-ai/state` (`STATE_REF`) | **Only through `team.json`.** The ref pattern is `COORDINATION_REF_PATTERN = /^refs\/(heads|near-ai)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/`, which accepts `refs/heads/near-ai/state`, `refs/heads/near-ai/state/x`, `refs/heads/near-ai` and `refs/near-ai/incoming` |
| Pin and trust files | `<globalStorage>/team/<teamId>/pin.json` (default `path.join(path.dirname(mirrorDir), 'pin.json')`), `trust.json`, `audit-mark.json` | none in sync | No |

`[VERIFIED: gitTransport.ts:17-22 and :232, teamFile.ts:14-17, stateTransport.ts:21-23, stateMirrorLock.ts:16, syncFlows.ts:300-302 read this session]`.

**What `team.json` validation must refuse (D-12).** In `parseTeamFile`'s `validRef`, after the existing pattern and `isGitRefName` checks, refuse a `coordination.ref` that, compared case-insensitively, (1) equals `refs/heads/near-ai/state`, (2) starts with `refs/heads/near-ai/state/`, (3) is a proper prefix of it (`refs/heads/near-ai`, which git cannot hold beside `refs/heads/near-ai/state`), or (4) equals or starts with `refs/near-ai/incoming`. Error text follows the existing style (names the field, never the value): `team.json has a missing or invalid "coordination.ref" and was not used.` Keep the two sync refs as string constants in `teamFile.ts` and add a test that imports `STATE_REF` and `INCOMING_REF` from `src/services/stateTransport.ts` and asserts equality, so a rename on the sync side fails a team test. Also reject the same value in `enable.ts` input if it ever takes a ref (today Enable always writes `DEFAULT_COORDINATION_REF`). For L2, note `policy.integrationBranch` goes through `isGitRefName` only; Phase 65 should refuse `near-ai/state` there too (record in the disposition notes, not this phase).

**D-15, `.planning/.near-ai/team.json` and main.** Phase 26 and 27 keep project state in `<project>/.near-ai/state` and `<project>/.near-ai/locks` (`stateHome.ts:209` lists tracked files under exactly `.near-ai/state` and `.near-ai/locks`; `scratch.ts:23` `STATE_DIR = '.near-ai/state'`). A grep for `planning` over `stateMigration.ts`, `stateSync.ts`, `syncFlows.ts`, `stateRecords.ts`, `stateTransport.ts` and `stateLocks.ts` finds nothing, and sync is allow-list based (`SYNCED_KINDS` in `stateRecords.ts:21`: `thread-meta, thread-context, marker, checkpoint, comparison, choice, spend, pickup, profile, secret`), so it never reads `.planning/.near-ai/` `[VERIFIED: grep, stateRecords.ts:21 read]`. `stateTwoMachines.test.ts:325` already plants a decoy `team.json` beside the state and proves it is never sent. `src/domain/protectedPaths.ts:14` makes any agent write under `.planning/.near-ai` ask the person (`PROTECTED_WRITE`), which also protects `team.json` from agent edits; nothing treats `team.json` specially beyond that. Conclusion: no change to the location; add one new test that runs a sync with a real `team.json` present and asserts the file is byte-identical afterwards and its content never appears in the remote payloads.

### Q5. TMR-05 design: one identity per person, one signer, key status, `device.rotated`

#### 5.1 What Phase 60 assumes about per-team keys, and what changes

`[VERIFIED: grep over the ae5e9e1 tree for deviceKeySecretName, createDeviceIdentity, loadDeviceIdentity, forgetDeviceIdentity, DEVICE_KEY_SECRET_PREFIX]`

| Place | Assumption | Change |
|-------|-----------|--------|
| `team/identity.ts:9-14` | `DEVICE_KEY_SECRET_PREFIX = 'nearAi.team.deviceKey.'`, `deviceKeySecretName(teamId)`; `DeviceIdentity` has `readonly teamId` | One constant `DEVICE_KEY_SECRET = 'nearAi.identity.deviceKey'`; drop `teamId` from `DeviceIdentity`; `createDeviceIdentity(secrets)` and `loadDeviceIdentity(secrets)` lose the `teamId` argument; add `loadOrCreateDeviceIdentity(secrets, { lockDir? })` returning `{ identity, created }` |
| `team/identity.ts:40-47` | "This device already has a key for this team" refusal in `createDeviceIdentity` | Keep the refusal under the new name (a second key must never silently replace the first); `loadOrCreate` is the only entry that creates on first need |
| `team/enable.ts:255` | `createDeviceIdentity(input.secrets, teamId)` per Enable | `loadOrCreateDeviceIdentity(input.secrets)`; remember `created` |
| `team/enable.ts:150` (inside `rollback`) | `forgetDeviceIdentity(secrets, teamId)` on any definite failure | Forget only when this Enable created the key and no key history record or other roster refers to it (decisions to revisit, item 3). "Unconfirmed push keeps the key" (WR-01, `teamEnable.test.ts:398`) is unchanged |
| `services/team/teamSession.ts:188` | `loadDeviceIdentity(deps.secrets, deps.teamFile.teamId)`; on no key the session is read-only | `loadDeviceIdentity(deps.secrets)` (never create at session start, so opening a team project writes nothing new). The adoption step already matches by fingerprint (`teamSession.ts:382`, `state.deviceIndex.get(this.identity.fingerprint)`), so a key not yet bound in this team's roster gives a read-only session with the existing text; reword `READ_ONLY_TEXT` so it does not say "for this team" |
| `test/helpers/teamHarness.ts:78-80` `createOwner(teamId)`, `teamEvents.ts:27`, `teamAppendChild.ts:49` | each test actor gets a fresh key via `createDeviceIdentity(secrets, teamId)` and `actor.identity.teamId` | Fresh `MemorySecrets` per actor already gives each actor its own key under the single name; drop the `teamId` argument and the `actor.identity.teamId` read (`teamEvents.ts:27` becomes `createDeviceIdentity(secrets)`) |
| `test/teamIdentity.test.ts` (all 8 tests) | name prefix, per-team refusal, `deviceKeySecretName` | Rewrite for the single name; keep the Ed25519-type check, the unreadable-value check, the no-private-key-in-the-object check and the 16 KB oversize check |
| `test/teamEnable.test.ts` lines 215, 366-375, 418-431, 487-511, 575-592, 611 | one key per team, "the device key is gone" after a failed push, canary scanners over `deviceKeySecretName(teamId)` | Adapt to the single name and add "an identity that existed before a failed Enable is untouched"; `deviceKeyForms` scanning of every rendering of the private key stays |
| `test/teamCommands.test.ts:286` | `p.secrets.values.get(deviceKeySecretName(teamFile.teamId))` | single name |

Nothing in `domain/team` knows key names; the event, snapshot and materializer code only see fingerprints. The roster binds one fingerprint per device and rejects reuse inside a team (`R.deviceTaken`), which still holds: two members of one team can never share the person's key.

#### 5.2 The signed envelope and signing input (D-08)

Domain separation by prefix works because the two inputs cannot be equal: a team event is signed as the canonical JSON of the envelope without `sig` (`canonical.ts:76-79`), which always starts with the byte `{`; a payload is signed as `near-ai-vscode/signed-payload/v1\n<purpose>\n` followed by canonical JSON, which starts with `n`. Two byte strings with different first bytes are never the same signing input, so a payload signature cannot verify as an event and the reverse (add both directions as tests). The purpose is in the prefix and also inside the envelope, but the verifier takes the expected purpose from its caller and never trusts the envelope's own field to choose the rule.

```ts
// src/domain/team/signedPayload.ts  (pure: imports node:crypto, ./canonical, ./types only)
export const PAYLOAD_DOMAIN = 'near-ai-vscode/signed-payload/v1';
export const PAYLOAD_PURPOSES = ['policy-bundle', 'grant', 'approval-answer', 'key-record'] as const;
export type PayloadPurpose = typeof PAYLOAD_PURPOSES[number];

export interface PayloadSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string }
export interface PayloadSignerRef { fingerprint: string; publicKey: string; memberId?: string }   // omit the key when absent: canonicalize() throws on undefined

export interface SignedPayload<T = unknown> {
  v: 1;                       // 1 means Ed25519 over exactly this signing input; any other algorithm or input takes v 2 beside it
  purpose: PayloadPurpose;
  signer: PayloadSignerRef;   // same field names as a DeviceRef (publicKey) so assertNoSecrets' key exemptions apply
  signedAt: string;           // ISO text, signed, claimed by the signer (see decisions to revisit, item 1)
  payload: T;                 // canonical-JSON-safe: safe integers only, no floats, no undefined
  sig: string;                // base64url, 64 bytes; key name 'sig' keeps the existing detector exemption
}

export function payloadSigningInput(unsigned: Omit<SignedPayload, 'sig'>): Buffer {
  return Buffer.concat([Buffer.from(`${PAYLOAD_DOMAIN}\n${unsigned.purpose}\n`, 'utf8'), canonicalBytes(unsigned)]);
}
```

Key points for the plans:

- `signPayload(signer, purpose, payload, options?)` refuses an unknown purpose, a payload that fails the canonicaliser (floats, `undefined`, depth over 16), a payload over `MAX_PAYLOAD_BYTES` (recommend 256 KiB, a verifier-side constant that can be raised without a format change), and a payload that `assertNoSecrets` flags (same write guard as events, D-23 of Phase 60; recommend on by default, with the existing `publicKey` and `sig` exemptions, and tests with a canary). It sets `signedAt` from an injected clock. It returns the envelope; it never returns or stores the private key.
- `verifyPayload(envelope: unknown, expected: { purpose; status: KeyStatusLookup; maxBytes? })` never throws (wrap everything, as `verifySignature` does). Order of checks, first failure wins: shape and `v === 1`; size; `purpose` equals `expected.purpose` and is in the closed list; `signer.publicKey` is strict base64url of 32 bytes and `fingerprintOf(rawKey) === signer.fingerprint` (this stops an envelope that claims one fingerprint with another key); signature valid over `payloadSigningInput`; then key status from the lookup: `unknown` refused ("this key is not known on this computer"), `revoked` refused, `rotated` refused when `signedAt >= since`. Returns `{ ok: true, payload, signer, signedAt }` or `{ ok: false, reason, message }` with `reason` from a closed list (`malformed`, `unsupported-version`, `unknown-purpose`, `wrong-purpose`, `too-large`, `key-mismatch`, `bad-signature`, `unknown-key`, `key-revoked`, `key-rotated`) and a plain-words `message` with no em-dash.
- Money and other numbers: the canonicaliser accepts safe integers only (the `number` case of `write()` in `domain/team/canonical.ts` throws `numbers must be safe integers`). The spike's DID draft carries `"spend": { "usd": 50.0 }`; `50.0` parses to the integer 50 but `0.5` would be refused. Phases 70 and 71 must express money in integer nano-USD (v0.6.0's rule) or basis points; write this in the module header and in a test that shows a float payload is refused with a plain message.
- Not a W3C proof: this is not `eddsa-jcs-2022` (that suite hashes the proof options and document separately). Phase 71 can wrap a DID document as a payload (`purpose` added to the list) and later add a W3C proof beside it under a new `v`; nothing here blocks that.

#### 5.3 Key status lookup (D-09)

```ts
// src/domain/team/keyStatus.ts (pure)
export type KeyState = 'active' | 'rotated' | 'revoked' | 'unknown';
export interface KeyStatus { state: KeyState; since?: string; replacedBy?: string; reason?: string }   // since: ISO, the rotation event's `at`
export type KeyStatusLookup = (key: { fingerprint: string; publicKey: string }) => KeyStatus;

export function teamKeyStatus(state: Pick<TeamState, 'members' | 'deviceIndex'>): KeyStatusLookup;   // from the roster
export function combineKeyStatus(...lookups: KeyStatusLookup[]): KeyStatusLookup;                   // worst state wins: revoked > rotated > active > unknown
```

- Team source: a fingerprint maps through `deviceIndex` to a member and a `DeviceKey`. `revokedEvent` set gives `revoked`; `rotatedEvent` set gives `rotated` with `since` = the rotation's `at` and `replacedBy` = the new fingerprint; a removed member (`removedEvent`) gives `revoked` with reason "removed from the team"; not in the index gives `unknown`; otherwise `active`. `DeviceKey` gains three optional fields, omitted when absent so a log with no rotation serialises and hashes exactly as before: `rotatedEvent`, `rotatedAt`, `rotatedTo`. Update `parseDeviceKey` (`materialize.ts:385` lists the optional keys `['revokedEvent', 'revokedBy']`), the snapshot (de)serialiser and its inconsistency checks, and the snapshot signer check at `materialize.ts:549` (a snapshot signed by a rotated-out device after the rotation is refused like a revoked one).
- The caller decides which sources apply; `combineKeyStatus` is a helper, not a rule. A solo policy bundle (Phase 70) consults the local history only. A grant or approval that is recorded in a team's log consults that team's roster, and may also combine the local history. A person removed from team A is `revoked` in A's lookup and still `active` in their own local history, so never combine A's lookup into a solo check.
- Agent keys (DLGT-01) get their own source later (a lookup over the grant chain); the interface already allows it because it is keyed by fingerprint and public key, not by roster membership.

#### 5.4 The `device.rotated` event (D-04, D-09), with positional semantics (Phase 60 D-11)

Add `'device.rotated'` to `TEAM_EVENT_TYPES` after `'device.revoked'` and to `IMPLEMENTED_EVENT_TYPES`, so the implemented set is eleven. No test asserts the union's length (`grep` finds none besides `IMPLEMENTED_EVENT_TYPES.length` in `teamValidate.test.ts:213`, which follows the constant).

| Aspect | Rule |
|--------|------|
| Body (exact keys, unknown keys rejected, like the others) | `{ memberId: string, from: string /* fingerprint */, device: DeviceRef /* the new key */ }` (`DeviceRotatedBody`) |
| Who signs | The member rotating their own key: `event.author === body.memberId` and `event.device === body.from` (signed by the key it retires). Owner or lead rotating another member's key: author is the owner or lead, signed by their own device. Matrix row `device.rotate`: owner true, lead true, developer, reviewer, observer `'self'` (same shape as `device.add` and `device.revoke`, `permissions.ts` matrix), and the existing D-32 rule applies: a lead cannot rotate a device of the owner (`PERMISSION_REASONS.leadOnOwnerDevice`) |
| Validation (in order, after the Phase 60 steps 1 to 5) | member exists and is not removed (`memberMissing`, `memberRemoved`); `from` is bound to that member (`deviceNotBound`) and is not revoked or already rotated (`deviceRevoked`, new `deviceRotated: 'device is already rotated'`); `device.fingerprint` is not in `deviceIndex` (`deviceTaken`); `validateDeviceRef` on the new key |
| Transition (one atomic step) | `from` key gets `rotatedEvent`, `rotatedAt`, `rotatedTo`; a new `DeviceKey` for `device` is added (`addedBy` the author, `addedEvent` the event id); `deviceIndex` gets the new fingerprint and keeps the old one so it can never be registered again. No moment with two active keys and none |
| Positional (D-11) | An event whose signing device is rotated at an earlier position is rejected with a new reason `rotatedDevice: 'device was rotated before this event'` (add beside `revokedDevice` in `TEAM_REJECTION_REASONS`, check next to `materialize.ts:92`). Events at or before the rotation stay valid |
| Last-device rule | The rotation does not trip `lastDevice` (net active devices unchanged). In `device.revoked`, count only devices that are neither revoked nor rotated (`materialize.ts:141` filters on `revokedEvent` alone), and allow revoking an already rotated key (a retired key found copied must become `revoked`); skip the last-device test for it |
| Size and secrets | Passes `assertNoSecrets`; the new key's `publicKey` is under the exempt key name |
| No proof of possession | Parity with `device.added`, which has none. A rotation to a key the member does not hold bricks that member until a lead rotates again. Phase 61's invite countersignature is the model if L2 wants one |

Tests to add or extend: `teamValidate` (body schema, unknown keys), `teamPermissions` (the row, the lead-on-owner denial, the table-driven spec test), `teamMaterialize` (transition, positional rejection, snapshot round trip, deterministic property test with rotation in the generator, `lastDevice` counting), `teamForgery` (an unbound or already rotated `from`), `teamLog` (write side refuses with the read-side text).

#### 5.5 Solo key history (no team)

Where: `<globalStorage>/identity/key-history.json`, the folder passed in by the adapter (`context.globalStorageUri.fsPath`) so `src/team` stays editor-free. Not in the project: it is per person per install, and a path in the project would sync or commit it.

Format (version 1): `{ "version": 1, "records": [ SignedPayload ... ] }`, each record a `SignedPayload` with purpose `key-record` and payload `{ seq, prev, kind, key, next?, at }`, where `seq` counts from 1, `prev` is `''` for the first record and otherwise the SHA-256 hex of the previous record's canonical bytes, `kind` is `created | rotated | revoked`, `key` is a `DeviceRef`, and `next` is the new `DeviceRef` for `rotated`. A pure `replayKeyHistory(records)` checks the chain and the signatures (a `created` is signed by its own key; a `rotated` by the key it retires; a `revoked` by that key or by the then-active key) and returns `{ ok: true, current, lookup }` or `{ ok: false, reason }`. A broken or tampered history fails closed: every key is `unknown`, so Phase 70 falls to its floor with a plain message, never to "everything trusted". The first record (`created`) is written when `loadOrCreateDeviceIdentity` creates the key, so "active" has a basis.

Writes reuse `writeFileAtomic` and `runSerialised` from `team/teamFile.ts` (exported there, temp file in the same folder then rename), and take the cross-process lock with `withFileLock(dir, 'key-history.lock', ...)` from `stateMirrorLock.ts` so two windows never interleave a read-modify-write `[VERIFIED: teamFile.ts:151-186 read at ae5e9e1]`. Creation of the identity itself needs the same lock around "check, then create, then store, then read back" because two windows can race on SecretStorage (see pitfalls). A cheap tamper check recommended but optional: store the head hash (`seq` and last record hash) in SecretStorage under a second name so a truncated file, which a chain alone cannot show, is detected `[ASSUMED: A5]`.

No command or UI for rotation or revocation belongs in this phase. The deliverables are the event, the lookup, the history functions and `prepareRotation`/`commitRotation` style helpers on the identity module that keep the previous private key until every roster has recorded the rotation (L2's "Replace my device", SHRD-03, owns the flow).

#### 5.6 Constraints from Phases 70, 71 and 80 and the DID drafts

`[VERIFIED: ROADMAP.md Phases 70, 71 and 80, REQUIREMENTS.md OFFL-02, DLGT-01, DLGT-03, APRV-02, openshell-spike/did/parent.did.json read]`

| Consumer | What it needs from the signer | Does the design give it? |
|----------|-------------------------------|--------------------------|
| Phase 70, OFFL-02 | A bundle "signed by a person's device identity"; "a fresh install creates and signs its first bundle"; expired, unsigned or tampered bundles fail closed; bundle carries version, expiry, issuer and empty slots for chain anchoring and revocation lists | `loadOrCreateDeviceIdentity` at first need (never at activation); `signPayload('policy-bundle')`; expiry, issuer and the slots are the bundle's own payload fields, which the caller checks after `verifyPayload` returns the payload; a revocation list slot can later become another `KeyStatusLookup` source |
| Phase 71, DLGT-01 and DLGT-03 | Every agent has its own Ed25519 key and NEAR implicit account; grants are signed by the delegator and recorded in the signed log | `PayloadSigner` is structural, so an agent key signs with the same call; keyed status lookup allows an agent source. This is why decisions to revisit item 2 matters |
| Phase 80, APRV-02 | "The answer is a signed event: signed by the person's device identity in the editor" | `signPayload('approval-answer')`; request digest binding is the payload's concern |
| NEAR and DID derivation | Ed25519 raw key to NEAR implicit account offline; DID verification method | The envelope carries the raw 32-byte key as base64url (43 characters). A NEAR implicit account id is the lowercase hex of the 32 key bytes (64 characters) `[CITED: docs.near.org/integrations/implicit-accounts, via search result: base58 key BGCCDDHfysuuVnaNVtEhhqeT4k9Muyem3Kpgq2U1m9HX maps to account id 98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de]`, so `Buffer.from(publicKey, 'base64url').toString('hex')` is the account id. The spike's draft uses `Ed25519VerificationKey2020` with `publicKeyMultibase` beginning `z6Mk`, which is `z` plus base58btc of the two multicodec bytes `0xed01` and the raw key `[ASSUMED: A4]`; also derivable from the same raw bytes. `did:near` is still a placeholder method in the draft (`"_draft": ... 'did:near' here is a placeholder`), Phase 71 chooses; nothing in the envelope fixes it. Recommended small test: a fixed seed, its base64url key, the hex id, and the docs vector above decoded with a ten-line base58 helper inside the test (no dependency), so the claim "later phases need no rework" is checked, not asserted |

What is easy to get wrong later and is cheap to settle now: keep `signer` field names `fingerprint`, `publicKey`, `memberId`; keep the purpose list closed with a one-line addition path; keep `v: 1` meaning exactly one algorithm and input; keep integers only; keep `signedAt` inside the signed bytes.

### Q6. TMR-04: v0.6.0 phases, requirement text and proposed dispositions

Sources: the archive's `.planning/ROADMAP.md` and `.planning/REQUIREMENTS.md` at `origin/feat/team-fix-pass` `[VERIFIED: git show, read]`. The archive's file header says "33 requirements" but lists **34** ids (4 + 4 + 3 + 5 + 3 + 5 + 1 + 2 + 4 + 3); the record should say 34. Main's `REQUIREMENTS.md` line 442 ("Carried from v0.6.0") is the starting point and names the same set; dispositions below match the L2 table in `ROADMAP.md` (lines 589 to 600).

**Phases**

| v0.6.0 phase | State on the archive | Proposed disposition |
|--------------|----------------------|----------------------|
| 60 Team core | Complete 2026-11-01 (12/12 plans) | **Landed in Phase 69** (TMR-02, TMR-03, with TMR-05 on top) |
| 61 Invitations, joining, removal, organization link and key integration (the archive's phase title uses older wording) | 33/35 plans, owner re-test chain 61-32 to 61-35 open | **Carried to L2**: close the re-test chain, then land; key delivery and device revocation reuse Phase 69's signer and `device.rotated`. Not ported here (Q1) |
| 62 Team Board | 28/28 plans per the progress table (27/30 in the phase header), re-test fixes 62-28 done, 62-29 and the 62-30 gate planned | **Carried to L2** after the re-test chain; weigh a Theia widget (L6) |
| 62.1 Board timeline | inserted phase, built with 62 | **Carried to L2** with 62 |
| 63 Claims, leases, claim workspaces, LeaseGuard | not started | **Carried, partly superseded**: claims between people stay; path leases become constraints the Phase 70 gate checks (no second gate); claim workspaces use Phase 72's copy-and-apply backends |
| 64 Dispatcher and Next Task | not started | **Carried**; agent claims signed under agent identities (Phase 71) |
| 65 Merge train and review gate | not started | **Carried**; pull-request mode uses the secure workflow kit from Phase 28 (one review path) |
| 66 Budgets and allocations | not started | **Re-based**: allocations become spend constraints in grants and reuse BUDG-04's integer nano-USD arithmetic (Phase 79); per-key provider caps stay |
| 67 Metrics, collaboration, team memory, team stop, release readiness, relay transport | not started | **Carried, with splits**: team memory shares the staged-proposal pipeline with learned skills (L6); team stop builds on the gate's stop (Phase 70); `relayTransport.ts` is **retired**, superseded by L5's federation transport |

**Requirements (all 34), with the archive's text condensed**

| Archive id | Meaning on the archive | Collides with v0.7.0 id? | Proposed id and disposition |
|------------|------------------------|--------------------------|-----------------------------|
| TEAM-01 | A lead can enable Team Mode on an initialised project; solo projects behave as before | Yes (main `TEAM-` is the Teams channel) | **TM-TEAM-01**, landed in Phase 69 (Phase 60 verified; re-verified here) |
| TEAM-02 | Invite by email with role and allocation; single-use join code; own NEAR access and key | Yes | **TM-TEAM-02**, carried to L2 |
| TEAM-03 | Remove a member; claims, leases, allocations released; later events from their keys rejected | Yes | **TM-TEAM-03**, carried to L2 (the key rejection half already exists in Phase 60 as positional removal) |
| TEAM-04 | Every client verifies every event's signature and the author's permission at that log position | Yes | **TM-TEAM-04**, landed in Phase 69 |
| BOARD-01 | Board mirrors GSD milestones, phases, plans, tasks; idempotent re-import | No | carried to L2 (Phase 62, built) |
| BOARD-02 | Changes appear on other boards within the poll interval (git) or 2 s (relay) | No | carried to L2; the **2 s relay half is retired** (relay transport superseded by L5) |
| BOARD-03 | Moves are permission-checked and follow permitted transitions | No | carried to L2 (Phase 62, built) |
| BOARD-04 | Milestone card with progress, burn, forecast, release readiness checklist | No | carried to L2 (Phase 67 content, not built) |
| ASSIGN-01 | Dispatcher offers or assigns per policy | No | carried to L2 (agent claims under Phase 71 identities) |
| ASSIGN-02 | Next Task claims the best item and prepares workspace and session | No | carried to L2 |
| ASSIGN-03 | Sub-agents in a claim get disjoint sub-leases and honour plan waves | No | carried to L2; sub-leases become gate constraints (Phase 70, 71) |
| CLAIM-01 | Two members never hold active claims on one item | No | carried to L2 |
| CLAIM-02 | No overlapping path leases | No | carried to L2, as gate constraints (Phase 70) |
| CLAIM-03 | Writes outside the lease set are refused with an explanation | No | carried to L2, enforced by the gate (Phase 70) |
| CLAIM-04 | Expired claims return to ready, prior work kept on its branch | No | carried to L2 |
| CLAIM-05 | Duplicate cards and duplicate code detected and resolved | No | carried to L2 |
| INTEG-01 | Code reaches the integration branch only through the merge train or PR mode | No | carried to L2 |
| INTEG-02 | Rebased, scope-checked, verified, reviewed by someone other than the author | No | carried to L2 |
| INTEG-03 | STATE.md progress regenerated from the log | No | carried to L2 |
| BUDGET-01 | Team budget and allocations; requests; logged decisions | Near (main has `BUDG-`) | carried to L2, **re-based** on BUDG-04 and grants |
| BUDGET-02 | Per-key provider caps when an organization is linked | Near | carried to L2 (stays) |
| BUDGET-03 | Effective run cap is the minimum of run, daily, member and ring-fence remaining | Near | carried to L2, folded into BUDG-04's "smallest of" arithmetic |
| BUDGET-04 | Spend reconciled with NEAR per member; differences flagged | Near | carried to L2 |
| BUDGET-05 | Alerts at 50, 80 and 100 percent | Near | carried to L2 |
| METRIC-01 | Per-member, per-agent and per-milestone metrics, exportable without prompts or code | No | carried to L2 |
| COLLAB-01 | Comments, mentions, handoffs, blockers and approval routing | No | carried to L2 (approval routing reuses Phase 80's signed approvals) |
| COLLAB-02 | Team memory only through approved proposals, landing through integration | No | carried to L2 (shares the staged-proposal pipeline, L6) |
| SEC-01 | No secret in the log, `team.json`, settings or audit | No (see below) | landed in Phase 69 (canary tests) |
| SEC-02 | Team-wide stop; only a lead resumes | No (see below) | carried to L2, builds on the gate's stop |
| SEC-03 | Teammate-authored text reaches agents only as untrusted data | No (see below) | carried to L2 |
| SEC-04 | Section 6.3 role permissions enforced on write and on read | No (see below) | landed in Phase 69 (matrix and forgery tests) |
| FLOW-01 | A single developer gets task workspaces, review, one path to main, releases | No | carried to L2; task workspaces use Phase 72 backends, review path Phase 28 |
| SETUP-01 | One guided project setup after connecting NEAR AI (purpose, where the project is kept, who else works on it, spending limits) | Yes (main `SETUP-` is the messaging setup view) | **TM-SETUP-01**, carried to L2 **narrowed**: steps 1, 2 and 4 already exist on `main` as the commands `nearAi.projectSetup`, `nearAi.sync.onlineHome` (shipped with Phase 27) and `nearAi.spendingLimits` `[VERIFIED: package.json command list]`; only step 3 (invite, or "just me for now") remains and needs Phase 61 |
| UX-01 | No step needs git or developer knowledge | No (see below) | carried to L2 as a rule on every L2 phase; Phase 28 also carries it for the setup step |

**Collisions.** Real collisions in the live `REQUIREMENTS.md`: TEAM-01..04 and SETUP-01 (D-16 already prefixes these). Near collisions D-16 does not name: the shipped v0.4.0 archive reuses `SEC-01`, `SEC-02`, `SEC-03`, `UX-01` and `UX-02` with other meanings (`.planning/milestones/v0.4.0-phases/` plans and summaries, and `AUDIT-2026-10-26.md`), and v0.7.0 has `BUDG-01..04` next to `BUDGET-01..05`. Recommendation: keep the bare ids named in main's REQUIREMENTS.md line 442 (those files are closed history) but give the disposition record a "Same id elsewhere" column that lists these, so nobody greps `SEC-01` and reads a v0.4.0 plan.

**Other items to record.** The archive's shared code-server follow-ups (owner, 2026-11-05) are already in main's REQUIREMENTS.md as SHRD-01..03 under L2. The Phase 60 planning folder, the addendum spec `.planning/research/v0.6.0-team-mode-addendum.md` (649 lines on the archive, absent from `origin/main`) and the Phase 61 and 62 plan folders stay readable on the archive branch; the record should list these paths and the commit so L2 can find them. Open question: copy the addendum onto `main` (it is the spec "that governs wherever it differs") or leave it on the archive; recommended: leave it, cite the archive path and sha 4207080.

### Q7. TMR-01 evidence

- `git ls-remote origin refs/heads/feat/team-fix-pass` returns `4207080ca394d36cf36bbed37b179d8f8400b721 refs/heads/feat/team-fix-pass` `[VERIFIED: run this session against GitHub]`. `origin/feat/team-fix-pass` and the local branch `legacy/team-fix-pass` both resolve to the same sha.
- The archive commit `4207080` ("chore(team-mode): archive uncommitted work before pushing the branch as an archive", 2026-11-15) contains six paths: modified `.planning/PROJECT.md`, `.planning/config.json`, `.planning/state.json`, `src/test/e2e/cdp.ts`, `src/test/e2e/codeServerTeam.ts`, and a new empty `.planning/phases/62.1-board-timeline-milestones-on-one-timeline-with-cards-as-dots/.gitkeep` `[VERIFIED: git show --name-status]`. The roadmap says "five uncommitted files"; the sixth is the `.gitkeep`.
- The legacy worktree exists at `/home/aaron/projects/legacy/WSL/CanonicalGroupLimited.Ubuntu22.04LTS_79rhkp1fndgsc/home/vitalpointai/projects/near-ai-vscode/.claude/worktrees/team-mode`, checked out at `4207080 [feat/team-fix-pass]`, and `git --no-optional-locks -C <that path> status --short` printed nothing, so no uncommitted or untracked files remain `[VERIFIED: run this session]`.
- Count: 777 commits above the fork point 6f779f3 `[VERIFIED: git rev-list --count]`.
- Re-run these three commands at the phase gate and paste the output into the disposition record (they cost nothing and the record should carry fresh evidence, not this document's).

## Architecture Patterns

### System Architecture Diagram

```
 owner / lead clone                                  another clone (same remote)
 ------------------                                  ---------------------------
 Enable Team Mode (preview setting on)               VS Code starts, team.json found (committed with -f)
   |                                                   |
   | loadOrCreateDeviceIdentity ----> SecretStorage    | one fs.stat at activation (solo: nothing else)
   |      (nearAi.identity.deviceKey; first need)      v
   v                                                 parseTeamFile (untrusted input) -> refuse reserved sync refs,
 genesis events (team.created, member.joined)          bad pattern, extra keys; checkTrustPin (trust.json)
   |   signed with the identity (signEvent)            |
   v                                                   v
 GitTransport.append  --push (CAS, no force)-->  refs/heads/near-ai/coordination  <--fetch-- GitTransport.fetch
   (mirror: <globalStorage>/team/<teamId>/coordination.git                          |  into refs/team/incoming
    lock: near-ai-team-sync.lock via acquireFileLock)                               |  ancestry check vs pin.json
                                                                                    v
                                                      teamMaterializer.apply per entry (positional rules, D-09 order):
                                                      schema -> team -> device bound, not revoked, NOT ROTATED ->
                                                      signature -> lamport -> decideTeamAction -> references
                                                           | accepted                  | rejected -> state.rejected + output channel
                                                           v
                                                      TeamState (members, devices incl. rotated/revoked)
                                                           |
                       +-----------------------------------+-----------------------------+
                       v                                                                 v
   teamKeyStatus(state): KeyStatusLookup                              auditMirror: roster events -> AuditStore
                       |                                              (.planning/.near-ai/audit.json, type team-roster)
                       v
   verifyPayload(envelope, { purpose, status })  <---- signPayload(signer, purpose, payload)   <- Phases 70, 71, 80
                       ^                                                                          (policy bundle, grant, approval)
                       |
   replayKeyHistory(<globalStorage>/identity/key-history.json): KeyStatusLookup for a person with no team

 Phase 27 sync (separate, never touched): <globalStorage>/sync-mirrors/<key>/mirror.git, near-ai-state-sync.lock,
 refs/heads/near-ai/state on the same remote, refs/near-ai/incoming in its mirror.
```

### Recommended Project Structure

```
src/domain/team/        canonical, types, permissions, policy, secrets, validate, materialize   (ported)
                        signedPayload.ts, keyStatus.ts                                            (new, pure)
src/team/               identity, runGit, transport, gitTransport, eventLog, teamFile, auditMirror,
                        enable, syncScheduler                                                     (ported)
                        keyHistory.ts                                                             (new, I/O)
src/services/team/      teamCommands, teamSession, teamStatusBar                                  (ported, vscode adapters)
src/test/               team*.test.ts (19 ported + teamSharedMirror + new), helpers/{teamHarness,teamEvents,
                        teamCanary,teamAppendChild,vscodeStub,mirrorLockChild}.ts
.planning/research/v0.6.0-disposition.md                                                          (new record, D-16)
```

### Pattern 1: Port first unchanged, then adapt (recommended order)

**What:** Wave A re-applies the 47 files from `ae5e9e1` plus fixes T1 and T2 and runs the ported suite green on `main` with the per-team key still in place. Only then does Wave B change identity to per-person, add `device.rotated`, the payload signer, the key status lookup and the key history.
**Why:** It gives TMR-02 clean evidence ("Phase 60's tests pass on main as they were written") and makes the TMR-05 changes a small, reviewable diff on top. The per-team key exists only on the intermediate commits of the PR branch, so D-06's "never ships" holds on squash merge. Each wave leaves `main` green (the discretion rule in CONTEXT).
**Suggested slicing for the planner (a hint, not a plan):** (1) pure domain core, helpers, tests; (2) team I/O core with T1 and T2; (3) services, `extension.ts`, `package.json`, preview setting, solo parity and canary; (4) per-person identity and Enable rollback rule; (5) `device.rotated` end to end; (6) payload signer, key status, key history; (7) isolation, boundary and manifest tests, disposition record, phase gate. PR cut: after (3) is a natural first PR; (4) to (7) the second, or a third after (5).

### Pattern 2: One lock implementation, two lock names

The team transport keeps its in-process chain (`mirrorLocks` map) and its `exclusive()` wrapper, and swaps only the acquire call:

```ts
// src/team/gitTransport.ts (after the swap)
import { MirrorBusyError, acquireFileLock } from '../services/stateMirrorLock';
import type { HeldMirrorLock, MirrorLockTimings } from '../services/stateMirrorLock';
export const TEAM_MIRROR_LOCK_FILE = 'near-ai-team-sync.lock';   // sync uses near-ai-state-sync.lock

private async exclusive<T>(work: () => Promise<T>): Promise<{ value: T } | undefined> {
  let held: HeldMirrorLock;
  try {
    held = await acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE, { ...this.lockTimings, sleep: this.sleep, random: this.random });
  } catch (error) {
    if (error instanceof MirrorBusyError) return undefined;
    throw error;
  }
  try { return { value: await work() }; } finally { /* release and report, as in 3e11c0e */ }
}
```

### Pattern 3: Refusing reserved refs in `team.json`

```ts
// src/team/teamFile.ts
const RESERVED_SYNC_REFS = ['refs/heads/near-ai/state', 'refs/near-ai/incoming'] as const;   // pinned by a test to stateTransport's constants
function collidesWithSync(ref: string): boolean {
  const lower = ref.toLowerCase();
  return RESERVED_SYNC_REFS.some((reserved) => lower === reserved || lower.startsWith(`${reserved}/`) || reserved.startsWith(`${lower}/`));
}
// validRef(ref) = existing pattern && isGitRefName(ref) && !collidesWithSync(ref)
```

### Pattern 4: Preview gate lives in the manifest, not in the code

`registerTeamMode` registers both commands unconditionally (the e2e command check and Phase 60's `teamManifest` test need that). Visibility is `menus.commandPalette` plus the `nearAi.team.preview` setting (Q3). The session and status bar start from `team.json`, independent of the setting (D-13).

### Anti-Patterns to Avoid

- **Cherry-picking from the tip or checking out `team*` globs:** entangles Phase 61 and 62 code and overwrites main's Team Studio tests (Q1).
- **Deleting the shared identity key on rollback:** orphans every signature made with it (decisions to revisit, item 3).
- **Trusting `purpose` from the envelope:** the verifier passes the purpose it expects.
- **Treating `signedAt` as proof:** it is a claim, only revocation stops a copied key.
- **A second lock, signer, canonicaliser or atomic-write helper:** reuse `stateMirrorLock.ts`, `signedPayload.ts`, `canonical.ts` and `teamFile.ts`.
- **Importing `vscode` or `../../services/*` (other than the two named exceptions) from `src/domain/team` or `src/team`:** the relay and Phase 70 reuse these files.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Canonical bytes to sign | a new serialiser | `canonicalBytes` in `domain/team/canonical.ts` | Frozen by `teamCanonical.test.ts` vectors; sorted UTF-16 keys, safe integers, depth 16 |
| Ed25519, SHA-256, randomness | any dependency | `node:crypto` | Already the whole core; zero-dependency rule |
| Cross-process lock for mirror and key history | a third lock | `acquireFileLock` and `withFileLock` in `stateMirrorLock.ts` | Takes over stale and crashed holders, tested by Phase 27 |
| Atomic file replace and serialised writes | new temp-file code | `writeFileAtomic` and `runSerialised` in `team/teamFile.ts` | Cleans up the temp file and keeps the original error |
| Secret scanning of anything written | a new regex list | `assertNoSecrets` in `domain/team/secrets.ts` (which calls main's `redactSecrets`) | One detector, with the `publicKey` and `sig` exemptions |
| Event and body validation | ad hoc checks | `validate.ts` exact-key helpers (`exactKeys`, `validateDeviceRef`) and the `teamFile.ts` pattern | Unknown keys are rejected by construction |
| Git plumbing and credentials | a second git runner | `team/runGit.ts` (`GIT_TERMINAL_PROMPT=0`, redaction, timeout); do not merge it with main's `runStateGit` in this phase | Parity with the verified Phase 60 behaviour |
| Base58 for the derivation test | a package | ten lines inside the test | Test-only, no dependency |

**Key insight:** every hard part of this phase already exists and is already tested; the risk is in the seams (key name, lock name, ref names, manifest), not in new algorithms.

## Runtime State Inventory

This is a port and a small re-keying, not a rename of anything on `main`. Checked for completeness:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None on `main` references the per-team key name or any `nearAi.team.*` storage (no `src/team`, no `nearAi.team.deviceKey` secret exists on `main`) `[VERIFIED: grep over src and package.json]` | None. Builds of the archive (the 0.6.x UAT VSIX) on the owner's machines hold `nearAi.team.deviceKey.<teamId>` secrets and teams on test remotes; main never reads them, and D-06 says no migration |
| Live service config | None. No remote is touched by this phase except test remotes | None |
| OS-registered state | None | None |
| Secrets and env vars | New secret name `nearAi.identity.deviceKey` (SecretStorage only) | Add it to the canary scanners as a name to look for; no env var |
| Build artifacts | `dist/` is built by `tsc`; a worktree has no `node_modules` or `dist` yet | `npm ci` then `npm run compile` once before any `dist/test` run |

## Common Pitfalls

### Pitfall 1: A glob or checkout clobbers main's Team Studio files
**What goes wrong:** `team*` matches `teamStudio.test.ts`, `teamStudioPage.test.ts`, `teamInvocation.test.ts` that exist on `main` in newer form.
**How to avoid:** use the explicit list in Appendix A; run `git status` after each port step and expect only added files plus the four edited ones.
**Warning signs:** a diff on `src/test/teamStudio*.test.ts` or `agentTeams.test.ts`.

### Pitfall 2: Rollback deletes the person's identity
See decisions to revisit, item 3. **Warning sign:** `forgetDeviceIdentity` called from any path that did not create the key.

### Pitfall 3: Optional `memberId` makes canonicalisation throw
`canonicalize` rejects `undefined` values (`write` throws "undefined is not allowed"). Omit the key when there is no member id; do not set it to `undefined`. Test both shapes.

### Pitfall 4: Two windows create the identity at once
SecretStorage `store` from two windows of one VS Code is last write wins; the first window may already hold, and sign with, a key that was just overwritten. **How to avoid:** hold `withFileLock(<globalStorage>/identity, 'identity-create.lock', ...)` around check, create, store and read back; the history `created` record is written inside the same lock. **Warning signs:** a policy bundle that fails to verify right after first run.

### Pitfall 5: Shared code-server installs and one identity for several people
The identity is "per install". On a shared code-server user profile, several people can share one install and so one key. Not solvable in this phase; SHRD-02 and SHRD-03 (recovery code, "Replace my device") own it. Say so in the disposition record so Phase 70 does not assume one person per install.

### Pitfall 6: The same fingerprint links a person across teams and projects
D-06 accepts it; the coordination branch is on the project's remote and readable by anyone who can read the repository. Put one plain sentence in the preview Enable confirmation and in the disposition record. Do not add a per-team derived key now (it would change `team.json` and the roster).

### Pitfall 7: `main`'s `redactSecrets` is broader than the one Phase 60 was written against
It now redacts `password`, `secret` and quoted JSON names, plus recovery-code shapes. Phase 60's detector calls it for every string it scans, so a team name or a policy value such as `secret: x` is now refused where it was not. Probably only wanted behaviour; re-run `teamSecrets`, `teamValidate`, `teamLog`, `teamEnable` and `teamFile` first and read any new failure as drift, not as a Phase 60 bug.

### Pitfall 8: Timing-sensitive and process-forking tests under the memory cap
`teamConcurrency` forks several child clients, `teamSharedMirror` forks a lock holder and has per-test timeouts of 60 to 300 seconds (a second writer is forced at every git step of an append, one step per round). Run each of these two files by itself, never beside the rest of the team group, and with `--test-concurrency=1`. The lock timing tests shorten `staleMs`, `refreshMs` and `waitMs` but still use real clocks and `utimes`; a loaded machine (28 GB total, about 2 GB free when probed) can make them slow. `teamScheduler` uses a fake clock and is stable. A failure that mentions "3 !== 1" in `teamSession` is the T2 flake, not a regression.

### Pitfall 9: `nearAi.team.` versus `nearAi.teams.`
Main already contributes `nearAi.teams.updateNotifications` and Team Studio commands (`nearAi.manageTeams`). A filter written as `startsWith('nearAi.team')` matches both; use the trailing dot (`'nearAi.team.'`), as the ported manifest test does.

### Pitfall 10: Review budget and gate files
The agent review cannot read a diff over 1,000,000 bytes (`MAX_DIFF_BYTES`) and holds the PR for the owner when it omits files; a PR that touches `SECURITY.md`, workflows or review and merge scripts also waits for the owner (`CONTRIBUTING.md`). Keep this phase out of those files. No README or SECURITY.md change is needed while the commands are hidden behind the preview setting; the CHANGELOG entry is written for users at release time. Branch names must be `feat/`, `fix/`, `chore/` or `docs/` (`merge-pr` rejects others).

### Pitfall 11: Windows and the lock tests
`teamSharedMirror` skips two tests on `win32` (they rely on `process.kill(pid, 0)` and `utimes` semantics, as in the branch). CI is Linux. Nothing in this phase may add a Windows-only path that the Linux suite cannot see.

## Code Examples

### Verify a payload with the team roster as the status source

```ts
// Source: design in this document, built on domain/team/canonical.ts and keyStatus.ts
const status = teamKeyStatus(materializedState);          // KeyStatusLookup
const result = verifyPayload(envelope, { purpose: 'grant', status });
if (!result.ok) return refuse(result.message);            // plain words, reason is a closed code
useGrant(result.payload as Grant, result.signer);         // the caller checks its own fields (expiry, issuer)
```

### A sample payload for the tests of each purpose (no real policy, grant or approval format, D-10)

```ts
const samples = {
  'policy-bundle': { version: 1, expiresAt: '2027-01-01T00:00:00Z', issuer: signer.fingerprint, rules: [] },
  'grant': { capability: 'read', until: '2026-12-01T00:00:00Z', budgetNanoUsd: 5_000_000_000 },
  'approval-answer': { requestDigest: 'a'.repeat(64), answer: 'allow' }
};
```

### The e2e-safe palette entries

See Q3 for the JSON. The ported solo-parity test should additionally assert that `registerTeamMode` registers both commands whatever the setting says.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Cherry-pick 111 interleaved commits | Re-apply files from the phase-complete commit plus named fixes | D-02, 2026-11-15 | Avoids Phase 61 and 62 entanglement |
| One key per device per team | One key per person per install, bound into each roster | D-06 | Enables solo signing and DIDs; adds a cross-team link |
| Branch's own cross-process lock | Main's `acquireFileLock` | Phase 27 copied it into `main` | One lock implementation |
| Sign events only | Sign events and domain-separated payloads | TMR-05 | Policy bundles, grants and approvals share one signer |

**Deprecated or outdated:** the branch's `mirrorProcessLock.ts` (replaced), the per-team key name `nearAi.team.deviceKey.<teamId>` (never ships on `main`), the roadmap's "five uncommitted files" (six paths in the archive commit).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The owner accepts that "rotated" refusal rests on the claimed `signedAt` and that only revocation stops a copied key | Decisions to revisit 1; 5.2; 5.3 | If the owner wants a hard guarantee, rotation needs a trusted timestamp (not available offline); wording and docs would change, not the format |
| A2 | `signPayload` should run `assertNoSecrets` by default | 5.2 | A real policy bundle with a secret-shaped string would be refused; Phase 70 would need an opt-out parameter |
| A3 | `config.<setting>` in a `when` clause works for an `application`-scope setting | Q3 | The palette entries would never show; fix by dropping `scope` or reading the setting into a context key in code |
| A4 | The W3C multibase form of an Ed25519 key is `z` plus base58btc of `0xed01` and the 32 raw bytes | 5.6 | Only matters to Phase 71; the raw key is in the envelope either way |
| A5 | A head hash in SecretStorage is a worthwhile truncation check for the key history | 5.5 | Optional; without it a truncated history is silently accepted |
| A6 | The plain-words subset (T3) is wanted in this phase | Q1 | Cosmetic; can be left as a follow-up |
| A7 | A 256 KiB payload cap is enough for policy bundles | 5.2 | A verifier-side constant; raise it without changing the format |
| A8 | `--test-concurrency=2` keeps the team group inside the 4 GB cap | Validation Architecture | Not measured here (no test runs allowed); lower to 1 if the scope is killed |
| A9 | `teamSharedMirror.test.ts` finishes inside the 900-second cap when run alone | Pitfall 8 | If not, give it a 1800-second invocation of its own |
| A10 | The NEAR implicit-account rule (64 lowercase hex characters of the 32-byte key) as read from the documentation search result is current | 5.6 | The direct documentation page fetch returned 404, so this rests on a search result from docs.near.org; confirm in Phase 71 research |

## Open Questions

1. **Retitle "Verify Team Log" to "Check Team Record" (T3)?**
   - What we know: the branch did it for plain language and kept the command id; ROADMAP and CONTEXT still say "Verify Team Log".
   - What's unclear: whether the owner wants the rename in this phase.
   - Recommendation: take the status bar sentences and tooltips (visible in every team project), keep the command title as is, and record the title as a follow-up. Either way, update the assertions deliberately.
2. **Should this phase ship any rotation or revocation command?**
   - Recommendation: no. Ship the event, the lookup, the history functions and the identity helpers that keep the previous private key; L2 and Phase 71 own the flow.
3. **Copy the v0.6.0 addendum spec onto `main`?** Recommendation: no; cite `origin/feat/team-fix-pass` at 4207080 in the disposition record.
4. **Where exactly to split the PRs?** Recommendation in Pattern 1; the planner decides with the 1,000,000-byte budget in mind (about 659 KB for the port alone).
5. **Context key `nearAi.team.active`.** Recommendation: add it (decisions to revisit, item 6); if the owner prefers fewer changes, show Verify Team Log only under the preview setting and accept the dead end.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | compile, tests | yes | v24.22.2 | none needed (CI uses Node 24 per `CONTRIBUTING.md`) |
| git | transport tests, TMR-01 checks | yes | 2.53.0 | none |
| `systemd-run`, `choom`, `timeout` | memory-capped runs | yes (`/usr/bin/systemd-run` found) | n/a | none; repo rule requires them |
| `xvfb-run` | e2e | yes (`/usr/bin/xvfb-run`) | n/a | none |
| `node_modules` and `dist` in this worktree | any test run | **no** (neither exists in `phase-69-plan`) | n/a | `npm ci` then `npm run compile` inside the cap, once per worktree; the main checkout has `node_modules` but a worktree should not share it |
| Network (GitHub) | `git ls-remote` for TMR-01, `npm ci` | yes (ls-remote worked) | n/a | TMR-01 evidence can be re-run later |
| Free memory | cap headroom | about 11 GB available of 28 GB when probed, other agents running | n/a | one heavy run at a time |

**Missing dependencies with no fallback:** none. **With fallback:** the install step above.

## Validation Architecture

`workflow.nyquist_validation` is absent from `.planning/config.json`, so this section applies `[VERIFIED: config.json read]`.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` on compiled JS (Node 24), run by `scripts/run-tests.mjs` |
| Config file | none; `tsconfig.json` compiles `src/**/*.ts` to `dist/` |
| Quick run command (one file) | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/teamCanonical.test.js'` (the form earlier phase plans use) |
| Team group command | the same wrapper with `node --test --test-concurrency=2 dist/test/teamAudit.test.js dist/test/teamCanonical.test.js dist/test/teamCommands.test.js dist/test/teamEnable.test.js dist/test/teamFile.test.js dist/test/teamForgery.test.js dist/test/teamGitTransport.test.js dist/test/teamIdentity.test.js dist/test/teamLog.test.js dist/test/teamManifest.test.js dist/test/teamMaterialize.test.js dist/test/teamPermissions.test.js dist/test/teamRunGit.test.js dist/test/teamScheduler.test.js dist/test/teamSecrets.test.js dist/test/teamSession.test.js dist/test/teamSoloParity.test.js dist/test/teamValidate.test.js` plus the new files; `teamConcurrency` and `teamSharedMirror` each as their own invocation with `--test-concurrency=1`. `--test-concurrency` exists in this Node `[VERIFIED: node --help]` |
| Full suite command | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test'` |
| E2E command | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 npm run test:e2e` (the script runs `xvfb-run` and `src/test/e2e/run.ts:20-27` deletes `WAYLAND_DISPLAY` and `WAYLAND_SOCKET` and sets the X11 hint) |
| Phase gate command | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npm run lint && npm test && npm run test:e2e && npm run verify:release && node scripts/secret-scan.mjs --range origin/main..HEAD'` (the shape Phase 27's gate plan used) |

### Phase Requirements to Test Map

| Req | Behavior | Test Type | Automated Command (wrapper omitted for brevity) | File Exists? |
|-----|----------|-----------|--------------------------------------------------|-------------|
| TMR-01 | Archive branch is on the remote at 4207080 and the legacy worktree is clean | scripted record check, manual-only evidence | `git ls-remote origin refs/heads/feat/team-fix-pass` expects `4207080ca394d36cf36bbed37b179d8f8400b721`; `git --no-optional-locks -C <legacy worktree> status --short` expects empty | evidence pasted into the disposition record (no code test; remote state is not test-suite material) |
| TMR-02, Phase 60 SC1 (Enable, key only in SecretStorage, canary) | Enable makes team, key, orphan branch, `team.json`-only commit; canaries never appear | integration, real git | `node --test dist/test/teamEnable.test.js dist/test/teamCommands.test.js dist/test/teamAudit.test.js dist/test/teamSecrets.test.js dist/test/teamFile.test.js dist/test/teamIdentity.test.js` | ported (adapted for the single key name) |
| TMR-02, SC2 (two clones converge, replay deterministic) | Byte-identical state on two clones; seeded property test | integration and property | `node --test dist/test/teamLog.test.js dist/test/teamMaterialize.test.js dist/test/teamGitTransport.test.js dist/test/teamCanonical.test.js` | ported; materialize property test extended with `device.rotated` |
| TMR-02, SC3 (forged and under-privileged events rejected, both sides) | Same reason on write and read | unit and integration | `node --test dist/test/teamForgery.test.js dist/test/teamPermissions.test.js dist/test/teamValidate.test.js` | ported; rows for `device.rotate` added |
| TMR-02, SC4 (concurrent appends lose nothing, no force-push) | Forked clients; two windows on one mirror | process-level | `node --test --test-concurrency=1 dist/test/teamConcurrency.test.js`, then `dist/test/teamSharedMirror.test.js` (each alone) | ported (T1 adds `teamSharedMirror`, lock name adapted) |
| TMR-02, SC5 (no team file, nothing runs) and the 60-12 scheduler criteria | One `fs.stat`, no timers, status item or storage; poll cadence | unit with fakes | `node --test dist/test/teamSoloParity.test.js dist/test/teamScheduler.test.js dist/test/teamSession.test.js dist/test/teamRunGit.test.js` | ported; session test gains the T2 case |
| TMR-02, no `vscode` and no new dependency | Boundary and manifest | static | `node --test dist/test/teamBoundaries.test.js dist/test/teamManifest.test.js` | new `teamBoundaries.test.ts` (scans `src/domain/team` and `src/team` sources for `vscode` and for imports outside the allow-list `node:*`, siblings, `../redaction`, `../services/auth` as type, `../services/stateMirrorLock`); manifest test adapted (Q3) |
| TMR-03, solo parity and canary | Solo activation costs one stat; canary strings absent from log, `team.json`, settings, audit | unit and integration | the SC1 and SC5 commands above, then the full suite and e2e | ported; full suite and e2e at the gate |
| TMR-03, preview hides the commands | `commandPalette` entries and setting exist, default false, application scope | static | `node --test dist/test/teamManifest.test.js` | adapted (new assertions) |
| Isolation (D-11, D-12, D-15) | A team sync and a state sync at once on one remote: separate mirror folders and lock files, no waits on each other, both refs advance, refs under sync names refused, `team.json` untouched by sync | integration, real git | `node --test --test-concurrency=1 dist/test/teamMirrorIsolation.test.js` | new `teamMirrorIsolation.test.ts` (uses `syncFixtures.ts` and `teamHarness.ts`; alias `MemorySecrets`); ref table tests also in `teamFile.test.ts` |
| TMR-04 | Every v0.6.0 phase and requirement id appears in the disposition record; `TM-` prefixes; links from REQUIREMENTS.md and ROADMAP.md | static doc check | `node --test dist/test/teamDisposition.test.js` | new, optional (reads `.planning/research/v0.6.0-disposition.md`); checks 9 phase rows and 34 requirement rows |
| TMR-05 sign and verify | Round trip for each purpose; domain separation both directions; purpose, version, key mismatch, tamper, float, secret, oversize; never throws | unit and fuzz | `node --test dist/test/teamSignedPayload.test.js` | new |
| TMR-05 key status | Team lookup (active, rotated, revoked, removed, unknown), combine rule, `verifyPayload` honours revoked and rotated with plain messages | unit | `node --test dist/test/teamKeyStatus.test.js` | new |
| TMR-05 `device.rotated` | Schema, matrix row, transition, positional rejection, snapshot round trip, last-device counting, forgery | unit and property | `node --test dist/test/teamValidate.test.js dist/test/teamPermissions.test.js dist/test/teamMaterialize.test.js dist/test/teamForgery.test.js dist/test/teamLog.test.js` | ported files extended |
| TMR-05 solo key history | Create, rotate, revoke replay; tampered, reordered, wrongly signed or truncated history fails closed; two writers take the lock; no private key in the file | unit and process-level | `node --test dist/test/teamKeyHistory.test.js dist/test/teamIdentity.test.js` | new and adapted |
| TMR-05 later-phase fit | Raw key to implicit account id and the docs vector | unit | inside `teamSignedPayload.test.ts` | new |

### Sampling Rate

- **Per task commit:** the single test file (or the small group in the row) touched by the task, with `npx tsc -p tsconfig.json` first (batched edits, not every save).
- **Per wave merge:** the team group command plus the isolation file, one heavy run at a time.
- **Phase gate:** the full gate command above, once, then `/gsd-verify-work`. Security checks (secrets canary, forgery, permission matrix, isolation) are immediately blocking whenever touched, per the global cadence rule.

### Wave 0 Gaps

- [ ] Worktree install: `npm ci` and `npm run compile` inside the cap (no `node_modules` or `dist` yet).
- [ ] `src/test/helpers/mirrorLockChild.ts` adapted to `acquireFileLock` and the team lock name.
- [ ] `src/test/teamBoundaries.test.ts`, `teamSignedPayload.test.ts`, `teamKeyStatus.test.ts`, `teamKeyHistory.test.ts`, `teamMirrorIsolation.test.ts`, optional `teamDisposition.test.ts`.
- [ ] `.planning/research/v0.6.0-disposition.md` skeleton so the doc test has a target.

## Security Domain

`security_enforcement` is absent from the config, so it is enabled `[VERIFIED: config.json read]`.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (no login; identity is a key, not a session) | n/a |
| V3 Session Management | no | n/a |
| V4 Access Control | yes | `decideTeamAction` single decision point on write and read; `device.rotate` row; D-32 lead-on-owner rule |
| V5 Input Validation | yes | `team.json` and event bodies are untrusted: exact-key validators, `COORDINATION_REF_PATTERN`, `REMOTE_NAME_PATTERN`, `TEAM_ID_PATTERN` before any path or git argument, the new reserved-ref refusal |
| V6 Cryptography | yes | `node:crypto` Ed25519 only; domain-separated signing input; never hand-rolled; private key only in SecretStorage and a closure-held `KeyObject` |
| V7 Error handling and logging | yes | `safeReason` and `redactGitMessage`; no remote URL, key or token in the output channel; plain messages |
| V8 Data protection | yes | no secret in log, `team.json`, settings, audit, transcripts or fixtures (canary tests); key history holds public keys only |
| V12 Files and resources | yes | atomic writes, `wx` lock files, storage folder from a validated team id, payload size caps |
| V14 Configuration | yes | `nearAi.team.preview` application scope so a repository cannot turn it on |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged or replayed event | Spoofing, Tampering | Signature over canonical envelope, device bound to author, positional revocation and rotation, lamport rule |
| Cross-protocol replay (a payload signature used as an event or the reverse, or one purpose as another) | Spoofing | Different first bytes of the signing input, purpose in prefix and envelope, verifier-supplied purpose |
| Downgrade to another version or algorithm | Tampering | `v: 1` fixed; unknown `v` refused with "update the extension" |
| Envelope claims a fingerprint for another key | Spoofing | Recompute `fingerprintOf(publicKey)` and compare |
| Backdated signature from a copied, retired key | Spoofing, Repudiation | Revocation refuses everything; `signedAt` is only a claim (A1) |
| Attacker-edited `team.json` names the sync branch or another team | Tampering, DoS | Reserved-ref refusal, trust pin, genesis anchor, 16 KB cap |
| Path traversal through a team id | Tampering | `TEAM_ID_PATTERN` before `teamStorageDir` |
| Option injection through remote name or ref | Tampering | Patterns above, values passed as separate argv entries |
| Secret written to the log, file or audit | Information disclosure | `assertNoSecrets` on every write, canary tests, `redactSecrets` on git text |
| Lock file symlink or stale lock | DoS | `open('wx')`, token compare on release, takeover of dead or stale holders (`stateMirrorLock.ts`) |
| Truncated or edited local key history | Tampering | Hash chain and signatures, fail closed to `unknown`, optional head hash (A5) |
| Oversized or deeply nested payload | DoS | `MAX_PAYLOAD_BYTES`, canonicaliser depth limit 16 |
| One key shared by several people on a shared code-server | Spoofing | Out of scope here; SHRD-02 and SHRD-03 in L2 |

## Sources

### Primary (HIGH confidence, read or run this session)

- `origin/feat/team-fix-pass` at `ae5e9e1` (Phase 60 end), `3e11c0e`, `9e49bc5`, `0f5ea20`, `f6890da`, `cb23b59`, `0b9cda9`, and the archive commit `4207080`: `git show`, `git log`, `git diff`, `patch --dry-run`.
- `main` (`origin/main` 6ba1620 plus the CONTEXT commit): `src/services/stateMirrorLock.ts`, `stateTransport.ts`, `stateHome.ts`, `stateRecords.ts`, `syncFlows.ts`, `stateLocks.ts`; `src/domain/redaction.ts`, `approval.ts`, `protectedPaths.ts`, `scratch.ts`; `src/services/auth.ts`, `auditStore.ts`; `src/extension.ts`; `package.json`, `tsconfig.json`, `.gitignore`, `.vscodeignore`; `scripts/run-tests.mjs`, `scripts/secret-scan.mjs`, `scripts/lib/workflow.mjs`, `scripts/lib/ci-review.mjs`, `scripts/ci-review-run.mjs`; `src/test/e2e/suite.ts`, `run.ts`; `CONTRIBUTING.md`.
- `.planning/` on `main`: ROADMAP.md (Phases 69, 70, 71, 80, L2 table), REQUIREMENTS.md, STATE.md, PROJECT.md, `research/platform-direction/openshell-spike/did/parent.did.json`.
- Archive `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, Phase 60 `60-CONTEXT.md` and `60-VERIFICATION.md`.
- Local runs: `git ls-remote`, `git worktree list`, a read-only `status` on the legacy worktree, `node --help`, a node script over `scripts/lib/workflow.mjs` rules and `src/domain/redaction.ts`.

### Secondary (MEDIUM confidence)

- [VS Code when-clause contexts](https://code.visualstudio.com/api/references/when-clause-contexts): `config.` prefix for boolean settings.
- [VS Code contribution points](https://code.visualstudio.com/api/references/contribution-points): `menus.commandPalette` takes a `when` condition.
- [NEAR implicit accounts](https://docs.near.org/integrations/implicit-accounts): 64-character lowercase hex of a 32-byte Ed25519 key (read through a search result; the direct fetch of `docs.near.org/protocol/account-id` returned 404).

### Tertiary (LOW confidence)

- The multibase and DID encodings in 5.6 (A4) and the application-scope behaviour of `config.` keys (A3), from general knowledge.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new is installed and every import was checked.
- Architecture: HIGH for the port (diffed and dry-run applied), MEDIUM for TMR-05 (a design with one honest soft spot, item 1).
- Pitfalls: HIGH for those found by reading or running something this session; MEDIUM for the timing and memory ones (no test run was allowed).

**Research date:** 2026-11-15
**Valid until:** 2026-12-15 (30 days; the main risk to the port is `main` moving under it, so re-run the drift checks in Q2 if another PR touches `redaction.ts`, `stateMirrorLock.ts`, `extension.ts` or `package.json` first)

## Appendix A: the 47 files to re-apply from `ae5e9e1`

`git diff --name-only ec53121^ ae5e9e1 -- . ':!.planning'` `[VERIFIED]`. Take with `git show ae5e9e1:<path>`; four of them already exist on `main` and are edited by hand (marked E).

```
package.json (E: two commands, pollSeconds, plus preview setting and commandPalette)
src/domain/approval.ts (E: add 'team-roster' to AuditEventType)
src/extension.ts (E: import and call registerTeamMode)
src/services/auditStore.ts (E: add 'team-roster' to isAuditEventType list)
src/domain/team/{canonical,materialize,permissions,policy,secrets,types,validate}.ts
src/services/team/{teamCommands,teamSession,teamStatusBar}.ts
src/team/{auditMirror,enable,eventLog,gitTransport,identity,runGit,syncScheduler,teamFile,transport}.ts
src/test/helpers/{teamAppendChild,teamCanary,teamEvents,teamHarness,vscodeStub}.ts
src/test/team{Audit,Canonical,Commands,Concurrency,Enable,File,Forgery,GitTransport,Identity,Log,Manifest,Materialize,Permissions,RunGit,Scheduler,Secrets,Session,SoloParity,Validate}.test.ts
```

Added from the fix commits: `src/test/teamSharedMirror.test.ts` and `src/test/helpers/mirrorLockChild.ts` (from `3e11c0e`, adapted); not taken: `src/team/mirrorProcessLock.ts`.

Not in the list and not to be taken: `src/test/teamStudio.test.ts`, `teamStudioPage.test.ts`, `teamInvocation.test.ts`, `agentTeams.test.ts` (they exist on `main` in newer form).
