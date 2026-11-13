import assert from 'node:assert/strict';
import test from 'node:test';
import { TREE_NAME } from '../domain/state/objects';
import { formatRecoveryCode } from '../domain/state/recoveryCode';
import { StateTransport, STATE_REF } from '../services/stateTransport';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { generateRecoveryCode } from '../domain/state/recoveryCode';
import { writeProjectChoice } from '../services/modelChoices';
import { SENTINEL_EMAIL, SENTINEL_NAME, bareRemote, fixtureGit, hermeticRunner, mirrorPaths, remoteCommits, scanRemote, sealedFiles, userRepo } from './helpers/gitFixtures';
import { SIX_TURNS, chain, machine, remotePayloads, writeMarker } from './helpers/syncFixtures';

const PROMPT = 'SENTINEL_PROMPT_7f3a';
const API_KEY = 'sk-test-SENTINEL-KEY';
const MODEL = 'SENTINEL_MODEL_zeta-9';

test('the leak scan finds a planted sentinel in a blob, a tree entry name, a commit and a ref name (the scan itself works)', () => {
  const remoteDir = bareRemote({ withMain: false });
  const blob = fixtureGit(remoteDir, ['hash-object', '-w', '--stdin'], `the prompt was ${PROMPT}`).trim();
  const tree = fixtureGit(remoteDir, ['mktree'], `100644 blob ${blob}\t${API_KEY}.txt\n`).trim();
  const commit = fixtureGit(remoteDir, ['commit-tree', tree, '-m', `message ${MODEL}`]).trim();
  fixtureGit(remoteDir, ['update-ref', `refs/heads/${SENTINEL_NAME}`, commit]);
  const scan = scanRemote(remoteDir, [PROMPT, API_KEY, MODEL, SENTINEL_NAME, Buffer.from(PROMPT)]);
  const found = new Set(scan.hits.map((hit) => `${hit.kind}:${hit.sentinel}`));
  assert.ok(found.has(`blob:${PROMPT}`));
  assert.ok(found.has(`tree:${API_KEY}`), 'a tree entry name is searched');
  assert.ok(found.has(`commit:${MODEL}`));
  assert.ok(found.has(`ref:${SENTINEL_NAME}`));
  assert.ok(found.has(`blob:bytes:${Buffer.from(PROMPT).toString('hex')}`), 'a byte sentinel is searched');
});

test('after real pushes the remote holds only ciphertext: no sentinel in any blob, tree entry name, commit, message or ref name', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const paths = await mirrorPaths();
  const transport = new StateTransport({ root: person.dir, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
  const plain = await sealedFiles([{ class: 'hot', payload: [] }]);
  const keys = plain.keys;
  const recovery = keys.code;
  const sentinels: Array<string | Buffer> = [
    PROMPT, API_KEY, keys.dataKey.toString('base64'), keys.dataKey.toString('hex'), keys.dataKey, recovery, recovery.replaceAll('-', ''),
    formatRecoveryCode(keys.codeBytes).toLowerCase(), keys.codeBytes, 'conv-', 'run-', MODEL, SENTINEL_NAME, SENTINEL_EMAIL
  ];
  // The payload really held every string sentinel, so the scan below proves they were sealed rather than never present.
  const payload = {
    prompt: `please remember ${PROMPT}`, apiKey: API_KEY, dataKey: [keys.dataKey.toString('base64'), keys.dataKey.toString('hex')], recovery: [recovery, recovery.replaceAll('-', '')],
    ids: ['conv-1234', 'run-5678'], model: MODEL, person: { name: SENTINEL_NAME, email: SENTINEL_EMAIL }
  };
  const text = JSON.stringify(payload);
  for (const sentinel of [PROMPT, API_KEY, keys.dataKey.toString('base64'), keys.dataKey.toString('hex'), recovery, recovery.replaceAll('-', ''), 'conv-', 'run-', MODEL, SENTINEL_NAME, SENTINEL_EMAIL]) {
    assert.ok(text.includes(sentinel), `${sentinel} is in the plaintext`);
  }
  const first = await sealedFiles([{ class: 'hot', payload }, { class: 'cold', payload: { ...payload, again: true } }], 1);
  const second = await sealedFiles([{ class: 'hot', payload: { ...payload, second: true } }], 2);
  const c1 = await transport.writeCommit(first.files);
  assert.equal((await transport.push(c1)).ok, true);
  const c2 = await transport.writeCommit(second.files, c1);
  assert.equal((await transport.push(c2)).ok, true);

  const scan = scanRemote(remoteDir, sentinels);
  assert.deepEqual(scan.hits, [], 'no sentinel anywhere in the remote');
  assert.ok(scan.objects >= 6 && scan.commits === 2, 'the scan really walked the objects');
  assert.ok(scan.treeNames.length >= 4);
  for (const name of scan.treeNames) assert.match(name, TREE_NAME);
  assert.deepEqual(scan.refs, [STATE_REF]);
  for (const commit of remoteCommits(remoteDir)) {
    assert.equal(`${commit.an}${commit.ae}${commit.cn}${commit.ce}`, 'near-ai-statestate@near-ai.invalidnear-ai-statestate@near-ai.invalid');
    assert.equal(commit.message, 'Update encrypted project state');
  }
});

test('a real sync of a state home seeded with threads, choices, markers, spend and checkpoints leaves no readable trace in the remote', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const a = await machine(remoteDir, 'alpha');
  const { code, bytes } = generateRecoveryCode();
  const TITLE = 'SENTINEL_TITLE_c41d';
  const PROMPT_TEXT = 'SENTINEL_PROMPT_SYNC_88ab';
  const TOOL_OUTPUT = 'SENTINEL_TOOLOUT_5e90';
  const CHOICE_MODEL = 'SENTINEL_MODEL_choice-77';
  const SPEND_MODEL = 'SENTINEL_SPENDMODEL_31f2';
  const CHECKPOINT_TEXT = 'SENTINEL_CHECKPOINT_a9d4';
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: 'conv-leakcheck1', title: TITLE, model: CHOICE_MODEL, origin: 'panel' });
  await a.threads.appendEntries('conv-leakcheck1', chain('conv-leakcheck1', a.writer, [...SIX_TURNS, ['user', PROMPT_TEXT], ['tool-call', TOOL_OUTPUT]]));
  await writeProjectChoice(a.root, 'nearAi.defaultModel', CHOICE_MODEL, a.writer);
  await writeMarker(a, 'conv-leakcheck1', { runId: 'run-500-abcdef', endedAt: new Date().toISOString(), outcome: 'completed' });
  await mkdir(a.home.paths.spend, { recursive: true });
  await writeFile(path.join(a.home.paths.spend, '2026-11.jsonl'), `${JSON.stringify({ t: 'e', id: 'ent-leak-1', v: 1, at: 1_700_000_000_000, model: SPEND_MODEL, estimateNanoUsd: 5 })}\n`);
  await writeFile(path.join(a.root, 'tracked-file.ts'), CHECKPOINT_TEXT);
  await new RunCheckpoints('run-500-abcdef', a.home.paths.checkpoints, { root: a.root, beforeWrite: () => a.home.ensure() }).capture(path.join(a.root, 'tracked-file.ts'));
  const outcome = await a.sync.sync();
  assert.equal(outcome.kind, 'synced', outcome.message);
  const dataKey = await a.keys.dataKey();
  assert.ok(dataKey);
  const sentinels: Array<string | Buffer> = [
    TITLE, PROMPT_TEXT, TOOL_OUTPUT, CHOICE_MODEL, SPEND_MODEL, CHECKPOINT_TEXT, Buffer.from(CHECKPOINT_TEXT).toString('base64'), 'conv-', 'run-', 'leakcheck', 'ent-leak',
    'near-ai-state-sync', 'nearAi.defaultModel', SENTINEL_NAME, SENTINEL_EMAIL, code, code.replaceAll('-', ''), dataKey.toString('base64'), dataKey.toString('hex'), dataKey, bytes
  ];
  // Positive control: every seeded value really was inside what was sent, so the scan below proves it was sealed rather than never present.
  const sealed = JSON.stringify(await remotePayloads(remoteDir, a));
  for (const seeded of [TITLE, PROMPT_TEXT, TOOL_OUTPUT, CHOICE_MODEL, SPEND_MODEL, Buffer.from(CHECKPOINT_TEXT).toString('base64'), 'conv-leakcheck1', 'run-500-abcdef']) {
    assert.ok(sealed.includes(seeded), `${seeded} was part of what was sent`);
  }
  const scan = fixtureGit(remoteDir, ['for-each-ref', '--format=%(refname)']).trim();
  assert.equal(scan, 'refs/heads/near-ai/state');
  const found = scanRemote(remoteDir, sentinels);
  assert.deepEqual(found.hits, [], 'no title, id, model name, prompt, key or person identity anywhere in the remote');
  assert.ok(found.objects >= 5, 'the scan walked real objects');
  for (const name of found.treeNames) assert.match(name, TREE_NAME);
  assert.deepEqual(found.refs, [STATE_REF]);
});

test('the remote history of a real sync carries only the anonymous identity and the constant message', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const a = await machine(remoteDir, 'alpha');
  const { bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: 'conv-leakcheck2', title: 'Anything', model: 'm', origin: 'panel' });
  const first = chain('conv-leakcheck2', a.writer, SIX_TURNS);
  await a.threads.appendEntries('conv-leakcheck2', first);
  assert.equal((await a.sync.sync()).pushed, true);
  await a.threads.appendEntries('conv-leakcheck2', chain('conv-leakcheck2', a.writer, [['user', 'again']], first[first.length - 1]?.id ?? null));
  assert.equal((await a.sync.sync()).pushed, true);
  const commits = remoteCommits(remoteDir);
  assert.equal(commits.length, 2);
  for (const commit of commits) {
    assert.equal(`${commit.an}${commit.ae}${commit.cn}${commit.ce}`, 'near-ai-statestate@near-ai.invalidnear-ai-statestate@near-ai.invalid');
    assert.equal(commit.message, 'Update encrypted project state');
  }
});
