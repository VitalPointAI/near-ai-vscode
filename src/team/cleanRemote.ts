// Reaching the project's git remote without the project's own git config (0.4.25).
//
// A cloned repository carries its own .git/config, and many of its settings make git run a program or send something on the person's behalf when
// it talks to a remote: core.sshCommand, credential.helper, core.gitProxy, remote.<name>.uploadpack and receivepack, http.<url>.extraHeader, hooks,
// and url.<base>.insteadOf rules that turn the address into a command helper. Fixing those one at a time leaves the next one open, so Team Mode
// never runs a network git command in the project. It reads the remote's addresses in the project (`git remote get-url`, which runs nothing and
// applies the project's insteadOf rules, so the address checked is the address used), checks every one (D-34), and then talks to the remote from a
// temporary bare git folder made for the call. Only that folder's own config, which Team Mode writes, and the person's global and system config
// apply there, the way the transport's mirror already works.
//
// The person's global config (~/.gitconfig) still applies on purpose: its credential helpers, ssh command and proxy are the person's own
// machine-wide choices, not something a cloned folder can set. An ssh command inherited from the environment (GIT_SSH_COMMAND or GIT_SSH) is
// honoured as well (PR #59); without either, and without one in the global config, a non-interactive ssh keeps a passphrase prompt from hanging.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { isContactableRemoteAddress } from './gitTransport';
import { gitText, redactGitMessage } from './runGit';
import type { GitResult, GitRunner } from './runGit';

const LOCAL_TIMEOUT_MS = 30_000;
export const CLEAN_NETWORK_TIMEOUT_MS = 60_000;
const DEFAULT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
// The remote's name inside the temporary folder. It exists only in the git process's environment (GIT_CONFIG_*), never in a config file.
const CLEAN_REMOTE_NAME = 'near-ai-team';
// git's own programs, passed on the command line as well, which git honours over any config value (checked on git 2.53).
const UPLOAD_PACK_DEFAULT = '--upload-pack=git-upload-pack';
const RECEIVE_PACK_DEFAULT = '--receive-pack=git-receive-pack';
const REFUSED_ADDRESS_HINT = 'Team Mode uses ssh, git, https, http or file addresses, or a local path.';

export interface CheckedRemote { fetchUrl: string; pushUrls: string[] }
export type CheckedRemoteResult = { ok: true; remote: CheckedRemote } | { ok: false; reason: string };

function lines(result: GitResult): string[] {
  return result.stdout.toString('utf8').split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.trim() !== '');
}

function failureText(result: GitResult): string {
  return redactGitMessage([result.stderr.trim(), gitText(result)].filter((part) => part !== '').join('\n') || `git exited with code ${result.code}`);
}

/**
 * Every fetch and push address of `remote` as git would use it, each checked with isContactableRemoteAddress. The addresses can carry credentials,
 * so a refusal never repeats them, and callers never show or store them.
 */
export async function resolveCheckedRemote(projectRoot: string, remote: string, git: GitRunner): Promise<CheckedRemoteResult> {
  const fetch = await git(['remote', 'get-url', '--all', remote], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (fetch.code !== 0) return { ok: false, reason: `Git could not read the address of the remote "${remote}": ${failureText(fetch)}` };
  const push = await git(['remote', 'get-url', '--push', '--all', remote], { cwd: projectRoot, timeoutMs: LOCAL_TIMEOUT_MS });
  if (push.code !== 0) return { ok: false, reason: `Git could not read the address of the remote "${remote}": ${failureText(push)}` };
  const fetchUrls = lines(fetch);
  const pushUrls = lines(push);
  const refused = `The address of the git remote named "${remote}" is not one Team Mode will contact. ${REFUSED_ADDRESS_HINT}`;
  if (fetchUrls.length === 0 || pushUrls.length === 0) return { ok: false, reason: refused };
  if ([...fetchUrls, ...pushUrls].some((address) => !isContactableRemoteAddress(address))) return { ok: false, reason: refused };
  return { ok: true, remote: { fetchUrl: fetchUrls[0] as string, pushUrls } };
}

/** A clean git folder for one network call: a temporary bare repository with no templates and an empty hooks folder, removed afterwards. */
async function withCleanGitDir<T>(git: GitRunner, work: (gitDir: string) => Promise<T>, objectsFrom?: string): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-team-git-'));
  try {
    const gitDir = path.join(dir, 'clean.git');
    const init = await git(['init', '--bare', '-q', '--template=', gitDir], { cwd: dir, timeoutMs: LOCAL_TIMEOUT_MS });
    if (init.code !== 0) throw new Error(`A temporary git folder could not be made: ${failureText(init)}`);
    const hooks = path.join(dir, 'no-hooks');
    await mkdir(hooks);
    // No hooks run, including any the global config's core.hooksPath names: a push from here is Team Mode's, not a commit of the person's.
    const set = await git(['--git-dir', gitDir, 'config', 'core.hooksPath', hooks], { cwd: dir, timeoutMs: LOCAL_TIMEOUT_MS });
    if (set.code !== 0) throw new Error(`A temporary git folder could not be set up: ${failureText(set)}`);
    if (objectsFrom !== undefined) {
      // The project's objects are read through an alternate, so the code branch can be pushed without opening the project as a repository.
      await mkdir(path.join(gitDir, 'objects', 'info'), { recursive: true });
      await writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), `${objectsFrom}\n`, 'utf8');
    }
    return await work(gitDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// An ssh command inherited from the environment is left alone, and so is one the global or system config sets (git applies it itself). The
// temporary folder's own config has none, so this reads only the person's own settings.
async function sshEnv(git: GitRunner, gitDir: string): Promise<Record<string, string>> {
  for (const name of ['GIT_SSH_COMMAND', 'GIT_SSH']) {
    const inherited = process.env[name];
    if (inherited !== undefined && inherited !== '') return {};
  }
  const configured = await git(['--git-dir', gitDir, 'config', '--get', 'core.sshCommand'], { timeoutMs: LOCAL_TIMEOUT_MS });
  if (configured.code === 0 && gitText(configured) !== '') return {};
  return { GIT_SSH_COMMAND: DEFAULT_SSH_COMMAND };
}

// The URL travels in the environment (GIT_CONFIG_*, git 2.31 and later), not in the arguments a local user could read (WR-12). An older git gets
// it as an argument, as in the transport.
async function target(git: GitRunner, url: string): Promise<{ target: string; env: Record<string, string> }> {
  const version = await git(['--version'], { timeoutMs: LOCAL_TIMEOUT_MS });
  const match = /(\d+)\.(\d+)/.exec(gitText(version));
  const major = match === null ? 0 : Number(match[1]);
  const minor = match === null ? 0 : Number(match[2]);
  if (version.code !== 0 || !(major > 2 || (major === 2 && minor >= 31))) return { target: url, env: {} };
  const inherited = Number(process.env.GIT_CONFIG_COUNT ?? '0');
  const index = Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
  return {
    target: CLEAN_REMOTE_NAME,
    env: { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: `remote.${CLEAN_REMOTE_NAME}.url`, [`GIT_CONFIG_VALUE_${index}`]: url }
  };
}

/** `git ls-remote --exit-code <remote> <ref>` against the checked fetch address, from a clean folder. */
export async function cleanLsRemote(git: GitRunner, remote: CheckedRemote, ref: string): Promise<GitResult> {
  return withCleanGitDir(git, async (gitDir) => {
    const to = await target(git, remote.fetchUrl);
    const env = { ...(await sshEnv(git, gitDir)), ...to.env };
    return git(['--git-dir', gitDir, 'ls-remote', UPLOAD_PACK_DEFAULT, '--exit-code', to.target, ref], { cwd: path.dirname(gitDir), env, timeoutMs: CLEAN_NETWORK_TIMEOUT_MS });
  });
}

/**
 * Pushes `commit` to refs/heads/<branch> at every checked push address, from a clean folder that reads the project's objects through an alternate.
 * Stops at the first address that refuses. The project's own pre-push hook and remote-tracking refs are not touched (the next fetch updates those).
 */
export async function cleanPush(git: GitRunner, remote: CheckedRemote, objectsDir: string, commit: string, branch: string): Promise<GitResult> {
  return withCleanGitDir(git, async (gitDir) => {
    let last: GitResult | undefined;
    for (const url of remote.pushUrls) {
      const to = await target(git, url);
      const env = { ...(await sshEnv(git, gitDir)), ...to.env };
      last = await git(['--git-dir', gitDir, 'push', RECEIVE_PACK_DEFAULT, to.target, `${commit}:refs/heads/${branch}`], { cwd: path.dirname(gitDir), env, timeoutMs: CLEAN_NETWORK_TIMEOUT_MS });
      if (last.code !== 0) return last;
    }
    return last as GitResult;
  }, objectsDir);
}
