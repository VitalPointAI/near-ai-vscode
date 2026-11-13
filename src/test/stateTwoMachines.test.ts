import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import test from 'node:test';
import { generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import { MAX_PUSH_ATTEMPTS } from '../services/stateSync';
import { bareRemote, fixtureGit } from './helpers/gitFixtures';
import { SIX_TURNS, chain, entryIds, machine } from './helpers/syncFixtures';

// Phase 27, plan 12 (SYNC-05): two computers with the project cloned at different paths exchange the state home through the project's own remote.

const THREAD = 'conv-twomachine1';
const REF = 'refs/heads/near-ai/state';
const tipOf = (remote: string): string => fixtureGit(remote, ['rev-parse', REF]).trim();

test('tracer: A pushes a six-entry thread, B opens it with the recovery code at another path, continues it, and A gets B\'s turns', async () => {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  assert.notEqual(a.root, b.root, 'the two computers hold the project at different paths');
  const { code, bytes } = generateRecoveryCode();

  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: THREAD, title: 'Plan the release', model: 'near/model-a', origin: 'panel' });
  const first = chain(THREAD, a.writer, SIX_TURNS);
  await a.threads.appendEntries(THREAD, first);
  const pushed = await a.sync.sync();
  assert.equal(pushed.kind, 'synced', pushed.message);
  assert.equal(pushed.pushed, true);
  assert.match(tipOf(remote), /^[0-9a-f]{40}$/, 'the remote has the state branch');

  // B has no state home at all until it is opened with the code.
  assert.equal(await stat(b.home.dir).then(() => true, () => false), false);
  const typed = parseRecoveryCode(code.toLowerCase().replace(/-/g, ' '));
  assert.ok(typed);
  const unlocked = await b.sync.unlockFromRemote(typed);
  assert.equal(unlocked.kind, 'synced', unlocked.message);
  assert.equal((await b.home.readMeta())?.stateId, (await a.home.readMeta())?.stateId, 'B takes the project id from the remote');
  assert.equal((await stat(b.home.paths.localKey)).mode & 0o777, 0o600);
  assert.ok([...b.secrets.values.keys()].some((name) => name.endsWith('.dataKey')), 'the device copy of the key is stored');

  const pulled = await b.sync.pullOnly();
  assert.equal(pulled.kind, 'synced', pulled.message);
  assert.deepEqual(await entryIds(b, THREAD), first.map((entry) => entry.id).sort());
  assert.equal((await b.threads.meta(THREAD))?.title, 'Plan the release');

  // B continues the thread and pushes; A pulls it.
  const more = chain(THREAD, b.writer, [['user', 'one more thing'], ['assistant', 'sure']], first[first.length - 1]?.id ?? null);
  await b.threads.appendEntries(THREAD, more);
  const back = await b.sync.sync();
  assert.equal(back.kind, 'synced', back.message);
  assert.equal(back.pushed, true);
  const aSync = await a.sync.sync();
  assert.equal(aSync.kind, 'synced', aSync.message);
  assert.deepEqual(await entryIds(a, THREAD), [...first, ...more].map((entry) => entry.id).sort(), 'nothing either computer wrote is lost');
  assert.equal((await entryIds(a, THREAD)).length, 8);
});

test('a second sync on each computer finds nothing new and the remote tip does not move', async () => {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { code, bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: THREAD, title: 'Steady', model: 'near/model-a', origin: 'panel' });
  await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, SIX_TURNS));
  await a.sync.sync();
  const typed = parseRecoveryCode(code);
  assert.ok(typed);
  await b.sync.unlockFromRemote(typed);
  await b.sync.sync();
  await a.sync.sync();
  const settled = tipOf(remote);
  const again = [await a.sync.sync(), await b.sync.sync(), await a.sync.sync()];
  for (const outcome of again) {
    assert.equal(outcome.kind, 'synced');
    assert.equal(outcome.pushed, false, 'nothing was pushed');
  }
  assert.equal(tipOf(remote), settled, 'the remote tip did not move');
});

test('the recovery wrap is owner-only and the code is never written anywhere in the state home', async () => {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const { code, bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  assert.equal((await stat(a.home.paths.recoveryWrap)).mode & 0o777, 0o600);
  const wrap = await a.keys.readRecoveryWrap();
  assert.ok(wrap && wrap.kdf.name === 'scrypt');
  const text = await readFile(a.home.paths.recoveryWrap, 'utf8');
  assert.equal(text.includes(code) || text.includes(code.replaceAll('-', '')) || text.includes(bytes.toString('base64')), false);
  assert.ok(MAX_PUSH_ATTEMPTS >= 2);
});
