// Git transport for the coordination log (D-01, D-02, D-03, D-04, D-16, D-17, D-34).
// The log lives on an orphan branch of the project's own remote. All work happens in a dedicated bare mirror, so the user's
// working tree, index and branches are never touched. Every git call goes through the injected GitRunner.
// Tracer scope: fetch and incremental read, plus the genesis append. The retry loop for an existing branch belongs to plan 60-03.
import { mkdir, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { CommittedEvent, EntryKind, LogHead, Materializer, TeamEvent } from '../domain/team/types';
import { NEUTRAL_IDENTITY_ENV, gitText, mustSucceed, redactGitMessage, runGit } from './runGit';
import type { GitResult, GitRunner } from './runGit';
import type { AppendBuild, AppendBuilder, AppendOptions, AppendResult, CoordinationTransport, TransportStatus, TransportSubscription } from './transport';

export const DEFAULT_COORDINATION_REF = 'refs/heads/near-ai/coordination';
export const LOCAL_REF = 'refs/team/coordination';

const REMOTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const REF_PATTERN = /^refs\/(?:heads|near-ai)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EXTRA_FILE_PATTERN = /^(?:events|snapshots)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;
const TEAM_FILE = 'team.json';
const LOG_FORMAT = '--format=%x01%H%x00%ct%x00%P';
const MAX_LISTENER_ERRORS = 20;

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
  pinFile?: string;
}

class RemoteUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RemoteUnavailableError';
  }
}

interface RawChange { status: string; path: string; blob: string }
interface RawCommit { commit: string; commitTime: number; parents: string[]; changes: RawChange[] }

// Fetches and commits on one mirror are serialised in this process (D-34). Callers on the same mirror share one chain.
const mirrorLocks = new Map<string, Promise<void>>();

async function withMirrorLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = mirrorLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  mirrorLocks.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (mirrorLocks.get(key) === tail) mirrorLocks.delete(key);
  }
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

function pushDetail(result: GitResult): { kind: 'rejected' | 'remote-rejected' | 'other'; reason: string } {
  const lines = result.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('!'));
  const line = lines[0];
  if (line === undefined) return { kind: 'other', reason: redactGitMessage(result.stderr.trim() || `git push exited with ${result.code}`) };
  const columns = line.split('\t');
  const summary = redactGitMessage((columns[columns.length - 1] ?? '').trim());
  return { kind: summary.startsWith('[remote rejected]') ? 'remote-rejected' : 'rejected', reason: summary };
}

export class GitTransport<S> implements CoordinationTransport<S> {
  private readonly git: GitRunner;
  private readonly materializer: Materializer<S>;
  private readonly mirrorDir: string;
  private readonly projectRoot: string;
  private readonly remote: string;
  private readonly ref: string;
  private readonly listeners = new Set<(entries: CommittedEvent[]) => void>();
  private readonly listenerErrors: string[] = [];
  private current: S;
  private lastProcessed: string | undefined;
  private mirrorReady = false;
  private statusValue: TransportStatus = { state: 'ok' };

  public constructor(options: GitTransportOptions<S>) {
    if (!REMOTE_PATTERN.test(options.remote)) throw new Error('The remote name in the team file is not valid.');
    if (!REF_PATTERN.test(options.ref) || options.ref.includes('..')) throw new Error('The coordination branch name in the team file is not valid.');
    this.git = options.git ?? runGit;
    this.materializer = options.materializer;
    this.mirrorDir = options.mirrorDir;
    this.projectRoot = options.projectRoot;
    this.remote = options.remote;
    this.ref = options.ref;
    this.current = options.materializer.initial();
  }

  public state(): S {
    return this.current;
  }

  public status(): TransportStatus {
    return { ...this.statusValue };
  }

  // Errors thrown by update listeners are kept here (bounded) so one bad listener cannot break syncing for the others.
  public listenerFailures(): string[] {
    return [...this.listenerErrors];
  }

  public onUpdate(listener: (entries: CommittedEvent[]) => void): TransportSubscription {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  public fetch(): Promise<CommittedEvent[]> {
    return withMirrorLock(this.mirrorDir, () => this.fetchLocked());
  }

  public readAll(): Promise<CommittedEvent[]> {
    return withMirrorLock(this.mirrorDir, async () => {
      await this.ensureMirror();
      if (await this.revParse(LOCAL_REF) === undefined) return [];
      return this.readRange(LOCAL_REF);
    });
  }

  public append(build: AppendBuilder<S>, options?: AppendOptions): Promise<AppendResult> {
    return withMirrorLock(this.mirrorDir, () => (options?.genesis ? this.appendGenesis(build, options.genesis.teamFileText) : this.appendExisting()));
  }

  private mirrorGit(args: string[], extra: { env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number } = {}): Promise<GitResult> {
    return this.git(['--git-dir', this.mirrorDir, ...args], extra);
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
    if (!initialised) mustSucceed(await this.git(['init', '--bare', '-q', this.mirrorDir]), 'Creating the coordination mirror');
    // The user's global hooks must never run on coordination commits (D-34): point the mirror at an empty hooks directory.
    const hooksDir = path.join(this.mirrorDir, 'coordination-hooks');
    await mkdir(hooksDir, { recursive: true });
    mustSucceed(await this.mirrorGit(['config', 'core.hooksPath', hooksDir]), 'Configuring the coordination mirror');
    mustSucceed(await this.mirrorGit(['config', 'gc.autoDetach', 'false']), 'Configuring the coordination mirror');
    this.mirrorReady = true;
  }

  // Read on every call and never stored or returned: the URL can embed credentials (D-34).
  private async remoteUrl(): Promise<string> {
    const result = await this.git(['-C', this.projectRoot, 'remote', 'get-url', '--push', this.remote]);
    const url = gitText(result);
    if (result.code !== 0 || url === '') throw new RemoteUnavailableError(`This project has no git remote named "${this.remote}".`);
    return url;
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

  private async fetchLocked(): Promise<CommittedEvent[]> {
    if (this.statusValue.state === 'paused') return [];
    try {
      await this.ensureMirror();
      const url = await this.remoteUrl();
      const previousHead = await this.revParse(LOCAL_REF);
      const fetched = await this.mirrorGit(['fetch', '--no-tags', '--quiet', url, `+${this.ref}:${LOCAL_REF}`]);
      if (fetched.code !== 0) {
        // A remote without the coordination branch yet is a normal state, not a failure.
        if (/couldn't find remote ref/.test(fetched.stderr)) {
          this.setStatus({ state: 'ok' });
          return [];
        }
        this.setStatus({ state: 'offline', reason: redactGitMessage(fetched.stderr.trim() || `git fetch exited with ${fetched.code}`) });
        return [];
      }
      const head = await this.revParse(LOCAL_REF);
      if (head === undefined) {
        this.setStatus({ state: 'ok' });
        return [];
      }
      if (previousHead !== undefined && head !== previousHead) {
        const ancestor = await this.mirrorGit(['merge-base', '--is-ancestor', previousHead, head]);
        if (ancestor.code === 1) {
          // The remote branch was rewritten (D-33): keep the last good state, keep the old objects reachable, and stop syncing.
          mustSucceed(await this.mirrorGit(['update-ref', `refs/team/quarantine/${previousHead.slice(0, 12)}`, previousHead]), 'Keeping the previous coordination history');
          this.setStatus({ state: 'paused', reason: TEAM_REJECTION_REASONS.logRewritten });
          return [];
        }
        if (ancestor.code !== 0) throw new Error(`Comparing coordination history failed: ${redactGitMessage(ancestor.stderr.trim())}`);
      }
      this.setStatus({ state: 'ok' });
      if (head === this.lastProcessed) return [];
      const entries = await this.readRange(this.lastProcessed === undefined ? LOCAL_REF : `${this.lastProcessed}..${LOCAL_REF}`);
      for (const entry of entries) entry.verdict = this.materializer.apply(this.current, entry);
      this.lastProcessed = head;
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
        const message = error instanceof Error ? error.message : String(error);
        this.listenerErrors.push(redactGitMessage(message));
        if (this.listenerErrors.length > MAX_LISTENER_ERRORS) this.listenerErrors.shift();
      }
    }
  }

  // Reads commits first-parent and oldest first. Event files inside one commit come out in file-name order (D-03).
  private async readRange(range: string): Promise<CommittedEvent[]> {
    const logged = mustSucceed(await this.mirrorGit(['log', '--first-parent', '--reverse', '--no-renames', '--raw', '-z', '--no-abbrev', LOG_FORMAT, range]), 'Reading the coordination log');
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
    const result = mustSucceed(await this.mirrorGit(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${blobs.join('\n')}\n` }), 'Reading coordination file sizes');
    for (const line of result.stdout.toString('utf8').split('\n')) {
      const fields = line.split(' ');
      if (fields.length === 3 && fields[1] === 'blob') sizes.set(fields[0] ?? '', Number(fields[2]));
    }
    return sizes;
  }

  private async blobTexts(blobs: string[]): Promise<Map<string, string>> {
    const texts = new Map<string, string>();
    if (blobs.length === 0) return texts;
    const output = mustSucceed(await this.mirrorGit(['cat-file', '--batch'], { input: `${blobs.join('\n')}\n` }), 'Reading coordination files').stdout;
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

  private async appendExisting(): Promise<AppendResult> {
    await this.fetchLocked();
    const status = this.statusValue;
    if (status.state === 'paused') return { ok: false, kind: 'paused', reason: status.reason ?? TEAM_REJECTION_REASONS.logRewritten, attempts: 0 };
    if (status.state === 'offline') return { ok: false, kind: 'offline', reason: status.reason ?? 'The remote is not reachable.', attempts: 0 };
    if (await this.revParse(LOCAL_REF) === undefined) return { ok: false, kind: 'refused', reason: 'The coordination log does not exist yet. Enable Team Mode first.', attempts: 0 };
    return { ok: false, kind: 'refused', reason: 'Adding to an existing coordination log is not available in this build yet.', attempts: 0 };
  }

  private normalise(build: AppendBuild): { events: TeamEvent[]; files: Array<{ path: string; text: string }> } | { conflict: string } {
    if (Array.isArray(build)) return { events: build, files: [] };
    if ('conflict' in build) return { conflict: build.conflict };
    return { events: build.events, files: build.files ?? [] };
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
    const probe = await this.mirrorGit(['ls-remote', '--exit-code', url, this.ref]);
    if (probe.code === 0) return { ok: false, kind: 'exists', reason: 'This remote already has a coordination log', attempts: 0 };
    if (probe.code !== 2) {
      const reason = redactGitMessage(probe.stderr.trim() || `git ls-remote exited with ${probe.code}`);
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
      if (!EXTRA_FILE_PATTERN.test(extra.path)) return { ok: false, kind: 'refused', reason: 'The coordination commit named a file that is not allowed.', attempts: 1 };
      files.push(extra);
    }
    files.push({ path: TEAM_FILE, text: teamFileText });
    const first = built.events[0] as TeamEvent;
    const commit = await this.commitFiles(files, undefined, `team: ${first.type} ${first.id}`);
    const pushed = await this.mirrorGit(['push', '--porcelain', url, `${commit}:${this.ref}`]);
    if (pushed.code !== 0) {
      const detail = pushDetail(pushed);
      if (detail.kind === 'rejected') return { ok: false, kind: 'exists', reason: 'This remote already has a coordination log', attempts: 1 };
      if (detail.kind === 'remote-rejected') return { ok: false, kind: 'remote-rejected', reason: detail.reason, attempts: 1 };
      this.setStatus({ state: 'offline', reason: detail.reason });
      return { ok: false, kind: 'offline', reason: detail.reason, attempts: 1 };
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
