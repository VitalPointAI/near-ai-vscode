// "Give this project an online home" (D-14): every test uses fakes (sign-in, the GitHub API, gh) and local bare repositories reached through a
// url.<path>.insteadOf rule, so nothing contacts GitHub, creates a real repository, runs the real gh or uses a real token.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { VISIBILITY_NOTES } from '../domain/state/onlineHome';
import type { Visibility } from '../domain/state/onlineHome';
import type { FetchLike } from '../services/githubApi';
import { onlineHomeFlow } from '../services/onlineHome';
import type { GitHubAuth, OnlineHomeUi } from '../services/onlineHome';
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
  public startCalls = 0;
  public constructor(private readonly answers: { start?: boolean; visibility?: Visibility; names?: Array<string | undefined> } = {}) {}
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
function spyGit(): { git: GitRunner; calls: string[][] } {
  const inner = hermeticRunner();
  const calls: string[][] = [];
  return { calls, git: (args, options) => { calls.push(args); return inner(args, options); } };
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
