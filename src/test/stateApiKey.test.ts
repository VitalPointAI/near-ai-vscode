import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { localKeyScope } from '../domain/auth';
import { stateFolder } from '../domain/scratch';
import { AuthService } from '../services/auth';
import { ProfileStore } from '../services/profileStore';
import { ProjectStateHome } from '../services/stateHome';
import { ApiKeyCopyHooks, apiKeyCopyHooks, openApiKeyCopy, removeApiKeyCopy, writeApiKeyCopy } from '../services/stateApiKey';
import { StateKeys } from '../services/stateKeys';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

const SENTINEL = 'near-test-SENTINEL-4f9a';
const LOCAL_SENTINEL = 'local-test-SENTINEL-7c21';
const ENDPOINT = 'https://example.test/v1';
const PROFILE = 'profile-company';

interface Editor { secrets: MemorySecrets; auth: AuthService; store: ProfileStore; home: ProjectStateHome; keys: StateKeys; hooks: ApiKeyCopyHooks; log: string[]; resolves: number }

/** One editor on a project folder: its own SecretStorage, its own AuthService, and the shared state home. */
function editor(root: string, keep = () => true): Editor {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const store = new ProfileStore(root, auth);
  const home = new ProjectStateHome(root);
  const keys = new StateKeys(home, secrets, keep);
  const log: string[] = [];
  const real = apiKeyCopyHooks({ projectScopeId: store.projectScopeId, home, keys, log: (line) => log.push(line) });
  const result: Editor = { secrets, auth, store, home, keys, hooks: real, log, resolves: 0 };
  auth.keyCopy = { ...real, resolve: async (scope, endpoint) => { result.resolves += 1; return real.resolve(scope, endpoint); } };
  return result;
}

async function setUp(a: Editor, profileId = PROFILE, key = SENTINEL): Promise<void> {
  await a.store.create({ profileId, displayName: 'Company', organization: 'Example Company', baseUrl: ENDPOINT, authMode: 'apiKey' });
  await a.store.saveProfileApiKey(profileId, key);
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(full)); else out.push(full);
  }
  return out;
}

function leaks(bytes: Buffer, needle: string): boolean {
  if (bytes.includes(needle) || bytes.toString('utf8').includes(needle) || bytes.toString('latin1').includes(needle)) return true;
  if (bytes.includes(Buffer.from(needle).toString('base64').slice(2, -2))) return true;
  for (const run of bytes.toString('utf8').match(/[A-Za-z0-9+/_=-]{16,}/g) ?? []) {
    for (const encoding of ['base64', 'base64url', 'hex'] as const) if (Buffer.from(run, encoding).toString('utf8').includes(needle)) return true;
  }
  return false;
}

test('D-15: a second editor on this host uses the key with no prompt and sync off, and keeps it in its own SecretStorage', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await setUp(a);
    const file = path.join(stateFolder(root), 'keys', 'api', `${PROFILE}.enc`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(stateFolder(root), 'keys', 'api'))).mode & 0o777, 0o700);
    const b = editor(root);
    const scope = b.store.getScope(PROFILE);
    assert.equal(b.secrets.values.size, 0);
    assert.equal(await b.auth.getScopedApiKeyFor(scope, ENDPOINT), SENTINEL);
    assert.equal(await b.auth.getScopedApiKey(scope), SENTINEL, "B's own SecretStorage now holds it under the local project scope");
    assert.equal(b.secrets.values.get('nearAi.v2.' + scope.projectId + '.' + scope.profileId + '.api-key-endpoint'), ENDPOINT);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: the plaintext key is on no disk file and in no log line; a hybrid local key is shared the same way', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await a.store.create({ profileId: PROFILE, displayName: 'Company', organization: 'Example Company', baseUrl: ENDPOINT, authMode: 'apiKey', provider: 'hybrid', localBaseUrl: 'https://local.example.test/v1' });
    await a.auth.saveScopedApiKey(localKeyScope(a.store.getScope(PROFILE)), LOCAL_SENTINEL, 'https://local.example.test/v1');
    await a.store.saveProfileApiKey(PROFILE, SENTINEL);
    const b = editor(root);
    assert.equal(await b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), ENDPOINT), SENTINEL);
    assert.equal(await b.auth.getScopedApiKeyFor(localKeyScope(b.store.getScope(PROFILE)), 'https://local.example.test/v1'), LOCAL_SENTINEL);
    // A refused copy also logs one sentence: scan those lines too.
    const file = path.join(stateFolder(root), 'keys', 'api', `${PROFILE}.enc`);
    const damaged = JSON.parse(await readFile(file, 'utf8')) as { data: string };
    damaged.data = Buffer.from(damaged.data, 'base64').fill(1).toString('base64');
    await writeFile(file, JSON.stringify(damaged));
    const c = editor(root);
    assert.equal(await c.auth.getScopedApiKeyFor(c.store.getScope(PROFILE), ENDPOINT), undefined);
    for (const dir of [stateFolder(root), path.join(root, '.planning')]) {
      for (const name of await allFiles(dir)) {
        const bytes = await readFile(name);
        assert.equal(leaks(bytes, SENTINEL), false, `${path.relative(root, name)} holds the key`);
        assert.equal(leaks(bytes, LOCAL_SENTINEL), false, `${path.relative(root, name)} holds the local key`);
      }
    }
    for (const line of [...a.log, ...b.log, ...c.log]) assert.equal(leaks(Buffer.from(line), SENTINEL) || leaks(Buffer.from(line), LOCAL_SENTINEL), false);
    assert.equal(c.log.length, 1, 'one plain sentence for the refusal');
    assert.match(c.log[0], /not used|not for this project/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: a tampered copy, a copy renamed to another profile, and a copy from another project are each refused', async () => {
  const root = await tempProject();
  const other = await tempProject();
  try {
    const a = editor(root);
    await setUp(a);
    const apiDir = path.join(stateFolder(root), 'keys', 'api');
    const file = path.join(apiDir, `${PROFILE}.enc`);
    const original = await readFile(file, 'utf8');
    // One flipped byte in the ciphertext.
    const flipped = JSON.parse(original) as { data: string };
    const bytes = Buffer.from(flipped.data, 'base64');
    bytes[0] ^= 0xff;
    flipped.data = bytes.toString('base64');
    await writeFile(file, JSON.stringify(flipped));
    const notices: string[] = [];
    assert.equal(await openApiKeyCopy(a.home, a.keys, PROFILE, (line) => notices.push(line)), undefined);
    assert.equal(notices.length, 1);
    // P's copy renamed to profile Q's file: the AAD names P.
    await writeFile(file, original);
    await writeFile(path.join(apiDir, 'profile-other.enc'), original);
    assert.equal(await openApiKeyCopy(a.home, a.keys, 'profile-other', (line) => notices.push(line)), undefined);
    assert.equal(notices.length, 2);
    assert.equal((await openApiKeyCopy(a.home, a.keys, PROFILE))?.apiKey, SENTINEL, 'the untouched original still opens');
    // A copy made in another project's state home.
    const foreign = editor(other);
    await setUp(foreign);
    await cp(path.join(stateFolder(other), 'keys', 'api', `${PROFILE}.enc`), file);
    assert.equal(await openApiKeyCopy(a.home, a.keys, PROFILE, (line) => notices.push(line)), undefined);
    assert.equal(notices.length, 3);
    const b = editor(root);
    assert.equal(await b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), ENDPOINT), undefined);
    for (const line of notices) assert.doesNotMatch(line, new RegExp(SENTINEL));
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('D-15: with keys/local.key gone and SecretStorage empty the copy cannot be opened and set-up follows', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await setUp(a);
    await rm(path.join(stateFolder(root), 'keys', 'local.key'));
    const b = editor(root);
    assert.equal(await b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), ENDPOINT), undefined);
    assert.equal(b.secrets.values.size, 0, 'nothing was stored');
    // keepKeyInProject off from the start: the key file never exists, so a new editor is locked the same way.
    const root2 = await tempProject();
    try {
      const c = editor(root2, () => false);
      await setUp(c);
      assert.equal(await stat(path.join(stateFolder(root2), 'keys', 'local.key')).then(() => true, () => false), false);
      const d = editor(root2, () => false);
      assert.equal(await d.auth.getScopedApiKeyFor(d.store.getScope(PROFILE), ENDPOINT), undefined);
    } finally { await rm(root2, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: saving a new key rotates the copy, removing the profile removes it, and a copy for another endpoint is never released', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await setUp(a);
    const file = path.join(stateFolder(root), 'keys', 'api', `${PROFILE}.enc`);
    const first = await readFile(file, 'utf8');
    await a.store.saveProfileApiKey(PROFILE, 'near-test-SENTINEL-second');
    const second = await readFile(file, 'utf8');
    assert.notEqual(second, first, 'new ciphertext');
    const b = editor(root);
    assert.equal(await b.auth.getScopedApiKeyFor(b.store.getScope(PROFILE), ENDPOINT), 'near-test-SENTINEL-second');
    // Another endpoint asks: the copy is for ENDPOINT only.
    const c = editor(root);
    assert.equal(await c.auth.getScopedApiKeyFor(c.store.getScope(PROFILE), 'https://elsewhere.test/v1'), undefined);
    assert.equal(await c.auth.getScopedApiKey(c.store.getScope(PROFILE)), undefined, 'a mismatched endpoint is never stored or released');
    await a.store.remove(PROFILE);
    assert.equal(await stat(file).then(() => true, () => false), false);
    const d = editor(root);
    assert.equal(await d.auth.getScopedApiKeyFor(d.store.getScope(PROFILE), ENDPOINT), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: no copy for a team profile or a reused profile, and an invalid profile id is refused', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    const scope = (profileId: string) => ({ version: 1 as const, projectId: a.store.projectScopeId, profileId });
    const profile = (profileId: string, extra = {}) => ({ profileId, baseUrl: ENDPOINT, ...extra });
    await a.hooks.written(scope('profile-team-acme'), profile('profile-team-acme'), SENTINEL);
    await a.hooks.written(scope('profile-reused'), profile('profile-reused', { keySource: { projectId: 'project-' + 'a'.repeat(32), profileId: 'profile-reused' } }), SENTINEL);
    await a.hooks.written({ ...scope('profile-reused'), projectId: 'project-' + 'b'.repeat(32) }, profile('profile-reused'), SENTINEL);
    assert.equal(await stat(stateFolder(root)).then(() => true, () => false), false, 'nothing was created');
    await assert.rejects(() => writeApiKeyCopy(a.home, a.keys, { profileId: '../escape', endpoint: ENDPOINT, apiKey: SENTINEL }), /profile/);
    await removeApiKeyCopy(a.home, '../../escape');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: the sealed copy is asked for at most once per scope per host, and asking creates nothing', async () => {
  const root = await tempProject();
  try {
    const b = editor(root);
    const scope = b.store.getScope(PROFILE);
    assert.equal(await b.auth.getScopedApiKeyFor(scope, ENDPOINT), undefined);
    assert.equal(await b.auth.getScopedApiKeyFor(scope, ENDPOINT), undefined);
    assert.equal(await Promise.all([b.auth.getScopedApiKeyFor(scope, ENDPOINT), b.auth.getScopedApiKeyFor(scope, ENDPOINT)]).then((all) => all.every((v) => v === undefined)), true);
    assert.equal(b.resolves, 1);
    assert.equal(await stat(stateFolder(root)).then(() => true, () => false), false, 'opening a folder still writes nothing');
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: a key removed on purpose in this editor is not brought back from the copy in the same session', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await setUp(a);
    const b = editor(root);
    const scope = b.store.getScope(PROFILE);
    assert.equal(await b.auth.getScopedApiKeyFor(scope, ENDPOINT), SENTINEL);
    await b.auth.removeScopedApiKey(scope);
    assert.equal(await b.auth.getScopedApiKeyFor(scope, ENDPOINT), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-15: the copy folder is created beside a keys/.gitignore and holds only *.enc files', async () => {
  const root = await tempProject();
  try {
    const a = editor(root, () => false);
    await setUp(a);
    assert.equal(await readFile(path.join(stateFolder(root), 'keys', '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual((await readdir(path.join(stateFolder(root), 'keys', 'api'))).sort(), [`${PROFILE}.enc`]);
    await mkdir(path.join(root, 'unrelated'), { recursive: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
