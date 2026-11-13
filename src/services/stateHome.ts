// The project's state home (D-04): one folder inside the project, ignored by git by its own inner .gitignore, that every editor on this computer
// reads and writes. Every path is computed here, in one place, so a later per-person subfolder for Team Mode is a single prefix change.
//
// Opening a folder creates nothing. Only ensure(), called from a person's action, creates the folder, and it writes the inner .gitignore
// first, so no later file can ever be staged. No vscode here, so tests run on plain node.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stateFolder } from '../domain/scratch';
import { newStateId, type SealedBlob } from '../domain/state/keys';
import { runStateGit, type GitRunner } from './stateGit';
import { withStateLock } from './stateLocks';

export const STATE_FORMAT = 1 as const;
const STATE_ID = /^[a-z0-9]{16,40}$/;
const GITIGNORE_TEXT = '*\n';
/** How long an answer to "is the state folder tracked by git" is reused, so a busy editor does not start git for every read. */
export const STATE_TRACKED_CHECK_MS = 30_000;

export interface StateMeta {
  format: typeof STATE_FORMAT;
  /** Random and portable: never derived from the folder's path or name. */
  stateId: string;
  createdAt: string;
  /** A short sealed marker under the data key, so a wrong or planted key is recognised before it is used (D-10). */
  keyCheck?: SealedBlob;
  migrated?: Record<string, unknown>;
  sync?: Record<string, unknown>;
}

export interface StatePaths {
  dir: string;
  gitignore: string;
  meta: string;
  keysDir: string;
  keysGitignore: string;
  localKey: string;
  recoveryWrap: string;
  apiKeysDir: string;
  threads: string;
  archive: string;
  runs: string;
  checkpoints: string;
  comparisons: string;
  choices: string;
  spend: string;
  pickup: string;
  sync: string;
}

export interface StateWriteOptions { mode?: number }

/** One id per extension host, for the run markers and writer fields of plan 04: a pid is not unique across a container and the host (Pitfall 1). */
export function newWriterId(hostname: string = os.hostname()): string {
  return `${createHash('sha256').update(hostname).digest('hex').slice(0, 8)}-${randomBytes(4).toString('hex')}`;
}
export const THIS_WRITER = newWriterId();

/** The part of vscode.Memento the writer id needs, so the state services stay free of vscode and tests run on plain node. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | Promise<void>;
}

const EDITOR_ID_KEY = 'nearAi.state.editorId';
const EDITOR_ID = /^[a-z0-9]{6,40}$/;
/** One id per extension host (a reload makes a new one): a pid alone is not unique across a container and the host. */
const INSTANCE_ID = randomBytes(6).toString('hex');
let processEditorId: string | undefined;
const editorIds = new WeakMap<object, string>();

/**
 * Who is writing: `<editor>.<instance>`. The editor id is created once per editor install and kept in its globalState, so it survives reloads and
 * is the same for every window of that editor; the instance id is new for each extension host. Run markers carry it (Pitfall 1): another editor's
 * pid means nothing here, but the same editor's pid does. Without a Memento (tests) the editor id lasts for the process.
 */
export function editorWriter(globalState?: MementoLike): string {
  const stored = globalState?.get<string>(EDITOR_ID_KEY);
  let editor = typeof stored === 'string' && EDITOR_ID.test(stored) ? stored : globalState ? editorIds.get(globalState) : processEditorId;
  if (!editor) {
    editor = randomBytes(6).toString('hex');
    if (globalState) {
      editorIds.set(globalState, editor);
      void Promise.resolve(globalState.update(EDITOR_ID_KEY, editor)).catch(() => undefined);
    } else processEditorId = editor;
  }
  return `${editor}.${INSTANCE_ID}`;
}

/** The editor part of a writer id, or undefined when there is none (a marker from before writers existed). */
export function writerEditor(writer: string | undefined): string | undefined {
  if (!writer) return undefined;
  const dot = writer.indexOf('.');
  return dot > 0 ? writer.slice(0, dot) : undefined;
}

function temporaryName(target: string): string {
  return `${target}.${randomBytes(8).toString('hex')}.tmp`;
}

/**
 * Writes the whole file or leaves the old one: a random temporary name (two editors never share one), then an atomic rename. Two writers to one
 * target always leave one complete version. The temporary file is removed on any failure.
 */
export async function writeFileAtomic(target: string, data: string | Buffer, options: StateWriteOptions = {}): Promise<void> {
  const temporary = temporaryName(target);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: options.mode ?? 0o600 });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Creates the file only if it does not exist, and never shows a half-written one: the content is written to a temporary file and hard-linked into
 * place, which fails when the target exists. On a filesystem without hard links it falls back to an exclusive create.
 */
export async function createExclusive(target: string, data: string | Buffer, mode = 0o600): Promise<'created' | 'exists'> {
  const temporary = temporaryName(target);
  await writeFile(temporary, data, { flag: 'wx', mode });
  try {
    await link(temporary, target);
    return 'created';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return 'exists';
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS' && code !== 'EXDEV') throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  try {
    await writeFile(target, data, { flag: 'wx', mode });
    return 'created';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
    throw error;
  }
}

/**
 * Why a file may not be trusted as this user's private file, or undefined when it may. A link, anything that is not a regular file and a parent folder
 * that is a link are refused everywhere. On POSIX the file and its folder must also belong to the user running the editor, and the file must have no
 * group or other permission bits (a file written by this extension is mode 0600, so another editor of the same user passes). A short reason, never a path.
 */
export async function privateFileProblem(file: string): Promise<string | undefined> {
  let info;
  let parent;
  try {
    info = await lstat(file);
    parent = await lstat(path.dirname(file));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  if (info.isSymbolicLink()) return 'a link';
  if (!info.isFile()) return 'not a regular file';
  if (parent.isSymbolicLink() || !parent.isDirectory()) return 'its folder is a link';
  if (typeof process.getuid === 'function') {
    const me = process.getuid();
    if (info.uid !== me) return 'owned by someone else';
    if (parent.uid !== me) return 'its folder is owned by someone else';
    if ((info.mode & 0o077) !== 0) return 'readable by others';
  }
  return undefined;
}

export class ProjectStateHome {
  public readonly dir: string;
  public readonly paths: StatePaths;
  private tracked: { at: number; value: boolean } | undefined;

  /** `dir` is for a copy built beside the real state home (a join, plan 15); every path is then inside it. */
  public constructor(public readonly root: string, dir?: string) {
    this.dir = dir ?? stateFolder(path.resolve(root));
    const at = (...parts: string[]) => path.join(this.dir, ...parts);
    this.paths = {
      dir: this.dir,
      gitignore: at('.gitignore'),
      meta: at('meta.json'),
      keysDir: at('keys'),
      keysGitignore: at('keys', '.gitignore'),
      localKey: at('keys', 'local.key'),
      recoveryWrap: at('keys', 'recovery.json'),
      apiKeysDir: at('keys', 'api'),
      threads: at('threads'),
      archive: at('archive'),
      runs: at('runs'),
      checkpoints: at('checkpoints'),
      comparisons: at('comparisons'),
      choices: at('choices.json'),
      spend: at('spend'),
      pickup: at('pickup.json'),
      sync: at('sync')
    };
  }

  /**
   * True when git tracks anything in the project's state or locks folder (a clone or pull with force-added files). The extension never stages these
   * folders, so a tracked one came from outside and no key is read from it. Git that is missing, a folder that is not a repository, or a failure all
   * count as not tracked. The answer is reused for STATE_TRACKED_CHECK_MS.
   */
  public async trackedByGit(git: GitRunner = runStateGit): Promise<boolean> {
    const now = Date.now();
    if (this.tracked && now - this.tracked.at < STATE_TRACKED_CHECK_MS) return this.tracked.value;
    let value = false;
    try {
      const result = await git(['-C', this.root, 'ls-files', '-z', '--cached', '--', '.near-ai/state', '.near-ai/locks'], { cwd: this.root, timeoutMs: 10_000 });
      value = result.code === 0 && result.stdout.length > 0;
    } catch {
      value = false;
    }
    this.tracked = { at: Date.now(), value };
    return value;
  }

  /** Whether the state home has been created. Looks only at meta.json and never creates anything. */
  public async exists(): Promise<boolean> {
    return Boolean((await stat(this.paths.meta).catch(() => undefined))?.isFile());
  }

  /** The meta file, or undefined when there is none. A file that is not valid is a plain error, never silently replaced. */
  public async readMeta(): Promise<StateMeta | undefined> {
    let text: string;
    try {
      text = await readFile(this.paths.meta, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error("This project's saved-state information is damaged, so it was not used. Nothing was changed."); }
    const meta = parsed as Partial<StateMeta> | null;
    if (typeof meta !== 'object' || meta === null || meta.format !== STATE_FORMAT || typeof meta.stateId !== 'string' || !STATE_ID.test(meta.stateId)) {
      throw new Error("This project's saved-state information is damaged or from a newer version, so it was not used. Nothing was changed.");
    }
    return meta as StateMeta;
  }

  /**
   * Creates the state home on a person's action. The folder (owner-only), then its inner .gitignore, then meta.json, each created exclusively, so
   * two editors doing this at once end with one stateId. `options.stateId` is used only when meta.json does not exist yet: it is how a second computer
   * takes the project's id from the remote before it has any state of its own (SYNC-05).
   */
  public async ensure(options: { stateId?: string } = {}): Promise<StateMeta> {
    if (options.stateId !== undefined && !STATE_ID.test(options.stateId)) throw new Error("This project's saved-state id is not valid. Nothing was changed.");
    const existing = await this.readMeta();
    if (existing && (await stat(this.paths.gitignore).catch(() => undefined))?.isFile()) return existing;
    await mkdir(path.dirname(this.dir), { recursive: true });
    await mkdir(this.dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await createExclusive(this.paths.gitignore, GITIGNORE_TEXT);
    if (existing) return existing;
    const fresh: StateMeta = { format: STATE_FORMAT, stateId: options.stateId ?? newStateId(), createdAt: new Date().toISOString() };
    if (await createExclusive(this.paths.meta, `${JSON.stringify(fresh, null, 2)}\n`) === 'created') return fresh;
    const winner = await this.readMeta();
    if (!winner) throw new Error("This project's saved-state information could not be created. Nothing was changed.");
    return winner;
  }

  /**
   * Runs `work` as the one editor changing meta.json or creating the key (REVIEW MINOR stateHome.ts:213): a lock file in .near-ai/locks held across
   * processes. Not re-entrant: inside `work`, change meta.json with updateMetaHeld, never updateMeta. Throws StateBusyError when the wait ends.
   */
  public withMetaLock<T>(work: () => Promise<T>): Promise<T> {
    return withStateLock(this.root, 'meta', work);
  }

  /** Changes the optional meta fields in place, under the meta lock. The file is read again inside the lock, so another editor's change is kept. */
  public updateMeta(change: Partial<Omit<StateMeta, 'format' | 'stateId' | 'createdAt'>>): Promise<StateMeta> {
    return this.withMetaLock(() => this.updateMetaHeld(change));
  }

  /** The change itself: read meta.json, merge, write the whole file. Only for a caller that already holds the meta lock (withMetaLock). */
  public async updateMetaHeld(change: Partial<Omit<StateMeta, 'format' | 'stateId' | 'createdAt'>>): Promise<StateMeta> {
    const current = await this.ensure();
    const next: StateMeta = { ...current, ...change };
    await writeFileAtomic(this.paths.meta, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /** Makes a folder inside the state home owner-only, for the key folders. */
  public async ensureFolder(folder: string): Promise<void> {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700).catch(() => undefined);
  }
}

const homes = new Map<string, ProjectStateHome>();

/** One home object per resolved project folder. Making the object touches nothing on disk. */
export function stateHomeFor(root: string): ProjectStateHome {
  const key = path.resolve(root);
  let home = homes.get(key);
  if (!home) { home = new ProjectStateHome(key); homes.set(key, home); }
  return home;
}
