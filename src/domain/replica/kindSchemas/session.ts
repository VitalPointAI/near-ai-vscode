// Data schema for the session family (Phase 33 P7, D-62): session.certify, a person device's certificate for one short-lived session key. Hub-side:
// pure, no Yjs; it must not import kinds.ts. Whether the certificate holds against the roster (its signer, slot and binding) is sessionKeys.ts's
// question at fold time; the schema only checks the shape, so a certificate naming another member still has a valid shape and is refused there, on
// the record.
//
// The shape is settled once (a one-way door):
//   { member, device, sessionKey, slot, notAfter, sessionSig }
// - member: the person's member id; device: the writer id of the certifying device, which writes the entry itself;
// - sessionKey: the session's raw Ed25519 public key as base64url, whose hash becomes the session's writer id;
// - slot: the certifying device's roster slot (D-41), so the session's Yjs client ids come from it;
// - notAfter: when the hub stops taking the key (the fold reads no clock);
// - sessionSig: the session key's own signature over the binding (sessionBindingBytes), so no device can claim a session key it does not hold.
import { isRecord } from '../../team/validate';
import { isSlot } from '../clientIds';
import { hashCheck, keyProblem, own, slugCheck, timeCheck } from './project';
import type { Check } from './project';
import { invalidAt, isBase64urlBytes } from './shared';

const ED25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

const exactBytes = (bytes: number): Check => (value, path) =>
  (isBase64urlBytes(value, bytes) && Buffer.from(value, 'base64url').length === bytes ? undefined : invalidAt(path));
const slotCheck: Check = (value, path) => (isSlot(value) ? undefined : invalidAt(path));

const CERTIFY_FIELDS: Readonly<Record<string, Check>> = {
  member: slugCheck,
  device: hashCheck,
  sessionKey: exactBytes(ED25519_PUBLIC_BYTES),
  slot: slotCheck,
  notAfter: timeCheck,
  sessionSig: exactBytes(ED25519_SIGNATURE_BYTES)
};

// Returns a reason, or undefined when the data is valid.
export function validateSessionData(kind: string, data: unknown, path: string): string | undefined {
  if (kind !== 'session.certify') return invalidAt(`${path}.kind`);
  if (!isRecord(data)) return invalidAt(path);
  const keys = keyProblem(data, path, Object.keys(CERTIFY_FIELDS));
  if (keys !== undefined) return keys;
  for (const [key, check] of Object.entries(CERTIFY_FIELDS)) {
    const problem = check(own(data, key), `${path}.${key}`);
    if (problem !== undefined) return problem;
  }
  return undefined;
}
