# Phase 33: Live multi-user staff projects - Research

**Researched:** 2026-11-21
**Domain:** Live replication client (SSE replicator, editor binding to Yjs, presence, sync status, contested decisions), a generic roster feature check (POST-01), hub hardening, scenarios, docs and the drop A release
**Confidence:** HIGH for the code facts (every API, line and value below was read in the worktree this session); MEDIUM for VS Code behaviour that depends on editor internals; LOW only where tagged `[ASSUMED]`
**Base:** worktree `docs-phase-33-plan` at `0341ef81` (main with Phases 30, 31, 32 and 41 merged). `package.json` says 0.4.35, and `v0.4.35` contains neither `hub/` nor `hubTransport.ts`, so the hub, its client and every hub API are unreleased and free to change without compatibility cost (checked with `git ls-tree -r --name-only v0.4.35`). The roster kinds of Phase 31 shipped in 0.4.35 and are permanent.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Order, base and branches**
- **D-01:** Phase 33 builds on `origin/main` with Phases 30, 31, 32 and 41 merged. The first task of every plan re-reads the names it relies on from main (the `HubTransport` push signature, `hubSync.ts` exports, `ReplicaProject`, `MigrationResult`, `TrustFacts`, `term()`, the copy lint and architecture baselines) and stops if they differ from the plan.
- **D-02:** One integration branch `feat/phase-33-live-staff`, plan branches `feat/phase-33-NN-<slug>` from its HEAD, merged back after each wave, one integration PR for the phase (the Phase 31, 32 and 41 pattern). Plans in one wave never change the same file. The drop A release is a separate `release/0.4.N` PR after the phase PR merges (D-38).
- **D-03:** Phases 32.1, 32.2 and 44 are planned and may build in parallel worktrees. Phase 33 does not edit Get Started's files when they exist, the guide question registry, `src/domain/gate/**` beyond reading it, or compliance files. It registers its setup step through the existing `registerSetupStep` registry (D-19), which Phase 32.1 keeps as the guide's step registry (EXPERIENCE 1).

**POST-01: the generic feature check (one-way door)**
- **D-04 (wire shape):** A new roster-family kind `roster.require` with data `{ features: string[] }`, written only by a lead device (lead or deputy), linear in the roster chain like every roster entry. Feature ids use the policy's `name@N` pattern (Phase 41 D-50). The project's required set is the union of every folded `roster.require`; a feature once required is never dropped (a later entry can only add). Its schema is settled in the first plan because roster kinds are permanent in shared logs.
- **D-05 (known features):** `KNOWN_REPLICA_FEATURES` in `src/domain/replica/` lists the features this client folds. Drop A ships it with the features it actually has (proposed: `replica@2`, `cells@1`, `hub@1`, `require@1`), so a project can already require them; `positions@1` is added by Phase 33.1. One registry; nothing else decides "do I know this feature".
- **D-06 (fail closed, whole project):** When the folded required set holds a feature this client lacks, the fold stops for that project: no state is projected, nothing is appended, the editor binding and replicator stay off, and the Staff Room shows "This project needs a newer version of the extension. Update to keep working on it." (portfolio DESIGN 3.9, exact words). The store keeps every entry, so updating resumes with no loss. The check runs on the roster fold, before any other family, so no entry from a later feature is ever half-applied.
- **D-07 (the hub obeys it too):** The hub folds `roster.require` in its roster cache. A hub that lacks a required feature refuses appends for that project with a plain reason (`needs-update`) and keeps serving reads, so an older hub can never accept a relieved holder's writes. A client also announces its `KNOWN_REPLICA_FEATURES` at session start; the hub refuses a session for a project whose required set the client does not cover, with the update sentence, so a client too old to know `roster.require` at all (the 0.4.35 preview) cannot write through the hub once a project requires anything.
- **D-08:** Making a project multi-user writes `roster.require { features: ["require@1"] }` right after genesis, so every drop A project starts with the check armed. Existing preview projects get it on their next lead open after updating (one entry, lead device only).

**The live replicator (sync connection machine, DESIGN 15.3)**
- **D-09:** One `LiveReplicator` per shared project per device in `src/staff/replica/`, built on `HubTransport` and `hubSync.ts` (never a second transport). States exactly as DESIGN 15.3: `single-machine`, `connecting`, `authenticating`, `catching-up`, `live`, `offline`, `refused`, `attention`, as a pure transition table in `src/domain/replica/` with every transition tested, plus `needs-update` from D-06 as a ninth state that only an update leaves. No state waits silently: `connecting` gives up to `offline` after 10 s, `offline` retries with back-off to 5 minutes and on Sync Now or a network change.
- **D-10 (hub address):** The roster stores the hub's pin and id, not its address. The address comes from the enrolment hub file or the invitation (Phase 32 invitation hub field), is kept per project per device in the project's local store settings (not in `settings.json`), and can be changed by the person under Share with people ("Change your organization's server address"), with the pin re-checked on every connection. A changed address never changes the pin.
- **D-11:** Pushes pass `blobsCitedBy` to `HubTransport.push` (Phase 32 follow-up). Appends are local first: the store writes, then the replicator pushes; a failed push leaves the entry queued, never lost.
- **D-12:** A `join-request` server-sent event makes the lead's and deputy's replicator call `fetchJoinRequests` and raise the Staff Room's "{name} wants to join. Compare this code with them: ..." card with Admit and Decline (Phase 31 flow, unchanged).
- **D-13:** Hub witness findings (withhold, delay, replay, reorder, roll back, fork the view, inject, corrupt blob, other project's stream) map to `attention` with the plain sentence the witness already names; "delayed" findings stay `live` with a detail line. The way out of a fork or rollback finding is the lead's **Re-admit your organization's server** action (SECURITY.md promises it "with the editor's hub commands"), which signs a fresh `hub.admit` citing the new pin or the restored checkpoint after the lead compares the twelve fingerprint words (Phase 41 D-12 style).
- **D-14:** Refusal (`refused`) shows the reason and the person to ask (staff lead by `term()` word); `connecting` after the lead acts. Quarantine of this device (equivocation proof) shows "One of your computers signed two different histories. Your new work is held until the staff lead looks at it."

**Editor binding (DESIGN 5.4)**
- **D-15:** The binding follows the y-codemirror and y-monaco pattern: local `onDidChangeTextDocument` changes become `Y.Text` operations with a local origin object; remote Yjs changes become a `WorkspaceEdit` applied with an echo guard keyed on that origin; local edits batch into one `doc.update` per product at most every 500 ms (DESIGN 5.2). On a detected mismatch between the editor text and `Y.Text` (fuzz-found or real), the binding resyncs the editor from `Y.Text` and logs one line. Clean-room: we read the y-codemirror and y-monaco sources (MIT) for the pattern and cite them; no code copied.
- **D-16:** Undo and redo in a bound product run through a Yjs `UndoManager` scoped to local origins, through `undo` and `redo` keybindings with a `when` context `nearAi.staffBoundEditor`, so VS Code's own undo never replays a remote edit. Outside bound products, undo is VS Code's.
- **D-17:** The header region (projected from the fold) is read-only: an edit to it is reverted with one notice "The header is kept by the project. Change it from the Staff Room." Saving writes the projection. A disk change outside the binding is offered as **Take This Change as My Edit** (signed by the person) or **Restore**.
- **D-18 (cursors and attribution):** Remote cursors and selections are Yjs relative positions in presence messages sealed under the product's cell key, at most 10 per second, never stored, shown as editor decorations with the person's name and position word from `term()`. **Show Who Wrote This** toggles gutter colours per author with a hover naming the person, or "{agent job} agent, run {n}, on {person}'s computer". Colour is never the only carrier (a name on hover and in the accessible text).

**Share with people, presence, status, contested**
- **D-19 (front door):** "Share with people" is registered with `registerSetupStep` (state, run) and offered as a Staff Room button and under the existing sync/settings surface for My computers and sharing; it never adds a top-level setup command (EXPERIENCE 1). The Phase 31 preview commands (`nearAi.staff.makeMultiUser`, `inviteToProject`, `joinProject`, `admitToProject` and the rest) keep their ids as hidden aliases that open the right step or Staff Room action. Opening a `.near-staff-invite` file opens the join step already filled in. When Get Started (32.1) lands, it lists the same step; nothing in Phase 33 changes.
- **D-20 (preview switch):** `nearAi.staff.multiUserPreview` is retired at the drop A release: shared projects are on for everyone, the setting is kept one minor release as deprecated and ignored, and its description says so. Projects that never turn on sharing behave exactly as before (MUS-06 parity test stays).
- **D-21 (presence):** Heartbeat every 5 s, time to live 30 s, as DESIGN 10.5; fanned out only to the cell's access list and never written to disk. The Staff Room header lists people with position and a dot (green "Live", grey "last seen 14:02") and a hover "Working on the intelligence estimate. Running 2 agents." The person setting "Show others what I am working on" (on by default) lives in the Share with people section, not as a new top-level setting page.
- **D-22 (status):** Sync state joins the one NEAR AI status item that exists today (`gateStatusBar.ts`), as one short word after the label and trust ("Protected B · Verified · Synced"), with detail in its popover or tooltip; no new status bar item (EXPERIENCE 5). The Staff Room bar shows the full sentence and one action per state (DESIGN 19 wording, "changes" never "entries", "your organization's server" never "hub").
- **D-23 (offline banner):** Shown in the Staff Room while `offline`: "You are offline. Your changes are kept here and will sync when your organization's server is back. Decisions you make now may become contested if someone else decides the same thing." Decisions folded after the newest checkpoint show "not yet confirmed by your organization's server".
- **D-24 (contested):** The decision queue card uses DESIGN 19's wording with both names and reasons and the two actions; settling writes a fresh decision whose `decisionsSeen` lists every contested decision. The decision dialog acts on the hash and state on screen and refuses with "Someone else decided this version while you were deciding. Look again." if another decision on that version folds while it is open. A focused browser check covers these two paths (authorization contract, DESIGN 17).
- **D-25 (N changes since):** The Staff Room shows "v5 awaiting decision, 37 changes since"; after 20 changes it prompts the product's owner once to propose a new version; never withdraws (owner decision 4).
- **D-26 (trust line):** Product rows and agent cards in the Staff Room use the one trust line from `TrustFacts` (Phase 41 D-38). No new badge state.
- **D-27 (words):** Every new string follows the glossary: "your organization's server", "Who can see this", "member" and lead words from `term()` in the project's mode (Corporate and software until 33.1 sets a mode), "agent team" and "work team" never a bare "team", "private" only when checked, organization Confidential shown as "Sensitive", no em-dashes, "your organization". The copy lint baseline can only shrink; new files pass the architecture test (no `getConfiguration` outside `services/settings.ts`, no `vscode` below the editor layer, size limits).

**Phase 32 follow-ups and hub hardening**
- **D-28 (WR-07 hub side):** The hub answers `blob-missing` per entry (that entry refused and retryable, the rest of the batch appended), not per batch. The client keeps its Phase 32 `heldBack` behaviour.
- **D-29 (IN-02):** Before moving a temporary folder in as the store, Start Again recovery checks it against the counts the intent records (`carried`, `grants`, `blobs`); on a mismatch it rebuilds again from the source. A disaster test kills the rebuild part way.
- **D-30 (IN-06):** At most 8 pending join requests per invitation and 64 per project at the hub; beyond that the hub refuses with "This invitation has too many people waiting. Ask the staff lead for a new one." Both numbers live in the hub's limits file with the others.
- **D-31 (`MigrationResult.withheld`):** After Share with people converts a project, products withheld from conversion (labels the lead's declared clearance does not cover) are listed by name with what to do ("Ask someone cleared for {label} to make a single-machine copy and share it again"), never silently dropped.
- **D-32 (restore limits, one-way for the hub API):** A restored hub starts in **restore mode** when its state directory carries the restore marker the operator's restore procedure writes (`relay/README.md` restore drill gains one step). In restore mode the hub accepts only hand-backs (checkpoints and entries members' computers already hold, Phase 32 D-70) and refuses new appends with a retryable `restoring` answer, until every enrolled device that held a lost checkpoint has handed back or the operator ends restore mode. Clients show "Your organization's server is being restored. Your changes are kept here." (an `offline`-like detail line, not `attention`). This removes limit 1 for restores done by the procedure; limit 2 (a lost checkpoint no client received) stays documented as accepted, with the operator step that clears it unchanged.
- **D-33 (other Phase 32 leftovers):** Kept as documented limits and moved to Phase 35's hub work, not built here: WR-02 for cells the hub cannot open, checkpoints whose covered heads exceed 64 KiB, clients not recomputing checkpoint order, and the deleted-store-with-mark case of 32-01.

**Scenarios, leak test, docs and release**
- **D-34 (scenarios):** Two- and three-person scenarios run real processes over a real hub (the `hub/` build started on a temporary state directory and loopback TLS, as the restore drill does), with separate store folders and device keys per person, driving the replicator and folds without the VS Code UI: co-edit, propose, guard, approve on another machine with equal digests; approve offline and reject online shows contested until a fresh decision; a late joiner loads from a compaction plus later updates. The editor binding is covered separately with fuzzed interleavings against a fake document. Each scenario runs inside the memory cap.
- **D-35 (leak test over the hub):** The Phase 32 two-compartment label leak test is repeated through the live replicator and a real hub: two people each cleared for one compartment, every byte each device and the hub receive captured, no plaintext and no stream of the other compartment reaches a device, the hub holds only ciphertext for ungranted cells, presence and cursor messages included.
- **D-36 (docs):** README (the Marketplace listing) gets a "Work on a staff project with other people" section that replaces the single-machine sentence from 0.4.35; SECURITY.md gets a multi-user staff projects section. Both carry the self-declared sentence and the not-accreditation sentence, reusing the wording SECURITY.md already uses ("self-declared until verified credentials arrive", "labels are not accreditation"), fixed in the docs plan and checked word for word by a docs test. CHANGELOG `## Unreleased` gets user-facing bullets.
- **D-37 (verification cadence):** Each plan runs its own tests through `node scripts/run-tests.mjs` inside the memory cap; the hub's suite runs in `hub/` for hub plans; the full suite, e2e, `verify:release` and the secret scan run once in the closing plan under the heavy lock (Phase 41 D-48).
- **D-38 (drop A release, success criterion 4):** After the phase PR merges, a `release/0.4.N` PR (N the next free patch, expected 0.4.36) is prepared with `scripts/prepare-release.mjs` and the release skill: version bump, CHANGELOG section named, README checked, `prepare-release check`, `verify:release`, secret scan. Merging, tagging and the Marketplace publish wait for the owner's explicit OK and click, as for every 0.4.x release. The phase's closing plan ends at "release PR open and green"; the owner approves the rest.
- **D-39 (gate paths):** If a plan must change gate paths (SECURITY.md, `scripts/lib/`, `.github/`, `verify-release-content.mjs`), the integration PR needs the owner's gate approval, and the run URL is sent the moment it waits.

### Claude's Discretion
- **D-40:** File splits inside `src/staff/replica/` and `src/services/`, the exact feature id strings of D-05, debounce constants inside DESIGN's bounds, decoration colours (theme tokens), and test fixture shapes are the planner's and executor's choice, within the architecture test and the copy lint.

### Deferred Ideas (OUT OF SCOPE)
- Offline transports (git per-writer refs, bundle, LAN): Phase 34
- Claims, leases, "agent writing here", shared run summaries, observations, hub watches, hub policy loading (C1, C2), the D-33 hub leftovers: Phase 35
- Positions, postings, handover, `positions@1`, roster clearance into `decideRoute`: Phase 33.1
- Get Started stepper UI and moving Share with people into it visually: Phase 32.1 (the step is already registered)
- WebSocket push if measured latency needs it (DESIGN 10.4)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MUS-09 | Live multi-user staff projects in the extension: editor binding, presence, sync states, contested UI, docs. | Everything below: the replicator (API facts 1.1 to 1.4), the binding (3.1 to 3.4), presence (2.4, 3.5), sync status and Staff Room (3.6 to 3.9), contested decisions and the shared write path (4), scenarios and docs (5, 7). |
| POST-01 | `roster.require` feature check: a client, or your organization's server, that lacks a feature a project requires refuses to fold it with the update sentence instead of ignoring entries it does not know. | Roster fold hook (1.6), hub hook (2.1, 2.2), fold-wide stop (1.7), one-way-door schema notes, test updates (kind counts 51 to 52 and 18 to 19). |
</phase_requirements>

## Summary

Phase 33 is mostly assembly, but the code reading found **fourteen places where the decisions in 33-CONTEXT.md name a piece that does not exist yet or cannot work as written**. They are listed first in "Findings that change the plan" because they decide the size of the plan set. The biggest: (1) every write method of `StaffHost` is refused in a shared project (`staffHost.ts:524-527`, "Live multi-user writes arrive in Phase 33." at line 34), so propose, guard, submit, approve and release over a hub need a new shared write path that no decision names; (2) D-13's "Re-admit your organization's server" cannot be done with a fresh `hub.admit` because the roster refuses a hub id given twice (`rosterMembers.ts:446-448`) and the witness never clears `distrusted`; (3) nothing writes `doc.compact` and no sync path starts from a checkpoint base, so "a late joiner loads from a compaction" has no producer or consumer; (4) the fold exposes only text and hashes per product, not the update bytes the editor binding needs; (5) `HubTransport.subscribe` throws away `join-request`, `roster`, `checkpoint` and `equivocation` events and the presence `cell`, `writer` and `left` fields, and the client has no presence POST at all; (6) `blobsCitedBy` is a constructor option of `HubTransport`, not a parameter of `push`.

The stack needs **no new package**: Yjs 13.6.33 and lib0 0.2.119 are already vendored and hash-pinned, `vendor/yjs/yjs.cjs` bundles the whole `yjs` package including `UndoManager` and relative positions, and everything else is `node:crypto`, `node:test` and the VS Code API at 1.101. The architecture test freezes `staffHost.ts` (1688 lines) and `store.ts` (1673 lines) at their size and fails a new file above 1200 lines, and `replicaProject.ts` has 27 lines of headroom and `hubTransport.ts` 96, so almost all new code must go into new files with one- or two-line hooks into the big ones.

Real-hub scenario tests need Node 26.13.1 (the hub refuses anything else, `hub/src/nodeVersion.ts`), while the extension's tests run on Node 24.22.3. Node 26.13.1 is installed here through nvm. The existing hub tests (Node 26, `hub/test/`) drive a real in-process hub with memory replicas and a byte-capture proxy; the extension-side tests use a scripted fake hub. A scenario that uses `ReplicaProject` (Yjs, store, decode worker) against a real hub therefore needs either a Node 26 child process started from an extension test or a Yjs-free replicator core driven from `hub/test/`. Both are recommended below, and the CI wiring touches `.github/` (a gate path, D-39).

**Primary recommendation:** Build tracer-first (wave 1: two devices, one real hub, one edit made through the binding core and seen on the other device). Wave 2 runs POST-01, the editor binding, the shared version acts and the small hub and store follow-ups in parallel; wave 3 the hub rules with the transport edits, and the projector, compactor and address store; wave 4 the full replicator and Share with people; wave 5 presence and the Staff Room; wave 6 the scenarios, the leak test and the docs; wave 7 the close-out and the release PR. Put every new behaviour in a new file, and settle `roster.require` (and any `hub.readmit`) first among the domain changes because roster kinds are permanent. Ask the owner the eight open questions before wave 2 starts, above all Open Questions 1 and 2.


## Project Constraints (from CLAUDE.md)

There is **no `CLAUDE.md` in the worktree** (checked with `ls`; the repository root has none). Directives that do bind this work, from the user's global rules, the project's memory notes and `.claude/commands/`:

- Never delete, overwrite or move anything under `~/.near-credentials` (not touched by this phase).
- Run every test command inside the cap wrapper and through `scripts/run-tests.mjs`, never bare `node --test` or uncapped `npm test` (a PreToolUse hook blocks it): `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-tests.mjs dist/test/<file>.test.js` (6G and `timeout 1800` for the full suite or e2e). One heavy run at a time. [CITED: memory note `cap-test-memory`]
- Say "your organization", never "NEAR organization"; no em-dashes in any copy; the copy lint (`src/test/copyLint.test.ts`) and the architecture test enforce this and the layering.
- Development cadence: smallest relevant check after an edit; broader suites in batches; the full suite once at the phase boundary; security, authorization, data-integrity and architectural-boundary checks are blocking whenever touched; never weaken a failing test to get green.
- Release 0.4.x: release PR from `scripts/prepare-release.mjs`, CI plus the agent review, `merge-pr` tags, the owner approves the publish. Strict ordering on main (`.claude/commands/release.md`, `merge-pr.md`, `review-pr.md`).
- Coherence review gate (memory): new user-facing features are checked against the glossary and the maps before they merge.
- Work in parallel by default: waves below name the file ownership that makes plans in a wave independent.
- Any change to SECURITY.md, `scripts/lib/`, `.github/` or `verify-release-content.mjs` needs the owner's gate approval on the integration PR (D-39).

## Findings that change the plan (read first)

Each row says what a decision assumes, what the code shows, and what the plan must do. "Impossible" means the decision cannot be built as worded without a roster or API change; the row gives the smallest change and says who must confirm.

| # | Decision or criterion | What the code shows | What the plan must do |
|---|---|---|---|
| F1 | D-11 "pass `blobsCitedBy` to `HubTransport.push`" | `blobsCitedBy` is an option of the **constructor**: `HubTransportOptions.blobsCitedBy?: (entryHashes) => Promise<Array<{entry, blob}>>` [VERIFIED: hubTransport.ts:114-118]. `push(entries, blobs)` throws without it: `if (this.blobsCitedBy === undefined) throw new Error('Pushing through the hub needs the blobs each entry uses ...')` [VERIFIED: hubTransport.ts:501-502]. `syncOnce` does not use `push`; it calls `appendBatches` and `pushPlan` itself with `local.blobsCitedBy` [VERIFIED: hubSync.ts:440 `const cited = entries.length === 0 ? [] : await local.blobsCitedBy([...hashOf.values()]);`, 443 `pushPlan(entries, cited, heldBlobs, ...)`, 455 `appendBatches(entries, grants, plan.blobRefs, ...)`]. | The replicator builds `new HubTransport({ ..., blobsCitedBy: (hashes) => project.blobsCitedBy(hashes) })`. Nothing else is needed for `syncOnce`. `push` is only used if the replicator pushes a just-appended entry without a full exchange (see Pattern 1). |
| F2 | D-12, D-21 use of `subscribe` | `subscribe(onHeads, onPresence, onEnd)` handles only the `heads` and `presence` events; `join-request`, `roster`, `checkpoint`, `equivocation` frames are read and dropped, and for presence it calls `onPresence(Buffer.from(device.sealed, 'base64url'))`, losing the frame's `cell`, the device's `writer` and the `left` list [VERIFIED: hubTransport.ts:521-552]. The hub frame is `{ project, cell, devices: [{writer, sealed}], left: [writer] }` [VERIFIED: hub/src/live/presence.ts:150-153 (`'presence', (recipient) => ... { project, cell, devices: mine, left: gone }`)]. The client has **no presence POST**; the hub route is `POST /v1/projects/:p/presence {cell, sealed}` or `{cell, leave: true}` [VERIFIED: hub/src/http/routes.ts:414-446]. | The replicator reads `HubTransport.events()` (public, returns an `EventReader` with typed `EventReport` frames) instead of `subscribe`. Add one public `HubTransport.postPresence(...)` method (about 15 lines; hubTransport.ts has 96 lines of headroom under the 1200 limit). New file `hubLive.ts` wraps the reader. |
| F3 | Criterion 3 "propose, guard, approve on another machine"; D-24 | Every write of `StaffHost` returns `refuse(SHARED_PROJECT_REFUSAL)` in a shared project: `private async sharedRefusal()` [VERIFIED: staffHost.ts:524-527] is called at lines 625, 711, 758, 1038 (`propose`), 1175 (`verdict`), 1229 (`submit`), 1256 (`withdraw`), 1582 (`decide`) and six more. The header says "Live multi-user writes arrive in Phase 33." [VERIFIED: staffHost.ts:34]. The only writer of a `version.*` kind anywhere is `proposeVersion` in `labelCells.ts` (`project.appendOwn('version.propose', { product, hash: version, textBlob: blob.hash, snapshot, pins }, ...)`, line 398), used by the migration. Nothing writes `version.verdict`, `version.submit`, `version.decide`, `version.release`, `version.withdraw` or `version.supersede`. | A new plan builds the **shared version acts** (new file `src/staff/replica/versionActs.ts`): propose from the live text, guard and tradecraft verdicts, submit, decide, release, withdraw, each through `ReplicaProject.appendOwn` with the exact data shapes in section 4.1, and a thin delegation from `staffHost.ts` (frozen at 1688 lines, so the delegation must be line-neutral). Registers, wargame, CCIR and step methods stay refused (out of scope: Phase 35). This scope is not in CONTEXT; confirm with the owner (Open Question 1). |
| F4 | D-13 "signs a fresh `hub.admit` citing the new pin" | `applyHubAdmit` refuses a hub id given twice: `if (state.hubs.has(data.hub)) return refused('hub-exists');` and `if (state.devices.has(data.device.writer)) return refused('device-exists');` [VERIFIED: rosterMembers.ts:446-449]. The witness never clears distrust: `if (state.distrusted) return { ..., trusted: false }` [VERIFIED: hubWitness.ts:193] and the state keeps `distrusted: true` with its proof [VERIFIED: hubWitness.ts:205]; a saved state must keep `state.distrusted === (state.proof !== undefined)` [VERIFIED: hubWitness.ts:437-438]. An honest restore keeps the hub's signing key, so its writer id is the same. | D-13 as worded is impossible. Smallest sound change (one-way door, so the owner must confirm; it rides in the same plan as `roster.require` because both add roster kinds): a roster kind `hub.readmit { hub, certPin, rosterPrev }` written by a lead device, applied only for an existing, not revoked hub, opening a new `HubRecord` version with the given pin; the witness remembers the roster position it last distrusted at and clears `distrusted` (dropping the proof but archiving it in the store) once the folded roster holds a `hub.readmit` for that hub at a later position. Alternative without a wire change: a per-device local "trust this server again" action after the twelve words, which D-13's own alternative (confirmation list item 6) describes. Open Question 2. |
| F5 | Criterion 3 and D-34 "a late joiner loads from a compaction" | No code writes `doc.compact` (grep of `src/staff` and `src/services` finds it only in decode-check comments, replicaProject.ts:618, 832, 854). No sync path starts from a checkpoint base: `pullWriter` starts at `head === undefined ? 0 : head.seq + 1` [VERIFIED: hubSync.ts pullWriter, `transport.entries(stream, writer, head === undefined ? 0 : head.seq + 1)`], and `checkpointBases` is used only inside the fold (`classifyChains`). | Decide the minimum that makes the criterion true: (a) a compactor (new `src/staff/replica/compactor.ts`: after `COMPACTION_WINDOW` (50) accepted updates, seal `encodeFullState(foldDoc)` as a blob and write `doc.compact` with `covers`, `stateVector`, `textHash`, `stateBlob`, exactly the schema in section 4.2) and (b) an opt-in `syncOnce` mode for a device holding nothing that pulls each log from the trusted v2 checkpoint's head instead of seq 0. Without (b) the scenario can only assert that the compaction verifies and the late joiner's text and digest equal the others', which is weaker than the criterion. Open Question 3. |
| F6 | D-15 binding "remote Yjs changes become a WorkspaceEdit" | The fold's per-product output carries `text`, `textHash`, `stateVector`, `registrations`, `accepted` (hashes), `attribution`, `deletions`, `incomplete`, `compactions` but **not the Y.Doc and not the update bytes** [VERIFIED: textFold.ts ProductTextOutput, lines 33-52]. The Y.Doc lives in the reducer's private `ProductText.doc`. `ReplicaProject.openEntry` is private. | Add a public read API `ReplicaProject.acceptedUpdates(stream, product, afterAccepted)` (implemented in a new file `productFeed.ts` using `state()` for the accepted hashes and the store's entries for bytes, because replicaProject.ts may grow only 27 lines). The binding applies exactly the updates whose hash is in `accepted`, never raw store bytes (a refused or held update must not reach an editor). |
| F7 | D-24 contested cards | A contested decision reaches the existing staff views only as `PROJECTION_PROBLEMS.disagrees` ("... gate verdicts or decisions made at the same time that disagree, so this view cannot vouch for it") and the product is marked tampered [VERIFIED: projection.ts:91-96, header 7-9]. The fold already has what the card needs: `VersionView.overlay?: 'contested' | 'pending-confirmation'`, `decision: DecisionSummary { status, names, contested, effective, pending, held, finalBeforeDispute }`, `changesSince`, `ownerPromptDue` [VERIFIED: versions.ts:134-175]. | The contested cards come from a new read path off `ProductVersions[]` (new `src/staff/replica/contested.ts`), not from the old ledger replay. The decision command in shared mode writes `version.decide` with `decisionsSeen` (section 4.1). |
| F8 | D-22, D-26 "one short word after the label and trust ('Protected B · Verified · Synced')" | Today the one item is the **policy** item: text is "Policy" or "Policy: reading only" and so on, plus ` · <label>` when the chat in view is above the default label [VERIFIED: gateStatusBar.ts:17-21, 55-62; item created `createStatusBarItem('nearAi.gate', vscode.StatusBarAlignment.Left, 49)`]. There is no trust word in it. `TrustFacts` is built from a `RouteDecision` for a model request (`trustFactsFor(decision, facts, context, extra)`) [VERIFIED: trust.ts:35-45, 81]; nothing produces a `TrustFacts` for a product row. | D-22: append `· Synced` (or the state word) to the existing text through an optional `sync` argument of `gateStatusText` and a `refresh` hook; do not invent "Protected B · Verified". D-26: product rows have no route decision, so "the one trust line" can only apply to agent cards that carry a decision; for product rows show "Who can see this" and the label (glossary section 3). Open Question 4. |
| F9 | D-32 restore mode "accepts only hand-backs" | A hand-back and a new append are the same bytes (an entry); the hub cannot tell them apart. What it can tell: a place covered by a checkpoint it holds (`coveredBefore(store, project, header, hash)`, the WR-02 rule, checks.ts) and whether a device has called the checkpoint ask since the restore. | Specify restore mode as: after the marker, an append entry is accepted only when a kept checkpoint (a handed-back one counts) covers its place; any other append gets the retryable `restoring` answer; mode ends when every admitted person device has made one checkpoint ask since the restart, or the operator removes the marker. The plan must settle the exact rule in its first task and test it with the restore drill (`hub/test/restoreDrill.test.ts`). The clients' hand-back already runs before their push in `syncOnce`, so honest clients make progress. |
| F10 | D-27 file sizes | `architecture-baseline.json` freezes `staff/staffHost.ts` at 1688 and `staff/replica/store.ts` at 1673 ("a frozen file may not grow", architectureScan.ts:49-52); a file above `WARN_ABOVE = 800` warns, above `FROZEN_ABOVE = 1200` fails unless frozen. Current sizes: `replicaProject.ts` 1173, `hubTransport.ts` 1104, `staffMultiUserCommands.ts` 852, `staffRoom.ts` 725, `media/staffRoom/staffRoom.js` 1273 (media is copy-linted but not size-checked). | Every plan puts new behaviour in new files. `store.ts` (IN-02) must end no larger than 1673 lines (put the count check in a new file and net the change to zero). `staffHost.ts` delegation must be net zero or negative. `replicaProject.ts` may take at most about 25 new lines. |
| F11 | D-34 "real processes over a real hub" | The hub runs only on Node 26.13.1 (`MIN_NODE_VERSION = '26.13.1'`; "Returns undefined when `version` is Node 26.13.1 or a later 26.x release", hub/src/nodeVersion.ts:7-12). The extension tests run on Node 24.22.3 here; CI's `test` job runs `NODE_VERSION` and its `hub` job installs Node 24 and then 26.13.1 [VERIFIED: ci.yml 295-312]. `hub/test/*` bundle with esbuild (`@ext` alias) and use `memoryReplica`, never `ReplicaProject`; the in-process hub and the byte capture are `startCapturedHub()` and `captureServer()` in `hub/test/ciphertextOnly.test.ts:154-259`. | Two layers: (1) hub-side tests in `hub/test/` drive a Yjs-free `LiveReplicator` core over `memoryReplica` against the in-process hub (fast, runs in the existing `hub` CI job: SSE live delivery, presence, join-request, restore mode, attention, the leak capture including presence); (2) one src-side scenario file that spawns the built hub on a temporary state directory using the Node named by `NEAR_AI_HUB_NODE`, skipping with a printed reason when it is unset locally and failing in GitHub Actions without it (the pattern of `hub/test/workspace.test.ts`, `NEAR_AI_HUB_OLD_NODE`). The CI step that sets it edits `.github/workflows/ci.yml` (gate path, D-39). |
| F12 | D-10 "the address comes from the enrolment hub file or the invitation" | The address is on the hub file (`HubFilePayload.address`) and the invitation's `hub` field (`InviteHub { address, certPin, writer }`) [VERIFIED: invite.ts:54-55, hubFile.ts:46]; the roster keeps only pin and id. `connectProjectToHub` and `sendJoinRequestThroughHub` use the address for one call and keep it nowhere [VERIFIED: hubMembership.ts:500-536, 570-599]. Joining by file (`joinFromWelcome`) never receives it. | A new small store `hubAddress.ts` next to the genesis pin (`<globalStorage>/staff-replica/<project>/hub.json`, written with the same file helpers as `genesisPinFile`), written by connect, by the invitation at join, and by "Change your organization's server address"; read by the replicator. Validate with `isHubAddress` and `parseHubAddress` on read. |
| F13 | D-13, D-19 hub actions "with the editor's hub commands" | `hubMembership.ts` exports flows (`admitHub`, `grantCellToHub`, `revokeHub`, `hubStanding`, `inviteThroughHub`, `sendJoinRequestThroughHub`, `fetchJoinRequests`, `connectProjectToHub`) but **no VS Code command calls any of them**: the only `hub` hit in `staffMultiUserCommands.ts` is a comment at line 362. The 12 contributed multi-user commands are make, invite, join, admit, remove, add machine, choose branch, name deputy, hand over, update member, single-machine copy, start history again [VERIFIED: package.json query]. | Share with people needs new command handlers (new file, not the 852-line one): connect to your organization's server (open a hub file and confirm it), grant a part, revoke, re-admit, invite through the server, join through the server, change address. `HUB_GRANT_TRADE_OFF` must be shown word for word before a grant (hubMembership.ts:52). |
| F14 | D-19 "Opening a `.near-staff-invite` file opens the join step already filled in" | The extension activates on `workspaceContains:.planning/.near-ai/**` and `onCommand:nearAi.openCyber` only [VERIFIED: package.json activationEvents]. VS Code has no "file opened with this extension" hook except a contributed language or custom editor. Since 1.74 "languages contributed by your extension do not require a corresponding `onLanguage` activation event" [CITED: code.visualstudio.com/api/references/activation-events]; the engine here is `>=1.101.0`. | Contribute a language id for the extensions `.near-staff-invite` (and `.near-staff-welcome`, `.near-staff-hub`), and handle `workspace.onDidOpenTextDocument` for that language to open the join step; or a custom readonly editor. Pick the language route (no webview, fewer security surfaces). Manifest edit: see wave plan (one plan owns `package.json` per wave). |

## Architectural Responsibility Map

The tiers here are this repository's layers (DEVELOPER-STRUCTURE section 1, enforced by `src/test/architecture.test.ts`): pure domain (`src/domain`), hosts and engines with Node I/O but no editor API (`src/staff`), the editor layer (`src/services`, the only place `vscode` is imported and the only place `getConfiguration` is read, in `services/settings.ts`), the page (`media/staffRoom`), and the separate hub service (`hub/`, Node 26).

| Capability | Primary tier | Secondary tier | Rationale |
|------------|--------------|----------------|-----------|
| `roster.require` kind, schema, fold, `KNOWN_REPLICA_FEATURES`, update sentence | Domain, hub-side files (`src/domain/replica`, no Yjs) | Hub (reads the same code), `ReplicaProject` (stop) | The hub compiles the roster fold; one registry decides "do I know this feature" (D-05). |
| Sync connection state machine (nine states, transition table) | Domain (`src/domain/replica/syncMachine.ts`, pure) | none | Pure and testable per transition; no I/O (D-09). |
| LiveReplicator (SSE reader, back-off, exchange scheduling, witness to state mapping, join-request fetch, presence loop) | Staff host (`src/staff/replica/liveReplicator.ts`, Node I/O, no `vscode`, no Yjs) | Hub transport | Must run in `hub/test` (Node 26, no Yjs) and in the extension; talks to a `SyncLocal`, never to `vscode`. |
| Editor binding core (Y.Text <-> text operations, echo guard, undo, relative positions, header region) | Staff host (`src/staff/replica/editorBinding.ts`) over an abstract bound document; Yjs only through `doc.ts` | Domain `doc.ts` (Yjs access, the only file allowed to load it) | Fuzzable against a fake document without VS Code (D-34). |
| VS Code adapter for the binding (listeners, `WorkspaceEdit`, decorations, keybinding commands, context key) | Editor layer (`src/services/staffEditorBinding.ts`) | none | Only the editor layer may import `vscode`. |
| Presence and cursor messages (seal, open, fan-in) | Domain (`src/domain/replica/presence.ts`, `node:crypto` only) | Replicator, editor layer (decorations) | The sealed plaintext format belongs to Phase 33 (`transport.ts`: "their format belongs to Phase 33"). |
| Shared version acts (propose, verdict, submit, decide, release, withdraw) and contested read model | Staff host (`src/staff/replica/versionActs.ts`, `contested.ts`) | `staffHost.ts` (delegation), editor layer (dialogs) | Writes are signed entries through `ReplicaProject.appendOwn`; the dialog stays in `staffCommands.ts`. |
| Staff Room live model (presence, sync sentence, offline banner, contested cards, join requests) | Domain model (`src/domain/staff/staffRoomLive.ts`, pure) | Panel (host), page (`media/staffRoom/staffLive.js`) | `buildStaffRoomModel` is pure; the page only renders what the host sends. |
| Share with people (setup step, hub connect/grant/revoke/re-admit, address, language activation) | Editor layer (`src/services/staffShare.ts` and a hub commands file) | `hubMembership.ts` flows, `setupSteps.ts` registry | Dialogs are editor code; flows already exist and never import `vscode`. |
| Hub append rules (`needs-update`, per-entry `blob-missing`, `restoring`), join cap, restore marker | Hub service (`hub/src`) | `src/domain/replica` (shared fold) | Server side of the same rules; the hub must refuse what an old client could still send. |
| Docs and release | Repository docs (README, SECURITY.md, `relay/README.md`, CHANGELOG) | docs tests in `src/test` | Sentences are checked word for word by a test (pattern: `gateDocs.test.ts`). |

## Standard Stack

### Core (all already in the repository; no new package)
| Library | Version | Purpose | Why standard |
|---------|---------|---------|--------------|
| Yjs | 13.6.33 (exact, vendored) | Shared text, `UndoManager`, relative positions, `encodeStateAsUpdate`, `mergeUpdates` | Chosen by the owner (DESIGN 21.1); `scripts/entries/yjs.mjs` is `export * from 'yjs';`, so the bundle `vendor/yjs/yjs.cjs` exports `UndoManager`, `createRelativePositionFromTypeIndex`, `createAbsolutePositionFromRelativePosition`, `encodeRelativePosition`, `decodeRelativePosition` [VERIFIED: scripts/entries/yjs.mjs; node_modules/yjs/dist/src/index.d.ts:1] |
| lib0 | 0.2.119 (exact, vendored with Yjs) | Yjs's dependency, bundled | Pinned in `scripts/crdt-vendor.json` ("lib0 ... pinned to 0.2.119 as its own exact devDependency") |
| VS Code API | `@types/vscode` 1.101.0, engine `>=1.101.0` | Documents, `WorkspaceEdit`, decorations, status bar, webview | `TextDocumentChangeEvent.reason` can be `TextDocumentChangeReason.Undo = 1` or `Redo = 2` [VERIFIED: node_modules/@types/vscode/index.d.ts:13300-13328] |
| `node:crypto`, `node:https`, `node:tls`, `node:test` | Node 24.22.3 (extension and tests), 26.13.1 (hub) | Sealing presence, transport, tests | No framework, no new dependency (project rule for hub and relay) |

### Supporting (existing project modules to reuse, not libraries)
| Module | Purpose | When to use |
|--------|---------|-------------|
| `src/staff/replica/hubTransport.ts`, `hubSync.ts` | Hub I/O and one exchange | The only hub path (D-09). |
| `src/staff/replica/replicaProject.ts` | Open, fold, append | Every read and write of the shared project. |
| `src/domain/replica/hubWitness.ts` | Finding ids and sentences | Map to `attention`. |
| `src/services/setupSteps.ts` `registerSetupStep` | The step registry | "Share with people" (D-19). |
| `src/domain/org/terms.ts` `term()` | Mode words | Every member and lead word (D-27). |
| `src/test/helpers/replicaWorld.ts`, `replicaRosterWorld.ts`, `replicaFakeTransport.ts`, `fakeHubServer.ts`, `fakeDom.ts`, `vscodeStub.ts`; `hub/test/helpers/hubHarness.ts`, `hubWorld.ts`, `memoryReplica.ts`, `faultProxy.ts`, `sseReader.ts` | Test worlds | Scenarios, binding fuzz, page tests. |

### Alternatives considered
| Instead of | Could use | Tradeoff |
|------------|-----------|----------|
| Origin-tagged own binding | `y-codemirror.next` or `y-monaco` as dependencies | They target CodeMirror and Monaco editor objects, not a VS Code `TextDocument`; new dependency and bundle size; D-15 already says clean-room, pattern only. |
| Prefix and suffix trimmed single replace for "Take This Change as My Edit" | A diff package (`fast-diff`) | A package adds supply-chain surface; a common-prefix and suffix diff gives one correct replace operation (coarser attribution of a rewritten region). [ASSUMED sufficient] |
| Hub-side tests only | Extension-side only | Hub tests are fast and already in CI on Node 26 but cannot load Yjs or the store; extension tests cannot start the hub on Node 24 (F11). Use both. |

**Installation:** none. `npm run compile` runs `node scripts/vendor-libs.mjs && tsc -p tsconfig.json` and writes `vendor/yjs/yjs.cjs`, which the binding tests need.

**Version verification:** no package is added, so no `npm view` was run. The pinned versions were read from `scripts/crdt-vendor.json` (`"name": "yjs", "version": "13.6.33"`, `"name": "lib0", "version": "0.2.119"`) and `package.json` devDependencies (`"lib0": "0.2.119"`, `"yjs": "13.6.33"`).

## Package Legitimacy Audit

No external package is installed by this phase. Yjs and lib0 were added and hash-pinned in Phase 30 (`scripts/crdt-vendor.json`, with a build check in `scripts/vendor-libs.mjs`), and y-codemirror.next and y-monaco are read for their pattern only, never installed or copied.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none new) | n/a | n/a | n/a | n/a | n/a | Nothing to install |

**Packages removed due to [SLOP] verdict:** none. **Packages flagged [SUS]:** none. The `package-legitimacy` seam was not run because there is nothing to check.

## Architecture Patterns

### System architecture diagram

```
 person types in a product file (VS Code TextDocument, header read-only)
        | onDidChangeTextDocument (contentChanges, reason)
        v
 [src/services/staffEditorBinding.ts]  adapter: echo guard (expected-version queue), header revert, decorations, keybindings undo/redo
        | BoundDocument interface (getText, applyEdit, onChange)           ^ remote edits as WorkspaceEdit
        v                                                                  |
 [src/staff/replica/editorBinding.ts]  Y.Doc (local clientID from roster slot) + UndoManager(trackedOrigins = {localOrigin})
        | 500 ms batch: doc.client (once per session) + doc.update  --appendOwn-->  [ReplicaProject store, local first]
        |                                                                  ^ acceptedUpdates(product, after) from the fold
        v                                                                  |
 [src/staff/replica/liveReplicator.ts]  per project per device; state from syncMachine.ts (pure table)
        |-- HubTransport.events() SSE: heads -> coalesced syncOnce; join-request -> fetchJoinRequests; roster/checkpoint/equivocation -> refresh/attention
        |-- syncOnce(transport, syncLocalOf(project), hubMemoryOf(secrets))  push + pull + witness (blobsCitedBy via SyncLocal)
        |-- postPresence(cell, sealed) every 5 s (+ cursor changes, max 10/s)  <-- presence frames {cell, devices[{writer, sealed}], left[]}
        v   TLS 1.3, pinned, session bound to the connection
 [hub/ service (Node 26)]  append checks (+ needs-update, per-entry blob-missing, restoring), SSE, presence fan-out (access list only), checkpoints
        v
 other devices: same path in reverse -> fold -> editorBinding applies accepted updates -> WorkspaceEdit -> their editor
 Staff Room host <- replicator state + presence + fold (versions, contested, N changes since) -> staffRoomLive model -> page
 gateStatusBar <- one word of sync state
```

### Recommended project structure (new files; existing files get at most one-to-three-line hooks)

```
src/domain/replica/
  features.ts            # KNOWN_REPLICA_FEATURES, feature id check, update sentence (hub-side: add to HUB_SIDE in replicaBoundaries.test.ts)
  syncMachine.ts         # nine-state transition table, pure
  presence.ts            # sealPresence/openPresence (node:crypto), message schema
src/domain/staff/
  staffRoomLive.ts       # live model types and builders (presence, sync sentence, banner, contested cards, join cards)
src/staff/replica/
  liveReplicator.ts      # the replicator (no vscode, no Yjs)
  hubLive.ts             # typed event frames over HubTransport.events(), postPresence wrapper
  hubAddress.ts          # per project per device hub address store
  requireGate.ts         # needs-update stop used by ReplicaProject.foldNow (keeps replicaProject.ts under 1200)
  editorBinding.ts       # binding core over BoundDocument
  productFeed.ts         # acceptedUpdates(...) for the binding, compaction input
  compactor.ts           # doc.compact writer
  versionActs.ts         # shared propose/verdict/submit/decide/release/withdraw
  contested.ts           # contested and pending-confirmation read model
  liveProjection.ts      # writes product files from the fold when not bound (last-projected rule)
src/services/
  staffEditorBinding.ts  # VS Code adapter for the binding
  staffShare.ts          # Share with people step and commands, hub commands, language activation
  staffSyncStatus.ts     # one status store the status bar and Staff Room read
media/staffRoom/staffLive.js  # page code for the live parts (staffRoom.js is 1273 lines; do not grow it)
hub/src/restore.ts       # restore marker and mode
```

### Pattern 1: LiveReplicator exchange scheduling
**What:** The replicator never invents a second protocol. It runs `syncOnce` for catch-up and after local appends, and uses the event stream only as a wake-up. **When:** always. A `heads` frame for a stream or a local append schedules one exchange, coalesced (trailing 250 ms, at most one in flight, at least 1 s between exchanges while events keep arriving); `resync`, `gap`, `closed`, `stopped`, `malformed` or `failed` ends of the reader run one exchange and re-open the reader after `retryMs`.
**Why not `syncOnce` per frame without coalescing:** one exchange is `GET heads`, grant fetches, pulls, pushes and `POST checkpoint` [VERIFIED: hubSync.ts header 8-14]; DESIGN 10.4 targets under one second on a LAN, which one reused connection meets, but a typing burst must not queue exchanges.
```typescript
// Source: this repository, hubTransport.ts:203-217 (EventReader, EventReport) and hubSync.ts:187 (syncOnce)
const reader = await transport.events();           // own connection and session
for await (const report of reader) {
  if (report.kind === 'frame' && report.event === 'heads') schedule('heads');
  else if (report.kind === 'frame' && report.event === 'join-request') void fetchRequests();
  else if (report.kind === 'frame' && report.event === 'presence') presence.apply(report.data);   // {project, cell, devices, left}
  else if (report.kind !== 'frame') { await exchangeOnce(); break; }          // gap, resync, closed, stopped, malformed
}
```

### Pattern 2: Echo-free binding (origin tagging)
**What:** One stable local origin object per bound product. Local `contentChanges` become `Y.Text` operations inside `doc.transact(fn, localOrigin)`; the `Y.Text` observer ignores events whose `transaction.origin === localOrigin` (and `undoManager`, see Pitfall 3) and turns all others into a `WorkspaceEdit`. Source pattern: y-codemirror.next `y-sync.js` ("The observer on `this._ytext` checks `tr.origin !== this.conf`", editor changes applied "with `this.conf` as origin") [CITED: https://github.com/yjs/y-codemirror.next/blob/main/src/y-sync.js], y-monaco uses a lib0 mutex around remote application and `doc.transact(..., this)` for local edits [CITED: https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js]. Both MIT [CITED: raw LICENSE of each repository, first line "The MIT License (MIT)"].
**VS Code difference:** `onDidChangeTextDocument` for our own `workspace.applyEdit` fires asynchronously relative to the promise, so a boolean flag is not enough. Keep a queue of expected remote edits keyed by the text they should produce (or by `document.version` after apply) and treat an event as ours only when the resulting document text equals the expected text; on any mismatch run the resync of D-15 (replace the body from `Y.Text`) and log one line.

### Pattern 3: Undo that removes only your own edits
**What:** `new Y.UndoManager(ytext, { trackedOrigins: new Set([localOrigin]), captureTimeout: 500 })`; bound `undo`/`redo` keybindings call `undoManager.undo()` / `redo()`. The y-codemirror.next version adds the sync config as a tracked origin only so "only changes from the y-sync binding are recorded in the undo history", wires `Mod-z` to undo and restores the selection from stack-item `meta` using relative positions [CITED: https://github.com/yjs/y-codemirror.next/blob/main/src/y-undomanager.js].
**Keybinding:** `contributes.keybindings` with `when: "editorTextFocus && nearAi.staffBoundEditor"`; set the key with `vscode.commands.executeCommand('setContext', 'nearAi.staffBoundEditor', true)` [CITED: code.visualstudio.com/api/references/when-clause-contexts: "you can add your own context key with the `setContext` command"]. There is **no API to intercept the Edit menu's Undo**, which runs the built-in `undo`; the binding must still be correct if that happens (Pitfall 4).

### Pattern 4: Presence sealed under the cell key, advisory only
**What:** Per cell the device sends `POST presence {cell, sealed}` every 5 s and on cursor change (at most 10 per second). `sealed` is base64url of `epoch (4 bytes) || iv || tag || ciphertext` under a key derived with HKDF from the cell's epoch key with info `near-ai/presence/v1` and AAD `cell | epoch | writer`. Body at most `LIMITS.presenceBytes = 2 * KIB` for the whole JSON [VERIFIED: hub/src/limits.ts presenceBytes], so the sealed text stays under about 1.4 KB. Receivers open with the epoch key they hold; a frame they cannot open is dropped. **Content rule:** the base cell's presence carries only "online" and the position word, never a product name; a product's name and cursor travel only in that product's own cell, so a member below the cell never receives it (D-35). Presence is a convenience and is never evidence: the hub names the writer in the frame, and any holder of the cell key could seal as someone else, so nothing may be decided from it.

### Pattern 5: The fold-wide stop (POST-01)
**What:** `roster.require` folds in `foldRoster` (domain, hub-side) into `RosterState.required` (a sorted union). `requireGate.ts` exports `requireProblem(roster: RosterState): { missing: string[] } | undefined`, and `ReplicaProject.foldNow` calls it right after the roster fold and before `createFoldState`/`addEntries` (a two-line hook), throwing `ReplicaProjectError({ refused: 'needs-update', message: UPDATE_SENTENCE })`. `appendOwn`, `state()`, `syncLocalOf.roster()` and the host's `openShared` all go through `foldNow`, so one hook stops all of them. `heads()`, `entriesAfter()`, `blob()` read the store directly and keep working, so updating loses nothing. Add `'needs-update'` to `PROJECT_REFUSALS_HOST` (replicaProject.ts:66-74).

### Pattern 6: Shared write path with a hash check at write time
**What:** `versionActs.ts` re-reads the fold inside the write and refuses with "Someone else decided this version while you were deciding. Look again." when the version's current `decision.status`, `contested`/`effective` entry hashes or version hash differ from the ones the dialog showed. The dialog passes `{ product, hash, decisionStamp }` where `decisionStamp` is a hash of `DecisionSummary.contested + effective + pending` taken when the dialog opened. This is the only way to catch "another decision folded while it is open" because today's check compares only the version hash once before the modal (`staffCommands.ts:136-137`) and `host.decide` receives the same hash [VERIFIED: staffCommands.ts:136-153].

### Anti-patterns to avoid
- **A second transport or a second sync loop.** Only `HubTransport` and `syncOnce` (D-09).
- **Applying store bytes to the editor.** Only fold-accepted updates (F6).
- **Writing the projection over an edited file.** `writeProjections` refuses a body that differs from the fold (`PROJECTION_LEFT_REASONS['text-changed']`); the new projector compares with the text it last projected instead, as the comment at projection.ts:650-651 says Phase 33 must.
- **Growing frozen or near-limit files.** `staffHost.ts`, `store.ts`, `replicaProject.ts`, `hubTransport.ts` (F10).
- **Putting product names in base-cell presence** (leak).
- **Treating presence or cursors as authority.**
- **Loading `src/staff/replica` for a project that is not shared.** `staffMultiUserManifest.test.ts` line 77 proves no module under `src/staff/replica` loads with the setting off; keep every new import dynamic and behind "is this project shared".

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Undo of only my edits | A custom inverse-operation log | `Y.UndoManager` with `trackedOrigins` | Handles concurrent remote edits, selection restore, redo. |
| Cursor positions that survive remote edits | Offsets in presence messages | `Y.createRelativePositionFromTypeIndex` / `createAbsolutePositionFromRelativePosition`, `encodeRelativePosition` | Offsets shift under concurrent edits; relative positions do not. |
| Echo suppression | A text-equality "did it change" heuristic only | Origin objects plus an expected-edit queue | The y-codemirror and y-monaco pattern; text equality alone races with fast typing. |
| A second sync protocol | New push and pull code | `syncOnce`, `appendBatches`, `pushPlan` | They carry the witness, hand-back, blob and held-back logic. |
| Hub address and pin parsing | Regexes | `parseHubAddress`, `isHubAddress`, `checkTrust` pin rules | Already exported and tested. |
| Sealing presence | A new cipher construction | `node:crypto` AES-256-GCM with HKDF-SHA-256 as `cellKeys.ts` and `entry.ts` do (`sealLabel`/`openLabel`, `sealBody`) | Reuse the exact primitives and the 12-byte IV and 16-byte tag layout (`SEALED_OVERHEAD = IV_BYTES + TAG_BYTES`). |
| Twelve fingerprint words for a server pin | A new word encoding | `safetyWords.ts` (BIP-39 list) and the Phase 41 D-12 pattern | One word list, one reading-aloud convention. |
| Mode words | String literals | `term(concept, mode)` | The copy lint's `mode-word` rule counts any literal. |
| Status and setup entry points | A new status bar item or setup command | `createGateStatusBar` (one item) and `registerSetupStep` | EXPERIENCE 1 and 5; the coherence review removed the separate sync item. |
| Decision UI for a version | A second approval dialog | `decideCommand` in `staffCommands.ts` (`askPerson`, modal, hash check) with shared-mode branch | Person-only decision commands are a safety boundary (`PERSON_DECISION_COMMANDS`). |
| Text diff for outside changes | A diff library | Common prefix and suffix trimming, one replace | No dependency; correct, if coarse. |

**Key insight:** every hard part (merge, undo, attribution, ordering, encryption, witness) already exists as a tested module. The work is wiring, three missing producers (shared version acts, compactor, update feed), and keeping all of it out of the big frozen files.

# Detailed code facts for the planner

Everything in sections 1 to 5 was read from the worktree this session. Values are quoted verbatim; a value not quoted here must be re-read by the executor (D-01).

## 1. Client side: `src/staff/replica` and `src/domain/replica`

### 1.1 `HubTransport` (hubTransport.ts, 1104 lines)

- **Options.** `address` (host:port or [IPv6]:port), `project`, `hub` (the hub's writer id, 64 hex), `trust: { pin: string } | { ca: string }`, `signer: PayloadSigner`, `servername?`, `now?`, `connectTimeoutMs?`, `responseMaxBytes?`, `blobsCitedBy?` [VERIFIED: hubTransport.ts:100-119]. `parseHubAddress` throws `'The hub address is not host:port.'` [VERIFIED: hubTransport.ts:229-235].
- **Constants.** `CONNECT_TIMEOUT_MS = 10_000` ("DESIGN 15.3: offline after 10 seconds"), `APPEND_MAX_ENTRIES = 200`, `APPEND_MAX_GRANTS = 64`, `APPEND_MAX_BYTES = 3 * MIB`, `CHECKPOINTS_PER_ASK = 16` [VERIFIED: hubTransport.ts:50-62].
- **Failure ids** (`HUB_TRANSPORT_FAILURES`): `unreachable`, `pin-mismatch`, `ca-refused`, `wrong-hub`, `session-refused`, `rate-limited`, `too-large`, `wrong-project`, `malformed`, `hub-error` [VERIFIED: hubTransport.ts:66-77]. `HubTransportError.detail` carries `reason`, `status`, `retryAfterSeconds`, `label`.
- **Events.** `HUB_EVENT_NAMES = ['heads', 'presence', 'checkpoint', 'roster', 'equivocation', 'join-request', 'resync']`; `EventReport` is `{ kind: 'frame'; event; id; data } | { kind: 'gap'; expected; got } | { kind: 'stopped' } | { kind: 'resync' } | { kind: 'closed' } | { kind: 'wrong-project'; event } | { kind: 'malformed' }`; `SubscriptionEnd = 'resync' | 'gap' | 'stopped' | 'closed' | 'malformed' | 'failed'` [VERIFIED: hubTransport.ts:195-211]. `EventReader` has `retryMs` and `close()`. A 204 means stop; Last-Event-ID is never sent; frame ids are a per-connection counter (header comment 27-28).
- **Methods** (all public): `heads`, `pull`, `push`, `subscribe`, `hubHeads`, `entries`, `append`, `putBlob`, `getBlob`, `grant`, `askCheckpoint`, `enrol`, `registerInvite`, `postJoin`, `joinRequests`, `events`, `close`. **There is no presence POST.** `append` retries once after a 409 `blob-missing` by putting every blob of the batch it holds (hubTransport.ts:601-620, the 409 branch starts at 608).
- **Errors from new hub refusals.** `answerJson` turns every status it does not expect into `hubError(status, error ?? reason)`, i.e. `HubTransportError('hub-error', { status, reason })` with `reason` the hub's error id when it matches `/^[a-z][a-z0-9-]{0,63}$/` [VERIFIED: hubTransport.ts answerJson/hubError]. So a hub answer `needs-update` or `restoring` reaches the replicator as `hub-error` with that reason, and `syncOnce` maps `hub-error` to `attention` (next section).

### 1.2 `syncOnce` (hubSync.ts, 509 lines)

- **Outcomes.** `export type SyncOutcome = 'synced' | 'offline' | 'refused' | 'attention';` [VERIFIED: hubSync.ts:104]. `SyncReport` fields: `outcome`, `pulled`, `pushed`, `blobs`, `grants`, `findings`, `repushed`, `handedBack`, `notStored`, `refusedByHub`, `heldBack`, `reason?`, `message?`, `retryAfterSeconds?` [VERIFIED: hubSync.ts:106-137].
- **Mapping of transport failures** (`OUTCOME_OF`): `unreachable` and `rate-limited` give `offline`; `pin-mismatch`, `ca-refused`, `wrong-hub`, `wrong-project`, `too-large`, `malformed`, `hub-error` give `attention`; `session-refused` gives `refused` [VERIFIED: hubSync.ts:153-166]. After the exchange, a `synced` outcome becomes `attention` when a finding is in `new Set(['rolled-back', 'forked-view', 'wrong-project'])` [VERIFIED: hubSync.ts:145]. `RETRY_REFUSALS = new Set(['not-admitted', 'unknown-stream', 'not-on-access-list', 'seq-gap', 'prev-mismatch'])` are push refusals that are retried within the exchange (`PUSH_PASSES = 3`) [VERIFIED: hubSync.ts:148, 151]. Plan consequence: `restoring` must become `offline` with `reason: 'restoring'` (D-32) and `needs-update` must become the `needs-update` state, and per-entry `blob-missing` (D-28) must be added to `RETRY_REFUSALS`; all three are small edits in hubSync.ts (509 lines, safe).
- **Witness memory.** `HUB_WITNESS_SECRET_PREFIX = 'nearAi.staff.hubWitness.'`; `hubMemoryOf(secrets)` stores the witness state per hub and project in `SecretStorage`; a saved state that does not read back starts fresh [VERIFIED: hubSync.ts:79-102].
- **`SyncLocal`** is what the replicator passes: `project`, `writer`, `roster()`, `heads()`, `head()`, `holds()`, `entriesAfter()`, `blob()`, `wantedBlobs()`, `blobsCitedBy()`, `grants()`, `ingest()`, `putGrants()`, `checkpoints()`, `putCheckpoint()`, optional `covered()` and `missingDeps()`. `syncLocalOf(project)` builds it (replicaProject.ts:1142-1173) and `ingest` returns `{ added, notStored }` where a refusal by the store throws `ReplicaProjectError`.
- **Pulling is all-or-from-zero.** `pullWriter` asks `transport.entries(stream, writer, head === undefined ? 0 : head.seq + 1)` page by page; there is no "start from a checkpoint base" option (F5).

### 1.3 Witness findings (hubWitness.ts) and the state mapping

`HUB_FINDINGS` (ids and sentences, verbatim) [VERIFIED: hubWitness.ts:23-32]:
- `withheld`: "The hub has not delivered N changes that other people's work refers to."
- `delayed`: "The hub has not confirmed your changes for N minutes."
- `rolled-back`: "The hub showed an older copy of this project than this computer has already seen."
- `forked-view`: "The hub showed two different versions of this project, so this computer no longer trusts its checkpoints."
- `injected`: "The hub sent a change that is not validly signed by anyone in this project, and it was refused."
- `corrupt-blob`: "The hub sent an attachment that does not match its fingerprint, and it was refused."
- `wrong-project`: "The hub answered with data from another project, and it was refused."
- `replayed`: "The hub sent changes this computer already had, so nothing changed."

These sentences contain the word "hub" and are shown on main screens by the replicator unless wrapped: the copy lint will flag the new use of a glossary word if the replicator copies them into user copy (they are in `src/domain/replica/hubWitness.ts`, already counted in the baseline). Show them through a new function that maps each id to a sentence saying "your organization's server" (the glossary's user word, GLOSSARY section 3), keeping the originals for logs and tests.

Recommended state mapping (D-13 refined; `reorder` has no finding because a reordered answer "changes nothing", SECURITY.md): `attention` for `rolled-back`, `forked-view`, `wrong-project` (syncOnce already does this), `injected`, `corrupt-blob` and `withheld` (the replicator escalates them; `syncOnce` leaves outcome `synced` for these three); `delayed` and `replayed` keep `live` with a detail line; transport `pin-mismatch`, `ca-refused`, `wrong-hub`, `too-large`, `malformed` and non-special `hub-error` are `attention` as `syncOnce` reports. `distrusted` is permanent today (F4).

### 1.4 `ReplicaProject` (replicaProject.ts, 1173 lines)

- **Public API:** `localDevice(deps)`, `open(root, deps)`, `createSharedProject`, `pinAnchor`, `startHistoryAgain`, `joinFromWelcome`, getters `projectId`, `deviceWriter`, `signer`, `refolds`, `context()`, `state()`, `appendOwn(kind, data, options)`, `findOwn`, `findOwnAll`, `heldCells`, `putGrants`, `ingestWelcome`, `ingestForeign`, `heldForCheck`, `welcomeFor`, `heads`, `head`, `holds`, `entriesAfter`, `blob`, `wantedBlobs`, `blobsCitedBy`, `missingDeps`, `signedGrants`, `putCheckpoint`, `checkpoints`, `hubCells`, `close` [VERIFIED: grep of `public` in replicaProject.ts].
- **One serialised queue.** `state()` and `appendOwn()` run through `this.exclusive(...)`; `appendOwn` "builds, signs and appends one entry ... A roster kind gets rosterPrev equal to the cited roster when its data has none ... when another window of this install wrote first, it is built again on the new head" (up to 5 attempts) [VERIFIED: replicaProject.ts:~497-520]. So `roster.require` data need not carry `rosterPrev`.
- **Fold flow.** `foldNow()`: store refresh, grants, blobs, recheck, then the roster fold (`foldRosterAndKeys`) only when the roster key changed, then the context, then `addEntries` for fresh entries, then `recordRosterHead` [VERIFIED: replicaProject.ts:903-943]. This is the single place for the POST-01 stop (Pattern 5).
- **Refusals** (`PROJECT_REFUSALS_HOST`): `pin-mismatch`, `not-shared`, `store-refused`, `no-key`, `pin-damaged`, `already-shared`, `welcome-refused` [VERIFIED: replicaProject.ts:66-74]. Add `needs-update`.
- **Deps.** `ReplicaProjectDeps { secrets, globalStorageDir, identityDir?, now?, keyStatus?, cellOrder?, decodeHost? }` [VERIFIED: replicaProject.ts:120-133]. The genesis pin lives at `<globalStorage>/staff-replica/<project>/genesis.json` (`GENESIS_PIN_FOLDER = 'staff-replica'`, `GENESIS_PIN_FILE = 'genesis.json'`); the hub address file goes beside it (F12).
- **What a binding cannot get today:** the Y.Doc and update bytes (F6), the product's current client-id usage, and the refreshed set of accepted update hashes between folds without a full `state()`.

### 1.5 Start Again, `MigrationResult.withheld`, single copy

- **IN-02 location.** `rollForwardSteps` branch "store gone, temporary gone": `const source = new ReplicaStore(...); await source.catchUp(); await ReplicaStore.buildFrom(source, temporary); await syncFolder(temporary); temp = 'folder';` then `await rename(temporary, dir)` [VERIFIED: store.ts:838-847]. The unchecked move-in is the single `if (store === 'none' && temp === 'folder') { await rename(temporary, dir); await syncFolder(staff); ... }` at lines 845-847: it moves in whatever folder is there, whether this run built it or an earlier, interrupted run left it half built. The intent already records the counts: `INTENT_KEYS = ['blobs', 'carried', 'grants', 'setAside', 'source', 'temporary', 'v', 'writer']` and `buildFrom` returns `{ carried, grants, blobs }` [VERIFIED: store.ts:421, 733-762]. Fix shape: a new file `startAgainCheck.ts` exports `countFolder(temporary)` (lines in `streams/*/<writer>.jsonl` of this device's own writer, grant files, blob files) and the mismatch rule; the single call site in `rollForwardSteps` replaces the unchecked rename, net zero lines in `store.ts` (frozen at 1673). Disaster test: the existing crash probe `startAgainProbe?.('intent-written')` and `src/test/helpers/startAgainCrashChild.ts` show the pattern.
- **`MigrationResult.withheld`** is `WithheldProduct[]` with `{ product, cell, lines, reason: 'names-above-cell' }`; `unversioned` is `UnversionedProduct[]` with `reason: 'pin-above-cell'` [VERIFIED: migrate.ts:400-421]. `makeMultiUserCommand` shows only the ledger count and ignores both: `tell(`This staff project is now multi-user, and you are its staff lead. ${count === 1 ? 'One ledger was' : ...} brought into the shared record ...`)` [VERIFIED: staffMultiUserCommands.ts:437-438]. D-31 text: "Ask someone cleared for {label} to make a single-machine copy and share it again". The label word for a cell comes from `MigrationCell.label` ("as people read it").
- **Reconstruct uses client ids by product index.** `clientIdOf(slot, counters.get(name))` with `counters` the sorted product index [VERIFIED: migrate.ts:733, `const clientId = clientIdOf(slot, counters.get(name) as number);`]. The binding must never reuse a counter already registered: take the next free id from the fold's `registrations` with `nextClientId(slot, used)` / `ClientIdAllocator`.

### 1.6 Kinds, roster fold and where `roster.require` goes

- **Roster kinds today (18):** `member.invite`, `member.admit`, `member.update`, `member.remove`, `device.add`, `device.rotate`, `device.revoke`, `device.quarantine`, `device.release`, `hub.admit`, `hub.grant`, `hub.revoke`, `cell.create`, `cell.rekey`, `lead.handover`, `roster.choose`, `deputy.name`, `invite.void` [VERIFIED: kinds.ts:24 (`roster: ['member.invite', 'member.admit', 'member.update', 'member.remove', ...`)]; `REPLICA_KINDS` is 51 [VERIFIED: kinds.ts comment "51 kinds"; replicaTracer.test.ts:142-144 `assert.equal(REPLICA_KINDS.length, 51);`].
- **Tests that count them and must change with the new kind:** `replicaTracer.test.ts:142-144` (51 to 52), `replicaProductCells.test.ts:256-257` (`the closed list stays at 51`), `replicaRosterTracer.test.ts:232-235` (`rosterKinds.length, 18` and `ROSTER_KIND_OWNER` keys equal roster kinds plus `project.genesis`). If `hub.readmit` is added too, the numbers are 53 and 20.
- **Schema.** Every roster shape requires `rosterPrev: hashCheck`; shapes are in `SHAPES` in `kindSchemas/roster.ts` and use the `Shape { required, optional, atLeastOneOf }` form with `listOf`, `oneOf`, `lineCheck` helpers from `kindSchemas/project.ts` [VERIFIED: kindSchemas/roster.ts:97-117 (`const SHAPES`), project.ts:112-135]. Add `'roster.require': { required: { features: featuresProblem, rosterPrev: hashCheck } }` with `featuresProblem` checking 1 to 16 distinct ids against the `name@N` pattern (recommended `/^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/` [ASSUMED]; Phase 41 D-50 says "feature ids are `name@N`" and the pattern lives in the gate bundle code: reuse its checker if it is importable from a hub-side file, otherwise keep this local one).
- **Fold.** `ROSTER_KIND_OWNER` routes each kind to `'members' | 'cells' | 'roster'`; `roster.require` is owner `'roster'`; `applyOne` has branches for `deputy.name` and `lead.handover` and ends `return { status: 'refused', reason: 'roster-kind-pending' }` for anything else, so the new kind needs its own branch (`applyRequire`: signer must be the lead or the deputy at the cited roster; the union grows; an empty or duplicate-only entry applies as a no-op) [VERIFIED: roster.ts:46-70, 296-310; the driver's `isRouted` at 312]. `RosterState` gets `required: Set<string>` (or a sorted array plus `from` positions for `requireAt(position)`); `createRosterState` initialises it.
- **Authority check already in place:** the driver refuses an entry from a device that is not a roster writer at the head (`isRosterWriterAt`) before `applyOne`, and refuses an agent actor with `person-only` [VERIFIED: roster.ts:155-161 (`isRosterWriterAt`), 368 (`settledRefusal`, which returns `'person-only'` for an agent actor), 380 (`if (isRosterWriterAt(state, entry.header.writer, headPosition)) candidates.push(entry);`)].
- **How an older client treats it.** `verifyEntry` marks an unknown kind `keep = 'newer-version'` ("Made by a newer version of the extension. It is kept and passed on and changes nothing here.") [VERIFIED: verify.ts:135, 40], and `foldRoster` skips such entries: `if (entry.keep === 'newer-version' || !isRouted(entry.body.kind)) continue;` [VERIFIED: roster.ts:367]. A later roster entry that cites the skipped `roster.require` as its `rosterPrev` never reaches the head on that client (`roster-prev-not-applied` hold) and an entry citing it as `body.roster` waits `missing-roster`. So a 0.4.35 client stalls at the roster change by construction; the hub's session announcement (D-07) stops it from writing with an older roster. State this in SECURITY.md (it is the honest reason the check works).

### 1.7 Where the fold-wide stop hooks

`requireProblem(rosterState)` in `requireGate.ts` (new, imports `features.ts`) is called in `foldNow` after `this.rosterState` is current and before `const entries = this.store.entries()`; it throws `ReplicaProjectError` with `{ refused: 'needs-update', message: UPDATE_SENTENCE }` where `UPDATE_SENTENCE = 'This project needs a newer version of the extension. Update to keep working on it.'` (portfolio DESIGN 3.9 exact words). `StaffHost.openShared` already turns a refused project into `{ problem }` and the Staff Room shows it; add the sentence to `SHARED_PROJECT_UNAVAILABLE`-style handling so the room says it instead of "cannot be opened". The hub side is in 2.1.

### 1.8 Editor-facing domain code (doc.ts, clientIds.ts, textFold.ts, attribution.ts)

- **`doc.ts` is the only file that may load Yjs** (`replicaBoundaries.test.ts`: `ref.specifier === 'yjs'` only in doc.ts and only `import type`; `VENDOR_FORM` forbids naming `vendor/yjs` elsewhere) [VERIFIED: replicaBoundaries.test.ts:75-100]. Its surface today: `createFoldDoc` (gc off, clientID 0), `applyUpdate` (256 KiB), `applyState`, `applyRemote` (state limit), `createLocalDoc(clientId)`, `localInsert`, `localDelete`, `docText`, `textHashOf`, `stateVectorOf`, `encodeDiff`, `encodeFullState`, `buildFromCompaction`, `snapshotOf`, `attributionRuns`, `inspectUpdate`, `inspectState`, `cloneDoc`, `pendingState`. **Missing for the binding:** a stable local origin and update capture that includes the `UndoManager`'s origin, a text observer, `UndoManager` construction, relative position encode and decode, `transact` with an origin. Add them to doc.ts (397 lines, room to grow) as a small plain-data surface (bytes, numbers, strings), as the file's header demands. Note `localUpdate` makes a fresh `{ local: true }` origin per call, which is unsuitable for an `UndoManager` (it needs one stable tracked origin).
- **Client ids.** `clientIdOf(slot, counter)` = `slot * 2^20 + counter`, slots 1 to 4095, counters 0 to 2^20 - 1; `slotOfClientId`, `nextClientId(slot, used)`, `ClientIdAllocator(used)` [VERIFIED: clientIds.ts:11-77]. The fold refuses an id not owned by the entry's writer (`foreign-client-id`), a registration whose actor differs from the entry's (`actor-mismatch`), a collision (`client-collision`), and more than `MAX_REGISTRATIONS_PER_WRITER_PRODUCT = 4096` ids per writer per product [VERIFIED: textFold.ts:100-102 (`COMPACTION_WINDOW = 50`, `MAX_REGISTRATIONS_PER_WRITER_PRODUCT = 4096`), 164-195 (`applyClient`)].
- **Registration then updates.** `doc.client { product, clientId, actor }` first, then `doc.update { product, update }` (base64url bytes, at most `MAX_UPDATE_BYTES = 256 * 1024`) [VERIFIED: kindSchemas/doc.ts:10, 54-65]. An update under an unregistered id is held `unregistered-client`; the clock rule requires a client's first struct to start at the next expected clock (`clock-overlap` below it, a recorded gap above it) [VERIFIED: textFold.ts:applyUpdateEntry]. **Consequence: use a fresh client id per editor session per product** (a crash between sending an update and recording it would otherwise risk reusing clocks), at most 4096 per writer per product.
- **Attribution.** `ProductTextOutput.attribution: AuthorSpan[]` with `{ start, length, clientId, writer, member, actor: 'person' | 'agent', agentMember?, run?, unverified? }`; `summariseAuthors` totals per writer, actor, agent member and run [VERIFIED: attribution.ts:15-44, 101-117]. Show Who Wrote This reads it; the roster gives `memberName(member, rosterHash)` for the name and `term()` the position word. Spans flagged `unverified` (text only an unverifiable compaction holds) must be shown as "not verified".

### 1.9 Versions, decisions, projection

- **Version kinds and exact data** are in section 4.1 (read from `kindSchemas/versions.ts`).
- **Fold output per product:** `ProductVersions { stream, product, section, title, roles, versions: VersionView[], records, refusals, working: 'open' | 'withdrawn' }`; `VersionView` has `number, hash, entry, state, held?, decisionFor?, proposedAtSameTimeAs, changesSince, othersChangesSince, ownerPromptDue, pins, header, verdictConflict?, submitConflict?, overlay?: 'contested' | 'pending-confirmation', decision: DecisionSummary, attribution, sourceChanged` [VERIFIED: versions.ts:134-160]. `OWNER_PROMPT_THRESHOLD = 20` [VERIFIED: versions.ts:40]; `MAX_ACTS_PER_WRITER_VERSION = 32`, `MAX_PROPOSALS_PER_WRITER_PRODUCT = 200` bound what a UI may write.
- **Refusals the UI must word:** the keys of `VERSION_REFUSALS` (`not-owner`, `not-authorised`, `wrong-state`, `stale-version`, `not-decision-holder`, `no-approval`, `no-release`, `not-gate-member`, `text-not-in-document`, `hash-mismatch` and the rest) [VERIFIED: versions.ts:50-72].
- **Projection to files** is read-only today except at conversion time (`writeProjections` called from `migrate.ts:919` and `singleCopy.ts:605`); a live product file writer does not exist (F6 row, Pattern anti-list). `foldTexts(fold)` gives `texts` and `incomplete`; an incomplete product must never be written (`PROJECTION_LEFT_REASONS['text-incomplete']`).

## 2. Hub side (`hub/`, Node 26.13.1, esbuild, `node:test`)

### 2.1 Append checks and the roster cache

- `checkBatch` runs per batch: shape, the device's token bucket (`takeWriter`), `unknown-project`, then for each declared `blobRef` `if (store.blobInfo(project, ref.blob) === undefined) return refuseBatch('blob-missing')` [VERIFIED: checks.ts:218-222], then per entry: header, body, stream, writer admitted and signature, standing (`revoked`, `quarantined`, `not-admitted`), access list, place, `seq-gap`, `prev-mismatch`, and for base-stream entries `readBase(...)`, where `!read.ok && read.why === 'missing-blob'` also returns `refuseBatch('blob-missing')` [VERIFIED: checks.ts:369-370]. **WR-07 hub side** (D-28): turn both into per-entry refusals `refuse('blob-missing', hash)` with the entry skipped, mark the writer's later entries in the batch as `seq-gap` (already retryable, hubSync.ts `RETRY_REFUSALS`), and change the client's `HubTransport.append` 409 handler: after a 200 whose `refused` list holds `blob-missing`, put the blobs of those entries and resend only them (the 409 path then disappears or stays for old hubs). `APPEND_REFUSALS` is a closed object (checks.ts:34-58) and `APPEND_STATUS` maps ids to statuses (routes.ts:179-185); `needs-update` and `restoring` are batch refusals and need statuses (recommend 403 and 503 with `retry-after`).
- **Where `roster.require` folds.** `ProjectRoster` in `hub/src/append/rosterCache.ts` wraps `RosterState` as `.state` (join.ts reads `roster.state.members`); once `RosterState.required` exists, `checkBatch` reads `base.state.required` and refuses with `needs-update` when `missingFeatures(required)` is non-empty. The batch's own overlay may add a `roster.require`; a later batch sees it.
- The checks must not call a refusal a fault the hub cannot prove (CR-01 rule, checks.ts header 15-22): a hub lacking a feature refuses the **batch** (the client's data is fine and it will retry after the operator updates the hub), it does not mark any entry bad.

### 2.2 Session and the feature announcement (D-07)

- The session answer is a signed payload with the **closed** key set `SESSION_KEYS = ['v', 'hub', 'project', 'challenge', 'keying']` and `SESSION_VERSION = 1` [VERIFIED: hubFile.ts:222-225, 267-273]; `sessionPayloadOf` returns undefined for any other key set. Add `features` (sorted, at most 16 `name@N` ids) to the signed payload (keys become `[..., 'keying', 'features']`, `SESSION_VERSION` 2), so the announcement is signed and bound to the connection. A missing field reads as an empty announcement. The hub checks `required ⊆ announced ∩ KNOWN` at `answer()` in `SessionRegistry` and refuses with `session-refused` reason `needs-update` (a new `SESSION_REFUSALS` entry whose sentence is the update sentence). `session-refused` is `refused` in `syncOnce`; the replicator must read `error.reason === 'needs-update'` and show the `needs-update` state, not "ask the staff lead". The hub and its client are unreleased (F-intro), so changing the payload version has no compatibility cost; keep the old shape readable only if a Phase 32 build is in the field (it is not).
- Tokens: 15 minutes, 8 per device per project, 10,000 in all; the client re-opens a session when a token is refused (`MENDABLE`). The auth deadline is 10 seconds per connection [VERIFIED: session.ts:30-34].

### 2.3 Join requests (IN-06, D-30)

- `Joins.join()` stores with `this.store.putJoinRequest({ project, requestHash, invite, body, receivedAt })` then `acceptJoinRequest` and publishes `join-request` `{ project, invite }` to `current.isRosterWriter(device)` devices only [VERIFIED: join.ts:217-224]. Requests are kept 7 days (`JOIN_REQUEST_KEEP_MS`). The refusal table is `JOIN_REFUSALS` with `STATUS` map [VERIFIED: join.ts:45-83].
- **Add** `'invite-full'` ("This invitation has too many people waiting. Ask the staff lead for a new one.", status 429 or 403) checked after `invite-locked` and before `readHubJoin`: count `store.joinRequests(project)` accepted within the 7 days, at most 8 for the invite, 64 for the project, with both numbers in `LIMITS` (`hub/src/limits.ts`, a frozen table where "Sizes in one frozen table"). A repeat of the very same request is `held`, not new, so count distinct request hashes only. Client side: `HUB_JOIN_REFUSAL['invite-full'] -> 'hub-invite-full'` and a new `HUB_MEMBERSHIP_REFUSALS` entry (hubMembership.ts:483-489). Tests: `hub/test/join.test.ts` pattern.

### 2.4 Live events, presence, limits

- `EVENT_NAMES = ['heads', 'presence', 'checkpoint', 'roster', 'equivocation', 'join-request', 'resync']` [VERIFIED: hub/src/live/events.ts:24]. `heads` frames go to every device on the stream's access list **except the pusher** (`writer !== pusher && access.includes(writer)`) with `{ project, stream, heads }` [VERIFIED: routes.ts:369]; `roster` goes to admitted devices with `{ project, head }` (routes.ts:351); `equivocation` goes to the access list and the roster writers (routes.ts:375).
- Presence: `PRESENCE_TIMING = { ttlMs: 30_000, coalesceMs: 250, sweepMs: 1000 }`, memory only, fan-out to the access list "each without its own entry" [VERIFIED: presence.ts:15-24, 142-155]. The POST needs an admitted device on the **cell's** access list (403 otherwise) and takes one token from the same `writerPerSecond: 50` / `writerBurst: 200` bucket appends use [VERIFIED: limits.ts, routes.ts:433, 439]. At 10 cursor posts per second a device spends 20 percent of its append budget; keep the 5-second heartbeat and the 10 per second ceiling, and coalesce cursor posts on the client.
- Event streams: 4 per device and 300 per address (`eventStreamsPerDevice`, `eventStreamsPerAddress`). One replicator holds one stream; two windows of one install hold two, which fits.

### 2.5 Checkpoints, restore, `restoring`

- Restore today is procedure plus detection: members hand back checkpoints, the hub holds "waiting" until it has every change they cover (`checkpoint.waiting`), then signs (relay/README.md 296-345; hub/test/restoreDrill.test.ts uses in-process hub instances on one state folder and its backup; `keptHub` and `HubInstance` in `faultProxy.ts`). The marker for D-32 does not exist; `hub/src/stateDir.ts` (182 lines) and `startup.ts` own the state directory. F9 gives the rule to settle. `relay/README.md` step 3's `docker run ... node -e` script gains one line that writes the marker file; step 5 gains "the hub leaves restore mode by itself".
- Limit 1 (an honest restore can look like a fork) and limit 2 (a checkpoint nobody received) are described in SECURITY.md under "Your organization's sync hub" (lines ~2324-2336) and relay/README.md (306-329). After D-32, limit 1 text becomes "restore mode refuses new changes until members have synced"; limit 2 stays verbatim.

### 2.6 How hub tests run and what exists to reuse

- `cd hub && npm test` = `node scripts/check-node.mjs && node scripts/build.mjs && node ../scripts/run-tests.mjs dist/test/*.test.js` [VERIFIED: hub/package.json scripts]; `hub/scripts/build.mjs` bundles `src/bin.ts`, `src/main.ts` and every `test/**/*.test.ts` with esbuild, `target: 'node26'`, `packages: 'external'`. Engines `>=26.13.1 <27`; no runtime dependency (workspace test checks it).
- Reusable: `startHub`/`withHub` (hubHarness.ts:104, 219), `createHubWorld` (hubWorld.ts), `memoryReplica(world, device)` (a `SyncLocal`), `MemorySecrets`, `keptHub()`/`wrapHub()` fault proxy with routes `session|enrol|heads|append|entries|events|presence|checkpoint|blob-get|blob-put|other` [VERIFIED: faultProxy.ts:25], `EventClient` (sseReader.ts), `startHubProcess` (hubProcess.ts, the built `dist/bin.mjs` as a child with four secret files at mode 0600, `HUB_PORT=0`, waits for `hub.listening`), and the byte capture `captureServer(server)` with `wireOf(capture)` and the canary search (`canaryForms`: UTF-8, UTF-16LE, hex, base64, base64url at three offsets) in `ciphertextOnly.test.ts`.
- The extension-side fake hub is `src/test/helpers/fakeHubServer.ts` (scripted answers, TLS 1.3, the real session protocol) used by `staffHubTransport.test.ts`.

## 3. Editor side

### 3.1 How products are projected today

Product files live at `staffProductPath(section, product)` under `.planning/staff/**`; a file is `projectProductFile(state, body)` = `renderProductHeader(projectHeader(state))` followed by the body, joined with nothing between; `splitProductFile(text)` returns `{ header, body }` [VERIFIED: projection.ts:548-551, 638-640]. The fold's `foldTexts` gives the live text. In a shared project the file is a projection (DESIGN 5.4). The header changes when a version's state changes (an approval rewrites the header), so a bound document's header region can change under a person who is typing in the body: apply a header change as one atomic edit of the header range only, and keep the offset mapping `bodyIndex = documentOffset - header.length`.

### 3.2 VS Code API facts (1.101)

- `TextDocumentChangeEvent` has `document`, `contentChanges`, `reason` (`Undo = 1`, `Redo = 2`, or undefined) [VERIFIED: index.d.ts:13300-13328]. Use `reason` to see VS Code's own undo and redo of a bound document and handle them (Pitfall 4).
- Remote cursors and selections: `window.createTextEditorDecorationType(DecorationRenderOptions)` and `editor.setDecorations(type, DecorationOptions[])`, with per-range `hoverMessage` and `renderOptions`, `isWholeLine`, `rangeBehavior`, and `after`/`before` attachments for the name label [VERIFIED: index.d.ts:1180-1235 (`isWholeLine`, `rangeBehavior`, `hoverMessage`, `renderOptions`), 11211 (`createTextEditorDecorationType`), 808 (`DecorationRangeBehavior`)]. Colours must be theme tokens (`ThemeColor`, for example `charts.*`), never fixed hex, and colour is never the only carrier: add the name in the hover and a **Show Who Wrote This** list (a quick pick of `summariseAuthors`) as the accessible text.
- Applying remote edits: `workspace.applyEdit(WorkspaceEdit)` returns `Thenable<boolean>` [VERIFIED: index.d.ts:13993]; it lands on the document's undo stack, which is why a bound editor must route undo through Yjs (Pattern 3) and treat VS Code's own undo as a local edit.
- Intercepting undo: no API; a `contributes.keybindings` entry with a `when` context is the supported way. **There are no `keybindings` in package.json today** (the contribution keys are `commands, viewsContainers, views, chatParticipants, configuration, menus`) [VERIFIED: package.json inspected with node].
- Activation by file: `contributes.languages` generates the activation (1.74 and later) [CITED: code.visualstudio.com/api/references/activation-events].

### 3.3 The binding pattern in the sources (read this session)

- y-codemirror.next `y-sync.js` [CITED: https://github.com/yjs/y-codemirror.next/blob/main/src/y-sync.js]: the sync config object is the transaction origin; the Y.Text observer ignores `tr.origin === this.conf` and turns other events' deltas into editor changes; editor updates carrying the sync annotation are skipped; a mismatch `fix` is reflected back on a later tick.
- y-codemirror.next `y-undomanager.js` [CITED: .../src/y-undomanager.js]: `addTrackedOrigin(syncConf)`, `undo()` and `redo()` return booleans, selection stored as a relative range in stack-item `meta` and restored on `stack-item-popped`.
- y-monaco `y-monaco.js` [CITED: https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js]: a lib0 mutex for echo, local edits applied right to left (largest `rangeOffset` first) as delete then insert, remote deltas applied one operation at a time with a running index, selections recorded as relative positions before every transaction and restored after, remote cursors as decorations re-rendered on awareness change and after each remote update.
- Licence: MIT for both ("The MIT License (MIT)", first line of each repository's LICENSE). Clean-room: write our own code and cite them in comments, as D-15 says.

### 3.4 Local edits to operations (what `onDidChangeTextDocument` gives)

`contentChanges[i]` has `range`, `rangeOffset`, `rangeLength`, `text`. Apply them to `Y.Text` **right to left** (descending `rangeOffset`) as `delete(rangeOffset - headerLength, rangeLength)` then `insert(rangeOffset - headerLength, text)` inside one transaction with the local origin; a change that touches the header region is reverted instead (D-17). Y.Text indexes are UTF-16 code units, the same unit as VS Code offsets; line endings must be one form in the shared text (Pitfall 6). Batch the resulting updates with `Y.mergeUpdates` into one `doc.update` per product at most every 500 ms (DESIGN 5.2); an update must stay under 256 KiB, so cut a huge paste into several updates in order (migrate.ts does this with `chunksOf`, 60 000 UTF-16 units per piece, lines 477-480).

### 3.5 Presence message plaintext (Phase 33 defines it)

Recommended closed shape (JSON, at most 1 KiB): `{ v: 1, kind: 'here' | 'cursor' | 'leave', member, position?, product?, anchor?, head?, runs?, seq }` where `anchor` and `head` are base64url of `Y.encodeRelativePosition`, `runs` is a count only, `seq` is a counter to drop out-of-order frames; `member` is the roster member id (names come from the roster at the frame's roster head, never from the message). Accept a frame only when it opens with a held epoch key, parses against the closed shape and `member` is the member of the frame's `writer`. The "Show others what I am working on" setting turns `product`, `anchor`, `head` and `runs` off (heartbeat only).

### 3.6 Staff Room panel

- `staffRoomPanel.ts` (217 lines): `registerStaffRoom(context, gate, chat)` registers `OPEN_STAFF_ROOM_COMMAND`; `openStaffRoom` builds the HTML with a nonce CSP (`copMapCsp(webview.cspSource, nonce)`), then `send()` builds `buildStaffRoomModel(...)` and posts `{ type: STAFF_ROOM_MESSAGE, model, cues, pictureNow, picture?, basemap? }`; it coalesces to at most four pictures a second (`MIN_GAP_MS = 250`) and nothing while hidden; a file watcher on `.planning/{staff/**,.near-ai/project.json}` and `host.onEvent` trigger it. `staffRoomTap` observes both directions for tests.
- Messages from the page go through `parseStaffRoomMessage` (domain `staffRoom.ts`) and `handleStaffRoomMessage` (`staffRoomHost.ts`); a decision button runs only `PERSON_DECISION_COMMANDS` after `decisionCommand(message, decisions)` checks the product and the version hash against the model last sent [VERIFIED: staffRoomHost.ts:34-71; staffRoom.ts:713-722]. `STAFF_ROOM_OPEN_COMMANDS` is the closed map of link targets (`team-live`, `load-scenario`, `set-up-staff`, `show-products`).
- **Adding live cards:** new message types (`admit-request`, `decline-request`, `sync-now`, `take-change`, `restore-file`, `settle-contested`) are added to the message union and `parseStaffRoomMessage` in domain `staffRoom.ts` (725 lines, under the 800 warning: add one import and the union members only; put the model in `staffRoomLive.ts`) and to `handleStaffRoomMessage`. The page script is a new `media/staffRoom/staffLive.js` loaded from `staffRoomHtml` (add the `<script nonce=...>` line and keep `localResourceRoots` to the existing `media/staffRoom` folder). Admit and Decline must run the existing person-only admit flow with the six words (Phase 31), never a one-click admit.
- Page tests use `src/test/helpers/fakeDom.ts` and `staffRoomFixture.ts` (`staffRoomPage.test.ts`); there is a 1 GB `maxRSS` budget test at the end of that file, so a new page test must print fake nodes short.

### 3.7 Commands and manifest

- The 12 multi-user command ids are in `STAFF_MULTI_USER_COMMANDS` (`src/domain/staff/commands.ts:27-41`), registered by `registerStaffMultiUserCommands` through the `gated(...)` wrapper that refuses with `MULTI_USER_PREVIEW_OFF_TEXT` while `nearAi.staff.multiUserPreview` is off [VERIFIED: staffMultiUserCommands.ts:833-852]. Every one has a `commandPalette` entry with `"when": "config.nearAi.staff.multiUserPreview"` (package.json:1094-1139). Retiring the setting (D-20) means: drop the `gated` check, change the palette `when` to `false` for the hidden aliases (as the policy commands do: `"when": "false"`), keep the setting contributed with a `deprecationMessage` and a description saying it is ignored, and update `staffMultiUserManifest.test.ts` (lines 77, 114, 126, 135, 143, 163) and `staffMultiUserCommands.test.ts` (39 tests).
- **Rule that must keep holding:** "No line of this file imports a module under src/staff/replica" (staffMultiUserCommands.ts header 9-10); handlers `await import('../staff/replica/...')`. New editor files follow it.
- New contributions this phase needs: commands (share, connect, grant, revoke, re-admit, change address, sync now, show who wrote this, take change, restore file, bound undo and redo), `keybindings` (new key), `languages` (new key), the deprecated setting text, and a person setting "Show others what I am working on" (read only through `services/settings.ts`; `get-configuration` baseline lists `services/staffMultiUserCommands.ts`, so it may not add more reads: a new file must use `settings.ts`).

### 3.8 `registerSetupStep`

`SetupStep { id, label, detail, icon, command, isDone(ctx), isAvailable?(ctx) }`; `registerSetupStep(step, after?)` returns `{ dispose }`; `SETUP_STEPS = [PROJECT_TEAM_STEP, SPENDING_LIMIT_STEP, WEB_SEARCH_STEP]`; the policy step is registered from `gateCommands.ts:406-408` as `keep(registerSetupStep(policySetupStep(host, clock)))` [VERIFIED: setupSteps.ts:31-47, 96-100]. `buildSetupMenu` shows undone steps first with the first one "(recommended)". The step is "done" when the project is shared and its sync state is not `single-machine`; `isAvailable` is false in a folder with no staff project. Register it from the new `staffShare.ts` activation hook, called from `src/services/staffCommands.ts` next to `registerStaffMultiUserCommands` (line 68) so the composition root `extension.ts` is not edited.

### 3.9 The one status item

`createGateStatusBar(options)` creates `vscode.window.createStatusBarItem('nearAi.gate', vscode.StatusBarAlignment.Left, 49)` (name 'NEAR AI Policy'); its text comes from the pure `gateStatusText(state, now, chatMark?, layers?)`; the `read` callback gives `{ state, now, layers }` and is wired in `gateCommands.ts:332`. To add sync: extend `read`'s result and `gateStatusText` with an optional `sync?: { word: string; tooltip: string; warning: boolean }` and append `· ${word}` (the label part already uses ` · `); a `staffSyncStatus.ts` store calls `bar.update(...)` on change. `GateStatusShown { text, tooltip, warning }`. Sentences per state (D-22, DESIGN 19): Live, Catching up (N changes), Offline: working on this computer. Last synced HH:MM., Not accepted by your organization's server: ask the {term lead}., Needs attention: ... (the finding sentence in user words), Needs an update.

### 3.10 `TrustFacts`, `term()`, settings

- `term(concept, mode = DEFAULT_MODE)` returns the word from `MODES[mode].words[concept].word` and throws `TypeError` for an unknown concept (terms.ts:20-24); the Staff Room uses the default (Corporate and software) until 33.1 sets a mode. Read `src/domain/org/modes.ts` for the concept keys (`CONCEPT_KEYS`) before writing any member or lead word; do not spell mode words.
- `TrustFacts` is `{ place, verification, allowedBy, label?, use?, wouldRefuse }` built by `trustFactsFor(decision, facts, context, extra?)`, and `trustLine(trust, scales)` gives "Runs on {place} · {verified} · {allowed}" [VERIFIED: trust.ts:35-45, 81, 99-132, 205]. Agent cards that already carry a route decision can show it; products cannot (F8).
- Settings are read only in `services/settings.ts` (`SETTINGS_FILE` in architectureScan.ts:44; `get-configuration` violations are baselined). Add `readStaffSharingSettings()` there for the new person setting.

### 3.11 Copy lint and architecture rules new files must pass

- Copy lint: scans `package.json`, every non-test `src/**/*.ts` and `media/**/*.js|mjs|html` (not `media/vendor`) for user-copy strings; rules `glossary`, `mode-word`, `brand`, `em-dash`, `provider-organization`, `bare-team`, `compliance-claim` [VERIFIED: copyLintScan.ts:10, 309-314]. A count above the baseline fails (`src/test/copy-lint-baseline.json`, only shrinks; `NEAR_AI_WRITE_BASELINE=1` rewrites it and fails on purpose). New copy: "your organization's server" not "hub", no bare "team", no "cell/grant/roster/seat" on main screens, no em-dash, never "compliant/certified/accredited" claims.
- Architecture: layers (domain below hosts below editor below composition root); rules `vscode-below-editor`, `upward-import`, `folder-cycle`, `scale-presets`, `get-configuration`; `WARN_ABOVE = 800`, `FROZEN_ABOVE = 1200`; the baseline lists `fileSizes` frozen at `staff/replica/store.ts` 1673 and `staff/staffHost.ts` 1688 [VERIFIED: architectureScan.ts:49-52 (`WARN_ABOVE = 800`, `FROZEN_ABOVE = 1200`), architecture-baseline.json `fileSizes`]. A new `src/staff/replica/*.ts` file importing `services/*` is an `upward-import` violation (existing ones are baselined); the new files take `secrets` and paths as arguments instead.
- `NEAR_AI_BASELINE_TIGHT=1` in the closing plan: stale baseline counts fail, so the closing plan re-records after the copy fixes.

## 4. Decisions and the decision dialog

### 4.1 Version act data shapes (kindSchemas/versions.ts, verbatim keys)

| Kind | Required keys (exact; extra keys refuse the entry) | Notes |
|---|---|---|
| `product.create` | `product, section, roles, title` | `roles` = `{ owner, sectionLead, releaseGuard, tradecraftReviewer? }`, guard never the owner |
| `version.propose` | `product, hash, textBlob, snapshot, pins` | `snapshot` base64url at most `MAX_SNAPSHOT_BYTES = 1024 * 1024`; written today by `proposeVersion` (labelCells.ts:377-398) |
| `version.verdict` | `product, hash, gate, verdict, reasons` | `gate` `'guard' | 'tradecraft'`; guard words `['CLEARED', 'HOLD']`, tradecraft `['SIGN-OFF', 'NOT READY']` |
| `version.submit` | `product, hash, decisionFor` | `decisionFor` a slug |
| `version.decide` | `product, hash, outcome, reasons, decisionsSeen` | `outcome` in `['approve', 'reject', 'decline']`; `decisionsSeen` at most `MAX_DECISIONS_SEEN = 64` hashes |
| `version.release` | `product, hash, decisionsSeen` | needs an effective approval of the same hash causally before |
| `version.withdraw` | `product, hash, reason, decisionsSeen` | reason a line of at most `MAX_REASON_CHARS = 500` |
| `version.supersede` | `product, hash, byHash` | |

[VERIFIED: kindSchemas/versions.ts:8-17, 60-122]. Agents may write `version.propose`, `version.verdict` and `version.submit`; `version.decide`, `version.release` and `version.supersede` are person-only (the fold refuses an agent decision; "Forbidden, each tested" in DESIGN 15.4). The staff host must keep `PERSON_DECISION_COMMANDS` as the only way a person's decision is written.

**Settling a contested version:** `version.decide` with `decisionsSeen` = `DecisionSummary.contested` (every contested entry hash, at most 64). The two buttons on the card are "Approve v{n}" and "Reject v{n}", both writing `version.decide`.

### 4.2 `doc.compact` data

`{ product, covers, stateVector, textHash, stateBlob }`: `covers` at most `MAX_COMPACT_COVERS = 64` deps, `stateVector` sorted `[client, clock]` pairs (at most 100 000), `textHash` and `stateBlob` 64-hex hashes (the blob sealed with `sealBlob(key, stream, epoch, fullState)`) [VERIFIED: kindSchemas/doc.ts:35-44]. The fold checks it against the accepted updates it covers and refuses a mismatch; a writer may compact a product again only after `COMPACTION_WINDOW = 50` more accepted updates (textFold.ts:100, `applyCompaction` at 259).

### 4.3 The decision dialog today and what must change

- Flow (`staffCommands.ts:119-158`): `decideCommand` reads `host.snapshot()`, picks the product, refuses `args.hash !== view.hash` ("changed since you saw it"), asks the person (`askPerson`: name, role), asks reasons for reject, shows a **modal** `showWarningMessage(..., { modal: true, detail })`, then `host.decide(person, { product, action, hash: view.hash, reasons, releaseOnApproval })`. The hash is compared once before the modal; nothing compares after it, and `host.decide` itself only passes the hash into the ledger event. In a shared project `host.decide` refuses (F3).
- Required: (1) `decideCommand` takes a `decisionStamp` (hash of the product's decision summary at open) and after the modal returns re-reads and refuses with exactly "Someone else decided this version while you were deciding. Look again." when it changed (D-24); (2) the shared branch of `decide` writes `version.decide` (or `version.release`/`version.withdraw`) with `decisionsSeen`; (3) the Staff Room contested card runs the same command with `settle: true`; (4) `decisionCommand` in domain `staffRoom.ts` keeps validating product and hash against the model last sent.
- The modal itself cannot be driven from a webview or a browser tool. "A focused browser check" (D-24) is therefore two checks: the Staff Room page in `fakeDom` (card text, two buttons, message sent) and the extension-host e2e (`src/test/e2e/suite.ts`, `npm run test:e2e`, xvfb) observing the webview messages with `staffRoomTap`, plus unit tests of the "changed while deciding" refusal in `staffCommands`. Do not add a Chromium dependency.

### 4.4 E2E infrastructure

`npm run test:e2e` = `npm run compile && env -u ELECTRON_RUN_AS_NODE xvfb-run -a -s "-screen 0 1920x1080x24" node dist/test/e2e/run.js`; the suite runs inside the extension host with `NEAR_AI_E2E=1`, scenarios `plain` and a project scenario, and observes both directions of the real webview (`Observer`, `toView`/`fromView`). `xvfb-run` and `docker` are present here. Run e2e once, in the closing plan, with the 6G wrapper.

## 5. Release mechanics

- `scripts/prepare-release.mjs bump <x.y.z>` sets `package.json` and `package-lock.json`; `prepare-release.mjs check` requires the branch `release/<version>` (or `hotfix/`), the version above the last `v*` tag on origin (read with `git ls-remote --tags --refs origin 'refs/tags/v*'`), and a `## <version>` CHANGELOG section with text. The `release` skill (`.claude/commands/release.md`) adds: write the CHANGELOG section in user words, update README and SECURITY.md, check the docs site, `npm run lint && npm test`, `npm run verify:release`, `npm run docs:build`, push, open the PR, `/review-pr`, `/merge-pr` (tags the squash commit); the owner approves the `publish` job in GitHub. Patch releases take no docs snapshot; a minor takes one (`npm run version:snapshot`). D-38 says 0.4.36, a patch: check the last tag first (0.4.35 is the latest local tag; the skill says read GitHub, not local tags).
- `verify:release` = `npm run package && node scripts/verify-release-content.mjs`, which lists required VSIX entries, including `extension/dist/staff/replica/decodeWorker.js`; add nothing new unless a new worker file ships. The VSIX must keep ignoring `hub/**` (`.vscodeignore`, `hubIsolation.test.ts:29`).
- **The README sentence to replace** is in the staff section at README.md:283-289: "Several people on their own computers sharing one staff project is a preview: turn on `nearAi.staff.multiUserPreview` to try the invite, join and admit commands, **Make This Staff Project Multi-User** and **Make a Single-Machine Copy**. Projects with products labelled above `org/Public` are not converted yet, and the shared project cannot yet be synced between computers; that comes in a later release." [VERIFIED: README.md:283-289]. (Part of it is already stale: Phase 32 converts labelled products.) The new section "Work on a staff project with other people" replaces it.
- **SECURITY.md** has "## Multi-user staff projects (preview)" at line 1619 (sections: update size limits, the replica store, keys and cells, joining, labelled products, "Off unless you turn it on" at ~1939-1943) and "## Your organization's sync hub" at 2258 with the two restore limits at 2324-2336 and "a flow that arrives with the editor's hub commands" at 2330. Retitle the first without "(preview)" once D-20 lands, replace "Off unless you turn it on", and fix the limit sentences.
- **Docs test pattern** (`src/test/gateDocs.test.ts`): constants owned by code are asserted word for word in a named section of README and SECURITY (`policySection.includes(CLEARANCE_SELF_ASSERTED_TEXT)`), `sectionOf(text, heading)` finds a section, `flat()` normalises whitespace, the commands the docs name are looked up in `package.json` through `commandName(id)`, and sections must hold no em-dash. The two sentences to reuse **exactly** (both are exported from `src/domain/gate/labels.ts`): `CLEARANCE_SELF_ASSERTED_TEXT` = "Until verified credentials arrive, your clearance comes from your own policy file, which your own device key signs, so it is self-declared. It is not an enforced clearance boundary." and `LABELS_NOT_ACCREDITATION_TEXT` = "Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary." [VERIFIED: labels.ts:283-288]. The multi-user notices every screen shows come from `multiUserNoticeLines` in `src/domain/staff/multiUser.ts` (SECURITY.md ~1915 and ~1928 quote them); read that function for the exact words and have the docs test import it, and the two label constants, rather than copy any of the three.
- **relay/README.md:141** says "This release ships the hub for operators only. People cannot connect a staff project to it from the editor yet; that arrives in a later release." and lines 327 and 342 say re-admitting arrives "in a later release" / "When members can connect projects from the editor": all three change with drop A.

## Runtime State Inventory

Not a rename or migration phase, so the five-category inventory does not apply. Two persistent-state facts the planner needs: (1) existing 0.4.35 preview projects carry no `roster.require` and have their products in the base cell (they cannot connect to a hub, SECURITY.md 1801-1806); D-08 arms the check on the lead's next open, and Share with people must refuse them with the single-machine-copy way out; (2) the witness state in `SecretStorage` (`nearAi.staff.hubWitness.<sha256>`) and the new per-project hub address file are the only new device-local state, both addressed by project id.

## Common Pitfalls

### Pitfall 1: The echo race and document version drift
**What goes wrong:** the binding applies a remote `WorkspaceEdit`, the resulting `onDidChangeTextDocument` is read as a local edit, and the change is written back to `Y.Text` (an echo loop or a duplicated character); or a person types while an edit is being applied and offsets in the pending edit are stale.
**Why:** `workspace.applyEdit` returns a promise and the change event is delivered separately, so a boolean "applying" flag is wrong in both directions. [ASSUMED: ordering of the event and the promise is not documented as fixed.]
**Avoid:** an expected-edit queue (the text the document should hold after each remote edit, plus `document.version`); every event is classified by comparing the document text to `Y.Text`-derived expectations; on any disagreement resync the body from `Y.Text` once, log one line. Build the whole thing on a `BoundDocument` interface so a fake document can reorder events, and fuzz it.
**Warning signs:** a character doubled after a remote edit, a cursor that jumps, the resync log line appearing in ordinary use.

### Pitfall 2: Fast typing, batching and clock continuity
**What goes wrong:** updates sent out of order, dropped after a failed append, or over 256 KiB; two windows reuse a client id.
**Why:** the fold requires a client's first struct to start at the next expected clock (`clock-overlap` or a gap, section 1.8) and each `doc.update` at most `MAX_UPDATE_BYTES`.
**Avoid:** one writer queue per product; `Y.mergeUpdates` of the captured updates in order every 500 ms; a failed append stays queued and is retried in order (D-11: "never lost"); cut an update over about 200 KiB; a fresh client id per session per product, registered with `doc.client` before the first update; stop and show the "pick again" outcome on `client-collision`.
**Warning signs:** `held` entries with `unregistered-client`, `refused` with `clock-overlap` in `fold.refused`.

### Pitfall 3: UndoManager origins and what it sends
**What goes wrong:** undo does nothing visible to others, or an undo is echoed back.
**Why:** an `UndoManager.undo()` runs a transaction whose origin is the manager itself, not the tracked origin; the update capture and the Y.Text observer must treat the manager's origin as local (send it, do not render it as remote) while still rendering it into the editor.
**Avoid:** capture `update` events with origin in `{ localOrigin, undoManager }`; render into the editor for undo and redo but not for `localOrigin`.

### Pitfall 4: VS Code's own undo and the Edit menu
**What goes wrong:** the Edit menu's Undo, or a command that calls the built-in `undo`, bypasses the keybinding and undoes a remote edit locally.
**Why:** a `when`-scoped keybinding does not intercept the built-in command (Pattern 3); `TextDocumentChangeEvent.reason` is the only signal (`Undo` or `Redo`).
**Avoid:** when a bound document reports `reason` Undo or Redo, restore the document body from `Y.Text` (resync) and run `UndoManager.undo()` or `redo()` instead, with the notice "Undo in a shared product removes only your own changes." [ASSUMED approach; test with the fake document.]

### Pitfall 5: The header region changes while someone types
**What goes wrong:** a header rewrite (an approval) shifts every offset; a local edit just before it lands in the wrong place.
**Avoid:** map by `document.version` and apply header changes as one edit of the header range; never let a header change enter `Y.Text`; reject edits crossing the boundary (D-17).

### Pitfall 6: Line endings, BOM and encoding
**What goes wrong:** CRLF in a document on one machine and LF in the shared text give offset drift and a changed digest.
**Avoid:** keep the shared text LF; set the bound document's EOL to LF on bind (`TextEditor.edit` with `setEndOfLine(EndOfLine.LF)`) and normalise inserted text; ignore a BOM. Test with a CRLF fake document.

### Pitfall 7: Two windows of one install
**What goes wrong:** two replicators push the same entries (harmless, held) but both write the witness state (last writer wins and can lose a finding) and both heartbeat as one device.
**Why:** `ReplicaStore` serialises appends across windows (file lock, `REPLICA_LOCK_FILE`), but nothing elects one replicator.
**Avoid:** a per-project lease file in extension storage taken with the existing file-lock helper; the window without the lease shows "Synced in another window" and still binds editors (its appends go to the shared store; the lease holder pushes them). [ASSUMED design.]

### Pitfall 8: Memory
**What goes wrong:** many open products each hold a fold document (`gc` off) and an editor document, and a full-suite run exceeds the cap.
**Avoid:** bind only open editors; drop a binding when its editor closes; one `ReplicaProject` per host (already kept while the store identity is unchanged); fuzz tests with small sizes; the decode worker's 128 MB cap is separate. All scenario tests run inside `MemoryMax=4G` and Node `--max-old-space-size=1536`. A failing `assert.equal` on fake DOM nodes once printed the whole graph (memory note); keep `fakeDom` short printing.

### Pitfall 9: A hidden tab or sleep
**What goes wrong:** the code-server host is killed after about five minutes in a hidden browser tab (memory note `code-server-location`), or a laptop sleeps; on return the SSE stream is dead and presence has expired.
**Avoid:** an exchange on resume (a timer drift check: if the monotonic gap since the last tick exceeds 30 seconds, treat the link as lost and reconnect), `offline` is not an error state, heartbeats restart at once.

### Pitfall 10: Presence names a product in the base cell
**What goes wrong:** a member below a product's cell learns its name from the base cell's presence. **Avoid:** Pattern 4's content rule, and the leak test with presence frames in the capture (D-35).

### Pitfall 11: Rekeys and removals while bound
**What goes wrong:** a member is removed or loses clearance, its cell rekeys, and its editor keeps a working binding that can no longer append (`no-key`). **Avoid:** subscribe to roster change (the `roster` event and the fold's cell access) and close the binding with the sentence "You no longer have access to this part of the project."; keep the file as last projected, never delete it (ask before deleting, global rule).

### Pitfall 12: New hub refusals read as "attention"
`needs-update` and `restoring` arrive as `hub-error` and `syncOnce` maps that to `attention` (section 1.2). Without the small mapping edit the status shows a scary sentence for an ordinary restore.

### Pitfall 13: Store identity changes under a bound project
Start Again here or in another window moves the store folder aside. The host drops and reopens `ReplicaProject` (`currentShared`, identity compare, staffHost.ts ~458-466); the replicator and bindings must observe the same identity and stop cleanly, then rebind.

### Pitfall 14: The roster split card is promised and missing
`foldRoster` records splits in `RosterState.pending` with `ROSTER_SPLIT_TEXT` ("The roster was changed in two places at once. The lead or the deputy must choose.") and its comment says "Phase 33 shows it in the Staff Room" [VERIFIED: roster.ts ROSTER_SPLIT_TEXT and comment above it]. Include a card with a Choose action (the existing `chooseBranch` command) in the Staff Room plan.

## State of the Art

| Old approach | Current approach | When changed | Impact |
|--------------|------------------|--------------|--------|
| Single-machine staff ledger and files, shared by git copies | Signed per-writer logs folded deterministically, sealed per cell, Yjs for text | Phases 30 to 32 (merged 2026-11-19 to 2026-11-20) | Phase 33 is the first user-facing layer on it. |
| Unknown entry kinds kept and ignored (fine for text) | A project's `roster.require` makes a client that lacks a feature stop | This phase | Required before any kind that changes authority (positions, Phase 33.1). |
| One-shot `syncOnce` per command | Live replicator: SSE as a wake-up plus the same exchange | This phase | Same wire, no new protocol. |
| `onDidChangeTextDocument` hand-rolled bindings | Origin-tagged bindings (y-codemirror.next, y-monaco) | Established | Pattern reused clean-room. |

**Deprecated or outdated in this repo by this phase:** `nearAi.staff.multiUserPreview` (retired at the drop A release, D-20); the README sentence "the shared project cannot yet be synced between computers"; the SECURITY.md heading "Multi-user staff projects (preview)"; the relay README sentences "People cannot connect a staff project to it from the editor yet".

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|-------|---------|---------------|
| A1 | Feature id pattern `/^[a-z][a-z0-9-]{0,31}@[1-9][0-9]{0,2}$/` | 1.6 | Low. If Phase 41's pattern differs, a feature id the policy accepts is refused here (or the reverse). Reuse its checker if importable hub-side. |
| A2 | Common-prefix and suffix trimming (one replace) is enough for Take This Change as My Edit | Alternatives | Low. Attribution of a rewritten region is coarse; no correctness loss. |
| A3 | The order of the change event and the `applyEdit` promise is not guaranteed | Pitfall 1 | Medium. If it were fixed, a simpler guard would do; the queue is safe either way. |
| A4 | Handling a native Undo or Redo by resync plus Yjs undo | Pitfall 4 | Medium. Needs the owner's reading of "undo only your own edits" in the Edit menu case; the alternative is to allow it as a local edit and say so. |
| A5 | A per-project lease elects one replicator per install | Pitfall 7 | Medium. Without it the witness state can lose a finding in two-window use. |
| A6 | The restore-mode rule (F9) | F9 | High for D-32 (one-way hub API). Settle in the first task of the hub plan with the restore drill as the test. |
| A7 | A `hub.readmit` roster kind, or a local trust-again action, replaces D-13's "fresh `hub.admit`" | F4 | High (one-way door if a kind). Owner confirmation needed (Open Question 2). |
| A8 | Presence key derivation (HKDF info `near-ai/presence/v1`) and plaintext shape | Pattern 4, 3.5 | Low to medium. Any construction reusing the existing AEAD layout is acceptable; the leak test checks the result. |
| A9 | Compactor plus an opt-in pull-from-base is the minimum for "late joiner from a compaction" | F5 | Medium. A weaker assertion is possible if the owner accepts it. |
| A10 | Adding `features` to the signed session payload at `SESSION_VERSION` 2 | 2.2 | Low (unreleased hub), but the hub and extension must change in one plan. |
| A11 | HTTP statuses 403 for `needs-update` and 503 with `retry-after` for `restoring` | 2.1 | Low. Any mapping works if client and hub agree; the client reads the reason id. |
| A12 | `contributes.languages` for the `.near-staff-*` extensions gives the activation and an `onDidOpenTextDocument` signal | F14 | Low to medium. Verify in the e2e host with a real invitation file. |
| A13 | The Staff Room can show "Who can see this" and the label for product rows instead of a trust line | F8 | Medium. Depends on the owner's reading of D-26. |
| A14 | Agents keep being refused writes to shared products in this phase | F3 | Medium. A later phase (35) adds the `staff-products` diff writer; confirm the owner does not expect it in drop A. |

## Open Questions

1. **Shared version acts are not in CONTEXT (F3).**
   - What we know: criterion 3 needs propose, guard, approve and release over a hub; the host refuses all of them in a shared project; no writer exists.
   - What is unclear: whether the owner expects this in Phase 33 (it appears to be implied by "contested UI" and the scenarios).
   - Recommendation: include it as plan 33-04 (propose, verdict, submit, decide, release, withdraw for persons; verdict and propose for agent actors), leave registers, wargame, CCIR and steps refused.

2. **How D-13's re-admit works (F4).**
   - Recommendation: add roster kind `hub.readmit { hub, certPin, rosterPrev }` in the same plan as `roster.require` (one wire decision, both in the 0.4.36 drop), a witness field for the roster position of the last re-admission, the twelve words computed from the pin with the safety word list, and a lead-only Re-admit action. Fallback if the owner declines a second roster kind: the member-by-member "trust this server again" (D-13's alternative) with the words shown to each member.

3. **Late joiner from a compaction (F5).**
   - Recommendation: compactor plus an opt-in `syncOnce` start-from-base for a device with an empty log; scenario asserts fewer entries pulled and equal text and digest.

4. **Trust line for product rows (F8).** Recommendation: agent cards that carry a route decision show `trustLine`; product rows show "Who can see this" plus the label word; no new badge state.

5. **Restore-mode rule (F9).** See F9; one decision for the hub plan, with the owner told in the plan summary.

6. **CI for the real-hub scenario (F11).** The cleanest is one added step in the `hub` job (Node 26 is already set up there) that runs `npm ci && npm run compile` at the repository root and then the src-side scenario file with `NEAR_AI_HUB_NODE` set. It edits `.github/workflows/ci.yml`: a gate path, so the integration PR needs the owner's gate approval and the run URL must be sent the moment it waits (D-39).

7. **Window election (Pitfall 7).** Lease file or accept duplicate replicators with a witness merge? Recommendation: lease.

8. **Preview projects after the preview switch is retired (D-20).** A 0.4.35 project has no `require@1`; D-08 arms it on the lead's next open. A member's device on 0.4.36 opening it before the lead updates still works (no requirement yet). Confirm that is intended.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node 24 | Extension build and tests | yes | v24.22.3 (nvm current) | none needed |
| Node 26.13.1 | The hub, hub tests, real-hub scenario | yes (nvm) | v26.13.1 at `~/.nvm/versions/node/v26.13.1/bin/node` | none: the hub refuses other versions |
| Docker | Hub container tests (`hub/test/container`), compose profile | yes | `/usr/bin/docker` | skip container tests locally; CI runs them |
| xvfb-run | `npm run test:e2e` | yes | `/usr/bin/xvfb-run` | none |
| systemd-run and choom | The required memory cap wrapper | yes | `/usr/bin/systemd-run`, `/usr/bin/choom` | none: uncapped runs are blocked by a hook |
| Free memory | One heavy run at a time | 6 GiB free, 14 GiB available of 28 GiB at the time of checking | n/a | check `free -g` before each heavy run |
| `vendor/yjs/yjs.cjs` | Binding and fold tests | produced by `npm run compile` | n/a | run `node scripts/vendor-libs.mjs` |
| Hub build `hub/dist` | Hub tests and the child-process scenario | produced by `cd hub && npm run build` | n/a | none |

**Missing with no fallback:** none. **Note:** the hub runs only on 26.13.1, so every command that starts it must put that Node first on `PATH` (for example `PATH=$HOME/.nvm/versions/node/v26.13.1/bin:$PATH`).

## Validation Architecture

### Test framework
| Property | Value |
|----------|-------|
| Framework | `node:test` through `scripts/run-tests.mjs` (extension, Node 24.22.3); the hub's own `node:test` run (Node 26.13.1) |
| Config file | none; `tsconfig.json` compiles `src/**/*.ts` to `dist/`; `hub/scripts/build.mjs` bundles hub tests with esbuild |
| Quick run (one file, capped) | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 300 env NODE_OPTIONS=--max-old-space-size=1536 node scripts/run-tests.mjs dist/test/<file>.test.js` after `npx tsc -p tsconfig.json` (or `npm run compile` when `vendor/` is stale) |
| Hub run (capped, Node 26) | `cd hub && systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 600 env PATH=$HOME/.nvm/versions/node/v26.13.1/bin:$PATH NODE_OPTIONS=--max-old-space-size=1536 npm test` (add a test file name filter through `node ../scripts/run-tests.mjs dist/test/<file>.test.js` after `npm run build`) |
| Full suite (closing plan only) | the same wrapper with `MemoryMax=6G`, `timeout 1800`, `npm test`; then `npm run test:e2e`, `npm run verify:release`, `node scripts/secret-scan.mjs`, one at a time |
| Never | bare `node --test`, uncapped `npm test` (a hook blocks it); `scripts/run-tests.mjs` also keeps temporary folders under one removed folder |

### Phase requirements to test map
| Req | Behaviour | Test type | Automated command | File exists? |
|-----|-----------|-----------|-------------------|--------------|
| POST-01 | `roster.require` kind and schema; union only grows; lead or deputy only; agent refused; counts 52 and 19 | unit | `... dist/test/replicaRosterRequire.test.js` | no, Wave 0 (plan 33-02) |
| POST-01 | A client lacking a feature stops: no state, no append, store intact, resumes after update; old-client roster stall documented | integration | `... dist/test/staffRequireGate.test.js` | no (33-02) |
| POST-01 | The hub refuses appends (`needs-update`) and sessions of clients lacking the feature; reads still served | hub | `cd hub && ... dist/test/require.test.js` | no (33-06) |
| MUS-09 | Nine-state machine: every transition, every state has a sentence and an accessible name, no silent wait (10 s, 5 min back-off) | unit, fake timers | `... dist/test/replicaSyncMachine.test.js` | no (33-01, 33-08) |
| MUS-09 | Replicator: event wake-up coalescing, local-first push, `blobsCitedBy` supplied, `join-request` fetch, witness findings to attention, `restoring` and `needs-update` states | unit with fake transport and `replicaFakeTransport.ts` | `... dist/test/staffLiveReplicator.test.js` | no (33-08) |
| MUS-09 | The same against the real in-process hub, including SSE latency under 1 s on loopback | hub | `cd hub && ... dist/test/liveReplicator.test.js` | no (33-08) |
| MUS-09 | Binding: fuzzed interleavings of local and remote edits against a fake document, no echo, resync on mismatch, undo only own, header read-only, CRLF, take and restore | unit and property | `... dist/test/staffEditorBinding.test.js` | no (33-03) |
| MUS-09 | VS Code adapter: listeners, expected-edit queue, decorations, keybinding commands, `setContext` | unit with `vscodeStub.ts` | `... dist/test/staffEditorBindingAdapter.test.js` | no (33-03) |
| MUS-09 | Show Who Wrote This: spans to names, agent on a named person's machine, unverified flagged | unit | `... dist/test/staffAttributionView.test.js` | no (33-03) |
| MUS-09 | Presence: seal and open, tamper, wrong epoch, size under 2 KiB, schema, opt-out, expiry, no product name in base cell | unit | `... dist/test/replicaPresence.test.js` | no (33-10) |
| MUS-09 | Shared version acts: each act and refusal, agent forbidden, contested cases (concurrent approve and reject), settling, changed-while-deciding refusal | integration (two `ReplicaProject` worlds) | `... dist/test/staffSharedVersionActs.test.js` | no (33-04) |
| MUS-09 | Staff Room model and page: presence list, sync sentence and one action per state, offline banner, contested card, N changes since, join-request card, roster split card | unit with `fakeDom` | `... dist/test/staffRoomLive.test.js`, `staffRoomLivePage.test.js` | no (33-11) |
| MUS-09 | Status bar word for each state | unit | extend `gateStatusBarRefresh.test.ts` | partly (33-11) |
| MUS-09 | Share with people: step registered, preview aliases hidden, language activation, hub flows reached, address stored, refusals worded | unit | `... dist/test/staffShare.test.js`; update `staffMultiUserManifest.test.js`, `staffMultiUserCommands.test.js` | partly (33-09) |
| MUS-09 | WR-07 per-entry `blob-missing`; IN-06 caps; IN-02 mismatch rebuild with a kill part way; `withheld` notice | hub and unit | `hub/test/blobMissingPerEntry.test.js`, `hub/test/joinCap.test.js`, extend `staffReplicaStartAgain.test.js`, `staffMultiUserCommands.test.js` | no (33-05, 33-06) |
| MUS-09 | Restore mode with the drill | hub | extend `hub/test/restoreDrill.test.ts` | partly (33-06) |
| MUS-09 | Two- and three-person scenarios over a real hub (co-edit, propose, guard, approve elsewhere with equal digests; offline approve vs online reject is contested until a fresh decision; late joiner) | scenario | `... dist/test/staffLiveScenario.test.js` with `NEAR_AI_HUB_NODE`; `hub/test/liveScenarios.test.ts` | no (33-01 tracer, 33-12) |
| MUS-09 | Two-compartment leak test through the replicator, presence included | hub with byte capture | `hub/test/liveLeak.test.ts` | no (33-12) |
| MUS-09 | README and SECURITY sentences word for word, no em-dash, commands named as contributed | docs test | `... dist/test/staffLiveDocs.test.js` | no (33-13) |
| MUS-09 | Preview parity: a project that never shares loads nothing under `src/staff/replica` | unit | existing `staffMultiUserManifest.test.js`, `staffReplicaParity.test.js` | yes |
| Gate | Copy lint and architecture ratchets | unit | `copyLint.test.js`, `architecture.test.js` | yes; baselines tightened in 33-14 |
| Release | `verify:release`, secret scan, `prepare-release check` | script | `npm run verify:release`; `node scripts/secret-scan.mjs`; `node scripts/prepare-release.mjs check` | yes |

### Sampling rate
- **Per task commit:** the single new test file for that task through the capped quick command, plus `tsc --noEmit` (`npm run lint`).
- **Per wave merge:** all new files of the wave, the copy lint and architecture tests, and `hub` tests when the wave touched `hub/`.
- **Phase gate:** the full suite once, e2e once, `verify:release` once, secret scan, hub suite, relay suite untouched (`relay/` is not changed), all green before `/gsd-verify-work`. Authorization, label leak, data integrity and boundary tests are blocking on every wave that touches them.

### Wave 0 gaps
- [ ] `src/test/helpers/liveWorld.ts`: two or three `ReplicaProject` devices with separate store folders, device keys and `replicaFakeTransport`, plus a `FakeBoundDocument` (versioned text, scripted event delivery, reorderable) shared by the binding tests.
- [ ] `src/test/helpers/hubChild.ts`: start the built hub as a child process on a temporary state directory with the Node named by `NEAR_AI_HUB_NODE` (copy the launch logic of `hub/test/helpers/hubProcess.ts`; src tests cannot import `hub/`), the fixture certificate from `test/fixtures/cyber/certs`, a hub file from `--hub-file`, and cleanup on exit (hub dies by SIGKILL after 60 s as `launchHub` does).
- [ ] Fuzz generator for interleaved edits with a seeded PRNG printed on failure.
- [ ] A hub-side `LiveClient` helper in `hub/test/helpers/` that runs the Yjs-free `LiveReplicator` over `memoryReplica`.
- [ ] `hub/test/helpers/` presence capture: reuse `captureServer` and add the `presence` route to the wire search.
- [ ] CI: the added `hub` job step (F11, gate path).
- [ ] Baseline records: `copy-lint-baseline.json` and `architecture-baseline.json` unchanged until the closing plan tightens them with `NEAR_AI_BASELINE_TIGHT=1`.

## Security Domain

### Applicable ASVS categories
| ASVS category | Applies | Standard control |
|---------------|---------|------------------|
| V2 Authentication | yes | Device-key signed session answer bound to the TLS connection (existing); feature announcement inside the signed payload. |
| V3 Session management | yes | Hub tokens (15 minutes, 8 per device per project) already bound to the connection; replicator re-opens on `MENDABLE` refusals only. |
| V4 Access control | yes | Cell access lists and roster standing at the hub; lead-only `roster.require`, `hub.readmit`, admit and decline; person-only decisions. |
| V5 Input validation | yes | Closed schemas for `roster.require` (feature ids) and presence plaintext; `parseHubAddress`/`isHubAddress`; bounds on join requests (8 and 64); update size and skim guards (existing). |
| V6 Cryptography | yes | AES-256-GCM with HKDF via `node:crypto` for presence; never a new construction; keys never logged. |
| V8 Data protection | yes | Presence never stored; base-cell presence carries no product name; sealed under the product's cell key; leak test with capture. |
| V9 Communications | yes | TLS 1.3 only, pinned (existing); the changed address never changes the pin (D-10). |
| V14 Configuration | yes | Hub restore marker is a file in the state directory; permissions as the state directory (0700 by `stateDir.ts`). |

### Known threat patterns for this stack
| Pattern | STRIDE | Standard mitigation |
|---------|--------|---------------------|
| Old client writes through the hub after a relief or requirement | Elevation of privilege | Hub refuses sessions and appends when `required` is not covered (D-07); roster chain stalls old clients (section 1.6). |
| Presence forgery by another cell member, or mislabelling by a malicious hub | Spoofing | Presence is advisory, shown with the roster's name for the frame's writer, never used for a decision or an authorization. |
| Product name or cursor leaks to a member below the cell | Information disclosure | Content rule per cell (Pattern 4); capture test includes presence frames. |
| Join-request flood against an invitation | Denial of service | 8 per invitation and 64 per project cap, plus the existing 10 per minute address bucket. |
| Restore replay: a restored hub accepts new work and then looks forked | Tampering, repudiation | Restore mode (D-32); witness findings unchanged. |
| A hostile `doc.update` through the binding | Tampering, DoS | Only fold-accepted updates reach the editor (F6); size and skim guards run before Yjs decodes. |
| Echo loop or runaway edit storm in the editor | DoS | Expected-edit queue, resync once, rate-limit resyncs per minute. |
| Fake "update" sentence or a lying feature announcement | Spoofing | The announcement is signed; a lying device only harms itself because the roster chain, not the announcement, stalls its fold. |
| Secrets in logs | Information disclosure | No token, key, join secret or pin printed (existing hub redactor; keep for new log lines). |

## Work breakdown: plans, waves and file ownership

Rules: plans in one wave own disjoint files (D-02); the first task of every plan re-reads the names it uses (D-01); each plan runs its own capped tests (D-37); one plan owns `package.json` in a wave; the frozen files take net-zero edits. The numbering below is a proposal; the planner may merge or split.

| Wave | Plan | Scope | Owns (new unless marked changed) | Needs | Req |
|------|------|-------|----------------------------------|-------|-----|
| 1 | 33-01 **Tracer** | Two devices (separate stores and keys), a real hub child process, one edit typed through the binding core on A and seen in B's fold and text. Minimal `syncMachine`, minimal `LiveReplicator` (open events, on `heads` run `syncOnce`, supply `blobsCitedBy`), the editor-doc additions to `doc.ts` (stable origin, update capture, observer), `productFeed.ts` (accepted update bytes via `project.state()`, `entriesAfter`, `verifyEntry(raw, project.context())`) | `src/domain/replica/syncMachine.ts`, `src/staff/replica/liveReplicator.ts`, `src/staff/replica/productEditing.ts`, `src/staff/replica/productFeed.ts`, `src/domain/replica/doc.ts` (changed), `src/test/staffLiveTracer.test.ts`, `src/test/helpers/hubChild.ts`, `src/test/helpers/liveWorld.ts` | none | MUS-09 |
| 2 | 33-02 **POST-01** | `roster.require` (and `hub.readmit` if confirmed): kind list, schema, fold, `RosterState.required`, `features.ts`, `requireGate.ts`, the `foldNow` hook, `needs-update` refusal, D-08 write at creation and `ensureRequireArmed`, HUB_SIDE list, count tests | `src/domain/replica/features.ts`, `kinds.ts`, `kindSchemas/roster.ts`, `roster.ts`, `src/staff/replica/requireGate.ts`, `replicaProject.ts` (changed, at most 25 lines), `src/test/replicaBoundaries.test.ts`, `replicaTracer.test.ts`, `replicaRosterTracer.test.ts`, `replicaProductCells.test.ts`, new tests | 33-01 | POST-01 |
| 2 | 33-03 **Editor binding** | Binding core with echo guard, `UndoManager`, header region, take or restore, Show Who Wrote This, the VS Code adapter, keybindings and `nearAi.staffBoundEditor`, the bound-editor commands in the manifest | `src/staff/replica/editorBinding.ts`, `src/services/staffEditorBinding.ts`, `src/domain/replica/doc.ts` (changed), `src/services/settings.ts` (changed, only if a setting is read here), `package.json` (changed: commands and `keybindings`), tests | 33-01 | MUS-09 |
| 2 | 33-04 **Shared version acts and contested read model** | `versionActs.ts`, `contested.ts`, host delegation, the `decisionStamp` check in `decideCommand`, agent propose and verdict, person-only decide, release, withdraw | `src/staff/replica/versionActs.ts`, `contested.ts`, `src/staff/staffHost.ts` (changed, net zero), `src/services/staffCommands.ts` (changed), `src/domain/staff/staffRoom.ts` (changed: `decisionCommand` only), tests | 33-01 | MUS-09 |
| 2 | 33-05 **Small hub and store follow-ups** | IN-06 join cap with limits and client refusal text, IN-02 count check (net zero in `store.ts`), `MigrationResult.withheld` and `unversioned` notice | `hub/src/join.ts`, `hub/src/limits.ts`, `hub/src/store/hubStore.ts` (changed), `src/staff/replica/hubMembership.ts` (changed: refusal id), `src/staff/replica/startAgainCheck.ts`, `store.ts` (changed, net zero), `src/services/staffMultiUserCommands.ts` (changed, notice only), tests | none | MUS-09 |
| 3 | 33-06 **Hub rules and transport edits** | `needs-update` (append and session), per-entry `blob-missing` (hub and client), `restoring` mode with marker, session `features` announce, `HubTransport.postPresence`, `hubSync` mapping for `restoring` and `needs-update` and the new retry refusal, optional start-from-base, relay README step | `hub/src/append/checks.ts`, `hub/src/http/routes.ts`, `hub/src/http/session.ts`, `hub/src/restore.ts`, `hub/src/main.ts`, `hub/src/stateDir.ts`, `src/domain/replica/hubFile.ts`, `src/staff/replica/hubTransport.ts`, `src/staff/replica/hubSync.ts`, `relay/README.md` (all changed), hub tests | 33-02 | POST-01, MUS-09 |
| 3 | 33-07 **Live projector, compactor, hub address store** | `liveProjection.ts` (write product files from the fold for unbound products, last-projected rule), `compactor.ts`, `hubAddress.ts`, `projection.ts` last-projected change | `src/staff/replica/liveProjection.ts`, `compactor.ts`, `hubAddress.ts`, `projection.ts` (changed), tests | 33-01 | MUS-09 |
| 4 | 33-08 **Full LiveReplicator** | Nine states, back-off, hub address, event handling, witness mapping with user-word sentences, join-request fetch, lead `ensureRequireArmed`, resume detection, optional lease, presence loop skeleton | `liveReplicator.ts`, `syncMachine.ts`, `hubLive.ts`, `staffSyncStatus.ts` (all changed or new), tests, `hub/test/liveReplicator.test.ts` | 33-06, 33-07 | MUS-09 |
| 4 | 33-09 **Share with people** | The setup step, preview aliases hidden, hub commands (connect, grant with the trade-off sentence, revoke, re-admit, change address), open-invitation language activation, retiring the preview switch (deprecated setting), "Show others what I am working on" in `settings.ts` | `src/services/staffShare.ts`, `staffHubCommands.ts`, `src/services/staffCommands.ts` (changed: one registration call), `src/services/settings.ts` (changed), `package.json` (changed: commands, `languages`, setting text, palette `when`), `staffMultiUserManifest.test.ts`, `staffMultiUserCommands.test.ts` (changed) | 33-02, 33-07 | MUS-09 |
| 5 | 33-10 **Presence, cursors, who wrote this** | `presence.ts` (seal, open, schema), replicator presence send and receive, cursor decorations with names, opt-out | `src/domain/replica/presence.ts`, `src/staff/replica/livePresence.ts`, `src/services/staffPresenceView.ts`, tests | 33-03, 33-08 | MUS-09 |
| 5 | 33-11 **Staff Room live and status word** | `staffRoomLive.ts` model, page script, message union and handlers, offline banner, contested cards, N changes since, join-request and roster-split cards, status bar word | `src/domain/staff/staffRoomLive.ts`, `media/staffRoom/staffLive.js`, `src/domain/staff/staffRoom.ts` (changed: union), `src/staff/staffRoomHost.ts` (changed), `src/services/staffRoomPanel.ts` (changed), `src/services/gateStatusBar.ts` (changed), `src/services/gateCommands.ts` (changed: line ~332), tests | 33-04, 33-08, 33-09 | MUS-09 |
| 6 | 33-12 **Scenarios and leak test** | Two- and three-person scenarios, contested and late joiner, label leak with presence over the hub, CI step | `src/test/staffLiveScenario.test.ts`, `hub/test/liveScenarios.test.ts`, `hub/test/liveLeak.test.ts`, `.github/workflows/ci.yml` (changed, gate) | all earlier | MUS-09 |
| 6 | 33-13 **Docs** | README section replacing the single-machine sentence, SECURITY.md section, `relay/README.md` hub sentences, CHANGELOG Unreleased, docs test | `README.md`, `SECURITY.md` (gate path), `relay/README.md` (changed in 33-06 earlier; docs only here after), `CHANGELOG.md`, `src/test/staffLiveDocs.test.ts` | 33-09, 33-11 | MUS-09 |
| 7 | 33-14 **Close-out** | Tighten copy-lint and architecture baselines, full suite, e2e, `verify:release`, secret scan, verification record, UAT sheet; open the release PR `release/0.4.36` with `prepare-release` and the `release` skill, green and unmerged | baselines, `.planning/phases/33-.../33-VERIFICATION.md`, release branch files | all | MUS-09, POST-01 |

**Tracer-first meaning here:** 33-01 lands the thinnest end-to-end path before anything else, and its test (`staffLiveTracer.test.ts`) stays in the suite and grows into the scenarios of 33-12. If the child-process route is blocked locally (no Node 26 on `PATH`), 33-01 falls back to the in-process hub in `hub/test` with `memoryReplica` for the transport half and the fake transport for the fold half, and 33-12 restores the real-hub scenario with the CI step.

**Parallelism notes (global rule):** wave 2 has four independent plans (distinct files, no shared database or port); use one git worktree per plan from the integration branch HEAD, scratch store folders per test, and merge back before wave 3. Wave 3's 33-06 and 33-07 are independent. Run the heavy suites once, in 33-14.

## Sources

### Primary (HIGH confidence): read in the worktree this session
- `.planning/phases/33-live-multi-user-staff-projects/33-CONTEXT.md`; `.planning/REQUIREMENTS.md` (MUS-09, POST-01); `.planning/STATE.md`; `.planning/ROADMAP.md` (Phase 33, drop A notes, line 150-152, 262-277)
- `.planning/research/multiuser-sync/DESIGN.md` sections 5.2 to 5.4, 6.2 to 6.4, 10.4, 10.5, 15.3 to 15.5, 17, 18, 19, 21, 22
- `.planning/research/portfolio-and-assignment/DESIGN.md` 3.9, 10.2 (POST-01 text)
- `.planning/research/coherence/GLOSSARY.md` sections 1 to 4
- `.planning/phases/32-your-organizations-sync-hub/32-REVIEW.md` (WR-06, WR-07, IN-02, IN-06, Resolution), `32-VERIFICATION.md`; `.planning/phases/41-.../41-CONTEXT.md` (D-12, D-50)
- Code: `src/staff/replica/{hubTransport,hubSync,hubMembership,replicaProject,store,migrate,projection,labelCells}.ts`, `src/domain/replica/{kinds,roster,rosterMembers,verify,fold,doc,clientIds,textFold,attribution,versions,hubFile,hubWitness,transport,checkpoint}.ts`, `kindSchemas/{roster,versions,doc}.ts`; `hub/src/{append/checks,append/rosterCache,http/routes,http/session,join,limits,live/presence,nodeVersion,main,bin}.ts`; `hub/test/{restoreDrill,ciphertextOnly,clientSync,workspace}.test.ts` and helpers; `src/services/{staffRoomPanel,staffMultiUserCommands,setupSteps,gateStatusBar,gateCommands,staffCommands,settings}.ts`; `src/staff/{staffHost,staffRoomHost}.ts`; `src/domain/staff/{staffRoom,commands}.ts`; `src/domain/org/terms.ts`; `src/domain/gate/{trust,labels}.ts`; `src/test/{architecture,copyLint,gateDocs,replicaBoundaries,staffMultiUserManifest}.test.ts` and helpers; `scripts/{run-tests,prepare-release,verify-release-content,vendor-libs,crdt-vendor}`; `package.json`; `.github/workflows/ci.yml`; `.claude/commands/release.md`; README.md and SECURITY.md sections named above; `relay/README.md`.
- `node_modules/@types/vscode/index.d.ts` (1.101.0) and `node_modules/yjs/dist/src/index.d.ts` (13.6.33), read through the worktree's `node_modules` link.

### Secondary (MEDIUM confidence): official documentation fetched this session
- https://code.visualstudio.com/api/references/activation-events (contributed languages and commands need no activation event from 1.74)
- https://code.visualstudio.com/api/references/when-clause-contexts (custom context keys through `setContext`)
- https://github.com/yjs/y-codemirror.next/blob/main/src/y-sync.js and `.../y-undomanager.js` (pattern, MIT)
- https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js (pattern, MIT)
- Memory note `cap-test-memory` (the exact capped-run wrapper)

### Tertiary (LOW confidence)
- None used as authority; items tagged `[ASSUMED]` are in the Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, nothing new and every pinned version read from the repository.
- Architecture and API facts: HIGH, each claim read from source this session with file and line.
- Hidden scope findings (F1 to F14): HIGH on the evidence, MEDIUM on the recommended fixes (several are one-way doors the owner should confirm).
- Pitfalls: MEDIUM, from the code and the pattern sources; the editor-event ordering ones are `[ASSUMED]`.

**Research date:** 2026-11-21
**Valid until:** 2026-12-05 (the base moves with Phases 32.1, 32.2 and 44 building in parallel; D-01 requires each plan to re-read the names it relies on before starting).






---

## Native Theia re-aim (2026-11-23)

**Scope:** only what the re-aim adds: the Monaco and Yjs binding inside Theia, the Theia JSON-RPC push for document changes, presence decorations in Monaco, and session-key certification with OpenBao Transit. The engine findings above (F1 to F14) still apply. Decisions: `33-CONTEXT.md`, "Re-aim to native Theia" (D-50 to D-68).
**Marking:** **[verified]** means read in source or docs during this research. **[verify]** means the executor confirms it against Theia 1.77.0's installed sources before relying on it.

### N1. What carries over unchanged

- These files are host-neutral and need no change for Theia: `src/staff/replica/*`, `src/domain/replica/*`, `src/domain/staff/*`, `staffHost.ts`, `versionActs.ts`, `contested.ts`, `hubAddress.ts`, `compactor.ts`, and `src/services/staffSyncStatus.ts`. Only `staffEditorBinding.ts` and `staffMultiUserCommands.ts` import `vscode`.
- The 33-04 `BoundDocument` (`editorBinding.ts` lines 11 to 25) has four members: `version`, `getText()`, `applyEdits(edits, expectedText, baseVersion, lineEndings?) => Promise<boolean>` and `onDidChange(listener)`. Its changes carry `edits`, `text`, `version` and an optional `reason: 'undo' | 'redo'`.
- Because `applyEdits` is asynchronous and checked against a version, the core already tolerates a document that lives across a process boundary. That is what makes D-53 possible without changing the core.
- `PayloadSigner.sign(bytes)` is synchronous (`src/domain/team/signedPayload.ts:58`). Transit signing is an HTTP call, so the person-key path needs an asynchronous variant (D-60). Session keys keep the synchronous path.
- Yjs client ids are `clientIdOf(slot, counter)` with a 12-bit slot and a 20-bit counter, and `nextClientId(slot, used)` avoids ids already in use (`clientIds.ts`). Session writers can therefore take their certifying device's slot from `session.certify` and stay collision-free, as long as `used` is built from the folded document.

### N2. The Yjs pattern, from y-monaco (MIT; pattern only, no code copied)

- **[verified]** y-monaco listens to `monacoModel.onDidChangeContent`. It sorts the changes right to left by `rangeOffset` and applies delete `rangeLength` then insert `text` inside one Yjs transaction.
- Remote changes come from a `ytext.observe` delta and are applied with `monacoModel.applyEdits`, never `pushEditOperations`, so they add no undo stop. A non-reentrant mutex suppresses the echo.
- Selections are saved as Yjs relative positions before remote transactions and restored with `setSelection` afterwards.
- Remote cursors are decorations with `className` for the selection, and `afterContentClassName` or `beforeContentClassName` for the caret, refreshed with `deltaDecorations`.
- The 33-04 core already follows all of this with an origin object in place of a mutex, in the backend. The frontend half only has to forward Monaco's change events faithfully and apply edits without undo stops.

### N3. Monaco inside Theia 1.77

- **[verified, master]** `MonacoEditorModel` (`@theia/monaco/lib/browser/monaco-editor-model`) exposes:
  - `onDidChangeContent` with `contentChanges: { range, rangeOffset, rangeLength, text }[]`;
  - `get version()` returning `model.getVersionId()`;
  - `get textEditorModel()`, the Monaco `ITextModel`;
  - `readOnly` and `onDidChangeReadOnly` from the resource, and `save()`, `onModelWillSaveModel` and `onDidSaveModel`.
- Its own `applyEdits` is protected. Use `textEditorModel.applyEdits(...)` directly. Theia's change event has no `isUndoing` or `isRedoing`, but Monaco's own `ITextModel.onDidChangeContent` carries `isUndoing` and `isRedoing`, so `MonacoBoundDocument` listens on `textEditorModel` **[verify in 1.77]**.
- **Save:** a bound product's text equals `Y.Text` after a flush, so Theia's save writes what the projection would write. The live projector (33-06) treats a file equal to the last bound text as projected, so a save is never a conflict. `onModelWillSaveModel` flushes the binding before saving (D-17).
- **Opening:** the frontend watches `EditorManager.onCreated` and asks the backend whether the editor's URI is a product of an open shared project. Only then does it attach. Models that are not bound are left alone (MUS-06 parity).

### N4. Undo and redo in Theia

- **[verified, master]** `CommandRegistry.registerHandler` puts a new handler first (`handlers.unshift(handler)`; "the given handler is registered as more specific, and has higher priority"). `getActiveHandler` returns the first enabled handler.
- A Sterling handler for `core.undo` and `core.redo`, enabled only when the focused editor's model is bound, therefore wins over Theia's. The keyboard path goes through Monaco's own `undo` and `redo` keybindings inside the editor, so the frontend also adds a Monaco editor action or a keybinding override with a context key, `sterlingStaffBoundEditor`, for the focused bound editor **[verify which path Theia 1.77 uses for Ctrl+Z inside Monaco]**.
- The test asserts that native undo of a bound model never runs, whichever path the key takes.

### N5. Pushing document changes over Theia JSON-RPC

- **[verified, master]** `RpcProxyFactory.isNotification` treats any method whose name starts with `notify` or `on` as a notification, so no reply is awaited.
- `RpcConnectionHandler(path, proxy => target)` hands the backend a proxy of the frontend's client object. The frontend's `ServiceConnectionProvider.createProxy(path, client)` sets that client (`setClient`).
- Phase 46-01's `bindBackendService(bind, id, path, make)` builds `new RpcConnectionHandler(path, () => ctx.container.get(id))` and ignores the client. D-52 adds one optional `withClient(service, client)` callback to that helper, and the service keeps a set of clients, so no second helper is built.
- The channel's methods:
  - Backend to frontend: `onApplyEdits(docId, edits, baseVersion, requestId)`, `onPresence(docId, cursors)`, `onAttribution(docId, ranges)`, `onStatus(status)`, `onNotice(text)`.
  - Frontend to backend: `attach(uri)`, `changed(docId, edits, version, textHash, reason?)`, `applied(requestId, ok)`, `fullText(docId, text, version)`, `undo(docId)`, `redo(docId)`, `selection(docId, ranges)`, `detach(docId)`.
- The protocol sends a hash, not the text, on each change (D-53): the backend mirror applies the edits to its copy and checks a SHA-256. On a mismatch it requests `fullText` once.
- A dropped connection detaches that client's documents. On reconnect the frontend calls `attach` again, and the backend answers with the full current text. This is the binding's resync path, logged once.

### N6. Presence decorations

- Monaco `IModelDecorationOptions` offers `className`, `beforeContentClassName`, `afterContentClassName`, `hoverMessage`, `linesDecorationsClassName` and injected text (`before` and `after`, whose `content` is plain text) **[verify that the Monaco build in Theia 1.77 has injected text; if not, the name is shown only in `hoverMessage` and the Staff Room people list]**.
- Colours come from 8 fixed CSS classes using theme variables. A person's slot is their index among the product's people. No name or colour value is generated into CSS (T-33-N3).
- The send and receive limits from D-18 (at most 10 per second, never stored) run in the backend `livePresence` (33-12). The frontend only draws what it is sent.

### N7. Session keys certified through OpenBao Transit (P6, P7)

**[verified]** OpenBao Transit API (`website/content/docs/api/secret/transit.mdx`):
- `POST transit/sign/:name` takes `input` (base64), an optional `key_version` and `batch_input`. Ed25519 ignores `hash_algorithm`.
- Signatures come back as `vault:v<version>:<base64>`. 46-07 already strips the prefix.
- The key types are AES-GCM, ChaCha20-Poly1305, XChaCha20-Poly1305, ed25519, ECDSA P-256/384/521, RSA, ML-DSA 44/65/87, hmac and external keys. There is **no X25519 or ECDH** (D-61).
- Rotation makes a new key version with new key material. A rotated person key is therefore a new public key, so Phase 47's rotation runbook must be followed by `device.rotate` in each project. Owner note: rotation stays an operator action. The workbench never rotates keys (46-07).
- `transit/sign` with step-up runs through the `sterling-workbench-stepup` jwt role (46-07, 47-07). Every person-key signature therefore needs `auth_time` inside the step-up window.
  - **At session start** the sign-in has just happened, so certifying the session key needs no extra prompt.
  - **For decisions** the decision dialog starts the step-up if the window has passed (46-02 `stepUpUrl`). The Staff Room says "Confirm with your passkey or security key" and acts after the person returns.

**The certificate** (D-62):
- `session.certify` is an entry. It is not a header field, because the header format is permanent and verified by every hub and client.
- It sits in the project stream in the roster cell, which the hub can read. The hub folds it into its roster cache next to the roster line, but it never advances the line.
- Its writer is the person device, through Transit. Its data is `{ member, device, sessionKey, slot, notAfter }`, and `sessionKey` becomes a writer id with its own chains.
- **Fold:** verify the entry's header signature with the certified key, then check the certificate's signer against the roster at the entry's cited roster hash. The fold uses no clock.
- **Hub:** on append and on session auth, refuse a session writer without a known certificate (`unknown-writer`, held as today) or with `notAfter` in the past (new refusal `session-expired`, not retryable, with "Your session key has ended. Sign in again."). Refuse a person-key kind from a session writer (`person-key-required`).

**Threats this closes:**
- A stolen session key works only until `notAfter` at the hub, and never for decisions or roster changes.
- A session key cannot change the roster.
- Revoking the person device ends every session key it certified.
- Long-term private keys never enter the session. The X25519 key and opened epoch keys do enter backend memory (unavoidable without ECDH in Transit), but they are never written to the volume in plain form.

### N8. Pitfalls added by the re-aim

1. **Two binders on one document:** the compatibility host runs the VSIX in the same image. If the extension ever attached its 33-19 adapter, two bindings would write the same product. D-64 adds a guard and a test.
2. **Version races across the process boundary:** a frontend edit can arrive between the backend's `applyEdits` request and its application. The version check in `MonacoBoundDocument.applyEdits` returns `false`, and the core retries. Never apply against a different version.
3. **Multiple tabs:** two tabs of one session have two Monaco models of the same product. `EditorBinding.open(document, product, hooks)` binds exactly one document, and each binding opens its own `ProductEditor` (checked on the integration branch). Two bindings of one product in one backend would compete for client ids under one writer. So the backend keeps **one binding per product per session**. The first tab to attach edits. Another tab's model is set read-only with the notice "This product is open for editing in another tab of your session.", and it takes over when the first tab detaches. The same rule covers two editors of one product in one tab.
4. **Step-up inside a modal:** step-up leaves the page through the identity provider. The decision dialog keeps its stamp (D-24) in the backend for the step-up window, so returning to the page resumes the same decision or refuses with the "changed while deciding" sentence.
5. **Bundle bloat:** the engine bundle is backend-only. A test asserts that no `yjs` and no `src/staff/replica` module reaches the frontend bundle (D-51).

### N9. Validation for the native plans

| Behaviour | Test | Where |
|---|---|---|
| Remote edits apply without an undo stop and only at the expected version | unit with a Monaco `ITextModel` created headless (`monaco-editor-core` from Theia's deps) or a fake that matches the interface | `workbench/test/staff/monaco-bound-document.test.ts` |
| Channel hash mismatch asks for the full text once | unit, backend mirror | `workbench/test/staff/remote-bound-document.test.ts` |
| Bound undo never runs native undo | unit, command registry with both handlers | `workbench/test/staff/bound-undo.test.ts` |
| A session key cannot write a person-key kind; revocation stops session writers; expired at the hub | engine unit and hub test | `src/test/replicaSessionCertify.test.ts`, `hub/test/sessionCertify.test.ts` |
| Two people in two browsers co-edit, see names, decide with step-up, see contested | Playwright against two built containers, one hub, dev OpenBao | `workbench/test/e2e/staff-live.spec.ts` (33-30) |
