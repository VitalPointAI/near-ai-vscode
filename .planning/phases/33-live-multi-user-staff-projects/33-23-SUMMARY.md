---
phase: 33-live-multi-user-staff-projects
plan: 23
status: complete
subsystem: workbench session keys, the person signer, the sealed encryption key and the person's key store for keyring.ts (P6)
tags: [workbench, staff, session-keys, person-key, openbao, transit, keyring, d-60, d-61, d-62, mus-09]
requires: [33-21, 33-22, 46-01, 46-02, 46-07]
provides: [startSessionKeys, SessionKeys, SessionSigner, CertifyTarget, SessionCertificate, SESSION_KEY_TEXT, SESSION_NOT_AFTER_MS, personSigner, PersonSigner, PersonSignRefused, PERSON_SIGNER_TEXT, signerFingerprint, isPublicKeyText, openEncryptionKey, OpenedEncryptionKey, EncryptionKeyEnvelope, ENCRYPTION_ENVELOPE_SECRET, ENCRYPTION_KEY_TEXT, keyStoreSecrets, SecretStorageLike, STAFF_SECRET_SERVICE, PLAIN_PRIVATE_KEY_SECRETS, KEY_STORE_SECRETS_TEXT, loadStaffEngine, StaffEngine, engine/staff.cjs]
affects: [33-24, 33-26, 33-27, 33.1-17, 33.2-04]
tech-stack:
  added: []
  patterns: [engine names reach the backend only through a runtime-loaded esbuild bundle typed structurally, refusals as values, each Transit signature checked against the person public key, envelope sealed under a Transit-wrapped data key with read-back, secrets held by the session and dropped at stop]
key-files:
  created:
    - workbench/tools/staff-engine-entry.ts
    - workbench/extension/src/node/staff/staff-engine.ts
    - workbench/extension/src/node/staff/person-signer.ts
    - workbench/extension/src/node/staff/session-keys.ts
    - workbench/extension/src/node/staff/encryption-key.ts
    - workbench/extension/src/node/staff/keystore-secrets.ts
    - workbench/test/staff/session-keys.test.ts
    - workbench/test/staff/encryption-key.test.ts
  modified:
    - workbench/tools/build-engine.mjs
    - workbench/package.json
    - src/services/nearAiClient.ts
key-decisions:
  - "The person public key is an input to startSessionKeys and personSigner, checked against every Transit signature: no session policy can read transit/keys/person-<entity> (47-07), so the plan's read through KeyService is not possible (open condition 1)."
  - "A certificate is per shared project: certificate(target, { member, slot }) appends one session.certify through the project's appendOwn with the person signer, since the project id and slot are inside the signed binding (33-21)."
  - "keyStoreSecrets refuses to store under the single-machine names that hold plain private keys, so a hosted session can never keep a long-term key in the person's store by a wrong wiring (D-61)."
  - "The sealed content of the envelope is versioned JSON { v: 1, x25519 }, so 33.2-04 can add its P-256 and ML-KEM keys beside it and still open envelopes written now."
requirements: [MUS-09]
requirements-completed: []
actuals:
  tokens: 16400
  tasks: 3
  commits: 3
completed: 2026-11-24
duration: 35min
plan_head_before: 2e02248e3887d8766fda45446cf9fa33311c67e3
plan_head_after: c9cc5fb6
---

# Phase 33 Plan 23: The person signer and session keys in a hosted session Summary

A hosted session now makes its own short-lived session key in memory, and the person's long-term key in your organization's OpenBao vouches for it once per shared project. The engine's own fold then counts the session key's writes as the person's. Decisions and roster changes go through the person signer, which needs a fresh passkey or security key confirmation and answers a refusal with what to do. The person's encryption key is kept only as an envelope sealed by their Transit key. Their epoch keys and join secrets are kept in their own key store and follow them to every later session. Nothing is wired to a widget yet; 33-24 does that.

## Base and branch

`feat/phase-33-engine-wave-1` at `becfbfb8` was checked out in this agent's own worktree branch, because the named branch was held by another worktree. `origin/main` at `5ed892af` (Phase 46, #187) was merged as `2e02248e`, with no conflicts. The work is pushed with `HEAD:feat/phase-33-engine-wave-1`.

Step 0, at `2e02248e`: `export function createKeyService` in key-service.ts gave 1. `bindBackendService` in backend-service.ts gave 1. `export function certifiedWriter` in sessionKeys.ts gave 1. `workbench/tools/build-engine.mjs` exists. Every name matched, so the work went ahead.

## What was built

| Module | Exports | Role |
|---|---|---|
| `workbench/tools/staff-engine-entry.ts` | `certifiedWriter`, `isPersonKeyKind`, `PERSON_KEY_KINDS`, `SESSION_DEFAULT_LIFETIME_MS`, `SESSION_MAX_LIFETIME_MS`, `sessionBindingBytes`, `sessionCertifyData`, `writerIdOf`, `x25519BindingBytes`, `DeviceKeyRing`, `ENCRYPTION_KEY_SECRET`, `EPOCH_KEY_SECRET_PREFIX`, `JOIN_SECRET_PREFIX`, `storeJoinSecret`, `joinSecret`, `forgetJoinSecret` | The engine names the staff backend uses, bundled by `build-engine.mjs` into `engine/staff.cjs` (73 KB). 33-24 adds the replica project and the live replicator, with the decode worker and the vendored Yjs they load by path. |
| `staff/staff-engine.ts` | `loadStaffEngine(appRoot?)`, `StaffEngine`, `SessionBindingFields`, `SessionCertifyData` | Loads the bundle once per path, from the app root computed from the code's own location. The extension cannot import `src/` (its rootDir is `extension/src`), so the names it calls are typed here. The workbench lint checks this interface against the entry (`EntryMatches` in session-keys.test.ts). |
| `staff/person-signer.ts` | `personSigner`, `PersonSigner`, `PersonSignRefused`, `PERSON_SIGNER_TEXT`, `signerFingerprint`, `isPublicKeyText` | The engine's `AsyncPayloadSigner` over `KeyService.sign`. |
| `staff/session-keys.ts` | `startSessionKeys`, `SessionKeys`, `SessionSigner`, `CertifyTarget`, `SessionCertificate`, `SESSION_KEY_TEXT`, `SESSION_NOT_AFTER_MS` | The session key, the certificate per shared project, and stop. |
| `staff/encryption-key.ts` | `openEncryptionKey`, `OpenedEncryptionKey`, `EncryptionKeyEnvelope`, `ENCRYPTION_ENVELOPE_SECRET`, `ENCRYPTION_KEY_TEXT` | The X25519 key sealed by the person's KEK. |
| `staff/keystore-secrets.ts` | `keyStoreSecrets`, `SecretStorageLike`, `STAFF_SECRET_SERVICE`, `PLAIN_PRIVATE_KEY_SECRETS`, `KEY_STORE_SECRETS_TEXT` | Theia's KeyStoreService as keyring.ts's SecretStorageLike. |

### Exported interfaces for the plans that build on this one

For 33.1-17 (`person-signer.ts`):

```ts
export interface PersonSignRefused { readonly refused: string; readonly fix?: string }
export interface PersonSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): Promise<string | PersonSignRefused> }
export function personSigner(keyService: Pick<KeyService, 'sign'>, publicKey: string): PersonSigner
export function signerFingerprint(publicKey: string): string   // the engine's fingerprintOf, "dev-" + 32 hex
export function isPublicKeyText(publicKey: unknown): publicKey is string
export const PERSON_SIGNER_TEXT: { mismatch: string }
```

- `sign` never throws. A KeyService refusal comes back as `{ refused: reason, fix? }`, with KeyService's own text: a stale step-up is `{ refused: 'Signing needs a fresh confirmation with your passkey or security key.', fix: 'Confirm with your passkey or security key' }`. A KeyService that throws or does not answer gives `KEY_SERVICE_TEXT.unreachable`. A signature that does not verify against `publicKey` gives `PERSON_SIGNER_TEXT.mismatch`.
- A signature is returned as base64url, the form the engine verifies; Transit's base64 is converted.
- The signer keeps no state between calls. `person-signer.ts` has no `writeFile` and no `keyStore` (33.1-17's guard grep gives 0 today).
- 33.1-17 adds the optional `{ action }` argument to `sign` and the pending-action registry. The person signer tests are in `workbench/test/staff/session-keys.test.ts`; 33.1-17's `person-signer.test.ts` is a new file.

For 33.2-04 (`encryption-key.ts`):

```ts
export const ENCRYPTION_ENVELOPE_SECRET = 'nearAi.identity.encryptionKeyEnvelope'
export interface EncryptionKeyEnvelope { readonly v: 1; readonly wrappedKey: string; readonly iv: string; readonly ciphertext: string; readonly tag: string }
export interface OpenedEncryptionKey { readonly publicKey: string; readonly privateKey: KeyObject | undefined; drop(): void }
export function openEncryptionKey(keyService: Pick<KeyService, 'generateWrappedDataKey' | 'unwrapDataKey'>, secrets: SecretStorageLike): Promise<ServiceResult<OpenedEncryptionKey>>
export const ENCRYPTION_KEY_TEXT: { unreadable: string; notKept: string }
```

- The envelope is JSON stored under `ENCRYPTION_ENVELOPE_SECRET` through `keyStoreSecrets(keyStore, STAFF_SECRET_SERVICE)`, where `STAFF_SECRET_SERVICE` is `'sterling-staff'`.
  - `wrappedKey` is Transit's `vault:vN:...` text, as Transit gives it.
  - `iv` (12 bytes), `ciphertext` and `tag` (16 bytes) are base64url.
  - The cipher is AES-256-GCM with AAD `near-ai/encryption-key-envelope/v1\n<wrappedKey>`.
- The sealed content is `{"v":1,"x25519":"<PKCS8 DER, base64url>"}`. A v2 content can add the P-256 scalar and the ML-KEM seed beside `x25519`. `open()` refuses any sealed `v` other than 1 today, so 33.2-04 widens that check and keeps v1 opening.
- `parseEnvelope` checks the envelope's own `v: 1` and its exact five keys. 33.2-04 needs no new outer field, because the version lives in the sealed content.
- `publicKey` is the raw X25519 public key as base64url, the form `keyring.ts` uses. `privateKey` is `undefined` after `drop()`.
- The tests in `workbench/test/staff/encryption-key.test.ts` share the helpers `site()` (a fake OpenBao with KV v2, `datakey/wrapped` and `decrypt`), `session(site)` (a fresh identity, key store and KeyService, as after a restart) and `opened(session)`.

For 33-24 (`session-keys.ts`):

```ts
export const SESSION_NOT_AFTER_MS = 12 * 60 * 60 * 1000
export const SESSION_KEY_TEXT: { stepUp: 'Confirm with your passkey or security key to work on shared projects.'; ended: string; noPersonKey: string }
export interface SessionSigner { readonly fingerprint: string; readonly publicKey: string; sign(bytes: Buffer): string }
export interface CertifyTarget { readonly projectId: string; appendOwn(kind: string, data: unknown, options: { signer: PersonSigner }): Promise<{ ok: true; hash: string; built: { entry: unknown } } | { refused: string; message: string }> }
export interface SessionCertificate { readonly hash: string; readonly entry: unknown; readonly notAfter: string }
export interface SessionKeys {
  readonly sessionSigner: SessionSigner; readonly personSigner: PersonSigner; readonly notAfter: string;
  certificate(target: CertifyTarget, seat: { member: string; slot: number }): Promise<ServiceResult<SessionCertificate>>;
  hold(secret: { drop(): void }): void; stop(): void;
}
export function startSessionKeys(keyService: Pick<KeyService, 'sign'>, identity: { status(): SessionIdentityStatus }, clock: { now(): number },
  options: { personPublicKey: string; engine: Pick<StaffEngine, 'sessionCertifyData' | 'writerIdOf'> }): ServiceResult<SessionKeys>
```

- `ReplicaProject` satisfies `CertifyTarget` structurally.
- `sessionSigner` goes to `ReplicaProjectDeps.sessionSigner` and `HubTransportOptions.signer`, and `personSigner` to `ReplicaProjectDeps.personSigner`.
- `SessionCertificate.entry` is the sealed entry for `HubTransportOptions.certificate` (33-22).
- Call `hold(opened)` with the opened encryption key, then `stop()` at the identity's `stopping`.

## How each truth was met

- **Session key at active, certified through KeyService.sign.** `startSessionKeys` refuses in local mode (`KEY_SERVICE_TEXT.local`), before `active` (`KEY_SERVICE_TEXT.notReady`) and without a person key. Otherwise it makes an Ed25519 key in memory. `certificate()` builds `session.certify` data with the engine's `sessionCertifyData`, which the session key signs. It then appends the entry through the project with the person signer: one step-up login, a Transit sign and a revoke, and no other prompt right after sign-in. A stale sign-in returns `refused('Confirm with your passkey or security key to work on shared projects.', 'Confirm with your passkey or security key')`, appends nothing and makes no OpenBao call. In the tracer, the roster world folds the entry: `sessions` holds it, it takes no roster position, and the engine bundle's `certifiedWriter` returns `{ member: 'mbr-pat', device: <person key writer>, slot: 2 }`.
- **The person public key and device.add.** The workbench creates, rotates, exports and deletes no Transit key, and calls only `sign`, `datakey/wrapped` and `decrypt`. The public key cannot be read in the session (open condition 1). It is an input, and every signature is verified against it.
- **The X25519 key at rest only as an envelope.** It is opened into backend memory at session start, held by the session keys and dropped at `stop()`. No `writeFile` appears in `encryption-key.ts` (grep 0). The tests scan the key store and a workspace folder, used as the working folder during two sessions, for six encodings of the private key and find none.
- **keyring.ts unchanged over the key store.** Join secrets are stored, read, refused when different and forgotten. An epoch key added by one session's `DeviceKeyRing` is read back by a new session's ring. All of it runs from `engine/staff.cjs` over `keyStoreSecrets` and the OpenBao key store, under `users/<entity>/`.
- **The person signer returns refusals as values.** It is covered for a stale step-up, a fresh step-up (the signature verifies against the Transit key), another key's signature, an unreachable key store and a throwing KeyService.

## Tests first

- The tests were written before the code they test, and each file was built on the unchanged base first. Both RED runs failed at the build: esbuild reported `Could not resolve "../../extension/src/node/staff/session-keys.ts"` for Task 1, then `encryption-key.ts` and `keystore-secrets.ts` for Task 2.
- `person-signer.ts` and `staff-engine.ts` were written in the same step as the session-keys test, before its RED build ran.

## Deviations from Plan

1. **[Rule 4 territory, recorded and not decided] The person public key is not read from KeyService.** The plan and D-61 say it is read from `transit/keys/person-<entity>`. Phase 47's `sterling-workbench` and `sterling-workbench-sign` policies grant no `transit/keys/` path. `deploy/test/openbao.test.mjs` asserts that no session policy does, and 46-07's own test asserts that no key path is called. Changing that is a Phase 47 security-policy decision, so this plan takes the key as `personPublicKey`. A wrong key cannot forge anything: `personSigner` and the engine's `finishPayload` verify every signature against it, and refuse on a mismatch.
2. **[Rule 3] The certificate is per project.** The plan's artifact reads `startSessionKeys(...): { sessionSigner, certificate, stop }`. The certificate's signed binding includes the project and the device's slot (33-21), so `certificate(target, seat)` is a method, called once per shared project. `startSessionKeys` is synchronous and signs nothing itself. The "stale sign-in" refusal therefore comes from `certificate()`.
3. **[Rule 3] A stopped session signer throws, and does not return a refusal.** The engine's `PayloadSigner.sign` (`ReplicaProjectDeps.sessionSigner`, the hub transport) is synchronous and returns a string, so it has no refusal value. After `stop()` it throws `SESSION_KEY_TEXT.ended`, and `certificate()` returns `refused(SESSION_KEY_TEXT.ended)`.
4. **[Rule 2, T-33-N8] `keyStoreSecrets` refuses plain private-key names.** These are `nearAi.identity.encryptionKey` and the three device-key names. Without the guard, opening a `ReplicaProject` over the person's key store would store a plain X25519 and Ed25519 key there. The test checks the names against the engine's and identity's own constants.
5. **[Rule 3] Files outside the plan's list:**
   - `staff/staff-engine.ts`: the typed bundle loader, needed because the extension cannot import `src/`.
   - `workbench/package.json`: the test script now also runs `dist/test/staff/*.test.js`, which its `dist/test/*.test.js` glob did not reach.
   - `src/services/nearAiClient.ts`: `new Blob([audio.slice()])`. The workbench lint (TypeScript with the DOM lib) checks keyring.ts's closure through `services/auth.ts`, and the DOM `BlobPart` type refuses a `Uint8Array<ArrayBufferLike>`. The slice is an ArrayBuffer-backed copy, so behaviour is unchanged. A comment first made the frozen file 1861 lines, and the architecture baseline caught it; the fix commit `c9cc5fb6` removed the comment.
6. **Task 3 has no commit of its own.** Its behaviour (stop, and the person signer's refusals) is in the same functions as Tasks 1 and 2, so it landed in `c59d7f03` and `f408b49f`. Task 3's verify command was run on the final state.
7. **Branch name:** the plan names `feat/phase-33-23-session-keys-native` from `feat/phase-33-live-multi-user`. As the orchestrator directed, the work is on `feat/phase-33-engine-wave-1`, like 33-21 and 33-22.

## Verification

All runs used the shared heavy lock, MemoryMax=6G, MemorySwapMax=0 and choom. The workbench ran on Node 26.13.1.

| Run | Result |
|-----|--------|
| `npm --prefix workbench test` and `npm --prefix workbench run lint` (Task 3's verify) | **119 tests: 119 passed, 0 failed, 0 skipped**; lint exit 0 |
| `session-keys.test.ts` | 8 passed (plan: at least 6) |
| `encryption-key.test.ts` | 7 passed (plan: at least 4) |
| Root `npm run lint` | exit 0 |
| Root, focused: spendCapture, gateRouteGuard, phase11 (transcription), replicaSessionCertify, staffPersonKeySigning, staffReplicaKeyring | 79 passed, 0 failed |
| Root: copyLint, architecture, spendCapture, phase11, after the frozen-size fix | 58 passed, 0 failed |

- Acceptance greps: `staff-engine-entry` in `build-engine.mjs` gives 2. `writeFile` in `encryption-key.ts` gives 0. `export function personSigner` gives 1, and `export function startSessionKeys` gives 1.
- **Tests added: 15** (8 and 7). **Tests changed: 0.**
- No container or Playwright suite was run, per D-65.

## Threat model

| Threat | Mitigation as built |
|---|---|
| T-33-N8 | The envelope is sealed under a Transit data key. There is no `writeFile`, and a byte scan of the key store and the workspace folder finds no key. Plain private-key names are refused in the key store. |
| T-33-N9 | KeyService's step-up guard applies, and OpenBao's step-up role enforces it. The refusal is a value, and every signature is checked against the person key. |
| T-33-N10 | `stop()` drops the session key and every held secret. It is idempotent, and a secret held after stop is dropped at once. |
| T-33-N7 | No module logs. Each test file captures all output and asserts that it holds no token, entity id, signature or private key. |
| T-33-SC | No package was installed. `node_modules` was hard-linked from a worktree with byte-identical lockfiles. |

## Known Stubs

None. The modules are complete for what they do. 33-24 wires them: it finds shared projects, calls `certificate()` and holds the encryption key.

## Threat Flags

None. No new network endpoint or route was added. The OpenBao paths called are the three 46-07 allows, plus the person's own KV path through 46-07's key store.

## Open conditions

1. **The person public key has no source in a hosted session.** No gap id was filed: Phase 33 does not edit `compliance/` (D-03, D-63), so the orchestrator should file it against Phase 47. D-61 and this plan assume the session reads `transit/keys/person-<entity>`, but 47-07's policies forbid any `transit/keys/` path for a session token, and its tests assert that. One of these is needed before 33-24 can open a shared project in a hosted session:
   - (a) a read-only `transit/keys/person-{{identity.entity.id}}` grant in `sterling-workbench`, with the 47-07 test changed by the owner;
   - (b) enrolment (`deploy/openbao/enrol.mjs`) writes the public key where the session can read it, for example the person's KV path, which needs a KV grant for the enrolment operator;
   - (c) the public key is carried in the person's roster `device.add`, made at enrolment.

   Whichever source is chosen, `startSessionKeys` and `personSigner` already verify it against every signature. This blocks 33-24's hosted path, not 33.1-17 or 33.2-04.
2. **Hand-off to 33-24:**
   - In a hosted session, `ReplicaProject` must be opened with the session and person signers and the opened encryption key. Its single-machine `loadOrCreateDeviceIdentity` and `loadOrCreateEncryptionKey` over `keyStoreSecrets` now fail visibly with `KEY_STORE_SECRETS_TEXT.plainPrivateKey`.
   - The person's member and slot for `certificate()` come from the roster, through the person key's writer id.
   - The staff engine entry needs the replica project and live replicator added, with the decode worker file and the vendored Yjs paths that `decodeHost.ts` and `doc.ts` load through `__dirname`.

## Self-Check: PASSED

- Created files exist: staff-engine-entry.ts, staff-engine.ts, person-signer.ts, session-keys.ts, encryption-key.ts, keystore-secrets.ts, and test/staff/session-keys.test.ts and encryption-key.test.ts.
- The commits `c59d7f03`, `f408b49f` and `c9cc5fb6` are in HEAD.
