// The invite file and the join request file (D-14, D-15, D-16, D-17). Hub-side and pure: node:crypto and src/domain only, no clock (the caller
// passes now), no I/O. The host reads and writes the files; this module builds and checks their content.
//
// - Invite (purpose staff-invite), signed by the inviting device: the pinned genesis hash, the project id and name, lead (the project's anchor: the
//   founding lead's member id and keys, which the joining device pins), inviter (the member id and keys of the device that signs the invitation, any
//   device of the lead or the deputy, MJ-05), the invite id, the one-time join secret (32 random bytes), the expiry and, for Add My Other Machine
//   (D-18), forMember: the existing member whose other machine may answer it. The roster entry member.invite carries only sha256 of the secret. An
//   invitation made before inviter existed has none and was signed by the founding lead's device; it is read with the inviter equal to the lead.
//   For a project on your organization's sync hub (D-47) it also names hub: the hub's address, certificate pin and writer id. An invitation without
//   hub works by file exactly as in Phase 31.
// - Join request (purpose staff-join-request), signed by the joining device: the invite id, the genesis hash, the person's name, the device's
//   Ed25519 and X25519 public keys, the X25519 binding signature, a fresh random nonce (an input of the safety code, see safetyCode.ts), member (only
//   when answering a forMember invite), and mac = HMAC-SHA256 under the secret over the canonical bytes of { invite, genesisHash, name, publicKey,
//   x25519, nonce, member? }. The MAC proves the request came from someone holding the invite file; the safety code is what catches a key swapped in
//   transit, because a stolen invite file lets anyone make a valid MAC. A request made before the nonce existed is refused malformed.
// - Welcome (no signature of its own, D-49 adds no purpose): the genesis entry, every roster entry and blob, and the signed grants addressed to the
//   new device. Everything in it is already signed; the joining device checks the genesis against the hash it pinned from the invite.
// - Hub join (D-48, purpose staff-hub-join), signed by the joining device: the hub's writer id, the project, the invite id, the sha256 hex of the
//   canonical signed join request and hubMac = HMAC-SHA256 under the hub check key over { hub, project, invite, request }. The check key is
//   HKDF-SHA256(secret, info HUB_JOIN_INFO followed by the invite id): the lead's device registers it with the hub and the joining device derives it
//   from the invitation, so the hub checks a join request without ever holding the join secret or its roster hash. The joining device still sends the
//   Phase 31 MAC, which only the lead's device checks, with the real secret, before Admit.
// Files arrive by any channel and are read as hostile input: text is size-capped before it is parsed, fields are read as own properties only, and
// parsed input is never spread into a result. Refusal reasons are a closed record of plain sentences that carry no secret, MAC or key.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { MAX_PAYLOAD_BYTES, PayloadError, signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { findSecrets } from '../team/secrets';
import { isRecord } from '../team/validate';
import { BLOB_MAX_BYTES, HASH_PATTERN, STREAM_ID_PATTERN, blobBytesHash, entryHash, parseHeaderShape, writerIdOf } from './entry';
import type { EntryHeader, SealedBlob, SealedEntry } from './entry';
import { X25519_KEY_BYTES, readGrant, x25519BindingBytes } from './cellKeys';
import type { KemPublicKeys } from './cellWrapV2';
import { kemBindingHolds, signKemBinding } from './deviceKem';
import type { KemBinding } from './deviceKem';
import { MAX_FEATURES, isReplicaFeature } from './features';
import { kemProblem } from './kindSchemas/device';
import type { RosterAnchor } from './roster';
import { safetyCode } from './safetyCode';
import { isHubAddress } from './hubFile';

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
const JOIN_KEYS = ['invite', 'genesisHash', 'name', 'publicKey', 'x25519', 'x25519Sig', 'nonce', 'mac'] as const;
/** The feature that lets a join request carry post-quantum keys (33.2 D-03): only an invitation that lists it among the project's required features. */
export const KEM_JOIN_FEATURE = 'wrap@2';
/** The bytes of the joining device's nonce (an input of the safety code). */
export const JOIN_NONCE_BYTES = 16;

export interface InviteLead { member: string; writer: string; publicKey: string; x25519: string }
/** The sync hub a project lives on (D-47): its public address, the sha256 hex pin of its certificate's public key and its writer id. */
export interface InviteHub { address: string; certPin: string; writer: string }
/**
 * lead is the project's anchor (the founding lead); inviter is the device that signed the invitation (equal to lead for an invitation without one);
 * hub is present only for a project on a sync hub.
 */
/** requires: the project's required features when the invitation was made (roster.require), sorted; absent when there are none (33.2 D-03). */
export interface InvitePayload { genesisHash: string; project: string; name: string; lead: InviteLead; inviter: InviteLead; invite: string; secret: string; expiresAt: string; forMember?: string; hub?: InviteHub; requires?: string[] }
/** kem: the joining device's post-quantum keys with their binding, only when the invitation requires wrap@2 (33.2 D-03). */
export interface JoinRequestPayload { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string; x25519Sig: string; nonce: string; mac: string; member?: string; kem?: KemBinding }
export interface JoinMacFields { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string; nonce: string; member?: string }

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

// HMAC-SHA256 under the secret over the canonical bytes of the six fields, as base64url.
// member is covered only when present, so a request for a new person's invite names no member.
export function joinMac(secret: string, fields: JoinMacFields): string {
  const covered: Record<string, string> = { invite: fields.invite, genesisHash: fields.genesisHash, name: fields.name, publicKey: fields.publicKey, x25519: fields.x25519, nonce: fields.nonce };
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

/** A device named by an invitation (lead or inviter) read from hostile input: exact keys, the writer id derived from the signing key. */
function inviteDeviceOf(value: unknown): InviteLead | undefined {
  if (!isRecord(value) || !hasKeys(value, ['member', 'writer', 'publicKey', 'x25519'])) return undefined;
  const [member, writer, publicKey, x25519] = ['member', 'writer', 'publicKey', 'x25519'].map((key) => own(value, key));
  if (typeof member !== 'string' || !SLUG.test(member)) return undefined;
  if (!isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES)) return undefined;
  if (typeof writer !== 'string' || writer !== writerIdOf(publicKey)) return undefined;
  return { member, writer, publicKey, x25519 };
}

/** The hub an invitation names, read from hostile input: exact keys, a hub address, a 64 hex pin and a 64 hex writer id. A fresh object. */
function inviteHubOf(value: unknown): InviteHub | undefined {
  if (!isRecord(value) || !hasKeys(value, ['address', 'certPin', 'writer'])) return undefined;
  const [address, certPin, writer] = ['address', 'certPin', 'writer'].map((key) => own(value, key));
  if (!isHubAddress(address) || typeof certPin !== 'string' || !HASH_PATTERN.test(certPin) || typeof writer !== 'string' || !HASH_PATTERN.test(writer)) return undefined;
  return { address, certPin, writer };
}

// A required feature list: 1 to MAX_FEATURES ids, distinct and sorted, as roster.require writes them. A fresh copy.
function requiresOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FEATURES) return undefined;
  for (let index = 0; index < value.length; index += 1) if (!isReplicaFeature(value[index]) || (index > 0 && !((value[index - 1] as string) < (value[index] as string)))) return undefined;
  return [...(value as string[])];
}

function invitePayloadOf(value: unknown): InvitePayload | undefined {
  if (!isRecord(value) || !hasKeys(value, INVITE_KEYS, ['forMember', 'inviter', 'hub', 'requires'])) return undefined;
  const [genesisHash, project, name, leadIn, invite, secret, expiresAt] = INVITE_KEYS.map((key) => own(value, key));
  const forMember = own(value, 'forMember');
  const inviterIn = own(value, 'inviter');
  const hubIn = own(value, 'hub');
  const hub = hubIn === undefined ? undefined : inviteHubOf(hubIn);
  if (hubIn !== undefined && hub === undefined) return undefined;
  const requiresIn = own(value, 'requires');
  const requires = requiresIn === undefined ? undefined : requiresOf(requiresIn);
  if (requiresIn !== undefined && requires === undefined) return undefined;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (!isLine(name) || typeof invite !== 'string' || !SLUG.test(invite) || !isKey(secret, JOIN_SECRET_BYTES) || !isTime(expiresAt)) return undefined;
  if (forMember !== undefined && (typeof forMember !== 'string' || !SLUG.test(forMember))) return undefined;
  const lead = inviteDeviceOf(leadIn);
  // An invitation without inviter was made by the founding lead's device, which signed it: its inviter is the lead.
  const inviter = inviterIn === undefined ? lead : inviteDeviceOf(inviterIn);
  if (lead === undefined || inviter === undefined) return undefined;
  const payload: InvitePayload = { genesisHash, project, name, lead, inviter: { ...inviter }, invite, secret, expiresAt };
  if (forMember !== undefined) payload.forMember = forMember;
  if (hub !== undefined) payload.hub = hub;
  if (requires !== undefined) payload.requires = requires;
  return payload;
}

function joinPayloadOf(value: unknown): JoinRequestPayload | undefined {
  if (!isRecord(value) || !hasKeys(value, JOIN_KEYS, ['member', 'kem'])) return undefined;
  const [invite, genesisHash, name, publicKey, x25519, x25519Sig, nonce, mac] = JOIN_KEYS.map((key) => own(value, key));
  const member = own(value, 'member');
  if (member !== undefined && (typeof member !== 'string' || !SLUG.test(member))) return undefined;
  if (typeof invite !== 'string' || !SLUG.test(invite)) return undefined;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (!isLine(name) || !isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES)) return undefined;
  if (!isKey(x25519Sig, ED25519_SIGNATURE_BYTES) || !isKey(nonce, JOIN_NONCE_BYTES) || !isKey(mac, MAC_BYTES)) return undefined;
  const kemIn = own(value, 'kem');
  if (kemIn !== undefined && kemProblem(kemIn, 'kem') !== undefined) return undefined;
  const payload: JoinRequestPayload = { invite, genesisHash, name, publicKey, x25519, x25519Sig, nonce, mac };
  if (member !== undefined) payload.member = member;
  if (kemIn !== undefined) {
    const kem = kemIn as Record<string, string>;
    payload.kem = { p256: kem.p256, mlkem768: kem.mlkem768, sig: kem.sig };
  }
  return payload;
}

// The envelope's signer must be the key the payload names, so the status lookup answers active for that key only.
const onlyKey = (publicKey: string): KeyStatusLookup => (key) => ({ state: key.publicKey === publicKey ? 'active' : 'unknown' });

/**
 * lead: the project's anchor, the founding lead's member id and X25519 key, and its signing key when the signer is another device. inviter: the
 * signing device's member id and X25519 key; absent when the signer is the founding lead's device itself.
 */
export interface BuildInviteInput {
  genesisHash: string;
  project: string;
  name: string;
  lead: { member: string; x25519: string; publicKey?: string };
  inviter?: { member: string; x25519: string };
  invite: string;
  secret: string;
  expiresAt: string;
  now: Date;
  forMember?: string;
  /** The project's sync hub (D-47). Only its address, certPin and writer are copied. */
  hub?: InviteHub;
  /** The project's required features (its folded roster.require), so a joining device knows to send post-quantum keys (33.2 D-03). */
  requires?: readonly string[];
}

// Signs an invite with the inviting device (the founding lead's, or any device of the lead or the deputy, MJ-05). With forMember it is the short
// invite of Add My Other Machine (D-18): only that member's other machine may answer it, and its admission is a device.add. Throws when the content is
// not a valid invite, or when another device signs without naming itself as the inviter.
export function buildInvite(signer: PayloadSigner, input: BuildInviteInput): SignedPayload<InvitePayload> {
  const leadKey = input.lead.publicKey ?? signer.publicKey;
  if (input.inviter === undefined && leadKey !== signer.publicKey) throw new Error('The invitation was not made: a device other than the founding lead\'s must name itself as the inviter.');
  const lead: InviteLead = { member: input.lead.member, writer: writerIdOf(leadKey), publicKey: leadKey, x25519: input.lead.x25519 };
  const inviter: InviteLead = input.inviter === undefined ? { ...lead } : { member: input.inviter.member, writer: writerIdOf(signer.publicKey), publicKey: signer.publicKey, x25519: input.inviter.x25519 };
  const payload: InvitePayload = {
    genesisHash: input.genesisHash,
    project: input.project,
    name: input.name,
    lead,
    inviter,
    invite: input.invite,
    secret: input.secret,
    expiresAt: input.expiresAt
  };
  if (input.forMember !== undefined) payload.forMember = input.forMember;
  if (input.requires !== undefined && input.requires.length > 0) payload.requires = [...input.requires];
  if (input.hub !== undefined) {
    const hub: unknown = input.hub;
    if (!isRecord(hub)) throw new Error('The invitation was not made: the hub must name an address, a certificate pin and a writer id.');
    payload.hub = { address: own(hub, 'address'), certPin: own(hub, 'certPin'), writer: own(hub, 'writer') } as InviteHub;
  }
  if (invitePayloadOf(payload) === undefined) throw new Error('The invitation was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-invite', payload, { now: () => input.now });
}

export type InviteRead = { ok: true; invite: InvitePayload } | InviteFailure;

// Reads an invite file (its JSON text or its parsed content) at time now. Checks the shape, that the inviter's own key signed it (the lead's for an
// invitation that names no inviter), and the expiry. Whether the inviter may invite is the roster's answer, checked when the welcome arrives. Never
// throws.
export function readInvite(file: unknown, now: Date): InviteRead {
  try {
    const parsed = fileValue(file, MAX_PAYLOAD_BYTES);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    const payload = isRecord(value) ? invitePayloadOf(own(value, 'payload')) : undefined;
    if (payload === undefined) return refuse('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-invite', status: onlyKey(payload.inviter.publicKey) });
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
// kem: the joining device's post-quantum public keys; the request carries them, bound by the same signer, only when the invitation requires wrap@2.
export interface BuildJoinRequestInput { name: string; x25519: string; now: Date; member?: string; kem?: KemPublicKeys }

function freshJoinNonce(): string {
  // Public randomness can resemble a secret. Redraw before building the signed payload.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = randomBytes(JOIN_NONCE_BYTES).toString('base64url');
    if (findSecrets({ nonce }).length === 0) return nonce;
  }
  throw new PayloadError('The join request was not made. Please try again.');
}

// Signs a join request with the joining device for the invite it read. The X25519 binding signature is made by the same signer. The nonce is drawn
// fresh here, after the invite was read, which is what makes the safety code cost a second preimage (safetyCode.ts).
export function buildJoinRequest(signer: PayloadSigner, invite: InvitePayload, input: BuildJoinRequestInput): SignedPayload<JoinRequestPayload> {
  const writer = writerIdOf(signer.publicKey);
  const member = input.member ?? invite.forMember;
  const fields: JoinMacFields = { invite: invite.invite, genesisHash: invite.genesisHash, name: input.name, publicKey: signer.publicKey, x25519: input.x25519, nonce: freshJoinNonce() };
  if (member !== undefined) fields.member = member;
  const payload: JoinRequestPayload = { invite: fields.invite, genesisHash: fields.genesisHash, name: fields.name, publicKey: fields.publicKey, x25519: fields.x25519, x25519Sig: signer.sign(x25519BindingBytes(input.x25519, writer)), nonce: fields.nonce, mac: joinMac(invite.secret, fields) };
  if (member !== undefined) payload.member = member;
  if (input.kem !== undefined && (invite.requires ?? []).includes(KEM_JOIN_FEATURE)) payload.kem = signKemBinding(input.kem, writer, (bytes) => signer.sign(bytes));
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
  return checkRequestFile(file, expected, true);
}

/** What the lead knows of an invitation that already admitted a device: no secret is needed or used. */
export interface AdmittedRequestExpectation { invite: Pick<InvitePayload, 'genesisHash' | 'invite' | 'forMember' | 'requires'> }

// The check of a join request for an invitation the roster shows as used, so the welcome file can be made again for the device it admitted (MJ-02):
// shape and size, signature, project, invitation id, key binding and member, in that order, and no MAC (the join secret may be forgotten by now). The
// caller must also check that the request's device is the one the invitation admitted, with the same keys; a welcome is only of use to that device.
// Never throws.
export function checkAdmittedRequest(file: unknown, expected: AdmittedRequestExpectation): JoinRequestCheck {
  return checkRequestFile(file, { invite: { ...expected.invite } as InvitePayload, secret: '' }, false);
}

function checkRequestFile(file: unknown, expected: JoinRequestExpectation, withMac: boolean): JoinRequestCheck {
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
    // Post-quantum keys come only in answer to an invitation that requires wrap@2, so a lead never meets keys it did not ask for (33.2 D-03).
    if (payload.kem !== undefined && !(expected.invite.requires ?? []).includes(KEM_JOIN_FEATURE)) return refuse('malformed');
    if (payload.kem !== undefined && !kemBindingHolds(payload.kem, writer, payload.publicKey)) return refuse('bad-binding');
    if (withMac) {
      const want = Buffer.from(joinMac(expected.secret, payload), 'base64url');
      const got = Buffer.from(payload.mac, 'base64url');
      if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse('wrong-secret');
    }
    // A member's invite is answered only by that member's machine, and a new person's invite by a machine that names no member.
    if (payload.member !== expected.invite.forMember) return refuse('wrong-device');
    return { ok: true, request: payload, writer };
  } catch {
    // Hostile input never throws out of the check.
    return refuse('malformed');
  }
}


/** The joining device's keys and the nonce of its join request. */
export interface SafetyCodeKeys { publicKey: string; x25519: string; nonce: string; kem?: { p256: string; mlkem768: string } }

// The six safety code words for an invite and a join request (D-16). Both sides pass the join request (the lead the checked one it received, the
// joining device the one it made). Both read the anchor's and the inviter's keys, the invite id and the genesis hash from the invite, so the two
// screens agree exactly when no key was swapped in transit. The join secret is not an input.
export function inviteSafetyCode(invite: Pick<InvitePayload, 'invite' | 'genesisHash' | 'lead' | 'inviter'>, joiner: SafetyCodeKeys): string[] {
  return safetyCode({
    invite: invite.invite,
    genesisHash: invite.genesisHash,
    lead: { publicKey: invite.lead.publicKey, x25519: invite.lead.x25519 },
    inviter: { publicKey: invite.inviter.publicKey, x25519: invite.inviter.x25519 },
    joiner: joiner.kem === undefined ? { publicKey: joiner.publicKey, x25519: joiner.x25519 } : { publicKey: joiner.publicKey, x25519: joiner.x25519, kem: { p256: joiner.kem.p256, mlkem768: joiner.kem.mlkem768 } },
    nonce: joiner.nonce
  });
}


// The pin a joining device takes from an invite it read (D-07): the genesis hash, the project id and the lead's member id and keys.
export function inviteAnchor(invite: InvitePayload): RosterAnchor {
  return { genesisHash: invite.genesisHash, project: invite.project, lead: { member: invite.lead.member, writer: invite.lead.writer, publicKey: invite.lead.publicKey, x25519: invite.lead.x25519 } };
}

// A welcome file is larger than an invite (it carries the roster), so its cap is the store's blob limit.
export const WELCOME_MAX_BYTES = BLOB_MAX_BYTES;
export const WELCOME_VERSION = 1;
const WELCOME_KEYS = ['v', 'genesis', 'roster', 'blobs', 'grants'] as const;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

// genesis: the project.genesis entry. roster: the other entries of the roster stream, in the order the lead holds them. blobs: the sealed blobs those
// entries name. grants: the signed cell grants addressed to the new device only (every epoch of each cell it is cleared for, D-45).
export interface WelcomeFile { v: 1; genesis: SealedEntry; roster: SealedEntry[]; blobs: SealedBlob[]; grants: unknown[] }

// writer: the joining device. cells: the cells it is cleared for (the lead's host decides clearance, D-22). grants: any grants the lead's host holds;
// only those of a cleared cell whose every wrap names the joining device are carried (the host builds per-device grants for admission, 31-20).
export interface BuildWelcomeInput { genesis: SealedEntry; roster: readonly SealedEntry[]; blobs: readonly SealedBlob[]; grants: readonly unknown[]; writer: string; cells: readonly string[] }

const copyEntry = (entry: SealedEntry): SealedEntry => JSON.parse(JSON.stringify({ header: entry.header, body: entry.body })) as SealedEntry;

// Builds the welcome the lead returns after Admit. An entry outside the roster stream is a fault of the caller: it throws a plain error. A grant that
// does not read is left out and counted in `skipped` when given (MJ-02): the grants folder is a folder anyone with the project can drop a file into, so
// one bad file must never stop a welcome. The caller tells the lead when a cleared cell has no grant in the welcome.
export function buildWelcome(input: BuildWelcomeInput, skipped?: { grants: number }): WelcomeFile {
  const stream = input.genesis.header.stream;
  const genesisHash = entryHash(input.genesis.header);
  const roster: SealedEntry[] = [];
  for (const entry of input.roster) {
    if (entry.header.stream !== stream) throw new Error('The welcome file was not made: a roster entry belongs to another stream.');
    if (entryHash(entry.header) !== genesisHash) roster.push(copyEntry(entry));
  }
  const grants: unknown[] = [];
  for (const signed of input.grants) {
    const read = readGrant(signed);
    if (!read.ok) {
      if (skipped !== undefined) skipped.grants += 1;
      continue;
    }
    if (input.cells.includes(read.grant.cell) && read.grant.wraps.every((wrap) => wrap.writer === input.writer)) grants.push(JSON.parse(JSON.stringify(signed)) as unknown);
  }
  const welcome: WelcomeFile = { v: WELCOME_VERSION, genesis: copyEntry(input.genesis), roster, blobs: input.blobs.map((blob) => ({ hash: blob.hash, bytes: blob.bytes })), grants };
  if (canonicalBytes(welcome).length > WELCOME_MAX_BYTES) throw new Error(`The welcome file was not made: the roster is larger than the ${WELCOME_MAX_BYTES} bytes a welcome file can carry.`);
  return welcome;
}

// A sealed entry read from hostile input: exact keys, a header of the exact shape, and a base64url body. A fresh object, never the input.
function sealedEntryOf(value: unknown): SealedEntry | undefined {
  if (!isRecord(value) || !hasKeys(value, ['header', 'body'])) return undefined;
  const shape = parseHeaderShape(own(value, 'header'));
  const body = own(value, 'body');
  if (!shape.ok || typeof body !== 'string' || !BASE64URL.test(body)) return undefined;
  const header: EntryHeader = { ...shape.header, body: { hash: shape.header.body.hash, size: shape.header.body.size } };
  return { header, body };
}

function sealedBlobOf(value: unknown): SealedBlob | undefined {
  if (!isRecord(value) || !hasKeys(value, ['hash', 'bytes'])) return undefined;
  const hash = own(value, 'hash');
  const bytes = own(value, 'bytes');
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash) || typeof bytes !== 'string' || !BASE64URL.test(bytes)) return undefined;
  const blob: SealedBlob = { hash, bytes };
  return blobBytesHash(blob) === hash ? blob : undefined;
}

export type WelcomeRead = { ok: true; welcome: WelcomeFile; entries: SealedEntry[] } | InviteFailure;

/** The project a welcome file names (its genesis stream), read only to find the pin; readWelcome checks everything else. Never throws. */
export function welcomeProjectOf(file: unknown): string | undefined {
  try {
    const value: unknown = typeof file === 'string' ? (Buffer.byteLength(file, 'utf8') <= WELCOME_MAX_BYTES ? JSON.parse(file) : undefined) : file;
    if (!isRecord(value) || !isRecord(value.genesis) || !isRecord(value.genesis.header)) return undefined;
    const stream = value.genesis.header.stream;
    return typeof stream === 'string' && STREAM_ID_PATTERN.test(stream) ? stream : undefined;
  } catch {
    return undefined;
  }
}

// The joining device's read of a welcome file (its JSON text or its parsed content) against the genesis hash it pinned from the invite and its own
// writer id. Checks, in order: size, shape (entries, blobs and grants each read as hostile input; every roster entry in the genesis stream; every
// blob's bytes match its name), the genesis hash (wrong-project), every grant's signature, and that every wrap of every grant names this device
// (wrong-device). entries is the genesis then the roster, ready for the roster fold, which checks every signature and rule itself. Never throws.
export function readWelcome(file: unknown, pinned: { genesisHash: string; writer: string }): WelcomeRead {
  try {
    const parsed = fileValue(file, WELCOME_MAX_BYTES);
    if (!parsed.ok) return parsed;
    // One plain snapshot of the input, so every check below reads the same values.
    const value: unknown = JSON.parse(canonicalBytes(parsed.value).toString('utf8'));
    if (!isRecord(value) || !hasKeys(value, WELCOME_KEYS) || own(value, 'v') !== WELCOME_VERSION) return refuse('malformed');
    const genesis = sealedEntryOf(own(value, 'genesis'));
    const rosterIn = own(value, 'roster');
    const blobsIn = own(value, 'blobs');
    const grantsIn = own(value, 'grants');
    if (genesis === undefined || !Array.isArray(rosterIn) || !Array.isArray(blobsIn) || !Array.isArray(grantsIn)) return refuse('malformed');
    const roster: SealedEntry[] = [];
    for (const item of rosterIn as unknown[]) {
      const entry = sealedEntryOf(item);
      if (entry === undefined || entry.header.stream !== genesis.header.stream) return refuse('malformed');
      roster.push(entry);
    }
    const blobs: SealedBlob[] = [];
    for (const item of blobsIn as unknown[]) {
      const blob = sealedBlobOf(item);
      if (blob === undefined) return refuse('malformed');
      blobs.push(blob);
    }
    if (entryHash(genesis.header) !== pinned.genesisHash) return refuse('wrong-project');
    const grants: unknown[] = [];
    let forAnotherDevice = false;
    for (const item of grantsIn as unknown[]) {
      const read = readGrant(item);
      if (!read.ok) return refuse(read.reason === 'bad-signature' ? 'bad-signature' : 'malformed');
      if (!read.grant.wraps.every((wrap) => wrap.writer === pinned.writer)) forAnotherDevice = true;
      grants.push(item);
    }
    if (forAnotherDevice) return refuse('wrong-device');
    const welcome: WelcomeFile = { v: WELCOME_VERSION, genesis, roster, blobs, grants };
    return { ok: true, welcome, entries: [genesis, ...roster] };
  } catch {
    // Hostile input never throws out of the reader.
    return refuse('malformed');
  }
}


// ---- Joining through your organization's sync hub (D-48). ----

/** The HKDF info prefix of the hub check key; the invite id's UTF-8 bytes follow it. */
export const HUB_JOIN_INFO = 'near-ai/hub-join/v1';
export const HUB_CHECK_KEY_BYTES = 32;
export const HUB_JOIN_VERSION = 1;
const HUB_JOIN_KEYS = ['v', 'hub', 'project', 'invite', 'request', 'hubMac'] as const;

/** hub is the hub's writer id (the invitation's hub.writer), project the project id, request the joinRequestHash of the signed join request. */
export interface HubJoinMacFields { hub: string; project: string; invite: string; request: string }
export interface HubJoinPayload { v: 1; hub: string; project: string; invite: string; request: string; hubMac: string }

// The hub check key of one invitation: HKDF-SHA256 over the secret's bytes with an empty salt and info HUB_JOIN_INFO followed by the invite id, 32 bytes
// as base64url. One way: it reveals neither the secret nor the secretHash the roster carries, and each invitation has its own. Throws a plain error,
// naming no secret, for a secret that is not 32 bytes of base64url or an invite id that is not a slug.
export function hubJoinCheckKey(secret: string, invite: string): string {
  if (!isKey(secret, JOIN_SECRET_BYTES) || typeof invite !== 'string' || !SLUG.test(invite)) {
    throw new Error('The hub check key was not made: it needs the invitation\'s 32 byte join secret and its invite id.');
  }
  const info = Buffer.concat([Buffer.from(HUB_JOIN_INFO, 'utf8'), Buffer.from(invite, 'utf8')]);
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64url'), Buffer.alloc(0), info, HUB_CHECK_KEY_BYTES)).toString('base64url');
}

// sha256 hex of the canonical form of a signed join request, given as JSON text or as its parsed value, so key order and spacing never change it.
// Throws a plain error for text that is not JSON or a value with no canonical form.
export function joinRequestHash(request: unknown): string {
  let value: unknown;
  try {
    value = typeof request === 'string' ? (JSON.parse(request) as unknown) : request;
    return createHash('sha256').update(canonicalBytes(value)).digest('hex');
  } catch {
    throw new Error('The join request could not be hashed: it is not a join request this version can read.');
  }
}

function hubJoinMessage(fields: HubJoinMacFields): Buffer {
  // Only these four fields, copied by name, so an extra property on the input is never covered.
  return canonicalBytes({ hub: fields.hub, project: fields.project, invite: fields.invite, request: fields.request });
}

// HMAC-SHA256 under the hub check key over the canonical bytes of the four fields, as base64url. Its key is never the join secret, so it is never the
// Phase 31 MAC, whose key is. Throws a plain error for a key that is not 32 bytes of base64url.
export function hubJoinMac(checkKey: string, fields: HubJoinMacFields): string {
  if (!isKey(checkKey, HUB_CHECK_KEY_BYTES)) throw new Error('The hub join MAC was not made: the hub check key must be 32 bytes written as base64url.');
  return createHmac('sha256', Buffer.from(checkKey, 'base64url')).update(hubJoinMessage(fields)).digest('base64url');
}

// The hub's check of a hub MAC, in constant time. False, never a throw, for any other MAC, key or input.
export function checkHubJoinMac(checkKey: string, fields: HubJoinMacFields, mac: string): boolean {
  try {
    if (!isKey(mac, MAC_BYTES)) return false;
    const want = Buffer.from(hubJoinMac(checkKey, fields), 'base64url');
    const got = Buffer.from(mac, 'base64url');
    return want.length === got.length && timingSafeEqual(want, got);
  } catch {
    return false;
  }
}

function hubJoinPayloadOf(value: unknown): HubJoinPayload | undefined {
  if (!isRecord(value) || !hasKeys(value, HUB_JOIN_KEYS)) return undefined;
  const [v, hub, project, invite, request, hubMac] = HUB_JOIN_KEYS.map((key) => own(value, key));
  if (v !== HUB_JOIN_VERSION || typeof hub !== 'string' || !HASH_PATTERN.test(hub) || typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (typeof invite !== 'string' || !SLUG.test(invite) || typeof request !== 'string' || !HASH_PATTERN.test(request) || !isKey(hubMac, MAC_BYTES)) return undefined;
  return { v: HUB_JOIN_VERSION, hub, project, invite, request, hubMac };
}

/** request: the signed join request this device made; hubMac: hubJoinMac under the check key the device derived from the invitation. */
export interface BuildHubJoinInput { hub: string; project: string; request: SignedPayload<JoinRequestPayload>; hubMac: string; now: Date }

// Signs the hub join envelope with the joining device, the device that signed the request. Throws a plain error when another device signs it or a
// field is not valid.
export function buildHubJoin(signer: PayloadSigner, input: BuildHubJoinInput): SignedPayload<HubJoinPayload> {
  const request = joinPayloadOf(isRecord(input.request) ? own(input.request, 'payload') : undefined);
  if (request === undefined || request.publicKey !== signer.publicKey) throw new Error('The hub join was not made: it must be signed by the device that made the join request.');
  const payload: HubJoinPayload = { v: HUB_JOIN_VERSION, hub: input.hub, project: input.project, invite: request.invite, request: joinRequestHash(input.request), hubMac: input.hubMac };
  if (hubJoinPayloadOf(payload) === undefined) throw new Error('The hub join was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-hub-join', payload, { now: () => input.now });
}

export type HubJoinRead = { ok: true; join: HubJoinPayload; writer: string } | InviteFailure;

// The hub's check of a hub join envelope (JSON text or parsed) against the signed join request posted with it (JSON text or parsed). Checks, in order:
// size and shape of both, that the envelope's signer is the request's own device (wrong-device), the envelope's signature and the request's own
// signature (bad-signature), then that the envelope names this request by its hash and the same invitation (wrong-device). The caller then checks that
// hub and project are its own, the invitation's standing, and checkHubJoinMac with the registered check key. Never throws.
export function readHubJoin(file: unknown, request: unknown): HubJoinRead {
  try {
    const parsed = fileValue(file, MAX_PAYLOAD_BYTES);
    if (!parsed.ok) return parsed;
    const parsedRequest = fileValue(request, MAX_PAYLOAD_BYTES);
    if (!parsedRequest.ok) return parsedRequest;
    const value = parsed.value;
    const requestValue = parsedRequest.value;
    const join = isRecord(value) ? hubJoinPayloadOf(own(value, 'payload')) : undefined;
    const joinRequest = isRecord(requestValue) ? joinPayloadOf(own(requestValue, 'payload')) : undefined;
    const signer = isRecord(value) ? own(value, 'signer') : undefined;
    const signerKey = isRecord(signer) ? own(signer, 'publicKey') : undefined;
    if (join === undefined || joinRequest === undefined || typeof signerKey !== 'string') return refuse('malformed');
    if (signerKey !== joinRequest.publicKey) return refuse('wrong-device');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-hub-join', status: onlyKey(joinRequest.publicKey) });
    if (!verdict.ok) return refuse(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    const requestVerdict = verifyPayload<unknown>(requestValue, { purpose: 'staff-join-request', status: onlyKey(joinRequest.publicKey) });
    if (!requestVerdict.ok) return refuse(requestVerdict.reason === 'bad-signature' || requestVerdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    if (join.request !== joinRequestHash(requestValue) || join.invite !== joinRequest.invite) return refuse('wrong-device');
    return { ok: true, join, writer: writerIdOf(joinRequest.publicKey) };
  } catch {
    // Hostile input never throws out of the check.
    return refuse('malformed');
  }
}
