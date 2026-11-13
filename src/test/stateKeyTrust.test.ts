// Which key file may be used (REVIEW B1: nothing inside the project folder decides which key is used). Planted, tracked, linked and group-readable key
// files are refused; the same user's second editor on the same computer still opens with no prompt (D-10, D-15). Keys are made at runtime.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { StateRefusedError, newDataKey, newSalt, wrapDataKey, deriveKek, KDF_PARAMS } from '../domain/state/keys';
import { stateFolder } from '../domain/scratch';
import { StateKeys, dataKeySecretName } from '../services/stateKeys';
import { ProjectStateHome } from '../services/stateHome';
import { MemorySecrets, git, gitInit, tempProject } from './helpers/stateFixtures';

function editor(root: string, secrets = new MemorySecrets()): { keys: StateKeys; secrets: MemorySecrets; home: ProjectStateHome } {
  const home = new ProjectStateHome(root);
  return { keys: new StateKeys(home, secrets), secrets, home };
}

async function treeHash(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of (await readdir(dir, { recursive: true })).map(String).sort()) {
    const full = path.join(dir, name);
    const info = await stat(full);
    hash.update(name);
    if (info.isFile()) hash.update(await readFile(full));
  }
  return hash.digest('hex');
}

/** Editor A makes the project's state home and key; the returned key file path is where editor B would look. */
async function projectWithKey(root: string): Promise<{ key: Buffer; stateId: string; file: string }> {
  const a = editor(root);
  const key = await a.keys.ensureDataKey();
  const stateId = (await a.home.readMeta())?.stateId as string;
  return { key, stateId, file: path.join(stateFolder(root), 'keys', 'local.key') };
}

test('tracer: a state folder tracked by git is refused in plain words and nothing is read from or written into it', async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    const { key } = await projectWithKey(root);
    git(root, ['add', '-f', '.near-ai/state']);
    git(root, ['commit', '-q', '-m', 'forced']);
    const before = await treeHash(stateFolder(root));
    const b = editor(root);
    assert.equal(await b.keys.dataKey(), undefined, 'locked, not an error');
    await assert.rejects(() => b.keys.ensureDataKey(), (error: unknown) => error instanceof StateRefusedError && error.reason === 'foreign-folder' && /part of the project's files in git/.test(error.message));
    assert.equal(b.secrets.values.size, 0, 'no device copy was made from it');
    assert.equal(await treeHash(stateFolder(root)), before, 'nothing was written into the folder');
    // Editor A already holds the key but is refused too once the folder is tracked: its chats are not opened from the tracked folder.
    const fresh = editor(root, new MemorySecrets());
    fresh.secrets.values.set(dataKeySecretName((await b.home.readMeta())?.stateId as string), key.toString('base64'));
    assert.equal(await fresh.keys.dataKey(), undefined, 'even a device copy is not used for a tracked folder');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a key file readable by group or others is not used; the same file at 0600 opens (second editor on this computer)', { skip: process.platform === 'win32' }, async () => {
  const root = await tempProject();
  try {
    const { key, file } = await projectWithKey(root);
    await chmod(file, 0o644);
    assert.equal(await editor(root).keys.dataKey(), undefined);
    await chmod(file, 0o600);
    const found = await editor(root).keys.dataKey();
    assert.ok(found && found.equals(key));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a key file that is a symbolic link is not used', { skip: process.platform === 'win32' }, async () => {
  const root = await tempProject();
  const outside = await tempProject();
  try {
    const { key, file } = await projectWithKey(root);
    const target = path.join(outside, 'elsewhere.key');
    await writeFile(target, `${key.toString('base64')}\n`, { mode: 0o600 });
    await rm(file);
    await symlink(target, file);
    assert.equal(await editor(root).keys.dataKey(), undefined);
    await assert.rejects(() => editor(root).keys.ensureDataKey(), /recovery code/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('a planted key file is not used without a key check, nor when the planted check was made from the planted key but the folder is tracked', async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    const real = editor(root);
    const meta = await real.home.ensure();
    const planted = newDataKey();
    await real.home.ensureFolder(real.home.paths.keysDir);
    await writeFile(real.home.paths.localKey, `${planted.toString('base64')}\n`, { mode: 0o600 });
    const b = editor(root);
    assert.equal(await b.keys.dataKey(), undefined, 'no key check: the file is never trusted');
    assert.equal(b.secrets.values.size, 0);
    // The attacker also plants a key check made from the planted key; the folder is tracked, so it is still refused.
    const maker = editor(root);
    await maker.keys.adoptDataKey(planted, meta.stateId);
    git(root, ['add', '-f', '.near-ai/state']);
    git(root, ['commit', '-q', '-m', 'forced']);
    assert.equal(await editor(root).keys.dataKey(), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a recovery wrap that is tracked, a link or group-readable reads as no wrap', { skip: process.platform === 'win32' }, async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    const { key, stateId } = await projectWithKey(root);
    const a = editor(root, new MemorySecrets());
    a.secrets.values.set(dataKeySecretName(stateId), key.toString('base64'));
    const salt = newSalt();
    const wrap = { kdf: { name: KDF_PARAMS.name, N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, salt: salt.toString('base64') }, wrappedKey: wrapDataKey(await deriveKek(Buffer.alloc(32, 1), salt, KDF_PARAMS), key, stateId) };
    await a.keys.storeRecoveryWrap(wrap);
    const file = a.home.paths.recoveryWrap;
    assert.ok(await a.keys.readRecoveryWrap(), 'a private untracked wrap is usable');
    assert.equal(await a.keys.hasRecoveryWrap(), true);
    await chmod(file, 0o640);
    assert.equal(await a.keys.readRecoveryWrap(), undefined);
    assert.equal(await a.keys.hasRecoveryWrap(), false);
    await chmod(file, 0o600);
    const text = await readFile(file, 'utf8');
    await rm(file);
    const elsewhere = path.join(root, 'elsewhere.json');
    await writeFile(elsewhere, text, { mode: 0o600 });
    await symlink(elsewhere, file);
    assert.equal(await a.keys.readRecoveryWrap(), undefined);
    assert.equal(await a.keys.hasRecoveryWrap(), false);
    await rm(file);
    await writeFile(file, text, { mode: 0o600 });
    const trusted = editor(root, a.secrets);
    assert.equal(await trusted.keys.hasRecoveryWrap(), true);
    git(root, ['add', '-f', '.near-ai/state']);
    git(root, ['commit', '-q', '-m', 'forced']);
    assert.equal(await editor(root).keys.readRecoveryWrap(), undefined);
    assert.equal(await editor(root).keys.hasRecoveryWrap(), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the cached key follows the state id: after meta.json names another state, the same editor finds that state key', async () => {
  const root = await tempProject();
  const other = await tempProject();
  try {
    const first = await projectWithKey(root);
    const second = await projectWithKey(other);
    assert.notEqual(first.stateId, second.stateId);
    const b = editor(root);
    assert.ok((await b.keys.dataKey())?.equals(first.key), 'B opened the first state');
    assert.ok((await b.keys.ensureDataKey()).equals(first.key));
    // A join in another editor swaps in a re-keyed copy: its own meta.json and key file.
    await mkdir(path.join(stateFolder(root), 'keys'), { recursive: true });
    await writeFile(path.join(stateFolder(root), 'meta.json'), await readFile(path.join(stateFolder(other), 'meta.json')));
    await writeFile(path.join(stateFolder(root), 'keys', 'local.key'), await readFile(path.join(stateFolder(other), 'keys', 'local.key')), { mode: 0o600 });
    await chmod(path.join(stateFolder(root), 'keys', 'local.key'), 0o600);
    const now = await b.keys.dataKey();
    assert.ok(now && now.equals(second.key) && !now.equals(first.key), 'dataKey() returns the new key');
    assert.ok((await b.keys.ensureDataKey()).equals(second.key), 'ensureDataKey() seals with the new key, never the old one');
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});

test('the same user second editor on this computer opens a key file written by the extension with no prompt and no device copy needed', async () => {
  const root = await tempProject();
  try {
    const { key, stateId } = await projectWithKey(root);
    const b = editor(root);
    assert.ok((await b.keys.dataKey())?.equals(key));
    const c = editor(root);
    assert.ok((await c.keys.ensureDataKey()).equals(key));
    assert.ok(c.secrets.values.has(dataKeySecretName(stateId)), 'C keeps its own device copy');
  } finally { await rm(root, { recursive: true, force: true }); }
});
