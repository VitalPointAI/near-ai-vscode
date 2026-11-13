// "Give this project an online home" (D-14): every test uses fakes (sign-in, the GitHub API, gh) and local bare repositories reached through a
// url.<path>.insteadOf rule, so nothing contacts GitHub, creates a real repository, runs the real gh or uses a real token.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VISIBILITY_NOTES } from '../domain/state/onlineHome';
import type { Visibility } from '../domain/state/onlineHome';
import { GitHubApiError, getRepo, isSafeBranchName, setDefaultBranch } from '../services/githubApi';
import type { FetchLike } from '../services/githubApi';
import type { CodePushSummary } from '../services/codePushCheck';
import { moveDefaultBranch, onlineHomeFlow, readProgress, systemGhCli } from '../services/onlineHome';
import type { CodePushOffer, GhCli, GhExec, GitHubAuth, OnlineHomeUi } from '../services/onlineHome';
import { stateHomeFor } from '../services/stateHome';
import type { GitRunner } from '../services/stateGit';
import { STATE_REF, StateTransport } from '../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, tempDirectory } from './helpers/gitFixtures';

const FAKE_TOKEN = 'gho_FAKE_TOKEN_1234567890';

interface ApiCall { url: string; method: string; headers: Record<string, string>; body?: string }

/** A GitHub that exists only in memory: it creates repositories under 'me', remembers them and their default branch, and accepts a default-branch PATCH. */
function fakeGitHub(options: { login?: string; existing?: string[]; defaultBranch?: string; events?: string[]; patch?: number | 'offline' } = {}): { fetchFn: FetchLike; calls: ApiCall[]; repos: Set<string>; defaultBranch: string | undefined } {
  const login = options.login ?? 'me';
  const repos = new Set<string>(options.existing ?? []);
  const calls: ApiCall[] = [];
  const reply = (status: number, body: unknown): { status: number; text(): Promise<string> } => ({ status, text: () => Promise.resolve(JSON.stringify(body)) });
  const repoAnswer = (name: string, isPrivate: boolean): Record<string, unknown> => {
    const answer: Record<string, unknown> = { name, owner: { login }, clone_url: `https://github.com/${login}/${name}.git`, private: isPrivate };
    if (github.defaultBranch !== undefined) answer.default_branch = github.defaultBranch;
    return answer;
  };
  const fetchFn: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    options.events?.push(`api:${init.method} ${url}`);
    if (init.method === 'POST' && url === 'https://api.github.com/user/repos') {
      const body = JSON.parse(init.body ?? '{}') as { name: string; private: boolean };
      if ([...repos].some((existing) => existing.toLowerCase() === body.name.toLowerCase())) {
        return Promise.resolve(reply(422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }));
      }
      repos.add(body.name);
      return Promise.resolve(reply(201, repoAnswer(body.name, body.private)));
    }
    const match = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(url);
    const found = match ? [...repos].find((existing) => existing.toLowerCase() === (match[2] ?? '').toLowerCase()) : undefined;
    if (init.method === 'GET' && match) {
      return Promise.resolve(found ? reply(200, repoAnswer(found, true)) : reply(404, { message: 'Not Found' }));
    }
    if (init.method === 'PATCH' && match && found) {
      if (options.patch === 'offline') return Promise.reject(new TypeError('fetch failed'));
      if (options.patch !== undefined) return Promise.resolve(reply(options.patch, { message: 'refused' }));
      github.defaultBranch = (JSON.parse(init.body ?? '{}') as { default_branch: string }).default_branch;
      return Promise.resolve(reply(200, repoAnswer(found, true)));
    }
    return Promise.resolve(reply(404, { message: 'Not Found' }));
  };
  const github = { fetchFn, calls, repos, defaultBranch: options.defaultBranch };
  return github;
}

class FakeUi implements OnlineHomeUi {
  public codePush?: CodePushOffer;
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

/** `null` stands for a person who closed the sign-in without allowing it. */
function fakeAuth(token: string | null = FAKE_TOKEN, available = true): GitHubAuth & { tokenCalls: number } {
  const auth = { tokenCalls: 0, available: () => Promise.resolve(available), token: () => { auth.tokenCalls += 1; return Promise.resolve(token ?? undefined); } };
  return auth;
}

/** Records every git call (arguments only) and passes it on to the hermetic runner. */
function spyGit(events?: string[]): { git: GitRunner; calls: string[][]; envs: Array<Record<string, string>> } {
  const inner = hermeticRunner();
  const calls: string[][] = [];
  const envs: Array<Record<string, string>> = [];
  return {
    calls,
    envs,
    git: (args, options) => {
      calls.push(args);
      envs.push({ ...options?.env });
      if (events && args.includes('push')) events.push(`git:${args.join(' ')}`);
      return inner(args, options);
    }
  };
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

class FakeCodeOffer implements CodePushOffer {
  public readonly events: string[];
  public readonly summaries: CodePushSummary[] = [];
  public constructor(events: string[], private readonly answers: { offer: boolean; push?: boolean }) { this.events = events; }
  public offer(): Promise<boolean> { this.events.push('offer'); return Promise.resolve(this.answers.offer); }
  public message(): void { /* not needed */ }
  public confirmPush(summary: CodePushSummary): Promise<boolean> { this.events.push('confirm-push'); this.summaries.push(summary); return Promise.resolve(this.answers.push ?? true); }
  public historyBlocked(): Promise<void> { return Promise.resolve(); }
  public confirmUnscannedHistory(): Promise<boolean> { return Promise.resolve(false); }
  public confirmIgnore(): Promise<boolean> { return Promise.resolve(false); }
  public askIdentity(): Promise<{ name: string; email: string } | undefined> { return Promise.resolve({ name: 'Pat', email: 'pat@example.test' }); }
}

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

const DEFAULT_STATE_BRANCH = 'near-ai/state';

/** The folder's current branch: the one the person's code push put online. */
function currentBranch(dir: string): string {
  return fixtureGit(dir, ['symbolic-ref', '--short', 'HEAD']).trim();
}

function remoteRefs(bare: string): string[] {
  return fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).split('\n').filter((ref) => ref !== '').sort();
}

/** The bare remote holds the sync branch and, when the code was pushed, the person's branch, and nothing else. */
function assertOnlyOurRefs(bare: string, dir: string, codePushed: boolean): void {
  const expected = [STATE_REF, ...(codePushed ? [`refs/heads/${currentBranch(dir)}`] : [])].sort();
  assert.deepEqual(remoteRefs(bare), expected);
}

/** No push the flow made forces, mirrors or deletes, and none names a refspec that starts with '+' or ':'. */
function assertNoDangerousPush(calls: string[][]): void {
  for (const args of calls.filter((entry) => entry.includes('push'))) {
    for (const arg of args) {
      assert.ok(!['--force', '--force-with-lease', '-f', '--mirror', '--delete'].includes(arg), `${args.join(' ')} forces or deletes`);
      assert.ok(!/^[+:]/.test(arg), `${args.join(' ')} has a refspec starting with + or :`);
    }
  }
}

interface CodeRun { dir: string; bare: string; github: ReturnType<typeof fakeGitHub>; ui: FakeUi; spy: ReturnType<typeof spyGit>; events: string[]; result: Awaited<ReturnType<typeof onlineHomeFlow>>; token: string | undefined }

/**
 * One online-home run on a local bare remote: the sync branch is pushed with StateTransport (as the real turn-on flow does), then the code offer is
 * answered as given. `route` picks how the token is obtained; 'url' pastes the address of the empty bare remote and involves no token at all.
 */
async function codeRun(name: string, options: {
  route?: 'vscode' | 'gh' | 'url'; defaultBranch?: string; patch?: number | 'offline'; offer?: boolean; push?: boolean;
  files?: Record<string, string>; hook?: string; remoteHeadAfterSync?: 'state' | 'person'; defaultAfterSync?: 'person';
}): Promise<CodeRun> {
  const route = options.route ?? 'vscode';
  const dir = await projectFolder(name);
  const bare = bareRemote({ withMain: false });
  for (const [file, text] of Object.entries(options.files ?? { 'app.ts': 'export {};\n' })) writeFileSync(path.join(dir, file), text);
  if (options.hook !== undefined) {
    const hook = path.join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, options.hook, { mode: 0o755 });
  }
  const events: string[] = [];
  // gh makes the repository itself, so the fake GitHub is told it exists; with the VS Code route the flow creates it through the fake.
  const github = fakeGitHub({ defaultBranch: options.defaultBranch, events, patch: options.patch, existing: route === 'gh' ? [name] : undefined });
  const ui = new FakeUi({ visibility: 'private', fallback: route === 'gh' ? 'gh' : 'url', urls: route === 'url' ? ['https://github.com/me/pasted.git'] : [] });
  ui.codePush = new FakeCodeOffer(events, { offer: options.offer ?? true, push: options.push ?? true });
  const spy = spyGit(events);
  const paths = await mirrorPaths();
  if (route === 'url') initWithMapping(dir, { 'https://github.com/me/pasted.git': bare });
  const result = await onlineHomeFlow({
    root: dir,
    ui,
    auth: fakeAuth(FAKE_TOKEN, route === 'vscode'),
    gh: route === 'gh' ? fakeGh() : undefined,
    fetchFn: github.fetchFn,
    git: spy.git,
    personGit: spy.git,
    afterRemote: async (remote) => {
      fixtureGit(dir, ['config', `url.${bare}.insteadOf`, remote.url]);
      const transport = new StateTransport({ root: dir, remote: remote.name, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: remote.git });
      const pushed = (await transport.push(await transport.writeCommit([{ name: 'manifest.json', data: '{}' }]))).ok;
      // GitHub's own behaviour, stood in for on a local remote: a bare remote's HEAD is its default branch.
      if (options.remoteHeadAfterSync === 'state') fixtureGit(bare, ['symbolic-ref', 'HEAD', STATE_REF]);
      if (options.remoteHeadAfterSync === 'person') fixtureGit(bare, ['symbolic-ref', 'HEAD', `refs/heads/${currentBranch(dir)}`]);
      if (options.defaultAfterSync === 'person') github.defaultBranch = currentBranch(dir);
      return pushed;
    }
  });
  return { dir, bare, github, ui, spy, events, result, token: route === 'url' ? undefined : FAKE_TOKEN };
}

const patches = (run: CodeRun): ApiCall[] => run.github.calls.filter((call) => call.method === 'PATCH');

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
