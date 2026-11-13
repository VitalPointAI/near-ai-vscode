import assert from 'node:assert/strict';
import { cp, readFile, rm, stat } from 'node:fs/promises';
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
