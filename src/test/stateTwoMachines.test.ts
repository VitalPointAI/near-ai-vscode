import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { ComparisonStore } from '../benchmark/store';
import { RUN_FORMAT, type SavedRun } from '../benchmark/results';
import { generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import { readProjectChoicesSync, writeProjectChoice } from '../services/modelChoices';
import { CHECKPOINT_SYNC_BYTES, CHECKPOINT_SYNC_RUNS, SYNCED_KINDS } from '../services/stateRecords';
import { MAX_PUSH_ATTEMPTS } from '../services/stateSync';
import { bareRemote, fixtureGit } from './helpers/gitFixtures';
import { SIX_TURNS, chain, entryIds, machine, remotePayloads, treeHash, writeMarker, type Machine } from './helpers/syncFixtures';

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

/** Two computers over one remote with sync on and B opened with the code. Machine A already pushed once. */
async function pair(): Promise<{ remote: string; a: Machine; b: Machine; code: string; bytes: Buffer }> {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { code, bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: THREAD, title: 'Shared thread', model: 'near/model-a', origin: 'panel' });
  await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, SIX_TURNS));
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.unlockFromRemote(bytes)).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  return { remote, a, b, code, bytes };
}

const jsonFiles = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
const later = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('markers: an ended run and a cut-off run sync; a run that is running here or elsewhere never does', async () => {
  const { a, b } = await pair();
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  await writeMarker(a, 'conv-finished1', { runId: 'run-101-aaaaaa', endedAt: new Date().toISOString(), outcome: 'completed' });
  await writeMarker(a, 'conv-cutoff01', { runId: 'run-102-bbbbbb', writer: 'ccccccc.ddddddd', activeAt: old, startedAt: old });
  await writeMarker(a, 'conv-runhere1', { runId: 'run-103-cccccc' });
  await writeMarker(a, 'conv-runelse1', { runId: 'run-104-dddddd', writer: 'ccccccc.ddddddd' });
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await jsonFiles(b.home.paths.runs), ['conv-cutoff01.json', 'conv-finished1.json']);
  const cut = await b.markers.markerOf('conv-cutoff01');
  assert.ok(cut);
  assert.equal(b.markers.runState(cut), 'cut-off', 'on B it waits for a click; nothing resumes by itself');
});

test('checkpoints: of twelve runs only the newest ten sync, outside files never leave, and B reverts under its own root', async () => {
  const { a, b } = await pair();
  const outside = path.join(path.dirname(a.root), `outside-${path.basename(a.root)}.txt`);
  await writeFile(outside, 'outside original');
  for (let index = 0; index < 12; index += 1) {
    const runId = `run-${200 + index}-abcdef`;
    const file = path.join(a.root, 'src', `f${index}.ts`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `original ${index}`);
    const checkpoints = new RunCheckpoints(runId, a.home.paths.checkpoints, { root: a.root, beforeWrite: () => a.home.ensure() });
    await checkpoints.capture(file);
    if (index === 11) await checkpoints.capture(outside);
    await writeFile(file, `changed ${index}`);
    const at = new Date(Date.now() - (12 - index) * 60_000);
    await utimes(path.join(a.home.paths.checkpoints, `${runId}.json`), at, at);
  }
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  const names = await jsonFiles(b.home.paths.checkpoints);
  assert.equal(names.length, CHECKPOINT_SYNC_RUNS);
  assert.deepEqual(names, Array.from({ length: 10 }, (_, index) => `run-${202 + index}-abcdef.json`));
  const text = await readFile(path.join(b.home.paths.checkpoints, 'run-211-abcdef.json'), 'utf8');
  assert.equal(text.includes('"abs"') || text.includes(outside) || text.includes('"outside"'), false, 'no absolute or outside snapshot crosses machines');
  const loaded = await RunCheckpoints.load('run-211-abcdef', b.home.paths.checkpoints, { root: b.root });
  assert.ok(loaded);
  await loaded.revert();
  assert.equal(await readFile(path.join(b.root, 'src', 'f11.ts'), 'utf8'), 'original 11', 'the revert writes under B\'s own root');
  assert.equal(await readFile(outside, 'utf8'), 'outside original');
});

test('checkpoints: fewer sync when the newest runs together pass 25 MiB', async () => {
  const { a, b } = await pair();
  for (let index = 0; index < 4; index += 1) {
    const runId = `run-${300 + index}-abcdef`;
    const file = path.join(a.root, `big${index}.bin`);
    await writeFile(file, Buffer.alloc(5 * 1024 * 1024, 97 + index));
    const checkpoints = new RunCheckpoints(runId, a.home.paths.checkpoints, { root: a.root, beforeWrite: () => a.home.ensure() });
    await checkpoints.capture(file);
    const at = new Date(Date.now() - (4 - index) * 60_000);
    await utimes(path.join(a.home.paths.checkpoints, `${runId}.json`), at, at);
  }
  assert.ok(CHECKPOINT_SYNC_BYTES === 25 * 1024 * 1024);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await jsonFiles(b.home.paths.checkpoints), ['run-301-abcdef.json', 'run-302-abcdef.json', 'run-303-abcdef.json']);
});

test('a checkpoint of a run that is still running is never sent', async () => {
  const { a, b } = await pair();
  await writeMarker(a, 'conv-runhere1', { runId: 'run-400-abcdef' });
  const file = path.join(a.root, 'live.ts');
  await writeFile(file, 'live original');
  await new RunCheckpoints('run-400-abcdef', a.home.paths.checkpoints, { root: a.root }).capture(file);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual(await jsonFiles(b.home.paths.checkpoints), []);
});

function savedRun(id: string): SavedRun {
  return {
    format: RUN_FORMAT, version: 1, id, startedAt: '2026-11-01T10:00:00.000Z', finishedAt: '2026-11-01T10:05:00.000Z', status: 'completed', taskSet: 'short', mode: 'reuse',
    runsPerTask: 1, models: [{ id: 'near/model-a', privacy: 'tee', catalogVersion: 'abc123' }], tasks: [], rows: []
  };
}

test('comparisons, model choices and the pick-up pointer sync, and the newer choice wins on both computers', async () => {
  const { a, b } = await pair();
  await new ComparisonStore(a.home.paths.comparisons).save(savedRun('2026-11-01T10-00-00-000Z'));
  await writeProjectChoice(a.root, 'nearAi.defaultModel', 'near/chosen-on-a', a.writer);
  await writeProjectChoice(a.root, 'nearAi.agent.deepModel', 'near/deep-a', a.writer);
  await writeFile(a.home.paths.pickup, `${JSON.stringify({ writer: a.writer, at: new Date().toISOString(), lastChat: { id: THREAD, title: 'Shared thread' } })}\n`);
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal((await b.sync.pullOnly()).kind, 'synced');
  assert.deepEqual((await new ComparisonStore(b.home.paths.comparisons).list()).map((run) => run.id), ['2026-11-01T10-00-00-000Z']);
  assert.equal(readProjectChoicesSync(b.root)['nearAi.defaultModel']?.value, 'near/chosen-on-a');
  assert.equal(readProjectChoicesSync(b.root)['nearAi.agent.deepModel']?.value, 'near/deep-a');
  assert.equal((JSON.parse(await readFile(b.home.paths.pickup, 'utf8')) as { writer: string }).writer, a.writer);

  await later();
  await writeProjectChoice(b.root, 'nearAi.defaultModel', 'near/chosen-on-b', b.writer);
  assert.equal((await b.sync.sync()).kind, 'synced');
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.equal(readProjectChoicesSync(a.root)['nearAi.defaultModel']?.value, 'near/chosen-on-b', 'the later choice wins');
  assert.equal(readProjectChoicesSync(a.root)['nearAi.agent.deepModel']?.value, 'near/deep-a', 'another setting is untouched');
  assert.equal((await b.sync.sync()).pushed, false);
});

test('spend lines from both computers are united by id and version, and nothing is lost', async () => {
  const { a, b } = await pair();
  const line = (id: string, v: number) => ({ t: 'e', id, v, at: 1_700_000_000_000 + v, writer: 'x', path: '/v1/chat/completions', status: 'completed', estimateNanoUsd: 100 * v });
  const text = (lines: object[]): string => `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`;
  await mkdir(a.home.paths.spend, { recursive: true });
  await mkdir(b.home.paths.spend, { recursive: true });
  await writeFile(path.join(a.home.paths.spend, '2026-11.jsonl'), text([line('e1', 1), line('e2', 1)]));
  await writeFile(path.join(b.home.paths.spend, '2026-11.jsonl'), text([line('e3', 1), line('e1', 2)]));
  for (const machineOf of [a, b, a, b]) assert.equal((await machineOf.sync.sync()).kind, 'synced');
  const keysOf = async (machineOf: Machine): Promise<string[]> => (await readFile(path.join(machineOf.home.paths.spend, '2026-11.jsonl'), 'utf8')).split('\n').filter(Boolean).map((raw) => { const item = JSON.parse(raw) as { id: string; v: number }; return `${item.id}#${item.v}`; }).sort();
  const expected = ['e1#1', 'e1#2', 'e2#1', 'e3#1'];
  assert.deepEqual(await keysOf(a), expected);
  assert.deepEqual(await keysOf(b), expected);
});

test('two computers pushing at the same moment both end with both computers\' threads; the lost race is retried, never forced', async () => {
  const { remote, a, b } = await pair();
  await a.threads.create({ id: 'conv-alphanew01', title: 'From A', model: 'm', origin: 'panel' });
  await a.threads.appendEntries('conv-alphanew01', chain('conv-alphanew01', a.writer, [['user', 'hello from a'], ['assistant', 'hi a']]));
  await b.threads.create({ id: 'conv-bravonew01', title: 'From B', model: 'm', origin: 'panel' });
  await b.threads.appendEntries('conv-bravonew01', chain('conv-bravonew01', b.writer, [['user', 'hello from b'], ['assistant', 'hi b']]));
  // Both reach their push before either goes: the second one is certain to be behind the remote.
  let waiting = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const pushes: Record<string, number> = { alpha: 0, bravo: 0 };
  for (const machineOf of [a, b]) {
    const push = machineOf.transport.push.bind(machineOf.transport);
    machineOf.transport.push = async (commit) => {
      pushes[machineOf.name] = (pushes[machineOf.name] ?? 0) + 1;
      if (pushes[machineOf.name] === 1) { waiting += 1; if (waiting === 2) release(); await gate; }
      return push(commit);
    };
  }
  const before = fixtureGit(remote, ['rev-list', '--count', REF]).trim();
  const [first, second] = await Promise.all([a.sync.sync(), b.sync.sync()]);
  assert.equal(first.kind, 'synced', first.message);
  assert.equal(second.kind, 'synced', second.message);
  assert.equal(Math.max(first.attempts ?? 0, second.attempts ?? 0), 2, 'exactly one push lost the race and was retried');
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.deepEqual(await entryIds(a, 'conv-bravonew01'), await entryIds(b, 'conv-bravonew01'));
  assert.equal((await entryIds(a, 'conv-bravonew01')).length, 2);
  assert.equal((await entryIds(b, 'conv-alphanew01')).length, 2);
  assert.equal(fixtureGit(remote, ['rev-list', '--merges', '--count', REF]).trim(), '0', 'a single linear history');
  assert.equal(Number(fixtureGit(remote, ['rev-list', '--count', REF]).trim()) - Number(before), 2, 'both pushes are in the history; neither overwrote the other');
});

test('an empty remote: a pull changes nothing and says so, and the first sync creates the state branch', async () => {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: THREAD, title: 'Lonely', model: 'm', origin: 'panel' });
  await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, SIX_TURNS));
  const before = treeHash(a.home.dir);
  const pulled = await a.sync.pullOnly();
  assert.equal(pulled.kind, 'nothing-yet');
  assert.match(pulled.message, /nothing/i);
  assert.equal(treeHash(a.home.dir), before, 'the state home is unchanged');
  assert.equal(fixtureGit(remote, ['for-each-ref', REF]).trim(), '');
  assert.equal((await a.sync.sync()).kind, 'synced');
  assert.match(tipOf(remote), /^[0-9a-f]{40}$/);
});

test('sync waits while a run is in flight in this editor, and without a recovery code it sends nothing', async () => {
  const remote = bareRemote({ withMain: false });
  let idle = false;
  const a = await machine(remote, 'alpha', { isIdle: () => idle });
  await a.keys.ensureDataKey();
  await a.threads.create({ id: THREAD, title: 'Busy', model: 'm', origin: 'panel' });
  assert.equal((await a.sync.sync()).kind, 'waiting');
  idle = true;
  const refused = await a.sync.sync();
  assert.equal(refused.kind, 'refused', 'no recovery code on this computer yet');
  assert.equal(fixtureGit(remote, ['for-each-ref', REF]).trim(), '');
});

test('only the allow-listed kinds are ever collected, and what is sent opens to nothing else', async () => {
  const { remote, a } = await pair();
  assert.deepEqual([...SYNCED_KINDS].sort(), ['checkpoint', 'choice', 'comparison', 'marker', 'pickup', 'profile', 'secret', 'spend', 'thread-context', 'thread-meta']);
  // Decoys: things that live beside the state and must never sync.
  const decoys: Array<[string, string]> = [
    ['security-scan-consent.json', '{"accepted":"DECOY_CONSENT"}'], ['emergency-stop.json', '{"stopped":"DECOY_STOP"}'], ['spend-reporting-token.json', '{"tokenId":"DECOY_TOKEN"}'],
    ['profiles-index.json', '{"index":"DECOY_PROFILE_INDEX"}'], ['team.json', '{"team":"DECOY_TEAM"}'], ['cyber-engagement.json', '{"engagement":"DECOY_CYBER"}']
  ];
  for (const [name, content] of decoys) {
    await writeFile(path.join(a.home.dir, name), content);
    await writeFile(path.join(a.root, name), content);
  }
  await mkdir(path.join(a.home.dir, 'team'), { recursive: true });
  await writeFile(path.join(a.home.dir, 'team', 'record.json'), '{"x":"DECOY_TEAM"}');
  await a.threads.appendEntries(THREAD, chain(THREAD, a.writer, [['user', 'one more']], (await a.threads.lines(THREAD)).main.at(-1)?.id ?? null));
  assert.equal((await a.sync.sync()).kind, 'synced');
  const text = JSON.stringify(await remotePayloads(remote, a));
  for (const decoy of ['DECOY_CONSENT', 'DECOY_STOP', 'DECOY_TOKEN', 'DECOY_PROFILE_INDEX', 'DECOY_TEAM', 'DECOY_CYBER']) assert.equal(text.includes(decoy), false, decoy);
  const kinds = new Set<string>();
  for (const payload of await remotePayloads(remote, a)) for (const record of (payload as { records?: Array<{ kind: string }> }).records ?? []) kinds.add(record.kind);
  for (const kind of kinds) assert.ok((SYNCED_KINDS as readonly string[]).includes(kind), kind);
});
