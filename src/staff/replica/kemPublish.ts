// Publishing this computer's post-quantum keys in a shared project (33.2 D-03, D-05). At each open, once the runtime passes probeWrapV2, the
// device makes its keys if it has none (keyring.ts) and, when the roster does not already hold exactly these keys for it, appends one device.kem
// signed by itself through the project's ordinary append path. A runtime that fails the probe makes and publishes nothing and says nothing here: a
// project that requires wrap@2 tells such a client to update (33 D-06, D-67). Node only; never imports vscode.
import { probeWrapV2 } from '../../domain/replica/cellWrapV2';
import type { KemPublicKeys } from '../../domain/replica/cellWrapV2';
import { kemKeysAt, signKemBinding } from '../../domain/replica/deviceKem';
import type { RosterState } from '../../domain/replica/roster';
import { deviceAt } from '../../domain/replica/rosterMembers';
import type { PayloadSigner } from '../../domain/team/signedPayload';

/** What publishing needs of an open project (ReplicaProject has all of it). */
export interface KemPublishProject {
  readonly deviceWriter: string;
  readonly signer: PayloadSigner;
  state(): Promise<{ roster: RosterState }>;
  /** ok true when appended; any other answer (ReplicaProject's ProjectRefused) is a refusal the next open retries. */
  appendOwn(kind: string, data: unknown): Promise<{ ok: true } | object>;
}

export type KemPublishOutcome = 'published' | 'present' | 'unavailable' | 'not-admitted' | 'refused' | 'failed';

export interface KemPublishOptions {
  /** This install's post-quantum public keys, made on first need (loadOrCreateKemKeys). Called only after the probe passes. */
  loadKeys(): Promise<{ publicKeys: KemPublicKeys }>;
  /** The start-up probe; probeWrapV2 unless a test gives another. */
  probe?: () => boolean;
}

const sameKeys = (a: KemPublicKeys | undefined, b: KemPublicKeys): boolean => a !== undefined && a.p256 === b.p256 && a.mlkem768 === b.mlkem768;

// Appends this device's device.kem when the roster does not hold these keys for it yet. Never throws, so opening a project never fails because of
// it: a refused append or a key store that cannot be read gives an outcome, and the next open tries again. The lead's switch card (33.2-06) lists
// any device whose keys are still missing.
export async function ensureDeviceKem(project: KemPublishProject, options: KemPublishOptions): Promise<KemPublishOutcome> {
  if (!(options.probe ?? probeWrapV2)()) return 'unavailable';
  try {
    return await publish(project, options);
  } catch {
    // Publishing is retried at the next open; the reason is not a sentence for the person opening the project.
    return 'failed';
  }
}

async function publish(project: KemPublishProject, options: KemPublishOptions): Promise<KemPublishOutcome> {
  const { roster } = await project.state();
  const writer = project.deviceWriter;
  if (deviceAt(roster.members, writer, roster.positions.length - 1) === undefined) return 'not-admitted';
  const { publicKeys } = await options.loadKeys();
  if (sameKeys(kemKeysAt(roster, writer), publicKeys)) return 'present';
  const binding = signKemBinding(publicKeys, writer, (bytes) => project.signer.sign(bytes));
  const appended = await project.appendOwn('device.kem', { device: writer, ...binding });
  return 'ok' in appended && appended.ok === true ? 'published' : 'refused';
}
