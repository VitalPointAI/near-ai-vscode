// Git transport for the coordination log (D-01, D-02, D-03, D-04, D-16, D-17, D-25, D-29, D-33, D-34).
// The log lives on an orphan branch of the project's own remote. All work happens in a dedicated bare mirror, so the user's
// working tree, index and branches are never touched. Every git call goes through the injected GitRunner.
// Appends are compare-and-swap: a lost push race fetches again and calls the builder again, so Lamport, prev and the signature
// are always derived from the fresh state (D-29). A rewritten remote branch pauses the transport and is never followed (D-33).
// Several processes can share one mirror (every window of one VS Code keeps a team's mirror in the same folder), so operations take a
// cross-process lock as well as the in-process one, and each operation keeps to the commits it fetched itself instead of re-reading refs
// another process may have moved (debug session team-shared-mirror-duplicate-lamport).
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, EntryKind, LogHead, Materializer, TeamEvent } from '../domain/team/types';
import { MirrorBusyError, acquireFileLock } from '../services/stateMirrorLock';
import type { HeldMirrorLock, MirrorLockTimings } from '../services/stateMirrorLock';
import { NEUTRAL_IDENTITY_ENV, gitText, mustSucceed, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import { BRANCH_MISSING_REASON } from './transport';
import type { AppendBuild, AppendBuilder, AppendOptions, AppendResult, CoordinationTransport, TransportStatus, TransportSubscription } from './transport';

export const DEFAULT_COORDINATION_REF = 'refs/heads/near-ai/coordination';
// The last trusted head. Only advanced after the ancestry check passes, so readAll never reads past it (D-33).
export const LOCAL_REF = 'refs/team/coordination';
// Where a fetch lands before it is trusted. A rewritten branch stays here and never reaches LOCAL_REF.
export const INCOMING_REF = 'refs/team/incoming';
export const QUARANTINE_REF_PREFIX = 'refs/team/quarantine/';

// Hosted remotes may word a lost race differently (RESEARCH A1). These two lists are the only place to extend; an unknown
// rejection is permanent and is shown with its redacted text instead of being retried.
export const CAS_LOST_MARKERS = ['non-fast-forward', 'fetch first', 'incorrect old value provided'] as const;
export const RETRYABLE_FETCH_MARKERS = ['incorrect old value provided', 'cannot lock ref'] as const;
// Another process on the same mirror holds git's config.lock (two windows, or an agent and a window, opening one mirror together).
export const CONFIG_LOCK_MARKERS = ['could not lock config file'] as const;

const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const REF_PATTERN = /^refs\/(?:heads|near-ai)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SNAPSHOT_FILE_PATTERN = /^snapshots\/\d{12}\.json$/;
const TEAM_FILE = 'team.json';
const LOG_FORMAT = '--format=%x01%H%x00%ct%x00%P';
const MAX_LISTENER_ERRORS = 20;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_GC_EVERY = 100;
const FETCH_RACE_RETRIES = 3;
const CONFIG_LOCK_RETRIES = 20;
const LOCAL_TIMEOUT_MS = 15_000;
const BULK_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 60_000;
const DEFAULT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10';
// The name the mirror gives the remote for the length of one git call; it exists only in that process's environment, never in the mirror's config.
const TEAM_REMOTE_NAME = 'near-ai-team';
const AUTH_HINT = 'Run git fetch once in a terminal so your credential helper can store the credentials.';
// The team mirror's own lock file name. Project state sync's mirror uses a different name (D-23), so the two features never wait on each other.
export const TEAM_MIRROR_LOCK_FILE = 'near-ai-team-sync.lock';
// Another process (another window of this VS Code) kept the mirror for longer than the wait limit.
export const MIRROR_BUSY_SYNC_REASON = 'Another window on this computer is still syncing this team. Team sync will try again.';
export const MIRROR_BUSY_APPEND_REASON = 'Another window on this computer is still saving to this team. Try again in a moment.';

export interface GitTransportOptions<S> {
  mirrorDir: string;
  projectRoot: string;
  remote: string;
  ref: string;
  materializer: Materializer<S>;
  git?: GitRunner;
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  // Where the last trusted position is kept so a deleted mirror cannot hide a rewrite. Defaults to pin.json beside the mirror.
  pinFile?: string;
  // Run `git gc --auto` inside the mirror lock after this many successful operations (RESEARCH Pitfall 8).
  gcEveryOperations?: number;
  // The cross-process mirror lock's stale, refresh and wait times. Defaults suit real use; tests shorten them.
  lockTimings?: MirrorLockTimings;
}

class RemoteUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

interface RawChange { status: string; path: string; blob: string }
interface RawCommit { commit: string; commitTime: number; parents: string[]; changes: RawChange[] }
interface Pin { head: string; lamport: number; entries: number }
interface PushedAttempt { commit: string; events: TeamEvent[] }

export type PushOutcome =
  | { kind: 'ok' }
  | { kind: 'up-to-date' }
  | { kind: 'cas-lost'; detail: string }
  | { kind: 'permanent'; detail: string }
  | { kind: 'offline'; detail: string };

export type GitFailure =
  | { kind: 'absent' }
  | { kind: 'race' }
  | { kind: 'auth'; detail: string }
  | { kind: 'unreachable'; detail: string };

// Fetches and commits on one mirror are serialised in this process (D-34). Callers on the same mirror share one chain. Other processes are
// kept out by the file lock in stateMirrorLock (acquireFileLock), taken inside this one.
const mirrorLocks = new Map<string, Promise<void>>();

export async function withMirrorLock<T>(mirrorDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(mirrorDir);
  const previous = mirrorLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  mirrorLocks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (mirrorLocks.get(key) === tail) mirrorLocks.delete(key);
  }
}

// Reads a `git push --porcelain` result. Only the flagged ref lines are used: the "To <url>" line is never read, so a URL with
// credentials cannot reach a reason. An exit without any ref line (timeout, auth, network) is offline and may still have landed.
export function classifyPush(result: GitResult): PushOutcome {
  const lines = result.stdout.toString('utf8').split('\n').filter((line) => /^[ +\-*=!]\t/.test(line));
  const rejected = lines.filter((line) => line.startsWith('!'));
  const first = rejected[0];
  if (first !== undefined) {
    const columns = first.split('\t');
    const summary = redactGitMessage((columns[columns.length - 1] ?? '').trim());
    if (CAS_LOST_MARKERS.some((marker) => summary.includes(marker))) return { kind: 'cas-lost', detail: summary };
    const remoteLines = result.stderr.split('\n').filter((line) => line.startsWith('remote:')).slice(0, 3).map((line) => line.slice('remote:'.length).trim()).filter((line) => line !== '');
    const extra = remoteLines.length > 0 ? ` ${redactGitMessage(remoteLines.join(' '))}` : '';
    return { kind: 'permanent', detail: `${summary}${extra}` };
  }
  if (result.code === 0) return lines.some((line) => line.startsWith('=')) ? { kind: 'up-to-date' } : { kind: 'ok' };
  return { kind: 'offline', detail: redactGitMessage(result.stderr.trim() || `git push exited with ${result.code}`) };
}

// Classifies a failed fetch or ls-remote by its English stderr (LC_ALL=C is set by runGit).
export function classifyGitFailure(result: GitResult): GitFailure {
  const stderr = result.stderr;
  if (/couldn't find remote ref/.test(stderr)) return { kind: 'absent' };
  if (RETRYABLE_FETCH_MARKERS.some((marker) => stderr.includes(marker))) return { kind: 'race' };
  const detail = redactGitMessage(stderr.trim() || `git exited with ${result.code}`);
  if (/terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Permission denied|returned error: 40[13]/i.test(stderr)) return { kind: 'auth', detail };
  return { kind: 'unreachable', detail };
}

function failureReason(failure: GitFailure & { detail: string }): string {
  return failure.kind === 'auth' ? `${failure.detail} ${AUTH_HINT}` : failure.detail;
}

// `git log -z` output: \x01<sha>\0<commit time>\0<parents>\0 then, per changed file, \n:<modes> <old> <new> <status>\0<path>\0.
// Parsed token by token so a hostile file name can never be mistaken for a commit header.
export function parseLog(output: string): RawCommit[] {
  const tokens = output.split('\0');
  const commits: RawCommit[] = [];
  let index = 0;
  while (index < tokens.length) {
    const header = (tokens[index] ?? '').replace(/^\n+/, '');
    if (header === '') { index += 1; continue; }
    if (!header.startsWith('\x01')) throw new Error('Unexpected output from git log.');
    const commit = header.slice(1);
    const commitTime = Number(tokens[index + 1] ?? '0');
    const parents = (tokens[index + 2] ?? '').split(' ').filter((parent) => parent !== '');
    index += 3;
    const changes: RawChange[] = [];
    while (index < tokens.length) {
      const meta = (tokens[index] ?? '').replace(/^\n+/, '');
      if (!meta.startsWith(':')) break;
      const fields = meta.slice(1).split(' ');
      changes.push({ status: fields[4] ?? '', blob: fields[3] ?? '', path: tokens[index + 1] ?? '' });
      index += 2;
    }
    commits.push({ commit, commitTime: Number.isFinite(commitTime) ? commitTime : 0, parents, changes });
  }
  return commits;
}

function classify(rawPath: string, isRoot: boolean): { kind: EntryKind; anomaly?: string } {
  if (/^events\/[^/]+\.json$/.test(rawPath)) return { kind: 'event' };
  if (/^snapshots\/[^/]+\.json$/.test(rawPath)) return { kind: 'snapshot' };
  if (rawPath === TEAM_FILE && isRoot) return { kind: 'genesis-copy' };
  return { kind: 'anomaly', anomaly: TEAM_REJECTION_REASONS.unexpectedPath };
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function isPin(value: unknown): value is Pin {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.head === 'string' && /^[0-9a-f]{40,64}$/.test(record.head)
    && typeof record.lamport === 'number' && Number.isSafeInteger(record.lamport) && record.lamport >= 0
    && typeof record.entries === 'number' && Number.isSafeInteger(record.entries) && record.entries >= 0;
}

// The project's own git config decides the remote address, so it is checked before it reaches git (D-34). Allowed: an address with the scheme
// ssh, git, http, https or file; an scp-like address (user@host:path), which git reads as ssh; and a plain local path. Everything else is
// refused, most of all git's remote helpers: <transport>::<address> (ext:: runs a command, fd:: reads a descriptor) and any other scheme.
// The helper test is wider than git's own on purpose: any leading run of letters, digits, plus, dot and dash directly followed by two colons, on the
// value with surrounding whitespace removed, so a spelling git reads as a helper (a leading digit) and one it might (a leading dot) are both refused.
// The address checked is the one `git remote get-url --push` reports (remoteUrl below), which has the project's `url.<base>.insteadOf` and
// pushInsteadOf rules applied, so a rewrite to a helper is refused like the helper itself (0.4.25). Only that checked address reaches the mirror.
const HELPER_ADDRESS = /^[A-Za-z0-9+.-]*::/;
const SCHEME_ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
const CONTACTED_SCHEMES: ReadonlySet<string> = new Set(['ssh', 'git', 'http', 'https', 'file']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function isContactableRemoteAddress(address: string): boolean {
  const url = address.trim();
  if (url === '' || url.startsWith('-') || CONTROL_CHARACTER.test(address)) return false;
  if (HELPER_ADDRESS.test(url)) return false;
  const scheme = SCHEME_ADDRESS.exec(url);
  if (scheme !== null) return CONTACTED_SCHEMES.has((scheme[1] as string).toLowerCase());
  return true;
}

// 0.4.26 (PR #62 review): a git older than 2.31 cannot read the remote address from its environment, so the address goes on its command line, which
// other users of this computer can read. That is refused when the address can carry a credential: a user and password in any URL, or any user name in an
// http, https, ftp or ftps URL (where the "user" is often a token). An ssh user (ssh://git@host/..., git@host:path) is a name, not a secret, and is allowed.
// 0.4.27 (PR #67 review): a credential can also ride in the query of an http(s) or ftp(s) URL (`?access_token=...`), so any non-empty query there counts.
export const OLD_GIT_CREDENTIALS_TEXT = 'Your git is older than 2.31, so Team Mode would have to put the remote address on the git command line, where other users of this computer can read it, and that address carries a user name, password or token. Update git to 2.31 or newer, or remove the credentials from the remote address and let a git credential helper supply them.';

export function addressCarriesCredentials(address: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(address.trim());
  if (match === null) return false;
  const web = /^(?:https?|ftps?)$/i.test(match[1] as string);
  if (web && (match[4] ?? '') !== '') return true;
  const authority = match[2] as string;
  const at = authority.lastIndexOf('@');
  if (at < 0) return false;
  const userinfo = authority.slice(0, at);
  if (userinfo.includes(':')) return true;
  return web;
}

/** Whether a git version string (`git version 2.30.1`) reads remote config from the environment (2.31 and later). Unknown counts as no. */
export function gitReadsEnvironmentConfig(versionText: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionText);
  if (match === null) return false;
  const major = Number(match[1]);
  return major > 2 || (major === 2 && Number(match[2]) >= 31);
}

export class GitTransport<S> implements CoordinationTransport<S> {
  private readonly git: GitRunner;
  private readonly materializer: Materializer<S>;
  private readonly mirrorDir: string;
  private readonly projectRoot: string;
  private readonly remote: string;
  private readonly ref: string;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly pinFile: string;
  private readonly gcEvery: number;
  private readonly lockTimings: MirrorLockTimings;
  private readonly listeners = new Set<(entries: CommittedEvent[]) => void>();
  private readonly diagnosticListeners = new Set<(message: string) => void>();
  private readonly listenerErrors: string[] = [];
  private current: S;
  private lastProcessed: string | undefined;
  private appliedEntries = 0;
  private pin: Pin | undefined;
  private pinLoaded = false;
  private successes = 0;
  private mirrorReady = false;
  private statusValue: TransportStatus = { state: 'ok' };
  private envConfigSupport: Promise<boolean> | undefined;

  public constructor(options: GitTransportOptions<S>) {
    if (!REMOTE_PATTERN.test(options.remote)) throw new Error('The remote name in the team file is not valid.');
    if (!REF_PATTERN.test(options.ref) || options.ref.includes('..')) throw new Error('The coordination branch name in the team file is not valid.');
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    const gcEvery = options.gcEveryOperations ?? DEFAULT_GC_EVERY;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries must be a whole number of zero or more.');
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new Error('baseDelayMs must be zero or more.');
    if (!Number.isSafeInteger(gcEvery) || gcEvery < 1) throw new Error('gcEveryOperations must be a whole number of one or more.');
    this.git = options.git ?? runGit;
    this.materializer = options.materializer;
    this.mirrorDir = options.mirrorDir;
    this.projectRoot = options.projectRoot;
    this.remote = options.remote;
    this.ref = options.ref;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.pinFile = options.pinFile ?? path.join(path.dirname(options.mirrorDir), 'pin.json');
    this.gcEvery = gcEvery;
    this.lockTimings = { ...options.lockTimings };
    this.current = options.materializer.initial();
  }

  public state(): S {
    return this.current;
  }

  public status(): TransportStatus {
    return { ...this.statusValue };
  }

  // The commit last applied to the state plus the Lamport position and id of the last accepted event.
  public head(): { commit?: string; lamport: number; eventId: string } {
    const head = this.materializer.head(this.current);
    return this.lastProcessed === undefined ? { lamport: head.lamport, eventId: head.eventId } : { commit: this.lastProcessed, lamport: head.lamport, eventId: head.eventId };
  }

  // Errors thrown by update listeners are kept here (bounded) so one bad listener cannot break syncing for the others.
  public listenerFailures(): string[] {
    return [...this.listenerErrors];
  }

  public onUpdate(listener: (entries: CommittedEvent[]) => void): TransportSubscription {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  // Maintenance messages (a failed gc, an unreadable position file). Always redacted before delivery.
  public onDiagnostic(listener: (message: string) => void): TransportSubscription {
    this.diagnosticListeners.add(listener);
    return { dispose: () => { this.diagnosticListeners.delete(listener); } };
  }

  public fetch(): Promise<CommittedEvent[]> {
    return withMirrorLock(this.mirrorDir, async () => {
      const done = await this.exclusive(async () => {
        const entries = await this.fetchLocked();
        await this.afterOperation(this.statusValue.state === 'ok');
        return entries;
      });
      if (done !== undefined) return done.value;
      if (this.statusValue.state !== 'paused') this.setStatus({ state: 'offline', reason: MIRROR_BUSY_SYNC_REASON });
      return [];
    });
  }

  public readAll(): Promise<CommittedEvent[]> {
    return withMirrorLock(this.mirrorDir, async () => {
      const done = await this.exclusive(async () => {
        await this.ensureMirror();
        if (await this.revParse(LOCAL_REF) === undefined) return [];
        return this.readRange(LOCAL_REF);
      });
      if (done === undefined) throw new MirrorBusyError();
      return done.value;
    });
  }

  public append(build: AppendBuilder<S>, options?: AppendOptions): Promise<AppendResult> {
    return withMirrorLock(this.mirrorDir, async () => {
      const done = await this.exclusive(async () => {
        const result = options?.genesis ? await this.appendGenesis(build, options.genesis.teamFileText) : await this.appendExisting(build);
        await this.afterOperation(result.ok);
        return result;
      });
      return done?.value ?? { ok: false, kind: 'busy', reason: MIRROR_BUSY_APPEND_REASON, attempts: 0 };
    });
  }

  // Runs work with the mirror to this process alone (the caller already holds the in-process lock). undefined when another process kept the
  // mirror for longer than the wait limit; nothing ran then.
  private async exclusive<T>(work: () => Promise<T>): Promise<{ value: T } | undefined> {
    let held: HeldMirrorLock;
    try {
      held = await acquireFileLock(this.mirrorDir, TEAM_MIRROR_LOCK_FILE, { ...this.lockTimings, sleep: this.sleep, random: this.random });
    } catch (error) {
      if (error instanceof MirrorBusyError) return undefined;
      throw error;
    }
    try {
      return { value: await work() };
    } finally {
      try {
        await held.release();
      } catch (error) {
        this.diagnostic(`The coordination mirror's lock could not be released: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private mirrorGit(args: string[], extra: { env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number } = {}): Promise<GitResult> {
    return this.git(['--git-dir', this.mirrorDir, ...args], { timeoutMs: LOCAL_TIMEOUT_MS, ...extra });
  }

  private async ensureMirror(): Promise<void> {
    if (this.mirrorReady) return;
    await mkdir(this.mirrorDir, { recursive: true });
    let initialised = true;
    try {
      await stat(path.join(this.mirrorDir, 'HEAD'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      initialised = false;
    }
    if (!initialised) await this.initMirror();
    // The user's global hooks must never run on coordination commits (D-34): point the mirror at an empty hooks directory.
    const hooksDir = path.join(this.mirrorDir, 'coordination-hooks');
    await mkdir(hooksDir, { recursive: true });
    await this.setMirrorConfig('core.hooksPath', hooksDir);
    await this.setMirrorConfig('gc.autoDetach', 'false');
    // Objects from the remote are checked as they arrive. The remote URL is never written into this config (D-34).
    await this.setMirrorConfig('transfer.fsckObjects', 'true');
    this.mirrorReady = true;
  }

  // Two processes can create the same mirror together. The loser of the race to write git's config sees the winner's mirror, which is fine.
  private async initMirror(): Promise<void> {
    for (let retries = 0; ; retries += 1) {
      const result = await this.git(['init', '--bare', '-q', this.mirrorDir]);
      if (result.code === 0) return;
      try {
        await stat(path.join(this.mirrorDir, 'HEAD'));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!this.configLockRace(result) || retries >= CONFIG_LOCK_RETRIES) mustSucceed(result, 'Creating the coordination mirror');
      await this.sleep(this.configLockPause());
    }
  }

  // Writes a mirror setting only when it differs, so opening an existing mirror normally takes no lock. A write that still meets another
  // process's config.lock is retried with a short jittered pause (D-34: lock races are retryable).
  private async setMirrorConfig(key: string, value: string): Promise<void> {
    for (let retries = 0; ; retries += 1) {
      const current = await this.mirrorGit(['config', '--get', key]);
      if (current.code === 0 && gitText(current) === value) return;
      const result = await this.mirrorGit(['config', key, value]);
      if (result.code === 0) return;
      if (!this.configLockRace(result) || retries >= CONFIG_LOCK_RETRIES) mustSucceed(result, 'Configuring the coordination mirror');
      await this.sleep(this.configLockPause());
    }
  }

  private configLockRace(result: GitResult): boolean {
    return CONFIG_LOCK_MARKERS.some((marker) => result.stderr.includes(marker));
  }

  private configLockPause(): number {
    return Math.max(1, this.baseDelayMs / 8) * (0.5 + this.random());
  }

  // Read on every call and never stored or returned: the URL can embed credentials (D-34). get-url applies the project's insteadOf and
  // pushInsteadOf rules, so the address checked here is the address used.
  private async remoteUrl(): Promise<string> {
    const result = await this.git(['-C', this.projectRoot, 'remote', 'get-url', '--push', this.remote], { timeoutMs: LOCAL_TIMEOUT_MS });
    const url = gitText(result);
    if (result.code !== 0 || url === '') throw new RemoteUnavailableError(`This project has no git remote named "${this.remote}".`);
    // The project's own git config decides this value, and a cloned repository can set it. A value that starts with a dash would read as an
    // option wherever the URL reaches git as an argument (a git older than 2.31), so it is refused here, before any network call.
    if (url.startsWith('-')) throw new RemoteUnavailableError(`The address of the git remote named "${this.remote}" is not one Team Mode will contact.`);
    if (!isContactableRemoteAddress(url)) {
      throw new RemoteUnavailableError(`The address of the git remote named "${this.remote}" is not one Team Mode will contact. Team Mode uses ssh, git, https, http or file addresses, or a local path.`);
    }
    // Checked here, where every caller already handles a refusal, rather than where the address is handed to git (0.4.26, PR #62 review).
    if (addressCarriesCredentials(url) && !(await this.supportsEnvironmentConfig())) throw new RemoteUnavailableError(OLD_GIT_CREDENTIALS_TEXT);
    return url;
  }

  // Only an ssh command inherited from the environment is passed on, and it is left where it is. A value from the project's own git
  // config is never copied into the environment: a cloned or hostile folder could set it, and the mirror does not read that config.
  // An ssh command git itself would apply to the mirror (the user's global config) is left to git. Without either, a non-interactive
  // command keeps a passphrase prompt from hanging.
  private async networkEnv(): Promise<Record<string, string>> {
    // 0.4.25: GIT_SSH counts as inherited too; setting the default GIT_SSH_COMMAND would otherwise override it.
    for (const name of ['GIT_SSH_COMMAND', 'GIT_SSH']) {
      const inherited = process.env[name];
      if (inherited !== undefined && inherited !== '') return {};
    }
    const configured = await this.mirrorGit(['config', '--get', 'core.sshCommand']);
    if (configured.code === 0 && gitText(configured) !== '') return {};
    return { GIT_SSH_COMMAND: DEFAULT_SSH_COMMAND };
  }

  // git 2.31 and later read config from the environment. The remote URL can carry a credential (https://user:token@host), and a process
  // command line is readable by other local users, so the URL travels in the environment of the git process instead of its arguments (WR-12).
  // An older git cannot do that, so it falls back to the argument form.
  private async supportsEnvironmentConfig(): Promise<boolean> {
    if (this.envConfigSupport === undefined) {
      this.envConfigSupport = this.git(['--version'], { timeoutMs: LOCAL_TIMEOUT_MS }).then((result) => result.code === 0 && gitReadsEnvironmentConfig(gitText(result)), () => false);
    }
    return this.envConfigSupport;
  }

  // The remote name (or URL, on an old git) to hand to fetch, push and ls-remote, with the environment that makes it resolve.
  private async networkTarget(url: string): Promise<{ target: string; env: Record<string, string> }> {
    const env = await this.networkEnv();
    if (!(await this.supportsEnvironmentConfig())) return { target: url, env };
    const inherited = Number(process.env.GIT_CONFIG_COUNT ?? '0');
    const index = Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
    return {
      target: TEAM_REMOTE_NAME,
      env: { ...env, GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: `remote.${TEAM_REMOTE_NAME}.url`, [`GIT_CONFIG_VALUE_${index}`]: url }
    };
  }

  private async revParse(ref: string): Promise<string | undefined> {
    const result = await this.mirrorGit(['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    if (result.code === 0) return gitText(result);
    if (result.code === 1) return undefined;
    throw new Error(`Reading ${ref} failed: ${redactGitMessage(result.stderr.trim() || `exit code ${result.code}`)}`);
  }

  private setStatus(next: TransportStatus): void {
    this.statusValue = next;
  }

  private diagnostic(message: string): void {
    const text = redactGitMessage(message);
    for (const listener of this.diagnosticListeners) {
      try {
        listener(text);
      } catch (error) {
        this.recordListenerError(error);
      }
    }
  }

  private recordListenerError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.listenerErrors.push(redactGitMessage(message));
    if (this.listenerErrors.length > MAX_LISTENER_ERRORS) this.listenerErrors.shift();
  }

  private backoff(attempt: number): number {
    return this.baseDelayMs * 2 ** (attempt - 1) * (0.5 + this.random());
  }

  // Counted inside the mirror lock. A failed gc is a diagnostic and never changes the status (RESEARCH Pitfall 8).
  private async afterOperation(success: boolean): Promise<void> {
    if (!success) return;
    this.successes += 1;
    if (this.successes % this.gcEvery !== 0) return;
    const result = await this.mirrorGit(['gc', '--auto', '--quiet'], { timeoutMs: BULK_TIMEOUT_MS });
    if (result.code !== 0) this.diagnostic(`Maintenance of the coordination mirror failed: ${result.stderr.trim() || `git gc exited with ${result.code}`}`);
  }

  private async loadPin(): Promise<void> {
    if (this.pinLoaded) return;
    this.pinLoaded = true;
    let text: string;
    try {
      text = await readFile(this.pinFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.diagnostic('The saved coordination position could not be read, so it was ignored.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.diagnostic(`The saved coordination position is not valid JSON, so it was ignored: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (isPin(parsed)) this.pin = { head: parsed.head, lamport: parsed.lamport, entries: parsed.entries };
    else this.diagnostic('The saved coordination position has an unexpected shape, so it was ignored.');
  }

  // Temp file then rename, so a crash never leaves half a pin. Failure is a diagnostic: syncing continues.
  private async savePin(head: string): Promise<void> {
    if (this.pin?.head === head && this.pin.entries === this.appliedEntries) return;
    const next: Pin = { head, lamport: this.materializer.head(this.current).lamport, entries: this.appliedEntries };
    const temp = `${this.pinFile}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    try {
      await mkdir(path.dirname(this.pinFile), { recursive: true });
      await writeFile(temp, `${JSON.stringify(next)}\n`, 'utf8');
      await rename(temp, this.pinFile);
      this.pin = next;
    } catch (error) {
      this.diagnostic(`The coordination position could not be saved: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await rm(temp, { force: true });
      } catch (cleanupError) {
        this.diagnostic(`A temporary coordination position file could not be removed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
    }
  }

  // Fetches into the staging ref. The lock-race wording is retried a few times with a short jittered pause (D-34).
  private async fetchRemote(url: string): Promise<GitResult> {
    const { target, env } = await this.networkTarget(url);
    let retries = 0;
    for (;;) {
      const result = await this.mirrorGit(['fetch', '--no-tags', '--quiet', target, `+${this.ref}:${INCOMING_REF}`], { env, timeoutMs: NETWORK_TIMEOUT_MS });
      if (result.code === 0 || classifyGitFailure(result).kind !== 'race' || retries >= FETCH_RACE_RETRIES) return result;
      retries += 1;
      await this.sleep(Math.max(1, this.baseDelayMs / 8) * (0.5 + this.random()));
    }
  }

  // Every previously trusted commit must still be an ancestor of (or equal to) the fetched head.
  private async checkAncestry(trusted: string[], head: string): Promise<{ kind: 'ok' } | { kind: 'rewritten'; old: string; present: boolean } | { kind: 'unknown'; detail: string }> {
    for (const old of trusted) {
      if (old === head) continue;
      const present = await this.mirrorGit(['cat-file', '-e', `${old}^{commit}`]);
      if (present.code !== 0) return { kind: 'rewritten', old, present: false };
      const ancestor = await this.mirrorGit(['merge-base', '--is-ancestor', old, head]);
      if (ancestor.code === 1) return { kind: 'rewritten', old, present: true };
      if (ancestor.code !== 0) return { kind: 'unknown', detail: redactGitMessage(ancestor.stderr.trim() || `git merge-base exited with ${ancestor.code}`) };
    }
    return { kind: 'ok' };
  }

  private async fetchLocked(): Promise<CommittedEvent[]> {
    if (this.statusValue.state === 'paused') return [];
    try {
      await this.ensureMirror();
      await this.loadPin();
      // Read before the fetch. Another process on this mirror may move the ref while the fetch runs; a head it fetched after this one must not
      // look like a rewrite of what this fetch brought (the remote only moves forward, so this fetch's head descends from the value read here).
      const local = await this.revParse(LOCAL_REF);
      const url = await this.remoteUrl();
      const fetched = await this.fetchRemote(url);
      if (fetched.code !== 0) {
        const failure = classifyGitFailure(fetched);
        // A remote without the coordination branch yet is a normal state, not a failure.
        if (failure.kind === 'absent') {
          // Only a branch that was never read is normal. One this client has read (a local copy or a saved position) and that is now gone
          // was deleted on the remote, which must stay visible instead of reading as a healthy, empty team (WR-10).
          const seen = this.pin !== undefined || local !== undefined;
          this.setStatus(seen ? { state: 'offline', reason: BRANCH_MISSING_REASON } : { state: 'ok' });
          return [];
        }
        const reason = failure.kind === 'race' ? 'The remote was busy and could not be read. Team sync will try again.' : failureReason(failure);
        this.setStatus({ state: 'offline', reason });
        return [];
      }
      const head = await this.revParse(INCOMING_REF);
      if (head === undefined) {
        this.setStatus({ state: 'ok' });
        return [];
      }
      const trusted: string[] = [];
      if (local !== undefined) trusted.push(local);
      if (this.pin !== undefined && !trusted.includes(this.pin.head)) trusted.push(this.pin.head);
      const ancestry = await this.checkAncestry(trusted, head);
      if (ancestry.kind === 'unknown') {
        this.setStatus({ state: 'offline', reason: `Team sync could not compare coordination heads: ${ancestry.detail}` });
        return [];
      }
      if (ancestry.kind === 'rewritten') {
        // The remote branch was rewritten (D-33): keep the last good state, keep the old objects reachable, and stop syncing.
        if (ancestry.present) mustSucceed(await this.mirrorGit(['update-ref', `${QUARANTINE_REF_PREFIX}${ancestry.old.slice(0, 12)}`, ancestry.old]), 'Keeping the previous coordination history');
        else this.diagnostic('The previous coordination history is no longer in the mirror, so only the saved position marks the rewrite.');
        this.setStatus({ state: 'paused', reason: TEAM_REJECTION_REASONS.logRewritten });
        return [];
      }
      this.setStatus({ state: 'ok' });
      if (local !== head) mustSucceed(await this.mirrorGit(['update-ref', LOCAL_REF, head]), 'Recording the coordination head');
      if (head === this.lastProcessed) return [];
      // Up to the commit this fetch produced, not to the shared ref, which another process may already have moved further: the state must
      // stand exactly at lastProcessed, or the next fetch would apply the entries past it a second time.
      const entries = await this.readRange(this.lastProcessed === undefined ? head : `${this.lastProcessed}..${head}`);
      for (const entry of entries) entry.verdict = this.materializer.apply(this.current, entry);
      this.lastProcessed = head;
      this.appliedEntries += entries.length;
      await this.savePin(head);
      if (entries.length > 0) this.notify(entries);
      return entries;
    } catch (error) {
      if (error instanceof RemoteUnavailableError) {
        this.setStatus({ state: 'offline', reason: error.message });
        return [];
      }
      throw error;
    }
  }

  private notify(entries: CommittedEvent[]): void {
    for (const listener of this.listeners) {
      try {
        listener(entries);
      } catch (error) {
        this.recordListenerError(error);
      }
    }
  }

  // Reads commits first-parent and oldest first. Event files inside one commit come out in file-name order (D-03).
  // Only added files can become entries, and their text comes from the blob the adding commit named (D-03). A merge commit,
  // a modified or deleted file and a file in an unexpected place each become an anomaly row, never state.
  private async readRange(range: string): Promise<CommittedEvent[]> {
    const logged = mustSucceed(await this.mirrorGit(['log', '--first-parent', '--reverse', '--no-renames', '--raw', '-z', '--no-abbrev', LOG_FORMAT, range], { timeoutMs: BULK_TIMEOUT_MS }), 'Reading the coordination log');
    const commits = parseLog(logged.stdout.toString('utf8'));
    const wanted = new Set<string>();
    for (const commit of commits) for (const change of commit.changes) if (change.status === 'A') wanted.add(change.blob);
    const sizes = await this.blobSizes([...wanted]);
    const texts = await this.blobTexts([...wanted].filter((blob) => (sizes.get(blob) ?? 0) <= 64 * 1024));
    const entries: CommittedEvent[] = [];
    for (const commit of commits) {
      const isRoot = commit.parents.length === 0;
      if (commit.parents.length > 1) entries.push({ commit: commit.commit, commitTime: commit.commitTime, path: '', blob: '', size: 0, text: '', kind: 'anomaly', anomaly: TEAM_REJECTION_REASONS.mergeCommit });
      for (const change of commit.changes) {
        if (change.status !== 'A') {
          entries.push({ commit: commit.commit, commitTime: commit.commitTime, path: change.path, blob: change.blob, size: 0, text: '', kind: 'anomaly', anomaly: TEAM_REJECTION_REASONS.historyChanged });
          continue;
        }
        const { kind, anomaly } = classify(change.path, isRoot);
        const entry: CommittedEvent = { commit: commit.commit, commitTime: commit.commitTime, path: change.path, blob: change.blob, size: sizes.get(change.blob) ?? 0, text: texts.get(change.blob) ?? '', kind };
        if (anomaly !== undefined) entry.anomaly = anomaly;
        entries.push(entry);
      }
    }
    return entries;
  }

  private async blobSizes(blobs: string[]): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    if (blobs.length === 0) return sizes;
    const result = mustSucceed(await this.mirrorGit(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${blobs.join('\n')}\n`, timeoutMs: BULK_TIMEOUT_MS }), 'Reading coordination file sizes');
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const fields = line.split(' ');
      if (fields.length === 3 && fields[1] === 'blob') sizes.set(fields[0] ?? '', Number(fields[2]));
    }
    return sizes;
  }

  private async blobTexts(blobs: string[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    if (blobs.length === 0) return texts;
    const output = mustSucceed(await this.mirrorGit(['cat-file', '--batch'], { input: `${blobs.join('\n')}\n`, timeoutMs: BULK_TIMEOUT_MS }), 'Reading coordination files').stdout;
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

  private normalise(build: AppendBuild): { events: TeamEvent[]; files: Array<{ path: string; text: string }> } | { conflict: string } {
    if (Array.isArray(build)) return { events: build, files: [] };
    if ('conflict' in build) return { conflict: build.conflict };
    return { events: build.events, files: build.files ?? [] };
  }

  // Is a commit pushed by an earlier attempt of this operation now part of the fetched history? Then it landed even though
  // the response was lost, and appending again would write a duplicate (RESEARCH Pitfall 6).
  private async findLanded(pushed: PushedAttempt[], head: string): Promise<PushedAttempt | undefined> {
    for (const attempt of pushed) {
      const result = await this.mirrorGit(['merge-base', '--is-ancestor', attempt.commit, head]);
      if (result.code === 0) return attempt;
      if (result.code !== 1) throw new Error(`Comparing coordination history failed: ${redactGitMessage(result.stderr.trim() || `exit code ${result.code}`)}`);
    }
    return undefined;
  }

  private async appendExisting(build: AppendBuilder<S>): Promise<AppendResult> {
    const maxAttempts = this.maxRetries + 1;
    const pushed: PushedAttempt[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await this.fetchLocked();
      const status = this.statusValue;
      if (status.state === 'paused') return { ok: false, kind: 'paused', reason: status.reason ?? TEAM_REJECTION_REASONS.logRewritten, attempts: attempt - 1 };
      if (status.state === 'offline') return { ok: false, kind: 'offline', reason: status.reason ?? 'The remote is not reachable.', attempts: attempt - 1 };
      // The parent is the commit the state was built from, never a fresh read of the mirror's ref: another process on this mirror may have moved
      // that ref, and an event stamped from older state on a newer parent is a fast-forward the remote accepts and every reader rejects. With
      // this parent the remote's compare-and-swap refuses the push unless the state the builder saw is the remote head.
      const head = this.lastProcessed;
      if (head === undefined) return { ok: false, kind: 'refused', reason: 'The coordination log does not exist yet. Enable Team Mode first.', attempts: attempt - 1 };

      const landed = await this.findLanded(pushed, head);
      if (landed !== undefined) return { ok: true, events: landed.events, commit: landed.commit, attempts: attempt };

      const built = this.normalise(await build(this.current, this.materializer.head(this.current)));
      const failKind = attempt === 1 ? 'refused' : 'conflict';
      if ('conflict' in built) return { ok: false, kind: failKind, reason: built.conflict, attempts: attempt };
      if (built.events.length === 0) return { ok: false, kind: 'refused', reason: 'There were no events to write.', attempts: attempt };
      const rejection = this.materializer.check(this.current, built.events);
      if (rejection !== undefined) return { ok: false, kind: failKind, reason: rejection.reason, attempts: attempt };
      const files = built.events.map((event) => ({ path: eventPath(event), text: canonicalize(event) }));
      for (const extra of built.files) {
        if (!SNAPSHOT_FILE_PATTERN.test(extra.path)) return { ok: false, kind: 'refused', reason: 'The coordination commit named a file that is not allowed.', attempts: attempt };
        const existing = await this.mirrorGit(['cat-file', '-e', `${head}:${extra.path}`]);
        if (existing.code === 0) return { ok: false, kind: failKind, reason: 'A snapshot for this point already exists.', attempts: attempt };
        files.push(extra);
      }
      const first = built.events[0] as TeamEvent;
      const commit = await this.commitFiles(files, head, `team: ${first.type} ${first.id}`);

      let url: string;
      try {
        url = await this.remoteUrl();
      } catch (error) {
        if (error instanceof RemoteUnavailableError) {
          this.setStatus({ state: 'offline', reason: error.message });
          return { ok: false, kind: 'offline', reason: error.message, attempts: attempt };
        }
        throw error;
      }
      const { target, env } = await this.networkTarget(url);
      const outcome = classifyPush(await this.mirrorGit(['push', '--porcelain', target, `${commit}:${this.ref}`], { env, timeoutMs: NETWORK_TIMEOUT_MS }));
      if (outcome.kind === 'ok' || outcome.kind === 'up-to-date') {
        // D-19: fetch straight after a local append so the state and listeners include the new events.
        await this.fetchLocked();
        return { ok: true, events: built.events, commit, attempts: attempt };
      }
      if (outcome.kind === 'permanent') return { ok: false, kind: 'remote-rejected', reason: outcome.detail, attempts: attempt };
      // A lost race, or a push whose answer never arrived (it may still have landed): remember the commit, then fetch again.
      pushed.push({ commit, events: built.events });
      if (attempt === maxAttempts) {
        if (outcome.kind === 'offline') {
          this.setStatus({ state: 'offline', reason: outcome.detail });
          return { ok: false, kind: 'offline', reason: outcome.detail, attempts: attempt };
        }
        return { ok: false, kind: 'busy', reason: 'The team record changed too often while saving. Try again in a moment.', attempts: attempt };
      }
      await this.sleep(this.backoff(attempt));
    }
    return { ok: false, kind: 'busy', reason: 'The team record changed too often while saving. Try again in a moment.', attempts: maxAttempts };
  }

  private async appendGenesis(build: AppendBuilder<S>, teamFileText: string): Promise<AppendResult> {
    let url: string;
    try {
      url = await this.remoteUrl();
      await this.ensureMirror();
    } catch (error) {
      if (error instanceof RemoteUnavailableError) return { ok: false, kind: 'refused', reason: error.message, attempts: 0 };
      throw error;
    }
    const { target, env } = await this.networkTarget(url);
    const probe = await this.mirrorGit(['ls-remote', '--exit-code', target, this.ref], { env, timeoutMs: NETWORK_TIMEOUT_MS });
    if (probe.code === 0) return { ok: false, kind: 'exists', reason: 'This remote already has a coordination log', attempts: 0 };
    if (probe.code !== 2) {
      const failure = classifyGitFailure(probe);
      const reason = failure.kind === 'auth' || failure.kind === 'unreachable' ? failureReason(failure) : redactGitMessage(probe.stderr.trim() || `git ls-remote exited with ${probe.code}`);
      this.setStatus({ state: 'offline', reason });
      return { ok: false, kind: 'offline', reason, attempts: 1 };
    }
    const initial = this.materializer.initial();
    const head: LogHead = this.materializer.head(initial);
    const built = this.normalise(await build(initial, head));
    if ('conflict' in built) return { ok: false, kind: 'conflict', reason: built.conflict, attempts: 1 };
    if (built.events.length === 0) return { ok: false, kind: 'refused', reason: 'There were no events to write.', attempts: 1 };
    const rejection = this.materializer.check(initial, built.events);
    if (rejection !== undefined) return { ok: false, kind: 'refused', reason: rejection.reason, attempts: 1 };
    const files = built.events.map((event) => ({ path: eventPath(event), text: canonicalize(event) }));
    for (const extra of built.files) {
      if (!SNAPSHOT_FILE_PATTERN.test(extra.path)) return { ok: false, kind: 'refused', reason: 'The coordination commit named a file that is not allowed.', attempts: 1 };
      files.push(extra);
    }
    files.push({ path: TEAM_FILE, text: teamFileText });
    const first = built.events[0] as TeamEvent;
    const commit = await this.commitFiles(files, undefined, `team: ${first.type} ${first.id}`);
    const outcome = classifyPush(await this.mirrorGit(['push', '--porcelain', target, `${commit}:${this.ref}`], { env, timeoutMs: NETWORK_TIMEOUT_MS }));
    if (outcome.kind === 'cas-lost') return { ok: false, kind: 'exists', reason: 'This remote already has a coordination log', attempts: 1 };
    if (outcome.kind === 'permanent') return { ok: false, kind: 'remote-rejected', reason: outcome.detail, attempts: 1 };
    if (outcome.kind === 'offline') {
      this.setStatus({ state: 'offline', reason: outcome.detail });
      return { ok: false, kind: 'offline', reason: outcome.detail, attempts: 1 };
    }
    await this.fetchLocked();
    return { ok: true, events: built.events, commit, attempts: 1 };
  }

  // Plumbing commit: blobs are written directly, a throw-away index builds the tree, and commit-tree makes the commit.
  // Nothing here reads or changes the user's repository.
  private async commitFiles(files: Array<{ path: string; text: string }>, parent: string | undefined, message: string): Promise<string> {
    const indexFile = path.join(this.mirrorDir, `index-${process.pid}-${randomBytes(4).toString('hex')}`);
    const env = { GIT_INDEX_FILE: indexFile, ...NEUTRAL_IDENTITY_ENV };
    let commit = '';
    let failure: unknown;
    try {
      if (parent !== undefined) mustSucceed(await this.mirrorGit(['read-tree', parent], { env }), 'Reading the coordination tree');
      for (const file of files) {
        const blob = gitText(mustSucceed(await this.mirrorGit(['hash-object', '-w', '--stdin'], { env, input: file.text }), 'Writing a coordination file'));
        mustSucceed(await this.mirrorGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], { env }), 'Staging a coordination file');
      }
      const tree = gitText(mustSucceed(await this.mirrorGit(['write-tree'], { env }), 'Writing the coordination tree'));
      const args = ['commit-tree', tree, ...(parent === undefined ? [] : ['-p', parent]), '-m', message];
      commit = gitText(mustSucceed(await this.mirrorGit(args, { env }), 'Writing the coordination commit'));
    } catch (error) {
      failure = error;
    }
    try {
      await rm(indexFile, { force: true });
    } catch (error) {
      throw new Error('Removing the temporary coordination index failed.', { cause: failure ?? error });
    }
    if (failure !== undefined) throw failure;
    return commit;
  }
}
