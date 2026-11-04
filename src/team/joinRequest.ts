// Ask to join (G-61-9, owner design 2026-11-04 item 2): an invite in reverse. A person who has a copy of the project but no invite makes a
// request on their own computer. The single-use code (D-09) is made and kept there only, in VS Code secure storage; the request carries the
// public key derived from it, the same derivation an invite uses, and is signed by that key so a changed name or email is refused. A lead who
// accepts writes a normal member.invited for that key through the invite code path, and the requester's computer then joins by itself with
// the existing code proof. No code, key or token travels in either direction, no new event type exists and no event body changes. The request
// text is hostile input like the invite bundle: exact prefix, size cap, strict base64url, pattern checks and fixed error sentences that never
// repeat the input. This module never imports vscode.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { canonicalBytes, canonicalize, isStrictBase64url, verifySignature } from '../domain/team/canonical';
import { isGitRefName } from '../domain/team/policy';
import { assertNoSecrets, findSecrets } from '../domain/team/secrets';
import type { TeamFile, TeamState } from '../domain/team/types';
import { EVENT_ID_PATTERN, MEMBER_ID_PATTERN, PUBLIC_KEY_PATTERN, SIGNATURE_PATTERN, TEAM_ID_PATTERN, validateName } from '../domain/team/validate';
import type { SecretStorageLike } from '../services/auth';
import { loadDeviceIdentity, loadSealIdentity, newMemberId } from './identity';
import { acceptRequestInvite } from './invite';
import type { InviteInput } from './invite';
import { deriveInviteKey, generateInviteCode, parseInviteCode } from './inviteCode';
import { joinTeam } from './join';
import type { JoinInput, JoinResult } from './join';
import { COORDINATION_REF_PATTERN, runSerialised, teamStorageDir, writeFileAtomic } from './teamFile';

export const JOIN_REQUEST_PREFIX = 'near-ai-join-request-v1.';
export const MAX_JOIN_REQUEST_BYTES = 2048;
export const JOIN_REQUEST_PURPOSE = 'near-ai.team.join-request';
/** Where the requester's computer keeps its request, code included, in VS Code secure storage. One request per team. */
export const JOIN_REQUEST_SECRET_PREFIX = 'nearAi.team.joinRequest.';
/** The accepting computer's list of requests it accepted: member ids, names and event ids only (no email, no key). */
export const ACCEPTED_REQUESTS_FILE = 'accepted-requests.json';

export interface JoinRequest { v: 1; team: string; ref: string; member: string; name: string; email?: string; key: string; sig: string }

// Every failure a person may read is one of a few fixed sentences. None of them contains the request text, a name, an email or a key.
export class JoinRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'JoinRequestError';
  }
}

const NOT_A_REQUEST = 'This is not a NEAR AI request to join. Paste the whole request text exactly as you were sent it.';
const TOO_LARGE = 'This request is far larger than a real one, so it was not used.';
const DAMAGED = 'This request is damaged or was changed after it was made. Ask the person to send it again.';
const NEWER = 'This request was made by a newer version of NEAR AI. Update the extension, then try again.';
const HOLDS_SECRET = 'This request holds something that looks like a key or token, so it was not used. Ask the person to send a new one.';
const BAD_NAME = 'Your name must be 1 to 80 characters with no line breaks.';
const BAD_EMAIL = 'The email address is not valid. Use a full address such as name@example.com, or leave it empty.';
const NAME_SECRET = 'Your name or email looks like a key or token, so no request was made.';
const HAS_KEY = 'This computer already has a key for this team, so it cannot ask to join it again.';
const STORED_DAMAGED = 'The request to join saved on this computer could not be read. Cancel it, then ask to join again.';

const BASE64URL_TEXT = /^[A-Za-z0-9_-]+$/;
const FUTURE_PREFIX = /^near-ai-join-request-v(?!1\.)\d+\./;
const CODE_TEXT = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F\u2028\u2029]/;
const MAX_EMAIL_LENGTH = 254;
const REQUEST_KEYS = new Set(['v', 'team', 'ref', 'member', 'name', 'email', 'key', 'sig']);
const CHECK_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_ACCEPTED = 500;

function validEmail(email: string): boolean {
  return email.length > 0 && email.length <= MAX_EMAIL_LENGTH && email.includes('@') && !CONTROL_CHARACTERS.test(email) && !/\s/.test(email);
}

function validRef(ref: unknown): ref is string {
  return typeof ref === 'string' && COORDINATION_REF_PATTERN.test(ref) && isGitRefName(ref);
}

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(fields: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
}

// The words a person typed (name, email) are checked like any written text; the key and signature are checked as key material, which is how
// the log's own write check treats them, so random base64url is never mistaken for a token.
function holdsSecret(request: { name: string; email?: string; key: string; sig: string }): boolean {
  const typed = request.email === undefined ? { name: request.name } : { name: request.name, email: request.email };
  return findSecrets(typed).length > 0 || findSecrets({ publicKey: request.key, sig: request.sig }).length > 0;
}

type RequestBody = Omit<JoinRequest, 'sig'>;

// What the derived key signs: the purpose and every field but the signature, in canonical JSON.
function signedBytes(body: RequestBody): Buffer {
  const fields: Record<string, unknown> = { purpose: JOIN_REQUEST_PURPOSE, v: 1, team: body.team, ref: body.ref, member: body.member, name: body.name, key: body.key };
  if (body.email !== undefined) fields['email'] = body.email;
  return canonicalBytes(fields);
}

function wireFields(request: JoinRequest): Record<string, unknown> {
  const fields: Record<string, unknown> = { v: 1, team: request.team, ref: request.ref, member: request.member, name: request.name, key: request.key, sig: request.sig };
  if (request.email !== undefined) fields['email'] = request.email;
  return fields;
}

function encode(request: JoinRequest): string {
  return `${JOIN_REQUEST_PREFIX}${Buffer.from(canonicalize(wireFields(request)), 'utf8').toString('base64url')}`;
}

// Hostile input by default. Surrounding whitespace from a paste is dropped; everything else must match exactly.
export function parseJoinRequest(text: string): JoinRequest {
  if (typeof text !== 'string') throw new JoinRequestError(NOT_A_REQUEST);
  const trimmed = text.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_JOIN_REQUEST_BYTES) throw new JoinRequestError(TOO_LARGE);
  if (!trimmed.startsWith(JOIN_REQUEST_PREFIX)) throw new JoinRequestError(FUTURE_PREFIX.test(trimmed) ? NEWER : NOT_A_REQUEST);
  const payload = trimmed.slice(JOIN_REQUEST_PREFIX.length);
  if (payload === '' || !BASE64URL_TEXT.test(payload)) throw new JoinRequestError(DAMAGED);
  const decoded = Buffer.from(payload, 'base64url');
  // A decode and encode round trip refuses a non-canonical tail, so one request has one spelling.
  if (decoded.toString('base64url') !== payload) throw new JoinRequestError(DAMAGED);
  const json = decoded.toString('utf8');
  if (!Buffer.from(json, 'utf8').equals(decoded)) throw new JoinRequestError(DAMAGED);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // The parse error would quote the input, so only the fixed sentence is thrown.
    throw new JoinRequestError(DAMAGED);
  }
  if (!isFields(parsed)) throw new JoinRequestError(DAMAGED);
  const version = own(parsed, 'v');
  if (typeof version === 'number' && version > 1) throw new JoinRequestError(NEWER);
  if (version !== 1) throw new JoinRequestError(DAMAGED);
  // The signature covers exactly these fields, so nothing else may ride along unsigned.
  if (Object.keys(parsed).some((key) => !REQUEST_KEYS.has(key))) throw new JoinRequestError(DAMAGED);
  const team = own(parsed, 'team');
  const ref = own(parsed, 'ref');
  const member = own(parsed, 'member');
  const name = own(parsed, 'name');
  const email = own(parsed, 'email');
  const key = own(parsed, 'key');
  const sig = own(parsed, 'sig');
  if (typeof team !== 'string' || !TEAM_ID_PATTERN.test(team) || !validRef(ref) || typeof member !== 'string' || !MEMBER_ID_PATTERN.test(member)) throw new JoinRequestError(DAMAGED);
  if (typeof name !== 'string' || validateName(name, 'name') !== undefined || name.trim() !== name) throw new JoinRequestError(DAMAGED);
  if (email !== undefined && (typeof email !== 'string' || !validEmail(email))) throw new JoinRequestError(DAMAGED);
  if (typeof key !== 'string' || !PUBLIC_KEY_PATTERN.test(key) || !isStrictBase64url(key, 32)) throw new JoinRequestError(DAMAGED);
  if (typeof sig !== 'string' || !SIGNATURE_PATTERN.test(sig)) throw new JoinRequestError(DAMAGED);
  const request: JoinRequest = { v: 1, team, ref, member, name, ...(email === undefined ? {} : { email }), key, sig };
  if (canonicalize(wireFields(request)) !== json) throw new JoinRequestError(DAMAGED);
  if (holdsSecret(request)) throw new JoinRequestError(HOLDS_SECRET);
  // Self-signed by the key the invitation will be bound to: a name or email changed on the way, or a request signed by any other key, fails here.
  if (!verifySignature(signedBytes(request), sig, key)) throw new JoinRequestError(DAMAGED);
  return request;
}

/** Eight characters in two groups from a hash of the whole request, shown to both people so they can check they hold the same one. */
export function requestCheckCode(request: JoinRequest): string {
  const digest = createHash('sha256').update(canonicalize(wireFields(request)), 'utf8').digest();
  let text = '';
  for (let index = 0; index < 8; index += 1) text += CHECK_ALPHABET.charAt((digest[index] ?? 0) & 31);
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

// ---- the requester's computer ------------------------------------------------------------------------------------------------------------

interface StoredRequest { v: 1; memberId: string; code: string; name: string; email?: string; ref: string }

function secretName(teamId: string): string {
  if (!TEAM_ID_PATTERN.test(teamId)) throw new JoinRequestError('The team id is not valid.');
  return `${JOIN_REQUEST_SECRET_PREFIX}${teamId}`;
}

async function readStored(secrets: SecretStorageLike, teamId: string): Promise<StoredRequest | undefined> {
  const text = await secrets.get(secretName(teamId));
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JoinRequestError(STORED_DAMAGED);
  }
  if (!isFields(parsed)) throw new JoinRequestError(STORED_DAMAGED);
  const { v, memberId, code, name, email, ref } = parsed;
  if (v !== 1 || typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId) || typeof code !== 'string' || !CODE_TEXT.test(code) || parseInviteCode(code) === undefined) {
    throw new JoinRequestError(STORED_DAMAGED);
  }
  if (typeof name !== 'string' || validateName(name, 'name') !== undefined || !validRef(ref)) throw new JoinRequestError(STORED_DAMAGED);
  if (email !== undefined && (typeof email !== 'string' || !validEmail(email))) throw new JoinRequestError(STORED_DAMAGED);
  return { v: 1, memberId, code, name, ...(email === undefined ? {} : { email }), ref };
}

// The request text is rebuilt from the stored code each time (Ed25519 signatures are deterministic), so it can never disagree with the code.
function buildRequest(stored: StoredRequest, teamId: string): JoinRequest {
  const codeBytes = parseInviteCode(stored.code);
  if (codeBytes === undefined) throw new JoinRequestError(STORED_DAMAGED);
  try {
    const derived = deriveInviteKey(codeBytes, teamId, stored.memberId);
    const body: RequestBody = { v: 1, team: teamId, ref: stored.ref, member: stored.memberId, name: stored.name, ...(stored.email === undefined ? {} : { email: stored.email }), key: derived.publicKey };
    return { ...body, sig: derived.sign(signedBytes(body)) };
  } finally {
    codeBytes.fill(0);
  }
}

function shown(stored: StoredRequest, teamId: string): { text: string; checkCode: string; memberId: string; name: string } {
  const request = buildRequest(stored, teamId);
  const text = encode(request);
  // Checked on the way out as well, so this computer never hands over a request no lead's computer would accept.
  parseJoinRequest(text);
  return { text, checkCode: requestCheckCode(request), memberId: stored.memberId, name: stored.name };
}

async function holdsTeamKey(secrets: SecretStorageLike, teamId: string): Promise<boolean> {
  try {
    return (await loadDeviceIdentity(secrets, teamId)) !== undefined || (await loadSealIdentity(secrets, teamId)) !== undefined;
  } catch {
    // A stored key that cannot be read is still a key this computer holds for the team.
    return true;
  }
}

/**
 * Makes this computer's request to join the team in team.json, or gives back the one it already made. The code is made here, kept only in
 * secure storage, and never shown; the returned text holds the public key derived from it.
 */
export async function createJoinRequest(input: { secrets: SecretStorageLike; teamFile: TeamFile; name: string; email?: string }): Promise<{ text: string; checkCode: string; memberId: string }> {
  const teamId = input.teamFile.teamId;
  const existing = await readStored(input.secrets, teamId);
  if (existing !== undefined) {
    const { text, checkCode, memberId } = shown(existing, teamId);
    return { text, checkCode, memberId };
  }
  if (await holdsTeamKey(input.secrets, teamId)) throw new JoinRequestError(HAS_KEY);
  const name = input.name.trim();
  if (validateName(name, 'name') !== undefined) throw new JoinRequestError(BAD_NAME);
  const typedEmail = input.email?.trim() ?? '';
  const email = typedEmail === '' ? undefined : typedEmail;
  if (email !== undefined && !validEmail(email)) throw new JoinRequestError(BAD_EMAIL);
  if (findSecrets(email === undefined ? { name } : { name, email }).length > 0) throw new JoinRequestError(NAME_SECRET);
  if (!validRef(input.teamFile.coordination.ref)) throw new JoinRequestError('The team file of this project names a team record this version cannot use.');

  const code = generateInviteCode();
  try {
    const stored: StoredRequest = { v: 1, memberId: newMemberId(), code: code.text, name, ...(email === undefined ? {} : { email }), ref: input.teamFile.coordination.ref };
    const made = shown(stored, teamId);
    await input.secrets.store(secretName(teamId), JSON.stringify(stored));
    return { text: made.text, checkCode: made.checkCode, memberId: made.memberId };
  } finally {
    code.bytes.fill(0);
  }
}

export async function readPendingRequest(secrets: SecretStorageLike, teamId: string): Promise<{ text: string; checkCode: string; memberId: string; name: string } | undefined> {
  const stored = await readStored(secrets, teamId);
  return stored === undefined ? undefined : shown(stored, teamId);
}

/** Forgets the stored request and its code, so an invitation made from it can never be used by anyone. */
export async function cancelJoinRequest(secrets: SecretStorageLike, teamId: string): Promise<void> {
  await secrets.delete(secretName(teamId));
}

// ---- the accepting computer ------------------------------------------------------------------------------------------------------------

export interface AcceptedRequest { memberId: string; name: string; invitedEvent: string }

function acceptedFile(storageDir: string): string {
  return path.resolve(storageDir, ACCEPTED_REQUESTS_FILE);
}

function parseAccepted(value: unknown): AcceptedRequest | undefined {
  if (!isFields(value)) return undefined;
  const { memberId, name, invitedEvent } = value;
  if (typeof memberId !== 'string' || !MEMBER_ID_PATTERN.test(memberId)) return undefined;
  if (typeof name !== 'string' || validateName(name, 'name') !== undefined) return undefined;
  if (typeof invitedEvent !== 'string' || !EVENT_ID_PATTERN.test(invitedEvent)) return undefined;
  return { memberId, name, invitedEvent };
}

async function readAcceptedFile(file: string): Promise<AcceptedRequest[]> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error('The saved list of accepted requests could not be read.', { cause: error });
  }
  const list = isFields(parsed) ? parsed['accepted'] : undefined;
  if (!Array.isArray(list)) throw new Error('The saved list of accepted requests is not in a form this version understands.');
  return list.flatMap((item) => {
    const entry = parseAccepted(item);
    return entry === undefined ? [] : [entry];
  });
}

export async function readAcceptedRequests(storageDir: string): Promise<AcceptedRequest[]> {
  const file = acceptedFile(storageDir);
  return runSerialised(file, () => readAcceptedFile(file));
}

async function recordAccepted(storageDir: string, entry: AcceptedRequest): Promise<void> {
  const file = acceptedFile(storageDir);
  await runSerialised(file, async () => {
    const existing = await readAcceptedFile(file);
    const accepted = [...existing.filter((item) => item.memberId !== entry.memberId), { ...entry }].slice(-MAX_ACCEPTED);
    const body = { version: 1, accepted };
    assertNoSecrets(body, 'The list of accepted requests');
    await writeFileAtomic(file, `${JSON.stringify(body, null, 2)}\n`);
  });
}

/** True when this computer accepted the request with this member id, so it may confirm that person when their join arrives. */
export async function wasAcceptedHere(storageDir: string, memberId: string): Promise<boolean> {
  return (await readAcceptedRequests(storageDir)).some((entry) => entry.memberId === memberId);
}

export type AcceptResult =
  | { ok: true; memberId: string; nearInvitation: 'sent' | 'already-member' | 'queued' | 'not-applicable'; notice?: string }
  | { ok: false; code: 'refused' | 'conflict' | 'offline'; message: string };

function refuse(message: string): { ok: false; code: 'refused'; message: string } {
  return { ok: false, code: 'refused', message };
}

/**
 * A lead's accept (member.invite permission, checked by the log's write side): a normal member.invited for the request's member id and key,
 * with the role, allowance, email and lifetime the lead chose, through the same path as an invite. The email is the lead's choice, prefilled
 * from the request; it becomes the invitation's one email hash and the lead's local invitation list, exactly as an invite does.
 */
export async function acceptJoinRequest(input: Omit<InviteInput, 'name' | 'email'> & { request: JoinRequest; email: string }): Promise<AcceptResult> {
  const { request, email, ...rest } = input;
  let checked: JoinRequest;
  try {
    // The request object is checked again from its own text, so a caller that changed a field after parsing is refused like a changed paste.
    checked = parseJoinRequest(encode(request));
  } catch (error) {
    if (error instanceof JoinRequestError) return refuse(`${error.message} Nothing was changed.`);
    return refuse(`${DAMAGED} Nothing was changed.`);
  }
  if (checked.team !== input.teamFile.teamId) return refuse('This request is for a different team than the one open in this project. Nothing was changed.');
  if (checked.ref !== input.teamFile.coordination.ref) return refuse('This request was made for a different team record than the one this project uses. Ask the person to get the latest version of the project and ask again. Nothing was changed.');
  const issued = await acceptRequestInvite({ ...rest, name: checked.name, email }, { memberId: checked.member, invitePublicKey: checked.key });
  if (!issued.ok) return issued;
  const notices = issued.notice === undefined ? [] : [issued.notice];
  try {
    await recordAccepted(teamStorageDir(input.globalStorageDir, checked.team), { memberId: issued.memberId, name: checked.name, invitedEvent: issued.invitedEvent });
  } catch {
    // The invitation is already in the log; losing the note only means this computer will not confirm the person by itself.
    notices.push('The request was accepted, but this computer could not note it, so confirm this person yourself when they join.');
  }
  return { ok: true, memberId: issued.memberId, nearInvitation: issued.nearInvitation, ...(notices.length === 0 ? {} : { notice: notices.join(' ') }) };
}

// ---- the requester's computer joins by itself -------------------------------------------------------------------------------------------

export type CompleteOutcome =
  | { kind: 'none' }
  | { kind: 'not-yet' }
  | { kind: 'joined'; result: Extract<JoinResult, { ok: true }> }
  | { kind: 'expired' | 'cancelled' | 'used' | 'failed'; message: string };

const EXPIRED = 'Your request to join was accepted, but the invitation it became has expired. Ask to join again, or cancel the request.';
const CANCELLED = 'The invitation made from your request to join was cancelled. Ask to join again, or cancel the request.';
const USED = 'The invitation made from your request to join was already used. If that was not you, tell your lead, then ask to join again.';
const MISMATCH = 'The invitation on the team list does not match the request this computer made, so it was not used. Cancel the request, then ask to join again.';

/**
 * Run when this computer sees the team record: when the record holds the invitation made from this computer's stored request, joins with
 * the existing join (member.joined with the code-derived proof, observer until confirmed) and then forgets the stored code. Before the
 * invitation exists it answers not-yet and changes nothing.
 */
export async function completeJoinRequest(input: Omit<JoinInput, 'bundle' | 'displayName'> & { state: TeamState }): Promise<CompleteOutcome> {
  const { state, ...joinInput } = input;
  const teamId = input.teamFile.teamId;
  let stored: StoredRequest | undefined;
  try {
    stored = await readStored(input.secrets, teamId);
  } catch (error) {
    if (error instanceof JoinRequestError) return { kind: 'failed', message: error.message };
    throw error;
  }
  if (stored === undefined) return { kind: 'none' };
  const member = state.members.get(stored.memberId);
  if (member === undefined || member.invitedEvent === undefined) return { kind: 'not-yet' };

  // An earlier completion whose answer was lost: this computer's device is already on the team under this id, so the request is done.
  try {
    const identity = await loadDeviceIdentity(input.secrets, teamId);
    if (identity !== undefined && state.deviceIndex.get(identity.fingerprint) === stored.memberId) {
      await cancelJoinRequest(input.secrets, teamId);
      return { kind: 'none' };
    }
  } catch {
    // A key that cannot be read is reported by the join below, which refuses a computer that already holds one.
  }
  if (member.status === 'invited' && member.removedEvent !== undefined) return { kind: 'cancelled', message: CANCELLED };
  if (member.status !== 'invited') return { kind: 'used', message: USED };
  if (stored.ref !== input.teamFile.coordination.ref) return { kind: 'failed', message: MISMATCH };
  const expected = buildRequest(stored, teamId).key;
  if (member.invite === undefined || member.invite.publicKey !== expected) return { kind: 'failed', message: MISMATCH };

  // The bundle lives only in this call, built from the stored code; nothing reads its address, which is never needed for a copy already here.
  const result = await joinTeam({
    ...joinInput, displayName: stored.name,
    bundle: { v: 1, repo: '', team: teamId, ref: input.teamFile.coordination.ref, member: stored.memberId, code: stored.code }
  });
  if (result.ok) {
    await cancelJoinRequest(input.secrets, teamId);
    return { kind: 'joined', result };
  }
  switch (result.code) {
    case 'expired':
      return { kind: 'expired', message: EXPIRED };
    case 'cancelled':
      return { kind: 'cancelled', message: CANCELLED };
    case 'used':
      return { kind: 'used', message: USED };
    default:
      return { kind: 'failed', message: result.message };
  }
}
