// A hosted person's install for the engine tests (Phase 33 D-60, D-61; 33-27): the person key stands for the Transit key person-<entity> (an async
// signer that counts its calls and can be told to refuse, as KeyService.sign refuses without a fresh step-up), a session key signs ordinary work and
// the store's marks, and the X25519 key is bound by the person key. No device key is made or read. Fictional exercise data only.
import { generateKeyPairSync } from 'node:crypto';
import { x25519BindingBytes, x25519PublicRaw } from '../../domain/replica/cellKeys';
import { writerIdOf } from '../../domain/replica/entry';
import type { AsyncPayloadSigner, PayloadSigner, SignRefused } from '../../domain/team/signedPayload';
import type { DeviceEncryptionKey } from '../../staff/replica/keyring';
import { install } from './labelCellWorld';
import type { Install } from './labelCellWorld';
import { fixedSigner } from './replicaWorld';

/** The step-up refusal KeyService gives (workbench common/key-service.ts KEY_SERVICE_TEXT.stepUpNeeded). */
export const STEP_UP_TEXT = 'Signing needs a fresh confirmation with your passkey or security key.';

export interface PersonKey extends AsyncPayloadSigner {
  /** How many signatures the person key gave. */
  signed: number;
  /** While true, every signature is refused with STEP_UP_TEXT (no fresh confirmation). */
  stale: boolean;
}

export interface HostedInstall extends Install {
  person: PersonKey;
  session: PayloadSigner;
  /** Every public key that signed through the session key, for checks that it never signed a person thing. */
  sessionSigned: number;
}

/** The person key of a label: a fixed Ed25519 key behind an asynchronous signer. */
export function personKey(label: string): PersonKey {
  const fixed = fixedSigner(`person/${label}`);
  const key: PersonKey = {
    fingerprint: fixed.signer.fingerprint,
    publicKey: fixed.publicKey,
    signed: 0,
    stale: false,
    sign: async (bytes: Buffer): Promise<string | SignRefused> => {
      if (key.stale) return { refused: STEP_UP_TEXT };
      key.signed += 1;
      return fixed.signer.sign(bytes);
    }
  };
  return key;
}

/** A hosted install: the person key is the device, the session key signs ordinary work, the X25519 key is bound by the person key. */
export async function hostedInstall(label: string): Promise<HostedInstall> {
  const at = install(label);
  const person = personKey(label);
  const fixed = fixedSigner(`session/${label}`);
  const counted: HostedInstall = { ...at, person, session: fixed.signer, sessionSigned: 0 };
  const session: PayloadSigner = { fingerprint: fixed.signer.fingerprint, publicKey: fixed.publicKey, sign: (bytes) => { counted.sessionSigned += 1; return fixed.signer.sign(bytes); } };
  counted.session = session;
  const { privateKey } = generateKeyPairSync('x25519');
  const x25519 = x25519PublicRaw(privateKey).toString('base64url');
  const binding = await person.sign(x25519BindingBytes(x25519, writerIdOf(person.publicKey)));
  if (typeof binding !== 'string') throw new Error('the person key did not bind the X25519 key');
  const encryption: DeviceEncryptionKey = { publicKey: x25519, privateKey, binding };
  counted.deps = {
    ...at.deps, sessionSigner: session, personSigner: person, keyStatus: () => Promise.resolve(() => ({ state: 'active' as const })),
    hosted: { personPublicKey: person.publicKey, encryption }
  };
  return counted;
}
