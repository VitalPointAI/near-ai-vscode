// Session keys (Phase 33 P7; D-60, D-62): a person's short-lived session key, certified by one of that person's own devices, writes the person's
// ordinary work into a shared project; decisions and roster changes stay with the person key. Pure and hub-side: no Yjs, no I/O, and no clock. The
// certificate's notAfter is for your organization's server to compare with its own clock when it takes appends and sessions; the fold never reads it.
//
// One set of rules, used by every client fold and by the server:
// - A certificate (session.certify, in the roster cell, off the roster line) is placed by the roster fold (roster.ts) when certificateProblem finds
//   nothing wrong. The first certificate placed for a session key wins; any other for the same key is refused session-key-reused.
// - An entry whose writer is not a roster device is checked with the key of the certificate placed for it (verify.ts). It counts only when its signer
//   device is admitted, not removed and not quarantined at the roster the entry cites, and its kind is not a person-key kind (sessionRefusal). The
//   entry belongs to the certificate's member, and its Yjs client ids come from the certificate's slot.
// - Revoking or quarantining the certifying device stops every session key it certified from that roster position on; entries citing an earlier
//   roster keep folding, so the history stays valid.
import { canonicalBytes, verifySignature } from '../team/canonical';
import { clientIdOf } from './clientIds';
import { writerIdOf } from './entry';
import { REPLICA_KINDS, kindFamily } from './kinds';
import type { RosterView } from './rosterView';
import type { VerifiedEntry } from './verify';

// The kinds only the person key may sign (D-60): every roster kind and the project genesis, the decision kinds, session.certify itself and a device's
// key binding (device.kem, 33.2 D-03). One list,
// checked by every client and by your organization's server.
export const PERSON_KEY_KINDS: readonly string[] = Object.freeze([
  'project.genesis',
  ...REPLICA_KINDS.filter((kind) => kindFamily(kind) === 'roster' || kindFamily(kind) === 'session' || kindFamily(kind) === 'device'),
  'version.decide', 'version.release', 'version.supersede', 'version.withdraw'
]);
const PERSON_KEY_KIND_SET: ReadonlySet<string> = new Set(PERSON_KEY_KINDS);

export function isPersonKeyKind(kind: string): boolean {
  return PERSON_KEY_KIND_SET.has(kind);
}

// The person-key kinds exactly as Phase 33 built them (33-21), frozen by name so the list above can grow without growing this one (33.1 D-09).
// These keep signing without an action id; every person-key kind outside it is action-bound by default, so a later kind cannot be left out.
export const PHASE_33_PERSON_KEY_KINDS: readonly string[] = Object.freeze([
  'project.genesis',
  'member.invite', 'member.admit', 'member.update', 'member.remove', 'device.add', 'device.rotate', 'device.revoke', 'device.quarantine', 'device.release',
  'hub.admit', 'hub.grant', 'hub.revoke', 'cell.create', 'cell.rekey', 'lead.handover', 'roster.choose', 'deputy.name', 'invite.void', 'roster.require',
  'hub.readmit',
  'session.certify',
  'version.decide', 'version.release', 'version.supersede', 'version.withdraw'
]);
const PHASE_33_PERSON_KEY_KIND_SET: ReadonlySet<string> = new Set(PHASE_33_PERSON_KEY_KINDS);

/** True for a person-key kind that a hosted project signs only under the one action the person confirmed (33.1 D-09). */
export function requiresActionId(kind: string): boolean {
  return isPersonKeyKind(kind) && !PHASE_33_PERSON_KEY_KIND_SET.has(kind);
}

// Closed list, one plain sentence each. No em-dashes.
export const SESSION_REFUSALS = {
  'person-key-required': 'Only the person\'s own key can make this change.',
  'session-device-stopped': 'The device that vouched for this session key was removed or set aside at this point, so this change is kept and does nothing.',
  'session-key-reused': 'This session key was already vouched for, so this second certificate is refused.',
  'session-certificate-invalid': 'This session key certificate does not match the device and person that signed it, so it is refused.'
} as const;
export type SessionRefusal = keyof typeof SESSION_REFUSALS;

// The longest a certificate may last, from its signed time to its notAfter. The workbench asks for 12 hours (D-62); the limit bounds what a stolen
// session key can do at your organization's server whatever the certificate says.
export const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const SESSION_DEFAULT_LIFETIME_MS = 12 * 60 * 60 * 1000;

export interface SessionCertifyData { member: string; device: string; sessionKey: string; slot: number; notAfter: string; sessionSig: string }

// A certificate the roster fold placed. writer is the session key's writer id; roster is the roster hash the certificate cites.
export interface SessionCertificate {
  hash: string;
  writer: string;
  member: string;
  device: string;
  sessionKey: string;
  slot: number;
  notAfter: string;
  roster: string;
}

export interface CertifiedWriter { member: string; device: string; slot: number }

// The binding the session key signs (sessionSig): the domain line, then the canonical certificate fields with the project, so a session key's
// proof is good for one person, device, slot, time and project only.
export const SESSION_BINDING_DOMAIN = 'near-ai/session-certify/v1';
export interface SessionBindingFields { project: string; member: string; device: string; sessionKey: string; slot: number; notAfter: string }

export function sessionBindingBytes(fields: SessionBindingFields): Buffer {
  const { project, member, device, sessionKey, slot, notAfter } = fields;
  return Buffer.concat([Buffer.from(`${SESSION_BINDING_DOMAIN}\n`, 'utf8'), canonicalBytes({ project, member, device, sessionKey, slot, notAfter })]);
}

// The data of a session.certify for the session key's holder to write through the certifying device. sign is the session key's own signer.
export function sessionCertifyData(fields: SessionBindingFields, sign: (bytes: Buffer) => string): SessionCertifyData {
  const { member, device, sessionKey, slot, notAfter } = fields;
  return { member, device, sessionKey, slot, notAfter, sessionSig: sign(sessionBindingBytes(fields)) };
}

// True when the device has a quarantine at the position that no release at or before it lifted.
function quarantinedAt(view: RosterView, device: string, position: number): boolean {
  return (view.deviceQuarantines?.(device) ?? []).some((spell) => spell.from <= position && !spell.released.some((at) => at >= spell.from && at <= position));
}

// True when a quarantine of the device applied after the certificate's roster and at or before the position: it stops the certificate for good.
function stoppedSince(view: RosterView, device: string, certified: number, position: number): boolean {
  return (view.deviceQuarantines?.(device) ?? []).some((spell) => spell.from > certified && spell.from <= position);
}

// Why this verified session.certify cannot be placed, or undefined. placed holds the certificates already placed, by session writer id. The signed
// lifetime is checked by the roster fold, which reads the entry's signed time.
export function certificateProblem(view: RosterView, entry: VerifiedEntry, project: string, placed: ReadonlyMap<string, SessionCertificate>): SessionRefusal | undefined {
  const data = entry.data as SessionCertifyData;
  const signer = entry.header.writer;
  const roster = entry.body.roster;
  if (entry.header.stream !== project || entry.body.actor.kind !== 'person' || data.device !== signer) return 'session-certificate-invalid';
  if (view.deviceKey(signer)?.member !== data.member || view.memberName(data.member, roster) === undefined) return 'session-certificate-invalid';
  // The slot must be the certifying device's own, so the session's client ids never belong to another device (D-41).
  if (view.clientIdOwner?.(clientIdOf(data.slot, 0), roster) !== signer) return 'session-certificate-invalid';
  const writer = writerIdOf(data.sessionKey);
  if (view.deviceKey(writer) !== undefined) return 'session-certificate-invalid';
  if (!verifySignature(sessionBindingBytes({ project, ...data }), data.sessionSig, data.sessionKey)) return 'session-certificate-invalid';
  const position = view.rosterPosition(roster);
  if (position === undefined || !view.isAdmitted(signer, roster) || quarantinedAt(view, signer, position)) return 'session-device-stopped';
  return placed.has(writer) ? 'session-key-reused' : undefined;
}

// The certificate's person, device and slot when the session writer may write at the roster it cites, or undefined (no certificate placed for it, or
// its device is not admitted, removed or quarantined there).
export function certifiedWriter(view: RosterView, writer: string, rosterHash: string): CertifiedWriter | undefined {
  const certificate = view.sessionCertificate?.(writer);
  if (certificate === undefined) return undefined;
  const position = view.rosterPosition(rosterHash);
  const certified = view.rosterPosition(certificate.roster);
  if (position === undefined || certified === undefined) return undefined;
  if (!view.isAdmitted(certificate.device, rosterHash) || view.memberName(certificate.member, rosterHash) === undefined) return undefined;
  if (quarantinedAt(view, certificate.device, position) || stoppedSince(view, certificate.device, certified, position)) return undefined;
  return { member: certificate.member, device: certificate.device, slot: certificate.slot };
}

// Why an entry by a certified session writer changes nothing, or undefined when it may: a person-key kind first, then a stopped device.
export function sessionRefusal(view: RosterView, writer: string, rosterHash: string, kind: string): SessionRefusal | undefined {
  if (isPersonKeyKind(kind)) return 'person-key-required';
  return certifiedWriter(view, writer, rosterHash) === undefined ? 'session-device-stopped' : undefined;
}
