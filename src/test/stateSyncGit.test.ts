import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GitNotFoundError } from '../services/stateGit';
import type { GitResult, GitRunner } from '../services/stateGit';
import { MIRROR_LOCK_FILE, withMirrorLock } from '../services/stateMirrorLock';
import { StateTransport, STATE_REF, classifyGitFailure } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, repoSnapshot, sealedFiles, tempDirectory, userRepo } from './helpers/gitFixtures';
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

// ---- failures, the lock, and interruption (Task 3) ----

function fakeRunner(result: Partial<GitResult> | Error, only?: string): GitRunner {
  const real = hermeticRunner();
  return (args, options) => {
    if (only !== undefined && !args.includes(only)) return real(args, options);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve({ code: 128, stdout: Buffer.alloc(0), stderr: '', ...result });
  };
}

test('a push from a commit that is not a descendant of the remote tip is rejected, never forced', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const a = await transportFor(person.dir);
  const b = await transportFor(person.dir);
  const one = await sealedFiles([{ class: 'hot', payload: { by: 'a' } }], 1);
  const two = await sealedFiles([{ class: 'hot', payload: { by: 'b' } }], 1);
  const first = await a.writeCommit(one.files);
  assert.equal((await a.push(first)).ok, true);
  const rival = await b.writeCommit(two.files);
  const result = await b.push(rival);
  assert.ok(!result.ok && result.failure.kind === 'rejected');
  assert.match(result.failure.message, /Another computer saved changes first/);
  assert.equal(fixtureGit(remoteDir, ['rev-parse', STATE_REF]).trim(), first, 'the remote keeps the first tip');
  // The caller fetches, builds on the tip and tries again.
  const fetched = await b.fetch();
  assert.deepEqual(fetched, { ok: true, value: first });
  const merged = await b.writeCommit(two.files, first);
  assert.equal((await b.push(merged)).ok, true);
  assert.equal(fixtureGit(remoteDir, ['rev-parse', STATE_REF]).trim(), merged);
});

test('a missing remote location is reported as offline in one plain sentence', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  fixtureGit(person.dir, ['remote', 'set-url', 'origin', '/nonexistent/near-ai/missing.git']);
  const t = await transportFor(person.dir);
  const fetched = await t.fetch();
  assert.ok(!fetched.ok && fetched.failure.kind === 'offline');
  assert.equal(fetched.failure.message, 'Could not reach your git host. Your work here is safe; sync will try again.');
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const pushed = await t.push(await t.writeCommit(files));
  assert.ok(!pushed.ok && pushed.failure.kind === 'offline');
});

test('git output is sorted into sign-in, host-policy, rejected and offline, with the sign-in hint and no URL userinfo', () => {
  const secret = 'https://person:SuperSecretToken123@git.example.com/me/repo.git';
  const cases: Array<[string, string]> = [
    [`fatal: Authentication failed for '${secret}/'`, 'auth'],
    ['fatal: could not read Username for \'https://git.example.com\': terminal prompts disabled', 'auth'],
    ['remote: error: GH013: Repository rule violations found for refs/heads/near-ai/state.', 'policy'],
    [' ! [remote rejected] x -> near-ai/state (protected branch hook declined)', 'policy'],
    [' ! [rejected] x -> near-ai/state (non-fast-forward)', 'rejected'],
    ['hint: Updates were rejected because the tip of your current branch is behind', 'rejected'],
    [`fatal: unable to access '${secret}/': Could not resolve host: git.example.com`, 'offline'],
    ['', 'offline']
  ];
  for (const [stderr, kind] of cases) {
    const failure = classifyGitFailure({ code: 128, stdout: Buffer.alloc(0), stderr });
    assert.equal(failure.kind, kind, stderr);
    assert.equal(/SuperSecretToken123|person:/.test(`${failure.message} ${failure.detail ?? ''}`), false, 'no userinfo in what is shown or logged');
    assert.equal(failure.message.includes('\n'), false);
  }
  assert.match(classifyGitFailure({ code: 128, stdout: Buffer.alloc(0), stderr: 'Authentication failed' }).message, /Run git fetch once in a terminal in this project/);
  assert.equal(classifyGitFailure({ code: 128, stdout: Buffer.alloc(0), stderr: 'GH013' }).message, 'Your git host did not accept the sync branch.');
});

test('failures from the runner are mapped end to end: sign-in, host policy and a missing git program', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const paths = await mirrorPaths();
  const make = (git: GitRunner): StateTransport => new StateTransport({ root: person.dir, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git });
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const commit = await make(hermeticRunner()).writeCommit(files);

  const auth = await make(fakeRunner({ stderr: 'fatal: could not read Username for \'https://x\': terminal prompts disabled' }, 'push')).push(commit);
  assert.ok(!auth.ok && auth.failure.kind === 'auth' && /sign-in/.test(auth.failure.message));
  const policy = await make(fakeRunner({ stderr: 'remote: error: GH013: Repository rule violations found' }, 'push')).push(commit);
  assert.ok(!policy.ok && policy.failure.kind === 'policy');
  const missing = await make(fakeRunner(new GitNotFoundError())).push(commit);
  assert.ok(!missing.ok && missing.failure.kind === 'git-missing');
  assert.equal(missing.failure.message, 'Git is not installed, so sync is off. Everything still works on this computer.');
  const missingFetch = await make(fakeRunner(new GitNotFoundError())).fetch();
  assert.ok(!missingFetch.ok && missingFetch.failure.kind === 'git-missing');
  // The lock was released on every path: a normal call still goes straight through.
  assert.equal((await make(hermeticRunner()).push(commit)).ok, true);
});

test('two transports on one mirror never overlap inside the lock', async () => {
  const paths = await mirrorPaths();
  const inside: string[] = [];
  let active = 0;
  let overlapped = false;
  const section = (name: string) => withMirrorLock(paths.mirrorDir, async () => {
    active += 1;
    if (active > 1) overlapped = true;
    inside.push(`enter ${name}`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    inside.push(`exit ${name}`);
    active -= 1;
  });
  await Promise.all([section('a'), section('b'), section('c'), section('a2')]);
  assert.equal(overlapped, false);
  assert.equal(inside.length, 8);
  for (let index = 0; index < inside.length; index += 2) assert.equal(inside[index]?.replace('enter ', ''), inside[index + 1]?.replace('exit ', ''));
});

test('two processes on one mirror are serialised by the file lock, and a lock left by a dead process is taken over', async () => {
  const paths = await mirrorPaths();
  const dir = await tempDirectory('near-ai-lock-');
  const log = path.join(dir, 'log.txt');
  const script = path.join(dir, 'worker.js');
  const lockModule = path.join(__dirname, '..', 'services', 'stateMirrorLock.js');
  writeFileSync(script, `const fs = require('node:fs');
const { withMirrorLock } = require(${JSON.stringify(lockModule)});
(async () => {
  for (let i = 0; i < 3; i += 1) {
    await withMirrorLock(${JSON.stringify(paths.mirrorDir)}, async () => {
      fs.appendFileSync(${JSON.stringify(log)}, 'enter ' + process.pid + '\\n');
      await new Promise((resolve) => setTimeout(resolve, 30));
      fs.appendFileSync(${JSON.stringify(log)}, 'exit ' + process.pid + '\\n');
    });
  }
})().catch((error) => { console.error(error); process.exit(1); });
`);
  const run = (): Promise<number | null> => new Promise((resolve) => { execFile(process.execPath, [script]).on('exit', resolve); });
  const codes = await Promise.all([run(), run()]);
  assert.deepEqual(codes, [0, 0]);
  const lines = readFileSync(log, 'utf8').split('\n').filter((line) => line !== '');
  assert.equal(lines.length, 12);
  for (let index = 0; index < lines.length; index += 2) {
    const [enter, pid] = (lines[index] ?? '').split(' ');
    assert.equal(enter, 'enter');
    assert.equal(lines[index + 1], `exit ${pid}`, 'the other process never entered in between');
  }
  assert.equal(existsSync(path.join(paths.mirrorDir, MIRROR_LOCK_FILE)), false, 'the lock file is removed when work ends');

  // A holder that has ended (same computer, process gone) is replaced at once instead of waited for.
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(paths.mirrorDir, MIRROR_LOCK_FILE), `${JSON.stringify({ pid: Number(dead), host: hostname(), token: 'ab'.repeat(8) })}\n`);
  const started = Date.now();
  await withMirrorLock(paths.mirrorDir, () => Promise.resolve(), { waitMs: 2_000 });
  assert.ok(Date.now() - started < 1_500);
});

test('a push stopped part way leaves the remote at its old tip or the new one, never a partial tree, and the state home is not touched', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const home = await tempDirectory('near-ai-home-');
  mkdirSync(path.join(home, 'threads'));
  writeFileSync(path.join(home, 'meta.json'), '{"format":1}\n');
  writeFileSync(path.join(home, 'threads', 'one.jsonl'), 'line\n');
  const homeBefore = readdirSync(home, { recursive: true }).map(String).sort().join(',');
  const homeText = readFileSync(path.join(home, 'meta.json'), 'utf8');
  const mirrorDir = path.join(home, 'sync', 'mirror.git');
  const hooksDir = path.join(home, 'sync', 'hooks');
  const real = hermeticRunner();
  const base = new StateTransport({ root: person.dir, mirrorDir, hooksDir, git: real });
  const one = await sealedFiles([{ class: 'hot', payload: { v: 1 } }, { class: 'cold', payload: { c: 'x'.repeat(400_000) } }], 1);
  const first = await base.writeCommit(one.files);
  assert.equal((await base.push(first)).ok, true);
  const two = await sealedFiles([{ class: 'hot', payload: { v: 2 } }, { class: 'cold', payload: { c: 'y'.repeat(900_000) } }], 2);
  const second = await base.writeCommit(two.files, first);
  const complete = (commit: string): boolean => {
    const names = fixtureGit(remoteDir, ['ls-tree', '--name-only', commit]).split('\n').filter((line) => line !== '');
    return names.length === (commit === first ? one.files.length : two.files.length);
  };
  let stopped = 0;
  for (const timeoutMs of [1, 2, 4, 8, 16, 32, 64]) {
    const impatient: GitRunner = (args, options) => real(args, args.includes('push') ? { ...options, timeoutMs } : options);
    const result = await new StateTransport({ root: person.dir, mirrorDir, hooksDir, git: impatient }).push(second);
    if (!result.ok) {
      stopped += 1;
      assert.equal(result.failure.kind, 'offline', 'a stopped push is reported as a failure to reach the host');
    }
    const tip = fixtureGit(remoteDir, ['rev-parse', STATE_REF]).trim();
    assert.ok(tip === first || tip === second, `tip is the old or the new commit at ${timeoutMs} ms`);
    assert.ok(complete(tip), 'the tree at the tip is whole');
    fixtureGit(remoteDir, ['fsck', '--strict']);
    if (tip === second) break;
  }
  assert.ok(stopped >= 1, 'at least one push was really stopped by its timeout');
  assert.ok(readdirSync(home, { recursive: true }).map(String).filter((name) => !name.startsWith('sync')).sort().join(',') === homeBefore.split(',').filter((name) => !name.startsWith('sync')).join(','), 'nothing outside sync/ changed in the state home');
  assert.equal(readFileSync(path.join(home, 'meta.json'), 'utf8'), homeText);
});
