// A device's post-quantum key binding (33.2 D-03, D-12): each device, hosted person and hub publishes a P-256 key and an ML-KEM-768 key, bound to
// its Ed25519 key by its own signature, so a wrapper can find each recipient's cell-wrap/v2 keys in the roster, proven to be that device's. Pure and
// hub-side: no Yjs, no I/O, no clock.
//
// The binding: the device's Ed25519 key signs DEVICE_KEM_BINDING_DOMAIN, the 65-byte P-256 key, the 1,184-byte ML-KEM key and the device's writer id
// as 64 hex characters (1,342 bytes), mirroring the X25519 binding (cellKeys.ts x25519BindingBytes). It travels two ways:
// - device.kem { device, p256, mlkem768, sig } in the roster cell, off the roster line (like session.certify). The roster fold places it after the
//   line when deviceKemProblem finds nothing wrong: the binding verifies under the named device's key, that device is admitted at the roster the
//   entry cites, and the entry was written by the device itself or by a lead device (the hub has no person key, so a lead writes the hub's).
// - the optional kem { p256, mlkem768, sig } of a device descriptor, checked by rosterMembers.ts when the device is added (kemBindingHolds).
// kemKeysAt gives a device's keys: its latest placed device.kem (by cited roster position, then signed time, then hash), else its descriptor's kem.
// The fold, every client and your organization's server use these same functions.
import { verifySignature } from '../team/canonical';
import { kemPublicKeysValid } from './cellWrapV2';
import type { KemPublicKeys } from './cellWrapV2';
import { HASH_PATTERN } from './entry';
import type { RosterState } from './roster';
import { deviceAt } from './rosterMembers';
import { KEM_MLKEM768_BYTES, KEM_P256_BYTES } from './kindSchemas/device';
import type { VerifiedEntry } from './verify';

export const DEVICE_KEM_BINDING_DOMAIN = 'near-ai-vscode/device-kem/v2\n';

export interface KemBinding { p256: string; mlkem768: string; sig: string }
export interface DeviceKemData extends KemBinding { device: string }

// The bytes a device signs to bind its v2 keys: the domain line, the raw P-256 key, the raw ML-KEM key, then the writer id in hex. Throws on a key of
// the wrong size or a writer id that is not 64 lowercase hex.
export function kemBindingBytes(keys: KemPublicKeys, writer: string): Buffer {
  const p256 = Buffer.from(keys.p256, 'base64url');
  const mlkem768 = Buffer.from(keys.mlkem768, 'base64url');
  if (p256.length !== KEM_P256_BYTES || mlkem768.length !== KEM_MLKEM768_BYTES) throw new Error('The post-quantum keys are not the right size.');
  if (!HASH_PATTERN.test(writer)) throw new Error('A writer id is 64 lowercase hex characters.');
  return Buffer.concat([Buffer.from(DEVICE_KEM_BINDING_DOMAIN, 'utf8'), p256, mlkem768, Buffer.from(writer, 'utf8')]);
}

// The binding a device makes for its own keys. sign is the device's Ed25519 signer (its person key in a hosted session, the hub's key for the hub).
export function signKemBinding(keys: KemPublicKeys, writer: string, sign: (bytes: Buffer) => string): KemBinding {
  return { p256: keys.p256, mlkem768: keys.mlkem768, sig: sign(kemBindingBytes(keys, writer)) };
}

// True when both keys are valid and the signature over the binding verifies under the device's Ed25519 public key. Never throws.
export function kemBindingHolds(binding: KemBinding, writer: string, publicKey: string): boolean {
  try {
    return kemPublicKeysValid(binding) && verifySignature(kemBindingBytes(binding, writer), binding.sig, publicKey);
  } catch {
    // A binding that cannot even be read does not hold.
    return false;
  }
}

// Closed list, one plain sentence each.
export const DEVICE_KEM_REFUSALS = {
  'kem-binding-invalid': 'These post-quantum keys are not signed by the computer they name, so they are refused.',
  'kem-device-not-admitted': 'The computer these post-quantum keys name is not part of this shared work at this point, so they are refused.',
  'kem-wrong-writer': 'Only the computer itself or a lead\'s computer can publish its post-quantum keys, so these are refused.'
} as const;
export type DeviceKemRefusal = keyof typeof DEVICE_KEM_REFUSALS;

// What deviceKemProblem needs to know of the roster at the roster an entry cites. deviceAt is undefined for a device not admitted there (revoked,
// removed or never added); isLeadDevice is true for a device of the lead or the deputy there.
export interface DeviceKemContext {
  deviceAt(writer: string, roster: string): { publicKey: string } | undefined;
  isLeadDevice(writer: string, roster: string): boolean;
}
// One device.kem as read: who signed the entry, the roster it cites, and its data (already shape-checked by the device schema).
export interface DeviceKemInput { signer: string; roster: string; data: DeviceKemData }

// Why this device.kem cannot be placed, or undefined. The client fold and your organization's server call this same function.
export function deviceKemProblem(input: DeviceKemInput, ctx: DeviceKemContext): DeviceKemRefusal | undefined {
  const named = ctx.deviceAt(input.data.device, input.roster);
  if (named === undefined) return 'kem-device-not-admitted';
  if (input.signer !== input.data.device && !ctx.isLeadDevice(input.signer, input.roster)) return 'kem-wrong-writer';
  return kemBindingHolds(input.data, input.data.device, named.publicKey) ? undefined : 'kem-binding-invalid';
}

// A device.kem the roster fold placed.
export interface KemRecord { device: string; p256: string; mlkem768: string; hash: string; roster: string; position: number; at: string }

export interface PlacedKems {
  placed: Map<string, KemRecord>;
  refused: Array<{ hash: string; kind: string; reason: DeviceKemRefusal }>;
  held: Array<{ hash: string; reason: string }>;
}

// Places the device.kem entries against the settled roster line. An entry citing a roster off the line waits (held, with the reason the caller gives
// for that roster); the rest are judged in order of cited position, signed time and hash, so every machine and the server keep the same latest keys.
export function placeDeviceKems(entries: readonly VerifiedEntry[], ctx: DeviceKemContext, positionOf: (roster: string) => number | undefined, offLine: (roster: string) => string): PlacedKems {
  const result: PlacedKems = { placed: new Map(), refused: [], held: [] };
  const on = (entry: VerifiedEntry): number => positionOf(entry.body.roster) ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...entries].sort((a, b) => on(a) - on(b) || Date.parse(a.body.at) - Date.parse(b.body.at) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  for (const entry of ordered) {
    const position = positionOf(entry.body.roster);
    if (position === undefined) {
      result.held.push({ hash: entry.hash, reason: offLine(entry.body.roster) });
      continue;
    }
    const data = entry.data as DeviceKemData;
    const problem = deviceKemProblem({ signer: entry.header.writer, roster: entry.body.roster, data }, ctx);
    if (problem !== undefined) {
      result.refused.push({ hash: entry.hash, kind: entry.body.kind, reason: problem });
      continue;
    }
    result.placed.set(data.device, { device: data.device, p256: data.p256, mlkem768: data.mlkem768, hash: entry.hash, roster: entry.body.roster, position, at: entry.body.at });
  }
  return result;
}

// The device's v2 public keys: its latest placed device.kem, else the kem of its descriptor, else undefined (the device has no v2 keys yet).
export function kemKeysAt(state: RosterState, writer: string): KemPublicKeys | undefined {
  const placed = state.kems.get(writer);
  if (placed !== undefined) return { p256: placed.p256, mlkem768: placed.mlkem768 };
  const versions = state.members.devices.get(writer) ?? [];
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const kem = versions[index].kem;
    if (kem !== undefined) return { p256: kem.p256, mlkem768: kem.mlkem768 };
  }
  return undefined;
}

// The context over a roster state: admission and lead authority at the cited roster's position.
export function deviceKemContext(state: RosterState, isLeadDeviceAt: (writer: string, position: number) => boolean): DeviceKemContext {
  return {
    deviceAt(writer, roster) {
      const position = state.positionOf.get(roster);
      return position === undefined ? undefined : deviceAt(state.members, writer, position);
    },
    isLeadDevice(writer, roster) {
      const position = state.positionOf.get(roster);
      return position !== undefined && isLeadDeviceAt(writer, position);
    }
  };
}
