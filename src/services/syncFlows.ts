// The sync controls in plain words (D-01, D-02, D-10, D-14, D-17): turn sync on with a recovery code shown once, restore a project on another computer with
// that code (the NEAR AI key included), route a project with no remote into the online-home flow, join from a computer that already has chats of its own,
// issue a new code, switch the key file off or on, turn sync off, and sync at safe moments. Nothing here imports vscode: every question to the person, the
// online-home setup and the building of a sync are injected, so the whole of it runs on plain node with fakes and local bare repositories.
//
// The recovery code lives in local variables of the flow that made it and is dropped when that flow ends: it is passed to the person's screen (the only
// place it is ever passed), never written to a file, a setting, a log, globalState or an error, and never sent anywhere.
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateRefusedError } from '../domain/state/keys';
import { generateRecoveryCode, parseRecoveryCode } from '../domain/state/recoveryCode';
import type { OnlineHomeRemote, OnlineHomeResult } from './onlineHome';
import { runStateGit, gitText, type GitRunner } from './stateGit';
import { ProjectStateHome } from './stateHome';
import type { StateKeys } from './stateKeys';
import type { RunMarker, RunState } from './runMarkers';
import { StateSync, type StateSyncOptions, type SyncOutcome } from './stateSync';
import { StateTransport, validateRemote } from './stateTransport';
import { adoptRemoteIdentity, discardPreviousState, type AdoptOptions } from './stateRestore';
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
}

export interface SyncSettings { enabled: boolean; remote?: string }

/** Whether sync is on for this project and which remote it uses, from the git-ignored state home (a cloned project never inherits it). */
export async function readSyncSettings(home: ProjectStateHome): Promise<SyncSettings> {
  const meta = await home.readMeta().catch(() => undefined);
  const sync = meta?.sync;
  const remote = typeof sync?.remote === 'string' && sync.remote !== '' ? sync.remote : undefined;
  return { enabled: sync?.enabled === true, ...(remote ? { remote } : {}) };
}

async function writeSyncSettings(home: ProjectStateHome, change: Partial<SyncSettings>): Promise<void> {
  const meta = await home.ensure();
  await home.updateMeta({ sync: { ...(meta.sync ?? {}), ...change } });
}

export type RemoteChoice = { kind: 'remote'; name: string } | { kind: 'none' } | { kind: 'cancelled' };

/**
 * The project's remote (D-14, D-09 defers any setting for it): one stored in the state home when it still exists, else `origin`, else the only remote,
 * else the person's pick among several (asked once and remembered in the state home). No repository or no remote is 'none'.
 */
export async function resolveRemote(env: Pick<SyncEnv, 'root' | 'home' | 'git'>, ui: Pick<SyncUi, 'pickRemote'>): Promise<RemoteChoice> {
  const run = env.git ?? runStateGit;
  const listed = await run(['-C', env.root, 'remote']).catch(() => undefined);
  const names = listed && listed.code === 0 ? gitText(listed).split('\n').map((line) => line.trim()).filter((line) => line !== '') : [];
  if (names.length === 0) return { kind: 'none' };
  const usable = (name: string): boolean => !('message' in validateRemote(name, names));
  const stored = (await readSyncSettings(env.home)).remote;
  if (stored && names.includes(stored) && usable(stored)) return { kind: 'remote', name: stored };
  if (names.includes('origin') && usable('origin')) return { kind: 'remote', name: 'origin' };
  if (names.length === 1 && usable(names[0] as string)) return { kind: 'remote', name: names[0] as string };
  const picked = await ui.pickRemote(names);
  if (!picked || !names.includes(picked) || !usable(picked)) return { kind: 'cancelled' };
  await writeSyncSettings(env.home, { remote: picked });
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
  isIdle?: () => boolean;
  runState?: (marker: RunMarker) => RunState;
  profiles?: { profileSource: ProfileSource; secretSource: SecretSource; applyProfiles: (records: StateRecord[]) => Promise<void> };
  extra?: Partial<StateSyncOptions>;
}

/** One StateSync over its own StateTransport. The private mirror is in the state home unless `mirror` says otherwise. */
export function buildStateSync(parts: SyncParts, input: { remote: string; git?: GitRunner; mirror?: { mirrorDir: string; hooksDir: string } }): StateSync {
  const mirror = input.mirror ?? { mirrorDir: path.join(parts.home.paths.sync, 'mirror.git'), hooksDir: path.join(parts.home.paths.sync, 'hooks') };
  const transport = new StateTransport({ root: parts.root, remote: input.remote, mirrorDir: mirror.mirrorDir, hooksDir: mirror.hooksDir, git: input.git ?? parts.git ?? runStateGit });
  return new StateSync({
    root: parts.root, home: parts.home, keys: parts.keys, threads: parts.threads, transport, remote: input.remote, writer: parts.writer,
    ...(parts.isIdle ? { isIdle: parts.isIdle } : {}), ...(parts.runState ? { runState: parts.runState } : {}),
    ...(parts.profiles ?? {}), ...(input.mirror ? { registerColdFetcher: false } : {}), ...(parts.extra ?? {})
  });
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
  await writeSyncSettings(env.home, { enabled: true, remote });
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
  const typed = await ui.askCode();
  if (typed === undefined) return { status: 'cancelled', message: 'No recovery code was entered.' };
  const bytes = parseRecoveryCode(typed);
  if (!bytes) {
    const message = new StateRefusedError('wrong-code-or-damaged').message;
    ui.info(message);
    return { status: 'refused', message };
  }
  try {
    const found = await resolveRemote(env, ui);
    if (found.kind === 'cancelled') return { status: 'cancelled', message: 'Project sync was not turned on.' };
    if (found.kind === 'none') { ui.info(NO_HOME); return { status: 'no-home', message: NO_HOME }; }
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'near-ai-unlock-'));
    let opening: Awaited<ReturnType<StateSync['openRemote']>>;
    try {
      opening = await env.makeSync({ remote: found.name, mirror: { mirrorDir: path.join(scratch, 'mirror.git'), hooksDir: path.join(scratch, 'hooks') } }).openRemote(bytes);
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
      const adopted = await adoptRemoteIdentity(env.root, { stateId: local.stateId, key: oldKey }, { stateId: opening.stateId, key: opening.dataKey }, options);
      joined = adopted.changed;
      env.threads.forgetCaches();
    }
    try {
      await env.keys.adoptDataKey(opening.dataKey, opening.stateId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The online copy was not opened. Nothing was changed.';
      ui.info(message);
      return { status: 'refused', message };
    }
    await env.keys.storeRecoveryWrap(opening.wrap);
    await writeSyncSettings(env.home, { enabled: true, remote: found.name });
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

// ---- a new code, the key file, turning off (stubs until the tests that drive them are green) --------------------------------------------

export type FlowStatus = 'done' | 'cancelled' | 'failed';
export interface FlowResult { status: FlowStatus; message: string }

/** Shows a new recovery code once and makes it the one that opens the project (D-02). */
export function newCodeFlow(_input: TurnOnInput): Promise<FlowResult> {
  return Promise.reject(new Error('not implemented'));
}

/** `nearAi.sync.keepKeyInProject` off or on (D-10). */
export function keepKeyFlow(_input: TurnOnInput, _on: boolean): Promise<FlowResult> {
  return Promise.reject(new Error('not implemented'));
}

/** Stops syncing; the remote and this computer's state are left as they are. */
export function turnOffFlow(_input: TurnOnInput): Promise<FlowResult> {
  return Promise.reject(new Error('not implemented'));
}
