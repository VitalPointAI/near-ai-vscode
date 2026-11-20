// The invite file and the join request file (D-14, D-15, D-16, D-17). Hub-side and pure: node:crypto and src/domain only, no clock (the caller
// passes now), no I/O. The host reads and writes the files; this module builds and checks their content.
//
// - Invite (purpose staff-invite), signed by the lead's device: the pinned genesis hash, the project id and name, the lead's member id and keys, the
//   invite id, the one-time join secret (32 random bytes) and the expiry. The roster entry member.invite carries only sha256 of the secret.
// - Join request (purpose staff-join-request), signed by the joining device: the invite id, the genesis hash, the person's name, the device's
//   Ed25519 and X25519 public keys, the X25519 binding signature, and mac = HMAC-SHA256 under the secret over the canonical bytes of
//   { invite, genesisHash, name, publicKey, x25519 }. The MAC proves the request came from someone holding the invite file; the safety code (a
//   separate module) is what catches a key swapped in transit, because a stolen invite file lets anyone make a valid MAC.
// Refusal reasons are a closed record of plain sentences. 31-16 completes the list and the welcome file.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalBytes, isStrictBase64url, verifySignature } from '../team/canonical';
import type { KeyStatusLookup } from '../team/keyStatus';
import { signPayload, verifyPayload } from '../team/signedPayload';
import type { PayloadSigner, SignedPayload } from '../team/signedPayload';
import { isRecord } from '../team/validate';
import { HASH_PATTERN, STREAM_ID_PATTERN, writerIdOf } from './entry';
import { X25519_KEY_BYTES, x25519BindingBytes } from './cellKeys';

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

export interface InviteLead { member: string; writer: string; publicKey: string; x25519: string }
export interface InvitePayload { genesisHash: string; project: string; name: string; lead: InviteLead; invite: string; secret: string; expiresAt: string }
export interface JoinRequestPayload { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string; x25519Sig: string; mac: string }
export interface JoinMacFields { invite: string; genesisHash: string; name: string; publicKey: string; x25519: string }

export const INVITE_REFUSALS = {
  malformed: 'This is not an invitation or join request this version can read. Ask the lead for a new invitation.',
  'bad-signature': 'The signature on this file does not match its content, so it was changed after it was signed. Ask for a new file.',
  'invite-expired': 'This invitation has expired. Ask the lead for a new invitation.',
  'wrong-project': 'This join request is for a different project. Check that you chose the right file.',
  'unknown-invite': 'This join request answers an invitation this project does not have. Ask the person to use the invitation you sent.',
  'bad-binding': 'The device keys in this join request do not belong together, so it cannot be used. Ask the person to make a new join request.',
  'wrong-secret': 'This join request was not made with the invitation you sent. Ask the person to make a new join request from your invitation.'
} as const;
export type InviteRefusal = keyof typeof INVITE_REFUSALS;
export type InviteFailure = { ok: false; reason: InviteRefusal; message: string };

const refuse = (reason: InviteRefusal): InviteFailure => ({ ok: false, reason, message: INVITE_REFUSALS[reason] });

// A fresh one-time join secret as base64url.
export function newJoinSecret(): string {
  return randomBytes(JOIN_SECRET_BYTES).toString('base64url');
}

// The value member.invite.secretHash carries: sha256 hex of the secret's bytes. The secret itself never enters a roster entry.
export function joinSecretHash(secret: string): string {
  return createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex');
}

// HMAC-SHA256 under the secret over the canonical bytes of the five fields, as base64url.
export function joinMac(secret: string, fields: JoinMacFields): string {
  const message = canonicalBytes({ invite: fields.invite, genesisHash: fields.genesisHash, name: fields.name, publicKey: fields.publicKey, x25519: fields.x25519 });
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(message).digest('base64url');
}

const isLine = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_CHARS && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const isKey = (value: unknown, bytes: number): value is string => typeof value === 'string' && isStrictBase64url(value, bytes);
const isTime = (value: unknown): value is string => typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const hasExactly = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
};

function invitePayloadOf(value: unknown): InvitePayload | undefined {
  if (!isRecord(value) || !hasExactly(value, ['genesisHash', 'project', 'name', 'lead', 'invite', 'secret', 'expiresAt'])) return undefined;
  const { genesisHash, project, name, lead, invite, secret, expiresAt } = value;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (typeof project !== 'string' || !STREAM_ID_PATTERN.test(project)) return undefined;
  if (!isLine(name) || typeof invite !== 'string' || !SLUG.test(invite) || !isKey(secret, JOIN_SECRET_BYTES) || !isTime(expiresAt)) return undefined;
  if (!isRecord(lead) || !hasExactly(lead, ['member', 'writer', 'publicKey', 'x25519'])) return undefined;
  if (typeof lead.member !== 'string' || !SLUG.test(lead.member)) return undefined;
  if (!isKey(lead.publicKey, ED25519_PUBLIC_BYTES) || !isKey(lead.x25519, X25519_KEY_BYTES)) return undefined;
  if (typeof lead.writer !== 'string' || lead.writer !== writerIdOf(lead.publicKey)) return undefined;
  return { genesisHash, project, name, lead: { member: lead.member, writer: lead.writer, publicKey: lead.publicKey, x25519: lead.x25519 }, invite, secret, expiresAt };
}

function joinPayloadOf(value: unknown): JoinRequestPayload | undefined {
  if (!isRecord(value) || !hasExactly(value, ['invite', 'genesisHash', 'name', 'publicKey', 'x25519', 'x25519Sig', 'mac'])) return undefined;
  const { invite, genesisHash, name, publicKey, x25519, x25519Sig, mac } = value;
  if (typeof invite !== 'string' || !SLUG.test(invite)) return undefined;
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash)) return undefined;
  if (!isLine(name) || !isKey(publicKey, ED25519_PUBLIC_BYTES) || !isKey(x25519, X25519_KEY_BYTES)) return undefined;
  if (!isKey(x25519Sig, ED25519_SIGNATURE_BYTES) || !isKey(mac, MAC_BYTES)) return undefined;
  return { invite, genesisHash, name, publicKey, x25519, x25519Sig, mac };
}

// The envelope's signer must be the key the payload names, so the status lookup answers active for that key only.
const onlyKey = (publicKey: string): KeyStatusLookup => (key) => ({ state: key.publicKey === publicKey ? 'active' : 'unknown' });

export interface BuildInviteInput { genesisHash: string; project: string; name: string; lead: { member: string; x25519: string }; invite: string; secret: string; expiresAt: string; now: Date }

// Signs an invite with the lead's device. Throws when the content is not a valid invite.
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
  if (invitePayloadOf(payload) === undefined) throw new Error('The invitation was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-invite', payload, { now: () => input.now });
}

export type InviteRead = { ok: true; invite: InvitePayload } | InviteFailure;

// Reads an invite file's parsed content at time now. Checks the shape, that the lead's own key signed it, and the expiry. Never throws.
export function readInvite(value: unknown, now: Date): InviteRead {
  try {
    const payload = isRecord(value) ? invitePayloadOf(value.payload) : undefined;
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

export interface BuildJoinRequestInput { name: string; x25519: string; now: Date }

// Signs a join request with the joining device for the invite it read. The X25519 binding signature is made by the same signer.
export function buildJoinRequest(signer: PayloadSigner, invite: InvitePayload, input: BuildJoinRequestInput): SignedPayload<JoinRequestPayload> {
  const writer = writerIdOf(signer.publicKey);
  const fields: JoinMacFields = { invite: invite.invite, genesisHash: invite.genesisHash, name: input.name, publicKey: signer.publicKey, x25519: input.x25519 };
  const payload: JoinRequestPayload = { ...fields, x25519Sig: signer.sign(x25519BindingBytes(input.x25519, writer)), mac: joinMac(invite.secret, fields) };
  if (joinPayloadOf(payload) === undefined) throw new Error('The join request was not made: one of its fields is not valid.');
  return signPayload(signer, 'staff-join-request', payload, { now: () => input.now });
}

export type JoinRequestCheck = { ok: true; request: JoinRequestPayload; writer: string } | InviteFailure;

// The lead's check of a join request against the invite it answers and the secret the lead kept. Never throws.
export function checkJoinRequest(value: unknown, expected: { invite: InvitePayload; secret: string }): JoinRequestCheck {
  try {
    const payload = isRecord(value) ? joinPayloadOf(value.payload) : undefined;
    if (payload === undefined) return refuse('malformed');
    const verdict = verifyPayload<unknown>(value, { purpose: 'staff-join-request', status: onlyKey(payload.publicKey) });
    if (!verdict.ok) return refuse(verdict.reason === 'bad-signature' || verdict.reason === 'unknown-key' ? 'bad-signature' : 'malformed');
    if (payload.genesisHash !== expected.invite.genesisHash) return refuse('wrong-project');
    if (payload.invite !== expected.invite.invite) return refuse('unknown-invite');
    const writer = writerIdOf(payload.publicKey);
    if (!verifySignature(x25519BindingBytes(payload.x25519, writer), payload.x25519Sig, payload.publicKey)) return refuse('bad-binding');
    const want = Buffer.from(joinMac(expected.secret, payload), 'base64url');
    const got = Buffer.from(payload.mac, 'base64url');
    if (want.length !== got.length || !timingSafeEqual(want, got)) return refuse('wrong-secret');
    return { ok: true, request: payload, writer };
  } catch {
    // Hostile input never throws out of the check.
    return refuse('malformed');
  }
}

// RED stub (31-16 Task 1): replaced by the real derivation in the next commit.
export function inviteSafetyCode(_invite: InvitePayload, _joiner: { publicKey: string; x25519: string }): string[] {
  return [];
}
