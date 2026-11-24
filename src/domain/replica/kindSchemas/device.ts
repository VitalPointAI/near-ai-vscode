// Data schema for the device family (33.2 D-03, D-12): device.kem, a device's post-quantum key binding, and the kem shape a device descriptor may
// carry. Hub-side: pure, no Yjs; it must not import kinds.ts or cellWrapV2.ts (cellKeys.ts imports the roster schema, so that would be a cycle).
// Whether the binding holds against the roster (the device's own signature, its admission, who wrote the entry) is deviceKem.ts's question at fold
// time; the schema only checks the shape.
//
// The shapes are settled once (owner, 2026-11-24, a one-way door):
//   device.kem { device, p256, mlkem768, sig }      descriptor kem { p256, mlkem768, sig }
// - device: the writer id of the device the keys belong to (the device itself, or the hub when a lead device writes the hub's binding);
// - p256: the uncompressed P-256 public key (65 bytes, first byte 04) and mlkem768: the ML-KEM-768 encapsulation key (1,184 bytes), as base64url;
// - sig: the device's Ed25519 signature over the binding bytes (deviceKem.ts kemBindingBytes).
import { isRecord } from '../../team/validate';
import { invalidAt, isBase64urlBytes, isHash } from './shared';

export const KEM_P256_BYTES = 65;
export const KEM_MLKEM768_BYTES = 1184;
const ED25519_SIGNATURE_BYTES = 64;

// project.ts imports this file for the descriptor, so the two small helpers are repeated here instead of imported back from it.
const own = (record: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
function keyProblem(data: Record<string, unknown>, path: string, required: readonly string[]): string | undefined {
  const present = Object.keys(data);
  for (const key of required) if (!present.includes(key)) return invalidAt(`${path}.${key}`, 'missing field');
  for (const key of present) if (!required.includes(key)) return invalidAt(`${path}.${key.slice(0, 40)}`, 'field not allowed');
  return undefined;
}

function exactBytes(value: unknown, bytes: number): value is string {
  return isBase64urlBytes(value, bytes) && Buffer.from(value, 'base64url').length === bytes;
}

// The kem { p256, mlkem768, sig } shape, alone or inside a device.kem (with device). Returns a reason or undefined.
function kemFieldsProblem(value: Record<string, unknown>, path: string): string | undefined {
  if (!exactBytes(own(value, 'p256'), KEM_P256_BYTES) || Buffer.from(own(value, 'p256') as string, 'base64url')[0] !== 0x04) return invalidAt(`${path}.p256`);
  if (!exactBytes(own(value, 'mlkem768'), KEM_MLKEM768_BYTES)) return invalidAt(`${path}.mlkem768`);
  if (!exactBytes(own(value, 'sig'), ED25519_SIGNATURE_BYTES)) return invalidAt(`${path}.sig`);
  return undefined;
}

// The optional kem of a device descriptor (the genesis lead, member.admit, device.add, hub.admit and the join request).
export function kemProblem(value: unknown, path: string): string | undefined {
  if (!isRecord(value)) return invalidAt(path);
  return keyProblem(value, path, ['p256', 'mlkem768', 'sig']) ?? kemFieldsProblem(value, path);
}

// Returns a reason, or undefined when the data is valid.
export function validateDeviceData(kind: string, data: unknown, path: string): string | undefined {
  if (kind !== 'device.kem') return invalidAt(`${path}.kind`);
  if (!isRecord(data)) return invalidAt(path);
  const keys = keyProblem(data, path, ['device', 'p256', 'mlkem768', 'sig']);
  if (keys !== undefined) return keys;
  if (!isHash(own(data, 'device'))) return invalidAt(`${path}.device`);
  return kemFieldsProblem(data, path);
}
