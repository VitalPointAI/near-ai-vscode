# Phase 68: Relay foundation - Pattern Map

**Mapped:** 2026-11-14
**Files analyzed:** 14 groups (relay/ tree plus root repo changes)
**Analogs found:** 9 / 14 groups (the rest are greenfield; use 68-RESEARCH.md Code Examples)

RESEARCH.md already holds tested snippets for the relay/ files (guard `bin.ts`, ambient `Database` d.ts, `build.mjs`, `tsconfig.json`, store open and commit, kill -9 drill, secret loader, redactor, Dockerfile). Use those; this file only adds the in-repo analogs. Layout is in RESEARCH.md lines 180-215.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `.github/workflows/ci.yml` (add `relay` job) | config | batch | existing jobs `lint`, `test`, `release-content` in same file | exact |
| `scripts/lib/workflow.mjs` (`CI_CHECKS` += `relay`) | config | n/a | line 5 itself | exact |
| `docs/development-workflow.md` (required-checks list) | docs | n/a | existing list in file | exact |
| `.vscodeignore` (append `relay/**`) | config | n/a | existing deny lines (`test/**`, `.github/**`) | exact |
| `scripts/verify-release-content.mjs` (forbid `extension/relay/`) | utility | transform | `forbiddenPatterns`, lines 135-148 | exact |
| root test asserting `.vscodeignore` has `relay/**` | test | request-response | `src/test/cyberFixtures.test.ts:137-141` | exact |
| `.gitignore`, root `.dockerignore` | config | n/a | existing `.gitignore` | role |
| `relay/scripts/build.mjs`, `check-node.mjs` | utility | batch | `scripts/run-tests.mjs`, `scripts/vendor-libs.mjs`, `scripts/entries/mcp-client.mjs` (no esbuild config at root) | partial |
| `relay/test/*.test.ts`, contract suite, crash writer | test | CRUD / event | `src/test/runMarkersForeign.test.ts` | role |
| `relay/src/stateDir.ts`, `store/sqliteStore.ts` (atomic write) | service | file-I/O | `src/services/runMarkers.ts:252-270` | role |
| `relay/src/log/redact.ts` | utility | transform | `src/domain/redaction.ts` | role |
| `relay/src/bin.ts`, `main.ts`, `config.ts`, `secrets.ts`, `health.ts`, `http/server.ts` | various | request-response | none | none |
| `relay/Dockerfile`, `compose.yaml`, `.npmrc`, `.nvmrc` | config | n/a | none | none |

## Pattern Assignments

### `.github/workflows/ci.yml` relay job
**Analog:** `lint` job, `ci.yml` lines 29-43 (pinned action SHAs, `persist-credentials: false`, timeout, job `name` equal to key).
```yaml
  lint:
    name: lint
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: npm
```
Relay differences: `node-version: '26.13.1'` (do not reuse `env.NODE_VERSION`, which is `'24'`), `cache-dependency-path: relay/package-lock.json`, `defaults.run.working-directory: relay`, `npm ci --ignore-scripts`. Update the header comment (lines 1-4) to list `relay`.

### `scripts/lib/workflow.mjs` line 5
```js
export const CI_CHECKS = Object.freeze(['lint', 'test', 'e2e', 'release-content', 'audit', 'secret-scan']);
```
Append `'relay'`. `REQUIRED_CHECKS` (line 20) derives from it. Search `scripts/test/*.test.mjs` for tests that pin the list and update them. This is a gate change (D-19): human checkpoint.

### `scripts/verify-release-content.mjs`
Add to `forbiddenPatterns` (lines 135-146), same style:
```js
  /^extension\/(?:src|test|scripts|node_modules)(?:\/|$)/,
  /^extension\/relay(?:\/|$)/,
```

### Root `.vscodeignore` test
**Analog:** `src/test/cyberFixtures.test.ts:137-141`
```ts
const ignore = await readFile(path.join(REPO_ROOT, '.vscodeignore'), 'utf8');
const lines = ignore.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
assert.ok(lines.includes('test/**'), '...');
```
Assert `lines.includes('relay/**')`. Root `tsc` must not compile `relay/` (check root `tsconfig.json` `include`/`exclude`).

### `relay/scripts/build.mjs` and root script style
No esbuild config exists at the root, so build.mjs follows RESEARCH.md. Copy only the script conventions from `scripts/run-tests.mjs`: shebang, leading comment explaining why, `node:` imports, spawn with `stdio: 'inherit'`, signal forwarding, nonzero exit propagation. The relay test runner can reuse its per-run `TMPDIR` trick (lines 9-20) so tests that make temp state dirs are cleaned up:
```js
const runDir = mkdtempSync(path.join(tmpdir(), 'near-ai-test-run-'));
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, TMPDIR: runDir, TEMP: runDir, TMP: runDir } });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
```
Root npm scripts for comparison: `"lint": "tsc -p tsconfig.json --noEmit"`, `"test": "npm run compile && node scripts/run-tests.mjs dist/test/*.test.js ..."`.

### `relay/test/*.test.ts`
**Analog:** `src/test/runMarkersForeign.test.ts` lines 1-30: `node:assert/strict`, `import test from 'node:test'`, flat `test('...', async () => {...})`, temp dir helper, `try { ... } finally { rm }`, injected clock/pid (`now: () => clock.now`) rather than real time. Mirror that injection style for the store and logger. Tests are plain `node:test`, no describe nesting needed.

### Atomic file writes and 0600 (stateDir, any state file, pseudonym key per D-18)
**Analog:** `src/services/runMarkers.ts:252-270`
```ts
const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
try {
  await mkdir(this.dir, { recursive: true });
  await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
} catch {
  await rm(temporary, { force: true }).catch(() => undefined);
}
```
Relay differences: add an fsync of the file (open, write, `sync`, close) before rename and mkdir with `mode: 0o700`; do not swallow errors (the marker code is best-effort, the relay must fail loudly).

### `relay/src/log/redact.ts`
**Analog:** `src/domain/redaction.ts` (extension side; `relay/` must not import it, copy the idea, since `@ext/*` is reserved for `runner/`). Reusable ideas: `SECRET_TOKENS` regex of well-known token shapes (line 5), `SECRET_ASSIGNMENT` for `name: value` and quoted JSON (line 12), and `redactSecrets` doing `bearer\s+[^\s,;]+` then replacements. Relay adds what the extension lacks: exact masking of every registered loaded secret, `Authorization` header drop, message-text drop, phone-number stable hash label (D-11, D-18; RESEARCH.md Pitfall 10 and "Redactor (tested)").

## Shared Patterns

- **Gate-change discipline:** `ci.yml` header comment says job names, `CI_CHECKS`, and `docs/development-workflow.md` change in the same PR. D-19 adds the owner approval and branch-protection checkpoint.
- **Pinned actions:** copy the exact SHA pins from existing jobs, never tags.
- **No ambient env secrets / no console logging in `relay/src`:** enforce with a grep test (RESEARCH.md anti-patterns, line 236).
- **Tracked-source check:** all analogs above are git-tracked (verified via `git ls-files` for ci.yml, runMarkers.ts, redaction.ts).

## No Analog Found

`relay/src/bin.ts` (guard), `main.ts`, `config.ts`, `secrets.ts`, `health.ts`, `http/server.ts`, `store/*`, `Dockerfile`, `compose.yaml`, `.npmrc`, `.nvmrc`, `.dockerignore`: the repo has no HTTP service, SQLite, or container build. Use RESEARCH.md Code Examples (lines 305-733), which were run on this host.

## Metadata

**Analog search scope:** `.github/`, `scripts/`, `scripts/lib/`, `src/domain`, `src/services`, `src/test`, root `package.json`, `.vscodeignore`
**Pattern extraction date:** 2026-11-14
