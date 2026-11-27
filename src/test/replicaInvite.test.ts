// Joining by file (D-14 to D-18, D-37): the invite file, the join request file and the welcome file, read the way a person's files arrive, as JSON
// text from any channel. One named test per refusal, the invited -> join-requested transition (DESIGN 15.1), the safety code on both screens, and the
// welcome file that lets a new device catch up on the roster with only the grants addressed to it.
import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import crypto = require('node:crypto');
import test from 'node:test';
import { sealBlob } from '../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../domain/replica/entry';
import { grantHash } from '../domain/replica/cellKeys';
import { kemPublicFromSeeds } from '../domain/replica/cellWrapV2';
import type { KemPublicKeys } from '../domain/replica/cellWrapV2';
import type { CellGrant } from '../domain/replica/cellKeys';
import {
  HUB_JOIN_INFO, INVITE_REFUSALS, JOIN_NONCE_BYTES, WELCOME_MAX_BYTES, buildHubJoin, buildInvite, buildJoinRequest, buildWelcome, checkAdmittedRequest, checkHubJoinMac, checkJoinRequest, hubJoinCheckKey, hubJoinMac,
  inviteAnchor, inviteSafetyCode, joinMac, joinRequestHash, joinSecretHash, newJoinSecret, readHubJoin, readInvite, readWelcome
} from '../domain/replica/invite';
import type { HubJoinMacFields, HubJoinPayload, InviteHub, InvitePayload, JoinRequestPayload, WelcomeFile } from '../domain/replica/invite';
import { foldRoster } from '../domain/replica/roster';
import { canonicalBytes } from '../domain/team/canonical';
import { MAX_PAYLOAD_BYTES, signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { findSecrets } from '../domain/team/secrets';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_NOW, createRosterWorld, rosterDevice } from './helpers/replicaRosterWorld';
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
function answer(state: Invited, device: RosterDevice = state.joiner, extra: { member?: string; kem?: KemPublicKeys } = {}): string {
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

test('MJ-01: a generated nonce rejected by the signing guard is discarded before the join request is signed', (t) => {
  const state = invited();
  const flaggedText = `rt_${'A'.repeat(19)}`;
  const flagged = Buffer.from(flaggedText, 'base64url');
  const clean = Buffer.alloc(JOIN_NONCE_BYTES, 7);
  assert.equal(flagged.length, JOIN_NONCE_BYTES);
  assert.equal(flagged.toString('base64url'), flaggedText);
  assert.deepEqual(findSecrets({ nonce: flaggedText }), ['$.nonce'], 'the unchanged guard classifies the synthetic generated candidate');
  assert.deepEqual(findSecrets({ nonce: clean.toString('base64url') }), []);

  const realRandomBytes = crypto.randomBytes;
  let nonceDraws = 0;
  t.mock.method(crypto, 'randomBytes', ((size: number): Buffer => {
    if (size !== JOIN_NONCE_BYTES) return realRandomBytes(size);
    nonceDraws += 1;
    return Buffer.from(nonceDraws === 1 ? flagged : clean);
  }) as typeof crypto.randomBytes);

  const request = buildJoinRequest(state.joiner.signer, state.invite, { name: 'Jo Analyst', x25519: state.joiner.x25519, now: NOW });
  assert.equal(nonceDraws, 2);
  assert.equal(request.payload.nonce, clean.toString('base64url'));
  assert.notEqual(request.payload.nonce, flaggedText);
  assert.equal(reasonOf(checkJoinRequest(asFile(request), { invite: state.invite, secret: state.secret })), 'ok');
});

test('MJ-01: eight rejected generated nonces fail closed before signing and disclose no candidate', (t) => {
  const state = invited();
  const candidates = Array.from({ length: 8 }, (_, index) => {
    const text = `rt_${index.toString().padStart(2, '0')}${'A'.repeat(17)}`;
    const bytes = Buffer.from(text, 'base64url');
    assert.equal(bytes.length, JOIN_NONCE_BYTES);
    assert.equal(bytes.toString('base64url'), text);
    assert.deepEqual(findSecrets({ nonce: text }), ['$.nonce']);
    return { text, bytes };
  });
  const realRandomBytes = crypto.randomBytes;
  let nonceDraws = 0;
  t.mock.method(crypto, 'randomBytes', ((size: number): Buffer => {
    if (size !== JOIN_NONCE_BYTES) return realRandomBytes(size);
    const candidate = candidates[nonceDraws];
    nonceDraws += 1;
    if (candidate === undefined) throw new Error('the nonce generator exceeded its eight-draw bound');
    return Buffer.from(candidate.bytes);
  }) as typeof crypto.randomBytes);

  let signCalls = 0;
  const signer = {
    ...state.joiner.signer,
    sign: (bytes: Buffer): string => {
      signCalls += 1;
      return state.joiner.signer.sign(bytes);
    }
  };
  assert.throws(
    () => buildJoinRequest(signer, state.invite, { name: 'Jo Analyst', x25519: state.joiner.x25519, now: NOW }),
    (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /join request was not made/i);
      assert.doesNotMatch(error.message, /secret|token|candidate|\$\.nonce/i);
      for (const candidate of candidates) {
        assert.ok(!error.message.includes(candidate.text));
        assert.ok(!error.message.includes(candidate.bytes.toString('hex')));
      }
      return true;
    },
  );
  assert.equal(nonceDraws, 8);
  assert.equal(signCalls, 0);
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

// ---- 32-15: the invitation's hub field (D-47), the hub check key, the hub MAC and the hub join envelope (D-48). ----

const HUB_DEVICE = rosterDevice('HUB', 'hub');
const HUB: InviteHub = { address: 'hub.example.org:8443', certPin: createHash('sha256').update('pin/hub').digest('hex'), writer: HUB_DEVICE.writer };

// The lead's invitation for a project on a hub: the same as invited(), with the hub field.
function invitedThroughHub(hub: unknown = HUB): Invited & { signed: SignedPayload<InvitePayload> } {
  const state = invited();
  const signed = buildInvite(state.world.lead.signer, {
    genesisHash: state.genesis.hash, project: state.world.project, name: state.world.projectName, lead: { member: state.world.lead.member, x25519: state.world.lead.x25519 },
    invite: INVITE_ID, secret: state.secret, expiresAt: INVITE_EXPIRES, now: NOW, hub: hub as InviteHub
  });
  return { ...state, signed, inviteText: asFile(signed), invite: signed.payload };
}

// The joiner's side of a join through the hub: the Phase 31 request, then the envelope with the MAC under the check key it derives from the secret.
function joinThroughHub(state: Invited): { request: SignedPayload<JoinRequestPayload>; join: SignedPayload<HubJoinPayload>; checkKey: string; fields: HubJoinMacFields } {
  const request = requestOf(answer(state));
  const checkKey = hubJoinCheckKey(state.invite.secret, state.invite.invite);
  const fields: HubJoinMacFields = { hub: HUB.writer, project: state.invite.project, invite: state.invite.invite, request: joinRequestHash(request) };
  const join = buildHubJoin(state.joiner.signer, { hub: HUB.writer, project: state.invite.project, request, hubMac: hubJoinMac(checkKey, fields), now: NOW });
  return { request, join, checkKey, fields };
}

test('D-47: an invitation may name its hub (address, certificate pin, hub writer id), and readInvite returns the same hub', () => {
  const state = invitedThroughHub();
  assert.deepEqual(state.signed.payload.hub, HUB);
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const invite = (read as { ok: true; invite: InvitePayload }).invite;
  assert.deepEqual(invite.hub, HUB);
  // The hub is a fresh copy, and it is covered by the signature.
  assert.notEqual(invite.hub, state.signed.payload.hub);
  const changed = clone(state.signed) as unknown as { payload: { hub: Json } };
  changed.payload.hub.address = 'other.example.org:8443';
  refusedAs(readInvite(asFile(changed), NOW), 'bad-signature');
  // Only the three named fields are copied from the builder's input, so an extra property of the caller's object never reaches the file.
  const extra = { ...HUB, note: 'x' } as unknown as InviteHub;
  assert.deepEqual(invitedThroughHub(extra).signed.payload.hub, HUB);
});

test('D-47: a Phase 31 invitation with no hub reads exactly as before, with no hub key at all', () => {
  const state = invited();
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const invite = (read as { ok: true; invite: InvitePayload }).invite;
  assert.equal('hub' in invite, false);
  assert.equal('hub' in state.invite, false);
  // The result Phase 31 gave for this file, field by field.
  assert.deepEqual(invite, {
    genesisHash: state.genesis.hash, project: state.world.project, name: state.world.projectName,
    lead: { member: state.world.lead.member, writer: state.world.lead.writer, publicKey: state.world.lead.publicKey, x25519: state.world.lead.x25519 },
    inviter: { member: state.world.lead.member, writer: state.world.lead.writer, publicKey: state.world.lead.publicKey, x25519: state.world.lead.x25519 },
    invite: INVITE_ID, secret: state.secret, expiresAt: INVITE_EXPIRES
  });
  // A file signed in the Phase 31 shape directly (no inviter, no hub) reads the same way.
  const { inviter: _inviter, ...old } = state.invite;
  assert.deepEqual((readInvite(asFile(signPayload(state.world.lead.signer, 'staff-invite', old, { now: () => NOW })), NOW) as { ok: true; invite: InvitePayload }).invite, invite);
});

test('D-47: a hub with an extra key, a missing key, a bad pin, a bad address or a bad writer id is malformed, as read and as built', () => {
  const state = invited();
  const bad: Array<[string, unknown]> = [
    ['an extra key', { ...HUB, extra: 'x' }],
    ['a missing key', { address: HUB.address, certPin: HUB.certPin }],
    ['a bad pin', { ...HUB, certPin: 'z'.repeat(64) }],
    ['a short pin', { ...HUB, certPin: 'a'.repeat(63) }],
    ['a bad address', { ...HUB, address: 'hub.example.org' }],
    ['a URL for an address', { ...HUB, address: 'https://hub.example.org:8443' }],
    ['a hub id for the writer', { ...HUB, writer: 'hub-0123456789abcdef' }],
    ['not an object', 'hub.example.org:8443'],
    ['a list', [HUB]],
    ['null', null]
  ];
  for (const [what, hub] of bad) {
    const signed = signPayload(state.world.lead.signer, 'staff-invite', { ...state.invite, hub }, { now: () => NOW });
    refusedAs(readInvite(asFile(signed), NOW), 'malformed');
    // The builder copies only the three named fields, so an extra key is dropped there (the test above); every other bad hub is refused.
    if (what !== 'an extra key') assert.throws(() => invitedThroughHub(hub), /The invitation was not made/, what);
  }
  // A __proto__ key inside the hub is an extra key.
  const text = asFile(invitedThroughHub().signed).replace('"address":', '"__proto__":{"x":1},"address":');
  refusedAs(readInvite(text, NOW), 'malformed');
});

test('D-48: hubJoinCheckKey is HKDF-SHA256 of the secret with info near-ai/hub-join/v1 and the invite id, 32 bytes, one per invitation, and reveals neither the secret nor its hash', () => {
  assert.equal(HUB_JOIN_INFO, 'near-ai/hub-join/v1');
  const secret = newJoinSecret();
  const key = hubJoinCheckKey(secret, 'inv-1');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  const expected = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'base64url'), Buffer.alloc(0), Buffer.concat([Buffer.from('near-ai/hub-join/v1', 'utf8'), Buffer.from('inv-1', 'utf8')]), 32)).toString('base64url');
  assert.equal(key, expected);
  assert.equal(hubJoinCheckKey(secret, 'inv-1'), key, 'the same inputs give the same key');
  assert.notEqual(hubJoinCheckKey(secret, 'inv-2'), key);
  assert.notEqual(hubJoinCheckKey(newJoinSecret(), 'inv-1'), key);
  assert.notEqual(key, secret);
  assert.notEqual(Buffer.from(key, 'base64url').toString('hex'), joinSecretHash(secret));
  assert.notEqual(Buffer.from(key, 'base64url').toString('hex'), Buffer.from(secret, 'base64url').toString('hex'));
  for (const [badSecret, badInvite] of [['short', 'inv-1'], [secret, 'Not A Slug'], [secret, '']]) {
    assert.throws(() => hubJoinCheckKey(badSecret, badInvite), /^Error: The hub check key was not made: /);
  }
});

test('D-48: joinRequestHash is sha256 hex of the canonical signed join request, the same for its text, its parsed value and any key order', () => {
  const state = invited();
  const text = answer(state);
  const request = requestOf(text);
  const hash = joinRequestHash(request);
  assert.equal(hash, createHash('sha256').update(canonicalBytes(request)).digest('hex'));
  assert.equal(joinRequestHash(text), hash);
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  assert.equal(joinRequestHash(reordered), hash);
  const changed = clone(request);
  changed.payload.name = 'Someone Else';
  assert.notEqual(joinRequestHash(changed), hash);
  assert.throws(() => joinRequestHash('not json'), /^Error: /);
});

test('D-48: hubJoinMac is HMAC-SHA256 under the check key over the hub, project, invite and request hash; checkHubJoinMac accepts it and refuses any one field changed or a MAC of the wrong length', () => {
  const state = invitedThroughHub();
  const { request, checkKey, fields } = joinThroughHub(state);
  const mac = hubJoinMac(checkKey, fields);
  const expected = createHmac('sha256', Buffer.from(checkKey, 'base64url')).update(canonicalBytes({ ...fields })).digest('base64url');
  assert.equal(mac, expected);
  assert.equal(checkHubJoinMac(checkKey, fields, mac), true);
  assert.equal(fields.request, joinRequestHash(request));
  const changed: Array<[keyof HubJoinMacFields, string]> = [
    ['hub', rosterDevice('OTHER-HUB', 'hub').writer], ['project', '0'.repeat(32)], ['invite', 'inv-other'], ['request', '0'.repeat(64)]
  ];
  for (const [field, value] of changed) assert.equal(checkHubJoinMac(checkKey, { ...fields, [field]: value }, mac), false, field);
  const bytes = Buffer.from(mac, 'base64url');
  assert.equal(checkHubJoinMac(checkKey, fields, bytes.subarray(0, 31).toString('base64url')), false);
  assert.equal(checkHubJoinMac(checkKey, fields, Buffer.concat([bytes, Buffer.from([1])]).toString('base64url')), false);
  for (const junk of ['', 'not a mac!', 7, null]) assert.equal(checkHubJoinMac(checkKey, fields, junk as string), false);
  assert.equal(checkHubJoinMac('short', fields, mac), false);
  assert.equal(checkHubJoinMac(hubJoinCheckKey(newJoinSecret(), INVITE_ID), fields, mac), false, 'another invitation\'s check key');
});

test('D-48: a hub MAC never verifies as the Phase 31 MAC and the Phase 31 MAC never verifies as a hub MAC', () => {
  const state = invitedThroughHub();
  const { request, checkKey, fields, join } = joinThroughHub(state);
  const phase31Mac = request.payload.mac;
  const hubMac = join.payload.hubMac;
  assert.notEqual(hubMac, phase31Mac);
  assert.equal(checkHubJoinMac(checkKey, fields, phase31Mac), false);
  // The secret itself is not the check key: a MAC under the secret over the hub fields does not pass, and the check key does not make the Phase 31 MAC.
  assert.equal(checkHubJoinMac(state.secret, fields, hubJoinMac(state.secret, fields)), true, 'the function is only a MAC');
  assert.equal(checkHubJoinMac(checkKey, fields, hubJoinMac(state.secret, fields)), false);
  assert.notEqual(joinMac(checkKey, request.payload), phase31Mac);
  // A request whose Phase 31 MAC is replaced by the hub MAC is refused by the lead's check with the real secret.
  const swapped = { ...request.payload, mac: hubMac };
  const resigned = signPayload(state.joiner.signer, 'staff-join-request', swapped, { now: () => NOW });
  refusedAs(checkJoinRequest(asFile(resigned), { invite: state.invite, secret: state.secret }), 'wrong-secret');
  // The honest request still passes the lead's check: the hub path adds a MAC and changes nothing in Phase 31.
  assert.equal(reasonOf(checkJoinRequest(asFile(request), { invite: state.invite, secret: state.secret })), 'ok');
});

test('D-48: buildHubJoin signs the hub join envelope with the joining device; readHubJoin accepts it for its own request, and the hub needs only the check key', () => {
  const state = invitedThroughHub();
  const { request, join, checkKey, fields } = joinThroughHub(state);
  assert.equal(join.purpose, 'staff-hub-join');
  assert.equal(join.signer.publicKey, state.joiner.publicKey);
  assert.deepEqual(join.payload, { v: 1, hub: HUB.writer, project: state.invite.project, invite: INVITE_ID, request: joinRequestHash(request), hubMac: hubJoinMac(checkKey, fields) });
  // The hub's side: the envelope and the request as they arrive in one post, then the MAC with the check key it was registered with.
  const read = readHubJoin(asFile(join), asFile(request));
  assert.equal(reasonOf(read), 'ok');
  const accepted = read as { ok: true; join: HubJoinPayload; writer: string };
  assert.deepEqual(accepted.join, join.payload);
  assert.equal(accepted.writer, state.joiner.writer);
  assert.equal(checkHubJoinMac(checkKey, { hub: accepted.join.hub, project: accepted.join.project, invite: accepted.join.invite, request: accepted.join.request }, accepted.join.hubMac), true);
  // Nothing the hub receives (the registration, the envelope and the request) carries the join secret or its roster hash.
  const received = JSON.stringify({ register: { invite: INVITE_ID, expiresAt: INVITE_EXPIRES, checkKey }, join, request });
  assert.equal(received.includes(state.secret), false);
  assert.equal(received.includes(joinSecretHash(state.secret)), false);
  // A device other than the request's own cannot make the envelope.
  assert.throws(() => buildHubJoin(state.world.device('MALLORY', 'mbr-mallory').signer, { hub: HUB.writer, project: state.invite.project, request, hubMac: join.payload.hubMac, now: NOW }), /^Error: The hub join was not made: /);
});

test('D-48: readHubJoin refuses an envelope signed by another device, for another request or invitation, with a changed field, or of the wrong shape', () => {
  const state = invitedThroughHub();
  const { request, join } = joinThroughHub(state);
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  // Another device signs an envelope for the joiner's request: wrong-device.
  refusedAs(readHubJoin(asFile(signPayload(mallory.signer, 'staff-hub-join', join.payload, { now: () => NOW })), request), 'wrong-device');
  // The joiner's envelope offered with another request of the same device (another nonce): the request hash does not match.
  const other = requestOf(answer(state));
  refusedAs(readHubJoin(asFile(join), other), 'wrong-device');
  // An envelope naming another invitation than its request.
  refusedAs(readHubJoin(asFile(signPayload(state.joiner.signer, 'staff-hub-join', { ...join.payload, invite: 'inv-other' }, { now: () => NOW })), request), 'wrong-device');
  // Any changed field breaks the signature.
  for (const field of ['hub', 'project', 'hubMac'] as const) {
    const changed = clone(join);
    changed.payload[field] = field === 'hub' ? rosterDevice('OTHER-HUB', 'hub').writer : field === 'project' ? '0'.repeat(32) : Buffer.alloc(32, 9).toString('base64url');
    refusedAs(readHubJoin(asFile(changed), request), 'bad-signature');
  }
  // A request whose own signature does not hold is refused too.
  const forgedRequest = clone(request);
  forgedRequest.payload.name = 'Someone Else';
  const forJoin = signPayload(state.joiner.signer, 'staff-hub-join', { ...join.payload, request: joinRequestHash(forgedRequest) }, { now: () => NOW });
  refusedAs(readHubJoin(asFile(forJoin), forgedRequest), 'bad-signature');
  // Wrong shapes.
  const base = join.payload as unknown as Json;
  for (const payload of [{ ...base, extra: 1 }, { ...base, v: 2 }, { ...base, hub: 'hub-0123456789abcdef' }, { ...base, request: 'x' }, { ...base, hubMac: 'short' }, { ...base, project: 'p' }]) {
    refusedAs(readHubJoin(asFile(signPayload(state.joiner.signer, 'staff-hub-join', payload, { now: () => NOW })), request), 'malformed');
  }
  // Another purpose: hubMac is not an exempt path of a join request, so a fixed value stands in for the random one.
  refusedAs(readHubJoin(asFile(signPayload(state.joiner.signer, 'staff-join-request', { ...base, hubMac: Buffer.alloc(32).toString('base64url') }, { now: () => NOW })), request), 'malformed');
  for (const input of ['not json', 'null', '{}', 'x'.repeat(MAX_PAYLOAD_BYTES + 1)]) refusedAs(readHubJoin(input, request), input.length > MAX_PAYLOAD_BYTES ? 'too-large' : 'malformed');
  refusedAs(readHubJoin(asFile(join), 'not json'), 'malformed');
  refusedAs(readHubJoin(asFile(join), { payload: {} }), 'malformed');
});

// ---- 33.2 D-03: post-quantum keys in a join request ----

const KEM_KEYS = kemPublicFromSeeds({ p256: createHash('sha256').update('jo kem p256').digest(), mlkem768: createHash('sha512').update('jo kem mlkem').digest() });

// The lead's invitation names the project's required features; the joiner answers with its post-quantum keys.
function invitedRequiring(requires: string[]): Invited {
  const state = invited();
  const signed = buildInvite(state.world.lead.signer, {
    genesisHash: state.genesis.hash, project: state.world.project, name: state.world.projectName, lead: { member: state.world.lead.member, x25519: state.world.lead.x25519 }, invite: INVITE_ID,
    secret: state.secret, expiresAt: INVITE_EXPIRES, now: NOW, requires
  });
  return { ...state, inviteText: asFile(signed), invite: signed.payload };
}

test('an invitation requiring wrap@2 lists it; the join request then carries kem, the lead accepts it, and both screens show the same words covering kem', () => {
  const state = invitedRequiring(['require@1', 'wrap@2']);
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const joinerInvite = (read as { ok: true; invite: InvitePayload }).invite;
  assert.deepEqual(joinerInvite.requires, ['require@1', 'wrap@2']);
  const requestText = answer(state, state.joiner, { kem: KEM_KEYS });
  const request = requestOf(requestText).payload;
  assert.deepEqual({ p256: request.kem?.p256, mlkem768: request.kem?.mlkem768 }, KEM_KEYS);
  const checked = checkJoinRequest(requestText, { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(checked), 'ok');
  const leadWords = inviteSafetyCode(state.invite, (checked as { ok: true; request: JoinRequestPayload }).request);
  const joinerWords = inviteSafetyCode(joinerInvite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519, nonce: request.nonce, kem: KEM_KEYS });
  assert.deepEqual(leadWords, joinerWords);
  assert.notDeepEqual(leadWords, inviteSafetyCode(joinerInvite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519, nonce: request.nonce }));
});

test('without wrap@2 in the invitation the joiner sends no kem, and a request that carries kem anyway is refused malformed (an older lead never meets unknown keys)', () => {
  const plain = invited();
  assert.equal(requestOf(answer(plain, plain.joiner, { kem: KEM_KEYS })).payload.kem, undefined);
  const requiring = invitedRequiring(['wrap@2']);
  const withKem = answer(requiring, requiring.joiner, { kem: KEM_KEYS });
  const { requires: _none, ...withoutRequires } = requiring.invite;
  assert.equal(reasonOf(checkJoinRequest(withKem, { invite: withoutRequires, secret: requiring.secret })), 'malformed');
  assert.equal(reasonOf(checkJoinRequest(withKem, { invite: { ...requiring.invite, requires: ['require@1'] }, secret: requiring.secret })), 'malformed');
});

test('a join request whose kem binding was made by another key is refused bad-binding; an invitation with an unsorted requires list is malformed', () => {
  const state = invitedRequiring(['wrap@2']);
  const signed = requestOf(answer(state, state.joiner, { kem: KEM_KEYS }));
  const other = rosterDevice('NOT-JO', JOINER_MEMBER);
  const forgedKem = { ...KEM_KEYS, sig: other.signer.sign(Buffer.from('not the binding')) };
  const resigned = signPayload(state.joiner.signer, 'staff-join-request', { ...signed.payload, kem: forgedKem }, { now: () => NOW });
  assert.equal(reasonOf(checkJoinRequest(asFile(resigned), { invite: state.invite, secret: state.secret })), 'bad-binding');
  const unsorted = { ...inviteObject(state), payload: { ...(inviteObject(state).payload as Json), requires: ['wrap@2', 'require@1'] } };
  assert.equal(reasonOf(readInvite(asFile(unsorted), NOW)), 'malformed');
});
