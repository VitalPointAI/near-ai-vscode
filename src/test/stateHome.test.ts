import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { stateFolder } from '../domain/scratch';
import { ProjectStateHome, createExclusive, newWriterId, writeFileAtomic } from '../services/stateHome';
import { git, gitInit, gitStatus, tempProject } from './helpers/stateFixtures';

test('SYNC-01: after ensure() and three writes, git sees nothing and names the inner .gitignore as the rule', async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    const home = new ProjectStateHome(root);
    await home.ensure();
    for (const name of ['a.json', 'b.json', 'c.json']) await writeFileAtomic(path.join(home.dir, name), '{"x":1}\n');
    await writeFileAtomic(path.join(home.dir, 'keys-note.txt'), 'x');
    assert.equal(gitStatus(root), '', 'nothing is untracked, modified or staged');
    const verdict = git(root, ['check-ignore', '-v', '.near-ai/state/x.json']);
    assert.match(verdict, /\.near-ai\/state\/\.gitignore:\d+:\*/, `the rule comes from the inner file: ${verdict}`);
    const forced = (() => { try { git(root, ['add', '.near-ai/state/a.json']); return 'added'; } catch { return 'refused'; } })();
    assert.equal(forced, 'refused', 'git add refuses an ignored file');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the inner .gitignore is the first file in the folder and holds only *', async () => {
  const root = await tempProject();
  try {
    const home = new ProjectStateHome(root);
    await home.ensure();
    assert.equal(await readFile(home.paths.gitignore, 'utf8'), '*\n');
    const gi = await stat(home.paths.gitignore);
    const meta = await stat(home.paths.meta);
    assert.ok(gi.birthtimeMs <= meta.birthtimeMs, 'written before meta.json');
    assert.equal((await stat(home.dir)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SYNC-01 adjacency: 20 writers to one target leave exactly one complete payload and no temporary files', async () => {
  const root = await tempProject();
  try {
    const home = new ProjectStateHome(root);
    await home.ensure();
    const target = path.join(home.dir, 'shared.bin');
    const payloads = Array.from({ length: 20 }, () => randomBytes(200 * 1024));
    await Promise.all(payloads.map((payload) => writeFileAtomic(target, payload)));
    const final = await readFile(target);
    assert.ok(payloads.some((payload) => payload.equals(final)), 'the file equals one writer payload in full');
    assert.deepEqual((await readdir(home.dir)).filter((name) => name.endsWith('.tmp')), []);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a failed atomic write leaves no temporary file behind', async () => {
  const root = await tempProject();
  try {
    const home = new ProjectStateHome(root);
    await home.ensure();
    // The target is a folder, so the rename fails after the temporary file was written.
    const target = path.join(home.dir, 'blocked');
    await home.ensureFolder(target);
    await writeFile(path.join(target, 'inside'), 'x');
    await assert.rejects(() => writeFileAtomic(target, 'data'));
    assert.deepEqual((await readdir(home.dir)).filter((name) => name.endsWith('.tmp')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('D-04: two instances calling ensure() at the same moment, 20 times, always agree on one stateId', async () => {
  for (let round = 0; round < 20; round += 1) {
    const root = await tempProject();
    try {
      const one = new ProjectStateHome(root);
      const two = new ProjectStateHome(root);
      const [a, b] = await Promise.all([one.ensure(), two.ensure()]);
      assert.equal(a.stateId, b.stateId);
      assert.equal((await one.readMeta())?.stateId, a.stateId);
      assert.equal(await readFile(one.paths.gitignore, 'utf8'), '*\n');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('SYNC-01 empty edge: opening a folder creates nothing; readers see an empty result until ensure()', async () => {
  const root = await tempProject();
  try {
    const home = new ProjectStateHome(root);
    assert.equal(await home.exists(), false);
    assert.equal(await home.readMeta(), undefined);
    assert.equal(await stat(stateFolder(root)).then(() => true, () => false), false, 'no folder yet');
    assert.deepEqual(await readdir(root), [], 'the project folder is untouched');
    await home.ensure();
    assert.equal(await home.exists(), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the stateId is random and never derived from the folder; a damaged meta.json is a plain error, not replaced', async () => {
  const one = await tempProject();
  const two = await tempProject();
  try {
    const a = await new ProjectStateHome(one).ensure();
    const b = await new ProjectStateHome(two).ensure();
    assert.notEqual(a.stateId, b.stateId);
    assert.match(a.stateId, /^[a-z0-9]{16,40}$/);
    const home = new ProjectStateHome(one);
    await writeFile(home.paths.meta, '{not json');
    await assert.rejects(() => home.readMeta(), /damaged/);
    await assert.rejects(() => home.ensure(), /damaged/);
    assert.equal(await readFile(home.paths.meta, 'utf8'), '{not json', 'left as found');
  } finally { await rm(one, { recursive: true, force: true }); await rm(two, { recursive: true, force: true }); }
});

test('createExclusive returns created once and exists after, and never exposes a half-written file', async () => {
  const root = await tempProject();
  try {
    const target = path.join(root, 'x');
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => createExclusive(target, `payload-${i}`)));
    assert.equal(results.filter((r) => r === 'created').length, 1);
    assert.match(await readFile(target, 'utf8'), /^payload-\d$/);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.tmp')), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the writer id is host-hash plus random and differs per call; no pid is used', () => {
  const a = newWriterId('host-a');
  const b = newWriterId('host-a');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.equal(a.slice(0, 8), b.slice(0, 8));
  assert.notEqual(newWriterId('host-b').slice(0, 8), a.slice(0, 8));
});

test('D-08, D-10: the phase settings are declared with their limits, and no sync remote setting is', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const props = pkg.contributes.configuration.properties;
  const live = props['nearAi.history.liveConversations'];
  const keep = props['nearAi.sync.keepKeyInProject'];
  assert.deepEqual([live.type, live.default, live.minimum, live.maximum], ['number', 5, 1, 50]);
  assert.deepEqual([keep.type, keep.default], ['boolean', true]);
  assert.equal(props['nearAi.sync.remote'], undefined, 'D-09 defers the private-remote setting');
  assert.doesNotMatch(props['nearAi.agent.saveTranscripts'].description, /Never saved in the project/);
  assert.match(props['nearAi.agent.saveTranscripts'].description, /\.near-ai\/state/);
  for (const key of ['nearAi.history.liveConversations', 'nearAi.sync.keepKeyInProject']) assert.doesNotMatch(props[key].description, /NEAR organization/i);
});
