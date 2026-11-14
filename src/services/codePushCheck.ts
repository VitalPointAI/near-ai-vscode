// The separate offer to put the person's own code on their new online repository (D-14, SYNC-09). It is never part of turning sync on: it comes after,
// as its own question. Before anything goes up the person sees every file that would be pushed, and likely secrets block the push: secret file names
// (the repository's own rules), and content that looks like a key (scanSecrets and SECRET_TOKENS). A blocked file can be added to .gitignore, on the
// person's click, and a file git already tracks must be removed from git by them. The push is the person's ordinary one: their own git settings and
// hooks apply, nothing is forced. The check also covers the history the push would publish (every commit not already online): a secret that was
// saved once and deleted later still goes up with the branch. No vscode here.
import { spawn } from 'node:child_process';
import { appendFile, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { MAX_SCANNABLE_BYTES, readScannable, scannableText } from '../agent/cyberFiles';
import type { WorkspaceFile } from '../agent/cyberFiles';
import { scanSecrets, scanSecretText } from '../agent/cyberProbes';
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
  /** Every file that would go up: tracked, plus untracked and not ignored. Never anything in the NEAR AI state folder, and no untracked NEAR AI record. */
  files: string[];
  /** NEAR AI's own records (account, runs, costs) that git does not track: left off the list and kept on this computer. Paths from the project root, sorted. */
  heldBack: string[];
  /** NEAR AI's own records that git already tracks: the push cannot keep them off (they are in git and its history), so they stay on the list and are named. Sorted. */
  trackedPrivate: string[];
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

/** A secret found in a commit that the push would publish. Never carries the value. */
export interface HistoryHit {
  /** The path of the file in that commit, or undefined for the commit message. */
  file?: string;
  /** The short id of the commit. */
  commit: string;
  reason: string;
}

export interface HistoryLimits { maxCommits: number; maxBytes: number }

export interface HistoryScan {
  /** How many commits were checked. */
  commits: number;
  hits: HistoryHit[];
  /** False when a limit was reached or git could not list the history: the rest was not checked. */
  complete: boolean;
  /** Why it is not complete, in plain words. */
  incompleteReason?: string;
  /** Files in earlier commits that could not be read as text (binary or very large). */
  unchecked: string[];
}

export interface CodePushUi {
  message(text: string): void;
  /** A secret is in the history that the push would publish. Shown as a plain notice; the only choice is not to push. */
  historyBlocked(text: string): Promise<void>;
  /** The history was too large to check fully. True only when the person goes on knowing that. */
  confirmUnscannedHistory(text: string): Promise<boolean>;
  /** The person's click on the list of files, after the check. */
  confirmPush(summary: CodePushSummary): Promise<boolean>;
  /** Add these files (not tracked by git) to .gitignore? */
  confirmIgnore(files: string[]): Promise<boolean>;
  /** Git has no name or email for this project: the person gives one, kept for this project only. */
  askIdentity(): Promise<{ name: string; email: string } | undefined>;
}

export type CodePushStatus = 'pushed' | 'declined' | 'blocked' | 'failed' | 'nothing';
export interface CodePushResult { status: CodePushStatus; message: string }
export interface CodePushOptions { ui: CodePushUi; visibility: Visibility | 'unknown'; historyLimits?: Partial<HistoryLimits> }

const STATE_FOLDER = '.near-ai/state/';
/** NEAR AI's folder inside the project. Per-person and per-run records live here next to the project's shared configuration (G-27-6c). */
export const NEAR_AI_PROJECT_FOLDER = '.planning/.near-ai/';
/**
 * The only files in NEAR_AI_PROJECT_FOLDER that describe the project for everyone working on it, so they go up with the code. Everything else there (the
 * person's organization and profiles, activity, audit, costs, resume points, generated media, reputation, per-machine state), and any file a later release
 * adds, stays on this computer: the list fails closed. A test keeps it in step with the files the extension writes.
 */
export const SHARED_PROJECT_FILES: readonly string[] = ['team.md', 'project.json', 'verifiers.json'];
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

/** True for a path under NEAR AI's project folder that is not exactly one of the shared configuration files. The folder is matched as an exact prefix. */
function isNearAiPrivateRecord(file: string): boolean {
  if (!file.startsWith(NEAR_AI_PROJECT_FOLDER)) return false;
  return !SHARED_PROJECT_FILES.includes(file.slice(NEAR_AI_PROJECT_FOLDER.length));
}

/**
 * What would go up and what must not. Git decides the list (tracked plus untracked and not ignored), the state folder is left out whatever git says,
 * NEAR AI's own records in the project folder are held back unless they are shared configuration, and each file is checked by name and then by content.
 * A blocked file is reported once, with the first reason found.
 */
export async function planCodePush(root: string, git: GitRunner): Promise<CodePushPlan> {
  const tracked = await git(['-C', root, 'ls-files', '-z', '--cached']);
  const others = await git(['-C', root, 'ls-files', '-z', '--others', '--exclude-standard']);
  if (tracked.code !== 0 || others.code !== 0) throw new Error('Git could not list this project\'s files.');
  const trackedFiles = new Set(nulList(tracked.stdout));
  const listed = [...new Set([...trackedFiles, ...nulList(others.stdout)])].filter((file) => trackedFiles.has(file) || !file.startsWith(STATE_FOLDER)).sort();
  const heldBack = listed.filter((file) => !trackedFiles.has(file) && isNearAiPrivateRecord(file));
  const files = listed.filter((file) => !heldBack.includes(file));
  const trackedPrivate = files.filter((file) => trackedFiles.has(file) && isNearAiPrivateRecord(file));
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
  return { files, heldBack, trackedPrivate, blocked: [...blocked.values()].sort((a, b) => a.file.localeCompare(b.file)), unchecked };
}

const SHORT_ID = 7;
const HISTORY_LIMITS: HistoryLimits = { maxCommits: 5_000, maxBytes: 200 * 1024 * 1024 };
const BATCH_BYTES = 16 * 1024 * 1024;
const MAX_UNCHECKED_LISTED = 200;
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NO_BLOB = /^0+$/;

/** Why a file's text looks like it holds a secret, in the same words as the working-tree check, or undefined. Never the value. */
function contentReason(file: string, text: string): string | undefined {
  const hit = scanSecretText(file, text)[0];
  if (hit) return `It looks like it holds a secret: ${hit.pattern} (line ${hit.line}).`;
  const tokenShape = new RegExp(SECRET_TOKENS.source);
  const at = text.split(/\r?\n/).findIndex((line) => line.length <= 4_000 && tokenShape.test(line));
  return at >= 0 ? `It looks like it holds a secret: a key or token (line ${at + 1}).` : undefined;
}

interface HistoryEntry { commit: string; file: string; blob: string }

/** The files each commit adds or changes: `diff-tree` in NUL form, without rename detection. A commit id token starts a commit, `:` starts an entry, then its path. */
function parseDiffTree(output: Buffer): HistoryEntry[] {
  const tokens = output.toString('utf8').split('\0');
  const entries: HistoryEntry[] = [];
  let commit = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith(':')) {
      const [, newMode = '', , newBlob = '', status = ''] = token.slice(1).split(' ');
      const file = tokens[index + 1] ?? '';
      index += 1;
      if (commit !== '' && file !== '' && !status.startsWith('D') && newMode !== '160000' && !NO_BLOB.test(newBlob)) entries.push({ commit, file, blob: newBlob });
    } else if (COMMIT_ID.test(token)) commit = token;
  }
  return entries;
}

/**
 * Checks everything the push would publish besides the working tree: every commit reachable from `ref` that no remote-tracking ref of `remote` has
 * (the whole history for a new online repository). For each commit: the file names it adds or changes, the content of those files (the working-tree
 * rules), and its message. Bounded by commit count and by text read. Only git commands through the person's runner, no network.
 */
export async function scanHistory(root: string, ref: string, remote: string, git: GitRunner, limits: Partial<HistoryLimits> = {}): Promise<HistoryScan> {
  const max: HistoryLimits = { ...HISTORY_LIMITS, ...limits };
  const base = ['-C', root];
  const scan: HistoryScan = { commits: 0, hits: [], complete: true, unchecked: [] };
  const incomplete = (reason: string): void => { scan.complete = false; scan.incompleteReason ??= reason; };
  if ((await git([...base, 'rev-parse', '--verify', '-q', `${ref}^{commit}`])).code !== 0) return scan;
  const listed = await git([...base, 'rev-list', '-n', String(max.maxCommits + 1), ref, '--not', `--remotes=${remote}`]);
  if (listed.code !== 0) { incomplete('git could not list the earlier commits'); return scan; }
  let ids = listed.stdout.toString('utf8').split('\n').filter((id) => COMMIT_ID.test(id));
  if (ids.length > max.maxCommits) { ids = ids.slice(0, max.maxCommits); incomplete(`it has more than ${max.maxCommits} commits that are not online yet, and only the newest ${max.maxCommits} were checked`); }
  ids.reverse(); // oldest first, so a finding names the commit that introduced it
  scan.commits = ids.length;
  if (ids.length === 0) return scan;
  const short = (id: string): string => id.slice(0, SHORT_ID);
  const input = `${ids.join('\n')}\n`;
  const found = new Set<string>();
  const addHit = (hit: HistoryHit): void => {
    const key = hit.file ?? `message:${hit.commit}`;
    if (found.has(key)) return;
    found.add(key);
    scan.hits.push(hit);
  };

  // Commit messages.
  const messages = await git([...base, 'log', '--no-walk=unsorted', '--stdin', '-z', '--format=%H%n%B'], { input });
  if (messages.code !== 0) incomplete('git could not read the commit messages');
  else {
    const tokenShape = new RegExp(SECRET_TOKENS.source);
    for (const record of messages.stdout.toString('utf8').split('\0')) {
      const lines = record.split(/\r?\n/);
      const id = (lines.shift() ?? '').trim();
      if (!COMMIT_ID.test(id)) continue;
      if (lines.some((line) => line.length <= 4_000 && tokenShape.test(line))) addHit({ commit: short(id), reason: 'The commit message looks like it holds a key or token.' });
    }
  }

  // File names, then content.
  const changed = await git([...base, 'diff-tree', '--stdin', '-r', '-z', '--root', '-m', '--no-renames'], { input });
  if (changed.code !== 0) { incomplete('git could not list what each commit changed'); return scan; }
  const entries = parseDiffTree(changed.stdout);
  const byBlob = new Map<string, HistoryEntry[]>();
  const seenEntry = new Set<string>();
  for (const entry of entries) {
    const key = `${entry.blob}\0${entry.file}`;
    if (seenEntry.has(key)) continue;
    seenEntry.add(key);
    if (entry.file.startsWith(STATE_FOLDER)) { addHit({ file: entry.file, commit: short(entry.commit), reason: "NEAR AI's private state folder is never pushed as code." }); continue; }
    if (isSecretFileName(entry.file)) { addHit({ file: entry.file, commit: short(entry.commit), reason: NAME_REASON }); continue; }
    byBlob.set(entry.blob, [...byBlob.get(entry.blob) ?? [], entry]);
  }
  const blobs = [...byBlob.keys()];
  const sizes = new Map<string, number>();
  if (blobs.length > 0) {
    const checked = await git([...base, 'cat-file', '--batch-check'], { input: `${blobs.join('\n')}\n` });
    if (checked.code !== 0) { incomplete('git could not read the files in earlier commits'); return scan; }
    for (const line of checked.stdout.toString('utf8').split('\n')) {
      const [id, type, size] = line.split(' ');
      if (id && type === 'blob' && size !== undefined) sizes.set(id, Number(size));
    }
  }
  const unchecked = new Set<string>();
  const readable: string[] = [];
  for (const blob of blobs) {
    const size = sizes.get(blob);
    if (size === undefined) { incomplete('git could not read some files in earlier commits'); continue; }
    if (size > MAX_SCANNABLE_BYTES) for (const entry of byBlob.get(blob) ?? []) unchecked.add(entry.file);
    else readable.push(blob);
  }
  let read = 0;
  for (let from = 0; from < readable.length;) {
    const batch: string[] = [];
    let batchBytes = 0;
    while (from < readable.length && (batch.length === 0 || batchBytes + (sizes.get(readable[from]!) ?? 0) <= BATCH_BYTES)) {
      const blob = readable[from]!;
      from += 1;
      if (read + batchBytes + (sizes.get(blob) ?? 0) > max.maxBytes) { incomplete(`the files in its earlier commits add up to more than ${Math.round(max.maxBytes / (1024 * 1024))} MB of text, and the rest were not read`); from = readable.length; break; }
      batch.push(blob);
      batchBytes += sizes.get(blob) ?? 0;
    }
    if (batch.length === 0) break;
    read += batchBytes;
    const out = await git([...base, 'cat-file', '--batch'], { input: `${batch.join('\n')}\n` });
    if (out.code !== 0) { incomplete('git could not read some files in earlier commits'); break; }
    let at = 0;
    while (at < out.stdout.length) {
      const newline = out.stdout.indexOf(10, at);
      if (newline < 0) break;
      const [id = '', type, sizeText] = out.stdout.subarray(at, newline).toString('utf8').split(' ');
      const size = Number(sizeText);
      if (type !== 'blob' || !Number.isFinite(size)) { at = newline + 1; continue; }
      const text = scannableText(out.stdout.subarray(newline + 1, newline + 1 + size));
      at = newline + 1 + size + 1;
      for (const entry of byBlob.get(id) ?? []) {
        if (text === undefined) { unchecked.add(entry.file); continue; }
        const reason = contentReason(entry.file, text);
        if (reason) addHit({ file: entry.file, commit: short(entry.commit), reason });
      }
    }
  }
  scan.unchecked = [...unchecked].sort().slice(0, MAX_UNCHECKED_LISTED);
  return scan;
}

function historyBlockedMessage(hits: readonly HistoryHit[]): string {
  const shown = hits.slice(0, 5).map((hit) => hit.file
    ? `- ${hit.file} (commit ${hit.commit}): ${hit.reason}`
    : `- A commit message (commit ${hit.commit}): ${hit.reason}`);
  const more = hits.length > 5 ? [`- and ${hits.length - 5} more.`] : [];
  return [
    'Your code was not pushed. Something that looks like a secret was saved earlier in this project\'s history:',
    ...shown, ...more, '',
    'Pushing a branch puts everything ever saved on it online, even a file you deleted later. Adding a file to .gitignore does not take it out of the history, and NEAR AI will not rewrite your history for you.',
    'A key that was saved in a project should be replaced with a new one. Syncing still works without pushing your code.'
  ].join('\n');
}

function unscannedText(scan: HistoryScan, visibility: Visibility | 'unknown'): string {
  const why = scan.incompleteReason ?? 'it could not be read in full';
  const who = visibility === 'unknown' ? 'If this repository is public, everyone could see anything in it. ' : '';
  return `The history of this project was not fully checked for secrets: ${why}. ${who}A secret saved in an earlier commit would go online with your code.`;
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

const MAX_NAMES_LISTED = 10;

/** File names relative to NEAR AI's folder, at most ten, then "and N more". */
function namesInFolder(files: readonly string[]): string {
  const names = files.map((file) => file.slice(NEAR_AI_PROJECT_FOLDER.length));
  const shown = names.slice(0, MAX_NAMES_LISTED).join(', ');
  return names.length > MAX_NAMES_LISTED ? `${shown} and ${names.length - MAX_NAMES_LISTED} more` : shown;
}

function heldBackNote(files: readonly string[]): string {
  return `These NEAR AI files hold your own account and run records and stay on this computer: ${namesInFolder(files)}.`;
}

function trackedPrivateNote(files: readonly string[]): string {
  const many = files.length > 1;
  return `${namesInFolder(files)} ${many ? 'are' : 'is'} already saved in git, so ${many ? 'they go' : 'it goes'} up with your code. ${many ? 'They hold' : 'It holds'} your own NEAR AI records, such as your organization's name and profile settings (no keys).`;
}

function trackedPrivateBlockedMessage(files: readonly string[]): string {
  const many = files.length > 1;
  const shown = files.slice(0, MAX_NAMES_LISTED).join(', ');
  const names = files.length > MAX_NAMES_LISTED ? `${shown} and ${files.length - MAX_NAMES_LISTED} more` : shown;
  const it = many ? 'them' : 'it';
  return `Your code was not pushed: ${names} ${many ? 'hold' : 'holds'} your own NEAR AI records and git already tracks ${it}, so a public repository would show ${it}; remove ${it} from git first (git rm --cached) and try again.`;
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
  // The history the push would publish comes first: a hit there cannot be fixed with .gitignore, so the person is not asked to ignore anything.
  const branchFirst = await git(['-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']);
  const headBranch = branchFirst.code === 0 ? gitText(branchFirst) : '';
  const history: HistoryScan = headBranch === ''
    ? { commits: 0, hits: [], complete: true, unchecked: [] }
    : await scanHistory(root, `refs/heads/${headBranch}`, remote, git, options.historyLimits);
  if (history.hits.length > 0) {
    await ui.historyBlocked(historyBlockedMessage(history.hits));
    return { status: 'blocked', message: 'Your code was not pushed because earlier commits look like they hold secrets. Syncing is not affected.' };
  }
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
  const branch = headBranch;
  if (branch === '') return { status: 'failed', message: 'Your project is not on a branch, so the code was not pushed. Switch to a branch and try again.' };
  if (plan.files.length === 0) return { status: 'nothing', message: 'There are no files to push yet.' };

  if (!history.complete) {
    if (options.visibility === 'public') return { status: 'blocked', message: `Your code was not pushed. ${unscannedText(history, 'public')} This repository is public, so nothing is pushed until the whole history can be checked. Syncing is not affected.` };
    if (!await ui.confirmUnscannedHistory(`${unscannedText(history, options.visibility)}\n\nPush your code anyway?`)) return { status: 'declined', message: 'Your code was not pushed. Syncing is not affected.' };
  }
  if (options.visibility === 'public' && plan.trackedPrivate.length > 0) {
    return { status: 'blocked', message: trackedPrivateBlockedMessage(plan.trackedPrivate) };
  }
  const notes: string[] = [];
  if (options.visibility === 'public') notes.push(PUBLIC_LINE);
  if (!history.complete) notes.push('The history of this project was not fully checked for secrets, and you chose to go on.');
  if (history.unchecked.length > 0) notes.push(`${history.unchecked.length} ${history.unchecked.length === 1 ? 'file' : 'files'} in earlier commits ${history.unchecked.length === 1 ? 'is' : 'are'} too large or not text, so ${history.unchecked.length === 1 ? 'it was' : 'they were'} not checked for secrets.`);
  if (plan.heldBack.length > 0) notes.push(heldBackNote(plan.heldBack));
  if (plan.trackedPrivate.length > 0) notes.push(trackedPrivateNote(plan.trackedPrivate));
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
