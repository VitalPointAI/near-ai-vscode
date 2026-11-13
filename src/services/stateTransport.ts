// Git transport for project sync (D-01, D-09, SYNC-05). The encrypted state lives on one dedicated branch of the project's own remote. All work happens
// in a private bare mirror inside the project's state home, so the person's working tree, index, HEAD, branches and remote-tracking branches are never
// touched: this module reads the person's repository only to learn the remote's address (`ls-remote --get-url`, `remote`) and writes nothing to it.
// Commits are built with plumbing (hash-object, mktree, commit-tree) under one anonymous identity, and pushed to refs/heads/near-ai/state without any
// force option: a push that loses a race reports 'rejected' and the caller fetches, merges and tries again. Every git call goes through the injected
// GitRunner, which switches off hooks, signing, helper transports and fsmonitor. Shaped after the Team transport (unmerged branch, copied, never
// imported). This module never imports vscode.
import { mkdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { StateRefusedError } from '../domain/state/keys';
import { TREE_NAME } from '../domain/state/objects';
import { redactSecrets } from '../domain/redaction';
import { withMirrorLock } from './stateMirrorLock';
import type { MirrorLockOptions } from './stateMirrorLock';
import { GitNotFoundError, STATE_COMMIT_MESSAGE, STATE_IDENTITY_ENV, gitText, mustSucceed, redactGitMessage, runStateGit } from './stateGit';
import type { GitResult, GitRunner } from './stateGit';

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
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_TREE_BYTES = 4 * 1024 * 1024;

export interface StateTransportOptions {
  /** The project folder. Read only. */
  root: string;
  /** A remote name of the project's repository, or an address. The setting that chooses it is deferred (D-09); the constructor default is the only place a name is assumed. */
  remote?: string;
  /** <state home>/sync/mirror.git, created on first use. */
  mirrorDir: string;
  /** An empty folder git is pointed at for hooks. */
  hooksDir: string;
  /** The injectable seam; a wrapper such as a token-adding runner goes here. */
  git?: GitRunner;
  lock?: Partial<MirrorLockOptions>;
}

export class StateTransport {
  private readonly root: string;
  private readonly remote: string;
  private readonly mirrorDir: string;
  private readonly hooksDir: string;
  private readonly git: GitRunner;
  private readonly lock: Partial<MirrorLockOptions>;
  private mirrorReady = false;

  public constructor(options: StateTransportOptions) {
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
    return this.run(['--git-dir', this.mirrorDir, '-c', 'gc.autoDetach=false', ...args], extra);
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

  /** Fetches the state branch into the mirror's own incoming ref and returns its commit id, or undefined when the remote has no state branch yet. */
  public fetch(): Promise<Outcome<string | undefined>> {
    return this.guarded(() => this.inMirror(async (): Promise<Outcome<string | undefined>> => {
      const resolved = await this.resolveRemoteUrl();
      if (!resolved.ok) return resolved;
      const url = resolved.value;
      const listing = await this.mirrorGit(['ls-remote', '--exit-code', url, STATE_REF], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (listing.code === 2) return { ok: true, value: undefined };
      if (listing.code !== 0) return { ok: false, failure: classifyGitFailure(listing) };
      const fetched = await this.mirrorGit(['-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '-q', url, `+${STATE_REF}:${INCOMING_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (fetched.code !== 0) {
        if (/couldn't find remote ref/.test(fetched.stderr)) return { ok: true, value: undefined };
        return { ok: false, failure: classifyGitFailure(fetched) };
      }
      const tip = gitText(mustSucceed(await this.mirrorGit(['rev-parse', '--verify', '-q', INCOMING_REF]), 'reading the fetched state'));
      return { ok: true, value: tip };
    }));
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

  /** One file's bytes, at most 16 MiB. */
  public readBlob(oid: string): Promise<Buffer> {
    return this.inMirror(async () => {
      if (!OID.test(oid)) throw new StateRefusedError('unsupported-format');
      const read = await this.mirrorGit(['cat-file', 'blob', oid], { maxStdoutBytes: MAX_BLOB_BYTES });
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
      const tree = gitText(mustSucceed(await this.mirrorGit(['mktree', '-z'], { input: Buffer.concat(lines) }), 'building the state tree'));
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
      const pushed = await this.mirrorGit(['push', '-q', resolved.value, `${commit}:${STATE_REF}`], { timeoutMs: NETWORK_TIMEOUT_MS });
      if (pushed.code !== 0) return { ok: false, failure: classifyGitFailure(pushed) };
      return { ok: true, value: commit };
    }));
  }
}
