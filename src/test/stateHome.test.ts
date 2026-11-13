import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { stateFolder } from '../domain/scratch';
import { ProjectStateHome, createExclusive, newWriterId, writeFileAtomic } from '../services/stateHome';
import { StateBusyError, STATE_LOCKS_DIR, withStateLock } from '../services/stateLocks';
import { StateKeys } from '../services/stateKeys';
import { MemorySecrets, git, gitInit, gitStatus, tempProject } from './helpers/stateFixtures';

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

// The meta lock (REVIEW MINOR stateHome.ts:213): key creation and every meta.json change have one owner at a time across editors on this computer.

const SERVICES = path.join(__dirname, '..', 'services');

/** Starts one node child per script, waits until every child says it is ready, then lets them all go at once. Resolves with each child's exit code and output. */
async function runTogether(dir: string, bodies: string[]): Promise<Array<{ code: number | null; out: string; err: string }>> {
  const go = path.join(dir, 'go');
  const children = bodies.map((body, index) => {
    const script = path.join(dir, `child-${index}.js`);
    writeFileSync(script, `const fs = require('node:fs');
(async () => {
  process.stdout.write('ready\\n');
  while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 1));
${body}
})().catch((error) => { console.error(String(error && error.stack || error)); process.exit(1); });
`);
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => { ready = resolve; });
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); if (out.includes('ready')) ready(); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    const done = new Promise<{ code: number | null; out: string; err: string }>((resolve) => { child.on('exit', (code) => resolve({ code, out, err })); });
    return { isReady, done };
  });
  await Promise.all(children.map((child) => child.isReady));
  writeFileSync(go, 'go');
  return Promise.all(children.map((child) => child.done));
}

test('two editors in two processes creating the key at once, ten rounds, end with one key file and a key check that opens with it', async () => {
  for (let round = 0; round < 10; round += 1) {
    const root = await tempProject();
    const scratch = await tempProject();
    try {
      const body = `  const { StateKeys } = require(${JSON.stringify(path.join(SERVICES, 'stateKeys.js'))});
  const { ProjectStateHome } = require(${JSON.stringify(path.join(SERVICES, 'stateHome.js'))});
  const values = new Map();
  const secrets = { get: async (k) => values.get(k), store: async (k, v) => { values.set(k, v); }, delete: async (k) => { values.delete(k); } };
  const key = await new StateKeys(new ProjectStateHome(${JSON.stringify(root)}), secrets).ensureDataKey();
  process.stdout.write('key ' + key.toString('base64') + '\\n');`;
      const results = await runTogether(scratch, [body, body]);
      assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.err).join('\n'));
      const keys = results.map((result) => /key (\S+)/.exec(result.out)?.[1]);
      assert.ok(keys[0] && keys[0] === keys[1], 'both processes hold the same key');
      const reader = new StateKeys(new ProjectStateHome(root), new MemorySecrets());
      const found = await reader.dataKey();
      assert.ok(found && found.toString('base64') === keys[0], 'the key file and the key check open with that key');
      assert.equal((await readFile(path.join(stateFolder(root), 'keys', 'local.key'), 'utf8')).trim(), keys[0]);
      assert.deepEqual((await readdir(path.join(root, STATE_LOCKS_DIR))).filter((name) => name.endsWith('.lock') || name.endsWith('.stale')), [], 'no lock is left behind');
    } finally { await rm(root, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); }
  }
});

test('two processes interleaving 20 updateMeta calls each never lose keyCheck or migrated, and meta.json is always a whole file', async () => {
  const root = await tempProject();
  const scratch = await tempProject();
  try {
    await new ProjectStateHome(root).ensure();
    const header = `  const { ProjectStateHome } = require(${JSON.stringify(path.join(SERVICES, 'stateHome.js'))});
  const home = new ProjectStateHome(${JSON.stringify(root)});`;
    const setsKeyCheck = `${header}
  for (let i = 0; i < 20; i += 1) await home.updateMeta({ keyCheck: { iv: 'iv' + i, tag: 'tag', data: 'data' } });`;
    const setsMigrated = `${header}
  for (let i = 0; i < 20; i += 1) {
    const current = await home.readMeta();
    await home.updateMeta({ migrated: { ...(current.migrated || {}), ['k' + i]: i } });
  }`;
    const results = await runTogether(scratch, [setsKeyCheck, setsMigrated]);
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.err).join('\n'));
    const meta = JSON.parse(readFileSync(path.join(stateFolder(root), 'meta.json'), 'utf8'));
    assert.equal(meta.keyCheck?.iv, 'iv19', 'the last keyCheck is kept');
    assert.equal(Object.keys(meta.migrated ?? {}).length, 20, 'every migrated entry is kept');
    assert.deepEqual((await readdir(stateFolder(root))).filter((name) => name.endsWith('.tmp')), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(scratch, { recursive: true, force: true }); }
});

test('a lock left by a dead process on this computer is taken over at once; a fresh lock of a live process makes the waiter give up with one plain sentence', async () => {
  const root = await tempProject();
  try {
    const locks = path.join(root, STATE_LOCKS_DIR);
    await mkdir(locks, { recursive: true });
    const lockFile = path.join(locks, 'meta.lock');
    const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).trim();
    await writeFile(lockFile, `${JSON.stringify({ pid: Number(dead), host: hostname(), token: 'ab'.repeat(8) })}\n`);
    const started = Date.now();
    assert.equal(await withStateLock(root, 'meta', () => Promise.resolve('ran'), { waitMs: 2_000 }), 'ran');
    assert.ok(Date.now() - started < 1_500, 'taken over without waiting');
    assert.equal(existsSync(lockFile), false, 'released when the work ends');
    // A live holder with a fresh time: the waiter waits its limit, then reports StateBusyError and does not run the work.
    await writeFile(lockFile, `${JSON.stringify({ pid: process.pid, host: hostname(), token: 'cd'.repeat(8) })}\n`);
    let ran = false;
    await assert.rejects(() => withStateLock(root, 'meta', () => { ran = true; return Promise.resolve(); }, { waitMs: 60, staleMs: 60_000 }), (error: unknown) => {
      return error instanceof StateBusyError && /Another editor on this computer is saving this project's state\. Try again in a moment\. Nothing was changed\./.test(error.message);
    });
    assert.equal(ran, false);
    assert.ok(existsSync(lockFile), "the live holder's lock is left alone");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the locks folder gets its own .gitignore of * first, and after locking and key creation git sees nothing in the project', async () => {
  const root = await tempProject();
  try {
    gitInit(root);
    await withStateLock(root, 'sync', async () => {
      assert.equal(await readFile(path.join(root, STATE_LOCKS_DIR, '.gitignore'), 'utf8'), '*\n', 'written before the lock file');
      assert.deepEqual((await readdir(path.join(root, STATE_LOCKS_DIR))).sort(), ['.gitignore', 'sync.lock']);
    });
    assert.equal((await stat(path.join(root, STATE_LOCKS_DIR))).mode & 0o777, 0o700);
    await new StateKeys(new ProjectStateHome(root), new MemorySecrets()).ensureDataKey();
    assert.equal(gitStatus(root), '', 'nothing is untracked, modified or staged');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a planted key file with no key check is replaced under the lock by a fresh key with a key check', async () => {
  const root = await tempProject();
  try {
    const home = new ProjectStateHome(root);
    await home.ensure();
    await home.ensureFolder(home.paths.keysDir);
    const planted = randomBytes(32).toString('base64');
    await writeFile(home.paths.localKey, `${planted}\n`, { mode: 0o600 });
    const keys = new StateKeys(home, new MemorySecrets());
    const key = await keys.ensureDataKey();
    assert.notEqual(key.toString('base64'), planted, 'the planted bytes are not the key');
    assert.equal((await readFile(home.paths.localKey, 'utf8')).trim(), key.toString('base64'));
    assert.ok((await home.readMeta())?.keyCheck, 'a key check was written');
    assert.ok((await new StateKeys(new ProjectStateHome(root), new MemorySecrets()).dataKey())?.equals(key));
    assert.equal((await stat(home.paths.localKey)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});
