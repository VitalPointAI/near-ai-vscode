// Git transport for project sync (D-01, D-09, SYNC-05). The encrypted state lives on one dedicated branch of the project's own remote. All work happens
// in a private bare mirror outside the project folder (the editor's own storage), so the person's working tree, index, HEAD, branches and remote-tracking branches are never
// touched: this module reads the person's repository only to learn the remote's address (`ls-remote --get-url`, `remote`) and writes nothing to it.
// Commits are built with plumbing (hash-object, mktree, commit-tree) under one anonymous identity, and pushed to refs/heads/near-ai/state without any
// force option: a push that loses a race reports 'rejected' and the caller fetches, merges and tries again. Every git call goes through the injected
// GitRunner, which switches off hooks, signing, helper transports and fsmonitor. Shaped after the Team transport (unmerged branch, copied, never
// imported). This module never imports vscode.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { StateRefusedError } from '../domain/state/keys';
import { TREE_NAME } from '../domain/state/objects';
import { redactSecrets } from '../domain/redaction';
import { withMirrorLock } from './stateMirrorLock';
import type { MirrorLockOptions } from './stateMirrorLock';
import { GitNotFoundError, STATE_COMMIT_MESSAGE, STATE_IDENTITY_ENV, addGitConfigEnv, gitText, mustSucceed, redactGitMessage, runStateGit, splitAddress } from './stateGit';
import type { GitResult, GitRunner, SplitAddress } from './stateGit';

/** The only branch sync ever writes, on the remote. */
export const STATE_REF = 'refs/heads/near-ai/state';
/** Where a fetch lands in the mirror before anything trusts it. */
export const INCOMING_REF = 'refs/near-ai/incoming';

export type SyncFailureKind = 'rejected' | 'offline' | 'auth' | 'policy' | 'git-missing' | 'no-remote' | 'invalid-remote';
/** One plain sentence for the person (no URL userinfo, no credentials) and, for logs, the redacted git text. */
export interface SyncFailure { kind: SyncFailureKind; message: string; detail?: string }
export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: SyncFailure };
export interface TreeEntry { name: string; oid: string }
export interface StateFile { name: string; data: Buffer | string }
/** A file of an earlier tree carried into a new one by its blob id, so an unchanged object is not read and stored again. */
export interface StateFileRef { name: string; oid: string }

const MESSAGES: Readonly<Record<SyncFailureKind, string>> = {
  rejected: 'Another computer saved changes first. Sync will combine them with yours and try again.',
  offline: 'Could not reach your git host. Your work here is safe; sync will try again.',
  auth: 'Git asked for a sign-in this editor cannot show. Run git fetch once in a terminal in this project so your credential helper can save it.',
  policy: 'Your git host did not accept the sync branch.',
  'git-missing': 'Git is not installed, so sync is off. Everything still works on this computer.',
  'no-remote': 'This project has no online home yet.',
  'invalid-remote': 'That address cannot be used for sync.'
};

// Hosted remotes word a lost race differently, so the markers are a list. An unknown rejection is not a race: it is reported, not retried.
export const CAS_LOST_MARKERS = ['non-fast-forward', 'fetch first', 'incorrect old value provided', 'tip is behind', 'Updates were rejected', 'cannot lock ref'] as const;
export const POLICY_MARKERS = ['GH013', 'protected branch', 'repository rule violations', 'declined', 'remote rejected', 'denied to'] as const;
const AUTH_PATTERN = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied \(publickey|returned error: 40[13]|Host key verification failed/i;

function failure(kind: SyncFailureKind, detail?: string): SyncFailure {
  const message = redactSecrets(redactGitMessage(MESSAGES[kind]));
  return detail === undefined ? { kind, message } : { kind, message, detail: redactGitMessage(detail.trim()).slice(0, 400) };
}

/** Maps a failed git result (English text: LC_ALL=C is set by the runner) to a kind and one plain sentence. */
export function classifyGitFailure(result: GitResult): SyncFailure {
  const text = result.stderr;
  const detail = text.trim() || `git exited with ${result.code}`;
  if (CAS_LOST_MARKERS.some((marker) => text.includes(marker))) return failure('rejected', detail);
  if (AUTH_PATTERN.test(text)) return failure('auth', detail);
  if (POLICY_MARKERS.some((marker) => text.includes(marker))) return failure('policy', detail);
  return failure('offline', detail);
}

/** A runner that could not start git at all. Anything else is not a sync outcome and is left to the caller. */
export function classifyThrown(error: unknown): SyncFailure | undefined {
  return error instanceof GitNotFoundError ? failure('git-missing') : undefined;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const URL_FORMS: readonly RegExp[] = [
  /^https:\/\/[^\s/@]*@?[A-Za-z0-9.-]+(?::\d+)?\/\S+$/i,
  /^ssh:\/\/\S+$/i,
  /^file:\/\/\S+$/i,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:\S+$/, // git@host:path
  /^\/\S*$/, // an absolute path on this computer
  /^[A-Za-z]:[\\/]\S*$/ // an absolute Windows path
];

// A helper transport ('ext::', 'fd::', any '<word>::') runs a program of the repository's choosing. Control characters and a leading dash would turn
// an address into an option.
function unsafeAddress(value: string): boolean {
  return value.includes('::') || /[\u0000-\u001f\u007f]/.test(value) || value.startsWith('-') || value.trim() !== value;
}

/**
 * Decides whether a remote value may be used. A name must be one of the repository's remotes; an address must be one of the plain forms. Any
 * helper-transport form is refused. A project with no remotes at all is 'no-remote', not an error to explain.
 */
export function validateRemote(value: string, remoteNames: readonly string[]): { kind: 'name' | 'url' } | SyncFailure {
  if (value === '' || unsafeAddress(value)) return failure('invalid-remote');
  if (remoteNames.includes(value)) return { kind: 'name' };
  if (URL_FORMS.some((form) => form.test(value))) return { kind: 'url' };
  if (REMOTE_NAME.test(value)) return remoteNames.length === 0 ? failure('no-remote') : failure('invalid-remote');
  return failure('invalid-remote');
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LOCAL_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 90_000;
/** The mirror's one remote. It is a promisor: blobs that were filtered out of a fetch are fetched one at a time, by git itself, the first time one is read. */
const STATE_REMOTE = 'state';
/** What a fetch leaves out: every blob. The commits and trees (so the file names and the manifest's list) come, and a blob only when it is read. */
export const PARTIAL_CLONE_FILTER = 'blob:none';
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;

export interface StateTransportOptions {
  /** The project folder. Read only. */
  root: string;
  /** A remote name of the project's repository, or an address. The setting that chooses it is deferred (D-09); the constructor default is the only place a name is assumed. */
  remote?: string;
  /** A private folder outside the project (the editor's own storage), created on first use. */
  mirrorDir: string;
  /** An empty folder git is pointed at for hooks. */
  hooksDir: string;
  /** The injectable seam; a wrapper such as a token-adding runner goes here. */
  git?: GitRunner;
  lock?: Partial<MirrorLockOptions>;
}

const OUTSIDE_PROJECT = "Sync's private folders must be outside the project folder. Nothing was changed.";

/** The real path of a folder that may not exist yet: the nearest existing ancestor with its symbolic links resolved, then the rest as written. */
function resolveThroughExisting(target: string): string {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInsideOrEqual(folder: string, root: string): boolean {
  const relative = path.relative(root, folder);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export class StateTransport {
  private readonly root: string;
  private readonly remote: string;
  private readonly mirrorDir: string;
  private readonly hooksDir: string;
  private readonly git: GitRunner;
  private readonly lock: Partial<MirrorLockOptions>;
  private mirrorReady = false;
  private configuredUrl: string | undefined;
  /** The credentials of the remote's address, when it has any. They reach git only as a rewrite rule in each call's environment; they are never written to the mirror's config or put in an argument. */
  private credentials: SplitAddress | undefined;
  private addressLearnt = false;
  /** The clean address the last fetch (or push, or blob read) used, without credentials. */
  private lastAddress: string | undefined;

  public constructor(options: StateTransportOptions) {
    // Nothing inside the project folder may decide what git runs (REVIEW B1): the mirror and the hooks folder must not be in it, links resolved.
    const realRoot = resolveThroughExisting(options.root);
    if (isInsideOrEqual(resolveThroughExisting(options.mirrorDir), realRoot) || isInsideOrEqual(resolveThroughExisting(options.hooksDir), realRoot)) {
      throw new Error(OUTSIDE_PROJECT);
    }
    this.root = options.root;
    this.remote = options.remote ?? 'origin';
    this.mirrorDir = options.mirrorDir;
    this.hooksDir = options.hooksDir;
    this.git = options.git ?? runStateGit;
    this.lock = options.lock ?? {};
  }

  private run(args: string[], extra: { env?: Record<string, string>; input?: Buffer | string; timeoutMs?: number; maxStdoutBytes?: number } = {}): Promise<GitResult> {
    return this.git(args, { timeoutMs: LOCAL_TIMEOUT_MS, hooksDir: this.hooksDir, ...extra });
  }

  private mirrorGit(args: string[], extra: { env?: Record<string, string>; input?: Buffer | string; timeoutMs?: number; maxStdoutBytes?: number } = {}): Promise<GitResult> {
    // An address with a password or token in it is written to the mirror without it (the address is written to the mirror's config); git is given the
    // credentialed form for this call only, as a rewrite of the plain address, in its environment.
    const credentialed = this.credentials?.credentialed;
    const env = credentialed ? addGitConfigEnv(extra.env, `url.${credentialed}.insteadOf`, (this.credentials as SplitAddress).clean) : extra.env;
    return this.run(['--git-dir', this.mirrorDir, '-c', 'gc.autoDetach=false', ...args], env ? { ...extra, env } : extra);
  }

  /** Remembers the credentials of a resolved address and returns the address without them: the only form that is ever written down or passed as an argument. */
  private useAddress(address: string): string {
    const split = splitAddress(address);
    this.credentials = split.credentialed ? split : undefined;
    this.addressLearnt = true;
    this.lastAddress = split.clean;
    return split.clean;
  }

  // Everything that touches the mirror runs here, inside withMirrorLock: first this process's turn, then the cross-process file lock, then the mirror itself.
  private inMirror<T>(work: () => Promise<T>): Promise<T> {
    return withMirrorLock(this.mirrorDir, async () => {
      await this.initialiseMirror();
      return work();
    }, this.lock);
  }

  private async initialiseMirror(): Promise<void> {
    if (this.mirrorReady) return;
    await mkdir(this.hooksDir, { recursive: true });
    const initialised = await stat(path.join(this.mirrorDir, 'HEAD')).then(() => true, () => false);
    if (!initialised) mustSucceed(await this.run(['init', '--bare', '-q', this.mirrorDir]), 'creating the sync mirror');
    this.mirrorReady = true;
  }

  private async guarded<T>(work: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
    try {
      return await work();
    } catch (error) {
      const known = classifyThrown(error);
      if (known) return { ok: false, failure: known };
      throw error;
    }
  }

  /** Creates the mirror (and the empty hooks folder) if they are not there yet. Safe to call every time. */
  public ensureMirror(): Promise<void> {
    return this.inMirror(() => Promise.resolve());
  }

  /** The address to push to and fetch from. Reads the person's repository (`remote`, `ls-remote --get-url`) and writes nothing to it. */
  public resolveRemoteUrl(): Promise<Outcome<string>> {
    return this.guarded(async () => {
      const listed = await this.run(['-C', this.root, 'remote']);
      const names = listed.code === 0 ? gitText(listed).split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
      const checked = validateRemote(this.remote, names);
      if ('message' in checked) return { ok: false, failure: checked };
      // insteadOf rewrites are honoured here, in the person's repository, so a mapped address resolves the way their own git would.
      const url = await this.run(['-C', this.root, 'ls-remote', '--get-url', this.remote]);
      if (url.code !== 0) return { ok: false, failure: classifyGitFailure(url) };
      const address = gitText(url);
      if (address === '' || unsafeAddress(address)) return { ok: false, failure: failure('invalid-remote') };
      return { ok: true, value: address };
    });
  }

  /**
   * Makes the mirror (and only the mirror: this is `--git-dir` the private folder, never the person's repository) a partial clone of `url`: remote
   * `state`, a promisor, with the blob filter. Safe to call every time; it does nothing when the address has not changed. A host that cannot filter
   * ignores the filter and sends everything, so nothing depends on it but bandwidth.
   */
  public configurePartialClone(url: string): Promise<void> {
    return this.inMirror(() => this.configureLocked(url));
  }

  private async configureLocked(address: string): Promise<void> {
    // Whatever is written to the mirror's config has no userinfo, however the caller got the address.
    const url = splitAddress(address).clean;
    if (this.configuredUrl === url) return;
    if (unsafeAddress(url)) throw new StateRefusedError('unsupported-format');
    const settings: Array<[string, string]> = [[`remote.${STATE_REMOTE}.url`, url], [`remote.${STATE_REMOTE}.promisor`, 'true'], [`remote.${STATE_REMOTE}.partialclonefilter`, PARTIAL_CLONE_FILTER]];
    for (const [key, value] of settings) mustSucceed(await this.mirrorGit(['config', key, value]), 'setting up the sync mirror');
    this.configuredUrl = url;
  }

  /** Fetches the state branch into the mirror's own incoming ref and returns its commit id, or undefined when the remote has no state branch yet. */
  public fetch(): Promise<Outcome<string | undefined>> {
    return this.guarded(() => this.inMirror(async (): Promise<Outcome<string | undefined>> => {
      const resolved = await this.resolveRemoteUrl();
      if (!resolved.ok) return resolved;
      const url = this.useAddress(resolved.value);
      const listing = await this.mirrorGit(['ls-remote', '--exit-code', url, STATE_REF], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (listing.code === 2) return { ok: true, value: undefined };
      if (listing.code !== 0) return { ok: false, failure: classifyGitFailure(listing) };
      await this.configureLocked(url);
      const fetched = await this.mirrorGit(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '-q', `--filter=${PARTIAL_CLONE_FILTER}`, STATE_REMOTE, `+${STATE_REF}:${INCOMING_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (fetched.code !== 0) {
        if (/couldn't find remote ref/.test(fetched.stderr)) return { ok: true, value: undefined };
        return { ok: false, failure: classifyGitFailure(fetched) };
      }
      const tip = gitText(mustSucceed(await this.mirrorGit(['rev-parse', '--verify', '-q', INCOMING_REF]), 'reading the fetched state'));
      return { ok: true, value: tip };
    }));
  }

  /** The commit the last fetch left in the mirror's incoming ref, or undefined when there has been none. Reads only the mirror. */
  public currentTip(): Promise<string | undefined> {
    return this.inMirror(async () => {
      const read = await this.mirrorGit(['rev-parse', '--verify', '-q', INCOMING_REF]);
      return read.code === 0 && OID.test(gitText(read)) ? gitText(read) : undefined;
    });
  }

  /**
   * Whether commit `ancestor` is `tip` or reachable from it, in the mirror. Both must be object ids. Anything else is false: a commit the mirror does not
   * hold after the fetch cannot be an ancestor of what was fetched, because a fetch brings the whole history of the tip (only blobs are left out).
   */
  public isAncestor(ancestor: string, tip: string): Promise<boolean> {
    return this.inMirror(async () => {
      if (!OID.test(ancestor) || !OID.test(tip)) return false;
      return (await this.mirrorGit(['merge-base', '--is-ancestor', ancestor, tip])).code === 0;
    });
  }

  /**
   * A short, stable name for the address the last fetch used (the first 16 hex of the sha256 of the address without credentials), so a computer can tell
   * that its remote now points somewhere else. Undefined before a fetch.
   */
  public addressId(): string | undefined {
    return this.lastAddress === undefined ? undefined : createHash('sha256').update(this.lastAddress, 'utf8').digest('hex').slice(0, 16);
  }

  /** The ids of the objects the mirror was told about and does not hold: after a filtered fetch, the blobs nobody has read yet. */
  public missingObjects(ref: string = INCOMING_REF): Promise<string[]> {
    return this.inMirror(async () => {
      const listed = await this.mirrorGit(['rev-list', '--objects', '--missing=print', ref], { maxStdoutBytes: MAX_TREE_BYTES });
      if (listed.overflowed) throw new StateRefusedError('unsupported-format');
      mustSucceed(listed, 'listing the objects not downloaded yet');
      return gitText(listed).split('\n').filter((line) => line.startsWith('?')).map((line) => line.slice(1).trim()).filter((oid) => OID.test(oid));
    });
  }

  /** The files of a commit's tree. Only manifest.json and <32 hex>.bin blobs are accepted; anything else is refused. */
  public readTree(oid: string): Promise<TreeEntry[]> {
    return this.inMirror(async () => {
      if (!OID.test(oid)) throw new StateRefusedError('unsupported-format');
      const listed = await this.mirrorGit(['ls-tree', '-z', oid], { maxStdoutBytes: MAX_TREE_BYTES });
      if (listed.overflowed) throw new StateRefusedError('unsupported-format');
      mustSucceed(listed, 'reading the state tree');
      const entries: TreeEntry[] = [];
      for (const record of listed.stdout.toString('utf8').split('\0')) {
        if (record === '') continue;
        const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record);
        if (!match || match[1] !== '100644' || match[2] !== 'blob' || !OID.test(match[3] ?? '') || !TREE_NAME.test(match[4] ?? '')) throw new StateRefusedError('unsupported-format');
        entries.push({ name: match[4] as string, oid: match[3] as string });
      }
      return entries;
    });
  }

  /** One file's bytes, at most 16 MiB. A blob the mirror does not hold yet is fetched by git first (a network call, so the longer timeout). */
  public readBlob(oid: string): Promise<Buffer> {
    return this.inMirror(async () => {
      if (!OID.test(oid)) throw new StateRefusedError('unsupported-format');
      // A blob that is not in the mirror yet is fetched by git from the remote written in the mirror's config, which has no credentials in it.
      if (!this.addressLearnt) { const resolved = await this.resolveRemoteUrl(); if (resolved.ok) this.useAddress(resolved.value); else this.addressLearnt = true; }
      const read = await this.mirrorGit(['cat-file', 'blob', oid], { maxStdoutBytes: MAX_BLOB_BYTES, timeoutMs: NETWORK_TIMEOUT_MS });
      if (read.overflowed) throw new StateRefusedError('unsupported-format');
      if (read.code !== 0) throw new StateRefusedError('missing-object');
      return read.stdout;
    });
  }

  /** Builds a flat tree of the given files (or blob ids of files already in the mirror) and a commit over it with the anonymous identity, optionally on top of `parent`. Nothing is pushed. */
  public writeCommit(files: ReadonlyArray<StateFile | StateFileRef>, parent?: string): Promise<string> {
    return this.inMirror(async () => {
      if (parent !== undefined && !OID.test(parent)) throw new StateRefusedError('unsupported-format');
      const seen = new Set<string>();
      const lines: Buffer[] = [];
      for (const file of files) {
        if (!TREE_NAME.test(file.name) || seen.has(file.name)) throw new StateRefusedError('unsupported-format');
        seen.add(file.name);
        const blob = 'oid' in file ? file.oid : gitText(mustSucceed(await this.mirrorGit(['hash-object', '-w', '--stdin'], { input: file.data }), 'storing a state file'));
        if (!OID.test(blob)) throw new StateRefusedError('unsupported-format');
        lines.push(Buffer.from(`100644 blob ${blob}\t${file.name}\0`, 'utf8'));
      }
      // --missing: an unchanged object carried by its blob id may be one this computer never downloaded (an archived thread kept only online); the
      // remote already holds it, which is exactly why it is carried by id.
      const tree = gitText(mustSucceed(await this.mirrorGit(['mktree', '-z', '--missing'], { input: Buffer.concat(lines) }), 'building the state tree'));
      const args = ['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', STATE_COMMIT_MESSAGE];
      return gitText(mustSucceed(await this.mirrorGit(args, { env: { ...STATE_IDENTITY_ENV } }), 'making the sync commit'));
    });
  }

  /** Pushes `commit` to the state branch. Never forced: a lost race comes back as 'rejected' for the caller to fetch, merge and retry. */
  public push(commit: string): Promise<Outcome<string>> {
    return this.guarded(() => this.inMirror(async (): Promise<Outcome<string>> => {
      if (!OID.test(commit)) return { ok: false, failure: failure('invalid-remote') };
      const resolved = await this.resolveRemoteUrl();
      if (!resolved.ok) return resolved;
      const pushed = await this.mirrorGit(['push', '-q', this.useAddress(resolved.value), `${commit}:${STATE_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (pushed.code !== 0) return { ok: false, failure: classifyGitFailure(pushed) };
      return { ok: true, value: commit };
    }));
  }
}
