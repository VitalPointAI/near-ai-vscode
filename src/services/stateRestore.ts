// What of a project's NEAR AI profile and key crosses machines, and how a computer that already has chats of its own joins a synced project (SYNC-04,
// D-02, D-15). No vscode here, so tests run on plain node.
//
// The key travels only as the D-15 sealed copy (the bytes of keys/api/<profile>.enc) inside the end-to-end encrypted bundle: this computer opens the
// copy in memory with the project's data key and saves the key under its own project scope, bound to the profile's endpoint. Profiles that reuse another
// project's key, profiles of a team, and any sign-in token are never collected, sent or written. Nothing here puts a key in a file, a log or a message.
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { PROFILE_ID_PATTERN, isProfileId, type OrganizationProfile } from '../domain/auth';
import type { AuthMode } from '../domain/config';
import type { StateRecord } from '../domain/state/records';
import { AuthService } from './auth';
import { ProfileStore, type CreateOrganizationProfileInput } from './profileStore';
import { isTeamProfileId } from './profileIndex';
import { listApiKeyCopies, openApiKeyCopy, openApiKeyCopyText, readApiKeyCopyText, writeApiKeyCopy } from './stateApiKey';
import { ProjectStateHome, stateHomeFor } from './stateHome';
import { StateKeys, dataKeySecretName, type SecretsLike } from './stateKeys';
import type { ProfileSource, SecretSource, SourceRecord } from './stateRecords';
import { ThreadStore, type ImportedThread } from './threadStore';
import { readArchive } from './threadArchive';
import { unionEntries } from '../domain/state/threadEntries';

const COPY_KEYS = ['format', 'iv', 'tag', 'data'];

/** Whether a profile's metadata and key go to other computers: not a reused profile (its key lives in another project) and not a team's. */
function travels(profile: OrganizationProfile): boolean {
  return !profile.keySource && !isTeamProfileId(profile.profileId) && PROFILE_ID_PATTERN.test(profile.profileId);
}

/** What of a profile is sent: its settings, never a key, a token or the result of its last check. */
interface ProfileBody {
  displayName: string;
  organization: string;
  provider: 'near-ai' | 'local' | 'hybrid';
  baseUrl: string;
  localBaseUrl?: string;
  authMode: AuthMode;
  createdAt: string;
}

function bodyOf(profile: OrganizationProfile): ProfileBody {
  return {
    displayName: profile.displayName, organization: profile.organization, provider: profile.provider, baseUrl: profile.baseUrl,
    ...(profile.localBaseUrl ? { localBaseUrl: profile.localBaseUrl } : {}), authMode: profile.authMode, createdAt: profile.createdAt
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProfileBody(value: unknown): ProfileBody | undefined {
  if (!isObject(value)) return undefined;
  const { displayName, organization, provider, baseUrl, localBaseUrl, authMode, createdAt } = value;
  if (typeof displayName !== 'string' || typeof organization !== 'string' || typeof baseUrl !== 'string' || typeof createdAt !== 'string') return undefined;
  if (provider !== 'near-ai' && provider !== 'local' && provider !== 'hybrid') return undefined;
  if (authMode !== 'apiKey' && authMode !== 'nearAccount') return undefined;
  if (localBaseUrl !== undefined && typeof localBaseUrl !== 'string') return undefined;
  return { displayName, organization, provider, baseUrl, ...(localBaseUrl ? { localBaseUrl } : {}), authMode, createdAt };
}

/** The settings of every profile that may travel, as profile records. Reads the project's profile file each time, so a change made in another editor is seen. */
export function profileSourceFor(root: string, auth: AuthService): ProfileSource {
  return {
    async records(): Promise<SourceRecord[]> {
      const exported = await new ProfileStore(root, auth).exportMetadata();
      return exported.profiles.filter(travels).map((profile) => ({ id: profile.profileId, body: bodyOf(profile), at: profile.updatedAt }));
    }
  };
}

/**
 * The sealed key copies of every profile that may travel, one secret record each. The body is the copy file as it is on disk (sealed under the project's
 * data key with a subkey of its own); the plaintext key is never read here.
 */
export function secretSourceFor(root: string, auth: AuthService, home: ProjectStateHome = stateHomeFor(root)): SecretSource {
  return {
    async records(): Promise<SourceRecord[]> {
      const exported = await new ProfileStore(root, auth).exportMetadata();
      const eligible = new Set(exported.profiles.filter(travels).map((profile) => profile.profileId));
      const found: SourceRecord[] = [];
      for (const profileId of await listApiKeyCopies(home)) {
        if (!eligible.has(profileId)) continue;
        const text = await readApiKeyCopyText(home, profileId);
        if (text === undefined) continue;
        let copy: unknown;
        try { copy = JSON.parse(text); } catch { continue; }
        if (!isObject(copy)) continue;
        const at = (await stat(path.join(home.paths.apiKeysDir, `${profileId}.enc`)).catch(() => undefined))?.mtime.toISOString();
        found.push({ id: profileId, body: { profileId, copy }, ...(at ? { at } : {}) });
      }
      return found;
    }
  };
}

export interface RestoreDeps {
  /** The project's keys on this computer: the sealed copies are opened with the data key they hold. */
  keys: StateKeys;
  home?: ProjectStateHome;
  /** The profile store to write through. Without one a store is made that does not call the provider while a sync is applying records. */
  store?: ProfileStore;
  /** Plain sentences only; never a key. */
  log?: (line: string) => void;
}

export interface RestoreResult {
  /** Profile ids whose settings (and key, when one came) were written here. */
  restored: string[];
  /** Profile ids left alone: not allowed to travel, not valid, already the same here, or whose key could not be opened for this endpoint. */
  skipped: string[];
}

/** A check that never reaches the provider: a restored profile is checked the next time it is selected or set up, not in the middle of a sync. */
const DEFERRED_CHECK = async (): Promise<void> => { throw new Error('This profile is checked the next time you use it.'); };

function sameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');
}

/** The newest record of each id. */
function newest(records: readonly StateRecord[], kind: 'profile' | 'secret'): Map<string, StateRecord> {
  const found = new Map<string, StateRecord>();
  for (const record of records) {
    if (record.kind !== kind) continue;
    const current = found.get(record.id);
    if (!current || record.at > current.at || (record.at === current.at && record.rev > current.rev)) found.set(record.id, record);
  }
  return found;
}

/**
 * Applies profile and secret records that came from another computer (StateSync's applyProfiles): the profile's settings are written through
 * ProfileStore.configure, the key from the sealed copy is saved under this computer's own project scope with the endpoint it was saved for, and the
 * profile is left to be checked by the existing check (validation stale). A key is released only to the endpoint it was sealed for. Nothing is
 * restored for a team profile, for a profile that reuses another project's key, or for a copy that does not open under this project's key.
 */
export async function restoreProfiles(root: string, auth: AuthService, records: readonly StateRecord[], deps: RestoreDeps): Promise<RestoreResult> {
  const result: RestoreResult = { restored: [], skipped: [] };
  const home = deps.home ?? stateHomeFor(root);
  const log = deps.log ?? (() => undefined);
  const dataKey = await deps.keys.dataKey();
  const meta = await home.readMeta().catch(() => undefined);
  const store = deps.store ?? new ProfileStore(root, auth, { validator: DEFERRED_CHECK });
  const profiles = newest(records, 'profile');
  const secrets = newest(records, 'secret');
  for (const [profileId, record] of profiles) {
    const skip = (why: string): void => { result.skipped.push(profileId); log(`A profile from another computer was not restored: ${why}`); };
    if (!isProfileId(profileId) || isTeamProfileId(profileId)) { skip('it is not a profile this project may share.'); continue; }
    const body = parseProfileBody(record.body);
    if (!body) { skip('its settings were not in the expected form.'); continue; }
    try {
      const existing = await store.get(profileId);
      if (existing?.keySource) { skip('this project already uses a key from another project for it.'); continue; }
      const input: CreateOrganizationProfileInput = {
        profileId, displayName: body.displayName, organization: body.organization, baseUrl: body.baseUrl, authMode: body.authMode, provider: body.provider,
        ...(body.localBaseUrl ? { localBaseUrl: body.localBaseUrl } : {})
      };
      const copy = secrets.get(profileId) ? readCopy(secrets.get(profileId) as StateRecord, profileId, dataKey, meta?.stateId, log) : undefined;
      // A key that is sealed for another endpoint than the profile's own is not released to it.
      if (copy && !sameEndpoint(copy.endpoint, body.baseUrl)) { skip("its key was saved for a different endpoint than the profile's."); continue; }
      if (copy && existing && sameEndpoint(existing.baseUrl, body.baseUrl) && await auth.getScopedApiKey(store.getScope(profileId)) === copy.apiKey) { result.skipped.push(profileId); continue; }
      if (copy) {
        await store.configure(input, copy.apiKey, copy.localApiKey ?? '');
        // Without the project's own hook (tests, a first run) the copy this computer keeps for its other editors is written here.
        if (!auth.keyCopy) await writeApiKeyCopy(home, deps.keys, copy);
      } else if (existing) {
        await store.update({ profileId, displayName: body.displayName, organization: body.organization, baseUrl: body.baseUrl, authMode: body.authMode });
      } else {
        await store.create(input);
      }
      await store.markValidationStale(profileId);
      result.restored.push(profileId);
    } catch {
      skip('it could not be saved here.');
    }
  }
  return result;
}

/** The three things a StateSync needs for profiles and keys (profileSource, secretSource, applyProfiles), made for this project and editor. */
export function profileSyncHooks(root: string, auth: AuthService, keys: StateKeys, home: ProjectStateHome = stateHomeFor(root), log?: (line: string) => void): { profileSource: ProfileSource; secretSource: SecretSource; applyProfiles: (records: StateRecord[]) => Promise<void> } {
  return {
    profileSource: profileSourceFor(root, auth),
    secretSource: secretSourceFor(root, auth, home),
    applyProfiles: async (records) => { await restoreProfiles(root, auth, records, { keys, home, ...(log ? { log } : {}) }); }
  };
}

function readCopy(record: StateRecord, profileId: string, dataKey: Buffer | undefined, stateId: string | undefined, log: (line: string) => void) {
  if (!dataKey || !stateId) return undefined;
  const body = record.body;
  if (!isObject(body) || body.profileId !== profileId || !isObject(body.copy)) return undefined;
  const keys = Object.keys(body.copy).sort();
  if (keys.length !== COPY_KEYS.length || COPY_KEYS.slice().sort().some((name, index) => keys[index] !== name)) return undefined;
  return openApiKeyCopyText(JSON.stringify(body.copy), dataKey, stateId, profileId, log);
}

// ---- joining a synced project from a computer that already has chats of its own --------------------------------------------------------

/** What a project's identity is: the random id and the data key that seals everything. */
export interface Identity { stateId: string; key: Buffer }

export type AdoptPoint = 'built' | 'between-renames';

export interface AdoptOptions {
  /** Whether the new key is also kept in a file in the project (nearAi.sync.keepKeyInProject). Default true. */
  keepKeyInProject?: () => boolean;
  /** The writer id of the copy's thread store. */
  writer?: string;
  /** Test seam: called at named points; a throw there stops the adoption as a failure would. */
  hook?: (point: AdoptPoint) => void | Promise<void>;
}

export interface AdoptResult {
  /** Whether anything changed: false when the project's own id already is the one to adopt, or there was no state home. */
  changed: boolean;
  /** The folder that holds the state as it was before the join, until a sync has worked; undefined when nothing changed. */
  previous?: string;
  /** The ids of conversations this join did not carry over (locked, unreadable, or kept only online). The folder from before the join is kept for them. */
  notCarried: string[];
  /** What the carried files and thread folders looked like when they were copied, so a later catch-up sees what changed since. */
  copied?: FileSnapshot;
}

/** Size and modification time of every file under some folders of a state home, by path relative to the home. */
export type FileSnapshot = Record<string, string>;

class PrivateSecrets implements SecretsLike {
  private readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

/** Plain files and folders of the state home that hold nothing sealed under the data key, so a join carries them over as they are. */
const CARRIED = ['runs', 'checkpoints', 'comparisons', 'choices.json', 'spend', 'pickup.json'] as const;

const ADOPT_PREFIX = 'state.adopt-';
const PREVIOUS_PREFIX = 'state.previous-';
/** Written into a folder kept from before a join when some conversation in it could not be carried: such a folder is never removed. */
const NOT_CARRIED_FILE = 'not-carried.json';
const THREAD_FOLDER = /^conv-[a-z0-9-]{6,60}$/;
const PREVIOUS_TIME = /^state\.previous-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]+$/;

function parentOf(home: ProjectStateHome): string {
  return path.dirname(home.dir);
}

/** A folder name for the state kept from before a join: the UTC time first (to the millisecond), so names sort by time. */
function previousName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${PREVIOUS_PREFIX}${stamp}-${randomBytes(4).toString('hex')}`;
}

/** The time a kept folder was made: from its name when it has one, else from when it was last changed (names of earlier builds carry no time). */
async function previousTime(parent: string, name: string): Promise<number> {
  const found = PREVIOUS_TIME.exec(name);
  if (found) {
    const [, y, mo, d, h, mi, sec, ms] = found.map(Number) as number[];
    return Date.UTC(y as number, (mo as number) - 1, d as number, h as number, mi as number, sec as number, ms as number);
  }
  return (await stat(path.join(parent, name)).catch(() => undefined))?.mtimeMs ?? 0;
}

/**
 * Puts a state home back in order after an adoption that was cut off: when the state folder is missing and previous ones are there (the first rename
 * happened, the second did not), the newest by the time in its name (by modification time for a name without one) is renamed back; half-built copies
 * are removed. Safe to call at any time.
 */
export async function recoverInterruptedAdoption(root: string): Promise<void> {
  const home = stateHomeFor(root);
  const parent = parentOf(home);
  const names = await readdir(parent).catch(() => [] as string[]);
  const present = Boolean((await stat(home.dir).catch(() => undefined))?.isDirectory());
  if (!present) {
    let back: { name: string; at: number } | undefined;
    for (const name of names.filter((item) => item.startsWith(PREVIOUS_PREFIX)).sort()) {
      const at = await previousTime(parent, name);
      if (!back || at >= back.at) back = { name, at };
    }
    if (back) await rename(path.join(parent, back.name), home.dir);
  }
  for (const name of names) if (name.startsWith(ADOPT_PREFIX)) await rm(path.join(parent, name), { recursive: true, force: true });
}

async function folderNames(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory() && THREAD_FOLDER.test(item.name)).map((item) => item.name);
}

/** The ids a kept folder names: each thread folder and each archive folder, and every id recorded as not carried. */
async function idsHeldBy(folder: string): Promise<{ held: Set<string>; notCarried: string[] }> {
  const held = new Set([...await folderNames(path.join(folder, 'threads')), ...await folderNames(path.join(folder, 'archive'))]);
  let notCarried: string[] = [];
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(folder, NOT_CARRIED_FILE), 'utf8'));
    if (Array.isArray(parsed)) notCarried = parsed.filter((item): item is string => typeof item === 'string');
  } catch (error) {
    // A marker that is there but cannot be read is a reason to keep the folder, never to remove it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') notCarried = ['unreadable-marker'];
  }
  return { held, notCarried };
}

/** Records, inside the folder kept from before a join, the conversations that were not carried; such a folder is then never removed. */
async function markNotCarried(previous: string, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const kept = (await idsHeldBy(previous)).notCarried;
  await writeFile(path.join(previous, NOT_CARRIED_FILE), `${JSON.stringify([...new Set([...kept, ...ids])].sort())}\n`, { mode: 0o600 });
}

/**
 * Removes the state folders kept from before a join, but only a folder whose every conversation is in the current state: one that holds a thread folder
 * or an archive folder the current state does not list, or that was marked as holding conversations the join could not carry, is left where it is
 * (it may hold the only copy). `current` is the project's thread store; without one, the thread folders on disk stand for what the state holds.
 */
export async function discardPreviousState(root: string, current?: { index(): Promise<Array<{ id: string; locked?: boolean }>> }): Promise<void> {
  const home = stateHomeFor(root);
  const parent = parentOf(home);
  const kept = (await readdir(parent).catch(() => [] as string[])).filter((name) => name.startsWith(PREVIOUS_PREFIX));
  if (!kept.length) return;
  let present: Set<string>;
  try {
    present = current
      ? new Set((await current.index()).filter((item) => !item.locked).map((item) => item.id))
      : new Set([...await folderNames(home.paths.threads), ...await folderNames(home.paths.archive)]);
  } catch {
    return;
  }
  for (const name of kept) {
    const folder = path.join(parent, name);
    const { held, notCarried } = await idsHeldBy(folder);
    if (notCarried.length || [...held].some((id) => !present.has(id))) continue;
    await rm(folder, { recursive: true, force: true });
  }
}

/** Size and modification time of every file under the named folders (or files) of `base`. */
async function snapshotOf(base: string, names: readonly string[]): Promise<FileSnapshot> {
  const found: FileSnapshot = {};
  const walk = async (relative: string): Promise<void> => {
    const full = path.join(base, relative);
    const info = await stat(full).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      for (const child of await readdir(full).catch(() => [] as string[])) await walk(path.join(relative, child));
    } else if (info.isFile()) {
      found[relative.split(path.sep).join('/')] = `${info.size}:${info.mtimeMs}`;
    }
  };
  for (const name of names) await walk(name);
  return found;
}

const SNAPSHOT_FOLDERS = [...CARRIED, 'threads', 'archive'];

/**
 * Re-encrypts this project's own chats and records under a synced project's identity (D-02, D-05). A copy of the state home is built beside the real
 * one (.near-ai/state.adopt-<random>): every thread, live or archived, is read with the old key and written with the new one under the new id; the
 * plain files are carried over; the key copies are re-sealed. Only when the copy is complete are the folders swapped, by two renames (the old one kept
 * as .near-ai/state.previous-<UTC time>-<hex>). A failure at any point leaves the original in place, and a cut-off run is put right by the next call.
 * A conversation that cannot be carried (locked, unreadable, kept only online) is listed in `notCarried` and marked in the kept folder, which no
 * discard then removes. The caller holds the project's sync lock around this and catchUpFromPrevious, syncs next, and calls discardPreviousState only
 * when that worked.
 */
export async function adoptRemoteIdentity(root: string, from: Identity, to: Identity, options: AdoptOptions = {}): Promise<AdoptResult> {
  await recoverInterruptedAdoption(root);
  const home = stateHomeFor(root);
  const oldMeta = await home.readMeta();
  if (!oldMeta || oldMeta.stateId === to.stateId) return { changed: false, notCarried: [] };
  const asideDir = path.join(parentOf(home), `${ADOPT_PREFIX}${randomBytes(6).toString('hex')}`);
  const previous = path.join(parentOf(home), previousName());
  const writer = options.writer ?? 'join-writer';
  const keep = options.keepKeyInProject ?? (() => true);
  try {
    // What the old home holds, read with the old key held only in memory.
    const oldSecrets = new PrivateSecrets();
    await oldSecrets.store(dataKeySecretName(from.stateId), from.key.toString('base64'));
    const oldKeys = new StateKeys(home, oldSecrets, () => false);
    const oldStore = new ThreadStore(home, oldKeys, { writer });

    // The copy, with the synced project's id and key.
    const aside = new ProjectStateHome(root, asideDir);
    await aside.ensure({ stateId: to.stateId });
    const asideKeys = new StateKeys(aside, new PrivateSecrets(), keep);
    await asideKeys.adoptDataKey(to.key, to.stateId);
    const asideStore = new ThreadStore(aside, asideKeys, { writer });
    // Looked at before anything is read, so a change made while the copy is built is seen afterwards.
    const copied = await snapshotOf(home.dir, SNAPSHOT_FOLDERS);
    const notCarried: string[] = [];
    for (const item of await oldStore.index()) {
      const thread = item.locked || item.location === 'remote' ? undefined : await readOldThread(oldStore, item.id, item.state === 'archived');
      if (thread) await asideStore.importThread(item.id, thread); else notCarried.push(item.id);
    }
    for (const name of CARRIED) {
      const source = path.join(home.dir, name);
      if (await stat(source).catch(() => undefined)) await cp(source, path.join(aside.dir, name), { recursive: true });
    }
    for (const profileId of await listApiKeyCopies(home)) {
      const copy = await openApiKeyCopy(home, oldKeys, profileId);
      if (copy) await writeApiKeyCopy(aside, asideKeys, copy);
    }
    if (oldMeta.migrated) await aside.updateMeta({ migrated: oldMeta.migrated });
    await mkdir(aside.dir, { recursive: true });
    await options.hook?.('built');

    // The swap: two renames, the original kept until a sync has worked.
    await rename(home.dir, previous);
    try {
      await options.hook?.('between-renames');
      await rename(asideDir, home.dir);
    } catch (error) {
      await rename(previous, home.dir).catch(() => undefined);
      throw error;
    }
    try {
      // The folder from before the join is the only copy of what could not be carried: it is marked so nothing removes it.
      await markNotCarried(previous, notCarried);
    } catch (error) {
      // Not marked means not safe to keep unmarked: the join is undone.
      await rename(home.dir, asideDir).catch(() => undefined);
      await rename(previous, home.dir).catch(() => undefined);
      throw error;
    }
    return { changed: true, previous, notCarried, copied };
  } catch (error) {
    await rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** What a catch-up found. */
export interface CatchUpResult {
  /** Conversations of the folder from before the join that could not be read again, so were not brought up to date. They are kept there. */
  notCarried: string[];
}

/**
 * Brings what was written to the state home between the copy and the swap into the joined state (another editor of this computer appending to a thread
 * while the join ran): every conversation of the folder from before the join that is new or changed since `copied` (every one, without it) is read with the
 * old key and added to the joined state under its id and key, entry by entry, an entry already there not written twice; plain files that changed
 * since the copy are copied again. Nothing is removed, and nothing is touched when nothing changed. The caller holds the project's sync lock.
 */
export async function catchUpFromPrevious(root: string, from: Identity, to: Identity, previous: string, copied?: FileSnapshot, options: { writer?: string } = {}): Promise<CatchUpResult> {
  const home = stateHomeFor(root);
  const old = new ProjectStateHome(root, previous);
  const writer = options.writer ?? 'join-writer';
  const now = await snapshotOf(old.dir, SNAPSHOT_FOLDERS);
  const changed = (name: string): boolean => copied === undefined || now[name] !== copied[name];
  const notCarried: string[] = [];

  // Threads and archives that are new or changed.
  const touched = new Set<string>();
  for (const name of Object.keys(now)) {
    const [folder, id] = name.split('/');
    if ((folder === 'threads' || folder === 'archive') && id && THREAD_FOLDER.test(id) && changed(name)) touched.add(id);
  }
  if (touched.size) {
    const oldSecrets = new PrivateSecrets();
    await oldSecrets.store(dataKeySecretName(from.stateId), from.key.toString('base64'));
    const oldStore = new ThreadStore(old, new StateKeys(old, oldSecrets, () => false), { writer });
    const newSecrets = new PrivateSecrets();
    await newSecrets.store(dataKeySecretName(to.stateId), to.key.toString('base64'));
    const newStore = new ThreadStore(home, new StateKeys(home, newSecrets, () => false), { writer });
    const listed = new Map((await oldStore.index()).map((item) => [item.id, item]));
    for (const id of touched) {
      const item = listed.get(id);
      const thread = item && !item.locked && item.location !== 'remote' ? await readOldThread(oldStore, id, item.state === 'archived') : undefined;
      if (!thread) { notCarried.push(id); continue; }
      try { await newStore.importThread(id, thread); } catch { notCarried.push(id); }
    }
  }

  // Plain files that changed since they were copied.
  for (const name of Object.keys(now)) {
    const [folder] = name.split('/');
    if (folder === 'threads' || folder === 'archive' || !changed(name)) continue;
    await mkdir(path.dirname(path.join(home.dir, name)), { recursive: true });
    await cp(path.join(old.dir, name), path.join(home.dir, name));
  }
  if (notCarried.length) await markNotCarried(previous, notCarried).catch(() => undefined);
  return { notCarried };
}

async function readOldThread(store: ThreadStore, id: string, archived: boolean): Promise<ImportedThread | undefined> {
  try {
    if (archived) {
      const bundle = await readArchive(store, id);
      const entries = unionEntries(bundle.entries, await store.archiveDeltaEntries(id));
      const { id: _id, turns: _turns, entries: _entries, bytes: _bytes, tip: _tip, state: _state, ...meta } = bundle.meta;
      return { entries, meta, ...(bundle.context ? { context: bundle.context } : {}), keepContextTip: true };
    }
    const snapshot = await store.liveSnapshot(id);
    if (!snapshot) return undefined;
    const { id: _id, turns: _turns, entries: _entries, bytes: _bytes, tip: _tip, state: _state, ...meta } = snapshot.meta;
    return { entries: snapshot.entries, meta, ...(snapshot.context ? { context: snapshot.context } : {}), keepContextTip: true };
  } catch {
    return undefined;
  }
}
