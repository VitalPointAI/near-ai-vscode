// One operation at a time on the sync mirror, across processes (D-09, SYNC-05). Every window of one editor, and every editor on one host (desktop, a
// code-server tab, a terminal), keeps the project's sync mirror in the same folder, <project>/.near-ai/state/sync/mirror.git, so two windows open on
// one project are two processes on one mirror. A fetch or a push reads and moves the mirror's refs in several git steps, and without this lock the
// steps of two processes interleave.
// The lock is a file created exclusively inside the mirror folder, so every path that names the folder finds the same file. The holder refreshes
// the file's time while it works. A waiter takes the lock over when the holder's process has ended (same computer) or the holder has not refreshed
// it for staleMs (a process on another computer, a reused process id, a stopped process). The transport's own checks keep the remote correct
// whatever another process does to the mirror; the lock keeps the shared refs moving forward only and keeps two windows from undoing each other's
// work. Shaped after the Team transport's lock (unmerged branch, copied, never imported). This module never imports vscode.
import { randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';

export const MIRROR_LOCK_FILE = 'near-ai-state-sync.lock';
export const DEFAULT_LOCK_STALE_MS = 60_000;
export const DEFAULT_LOCK_REFRESH_MS = 5_000;
export const DEFAULT_LOCK_WAIT_MS = 120_000;
const FIRST_PAUSE_MS = 5;
const MAX_PAUSE_MS = 250;
const TOKEN_PATTERN = /^[0-9a-f]{16,64}$/;

export interface MirrorLockTimings {
  // A lock whose file time is older than this is taken over even when its holder may still run.
  staleMs?: number;
  // How often a holder refreshes the file time. Must be well under staleMs.
  refreshMs?: number;
  // How long a waiter waits in total (the sum of its pauses) before it gives up with MirrorBusyError.
  waitMs?: number;
}

export interface MirrorLockOptions extends MirrorLockTimings {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export class MirrorBusyError extends Error {
  public constructor() {
    super('Another window on this computer is still syncing this project.');
    this.name = 'MirrorBusyError';
  }
}

export interface HeldMirrorLock {
  release(): Promise<void>;
}

interface Holder { pid: number; host: string; token: string }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function parseHolder(text: string): Holder | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid < 1) return undefined;
  if (typeof record.host !== 'string' || typeof record.token !== 'string' || !TOKEN_PATTERN.test(record.token)) return undefined;
  return { pid: record.pid, host: record.host, token: record.token };
}

// Signal 0 checks that a process exists without touching it. EPERM means it exists but belongs to someone else.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

// Creates the lock file only if there is none. A write that fails after the create removes the file, so an empty lock is never left behind.
async function tryCreate(file: string, text: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(text, 'utf8');
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

// True when the lock file is gone, or was stale and has been moved aside, so the caller should try to create it again at once.
async function clearIfStale(file: string, staleMs: number): Promise<boolean> {
  let text: string;
  let modified: number;
  try {
    // Content first, then time: a lock replaced in between shows the new, fresh time, so a live lock is never judged by an old one's age.
    text = await readFile(file, 'utf8');
    modified = (await stat(file)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
  const holder = parseHolder(text);
  const ended = holder !== undefined && holder.host === hostname() && holder.pid !== process.pid && !processAlive(holder.pid);
  if (!ended && Date.now() - modified < staleMs) return false;
  // Moved aside under a name of its own: only one waiter can move a given file. A waiter that finds it moved a different lock than the one it
  // judged (another waiter took the stale one over in between) puts that lock back when its place is still free.
  const aside = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.stale`;
  try {
    await rename(file, aside);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true;
    throw error;
  }
  const moved = parseHolder(await readFile(aside, 'utf8').catch(() => ''));
  if (moved !== undefined && moved.token !== holder?.token) await link(aside, file).catch(() => undefined);
  await rm(aside, { force: true });
  return true;
}

export async function acquireMirrorLock(mirrorDir: string, options: MirrorLockOptions): Promise<HeldMirrorLock> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const refreshMs = options.refreshMs ?? DEFAULT_LOCK_REFRESH_MS;
  const waitMs = options.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const file = path.join(mirrorDir, MIRROR_LOCK_FILE);
  await mkdir(mirrorDir, { recursive: true });
  const me: Holder = { pid: process.pid, host: hostname(), token: randomBytes(12).toString('hex') };
  const text = `${JSON.stringify(me)}\n`;
  let waited = 0;
  for (let round = 0; ; round += 1) {
    if (await tryCreate(file, text)) return hold(file, me.token, refreshMs);
    if (await clearIfStale(file, staleMs)) continue;
    if (waited >= waitMs) throw new MirrorBusyError();
    const pause = Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(round, 6)) * (0.5 + options.random());
    waited += pause;
    await options.sleep(pause);
  }
}

function hold(file: string, token: string, refreshMs: number): HeldMirrorLock {
  const refresh = setInterval(() => {
    const now = new Date();
    utimes(file, now, now).catch(() => undefined);
  }, refreshMs);
  refresh.unref();
  return {
    release: async () => {
      clearInterval(refresh);
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      // A lock another process took over (this one was stopped for longer than staleMs) is theirs now and stays.
      if (parseHolder(text)?.token === token) await rm(file, { force: true });
    }
  };
}

// Work on one mirror is serialised in this process first (callers on the same mirror share one chain), then across processes by the file lock.
const mirrorChains = new Map<string, Promise<void>>();

const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function withMirrorLock<T>(mirrorDir: string, work: () => Promise<T>, options: Partial<MirrorLockOptions> = {}): Promise<T> {
  const key = path.resolve(mirrorDir);
  const previous = mirrorChains.get(key) ?? Promise.resolve();
  let releaseChain!: () => void;
  const gate = new Promise<void>((resolve) => { releaseChain = resolve; });
  const tail = previous.then(() => gate);
  mirrorChains.set(key, tail);
  await previous;
  try {
    const held = await acquireMirrorLock(mirrorDir, { sleep: realSleep, random: Math.random, ...options });
    try {
      return await work();
    } finally {
      await held.release();
    }
  } finally {
    releaseChain();
    if (mirrorChains.get(key) === tail) mirrorChains.delete(key);
  }
}
