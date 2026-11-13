# Phase 27: Project state follows the project across interfaces and machines (0.4.20) - Research

**Researched:** 2026-11-13
**Domain:** VS Code extension (Node extension host): project-local encrypted state store, key management (data key, recovery code, scrypt), git plumbing sync to a dedicated branch, per-record merge, settings layering, resume card
**Confidence:** MEDIUM-HIGH (live source read this session and git plumbing proven in a sandbox; four design decisions need the owner, see Open Questions)

<user_constraints>
## User Constraints (from CONTEXT.md)

CONTEXT.md has no "Claude's Discretion" section. Its "Research flags for the planner" (7 items) are the discretion areas; they are answered below. Everything under Decisions is locked.

### Locked Decisions

- **D-01 Transport across machines: the project's own git remote.** State travels as an encrypted bundle on a dedicated branch of the project's remote (working name `near-ai/state`), never `main` and never mixed into work branches. No new service. The extension does all git work and reports in plain words (owner principle: users never need git).
- **D-02 The API key syncs, unlocked by a recovery code.** Turning sync on generates a high-entropy recovery code (not user-chosen) and shows it once. It is never stored or logged. A strong KDF turns it into the key that wraps the project data key and the NEAR AI key. A new device asks for the code once, then keeps an unwrapped copy in its SecretStorage. Tests cover a wrong code, a tampered bundle and a truncated bundle. This matches the owner's 2026-11-05 recovery-code decision for Team Mode.
- **D-03 Resume UX: a "Pick up where you left off" card.** It shows the last chat, the last run's state (finished, cut off, waiting), and the current GSD phase with its next step from `.planning/`. One click reopens the chat and panels. Nothing re-runs and nothing spends money. A cut-off run uses the existing PERF-05 resume path only when the person clicks.
- **D-04 Same-host first.** Per-project state moves into a git-ignored state home inside the project (working location `.near-ai/state/`, next to the existing `.near-ai/attachments` and `.near-ai/scratch`). Any editor that opens the folder on this machine reads and writes the same files. Cross-machine sync then only has to move that one folder's encrypted form.
- **D-05 Migration merges and never destroys.** On first activation of 0.4.20 each editor merges its own globalStorage data for the open project into the state home. The merge is by record id, idempotent, never overwrites a newer record and never deletes the source. Transcripts encrypted with an install-local key are re-encrypted under the project data key; the editor that holds the old key does this, so code-server's transcripts migrate when code-server next runs 0.4.20.
- **D-06 Model choices follow the project.** Comparison runs are stored in the project's state home, so Compare Models shows them in every interface. "Apply recommended" writes to workspace settings (or to project state read as a project-level default) instead of user settings. Choices already applied globally in one editor are offered for import into the project rather than silently copied.

- **D-07 Every thread keeps its full conversation history, with all messages, in every interface.** (Added by the owner 2026-11-13.) Every chat thread for the project, not only the last one, opens with its complete message history in any editor or on any machine: every user message, assistant reply and tool step, in order, exactly as the person saw them, with nothing summarised away, truncated or reduced to a title list. Where the model only saw a compacted context, the full original messages are still kept and shown. This covers threads from the panel chat and the `@near` chat participant. The participant's history inside VS Code's own Chat view belongs to the editor, so the extension keeps its own record of those turns in the state home. Migration (D-05) and sync (D-01) carry whole threads, and the per-record merge never drops a message from a thread that was continued on two machines.
- **D-08 History retention: the last 5 conversations stay fully live, the rest are archived and still retrievable.** (Added by the owner 2026-11-13.) By default the 5 most recently used threads per project are kept fully live, with every message, and open instantly. Older threads move to an archive inside the state home. They are never deleted. Archived threads stay listed, can be found and searched by title, and can be reopened with their full history on request. Reopening one makes it live again. A user setting (working name `nearAi.history.liveConversations`, default `5`) lets the person change how many threads stay live. The archive keeps the same encryption (D-02/SYNC-03) and is covered by migration (D-05). Whether the archive syncs across machines or stays local until it is asked for is a planner/research decision under flag 7 (size).
- **D-09 Everything synced to a git remote is end-to-end encrypted, and only the user can open it.** (Added by the owner 2026-11-13. This is a hard constraint and overrides any cheaper option in research flags 1 and 2.)
  - **Scope.** Every byte the extension pushes to the sync branch on GitHub (or any remote) is ciphertext that only the person who holds the recovery code, or an unlocked device of theirs, can decrypt. This covers conversations, archived conversations, run records, checkpoints, comparisons, model choices, spend history, the resume pointer and the wrapped NEAR AI key.
  - **No key escrow.** NEAR AI, the extension authors, GitHub, and anyone else with read access to the repo, including collaborators on a public or shared repo, cannot decrypt it. The extension keeps no server-side copy of keys.
  - **Metadata.** Nothing readable leaks through what surrounds the data either. Conversation titles, thread and record ids, model names and prompt text never appear in file names, paths, commit messages, branch names or git notes. File names are opaque, for example random or keyed-hash ids. Commit messages are generic, for example "Update encrypted project state". Sizes are padded and counts are hidden where practical; research picks the method.
  - **Authenticated encryption.** Encryption is authenticated (AEAD), so any tampering is detected and refused (SYNC-04).
  - **Anonymous commit identity.** (Owner, 2026-11-13.) Sync commits use a generic author and committer, not the person's git identity. Working value: name `near-ai-state`, email `state@near-ai.invalid`. Alternatively the identity can be a per-project opaque id that does not identify the person. Either way the commits are set through git environment or config flags on the sync commit only, so the person's own git config and their other commits are never touched. Commit timestamps may be coarsened (for example rounded to the hour) if research shows it is cheap. The leak test also asserts that the person's name and email do not appear in any sync commit.
  - **Private remote (specified now, deferred).** A per-project setting to push the sync branch to a different, private remote instead of the project's own remote (working name `nearAi.sync.remote`; default is the project's `origin`). The design must leave room for it: the remote is a parameter of the sync layer, never hard-coded to `origin`. Building the setting and its UI is deferred to a later phase. The bundle format and encryption are identical either way.
  - **Leak test.** The SYNC-05 leak test is extended. It scans the pushed tree, commit objects and messages for plaintext transcript text, titles, ids, keys and prompts, and fails on any hit.

Requirements: SYNC-01 to SYNC-08 (listed in the next block). SYNC-01 and SYNC-05 were amended by the owner on 2026-11-13 to cover D-07 to D-09.

### Claude's Discretion (the 7 research flags)

1. Public repositories: what ciphertext leaks (sizes, timestamps, record counts); recovery-code entropy; KDF choice and parameters (scrypt via Node built-in vs Argon2id as a new dependency); a per-project switch to a different (private) remote.
2. Bundle format: one encrypted file per record vs padded chunked bundles; append-only logs merged by id; deletion propagation (tombstones).
3. How sync runs git without disturbing the person's work: separate worktree or plumbing; offline operation, rejected pushes, remotes that need credentials.
4. SecretStorage in code-server: per browser profile; the device copy of the unwrapped data key must work with two browsers; the recovery code must cover a browser whose data was lost.
5. Overlap with the unmerged `feat/team-fix-pass` branch (Phases 60-67): design the state home so per-person subfolders can be added later; do not move Team Mode records.
6. Which globalState items become project state (saved-profile index, cyber model choice, Team Studio drafts, security-scan consent); some stay per device (emergency stop, reporting token id).
7. Size: code-server `checkpoints/` is 3.8 MB and `transcripts/` 11 MB; decide what syncs, what stays local, set limits.

### Deferred Ideas (OUT OF SCOPE)

- No NEAR AI hosted store and no VS Code Settings Sync (not available in code-server).
- Team Mode records and the shared team library are not moved. The team library (`teams/*.md`) stays per user; see flag 5.
- Live, in-flight runs are not handed between machines. Only finished or cut-off state syncs, and resuming always takes a click.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SYNC-01 | Project-local state home: every chat thread with full history (all messages, never truncated or summarised away; 5 live by default, older archived and reopenable), run records, checkpoints, comparison runs, applied model choices, spend history, resume pointer | "State home layout", "Store seams to rewire", gitignore self-ignore trick (verified), Patterns 11 and 12 (thread log, `@near` participant recording, archive, setting `nearAi.history.liveConversations`) |
| SYNC-02 | Safe one-time migration by record id, idempotent, never overwrite newer, never delete source | "Migration algorithm", Runtime State Inventory, pid-collision temp-file pitfall |
| SYNC-03 | Portable per-project data key, wrapped per device and by the recovery-code key | "Key hierarchy", Open Question 1 (how a second editor on the same host obtains the key) |
| SYNC-04 | Recovery code shown once, strong KDF, NEAR AI key carried wrapped, refusal of wrong/tampered/truncated bundle | "Recovery code and KDF" (160-bit Crockford code, scrypt N=2^17 with `maxmem`), AAD binding, atomic apply-after-verify |
| SYNC-05 | Encrypted sync over a dedicated branch, everything pushed is AEAD ciphertext with opaque names, generic commit message and anonymous identity, no key escrow, remote is a parameter (default `origin`), no touch of working tree/index/branch, per-record merge, leak test | Patterns 5 (D-09 bundle), 8, 13 (identity, hooks, push safety), 11 (thread merge), Validation Architecture leak test |
| SYNC-06 | Comparison results and applied choices visible and effective in every interface | "Model choices layering", "Comparison store union" |
| SYNC-07 | Pick up where you left off card | "Pick-up card", run-marker cross-editor liveness hazard |
| SYNC-08 | Release 0.4.20 with CHANGELOG, README | "Release" (docs/development-workflow.md, `/release` command) |
</phase_requirements>

## Project Constraints (from CLAUDE.md and standing rules)

No project `./CLAUDE.md` exists (verified: the repo root listing has none; `.claude/` holds only `commands/` and `worktrees/`). Directives that apply, from the user's global `~/.claude/CLAUDE.md` and memory index [VERIFIED: system-reminder context this session]:

- **Test memory cap (standing rule):** every test/node run is wrapped: `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 <command>`; one heavy run at a time; full suite or e2e uses MemoryMax=6G and timeout 1800. Never run uncapped `npm test` / `node --test`. [VERIFIED: ~/.claude/projects/.../memory/cap-test-memory.md]
- **Verification cadence:** smallest relevant unit/type/lint check after each edit; batch before broader suites; complete suite once at the phase/release boundary. Security, money, migrations, data integrity and architectural-boundary checks are immediately blocking when touched. Never delete/skip/weaken a failing test to get green. This phase touches migrations, data integrity, secrets and (spend history) money, so those checks block per task.
- **NEAR keys:** never delete or edit anything under `~/.near-credentials`. The sync code must never read or write it (it concerns NEAR *accounts*, not NEAR AI API keys; no overlap, stated so the planner does not touch it).
- **Naming:** say "your organization", never "NEAR organization"; NEAR AI is only the provider. Applies to every plain-words message in this phase.
- **No git knowledge required of users; protected main, squash PRs + agent-review gate, owner approves publish; no solo mode.** All git work reported in plain words.
- **Review loops: fix the class, not the instance.** Repeated agent-review findings of one class mean a heuristic boundary; replace with an invariant. Relevant to the three places this phase should use invariants instead of heuristics: liveness of a run (heartbeat, not pid), "is this state home ignored by git" (self-ignoring `.gitignore`, not a root-`.gitignore` edit), and merge (one deterministic rule, property-tested).
- **Branch names:** merge-pr rejects some prefixes (e.g. `perf/`); renaming a PR branch closes the PR. Use `feat/` for the work branch and `release/0.4.20` for the release.
- **Release process 0.4.x:** release PR via prepare-release, CI + auto review, merge-pr tags, owner approves publish; strict main ordering. [CITED: docs/development-workflow.md]

## Summary

The five stores the phase moves (transcripts, run markers, checkpoints, comparison runs, spend) all already write atomically as temp-file-plus-rename into a directory chosen by one constructor argument, so the same-host half (SYNC-01/02/06) is mostly a re-pointing job plus a migrator, not a rewrite. The real work is in four places the CONTEXT does not fully resolve: (1) **how a second editor on the same host gets the data key without a manual step** (code-server runs in a container whose `~` differs from the host's, so the project folder is the only shared medium; see Open Question 1), (2) **cross-editor liveness of runs** (the existing cut-off detection uses `process.kill(pid, 0)`, which is wrong across a container's pid namespace and would make desktop VS Code auto-resume a run that is live in code-server, spending money twice), (3) **portable identity** (project id, cyber store path and checkpoint file paths are all derived from the absolute folder path, which differs on the second machine), and (4) **the merge rule** (whole-file transcripts need a divergence rule so two machines continuing one chat lose nothing).

For sync, use **git plumbing in a private bare mirror repo** (the same design the unmerged Team Mode branch already uses on `refs/heads/near-ai/coordination`), writing an orphan-lineage commit of immutable, padded, AES-256-GCM-encrypted **segment files** with opaque names plus one small plaintext manifest holding the KDF salt and the wrapped data key. No new dependencies: Node built-ins only (`node:crypto` scrypt, HKDF, AES-GCM; `node:child_process` for git). Use **scrypt N=2^17, r=8, p=1 with `maxmem` raised** (Argon2 is not available in the Node 22 that VS Code 1.101 ships; adding a native or WASM package would be the phase's only new supply-chain surface for no real gain, because the recovery code is 160 random bits and cannot be guessed offline whatever the KDF). Sandbox runs in this session proved: a pre-push hook in the user's repo breaks a plain `git push` (so every call needs `-c core.hooksPath=` disabled), a fetch by remote name creates a visible `refs/remotes/origin/near-ai/state` branch in the user's repo (so the mirror is needed), and plumbing never changes `git status`, `HEAD` or the current branch.

**Owner additions (2026-11-13, D-07 to D-09):** the current `TranscriptStore` keeps only the model's compacted working list, so full history needs a new append-only, message-level **thread log** captured before compaction (Pattern 11); the `@near` participant persists nothing today and must be recorded by a stream wrapper with the thread id carried in `ChatResult.metadata`; archives are one brotli+AEAD file per thread, pushed as cold objects and fetched lazily through a partial-clone mirror (Pattern 12, verified against github.com); the bundle is random-named padded AEAD objects behind a sealed index with an anonymous commit identity, which a sandbox run showed `commit-tree` environment variables support cleanly (Patterns 5 and 13).

**Primary recommendation:** Build a `ProjectStateHome` (`.near-ai/state/`, self-ignoring via an inner `.gitignore` containing `*`), re-point the five stores at it, add a `StateKeys` (data key, scrypt-wrapped recovery blob) and a `StateSync` over a bare mirror with immutable padded AEAD objects (Pattern 5) and a deterministic merge (entry-level for threads); fix run liveness (heartbeat + writer identity) before any second editor can read markers; layer model choices as project state beneath explicit workspace settings; render the pick-up card with the existing `setup-nudge` pattern.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| State home read/write, migration, merge | Extension host (Node, `src/services` + pure `src/domain`) | Filesystem (project folder) | Needs `node:fs`/`node:crypto`; shared by all editors via the folder |
| Data key, recovery wrap, device copy | Extension host | SecretStorage (per editor/browser) | Key material never enters a webview; the webview only collects the code |
| Recovery code display / entry | Webview or input box (shown once) | Extension host (generates, never logs) | Code must not be stored; display is a one-shot VS Code modal or webview card |
| Git transport (mirror, fetch, push) | Extension host (`child_process` git) | Remote git host | Plain-words status; no UI in git tier |
| Model choices (applied) | Extension host settings layer | Project state file | Readers in `settings.ts` resolve explicit workspace setting > project choice > user setting > default |
| Pick-up card | Webview (`media/chat`) | Extension host (derives data) | Same pattern as `setup-nudge`; host decides, page renders and posts one action |
| Run liveness | Extension host (`RunMarkers`) | Filesystem heartbeat | Must not depend on pid namespaces |
| GSD phase / next step | Extension host reads `.planning/` | Git (the project's own commits carry `.planning/`) | `.planning/` already travels with the project; do not duplicate it into the bundle |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` (built-in) | Node 22 (VS Code 1.101 host) / 24 in dev | AES-256-GCM, scrypt, HKDF (`hkdfSync`), `randomBytes`, `timingSafeEqual` | Already used by `transcripts.ts` (AES-256-GCM) and the Team branch (HKDF); zero new supply-chain surface |
| `node:child_process` + system `git` (>= 2.x; 2.53.0 here) | git 2.53.0 [VERIFIED: `git --version`] | Plumbing: `hash-object`, `mktree`, `commit-tree`, `update-ref`, `fetch`, `push`, `ls-remote`, `cat-file`, `ls-tree` | Proven in sandbox this session; same approach as Team transport |
| `node:zlib` (built-in) | — | brotli q5 for thread archives and bundle objects | Measured 0.23 ratio, ~11 ms decompress on 5.3 MB [VERIFIED: ran this session] |
| `node:fs/promises` (built-in) | — | Atomic temp+rename writes, `readdir` scans, `appendFile` for thread logs | Every existing store already does this |
| `node:test` + `node:assert/strict` | — | Test runner (compiled to `dist/test`) | Existing convention [VERIFIED: package.json `test` script; src/test/profileStore.test.ts] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vscode` API: `SecretStorage`, `ConfigurationTarget`, `workspace.fs`/`FileSystemWatcher` | engines `>=1.101.0` | Device key copy, settings layering, optional live refresh | Host-only; keep crypto/merge pure and `vscode`-free so tests run under plain `node --test` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| scrypt (built-in) | Argon2id via `crypto.argon2` | `crypto.argon2` was added in Node v24.7.0 [CITED: https://nodejs.org/en/blog/release/v24.7.0]; VS Code 1.101 runs Electron 35 / Node 22 [CITED: https://issues.redhat.com/browse/CRW-9203, single source], so it is not available to the extension host. A npm Argon2 package adds a native/WASM dependency. Reject. |
| Bare mirror repo for sync | Plumbing inside the user's repo | In-repo objects are harmless, but a named-remote fetch creates `refs/remotes/origin/near-ai/state` shown by `git branch -a` [VERIFIED: sandbox run this session]. Use the mirror (precedent: Team transport). |
| One file per record on the branch | Padded immutable segments | Per-record files leak record count and (if named by id) creation time, because ids embed base36 timestamps (`conv-mw972e7s-...`). Use segments with opaque names. |

**Installation:** none. No package is added.

**Version verification:** no external package is recommended, so no `npm view` is needed. Dev tooling already pinned in `package.json` (`typescript ^5.7.2`, `@types/node ^22.10.0`) [VERIFIED: package.json devDependencies output]. `@types/node ^22` types do not include `crypto.argon2`, a second compile-time confirmation that Argon2 is out.

## Package Legitimacy Audit

No external packages are installed by this phase.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| (none) | — | — | — | — | — | — |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

If the planner is tempted to add an Argon2, git or crypto-helper package, that is a deviation from this research and would need a `checkpoint:human-verify` task plus the legitimacy check.

## Architecture Patterns

### System Architecture Diagram

```
 Editor A (code-server, container)          Editor B (desktop VS Code, host)
   extension host A                           extension host B
        |  writes                                |  writes
        v                                        v
 +------------------------------------------------------------------+
 |  <project>/.near-ai/state/   (self-ignored, SAME FILES for A and B)|
 |   meta.json   keys/  transcripts/  runs/  checkpoints/  comparisons/|
 |   choices.json  profile.json  spend/  pickup.json  sync/          |
 +------------------------------------------------------------------+
        ^  migrate-on-first-start (per editor, from its own globalStorage;
        |  re-encrypt old transcripts under data key; never delete source)
   <globalStorage>/{transcripts,runs,checkpoints,evals,spend}/...

 Sync (only when turned on; one machine at a time, debounced, idle-only):

 state home --collect records--> canonical records --pad+AES-GCM--> immutable segments
                                                                    |
   +------------- bare mirror (.near-ai/state/sync/mirror.git) -----+
   |  fetch +refs/heads/near-ai/state -> refs/near-ai/incoming
   |  verify: manifest tag, every segment tag, seq >= last seen   --fail--> refuse, state untouched, plain message
   |  merge per record (rev/basedOn rule, tombstones, fork on divergence)
   |  apply to state home atomically (temp dir + rename per file)
   |  hash-object -> mktree -> commit-tree (neutral identity, fixed date) -> push (no force)
   |        rejected (non-ff)? fetch again, merge, retry (max 5)
   v
 remote:  refs/heads/near-ai/state  = manifest.json (plaintext header: format, kdf, salt, wrapped data key; sealed body)
                                      + <32 hex>.bin ...  (brotli + padded + AEAD, random names; hot deltas, cold archives, index)

 Machine 2 (project cloned, different path):
   remote has near-ai/state? --> "Enter your recovery code" --> scrypt --> unwrap data key
   --> decrypt segments --> write state home, profile.json -> ProfileStore, API key -> SecretStorage
       under THIS machine's project scope (path-hash differs; see Pitfall 4)
```

### Recommended Project Structure

```
src/domain/state/            # pure, vscode-free, fully unit-testable
  records.ts                 # record kinds, canonical JSON, rev hash, basedOn rule
  merge.ts                   # deterministic per-record merge + tombstones + fork rule
  segments.ts                # pad / seal / open segments, manifest format, AAD builders
  recoveryCode.ts            # 160-bit Crockford base32 encode/parse (mirror of Team inviteCode format)
  keys.ts                    # data key, HKDF sub-keys, scrypt wrap/unwrap (maxmem raised)
  pickup.ts                  # derive card model from markers + transcripts + .planning/
src/services/
  stateHome.ts               # ProjectStateHome: paths, self-ignore, atomic write helper (random temp suffix)
  stateMigration.ts          # per-editor idempotent merge from globalStorage
  stateKeys.ts               # SecretStorage glue, device copy, local key file (if Open Question 1 = A/C)
  stateSync.ts               # mirror + git plumbing + sync loop + plain-words status
  stateGit.ts                # runGit (array args, timeouts, hooks disabled, redaction); same shape as Team GitRunner
  modelChoices.ts            # project-level applied choices (read by settings.ts)
  pickupCard.ts              # host side of the card (messages to media/chat)
media/chat/pickup.js         # card rendering, modeled on media/chat/setup.js
```

### Pattern 1: State home layout and the self-ignoring folder

**What:** `.near-ai/state/` with an inner `.gitignore` whose only line is `*`. Verified in a sandbox: with that file, `git status --porcelain` is empty and `git check-ignore -v .near-ai/state/t.json` reports the rule from the inner file. Do not rely on the root `.gitignore` (the existing `ensureScratch` only adds `.near-ai/scratch/` and `.near-ai/attachments/` and only for set-up projects).
**When to use:** the first time the state home is created, before any other file is written into it.
**Why it matters:** the state home holds transcripts (encrypted, but still never to be committed to `main`) and, under Open Question 1 option A/C, a local key file. The invariant "nothing in `.near-ai/state/` can ever be staged" must not depend on a heuristic about the project's `.gitignore`.

Existing values the layout sits next to, read this session:

```
// [VERIFIED: src/domain/scratch.ts:16]
export const SCRATCH_IGNORE_LINES: readonly string[] = Object.freeze(['.near-ai/scratch/', '.near-ai/attachments/']);
```

Also add `.near-ai/state/` to `SCRATCH_IGNORE_LINES` as a belt-and-braces second line (the existing `gitignoreAdditions` already treats a bare `.near-ai` rule as covering everything), but the inner `.gitignore` is the invariant.

### Pattern 2: Per-store seam (what to re-point)

All of these take their directory from one argument, so the change is small:

| Store | Today | After |
|-------|-------|-------|
| `TranscriptStore(storageDir, root, key)` (becomes the thread store of Patterns 11 and 12; `prune()` removed, `list()` replaced by the index) | dir = `<global>/transcripts/<sha256(path.resolve(root))[0:16]>`; called in `chat.ts` `conversationFor`, `extension.ts` `showHistory` | dir = `<state>/transcripts`; key = data key; **`list()` must surface undecryptable files as "locked", not drop them** (see Pitfall 7) |
| `RunMarkers(storageDir, root)` | `<global>/runs/<hash16>/<conv>.json` via `runMarkersFor` in `chat.ts` | `<state>/runs/`; add writer identity and heartbeat (Pitfall 1) |
| `AgentConversation(..., path.join(storage,'checkpoints'), ...)` → `RunCheckpoints(runId, storageDir)` | flat `<global>/checkpoints/<runId>.json`, **not per project**, absolute paths inside | `<state>/checkpoints/`; store root-relative paths (version 2), see Pitfall 5 |
| `ComparisonStore(<global>/evals)` | global, shared across projects; also read by `teamStudioPanel.ts` (2 sites) | union read of `<state>/comparisons` and `<global>/evals`, write to both; see Pattern 7 |
| `SpendLedger` | per **key identity** (`spend/<hash>/<yyyy>-<mm>.jsonl`), entries tagged `proj` | project mirror of entries with this project's tag; history only (Open Question 4) |
| `ActivityStore(root)` | already project-local: `.planning/.near-ai/activity.json`, whole-file rewrite | **already shared by two editors on one host with last-writer-wins; add read-merge-write by session id** (Pitfall 6) |
| `ProfileStore(root)` | already project-local metadata `.planning/.near-ai/auth-profiles.json`; keys in SecretStorage | profile metadata record travels in the bundle; keys re-stored under the local scope on restore |

### Pattern 3: Key hierarchy

```
DK  = 32 random bytes per project ("project data key"), created once, never derived from the code
DK -> HKDF-SHA256(info="near-ai/state/v1/transcripts") = transcript key   (state-home files at rest)
DK -> HKDF-SHA256(info="near-ai/state/v1/segment")     = segment key      (bundle)
DK -> HKDF-SHA256(info="near-ai/state/v1/manifest")    = manifest-MAC key (authenticated manifest list)
RC  = 160-bit recovery code (Crockford base32, 32 chars), shown once, never stored
KEK = scrypt(RC, salt(16+ random bytes, in manifest), N=2^17, r=8, p=1, maxmem=256 MiB) -> 32 bytes
wrapped DK   = AES-256-GCM(KEK, iv, DK,  aad="near-ai/state/v1|wrap|<stateId>")      (in manifest.json)
device copy  = DK in SecretStorage under "nearAi.state.<stateId>.dataKey"           (per editor/browser)
```

Why one data key and not a separate wrap for the API key: the API key (and its bound endpoint) is just an encrypted record inside the segments, so it is covered by DK, which the code wraps. D-02's "wraps the project data key and the NEAR AI key" is satisfied transitively and rotating the recovery code only re-wraps DK. Bind every ciphertext to context with AAD (state id, purpose, segment id) so blobs cannot be swapped between purposes or projects.

### Pattern 4: Recovery code and KDF (research flag 1)

- **Entropy:** reuse the Team Mode invite format: 160 random bits, 32 Crockford base32 characters, shown as `XXXX-XXXX-...`, tolerant parser (I,L as 1; O as 0) [VERIFIED: `git show feat/team-fix-pass:src/team/inviteCode.ts` read this session: `INVITE_CODE_BYTES = 20`, `CODE_CHARACTERS = 32`, `ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'`]. 160 bits cannot be searched offline whatever the KDF; the KDF is defense in depth. Copy the ~40 lines into `src/domain/state/recoveryCode.ts` (the Team branch is unmerged); dedupe when it merges.
- **KDF:** scrypt N=2^17, r=8, p=1. OWASP lists this as the minimum when Argon2id is unavailable [CITED: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html, via a search summary of the page; confirm wording when writing the plan]. Node's default `maxmem` (32 MiB) rejects it: `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` [VERIFIED: ran `scryptSync('x','y',32,{N:2**17,r:8,p:1})` in this session]; pass `maxmem: 256 * 1024 * 1024`. Measured 307 ms and ~128 MiB transient on Node 24 [VERIFIED: ran this session]. Store `{ name: 'scrypt', N, r, p, salt }` in the manifest so the parameters can be raised later without a format break.
- **Wrong code:** AES-GCM tag failure on the wrapped DK is the only signal; map it to one plain message ("That recovery code is not right. Nothing was changed."). Do not distinguish wrong code from tampered manifest at this step (it cannot be distinguished cryptographically).

### Pattern 5: Bundle format that meets D-09 (flags 1 and 2; supersedes any file-per-record option)

D-09 is a hard constraint: everything on the branch is AEAD ciphertext, with no readable titles, ids, model names or prompts in file names, paths, commit messages, branch names or notes, and sizes/counts hidden where practical. A file-per-record layout fails it, even with keyed-HMAC names: a name that reappears in a later commit reveals "this record changed", and the number of names reveals the record count. Use **padded, compressed, AEAD-sealed objects with random names, found only through a sealed index**.

**Primitives (all `node:crypto` / `node:zlib`, no new package):**

| Need | Choice | Notes |
|------|--------|-------|
| AEAD | AES-256-GCM, 96-bit random IV, 128-bit tag, AAD binds context | Already the repo's cipher [VERIFIED: src/services/transcripts.ts:11 `type Envelope = { enc: 'aes-256-gcm'; ... }`]. ChaCha20-Poly1305 is also built into `createCipheriv`; no reason to switch. |
| One key per object | `hkdfSync('sha256', DK, salt = 16 random bytes stored in the object header, info = 'near-ai/state/v1/object', 32)` | Each key encrypts exactly one message, so the random-IV birthday bound never applies; also separates purposes |
| Password KDF | scrypt N=2^17, r=8, p=1, `maxmem` 256 MiB (Pattern 4) | Applied once, to the recovery code |
| Compression | `zlib.brotliCompressSync`, quality 5, applied **before** padding and encryption | Measured on 5.3 MB of source-like JSON: brotli q5 ratio 0.230, 105 ms compress, 11 ms decompress; gzip-6 ratio 0.269, 100 ms / 15 ms; AES-GCM 2 ms [VERIFIED: ran this session; real transcripts may compress differently]. Compress-then-encrypt is safe here because nothing an attacker controls is mixed into the plaintext and sizes are bucketed. |
| Opaque names | 128 random bits as hex, `<32 hex>.bin` | Not derived from any id |

**Tree on `refs/heads/near-ai/state`:** a flat tree, no subdirectories, containing exactly `manifest.json` and `<32 hex>.bin` objects (the leak test asserts this with the regex `^(manifest\.json|[0-9a-f]{32}\.bin)$`).

- `manifest.json` is the only plaintext file and must be, because a new device needs it to derive the key: `{ format: 1, stateId (random, not derived from the path or name), kdf: { name: 'scrypt', N, r, p, salt }, wrappedKey: {iv, tag, data}, sealed: {nonce, iv, tag, data} }`. `sealed` decrypts to `{ seq, objects: [{ file, bytes, sha256, class: 'hot'|'cold'|'index', part?, of? }], indexFile }`. Verifying `sealed` first means a removed, swapped or truncated object is detected before anything is applied (SYNC-04).
- **Object envelope:** `magic | version | objectSalt(16) | iv(12) | tag(16) | ciphertext`; plaintext = `u32 true length | brotli(JSON) | pad`. AAD = `near-ai/state/v1|<stateId>|<class>` so an object cannot be moved between purposes or projects.
- **Padding (Padme-style):** round the plaintext length `L` up to a multiple of `2^(floor(log2 L) - 3)` with a floor of 64 KiB; overhead at most 12.5% (8 buckets per octave). Payloads over 8 MiB are split into 8 MiB parts, each padded, listed in the sealed manifest. Pad with random bytes inside the AEAD. [ASSUMED: parameters; the technique is the published Padme padding for reducing length leakage]
- **Object classes:** `hot` = delta segments (records changed since the last push, never rewritten); `cold` = one archived thread each (Pattern 12); `index` = the encrypted thread index (titles, times, counts, where each thread's objects are), so a new machine can list every thread, including archived ones, after reading only the manifest and the index.
- **Commit:** one parent chain; message the constant `Update encrypted project state`; author and committer `near-ai-state <state@near-ai.invalid>` set only through `GIT_AUTHOR_*` / `GIT_COMMITTER_*` environment variables on the `commit-tree` call; both dates the constant `2000-01-01T00:00:00Z` (coarsening to a constant is free, so do that rather than rounding to the hour). Optionally squash the history to one root commit when commits exceed ~100 (see growth below).
- **Same layout for a private remote.** The bundle and encryption do not change with the remote (D-09).

**What still unavoidably leaks, and how it is minimised** (state this in the sync-on dialog and README in plain words):

| Leak | Who sees it | Minimisation |
|------|-------------|--------------|
| That this project uses NEAR AI state sync (branch name `near-ai/state`, manifest shape) | anyone who can read the repo | Accept; the branch name is generic and carries no project data |
| Total size, to within a bucket (about 12.5%) | anyone who can read the repo | Padme padding; objects over 8 MiB split; a floor of 64 KiB |
| Number of objects | same | Delta objects are small and few; consolidate to a handful of ~8 MiB parts at compaction so the count tracks size, not record count |
| Push times and number of commits | same, and the git host regardless | Constant commit date hides in-commit time but not the host's push event; debounce pushes (run end, idle, manual) so cadence says "active", not "which chat"; optional squash to one commit lowers visible commit count |
| That the person pushed from some IP/account | git host | Not controllable by the extension |
| The remote's access list and the URL | repo | Not applicable |

The recovery code is 160 random bits, so a public ciphertext cannot be searched offline; scrypt adds cost per guess as defence in depth. There is no key escrow: the data key exists only wrapped by the recovery code and in each device's own storage.

**Growth and compaction:** each sync adds hot objects, which stay in history. When hot objects exceed ~20 or twice the live size, a machine writes consolidated objects and a new tree that omits the old ones; history keeps the old objects (accepted). If a hard cap is wanted, a rare orphan rewrite pushed with `--force-with-lease=refs/heads/near-ai/state:<expected oid>` is possible because the merge reads only the tip tree; other machines then accept any tip whose authenticated `seq` is not lower than the last they saw. Keep the rewrite out of v1 unless size testing demands it, and never use it on a branch the host protects. [ASSUMED]

### Pattern 6: Records, merge and tombstones (the "no lost entries" rule)

Record kinds in objects (threads use the entry-level model of Pattern 11, not whole-record merge): `transcript` (legacy/context only), `marker`, `checkpoint`, `comparison`, `choice`, `profile`, `secret`, `spend`, `pickup`, `tombstone`. Every record: `{ kind, id, rev, basedOn?, at, writer, body }` where `rev` = first 16 hex of sha256 over canonical JSON of `body`, `basedOn` = the `rev` the writer started from.

Deterministic merge for one `(kind,id)` given local L and remote R:

1. `L.rev === R.rev`: same, keep.
2. `R.basedOn === L.rev`: remote is a descendant, take R. `L.basedOn === R.rev`: keep L.
3. Neither (divergent edit on both machines): keep the newer by `at` (ties: lexicographically larger `writer`) under the original id, and keep the other as a **fork** under a new id derived from `sha256(id + rev)` with title suffix "(from another computer)". Nothing is dropped.
4. `tombstone(kind,id,at)` wins over a record only if `tombstone.at > record.at`; otherwise the edit resurrects it (an edit after a delete on another machine is newer information).
5. Append-only logs (`spend`, activity sessions) merge as a union keyed by their own ids; the existing spend format is already id+version-mergeable [VERIFIED: ledger records carry `id` and `v` fields, read this session].

Merge must be commutative, associative and idempotent; that is the property test. **Retention (superseded by D-08):** `TranscriptStore` pruned to `MAX_TRANSCRIPTS = 50` [VERIFIED: src/services/transcripts.ts:6 `const MAX_TRANSCRIPTS = 50;`]. D-08 removes the prune: threads are archived, never deleted, so there are no thread tombstones and no retention horizon in the merge (the churn this would have caused is avoided by design).

### Pattern 7: Comparison store union and model choices layering (SYNC-06, D-06)

- Comparison runs today are global and shared across projects by design [VERIFIED: src/benchmark/store.ts header: "Shared by every project: a model's ability does not depend on the folder it was tested from"]. D-06 wants them in the project's home. Recommend **union read, dual write**: a `ComparisonStore` taking an ordered list of dirs, listing `<state>/comparisons` ∪ `<global>/evals` de-duplicated by run id (`RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/` [VERIFIED: src/benchmark/results.ts:92]); new runs write to the state home (authoritative for sync) and to global (so other projects on this editor keep reusing results at no cost). `teamStudioPanel.ts` lines 55 and 182 construct their own `ComparisonStore` on the global dir and must switch to the same helper. [ASSUMED: dual write is the right trade-off; confirm with the owner]
- **Applied choices:** today `applyRole`/`applyRecommended` write `ConfigurationTarget.Workspace` when the project already sets the value, else `ConfigurationTarget.Global` [VERIFIED: src/services/modelComparisonPanel.ts:264 and :301 `const target = inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;`]. Writing `Workspace` instead would create or edit the project's `.vscode/settings.json`, a file people commit and one this repo shows as untracked. Recommend **project state, not workspace settings**: a `choices.json` in the state home (`{ defaultModel?, agent.deepModel?, agent.standardModel?, agent.fastModel?, agent.safetyModel?, agent.roleModels? }`), consulted by the readers in `settings.ts` with precedence: explicit workspace/workspace-folder value > project choice > user (global) value > default. Use `configuration.inspect(key)` to detect an explicit workspace value (the panel already does). Readers to change: `readSettings().defaultModel`, `readRoleModels`, `readModelTiers`, `readSafetyModel` [VERIFIED: src/services/settings.ts read this session]. `toolsDirectory.ts` lines 208-213 display the same settings and should use the same resolver. The undo map in the panel stores `{setting, previous, target}`; add a `target: 'project'` variant so undo restores `choices.json`.
- **Import of old global choices:** on first open, if `inspect()` shows a global value that differs from the default and no project choice exists, show one card "These models were set up earlier in this editor: use them for this project?" (never silent, per D-06). The sync bundle carries only project choices, never user settings.

### Pattern 8: Git transport (research flag 3)

Sequence proven in a sandbox this session (local bare remote, user repo with a staged file, a dirty tracked file and a failing `pre-push` hook): `git status --porcelain`, `HEAD` and the current branch were identical before and after; the push with the hook active failed ("HOOK RAN", push refused); with `-c core.hooksPath=<empty dir>` it succeeded; a second push from a commit that was not a descendant was rejected with "Updates were rejected because a pushed branch tip is behind its remote"; `git ls-remote --exit-code origin refs/heads/nope` exited 2. [VERIFIED: sandbox run this session]

```bash
# All in a bare mirror: git --git-dir=<state>/sync/mirror.git ... ; URL from `git -C <root> remote get-url <remote>`
BLOB=$(git hash-object -w --stdin < segment.bin)                       # no index, no working tree
TREE=$(printf '100644 blob %s\t<32hex>.bin\n100644 blob %s\tmanifest.json\n' "$BLOB" "$MBLOB" | git mktree)
COMMIT=$(GIT_AUTHOR_NAME=near-ai-state GIT_AUTHOR_EMAIL=state@near-ai.invalid GIT_COMMITTER_NAME=near-ai-state GIT_COMMITTER_EMAIL=state@near-ai.invalid \
         GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" \
         git -c commit.gpgsign=false commit-tree "$TREE" [-p <remote tip>] -m 'Update encrypted project state')
GIT_TERMINAL_PROMPT=0 git -c core.hooksPath=<emptydir> -c push.gpgSign=false push "$REMOTE" "$COMMIT":refs/heads/near-ai/state   # no force; $REMOTE is the sync layer's parameter (default origin)
git fetch "$URL" +refs/heads/near-ai/state:refs/near-ai/incoming                                         # before merging
```

Rules for the implementer (derived from the sandbox and the Team transport read this session):

- **Arrays, never a shell string;** every call has a timeout and runs in its own process group (copy the shape of Team's `runGit`: `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GCM_INTERACTIVE=never`, detached group, output cap). Strip userinfo from any URL before it reaches a message or log (Team's `redactGitMessage`).
- **Mirror, not the user's repo:** fetching by remote name from inside the user's repo created `refs/remotes/origin/near-ai/state` visible in `git branch -a` [VERIFIED: sandbox]. Keep the bare mirror under `.near-ai/state/sync/` (self-ignored) and read the remote URL from the user's repo (`git remote get-url`, honoring `insteadOf` via `git ls-remote --get-url <name>`). Credentials: git's own credential helper keyed by URL still applies from the mirror; a helper configured only in the project's local `.git/config` will not. Detect an auth failure and say: "Git asked for a sign-in this editor cannot show. Run `git fetch` once in a terminal in this project so your credential helper can save it." (mirrors Team's `AUTH_HINT`).
- **Non-fast-forward is normal:** on rejection fetch, merge, rebuild, retry (max 5, jittered backoff). Never `--force` in v1.
- **Offline:** every failure is classified (no network, auth, rejected, remote policy) into a plain sentence; sync state is "waiting", state home keeps working, nothing is lost. Offline never blocks chat.
- **Hooks and signing:** `core.hooksPath` disabled and `commit.gpgsign=false` on every call.
- **Remote policy:** a repository ruleset requiring signed commits or blocking unknown branches will reject the push; report it as "Your git host did not accept the sync branch". A tree with no `.github/` triggers no workflows. [ASSUMED: GitHub runs workflows from the pushed commit's tree]
- **No shell-out when not needed:** read the tip tree with `git cat-file --batch`/`ls-tree`; do not check anything out.

### Pattern 9: Pick-up card (SYNC-07, D-03)

- Model (pure, `src/domain/state/pickup.ts`): `{ lastChat?: {id,title,updatedAt}, lastRun?: { state: 'finished'|'cut-off'|'running-elsewhere'|'waiting', at }, phase?: { number, name, nextStep }, writer }`. Sources: newest transcript summary (`TranscriptStore.list()` gives `id,title,model,updatedAt,turns` [VERIFIED: transcripts.ts `TranscriptSummary`]); the newest run marker; `.planning/STATE.md` through the existing `parseGsdPlanningState` (gives `state,currentPhase,currentPlan,...`) [VERIFIED: src/domain/gsdStatus.ts read this session].
- **No existing "next step" derivation exists** in the repo (grep found only auto-advance text and the `gsd-next` command definition). Derive it from artifact presence in `.planning/phases/<NN>-*/`: no `*-CONTEXT.md` → discuss; context but no `*-PLAN.md` → plan; plans without matching `*-SUMMARY.md` → execute; all summaries without verification/UAT → verify; else next phase. Map to the slash commands the chat already lists (`/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-verify-work`) and show them as text; the card never runs them. [ASSUMED: artifact naming from the GSD tooling used in this repo; verify with a fixture from `test/fixtures/gsd-import/planning`]
- **When to show:** only when the newest `pickup.json` writer differs from this editor's writer id (a different interface or machine) and the pointer is newer than this editor's last-seen pointer. Dismiss = remember last-seen, never re-show for the same pointer.
- **Rendering:** follow the `setup-nudge` pattern: host posts a message (`chat.ts:123` posts `{ type: 'setup-nudge', show }`), `media/chat/setup.js` builds a `section` card with an id, `aria-labelledby`, and posts one action. Add `media/chat/pickup.js` and a `pickup-card` message pair. The one click calls the existing `resume-conversation` handler (`chat.ts:399`: `if (message.type === 'resume-conversation') { await openSaved(message.id); return; }`). It must **not** call `settleInterrupted`, `autoResumeChoice`, or send any model request. A cut-off run keeps its existing Resume button; auto-resume must not fire for a foreign marker (Pitfall 1).

### Pattern 10: Migration algorithm (SYNC-02, D-05)

Per editor, per project, at first need (Open Question 5 on timing):

1. Resolve sources from this editor's `globalStorage`: `transcripts/<hash16>`, `runs/<hash16>`, `checkpoints/<runId>.json` (flat; attribute to the project by run ids present in this project's activity ledger, else by snapshot paths under the project root), `evals/*.json`, `spend/<identity>/*.jsonl` filtered by `proj` = this project's scope id. The `hash16` is `sha256(path.resolve(root)).slice(0,16)` [VERIFIED: transcripts.ts and runMarkers.ts constructors], identical in both editors because the container mounts the same path [CITED: CONTEXT.md evidence].
2. For each source record: if the state home has the same `(kind,id)`, apply the Pattern 6 rule (never overwrite a newer one; divergent = fork); else copy. Transcripts: decrypt with this editor's old key (`nearAi.transcripts.key` in SecretStorage) and re-encrypt under the data key; a plaintext legacy file is encrypted on the way in (matches today's "re-saved encrypted when read").
3. Write each file via temp name with **random** suffix then rename; record `migrated: { <sha256(globalStorage path)[0:12]>: <iso> }` in `meta.json` as an optimization only (the merge is idempotent without it, so a crash mid-way is repaired by running again).
4. Never delete or modify the source. Leave the source folders for one release; a later cleanup is a separate decision.
5. If the old key cannot be read (SecretStorage empty), leave that transcript in place, surface it as "locked" (Pitfall 7), and retry next start.

### Pattern 11: Full thread history, every message, every interface (D-07)

**Finding 1: what `TranscriptStore` keeps today is the model's compacted context, not the conversation.** [VERIFIED: source read this session]

- `AgentConversation.saveTranscript` writes `{ id, title, model, updatedAt, turns, messages, display }` where `messages` is the agent's **working list** (src/services/agentSession.ts:1030). That list is replaced during a run: `manageContext` first runs `trimOldToolResults` (older tool results cut to 600 characters plus a "[Older tool output trimmed ...]" note, src/agent/context.ts:61-69) and at the compaction threshold `compactConversation`, which replaces everything before the last 8 messages with one `<conversation-summary>` user message (src/agent/context.ts:79-110). `beforeTurn` returns that result as the next transcript (agentSession.ts:383-386) and `this.messages = result.messages` (agentSession.ts:425) stores it. So after the first compaction the original messages are gone from disk.
- `visibleTurns` then rebuilds what the reopened view shows: user text (from the `display` map of `[contentKey(message the model saw), what the person typed]`), assistant text merged across tool loops, and **only a count** of tool calls; it skips `<conversation-summary>` and `<agent-notification` messages (agentSession.ts:1426-1442). The `display` map survives compaction for the user messages that are still in the list, but earlier ones vanish with their messages.
- Nothing is lost by save or load themselves, but `TranscriptStore.save` calls `prune()`, which `rm`s everything beyond the newest `MAX_TRANSCRIPTS = 50` (transcripts.ts:6 and the `prune` method). D-08 says threads are never deleted, so prune must go.
- The live view keeps a `ConversationLog` of events (tool cards, notices, deltas) per tab, **in memory only**, capped at 4 000 entries with the oldest quarter dropped and each replayed tool output cut at `MAX_REPLAYED_OUTPUT = 20_000` characters [VERIFIED: src/services/conversations.ts:93 and the class at :101-127]. It is lost on reload; the reopened thread then shows "N tool calls" only.

So D-07 requires a **new persisted record that is separate from the model context**: an append-only **thread log** of the original, un-trimmed, un-summarised messages. Do not try to make `messages` itself the history (it must stay the compact working context the model sees).

**Recommended design:**

- `thread-entry` record, append-only, one per message: `{ id, thread, parent, at, writer, role: 'user'|'assistant'|'tool-call'|'tool-result'|'notice', body }`. For a user entry `body` holds what the person typed (the `display` value), plus a flag if the model saw expanded text (slash command or attachment text); for an assistant entry the text; for tool entries the name, the arguments, and the **result as originally returned**.
- **Message ids by hash chain:** `id = base32(sha256(parentId || canonical(body-without-time)))[0:26]`. The same continuation produces the same id on any machine (natural dedupe, idempotent import), and a continuation that differs produces a different id (a branch). Ids exist only inside encrypted objects and local files, never on the remote (D-09).
- **Capture point:** one function, `ThreadLog.sync(transcript)`, called (a) at the top of `beforeTurn` **before** `manageContext` runs, so untrimmed originals are logged before trim/compaction replaces them, and (b) from `saveTranscript` / run end for the tail. It appends only messages whose chain id is not yet logged and skips synthetic ones (`system`, `<conversation-summary>`, the "Understood. Continuing from the summary." ack, `<agent-notification`). This is the invariant that makes the history complete: every message passes through `beforeTurn`/`saveTranscript` before it can be compacted.
- **Tool result size:** store originals in full up to a sanity cap per result (recommend 2 MiB, with an explicit marker "N characters not stored" beyond it, which is the only truncation and is visible). Tool outputs are already bounded by the tools (for example a ranged file read), so the cap is rarely hit. [ASSUMED: cap value; confirm with owner given "nothing truncated"]
- **Sub-agent internals** (each sub-agent has its own transcript and `manageContext(..., false)`, agentSession.ts:845) are **not** logged as separate thread entries in 0.4.20; the lead's tool result carries the sub-agent's report (capped at 12 000 characters by 0.4.19). See Open Question 7.
- **Local file:** `.near-ai/state/threads/<conv id>/log.jsonl` (each line one AEAD envelope under a per-thread subkey, appended with a single `appendFile`; a reader skips a torn final line) plus `context.enc` (the existing `Transcript` for the model, whole-file, atomic) and the index entry. Local names may use ids (the folder is git-ignored and never pushed).
- **Reopening:** extend `restore(id)` to return turns from the thread log (entries in chain order), not from `visibleTurns(messages)`. Extend the webview `transcript` message with tool-step entries (`{role:'tool', name, args, output, ok}`) rendered as collapsed `<details>` cards by `media/chat/chat.js` (the case at `chat.js:1338` currently renders only user text, assistant markdown and a "N tool calls" meta line). The model context on resume still comes from `context.enc` (unchanged behavior, including the existing cut-off Resume path).
- **Rendering a long thread:** render everything but in chunks (a batch per animation frame) with `content-visibility: auto` on turn elements, and build tool-output bodies lazily on first expand; do not stop at "show last N". [ASSUMED: acceptable for "complete history"; test with a 5 000-entry thread]
- **Context after a merge:** `context.enc` is last-writer-wins by `at` and records `basedOnTip` (the chain id of the last entry it covers). If a machine opens a thread whose context's `basedOnTip` is not the tip of the main branch of the merged log, it rebuilds the working context as `[system, summary-if-any, ...entries of the main branch]` and lets the normal compaction shrink it on the next turn. No message is ever lost because the log, not the context, is the record.

**Finding 2: the `@near` chat participant persists nothing.** [VERIFIED: src/services/chatParticipant.ts read this session]

- `registerChatParticipant`'s handler passes `chatContext.history` to `historyFromChatContext`, which keeps this participant's own turns and **slices to the last 20** (`return history.slice(-20);`). The only thing written for a plain prompt is an `ActivityStore` session with summaries like "Assistant response completed." and costs; never the text. VS Code keeps the Chat view's turns itself, per editor (and the API only exposes the current participant's turns in the current session: "Currently, only chat messages for the current participant are included." [VERIFIED: node_modules/@types/vscode/index.d.ts, ChatContext.history doc]).
- Notes on what the person sees: the response text includes the usage footer appended with `response.markdown(usageFooter(...))`, so a recorded assistant turn should be stored as streamed (footer included, "exactly as the person saw it"). The footer is also fed back to the model today; that is existing behavior, not changed here. Slash-command turns (`/gsd-*`) answer "Started ..." and run in the panel; record them as `notice` entries marked not-for-context.
- **How to record:** wrap the `ChatResponseStream` in a recorder that accumulates `markdown` parts (and notes `button` and `progress` as notices), and on completion (or cancel/error, with a partial marker) append two entries: the user prompt and the assistant text. The recorder must append to the thread log, **not** rebuild from `history`, so the 20-turn model window never limits what is stored. Honor `nearAi.agent.saveTranscripts`.
- **Which thread a turn belongs to:** `ChatResponseTurn.result` is a `ChatResult` whose `metadata` the extension already uses (`turn.result.metadata?.command`). Return `{ metadata: { command?, threadId } }` from the handler; on the next request read `threadId` from the newest of this participant's response turns. First request in a session (no such turn): mint a new `conv-` thread. A session that predates 0.4.20 (turns without `threadId`): seed a new thread once from the **full** `chatContext.history` (before the slice), then continue it. If metadata is lost (a restored session), fall back to matching the last assistant text against the newest participant thread's tail; if no match, start a new thread (never overwrite). [ASSUMED: VS Code keeps `result.metadata` when it restores a Chat session after reload; verify in an extension-host test or manually]
- **Reopening in another editor:** the Chat view of another editor cannot be populated by an extension (no API to seed past turns; at most a prefilled query). So a participant thread is reopened **in the NEAR AI panel** through the same `resume-conversation` path as any thread, with full history, and can be continued there (its context is just the user/assistant turns). Add `response.button({ command: 'nearAi.openThread', arguments: [threadId], title: 'Open this chat in the NEAR AI panel' })` to participant replies, and list participant threads in the history picker with an origin label ("Chat view"). [ASSUMED: no Chat-view seeding API in `@types/vscode` 1.101; none found in the type file]

**Finding 3: how the panel lists and reopens threads today.** [VERIFIED: src/extension.ts `showHistory`, src/services/chat.ts `openSaved`/`restoreInto`, media/chat/chat.js]

- Listing is the command `nearAi.showHistory`: a QuickPick over `TranscriptStore.list()` (which decrypts and parses **every** saved transcript on every call, silently dropping unreadable ones), labelled by title, turn count, time and model. There is no history list in the webview. Choosing one posts `resume-conversation`, `openSaved(id)` focuses the tab if open, else `restoreInto` -> `agent.restore(id)` -> `tab.log.add({type:'transcript', turns, note})` -> the webview renders `turns`.
- After a reload the open tabs come back from `workspaceState['nearAi.chat.openConversations']` through the same `restoreInto`. `MAX_OPEN_CONVERSATIONS = 8` (conversations.ts:9) is independent of the live-thread count in D-08.
- So reopening renders user text, assistant text and a tool-call count, and after compaction not even the earlier turns. The history picker, `restore`, the `transcript` message and the webview case must all change for D-07; the QuickPick should read the new index (Pattern 12) instead of decrypting every file.

**Finding 4: merging a thread continued on two machines.** Use the message-level append log above, not whole-transcript last-writer-wins (which would drop one machine's turns).

- Threads are a grow-only set of entries keyed by chain id; merge = set union. There are **no thread tombstones** (D-08: never deleted).
- Entries form a tree through `parent`. If machine A and B both append to tip T, the tree has two branches. Deterministic display rule: the **main line** is the path from the root to the newest leaf by `(at, writer)`; any other branch is shown after its fork point under a divider "Also continued on another computer", fully, in order. Continuing a thread extends the newest leaf. Both branches stay in the log forever, so nothing is dropped. [ASSUMED: this display is acceptable; the alternative of interleaving by timestamp mixes two conversations]
- `thread-meta` (title, model, origin, `lastUsedAt = max(at)`) merges as last-writer-wins on `at` for the title and max for `lastUsedAt`, so it never needs the log to be opened.
- The pure merge law (union by id, commutative, associative, idempotent) is property-tested with seeded random orderings, including partial deliveries of one machine's entries.

### Pattern 12: History retention and the archive (D-08)

**Rule (derived, not a flag):** `live = the N threads with the greatest lastUsedAt` (N from `nearAi.history.liveConversations`, default 5), **plus** any thread open in a tab of this editor and any thread with a fresh run marker (heartbeat within the liveness window; Pitfall 1). Everything else is archived. Because placement is computed from data (`lastUsedAt` merged by max), two machines with different N or different clocks converge on the same content; placement is a local storage choice, not a replicated field. Reopening an archived thread appends an entry or a `lastUsedAt` bump, which moves it into the live set and the lowest-ranked live thread is archived in turn.

**(a) Archive format.** One file per thread: `.near-ai/state/archive/<conv id>.arc` = the thread's whole bundle (`log`, `context`, `meta`) as JSON, compressed with brotli q5, padded to a Padme bucket, sealed with the same AEAD envelope as bundle objects (Pattern 5). Weighed alternatives:

| Option | Cost | Retrieval | Verdict |
|--------|------|-----------|---------|
| Per-thread compressed+encrypted file (chosen) | One read + AEAD open + brotli decompress; measured ~11 ms decompress and ~2 ms AES-GCM for 5.3 MB (about 1.2 MB compressed) [VERIFIED: ran this session on source-like JSON] | Instant (tens of ms for a multi-MB thread); one file fetched when synced lazily | Chosen: also **is** the `cold` bundle object, so archiving a thread needs no re-encryption and pushing it dedupes by content |
| Packed archive (many threads in one file) | Rewrite or append-with-index on every archival; larger blast radius for a torn write | Needs an index into the pack | Rejected: no real saving over per-thread files for hundreds of threads |
| Leave logs uncompressed in the state home | Disk 4x larger | Fastest | Rejected for archives; fine for the 5 live threads |

- **Index:** `.near-ai/state/threads/index.enc` (one AEAD file) lists every thread, live or archived: `{ id, title, model, origin, createdAt, lastUsedAt, turns, entries, bytes, state, archiveFile?, tip }`. History listing, title search (client-side substring over the decrypted index) and the "Archived" label come from it without opening any archive. The index is derived, rebuildable by scanning archive headers (slow path), and merged by max/LWW like `thread-meta`.
- **Archiving is two-phase and crash safe:** write the `.arc` via temp+rename, **re-open and verify** it (decrypt, entry count and tip equal to the source), then remove the live files. Never delete first. A crash between the steps leaves both copies; the next start finishes or discards the duplicate (the live copy wins).
- **Reopen:** decrypt and merge the archive into `threads/<id>/` (idempotent union), then delete the `.arc` only after verifying. A run on an archived thread is not possible until it is live again.
- **`TranscriptStore.prune()` and `MAX_TRANSCRIPTS = 50` are removed** (replaced by archiving); `list()` is replaced by the index.

**(b) Sync: push archives, fetch them lazily.** Archived threads must be pushed (as `cold` objects, one thread per object, split in 8 MiB parts if larger) or they exist on one disk only, which breaks "never deleted" and "follows the project". Downloading them eagerly everywhere is the cost to avoid (flag 7). Use a **partial-clone mirror**: configure the private bare mirror as a promisor (`remote.origin.promisor=true`, `remote.origin.partialclonefilter=blob:none`) and fetch with `--filter=blob:none`: the fetch brings commits and trees only; blobs are downloaded the first time they are read by `git cat-file`. Proven this session against github.com: after a `--filter=blob:none` fetch, 2 777 objects were missing locally and reading one blob fetched exactly that one (missing count 2 776) [VERIFIED: ran this session]. The sync reads `manifest.json`, the sealed manifest, the index object and the hot objects, and never reads cold objects until a thread is opened. A host that does not support filters ignores the flag and sends everything (a plain local `file://` remote did so in the sandbox [VERIFIED]), so correctness does not depend on it; only bandwidth does. Add a soft total cap on synced ciphertext (recommend warn at 500 MB and stop pushing cold objects at 1 GiB; GitHub rejects files over 100 MB, so parts stay at 8 MiB). [ASSUMED: caps; GitHub limits per its documentation, not re-read this session]

**(c) Archiving and the per-record merge.** Archiving does not change any record: entries and ids are identical whether a thread is live or in an `.arc`. Scenario "archived on A, continued on B": B opens the thread (it is fetched lazily as a cold object, merged into B's live thread), appends entries, and pushes a **hot delta** containing only the new entries (parent = B's tip). A pulls: the delta targets a thread A holds as `.arc`; A appends the delta entries to a side file `archive/<id>.delta` (cheap, no decompress), bumps the index `lastUsedAt` by max, which ranks the thread into the live set; "make live" then folds the `.arc` and the delta together by union. If A and B each archive/compact the same thread differently, the cold objects are redundant copies of a union of the same entries; the next merge unions them. No path deletes an entry. Compaction on a machine rewrites cold objects only after verifying that the new object's entry set is a superset of the entries in the ones it replaces.

**(d) Setting naming.** Every contributed setting uses `nearAi.<area>.<camelCaseName>` for grouped settings (`agent.*`, `spend.*`, `activity.*`, `gsd.*`, `security.*`, `teams.*`, `webSearch.*`) and bare `nearAi.<camelCase>` only for the oldest top-level ones (`baseUrl`, `defaultModel`, `actionPolicy`, `privacyMode`, `dailySpendLimitUsd`) [VERIFIED: the full list of `contributes.configuration` keys printed this session]. Numeric bounds are expressed as `minimum`/`maximum` in `package.json` and clamped again in a reader (`readAgentLimits`'s `bounded(...)` in settings.ts); examples: `nearAi.activity.retentionMinutes` (60, 5 to 1440), `nearAi.agent.maxTurns` (60, 5 to 500). No setting sets `scope`. Recommendation:

- `nearAi.history.liveConversations`: number, default 5, `minimum` 1, `maximum` 50; a new `history` area is consistent with the convention and is the owner's working name. Clamp in a `readHistoryLimits()` next to `readAgentLimits`. Description in plain words, saying archived threads are never deleted and reopen on request.
- `nearAi.sync.remote`: string, default `"origin"`, **`"scope": "machine"`** so a cloned repository's `.vscode/settings.json` can never redirect where the encrypted state is pushed (a hostile repo could otherwise choose the destination). It is specified now and consumed as a **parameter of the sync layer** (`new StateSync({ remote })`, default `'origin'`); the UI is deferred, but reading the setting should be wired so it works when set by hand. Validate the value: a remote name from `git remote`, or a URL whose scheme is `https`, `ssh` or scp-like `git@host:path`; reject `ext::` and anything else.

### Pattern 13: Git identity, hooks and push safety (D-09 additions)

Verified in the sandbox this session with the person's repo configured as `user.name=Me`: `git commit-tree` **without** the environment override recorded `author=Me <me@example.com>`; **with** `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` and the two `*_DATE` variables set on that one call, the commit recorded `author=N <n@x.invalid> committer=N <n@x.invalid> date=2000-01-01T00:00:00Z msg=sync`, and `git config user.name` still printed `Me` afterwards [VERIFIED: ran this session]. So the plumbing approach (`hash-object` / `mktree` / `commit-tree` / `push`) supports the anonymous identity cleanly: the identity lives only in the child process environment, no git config is written, and a machine with no `user.name` at all also works.

Rules:

- Use `near-ai-state <state@near-ai.invalid>` for author and committer, a constant message `Update encrypted project state`, and a constant date. The environment must be set by the runner on every `commit-tree`; a missing override silently leaks the person's identity, so the runner must refuse to run `commit-tree` without it (a unit test spies the env) and the leak test seeds sentinel values for `user.name`, `user.email`, `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the person's config and environment and fails if either appears in any commit object, tag, or ref.
- Also pass `-c push.gpgSign=false -c commit.gpgsign=false -c core.hooksPath=<empty dir> -c protocol.ext.allow=never` and an explicit refspec. `push.gpgSign` would otherwise attach a signed push certificate naming the person on hosts that accept one, and a `pre-push` hook in the person's repo breaks a plain push (proven this session: "HOOK RAN", push refused). An explicit refspec on the command line makes git ignore `remote.<name>.push` and `push.default`.
- The remote is a **parameter**: `StateSync` takes `{ remote: string }`; nothing in the sync layer names `origin` except the default value of the setting. Resolve its URL with `git ls-remote --get-url <name>` run in the user's repo (honors `insteadOf`), never log it with userinfo.

### Pattern 14: Where D-07 to D-09 change the earlier patterns

- Pattern 2 `TranscriptStore` row: becomes `ThreadStore` (log + context + index + archive); `prune()` removed; `list()` replaced by the index.
- Pattern 6 record kinds: add `thread-entry` (grow-only), `thread-meta` (LWW + max), `thread-context` (LWW, derived), `archive-part`; **no tombstones for threads**.
- Pattern 10 migration: for each old transcript, create the thread from its `messages`: user messages via the `display` map, assistant text, tool calls and results as they stand, with `<conversation-summary>` messages kept in the **context** and not as visible entries; mark the thread `history: 'partial-before-0.4.20'` when a summary is present, because the originals before the summary no longer exist anywhere and cannot be recovered (say so in the UI: "Earlier messages of this chat were summarised before this version and cannot be restored"). Old `messages` that were trimmed keep their trim marker. The 5-live/rest-archived rule is applied at the end of migration. [VERIFIED reasoning: the compacted list is all that is on disk, see Finding 1]

### Anti-Patterns to Avoid

- **Deriving anything portable from the absolute path.** `deriveProjectScopeId(projectIdentity)` hashes the identity string `project-<sha256(path)[0:32]>` [VERIFIED: src/domain/auth.ts read this session]; `cyberStorePath` uses the path text; `RunCheckpoints` stores absolute file paths. Use a random `stateId` in `meta.json` as the portable identity.
- **Using `pid` to decide whether another editor's run is alive.** See Pitfall 1.
- **Putting the recovery code, data key or API key in any log, error, telemetry, or `redactForDisplay` path.** Add the code's shape to the redaction patterns so an accidental `String(error)` is scrubbed.
- **Moving Team Mode records or `teams/*.md`.** Out of scope; leave `team/` and `teams/` globalStorage alone.
- **Syncing during a live run.** Sync only at idle (no run in this editor) and after a run ends; never serialize a transcript mid-turn.

### Suggested plan slicing (for the planner)

1. **Foundation (pure):** records, canonical JSON/rev, merge rule + property tests (thread-entry union, branch linearization), recovery code, keys (scrypt wrap/unwrap, HKDF per object), objects (brotli, Padme pad, seal/open, manifest). No vscode, no git.
2. **State home + same-host stores:** `ProjectStateHome` with self-ignore; re-point TranscriptStore, RunMarkers, RunCheckpoints, ComparisonStore; random temp suffix everywhere; run-liveness fix; ActivityStore read-merge-write.
2b. **Thread log and archive (D-07, D-08):** `ThreadLog.sync` hook in `beforeTurn` and `saveTranscript`, thread store (log, context, index, archive, rank rule, two-phase archive), replace `prune`/`list`, webview tool-step cards and chunked rendering, `@near` participant recorder and `nearAi.openThread`, setting `nearAi.history.liveConversations`.
3. **Migration:** per-editor migrator + tests with fixture globalStorage (including summarised threads marked partial); "locked" surfacing.
4. **Model choices:** `choices.json`, settings resolver, panel apply/undo, import card.
5. **Sync transport:** partial-clone mirror, plumbing with anonymous identity, `StateSync({ remote })` parameter and `nearAi.sync.remote` read (machine scope, no UI), status/plain words, offline/auth/rejected handling, leak test against a real local bare remote.
6. **Sync UX + restore:** turn on (show code once), restore on second machine, profile/API-key restore via `ProfileStore`/`AuthService`, replace-device/rotate code.
7. **Pick-up card.**
8. **Release 0.4.20:** CHANGELOG, README, `/release 0.4.20`.

Keep slices 1 and 5 free of `vscode` imports so they run under `node --test` with no extension host.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Authenticated encryption | Custom cipher or MAC-then-encrypt | `aes-256-gcm` from `node:crypto` with AAD | Already the project's cipher; GCM gives tamper detection per blob |
| Key derivation from the code | Iterated hashes | `crypto.scryptSync`/`scrypt` with `maxmem` | OWASP-listed; built in |
| Key separation | Reusing DK directly for each purpose | `crypto.hkdfSync` with distinct `info` labels | Prevents cross-purpose key reuse |
| Randomness | `Math.random`, timestamps | `crypto.randomBytes`, `randomUUID` | Ids, salts, IVs, segment names, the code |
| Constant-time compare | `===` on secrets/tags | `crypto.timingSafeEqual` (GCM already verifies tags internally) | Avoid timing leaks on any comparison you add |
| Git operations | A JS git implementation or a new package | System `git` via array-arg `spawn` with timeouts | Credential helpers, ssh config and proxies "just work"; Team transport precedent |
| Atomic file replace | Direct `writeFile` over the target | temp file (random suffix) + `rename` | Existing pattern in every store |
| Per-record ordering | Wall-clock last-write-wins alone | `rev`/`basedOn` plus fork-on-divergence | Wall clocks disagree across machines; LWW silently drops one machine's turns |
| Settings merge precedence | Reimplementing VS Code scopes | `configuration.inspect()` | Already used by the panel to find explicit workspace values |
| Card UI | New webview framework | The `setup.js`/`setup-nudge` card pattern | Layout probes, a11y and CSS already exist for it |

**Key insight:** the dangerous parts of this phase are not the crypto primitives (all built in) but the invariants around them: a key that never leaves where it should, a merge that cannot drop an entry, a git sequence that cannot touch the person's work, and liveness that is correct across containers. Each should be a small pure module with property or adversarial tests.

## Runtime State Inventory

This is a migration phase (data moves from per-editor `globalStorage` to the project), so all five categories are answered.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| **Stored data** | Per editor `globalStorage/vitalpoint.near-ai-vscode/`: `transcripts/<hash16>/<conv>.json` (AES-GCM under per-install key), `runs/<hash16>/<conv>.json` (markers), `checkpoints/<runId>.json` (flat, 69 files, 3.8 MB in code-server, absolute paths), `evals/<runId>.json` (global comparisons, 48 KB), `spend/<identity>/<yyyy>-<mm>.jsonl` (per API key, 7.4 MB in code-server), `cyber/<key>` (108 KB), `team/`, `teams/` [VERIFIED: `du -sh` and `ls` of the code-server data dir this session]. Desktop has the same folders minus `cyber`, `team`. Project-local already: `.planning/.near-ai/{auth-profiles,activity,audit,...}.json`. | **Data migration** (copy/merge into state home) for transcripts, runs, checkpoints, evals, project-tagged spend. **No migration** for `cyber/`, `team/`, `teams/` (deferred/out of scope), `gsd/` runtime (38 MB, install-local), `emergency-stop.json`. |
| **Live service config** | None stored outside git/disk: no external service holds the old paths. The NEAR AI billing side only sees key usage. The remote branch `near-ai/state` is new. | None. Verified by reading `spendTracking.ts` (reporting token is a SecretStorage item, not a service-side config keyed by path). |
| **OS-registered state** | None. No scheduled task, systemd unit or launchd entry registers the storage path. The code-server container mounts `/home/aaron/projects` at the same path [CITED: CONTEXT.md]; `~` inside the container differs from the host, so nothing under `~` is shared. | None. Do not use `~` for any cross-editor sharing. |
| **Secrets and env vars** | SecretStorage per editor/browser: `nearAi.transcripts.key` [VERIFIED: transcripts.ts:26], `nearAi.v2.<projectId>.<profileId>.api-key` and `...api-key-endpoint` and `...refresh-token` [VERIFIED: auth.ts `scopedSecret`, `SCOPED_SECRET_VERSION = 2`], local runtime key under `localKeyScope`, reporting token. globalState: `nearAi.savedProfiles` (profileIndex), `nearAi.teamStudio.draft`/`kept`, `nearAi.cyber.model.<engagementId>`, reporting token id, `nearAi.proxyAdvice`-style notices. workspaceState: `nearAi.chat.openConversations` [VERIFIED: chat.ts:65], setup-nudge dismissal, security-scan consent. | **Code edit + one-time re-store:** new `nearAi.state.<stateId>.dataKey` secret; on restore the API key is re-stored under the **local** scope. Old keys are left in place. See Pitfall 4 and the globalState triage below. |
| **Build artifacts / installed packages** | `dist/` is rebuilt by `tsc`; no installed artifact carries a path. Old `*.vsix` files in the repo root are untracked build output. The installed extension in code-server and desktop is replaced by the 0.4.20 VSIX. | None beyond the normal release. |

**globalState / workspaceState triage (research flag 6):**

| Item | Decision | Reason |
|------|----------|--------|
| `nearAi.chat.openConversations` (workspaceState) | Keep local; the pick-up card replaces the need to sync it | Which tabs are open is per window; `pickup.json` carries the one pointer that matters |
| Profile metadata (`auth-profiles.json`) | Sync as a `profile` record (excluding `keySource` copies and `profile-team-*`) | Needed to restore without re-setup; `keySource` links are machine-chosen (`isLinkedCopy` reads globalState) |
| `nearAi.savedProfiles` index | Do not sync | Computer-wide index of other projects; rebuilt by `ProfileStore.recordIndex` |
| `nearAi.cyber.model.<id>` | Defer (cyber out of SYNC-01) | Cyber store path is path-text keyed; not listed in requirements |
| Team Studio draft/kept | Defer | Per-user, tied to team library that stays per user |
| Security-scan consent (workspaceState) | **Never sync** | Consent to run scans must be given per editor/device; syncing a "granted" would act as consent on a machine the person has not approved |
| Emergency stop, reporting token id, proxy advice | Per device | Safety/credential state |
| Refresh tokens (`authMode: nearAccount`) | Do not carry (recommend; confirm) | Broader credential with its own sign-in; carry API key + bound endpoint + local runtime key only [ASSUMED] |

## Common Pitfalls

### Pitfall 1: A second editor mistakes a live run in the first for a cut-off run and resumes it (money, correctness)
**What goes wrong:** `RunMarkers.isInterrupted` is `!marker.endedAt && marker.pid !== this.pid && !this.alive(marker.pid)` [VERIFIED: src/services/runMarkers.ts:137-139]. `alive` is `process.kill(pid, 0)`. code-server runs in a container with its own pid namespace; desktop VS Code on the host cannot see that pid (or sees an unrelated process with the same number). With a shared state home, desktop reads code-server's live marker as "started, never ended, pid gone" and `autoResumeAfterReload` (default `true` [VERIFIED: package.json `nearAi.agent.autoResumeAfterReload` default true]) starts a second run on the same conversation within 12 hours: double spend and two writers on one transcript. The same shared-file problem already exists for `closeInterruptedRuns` (it cancels every "running" session in `activity.json` at any editor's activation [VERIFIED: activityStore.ts `closeInterrupted`]).
**Why it happens:** pid is only meaningful inside one pid namespace.
**How to avoid:** add `writer` (random per extension-host instance, plus hostname) and a periodic heartbeat that updates `activeAt` every ~30 s while a run is live (not only at steps). Rule: a marker from **this** writer is never cut off by this process; a marker from a **foreign writer** (different instance id) is "running elsewhere" while `now - activeAt < 3 min`, and "cut off" only after that; the pid check is used only when writer host equals this host and pid namespace is shared (do not rely on it). Foreign "cut off" markers are **never auto-resumed**; they show the Resume button and the pick-up card state "cut off"; only a click resumes (D-03). Apply the same writer/heartbeat rule to `closeInterruptedRuns`. This is the "fix the class with an invariant" case.
**Warning signs:** a conversation gets two running tabs after opening the other editor; spend ledger shows two interleaved runs for one `conversationId`.

### Pitfall 2: Two editors on one host cannot decrypt each other's files (the single most important design gap)
**What goes wrong:** code-server keeps SecretStorage in the browser; desktop uses the OS keyring. Neither can read the other's `nearAi.state.<id>.dataKey`. A second editor opening a state home sees ciphertext it cannot open, so "same chat list without any manual step" (success criterion 1) fails, and sync may not even be on (no recovery code exists yet).
**Why it happens:** the container's `~` differs from the host's, so no home-dir key file is shared; the project folder is the only shared medium [CITED: CONTEXT.md evidence; mount at same path].
**How to avoid:** resolve Open Question 1 before planning slice 2. Do not ship criterion 1 with transcripts only decryptable through per-editor SecretStorage.
**Warning signs:** chat history empty in editor B although files exist in `.near-ai/state/transcripts`.

### Pitfall 3: Temp-file names collide across a container and the host
**What goes wrong:** `${file}.${process.pid}.tmp` is used by transcripts, run markers and the comparison store [VERIFIED: transcripts.ts:83, runMarkers.ts:156, store.ts:21 all `const temporary = \`${file}.${process.pid}.tmp\`;`]. Two editors in different pid namespaces can have the same pid, and then write the same temp file simultaneously, corrupting a record. `RunCheckpoints` already uses `randomBytes(4)`.
**How to avoid:** one shared `writeFileAtomic(target, data)` helper in `stateHome.ts` with `randomBytes(8)` in the temp name, `mode 0o600`, `wx` flag, cleanup on failure; replace all three call sites. Add a test that two writers to one target never produce a torn file.

### Pitfall 4: Identity and secret scope are path-derived, so a second machine looks like a different project
**What goes wrong:** project id, the credential scope and `profileId` derivation all hash the absolute path. On machine 2 the clone is at another path, so `nearAi.v2.<projectId2>...` is empty and the profile ids differ. `ProfileStore.load` already rewrites `projectId` when the file's differs (it persists with the local id [VERIFIED: profileStore.ts:331-332]) and a cloned `auth-profiles.json` is only metadata; the key is not there.
**How to avoid:** on restore, write profile metadata through `ProfileStore` (not by file copy), then `AuthService.saveScopedApiKey(scope, key, endpoint)` for the **local** scope with the bound endpoint (omitting the endpoint makes `getScopedApiKeyFor` refuse a non-default endpoint [VERIFIED: auth.ts `getScopedApiKeyFor`]). Skip profiles with `keySource` and `profile-team-*`. Use a random `stateId`, not the path hash, to name state-level secrets. Mark validation `stale` and let the existing validation run.

### Pitfall 5: Checkpoints hold absolute paths and are flat across projects
**What goes wrong:** `RunCheckpoints` snapshots `{ path: absolutePath, original: base64 }` and files sit at `<global>/checkpoints/<runId>.json` for all projects [VERIFIED: checkpoints.ts and chat.ts:828 `path.join(storage, 'checkpoints')`]. Copied to another machine, `revert()` would write to another machine's absolute paths (or the same wrong path under a different user), and `revert` of an outside-workspace file is dangerous.
**How to avoid:** version 2 format stores `rel` (relative to the project root) for files inside the root and refuses to revert anything else; migration converts only snapshots whose path is under the root. Do not sync outside-root snapshots. Sync checkpoints only for the newest N runs (recommend 10) and under a size cap (recommend 25 MB total per bundle, configurable); older checkpoints stay local ("checkpoints only on request", flag 7). Checkpoints contain full original file contents, so they must only ever leave the machine inside encrypted segments.

### Pitfall 6: Lost updates in `activity.json` between editors
**What goes wrong:** `ActivityStore` keeps the ledger in memory and rewrites the whole file; two editors on one host overwrite each other's sessions. This is today's behavior and becomes visible once both editors really share the project.
**How to avoid:** on persist, read the current file, merge by `sessionId` (newer `updatedAt` wins per session, union of ids), then write atomically. Keep `reload()` for readers. Add a two-writer test.

### Pitfall 7: `TranscriptStore.list()` drops what it cannot decrypt
**What goes wrong:** `read()` catches every error and returns `undefined`, so `list()` silently omits undecryptable files [VERIFIED: transcripts.ts `read` try/catch]. After migration, a transcript whose key is missing would vanish from history rather than say "locked".
**How to avoid:** return a `locked` summary (id from the filename, no title) and show "Locked on this device: enter your recovery code to open", never a blank list. Distinguish "not encrypted for us" from "corrupt".

### Pitfall 8: Pruning conflicts with D-07/D-08
`TranscriptStore.save` prunes beyond 50 transcripts. With full history and archiving this deletion must be removed (Pattern 12); leaving it would silently delete threads on every save and, with sync, churn between machines.

### Pitfall 9: Opening a folder must still write nothing
The e2e `'opening the sidebar there writes nothing into the folder'` asserts `readdir(workspace)` is empty [VERIFIED: src/test/e2e/suite.ts:271 and :286]. Creating `.near-ai/state/` on activation would fail it. Create the state home lazily on the first write by a person's action, or only when `isNearAiProject(root)` (which means `.planning/.near-ai` exists [VERIFIED: runtime.ts `isNearAiProject`]). Migration timing is Open Question 5.

### Pitfall 10: scrypt memory
Default `maxmem` rejects N=2^17 (Pattern 4). Also scrypt blocks the thread for ~0.3 s: use the async `crypto.scrypt` so the extension host stays responsive; run it only on unlock/restore, never per file.

### Pitfall 11: Leaking through plaintext names, messages and logs
Segment names, commit messages, author, dates, the manifest's plaintext fields, and **extension logs** (`nearLog` output channel receives diagnostics) must contain no ids, titles, key material or the recovery code. The recovery code is displayed once and never passed through `console`, the NEAR AI output channel or an error message; keep it out of component state after display.

### Pitfall 12: Rollback/deletion by anyone with remote write access
An attacker with push rights can replace the tip with an older (valid) bundle or delete segments. Authenticated `sealed` manifest with monotonic `seq` and per-segment hashes lets a client refuse a lower `seq` than it has seen and refuse a tip with a missing segment; local state is never deleted by a pull and the next push restores missing segments. State the residual risk (availability, not confidentiality) in the plan. [ASSUMED: `seq`-pinning is sufficient for v1]

### Pitfall 13: Time bomb at sync cadence
Debounce pushes (recommend: at run end, on window blur after 60 s idle, and a manual "Sync now"), never per keystroke or per transcript checkpoint, and never while a run is in flight. The shared `transcripts.checkpoint()` writes during a run must not trigger sync.

### Pitfall 14: "History" that is really the compacted context
**What goes wrong:** treating `Transcript.messages` as the history reproduces today's gap: after one compaction the earlier turns exist nowhere, and tool results older than the newest are cut to 600 characters.
**How to avoid:** the thread log, captured before `manageContext` (Pattern 11).
**Warning signs:** a reopened long thread shows fewer user turns than the person typed; a test that compacts a transcript and then lists entries finds a `<conversation-summary>` entry.

### Pitfall 15: Threads summarised before 0.4.20 cannot be restored
Originals before an earlier summary are not on disk. Migration must say so per thread instead of implying completeness (D-07 says "nothing summarised away"; for old threads that cannot be achieved and the owner should know).

### Pitfall 16: Participant thread identity
`ChatContext.history` has no session id and only this participant's turns. Carry `threadId` in `ChatResult.metadata` and fall back by tail-match; never overwrite a thread on a weak match. Record from the response stream, not from `history`, because `historyFromChatContext` slices to 20.

### Pitfall 17: Archiving must never be the only copy
Write, verify, then remove. An open tab, a running run and a fresh run marker keep a thread live regardless of rank. Two editors computing different live sets converge because rank is derived from merged `lastUsedAt`.

### Pitfall 18: A repository must not choose where the state is pushed
`nearAi.sync.remote` without `scope: machine` can be set by a cloned repo's `.vscode/settings.json`. Also reject `ext::` and other helper transports and set `protocol.ext.allow=never`.

### Pitfall 19: The person's identity leaking through git
Without the environment override `commit-tree` records the person's `user.name` and `user.email` (proven); `push.gpgSign` can attach a signed push certificate. Both are fixed per call, never by editing config; the leak test seeds sentinels for both.

### Pitfall 20: Sizes grow once full history is kept
Originals are larger than the 11 MB of trimmed transcripts the owner has today. Brotli brings text to roughly a quarter; padding adds up to 12.5%; set caps and show size in the sync dialog.

## Code Examples

### Wrap and unwrap the data key (pure module, Node built-ins)

```typescript
// Source: Node docs for crypto.scrypt / createCipheriv; verified live this session (N=2^17 needs maxmem, ~300 ms)
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';

const KDF = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;

export function deriveKek(code: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(code, salt, 32, KDF, (error, key) => (error ? reject(error) : resolve(key))));
}

export function wrap(kek: Buffer, plain: Buffer, aad: string): { iv: string; tag: string; data: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function unwrap(kek: Buffer, blob: { iv: string; tag: string; data: string }, aad: string): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(blob.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]); // throws on a wrong code or any tamper
}
```

The existing at-rest envelope this mirrors (for the migrator to read old files):

```
// [VERIFIED: src/services/transcripts.ts:11]
type Envelope = { enc: 'aes-256-gcm'; iv: string; tag: string; data: string };
```

### Deterministic record merge (pure)

```typescript
// Source: derived from Pattern 6; test as commutative, associative, idempotent
export function mergeRecord(local: Rec | undefined, remote: Rec): { keep: Rec; fork?: Rec } {
  if (!local || local.rev === remote.rev) return { keep: local ?? remote };
  if (remote.basedOn === local.rev) return { keep: remote };
  if (local.basedOn === remote.rev) return { keep: local };
  const [newer, older] = remote.at > local.at || (remote.at === local.at && remote.writer > local.writer) ? [remote, local] : [local, remote];
  return { keep: newer, fork: forkOf(older) }; // forkOf: new id = sha256(id + rev), title suffix "(from another computer)"
}
```

### Leak test shape (real git, real local bare remote)

```typescript
// Seed state with sentinels, sync to a bare remote, then scan EVERYTHING the remote holds.
const sentinels = ['SENTINEL_PROMPT_7f3a', 'sk-test-SENTINEL-KEY', dataKey.toString('base64'), dataKey.toString('hex'), recoveryCode, recoveryCode.replaceAll('-', ''), 'conv-'];
// git -C remote.git rev-list --all --objects ; git cat-file --batch for every object (blobs, trees, commits)
// assert: no sentinel in any blob/tree entry name/commit message/author/ref name; refs are only refs/heads/near-ai/state (+ nothing on main)
// assert: tree entry names match /^(manifest\.json|[0-9a-f]{32}\.bin)$/ ; no title, id, model name, person name/email in any commit object
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Per-editor `globalStorage` for project data | Project-local state home shared by every editor on the host | This phase | Chats, runs, comparisons and choices follow the folder |
| User-level applied models (`ConfigurationTarget.Global`) | Project-level choices layered under explicit workspace settings | This phase | Choices are visible in every interface and travel with sync |
| Install-local transcript key in SecretStorage | Per-project data key, recovery-code wrapped | This phase | Transcripts decryptable on another editor/machine |
| `crypto.scrypt` only on Node 22 | `crypto.argon2` on Node >= 24.7 | Node 24.7.0 (2025) | Not usable by VS Code 1.101's Node 22; revisit when `engines.vscode` moves to a host on Node >= 24.7 and make the KDF name part of the manifest so the switch is a format minor |

**Deprecated/outdated:** nothing in the repo is deprecated by this phase; the globalStorage folders become read-only legacy sources.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Option C for same-host key sharing (a per-project local key file in the state home, mode 0600, plus SecretStorage copy; recovery wrap added when sync turns on) is acceptable to the owner | Open Question 1 | If the owner wants at-rest protection equal to SecretStorage, criterion 1 needs a manual unlock step on each new editor/browser |
| A2 | Dual write of comparison runs (state home + global store) is the right trade-off vs moving them entirely to the project | Pattern 7 | If wrong, either other projects lose cost-free reuse, or duplicates confuse; low impact |
| A3 | Project-level choices via `choices.json` beats writing `.vscode/settings.json` | Pattern 7 | If the owner prefers real workspace settings, other tooling sees them but the file gets committed/edited by the extension |
| A4 | Compaction when hot objects exceed ~20 or twice the live size (padding parameters are A14) | Pattern 5 | Size/leakage trade-off; low |
| A5 | Refresh tokens are not carried; only API key + endpoint + local runtime key | Runtime State Inventory | Restoring a nearAccount profile needs a fresh sign-in on the new machine |
| A6 | Checkpoints sync only for the newest 10 runs and a 25 MB total cap; spend history mirrors only entries tagged to this project | Pitfall 5, Open Question 4 | Users may expect full history; size limits may need raising |
| A7 | Run liveness thresholds: heartbeat 30 s, foreign marker "running elsewhere" for 3 min | Pitfall 1 | Too short = false cut-off during a long single model call; too long = slow recovery; tune with the stall timeout (`nearAi.agent.modelStallSeconds`, 120 s) |
| A8 | GSD artifact naming (`*-CONTEXT.md`, `*-PLAN.md`, `*-SUMMARY.md`, `*-VERIFICATION.md`/`*-UAT.md`) decides the "next step" shown on the card | Pattern 9 | Wrong suggestion text; verify against `test/fixtures/gsd-import/planning` |
| A9 | A pushed commit whose tree has no `.github/` triggers no workflows; branch rulesets may reject the push | Pattern 8 | A host policy could block sync; message and retry-later path must exist |
| A10 | Secrets in code-server are per browser profile (taken from the owner's evidence, not verified in code-server source; a web search for it was inconclusive) | Pitfall 2 / flag 4 | If code-server shares secrets server-side, Open Question 1 largely disappears |
| A11 | VS Code 1.101 extension host is Node 22 (single source) | Standard Stack | If it is already >= 24.7, Argon2id becomes available; scrypt remains acceptable regardless |
| A12 | `seq`-pinning is enough rollback protection for v1 | Pitfall 12 | An attacker with write access could still cause availability loss |
| A13 | Thread entries use hash-chain ids over canonical body; branches shown as main line plus labelled continuation | Pattern 11 | Different branch UX; data is never lost either way |
| A14 | 2 MiB per-result tool-output cap; brotli q5; Padme padding with a 64 KiB floor and 8 MiB parts | Patterns 5 and 11 | Size/leakage tuning; "nothing truncated" wording |
| A15 | VS Code persists `ChatResult.metadata` across a Chat session restore; the API cannot seed past turns | Pattern 11 Finding 2 | Participant threads may fork more often; reopen still works in the panel |
| A16 | Partial-clone filters work on the owner's git host (verified for github.com only); caps of 500 MB warn and 1 GiB stop for synced ciphertext | Pattern 12 | Falls back to full fetch; more bandwidth |
| A17 | Rendering a long thread in chunks is acceptable for "complete history" | Pattern 11 | A paging control would be needed |

## Open Questions

1. **How does the second editor on the same host get the data key without a manual step? (needs the owner)**
   - What we know: code-server secrets live in the browser, desktop's in the OS keyring; the container's `~` is not the host's; the project folder is the only shared medium. Success criterion 1 says "without any manual step". D-02 says a new device asks for the recovery code once, but the code is only created when sync is turned on.
   - What's unclear: whether a key file beside the data is acceptable, or whether a once-per-editor unlock is.
   - Recommendation (A1): **Option C.** On first state-home creation write `.near-ai/state/keys/local.key` (mode 0600, self-ignored, never added to any bundle or log) holding the data key, **and** keep the SecretStorage copy; when sync is turned on add the recovery-code wrap. Add `nearAi.sync.keepKeyInProject` (default true); turning it off removes the file and makes each new editor/browser ask for the recovery code (which then must be created at that moment). State plainly in README that chats at rest in the project folder are protected by file permissions on that machine (as `.planning/.near-ai/activity.json` already is), and are end-to-end encrypted everywhere they leave it. Rejected: Option B (always require the code on a second editor) breaks criterion 1 for people who never turn sync on.
2. **Should sync run only with an explicit "turn on", or offer on first launch?** Recommendation: explicit only (D-02 says turning sync on). The same-host features work with sync off.
3. **Which remote?** Recommendation: default `origin`; if there are several remotes, ask once and store the choice in `meta.json`; if none, say "This project has no online home yet" and offer nothing destructive (no `git remote add` by the extension). Allow `nearAi.sync.remote` override for a private remote.
4. **Daily spend limit across two editors on one host.** Each editor's `SpendLedger` sums its own globalStorage ledger, so two editors on one host already under-count against `nearAi.dailySpendLimitUsd`, and sync does not change that. Mirroring project spend into the state home for history is in scope (SYNC-01). Making the limit read the union is a money-path change (blocking checks apply) and probably belongs in a follow-up; decide before slice 2 whether 0.4.20 does it.
5. **When does migration run?** Recommendation: when `isNearAiProject(root)` is true at activation, or lazily on the first chat/history/compare action otherwise, so the "writes nothing on open" e2e still holds.
6. **Does the owner want old globalStorage folders cleaned after 0.4.20?** Recommendation: no, leave them (D-05: never delete the source); a later release may offer cleanup.

7. **Sub-agent internals in the history.** Sub-agents have their own transcripts; the lead sees their report (capped at 12 000 characters). Recommendation: log only the lead's view in 0.4.20 and say so; a later release can log sub-agent threads as linked entries. Owner to confirm "every tool step" means the lead's steps.
8. **Per-result cap on stored tool output** (recommend 2 MiB with a visible marker) versus the owner's "nothing truncated". Confirm.
9. **Long threads in the webview:** render all in chunks (recommended) or add a "Show earlier messages" control.
10. **Branch display for a thread continued on two machines:** main line plus a labelled other continuation (recommended) versus forking into two threads.
11. **Commit squashing** (rare force-with-lease orphan rewrite) in 0.4.20 or later; recommendation: later, unless size tests demand it.
12. **Where participant threads appear:** the history picker with a "Chat view" label and a button in each reply to open it in the panel (recommended); the Chat view itself cannot be seeded.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build, tests, crypto | yes | v24.22.2 (dev); Node 22 in VS Code 1.101 host | none needed |
| git | sync transport, tests | yes | 2.53.0 | sync reports "git not found" in plain words; same-host features unaffected |
| systemd-run / choom / timeout | required test wrapper | yes (used by the standing rule) | — | none; the rule forbids uncapped runs |
| TypeScript (`npx tsc`) | compile | yes (`typescript ^5.7.2` in devDependencies, `dist/` present) | — | — |
| xvfb + VS Code test-electron | `npm run test:e2e` (release boundary only) | not probed (not needed during research) | — | run only at the release gate, one heavy run at a time |
| Network to github.com | optional live probe of public-readability | yes (anonymous `ls-remote` worked) | — | tests use a local bare remote; no network needed |
| Docker/code-server container | manual verification of the owner scenario | present on the owner's host (data dir exists) | — | simulate with two storage dirs + a shared state home in tests |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none required for planning.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | `node:test` with `node:assert/strict`, TypeScript compiled by `tsc` to `dist/` [VERIFIED: package.json scripts; src/test/profileStore.test.ts imports] |
| Config file | `tsconfig.json` (`rootDir src`, `outDir dist`, `include src/**/*.ts`) [VERIFIED: tsconfig.json read this session] |
| Quick run command | `systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 sh -c 'npx tsc -p tsconfig.json && node --test dist/test/<name>.test.js'` (the prior-phase shape `npx tsc -p tsconfig.json && node --test dist/test/<name>.test.js` still holds: `dist/test/*.test.js` exists and `rootDir=src` maps `src/test/x.test.ts` to `dist/test/x.test.js`) |
| Full suite command | `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 choom -n 1000 -- timeout 1800 env NODE_OPTIONS=--max-old-space-size=1536 npm test` (`npm test` = `npm run compile && node --test dist/test/*.test.js scripts/test/*.test.mjs`), once at the phase boundary |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SYNC-01 | State home paths, self-ignoring `.gitignore` (`git status` clean, `check-ignore`), atomic writes with random temp names, two-editor shared dir | unit + real git in temp dir | `node --test dist/test/stateHome.test.js` | Wave 0 |
| SYNC-01 | Stores re-pointed: transcripts/markers/checkpoints/comparisons read what another store instance wrote under a different "editor" storage | integration | `node --test dist/test/stateStores.test.js` | Wave 0 |
| SYNC-02 | Migration: idempotent (run twice = identical tree), never overwrites newer, never deletes source, old-key transcript re-encrypted, locked when key missing, forks on divergence, crash-mid-migration then rerun | unit/integration with fixture globalStorage | `node --test dist/test/stateMigration.test.js` | Wave 0 |
| SYNC-03 | Data key + HKDF sub-keys; device copy via a `MemorySecrets` fake (pattern in profileStore.test.ts); local key file mode 0600 (Open Question 1) | unit | `node --test dist/test/stateKeys.test.js` | Wave 0 |
| SYNC-04 | Wrong code refused; tampered manifest, tampered segment, truncated segment, swapped segment from another state id (AAD), missing segment, lower `seq`; **state untouched after each refusal** (byte-compare the state home before/after); plain messages; code never logged (spy on output channel / console) | unit | `node --test dist/test/stateRecovery.test.js` | Wave 0 |
| SYNC-05 | Merge laws (commutative, associative, idempotent) with seeded random orderings; two machines edit the same transcript, delete vs edit, prune horizon; no lost entries | property-style unit | `node --test dist/test/stateMerge.test.js` | Wave 0 |
| SYNC-05 | Git transport against a real local bare remote: `git status`/`HEAD`/branch unchanged, failing `pre-push` hook ignored, non-fast-forward then retry succeeds, offline remote reported plainly, auth failure message, branch is never `main` | integration | `node --test dist/test/stateSyncGit.test.js` | Wave 0 |
| SYNC-05 | **Leak test:** sentinels in prompts, API key, data key (base64/hex), recovery code; scan every object in the remote (blobs, trees, commits, refs); tree names match `^(manifest\.json\|[0-9a-f]{32}\.bin)$`; anonymous author/date (the D-09 rows below extend this) | integration | `node --test dist/test/stateLeak.test.js` | Wave 0 |
| SYNC-05 | Two simulated machines (different root paths) round trip: A pushes, B restores with the code, then B pushes a new chat and A pulls it | integration | `node --test dist/test/stateTwoMachines.test.js` | Wave 0 |
| SYNC-04/05 | Restore writes the API key under the **local** project scope with the bound endpoint; skips `keySource`/`profile-team-*` | integration with `AuthService` + `MemorySecrets` | `node --test dist/test/stateRestoreProfile.test.js` | Wave 0 |
| SYNC-01 / D-07 | Thread log captures originals before compaction: feed a transcript through trim and compaction; the log holds every user/assistant/tool entry untrimmed, no `<conversation-summary>` entry, ids stable and idempotent on re-sync | unit | `node --test dist/test/threadLog.test.js` | Wave 0 |
| SYNC-01 / D-07 | Reopen: restored turns equal all entries in order, with tool-step cards; a 5 000-entry thread is posted to the webview in batches without dropping any | unit | `node --test dist/test/threadReplay.test.js` | Wave 0 |
| D-07 participant | Recorder wraps the response stream; 30 turns recorded while the model window sees 20; thread id round-trips through `ChatResult.metadata`; seeding from full pre-0.4.20 history; cancelled partial; slash-command turn recorded as notice; `saveTranscripts=false` records nothing | unit with a fake `ChatResponseStream` | `node --test dist/test/participantRecord.test.js` | Wave 0 |
| D-07 merge | Thread continued on two machines: union keeps all entries from both, deterministic branch linearization, commutative/associative/idempotent with seeded orderings and partial delivery | property-style unit | `node --test dist/test/threadMerge.test.js` | Wave 0 |
| D-08 | Rank rule: top N by `lastUsedAt` live, open-tab and running threads protected, setting change re-places threads, setting clamps 1 to 50 and matches `package.json` minimum/maximum/default | unit | `node --test dist/test/historyRetention.test.js` | Wave 0 |
| D-08 | Archive round trip: archive, verify, remove live; a crash between steps loses nothing; reopen merges and makes live; index lists archived threads with title search; threads are never pruned (more than 50 all listed) | integration (temp state home) | `node --test dist/test/threadArchive.test.js` | Wave 0 |
| D-08 merge | Archived on A, continued on B: B pushes a hot delta, A folds it into the archive delta and ranks it live; no entry lost; two machines with different N converge | integration (two simulated machines, local bare remote) | `node --test dist/test/archiveMerge.test.js` | Wave 0 |
| D-08 sync | Cold objects are not read on a normal sync: with `uploadpack.allowFilter` on the local bare remote, `git rev-list --objects --missing=print` shows cold blobs missing after sync and present after opening that thread; a remote without filter support still syncs | integration | `node --test dist/test/stateLazyFetch.test.js` | Wave 0 |
| D-09 | Padding: payloads in one bucket give equal object sizes, overhead at most 12.5%, parts at most 8 MiB; per-object subkeys; AAD swap (object moved between classes or state ids) refused | unit | `node --test dist/test/stateObjects.test.js` | Wave 0 |
| D-09 identity | The person's `user.name`, `user.email` and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` seeded with sentinels; every commit on the remote has author and committer `near-ai-state <state@near-ai.invalid>`, constant date and message `Update encrypted project state`; the person's git config unchanged afterwards; the runner refuses `commit-tree` without the override | integration | `node --test dist/test/stateIdentity.test.js` | Wave 0 |
| D-09 remote parameter | `StateSync({ remote })` pushes to a non-`origin` remote; no code path names `origin` except the setting default; `nearAi.sync.remote` declared in `package.json` with `scope: machine`; `ext::` and other schemes rejected | unit | `node --test dist/test/stateRemote.test.js` | Wave 0 |
| D-09 leak (extends the SYNC-05 test) | Scan tree entry names, every blob, every commit object, commit messages, and ref/tag/note names for thread titles, thread and record ids (`conv-`, `run-`), model names, prompt sentinels, API key, data key (base64 and hex), recovery code, and the person's name and email; tree names match `^(manifest\.json\|[0-9a-f]{32}\.bin)$` | integration | `node --test dist/test/stateLeak.test.js` | Wave 0 |
| SYNC-06 | Settings resolver precedence (explicit workspace > project choice > user > default); `applyRecommended` writes project state, undo restores it; global import offered, not silent; comparison union list de-duplicates by run id | unit (resolver is pure; panel logic behind a fake) | `node --test dist/test/modelChoices.test.js` and extend `modelComparisonPage.test.js` | Wave 0 (new) + existing |
| SYNC-07 | Pick-up model: states finished/cut-off/running-elsewhere/waiting; shows only for a foreign writer; next-step derivation from fixture `.planning/`; the click path never calls resume/auto-resume | unit | `node --test dist/test/pickup.test.js` | Wave 0 |
| SYNC-07 / Pitfall 1 | Foreign live marker is never "cut off" within the heartbeat window and never auto-resumed; pid not trusted across writers; `closeInterruptedRuns` honors writers | unit (extends runMarkers tests) | `node --test dist/test/runMarkersForeign.test.js` | Wave 0 |
| SYNC-01 / Pitfall 6 | `ActivityStore` two writers merge by session id | unit | `node --test dist/test/activityShared.test.js` | Wave 0 |
| (existing) | "opening the sidebar writes nothing into the folder" still passes | e2e (release gate only) | `npm run test:e2e` (capped, one heavy run) | exists (suite.ts:271) |
| SYNC-08 | CHANGELOG has `## 0.4.20`, README updated, version bump in package.json and package-lock.json | release script check | `node scripts/verify-release-content.mjs` after `npm run package` (release PR boundary) | exists |

### Sampling Rate

- **Per task commit:** the single new test file for that task (quick run command above), plus `npx tsc -p tsconfig.json --noEmit` (`npm run lint`).
- **Per wave merge:** all new `state*.test.js`, `pickup`, `modelChoices`, `runMarkers*`, `activity*` and the existing `profileStore`, `auth`, `conversations`, `privacy`, `agentFleet`, `modelComparisonPage`, `scratch` tests (the ones that touch changed seams; `transcripts` is covered by `conversations`, `privacy`, `agentFleet` which import `TranscriptStore`).
- **Phase gate:** full `npm test` once, then `npm run test:e2e` once, then `npm run verify:release`, all capped and serialized.
- Security, migration, key-handling and any spend-path tests block each task; they are not deferred to the phase gate.

### Wave 0 Gaps

- [ ] `src/test/stateHome.test.ts`, `stateStores.test.ts`, `stateMigration.test.ts` (SYNC-01, SYNC-02)
- [ ] `src/test/stateKeys.test.ts`, `stateRecovery.test.ts`, `stateRestoreProfile.test.ts` (SYNC-03, SYNC-04)
- [ ] `src/test/stateMerge.test.ts`, `stateSyncGit.test.ts`, `stateLeak.test.ts`, `stateTwoMachines.test.ts` (SYNC-05)
- [ ] `src/test/modelChoices.test.ts` (SYNC-06), `pickup.test.ts` (SYNC-07), `runMarkersForeign.test.ts`, `activityShared.test.ts`
- [ ] D-07/D-08/D-09: `threadLog.test.ts`, `threadReplay.test.ts`, `participantRecord.test.ts`, `threadMerge.test.ts`, `historyRetention.test.ts`, `threadArchive.test.ts`, `archiveMerge.test.ts`, `stateLazyFetch.test.ts`, `stateObjects.test.ts`, `stateIdentity.test.ts`, `stateRemote.test.ts`; fixtures: a compaction-triggering transcript builder (run `compactConversation` with a fake client) and a fake `ChatResponseStream`
- [ ] Shared helpers: `src/test/helpers/stateFixtures.ts` (temp project, fake two-editor globalStorage with old-key transcripts, local bare remote builder, `MemorySecrets` as in profileStore.test.ts, git-object scanner for the leak test)
- [ ] No framework install needed (`node:test` already in use)

## Security Domain

`security_enforcement` is not set in `.planning/config.json` (absent = enabled) [VERIFIED: config.json read this session].

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (credential carriage, recovery code as a secret) | 160-bit random code, scrypt, never stored/logged; SecretStorage for the device copy |
| V3 Session Management | no | No sessions introduced |
| V4 Access Control | yes | State home mode 0600/0700; sync only for the opened project; the pick-up card and restore never bypass the existing approval/spend gates; security-scan consent is never synced |
| V5 Input Validation | yes | Strict parsing of every remote byte (manifest, segment JSON, ids against the existing `conv-`/`run-`/`RUN_ID` patterns, size caps, no path from record content used as a file path); a malicious remote branch must not write outside the state home |
| V6 Cryptography | yes | AES-256-GCM with AAD, HKDF-SHA256, scrypt N=2^17 r=8 p=1; no custom primitives; random 96-bit IVs from `randomBytes` |
| V7 Error Handling and Logging | yes | Plain messages; secrets and code never in logs; git messages redacted of URL userinfo |
| V8 Data Protection | yes | Ciphertext only leaves the machine; padding; neutral commit identity; documented public-repo leakage |
| V10 Malicious Code / V12 Files | yes | Records from a remote are data only; never executed; archive/path traversal checks on any path derived from a record |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Offline guessing of the recovery code from a public ciphertext | Information disclosure | 160-bit random code; scrypt as defense in depth; code never user-chosen |
| Tampered, truncated, swapped or deleted segment/manifest | Tampering | GCM tags + AAD (state id, purpose); authenticated manifest listing segment hashes; apply only after all verification passes; state untouched on refusal |
| Rollback to an older valid bundle | Tampering / DoS | Monotonic `seq` pinned locally; never delete local state on pull |
| Path traversal or oversized input from a hostile remote branch | Tampering / DoS | Fixed filename pattern `manifest.json` / `<32hex>.bin`, per-file and total size caps, ids validated by existing regexes |
| Git hook/config execution during sync (pre-push, `core.fsmonitor`, `core.sshCommand` from a hostile repo) | Elevation of privilege | `-c core.hooksPath=<empty>`; run in the private mirror, not the repo's working tree; array args, no shell; do not honor repo-local `core.sshCommand` blindly (Team's `networkEnv` reads it from the repo config; decide consciously) |
| Credential leak in messages | Information disclosure | Strip URL userinfo; `redactSecrets` on every message |
| Repository-chosen push destination (a cloned `.vscode/settings.json` sets `nearAi.sync.remote`) | Tampering / Information disclosure | `scope: machine`, scheme allow-list, `protocol.ext.allow=never` |
| The person's identity in sync commits or a signed push certificate | Information disclosure | Environment override on `commit-tree`, `push.gpgSign=false`, leak test with sentinels |
| Length and count leakage of ciphertext | Information disclosure | Brotli then Padme padding, parts at most 8 MiB, sealed index, random names, constant commit date |
| Plaintext key file beside data (Option C) | Information disclosure | 0600, self-ignored, never bundled; explicit documentation; opt-out setting |
| Syncing consent or permissions to another machine | Elevation of privilege | Allow-list of synced record kinds; consent/permissions never synced |
| Double-run via foreign marker | Repudiation / integrity / money | Writer id + heartbeat; no auto-resume for foreign markers (Pitfall 1) |

## Sources

### Primary (HIGH confidence)

- Live source read this session: `src/services/transcripts.ts`, `src/agent/checkpoints.ts`, `src/services/runMarkers.ts`, `src/services/auth.ts`, `src/domain/auth.ts`, `src/services/profileStore.ts`, `src/services/profileIndex.ts`, `src/services/modelComparisonPanel.ts`, `src/benchmark/store.ts`, `src/benchmark/results.ts` (RUN_ID), `src/services/settings.ts`, `src/services/modelRoles.ts`, `src/services/spendLedger.ts`, `src/services/spendTracking.ts`, `src/services/activityStore.ts`, `src/services/chat.ts` (storage, markers, resume, nudge), `src/extension.ts`, `src/domain/scratch.ts`, `src/services/scratch.ts`, `src/gsd/runtime.ts` (`isNearAiProject`), `src/domain/gsdStatus.ts`, `package.json`, `tsconfig.json`, `.gitignore`, `src/test/profileStore.test.ts`, `src/test/e2e/suite.ts`.
- Live data: code-server globalStorage sizes and layout under `/home/aaron/projects/services/code-server/data/share/User/globalStorage/vitalpoint.near-ai-vscode`.
- Unmerged branch precedent (read via `git show`, not merged): `feat/team-fix-pass:src/team/gitTransport.ts`, `runGit.ts`, `inviteCode.ts`, `projectHome.ts`, `enable.ts` (`networkEnv`).
- Sandbox runs this session: git plumbing (hash-object, mktree, commit-tree, push, fetch, hooks), self-ignoring `.gitignore`, scrypt N=2^17 timing and `maxmem` error, anonymous `ls-remote` public-repo probe.

### Secondary (MEDIUM confidence)

- Node.js 24.7.0 release notes (crypto.argon2 added): https://nodejs.org/en/blog/release/v24.7.0 (via search result; docs JSON listed in v24.8.0).
- OWASP Password Storage Cheat Sheet (scrypt minimum N=2^17, r=8, p=1): https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html (confirmed via search summary and an OWASP pull request, wording not read in full; re-check when planning).

### Tertiary (LOW confidence)

- VS Code 1.101 = Electron 35 / Node 22: https://issues.redhat.com/browse/CRW-9203 (single source; re-check the 1.101.0 tag if Argon2 availability matters).
- code-server SecretStorage in the browser: owner's evidence in CONTEXT.md only; a search found no confirming source (A10).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH, Node built-ins only, existing cipher and test conventions confirmed in source.
- Architecture: MEDIUM-HIGH, store seams, merge and git sequence verified; Open Question 1 (key sharing) is a genuine owner decision.
- Pitfalls: HIGH for the ones tied to read lines (pid liveness, temp-file names, path-derived identity, checkpoint paths, prune churn); MEDIUM for remote-host policy behavior.

**Research date:** 2026-11-13
**Valid until:** 2026-12-13 (stable code paths); re-check the `feat/team-fix-pass` overlap if that branch merges before planning completes.
