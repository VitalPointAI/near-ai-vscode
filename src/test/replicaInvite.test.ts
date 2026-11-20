// Joining by file (D-14 to D-18, D-37): the invite file, the join request file and the welcome file, read the way a person's files arrive, as JSON
// text from any channel. One named test per refusal, the invited -> join-requested transition (DESIGN 15.1), the safety code on both screens, and the
// welcome file that lets a new device catch up on the roster with only the grants addressed to it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvite, buildJoinRequest, checkJoinRequest, inviteSafetyCode, joinMac, joinSecretHash, newJoinSecret, readInvite } from '../domain/replica/invite';
import type { InvitePayload, JoinRequestPayload } from '../domain/replica/invite';
import { signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_NOW, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
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
function invited(options: { expiresAt?: string } = {}): Invited {
  const world = createRosterWorld();
  const joiner = world.device('JO', JOINER_MEMBER);
  const { entry: genesis } = world.genesis();
  const secret = newJoinSecret();
  const expiresAt = options.expiresAt ?? INVITE_EXPIRES;
  const inviteEntry = world.rosterEntry(world.lead, 'member.invite', {
    invite: INVITE_ID, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt, secretHash: joinSecretHash(secret)
  }, genesis.hash);
  const signed = buildInvite(world.lead.signer, {
    genesisHash: genesis.hash, project: world.project, name: world.projectName, lead: { member: world.lead.member, x25519: world.lead.x25519 }, invite: INVITE_ID, secret, expiresAt, now: NOW
  });
  const inviteText = asFile(signed);
  return { world, joiner, genesis, inviteEntry, secret, inviteText, invite: signed.payload };
}

// The joiner's side: read the invite text, answer it with this device, return the request as text.
function answer(state: Invited, device: RosterDevice = state.joiner): string {
  const read = readInvite(state.inviteText, NOW);
  assert.equal(reasonOf(read), 'ok');
  const invite = (read as { ok: true; invite: InvitePayload }).invite;
  return asFile(buildJoinRequest(device.signer, invite, { name: 'Jo Analyst', x25519: device.x25519, now: NOW }));
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
  const joinerWords = inviteSafetyCode(joinerInvite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519 });
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
  const fields = { invite: original.invite, genesisHash: original.genesisHash, name: original.name, publicKey: original.publicKey, x25519: mallory.x25519 };
  const payload: JoinRequestPayload = { ...fields, x25519Sig: original.x25519Sig, mac: joinMac(state.secret, fields) };
  const resigned = signPayload(state.joiner.signer, 'staff-join-request', payload, { now: () => NOW });
  const checked = checkJoinRequest(asFile(resigned), { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(checked), 'bad-binding');
});

test('a request fully re-made by another device with a stolen invite file checks, but its safety code differs from the joiner\'s (D-16)', () => {
  const state = invited();
  const mallory = state.world.device('MALLORY', 'mbr-mallory');
  const stolen = checkJoinRequest(answer(state, mallory), { invite: state.invite, secret: state.secret });
  assert.equal(reasonOf(stolen), 'ok');
  const leadWords = inviteSafetyCode(state.invite, (stolen as { ok: true; request: JoinRequestPayload }).request);
  const joinerWords = inviteSafetyCode(state.invite, { publicKey: state.joiner.publicKey, x25519: state.joiner.x25519 });
  assert.equal(leadWords.length, 6);
  assert.notDeepEqual(leadWords, joinerWords);
  // Only the X25519 key substituted (the signing key kept) also changes the words.
  const halfSwap = inviteSafetyCode(state.invite, { publicKey: state.joiner.publicKey, x25519: mallory.x25519 });
  assert.notDeepEqual(halfSwap, joinerWords);
});
