// Joining by file (D-14 to D-18, D-37): the invite file, the join request file and the welcome file, read the way a person's files arrive, as JSON
// text from any channel. One named test per refusal, the invited -> join-requested transition (DESIGN 15.1), the safety code on both screens, and the
// welcome file that lets a new device catch up on the roster with only the grants addressed to it.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { sealBlob } from '../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../domain/replica/entry';
import { grantHash } from '../domain/replica/cellKeys';
import type { CellGrant } from '../domain/replica/cellKeys';
import {
  INVITE_REFUSALS, WELCOME_MAX_BYTES, buildInvite, buildJoinRequest, buildWelcome, checkAdmittedRequest, checkJoinRequest, inviteAnchor, inviteSafetyCode, joinMac, joinSecretHash, newJoinSecret, readInvite,
  readWelcome
} from '../domain/replica/invite';
import type { InvitePayload, JoinRequestPayload, WelcomeFile } from '../domain/replica/invite';
import { foldRoster } from '../domain/replica/roster';
import { canonicalBytes } from '../domain/team/canonical';
import { MAX_PAYLOAD_BYTES, signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_NOW, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { streamId } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const INVITE_ID = 'inv-jo';
const JOINER_MEMBER = 'mbr-jo';
const NOW = new Date(ROSTER_NOW);

// A file as it travels: written as JSON text by one side, read as text by the other.
const asFile = (value: unknown): string => JSON.stringify(value);
const reasonOf = (result: { ok: boolean; reason?: string }): string => (result.ok ? 'ok' : (result.reason as string));

interface Invited {
  world: RosterWorld;
  joiner: RosterDevice;
  genesis: Written;
  inviteEntry: Written;
  secret: string;
  inviteText: string;
  invite: InvitePayload;
}

// The lead writes the genesis and member.invite, then sends the invite file. The joiner has not answered yet.
function invited(options: { forMember?: string; expiresAt?: string; genesisHash?: string } = {}): Invited {
  const world = createRosterWorld();
  const joiner = world.device('JO', JOINER_MEMBER);
  const { entry: genesis } = world.genesis();
  const secret = newJoinSecret();
  const expiresAt = options.expiresAt ?? INVITE_EXPIRES;
  const inviteEntry = world.rosterEntry(world.lead, 'member.invite', {
    invite: INVITE_ID, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt, secretHash: joinSecretHash(secret),
    ...(options.forMember === undefined ? {} : { forMember: options.forMember })
  }, genesis.hash);
  const signed = buildInvite(world.lead.signer, {
    genesisHash: options.genesisHash ?? genesis.hash, project: world.project, name: world.projectName, lead: { member: world.lead.member, x25519: world.lead.x25519 }, invite: INVITE_ID,
    secret, expiresAt, now: NOW, ...(options.forMember === undefined ? {} : { forMember: options.forMember })
  });
  const inviteText = asFile(signed);
  return { world, joiner, genesis, inviteEntry, secret, inviteText, invite: signed.payload };
}

// The joiner's side: read the invite text, answer it with this device, return the request as text.
function answer(state: Invited, device: RosterDevice = state.joiner, extra: { member?: string } = {}): string {
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const invite = (read as { ok: true; invite: InvitePayload }).invite;
  return asFile(buildJoinRequest(device.signer, invite, { name: 'Jo Analyst', x25519: device.x25519, now: NOW, ...extra }));
}

const requestOf = (text: string): SignedPayload<JoinRequestPayload> => JSON.parse(text) as SignedPayload<JoinRequestPayload>;

test('15.1 invited -> join-requested: the invite and the join request travel as JSON text, the lead checks the request with the secret, and both screens show the same six words; reading and checking write nothing', () => {
  const state = invited();
  const entriesBefore = state.world.entries.length;
  const grantsBefore = state.world.grants.length;
  // The joiner reads the invite file text and answers it.
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const joinerInvite = (read as { ok: true; invite: InvitePayload }).invite;
  assert.equal(joinerInvite.genesisHash, state.genesis.hash);
  assert.equal(joinerInvite.lead.writer, state.world.lead.writer);
  const requestText = answer(state);
  // The lead checks the request text against the invite it holds and the secret it kept.
  const checked = checkJoinRequest(requestText, { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(checked), 'ok');
  const accepted = checked as { ok: true; request: JoinRequestPayload; writer: string };
  assert.equal(accepted.writer, state.joiner.writer);
  assert.equal(accepted.request.invite, INVITE_ID);
  // The lead's screen (from its invite and the request) and the joiner's screen (from the invite it read and its own keys) show the same words.
  const leadWords = inviteSafetyCode(state.invite, accepted.request);
  const joinerWords = inviteSafetyCode(joinerInvite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519, nonce: requestOf(requestText).payload.nonce });
  assert.equal(leadWords.length, 6);
  assert.deepEqual(leadWords, joinerWords);
  // Nothing was written to the roster or the grants by reading or checking (D-15): admission is a separate, confirmed step.
  assert.equal(state.world.entries.length, entriesBefore);
  assert.equal(state.world.grants.length, grantsBefore);
  // The parsed objects are fresh copies, so a caller changing them changes nothing the reader keeps.
  assert.deepEqual(JSON.parse(state.inviteText).payload, joinerInvite);
});

test('a joining X25519 key swapped in the request after it was signed is refused bad-signature', () => {
  const state = invited();
  const swapped = requestOf(answer(state));
  swapped.payload.x25519 = state.world.device('MALLORY', 'mbr-mallory').x25519;
  const checked = checkJoinRequest(asFile(swapped), { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(checked), 'bad-signature');
});

test('a request re-signed with a swapped X25519 key but the old binding signature is refused bad-binding, even when its MAC is right', () => {
  const state = invited();
  const original = requestOf(answer(state)).payload;
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  // Whoever holds the invite file can make a valid MAC, so only the binding signature stops this swap.
  const fields = { invite: original.invite, genesisHash: original.genesisHash, name: original.name, publicKey: original.publicKey, x25519: mallory.x25519, nonce: original.nonce };
  const payload: JoinRequestPayload = { ...fields, x25519Sig: original.x25519Sig, mac: joinMac(state.secret, fields) };
  const resigned = signPayload(state.joiner.signer, 'staff-join-request', payload, { now: () => NOW });
  const checked = checkJoinRequest(asFile(resigned), { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(checked), 'bad-binding');
});

test('a request fully re-made by another device with a stolen invite file checks, but its safety code differs from the joiner\'s (D-16)', () => {
  const state = invited();
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  const own = requestOf(answer(state)).payload;
  const stolen = checkJoinRequest(answer(state, mallory), { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(stolen), 'ok');
  const leadWords = inviteSafetyCode(state.invite, (stolen as { ok: true; request: JoinRequestPayload }).request);
  const joinerWords = inviteSafetyCode(state.invite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519, nonce: own.nonce });
  assert.equal(leadWords.length, 6);
  assert.notDeepEqual(leadWords, joinerWords);
  // Only the X25519 key substituted (the signing key and even the nonce kept) also changes the words.
  const halfSwap = inviteSafetyCode(state.invite, { publicKey: state.joiner.publicKey, x25519: mallory.x25519, nonce: own.nonce });
  assert.notDeepEqual(halfSwap, joinerWords);
});

test('MJ-01: the joining device draws a fresh nonce after it reads the invite, so its words cannot be predicted when the invite is chosen; the words cover the inviter', () => {
  const state = invited();
  const first = requestOf(answer(state)).payload;
  const second = requestOf(answer(state)).payload;
  // Same invite, same device, same keys: a new nonce each time, so other words each time.
  assert.equal(Buffer.from(first.nonce, 'base64url').length, 16);
  assert.notEqual(first.nonce, second.nonce);
  assert.equal(first.publicKey, second.publicKey);
  assert.notDeepEqual(inviteSafetyCode(state.invite, first), inviteSafetyCode(state.invite, second));
  // Each request checks, and its nonce is covered by its MAC and its signature.
  for (const request of [first, second]) {
    const checked = checkJoinRequest(asFile(signPayload(state.joiner.signer, 'staff-join-request', request, { now: () => NOW })), { invite: state.invite, secret: state.secret });
    assert.equal(reasonOf(checked), 'ok');
  }
  const swapped = signPayload(state.joiner.signer, 'staff-join-request', { ...first, nonce: second.nonce }, { now: () => NOW });
  refusedAs(checkJoinRequest(asFile(swapped), { invite: state.invite, secret: state.secret }), 'wrong-secret');
  // An invitation whose inviter is another device gives other words for the same request: a swapped inviter key is caught.
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  const otherInviter = { ...state.invite, inviter: { member: 'mbr-mallory', writer: mallory.writer, publicKey: mallory.publicKey, x25519: mallory.x25519 } };
  assert.notDeepEqual(inviteSafetyCode(otherInviter, first), inviteSafetyCode(state.invite, first));
});

test('MJ-01: a join request without a nonce (the format before it) is refused malformed, in plain words', () => {
  const state = invited();
  const request = JSON.parse(answer(state)) as { payload: Record<string, unknown> };
  const { nonce: _nonce, ...old } = request.payload;
  const fields = { invite: old.invite, genesisHash: old.genesisHash, name: old.name, publicKey: old.publicKey, x25519: old.x25519 };
  const oldMac = createHmac('sha256', Buffer.from(state.secret, 'base64url')).update(canonicalBytes(fields)).digest('base64url');
  const resigned = signPayload(state.joiner.signer, 'staff-join-request', { ...old, mac: oldMac }, { now: () => NOW });
  refusedAs(checkJoinRequest(asFile(resigned), { invite: state.invite, secret: state.secret }), 'malformed');
  assert.match(INVITE_REFUSALS.malformed, /Ask the person who sent it for a new file/);
});

test('MJ-05: any roster writer\'s device signs an invitation naming itself as the inviter and the founding lead as the anchor; it reads, and the inviter\'s key is what signs it', () => {
  const state = invited();
  const deputy = state.world.device('DEPUTY', 'mbr-dee');
  const signed = buildInvite(deputy.signer, {
    genesisHash: state.genesis.hash, project: state.world.project, name: state.world.projectName,
    lead: { member: state.world.lead.member, x25519: state.world.lead.x25519, publicKey: state.world.lead.publicKey }, inviter: { member: 'mbr-dee', x25519: deputy.x25519 },
    invite: 'inv-by-deputy', secret: newJoinSecret(), expiresAt: INVITE_EXPIRES, now: NOW
  });
  const read = readInvite(asFile(signed), NOW);
  assert.equal(reasonOf(read), 'ok');
  const invite = (read as { ok: true; invite: InvitePayload }).invite;
  assert.equal(invite.lead.writer, state.world.lead.writer, 'the anchor is the founding lead');
  assert.equal(invite.inviter.writer, deputy.writer);
  assert.equal(invite.inviter.member, 'mbr-dee');
  assert.deepEqual(inviteAnchor(invite).lead, { member: state.world.lead.member, writer: state.world.lead.writer, publicKey: state.world.lead.publicKey, x25519: state.world.lead.x25519 });
  // The inviter is covered by the signature: naming another inviter, or the lead's key signing it, is refused.
  const renamed = clone(signed) as unknown as { payload: { inviter: Json } };
  renamed.payload.inviter.x25519 = state.joiner.x25519;
  refusedAs(readInvite(asFile(renamed), NOW), 'bad-signature');
  const byLead = signPayload(state.world.lead.signer, 'staff-invite', signed.payload, { now: () => NOW });
  refusedAs(readInvite(asFile(byLead), NOW), 'bad-signature');
  // A device other than the founding lead's cannot make an invitation that does not name it as the inviter.
  assert.throws(() => buildInvite(deputy.signer, { ...{ genesisHash: state.genesis.hash, project: state.world.project, name: state.world.projectName, invite: 'inv-x', secret: newJoinSecret(), expiresAt: INVITE_EXPIRES, now: NOW }, lead: { member: state.world.lead.member, x25519: state.world.lead.x25519, publicKey: state.world.lead.publicKey } }), /inviter/);
  // The joining device answers it, and both screens agree on words that cover the deputy's keys.
  const request = buildJoinRequest(state.joiner.signer, invite, { name: 'Jo Analyst', x25519: state.joiner.x25519, now: NOW });
  assert.deepEqual(inviteSafetyCode(signed.payload, request.payload), inviteSafetyCode(invite, request.payload));
  assert.notDeepEqual(inviteSafetyCode({ ...invite, inviter: invite.lead }, request.payload), inviteSafetyCode(invite, request.payload));
});

test('MJ-05: an invitation made before inviter existed (signed by the founding lead, no inviter field) is still read, with the lead as its inviter', () => {
  const state = invited();
  const { inviter: _inviter, ...old } = state.invite;
  const signed = signPayload(state.world.lead.signer, 'staff-invite', old, { now: () => NOW });
  const read = readInvite(asFile(signed), NOW);
  assert.equal(reasonOf(read), 'ok');
  assert.deepEqual((read as { ok: true; invite: InvitePayload }).invite.inviter, state.invite.lead);
  // Without an inviter, only the lead's own key can sign it.
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  refusedAs(readInvite(asFile(signPayload(mallory.signer, 'staff-invite', old, { now: () => NOW })), NOW), 'bad-signature');
});

test('MJ-02: checkAdmittedRequest checks the signature, project, invitation and binding of a request without its secret, and refuses what checkJoinRequest refuses for them', () => {
  const state = invited();
  const text = answer(state);
  const expected = { invite: { genesisHash: state.invite.genesisHash, invite: state.invite.invite } };
  const checked = checkAdmittedRequest(text, expected);
  assert.equal(reasonOf(checked), 'ok');
  assert.equal((checked as { ok: true; writer: string }).writer, state.joiner.writer);
  const changed = JSON.parse(text) as { payload: Json };
  changed.payload.name = 'Someone Else';
  refusedAs(checkAdmittedRequest(asFile(changed), expected), 'bad-signature');
  refusedAs(checkAdmittedRequest(text, { invite: { ...expected.invite, genesisHash: 'e'.repeat(64) } }), 'wrong-project');
  refusedAs(checkAdmittedRequest(text, { invite: { ...expected.invite, invite: 'inv-other' } }), 'unknown-invite');
  refusedAs(checkAdmittedRequest(text, { invite: { ...expected.invite, forMember: JOINER_MEMBER } }), 'wrong-device');
  refusedAs(checkAdmittedRequest('not json', expected), 'malformed');
});

// ---- Task 2: every refusal by name (D-17, D-37) ----

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const inviteObject = (state: Invited): Json => JSON.parse(state.inviteText) as Json;
// Every refusal any test below saw, so the leak test can search all of them.
const seenRefusals: Array<{ reason: string; message: string }> = [];
function refusedAs(result: { ok: boolean; reason?: string; message?: string }, reason: string): void {
  assert.equal(reasonOf(result), reason);
  assert.equal(result.message, (INVITE_REFUSALS as Record<string, string>)[reason]);
  seenRefusals.push({ reason, message: result.message as string });
}

test('invite-expired: an invite read after its expiry is refused, one read at the expiry instant is not, and the lead\'s check given a later time refuses too', () => {
  const state = invited();
  assert.equal(reasonOf(readInvite(state.inviteText, new Date(INVITE_EXPIRES))), 'ok');
  refusedAs(readInvite(state.inviteText, new Date(Date.parse(INVITE_EXPIRES) + 1)), 'invite-expired');
  const request = answer(state);
  assert.equal(reasonOf(checkJoinRequest(request, { invite: state.invite, secret: state.secret, now: new Date(INVITE_EXPIRES) })), 'ok');
  refusedAs(checkJoinRequest(request, { invite: state.invite, secret: state.secret, now: new Date(Date.parse(INVITE_EXPIRES) + 1) }), 'invite-expired');
});

test('wrong-secret: a join request whose MAC was made with another secret is refused', () => {
  const state = invited();
  const request = answer(state);
  refusedAs(checkJoinRequest(request, { invite: state.invite, secret: newJoinSecret() }), 'wrong-secret');
  // The same device answering a copy of the invite carrying another secret (same id) is refused against the lead's real secret.
  const other = clone(state.invite);
  other.secret = newJoinSecret();
  const forged = asFile(buildJoinRequest(state.joiner.signer, other, { name: 'Jo Analyst', x25519: state.joiner.x25519, now: NOW }));
  refusedAs(checkJoinRequest(forged, { invite: state.invite, secret: state.secret }), 'wrong-secret');
});

test('wrong-project: a join request naming another genesis is refused, and so is a request checked against an invite of another project', () => {
  const state = invited();
  const elsewhere = invited({ genesisHash: 'e'.repeat(64) });
  const request = answer(elsewhere);
  refusedAs(checkJoinRequest(request, { invite: state.invite, secret: state.secret }), 'wrong-project');
  refusedAs(checkJoinRequest(answer(state), { invite: elsewhere.invite, secret: state.secret }), 'wrong-project');
});

test('bad-signature: an invite or a join request with any changed field is refused', () => {
  const state = invited();
  const invite = inviteObject(state);
  const inviteChanges: Array<(payload: Json & { lead: Json }) => void> = [
    (payload) => { payload.name = 'Exercise Southwind'; },
    (payload) => { payload.invite = 'inv-other'; },
    (payload) => { payload.expiresAt = '2027-11-26T11:00:00.000Z'; },
    (payload) => { payload.secret = newJoinSecret(); },
    (payload) => { payload.genesisHash = 'e'.repeat(64); },
    (payload) => { payload.project = 'f'.repeat(32); },
    (payload) => { payload.lead.member = 'mbr-other'; },
    (payload) => { payload.lead.x25519 = state.world.device('MALLORY', 'mbr-mallory').x25519; },
    (payload) => { (payload.inviter as Json).member = 'mbr-other'; }
  ];
  for (const change of inviteChanges) {
    const copy = clone(invite) as Json & { payload: Json & { lead: Json } };
    change(copy.payload);
    refusedAs(readInvite(asFile(copy), NOW), 'bad-signature');
  }
  const signedAt = clone(invite);
  signedAt.signedAt = '2026-11-19T12:00:00.001Z';
  refusedAs(readInvite(asFile(signedAt), NOW), 'bad-signature');
  // An invite signed by another device that claims to be the lead's: its signer is not the key the payload names.
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  const byMallory = signPayload(mallory.signer, 'staff-invite', state.invite, { now: () => NOW });
  refusedAs(readInvite(asFile(byMallory), NOW), 'bad-signature');

  const request = JSON.parse(answer(state)) as Json & { payload: Json };
  const requestChanges: Array<(payload: Json) => void> = [
    (payload) => { payload.name = 'Someone Else'; },
    (payload) => { payload.invite = 'inv-other'; },
    (payload) => { payload.genesisHash = 'e'.repeat(64); },
    (payload) => { payload.publicKey = mallory.publicKey; },
    (payload) => { payload.x25519 = mallory.x25519; },
    (payload) => { payload.x25519Sig = mallory.x25519Sig; },
    (payload) => { payload.nonce = Buffer.alloc(16, 7).toString('base64url'); },
    (payload) => { payload.mac = joinMac(newJoinSecret(), { invite: INVITE_ID, genesisHash: state.genesis.hash, name: 'Jo Analyst', publicKey: state.joiner.publicKey, x25519: state.joiner.x25519, nonce: payload.nonce as string }); }
  ];
  for (const change of requestChanges) {
    const copy = clone(request);
    change(copy.payload);
    refusedAs(checkJoinRequest(asFile(copy), { invite: state.invite, secret: state.secret }), 'bad-signature');
  }
});

test('unknown-invite: a join request answering an invitation the lead does not hold is refused', () => {
  const state = invited();
  // An invitation of the same project with another id (as if the lead had voided and forgotten it, or it came from someone else).
  const other = clone(state.invite);
  other.invite = 'inv-someone-else';
  const answered = asFile(buildJoinRequest(state.joiner.signer, other, { name: 'Jo Analyst', x25519: state.joiner.x25519, now: NOW }));
  refusedAs(checkJoinRequest(answered, { invite: state.invite, secret: state.secret }), 'unknown-invite');
});

test('invite-used and invite-voided: the lead\'s check refuses a request for an invitation the roster shows as used or voided, and accepts it while open', () => {
  const state = invited();
  const request = answer(state);
  assert.equal(reasonOf(checkJoinRequest(request, { invite: state.invite, secret: state.secret, rosterInvite: { state: 'open' } })), 'ok');
  refusedAs(checkJoinRequest(request, { invite: state.invite, secret: state.secret, rosterInvite: { state: 'used' } }), 'invite-used');
  refusedAs(checkJoinRequest(request, { invite: state.invite, secret: state.secret, rosterInvite: { state: 'voided' } }), 'invite-voided');
});

test('malformed: a missing field, an extra field, a __proto__ key, a non-object and text that is not JSON are each refused, for the invite and the request', () => {
  const state = invited();
  const invite = inviteObject(state);
  const request = JSON.parse(answer(state)) as Json;
  const variants = (file: Json): string[] => {
    const missing = clone(file) as Json & { payload: Json };
    delete missing.payload.name;
    const extra = clone(file) as Json & { payload: Json };
    extra.payload.hub = 'hub.example.test';
    const protoText = asFile(file).replace('{"', '{"__proto__":{"polluted":true},"');
    const protoInPayload = asFile(file).replace('"payload":{', '"payload":{"__proto__":{"polluted":true},');
    return [asFile(missing), asFile(extra), protoText, protoInPayload, '42', '[]', 'null', '"text"', 'not json at all', '{"v":1'];
  };
  for (const text of variants(invite)) refusedAs(readInvite(text, NOW), 'malformed');
  for (const text of variants(request)) refusedAs(checkJoinRequest(text, { invite: state.invite, secret: state.secret }), 'malformed');
  for (const value of [undefined, null, 7, [], new Map(), Object.create({ payload: (invite as { payload: unknown }).payload }) as unknown]) {
    refusedAs(readInvite(value, NOW), 'malformed');
    refusedAs(checkJoinRequest(value, { invite: state.invite, secret: state.secret }), 'malformed');
  }
  // Nothing leaked onto the shared prototype.
  assert.equal(({} as Json).polluted, undefined);
});

test('too-large: a file over MAX_PAYLOAD_BYTES is refused before it is parsed, as text or as a parsed value', () => {
  const state = invited();
  const padding = ' '.repeat(MAX_PAYLOAD_BYTES);
  refusedAs(readInvite(`${state.inviteText}${padding}`, NOW), 'too-large');
  refusedAs(checkJoinRequest(`${answer(state)}${padding}`, { invite: state.invite, secret: state.secret }), 'too-large');
  // Text that is not even JSON is refused for its size first, so a huge file is never parsed.
  refusedAs(readInvite(`{${'x'.repeat(MAX_PAYLOAD_BYTES + 1)}`, NOW), 'too-large');
  const big = inviteObject(state) as Json & { payload: Json };
  big.payload.name = 'x'.repeat(MAX_PAYLOAD_BYTES);
  refusedAs(readInvite(big, NOW), 'too-large');
});

test('Add My Other Machine: an invite for an existing member is answered by that member\'s other machine; a request naming another member, or none, is refused wrong-device', () => {
  const lead = invited({ forMember: JOINER_MEMBER });
  assert.equal(lead.invite.forMember, JOINER_MEMBER);
  const read = readInvite(lead.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  assert.equal((read as { ok: true; invite: InvitePayload }).invite.forMember, JOINER_MEMBER);
  // The other machine names the member the invite is for (by default the request copies it from the invite).
  const laptop = lead.world.device('JO-LAPTOP', JOINER_MEMBER);
  const honest = checkJoinRequest(answer(lead, laptop), { invite: lead.invite, secret: lead.secret });
  assert.equal(reasonOf(honest), 'ok');
  assert.equal((honest as { ok: true; request: JoinRequestPayload }).request.member, JOINER_MEMBER);
  assert.equal(inviteSafetyCode(lead.invite, (honest as { ok: true; request: JoinRequestPayload }).request).length, 6);
  // Another member's machine answering it is refused, with a right MAC and a valid signature.
  refusedAs(checkJoinRequest(answer(lead, laptop, { member: 'mbr-other' }), { invite: lead.invite, secret: lead.secret }), 'wrong-device');
  // A request naming no member for a member's invite, and one naming a member for a new-person invite, are refused too.
  const stripped = clone(lead.invite);
  delete stripped.forMember;
  const noMember = asFile(buildJoinRequest(laptop.signer, stripped, { name: 'Jo Analyst', x25519: laptop.x25519, now: NOW }));
  refusedAs(checkJoinRequest(noMember, { invite: lead.invite, secret: lead.secret }), 'wrong-device');
  const person = invited();
  refusedAs(checkJoinRequest(answer(person, person.joiner, { member: JOINER_MEMBER }), { invite: person.invite, secret: person.secret }), 'wrong-device');
});

test('every refusal message is one or two plain sentences that say what to do next, with no em-dash, and no refusal carries the secret, the MAC or a key', () => {
  const reasons = Object.keys(INVITE_REFUSALS).sort();
  assert.deepEqual(reasons, ['bad-binding', 'bad-signature', 'invite-expired', 'invite-used', 'invite-voided', 'malformed', 'too-large', 'unknown-invite', 'wrong-device', 'wrong-project', 'wrong-secret']);
  for (const [reason, message] of Object.entries(INVITE_REFUSALS)) {
    const sentences = message.split(/(?<=\.)\s+/).filter((part) => part.length > 0);
    assert.ok(sentences.length >= 1 && sentences.length <= 2, `${reason}: ${message}`);
    assert.ok(message.endsWith('.'), reason);
    assert.ok(!message.includes('\u2014') && !message.includes('\u2013'), `${reason} has a dash`);
    assert.match(message, /\b(Ask|Check|Choose|Use)\b/, `${reason} does not say what to do next`);
  }
  // Every refusal seen above, plus the refusals of one fresh scenario, contain no secret, MAC or key of that scenario.
  const state = invited();
  const request = JSON.parse(answer(state)) as { payload: JoinRequestPayload };
  const results = [
    checkJoinRequest(asFile(request), { invite: state.invite, secret: newJoinSecret() }),
    checkJoinRequest(asFile(request), { invite: state.invite, secret: state.secret, rosterInvite: { state: 'used' } }),
    readInvite(state.inviteText, new Date('2027-01-01T00:00:00.000Z'))
  ];
  const secrets = [state.secret, request.payload.mac, request.payload.publicKey, request.payload.x25519, request.payload.x25519Sig, state.invite.lead.publicKey, state.invite.lead.x25519];
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.deepEqual(Object.keys(result), ['ok', 'reason', 'message']);
    const text = JSON.stringify(result);
    for (const value of secrets) assert.ok(!text.includes(value), `a refusal carries ${value.slice(0, 4)}...`);
  }
  assert.ok(seenRefusals.length >= 20, `expected the named tests to record their refusals first, saw ${seenRefusals.length}`);
  for (const seen of seenRefusals) assert.deepEqual(Object.keys(seen), ['reason', 'message']);
});

// ---- Task 3: the welcome file (D-22, D-44, D-45) ----

const KIM_MEMBER = 'mbr-kim';

interface Admitted {
  world: RosterWorld;
  invite: InvitePayload;
  joiner: RosterDevice;
  kim: RosterDevice;
  genesis: Written;
  // J's own grants (base cell epochs 1 and 2), the grants J must not receive, and a sealed blob of the project stream.
  joinerGrants: Array<SignedPayload<CellGrant>>;
  notForJoiner: { lead: SignedPayload<CellGrant>; kim: SignedPayload<CellGrant>; mixed: SignedPayload<CellGrant>; otherCell: SignedPayload<CellGrant> };
  blob: SealedBlob;
}

// The lead founds the project (founding grant to L), invites and admits J at slot 2 and K at slot 3, and grants the base cell to each device on its
// own grant. A mixed grant (J and K on one grant) and a grant of another cell addressed to J also exist on the lead's side.
function admittedWorld(): Admitted {
  const state = invited();
  const { world, joiner, genesis, inviteEntry } = state;
  const kim = world.device('KIM', KIM_MEMBER);
  const admitJo = world.rosterEntry(world.lead, 'member.admit', {
    member: JOINER_MEMBER, invite: INVITE_ID, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: joiner.descriptor(2), agentSeats: []
  }, inviteEntry.hash);
  const inviteKim = world.rosterEntry(world.lead, 'member.invite', {
    invite: 'inv-kim', name: 'Kim Planner', seat: 'j5-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, admitJo.hash);
  const admitKim = world.rosterEntry(world.lead, 'member.admit', {
    member: KIM_MEMBER, invite: 'inv-kim', name: 'Kim Planner', seat: 'j5-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: kim.descriptor(3), agentSeats: []
  }, inviteKim.hash);
  const lead = world.grants[0];
  const joinerEpoch1 = world.grant(world.lead, { roster: admitJo.hash, to: [joiner] });
  const kimGrant = world.grant(world.lead, { roster: admitKim.hash, to: [kim] });
  const mixed = world.grant(world.lead, { roster: admitKim.hash, to: [joiner, kim] });
  // Cell creation is 31-15's in this wave, so the base cell's second epoch and the other cell are standalone grant objects here.
  const joinerEpoch2 = world.grant(world.lead, { epoch: 2, roster: admitKim.hash, to: [joiner] });
  const otherCell = world.grant(world.lead, { cell: streamId('other-cell'), roster: admitKim.hash, to: [joiner] });
  const blob = sealBlob(world.epochKeyOf(world.project, 1), world.project, 1, Buffer.from('a large roster body, sealed apart', 'utf8'));
  return { world, invite: state.invite, joiner, kim, genesis, joinerGrants: [joinerEpoch1, joinerEpoch2], notForJoiner: { lead, kim: kimGrant, mixed, otherCell }, blob };
}

function welcomeFor(admitted: Admitted): WelcomeFile {
  const { world, genesis, joiner, blob } = admitted;
  return buildWelcome({ genesis: genesis.entry, roster: world.entries, blobs: [blob], grants: world.grants, writer: joiner.writer, cells: [world.project] });
}

test('buildWelcome carries the genesis, every roster entry and blob and exactly the joining device\'s grants; the device folds the roster from the welcome alone to the lead\'s head', () => {
  const admitted = admittedWorld();
  const { world, joiner, genesis, joinerGrants, blob } = admitted;
  const welcome = welcomeFor(admitted);
  assert.equal(welcome.v, 1);
  assert.deepEqual(welcome.genesis, genesis.entry);
  assert.deepEqual(welcome.roster, world.entries.filter((entry) => entry !== genesis.entry));
  assert.deepEqual(welcome.blobs, [blob]);
  assert.deepEqual(welcome.grants.map(grantHash).sort(), joinerGrants.map(grantHash).sort());
  // The device reads the welcome as text, with the genesis hash it pinned from the invite and its own writer id.
  const read = readWelcome(JSON.stringify(welcome), { genesisHash: admitted.invite.genesisHash, writer: joiner.writer });
  assert.equal(reasonOf(read), 'ok');
  const received = (read as { ok: true; welcome: WelcomeFile; entries: SealedEntry[] });
  assert.deepEqual(received.entries, [welcome.genesis, ...welcome.roster]);
  const blobs = new Map(received.welcome.blobs.map((item) => [item.hash, item]));
  const ring = world.ringFor(joiner, received.welcome.grants as Array<SignedPayload<CellGrant>>);
  assert.deepEqual(ring(world.project, 1), world.epochKeyOf(world.project, 1));
  assert.deepEqual(ring(world.project, 2), world.epochKeyOf(world.project, 2));
  const joinerSide = foldRoster({ entries: received.entries, anchor: inviteAnchor(admitted.invite), keys: ring, blobs: (hash) => blobs.get(hash), grants: received.welcome.grants, now: NOW });
  const leadSide = world.foldRoster();
  assert.equal(leadSide.positions.length, 6);
  assert.deepEqual(joinerSide.positions, leadSide.positions);
  assert.deepEqual(joinerSide.refused.filter((item) => item.kind !== 'grant'), []);
});

test('the serialised welcome holds no grant of another cell, of another device or shared with another device', () => {
  const admitted = admittedWorld();
  const text = JSON.stringify(welcomeFor(admitted));
  for (const [name, grant] of Object.entries(admitted.notForJoiner)) {
    assert.ok(!text.includes(grantHash(grant)), `${name} grant hash found`);
    assert.ok(!text.includes(grant.sig), `${name} grant found`);
  }
  assert.ok(!text.includes(streamId('other-cell')));
  assert.ok(!text.includes(admitted.kim.x25519));
});

test('readWelcome refuses a welcome for another genesis (wrong-project) and one holding a grant for another device (wrong-device), and accepts the honest one', () => {
  const admitted = admittedWorld();
  const welcome = welcomeFor(admitted);
  const pinned = { genesisHash: admitted.invite.genesisHash, writer: admitted.joiner.writer };
  assert.equal(reasonOf(readWelcome(JSON.stringify(welcome), pinned)), 'ok');
  assert.equal(reasonOf(readWelcome(welcome, pinned)), 'ok');
  refusedAs(readWelcome(JSON.stringify(welcome), { ...pinned, genesisHash: 'e'.repeat(64) }), 'wrong-project');
  // Another project's genesis carried in the file is refused against this pin as well.
  const elsewhere = admittedWorld();
  refusedAs(readWelcome(JSON.stringify({ ...welcome, genesis: elsewhere.genesis.entry }), pinned), 'wrong-project');
  for (const grant of [admitted.notForJoiner.kim, admitted.notForJoiner.mixed, admitted.notForJoiner.lead]) {
    refusedAs(readWelcome(JSON.stringify({ ...welcome, grants: [...welcome.grants, grant] }), pinned), 'wrong-device');
  }
  // The honest welcome read by another device is refused the same way.
  refusedAs(readWelcome(JSON.stringify(welcome), { ...pinned, writer: admitted.kim.writer }), 'wrong-device');
});

test('readWelcome reads hostile input: oversized, malformed, a changed grant, an entry of another stream and a blob that does not match its name are refused', () => {
  const admitted = admittedWorld();
  const welcome = welcomeFor(admitted);
  const pinned = { genesisHash: admitted.invite.genesisHash, writer: admitted.joiner.writer };
  const text = JSON.stringify(welcome);
  refusedAs(readWelcome(`${text}${' '.repeat(WELCOME_MAX_BYTES)}`, pinned), 'too-large');
  const malformed: unknown[] = [
    '[]', 'null', 'not json', JSON.stringify({ ...welcome, v: 2 }), JSON.stringify({ ...welcome, extra: true }), text.replace('{"', '{"__proto__":{"polluted":true},"'),
    JSON.stringify({ ...welcome, roster: 'all of it' }), JSON.stringify({ ...welcome, genesis: { header: welcome.genesis.header } }),
    JSON.stringify({ ...welcome, roster: [...welcome.roster, { header: { ...welcome.genesis.header, stream: 'f'.repeat(32) }, body: welcome.genesis.body }] }),
    JSON.stringify({ ...welcome, blobs: [{ hash: 'e'.repeat(64), bytes: admitted.blob.bytes }] }),
    JSON.stringify({ ...welcome, grants: [{ not: 'a grant' }] }), undefined, 7
  ];
  for (const value of malformed) refusedAs(readWelcome(value, pinned), 'malformed');
  const changed = clone(welcome.grants[0]) as { payload: { labelSealed: string } };
  changed.payload.labelSealed = 'AAAA';
  refusedAs(readWelcome(JSON.stringify({ ...welcome, grants: [changed] }), pinned), 'bad-signature');
  assert.equal(({} as Json).polluted, undefined);
});

// Changed for MJ-02: buildWelcome used to throw on an unreadable grant, so one bad file anyone can drop in the grants folder stopped every welcome after
// the person was admitted. It now leaves the grant out and counts it; a roster entry of another stream is still the caller's fault and throws.
test('buildWelcome leaves out and counts an unreadable grant, keeps every readable one, and refuses a roster entry of another stream', () => {
  const admitted = admittedWorld();
  const { world, genesis, joiner } = admitted;
  const honest = buildWelcome({ genesis: genesis.entry, roster: world.entries, blobs: [], grants: world.grants, writer: joiner.writer, cells: [world.project] });
  const skipped = { grants: 0 };
  const withBad = buildWelcome({ genesis: genesis.entry, roster: world.entries, blobs: [], grants: [{ not: 'a grant' }, ...world.grants, 'text'], writer: joiner.writer, cells: [world.project] }, skipped);
  assert.equal(skipped.grants, 2);
  assert.deepEqual(withBad, honest);
  assert.ok(honest.grants.length > 0);
  assert.doesNotThrow(() => buildWelcome({ genesis: genesis.entry, roster: world.entries, blobs: [], grants: [{ not: 'a grant' }], writer: joiner.writer, cells: [world.project] }));
  const foreign = { header: { ...genesis.entry.header, stream: 'f'.repeat(32) }, body: genesis.entry.body };
  assert.throws(() => buildWelcome({ genesis: genesis.entry, roster: [...world.entries, foreign], blobs: [], grants: [], writer: joiner.writer, cells: [world.project] }), /welcome/i);
});
