import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { GitIdentityMissingError, STATE_COMMIT_MESSAGE, STATE_IDENTITY_ENV, SAFE_GIT_CONFIG, runStateGit } from '../services/stateGit';
import type { GitRunner } from '../services/stateGit';
import { StateTransport } from '../services/stateTransport';
import { SENTINEL_EMAIL, SENTINEL_NAME, bareRemote, fixtureGit, hermeticRunner, mirrorPaths, remoteCommits, sealedFiles, tempDirectory, userRepo } from './helpers/gitFixtures';

const OTHER_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'ENV_AUTHOR_NAME_55aa', GIT_AUTHOR_EMAIL: 'env-author55aa@example.com',
  GIT_COMMITTER_NAME: 'ENV_COMMITTER_NAME_55aa', GIT_COMMITTER_EMAIL: 'env-committer55aa@example.com'
};

async function withProcessEnv<T>(values: Record<string, string>, work: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}

test('every sync commit carries the anonymous identity, the constant date and message, whatever the person\'s config and environment say', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const paths = await mirrorPaths();
  const transport = new StateTransport({ root: person.dir, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
  const one = await sealedFiles([{ class: 'hot', payload: { n: 1 } }], 1);
  const two = await sealedFiles([{ class: 'hot', payload: { n: 2 } }], 2);
  await withProcessEnv(OTHER_ENV, async () => {
    const first = await transport.writeCommit(one.files);
    assert.equal((await transport.push(first)).ok, true);
    const second = await transport.writeCommit(two.files, first);
    assert.equal((await transport.push(second)).ok, true);
  });
  const commits = remoteCommits(remoteDir);
  assert.equal(commits.length, 2);
  for (const commit of commits) {
    assert.equal(commit.an, 'near-ai-state');
    assert.equal(commit.ae, 'state@near-ai.invalid');
    assert.equal(commit.cn, 'near-ai-state');
    assert.equal(commit.ce, 'state@near-ai.invalid');
    assert.equal(commit.at, '946684800');
    assert.equal(commit.ct, '946684800');
    assert.equal(commit.message, STATE_COMMIT_MESSAGE);
    assert.equal(commit.signature, 'N');
    const raw = fixtureGit(remoteDir, ['cat-file', 'commit', commit.hash]);
    assert.equal(raw.includes('gpgsig'), false);
    for (const leaked of [SENTINEL_NAME, SENTINEL_EMAIL, ...Object.values(OTHER_ENV)]) assert.equal(raw.includes(leaked), false, `${leaked} must not be in a sync commit`);
  }
  assert.equal(fixtureGit(person.dir, ['config', 'user.name']).trim(), SENTINEL_NAME, 'the person\'s git config is unchanged');
  assert.equal(fixtureGit(person.dir, ['config', 'user.email']).trim(), SENTINEL_EMAIL);
  assert.throws(() => fixtureGit(paths.mirrorDir, ['config', '--get', 'user.name']), 'the mirror holds no identity either');
});

test('signing and hooks set in the person\'s git configuration do not make the push fail, and nothing is signed', async () => {
  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const paths = await mirrorPaths();
  const globalHooks = await tempDirectory('near-ai-global-hooks-');
  const hook = path.join(globalHooks, 'pre-push');
  writeFileSync(hook, '#!/bin/sh\necho "GLOBAL HOOK RAN" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const configDir = await tempDirectory('near-ai-global-config-');
  const config = path.join(configDir, 'gitconfig');
  writeFileSync(config, [
    '[commit]', '\tgpgsign = true', '[push]', '\tgpgSign = true', '[gpg]', '\tprogram = /nonexistent/gpg-would-fail', '[user]', '\tsigningkey = DEADBEEF',
    '[core]', `\thooksPath = ${globalHooks}`, `\tfsmonitor = ${path.join(configDir, 'fsmonitor-would-run')}`, ''
  ].join('\n'));
  const transport = new StateTransport({ root: person.dir, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner({}, config) });
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  const commit = await transport.writeCommit(files);
  const pushed = await transport.push(commit);
  assert.deepEqual(pushed, { ok: true, value: commit });
  const [stored] = remoteCommits(remoteDir);
  assert.equal(stored?.signature, 'N');
  assert.equal(fixtureGit(remoteDir, ['cat-file', 'commit', commit]).includes('gpgsig'), false);
});

test('commit-tree is refused before git starts unless the whole anonymous identity is supplied, and the transport always supplies it', async () => {
  await assert.rejects(runStateGit(['commit-tree', 'deadbeef']), GitIdentityMissingError);
  await assert.rejects(runStateGit(['--git-dir', '/nonexistent', 'commit-tree', 'deadbeef'], { env: {} }), GitIdentityMissingError);
  const partial = { ...STATE_IDENTITY_ENV };
  delete partial.GIT_COMMITTER_DATE;
  await assert.rejects(runStateGit(['commit-tree', 'deadbeef'], { env: partial }), GitIdentityMissingError);
  await assert.rejects(runStateGit(['commit-tree', 'deadbeef'], { env: { ...STATE_IDENTITY_ENV, GIT_AUTHOR_NAME: 'someone else' } }), GitIdentityMissingError);

  const remoteDir = bareRemote({ withMain: false });
  const person = userRepo(remoteDir);
  const paths = await mirrorPaths();
  const calls: Array<{ args: string[]; env: Record<string, string> | undefined }> = [];
  const spy: GitRunner = (args, options) => {
    calls.push({ args, env: options?.env });
    return hermeticRunner()(args, options);
  };
  const transport = new StateTransport({ root: person.dir, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: spy });
  const { files } = await sealedFiles([{ class: 'hot', payload: { n: 1 } }]);
  await transport.writeCommit(files);
  const commitCalls = calls.filter((call) => call.args.includes('commit-tree'));
  assert.equal(commitCalls.length, 1);
  for (const [name, value] of Object.entries(STATE_IDENTITY_ENV)) assert.equal(commitCalls[0]?.env?.[name], value, name);
  assert.ok(commitCalls[0]?.args.includes(STATE_COMMIT_MESSAGE));
  assert.ok(calls.every((call) => !call.args.includes('--force') && !call.args.includes('-f')), 'no call carries a force option');
});

test('every git call carries the safety configuration and none inherits the person\'s git environment', async () => {
  const shimDir = await tempDirectory('near-ai-git-shim-');
  const log = path.join(shimDir, 'calls.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const shim = path.join(shimDir, 'git');
  writeFileSync(shim, `#!/bin/sh\n{ echo "ARGS $*"; env | grep -E '^(GIT_|GCM_|LC_ALL)' | sort | sed 's/^/ENV /'; echo END; } >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(shim, 0o755);
  const hooksDir = path.join(shimDir, 'hooks');
  mkdirSync(hooksDir);
  const dirty: Record<string, string> = {
    GIT_DIR: '/nonexistent/git-dir', GIT_WORK_TREE: '/nonexistent/tree', GIT_INDEX_FILE: '/nonexistent/index', GIT_OBJECT_DIRECTORY: '/nonexistent/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/nonexistent/alt', GIT_NAMESPACE: 'ns', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'leak',
    GIT_CONFIG_PARAMETERS: "'user.name=leak'", ...OTHER_ENV, GIT_COMMITTER_DATE: '2024-01-01T00:00:00Z'
  };
  await withProcessEnv({ ...dirty, PATH: `${shimDir}:${process.env.PATH ?? ''}` }, async () => {
    const result = await runStateGit(['--version'], { hooksDir, env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(result.code, 0);
  });
  const text = readFileSync(log, 'utf8');
  assert.match(text, /^ARGS /m);
  for (const pair of [`core.hooksPath=${hooksDir}`, 'commit.gpgsign=false', 'push.gpgSign=false', 'protocol.ext.allow=never', 'core.fsmonitor=false']) {
    assert.ok(text.includes(`-c ${pair}`), `${pair} is passed on the command line`);
  }
  assert.deepEqual(SAFE_GIT_CONFIG('x').filter((item) => item === '-c').length, 5);
  for (const name of Object.keys(dirty)) assert.equal(new RegExp(`^ENV ${name}=`, 'm').test(text), false, `${name} is not inherited`);
  assert.match(text, /^ENV GIT_TERMINAL_PROMPT=0$/m);
  assert.match(text, /^ENV LC_ALL=C$/m);
  assert.match(text, /^ENV GIT_CONFIG_GLOBAL=\/dev\/null$/m, 'a variable the caller sets on purpose is kept');
});
