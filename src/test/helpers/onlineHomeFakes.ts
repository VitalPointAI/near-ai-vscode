// Fakes shared by the online-home tests (the setup flow and the later code push): an in-memory GitHub, sign-in, gh and code-push dialogs, plus local bare
// repositories reached through a url.<path>.insteadOf rule, so nothing contacts GitHub, creates a real repository or uses a real token.
import assert from 'node:assert/strict';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Visibility } from '../../domain/state/onlineHome';
import { GitHubApiError } from '../../services/githubApi';
import type { FetchLike } from '../../services/githubApi';
import type { CodePushSummary } from '../../services/codePushCheck';
import { onlineHomeFlow } from '../../services/onlineHome';
import type { CodePushOffer, GhCli, GitHubAuth, OnlineHomeUi } from '../../services/onlineHome';
import type { GitRunner } from '../../services/stateGit';
import { STATE_REF, StateTransport } from '../../services/stateTransport';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, tempDirectory } from './gitFixtures';

export const FAKE_TOKEN = 'gho_FAKE_TOKEN_1234567890';

export interface ApiCall { url: string; method: string; headers: Record<string, string>; body?: string }

/** A GitHub that exists only in memory: it creates repositories under 'me', remembers them and their default branch, and accepts a default-branch PATCH. */
export function fakeGitHub(options: { login?: string; existing?: string[]; defaultBranch?: string; events?: string[]; patch?: number | 'offline' } = {}): { fetchFn: FetchLike; calls: ApiCall[]; repos: Set<string>; defaultBranch: string | undefined } {
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

export class FakeUi implements OnlineHomeUi {
  public codePush?: CodePushOffer;
  public readonly messages: string[] = [];
  public readonly steps: string[] = [];
  public readonly visibilityNotes: Array<Readonly<Record<Visibility, string>>> = [];
  public readonly nameCalls: Array<{ suggested: string; problem?: string }> = [];
  public readonly fallbackCalls: Array<{ gh: boolean }> = [];
  public readonly urlProblems: Array<string | undefined> = [];
  public startCalls = 0;
  /** The branches the person was asked to make the default. Only present when the test gives an answer: a ui without the question is a valid ui. */
  public readonly defaultQuestions: string[] = [];
  public confirmDefaultBranch?: (branch: string) => Promise<boolean>;
  public constructor(private readonly answers: { start?: boolean; visibility?: Visibility; names?: Array<string | undefined>; fallback?: 'gh' | 'url'; urls?: Array<string | undefined>; confirmDefault?: boolean } = {}) {
    const confirm = answers.confirmDefault;
    if (confirm !== undefined) this.confirmDefaultBranch = (branch) => { this.defaultQuestions.push(branch); return Promise.resolve(confirm); };
  }
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
export function fakeAuth(token: string | null = FAKE_TOKEN, available = true): GitHubAuth & { tokenCalls: number } {
  const auth = { tokenCalls: 0, available: () => Promise.resolve(available), token: () => { auth.tokenCalls += 1; return Promise.resolve(token ?? undefined); } };
  return auth;
}

/** Records every git call (arguments only) and passes it on to the hermetic runner. */
export function spyGit(events?: string[]): { git: GitRunner; calls: string[][]; envs: Array<Record<string, string>> } {
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
export function fakeGh(options: { available?: boolean; signedIn?: boolean; token?: string; login?: string; taken?: string[] } = {}): GhCli & { calls: string[][] } {
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

export function allFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(full));
    else if (statSync(full).isFile()) found.push(full);
  }
  return found;
}

export async function projectFolder(name = 'My Project!'): Promise<string> {
  const base = await tempDirectory('near-ai-home-');
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A repository folder that already exists, with the GitHub address of `url` mapped to a local bare repository, as the person's own git config could. */
export function initWithMapping(dir: string, mappings: Record<string, string>): void {
  fixtureGit(dir, ['init', '-q']);
  for (const [url, bare] of Object.entries(mappings)) fixtureGit(dir, ['config', `url.${bare}.insteadOf`, url]);
}

export class FakeCodeOffer implements CodePushOffer {
  public readonly events: string[];
  public readonly summaries: CodePushSummary[] = [];
  /** Every sentence the code-push step told, in order. */
  public readonly messages: string[] = [];
  public constructor(events: string[], private readonly answers: { offer: boolean; push?: boolean }) { this.events = events; }
  public offer(): Promise<boolean> { this.events.push('offer'); return Promise.resolve(this.answers.offer); }
  public message(text: string): void { this.messages.push(text); }
  public confirmPush(summary: CodePushSummary): Promise<boolean> { this.events.push('confirm-push'); this.summaries.push(summary); return Promise.resolve(this.answers.push ?? true); }
  public historyBlocked(): Promise<void> { return Promise.resolve(); }
  public confirmUnscannedHistory(): Promise<boolean> { return Promise.resolve(false); }
  public confirmIgnore(): Promise<boolean> { return Promise.resolve(false); }
  public askIdentity(): Promise<{ name: string; email: string } | undefined> { return Promise.resolve({ name: 'Pat', email: 'pat@example.test' }); }
}

export const DEFAULT_STATE_BRANCH = 'near-ai/state';

/** The folder's current branch: the one the person's code push put online. */
export function currentBranch(dir: string): string {
  return fixtureGit(dir, ['symbolic-ref', '--short', 'HEAD']).trim();
}

export function remoteRefs(bare: string): string[] {
  return fixtureGit(bare, ['for-each-ref', '--format=%(refname)']).split('\n').filter((ref) => ref !== '').sort();
}

/** The bare remote holds the sync branch and, when the code was pushed, the person's branch, and nothing else. */
export function assertOnlyOurRefs(bare: string, dir: string, codePushed: boolean): void {
  const expected = [STATE_REF, ...(codePushed ? [`refs/heads/${currentBranch(dir)}`] : [])].sort();
  assert.deepEqual(remoteRefs(bare), expected);
}

/** No push the flow made forces, mirrors or deletes, and none names a refspec that starts with '+' or ':'. */
export function assertNoDangerousPush(calls: string[][]): void {
  for (const args of calls.filter((entry) => entry.includes('push'))) {
    for (const arg of args) {
      assert.ok(!['--force', '--force-with-lease', '-f', '--mirror', '--delete'].includes(arg), `${args.join(' ')} forces or deletes`);
      assert.ok(!/^[+:]/.test(arg), `${args.join(' ')} has a refspec starting with + or :`);
    }
  }
}

export interface CodeRun { dir: string; bare: string; github: ReturnType<typeof fakeGitHub>; ui: FakeUi; spy: ReturnType<typeof spyGit>; events: string[]; result: Awaited<ReturnType<typeof onlineHomeFlow>>; token: string | undefined }

/**
 * One online-home run on a local bare remote: the sync branch is pushed with StateTransport (as the real turn-on flow does), then the code offer is
 * answered as given. `route` picks how the token is obtained; 'url' pastes the address of the empty bare remote and involves no token at all.
 */
export async function codeRun(name: string, options: {
  route?: 'vscode' | 'gh' | 'url'; defaultBranch?: string; patch?: number | 'offline'; offer?: boolean; push?: boolean;
  files?: Record<string, string>; hook?: string; remoteHeadAfterSync?: 'state' | 'person'; defaultAfterSync?: 'person'; visibility?: Visibility;
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
  const ui = new FakeUi({ visibility: options.visibility ?? 'private', fallback: route === 'gh' ? 'gh' : 'url', urls: route === 'url' ? ['https://github.com/me/pasted.git'] : [] });
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

export const patches = (run: CodeRun): ApiCall[] => run.github.calls.filter((call) => call.method === 'PATCH');
