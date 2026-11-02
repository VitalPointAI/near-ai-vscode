// Reads the project's GSD files from the team's integration branch as committed on the remote (D-01).
// The branch is fetched into a private ref inside the project repository and .planning is read from that ref through git
// plumbing. The working tree, the index, the member's branches and unpushed commits are never an input.
import { isGitRefName } from '../domain/team/policy';
import { gitText, mustSucceed, redactGitMessage, runGit } from './runGit';
import type { GitRunner } from './runGit';

export const INTEGRATION_REF_PREFIX = 'refs/near-ai/integration/';
export const MAX_PLANNING_FILE_BYTES = 256 * 1024;
const MAX_PLANNING_PATHS = 2000;
const MAX_PLANNING_TOTAL_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const BULK_TIMEOUT_MS = 120_000;
const PLANNING_DIRECTORY = '.planning';

export type FetchOutcome = { ok: true; ref: string; commit: string } | { ok: false; kind: 'missing' | 'offline'; reason: string };

export interface PlanningSnapshot {
  commit: string;
  treeHash: string | undefined;
  paths: string[];
  files: Map<string, string>;
  oversize: string[];
  truncated: boolean;
}

export function integrationRef(branch: string): string {
  if (!isGitRefName(branch)) throw new Error('The integration branch name is not a valid git branch name.');
  return `${INTEGRATION_REF_PREFIX}${branch}`;
}

function failureDetail(stderr: string, code: number): string {
  return redactGitMessage(stderr.trim() || `git exited with code ${code}`);
}

// Fetches the remote's branch into the private ref. The fetch writes no FETCH_HEAD and moves no local branch, HEAD or index.
export async function fetchIntegrationBranch(projectRoot: string, remote: string, branch: string, git: GitRunner = runGit): Promise<FetchOutcome> {
  const ref = integrationRef(branch);
  if (!isGitRefName(remote)) throw new Error('The team remote name is not a valid git remote name.');
  const fetched = await git(['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', remote, `+refs/heads/${branch}:${ref}`], { cwd: projectRoot, timeoutMs: FETCH_TIMEOUT_MS });
  if (fetched.code !== 0) {
    if (/couldn't find remote ref/i.test(fetched.stderr)) return { ok: false, kind: 'missing', reason: `The integration branch ${branch} was not found on the team remote.` };
    return { ok: false, kind: 'offline', reason: failureDetail(fetched.stderr, fetched.code) };
  }
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot });
  const commit = gitText(resolved);
  if (resolved.code !== 0 || commit === '') return { ok: false, kind: 'offline', reason: failureDetail(resolved.stderr, resolved.code) };
  return { ok: true, ref, commit };
}

interface TreeEntry { path: string; blob: string; readable: boolean }

// `git ls-tree -r -z` rows are "<mode> <type> <object>\t<path>" ending in NUL. The path is data and is never used to open a file.
function parseTree(output: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const row of output.toString('utf8').split('\0')) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const fields = row.slice(0, tab).split(' ');
    if (fields.length !== 3 || fields[1] !== 'blob') continue;
    // A symbolic link is a blob holding a path; it is listed but never read.
    entries.push({ path: row.slice(tab + 1), blob: fields[2] ?? '', readable: fields[0] === '100644' || fields[0] === '100755' });
  }
  return entries;
}

async function blobSizes(projectRoot: string, blobs: string[], git: GitRunner): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  if (blobs.length === 0) return sizes;
  const result = mustSucceed(await git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { cwd: projectRoot, input: `${blobs.join('\n')}\n`, timeoutMs: BULK_TIMEOUT_MS }), 'Reading planning file sizes');
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const fields = line.split(' ');
    if (fields.length === 3 && fields[1] === 'blob') sizes.set(fields[0] ?? '', Number(fields[2]));
  }
  return sizes;
}

async function blobTexts(projectRoot: string, blobs: string[], git: GitRunner): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  if (blobs.length === 0) return texts;
  const output = mustSucceed(await git(['cat-file', '--batch'], { cwd: projectRoot, input: `${blobs.join('\n')}\n`, timeoutMs: BULK_TIMEOUT_MS }), 'Reading planning files').stdout;
  let offset = 0;
  while (offset < output.length) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd < 0) break;
    const fields = output.toString('utf8', offset, lineEnd).split(' ');
    offset = lineEnd + 1;
    if (fields.length !== 3) continue;
    const size = Number(fields[2]);
    texts.set(fields[0] ?? '', output.toString('utf8', offset, offset + size));
    offset += size + 1;
  }
  return texts;
}

// Reads .planning at one commit of the given ref. Every blob is size-checked before it is read (256 KB each), and the read
// stops at 2000 listed paths or 8 MB of wanted text, with truncated set (T-62-07).
export async function readPlanningSnapshot(projectRoot: string, ref: string, wanted: (path: string) => boolean, git: GitRunner = runGit): Promise<PlanningSnapshot> {
  const commit = gitText(mustSucceed(await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: projectRoot }), 'Resolving the integration branch'));
  const tree = await git(['rev-parse', '--verify', '--quiet', `${commit}:${PLANNING_DIRECTORY}`], { cwd: projectRoot });
  const treeHash = tree.code === 0 && gitText(tree) !== '' ? gitText(tree) : undefined;
  if (treeHash === undefined) return { commit, treeHash, paths: [], files: new Map(), oversize: [], truncated: false };

  const listed = mustSucceed(await git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', PLANNING_DIRECTORY], { cwd: projectRoot, timeoutMs: BULK_TIMEOUT_MS }), 'Listing planning files');
  const all = parseTree(listed.stdout);
  let truncated = all.length > MAX_PLANNING_PATHS;
  const entries = all.slice(0, MAX_PLANNING_PATHS);
  const candidates = entries.filter((entry) => entry.readable && wanted(entry.path));
  const sizes = await blobSizes(projectRoot, [...new Set(candidates.map((entry) => entry.blob))], git);

  const oversize: string[] = [];
  const toRead: TreeEntry[] = [];
  let total = 0;
  for (const entry of candidates) {
    const size = sizes.get(entry.blob);
    if (size === undefined) continue;
    if (size > MAX_PLANNING_FILE_BYTES) {
      oversize.push(entry.path);
      continue;
    }
    if (total + size > MAX_PLANNING_TOTAL_BYTES) {
      truncated = true;
      continue;
    }
    total += size;
    toRead.push(entry);
  }
  const texts = await blobTexts(projectRoot, [...new Set(toRead.map((entry) => entry.blob))], git);
  const files = new Map<string, string>();
  for (const entry of toRead) {
    const text = texts.get(entry.blob);
    if (text !== undefined) files.set(entry.path, text);
  }
  return { commit, treeHash, paths: entries.map((entry) => entry.path), files, oversize, truncated };
}

export async function remoteBranchHead(_projectRoot: string, _remote: string, _branch: string, _git: GitRunner = runGit): Promise<string | undefined> {
  throw new Error('not implemented');
}

export async function isAncestor(_projectRoot: string, _older: string, _newer: string, _git: GitRunner = runGit): Promise<boolean | 'unknown'> {
  throw new Error('not implemented');
}
