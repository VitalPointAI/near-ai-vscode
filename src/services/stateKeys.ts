// The project's data key on this computer (D-10, SYNC-03). One random 256-bit key per project, found in this order:
//   1. keys/local.key in the project's state home (mode 0600, ignored by git), when nearAi.sync.keepKeyInProject is on;
//   2. this editor's own SecretStorage, under nearAi.state.<stateId>.dataKey.
// A candidate is used only if it opens the key check in meta.json, so a planted or swapped key is never trusted, and a file candidate is read only
// through readKeyFile: the state folder is not tracked by git, and the file is this user's private regular file (REVIEW B1: nothing inside the project
// folder decides which key is used). Whatever the file gave is kept in SecretStorage too, so an editor that has opened the project once no longer
// needs the file. No method logs a key; none is in an error message.
import { KDF_PARAMS, StateRefusedError, assertKdfParams, deriveKek, newSalt, open, seal, aadFor, newDataKey, subKey, unwrapDataKey, wrapDataKey, type KdfRecord, type SealedBlob } from '../domain/state/keys';
import { createExclusive, privateFileProblem, ProjectStateHome, stateHomeFor, writeFileAtomic } from './stateHome';
import { constants } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';

export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

const KEY_CHECK_TEXT = 'near-ai-key-check';
const KEY_CHECK_PURPOSE = 'key-check';
const IGNORE_ALL = '*\n';
const LOCKED_MESSAGE = "This project's chats are locked on this computer. Enter the recovery code to open them.";

/** What keys/recovery.json holds: the data key wrapped under the recovery code's key. The code itself is never written. */
export interface RecoveryWrap { kdf: KdfRecord; wrappedKey: SealedBlob }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function strictBlob(value: unknown): SealedBlob | undefined {
  const blob = value as Record<string, unknown> | null;
  if (typeof blob !== 'object' || blob === null || Object.keys(blob).length !== 3) return undefined;
  const { iv, tag, data } = blob;
  if (typeof iv !== 'string' || typeof tag !== 'string' || typeof data !== 'string') return undefined;
  return [iv, tag, data].every((text) => BASE64.test(text)) ? { iv, tag, data } : undefined;
}

/** Reads a recovery wrap strictly; anything that is not exactly { kdf, wrappedKey } with sane scrypt cost is undefined. */
export function parseRecoveryWrap(value: unknown): RecoveryWrap | undefined {
  const raw = value as Record<string, unknown> | null;
  if (typeof raw !== 'object' || raw === null || Object.keys(raw).length !== 2) return undefined;
  const kdf = raw.kdf as Record<string, unknown> | null;
  if (typeof kdf !== 'object' || kdf === null || Object.keys(kdf).length !== 5 || typeof kdf.salt !== 'string') return undefined;
  const wrappedKey = strictBlob(raw.wrappedKey);
  if (!wrappedKey) return undefined;
  try {
    const params = assertKdfParams(kdf);
    const salt = Buffer.from(kdf.salt, 'base64');
    if (salt.length < 8 || salt.length > 64 || salt.toString('base64') !== kdf.salt) return undefined;
    return { kdf: { ...params, salt: kdf.salt }, wrappedKey };
  } catch {
    return undefined;
  }
}

export function dataKeySecretName(stateId: string): string {
  return `nearAi.state.${stateId}.dataKey`;
}

function decodeKey(text: string | undefined): Buffer | undefined {
  if (!text) return undefined;
  const bytes = Buffer.from(text.trim(), 'base64');
  return bytes.length === 32 ? bytes : undefined;
}

function isForeignFolder(error: unknown): boolean {
  return error instanceof StateRefusedError && error.reason === 'foreign-folder';
}

export class StateKeys {
  /** The key this editor holds, tied to the state id it belongs to: meta.json naming another id (a join done in another editor) drops it. */
  private cached: { stateId: string; key: Buffer } | undefined;

  public constructor(
    private readonly home: ProjectStateHome,
    private readonly secrets: SecretsLike,
    private readonly keepKeyInProject: () => boolean = () => true
  ) {}

  /** The key if this editor can open the project's state without asking, otherwise undefined (locked). Creates nothing. */
  public async dataKey(): Promise<Buffer | undefined> {
    try {
      await this.refuseForeignFolder();
      const meta = await this.home.readMeta();
      if (!meta) return undefined;
      if (this.cached?.stateId === meta.stateId) return this.cached.key;
      this.cached = undefined;
      const found = await this.find(meta.stateId, meta.keyCheck);
      if (found) this.cached = { stateId: meta.stateId, key: found.key };
      return found?.key;
    } catch (error) {
      // A state folder that came with the project's files is locked, not an error: chats in the chat panel still work.
      if (isForeignFolder(error)) return undefined;
      throw error;
    }
  }

  /** The key, creating the state home and the key on first use by a person's action. Throws a plain error when the project is locked. */
  public async ensureDataKey(): Promise<Buffer> {
    await this.refuseForeignFolder();
    if (this.cached && this.cached.stateId === (await this.home.readMeta())?.stateId) return this.cached.key;
    this.cached = undefined;
    const meta = await this.home.ensure();
    const found = await this.find(meta.stateId, meta.keyCheck);
    if (found) {
      if (found.from === 'file') await this.storeDeviceCopy(found.key, meta.stateId);
      this.cached = { stateId: meta.stateId, key: found.key };
      return found.key;
    }
    if (meta.keyCheck) throw new Error(LOCKED_MESSAGE);
    const fresh = newDataKey();
    let key = fresh;
    if (this.keepKeyInProject()) {
      await this.home.ensureFolder(this.home.paths.keysDir);
      await createExclusive(this.home.paths.keysGitignore, IGNORE_ALL);
      if (await createExclusive(this.home.paths.localKey, `${fresh.toString('base64')}\n`, 0o600) === 'exists') {
        // Another editor created it at the same moment: use its key.
        const winner = decodeKey(await this.readKeyFile(this.home.paths.localKey));
        if (!winner) throw new Error(LOCKED_MESSAGE);
        key = winner;
      }
    }
    await this.home.updateMeta({ keyCheck: this.makeKeyCheck(key, meta.stateId) });
    await this.storeDeviceCopy(key, meta.stateId);
    this.cached = { stateId: meta.stateId, key };
    return key;
  }

  /** The key for the thread and record files at rest. Creates the state home and key on first use. */
  public async transcriptKey(): Promise<Buffer> {
    return subKey(await this.ensureDataKey(), 'transcripts');
  }

  public async storeDeviceCopy(key: Buffer, stateId?: string): Promise<void> {
    const id = stateId ?? (await this.home.readMeta())?.stateId;
    if (!id) throw new Error('This project has no saved state yet.');
    await this.secrets.store(dataKeySecretName(id), key.toString('base64'));
  }

  /** Whether the recovery-code wrap exists (written when sync is turned on). */
  public async hasRecoveryWrap(): Promise<boolean> {
    return (await this.readUsableFile(this.home.paths.recoveryWrap)) !== undefined;
  }

  /**
   * Wraps the data key under a key derived from the recovery code and writes keys/recovery.json (D-02). The data key is created first when this project
   * has none yet. The code is only read, never stored.
   */
  public async writeRecoveryWrap(codeBytes: Buffer): Promise<RecoveryWrap> {
    const key = await this.ensureDataKey();
    const meta = await this.home.ensure();
    const salt = newSalt();
    const kdf: KdfRecord = { name: KDF_PARAMS.name, N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, salt: salt.toString('base64') };
    const wrap: RecoveryWrap = { kdf, wrappedKey: wrapDataKey(await deriveKek(codeBytes, salt, kdf), key, meta.stateId) };
    await this.storeRecoveryWrap(wrap);
    return wrap;
  }

  /** Stores a wrap that came with the remote's manifest, so this computer can seal the same header. */
  public async storeRecoveryWrap(wrap: RecoveryWrap): Promise<void> {
    await this.refuseForeignFolder();
    await this.home.ensureFolder(this.home.paths.keysDir);
    await createExclusive(this.home.paths.keysGitignore, IGNORE_ALL);
    await writeFileAtomic(this.home.paths.recoveryWrap, `${JSON.stringify(wrap)}\n`, { mode: 0o600 });
  }

  /** The recovery wrap, or undefined when there is none or the file is not exactly a wrap. */
  public async readRecoveryWrap(): Promise<RecoveryWrap | undefined> {
    try {
      return parseRecoveryWrap(JSON.parse(await this.readUsableFile(this.home.paths.recoveryWrap) ?? ''));
    } catch {
      return undefined;
    }
  }

  /**
   * Makes this computer's state home for a project whose id and data key came from the remote (unlocked with the recovery code): the home is created
   * with that id, the key is kept the way a first key would be, and the device copy is stored. Refused when the project already has another id here.
   */
  public async adoptDataKey(key: Buffer, stateId: string): Promise<void> {
    await this.refuseForeignFolder();
    const meta = await this.home.ensure({ stateId });
    if (meta.stateId !== stateId) throw new Error('This project already has its own saved chats on this computer, so the online copy was not opened. Nothing was changed.');
    const existing = await this.find(meta.stateId, meta.keyCheck);
    if (existing && meta.keyCheck) {
      if (!existing.key.equals(key)) throw new Error('This project already has its own saved chats on this computer, so the online copy was not opened. Nothing was changed.');
      this.cached = { stateId: meta.stateId, key: existing.key };
      return;
    }
    if (meta.keyCheck && !this.opensKeyCheck(key, meta.stateId, meta.keyCheck)) throw new Error('This project already has its own saved chats on this computer, so the online copy was not opened. Nothing was changed.');
    if (this.keepKeyInProject()) {
      await this.home.ensureFolder(this.home.paths.keysDir);
      await createExclusive(this.home.paths.keysGitignore, IGNORE_ALL);
      await createExclusive(this.home.paths.localKey, `${key.toString('base64')}\n`, 0o600);
    }
    await this.home.updateMeta({ keyCheck: this.makeKeyCheck(key, meta.stateId) });
    await this.storeDeviceCopy(key, meta.stateId);
    this.cached = { stateId: meta.stateId, key };
  }

  /**
   * Opens the project on an editor that holds no key (the key file is off), with the recovery code and the wrap kept in this project's state folder. The
   * key is checked against the project's key check and then kept in this editor's own secret storage. False for a wrong code or anything that does not fit.
   */
  public async unlockWithCode(codeBytes: Buffer): Promise<boolean> {
    const meta = await this.home.readMeta().catch(() => undefined);
    const wrap = await this.readRecoveryWrap();
    if (!meta || !meta.keyCheck || !wrap || codeBytes.length !== 32) return false;
    try {
      const key = unwrapDataKey(await deriveKek(codeBytes, Buffer.from(wrap.kdf.salt, 'base64'), wrap.kdf), wrap.wrappedKey, meta.stateId);
      if (!this.opensKeyCheck(key, meta.stateId, meta.keyCheck)) return false;
      await this.storeDeviceCopy(key, meta.stateId);
      this.cached = { stateId: meta.stateId, key };
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Makes sure this editor's own secret storage holds the key, so the project still opens here once the key file is gone. The key file is read even when
   * the setting that keeps it is already off. False when there is no key to keep (the project is locked here).
   */
  public async keepDeviceCopy(): Promise<boolean> {
    const meta = await this.home.readMeta().catch(() => undefined);
    if (!meta) return false;
    try {
      await this.refuseForeignFolder();
      let key = this.cached?.stateId === meta.stateId ? this.cached.key : undefined;
      key ??= (await this.find(meta.stateId, meta.keyCheck, true))?.key;
      if (!key) return false;
      await this.storeDeviceCopy(key, meta.stateId);
      this.cached = { stateId: meta.stateId, key };
      return true;
    } catch (error) {
      if (isForeignFolder(error)) return false;
      throw error;
    }
  }

  /** Writes keys/local.key again from the unlocked key (mode 0600, ignored by git), when the key file is switched back on. Leaves an existing file alone. */
  public async writeLocalKeyFile(): Promise<void> {
    await this.refuseForeignFolder();
    const key = await this.dataKey();
    if (!key) throw new Error(LOCKED_MESSAGE);
    await this.home.ensureFolder(this.home.paths.keysDir);
    await createExclusive(this.home.paths.keysGitignore, IGNORE_ALL);
    await createExclusive(this.home.paths.localKey, `${key.toString('base64')}\n`, 0o600);
  }

  /** Removes the key file. Refused unless the recovery code can open the project instead, so the chats are never locked out by this. */
  public async removeLocalKeyFile(): Promise<void> {
    if (!await this.hasRecoveryWrap()) throw new Error('The chat key file is kept until a recovery code exists, so your chats stay openable.');
    await rm(this.home.paths.localKey, { force: true });
  }

  private makeKeyCheck(key: Buffer, stateId: string) {
    return seal(subKey(key, 'manifest'), Buffer.from(KEY_CHECK_TEXT, 'utf8'), aadFor(stateId, KEY_CHECK_PURPOSE));
  }

  private opensKeyCheck(key: Buffer, stateId: string, check: ReturnType<StateKeys['makeKeyCheck']> | undefined): boolean {
    if (!check) return false;
    try {
      return open(subKey(key, 'manifest'), check, aadFor(stateId, KEY_CHECK_PURPOSE)).toString('utf8') === KEY_CHECK_TEXT;
    } catch {
      return false;
    }
  }

  /** Refuses with 'foreign-folder' when git tracks the state or locks folder: it came with the project's files, so nothing is read from it or written into it. */
  private async refuseForeignFolder(): Promise<void> {
    if (await this.home.trackedByGit()) throw new StateRefusedError('foreign-folder');
  }

  /**
   * The one way a key file or the recovery wrap is read (REVIEW B1). Throws 'foreign-folder' when the state folder is tracked by git; gives undefined
   * unless the file is this user's private regular file (not a link, owned by this user, no group or other permissions).
   */
  private async readKeyFile(file: string): Promise<string | undefined> {
    await this.refuseForeignFolder();
    if (await privateFileProblem(file) !== undefined) return undefined;
    // O_NOFOLLOW closes the gap between the check above and the read: a link put in place in between is not followed (where the platform has it).
    return readFile(file, { encoding: 'utf8', flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }).catch(() => undefined);
  }

  /** A file's text through readKeyFile, or undefined also for a tracked folder (a caller that only asks whether a usable file exists). */
  private async readUsableFile(file: string): Promise<string | undefined> {
    try {
      return await this.readKeyFile(file);
    } catch (error) {
      if (isForeignFolder(error)) return undefined;
      throw error;
    }
  }

  private async find(stateId: string, check: ReturnType<StateKeys['makeKeyCheck']> | undefined, includeFile: boolean = this.keepKeyInProject()): Promise<{ key: Buffer; from: 'file' | 'device' } | undefined> {
    await this.refuseForeignFolder();
    if (includeFile) {
      // A file key is used only with a key check that opens with it: a file with no check is never trusted, because nothing was sealed under it.
      const fromFile = decodeKey(await this.readKeyFile(this.home.paths.localKey));
      if (fromFile && this.opensKeyCheck(fromFile, stateId, check)) return { key: fromFile, from: 'file' };
    }
    const fromDevice = decodeKey(await this.secrets.get(dataKeySecretName(stateId)));
    // With no check yet, a device copy is not trusted either: there is nothing to prove it belongs to this state.
    if (fromDevice && this.opensKeyCheck(fromDevice, stateId, check)) return { key: fromDevice, from: 'device' };
    return undefined;
  }
}

const instances = new WeakMap<object, Map<string, StateKeys>>();

/** One StateKeys per project folder and secret store, so two stores in one editor never create two keys. */
export function stateKeysFor(root: string, secrets: SecretsLike, keepKeyInProject?: () => boolean): StateKeys {
  const resolved = path.resolve(root);
  let byRoot = instances.get(secrets);
  if (!byRoot) { byRoot = new Map(); instances.set(secrets, byRoot); }
  let keys = byRoot.get(resolved);
  if (!keys) { keys = new StateKeys(stateHomeFor(resolved), secrets, keepKeyInProject); byRoot.set(resolved, keys); }
  return keys;
}
