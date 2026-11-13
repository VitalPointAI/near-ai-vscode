// "Give this project an online home" (D-14): every test uses fakes (sign-in, the GitHub API, gh) and local bare repositories reached through a
// url.<path>.insteadOf rule, so nothing contacts GitHub, creates a real repository, runs the real gh or uses a real token.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VISIBILITY_NOTES } from '../domain/state/onlineHome';
import { GitHubApiError, getRepo, isSafeBranchName, setDefaultBranch } from '../services/githubApi';
import type { FetchLike } from '../services/githubApi';
import { moveDefaultBranch, onlineHomeFlow, readProgress, remoteDefaultBranch, systemGhCli } from '../services/onlineHome';
import type { GhExec } from '../services/onlineHome';
import { stateHomeFor } from '../services/stateHome';
import type { GitRunner } from '../services/stateGit';
import { STATE_REF, StateTransport } from '../services/stateTransport';
import { bareRemote, fixtureGit, mirrorPaths } from './helpers/gitFixtures';
import {
  DEFAULT_STATE_BRANCH, FAKE_TOKEN, FakeCodeOffer, FakeUi, allFiles, assertNoDangerousPush, assertOnlyOurRefs, codeRun, currentBranch, fakeAuth, fakeGh, fakeGitHub,
  initWithMapping, patches, projectFolder, spyGit
} from './helpers/onlineHomeFakes';
import type { CodeRun } from './helpers/onlineHomeFakes';

const NOT_AVAILABLE = 'GitHub sign-in is not available in this editor.';
const NAME_TAKEN = 'A repository with that name already exists on your account. Choose another name.';
const NOT_ALLOWED = 'GitHub did not allow creating the repository. Sign in again and allow repository access.';
const OFFLINE = 'Could not reach GitHub. Check your internet connection and try again; your progress is saved.';
const NOT_EMPTY = 'That repository is not empty. Paste the address of a new, empty repository.';
const BAD_ADDRESS = 'That address cannot be used. Paste the address of a repository, for example https://github.com/you/project.git.';
const HAS_SECRET = 'Paste the address without a password or token in it.';
const BAD_NAME = 'That name cannot be used. Use letters, numbers, dots, dashes and underscores.';

test('tracer: a folder with no repository gets a private GitHub home and the sync branch, all on the person\'s clicks', async () => {
  const dir = await projectFolder();
  const bare = bareRemote({ withMain: false });
  const github = fakeGitHub();
  const ui = new FakeUi({ visibility: 'private' });
  const spy = spyGit();
  const paths = await mirrorPaths();
  let afterRemoteRuns = 0;
  const result = await onlineHomeFlow({
    root: dir,
    ui,
    auth: fakeAuth(),
    fetchFn: github.fetchFn,
    git: spy.git,
    afterRemote: async (remote) => {
      afterRemoteRuns += 1;
      // The test stands in for the network: the GitHub address is mapped to a local bare repository.
      fixtureGit(dir, ['config', `url.${bare}.insteadOf`, remote.url]);
      const transport = new StateTransport({ root: dir, remote: remote.name, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: remote.git });
      const commit = await transport.writeCommit([{ name: 'manifest.json', data: '{}' }]);
      return (await transport.push(commit)).ok;
    }
  });
  assert.equal(result.status, 'done');
  assert.equal(afterRemoteRuns, 1);
  assert.equal(fixtureGit(dir, ['rev-parse', '--is-inside-work-tree']).trim(), 'true');
  assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/My-Project.git');
  assert.deepEqual(result.remote, { name: 'origin', url: 'https://github.com/me/My-Project.git' });
  const creates = github.calls.filter((call) => call.method === 'POST');
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.url, 'https://api.github.com/user/repos');
  assert.equal(creates[0]?.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.deepEqual(JSON.parse(creates[0]?.body ?? '{}'), { name: 'My-Project', private: true, auto_init: false });
  assert.ok(github.calls.every((call) => call.url.startsWith('https://api.github.com/')), 'only the GitHub API was contacted');
  // The sync branch reached the (local stand-in for the) online repository.
  assert.ok(fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).split('\n').includes(STATE_REF));
  // Both choices were shown with their notes, and every step was reported.
  assert.deepEqual(ui.visibilityNotes, [VISIBILITY_NOTES]);
  assert.ok(ui.steps.length >= 4 && ui.steps.every((step) => step.length > 10));
});

test('declining the start prompt writes nothing: no repository, no state home, no request', async () => {
  const dir = await projectFolder();
  const github = fakeGitHub();
  const auth = fakeAuth();
  let afterRemoteRuns = 0;
  const result = await onlineHomeFlow({ root: dir, ui: new FakeUi({ start: false }), auth, fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => { afterRemoteRuns += 1; return Promise.resolve(true); } });
  assert.equal(result.status, 'declined');
  assert.equal(existsSync(path.join(dir, '.git')), false);
  assert.equal(existsSync(path.join(dir, '.near-ai')), false);
  assert.equal(github.calls.length, 0);
  assert.equal(auth.tokenCalls, 0);
  assert.equal(afterRemoteRuns, 0);
});

test('visibility is asked every time with no default: walking away creates nothing', async () => {
  const dir = await projectFolder();
  const github = fakeGitHub();
  const ui = new FakeUi({ visibility: undefined });
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(result.status, 'cancelled');
  assert.equal(github.calls.length, 0);
  assert.equal(ui.visibilityNotes.length, 1);
  assert.equal(fixtureGit(dir, ['remote']).trim(), '');
  assert.equal(VISIBILITY_NOTES.private.includes('free plan'), true);
  assert.equal(VISIBILITY_NOTES.public.includes('encrypted'), true);
  assert.equal(VISIBILITY_NOTES.public.includes('code'), true);
});


test('without VS Code sign-in the flow says so and creates the repository through gh, never with a source or push', async () => {
  const dir = await projectFolder('gh-project');
  const gh = fakeGh();
  const github = fakeGitHub();
  const ui = new FakeUi({ fallback: 'gh', visibility: 'public' });
  const spy = spyGit();
  let runner: GitRunner | undefined;
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(FAKE_TOKEN, false), gh, fetchFn: github.fetchFn, git: spy.git, afterRemote: (remote) => { runner = remote.git; return Promise.resolve(true); } });
  assert.equal(result.status, 'done');
  assert.ok(ui.messages.includes(NOT_AVAILABLE), ui.messages.join('|'));
  assert.deepEqual(ui.fallbackCalls, [{ gh: true }]);
  assert.deepEqual(gh.calls, [['repo', 'create', 'gh-project', '--public']]);
  assert.equal(github.calls.length, 0, 'no GitHub API request: gh made the repository');
  assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/gh-project.git');
  // gh's token reaches git the same way the VS Code one would: through the child environment only.
  assert.ok(runner);
  await runner(['--version']);
  assert.match(spy.envs.at(-1)?.GIT_CONFIG_VALUE_0 ?? '', /^AUTHORIZATION: basic /);
  assert.equal(spy.envs.at(-1)?.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal((await readProgress(stateHomeFor(dir)))?.method, 'gh');
});

test('when gh is missing or signed out, the flow offers pasting the address of an empty repository and never asks for a token', async () => {
  for (const gh of [fakeGh({ available: false }), fakeGh({ signedIn: false }), undefined]) {
    const dir = await projectFolder('paste-project');
    const empty = bareRemote({ withMain: false });
    initWithMapping(dir, { 'https://github.com/me/empty.git': empty });
    const ui = new FakeUi({ urls: ['https://github.com/me/empty.git'] });
    const spy = spyGit();
    const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(FAKE_TOKEN, false), gh, git: spy.git, afterRemote: () => Promise.resolve(true) });
    assert.equal(result.status, 'done');
    assert.ok(ui.messages.includes(NOT_AVAILABLE));
    assert.deepEqual(ui.fallbackCalls, [], 'with nothing but a pasted address to offer, no menu is shown');
    assert.deepEqual(ui.urlProblems, [undefined]);
    assert.equal(ui.visibilityNotes.length, 0, 'a repository that already exists is not given a visibility');
    assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/empty.git');
    assert.equal(spy.envs.every((env) => env.GIT_CONFIG_VALUE_0 === undefined), true, 'no token was involved');
    assert.equal((await readProgress(stateHomeFor(dir)))?.method, 'url');
  }
});

test('a pasted address with a helper transport or a password in it is refused, and one that is not empty is refused, until an empty one is given', async () => {
  const dir = await projectFolder('paste-project');
  const empty = bareRemote({ withMain: false });
  const full = bareRemote();
  initWithMapping(dir, { 'https://github.com/me/full.git': full, 'https://github.com/me/empty.git': empty });
  const ui = new FakeUi({ urls: ['ext::sh -c x', 'https://me:ghp_FAKEFAKEFAKEFAKEFAKE12345@github.com/me/empty.git', 'https://github.com/me/full.git', 'https://github.com/me/empty.git'] });
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(FAKE_TOKEN, false), git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(result.status, 'done');
  assert.deepEqual(ui.urlProblems, [undefined, BAD_ADDRESS, HAS_SECRET, NOT_EMPTY]);
  assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/empty.git');
  assert.deepEqual(fixtureGit(dir, ['remote']).trim().split('\n'), ['origin']);
});

test('GitHub answers become one plain sentence each: a taken name asks for another, offline and refused permission stop, an invalid name never leaves the computer', async () => {
  // A name that is taken: the second name works.
  const taken = await projectFolder('taken');
  const github = fakeGitHub({ existing: ['taken'] });
  const ui = new FakeUi({ names: ['taken', 'taken-2'] });
  const first = await onlineHomeFlow({ root: taken, ui, auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(first.status, 'done');
  assert.deepEqual(ui.nameCalls.map((call) => call.problem), [undefined, NAME_TAKEN]);
  assert.equal(github.calls.filter((call) => call.method === 'POST').length, 2);
  assert.equal(fixtureGit(taken, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/taken-2.git');

  // Offline.
  const offlineDir = await projectFolder('offline');
  const offlineUi = new FakeUi();
  const offline = await onlineHomeFlow({ root: offlineDir, ui: offlineUi, auth: fakeAuth(), fetchFn: () => Promise.reject(new TypeError('fetch failed')), git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(offline.status, 'failed');
  assert.ok(offlineUi.messages.includes(OFFLINE), offlineUi.messages.join('|'));
  assert.equal(fixtureGit(offlineDir, ['remote']).trim(), '');
  assert.equal((await readProgress(stateHomeFor(offlineDir)))?.repo, undefined);

  // Refused permission, both from the API and from the person closing the sign-in.
  for (const [dir, fetchFn, auth] of [
    [await projectFolder('refused'), (() => Promise.resolve({ status: 403, text: () => Promise.resolve('{"message":"Resource not accessible"}') })) as FetchLike, fakeAuth()],
    [await projectFolder('closed'), undefined, fakeAuth(null)]
  ] as const) {
    const refusedUi = new FakeUi();
    const refused = await onlineHomeFlow({ root: dir, ui: refusedUi, auth, fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
    assert.notEqual(refused.status, 'done');
    assert.ok(refusedUi.messages.includes(NOT_ALLOWED), refusedUi.messages.join('|'));
    assert.equal(fixtureGit(dir, ['remote']).trim(), '');
  }

  // An invalid name is refused before any request.
  const invalidDir = await projectFolder('invalid');
  const invalidGithub = fakeGitHub();
  const invalidUi = new FakeUi({ names: ['bad name!', 'a/b', '..', 'repo.git', 'good-name'] });
  const invalid = await onlineHomeFlow({ root: invalidDir, ui: invalidUi, auth: fakeAuth(), fetchFn: invalidGithub.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(invalid.status, 'done');
  assert.deepEqual(invalidUi.nameCalls.map((call) => call.problem), [undefined, BAD_NAME, BAD_NAME, BAD_NAME, BAD_NAME]);
  assert.deepEqual(invalidGithub.calls.map((call) => (JSON.parse(call.body ?? '{}') as { name?: string }).name), ['good-name']);
});

test('an interrupted setup resumes: after create the repository is found, not created again; after git init it carries on at sign-in', async () => {
  const dir = await projectFolder('resume');
  const github = fakeGitHub();
  const stop = (at: string) => (step: string): void => { if (step === at) throw new Error('interrupted'); };
  await assert.rejects(onlineHomeFlow({ root: dir, ui: new FakeUi(), auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true), onStep: stop('create') }), /interrupted/);
  const saved = await readProgress(stateHomeFor(dir));
  assert.equal(saved?.step, 'create');
  assert.equal(saved?.repo?.url, 'https://github.com/me/resume.git');
  assert.equal(fixtureGit(dir, ['remote']).trim(), '');

  const ui = new FakeUi();
  let afterRemoteRuns = 0;
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => { afterRemoteRuns += 1; return Promise.resolve(true); } });
  assert.equal(result.status, 'done');
  assert.equal(github.calls.filter((call) => call.method === 'POST').length, 1, 'the repository was created once');
  assert.ok(github.calls.some((call) => call.method === 'GET' && call.url.endsWith('/repos/me/resume')));
  assert.equal(ui.visibilityNotes.length, 0, 'the choice made before is not asked again');
  assert.equal(afterRemoteRuns, 1);
  assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://github.com/me/resume.git');
  assert.equal((await readProgress(stateHomeFor(dir)))?.step, 'done');

  const early = await projectFolder('early');
  await assert.rejects(onlineHomeFlow({ root: early, ui: new FakeUi(), auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true), onStep: stop('init') }), /interrupted/);
  assert.equal(existsSync(path.join(early, '.git')), true);
  const again = spyGit();
  const second = await onlineHomeFlow({ root: early, ui: new FakeUi(), auth: fakeAuth(), fetchFn: github.fetchFn, git: again.git, afterRemote: () => Promise.resolve(true) });
  assert.equal(second.status, 'done');
  assert.equal(again.calls.some((args) => args.includes('init')), false, 'git init is not run twice');
  assert.equal(github.calls.filter((call) => call.method === 'POST').length, 2);
});

test('a saved repository that GitHub no longer has starts again at sign-in, and a tampered progress file is not trusted', async () => {
  const dir = await projectFolder('gone');
  const github = fakeGitHub();
  await assert.rejects(onlineHomeFlow({ root: dir, ui: new FakeUi(), auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true), onStep: (step) => { if (step === 'create') throw new Error('interrupted'); } }), /interrupted/);
  github.repos.clear();
  const ui = new FakeUi();
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(result.status, 'done');
  assert.equal(ui.visibilityNotes.length, 1);

  const home = stateHomeFor(dir);
  const { writeFile } = await import('node:fs/promises');
  const file = path.join(home.paths.sync, 'online-home.json');
  for (const bad of [
    { step: 'create', method: 'url', startedAt: 'x', repo: { owner: '', name: 'a', url: 'ext::sh -c x', visibility: 'unknown' } },
    { step: 'create', method: 'vscode', startedAt: 'x', repo: { owner: 'me', name: 'a', url: 'https://evil.example/me/a.git', visibility: 'private' } },
    { step: 'nope', method: 'vscode', startedAt: 'x' }
  ]) {
    await writeFile(file, JSON.stringify(bad));
    assert.equal(await readProgress(home), undefined, JSON.stringify(bad));
  }
});

test('the token never appears in a git argument, a file, the progress record, a message or the console, and git gets it only through its environment', async () => {
  const secrets = [FAKE_TOKEN, Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')];
  const logged: string[] = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = consoleMethods.map((method) => console[method]);
  for (const method of consoleMethods) console[method] = (...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); };
  const folders: string[] = [];
  const argLists: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  const messages: string[] = [];
  const requests: string[] = [];
  try {
    for (const route of ['vscode', 'gh'] as const) {
      const dir = await projectFolder(`hygiene-${route}`);
      const bare = bareRemote({ withMain: false });
      // The person's code is pushed too, so the default-branch read and PATCH are part of the run (gh makes its repository itself).
      writeFileSync(path.join(dir, 'app.ts'), 'export {};\n');
      const github = fakeGitHub({ defaultBranch: DEFAULT_STATE_BRANCH, existing: route === 'gh' ? [`hygiene-${route}`] : undefined });
      const ui = new FakeUi({ fallback: 'gh' });
      ui.codePush = new FakeCodeOffer([], { offer: true });
      const spy = spyGit();
      const result = await onlineHomeFlow({
        root: dir,
        ui,
        auth: fakeAuth(FAKE_TOKEN, route === 'vscode'),
        gh: fakeGh(),
        fetchFn: github.fetchFn,
        git: spy.git,
        personGit: spy.git,
        afterRemote: async (remote) => {
          fixtureGit(dir, ['config', `url.${bare}.insteadOf`, remote.url]);
          const paths = await mirrorPaths();
          folders.push(paths.base);
          const transport = new StateTransport({ root: dir, remote: remote.name, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: remote.git });
          return (await transport.push(await transport.writeCommit([{ name: 'manifest.json', data: '{}' }]))).ok;
        }
      });
      assert.equal(result.status, 'done');
      assert.equal(github.calls.filter((call) => call.method === 'PATCH').length, 1, 'the run sent the default-branch PATCH');
      for (const call of github.calls) requests.push(call.url, call.body ?? '');
      folders.push(dir);
      argLists.push(...spy.calls);
      envs.push(...spy.envs);
      messages.push(...ui.messages, ...ui.steps, JSON.stringify(result));
    }
  } finally {
    consoleMethods.forEach((method, index) => { console[method] = originals[index] as never; });
  }
  for (const secret of secrets) {
    assert.equal(argLists.some((args) => args.some((arg) => arg.includes(secret))), false, 'no git argument holds the token');
    assert.equal(messages.some((message) => message.includes(secret)), false);
    assert.equal(requests.some((request) => request.includes(secret)), false, 'no request URL or body holds the token');
    assert.equal(logged.some((line) => line.includes(secret)), false);
    for (const folder of folders) {
      for (const file of allFiles(folder)) assert.equal(readFileSync(file).includes(Buffer.from(secret)), false, `${file} holds the token`);
    }
  }
  assert.equal(logged.length, 0, 'the flow prints nothing');
  // The token did reach git, scoped to github.com and only through the environment.
  const carrying = envs.filter((env) => env.GIT_CONFIG_VALUE_0 !== undefined);
  assert.ok(carrying.length >= 2);
  for (const env of carrying) {
    assert.equal(env.GIT_CONFIG_COUNT, '1');
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${secrets[1]}`);
  }
});

test('gh is run with array arguments and prompts off, never with a source or push, and its token is read from gh auth token into memory', async () => {
  const calls: Array<{ args: string[] }> = [];
  const answers: Record<string, { code: number; stdout: string; stderr: string }> = {
    '--version': { code: 0, stdout: 'gh version 2.50.0\n', stderr: '' },
    'auth status': { code: 0, stdout: '', stderr: 'Logged in\n' },
    'auth token': { code: 0, stdout: `${FAKE_TOKEN}\n`, stderr: '' },
    'repo create fresh --private': { code: 0, stdout: 'https://github.com/me/fresh\n', stderr: '' },
    'repo create quiet --public': { code: 0, stdout: '\n', stderr: '' },
    'api user --jq .login': { code: 0, stdout: 'me\n', stderr: '' },
    'repo create taken --private': { code: 1, stdout: '', stderr: 'GraphQL: Name already exists on this account (createRepository)\n' },
    'repo create refused --private': { code: 1, stdout: '', stderr: 'HTTP 403: Resource not accessible by integration\n' }
  };
  const exec: GhExec = (args) => { calls.push({ args }); return Promise.resolve(answers[args.join(' ')] ?? { code: 1, stdout: '', stderr: 'unknown' }); };
  const gh = systemGhCli(exec);
  assert.equal(await gh.available(), true);
  assert.equal(await gh.signedIn(), true);
  assert.equal(await gh.token(), FAKE_TOKEN);
  assert.deepEqual(await gh.createRepo('fresh', 'private'), { owner: 'me', name: 'fresh' });
  assert.deepEqual(await gh.createRepo('quiet', 'public'), { owner: 'me', name: 'quiet' }, 'the account is read from gh when the output has no address');
  await assert.rejects(gh.createRepo('taken', 'private'), (error: unknown) => error instanceof GitHubApiError && error.kind === 'name-taken');
  await assert.rejects(gh.createRepo('refused', 'private'), (error: unknown) => error instanceof GitHubApiError && error.kind === 'permission');
  await assert.rejects(gh.createRepo('bad name', 'private'), GitHubApiError);
  assert.equal(calls.some(({ args }) => args.some((arg) => /^--(source|push|clone)/.test(arg) || arg === '-s')), false);
  assert.equal(calls.some(({ args }) => args.some((arg) => arg.includes(FAKE_TOKEN))), false);
  const signedOut = systemGhCli(() => Promise.resolve({ code: 1, stdout: '', stderr: 'not logged in' }));
  assert.equal(await signedOut.signedIn(), false);
  assert.equal(await signedOut.token(), undefined);
});

test('a folder inside another repository is not given a repository of its own, and a remote already named origin is left alone', async () => {
  const parent = await projectFolder('parent');
  fixtureGit(parent, ['init', '-q']);
  const inner = path.join(parent, 'inner');
  await mkdir(inner);
  const github = fakeGitHub();
  const ui = new FakeUi();
  const result = await onlineHomeFlow({ root: inner, ui, auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(result.status, 'failed');
  assert.ok(ui.messages.some((message) => message.startsWith('This folder is inside another git repository')), ui.messages.join('|'));
  assert.equal(existsSync(path.join(inner, '.git')), false);
  assert.equal(github.calls.length, 0);

  const dir = await projectFolder('named');
  fixtureGit(dir, ['init', '-q']);
  fixtureGit(dir, ['remote', 'add', 'origin', 'https://example.com/other/named.git']);
  const done = await onlineHomeFlow({ root: dir, ui: new FakeUi(), auth: fakeAuth(), fetchFn: github.fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(true) });
  assert.equal(done.status, 'done');
  assert.deepEqual(done.remote, { name: 'near-ai-home', url: 'https://github.com/me/named.git' });
  assert.equal(fixtureGit(dir, ['config', '--get', 'remote.origin.url']).trim(), 'https://example.com/other/named.git');
});


test('the code push is a separate question asked only after the sync branch step, and declining it leaves sync as it was', async () => {
  const dir = await projectFolder('offer');
  const events: string[] = [];
  const ui = new FakeUi();
  ui.codePush = new FakeCodeOffer(events, { offer: false });
  const spy = spyGit();
  const result = await onlineHomeFlow({ root: dir, ui, auth: fakeAuth(), fetchFn: fakeGitHub().fetchFn, git: spy.git, personGit: spy.git, afterRemote: () => { events.push('sync'); return Promise.resolve(true); } });
  assert.equal(result.status, 'done');
  assert.deepEqual(events, ['sync', 'offer']);
  assert.equal(fixtureGit(dir, ['rev-list', '--all', '--count']).trim(), '0', 'no commit was made on the person\'s account of the code');
  assert.equal(spy.calls.some((args) => args.includes('push')), false);

  // When the sync step does not finish, the code is not even offered.
  const stalled = await projectFolder('stalled');
  const stalledEvents: string[] = [];
  const stalledUi = new FakeUi();
  stalledUi.codePush = new FakeCodeOffer(stalledEvents, { offer: true });
  const incomplete = await onlineHomeFlow({ root: stalled, ui: stalledUi, auth: fakeAuth(), fetchFn: fakeGitHub().fetchFn, git: spyGit().git, afterRemote: () => Promise.resolve(false) });
  assert.equal(incomplete.status, 'sync-incomplete');
  assert.deepEqual(stalledEvents, []);
});

test('accepting the offer pushes the code through the signed-in runner with the repository\'s visibility in the summary', async () => {
  const dir = await projectFolder('code-yes');
  const bare = bareRemote({ withMain: false });
  writeFileSync(path.join(dir, 'app.ts'), 'export {};\n');
  const events: string[] = [];
  const offer = new FakeCodeOffer(events, { offer: true, push: true });
  const ui = new FakeUi({ visibility: 'public' });
  ui.codePush = offer;
  const spy = spyGit();
  const result = await onlineHomeFlow({
    root: dir, ui, auth: fakeAuth(), fetchFn: fakeGitHub().fetchFn, git: spy.git, personGit: spy.git,
    afterRemote: (remote) => { fixtureGit(dir, ['config', `url.${bare}.insteadOf`, remote.url]); events.push('sync'); return Promise.resolve(true); }
  });
  assert.equal(result.status, 'done');
  assert.deepEqual(events, ['sync', 'offer', 'confirm-push']);
  assert.equal(offer.summaries[0]?.visibility, 'public');
  assert.equal(offer.summaries[0]?.remote, 'origin');
  assert.ok(offer.summaries[0]?.files.includes('app.ts'));
  assert.ok(fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).split('\n').some((ref) => ref.startsWith('refs/heads/')));
  const pushEnvs = spy.calls.map((args, index) => ({ args, env: spy.envs[index] })).filter((entry) => entry.args.includes('push'));
  assert.ok(pushEnvs.length >= 1 && pushEnvs.every((entry) => entry.env?.GIT_CONFIG_VALUE_0?.startsWith('AUTHORIZATION: basic ')));
  assert.equal(pushEnvs.some((entry) => entry.args.some((arg) => arg.includes(FAKE_TOKEN))), false);
});


test('tracer: once the code is pushed on the VS Code route, the default branch moves from near-ai/state to the pushed branch with one PATCH', async () => {
  const run = await codeRun('tracer-default', { defaultBranch: DEFAULT_STATE_BRANCH });
  assert.equal(run.result.status, 'done');
  const branch = currentBranch(run.dir);
  const sent = patches(run);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.url, 'https://api.github.com/repos/me/tracer-default');
  assert.equal(sent[0]?.body, JSON.stringify({ default_branch: branch }));
  assert.equal(sent[0]?.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  const patchAt = run.events.findIndex((event) => event.startsWith('api:PATCH'));
  const pushAt = run.events.findIndex((event) => event.startsWith('git:') && event.includes(`refs/heads/${branch}:refs/heads/${branch}`));
  assert.ok(pushAt >= 0 && patchAt > pushAt, `the PATCH comes after the push of the person's branch: ${run.events.join(' | ')}`);
  assert.equal(run.github.defaultBranch, branch);
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
  assert.equal(run.ui.messages.filter((message) => /is now the repository's default branch/.test(message)).length, 1, run.ui.messages.join('|'));
});

test('GitHub answers carry the default branch only when it is a safe branch name, and setDefaultBranch sends one PATCH and checks everything before any request', async () => {
  const github = fakeGitHub({ existing: ['demo'], defaultBranch: DEFAULT_STATE_BRANCH });
  assert.equal((await getRepo(FAKE_TOKEN, 'me', 'demo', github.fetchFn))?.defaultBranch, DEFAULT_STATE_BRANCH);
  for (const unsafe of ['', '-x', '/x', 'a..b', 'x/', 'x.lock', 'a b', 'a;b', 'a'.repeat(256), 'a\nb', 'a//b']) {
    const odd = fakeGitHub({ existing: ['demo'], defaultBranch: unsafe });
    const repo = await getRepo(FAKE_TOKEN, 'me', 'demo', odd.fetchFn);
    assert.ok(repo, 'an unsafe default branch never fails the parse');
    assert.equal(repo.defaultBranch, undefined, JSON.stringify(unsafe));
    assert.equal(isSafeBranchName(unsafe), false);
  }
  assert.equal((await getRepo(FAKE_TOKEN, 'me', 'demo', fakeGitHub({ existing: ['demo'] }).fetchFn))?.defaultBranch, undefined);
  for (const safe of ['main', 'feature/x-1', 'release_1.2', 'near-ai/state']) assert.equal(isSafeBranchName(safe), true);

  await setDefaultBranch(FAKE_TOKEN, 'me', 'demo', 'develop', github.fetchFn);
  const sent = github.calls.filter((call) => call.method === 'PATCH');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.body, '{"default_branch":"develop"}');
  assert.equal(github.defaultBranch, 'develop');
  const before = github.calls.length;
  for (const [owner, name, branch] of [['-bad', 'demo', 'main'], ['me', 'bad name', 'main'], ['me', 'demo', '-main'], ['me', 'demo', 'a..b']]) {
    await assert.rejects(setDefaultBranch(FAKE_TOKEN, owner as string, name as string, branch as string, github.fetchFn), (error: unknown) => error instanceof GitHubApiError && error.kind === 'other');
  }
  assert.equal(github.calls.length, before, 'nothing was sent for an unsafe owner, name or branch');
});

test('moveDefaultBranch moves only a default of near-ai/state', async () => {
  for (const [current, expected, patchCount] of [[DEFAULT_STATE_BRANCH, 'moved', 1], ['develop', 'unchanged', 0], ['main', 'unchanged', 0], [undefined, 'unchanged', 0]] as const) {
    const github = fakeGitHub({ existing: ['demo'], defaultBranch: current });
    const moved = await moveDefaultBranch({ token: FAKE_TOKEN, owner: 'me', name: 'demo', to: 'main', fetchFn: github.fetchFn });
    assert.equal(moved.result, expected, String(current));
    assert.equal(github.calls.filter((call) => call.method === 'PATCH').length, patchCount);
  }
  const gone = await moveDefaultBranch({ token: FAKE_TOKEN, owner: 'me', name: 'missing', to: 'main', fetchFn: fakeGitHub().fetchFn });
  assert.equal(gone.result, 'failed');
});

const DEFAULT_SENTENCE = /is now the repository's default branch/;
const FAILED_SENTENCE = /did not change the default branch/;

/** A run where nothing reached the person's repository but the sync branch: no PATCH, no default-branch sentence, the default is still near-ai/state. */
function assertDefaultUntouched(run: CodeRun): void {
  assert.equal(run.result.status, 'done');
  assert.equal(patches(run).length, 0);
  assert.equal(run.github.defaultBranch, DEFAULT_STATE_BRANCH);
  assert.equal(run.ui.messages.some((message) => DEFAULT_SENTENCE.test(message) || FAILED_SENTENCE.test(message) || /default branch/.test(message)), false, run.ui.messages.join('|'));
  assertOnlyOurRefs(run.bare, run.dir, false);
  assertNoDangerousPush(run.spy.calls);
}

test('a declined code offer sends no PATCH and leaves the default as it was', async () => {
  assertDefaultUntouched(await codeRun('declined-offer', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false }));
});

test('a declined summary sends no PATCH and leaves the default as it was', async () => {
  assertDefaultUntouched(await codeRun('declined-summary', { defaultBranch: DEFAULT_STATE_BRANCH, push: false }));
});

test('a planted .env blocks the code push, and with it any PATCH', async () => {
  const run = await codeRun('blocked-env', { defaultBranch: DEFAULT_STATE_BRANCH, files: { 'app.ts': 'export {};\n', '.env': 'API_KEY=sk_live_FAKEFAKEFAKEFAKE12345\n' } });
  assertDefaultUntouched(run);
});

test('a push the online repository refuses sends no PATCH and leaves the sync branch there', async () => {
  const hook = `#!/bin/sh\nwhile read old new ref; do\n  [ "$ref" = "${STATE_REF}" ] || { echo "branch not accepted" >&2; exit 1; }\ndone\n`;
  const run = await codeRun('refused-push', { defaultBranch: DEFAULT_STATE_BRANCH, hook });
  assertDefaultUntouched(run);
  assert.ok(run.ui.messages.some((message) => /not pushed|nothing was pushed/i.test(message)), run.ui.messages.join('|'));
});

test('nothing to push sends no PATCH and leaves the default as it was', async () => {
  assertDefaultUntouched(await codeRun('nothing-to-push', { defaultBranch: DEFAULT_STATE_BRANCH, files: {} }));
});

test('a default the person chose is read and never changed, and one that is already the pushed branch is left alone too', async () => {
  for (const [name, options] of [['own-default', { defaultBranch: 'develop' }], ['same-default', { defaultBranch: DEFAULT_STATE_BRANCH, defaultAfterSync: 'person' as const }]] as const) {
    const run = await codeRun(name, options);
    assert.equal(run.result.status, 'done');
    assert.equal(run.github.calls.filter((call) => call.method === 'GET').length, 1, 'the default branch was read');
    assert.equal(patches(run).length, 0, name);
    assert.equal(run.github.defaultBranch, options.defaultBranch === 'develop' ? 'develop' : currentBranch(run.dir));
    assert.equal(run.ui.messages.some((message) => /default branch/.test(message)), false, run.ui.messages.join('|'));
    assertOnlyOurRefs(run.bare, run.dir, true);
    assertNoDangerousPush(run.spy.calls);
  }
});

test('on the gh route the same move happens, with the gh token only in the Authorization header', async () => {
  const run = await codeRun('gh-default', { route: 'gh', defaultBranch: DEFAULT_STATE_BRANCH });
  assert.equal(run.result.status, 'done');
  const branch = currentBranch(run.dir);
  assert.equal(patches(run).length, 1);
  assert.equal(patches(run)[0]?.body, JSON.stringify({ default_branch: branch }));
  assert.equal(patches(run)[0]?.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.equal(run.github.defaultBranch, branch);
  assert.ok(run.github.calls.every((call) => !call.url.includes(FAKE_TOKEN) && !(call.body ?? '').includes(FAKE_TOKEN)));
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
});

test('a pasted address sends no GitHub request, and names the setting to change when the remote still shows near-ai/state first', async () => {
  const run = await codeRun('paste-state', { route: 'url', remoteHeadAfterSync: 'state' });
  assert.equal(run.result.status, 'done');
  assert.equal(run.github.calls.length, 0, 'no GitHub API request at all');
  const branch = currentBranch(run.dir);
  assert.ok(run.ui.messages.some((message) => message.includes(`make ${branch} the default branch`) && message.includes('settings')), run.ui.messages.join('|'));
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
});

test('a pasted address whose remote already shows another branch first gets no settings sentence', async () => {
  const run = await codeRun('paste-person', { route: 'url', remoteHeadAfterSync: 'person' });
  assert.equal(run.result.status, 'done');
  assert.equal(run.github.calls.length, 0);
  assert.equal(run.ui.messages.some((message) => /default branch/.test(message)), false, run.ui.messages.join('|'));
  assertOnlyOurRefs(run.bare, run.dir, true);
});

test('a default-branch change GitHub refuses or cannot reach is told in one plain sentence, the setup still ends done, and the pushed code is left as it is', async () => {
  for (const patch of [403, 422, 'offline'] as const) {
    const run = await codeRun(`patch-${String(patch)}`, { defaultBranch: DEFAULT_STATE_BRANCH, patch });
    assert.equal(run.result.status, 'done', String(patch));
    const branch = currentBranch(run.dir);
    const told = run.ui.messages.filter((message) => FAILED_SENTENCE.test(message));
    assert.equal(told.length, 1, run.ui.messages.join('|'));
    assert.ok(told[0]?.includes(branch) && told[0].includes(DEFAULT_STATE_BRANCH));
    assert.equal(run.ui.messages.some((message) => DEFAULT_SENTENCE.test(message)), false);
    assert.equal(run.github.defaultBranch, DEFAULT_STATE_BRANCH);
    assertOnlyOurRefs(run.bare, run.dir, true);
    assertNoDangerousPush(run.spy.calls);
  }
});

test('remoteDefaultBranch reads the symbolic HEAD with git alone, and anything it cannot read means "cannot tell"', async () => {
  const answer = (code: number, text: string): GitRunner => () => Promise.resolve({ code, stdout: Buffer.from(text), stderr: '' });
  const oid = 'a'.repeat(40);
  assert.equal(await remoteDefaultBranch('/x', 'origin', answer(0, `ref: refs/heads/main\tHEAD\n${oid}\tHEAD\n`)), 'main');
  assert.equal(await remoteDefaultBranch('/x', 'origin', answer(0, `ref: refs/heads/near-ai/state\tHEAD\n${oid}\tHEAD\n`)), DEFAULT_STATE_BRANCH);
  for (const text of ['', `${oid}\tHEAD\n`, 'ref: refs/heads/-x\tHEAD\n', 'ref: refs/heads/a..b\tHEAD\n', 'ref: refs/tags/v1\tHEAD\n']) {
    assert.equal(await remoteDefaultBranch('/x', 'origin', answer(0, text)), undefined, JSON.stringify(text));
  }
  assert.equal(await remoteDefaultBranch('/x', 'origin', answer(128, `ref: refs/heads/main\tHEAD\n`)), undefined);
  const seen: string[][] = [];
  await remoteDefaultBranch('/x', 'origin', (args) => { seen.push(args); return Promise.resolve({ code: 1, stdout: Buffer.alloc(0), stderr: '' }); });
  assert.deepEqual(seen, [['-C', '/x', 'ls-remote', '--symref', 'origin', 'HEAD']]);
});

// ---- running the setup again: the code offer, the way back after a decline, and the click-confirmed default branch (G-27-6a, G-27-6b) ----

const COMMAND_NAME = "Put This Project's Code Online";
const HAS_CODE = /online home has this project's code/;
const SETTINGS = (branch: string): string => `make ${branch} the default branch in the online repository's settings`;

/** The same project's setup run a second time on the same fakes: nothing is created, and what the run did is returned for inspection. */
async function rerun(run: CodeRun, ui: FakeUi, route: 'vscode' | 'gh' | 'url' = 'vscode'): Promise<{ result: Awaited<ReturnType<typeof onlineHomeFlow>>; afterRemoteRuns: number; gitCalls: string[][]; apiCalls: number; creates: number }> {
  const gitBefore = run.spy.calls.length;
  const apiBefore = run.github.calls.length;
  const createsBefore = run.github.calls.filter((call) => call.method === 'POST').length;
  let afterRemoteRuns = 0;
  const result = await onlineHomeFlow({
    root: run.dir, ui, auth: fakeAuth(FAKE_TOKEN, route === 'vscode'), gh: route === 'gh' ? fakeGh() : undefined, fetchFn: run.github.fetchFn, git: run.spy.git, personGit: run.spy.git,
    afterRemote: () => { afterRemoteRuns += 1; return Promise.resolve(true); }
  });
  return {
    result, afterRemoteRuns, gitCalls: run.spy.calls.slice(gitBefore), apiCalls: run.github.calls.length - apiBefore,
    creates: run.github.calls.filter((call) => call.method === 'POST').length - createsBefore
  };
}

/** A project whose code is already online while GitHub still shows near-ai/state first, as an earlier build left it. */
async function codeOnlineDefaultOnState(name: string, route: 'vscode' | 'gh' = 'vscode'): Promise<CodeRun> {
  const run = await codeRun(name, { route, defaultBranch: 'develop' });
  assert.equal(run.result.status, 'done');
  assert.equal(patches(run).length, 0);
  run.github.defaultBranch = DEFAULT_STATE_BRANCH;
  return run;
}

test('declining the code offer ends with one sentence that names the command and says what the online repository holds until then', async () => {
  const run = await codeRun('decline-sentence', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  assert.equal(run.result.status, 'done');
  const told = run.ui.messages.filter((message) => message.includes(COMMAND_NAME));
  assert.equal(told.length, 1, run.ui.messages.join('|'));
  assert.match(told[0] as string, /only NEAR AI's encrypted sync branch/);
  assert.match(told[0] as string, /stays on this computer/);
  assert.equal(told[0]?.includes('default branch'), false);
  assert.equal(patches(run).length, 0);
});

test('running the setup again on a project whose code is not online offers the code push: accepting pushes through the same checks and moves the default once, after the push', async () => {
  const run = await codeRun('rerun-offer', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  const ui = new FakeUi();
  const offer = new FakeCodeOffer(run.events, { offer: true, push: true });
  ui.codePush = offer;
  const again = await rerun(run, ui);
  assert.equal(again.result.status, 'done');
  assert.equal(again.afterRemoteRuns, 0, 'the turn-on flow is not run again');
  assert.equal(again.creates, 0, 'no second repository');
  assert.equal(run.events.filter((event) => event === 'offer').length, 2, 'the code was offered once more');
  assert.equal(offer.summaries.length, 1);
  assert.ok(offer.summaries[0]?.files.includes('app.ts'));
  const branch = currentBranch(run.dir);
  assert.equal(patches(run).length, 1);
  assert.equal(patches(run)[0]?.body, JSON.stringify({ default_branch: branch }));
  const pushAt = run.events.findIndex((event) => event.startsWith('git:') && event.includes(`refs/heads/${branch}:refs/heads/${branch}`));
  const patchAt = run.events.findIndex((event) => event.startsWith('api:PATCH'));
  assert.ok(pushAt >= 0 && patchAt > pushAt, run.events.join(' | '));
  assert.equal(run.github.defaultBranch, branch);
  assert.ok(ui.messages.some((message) => DEFAULT_SENTENCE.test(message)), ui.messages.join('|'));
  assertOnlyOurRefs(run.bare, run.dir, true);
  assertNoDangerousPush(run.spy.calls);
});

test('running the setup again and declining the code offer names the command again, sends no PATCH and creates nothing', async () => {
  const run = await codeRun('rerun-decline', { defaultBranch: DEFAULT_STATE_BRANCH, offer: false });
  const ui = new FakeUi();
  ui.codePush = new FakeCodeOffer(run.events, { offer: false });
  const again = await rerun(run, ui);
  assert.equal(again.result.status, 'done');
  assert.equal(again.afterRemoteRuns, 0);
  assert.equal(again.creates, 0);
  assert.equal(ui.messages.filter((message) => message.includes(COMMAND_NAME)).length, 1, ui.messages.join('|'));
  assert.equal(again.gitCalls.some((args) => args.includes('push')), false);
  assert.equal(patches(run).length, 0);
  assertOnlyOurRefs(run.bare, run.dir, false);
});

test('a re-run whose branch is already online says so in one sentence, asks once whether to make it the default, and only on the click sends one PATCH', async () => {
  for (const answer of [true, false]) {
    const run = await codeOnlineDefaultOnState(`rerun-repair-${String(answer)}`);
    const ui = new FakeUi({ confirmDefault: answer });
    const offer = new FakeCodeOffer(run.events, { offer: true });
    ui.codePush = offer;
    const again = await rerun(run, ui);
    const branch = currentBranch(run.dir);
    assert.equal(again.result.status, 'done');
    assert.equal(again.afterRemoteRuns, 0);
    assert.equal(again.creates, 0);
    assert.equal(ui.messages.filter((message) => HAS_CODE.test(message)).length, 1, ui.messages.join('|'));
    assert.deepEqual(ui.defaultQuestions, [branch]);
    assert.equal(run.events.filter((event) => event === 'offer').length, 1, 'the code is not offered again: it is already online');
    assert.equal(again.gitCalls.some((args) => args.includes('push')), false, 'the repair pushes nothing');
    assert.equal(patches(run).length, answer ? 1 : 0);
    assert.equal(run.github.defaultBranch, answer ? branch : DEFAULT_STATE_BRANCH);
    assert.equal(ui.messages.some((message) => DEFAULT_SENTENCE.test(message)), answer, ui.messages.join('|'));
    if (answer) assert.equal(patches(run)[0]?.body, JSON.stringify({ default_branch: branch }));
    assertOnlyOurRefs(run.bare, run.dir, true);
  }
});

test('a re-run never asks about, or changes, a default the person chose or one that is already their branch, and without the question on the ui no PATCH is sent', async () => {
  const own = await codeRun('rerun-own', { defaultBranch: 'develop' });
  const ownUi = new FakeUi({ confirmDefault: true });
  ownUi.codePush = new FakeCodeOffer(own.events, { offer: true });
  await rerun(own, ownUi);
  assert.deepEqual(ownUi.defaultQuestions, []);
  assert.equal(patches(own).length, 0);
  assert.equal(own.github.defaultBranch, 'develop');
  assert.ok(ownUi.messages.some((message) => HAS_CODE.test(message)));

  const same = await codeRun('rerun-same', { defaultBranch: 'develop' });
  same.github.defaultBranch = currentBranch(same.dir);
  const sameUi = new FakeUi({ confirmDefault: true });
  sameUi.codePush = new FakeCodeOffer(same.events, { offer: true });
  await rerun(same, sameUi);
  assert.deepEqual(sameUi.defaultQuestions, []);
  assert.equal(patches(same).length, 0);

  const silent = await codeOnlineDefaultOnState('rerun-no-question');
  const silentUi = new FakeUi();
  silentUi.codePush = new FakeCodeOffer(silent.events, { offer: true });
  const again = await rerun(silent, silentUi);
  assert.equal(again.result.status, 'done');
  assert.equal(patches(silent).length, 0);
  assert.equal(silent.github.defaultBranch, DEFAULT_STATE_BRANCH);
});

test('on the gh route the re-run repair is the same click and one PATCH, with the gh token only in the Authorization header', async () => {
  const run = await codeOnlineDefaultOnState('rerun-gh', 'gh');
  const ui = new FakeUi({ confirmDefault: true });
  ui.codePush = new FakeCodeOffer(run.events, { offer: true });
  const again = await rerun(run, ui, 'gh');
  assert.equal(again.result.status, 'done');
  assert.deepEqual(ui.defaultQuestions, [currentBranch(run.dir)]);
  assert.equal(patches(run).length, 1);
  assert.equal(patches(run)[0]?.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
  assert.ok(run.github.calls.every((call) => !call.url.includes(FAKE_TOKEN) && !(call.body ?? '').includes(FAKE_TOKEN)));
  assert.equal(run.github.defaultBranch, currentBranch(run.dir));
});

test('on a pasted address a re-run sends no request to GitHub: it names the setting when the remote shows near-ai/state first, says nothing more when it does not, and the code offer works', async () => {
  const shown = await codeRun('rerun-paste-state', { route: 'url', remoteHeadAfterSync: 'state' });
  const stateUi = new FakeUi({ confirmDefault: true });
  stateUi.codePush = new FakeCodeOffer(shown.events, { offer: true });
  const stateAgain = await rerun(shown, stateUi, 'url');
  assert.equal(stateAgain.apiCalls, 0);
  assert.equal(shown.github.calls.length, 0);
  assert.deepEqual(stateUi.defaultQuestions, []);
  assert.ok(stateUi.messages.some((message) => HAS_CODE.test(message)));
  assert.ok(stateUi.messages.some((message) => message.includes(SETTINGS(currentBranch(shown.dir))) && message.includes('settings')), stateUi.messages.join('|'));
  assert.equal(stateAgain.gitCalls.some((args) => args.includes('push')), false);

  const person = await codeRun('rerun-paste-person', { route: 'url', remoteHeadAfterSync: 'person' });
  const personUi = new FakeUi({ confirmDefault: true });
  personUi.codePush = new FakeCodeOffer(person.events, { offer: true });
  await rerun(person, personUi, 'url');
  assert.equal(personUi.messages.some((message) => /default branch/.test(message)), false, personUi.messages.join('|'));
  assert.deepEqual(personUi.defaultQuestions, []);

  const declined = await codeRun('rerun-paste-offer', { route: 'url', remoteHeadAfterSync: 'state', offer: false });
  const offerUi = new FakeUi();
  const offer = new FakeCodeOffer(declined.events, { offer: true, push: true });
  offerUi.codePush = offer;
  const offered = await rerun(declined, offerUi, 'url');
  assert.equal(offered.apiCalls, 0);
  assert.equal(offer.summaries.length, 1);
  assert.ok(offerUi.messages.some((message) => message.includes(SETTINGS(currentBranch(declined.dir)))), offerUi.messages.join('|'));
  assertOnlyOurRefs(declined.bare, declined.dir, true);
  assertNoDangerousPush(declined.spy.calls);
});

test('the re-run reads the remote with one ls-remote of the person\'s branch, leaves its progress record at done, and a branch it cannot place gets the plain sentence only', async () => {
  const run = await codeOnlineDefaultOnState('rerun-reads');
  const ui = new FakeUi({ confirmDefault: false });
  ui.codePush = new FakeCodeOffer(run.events, { offer: true });
  const again = await rerun(run, ui);
  const listed = again.gitCalls.filter((args) => args.includes('ls-remote') && args.includes('--heads'));
  assert.equal(listed.length, 1);
  assert.ok(listed[0]?.includes(`refs/heads/${currentBranch(run.dir)}`));
  assert.equal((await readProgress(stateHomeFor(run.dir)))?.step, 'done');

  // A project that is not on a branch (or whose remote cannot be read) is not offered anything and not asked anything.
  fixtureGit(run.dir, ['checkout', '-q', '--detach']);
  fixtureGit(run.dir, ['commit', '-q', '--allow-empty', '-m', 'detached']);
  const detachedUi = new FakeUi({ confirmDefault: true });
  const detachedOffer = new FakeCodeOffer(run.events, { offer: true });
  detachedUi.codePush = detachedOffer;
  const detached = await rerun(run, detachedUi);
  assert.equal(detached.result.status, 'done');
  assert.deepEqual(detachedUi.defaultQuestions, []);
  assert.equal(detachedOffer.summaries.length, 0);
  assert.deepEqual(detachedUi.messages, ['This project already has an online home.']);
  assert.equal(patches(run).length, 0);
});
