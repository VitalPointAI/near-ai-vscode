// The project's data key on this computer (D-10, SYNC-03). One random 256-bit key per project, found in this order:
//   1. keys/local.key in the project's state home (mode 0600, ignored by git), when nearAi.sync.keepKeyInProject is on;
//   2. this editor's own SecretStorage, under nearAi.state.<stateId>.dataKey.
// A candidate is used only if it opens the key check in meta.json, so a planted or swapped key is never trusted. Whatever the file gave is kept
// in SecretStorage too, so an editor that has opened the project once no longer needs the file. No method logs a key; none is in an error message.
import { KDF_PARAMS, assertKdfParams, deriveKek, newSalt, open, seal, aadFor, newDataKey, subKey, wrapDataKey, type KdfRecord, type SealedBlob } from '../domain/state/keys';
import { createExclusive, ProjectStateHome, stateHomeFor, writeFileAtomic } from './stateHome';
import { readFile, rm, stat } from 'node:fs/promises';
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

export class StateKeys {
  private cached: Buffer | undefined;

  public constructor(
    private readonly home: ProjectStateHome,
    private readonly secrets: SecretsLike,
    private readonly keepKeyInProject: () => boolean = () => true
  ) {}

  /** The key if this editor can open the project's state without asking, otherwise undefined (locked). Creates nothing. */
  public async dataKey(): Promise<Buffer | undefined> {
    if (this.cached) return this.cached;
    const meta = await this.home.readMeta();
    if (!meta) return undefined;
    const found = await this.find(meta.stateId, meta.keyCheck);
    if (found) this.cached = found.key;
    return found?.key;
  }

  /** The key, creating the state home and the key on first use by a person's action. Throws a plain error when the project is locked. */
  public async ensureDataKey(): Promise<Buffer> {
    if (this.cached) return this.cached;
    let meta = await this.home.ensure();
    const found = await this.find(meta.stateId, meta.keyCheck);
    if (found) {
      // A key file from an interrupted first run has no check yet: it is trusted once, and the check is written now.
      if (!meta.keyCheck) meta = await this.home.updateMeta({ keyCheck: this.makeKeyCheck(found.key, meta.stateId) });
      if (found.from === 'file') await this.storeDeviceCopy(found.key, meta.stateId);
      this.cached = found.key;
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
        const winner = decodeKey(await readFile(this.home.paths.localKey, 'utf8').catch(() => undefined));
        if (!winner) throw new Error(LOCKED_MESSAGE);
        key = winner;
      }
    }
    await this.home.updateMeta({ keyCheck: this.makeKeyCheck(key, meta.stateId) });
    await this.storeDeviceCopy(key, meta.stateId);
    this.cached = key;
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
    return Boolean((await stat(this.home.paths.recoveryWrap).catch(() => undefined))?.isFile());
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
    await this.home.ensureFolder(this.home.paths.keysDir);
    await createExclusive(this.home.paths.keysGitignore, IGNORE_ALL);
    await writeFileAtomic(this.home.paths.recoveryWrap, `${JSON.stringify(wrap)}\n`, { mode: 0o600 });
  }

  /** The recovery wrap, or undefined when there is none or the file is not exactly a wrap. */
  public async readRecoveryWrap(): Promise<RecoveryWrap | undefined> {
    try {
      return parseRecoveryWrap(JSON.parse(await readFile(this.home.paths.recoveryWrap, 'utf8')));
    } catch {
      return undefined;
    }
  }

  /**
   * Makes this computer's state home for a project whose id and data key came from the remote (unlocked with the recovery code): the home is created
   * with that id, the key is kept the way a first key would be, and the device copy is stored. Refused when the project already has another id here.
   */
  public async adoptDataKey(key: Buffer, stateId: string): Promise<void> {
    const meta = await this.home.ensure({ stateId });
    if (meta.stateId !== stateId) throw new Error('This project already has its own saved chats on this computer, so the online copy was not opened. Nothing was changed.');
    const existing = await this.find(meta.stateId, meta.keyCheck);
    if (existing && meta.keyCheck) {
      if (!existing.key.equals(key)) throw new Error('This project already has its own saved chats on this computer, so the online copy was not opened. Nothing was changed.');
      this.cached = existing.key;
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
    this.cached = key;
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
    if (!check) return true;
    try {
      return open(subKey(key, 'manifest'), check, aadFor(stateId, KEY_CHECK_PURPOSE)).toString('utf8') === KEY_CHECK_TEXT;
    } catch {
      return false;
    }
  }

  private async find(stateId: string, check: ReturnType<StateKeys['makeKeyCheck']> | undefined): Promise<{ key: Buffer; from: 'file' | 'device' } | undefined> {
    if (this.keepKeyInProject()) {
      const fromFile = decodeKey(await readFile(this.home.paths.localKey, 'utf8').catch(() => undefined));
      if (fromFile && this.opensKeyCheck(fromFile, stateId, check)) return { key: fromFile, from: 'file' };
    }
    const fromDevice = decodeKey(await this.secrets.get(dataKeySecretName(stateId)));
    // With no check yet, a device copy is not trusted: there is nothing to prove it belongs to this state.
    if (fromDevice && check && this.opensKeyCheck(fromDevice, stateId, check)) return { key: fromDevice, from: 'device' };
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
