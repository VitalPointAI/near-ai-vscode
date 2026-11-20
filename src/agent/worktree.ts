import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { ToolError } from './workspace';

// Sub-agent isolation in a git worktree, as Open-GSD expects of a host that declares
// `harness-worktree`: the host creates a branch from HEAD checked out in its own directory and
// runs the agent there; the agent commits on that branch; the orchestrator merges and removes it.
// Worktrees live in the extension's storage, so the project itself gets no extra folders.

/** `root` is where the agent works: the worktree's copy of the workspace folder, which is below `path` when the workspace is a subfolder of the repository. */
export interface AgentWorktree { path: string; branch: string; base: string; repo: string; root: string; /** The workspace folder could not be placed inside the worktree, so `root` is its top level. */ rootUnmatched?: boolean; /** The workspace folder is not tracked by git, so its copy in the worktree was created empty. */ rootCreatedEmpty?: boolean }

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || error.message}`));
      else resolve(String(stdout).trim());
    });
  });
}

/** How worktree changes reach git; tests wrap it to watch what overlaps. */
export const worktreeGit = { run: git };

/**
 * One repository's worktree changes run one at a time. Agents in one wave start together, and two `git worktree add` (or `remove`) in one repository
 * at once race on its .git/worktrees administration ("fatal: failed to read .git/worktrees/<name>/commondir"), so one agent's worktree failed for no
 * reason of its own. Keyed by the repository's top level; a failed change never blocks the next one.
 */
const repoQueues = new Map<string, Promise<unknown>>();
function inRepoOrder<T>(repo: string, change: () => Promise<T>): Promise<T> {
  const key = path.resolve(repo);
  const previous = repoQueues.get(key) ?? Promise.resolve();
  const next = previous.then(change, change);
  const settled = next.then(() => undefined, () => undefined);
  repoQueues.set(key, settled);
  void settled.then(() => { if (repoQueues.get(key) === settled) repoQueues.delete(key); });
  return next;
}

export async function createAgentWorktree(root: string, baseDir: string, agentId: string): Promise<AgentWorktree> {
  const repo = await git(root, ['rev-parse', '--show-toplevel']).catch(() => { throw new ToolError('isolation "worktree" needs a git repository; this workspace is not one.'); });
  const base = await git(repo, ['rev-parse', '--verify', 'HEAD']).catch(() => { throw new ToolError('isolation "worktree" needs at least one commit to branch from.'); });
  const dir = path.join(baseDir, createHash('sha256').update(repo).digest('hex').slice(0, 12), `agent-${agentId}`);
  await mkdir(path.dirname(dir), { recursive: true });
  const branch = `worktree-agent-${agentId}`;
  await inRepoOrder(repo, () => worktreeGit.run(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, base]));
  const { root: placed, createdEmpty } = await worktreeRoot(repo, root, dir);
  return { path: dir, branch, base, repo, root: placed, ...(placed === dir && path.resolve(await realpath(root).catch(() => root)) !== path.resolve(repo) ? { rootUnmatched: true } : {}), ...(createdEmpty ? { rootCreatedEmpty: true } : {}) };
}

/**
 * The workspace folder's place inside the worktree. A workspace opened at repo/packages/app works in
 * <worktree>/packages/app, not at the repository's top. git reports the top level with symlinks
 * resolved, so the workspace path is resolved too before comparing. A folder git does not track
 * (so it is not in the checkout) is created empty.
 */
async function worktreeRoot(repo: string, workspaceRoot: string, worktreePath: string): Promise<{ root: string; createdEmpty: boolean }> {
  const resolved = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const relative = path.relative(repo, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { root: worktreePath, createdEmpty: false };
  const root = path.join(worktreePath, relative);
  const existed = await stat(root).then(() => true, () => false);
  await mkdir(root, { recursive: true });
  return { root, createdEmpty: !existed };
}

/** Removes the worktree and its branch when the agent left nothing in them; otherwise keeps both for merging. */
export async function finishAgentWorktree(worktree: AgentWorktree): Promise<'removed' | 'kept'> {
  const status = await git(worktree.path, ['status', '--porcelain']).catch(() => undefined);
  const head = await git(worktree.path, ['rev-parse', 'HEAD']).catch(() => undefined);
  if (status !== '' || head !== worktree.base) return 'kept';
  await inRepoOrder(worktree.repo, async () => {
    await worktreeGit.run(worktree.repo, ['worktree', 'remove', worktree.path]);
    // -d, not -D: the branch has no commits of its own, so this can never discard work.
    await worktreeGit.run(worktree.repo, ['branch', '-d', worktree.branch]).catch(() => undefined);
  });
  return 'removed';
}

export function worktreeReport(worktree: AgentWorktree, state: 'removed' | 'kept'): string {
  return state === 'removed'
    ? 'The agent ran in an isolated git worktree and changed nothing, so the worktree was removed.'
    : `The agent ran in an isolated git worktree. Its changes are on branch ${worktree.branch} (based on ${worktree.base.slice(0, 12)}) at ${worktree.path} and have not been merged.`;
}
