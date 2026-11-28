// The device a shared project opens as (split from replicaProject.ts to keep it under the file-size limit): what the host gives a project, this
// device's keys (a single computer's own keys, or a hosted session's session key with the person key the roster names, Phase 33 D-60, D-61), the
// post-quantum keys where this computer knows wrap@2 (33.2 D-03, D-05), and the store's deps. Node I/O only; never imports vscode.
import { identityDir as identityDirOf, loadOrCreateDeviceIdentity } from '../../team/identity';
import type { DeviceIdentity } from '../../team/identity';
import { localKeyStatus } from '../../team/keyHistory';
import type { KeyStatusLookup } from '../../domain/team/keyStatus';
import type { AsyncPayloadSigner, PayloadSigner } from '../../domain/team/signedPayload';
import type { KemPrivateKeys, KemPublicKeys } from '../../domain/replica/cellWrapV2';
import { writerIdOf } from '../../domain/replica/entry';
import type { RosterState } from '../../domain/replica/roster';
import type { ReplicaContext } from '../../domain/replica/rosterView';
import { WRAP_V2_FEATURE } from '../../domain/replica/features';
import type { DecodeHost } from './decodeHost';
import { loadOrCreateEncryptionKey, loadOrCreateKemKeys } from './keyring';
import type { DeviceEncryptionKey, DeviceKeyRing, KeyRingDevice } from './keyring';
import type { ReplicaStoreDeps } from './store';
import { clientReplicaFeatures } from './clientFeatures';

/** What the host gives a project: secret storage, the extension's global storage folder, and optional seams for tests and later plans. */
export interface ReplicaProjectDeps {
  secrets: ReplicaStoreDeps['secrets'];
  globalStorageDir: string;
  /** The identity folder (identity-create.lock and the key history); identityDir(globalStorageDir) when absent. */
  identityDir?: string;
  now?: () => Date;
  /** The key status that verifies this device's store marks; this device's key history when absent. */
  keyStatus?: () => Promise<KeyStatusLookup>;
  /** The cell order the fold checks writes against (D-25), built by the host from Phase 70 dominance; absent means every citation is allowed. */
  cellOrder?: (roster: RosterState, keys: DeviceKeyRing) => ReplicaContext['cellOrder'];
  /** The memory-capped decode worker entries from outside pass (D-05); the project makes its own on first need when absent, and close() ends it. */
  decodeHost?: DecodeHost;
  /** The features this build folds; clientReplicaFeatures() when absent. Tests set it to stand in for a newer version (POST-01) or a runtime
   *  without wrap@2 (33.2 D-05). */
  knownFeatures?: readonly string[];
  /** A hosted session (Phase 33 D-60): the session key signs this device's ordinary writes, and the person key, through your organization's key store,
   *  signs the person-key kinds. Absent on a single machine, where this device's key signs everything as before. */
  sessionSigner?: PayloadSigner;
  personSigner?: AsyncPayloadSigner;
  /** Publish this computer's post-quantum keys at open (33.2 D-05). Off unless set: the host sets it where a project opens for live work, not for a
   *  command's short open, whose flows promise to write nothing. A hosted session publishes through its own step-up instead. */
  publishKem?: boolean;
  /** Require wrap@2 beside require@1 when this computer makes a project shared and knows wrap@2 (33.2 D-05). On unless set false. */
  wrapV2AtCreation?: boolean;
  /** A hosted session (Phase 33 D-61): the person key is this device (its writer), the opened X25519 key decrypts grants, and the session key signs the
   *  store's marks and owns its files. No device key is made or read; needs sessionSigner, personSigner and keyStatus. */
  hosted?: { personPublicKey: string; encryption: DeviceEncryptionKey; kem?: { publicKeys: KemPublicKeys; privateKeys: KemPrivateKeys } };
}

/** This device as a shared project sees it. The signer signs; no private key leaves SecretStorage and memory. */
export interface LocalDevice {
  signer: DeviceIdentity;
  /** What signs as the device the roster names (genesis, grants, invitations, join requests): the person key in a hosted session (33-27). */
  rosterSigner: PayloadSigner | AsyncPayloadSigner;
  writer: string;
  publicKey: string;
  /** The raw X25519 public key as base64url, and the device's signature binding it to the writer (D-19). */
  x25519: string;
  x25519Sig: string;
  /** This computer's post-quantum public keys where it knows wrap@2 (33.2 D-03): a join request carries them when the invitation asks. */
  kem?: KemPublicKeys;
}

export interface DeviceKeys { identity: DeviceIdentity; roster: PayloadSigner | AsyncPayloadSigner; writer: string; encryption: DeviceEncryptionKey; kem?: KemPublicKeys; kemPrivate?: KemPrivateKeys }

/** This computer knows wrap@2 (its features say so: the probe passed, or a test says it does). */
const knowsWrapV2 = (deps: ReplicaProjectDeps): boolean => (deps.knownFeatures ?? clientReplicaFeatures()).includes(WRAP_V2_FEATURE);

export async function deviceKeys(deps: ReplicaProjectDeps): Promise<DeviceKeys> {
  const person = deps.personSigner;
  if (deps.hosted !== undefined && deps.sessionSigner !== undefined && person?.publicKey === deps.hosted.personPublicKey) {
    // The person's post-quantum keys from the session's envelope (33.2-04), so a hosted session opens cell-wrap/v2 grants too.
    const { kem } = deps.hosted;
    return { identity: deps.sessionSigner, roster: person, writer: writerIdOf(deps.hosted.personPublicKey), encryption: deps.hosted.encryption, ...(kem === undefined ? {} : { kem: kem.publicKeys, kemPrivate: kem.privateKeys }) };
  }
  if (deps.hosted !== undefined) throw new Error('A hosted session opens a shared project only with its session key and the person key it names.');
  const dir = deps.identityDir ?? identityDirOf(deps.globalStorageDir);
  const { identity } = await loadOrCreateDeviceIdentity(deps.secrets, { identityDir: dir, ...(deps.now === undefined ? {} : { now: deps.now }) });
  const encryption = await loadOrCreateEncryptionKey(deps.secrets, { identityDir: dir, identity });
  const keys: DeviceKeys = { identity, roster: identity, writer: writerIdOf(identity.publicKey), encryption };
  // The post-quantum keys, wherever this computer knows wrap@2: published at creation and joining, and opening v2 wraps (33.2 D-03).
  // Keys that cannot be read are left as they are (never replaced): the project opens, reads what is wrapped the older way, and is not made switched.
  const kem = knowsWrapV2(deps) ? await loadOrCreateKemKeys(deps.secrets, { identityDir: dir }).catch(() => undefined) : undefined;
  return kem === undefined ? keys : { ...keys, kem: kem.publicKeys, kemPrivate: kem.privateKeys };
}

/** The device a key ring opens grants for: its X25519 key and, where it has them, its post-quantum keys. */
export const ringDevice = (device: DeviceKeys): KeyRingDevice => ({ writer: device.writer, privateKey: device.encryption.privateKey, ...(device.kemPrivate === undefined ? {} : { kem: device.kemPrivate }) });

/** Whether a project made shared now requires wrap@2 from the start (33.2 D-05): unless the host turns it off, wherever this computer knows wrap@2. */
export const wrapV2AtCreation = (deps: ReplicaProjectDeps): boolean => deps.wrapV2AtCreation !== false && knowsWrapV2(deps);

export function storeDeps(deps: ReplicaProjectDeps, identity: DeviceIdentity): ReplicaStoreDeps {
  const dir = deps.identityDir ?? identityDirOf(deps.globalStorageDir);
  return {
    secrets: deps.secrets,
    signer: () => Promise.resolve(identity),
    keyStatus: deps.keyStatus ?? (() => localKeyStatus(dir, deps.secrets)),
    ...(deps.now === undefined ? {} : { now: deps.now })
  };
}
