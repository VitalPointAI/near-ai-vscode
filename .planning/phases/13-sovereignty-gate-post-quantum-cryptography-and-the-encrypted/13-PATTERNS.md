# Phase 13: Sovereignty gate, post-quantum cryptography, and the encrypted event log - Pattern Map

**Mapped:** 2026-10-28
**Files analyzed:** 27 (new) + 9 (modified)
**Analogs found:** 26 / 36 (the rest are greenfield, use RESEARCH.md Patterns 4-8)
All analog paths verified git-tracked.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `scripts/entries/pq.mjs` (new) | config/build entry | transform | `scripts/entries/mcp-client.mjs` | exact |
| `scripts/vendor-libs.mjs` (mod: add `bundle(... 'pq' ...)`) | build script | batch | itself, lines 50-51 | exact |
| `scripts/verify-release-content.mjs` (mod: `required` list) | build check | batch | itself | exact |
| `src/kb/crypto/pq.ts` | utility (typed vendor loader) | request-response | `src/mcp/client.ts` `loadSdk` (47-57) | exact |
| `src/kb/crypto/identity.ts`, `hybridSign.ts`, `keyWrap.ts`, `canonical.ts` | pure crypto | transform | `src/services/transcripts.ts` (node:crypto AES-GCM envelope) | role-match |
| `src/kb/log/{hlc,envelope,segment,itemKeys,verify,fold}.ts` | pure model/log | file-I/O + transform | `src/services/transcripts.ts` (encode/decode, atomic write); no log analog | partial |
| `src/kb/redact.ts` | utility | transform | `src/domain/redaction.ts` (`redactSecrets`) | role-match |
| `src/domain/sovereignty.ts` | domain policy | transform | `src/domain/privacy.ts` + `src/domain/config.ts` (`LOOPBACK_HOSTS`, `isSecureEndpoint`) | exact |
| `src/domain/destinations.ts` | domain matcher | transform | `src/domain/config.ts` `isSecureEndpoint` | role-match |
| `src/services/teeGatedClient.ts` | service (wrapper) | request-response/streaming | `src/services/nearAiClient.ts` (surface) + `src/services/outboundGuard.ts` | role-match |
| `src/services/nearAiClient.ts` (mod: extract `ModelClient`, add `embed`/`rerank`) | service | streaming | itself | exact |
| `src/services/providerCache.ts`, `providerFactory.ts` (mod: required `SovereigntyPolicy`) | service | request-response | `providerCache.ts` 24-51 | exact |
| `src/services/chat.ts` (mod: `getGenerationService`, `getMultimodalContext`) | controller | request-response | itself, 774-790 | exact |
| `src/services/kbMode.ts` | service (state adapter) | CRUD | `src/services/auth.ts` (injected `SecretStorageLike`) | role-match |
| `src/services/kbIdentityVault.ts` | service | CRUD | `src/services/transcripts.ts` `transcriptKey` (as anti-pattern) + `auth.ts` | role-match |
| `src/services/kbCreate.ts`, `kbStatus.ts` | service/UI | event-driven | `src/services/workspaceCommands.ts` (dialog flows) | role-match |
| `src/services/transcripts.ts`, `handoff.ts`, `activityStore.ts`, `agentActivity.ts`, `contextGraph*.ts`, `multimodalIntake.ts` (mod: redact/encrypt in KB mode) | service | file-I/O | themselves | exact |
| `src/services/workspaceCommands.ts` (mod, S4) | command | file-I/O | itself, 145-146 | exact |
| `src/agent/shell.ts` (mod, S7) | service | request-response | itself, 113-116 | exact |
| `KbEraseItem` agent tool + erase host fn | tool | request-response | `AgentTool.risky` in `src/agent/tools.ts`; `src/services/approvalService.ts` | role-match |
| `src/test/helpers/{networkSpy,canaryScan,fakeNearServer,fakeMemento}.ts` | test helper | event-driven | `src/test/chatSendPath.test.ts` (`MemorySecrets`, `fakeNear`) | role-match |
| `src/test/teeGatedClient.test.ts`, `sovereignty*.test.ts`, `kb*.test.ts`, `pqcKats.test.ts` | test | request-response | `src/test/chatSendPath.test.ts`, `outboundGuard.test.ts`, `nearAiClient.test.ts` | role-match |

## Pattern Assignments

### `scripts/entries/pq.mjs` and `scripts/vendor-libs.mjs`
**Analog:** `scripts/entries/mcp-client.mjs` (lines 1-5) and `scripts/vendor-libs.mjs` (36-51)
```js
// Bundle entry: only the MCP client side is shipped.
export { Client } from '@modelcontextprotocol/sdk/client/index.js';
```
Entry exports only `ml_dsa65`, `ml_kem768_x25519`, bip39 fns, English wordlist (explicit named re-exports so esbuild tree-shakes).
Registration (add after line 51):
```js
await bundle(path.join(root, 'scripts', 'entries', 'mcp-client.mjs'), 'mcp', 'mcp-client.cjs', '@modelcontextprotocol/sdk');
// add: await bundle(path.join(root, 'scripts', 'entries', 'pq.mjs'), 'pq', 'pq.cjs', '@noble/post-quantum');
```
`bundle()` already writes LICENSES.txt and manifest rows (esbuild `format: 'cjs'`, `target: 'node22'`, `minify`).

### `src/kb/crypto/pq.ts` (typed vendor loader)
**Analog:** `src/mcp/client.ts`
```ts
let sdk: Sdk | undefined;
function loadSdk(): Sdk {
  if (!sdk) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sdk = require(path.join(__dirname, '..', '..', 'vendor', 'mcp', 'mcp-client.cjs')) as Sdk;
    } catch (error) {
      throw new ToolError(`The MCP client is missing from this installation (${(error as Error).message}).`);
    }
  }
  return sdk;
}
```
Copy: hand-written `type Pq = {...}` structural type, lazy cached `require` of `vendor/pq/pq.cjs`. Path depth differs: `src/kb/crypto` compiles to `dist/kb/crypto`, so `'..','..','..','vendor','pq','pq.cjs'` (verify against dist layout of mcp: `dist/mcp` uses two `..`). Throw a plain Error, not `ToolError` (kb/ must stay free of agent imports and `vscode`).

### `src/kb/crypto/*` and `src/kb/log/segment.ts` (AES-GCM, atomic file I/O)
**Analog:** `src/services/transcripts.ts`
Imports (1-4): `createCipheriv, createDecipheriv, createHash, randomBytes` from `node:crypto`; `mkdir, readdir, readFile, rename, rm, writeFile` from `node:fs/promises`.
AES-256-GCM encode (49-56):
```ts
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
const data = Buffer.concat([cipher.update(JSON.stringify(transcript), 'utf8'), cipher.final()]);
const envelope = { enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
```
Differences required: add `cipher.setAAD(headerBytes)` and `decipher.setAuthTag`; use `fs.link(tmp, final)` + `unlink` (not `rename`) for no-clobber per RESEARCH Pattern 5. Pure modules take `dir` strings (no `vscode`), as `TranscriptStore` takes `storageDir`.
**Anti-pattern (do not copy), lines 25-31:** `const fresh = randomBytes(32); await secrets.store('nearAi.transcripts.key', ...)` after `get` returned nothing. This is the exact PQC-03 failure; the KB transcript key must come from the identity `local-secrets` root, and `sharedTranscriptKey` (16-19) must be given a KB-mode branch.

### `src/domain/sovereignty.ts`
**Analog:** `src/domain/privacy.ts` (12-14) and `src/domain/config.ts` (25-50 region)
```ts
export type ProviderBoundary = 'local' | 'cloud' | 'tee' | 'unknown';
export type SovereigntyMode = 'standard' | 'tee-only' | 'local-only';
```
```ts
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export function isSecureEndpoint(value: string): boolean {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)); } catch { return false; }
}
```
Copy shape: pure function, `new URL()` in try/catch returning the safe (refusing) value. Extend: `isLoopback` must cover all of `127.0.0.0/8`, `::1`, `localhost`; fail closed on parse error (D-11/D-12). Import types with `import type` from `./privacy` (domain has no `vscode`).

### `src/services/nearAiClient.ts` (extract `ModelClient`) and `src/services/teeGatedClient.ts`
**Analog:** `NearAiClient` class (public surface: `listModels`, `listLocalModels`, `listModelPrivacy`, streaming/image/audio methods). Private members (`private readonly fetchFn`, `private readonly models`, `private async withPrivacy`) make it nominal, so extract `export interface ModelClient` of the public methods and retype consumers (`ResolvedProvider.client` in `src/domain/auth.ts`, `AgentTurnRequest.client`, imageTool, prepareAttachments, compactConversation, `NearAiGenerationAdapter`).
Catalog/privacy source for the gate (classifier is at ~line 639 of `nearAiClient.ts`; `listLocalModels` stamps `privacyBoundary: 'local'`):
```ts
return this.rememberModels(models.map((model) => ({ ...model, privacyBoundary: 'local' as const, locality: 'local' as const })));
```
Wrapper follows the guard style of `src/services/outboundGuard.ts` / `privacyPreflight.ts` (class with injected options object, `mode ?? 'standard'` default; here make the policy required with no default). Refusal is a typed `ModelRefusal` error. Reflection test classifies `Object.getOwnPropertyNames(NearAiClient.prototype)` (RESEARCH Pattern 2).

### `src/services/providerCache.ts` / `providerFactory.ts` / `chat.ts` seam
**Analog:** `providerCache.ts`
```ts
export async function activeProvider(root: string, auth: AuthService): Promise<ActiveProvider | undefined> {
  ...
    const provider = entry?.provider ?? await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
```
```ts
export function clientFor(active: ActiveProvider, model: string): { client: ResolvedProvider['client']; local: boolean } {
  const info = active.models.find((candidate) => candidate.id === model);
  const local = info?.privacyBoundary === 'local' || active.provider.provider === 'local';
```
Add a required `SovereigntyPolicy` param, wrap `client` and `localClient` when KB. Include policy in the cache key (line 29). Note `clientFor` trusts the `local` label: the gate must use the endpoint host instead.
**Two bypass sites to fix** in `chat.ts` `getGenerationService` (774-790):
```ts
const provider = await createNearAiProvider({ auth, profile, scope: profiles.getScope(selection.profileId) });
const privacy = new PrivacyPreflight();   // default 'standard' mode: SOV-06 gap
```
Change to the gated provider and `new PrivacyPreflight({ mode: policy.mode })`. Same for `getMultimodalContext` (~736-744).

### `src/services/kbMode.ts`, `kbIdentityVault.ts`
**Analog:** `src/services/auth.ts` (1-22): inject a minimal structural interface, no `vscode` import.
```ts
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}
export class AuthService { public constructor(private readonly secrets: SecretStorageLike) {} ...
```
Define `MementoLike { get; update }` the same way for `globalState`. Test fakes follow `MemorySecrets` in `chatSendPath.test.ts` (14-19). Lockout tests assert zero `store` calls once the existence marker exists.

### S4 `src/services/workspaceCommands.ts` (145-146)
```ts
const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(root, 'near-ai-memory.json')), filters: { JSON: ['json'] } });
if (target) await writeFile(target.fsPath, await memory.export(...), 'utf8');
```
Change default URI to outside the workspace (home or global storage), warn if the chosen path is inside a git tree; KB mode: encrypted export or refuse. Webview `memory-export` is handled in `chatBridge.ts:637` and `chat.ts`.

### S7 `src/agent/shell.ts` (113-116)
```ts
this.scripts ??= mkdtempSync(path.join(tmpdir(), 'near-ai-shell-'));
const script = path.join(this.scripts, `${marker}.sh`);
writeFileSync(script, `${command}\n`, { mode: 0o600 });
```
Env filtering lives in `shellEnv(this.extraEnv, this.allowEnv)` (`ensureShell`, ~line 123). Sensitive-path vocabulary to extend (add `.near-kb/`, key files, `state.vscdb` in KB mode): `NEAR_CREDENTIAL_PATH` and `PRIVATE_PATH` at `privacyPreflight.ts:16-17`.

### Erase tool and approval (D-15)
**Analog:** `src/services/approvalService.ts`: `preview()` -> `decide()` -> `dispatch()`; `risky` set (line 8) and `requiresApproval: risky.has(capability) || ...` (line 21) force the prompt; `safe()` (line 40) sanitises the shown text. The agent explanation goes through the preview `action`/`riskExplanation`. Also mark the tool `risky` per `AgentTool.risky` in `src/agent/tools.ts` (read it before planning). Fingerprint-bound approvals: `memoryApproval.test.ts` pattern.

### Tests and `NetworkSpy`
**Analog:** `src/test/chatSendPath.test.ts`: real host path with a faked `globalThis.fetch`:
```ts
function fakeNear(calls: string[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url.replace('https://cloud-api.near.ai/v1', ''));
    if (url.endsWith('/model/list')) return Response.json({ models: [{ modelId: 'z-ai/glm-5.3', metadata: { attestationSupported: true, providerType: 'tinfoil' } }, { modelId: 'deepseek/deepseek-v4.1-flash', metadata: { attestationSupported: false, providerType: 'external', ... } }] });
```
Reuse these catalog rows as the TEE vs forwarded fixtures; header lines 1-8 for test imports (`node:test`, `node:assert/strict`, `mkdtemp(tmpdir())`); one shared `vscodeStub` object (46-50). Tests run via `node --test dist/test/*.test.js`. Move `MemorySecrets` and `fakeNear` into `src/test/helpers/`.

## Shared Patterns

### Layering
`src/domain`, `src/kb`, `src/agent`: no `vscode` import; ports injected (`SecretStorageLike`, `fetchFn`), composed in `src/extension.ts`.

### Fail closed
`isSecureEndpoint` pattern: `try { new URL } catch { return false }`. Apply to every gate predicate.

### Vendored third-party code
Load only via lazy `require(path.join(__dirname, ...,'vendor', ...))`; ship via `vendor-libs.mjs`; add to `verify-release-content.mjs` `required`.

### Redaction
Base: `redactSecrets` in `src/domain/redaction.ts`; `safe()` in `approvalService.ts:40`. `KbRedactor` is a sibling pure function applied at each sink in RESEARCH Pattern 10.

## No Analog Found
| File | Role | Reason |
|---|---|---|
| `src/kb/log/{envelope,segment,verify,fold,hlc}.ts` | append-only signed log | no existing log or hash-chain code; use RESEARCH Patterns 5-8 (transcripts only supplies AES-GCM and file I/O style) |
| `src/kb/crypto/hybridSign.ts`, `keyWrap.ts`, `identity.ts` | hybrid PQ crypto | no PQ or HKDF/scrypt code exists; use RESEARCH Patterns 3-4 |
| `src/test/helpers/networkSpy.ts` | test harness | no `diagnostics_channel` usage; RESEARCH Pattern 9 |
| `src/test/helpers/canaryScan.ts` | test harness | none; RESEARCH Pattern 10 |
| unix-socket `fetchFn` | transport | none; RESEARCH Open Question 5 |
| status-bar item / chat-header badge / locked and tamper screens | UI | check `.planning/UX-CONTRACT.md`, `media/chat/*`, `panelView.ts` (not read in this pass) |

## Metadata
**Analog search scope:** `scripts/`, `src/mcp`, `src/services`, `src/domain`, `src/agent/shell.ts`, `src/test`
**Not read (planner should read before editing):** `src/agent/tools.ts`, `src/domain/redaction.ts`, `src/services/chat.ts` 736-744, `media/chat/*`, `panelView.ts`
**Pattern extraction date:** 2026-10-28
