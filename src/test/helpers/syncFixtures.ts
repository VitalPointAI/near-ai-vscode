// Shared by the two-machine sync tests: a "machine" is a project folder with its own state home, keys, thread store, transport mirror and StateSync, all
// over one local bare remote. Two machines share nothing but that remote. No network is ever contacted.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateRecoveryCode } from '../../domain/state/recoveryCode';
import { openManifest, openObject } from '../../domain/state/objects';
import { entryId, type ThreadEntry, type ThreadRole } from '../../domain/state/threadEntries';
import { RunMarkers, type RunMarker } from '../../services/runMarkers';
import { StateSync, type StateSyncOptions } from '../../services/stateSync';
import { stateHomeFor, type ProjectStateHome } from '../../services/stateHome';
import { stateKeysFor, type StateKeys } from '../../services/stateKeys';
import { StateTransport } from '../../services/stateTransport';
import { threadStoreFor, type ThreadStore } from '../../services/threadStore';
import { bareRemote, fixtureGit, hermeticRunner, mirrorPaths, userRepo } from './gitFixtures';
import { MemorySecrets } from './stateFixtures';

export interface Machine {
  name: string;
  root: string;
  home: ProjectStateHome;
  keys: StateKeys;
  threads: ThreadStore;
  secrets: MemorySecrets;
  transport: StateTransport;
  /** The private mirror folder this computer syncs through. */
  mirrorDir: string;
  sync: StateSync;
  writer: string;
  markers: RunMarkers;
}

export interface MachineOptions {
  isIdle?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  extra?: Partial<StateSyncOptions>;
}

/** One computer's view of the project, cloned at its own path. */
export async function machine(remoteDir: string, name: string, options: MachineOptions = {}): Promise<Machine> {
  const root = userRepo(remoteDir).dir;
  const secrets = new MemorySecrets();
  const writer = `${name.padEnd(6, 'x')}ed.${name.padEnd(6, 'x')}in`;
  const keys = stateKeysFor(root, secrets);
  const threads = threadStoreFor(root, secrets, writer);
  const home = stateHomeFor(root);
  const paths = await mirrorPaths(`near-ai-mirror-${name}-`);
  const transport = new StateTransport({ root, mirrorDir: paths.mirrorDir, hooksDir: paths.hooksDir, git: hermeticRunner() });
  const markers = new RunMarkers(home.dir, root, { dir: home.paths.runs, writer });
  const sync = new StateSync({
    root, home, keys, threads, transport, writer, runState: (marker) => markers.runState(marker),
    sleep: options.sleep ?? (() => Promise.resolve()), random: () => 0,
    ...(options.isIdle ? { isIdle: options.isIdle } : {}),
    ...options.extra
  });
  return { name, root, home, keys, threads, secrets, transport, mirrorDir: paths.mirrorDir, sync, writer, markers };
}

let clock = Date.parse('2026-11-01T10:00:00.000Z');

/** A chain of entries, each following the last, with growing times. `parent` continues an existing chain. */
export function chain(thread: string, writer: string, items: ReadonlyArray<readonly [ThreadRole, string]>, parent: string | null = null): ThreadEntry[] {
  const entries: ThreadEntry[] = [];
  let previous = parent;
  for (const [role, text] of items) {
    const body = role === 'tool-call' ? { name: 'read_file', args: { text } } : { text };
    const id = entryId(previous, role, body);
    clock += 1000;
    entries.push({ id, thread, parent: previous, at: new Date(clock).toISOString(), writer, role, body });
    previous = id;
  }
  return entries;
}

export const SIX_TURNS: ReadonlyArray<readonly [ThreadRole, string]> = [
  ['user', 'plan the release'], ['assistant', 'here is a plan'], ['user', 'add a changelog'], ['assistant', 'done'], ['user', 'thanks'], ['assistant', 'welcome']
];

/** Every file under a folder with its bytes' hash, for comparing a state home before and after. */
export function treeHash(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) { lines.push(`d ${path.relative(dir, full)}`); walk(full); } else if (item.isFile()) {
        lines.push(`f ${path.relative(dir, full)} ${statSync(full).size} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
      }
    }
  };
  try { walk(dir); } catch { return 'absent'; }
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function entryIds(machineOf: Machine, thread: string): Promise<string[]> {
  return (await machineOf.threads.entries(thread)).map((entry) => entry.id).sort();
}

/** Writes a run marker file the way the run markers do, with the fields given over a plain finished-or-live shape. */
export async function writeMarker(machineOf: Machine, conversationId: string, fields: Partial<RunMarker>): Promise<RunMarker> {
  const now = new Date().toISOString();
  const marker: RunMarker = { version: 2, conversationId, runId: 'run-100-abcdef', pid: process.pid, writer: machineOf.writer, startedAt: now, activeAt: now, steps: [], ...fields };
  await mkdir(machineOf.home.paths.runs, { recursive: true });
  await writeFile(`${machineOf.home.paths.runs}/${conversationId}.json`, `${JSON.stringify(marker)}\n`);
  return marker;
}

/** Every payload the remote's state branch holds, opened with the machine's own key (so a test can look at what really left the computer). */
export async function remotePayloads(remoteDir: string, machineOf: Machine): Promise<unknown[]> {
  const dataKey = await machineOf.keys.dataKey();
  const meta = await machineOf.home.readMeta();
  if (!dataKey || !meta) throw new Error('machine has no key');
  const show = (name: string): Buffer => execFileSync('git', ['--git-dir', remoteDir, 'show', `refs/heads/near-ai/state:${name}`], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 256 * 1024 * 1024 });
  const manifest = openManifest(show('manifest.json').toString('utf8'), dataKey, 0);
  const payloads: unknown[] = [];
  let at = 0;
  while (at < manifest.objects.length) {
    const first = manifest.objects[at] as (typeof manifest.objects)[number];
    const group = manifest.objects.slice(at, at + first.of);
    payloads.push(openObject(dataKey, meta.stateId, first.class, group.map((entry) => ({ entry, data: show(entry.file) }))));
    at += first.of;
  }
  return payloads;
}

/** The sealed manifest of the remote's state branch, opened with the machine's key: every object listed, with its class, size and file name. */
export async function remoteManifest(remoteDir: string, machineOf: Machine, ref = 'refs/heads/near-ai/state'): Promise<ReturnType<typeof openManifest>> {
  const dataKey = await machineOf.keys.dataKey();
  if (!dataKey) throw new Error('machine has no key');
  const text = execFileSync('git', ['--git-dir', remoteDir, 'show', `${ref}:manifest.json`], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  return openManifest(text, dataKey, 0);
}

/** Two computers over one remote with sync on: A has one thread and pushed it, B was opened with the code and pulled. */
export async function syncedPair(thread: string): Promise<{ remote: string; a: Machine; b: Machine; code: string; bytes: Buffer }> {
  const remote = bareRemote({ withMain: false });
  const a = await machine(remote, 'alpha');
  const b = await machine(remote, 'bravo');
  const { code, bytes } = generateRecoveryCode();
  await a.keys.ensureDataKey();
  await a.keys.writeRecoveryWrap(bytes);
  await a.threads.create({ id: thread, title: 'Shared thread', model: 'near/model-a', origin: 'panel' });
  await a.threads.appendEntries(thread, chain(thread, a.writer, SIX_TURNS));
  if ((await a.sync.sync()).kind !== 'synced') throw new Error('the first sync did not finish');
  if ((await b.sync.unlockFromRemote(bytes)).kind !== 'synced') throw new Error('the code did not open the project');
  if ((await b.sync.pullOnly()).kind !== 'synced') throw new Error('the first pull did not finish');
  return { remote, a, b, code, bytes };
}

const STATE_BRANCH = 'refs/heads/near-ai/state';
const gitBuffer = (remoteDir: string, args: string[], input?: Buffer): Buffer => execFileSync('git', ['--git-dir', remoteDir, ...args], { input, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.test', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.test' }, maxBuffer: 256 * 1024 * 1024 });

/** The files of the remote's state branch by name, as bytes. */
export function remoteFiles(remoteDir: string, ref = STATE_BRANCH): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const name of fixtureGit(remoteDir, ['ls-tree', '--name-only', ref]).split('\n').filter(Boolean)) files.set(name, gitBuffer(remoteDir, ['show', `${ref}:${name}`]));
  return files;
}

/** Puts a new commit holding exactly these files on the state branch, on top of the old tip, using plain git (what anyone with push rights could do). */
export function replaceRemoteTree(remoteDir: string, files: ReadonlyMap<string, Buffer>): string {
  const parent = fixtureGit(remoteDir, ['rev-parse', STATE_BRANCH]).trim();
  const lines: Buffer[] = [];
  for (const [name, data] of files) lines.push(Buffer.from(`100644 blob ${gitBuffer(remoteDir, ['hash-object', '-w', '--stdin'], data).toString().trim()}\t${name}\0`));
  const tree = gitBuffer(remoteDir, ['mktree', '-z'], Buffer.concat(lines)).toString().trim();
  const commit = gitBuffer(remoteDir, ['commit-tree', tree, '-p', parent, '-m', 'attack']).toString().trim();
  fixtureGit(remoteDir, ['update-ref', STATE_BRANCH, commit]);
  return commit;
}
