# Phase 27: Project state follows the project across interfaces and machines (context)

**Gathered:** 2026-11-13. The owner chose all four recommended options; there was no separate discussion round.
**Release:** 0.4.20, through the usual release PR, before v0.7.0 Phase 68.

## Evidence

On 2026-11-13 the owner opened, in desktop VS Code on the host, projects they had worked on all week through a client connected to the `code-server` container on the same host. The week's progress was missing. The profile needed setting up again. Model choices applied from Compare Models were missing, and redoing the comparison would cost money.

- The container mounts `/home/aaron/projects` at the same path, so project scope ids (`project-<hash>`) and transcript/run folder hashes are identical in both editors. That part is not the cause.
- Per-project data lives in each editor's own `context.globalStorageUri`:
  - code-server: `/home/aaron/projects/services/code-server/data/share/User/globalStorage/vitalpoint.near-ai-vscode`
  - desktop: `~/.config/Code/User/globalStorage/vitalpoint.near-ai-vscode`
  - Data in each: `transcripts/<hash>`, `runs/<hash>`, `checkpoints/`, `evals/*.json` (ComparisonStore), `spend/`, `cyber/<key>`, `teams/*.md`, `team/`. code-server has 5 transcript folders and the 2026-11-12 comparison. Desktop stops at 2026-11-06.
- `applyRecommended` in `src/services/modelComparisonPanel.ts` writes to `ConfigurationTarget.Global` unless the project already sets the value. That is the *user* settings.json, which is separate per editor.
- Secrets are in each editor's SecretStorage, which code-server keeps in the browser: the API key and refresh token (`src/services/auth.ts`, scoped per project) and the transcript key `nearAi.transcripts.key` (`src/services/transcripts.ts`). This is why the profile "needed setup" even though `.planning/.near-ai/auth-profiles.json` (metadata only) was present. It is also why copied transcripts cannot be decrypted elsewhere.
- globalState also holds per-install items: `nearAi.savedProfiles` (profileIndex.ts), Team Studio drafts, the cyber model per project, the spend reporting token id, and emergency stop. Workspace state holds security-scan consent.

## Decisions

- **D-01 Transport across machines: the project's own git remote.** State travels as an encrypted bundle on a dedicated branch of the project's remote (working name `near-ai/state`), never `main` and never mixed into work branches. No new service. The extension does all git work and reports in plain words (owner principle: users never need git).
- **D-02 The API key syncs, unlocked by a recovery code.** Turning sync on generates a high-entropy recovery code (not user-chosen) and shows it once. It is never stored or logged. A strong KDF turns it into the key that wraps the project data key and the NEAR AI key. A new device asks for the code once, then keeps an unwrapped copy in its SecretStorage. Tests cover a wrong code, a tampered bundle and a truncated bundle. This matches the owner's 2026-11-05 recovery-code decision for Team Mode.
- **D-03 Resume UX: a "Pick up where you left off" card.** It shows the last chat, the last run's state (finished, cut off, waiting), and the current GSD phase with its next step from `.planning/`. One click reopens the chat and panels. Nothing re-runs and nothing spends money. A cut-off run uses the existing PERF-05 resume path only when the person clicks.
- **D-04 Same-host first.** Per-project state moves into a git-ignored state home inside the project (working location `.near-ai/state/`, next to the existing `.near-ai/attachments` and `.near-ai/scratch`). Any editor that opens the folder on this machine reads and writes the same files. Cross-machine sync then only has to move that one folder's encrypted form.
- **D-05 Migration merges and never destroys.** On first activation of 0.4.20 each editor merges its own globalStorage data for the open project into the state home. The merge is by record id, idempotent, never overwrites a newer record and never deletes the source. Transcripts encrypted with an install-local key are re-encrypted under the project data key; the editor that holds the old key does this, so code-server's transcripts migrate when code-server next runs 0.4.20.
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
- **D-10 Same-host key: a key file in the project, plus SecretStorage.** (Owner, 2026-11-13, research Q1.) On first creation of the state home, write the project data key to `.near-ai/state/keys/local.key`. The file has mode 0600, is ignored by git (its own ignore rule) and is never added to any bundle, log or sync push. A SecretStorage copy is kept as well. When sync is turned on, the recovery-code wrap is added. The setting `nearAi.sync.keepKeyInProject` (default true) controls the file; turning it off removes the file, and from then on each new editor or browser asks for the recovery code. The README says plainly that chats at rest in the project folder are protected by file permissions on that machine and are end-to-end encrypted everywhere they leave it.
- **D-11 The daily spend limit stays per editor in 0.4.20.** (Owner, research Q4.) Project spend history is mirrored into the state home so it can be seen in every editor (SYNC-01). Making `nearAi.dailySpendLimitUsd` count spend from every editor on the host is deferred to a follow-up release. The 0.4.20 CHANGELOG states the known gap.
- **D-12 Stored tool output is capped at 2 MiB per result, with a visible marker.** (Owner, research Q8.) Every message and tool step is kept. Only a single tool result larger than 2 MiB is shortened, and the history shows a visible "output shortened, N MB" marker. This is the only allowed exception to "nothing truncated" in D-07.
- **D-13 The history shows the lead agent's view in 0.4.20.** (Owner, research Q7.) Every step of the lead agent plus each sub-agent's report goes into the thread log. A sub-agent's own internal steps become linked threads in a later release. The release notes say so.
- **D-06 Model choices follow the project.** Comparison runs are stored in the project's state home, so Compare Models shows them in every interface. "Apply recommended" writes to workspace settings (or to project state read as a project-level default) instead of user settings. Choices already applied globally in one editor are offered for import into the project rather than silently copied.

### Claude's Discretion (research recommendations adopted, 2026-11-13)

- Sync runs only after an explicit "turn on" (research Q2).
- Remote: default `origin`. With several remotes, ask once and store the choice. With none, say "This project has no online home yet" and never run `git remote add` (Q3).
- Migration runs at activation when `isNearAiProject(root)` is true. Otherwise it runs lazily on the first chat, history or compare action, so opening a folder still writes nothing (Q5).
- Old globalStorage folders are left in place (Q6).
- Long threads render fully in chunks in the webview (Q9).
- A thread continued on two machines shows the main line plus a labelled other continuation, and nothing is dropped (Q10).
- Squashing the sync branch's history is deferred unless the size tests demand it (Q11).
- Participant threads appear in the history picker with a "Chat view" label, and each reply has a button that opens the thread in the panel (Q12).

## Requirements (new, SYNC-*)

- **SYNC-01** A project-local state home holds chats, run records, checkpoints, comparison runs, applied model choices, the project's spend history and the resume pointer.
- **SYNC-02** A safe one-time migration from each editor's existing storage, merging without overwriting or deleting.
- **SYNC-03** A portable per-project data key encrypts transcripts. It is wrapped per device in SecretStorage and by the recovery-code key.
- **SYNC-04** A recovery code shown once, a strong KDF, the NEAR AI key carried wrapped, and refusal of a wrong or tampered bundle with tests.
- **SYNC-05** Encrypted sync through a dedicated branch of the project's git remote; per-record merge across machines with no lost entries; a leak test showing no plaintext reaches the remote.
- **SYNC-06** Comparison results and applied model choices visible and effective in every interface without re-running.
- **SYNC-07** The "Pick up where you left off" card.
- **SYNC-08** Release 0.4.20: CHANGELOG, README (Marketplace listing) and the release PR.

## Research flags for the planner

1. **Public repositories.** This repo is public, so ciphertext on its remote is public. Check what that leaks (sizes, timestamps, record counts) and how much entropy the recovery code needs so offline guessing is infeasible. Choose the KDF and its parameters (scrypt with Node's built-in crypto vs Argon2id, which would add a dependency). Consider a per-project switch to use a different (private) remote.
2. **Bundle format.** Decide between one encrypted file per record (cheap merges, leaks counts) and padded chunked bundles. Plan for append-only logs merged by id, and for how deletions propagate (tombstones).
3. **How sync runs git without disturbing the person's work.** Options: a separate worktree or plumbing commands (`git hash-object`/`commit-tree`/`push` to the state ref) so the working tree, index and current branch are never touched. Also handle offline operation, pushes that are rejected, and remotes that need credentials.
4. **SecretStorage in code-server.** Secrets there are per browser profile. The device copy of the unwrapped data key must still work when the same person uses two browsers. The recovery code must cover a browser whose data was lost.
5. **Overlap with the unmerged `feat/team-fix-pass` branch** (Phases 60-67). That branch keys Team Mode records per person under `<globalStorage>/people/<hash>/team/` and plans "per-person spend/runs/chats on a shared server". Design the state home so per-person subfolders can be added later. Do not move Team Mode records in this phase.
6. **Which globalState items should become project state:** saved-profile index, cyber model choice, Team Studio drafts, security-scan consent. Some should stay per device (emergency stop, reporting token id).
7. **Size.** The code-server `checkpoints/` is 3.8 MB and `transcripts/` 11 MB. Decide what is synced and what stays local (for example, checkpoints only on request) and set limits.

## Deliberately not done

- **Private sync remote (deferred, specified in D-09).** The `nearAi.sync.remote` setting and its UI are built in a later phase. This phase only keeps the remote a parameter of the sync layer.

- No NEAR AI hosted store and no VS Code Settings Sync. Settings Sync is not available in code-server.
- Team Mode records and the shared team library are not moved. The team library (`teams/*.md`) stays per user; see flag 5.
- Live, in-flight runs are not handed between machines. Only finished or cut-off state syncs, and resuming always takes a click.
