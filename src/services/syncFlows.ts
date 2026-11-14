// The sync controls in plain words (D-01, D-02, D-10, D-14, D-17): turn sync on with a recovery code shown once, restore a project on another computer with
// that code (the NEAR AI key included), route a project with no remote into the online-home flow, join from a computer that already has chats of its own,
// issue a new code, switch the key file off or on, turn sync off, and sync at safe moments. Nothing here imports vscode: every question to the person, the
// online-home setup and the building of a sync are injected, so the whole of it runs on plain node with fakes and local bare repositories.
//
// The recovery code lives in local variables of the flow that made it and is dropped when that flow ends: it is passed to the person's screen (the only
// place it is ever passed), never written to a file, a setting, a log, globalState or an error, and never sent anywhere.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { lstat, mkdtemp, rm, unlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateRefusedError } from '../domain/state/keys';
import { generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import { withGitHubAuth, type OnlineHomeRemote, type OnlineHomeResult } from './onlineHome';
import { redactSecrets } from '../domain/redaction';
import { runStateGit, gitText, privateHooksDir, redactGitMessage, TIMED_OUT_CODE, type GitRunner } from './stateGit';
import { ProjectStateHome, stateHomeFor, type MementoLike } from './stateHome';
import type { StateKeys } from './stateKeys';
import type { RunMarker, RunState } from './runMarkers';
import { StateSync, type StateSyncOptions, type SyncOutcome } from './stateSync';
import { StateTransport, validateRemote } from './stateTransport';
import { adoptRemoteIdentity, discardPreviousState, recoverInterruptedAdoption, type AdoptOptions } from './stateRestore';
import type { ProfileSource, SecretSource } from './stateRecords';
import type { StateRecord } from '../domain/state/records';
import type { ThreadStore } from './threadStore';

/** What the person is told before sync is turned on: what the git host can and cannot see (research Pattern 5, D-09). */
export const SYNC_LEAK_EXPLANATION = [
  "Project sync keeps an encrypted copy of this project's chats, runs, comparisons, model choices and your NEAR AI key on your git host, on a branch of this project's own repository.",
  'Everything is encrypted on this computer before it leaves, and only your recovery code can open it. Your git host, and anyone who can read the repository, cannot read your chats or your key.',
  'They can see that this project uses NEAR AI sync, roughly how much is stored, and when you save.',
  'Nobody, including NEAR AI, can recover your recovery code for you.'
].join('\n\n');

const NO_HOME = 'This project has no online home yet, so it cannot sync.';
const ENTER_CODE_INSTEAD = 'This project already has synced chats online. Choose "Enter Recovery Code" to open them on this computer.';
const RESTORED = 'Your chats, runs, comparisons and model choices are here, and your NEAR AI key is set up for this project.';
const JOIN_TEXT = 'This project has chats on this computer that are not online yet. They will be kept, added to the online project and encrypted with its key, and the original files stay until the first sync has worked. Continue?';
const LOCKED_HERE = "This project's chats on this computer are locked, so they cannot be added to the online project. Open them first with this computer's own recovery code, or move the project folder aside.";
const SYNC_ON = 'Project sync is on. Your project is encrypted and saved on your git host.';
const SYNC_ON_PENDING = 'Project sync is on, but the first save did not finish. It will try again.';
const UNLOCKED = 'This project is open on this computer again.';
const JOIN_FAILED = "Something went wrong while adding this computer's chats to the online project, so nothing was changed. Try again.";
const NEEDS_KEY = "This project's chats are locked on this computer. Enter the recovery code first.";
const NEW_CODE_SAVED = 'Your new recovery code is the one that opens this project now.';
const OLD_CODE_NOTE = 'Copies already on your git host can still be opened with the old code until the data is re-keyed.';
const KEY_FILE_OFF_TEXT = 'Turn off the chat key file in this project? Each new editor or browser will then ask for the recovery code before it can open these chats. A recovery code will be shown first if you have none.';
const KEY_FILE_OFF_DONE = 'The chat key file was removed. New editors and browsers will ask for the recovery code.';
const KEY_FILE_ON_DONE = 'The chat key file is back in this project, so every editor on this computer can open the chats.';
const SYNC_OFF = 'Project sync is off. Your chats stay on this computer, and what is already online is left as it is.';
const NOTHING_ONLINE = 'There is nothing saved online for this project yet. Turn on project sync on the computer that has your chats first.';

/** Everything a flow asks the person. Each is a click or a typed answer; `undefined` or false means they walked away. */
export interface SyncUi {
  /** Shows the recovery code once for copying. True when the person says they have saved it. This is the only place the code is passed. */
  showCodeOnce(code: string): Promise<boolean>;
  /** The code the person types or pastes on another computer, or undefined. */
  askCode(): Promise<string | undefined>;
  confirm(text: string): Promise<boolean>;
  /** Several remotes and no origin: which one to use. */
  pickRemote(names: string[]): Promise<string | undefined>;
  info(text: string): void;
  warn?(text: string): void;
}

/** Starts the online-home setup (plan 17); `afterRemote` is the rest of the turn-on flow, which returns whether it finished. */
export type OnlineHomeStarter = (afterRemote: (remote: OnlineHomeRemote) => Promise<boolean | void>) => Promise<OnlineHomeResult>;

/** What a flow needs from the editor. */
export interface SyncEnv {
  root: string;
  home: ProjectStateHome;
  keys: StateKeys;
  threads: ThreadStore;
  /** Builds a sync for a remote. `mirror` places the private mirror elsewhere than the state home (opening a project before it has a state home). */
  makeSync(input: { remote: string; git?: GitRunner; mirror?: { mirrorDir: string; hooksDir: string } }): StateSync;
  /** Reads the person's remotes. Default: the sync runner. */
  git?: GitRunner;
  keepKeyInProject?: () => boolean;
  writer?: string;
  /** Called when sync turns on (with the remote) or off, so the scheduler can start or stop. */
  onEnabled?: (on: boolean, remote?: string) => void;
  /** Called after the restore of a second computer, for work that needs an editor (checking the restored profile). */
  afterRestore?: () => void | Promise<void>;
  /** Whether sync is on and which remote it uses: this editor's own storage. Without one, a store that lasts for this process (never a file in the project). */
  settings?: SyncSettingsStore;
}

export interface SyncSettings { enabled: boolean; remote?: string }

/**
 * Whether sync is on for this project and which remote it uses, kept in this editor's own storage and never in a file inside the project (REVIEW B1: a
 * cloned or edited project must not be able to turn background sync on or choose where it goes).
 */
export interface SyncSettingsStore {
  read(): Promise<SyncSettings>;
  /** Merges the given fields. An undefined field is left as it was. */
  write(change: Partial<SyncSettings>): Promise<void>;
}

function mergeSettings(base: SyncSettings, change: Partial<SyncSettings>): SyncSettings {
  const remote = change.remote !== undefined && change.remote !== '' ? change.remote : base.remote;
  return { enabled: change.enabled ?? base.enabled, ...(remote ? { remote } : {}) };
}

const memoryStores = new Map<string, SyncSettingsStore>();

/** Settings kept for this process only, one store per resolved project folder: what a caller with no editor storage (a test, a fake) gets. Never a file. */
export function memorySyncSettings(root: string): SyncSettingsStore {
  const key = path.resolve(root);
  let store = memoryStores.get(key);
  if (!store) {
    let value: SyncSettings = { enabled: false };
    store = { read: () => Promise.resolve({ ...value }), write: (change) => { value = mergeSettings(value, change); return Promise.resolve(); } };
    memoryStores.set(key, store);
  }
  return store;
}

const SETTINGS_KEY = 'nearAi.sync.projects';
const STORED_STATE_ID = /^[a-z0-9]{16,40}$/;

interface StoredSettings { stateId?: string; enabled: boolean; remote?: string; legacyChecked?: boolean }

/** One stored entry, only when it is exactly what this module writes; anything else is no entry. */
function parseStored(value: unknown): StoredSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') return undefined;
  if (raw.stateId !== undefined && (typeof raw.stateId !== 'string' || !STORED_STATE_ID.test(raw.stateId))) return undefined;
  if (raw.remote !== undefined && (typeof raw.remote !== 'string' || raw.remote === '' || raw.remote.length > 200)) return undefined;
  if (raw.legacyChecked !== undefined && typeof raw.legacyChecked !== 'boolean') return undefined;
  return {
    enabled: raw.enabled,
    ...(raw.stateId !== undefined ? { stateId: raw.stateId as string } : {}),
    ...(raw.remote !== undefined ? { remote: raw.remote as string } : {}),
    ...(raw.legacyChecked === true ? { legacyChecked: true } : {})
  };
}

/** What the one-time adoption of the old meta.json switch needs: the state home to read it from, the keys to prove this editor can open the project, git for the remotes. */
export interface LegacySyncSwitch {
  home: ProjectStateHome;
  keys: Pick<StateKeys, 'dataKey'>;
  git?: GitRunner;
}

/**
 * Settings in this editor's globalState (a MementoLike), one entry per project under `nearAi.sync.projects`, keyed by the hash of the project folder and bound
 * to the state id they were written for (a different state in the folder reads as off). A switch an earlier 0.4.20 build kept in meta.json is adopted once
 * per editor and project, and only when this editor can already open the project's key and the remote named is one the project has: nothing in the project
 * folder can turn sync on by itself.
 */
export function mementoSyncSettings(memento: MementoLike, root: string, legacy?: LegacySyncSwitch): SyncSettingsStore {
  const name = mirrorFolderName(root);
  const stored = (): Record<string, unknown> => {
    const map = memento.get<unknown>(SETTINGS_KEY);
    return typeof map === 'object' && map !== null && !Array.isArray(map) ? { ...(map as Record<string, unknown>) } : {};
  };
  const save = async (entry: StoredSettings): Promise<void> => { await memento.update(SETTINGS_KEY, { ...stored(), [name]: entry }); };
  const currentStateId = async (): Promise<string | undefined> => {
    const home = legacy?.home ?? stateHomeFor(root);
    return (await home.readMeta().catch(() => undefined))?.stateId;
  };

  /** The old meta.json switch, looked at once. Undefined when the answer could not be had (it is looked at again next time). */
  const adopt = async (stateId: string | undefined): Promise<StoredSettings | undefined> => {
    if (!legacy) return undefined;
    try {
      const sync = (await legacy.home.readMeta().catch(() => undefined))?.sync;
      const remote = typeof sync?.remote === 'string' && sync.remote !== '' ? sync.remote : undefined;
      let adoptable = sync?.enabled === true && stateId !== undefined && (await legacy.keys.dataKey()) !== undefined;
      if (adoptable && remote !== undefined) {
        const listed = await (legacy.git ?? runStateGit)(['-C', root, 'remote']);
        if (listed.code === TIMED_OUT_CODE) return undefined;
        adoptable = listed.code === 0 && gitText(listed).split('\n').map((line) => line.trim()).includes(remote);
      }
      return adoptable
        ? { enabled: true, ...(remote ? { remote } : {}), ...(stateId ? { stateId } : {}), legacyChecked: true }
        : { enabled: false, legacyChecked: true };
    } catch {
      return undefined;
    }
  };

  /** The entry that applies to the state now in the folder (a different state's entry is no entry). */
  const load = async (): Promise<StoredSettings> => {
    const stateId = await currentStateId();
    let entry = parseStored(stored()[name]);
    if (!entry) {
      const adopted = await adopt(stateId);
      if (!adopted) return { enabled: false };
      await save(adopted);
      entry = adopted;
    } else if (!entry.legacyChecked && legacy) {
      entry = { ...entry, legacyChecked: true };
      await save(entry);
    }
    if (entry.stateId !== undefined && entry.stateId !== stateId) return { enabled: false, legacyChecked: true };
    return entry;
  };

  return {
    read: async () => {
      const entry = await load();
      return { enabled: entry.enabled, ...(entry.remote ? { remote: entry.remote } : {}) };
    },
    write: async (change) => {
      const entry = await load();
      const stateId = await currentStateId();
      const merged = mergeSettings({ enabled: entry.enabled, ...(entry.remote ? { remote: entry.remote } : {}) }, change);
      await save({ ...merged, ...(stateId ? { stateId } : {}), legacyChecked: true });
    }
  };
}

/** The store a flow uses: the editor's own, or (with none given) one that lasts for this process. */
function settingsOf(env: Pick<SyncEnv, 'root' | 'settings'>): SyncSettingsStore {
  return env.settings ?? memorySyncSettings(env.root);
}

/** Turning sync on or choosing a remote starts from a state home that exists, so the stored switch is bound to its id. */
async function writeEnabled(env: SyncEnv, change: Partial<SyncSettings>): Promise<void> {
  await env.home.ensure();
  await settingsOf(env).write(change);
}

/**
 * Whether the project has an online home, from a local check only (D-16, D-14): git's own list of the project's remotes. Nothing is fetched, nothing contacts
 * a network, nothing is written. A folder that is not a repository, or has no remote, is 'no-home'; 'unknown' when git is missing or the check did not finish,
 * so the control keeps what it says and the turn-on flow explains.
 */
export async function localHomeState(root: string, git: GitRunner = runStateGit): Promise<'home' | 'no-home' | 'unknown'> {
  try {
    const listed = await git(['-C', root, 'remote']);
    if (listed.code === TIMED_OUT_CODE) return 'unknown';
    const names = listed.code === 0 ? gitText(listed).split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
    return names.length > 0 ? 'home' : 'no-home';
  } catch {
    return 'unknown';
  }
}

export type RemoteChoice = { kind: 'remote'; name: string } | { kind: 'none' } | { kind: 'cancelled' };

/**
 * The project's remote (D-14, D-09 defers any setting for it): one stored in this editor's settings when it still exists, else `origin`, else the only remote,
 * else the person's pick among several (asked once and remembered in this editor's settings). No repository or no remote is 'none'.
 */
export async function resolveRemote(env: Pick<SyncEnv, 'root' | 'git' | 'settings'>, ui: Pick<SyncUi, 'pickRemote'>): Promise<RemoteChoice> {
  const run = env.git ?? runStateGit;
  const listed = await run(['-C', env.root, 'remote']).catch(() => undefined);
  const names = listed && listed.code === 0 ? gitText(listed).split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
  if (names.length === 0) return { kind: 'none' };
  const usable = (name: string): boolean => !('message' in validateRemote(name, names));
  const stored = (await settingsOf(env).read()).remote;
  if (stored && names.includes(stored) && usable(stored)) return { kind: 'remote', name: stored };
  if (names.includes('origin') && usable('origin')) return { kind: 'remote', name: 'origin' };
  if (names.length === 1 && usable(names[0] as string)) return { kind: 'remote', name: names[0] as string };
  const picked = await ui.pickRemote(names);
  if (!picked || !names.includes(picked) || !usable(picked)) return { kind: 'cancelled' };
  await settingsOf(env).write({ remote: picked });
  return { kind: 'remote', name: picked };
}

/** What a sync is built from: the parts that do not change between one remote and the next. */
export interface SyncParts {
  root: string;
  home: ProjectStateHome;
  keys: StateKeys;
  threads: ThreadStore;
  writer: string;
  /** The base git runner. Default: the sync runner. A token-adding wrapper goes around it per call. */
  git?: GitRunner;
  /** The editor's own folder for sync mirrors (outside every project). Without one, a private temporary folder made once per process is used. */
  mirrorRoot?: string;
  isIdle?: () => boolean;
  runState?: (marker: RunMarker) => RunState;
  profiles?: { profileSource: ProfileSource; secretSource: SecretSource; applyProfiles: (records: StateRecord[]) => Promise<void> };
  extra?: Partial<StateSyncOptions>;
}

/** The folder name of one project's mirror under the mirror root: the first 16 hex characters of the sha256 of the resolved project path. */
export function mirrorFolderName(root: string): string {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
}

let processMirrorRoot: string | undefined;

/** Where mirrors go when no editor storage is given: one private temporary folder per process (owner-only, random name, outside every project). */
export function defaultMirrorRoot(): string {
  processMirrorRoot ??= mkdtempSync(path.join(os.tmpdir(), 'near-ai-sync-mirrors-'));
  return processMirrorRoot;
}

/** One StateSync over its own StateTransport. The private mirror lives outside the project (REVIEW B1) unless `mirror` says otherwise. */
export function buildStateSync(parts: SyncParts, input: { remote: string; git?: GitRunner; mirror?: { mirrorDir: string; hooksDir: string } }): StateSync {
  const mirror = input.mirror ?? { mirrorDir: path.join(parts.mirrorRoot ?? defaultMirrorRoot(), mirrorFolderName(parts.root), 'mirror.git'), hooksDir: privateHooksDir() };
  const transport = new StateTransport({ root: parts.root, remote: input.remote, mirrorDir: mirror.mirrorDir, hooksDir: mirror.hooksDir, git: input.git ?? parts.git ?? runStateGit });
  return new StateSync({
    root: parts.root, home: parts.home, keys: parts.keys, threads: parts.threads, transport, remote: input.remote, writer: parts.writer,
    ...(parts.isIdle ? { isIdle: parts.isIdle } : {}), ...(parts.runState ? { runState: parts.runState } : {}),
    ...(parts.profiles ?? {}), ...(input.mirror ? { registerColdFetcher: false } : {}), ...(parts.extra ?? {})
  });
}

/**
 * Removes what earlier dev builds kept inside the project: the private mirror and the hooks folder in .near-ai/state/sync/. They were only a cache and an
 * empty folder. A symbolic link is unlinked and never followed; anything else in that folder is left alone. Creates nothing; a failure is tried again later.
 */
export async function removeOldInProjectSyncFolders(home: ProjectStateHome): Promise<void> {
  try {
    if (!(await home.exists())) return;
    for (const name of ['mirror.git', 'hooks']) {
      const target = path.join(home.paths.sync, name);
      const info = await lstat(target).catch(() => undefined);
      if (!info) continue;
      if (info.isSymbolicLink()) await unlink(target);
      else if (info.isDirectory()) await rm(target, { recursive: true, force: true });
    }
  } catch { /* tried again at the next activation */ }
}

// ---- turning sync on --------------------------------------------------------------------------------------------------------------------

export type TurnOnStatus = 'on' | 'pending' | 'cancelled' | 'no-home' | 'blocked' | 'failed';
export interface TurnOnResult { status: TurnOnStatus; message: string }

export interface TurnOnInput {
  env: SyncEnv;
  ui: SyncUi;
  /** The plan-17 flow, for a project with no repository or no remote. Without it such a project is told it has no online home. */
  onlineHome?: OnlineHomeStarter;
}

/**
 * Turns project sync on (D-02, D-14, Q2). The remote is found (or made through the online-home flow), the person is told what the git host can and
 * cannot see, a recovery code is made and shown once, and the first sync runs. Nothing is written before the person has confirmed both screens.
 */
export async function turnOnFlow(input: TurnOnInput): Promise<TurnOnResult> {
  const { env, ui } = input;
  const found = await resolveRemote(env, ui);
  if (found.kind === 'cancelled') return { status: 'cancelled', message: 'Project sync was not turned on.' };
  if (found.kind === 'remote') return finishTurnOn(env, ui, found.name);
  if (!input.onlineHome) { ui.info(NO_HOME); return { status: 'no-home', message: NO_HOME }; }
  let finished: TurnOnResult | undefined;
  const made = await input.onlineHome(async (remote) => {
    finished = await finishTurnOn(env, ui, remote.name, remote.git);
    return finished.status === 'on';
  });
  if (finished) return finished;
  const message = made.message ?? (made.status === 'declined' || made.status === 'cancelled' ? 'Project sync was not turned on.' : NO_HOME);
  return { status: made.status === 'declined' || made.status === 'cancelled' ? 'cancelled' : 'no-home', message };
}

/** The rest of turning sync on, for the online-home flow to call once the remote exists: it returns whether the first sync finished. */
export function afterRemoteFor(env: SyncEnv, ui: SyncUi): (remote: OnlineHomeRemote) => Promise<boolean> {
  return async (remote) => (await finishTurnOn(env, ui, remote.name, remote.git)).status === 'on';
}

async function finishTurnOn(env: SyncEnv, ui: SyncUi, remote: string, git?: GitRunner): Promise<TurnOnResult> {
  const sync = env.makeSync({ remote, ...(git ? { git } : {}) });
  const online = await sync.remoteState();
  if (!online.ok) { ui.info(online.outcome.message); return { status: 'failed', message: online.outcome.message }; }
  const meta = await env.home.readMeta().catch(() => undefined);
  const hasWrap = await env.keys.hasRecoveryWrap();
  // Turning sync on again after turning it off: the same project, the same code. Anything else already online belongs to another copy of the project.
  const again = hasWrap && meta !== undefined && meta.stateId === online.stateId;
  if (online.stateId !== undefined && !again) { ui.info(ENTER_CODE_INSTEAD); return { status: 'blocked', message: ENTER_CODE_INSTEAD }; }

  if (!(await ui.confirm(SYNC_LEAK_EXPLANATION))) return { status: 'cancelled', message: 'Project sync was not turned on.' };
  if (!hasWrap) {
    const made = generateRecoveryCode();
    try {
      if (!(await ui.showCodeOnce(made.code))) return { status: 'cancelled', message: 'Project sync was not turned on, and no recovery code was kept.' };
      await env.keys.writeRecoveryWrap(made.bytes);
    } finally {
      made.bytes.fill(0);
    }
  }
  await writeEnabled(env, { enabled: true, remote });
  env.onEnabled?.(true, remote);
  const outcome = await sync.sync();
  return reportTurnOn(ui, outcome);
}

function reportTurnOn(ui: SyncUi, outcome: SyncOutcome): TurnOnResult {
  if (outcome.kind === 'synced' || outcome.kind === 'nothing-yet') { ui.info(SYNC_ON); return { status: 'on', message: SYNC_ON }; }
  (ui.warn ?? ui.info).call(ui, `${SYNC_ON_PENDING} ${outcome.message}`);
  return { status: 'pending', message: outcome.message };
}

// ---- entering the recovery code on another computer -------------------------------------------------------------------------------------

export type EnterCodeStatus = 'restored' | 'unlocked' | 'pending' | 'cancelled' | 'refused' | 'no-home' | 'failed';
export interface EnterCodeResult { status: EnterCodeStatus; message: string }

export interface EnterCodeInput extends TurnOnInput {
  /** Options for joining from a computer that already has chats (test seams). */
  adopt?: AdoptOptions;
}

/**
 * Restores the project on this computer from the recovery code (D-02): the code opens the remote's manifest (through a throwaway mirror outside the
 * state home, so a wrong code creates nothing), this computer takes the project's id and key (joining first when it already has chats of its own), and
 * a full sync brings everything, the NEAR AI key included, which is saved under this computer's own scope.
 */
export async function enterCodeFlow(input: EnterCodeInput): Promise<EnterCodeResult> {
  const { env, ui } = input;
  // A join that was cut off after its first rename is put right before anything reads this computer's state.
  await recoverInterruptedAdoption(env.root);
  const typed = await ui.askCode();
  if (typed === undefined) return { status: 'cancelled', message: 'No recovery code was entered.' };
  const bytes = parseRecoveryCode(typed);
  if (!bytes) {
    const message = new StateRefusedError('wrong-code-or-damaged').message;
    ui.info(message);
    return { status: 'refused', message };
  }
  try {
    // A project that is here but locked (no key file, an editor with no key of its own) is opened with the code and the wrap kept in its own folder.
    if ((await env.home.readMeta().catch(() => undefined)) && !(await env.keys.dataKey()) && await env.keys.hasRecoveryWrap()) {
      if (await env.keys.unlockWithCode(bytes)) { ui.info(UNLOCKED); return { status: 'unlocked', message: UNLOCKED }; }
      const message = new StateRefusedError('wrong-code-or-damaged').message;
      ui.info(message);
      return { status: 'refused', message };
    }
    const found = await resolveRemote(env, ui);
    if (found.kind === 'cancelled') return { status: 'cancelled', message: 'Project sync was not turned on.' };
    if (found.kind === 'none') { ui.info(NO_HOME); return { status: 'no-home', message: NO_HOME }; }
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'near-ai-unlock-'));
    let opening: Awaited<ReturnType<StateSync['openRemote']>>;
    try {
      opening = await env.makeSync({ remote: found.name, mirror: { mirrorDir: path.join(scratch, 'mirror.git'), hooksDir: privateHooksDir() } }).openRemote(bytes);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
    if (!opening.ok) {
      const outcome = opening.outcome;
      const message = outcome.kind === 'nothing-yet' ? NOTHING_ONLINE : outcome.message;
      ui.info(message);
      return { status: outcome.kind === 'refused' ? 'refused' : 'failed', message };
    }
    const local = await env.home.readMeta().catch(() => undefined);
    let joined = false;
    if (local && local.stateId !== opening.stateId) {
      const oldKey = await env.keys.dataKey();
      if (!oldKey) { ui.info(LOCKED_HERE); return { status: 'refused', message: LOCKED_HERE }; }
      if (!(await ui.confirm(JOIN_TEXT))) return { status: 'cancelled', message: 'Nothing was changed.' };
      const options: AdoptOptions = { ...(env.keepKeyInProject ? { keepKeyInProject: env.keepKeyInProject } : {}), ...(env.writer ? { writer: env.writer } : {}), ...(input.adopt ?? {}) };
      try {
        const adopted = await adoptRemoteIdentity(env.root, { stateId: local.stateId, key: oldKey }, { stateId: opening.stateId, key: opening.dataKey }, options);
        joined = adopted.changed;
      } catch {
        ui.info(JOIN_FAILED);
        return { status: 'failed', message: JOIN_FAILED };
      } finally {
        env.threads.forgetCaches();
      }
    }
    try {
      await env.keys.adoptDataKey(opening.dataKey, opening.stateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The online copy was not opened. Nothing was changed.';
      ui.info(message);
      return { status: 'refused', message };
    }
    await env.keys.storeRecoveryWrap(opening.wrap);
    await writeEnabled(env, { enabled: true, remote: found.name });
    env.onEnabled?.(true, found.name);
    const outcome = await env.makeSync({ remote: found.name }).sync();
    if (outcome.kind === 'synced' || outcome.kind === 'nothing-yet') {
      if (joined) await discardPreviousState(env.root);
      await env.afterRestore?.();
      ui.info(RESTORED);
      return { status: 'restored', message: RESTORED };
    }
    (ui.warn ?? ui.info).call(ui, outcome.message);
    return { status: 'pending', message: outcome.message };
  } finally {
    bytes.fill(0);
  }
}

// ---- a new code, the key file, turning off ----------------------------------------------------------------------------------------------

export type FlowStatus = 'done' | 'cancelled' | 'failed';
export interface FlowResult { status: FlowStatus; message: string }

/**
 * Shows a new recovery code once and makes it the one that opens the project (D-02). Its wrap goes up with the next sync (now, when sync is on). Copies
 * already on the git host were wrapped under the old code: until the data is re-keyed (not part of this phase) the old code still opens them, and the
 * message says so.
 */
export async function newCodeFlow(input: TurnOnInput): Promise<FlowResult> {
  const { env, ui } = input;
  if (!(await env.keys.dataKey())) { ui.info(NEEDS_KEY); return { status: 'failed', message: NEEDS_KEY }; }
  const settings = await settingsOf(env).read();
  const made = generateRecoveryCode();
  try {
    if (!(await ui.showCodeOnce(made.code))) return { status: 'cancelled', message: 'No new recovery code was made.' };
    await env.keys.writeRecoveryWrap(made.bytes);
  } finally {
    made.bytes.fill(0);
  }
  let message = NEW_CODE_SAVED;
  if (settings.enabled) {
    const found = await resolveRemote(env, ui);
    if (found.kind === 'remote') {
      const sync = env.makeSync({ remote: found.name });
      await sync.markWrapChanged();
      const outcome = await sync.sync();
      if (outcome.kind !== 'synced') message = `${message} It could not go online yet and will with the next sync.`;
    }
  }
  message = `${message} ${OLD_CODE_NOTE}`;
  ui.info(message);
  return { status: 'done', message };
}

/**
 * `nearAi.sync.keepKeyInProject` off or on (D-10). Off asks first, makes sure a recovery code exists (showing a new one once when it does not), keeps
 * this editor's own copy of the key, and only then removes keys/local.key. On writes the file again from the unlocked key.
 */
export async function keepKeyFlow(input: TurnOnInput, on: boolean): Promise<FlowResult> {
  const { env, ui } = input;
  if (on) {
    try {
      await env.keys.writeLocalKeyFile();
    } catch {
      ui.info(NEEDS_KEY);
      return { status: 'failed', message: NEEDS_KEY };
    }
    ui.info(KEY_FILE_ON_DONE);
    return { status: 'done', message: KEY_FILE_ON_DONE };
  }
  if (!(await env.keys.keepDeviceCopy())) { ui.info(NEEDS_KEY); return { status: 'failed', message: NEEDS_KEY }; }
  if (!(await ui.confirm(KEY_FILE_OFF_TEXT))) return { status: 'cancelled', message: 'The chat key file was kept.' };
  if (!(await env.keys.hasRecoveryWrap())) {
    const made = generateRecoveryCode();
    try {
      if (!(await ui.showCodeOnce(made.code))) return { status: 'cancelled', message: 'The chat key file was kept, because no recovery code was saved.' };
      await env.keys.writeRecoveryWrap(made.bytes);
    } finally {
      made.bytes.fill(0);
    }
  }
  await env.keys.removeLocalKeyFile();
  ui.info(KEY_FILE_OFF_DONE);
  return { status: 'done', message: KEY_FILE_OFF_DONE };
}

/** Stops syncing: nothing is scheduled or pushed any more. The remote branch and this computer's state are left as they are. */
export async function turnOffFlow(input: TurnOnInput): Promise<FlowResult> {
  const { env, ui } = input;
  await settingsOf(env).write({ enabled: false });
  env.onEnabled?.(false);
  ui.info(SYNC_OFF);
  return { status: 'done', message: SYNC_OFF };
}

// ---- when sync runs (D-17) --------------------------------------------------------------------------------------------------------------

/** The default for nearAi.sync.intervalMinutes: how often a background sync runs while the editor is idle. */
export const SYNC_INTERVAL_DEFAULT = 10;
const SYNC_INTERVAL_MAX = 1440;
/** A pull runs when the window comes back after being away this long. */
export const RETURN_PULL_AFTER_MS = 300_000;
/** Automatic pushes are at least this far apart, so push timing shows that someone is active, not which chat (D-09). */
export const PUSH_BATCH_MS = 120_000;
/** The push attempted when the editor closes is cut off after this long. It is never relied on. */
export const DEACTIVATE_PUSH_MS = 3_000;
/** Requests that arrive within this long of each other become one sync. */
export const COALESCE_MS = 5_000;
/** A full sync runs this long after the window loses focus, when nothing is running. */
export const BLUR_IDLE_MS = 60_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const WAIT_RETRY_MS = 30_000;

/** The interval setting as the reader sees it: a whole number of minutes from 0 (off) to 1440, and the default for anything that is not a number. */
export function clampSyncInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SYNC_INTERVAL_DEFAULT;
  return Math.min(SYNC_INTERVAL_MAX, Math.max(0, Math.floor(value)));
}

export type SyncState = 'off' | 'syncing' | 'synced' | 'attention' | 'no-home';
export type SyncReason = 'run-ended' | 'blur-idle' | 'manual' | 'interval' | 'open' | 'return' | 'retry' | 'close';

/** What the chat panel's sync control shows (D-16): one state and, where it helps, a time and one plain sentence. */
export interface SyncStatus {
  state: SyncState;
  /** When the last sync worked (ISO time), for 'synced'. */
  at?: string;
  /** One plain sentence: the problem for 'attention' and 'no-home'. No git terms beyond "git host", no URLs, no secrets. */
  message?: string;
  /** Why a sync is running, for 'syncing': 'open' lets the pick-up card say "Checking for updates…". */
  reason?: SyncReason;
}

export interface SyncClock {
  now(): number;
  setTimeout(work: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: SyncClock = { now: () => Date.now(), setTimeout: (work, ms) => setTimeout(work, ms), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) };

export interface SyncRequest { mode: 'sync' | 'pull'; /** True only for a person's click: only then may a sign-in be asked for. */ interactive: boolean; reason: SyncReason }

export interface SchedulerOptions {
  /** Runs one sync. Never called while a run is in flight. */
  runSync: (request: SyncRequest) => Promise<SyncOutcome>;
  runsInFlight: () => number;
  /** The nearAi.sync.intervalMinutes setting as it is now (clamped here). */
  intervalMinutes: () => unknown;
  clock?: SyncClock;
}

interface Job { full: boolean; interactive: boolean; reasons: SyncReason[] }

const NEEDS_SIGN_IN = 'Sync needs you to sign in. Choose Sync Project Now.';
const RUN_WAITING = 'A chat is running, so sync will run when it ends.';
const STOPPED = 'Sync stopped unexpectedly and will try again.';

/**
 * The one sentence for how a sync came out (D-16, D-17), used by the toast and the control alike so they never word the same failure two ways: the
 * transport's own plain sentence for a failure, except a sign-in that is missing on an automatic sync, which points at the click that can ask for it.
 */
export function statusSentence(outcome: SyncOutcome, interactive: boolean): string {
  const failure = outcome.failure;
  if (!failure) return outcome.message;
  if (failure.kind === 'auth' && !interactive) return NEEDS_SIGN_IN;
  return failure.message;
}

/** A status sentence that cannot carry a URL with credentials or a secret (T-27-91). */
function plain(text: string): string {
  return redactSecrets(redactGitMessage(text)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * Decides when a sync runs, and publishes what it came to (D-17, D-16). Full syncs (pull, merge, push) follow a run or chat reply that ends, the window
 * being out of focus for a minute, a click on Sync Project Now, and the background interval; pulls follow opening the project and coming back after five
 * minutes. It never starts while a run is in flight in this editor (what was asked is kept and runs when the run ends), joins requests that arrive close
 * together, backs off when the host cannot be reached (1, 2, 4 ... 30 minutes, reset by a success) and keeps automatic pushes at least two minutes apart. Only a
 * person's click may ask for a sign-in. No vscode: the clock, the runs and the sync itself are injected.
 */
export class SyncScheduler {
  private readonly clock: SyncClock;
  private on = false;
  private current: SyncStatus = { state: 'off' };
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private pending: Job | undefined;
  private dueAt = 0;
  private timer: unknown;
  private intervalTimer: unknown;
  private blurTimer: unknown;
  private retryTimer: unknown;
  private blurredAt: number | undefined;
  private running: Promise<void> | undefined;
  private lastPushAt: number | undefined;
  private backoffMs = 0;
  private notBefore = 0;
  /** The status from before the sync that is running, to go back to when it only had to wait. */
  private before: SyncStatus = { state: 'off' };

  public constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? realClock;
  }

  public status(): SyncStatus { return { ...this.current }; }

  public onStatus(listener: (status: SyncStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  private publish(next: SyncStatus): void {
    this.current = next.message === undefined ? next : { ...next, message: plain(next.message) };
    for (const listener of [...this.listeners]) { try { listener(this.status()); } catch { /* a listener never stops sync */ } }
  }

  /** Sync runs only once turned on. Turning it off stops everything that was scheduled. */
  public setEnabled(on: boolean): void {
    this.on = on;
    if (!on) {
      this.clearAll();
      this.pending = undefined;
      this.publish({ state: 'off' });
      return;
    }
    // The turn-on flow's own first sync follows; recordOutcome replaces this with what it came to.
    if (this.current.state === 'off') this.publish({ state: 'syncing', reason: 'manual' });
    this.scheduleInterval();
  }

  public isEnabled(): boolean { return this.on; }

  /** The project has no remote (or lost it): the control says so and offers the online-home setup. */
  public setNoHome(): void {
    this.publish({ state: 'no-home', message: 'This project has no online home yet.' });
  }

  /**
   * What a local look at the project's remotes found (localHomeState), for as long as sync is off: no remote reads "No online home · Set up", a remote reads
   * "Sync off · Turn on". Ignored while sync is on (the scheduler's own outcomes say the state then), and silent when the answer is the same as before.
   */
  public setHomeKnown(hasHome: boolean): void {
    if (this.on) return;
    if (hasHome) {
      if (this.current.state === 'no-home') this.publish({ state: 'off' });
      return;
    }
    if (this.current.state !== 'no-home') this.setNoHome();
  }

  /** Called when the project opens: with sync on, a pull starts at once and is not waited for. */
  public start(): void {
    if (!this.on) return;
    this.scheduleInterval();
    this.request('open', false, { immediate: true });
  }

  public stop(): void {
    this.clearAll();
    this.pending = undefined;
  }

  /** A run or chat reply ended in this editor: a full sync follows. */
  public runEnded(): void {
    this.request('run-ended', true);
  }

  /** The window lost or regained focus. A minute out of focus with nothing running starts a full sync; five minutes away starts a pull on return. */
  public windowFocus(focused: boolean): void {
    if (!focused) {
      if (this.blurredAt === undefined) this.blurredAt = this.clock.now();
      this.clock.clearTimeout(this.blurTimer);
      this.blurTimer = this.clock.setTimeout(() => {
        this.blurTimer = undefined;
        if (this.blurredAt !== undefined && this.options.runsInFlight() === 0) this.request('blur-idle', true);
      }, BLUR_IDLE_MS);
      return;
    }
    this.clock.clearTimeout(this.blurTimer);
    this.blurTimer = undefined;
    const away = this.blurredAt === undefined ? 0 : this.clock.now() - this.blurredAt;
    this.blurredAt = undefined;
    if (away >= RETURN_PULL_AFTER_MS) this.request('return', false, { immediate: true });
  }

  /** Sync Project Now: a person's click. It may ask for a sign-in and is not held back by the batching or the backoff. */
  public async syncNow(): Promise<SyncOutcome | undefined> {
    if (!this.on) return undefined;
    if (this.options.runsInFlight() > 0) {
      // Kept for when the run ends. It then runs without asking for a sign-in: the click was minutes ago.
      this.merge({ full: true, interactive: false, reasons: ['manual'] });
      return { kind: 'waiting', message: RUN_WAITING };
    }
    this.clearTimer();
    this.merge({ full: true, interactive: true, reasons: ['manual'] });
    return this.drain();
  }

  /** Records the result of a sync that was run outside the scheduler (the turn-on flow's first sync), so the status and the backoff follow it. */
  public recordOutcome(outcome: SyncOutcome, startedAt: number = this.clock.now()): void {
    this.settle(outcome, startedAt, { full: true, interactive: false, reasons: ['manual'] });
  }

  /** The interval setting changed: the next background sync is planned again from now. */
  public reschedule(): void {
    this.scheduleInterval();
  }

  /** Editor closing: one sync, cut off after DEACTIVATE_PUSH_MS, and any failure swallowed. Never relied on. */
  public async flushOnClose(): Promise<void> {
    if (!this.on) return;
    this.clearAll();
    if (this.options.runsInFlight() > 0) return;
    let timeout: unknown;
    try {
      const attempt = this.options.runSync({ mode: 'sync', interactive: false, reason: 'close' }).then(() => undefined, () => undefined);
      const cutOff = new Promise<void>((resolve) => { timeout = this.clock.setTimeout(resolve, DEACTIVATE_PUSH_MS); });
      await Promise.race([attempt, cutOff]);
    } catch { /* closing never fails because of sync */ } finally {
      this.clock.clearTimeout(timeout);
    }
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------

  private clearTimer(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearAll(): void {
    for (const handle of [this.timer, this.intervalTimer, this.blurTimer, this.retryTimer]) this.clock.clearTimeout(handle);
    this.timer = this.intervalTimer = this.blurTimer = this.retryTimer = undefined;
  }

  private merge(job: Job): void {
    const held = this.pending;
    this.pending = held
      ? { full: held.full || job.full, interactive: held.interactive || job.interactive, reasons: [...new Set([...held.reasons, ...job.reasons])] }
      : { ...job, reasons: [...job.reasons] };
  }

  /** Asks for a sync. While a run is in flight the request is kept and nothing is planned; the run ending asks again. */
  private request(reason: SyncReason, full: boolean, options: { immediate?: boolean } = {}): void {
    if (!this.on) return;
    this.merge({ full, interactive: false, reasons: [reason] });
    if (this.options.runsInFlight() > 0) return;
    const now = this.clock.now();
    let due = now + (options.immediate ? 0 : COALESCE_MS);
    // Automatic pushes are spaced out; a pull is not a push.
    if (this.pending?.full && this.lastPushAt !== undefined) due = Math.max(due, this.lastPushAt + PUSH_BATCH_MS);
    due = Math.max(due, this.notBefore);
    // Nothing holds it back: it starts now, in this call, so the status is 'syncing' as soon as the project opens.
    if (due <= now) { this.clearTimer(); void this.drain(); return; }
    if (this.timer !== undefined && due <= this.dueAt) return;
    this.clearTimer();
    this.dueAt = due;
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; void this.drain(); }, Math.max(0, due - now));
  }

  private scheduleInterval(): void {
    this.clock.clearTimeout(this.intervalTimer);
    this.intervalTimer = undefined;
    const minutes = clampSyncInterval(this.options.intervalMinutes());
    if (!this.on || minutes === 0) return;
    this.intervalTimer = this.clock.setTimeout(() => {
      this.intervalTimer = undefined;
      // Only while idle: a run in flight skips this one.
      if (this.options.runsInFlight() === 0 && this.running === undefined) this.request('interval', true);
      this.scheduleInterval();
    }, minutes * 60_000);
  }

  /** Runs what is pending, one sync at a time. */
  private async drain(): Promise<SyncOutcome | undefined> {
    if (!this.on) return undefined;
    if (this.running !== undefined) {
      // One is already going: what was asked waits for it, then goes next.
      await this.running;
      if (this.pending && this.options.runsInFlight() === 0) this.request('retry', this.pending.full, { immediate: true });
      return undefined;
    }
    if (this.options.runsInFlight() > 0 || this.pending === undefined) return undefined;
    const job = this.pending;
    this.pending = undefined;
    let outcome: SyncOutcome | undefined;
    this.running = (async () => {
      const startedAt = this.clock.now();
      const reason = job.reasons.includes('open') ? 'open' : (job.reasons[0] as SyncReason);
      this.before = this.current;
      this.publish({ state: 'syncing', reason });
      try {
        outcome = await this.options.runSync({ mode: job.full ? 'sync' : 'pull', interactive: job.interactive, reason });
      } catch {
        outcome = { kind: 'failed', message: STOPPED };
      }
      this.settle(outcome, startedAt, job);
    })();
    try { await this.running; } finally { this.running = undefined; }
    return outcome;
  }

  /** What a finished sync does to the status, the backoff and the batching. */
  private settle(outcome: SyncOutcome, startedAt: number, job: Job): void {
    const now = this.clock.now();
    if (outcome.kind === 'synced' || outcome.kind === 'nothing-yet') {
      this.backoffMs = 0;
      this.notBefore = 0;
      if (outcome.pushed) this.lastPushAt = startedAt;
      this.publish({ state: 'synced', at: new Date(now).toISOString(), message: outcome.message });
      return;
    }
    if (outcome.kind === 'waiting') {
      // Another window is syncing or a run began: not a problem, try again soon.
      this.publish(this.before.state === 'off' || this.before.state === 'syncing' ? { state: 'synced' } : this.before);
      this.merge(job);
      this.clock.clearTimeout(this.retryTimer);
      this.retryTimer = this.clock.setTimeout(() => { this.retryTimer = undefined; this.request('retry', this.pending?.full ?? false, { immediate: true }); }, WAIT_RETRY_MS);
      return;
    }
    if (outcome.kind === 'refused') {
      // Retrying cannot change a refusal (a damaged or foreign copy, a locked project): the person is told and the next trigger tries again.
      this.publish({ state: 'attention', message: outcome.message });
      return;
    }
    const kind = outcome.failure?.kind;
    if (kind === 'no-remote') { this.setNoHome(); return; }
    this.backoffMs = this.backoffMs === 0 ? BACKOFF_FIRST_MS : Math.min(BACKOFF_MAX_MS, this.backoffMs * 2);
    this.notBefore = now + this.backoffMs;
    this.publish({ state: 'attention', message: statusSentence(outcome, job.interactive) });
    // What was asked is not lost: it runs again once the backoff is over.
    this.merge(job);
    this.request('retry', this.pending?.full ?? false);
  }
}

// ---- the GitHub sign-in for syncs ---------------------------------------------------------------------------------------------------

/**
 * A git runner that signs in to github.com for the calls that touch the private mirror, with a token looked up when it is needed (carry-forward 27-17):
 * `getToken` is silent for every automatic sync, and only a person's click may prompt. Nothing is changed when there is no token. The token never
 * reaches an argument or a file: withGitHubAuth puts it in the child's environment, scoped to https://github.com/.
 */
export function tokenRunner(base: GitRunner, getToken: () => Promise<string | undefined>): GitRunner {
  return async (args, options) => {
    if (!args.includes('--git-dir')) return base(args, options);
    const token = await getToken();
    return (token === undefined ? base : withGitHubAuth(base, token))(args, options);
  };
}
