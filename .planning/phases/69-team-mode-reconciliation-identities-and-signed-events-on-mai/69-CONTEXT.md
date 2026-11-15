# Phase 69: Team Mode reconciliation: identities and signed events on main - Context

**Gathered:** 2026-11-15
**Status:** Ready for planning
**Source:** Owner chose "plan now, I decide" for milestone v0.7.0. The decisions below were made by the planning agent on the owner's behalf from ROADMAP.md (Phase 69 and the phases that build on it: 70, 71, 80), PROJECT.md "Platform direction (owner decisions, 2026-11-15)", STATE.md "Owner answers 2026-11-15", and the archived branch `origin/feat/team-fix-pass` (4207080; Phase 60 CONTEXT, SUMMARY and VERIFICATION files). The owner can change any of them; each is marked with how hard it is to undo.

<domain>
## Phase Boundary

Bring the Team Mode identity foundations from the archived branch onto current `main` and make the signing part reusable by the governance phases:

- the Phase 60 core: canonical JSON, device identities in SecretStorage, the signed append-only event envelope with Lamport ordering, event validation, the deterministic materializer, the role-by-action permission matrix (`src/domain/team/permissions.ts`), the git coordination transport, `team.json` with its trust pin, the roster audit mirror, the sync scheduler and the Phase 60 commands (Enable Team Mode, Verify Team Log) and status bar;
- one signing and verification interface for any canonical payload (policy bundles in Phase 70, grants in Phase 71, approval answers in Phase 80), with key rotation and revocation as signed events that later checks honour (TMR-05);
- a recorded disposition for every v0.6.0 phase and requirement (TMR-04), and a recorded check that the archive branch is preserved (TMR-01).

Not in this phase: invitations, joining, removal flows, NEAR organization calls, key sealing and delivery (Phase 61), work items and the board (Phase 62, 62.1), claims, dispatch, integration, budgets and metrics (Phases 63-67). Those stay on the archive branch for milestone L2 (owner, 2026-11-15). No policy bundle, capability vocabulary, grant format, DID document or approval object is designed here: those belong to Phases 70, 71 and 80. This phase gives them the signer, the verifier and the key history they will call.
</domain>

<decisions>
## Implementation Decisions

### Archive branch and history (TMR-01)
- **D-01:** TMR-01 is already done by the owner: `origin/feat/team-fix-pass` is on GitHub at 4207080, whose commit "archive uncommitted work before pushing the branch as an archive" holds the loose files. The phase only verifies and records this (branch exists on the remote at that commit, the legacy worktree has no uncommitted changes left, or the remaining ones are listed) in the phase's disposition record. No code task depends on anything else. *Undo: not applicable (a record).*

### Port strategy (research flag 1)
- **D-02:** Port by re-applying files, not by cherry-picking commits. The Phase 60 work is 111 interleaved commits, almost entirely new files (`src/domain/team/*`, `src/team/*`, `src/services/team/*`, test helpers and `src/test/team*.test.ts`); it touched existing files only in five small places (`src/extension.ts` two lines, `src/domain/approval.ts` one audit type, `src/services/auditStore.ts` one line, `package.json` contributions, and `src/test/helpers/vscodeStub.ts` as a new helper). New files are taken from the archive branch with `git show <sha>:<path>`; the five small edits are re-applied by hand onto main's current versions. `src/agent/permissions.ts` was not changed by Phase 60 and is not touched. *Undo: cheap.*
- **D-03:** The base is the end of Phase 60 on the branch (`ae5e9e1`, "complete phase 60 after real-window UAT re-test"), not the branch tip. Later commits on the same files are taken only when they fix Phase 60 behaviour (the `fix(team): ...` commits, for example 3e11c0e "two windows on one team mirror take turns, and an append always commits on the state it was built from"); commits that add Phase 61, 62 or 62.1 behaviour (invites, joins after genesis, sealed keys, NEAR org, work items, assignment) are left out. Research classifies every later commit that touches a Phase 60 file as "fix, take" or "later phase, leave" with a reason, and the plans follow that list. *Undo: cheap (each fix is separable).*
- **D-04:** The event type union stays as Phase 60 declared it (all types named, only the ten Phase 60 bodies accepted; any other type is rejected with "unsupported event type for this version"), plus whatever new types TMR-05 needs (D-09). L2 will add the later bodies on top. *Undo: cheap.*
- **D-05:** Phase 60's tests come across with the code and must pass on main unchanged in meaning; where main's helpers or APIs moved since 0.4.11 the tests are adapted, never weakened. Phase 60's success criteria are re-verified on main by running them, not assumed from the branch's VERIFICATION.md (TMR-02). *Undo: not applicable.*

### One device identity per person per install (TMR-05, links Phases 70 and 71)
- **D-06:** Phase 60 kept one key per device per team (`nearAi.team.deviceKey.<teamId>`). Phase 70 needs a solo person (no team) to sign their first policy bundle on a fresh install, and the owner chose one persistent `did:near` identity per member (Phase 71). So the key moves up one level: **one Ed25519 device identity per person per install**, stored only in SecretStorage under one name (`nearAi.identity.deviceKey`), created on first need, and used by Team Mode for every team this install joins (the roster binds this key's fingerprint as the member's device). Team Mode never ships the per-team key on main, so there is nothing to migrate. Consequence accepted: the same device fingerprint appears in every team the person is in; a `did:near` identity is global anyway. *Undo: costly once released (the key name and the fingerprint end up in logs and signed payloads), cheap before the first release that contains this phase.*
- **D-07:** The identity module stays `vscode`-free: it takes the existing type-only `SecretStorageLike`. The private key never leaves the closure-held `KeyObject` and SecretStorage: never in settings, the workspace, `team.json`, the log, transcripts, audit or fixtures. *Undo: not applicable (a rule).*

### Signing any canonical payload (TMR-05)
- **D-08:** One interface for every signed thing that is not a team event: `signPayload(identity, purpose, payload)` and a never-throwing `verifyPayload(...)`, in `src/domain/team/` (pure; the private-key half in `src/team/identity.ts`). The signature covers a domain-separated input: a fixed prefix naming this product, a version and the **purpose** (a closed list: `policy-bundle`, `grant`, `approval-answer`, with room to add; unknown purposes are refused) followed by the canonical JSON bytes (Phase 60's canonicaliser, D-06 of Phase 60: sorted keys, safe integers only). So a signature made for one purpose can never be replayed as another, and none can be replayed as a team event. The signed envelope names the signer by device fingerprint and public key, and carries an optional member id slot so Phase 71 can add the `did:near` identifier without changing the format. Team events keep their own signing input from Phase 60 (the envelope without `sig`), because their `teamId`, `type` and `v` fields already separate them. *Undo: costly. Policy bundles, grants and approval records signed through it outlive a change; the format carries a version so a later one can be added beside it.*
- **D-09:** Key rotation and revocation are signed events, and every check honours them through one key-status lookup. In a team: the existing `device.revoked` (positional, Phase 60 D-11) and a new `device.rotated` event signed by the old key (or by the owner or a lead) naming the new key, in one event so there is no moment with two active keys or none. For a person with no team, the same two records live in a local, append-only, signed key history in extension global storage, so a solo policy bundle (Phase 70) is checked the same way. `verifyPayload` takes the key status from that lookup: a revoked key is refused for everything; a rotated-out key is refused for anything signed after the rotation; the result says why in plain words. *Undo: medium; the key history format is local but signed payloads depend on its rules.*
- **D-10:** Phase 69 builds the interface and proves it with tests over sample payloads of each purpose (no real policy, grant or approval format). Phases 70, 71 and 80 call it and must not add a second signer. *Undo: cheap.*

### Two private git mirrors (research flag 2)
- **D-11:** Team Mode's coordination mirror (`<globalStorage>/team/<teamId>/coordination.git`, Phase 60 D-16) and Phase 27's sync mirror (`<storage>/sync-mirrors/<project key>/mirror.git`) are different folders, so they never share a mirror. The team transport's cross-process lock uses main's existing `acquireFileLock` / `withFileLock` from `src/services/stateMirrorLock.ts` with its own lock file name in the team mirror folder, instead of porting the branch's `mirrorProcessLock.ts`; one lock implementation in the product. A test runs a team sync and a state sync on one project at the same time and shows neither waits for or touches the other's mirror or lock. *Undo: cheap.*
- **D-12:** The two features also must not share a branch on the project's remote. Sync owns `refs/heads/near-ai/state` and `refs/near-ai/incoming` (`src/services/stateTransport.ts`). `team.json` is attacker-influenced, and its coordination ref pattern would today accept `refs/heads/near-ai/state`, so `team.json` validation refuses any coordination ref equal to or under a sync ref, and the team transport uses its own incoming and quarantine ref names that cannot collide. *Undo: cheap.*

### Commands, settings and what a person sees
- **D-13:** Phase 60's commands come across with their ids unchanged (`nearAi.team.enable`, `nearAi.team.verifyLog`, setting `nearAi.team.pollSeconds`); they do not collide with main's agent-team commands (`nearAi.teams.*`, Team Studio). Without invitations (Phase 61, milestone L2) a team on main can only hold its owner, so the two commands are hidden from the Command Palette unless a new boolean setting `nearAi.team.preview` (default false, application scope) is on. A project that already has `team.json` still starts its session and status bar whatever the setting says, so a team project is never silently ignored. *Undo: cheap (flip the default or drop the `when` clause).*
- **D-14:** A project with no `team.json` does exactly what it does today: one `fs.stat` at activation and nothing else (Phase 60 D-24). The full suite stays green, and the Phase 60 solo-parity test plus a canary test (no secret in the log, `team.json`, settings or audit) run on main (TMR-03). *Undo: not applicable.*
- **D-15:** `team.json` stays at `.planning/.near-ai/team.json` (Phase 60 D-21) because Enable Team Mode commits it with the project so every clone can find its team. Research checks how main treats `.planning/.near-ai/` since 0.4.11 (protected paths, Phase 26 state layout, Phase 27 sync) and the plans follow what main does; if main's sync would copy or rewrite `team.json`, the plan keeps the two apart. *Undo: medium (moving the pointer later needs a migration for every team project).*

### v0.6.0 disposition (TMR-04)
- **D-16:** The disposition record is one planning document, `.planning/research/v0.6.0-disposition.md`, with one row per v0.6.0 phase (60-67, 62.1) and per v0.6.0 requirement: landed in Phase 69, carried to the Team Mode milestone L2, folded into a named v0.7.0 phase, or retired, with the reason. Carried ids that collide with v0.7.0 ids take the `TM-` prefix (TM-TEAM-01..04, TM-SETUP-01). REQUIREMENTS.md and ROADMAP.md link to it. Starting point: REQUIREMENTS.md line "Carried from v0.6.0" (TM-TEAM-01, TM-TEAM-04, SEC-01, SEC-04 land here). *Undo: cheap (a document).*

### Release and process
- **D-17:** The phase lands on `main` through the normal reviewed PR and ships in the next 0.4.x release (owner, 2026-11-15: Stage 1 phases ship in 0.4.x as they land). The release itself is not a plan in this phase. *Undo: not applicable.*
- **D-18:** Repo rules apply to every plan: tests on every change; every test command uses the memory cap (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 <cmd>`; full suite and e2e with MemoryMax=6G and timeout 1800), one heavy run at a time; e2e only under xvfb with Wayland variables stripped; plain language, no em-dashes, "your organization" never "NEAR organization"; `src/domain/team/*` and `src/team/*` never import `vscode`; no new runtime dependency in the extension. *Undo: not applicable.*

### Amendments from research (2026-11-15, made on the owner's behalf; these refine the decisions above and win where they differ)
- **D-19 (refines D-03):** The post-Phase-60 commits to take are `3e11c0e` (two windows on one team mirror take turns; its `mirrorProcessLock.ts` part is replaced per D-11) and `9e49bc5` with its test `35ac2b9` (the load-dependent dedupe key in `teamSession`; hunk 4, Phase 61 key install, is left out). The plain-words string changes in `0f5ea20` and `f6890da` are taken only where they touch Phase 60 strings. Everything else after `ae5e9e1` stays on the archive branch. Files are copied by explicit path, never by a `team*` glob, because main has newer `teamStudio*`, `teamInvocation` and `agentTeams` files. *Undo: cheap.*
- **D-20 (refines D-08):** The payload signer accepts any Ed25519 signer (an object with a public key, a fingerprint and a sign function), not only the device identity, so Phase 71's per-agent keys use the same interface (D-10: no second signer). Signing input: `near-ai-vscode/signed-payload/v1\n<purpose>\n` followed by the canonical JSON bytes; it can never equal a team event's signing input, which starts with `{`. Public keys stay raw Ed25519 as base64url so the NEAR implicit account id (lowercase hex of the key bytes) and a `did:near` verification method can be derived offline. An internal purpose `key-record` signs the local key history entries. *Undo: costly (same as D-08).*
- **D-21 (refines D-09):** Revocation stops a key for everything. Rotation retires a key only for payloads that claim a signing time after the rotation, and that time is chosen by the key holder, so rotation does not stop a copied key; only revocation does. The verifier's result and the user-facing text say this plainly, and a person who thinks a key was copied is told to revoke, not rotate. *Undo: medium.*
- **D-22 (refines D-06):** Enable Team Mode's rollback no longer forgets the device key whenever enabling fails: it forgets it only if this call created the key and nothing was signed with it. A test proves an existing identity survives a failed Enable. *Undo: cheap.*
- **D-23 (refines D-12):** `team.json` validation refuses, comparing case-insensitively, any coordination ref equal to, under, or a prefix of `refs/heads/near-ai/state`, and anything under `refs/near-ai/incoming`. The team mirror's lock file is `near-ai-team-sync.lock` (sync uses `near-ai-state-sync.lock`). *Undo: cheap.*
- **D-24 (refines D-13):** Only `NEAR AI: Enable Team Mode` is hidden behind `nearAi.team.preview`. `NEAR AI: Verify Team Log` shows when the preview setting is on or a team session is running (context key `nearAi.team.active`), so a team project never leads to a dead end. Command titles stay as Phase 60 named them. *Undo: cheap.*
- **D-25 (refines D-17):** The agent review caps a PR diff at 1,000,000 bytes and the port alone is about 659 KB, so the phase lands as at least two PRs: first the unchanged Phase 60 port with its fixes (TMR-02, TMR-03 evidence on main), then the per-person identity, `device.rotated`, the payload signer and key history (TMR-05), with the disposition record (TMR-01, TMR-04) in whichever PR is smaller. Each PR leaves main green. *Undo: not applicable.*
- **D-26 (refines D-16):** The disposition record also has a "same id elsewhere" column, because `SEC-01..03` and `UX-01/02` also exist in the shipped v0.4.0 archive and `BUDGET` sits next to v0.7.0's `BUDG`. It lists the 34 requirement ids the archive actually carries (its header says 33). *Undo: cheap.*
- **D-27 (new):** The ported `teamManifest` test compares against the 0.4.11 merge base, which means nothing on main; it is replaced by a test of main's `package.json` that checks the three Phase 60 contributions, the new setting and the `when` clauses. *Undo: cheap.*
- **D-28 (accepted consequence of D-06):** The one device fingerprint is visible to anyone who can read the project's remote, and on a shared code-server one install can mean one identity for several people. Recovery and per-person identity on shared hosts stay with the shared code-server requirements (SHRD-02, SHRD-03); this phase only records the consequence in the phase docs. *Undo: as D-06.*

- **D-29 (refines D-25, planning 2026-11-15):** The per-person identity change (D-06, D-22) lands in PR 1, not PR 2, so the per-team key name `nearAi.team.deviceKey.<teamId>` never reaches `main` and no 0.4.x release cut between the two PRs can ship it. PR 1 still records unchanged-port evidence for TMR-02 before the identity is adapted. PR 2 carries `device.rotated`, the payload signer, key status, the solo key history and the disposition record. *Undo: cheap (plan 69-07 can move behind 69-08 to the PR 2 branch).*

### Claude's Discretion
- File split inside `src/domain/team/` for the payload signer and key status (one new file or two), and the exact names of exported functions, as long as D-08 and D-09 hold.
- Order of porting within the plans, as long as each plan leaves main green.
- Test file names for new tests, following the `src/test/team*.test.ts` pattern.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Roadmap and requirements
- `.planning/ROADMAP.md` Phase 69 (and Phases 70, 71, 80 for what consumes the signer)
- `.planning/REQUIREMENTS.md` TMR-01..05 and the "Carried from v0.6.0" line
- `.planning/PROJECT.md` "Platform direction (owner decisions, 2026-11-15)"
- `.planning/STATE.md` "Owner answers 2026-11-15"

### Source of the port (read with `git show origin/feat/team-fix-pass:<path>` or `git show ae5e9e1:<path>`)
- `.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster/60-CONTEXT.md` (D-01..D-31), `60-RESEARCH.md`, `60-PATTERNS.md`, `60-0N-SUMMARY.md` (01-12), `60-VERIFICATION.md`, `60-SECURITY.md`, `60-UAT.md`
- `src/domain/team/{canonical,types,permissions,policy,secrets,validate,materialize}.ts`, `src/team/{identity,runGit,transport,gitTransport,eventLog,teamFile,auditMirror,enable,syncScheduler}.ts`, `src/services/team/{teamCommands,teamSession,teamStatusBar}.ts`, `src/test/helpers/{teamHarness,teamEvents,teamCanary,teamAppendChild,vscodeStub}.ts`, `src/test/team*.test.ts`

### Main code the port must fit
- `src/services/stateMirrorLock.ts`, `src/services/stateTransport.ts`, `src/services/stateSync.ts`, `src/services/syncFlows.ts` (Phase 27 sync mirror, lock and refs)
- `src/domain/protectedPaths.ts`, `src/extension.ts`, `src/domain/approval.ts`, `src/services/auditStore.ts`, `src/services/auth.ts` (`SecretStorageLike`), `package.json`
- `src/domain/redaction.ts` (secret detectors reused by `assertNoSecrets`)
</canonical_refs>

<specifics>
## Specific Ideas

- The signer is the piece with the highest undo cost; Phase 70's research will look at OpenShell's policy format and the spike's DID drafts (`.planning/research/platform-direction/openshell-spike/`). Keep the payload envelope small and versioned so those phases can wrap it, not replace it.
- Phase 60 proved "two VS Code instances on two clones" with two team-core clients in `node --test` (Phase 60 D-28); the same proof is acceptable on main.
</specifics>

<deferred>
## Deferred Ideas

- Invitations, joining, removal, NEAR organization calls, sealed key delivery (Phase 61), the board and work items (Phases 62, 62.1), and Phases 63-67: milestone L2, on the archive branch.
- `did:near` documents, member identities above device keys, grants: Phase 71.
- Policy bundle format and the gate: Phase 70. Request-bound approvals: Phase 80.
- Board sync over the relay (`relayTransport.ts`): superseded by L5's federation transport.
</deferred>

---

*Phase: 69-team-mode-reconciliation-identities-and-signed-events-on-main*
*Context gathered: 2026-11-15 (decisions made on the owner's behalf)*
