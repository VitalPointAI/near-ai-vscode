import assert from 'node:assert/strict';
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { aadFor, open, seal } from '../domain/state/keys';
import { stateFolder } from '../domain/scratch';
import { StateKeys, dataKeySecretName } from '../services/stateKeys';
import { ProjectStateHome } from '../services/stateHome';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

function editor(root: string, secrets = new MemorySecrets(), keep = () => true): { keys: StateKeys; secrets: MemorySecrets; home: ProjectStateHome } {
  const home = new ProjectStateHome(root);
  return { keys: new StateKeys(home, secrets, keep), secrets, home };
}

test('tracer: editor A writes an encrypted file and editor B opens it with no manual step', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    const b = editor(root);
    const stateId = (await a.home.ensure()).stateId;
    const keyA = await a.keys.transcriptKey();
    const sealed = seal(keyA, Buffer.from('a private chat', 'utf8'), aadFor(stateId, 'thread'));
    assert.equal(b.secrets.values.size, 0, 'B starts with an empty secret store');
    const keyB = await b.keys.transcriptKey();
    assert.equal(open(keyB, sealed, aadFor(stateId, 'thread')).toString('utf8'), 'a private chat');
    assert.ok(b.secrets.values.has(dataKeySecretName(stateId)), "B now keeps its own copy under nearAi.state.<stateId>.dataKey");
    assert.match(dataKeySecretName(stateId), /^nearAi\.state\.[a-z0-9]+\.dataKey$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the key file is private and ignored twice; the folder is owner-only', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    await a.keys.ensureDataKey();
    const file = path.join(stateFolder(root), 'keys', 'local.key');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(path.join(stateFolder(root), 'keys', '.gitignore'), 'utf8'), '*\n');
    assert.equal(await readFile(path.join(stateFolder(root), '.gitignore'), 'utf8'), '*\n');
    assert.equal((await stat(path.join(stateFolder(root), 'keys'))).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a state home copied to another path opens with the same stateId and the same data key', async () => {
  const first = await tempProject();
  const second = await tempProject();
  try {
    const a = editor(first);
    const keyA = await a.keys.ensureDataKey();
    const idA = (await a.home.readMeta())?.stateId;
    await cp(stateFolder(first), stateFolder(second), { recursive: true });
    const b = editor(second);
    const keyB = await b.keys.dataKey();
    assert.equal((await b.home.readMeta())?.stateId, idA);
    assert.ok(keyB && keyB.equals(keyA), 'the same key bytes');
  } finally { await rm(first, { recursive: true, force: true }); await rm(second, { recursive: true, force: true }); }
});

test('keepKeyInProject off: no key file is written, the key lives only in SecretStorage, a new editor is locked', async () => {
  const root = await tempProject();
  try {
    const a = editor(root, new MemorySecrets(), () => false);
    const key = await a.keys.ensureDataKey();
    const stateId = (await a.home.readMeta())?.stateId as string;
    assert.equal(await stat(path.join(stateFolder(root), 'keys', 'local.key')).then(() => true, () => false), false);
    assert.equal(a.secrets.values.get(dataKeySecretName(stateId)), key.toString('base64'));
    const b = editor(root, new MemorySecrets(), () => false);
    assert.equal(await b.keys.dataKey(), undefined, 'a second editor with empty secrets is locked');
    await assert.rejects(() => b.keys.ensureDataKey(), /recovery code/);
    assert.equal(await stat(path.join(stateFolder(root), 'keys', 'local.key')).then(() => true, () => false), false, 'locking does not write a key');
    assert.equal(b.secrets.values.size, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a wrong key in SecretStorage is rejected by the key check, and a planted key file is not trusted', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    const real = await a.keys.ensureDataKey();
    const stateId = (await a.home.readMeta())?.stateId as string;
    const wrong = Buffer.alloc(32, 7);
    const b = editor(root, new MemorySecrets(), () => false);
    b.secrets.values.set(dataKeySecretName(stateId), wrong.toString('base64'));
    assert.equal(await b.keys.dataKey(), undefined);
    // The same wrong key placed in the project's key file by someone else is refused too; SecretStorage's good copy wins.
    await writeFile(path.join(stateFolder(root), 'keys', 'local.key'), `${wrong.toString('base64')}\n`);
    const c = editor(root);
    c.secrets.values.set(dataKeySecretName(stateId), real.toString('base64'));
    const found = await c.keys.dataKey();
    assert.ok(found && found.equals(real));
    const d = editor(root);
    assert.equal(await d.keys.dataKey(), undefined, 'planted file and nothing else: locked, never the planted key');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two editors creating the key at the same moment end with one key', async () => {
  for (let round = 0; round < 10; round += 1) {
    const root = await tempProject();
    try {
      const a = editor(root);
      const b = editor(root);
      const [keyA, keyB] = await Promise.all([a.keys.ensureDataKey(), b.keys.ensureDataKey()]);
      assert.ok(keyA.equals(keyB));
      const c = editor(root);
      assert.ok((await c.keys.dataKey())?.equals(keyA));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('opening reads nothing into existence: dataKey() on a folder with no state home is undefined and creates nothing', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    assert.equal(await a.keys.dataKey(), undefined);
    assert.equal(await stat(stateFolder(root)).then(() => true, () => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removing the key file is refused until a recovery wrap exists, and no key ever appears in an error', async () => {
  const root = await tempProject();
  try {
    const a = editor(root);
    const key = await a.keys.ensureDataKey();
    await assert.rejects(() => a.keys.removeLocalKeyFile(), (error: Error) => !error.message.includes(key.toString('base64')));
    assert.equal(await a.keys.hasRecoveryWrap(), false);
    await writeFile(path.join(stateFolder(root), 'keys', 'recovery.json'), '{}');
    await a.keys.removeLocalKeyFile();
    assert.equal(await stat(path.join(stateFolder(root), 'keys', 'local.key')).then(() => true, () => false), false);
    // The device copy keeps this editor open.
    const again = editor(root, a.secrets);
    assert.ok((await again.keys.dataKey())?.equals(key));
  } finally { await rm(root, { recursive: true, force: true }); }
});
