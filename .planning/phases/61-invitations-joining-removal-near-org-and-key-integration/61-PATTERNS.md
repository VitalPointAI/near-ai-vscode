# Phase 61: Invitations, joining, removal, NEAR org and key integration - Pattern Map

**Mapped:** 2026-11-01
**Files analyzed:** 27 new or modified
**Analogs found:** 26 / 27 (all analog paths verified git-tracked under `src/`; no mirror paths)

Decisions D-21 to D-28 (CONTEXT.md) supersede the research where the invitee creates their own key: the lead's client creates the key with `spendLimit` = allocation and seals it to the member's device in a signed log event. Patterns below follow CONTEXT.md.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `src/domain/team/types.ts` (mod) | model | transform | itself (lines 20-36 body interfaces, 33 `IMPLEMENTED_EVENT_TYPES`) | exact |
| `src/domain/team/validate.ts` (mod) | validator | transform | itself `BODY_VALIDATORS` (lines 170-205) | exact |
| `src/domain/team/materialize.ts` (mod) | service (reducer) | event-driven | itself `applyTransition`, `authorisationProblem`, `parseMember` | exact |
| `src/domain/team/permissions.ts` (mod) | utility | request-response | itself (`member.invite` row, `actionForEvent`) | exact |
| `src/domain/team/secrets.ts` (mod) | utility | transform | itself `isExemptKeyMaterial` (lines 40-42) | exact |
| `src/domain/team/invite.ts` (new, pure) | utility | transform | `src/domain/team/policy.ts` (pure, no I/O) | role-match |
| `src/team/inviteCode.ts` (new) | utility | transform | `src/team/identity.ts` (node:crypto keys, base64url) | role-match |
| `src/team/keySeal.ts` (new; X25519+HKDF+AES-GCM) | utility | transform | `src/team/identity.ts` + `src/domain/team/canonical.ts` (strict base64url) | partial |
| `src/team/identity.ts` (mod: X25519 device key) | utility | CRUD (SecretStorage) | itself `createDeviceIdentity`/`loadDeviceIdentity` | exact |
| `src/team/inviteBundle.ts` (new) | utility | transform | `src/domain/team/canonical.ts` + `src/team/teamFile.ts` strict parse | role-match |
| `src/team/nearOrg.ts` (new) | service | request-response | `src/services/reportingSignIn.ts` lines 188-270 (`call`, `errorText`, `FetchLike`) | exact |
| `src/team/nearSession.ts` (new) | service | CRUD (SecretStorage) | `src/team/identity.ts` secret-name functions | role-match |
| `src/team/invite.ts`, `join.ts`, `remove.ts`, `confirm.ts`, `nearLink.ts` (new) | service | request-response + git | `src/team/enable.ts` | exact |
| `src/team/cleanupChecklist.ts` (new) | service | file-I/O | `src/team/teamFile.ts` (`writeTeamFile`, `teamStorageDir`) | role-match |
| `src/team/teamFile.ts` (mod: write `near`) | utility | file-I/O | itself | exact |
| `src/team/eventLog.ts` (mod: allow joiner/invited intents) | service | event-driven | itself `prepareEvents` lines 84-111 | exact |
| `src/services/team/nearSignIn.ts` (new; extracted `browserSignIn`) | service (vscode) | request-response | `src/services/spendTracking.ts` lines 114-155 | exact (extraction) |
| `src/services/team/teamCommands.ts` (mod) | controller (commands) | request-response | itself `enable()` + `guarded()` | exact |
| `src/services/team/teamSession.ts` (mod) | service | event-driven | itself | exact |
| `src/services/team/teamStatusBar.ts` (mod: pending count) | component | event-driven | itself `statusText` | exact |
| `package.json` (mod: contributes) | config | n/a | lines 206-215 | exact |
| `src/test/helpers/fakeNear.ts` (new) | test helper | request-response | `src/test/helpers/teamHarness.ts` (no `.test` suffix) | role-match |
| `src/test/teamInvite*.test.ts`, `teamJoin.test.ts`, `teamRemove.test.ts`, `teamNearOrg.test.ts`, `teamKeySeal.test.ts` (new) | test | request-response | `src/test/teamEnable.test.ts`, `teamValidate.test.ts`, `teamMaterialize.test.ts` | exact |
| `src/test/teamSecrets.test.ts` (mod) | test | transform | itself | exact |
| privacy canary test extension | test | file scan | `src/test/helpers/teamCanary.ts` + `teamEnable.test.ts` | exact |
| live NEAR test (env flag) | test | request-response | no analog | none |

## Pattern Assignments

### `src/domain/team/types.ts` (model) and `validate.ts` (validator)

**Analog:** same files. `member.invited` is in `TEAM_EVENT_TYPES` (line 14) but not `IMPLEMENTED_EVENT_TYPES` (types.ts:33). Add the body interface, add to `ImplementedEventBodies` (line 31), add to `IMPLEMENTED_EVENT_TYPES`, and add a validator entry. One new type for the sealed key event is allowed (D-23); it must also be added to `TEAM_EVENT_TYPES` since the union type is derived from it, and the "all 54 types" comment/test must change accordingly.

Body interface style (types.ts:23-25):
```typescript
export interface MemberJoinedBody { memberId: string; name: string; emailHashes: string[]; role: Role; device: DeviceRef }
export interface MemberRoleChangedBody { memberId: string; role: Role }
export interface MemberRemovedBody { memberId: string }
```
`Member` (types.ts:51) already has optional `nearApiKeyId`; add optional `status`/invite fields (expiry, proof public key, requested role, allocation) as optional so `parseMember` and snapshots stay compatible (research Pitfall 9). `TEAM_REJECTION_REASONS` (types.ts:73-88) is the place for new fixed reasons (e.g. invite missing, expired, used, code proof bad).

Validator pattern (validate.ts:170-176 and 82-93): exact keys via `checkKeys`, per-field helpers returning a reason string or `undefined`, chained with `??`; never spread parsed input.
```typescript
'member.joined': (body) => checkKeys(body, 'body', ['memberId', 'name', 'emailHashes', 'role', 'device'])
    ?? validateId(body.memberId, MEMBER_ID_PATTERN, 'body.memberId')
    ?? validateName(body.name, 'body.name')
    ?? validateEmailHashes(body.emailHashes, 'body.emailHashes')
    ?? validateChoice(body.role, ROLES, 'body.role')
    ?? validateDeviceRef(body.device, 'body.device'),
```
`member.joined` extension: add the X25519 public key as an optional/required field with `isStrictBase64url(value, 32)` (canonical.ts:106-112), plus the invite countersignature (`isStrictBase64url(sig, 64)`). `validateDeviceRef` (validate.ts:98-109) is the model for a key field bound to a fingerprint. Optional fields use the `Object.prototype.hasOwnProperty.call(body, 'x') ? validate(...) : undefined` idiom (validate.ts:166-167).

Sealed-key event body: fixed-length strict fields (ephemeral public key 32 bytes, nonce 12, tag 16, ciphertext length-bounded) all checked with `isStrictBase64url`; keep total under `MAX_EVENT_BYTES` (16 KB, canonical.ts:7).

### `src/domain/team/materialize.ts` (reducer)

**Analog:** itself. Edit points:

- `authorisationProblem` (lines 105-111): today any `member.joined` not the owner's genesis join is rejected with `ownerJoinOnly`. Replace with the invite-gated rule (author is the invited member's pending record, devices unbound, countersignature verifies, role valid, expiry rule).
```typescript
function authorisationProblem(state: TeamState, event: ImplementedTeamEvent): string | undefined {
  if (event.type === 'team.created') return R.genesisOnly;
  if (event.type === 'member.joined') return isOwnerJoin(state, event) ? undefined : `${R.notPermitted}: ${R.ownerJoinOnly}`;
  const action = actionForEvent(event);
  ...
```
- Gotcha: `boundKey` (lines 86-95) requires the author's device to be already bound (`deviceIndex`) before the event is accepted. A joiner's first event cannot satisfy that, so the joiner path must be handled before step 3 in `applyEntry` (lines 214-250). This is research Pattern 2 "self-bound join in the pipeline" (RESEARCH.md lines 336-345). Read the rest of `applyEntry` (250-ish) before editing.
- `applyTransition` `member.joined` branch (lines 165-172) only updates the owner. Add the joiner branch (set name/emailHashes/devices/deviceIndex, status active/observer) and the `member.removed` branch (lines 176-180) release logic: claims to `ready`, leases released, allocations revoked (D-19). `state.items/claims/leases/allocations` already exist on `TeamState`.
```typescript
case 'member.removed': {
  const member = memberOf(state, event.body.memberId);
  member.removedEvent = event.id;
  member.removedAt = event.at;
  return;
}
```
- `referenceProblem` (lines 121-153): `member.removed` currently uses `lookupMember` (rejects missing/removed) which already works for invited members once they are in `state.members`.
- Removal revokes devices positionally: `boundKey` already rejects authors whose `member.removedEvent` is set (line 93), so Phase 60 D-11 behaviour comes free.
- `parseMember` (lines 400-418) uses `plainRecord(value, path, required, optional)`: add new optional fields to the `optional` list and parse them, so snapshots round trip. `stateHash` (307-318) must include them deterministically.

### `src/domain/team/permissions.ts`

**Analog:** itself. `member.invite`, `member.remove`, `member.change-role` rows are `MANAGERS` (owner, lead). `actionForEvent` (line 171) maps events to actions; add `member.invited` -> `member.invite`, sealed-key event -> lead/owner only (a new action kind or reuse `member.change-role`). Cancel is `member.removed` on an invited id (D-10). Check `decideTeamAction` (line 155) for the lead-cannot-remove-owner style guards before adding.

### `src/domain/team/secrets.ts` (strict-shape exemption)

**Analog:** itself, lines 38-46. This is the template for the sealed-field exemption (D-23):
```typescript
const PUBLIC_KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE_SHAPE = /^[A-Za-z0-9_-]{86}$/;
...
function isExemptKeyMaterial(key: string | undefined, text: string): boolean {
  return (key === 'publicKey' && PUBLIC_KEY_SHAPE.test(text)) || (key === 'sig' && SIGNATURE_SHAPE.test(text));
}
function stringIsFinding(key: string | undefined, text: string): boolean {
  return isExemptKeyMaterial(key, text) ? isPrivateKeyMaterial(text) : looksSecret(text);
}
```
Add named keys (for example `ephemeralPublicKey` 43 chars, `nonce` 16 chars for 12 bytes, `tag` 22 chars for 16 bytes, `ciphertext` variable length base64url bounded, plus the X25519 `agreementKey`/countersignature) to `isExemptKeyMaterial` with exact-shape regexes. Random base64url can accidentally contain `sk-xxxxxxxx` or `rt_...` (Pitfall 10). Do not widen to any string under these names, only the exact shape. The `redactSecrets(text) !== text` fallback in `looksSecret` (line 52) also matters: confirm exempt strings are not affected because exempt shapes skip it. `assertNoSecrets` stays on the write path only (comment, lines 1-4). Tests: extend `src/test/teamSecrets.test.ts` using the `rawKeyPair()`/`hex()` run-time-built secret style (test lines 1-25), including a ciphertext deliberately containing a token-looking substring.

### `src/team/identity.ts` (X25519 device key, mod) and `src/team/keySeal.ts` (new)

**Analog:** `src/team/identity.ts`.

Secret name and storage (lines 9-14, 37-54):
```typescript
export const DEVICE_KEY_SECRET_PREFIX = 'nearAi.team.deviceKey.';
export function deviceKeySecretName(teamId: string): string { return `${DEVICE_KEY_SECRET_PREFIX}${teamId}`; }
...
export async function createDeviceIdentity(secrets: SecretStorageLike, teamId: string): Promise<DeviceIdentity> {
  const name = deviceKeySecretName(teamId);
  if (await secrets.get(name)) throw new Error('This device already has a key for this team. ...');
  const { privateKey } = generateKeyPairSync('ed25519');
  const stored = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  await secrets.store(name, stored);
  return identityFrom(teamId, privateKey);
}
```
Copy for an X25519 agreement key under a distinct name (for example `nearAi.team.agreementKey.<teamId>`), `generateKeyPairSync('x25519')`, pkcs8 DER base64 in SecretStorage, raw public via `export({format:'jwk'}).x` as in `publicKeyRawOf` (lines 24-28). Note: the stored pkcs8 form differs from the Ed25519 prefix `MC4CAQAwBQYDK2VwBCIEI` that `PKCS8_ED25519` in secrets.ts detects; the X25519 prefix is `MC4CAQAwBQYDK2VuBCIEI`, so stored forms are not caught by the existing detector. Add that prefix to `SECRET_PATTERNS` and to `deviceKeyForms` in `src/test/helpers/teamCanary.ts`. Extend `forgetDeviceIdentity` (line 63) to delete the agreement key too (D-20). Include `agreement` public key in `DeviceIdentity` or a sibling type; do not change `identityFrom` signature in ways that break `teamIdentity.test.ts`.

`keySeal.ts`: no existing seal code. Use `node:crypto` only: `generateKeyPairSync('x25519')` ephemeral, `diffieHellman({privateKey, publicKey})`, `hkdfSync('sha256', shared, salt, info, 32)`, `createCipheriv('aes-256-gcm', key, nonce)` with `setAAD(canonicalBytes({teamId, memberId, device, keyId}))`, 12-byte random nonce, 16-byte tag. Reuse `canonicalBytes` for the AAD (canonical.ts:70) and `isStrictBase64url` for decoding fields. Follow the `try { ... } catch { return false }` verdict style of `verifySignature` (canonical.ts:114-123) for open failures. Export a pure `seal(plaintext, recipientPublicKey, context)` and `open(sealed, privateKey, context)`. Zero/overwrite the plaintext Buffer after sealing (D-23).

### `src/team/inviteCode.ts` (new) - code, derived Ed25519 key, countersignature

**Analog:** `src/team/identity.ts` (key construction) and `canonical.ts` (SPKI prefix, verify).
```typescript
// canonical.ts:12 -  SPKI prefix to rebuild an Ed25519 public key from 32 raw bytes
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
// canonical.ts:117 - verification of a raw public key and signature
const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKey, 'base64url')]), format: 'der', type: 'spki' });
return edVerify(null, bytes, key, Buffer.from(signature, 'base64url'));
```
Derived-key snippet is already verified in RESEARCH.md "Deriving the invite key" (line 436); copy it from there (build the private key from a 32-byte seed with the PKCS8 prefix, derive via HKDF/SHA-256 of the code). Verification of the countersignature can call `verifySignature(bytes, sig, derivedPublicKey)` from canonical.ts directly. Random bytes pattern: `randomBytes` as in `newMemberId` (identity.ts:100). Code must be at least 128 bits (D-09); do not log it; `PKCS8_ED25519` in secrets.ts would catch a stored derived seed in PKCS8 form, which is a useful safety net.

### `src/team/inviteBundle.ts` (new)

**Analog:** `src/domain/team/canonical.ts` (`canonicalize`, `isStrictBase64url`) and `src/team/teamFile.ts` (`exactKeys`, `refuse`, strict parse; size limit `MAX_TEAM_FILE_BYTES`, lines 15-60). Bundle format `near-ai-invite-v1.<base64url(canonicalize(json))>`; parse with exact-key check, size cap, patterns reused from validate.ts (`TEAM_ID_PATTERN`, `COORDINATION_REF_PATTERN` and `REMOTE_NAME_PATTERN` in teamFile.ts:15-16). Credentials removed from the repo URL (D-06): use `new URL()`, clear `username`/`password`, reject query/fragment tokens; redaction helper `redactGitMessage` in `src/team/runGit.ts` is the existing URL-credential scrubber (used at enable.ts:50-56). Never log the URL (Phase 60 D-34).

### `src/team/nearOrg.ts` (new, vscode-free typed NEAR client)

**Analog:** `src/services/reportingSignIn.ts` lines 188-270. Copy the injected `FetchLike`, `call`, `errorText`, `signOut` shapes; the module must not import `vscode`.
```typescript
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
const REQUEST_TIMEOUT_MS = 30_000;
async function call(fetchImpl: FetchLike, url: string, bearer: string, method: string, body?: unknown) {
  return fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
}
async function errorText(response: { text(): Promise<string> }): Promise<string> { /* handles {error:{message}} and {error_description} , slice(0,300) */ }
export async function signOut(baseUrl: string, refreshToken: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<boolean> {
  return call(fetchImpl, `${baseUrl.replace(/\/+$/, '')}/auth/logout`, refreshToken, 'POST').then((answer) => answer.ok, () => false);
}
```
Import `FetchLike`, `SessionTokens`, `SignInError`, `signOut` from `reportingSignIn.ts` rather than copying (it is vscode-free). Error-mapping style for status codes: lines 233-241 (`401` -> expired, `403` -> not-admin, otherwise `HTTP n: detail`). Endpoint paths and casing are in RESEARCH.md lines 119-150; critical: requests use camelCase `spendLimit` `{amount, currency:'USD'}` and a typed function must make dropping the field impossible (Pitfall 1, Pattern 1). Existing org lookup for validating a pasted key: `NearAiClient.checkApiKey` (`src/services/nearAiClient.ts:342-349`, returns `{organizationId, apiKeyId}`; `maxRetries: 0`). Bounded activation retry (new key up to 10 s, check_api_key cached 60 s) wraps that. Redact all bearer values from error text.

### `src/team/nearSession.ts` (new)

**Analog:** `src/team/identity.ts` secret naming plus `SecretStorageLike` (`src/services/auth.ts:8-12`). Key `nearAi.team.nearSession.<teamId>` (D-02), same helper shape as `deviceKeySecretName`. Store JSON `{refreshToken}` only; refresh rotates (Pitfall 2): serialise refreshes with a promise and write the new refresh token before using the access token. Refresh endpoint: `POST /users/me/access-tokens` with `Bearer rt_...` (RESEARCH.md line 144). Tokens must never reach logs or events (`rt_` and JWT patterns are in `SECRET_PATTERNS`).

### `src/services/team/nearSignIn.ts` (new, extracted `browserSignIn`)

**Source (private helper now lives here):** `src/services/spendTracking.ts` lines 114-155 `browserSignIn` and `pasteSignInAddress`/`checkPasted` (includes the code-server paste fix `d637578`). `spendTracking.ts` is git-tracked. Extract into a shared module and have `spendTracking.ts` import it so the existing `rpt-` flow is unchanged (D-01). Only the box title/prompt copy differs: the current prompt says "signed out as soon as the token is made" (spendTracking.ts line ~137), which is wrong for the kept team session, so the copy must be a parameter.
```typescript
async function browserSignIn(baseUrl: string, provider: SignInProvider, signal: AbortSignal): Promise<SessionTokens | undefined> {
  try {
    const loopback = await startLoopbackSignIn({ signal, external: async (local) => (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString(true) });
    if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, loopback.callback)))) { loopback.close(); return undefined; }
    if (vscode.env.uiKind !== vscode.UIKind.Web) return await loopback.tokens;
    return await firstSession(loopback, pasteSignInAddress(loopback.callback, '...'));
  } catch (error) {
    if (!(error instanceof SignInError) || error.code !== 'remote') throw error;
  }
  if (!await vscode.env.openExternal(vscode.Uri.parse(loginUrl(baseUrl, provider, PASTE_CALLBACK)))) return undefined;
  const paste = pasteSignInAddress(PASTE_CALLBACK, '...');
  try { const pasted = await paste.value; return pasted ? parseCallback(pasted) : undefined; } finally { paste.dismiss(); }
}
```
Imports from `reportingSignIn.ts`: `startLoopbackSignIn, loginUrl, firstSession, parseCallback, PASTE_CALLBACK, SignInError, SignInProvider, SessionTokens`. Also note `main` fix `403c06e` (usage summary 404 = "not offered yet") lives in the usage code, relevant to Phase 66, not here. Provider choice UI: `SIGN_IN_CHOICES` quick pick in `registerSpendTracking` (spendTracking.ts ~line 210); reuse that shape.

### `src/team/invite.ts`, `join.ts`, `remove.ts`, `confirm.ts`, `nearLink.ts` (orchestration)

**Analog:** `src/team/enable.ts` (vscode-free flow over real git, input object, discriminated result, failure codes, redacted messages, rollback). Copy these elements:

Result/failure typing and helpers (enable.ts:25-44, 70-86):
```typescript
export type EnableResult =
  | { ok: true; teamFile: TeamFile; branch?: string; commit: string; remote: string }
  | { ok: false; code: EnableFailureCode; message: string; teamFile?: TeamFile };
function fail(code, message) { return { ok: false, code, message }; }
function describeError(error: unknown): string { return redactGitMessage(error instanceof Error ? error.message : String(error)); }
```
Input injection (`git?: GitRunner`, `now?: () => Date`, `secrets: SecretStorageLike`, fetch for NEAR) so tests run with real git and a fake server (enable.ts:34-44).

Commit-only-`team.json` for linking a NEAR org (D-03), enable.ts:271-292:
```typescript
const added = await git(['add', '-f', '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
const committed = added.code === 0
  ? await git(['commit', '--only', '-m', ENABLE_COMMIT_MESSAGE, '--', TEAM_FILE_REL], { cwd: projectRoot, timeoutMs: COMMIT_TIMEOUT_MS })
  : added;
if (committed.code !== 0) {
  const reset = await git(['reset', '-q', '--', TEAM_FILE_REL], ...);
  ... return { ok: false, code: 'commit-failed', teamFile, message: `... To finish, run: ${manualCommitCommand()}` };
}
```
Push offered, never automatic: `pushCodeBranch` (enable.ts:300-307). Reuse it directly. `team.json` rewrite: `writeTeamFile`/`canonicalTeamFile` plus `checkTrustPin` (teamFile.ts; used enable.ts:262-263). Note `team.json` carries a trust pin (`checkTrustPin`), so adding `near` changes the pinned content: read teamFile.ts `checkTrustPin` and trust.json handling (lines ~60-240) before designing the link flow so the lead's own session does not report a tampered file.

Joining (join.ts): create device identity with `createDeviceIdentity` (enable.ts:211), build `member.joined` signed by the new key, and append through `GitTransport.append` with a builder (enable.ts `pushGenesis` lines 108-153 shows the append/offline/unconfirmed handling, and a probe `git ls-remote`). `TeamLog.append(intents)` (eventLog.ts:209) refuses `member.joined` today (prepareEvents lines 91-92); the join path needs a distinct signer path because the joiner is not yet a member. Rollback on failure: copy `rollback()` (enable.ts:178-192) and extend it to delete the agreement key and any stored team key profile.

Clone-then-resume (D-07, D-26): git clone via VS Code's `git.clone` command in the adapter; the pure part parses the bundle and checks that `readTeamFile(projectRoot)` team id equals the bundle's.

Removal ordering (D-17, D-25): sequence set limit 0 -> write `member.removed` (also `device.revoked` as needed; `device.revoked` rejects the last device with `lastDevice`, line 140, so rely on member removal for the final device) -> revoke key -> (lead only) remove org member. Each NEAR step failure is captured into the checklist and does not throw (D-18), mirroring enable.ts's "return text, never drop" rollback approach (lines 178-192).

### `src/team/cleanupChecklist.ts` (new)

**Analog:** `src/team/teamFile.ts` for atomic file write and `teamStorageDir(globalStorageDir, teamId)` (used enable.ts:212). Store under the team storage dir, JSON with ids and step names only, no secrets (`assertNoSecrets` before write, as in enable.ts:166 and 233).

### `src/services/team/teamCommands.ts` (mod) and `package.json`

**Analog:** itself. New commands follow `enable()`/`guarded()` and lazy `await import(...)` of team modules (so solo activation stays one `fs.stat`, header comment lines 1-4). Reuse `ask()` (lines 160-163), `report()`/`announce()` (lines 76-91), `guarded()` (lines 241-250), `PUSH_ACTION`, and the update of `enable()` line ~172: the message "Joining an existing team arrives with team invitations." must be replaced with the Join offer (D-22/Phase 60 D-22). Registration (lines 253-257):
```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(ENABLE_COMMAND, guarded('Enable Team Mode', enable)),
  vscode.commands.registerCommand(VERIFY_LOG_COMMAND, guarded('Verify Team Log', verifyLog)),
```
`package.json` contributes entries for existing commands are at lines 206-215 (`nearAi.team.enable`, `nearAi.team.verifyLog`); copy that shape for `nearAi.team.invite`, `.join`, `.manageMembers`, `.linkNearOrganization`, `.signOutNear`. Check `activationEvents`/menus for how those two are exposed and whether `src/test/teamInvocation.test.ts` pins the command list (it likely does, update it).

### `src/services/team/teamSession.ts` and `teamStatusBar.ts` (mod)

**Analog:** themselves. `TeamSession` holds `log: TeamLog`, `identity`, `scheduler`; add: `append()` passthrough for command adapters, detection of own `member.removed` (D-20: stop sync, call `forgetDeviceIdentity`, delete team key profile and NEAR session secrets, notify), pending-confirmation count (members with status awaiting confirmation) and a notifier call using the existing `TeamNotifier` (teamSession.ts:38). Status bar: `statusText(status, teamName)` returns `{text, tooltip}`; extend to include a pending count (e.g. `Team: name (2 pending)`), escape names with `displayName`, and pass reasons through `safeReason`. Keep `update(status, teamName)` backward compatible or update `teamStudio`/tests accordingly.

### `src/test/helpers/fakeNear.ts` (new fake NEAR server)

**Analog:** `src/test/helpers/teamHarness.ts` (shared fixtures, no `.test` suffix so the glob skips it). Use `node:http` `createServer` on `127.0.0.1:0` (pattern from `startLoopbackSignIn`, reportingSignIn.ts:94-135) and implement the endpoints in RESEARCH.md lines 119-150 with in-memory state, enforcing the camelCase `spendLimit` request casing so a mis-cased call fails the test. Also expose request logs for asserting call order in removal (limit 0 before revoke) and that no `sk-` appears in logs.

### Tests

**Analogs:**
- Orchestration on real git: `src/test/teamEnable.test.ts` - `withFixture` (lines 36-44), `MemorySecrets`, `createTeamFixture`, `gitIn`, `.invalid` emails, `makeCanaries`/`scanFiles`/`scanGitObjects` from `./helpers/teamCanary`.
- Validators, pinned body shapes: `src/test/teamValidate.test.ts`.
- Materializer on fixture state: `src/test/teamMaterialize.test.ts` with helpers in `src/test/helpers/teamEvents.ts` (`makeActor`, `signed`, `entryOf`, `genesisEntries`, `addFixtureMember`) - use these for removal-releases-claims fixtures (D-19).
- Permissions: `src/test/teamPermissions.test.ts`. Forgery: `src/test/teamForgery.test.ts` (joiner without valid proof, replayed `member.joined`, join after expiry, join with role above invited role).
- Canonical vectors: `src/test/teamCanonical.test.ts` freezes the canonical form; add vectors for new bodies.
- Secrets: `src/test/teamSecrets.test.ts` (run-time-built secret literals).
- Run-time secret literals: never commit a secret-shaped literal; build with `randomBytes` like teamSecrets.test.ts lines 8-24.
- Tests are `node --test` via the repo's compile step; vscode cannot be imported in tests (teamEnable.test.ts:32 comment), so adapters stay thin.

## Shared Patterns

### Write path: permission, then secret check, then sign
**Source:** `src/team/eventLog.ts:84-111` (`prepareEvents`). Every new intent goes through `assertNoSecrets(intent.body, ...)`, `actionForEvent` + `decideTeamAction`, size check with `SIGNATURE_PLACEHOLDER`, then `signEvent`. Also update the `member.joined` refusal there (lines 91-92) for the joiner path. `EventIntent` type (line 37) is derived from `ImplementedEventBodies`, so type additions flow automatically.

### Read path: never call `assertNoSecrets` (secrets.ts header lines 1-4). Reads report warnings only.

### Strict base64url
**Source:** `canonical.ts:106-112` `isStrictBase64url(value, byteLength)`. Use for all key, nonce, tag, signature fields.

### Fixed rejection reasons
**Source:** `types.ts:73-88` `TEAM_REJECTION_REASONS` and `validate.ts:48-52` `invalid(path)`. Add reasons as constants; attacker-controlled text only goes through `invalid()` which sanitises.

### Secret storage names and cleanup
**Source:** `identity.ts:9-14` prefix + name function. New names: nearSession, agreement key, team API key profile (project-scoped, `ProjectCredentialScope` in `src/domain/auth.ts:35,95-100` with `scopedSecret(scope, 'api-key')` in `src/services/auth.ts:129`). Team key profile creation goes through `ProfileStore` (`src/services/profileStore.ts:69`, `createOrganizationProfile` input at line 26); read its API before writing the "new project-scoped profile selected for this project" step (D-14). Removal cleanup mirrors `forgetDeviceIdentity`.

### Error text safety
**Source:** `enable.ts:50-56` `describeError` + `redactGitMessage`; `teamStatusBar.ts:19-24` `safeReason`; `reportingSignIn.ts` `errorText` slice(0,300). Hostile text from NEAR or the log must be bounded and control-character-stripped before UI (Pitfall 13).

### Output text rules
No em-dashes, plain language (CONTEXT discretion). Messages end with what happened and what to do, like enable.ts messages.

### vscode boundary
`src/domain/team/*` and `src/team/*` never import `vscode`; adapters in `src/services/team/*` load team modules with dynamic `import()` (teamCommands.ts header lines 1-4).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/team/keySeal.ts` crypto core | utility | transform | No ECDH/HKDF/AES-GCM code in repo; use `node:crypto` directly, borrow structure from identity.ts and error style from canonical.ts `verifySignature` |
| live NEAR test | test | request-response | No env-flag-gated live test exists in team suite; grep other suites (`process.env.` gating) before writing, otherwise follow `node:test` `{ skip: !process.env.X }` |

## Metadata

**Analog search scope:** `src/domain/team`, `src/team`, `src/services/team`, `src/services/reportingSignIn.ts`, `src/services/spendTracking.ts`, `src/services/auth.ts`, `src/services/nearAiClient.ts`, `src/test/helpers`, `src/test/team*.test.ts`, `package.json`.
**Files scanned:** about 30 read in full or by range.
**Notes for the planner:**
1. `browserSignIn` is private in `src/services/spendTracking.ts` (lines 114-155) with `pasteSignInAddress`/`checkPasted` below it; extract rather than duplicate, and make the paste-box copy a parameter.
2. `applyEntry` step 3 (`boundKey`) rejects any author whose device is unbound, so the joiner path must be branched before that step.
3. `teamFile.ts` trust pin (`checkTrustPin`) interacts with writing `near` into `team.json`.
4. The X25519 pkcs8 prefix is not in `SECRET_PATTERNS`; add it and to the canary device-key forms.
5. `Pattern extraction date:` 2026-11-01. Not read in full (planner should open before editing): `materialize.ts` lines 250-300 (rest of `applyEntry`), `teamFile.ts` lines 60-240, `teamSession.ts` body, `permissions.ts` lines 96-185, `profileStore.ts`.
