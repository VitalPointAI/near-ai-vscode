import assert from 'node:assert/strict';
import test from 'node:test';
import { StateTransport, STATE_REF } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, repoSnapshot, sealedFiles, userRepo } from './helpers/gitFixtures';
import { openManifest, openObject } from '../domain/state/objects';

async function transportFor(root: string, remote = 'origin'): Promise<StateTransport> {
  const paths = await mirrorPaths();
  return new StateTransport({ root, remote, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
}

test('tracer: one sealed object is pushed to near-ai/state and read back by a second mirror, with the person\'s repository untouched', async () => {
  const remoteDir = bareRemote();
  const person = userRepo(remoteDir);
  const mainBefore = fixtureGit(remoteDir, ['rev-parse', 'refs/heads/main']).trim();
  const before = repoSnapshot(person.dir);
  assert.match(before.status ?? '', /staged\.txt/, 'the fixture has a staged file');
  assert.match(before.status ?? '', / M tracked\.txt/, 'the fixture has a modified tracked file');

  const { files, objectNames, keys } = await sealedFiles([{ class: 'hot', payload: { note: 'hello' } }]);
  assert.equal(objectNames.length, 1);
  const writer = await transportFor(person.dir);
  const first = await writer.fetch();
  assert.deepEqual(first, { ok: true, value: undefined }, 'a remote with no state branch yet reports none');
  const commit = await writer.writeCommit(files);
  const pushed = await writer.push(commit);
  assert.deepEqual(pushed, { ok: true, value: commit });

  assert.deepEqual(repoSnapshot(person.dir), before, 'status, HEAD, branch, refs, index, config and files are identical');
  assert.equal(fixtureGit(person.dir, ['branch', '-a']).includes('near-ai'), false, 'no tracking branch for the state branch appears in the person\'s repository');

  const refs = fixtureGit(remoteDir, ['for-each-ref', '--format=%(refname)']).split('\n').filter((line) => line !== '').sort();
  assert.deepEqual(refs, ['refs/heads/main', STATE_REF].sort());
  assert.equal(fixtureGit(remoteDir, ['rev-parse', 'refs/heads/main']).trim(), mainBefore, 'main in the remote is unchanged');
  assert.equal(fixtureGit(remoteDir, ['rev-parse', STATE_REF]).trim(), commit);

  // A second computer: its own mirror, the same remote.
  const reader = await transportFor(person.dir);
  const fetched = await reader.fetch();
  assert.deepEqual(fetched, { ok: true, value: commit });
  const entries = await reader.readTree(commit);
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ['manifest.json', ...objectNames].sort());
  const byName = new Map(entries.map((entry) => [entry.name, entry.oid]));
  const manifestText = (await reader.readBlob(byName.get('manifest.json') as string)).toString('utf8');
  const manifest = openManifest(manifestText, keys.dataKey, 0);
  assert.equal(manifest.seq, 1);
  const objectBytes = await reader.readBlob(byName.get(objectNames[0] as string) as string);
  assert.ok(objectBytes.equals(files.find((file) => file.name === objectNames[0])?.data as Buffer), 'the object comes back byte for byte');
  const opened = openObject(keys.dataKey, keys.stateId, 'hot', [{ entry: manifest.objects[0]!, data: objectBytes }]);
  assert.deepEqual(opened, { note: 'hello' });
  assert.deepEqual(repoSnapshot(person.dir), before, 'reading back changed nothing either');
});

test('the transport never writes to the person\'s repository even when the process environment points git at it', async () => {
  const remoteDir = bareRemote();
  const person = userRepo(remoteDir);
  const before = repoSnapshot(person.dir);
  const commitsBefore = fixtureGit(person.dir, ['rev-list', '--all', '--count']).trim();
  const objectsBefore = fixtureGit(person.dir, ['count-objects', '-v']);
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const transport = await transportFor(person.dir);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = `${person.dir}/.git`;
  process.env.GIT_WORK_TREE = person.dir;
  process.env.GIT_INDEX_FILE = `${person.dir}/.git/index`;
  try {
    const commit = await transport.writeCommit(files);
    assert.equal((await transport.push(commit)).ok, true);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  assert.deepEqual(repoSnapshot(person.dir), before);
  assert.equal(fixtureGit(person.dir, ['rev-list', '--all', '--count']).trim(), commitsBefore, 'the person\'s repository gained no commit');
  assert.equal(fixtureGit(person.dir, ['count-objects', '-v']), objectsBefore, 'the person\'s repository gained no object');
});

test('a tree with an unexpected entry is refused when read, and a name outside the allow-list is refused when written', async () => {
  const remoteDir = bareRemote();
  const person = userRepo(remoteDir);
  const transport = await transportFor(person.dir);
  await assert.rejects(transport.writeCommit([{ name: '../escape.bin', data: 'x' }]), /format this version cannot read/);
  await assert.rejects(transport.writeCommit([{ name: 'notes.txt', data: 'x' }]), /format this version cannot read/);
  // A hostile remote branch that holds a readable file: fetch lands it in the mirror, readTree refuses it.
  const hostile = fixtureGit(remoteDir, ['hash-object', '-w', '--stdin'], 'plain text').trim();
  const tree = fixtureGit(remoteDir, ['mktree'], `100644 blob ${hostile}\tREADME.txt\n`).trim();
  const commit = fixtureGit(remoteDir, ['commit-tree', tree, '-m', 'x']).trim();
  fixtureGit(remoteDir, ['update-ref', STATE_REF, commit]);
  const fetched = await transport.fetch();
  assert.deepEqual(fetched, { ok: true, value: commit });
  await assert.rejects(transport.readTree(commit), /format this version cannot read/);
  await assert.rejects(transport.readTree('--help'), /format this version cannot read/);
});
