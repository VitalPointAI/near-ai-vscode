// "Give this project an online home" (D-14): every test uses fakes (sign-in, the GitHub API, gh) and local bare repositories reached through a
// url.<path>.insteadOf rule, so nothing contacts GitHub, creates a real repository, runs the real gh or uses a real token.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VISIBILITY_NOTES } from '../domain/state/onlineHome';
import type { Visibility } from '../domain/state/onlineHome';
import { GitHubApiError } from '../services/githubApi';
import type { FetchLike } from '../services/githubApi';
import { onlineHomeFlow, readProgress, systemGhCli } from '../services/onlineHome';
import type { GhCli, GhExec, GitHubAuth, OnlineHomeUi } from '../services/onlineHome';
import { stateHomeFor } from '../services/stateHome';
import type { GitRunner } from '../services/stateGit';
import { STATE_REF, StateTransport } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, tempDirectory } from './helpers/gitFixtures';

const FAKE_TOKEN = 'gho_FAKE_TOKEN_1234567890';

interface ApiCall { url: string; method: string; headers: Record<string, string>; body?: string }

/** A GitHub that exists only in memory: it creates repositories under 'me' and remembers them. */
function fakeGitHub(options: { login?: string; existing?: string[] } = {}): { fetchFn: FetchLike; calls: ApiCall[]; repos: Set<string> } {
  const login = options.login ?? 'me';
  const repos = new Set<string>(options.existing ?? []);
  const calls: ApiCall[] = [];
  const reply = (status: number, body: unknown): { status: number; text(): Promise<string> } => ({ status, text: () => Promise.resolve(JSON.stringify(body)) });
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === 'POST' && url === 'https://api.github.com/user/repos') {
      const body = JSON.parse(init.body ?? '{}') as { name: string; private: boolean };
      if ([...repos].some((existing) => existing.toLowerCase() === body.name.toLowerCase())) {
        return Promise.resolve(reply(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }));
      }
      repos.add(body.name);
      return Promise.resolve(reply(201, { name: body.name, owner: { login }, clone_url: `https://github.com/${login}/${body.name}.git`, private: body.private }));
    }
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
    if (init.method === 'GET' && match) {
      const found = [...repos].find((existing) => existing.toLowerCase() === (match[2] ?? '').toLowerCase());
      return Promise.resolve(found ? reply(200, { name: found, owner: { login }, clone_url: `https://github.com/${login}/${found}.git`, private: true }) : reply(404, { message: 'Not Found' }));
    }
    return Promise.resolve(reply(404, { message: 'Not Found' }));
  };
  return { fetchFn, calls, repos };
}

class FakeUi implements OnlineHomeUi {
  public readonly messages: string[] = [];
  public readonly steps: string[] = [];
  public readonly visibilityNotes: Array<Readonly<Record<Visibility, string>>> = [];
  public readonly nameCalls: Array<{ suggested: string; problem?: string }> = [];
  public readonly fallbackCalls: Array<{ gh: boolean }> = [];
  public readonly urlProblems: Array<string | undefined> = [];
  public startCalls = 0;
  public constructor(private readonly answers: { start?: boolean; visibility?: Visibility; names?: Array<string | undefined>; fallback?: 'gh' | 'url'; urls?: Array<string | undefined> } = {}) {}
  public pickFallback(choices: { gh: boolean }): Promise<'gh' | 'url' | undefined> { this.fallbackCalls.push(choices); return Promise.resolve(this.answers.fallback); }
  public askRepoUrl(problem?: string): Promise<string | undefined> { this.urlProblems.push(problem); return Promise.resolve(this.answers.urls?.shift()); }
  public confirmStart(): Promise<boolean> { this.startCalls += 1; return Promise.resolve(this.answers.start ?? true); }
  public progress(message: string): void { this.steps.push(message); }
  public message(text: string): void { this.messages.push(text); }
  public pickVisibility(notes: Readonly<Record<Visibility, string>>): Promise<Visibility | undefined> {
    this.visibilityNotes.push(notes);
    return Promise.resolve('visibility' in this.answers ? this.answers.visibility : 'private');
  }
  public askName(suggested: string, problem?: string): Promise<string | undefined> {
    this.nameCalls.push({ suggested, problem });
    if (this.answers.names && this.answers.names.length > 0) return Promise.resolve(this.answers.names.shift());
    return Promise.resolve(suggested);
  }
}

function fakeAuth(token: string | undefined = FAKE_TOKEN, available = true): GitHubAuth & { tokenCalls: number } {
  const auth = { tokenCalls: 0, available: () => Promise.resolve(available), token: () => { auth.tokenCalls += 1; return Promise.resolve(token); } };
  return auth;
}

/** Records every git call (arguments only) and passes it on to the hermetic runner. */
function spyGit(): { git: GitRunner; calls: string[][]; envs: Array<Record<string, string>> } {
  const inner = hermeticRunner();
  const calls: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  return { calls, envs, git: (args, options) => { calls.push(args); envs.push({ ...options?.env }); return inner(args, options); } };
}

/** A gh that exists only in memory. It remembers what it was asked and refuses a name that is taken. */
function fakeGh(options: { available?: boolean; signedIn?: boolean; token?: string; login?: string; taken?: string[] } = {}): GhCli & { calls: string[][] } {
  const taken = new Set(options.taken ?? []);
  const calls: string[][] = [];
  return {
    calls,
    available: () => Promise.resolve(options.available ?? true),
    signedIn: () => Promise.resolve(options.signedIn ?? true),
    token: () => Promise.resolve('token' in options ? options.token : FAKE_TOKEN),
    createRepo: (name, visibility) => {
      calls.push(['repo', 'create', name, `--${visibility}`]);
      if (taken.has(name)) return Promise.reject(new GitHubApiError('name-taken'));
      taken.add(name);
      return Promise.resolve({ owner: options.login ?? 'me', name });
    }
  };
}

const NOT_AVAILABLE = 'GitHub sign-in is not available in this editor.';
const NAME_TAKEN = 'A repository with that name already exists on your account. Choose another name.';
const NOT_ALLOWED = 'GitHub did not allow creating the repository. Sign in again and allow repository access.';
const OFFLINE = 'Could not reach GitHub. Check your internet connection and try again; your progress is saved.';
const NOT_EMPTY = 'That repository is not empty. Paste the address of a new, empty repository.';
const BAD_ADDRESS = 'That address cannot be used. Paste the address of a repository, for example https://github.com/you/project.git.';
const HAS_SECRET = 'Paste the address without a password or token in it.';
const BAD_NAME = 'That name cannot be used. Use letters, numbers, dots, dashes and underscores.';

function allFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(full));
    else if (statSync(full).isFile()) found.push(full);
  }
  return found;
}

async function projectFolder(name = 'My Project!'): Promise<string> {
  const base = await tempDirectory('near-ai-home-');
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

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

/** A repository folder that already exists, with the GitHub address of `url` mapped to a local bare repository, as the person's own git config could. */
function initWithMapping(dir: string, mappings: Record<string, string>): void {
  fixtureGit(dir, ['init', '-q']);
  for (const [url, bare] of Object.entries(mappings)) fixtureGit(dir, ['config', `url.${bare}.insteadOf`, url]);
}

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
    [await projectFolder('closed'), undefined, fakeAuth(undefined)]
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
  try {
    for (const route of ['vscode', 'gh'] as const) {
      const dir = await projectFolder(`hygiene-${route}`);
      const bare = bareRemote({ withMain: false });
      const github = fakeGitHub();
      const ui = new FakeUi({ fallback: 'gh' });
      const spy = spyGit();
      const result = await onlineHomeFlow({
        root: dir,
        ui,
        auth: fakeAuth(FAKE_TOKEN, route === 'vscode'),
        gh: fakeGh(),
        fetchFn: github.fetchFn,
        git: spy.git,
        afterRemote: async (remote) => {
          fixtureGit(dir, ['config', `url.${bare}.insteadOf`, remote.url]);
          const paths = await mirrorPaths();
          folders.push(paths.base);
          const transport = new StateTransport({ root: dir, remote: remote.name, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: remote.git });
          return (await transport.push(await transport.writeCommit([{ name: 'manifest.json', data: '{}' }]))).ok;
        }
      });
      assert.equal(result.status, 'done');
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
