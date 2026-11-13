// The separate offer to put the person's own code on their new online repository (D-14, SYNC-09). It is never part of turning sync on: it comes after,
// as its own question. Before anything goes up the person sees every file that would be pushed, and likely secrets block the push: secret file names
// (the repository's own rules), and content that looks like a key (scanSecrets and SECRET_TOKENS). A blocked file can be added to .gitignore, on the
// person's click, and a file git already tracks must be removed from git by them. The push is the person's ordinary one: their own git settings and
// hooks apply, nothing is forced. No vscode here.
import { spawn } from 'node:child_process';
import { appendFile, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { readScannable } from '../agent/cyberFiles';
import type { WorkspaceFile } from '../agent/cyberFiles';
import { scanSecrets } from '../agent/cyberProbes';
import { SECRET_TOKENS } from '../domain/redaction';
import type { Visibility } from '../domain/state/onlineHome';
import { GitNotFoundError, gitText, redactGitMessage } from './stateGit';
import type { GitRunner } from './stateGit';
import { classifyGitFailure } from './stateTransport';

// Ported from SECRET_FILE_PATTERNS and SECRET_FILE_EXCEPTIONS in scripts/lib/workflow.mjs (the repository's own secret scan). Keep the two lists in
// step: a test compares them.
const SECRET_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|\/)\.near-credentials\//,
  /(^|\/)[^/]+\.(p12|pfx|keystore)$/
];
const SECRET_FILE_EXCEPTIONS: readonly RegExp[] = [/(^|\/)\.env\.(example|sample|template)$/];

/** File names that should never be pushed, whatever they contain. `.env.example` and its siblings are fine. */
export function isSecretFileName(file: string): boolean {
  if (SECRET_FILE_EXCEPTIONS.some((pattern) => pattern.test(file))) return false;
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(file));
}

export interface CodePushBlock {
  file: string;
  /** Why it was blocked, in plain words, never with the value that matched. */
  reason: string;
  /** Git already tracks the file, so adding it to .gitignore would not keep it out. */
  tracked?: boolean;
}

export interface CodePushPlan {
  /** Every file that would go up: tracked, plus untracked and not ignored. Never anything in the NEAR AI state folder. */
  files: string[];
  blocked: CodePushBlock[];
  /** Files that could not be read as text (binary or very large), so they were not checked for secrets. */
  unchecked: string[];
}

export interface CodePushSummary {
  branch: string;
  remote: string;
  visibility: Visibility | 'unknown';
  files: string[];
  /** Extra plain lines to show with the list. */
  notes: string[];
}

export interface CodePushUi {
  message(text: string): void;
  /** The person's click on the list of files, after the check. */
  confirmPush(summary: CodePushSummary): Promise<boolean>;
  /** Add these files (not tracked by git) to .gitignore? */
  confirmIgnore(files: string[]): Promise<boolean>;
  /** Git has no name or email for this project: the person gives one, kept for this project only. */
  askIdentity(): Promise<{ name: string; email: string } | undefined>;
}

export type CodePushStatus = 'pushed' | 'declined' | 'blocked' | 'failed' | 'nothing';
export interface CodePushResult { status: CodePushStatus; message: string }
export interface CodePushOptions { ui: CodePushUi; visibility: Visibility | 'unknown' }

const STATE_FOLDER = '.near-ai/state/';
const NAME_REASON = 'The file name looks like a password, key or credential file.';
const PUBLIC_LINE = 'Everyone will be able to see these files.';
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PERSON_GIT_TIMEOUT_MS = 120_000;

/**
 * The person's own git, as they run it: their configuration and hooks apply (this push is their normal push). Array arguments, a timeout, no terminal
 * prompts, and the helper-transport protocol switched off. Text output is English so failures can be sorted.
 */
export const runPersonGit: GitRunner = (args, options = {}) => new Promise((resolve, reject) => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', ...options.env };
  const ownGroup = process.platform !== 'win32';
  const child = spawn('git', ['-c', 'protocol.ext.allow=never', ...args], { cwd: options.cwd, env, windowsHide: true, detached: ownGroup, stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let settled = false;
  const finish = (action: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); action(); };
  const timer = setTimeout(() => {
    try { if (ownGroup && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* already gone */ }
    finish(() => { child.stdout?.destroy(); child.stderr?.destroy(); resolve({ code: 124, stdout: Buffer.concat(out), stderr: 'git timed out' }); });
  }, options.timeoutMs ?? PERSON_GIT_TIMEOUT_MS);
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk));
  child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(error.code === 'ENOENT' ? new GitNotFoundError() : error)));
  child.on('close', (code) => finish(() => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') })));
  if (options.input !== undefined && child.stdin) {
    child.stdin.on('error', (error: Error) => err.push(Buffer.from(`stdin: ${error.message}\n`)));
    child.stdin.end(options.input);
  }
});

function nulList(text: Buffer): string[] {
  return text.toString('utf8').split('\0').filter((entry) => entry !== '');
}

/** The first line of git's own words, redacted, for a failure the person may be able to fix (a hook's message, a missing identity). */
function gitReason(stderr: string): string {
  const line = redactGitMessage(stderr).split('\n').map((text) => text.trim()).find((text) => text !== '') ?? '';
  return line === '' ? '' : ` Git said: ${line.slice(0, 200)}`;
}

/**
 * What would go up and what must not. Git decides the list (tracked plus untracked and not ignored), the state folder is left out whatever git says,
 * and each file is checked by name and then by content. A blocked file is reported once, with the first reason found.
 */
export async function planCodePush(root: string, git: GitRunner): Promise<CodePushPlan> {
  const tracked = await git(['-C', root, 'ls-files', '-z', '--cached']);
  const others = await git(['-C', root, 'ls-files', '-z', '--others', '--exclude-standard']);
  if (tracked.code !== 0 || others.code !== 0) throw new Error('Git could not list this project\'s files.');
  const trackedFiles = new Set(nulList(tracked.stdout));
  const files = [...new Set([...trackedFiles, ...nulList(others.stdout)])].filter((file) => trackedFiles.has(file) || !file.startsWith(STATE_FOLDER)).sort();
  const blocked = new Map<string, CodePushBlock>();
  const block = (file: string, reason: string): void => {
    if (!blocked.has(file)) blocked.set(file, { file, reason, ...(trackedFiles.has(file) ? { tracked: true } : {}) });
  };
  for (const file of files) {
    if (file.startsWith(STATE_FOLDER)) block(file, "NEAR AI's private state folder is never pushed as code.");
    else if (isSecretFileName(file)) block(file, NAME_REASON);
  }
  const candidates: WorkspaceFile[] = files.filter((file) => !blocked.has(file)).map((file) => ({ absolute: path.join(root, file), relative: file }));
  for (const hit of await scanSecrets(root, candidates)) block(hit.file, `It looks like it holds a secret: ${hit.pattern} (line ${hit.line}).`);
  const unchecked: string[] = [];
  const tokenShape = new RegExp(SECRET_TOKENS.source);
  for (const candidate of candidates) {
    const text = await readScannable(candidate);
    if (text === undefined) {
      if ((await stat(candidate.absolute).catch(() => undefined))?.isFile()) unchecked.push(candidate.relative);
      continue;
    }
    if (blocked.has(candidate.relative)) continue;
    const lines = text.split(/\r?\n/);
    const at = lines.findIndex((line) => line.length <= 4_000 && tokenShape.test(line));
    if (at >= 0) block(candidate.relative, `It looks like it holds a secret: a key or token (line ${at + 1}).`);
  }
  return { files, blocked: [...blocked.values()].sort((a, b) => a.file.localeCompare(b.file)), unchecked };
}

function ignoreLine(file: string): string {
  return `/${file.replace(/[\\*?[\]]/g, '\\$&').replace(/ $/, '\\ ')}`;
}

async function addToGitignore(root: string, files: readonly string[]): Promise<void> {
  const target = path.join(root, '.gitignore');
  const current = await readFile(target, 'utf8').catch(() => '');
  const prefix = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(target, `${prefix}${files.map(ignoreLine).join('\n')}\n`);
}

function blockedMessage(blocked: readonly CodePushBlock[]): string {
  const lines = blocked.map((entry) => `- ${entry.file}: ${entry.reason}`);
  const tracked = blocked.filter((entry) => entry.tracked).map((entry) => entry.file);
  const advice = tracked.length > 0
    ? `\n${tracked.join(', ')} ${tracked.length === 1 ? 'is' : 'are'} already tracked by git, so ignoring ${tracked.length === 1 ? 'it' : 'them'} is not enough. Remove ${tracked.length === 1 ? 'it' : 'them'} from git yourself (git rm --cached), then try again.`
    : '';
  return `These files look like secrets, so your code was not pushed:\n${lines.join('\n')}${advice}`;
}

/**
 * Commits and pushes the person's code, only after they have seen the list and clicked. Returns without changing anything while a likely secret is in
 * the list. The commit and the push are the person's own: their identity (or one they accept for this project), their hooks, no force option.
 */
export async function pushProjectCode(root: string, remote: string, git: GitRunner, options: CodePushOptions): Promise<CodePushResult> {
  const { ui } = options;
  if (!REMOTE_NAME.test(remote)) return { status: 'failed', message: 'That remote cannot be used, so your code was not pushed.' };
  let plan = await planCodePush(root, git);
  if (plan.blocked.length > 0) {
    const ignorable = plan.blocked.filter((entry) => !entry.tracked).map((entry) => entry.file);
    if (ignorable.length > 0 && await ui.confirmIgnore(ignorable)) {
      await addToGitignore(root, ignorable);
      plan = await planCodePush(root, git);
    }
    if (plan.blocked.length > 0) {
      ui.message(blockedMessage(plan.blocked));
      return { status: 'blocked', message: 'Your code was not pushed because some files look like secrets.' };
    }
  }
  const branchResult = await git(['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = branchResult.code === 0 ? gitText(branchResult) : '';
  if (branch === '') return { status: 'failed', message: 'Your project is not on a branch, so the code was not pushed. Switch to a branch and try again.' };
  if (plan.files.length === 0) return { status: 'nothing', message: 'There are no files to push yet.' };

  const notes: string[] = [];
  if (options.visibility === 'public') notes.push(PUBLIC_LINE);
  if (plan.unchecked.length > 0) notes.push(`${plan.unchecked.length} ${plan.unchecked.length === 1 ? 'file is' : 'files are'} too large or not text, so ${plan.unchecked.length === 1 ? 'it was' : 'they were'} not checked for secrets.`);
  if (!await ui.confirmPush({ branch, remote, visibility: options.visibility, files: plan.files, notes })) {
    return { status: 'declined', message: 'Your code was not pushed. Syncing is not affected.' };
  }

  // Their own identity, or one they accept for this project only.
  const name = await git(['-C', root, 'config', 'user.name']);
  const email = await git(['-C', root, 'config', 'user.email']);
  if (gitText(name) === '' || gitText(email) === '') {
    const identity = await ui.askIdentity();
    const given = { name: identity?.name.trim() ?? '', email: identity?.email.trim() ?? '' };
    if (given.name === '' || given.email === '' || /[\u0000-\u001f]/.test(given.name + given.email)) return { status: 'declined', message: 'Your code was not pushed. Syncing is not affected.' };
    await git(['-C', root, 'config', '--local', 'user.name', given.name]);
    await git(['-C', root, 'config', '--local', 'user.email', given.email]);
  }

  const staged = await git(['-C', root, 'add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: plan.files.join('\0'), env: { GIT_LITERAL_PATHSPECS: '1' } });
  if (staged.code !== 0) return { status: 'failed', message: `Git could not add your files, so nothing was pushed.${gitReason(staged.stderr)}` };
  if ((await git(['-C', root, 'diff', '--cached', '--quiet'])).code !== 0) {
    const committed = await git(['-C', root, 'commit', '-q', '-m', 'Add project files']);
    if (committed.code !== 0) return { status: 'failed', message: `Git could not save your files as a commit, so nothing was pushed.${gitReason(committed.stderr)}` };
  }
  if ((await git(['-C', root, 'rev-parse', '--verify', '-q', 'HEAD'])).code !== 0) return { status: 'nothing', message: 'There are no files to push yet.' };

  const pushed = await git(['-C', root, 'push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: PERSON_GIT_TIMEOUT_MS });
  if (pushed.code !== 0) {
    const failure = classifyGitFailure(pushed);
    const message = failure.kind === 'rejected'
      ? 'The online repository already has different files on this branch, so nothing was pushed. Nothing there was changed.'
      : `${failure.message} Your code was not pushed.`;
    return { status: 'failed', message };
  }
  return { status: 'pushed', message: `Your code is on ${remote} (${branch}).` };
}
