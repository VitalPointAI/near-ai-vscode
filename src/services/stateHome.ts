// The project's state home (D-04): one folder inside the project, ignored by git by its own inner .gitignore, that every editor on this computer
// reads and writes. Every path is computed here, in one place, so a later per-person subfolder for Team Mode is a single prefix change.
//
// Opening a folder creates nothing. Only ensure(), called from a person's action, creates the folder, and it writes the inner .gitignore
// first, so no later file can ever be staged. No vscode here, so tests run on plain node.
import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stateFolder } from '../domain/scratch';
import { newStateId, type SealedBlob } from '../domain/state/keys';

export const STATE_FORMAT = 1 as const;
const STATE_ID = /^[a-z0-9]{16,40}$/;
const GITIGNORE_TEXT = '*\n';

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

export class ProjectStateHome {
  public readonly dir: string;
  public readonly paths: StatePaths;
  private metaQueue: Promise<unknown> = Promise.resolve();

  public constructor(public readonly root: string) {
    this.dir = stateFolder(path.resolve(root));
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
   * two editors doing this at once end with one stateId.
   */
  public async ensure(): Promise<StateMeta> {
    const existing = await this.readMeta();
    if (existing && (await stat(this.paths.gitignore).catch(() => undefined))?.isFile()) return existing;
    await mkdir(path.dirname(this.dir), { recursive: true });
    await mkdir(this.dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    await createExclusive(this.paths.gitignore, GITIGNORE_TEXT);
    if (existing) return existing;
    const fresh: StateMeta = { format: STATE_FORMAT, stateId: newStateId(), createdAt: new Date().toISOString() };
    if (await createExclusive(this.paths.meta, `${JSON.stringify(fresh, null, 2)}\n`) === 'created') return fresh;
    const winner = await this.readMeta();
    if (!winner) throw new Error("This project's saved-state information could not be created. Nothing was changed.");
    return winner;
  }

  /** Changes the optional meta fields in place. Changes made through one instance are applied in order. */
  public updateMeta(change: Partial<Omit<StateMeta, 'format' | 'stateId' | 'createdAt'>>): Promise<StateMeta> {
    const run = async (): Promise<StateMeta> => {
      const current = await this.ensure();
      const next: StateMeta = { ...current, ...change };
      await writeFileAtomic(this.paths.meta, `${JSON.stringify(next, null, 2)}\n`);
      return next;
    };
    const result = this.metaQueue.then(run, run);
    this.metaQueue = result.catch(() => undefined);
    return result;
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
