// The invite file and the join request file (D-14, D-15, D-16, D-17). Hub-side and pure: node:crypto and src/domain only, no clock (the caller
// passes now), no I/O. The host reads and writes the files; this module builds and checks their content.
//
// - Invite (purpose staff-invite), signed by the lead's device: the pinned genesis hash, the project id and name, the lead's member id and keys, the
//   invite id, the one-time join secret (32 random bytes), the expiry and, for Add My Other Machine (D-18), forMember: the existing member whose
//   other machine may answer it. The roster entry member.invite carries only sha256 of the secret.
// - Join request (purpose staff-join-request), signed by the joining device: the invite id, the genesis hash, the person's name, the device's
//   Ed25519 and X25519 public keys, the X25519 binding signature, member (only when answering a forMember invite), and mac = HMAC-SHA256 under the
//   secret over the canonical bytes of { invite, genesisHash, name, publicKey, x25519, member? }. The MAC proves the request came from someone holding
//   the invite file; the safety code is what catches a key swapped in transit, because a stolen invite file lets anyone make a valid MAC.
// - Welcome (no signature of its own, D-49 adds no purpose): the genesis entry, every roster entry and blob, and the signed grants addressed to the
//   new device. Everything in it is already signed; the joining device checks the genesis against the hash it pinned from the invite.
// Files arrive by any channel and are read as hostile input: text is size-capped before it is parsed, fields are read as own properties only, and
// parsed input is never spread into a result. Refusal reasons are a closed record of plain sentences that carry no secret, MAC or key.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { MAX_PAYLOAD_BYTES, signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord } from '../team/validate';
import { HASH_PATTERN, STREAM_ID_PATTERN, writerIdOf } from './entry';
import { X25519_KEY_BYTES, x25519BindingBytes } from './cellKeys';
import { safetyCode } from './safetyCode';

export const INVITE_FILE_EXTENSION = '.near-staff-invite';
export const JOIN_REQUEST_FILE_EXTENSION = '.near-staff-join';
export const WELCOME_FILE_EXTENSION = '.near-staff-welcome';
export const JOIN_SECRET_BYTES = 32;
const ED25519_PUBLIC_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const MAC_BYTES = 32;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_NAME_CHARS = 120;
const INVITE_KEYS = ['genesisHash', 'project', 'name', 'lead', 'invite', 'secret', 'expiresAt'] as const;
const JOIN_KEYS = ['invite', 'genesisHash', 'name', 'publicKey', 'x25519', 'x25519Sig', 'mac'] as const;

export interface InviteLead { member: string; writer: string; publicKey: string; x25519: string }
export interface InvitePayload { genesisHash: string; project: string; name: string; lead: InviteLead; invite: string; secret: string; expiresAt: string; forMember?: string }
export interface JoinRequestPayload { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string; x25519Sig: string; mac: string; member?: string }
export interface JoinMacFields { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string; member?: string }

export const INVITE_REFUSALS = {
  malformed: 'This is not an invitation, join request or welcome file this version can read. Ask the person who sent it for a new file.',
  'too-large': 'This file is larger than an invitation, join request or welcome file can be, so it was not opened. Ask the person who sent it for a new file.',
  'bad-signature': 'The signature on this file does not match its content or its sender, so it was changed or made by someone else. Ask the person who sent it for a new file.',
  'wrong-project': 'This file is for a different staff project. Check that you chose the right file, or ask the lead for a new one.',
  'invite-expired': 'This invitation has expired. Ask the lead for a new invitation.',
  'invite-used': 'This invitation was already used to join the project. Ask the lead for a new invitation.',
  'invite-voided': 'The lead cancelled this invitation. Ask the lead for a new invitation if you still need one.',
  'unknown-invite': 'This join request answers an invitation this project does not have. Ask the person to use the invitation you sent.',
  'wrong-secret': 'This join request was not made with the invitation you sent. Ask the person to make a new join request from your invitation.',
  'bad-binding': 'The device keys in this join request do not belong together, so it cannot be used. Ask the person to make a new join request.',
  'wrong-device': 'This file was made for a different person or device. Ask the lead for an invitation or welcome file made for this one.'
} as const;
export type InviteRefusal = keyof typeof INVITE_REFUSALS;
export type InviteFailure = { ok: false; reason: InviteRefusal; message: string };

const refuse = (reason: InviteRefusal): InviteFailure => ({ ok: false, reason, message: INVITE_REFUSALS[reason] });

// A file as it arrives: JSON text, measured before it is parsed, or a value a caller already parsed, measured by its canonical form. A value that has
// no canonical form (a function, a cycle, a non-plain object) is malformed.
function fileValue(value: unknown, maxBytes: number): { ok: true; value: unknown } | InviteFailure {
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > maxBytes) return refuse('too-large');
      return { ok: true, value: JSON.parse(value) as unknown };
    }
    if (canonicalBytes(value).length > maxBytes) return refuse('too-large');
    return { ok: true, value };
  } catch {
    return refuse('malformed');
  }
}

// An own property of a parsed record, never one inherited from a prototype.
const own = (record: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);

// A fresh one-time join secret as base64url.
export function newJoinSecret(): string {
  return randomBytes(JOIN_SECRET_BYTES).toString('base64url');
}

// The value member.invite.secretHash carries: sha256 hex of the secret's bytes. The secret itself never enters a roster entry.
export function joinSecretHash(secret: string): string {
  return createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex');
}

// HMAC-SHA256 under the secret over the canonical bytes of the five fields, as base64url.
// member is covered only when present, so a request for a new person's invite has the same MAC input as before forMember existed.
export function joinMac(secret: string, fields: JoinMacFields): string {
  const covered: Record<string, string> = { invite: fields.invite, genesisHash: fields.genesisHash, name: fields.name, publicKey: fields.publicKey, x25519: fields.x25519 };
  if (fields.member !== undefined) covered.member = fields.member;
  const message = canonicalBytes(covered);
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(message).digest('base64url');
}

const isLine = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_CHARS && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const isKey = (value: unknown, bytes: number): value is string => typeof value === 'string' && isStrictBase64url(value, bytes);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
// Every required key present and nothing outside required plus optional. Object.keys lists own keys only, so a parsed "__proto__" key is an extra key.
const hasKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const present = Object.keys(value);
  return required.every((key) => present.includes(key)) && present.every((key) => required.includes(key) || optional.includes(key));
};

function invitePayloadOf(value: unknown): InvitePayload | undefined {
  if (!isRecord(value) || !hasKeys(value, INVITE_KEYS, ['forMember'])) return undefined;
  const [genesisHash, project, name, lead, invite, secret, expiresAt] = INVITE_KEYS.map((key) => own(value, key));
  const forMember = own(value, 'forMember');
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (!isLine(name) || typeof invite !== 'string' || !SLUG.test(invite) || !isKey(secret, JOIN_SECRET_BYTES) || !isTime(expiresAt)) return undefined;
  if (forMember !== undefined && (typeof forMember !== 'string' || !SLUG.test(forMember))) return undefined;
  if (!isRecord(lead) || !hasKeys(lead, ['member', 'writer', 'publicKey', 'x25519'])) return undefined;
  const [member, writer, publicKey, x25519] = ['member', 'writer', 'publicKey', 'x25519'].map((key) => own(lead, key));
  if (typeof member !== 'string' || !SLUG.test(member)) return undefined;
  if (!isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES)) return undefined;
  if (typeof writer !== 'string' || writer !== writerIdOf(publicKey)) return undefined;
  const payload: InvitePayload = { genesisHash, project, name, lead: { member, writer, publicKey, x25519 }, invite, secret, expiresAt };
  if (forMember !== undefined) payload.forMember = forMember;
  return payload;
}

function joinPayloadOf(value: unknown): JoinRequestPayload | undefined {
  if (!isRecord(value) || !hasKeys(value, JOIN_KEYS, ['member'])) return undefined;
  const [invite, genesisHash, name, publicKey, x25519, x25519Sig, mac] = JOIN_KEYS.map((key) => own(value, key));
  const member = own(value, 'member');
  if (member !== undefined && (typeof member !== 'string' || !SLUG.test(member))) return undefined;
  if (typeof invite !== 'string' || !SLUG.test(invite)) return undefined;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (!isLine(name) || !isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES)) return undefined;
  if (!isKey(x25519Sig, ED25519_SIGNATURE_BYTES) || !isKey(mac, MAC_BYTES)) return undefined;
  const payload: JoinRequestPayload = { invite, genesisHash, name, publicKey, x25519, x25519Sig, mac };
  if (member !== undefined) payload.member = member;
  return payload;
}

// The envelope's signer must be the key the payload names, so the status lookup answers active for that key only.
const onlyKey = (publicKey: string): KeyStatusLookup => (key) => ({ state: key.publicKey === publicKey ? 'active' : 'unknown' });

export interface BuildInviteInput { genesisHash: string; project: string; name: string; lead: { member: string; x25519: string }; invite: string; secret: string; expiresAt: string; now: Date; forMember?: string }

// Signs an invite with the lead's device. With forMember it is the short invite of Add My Other Machine (D-18): only that member's other machine may
// answer it, and its admission is a device.add. Throws when the content is not a valid invite.
export function buildInvite(signer: PayloadSigner, input: BuildInviteInput): SignedPayload<InvitePayload> {
  const payload: InvitePayload = {
    genesisHash: input.genesisHash,
    project: input.project,
    name: input.name,
    lead: { member: input.lead.member, writer: writerIdOf(signer.publicKey), publicKey: signer.publicKey, x25519: input.lead.x25519 },
    invite: input.invite,
    secret: input.secret,
    expiresAt: input.expiresAt
  };
  if (input.forMember !== undefined) payload.forMember = input.forMember;
  if (invitePayloadOf(payload) === undefined) throw new Error('The invitation was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-invite', payload, { now: () => input.now });
}

export type InviteRead = { ok: true; invite: InvitePayload } | InviteFailure;

// Reads an invite file (its JSON text or its parsed content) at time now. Checks the shape, that the lead's own key signed it, and the expiry. Never throws.
export function readInvite(file: unknown, now: Date): InviteRead {
  try {
    const parsed = fileValue(file, MAX_PAYLOAD_BYTES);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    const payload = isRecord(value) ? invitePayloadOf(own(value, 'payload')) : undefined;
    if (payload === undefined) return refuse('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-invite', status: onlyKey(payload.lead.publicKey) });
    if (!verdict.ok) return refuse(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    if (now.getTime() > Date.parse(payload.expiresAt)) return refuse('invite-expired');
    return { ok: true, invite: payload };
  } catch {
    // Hostile input never throws out of the reader.
    return refuse('malformed');
  }
}

// member: the member this machine belongs to. It defaults to the invite's forMember, so a person's other machine names its member and a new person's
// machine names none.
export interface BuildJoinRequestInput { name: string; x25519: string; now: Date; member?: string }

// Signs a join request with the joining device for the invite it read. The X25519 binding signature is made by the same signer.
export function buildJoinRequest(signer: PayloadSigner, invite: InvitePayload, input: BuildJoinRequestInput): SignedPayload<JoinRequestPayload> {
  const writer = writerIdOf(signer.publicKey);
  const member = input.member ?? invite.forMember;
  const fields: JoinMacFields = { invite: invite.invite, genesisHash: invite.genesisHash, name: input.name, publicKey: signer.publicKey, x25519: input.x25519 };
  if (member !== undefined) fields.member = member;
  const payload: JoinRequestPayload = { invite: fields.invite, genesisHash: fields.genesisHash, name: fields.name, publicKey: fields.publicKey, x25519: fields.x25519, x25519Sig: signer.sign(x25519BindingBytes(input.x25519, writer)), mac: joinMac(invite.secret, fields) };
  if (member !== undefined) payload.member = member;
  if (joinPayloadOf(payload) === undefined) throw new Error('The join request was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-join-request', payload, { now: () => input.now });
}

export type JoinRequestCheck = { ok: true; request: JoinRequestPayload; writer: string } | InviteFailure;

// The lead's state of an invitation as its roster shows it (the roster fold remains the authority at admission; this lets the command refuse before
// it writes anything).
export interface RosterInviteState { state: 'open' | 'used' | 'voided' }
export interface JoinRequestExpectation { invite: InvitePayload; secret: string; now?: Date; rosterInvite?: RosterInviteState }

// The lead's check of a join request file (its JSON text or its parsed content) against the invite it answers and the secret the lead kept. The
// checks run in this order and the first failure is the answer: shape and size, signature, project, invitation id, invitation state (voided, used,
// then expired when now is given), key binding, MAC, member. Reading or checking writes nothing. Never throws.
export function checkJoinRequest(file: unknown, expected: JoinRequestExpectation): JoinRequestCheck {
  try {
    const parsed = fileValue(file, MAX_PAYLOAD_BYTES);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    const payload = isRecord(value) ? joinPayloadOf(own(value, 'payload')) : undefined;
    if (payload === undefined) return refuse('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-join-request', status: onlyKey(payload.publicKey) });
    if (!verdict.ok) return refuse(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    if (payload.genesisHash !== expected.invite.genesisHash) return refuse('wrong-project');
    if (payload.invite !== expected.invite.invite) return refuse('unknown-invite');
    if (expected.rosterInvite?.state === 'voided') return refuse('invite-voided');
    if (expected.rosterInvite?.state === 'used') return refuse('invite-used');
    if (expected.now !== undefined && expected.now.getTime() > Date.parse(expected.invite.expiresAt)) return refuse('invite-expired');
    const writer = writerIdOf(payload.publicKey);
    if (!verifySignature(x25519BindingBytes(payload.x25519, writer), payload.x25519Sig, payload.publicKey)) return refuse('bad-binding');
    const want = Buffer.from(joinMac(expected.secret, payload), 'base64url');
    const got = Buffer.from(payload.mac, 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse('wrong-secret');
    // A member's invite is answered only by that member's machine, and a new person's invite by a machine that names no member.
    if (payload.member !== expected.invite.forMember) return refuse('wrong-device');
    return { ok: true, request: payload, writer };
  } catch {
    // Hostile input never throws out of the check.
    return refuse('malformed');
  }
}


export interface SafetyCodeKeys { publicKey: string; x25519: string }

// The six safety code words for an invite and the joining device's keys (D-16). The lead passes the checked request (it carries the joiner's keys); the
// joining device passes its own keys. Both read the lead's keys, the invite id and the genesis hash from the invite, so the two screens agree exactly
// when no key was swapped in transit. The join secret is not an input.
export function inviteSafetyCode(invite: InvitePayload, joiner: SafetyCodeKeys): string[] {
  return safetyCode({
    invite: invite.invite,
    genesisHash: invite.genesisHash,
    lead: { publicKey: invite.lead.publicKey, x25519: invite.lead.x25519 },
    joiner: { publicKey: joiner.publicKey, x25519: joiner.x25519 }
  });
}
