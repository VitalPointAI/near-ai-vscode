// 0.4.26 (PR #62 review): on a git older than 2.31 the remote address reaches git as a command-line argument, which other users of the computer can
// read. An address that can carry a credential is refused there, with a plain message that never repeats it; any other address still works as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLsRemote, cleanPush } from '../team/cleanRemote';
import * as path from 'node:path';
import { DEFAULT_COORDINATION_REF, GitTransport } from '../team/gitTransport';
import { createTeamFixture, gitIn, recordingMaterializer } from './helpers/teamHarness';
import { OLD_GIT_CREDENTIALS_TEXT, addressCarriesCredentials, gitReadsEnvironmentConfig } from '../team/gitTransport';
import { runGit } from '../team/runGit';
import type { GitRunner } from '../team/runGit';

// The real git for the temporary folder, with `git --version` answering as the given version, and every call recorded.
function gitAt(version: string, calls: string[][]): GitRunner {
  return async (args, options) => {
    calls.push(args);
    if (args[0] === '--version') return { code: 0, stdout: Buffer.from(`git version ${version}\n`), stderr: '' };
    if (args.includes('ls-remote') || args.includes('push')) return { code: 1, stdout: Buffer.alloc(0), stderr: 'fake network failure' };
    return runGit(args, options);
  };
}

test('which addresses can carry a credential', () => {
  for (const address of ['https://user:secret@example.com/team.git', 'https://ghp_token@example.com/team.git', 'http://name@example.com/t.git', 'ssh://user:pw@example.com/t.git', 'ftps://u@example.com/t.git']) {
    assert.equal(addressCarriesCredentials(address), true, address);
  }
  for (const address of ['https://example.com/team.git', 'ssh://git@example.com/team.git', 'git@example.com:owner/team.git', '/srv/team.git', 'file:///srv/team.git', 'git://example.com/t.git', 'https://example.com/a@b']) {
    assert.equal(addressCarriesCredentials(address), false, address);
  }
  assert.equal(gitReadsEnvironmentConfig('git version 2.30.9'), false);
  assert.equal(gitReadsEnvironmentConfig('git version 2.31.0'), true);
  assert.equal(gitReadsEnvironmentConfig('git version 3.0.0'), true);
  assert.equal(gitReadsEnvironmentConfig('not git'), false);
});

test('on git older than 2.31 a credentialed address is refused before any network call, and never reaches the command line', async () => {
  const secretUrl = 'https://person:hunter2-secret@example.invalid/team.git';
  const calls: string[][] = [];
  const probe = await cleanLsRemote(gitAt('2.30.2', calls), { fetchUrl: secretUrl, pushUrls: [secretUrl] }, 'refs/heads/near-ai/coordination');
  assert.equal(probe.code, 128, 'a fatal failure, never ls-remote\'s "not found" (2)');
  assert.equal(probe.stderr, OLD_GIT_CREDENTIALS_TEXT);
  assert.equal(probe.stderr.includes('hunter2'), false, 'the refusal does not repeat the address');
  const pushed = await cleanPush(gitAt('2.30.2', calls), { fetchUrl: secretUrl, pushUrls: [secretUrl] }, '/nonexistent/objects', '0'.repeat(40), 'main');
  assert.equal(pushed.code, 128);
  assert.equal(pushed.stderr, OLD_GIT_CREDENTIALS_TEXT);
  assert.deepEqual(calls.filter((args) => args.some((arg) => arg.includes('hunter2'))), [], 'no git command was given the address');
  assert.deepEqual(calls.filter((args) => args.includes('ls-remote') || args.includes('push')), [], 'no network command ran');
});

test('on git older than 2.31 an address without a credential still goes to git as before; on 2.31 the credentialed one goes in the environment', async () => {
  const calls: string[][] = [];
  const plain = 'ssh://git@example.invalid/team.git';
  const old = await cleanLsRemote(gitAt('2.30.2', calls), { fetchUrl: plain, pushUrls: [plain] }, 'refs/heads/x');
  assert.equal(old.stderr, 'fake network failure', 'the call was made');
  assert.ok(calls.some((args) => args.includes('ls-remote') && args.includes(plain)), 'as an argument, as before');

  const newer: string[][] = [];
  const secretUrl = 'https://person:hunter2-secret@example.invalid/team.git';
  const current = await cleanLsRemote(gitAt('2.31.0', newer), { fetchUrl: secretUrl, pushUrls: [secretUrl] }, 'refs/heads/x');
  assert.equal(current.stderr, 'fake network failure', 'git 2.31 and later is not refused');
  assert.deepEqual(newer.filter((args) => args.some((arg) => arg.includes('hunter2'))), [], 'the address stays out of the arguments');
});

test('the coordination transport refuses a credentialed address on git older than 2.31 the same way, before any network call', async () => {
  const fixture = await createTeamFixture({ clones: ['a'], initialised: true });
  try {
    const root = fixture.clones['a'] as string;
    gitIn(root, ['remote', 'set-url', 'origin', 'https://person:hunter2-secret@example.invalid/team.git']);
    const calls: string[][] = [];
    const transport = new GitTransport({ mirrorDir: path.join(fixture.storageDir('a'), 'coordination.git'), projectRoot: root, remote: 'origin', ref: DEFAULT_COORDINATION_REF, materializer: recordingMaterializer(), sleep: async () => undefined, git: gitAt('2.30.2', calls) });
    const result = await transport.append(() => [], { genesis: { teamFileText: '{}' } });
    assert.deepEqual(result.ok ? 'ok' : [result.kind, result.reason], ['refused', OLD_GIT_CREDENTIALS_TEXT]);
    assert.deepEqual(calls.filter((args) => args.includes('ls-remote') || args.includes('push') || args.includes('fetch')), [], 'no network command ran');
  } finally {
    await fixture.cleanup();
  }
});
