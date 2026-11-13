# Phase 27: Project state follows the project - Pattern Map

**Mapped:** 2026-11-13
**Files analyzed:** 24 (new and modified)
**Analogs found:** 22 / 24

All analog paths below are git-tracked on `main`, except those marked `[feat/team-fix-pass]`. Read those with `git show feat/team-fix-pass:<path>` and copy the code. Do not import across branches, because the branch is unmerged. Line numbers refer to the files as read on 2026-11-13.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/domain/state/recoveryCode.ts` (new) | utility | transform | `[feat/team-fix-pass] src/team/inviteCode.ts` | exact (copy) |
| `src/domain/state/keys.ts` (new) | utility | transform | `src/services/transcripts.ts` (AES-GCM envelope), invite HKDF | role-match |
| `src/domain/state/segments.ts` (new) | utility | transform | `src/services/transcripts.ts` `encode`/`decode` | partial |
| `src/domain/state/records.ts`, `merge.ts` (new) | utility | transform | `src/services/spendLedger.ts` (id+version merge); no pure-merge analog | partial |
| `src/domain/state/pickup.ts` (new) | utility | transform | `src/domain/gsdStatus.ts` (`parseGsdPlanningState`) | role-match |
| `src/services/stateHome.ts` (new) | service | file-I/O | `src/services/transcripts.ts` `write`, `src/domain/scratch.ts` | role-match |
| `src/services/stateMigration.ts` (new) | service | batch | `src/services/transcripts.ts` `read` (re-save on read) | partial |
| `src/services/stateKeys.ts` (new) | service | request-response | `transcriptKey` in `src/services/transcripts.ts` | exact |
| `src/services/stateGit.ts` (new) | service | request-response | `[feat/team-fix-pass] src/team/runGit.ts` | exact (copy) |
| `src/services/stateSync.ts` (new) | service | event-driven | `[feat/team-fix-pass] src/team/gitTransport.ts` | role-match |
| `src/services/modelChoices.ts` (new) | service | CRUD | `src/services/settings.ts` readers, `modelComparisonPanel.ts` apply | role-match |
| `src/services/pickupCard.ts` + `media/chat/pickup.js` (new) | component | event-driven | `setupNudgeShows` in `chat.ts:123`, `media/chat/setup.js` | exact |
| `src/services/transcripts.ts` (modify) | service | CRUD | itself | modify |
| `src/services/runMarkers.ts` (modify) | service | CRUD | itself | modify |
| `src/services/chat.ts`, `chatParticipant.ts`, `agentSession.ts` (modify) | controller | request-response | themselves | modify |
| `src/benchmark/store.ts` (modify) | service | file-I/O | itself | modify |
| `src/services/settings.ts`, `modelComparisonPanel.ts`, `toolsDirectory.ts`, `teamStudioPanel.ts` (modify) | service | request-response | themselves | modify |
| `src/services/activityStore.ts` (modify) | service | file-I/O | itself | modify |
| `src/domain/scratch.ts` (modify) | utility | transform | itself | modify |
| `src/test/state*.test.ts` (new) | test | n/a | `src/test/profileStore.test.ts` | exact |
| `package.json`, `CHANGELOG.md`, `README.md` (modify) | config | n/a | prior release PR (0.4.19, commit `72ebd4e`) | exact |

## Pattern Assignments

### `src/domain/state/recoveryCode.ts` (utility, transform)

**Analog:** `[feat/team-fix-pass] src/team/inviteCode.ts` lines 1-55. Copy `encode`, `generateInviteCode`, `formatInviteCode`, `parseInviteCode` and rename them. Drop the Ed25519 half. Leave a "dedupe when Team merges" comment.

```typescript
import { randomBytes } from 'node:crypto';
export const INVITE_CODE_BYTES = 20;            // 160 bits
const CODE_CHARACTERS = 32;
const GROUP_SIZE = 4;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// parse: strip [\s-], uppercase, I/L -> 1, O -> 0, length must be 32, any non-alphabet char -> undefined
```

### `src/domain/state/keys.ts` and `segments.ts` (utility, transform)

**Analog:** `src/services/transcripts.ts` lines 10-12 and 44-62 (AES-256-GCM envelope with base64 `iv`/`tag`/`data`). Extend it as follows:
- Add AAD through `cipher.setAAD(Buffer.from('near-ai/state/v1|<stateId>|<class>'))` and the same call on the decipher.
- Derive a per-object key with `hkdfSync('sha256', DK, salt16, info, 32)`. The invite code at `inviteCode.ts` line 11 and `privateKeyFor` show the HKDF call shape.
- Derive the KEK with `scryptSync(code, salt, 32, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })`. The `maxmem` argument is mandatory, because the default raises `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
- Keep `vscode` out of these files so they run under plain `node --test`.

```typescript
// transcripts.ts:44-51 (copy shape, add AAD + per-object key)
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
const data = Buffer.concat([cipher.update(JSON.stringify(transcript), 'utf8'), cipher.final()]);
const envelope = { enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
// decode (transcripts.ts:55-60): decipher.setAuthTag(...); decipher.final() THROWS on tamper. Map that to the single plain "wrong code or damaged" message.
```

### `src/services/stateKeys.ts` (service, request-response)

**Analog:** `transcriptKey` / `sharedTranscriptKey`, `src/services/transcripts.ts` lines 14-34. This is the SecretStorage get-or-create pattern. Clone it for the data key under the key name `nearAi.state.<stateId>.dataKey`. Add the D-10 key-file fallback by reading `.near-ai/state/keys/local.key` first when `keepKeyInProject` is true.

```typescript
export function transcriptKey(secrets: { get(key: string): Thenable<string | undefined> | Promise<string | undefined>; store(key: string, value: string): Thenable<void> | Promise<void> }): () => Promise<Buffer> {
  let key: Promise<Buffer> | undefined;
  return () => { key ??= (async () => {
      const stored = await secrets.get('nearAi.transcripts.key');
      if (stored && Buffer.from(stored, 'base64').length === 32) return Buffer.from(stored, 'base64');
      const fresh = randomBytes(32);
      await secrets.store('nearAi.transcripts.key', fresh.toString('base64'));
      return fresh; })(); return key; };
}
```

Keep the structural `secrets` type, not `vscode.SecretStorage`, so tests can pass the `MemorySecrets` class from `src/test/profileStore.test.ts` lines 11-16. The migrator needs the OLD key by this name (`nearAi.transcripts.key`), so keep this function.

### `src/services/stateGit.ts` (service, request-response)

**Analog:** `[feat/team-fix-pass] src/team/runGit.ts` (whole file, about 110 lines). Copy it. It provides `spawn('git', args)` with array args, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `GCM_INTERACTIVE=never`, a detached process group with a kill-tree timeout, a `maxStdoutBytes` cap, and stdin `input`. It also provides `gitText`, `GitNotFoundError`, `GitCommandError` and `redactGitMessage`.

Change only the identity constant. Per D-09 it must be:

```typescript
export const STATE_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'near-ai-state', GIT_AUTHOR_EMAIL: 'state@near-ai.invalid',
  GIT_COMMITTER_NAME: 'near-ai-state', GIT_COMMITTER_EMAIL: 'state@near-ai.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
};
```

The Team original is `NEUTRAL_IDENTITY_ENV` with 'NEAR AI Team' (runGit.ts lines 14-20). Pass it only through `options.env` on the `commit-tree` call.

### `src/services/stateSync.ts` (service, event-driven)

**Analog:** `[feat/team-fix-pass] src/team/gitTransport.ts`. It is a role-match, not a copy, because it uses a different ref and no event log. Take these pieces:
- **Header and design (lines 1-9):** a bare mirror, the user's tree is never touched, and a cross-process lock because several windows share one mirror. Copy `src/team/mirrorProcessLock.ts` (`acquireMirrorLock`, `MirrorBusyError`) and `withMirrorLock` (line 109).
- **Failure classification (lines 127-155):** `classifyPush`, `classifyGitFailure`, `CAS_LOST_MARKERS`, `RETRYABLE_FETCH_MARKERS` and `AUTH_HINT` (line 53, "Run git fetch once in a terminal so your credential helper can store the credentials."). Reuse the auth hint wording for the sync messages.
- **Hooks off (line 360):** `setMirrorConfig('core.hooksPath', hooksDir)`. The research also adds `-c core.hooksPath=<emptydir> -c commit.gpgsign=false -c push.gpgSign=false` on every call.
- **Plumbing sequence:** see the RESEARCH Pattern 8 script (`hash-object -w`, `mktree`, `commit-tree` with `STATE_IDENTITY_ENV`, `push "$REMOTE" "$COMMIT":refs/heads/near-ai/state`, `fetch +refs/heads/near-ai/state:refs/near-ai/incoming`).
- **Constants to define:** `STATE_REF = 'refs/heads/near-ai/state'` (the Team equivalent is `DEFAULT_COORDINATION_REF`, line 22) and `INCOMING_REF = 'refs/near-ai/incoming'` (Team: line 26).
- **Remote is a parameter:** `new StateSync({ remote })`, default `'origin'`. Never hard-code the name.
- **Commit message:** the constant `Update encrypted project state`.
- **Tree shape:** flat. Only `manifest.json` and `<32 hex>.bin` are allowed, so the leak test regex is `^(manifest\.json|[0-9a-f]{32}\.bin)$`.
- **No force push** in v1.

### `src/services/stateHome.ts` (service, file-I/O)

**Analog:** `src/services/transcripts.ts` `write` (lines 81-87), `src/domain/scratch.ts` lines 12-24.

```typescript
// transcripts.ts:81-87: atomic write. CHANGE: temp suffix must be random, not process.pid (pid collides between container and host, Pitfall 3)
await mkdir(this.dir, { recursive: true });
const file = path.join(this.dir, `${transcript.id}.json`);
const temporary = `${file}.${process.pid}.tmp`;   // -> `${file}.${randomBytes(6).toString('hex')}.tmp`
await writeFile(temporary, await this.encode(transcript), { encoding: 'utf8', mode: 0o600 });
await rename(temporary, file);
```

Apply the same random-suffix fix at `src/benchmark/store.ts:21` (`ComparisonStore.save`) and anywhere else `process.pid}.tmp` appears. Find them with `grep -rn 'pid}.tmp' src`.

Scratch constants (`src/domain/scratch.ts`):

```typescript
export const SCRATCH_DIR = '.near-ai/scratch';
export const SCRATCH_IGNORE_LINES: readonly string[] = Object.freeze(['.near-ai/scratch/', '.near-ai/attachments/']);
export function scratchFolder(root: string): string { return path.join(root, '.near-ai', 'scratch'); }
```

Add a `STATE_DIR = '.near-ai/state'`, a `stateFolder(root)` helper and `.near-ai/state/` to `SCRATCH_IGNORE_LINES` as the second line of defense. The real invariant is a self-ignoring inner `.gitignore` containing `*`, written before any other file in the folder. Also write `keys/local.key` with mode 0o600 (D-10), as `transcripts.ts:85` does with `{ mode: 0o600 }`.

### `src/services/transcripts.ts` (modify: thread store)

**Analog:** itself.
- **Constructor (lines 41-43):** `storageDir` plus a path hash of the root. Re-point it to `<state>/transcripts` and take the data key.
- **Remove `prune()` (lines 119-122) and the `MAX_TRANSCRIPTS` constant (line 6).** D-08 says threads are archived, never deleted. `save` (line 71-75) calls `prune`.
- **`list()` (lines 89-97):** `read` returns `undefined` on any error, so undecryptable files vanish (Pitfall 7). Return them as `locked: true` summaries instead.
- **Id check:** `/^conv-[a-z0-9-]{6,60}$/` is repeated at lines 72, 78 and 100. Keep it.
- **Migration reuse:** `read()` lines 102-111 already do a "plain then re-save encrypted" step. The migrator generalizes it: decrypt with the old key and re-encrypt under the data key.

### `src/services/runMarkers.ts` (modify: liveness)

**Analog:** itself.
- **Constructor (lines 55-60):** `path.join(storageDir, 'runs', sha256(root)[0:16])`. Re-point to `<state>/runs`.
- **Replace `processAlive(pid)` (lines 41-44):** `process.kill(pid, 0)` is wrong across the container's pid namespace. Use a heartbeat (`activeAt` freshness) plus a writer id stored in the marker. The `RunMarker.pid` field (line 29) is the one to supplement. Auto-resume must not fire for a foreign-writer marker.
- **Options (lines 38-43):** the injected `pid`, `now` and `alive` options are the test seam. Add a `writer` option the same way.
- **Existing markers carry only IDs, times and tool names (header, lines 8-9).** Keep that invariant.

### `src/benchmark/store.ts` (modify: union store)

**Analog:** itself, lines 9-34. `ComparisonStore(dir)` becomes an ordered list of dirs: `list()` is the union de-duplicated by run id, `save()` writes to the state home and to global (dual write). `fileFor` validates against `RUN_ID` (`src/benchmark/results.ts:92`). `teamStudioPanel.ts` lines 55 and 182 construct their own `ComparisonStore`. Switch them to the same helper.

### `src/services/modelChoices.ts` (service) with `settings.ts` and `modelComparisonPanel.ts` (modify)

**Analog:** `src/services/settings.ts` readers and `src/services/modelComparisonPanel.ts` lines 261-265 and 299-302.

```typescript
// modelComparisonPanel.ts:261-265 (and 299-302): the current target decision
const inspected = configuration.inspect(option.setting);
const inWorkspace = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
const target = inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
const previous = inWorkspace ? inspected?.workspaceValue : inspected?.globalValue;
```

The undo map (line 41) is `Map<string, Array<{ setting; previous; target: ConfigurationTarget; label }>>`. Add a project-state variant. The readers to route through one resolver (precedence: explicit workspace or folder value, then project `choices.json`, then user value, then default) are `readSettings` (settings.ts:11, `defaultModel` at line 19), `readRoleModels` (:42), `readModelTiers` (:48) and `readSafetyModel` (:58). `toolsDirectory.ts` lines 208-213 display the same settings and need the same resolver.

### `src/services/pickupCard.ts` and `media/chat/pickup.js` (component, event-driven)

**Analog:** `media/chat/setup.js` lines 1-58 and `src/services/chat.ts` line 123.

```javascript
// setup.js:5-9,39-47: IIFE module; renderSetupNudge(doc, container, show, post, afterDismiss)
// idempotent by id ('setup-nudge'), section role=region aria-labelledby, one action posted per button
const card = make('section', 'setup-nudge');
card.id = 'setup-nudge';
card.setAttribute('role', 'region');
card.setAttribute('aria-labelledby', 'setup-nudge-title');
// buttons: post({ type: 'setup-nudge', action })
```

```typescript
// chat.ts:123 host side: latestOnly debounce, post { type, show }
const setupNudge = latestOnly(() => setupNudgeShows(context, auth), (show) => { if (!disposed) void panel.webview.postMessage({ type: 'setup-nudge', show }); });
// chat.ts:399 the one-click action to reuse. It must NOT call settleInterrupted / autoResumeChoice.
if (message.type === 'resume-conversation') { await openSaved(message.id); return; }
// chat.ts:446 inbound handler for the card's action: `if (message.type === 'setup-nudge') {`
```

Make a `pickup-card` / `pickup-card-action` message pair. The page script file must be registered the same way `setup.js` is (check how `chat.js` and the webview HTML load `setup.js`). Model derivation is in `src/domain/state/pickup.ts` on top of `parseGsdPlanningState` (`src/domain/gsdStatus.ts`) and `TranscriptStore.list()`.

### `src/services/stateMigration.ts` (service, batch)

**Analog:** the `TranscriptStore.read` re-save-on-read behavior (above) and the RESEARCH Pattern 10 algorithm. There is no existing migrator, so this is a partial match. Follow these rules:
- Sources are the editor's `globalStorage` folders: `transcripts/<hash16>`, `runs/<hash16>`, flat `checkpoints/<runId>.json`, `evals/*.json` and `spend/<identity>/*.jsonl` filtered by `proj`.
- Merge by `(kind, id)` and never overwrite a newer record.
- Use a random temp suffix.
- Never delete the source.
- Mark the `meta.json` `migrated` field as an optimization only.
- Surface undecryptable transcripts as locked.

### Tests: `src/test/state*.test.ts` (new)

**Analog:** `src/test/profileStore.test.ts` lines 1-40. The file is `node:test` + `node:assert/strict`, with a `MemorySecrets implements SecretStorageLike` class, `mkdtemp(path.join(tmpdir(), 'near-ai-...-'))` temp roots, and `try { ... } finally { await rm(root, { recursive: true, force: true }); }`. Tests compile to `dist/test` through the existing `test` script. Run them with the memory cap from the standing rule (`systemd-run --user --scope -q -p MemoryMax=4G -p MemorySwapMax=0 choom -n 1000 -- timeout 900 env NODE_OPTIONS=--max-old-space-size=1536 ...`). The leak test uses a real local bare remote (RESEARCH "Leak test shape"). Required cases: wrong code, tampered bundle, truncated bundle, merge commutativity/associativity/idempotence (property test), and the leak scan of tree, commits and messages for the person's name and email.

### Release files (SYNC-08)

**Analog:** the 0.4.19 release (`72ebd4e chore(release): 0.4.19 (#38)`) and `docs/development-workflow.md`. Look at that commit's diff for exactly which files change (`package.json` version, `CHANGELOG.md`, `README.md`). The CHANGELOG states the D-11 spend-limit gap and the D-13 sub-agent note.

## Shared Patterns

### Atomic write with random temp name
**Source:** `src/services/transcripts.ts:81-87`, `src/benchmark/store.ts:19-23`. **Apply to:** every state-home writer. Replace `process.pid` in the temp name with a random hex suffix, because pid collides across the container and the host.

### Injected `now` / `pid` / `alive` test seams
**Source:** `src/services/runMarkers.ts:38-43,55-60`. **Apply to:** `RunMarkers`, `StateSync` (inject the `GitRunner` as Team's `options.git ?? runGit` does at gitTransport.ts:238), the migrator and the pickup derivation.

### Structural SecretStorage type
**Source:** `transcripts.ts:21` and `MemorySecrets` in `profileStore.test.ts:11-16`. **Apply to:** all key-handling services.

### Plain-words messages
**Source:** `AUTH_HINT` in the Team `gitTransport.ts:53`. **Apply to:** all sync status. Say "your organization", never "NEAR organization". Strip URL userinfo with `redactGitMessage` before any message or log reaches the user.

### Pure core, thin vscode shell
**Source:** `src/domain/*` (for example `scratch.ts`, which has no I/O) against `src/services/*`. **Apply to:** `src/domain/state/*` never imports `vscode`.

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/domain/state/merge.ts` (per-record merge, fork rule, thread-entry hash chain) | utility | transform | No pure CRDT-style merge exists. `SpendLedger` has id+`v` versioning (`spendLedger.ts` around lines 142-149) but not forks. Use RESEARCH Patterns 6 and 11 and the "Deterministic record merge" example. |
| Padme padding + brotli object envelope | utility | transform | Nothing compresses or pads today. Use RESEARCH Pattern 5. |
| Thread log (append-only message log), archive, `@near` participant recorder | service | streaming | `ConversationLog` in `src/services/conversations.ts` (line 93+) is in-memory only and capped. Use RESEARCH Patterns 11 and 12. The hook points are `beforeTurn` and `saveTranscript` in `src/services/agentSession.ts` (about lines 383-425 and 1030). |
| Next-step derivation for the pick-up card | utility | transform | RESEARCH Pattern 9 notes that none exists. Verify with a fixture under `test/fixtures/gsd-import/planning`. |

## Metadata

**Analog search scope:** `src/services`, `src/domain`, `src/benchmark`, `src/test`, `media/chat`, and `feat/team-fix-pass:src/team`.
**Not read in full (read before editing):** `chat.ts`, `agentSession.ts`, `chatParticipant.ts`, `spendLedger.ts`, `activityStore.ts`, `mirrorProcessLock.ts` (Team branch).
**Tracked-source check:** `git ls-files` confirmed `transcripts.ts`, `runMarkers.ts`, `scratch.ts` and `setup.js` are tracked. All other main-branch analogs were found by `src/` Glob and are not gitignored mirrors.
**Pattern extraction date:** 2026-11-13
