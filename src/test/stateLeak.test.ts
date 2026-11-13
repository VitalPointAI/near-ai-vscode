import assert from 'node:assert/strict';
import test from 'node:test';
import { TREE_NAME } from '../domain/state/objects';
import { formatRecoveryCode } from '../domain/state/recoveryCode';
import { StateTransport, STATE_REF } from '../services/stateTransport';
import { SENTINEL_EMAIL, SENTINEL_NAME, bareRemote, fixtureGit, hermeticRunner, mirrorPaths, remoteCommits, scanRemote, sealedFiles, userRepo } from './helpers/gitFixtures';

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
