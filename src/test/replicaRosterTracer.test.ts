// The WP-R1 tracer (31-CONTEXT "Specific Ideas"): genesis by the lead, one invite file, one join request file, the same safety code on both sides,
// admission, one cell grant opened by the new device, and one doc.update from the new device accepted by the main fold through the real roster view.
// It also pins the module seams the wave-6 plans build on: which module owns each roster kind, and that a kind whose rule is not written yet is
// refused and changes nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { KIND_FAMILIES } from '../domain/replica/kinds';
import { unwrapEpochKey } from '../domain/replica/cellKeys';
import { buildInvite, buildJoinRequest, checkJoinRequest, joinSecretHash, newJoinSecret, readInvite } from '../domain/replica/invite';
import type { InvitePayload } from '../domain/replica/invite';
import { ORIGIN_ROSTER, ROSTER_KIND_OWNER, ROSTER_REFUSALS, foldRoster, rosterView } from '../domain/replica/roster';
import type { RosterAnchor, RosterState } from '../domain/replica/roster';
import { safetyCode, safetyCodeText } from '../domain/replica/safetyCode';
import type { ProductTextOutput } from '../domain/replica/textFold';
import { DEMO_CLEARANCE, INVITE_EXPIRES, ROSTER_NOW, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const INVITE_ID = 'inv-jo';
const JOINER_MEMBER = 'mbr-jo';

interface Joined {
  world: RosterWorld;
  joiner: RosterDevice;
  genesis: Written;
  invite: Written;
  admit: Written;
  inviteFile: unknown;
  invitePayload: InvitePayload;
  secret: string;
  request: unknown;
}

// The lead writes the genesis and an invitation, the joiner answers it by file, the lead checks the answer and admits the joiner's device at slot 2,
// then grants the base cell's epoch 1 to it at the admission roster. Files travel as JSON text, as a person would carry them.
function joinScenario(): Joined {
  const world = createRosterWorld();
  const joiner = world.device('JO', JOINER_MEMBER);
  const { entry: genesis } = world.genesis();
  const secret = newJoinSecret();
  const invite = world.rosterEntry(world.lead, 'member.invite', {
    invite: INVITE_ID, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(secret)
  }, genesis.hash);
  const inviteFile: unknown = JSON.parse(JSON.stringify(buildInvite(world.lead.signer, {
    genesisHash: genesis.hash, project: world.project, name: world.projectName, lead: { member: world.lead.member, x25519: world.lead.x25519 }, invite: INVITE_ID, secret, expiresAt: INVITE_EXPIRES, now: new Date(ROSTER_NOW)
  })));
  // The joiner's side: read the file before it expires, then answer it.
  const read = readInvite(inviteFile, new Date(ROSTER_NOW));
  assert.equal(read.ok, true);
  const invitePayload = (read as { ok: true; invite: InvitePayload }).invite;
  const request: unknown = JSON.parse(JSON.stringify(buildJoinRequest(joiner.signer, invitePayload, { name: 'Jo Analyst', x25519: joiner.x25519, now: new Date(ROSTER_NOW) })));
  // The lead's side: the answer checks with the secret the lead kept, and then the lead admits.
  const checked = checkJoinRequest(request, { invite: invitePayload, secret });
  assert.equal(checked.ok, true);
  const admit = world.rosterEntry(world.lead, 'member.admit', {
    member: JOINER_MEMBER, invite: INVITE_ID, name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: joiner.descriptor(2), agentSeats: []
  }, invite.hash);
  world.grant(world.lead, { roster: admit.hash, to: [joiner] });
  return { world, joiner, genesis, invite, admit, inviteFile, invitePayload, secret, request };
}

// The joiner's roster: folded from the entries and every grant, with the key ring the joiner opens from its own grant.
function joinerRoster(joined: Joined): RosterState {
  return joined.world.foldRoster({ keys: joined.world.ringFor(joined.joiner) });
}

function productOf(result: FoldResult): ProductTextOutput {
  const products = result.families.doc as ProductTextOutput[];
  assert.equal(products.length, 1);
  return products[0];
}

test('15.1 invited -> join-requested: the joining device reads the invite file and writes a join request the lead checks with the secret; another secret is refused wrong-secret', () => {
  const joined = joinScenario();
  const { world, invitePayload, secret, request } = joined;
  assert.equal(invitePayload.genesisHash, joined.genesis.hash);
  assert.equal(invitePayload.lead.writer, world.lead.writer);
  const checked = checkJoinRequest(request, { invite: invitePayload, secret });
  assert.equal(checked.ok, true);
  assert.equal((checked as { writer: string }).writer, joined.joiner.writer);
  // A request whose MAC was made with another secret: an invite file with the same id but another secret, answered by the same device.
  const otherFile = buildInvite(world.lead.signer, { genesisHash: invitePayload.genesisHash, project: world.project, name: world.projectName, lead: { member: world.lead.member, x25519: world.lead.x25519 }, invite: INVITE_ID, secret: newJoinSecret(), expiresAt: INVITE_EXPIRES, now: new Date(ROSTER_NOW) });
  const forged = buildJoinRequest(joined.joiner.signer, otherFile.payload, { name: 'Jo Analyst', x25519: joined.joiner.x25519, now: new Date(ROSTER_NOW) });
  const refused = checkJoinRequest(JSON.parse(JSON.stringify(forged)), { invite: invitePayload, secret });
  assert.deepEqual(refused.ok ? 'ok' : refused.reason, 'wrong-secret');
  // A changed field after signing is a bad signature; an invite read after its expiry is refused.
  const tampered = JSON.parse(JSON.stringify(request)) as { payload: { name: string } };
  tampered.payload.name = 'Someone Else';
  const tamperedCheck = checkJoinRequest(tampered, { invite: invitePayload, secret });
  assert.equal(tamperedCheck.ok ? 'ok' : tamperedCheck.reason, 'bad-signature');
  const late = readInvite(joined.inviteFile, new Date('2026-11-27T00:00:00.000Z'));
  assert.equal(late.ok ? 'ok' : late.reason, 'invite-expired');
  // The roster carries only the hash of the secret, never the secret: read the opened invite entry through the lead's roster fold.
  const record = world.foldRoster().members.invites.get(INVITE_ID);
  assert.equal(record?.secretHash, joinSecretHash(secret));
  assert.ok(!JSON.stringify(record).includes(secret));
});

test('both sides compute the same six-word safety code from the invite and the request, and the secret is not an input', () => {
  const joined = joinScenario();
  const { invitePayload } = joined;
  const request = (joined.request as { payload: { publicKey: string; x25519: string; nonce: string } }).payload;
  // The lead's side reads the joiner's keys and nonce from the request; the joiner's side uses its own keys and the nonce it drew.
  const leadSide = safetyCode({ invite: invitePayload.invite, genesisHash: invitePayload.genesisHash, lead: invitePayload.lead, inviter: invitePayload.inviter, joiner: { publicKey: request.publicKey, x25519: request.x25519 }, nonce: request.nonce });
  const joinerSide = safetyCode({ invite: invitePayload.invite, genesisHash: invitePayload.genesisHash, lead: { publicKey: invitePayload.lead.publicKey, x25519: invitePayload.lead.x25519 }, inviter: { publicKey: invitePayload.inviter.publicKey, x25519: invitePayload.inviter.x25519 }, joiner: { publicKey: joined.joiner.publicKey, x25519: joined.joiner.x25519 }, nonce: request.nonce });
  assert.equal(leadSide.length, 6);
  assert.deepEqual(leadSide, joinerSide);
  assert.equal(safetyCodeText(leadSide), leadSide.join(' '));
  // A substituted joining key gives other words.
  const other = joined.world.device('MALLORY', 'mbr-mallory');
  const substituted = safetyCode({ invite: invitePayload.invite, genesisHash: invitePayload.genesisHash, lead: invitePayload.lead, inviter: invitePayload.inviter, joiner: { publicKey: other.publicKey, x25519: other.x25519 }, nonce: request.nonce });
  assert.notDeepEqual(substituted, leadSide);
});

test('15.1 join-requested -> active: the lead admits the device and grants the base cell; the new device opens its wrap and folds the roster to origin, genesis, invite, admit', () => {
  const joined = joinScenario();
  const { world, joiner, genesis, invite, admit } = joined;
  const ring = world.ringFor(joiner);
  assert.deepEqual(ring(world.project, 1), world.epochKeyOf(world.project, 1));
  const state = joinerRoster(joined);
  assert.deepEqual(state.positions, [ORIGIN_ROSTER, genesis.hash, invite.hash, admit.hash]);
  assert.deepEqual(state.refused, []);
  assert.deepEqual(state.pending, []);
  const view = rosterView(state);
  assert.equal(view.isAdmitted(joiner.writer, admit.hash), true);
  assert.equal(view.isAdmitted(joiner.writer, invite.hash), false);
  assert.equal(view.memberName(JOINER_MEMBER, admit.hash), 'Jo Analyst');
  assert.equal(view.hasRole(JOINER_MEMBER, 'member', admit.hash), true);
  assert.equal(view.hasRole(world.lead.member, 'staff_lead', ORIGIN_ROSTER), true);
  assert.equal(view.hasRole(world.lead.member, 'staff_lead', admit.hash), true);
  assert.equal(view.hasRole(JOINER_MEMBER, 'staff_lead', admit.hash), false);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 0), admit.hash), joiner.writer);
  assert.equal(view.clientIdOwner?.(clientIdOf(1, 0), admit.hash), world.lead.writer);
  assert.equal(view.clientIdOwner?.(clientIdOf(2, 0), invite.hash), undefined);
  assert.equal(view.deviceEncryptionKey?.(joiner.writer, admit.hash), joiner.x25519);
  assert.deepEqual(view.cellGrantees?.(world.project, admit.hash), [joiner.writer, world.lead.writer].sort());
  assert.deepEqual(view.cellGrantees?.(world.project, invite.hash), [world.lead.writer]);
  // The lead's own fold, with the lead's key ring, reaches the same line.
  assert.deepEqual(world.foldRoster().positions, state.positions);
  // Without a key for the roster stream nothing past the origin can be read.
  assert.deepEqual(world.foldRoster({ keys: () => undefined }).positions, [ORIGIN_ROSTER]);
});

function joinerWrites(joined: Joined, clientId: number): { client: Written; update: Written } {
  const doc = createLocalDoc(clientId);
  const client = joined.world.write(joined.joiner, { kind: 'doc.client', data: { product: PRODUCT, clientId, actor: { kind: 'person' } }, roster: joined.admit.hash });
  const update = joined.world.write(joined.joiner, { kind: 'doc.update', data: updateData(PRODUCT, localInsert(doc, 0, 'Enemy holds the ridge.')), roster: joined.admit.hash });
  return { client, update };
}

test('one doc.update from the new device is accepted by the main fold through the real roster view and attributed to its writer and member', () => {
  const joined = joinScenario();
  const { client, update } = joinerWrites(joined, clientIdOf(2, 0));
  const ring = joined.world.ringFor(joined.joiner);
  const state = joinerRoster(joined);
  const result = foldEntries(joined.world.entries, joined.world.ctxFor(state, ring));
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.held, []);
  assert.ok(result.applied.includes(client.hash));
  assert.ok(result.applied.includes(update.hash));
  // The genesis is accepted by the project reducer because the lead holds staff_lead at the origin roster it cites.
  assert.ok(result.applied.includes(joined.genesis.hash));
  const product = productOf(result);
  assert.equal(product.text, 'Enemy holds the ridge.');
  assert.deepEqual(product.attribution.map((span) => [span.writer, span.member, span.clientId]), [[joined.joiner.writer, JOINER_MEMBER, clientIdOf(2, 0)]]);
});

test('the same doc.client by the new device under a client id in the lead slot range is refused foreign-client-id through the real roster view', () => {
  const joined = joinScenario();
  const { client, update } = joinerWrites(joined, clientIdOf(1, 0));
  const state = joinerRoster(joined);
  const result = foldEntries(joined.world.entries, joined.world.ctxFor(state, joined.world.ringFor(joined.joiner)));
  assert.equal(result.refused.find((item) => item.hash === client.hash)?.reason, 'foreign-client-id');
  assert.ok(!result.applied.includes(update.hash));
});

test('a wrap opens only for the device it is addressed to: another private key, a changed cell, epoch or device id fails', () => {
  const joined = joinScenario();
  const { world, joiner } = joined;
  const grant = world.grants[world.grants.length - 1].payload;
  const wrap = grant.wraps[0];
  assert.equal(wrap.writer, joiner.writer);
  const open = (overrides: Partial<{ cell: string; epoch: number; writer: string; privateKey: RosterDevice['x25519Private'] }>): Buffer | undefined =>
    unwrapEpochKey({ cell: grant.cell, epoch: grant.epoch, writer: joiner.writer, privateKey: joiner.x25519Private, wrap: wrap.wrap, ...overrides });
  assert.deepEqual(open({}), world.epochKeyOf(world.project, 1));
  assert.equal(open({ privateKey: world.lead.x25519Private }), undefined);
  assert.equal(open({ cell: 'f'.repeat(32) }), undefined);
  assert.equal(open({ epoch: 2 }), undefined);
  assert.equal(open({ writer: world.lead.writer }), undefined);
  // A changed byte and a wrong length are refused too.
  const bytes = Buffer.from(wrap.wrap, 'base64url');
  bytes[bytes.length - 1] ^= 1;
  assert.equal(unwrapEpochKey({ cell: grant.cell, epoch: grant.epoch, writer: joiner.writer, privateKey: joiner.x25519Private, wrap: bytes.toString('base64url') }), undefined);
  assert.equal(unwrapEpochKey({ cell: grant.cell, epoch: grant.epoch, writer: joiner.writer, privateKey: joiner.x25519Private, wrap: wrap.wrap.slice(4) }), undefined);
});

test('only the lead device writes the roster: an invite by the admitted member is refused not-a-roster-writer, and a genesis that is not the pinned one is refused', () => {
  const joined = joinScenario();
  const { world, joiner, admit } = joined;
  const byMember = world.rosterEntry(joiner, 'member.invite', {
    invite: 'inv-other', name: 'Other Person', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, admit.hash);
  const state = joinerRoster(joined);
  assert.deepEqual(state.refused, [{ hash: byMember.hash, kind: 'member.invite', reason: 'not-a-roster-writer' }]);
  assert.equal(state.positions[state.positions.length - 1], admit.hash);
  // A machine that pinned another genesis hash starts nowhere from this one.
  const anchor = { ...world.anchor(), genesisHash: 'a'.repeat(64) };
  const other = rosterFromAnchor(world, anchor, joined.joiner);
  assert.deepEqual(other.positions, [ORIGIN_ROSTER]);
  assert.equal(other.refused.find((item) => item.hash === joined.genesis.hash)?.reason, 'not-the-pinned-genesis');
});

function rosterFromAnchor(world: RosterWorld, anchor: RosterAnchor, device: RosterDevice): RosterState {
  return foldRoster({ entries: world.entries, anchor, keys: world.ringFor(device), blobs: (hash) => world.blobs.get(hash), grants: world.grants, now: new Date(ROSTER_NOW) });
}

test('every roster refusal reason is a plain sentence without an em-dash', () => {
  for (const [reason, text] of Object.entries(ROSTER_REFUSALS)) {
    assert.ok(text.length > 20 && text.endsWith('.'), reason);
    assert.ok(!text.includes('\u2014'), reason);
  }
  // Every routed kind is a known kind of the closed list.
  for (const kind of Object.keys(ROSTER_KIND_OWNER)) assert.ok(KIND_FAMILIES.has(kind), kind);
});

test('ROSTER_KIND_OWNER routes each of the 35 roster kinds and project.genesis to exactly one owner module', () => {
  const rosterKinds = [...KIND_FAMILIES].filter(([, family]) => family === 'roster').map(([kind]) => kind);
  assert.equal(rosterKinds.length, 35, 'includes the signed cell.access.commit roster transition');
  assert.deepEqual(Object.keys(ROSTER_KIND_OWNER).sort(), [...rosterKinds, 'project.genesis'].sort());
  for (const [kind, owner] of Object.entries(ROSTER_KIND_OWNER)) {
    const positions = /^(position|posting|authority)\./.test(kind) || kind === 'cell.rekey.staged' || kind === 'project.mode';
    const expected = kind === 'cell.access.commit' ? 'roster' :
      positions ? 'positions' : /^(member|device|hub|invite)\./.test(kind) ? 'members' : /^cell\./.test(kind) ? 'cells' : 'roster';
    assert.equal(owner, expected, kind);
  }
  assert.deepEqual(Object.entries(ROSTER_KIND_OWNER).filter(([, owner]) => owner === 'roster').map(([kind]) => kind).sort(), ['cell.access.commit', 'deputy.name', 'lead.handover', 'project.genesis', 'roster.choose', 'roster.require']);
  assert.deepEqual(Object.entries(ROSTER_KIND_OWNER).filter(([, owner]) => owner === 'cells').map(([kind]) => kind).sort(), ['cell.create', 'cell.rekey']);
  assert.ok(Object.isFrozen(ROSTER_KIND_OWNER));
});

test('every roster kind that waited on a later plan now has its rule: none of them is refused roster-kind-pending, in any owner module', () => {
  const joined = joinScenario();
  const { world, admit } = joined;
  const base = [...world.entries];
  const keys = world.ringFor(joined.joiner);
  // These kinds were refused roster-kind-pending after 31-12; 31-14 wrote the members rules, 31-15 the cell rules and 31-17 the roster rules.
  const once: Array<[string, Record<string, unknown>]> = [
    ['member.update', { member: JOINER_MEMBER, roles: ['member', 'observer'], agentSeats: ['release-guard'] }],
    ['member.remove', { member: JOINER_MEMBER }],
    ['device.revoke', { member: JOINER_MEMBER, writer: joined.joiner.writer }],
    ['invite.void', { invite: INVITE_ID }],
    ['cell.create', { cell: 'c'.repeat(32), epoch: 1, grant: 'd'.repeat(64) }],
    ['deputy.name', { member: JOINER_MEMBER }],
    ['lead.handover', { to: JOINER_MEMBER, reason: 'planned' }]
  ];
  for (const [kind, data] of once) {
    const written = world.rosterEntry(world.lead, kind, data, admit.hash);
    const state = world.foldRoster({ entries: [...base, written.entry], keys });
    assert.ok(!state.refused.some((r) => r.hash === written.hash && r.reason === 'roster-kind-pending'), kind);
  }
  // Between them they cover all three owner modules.
  assert.deepEqual([...new Set(once.map(([kind]) => ROSTER_KIND_OWNER[kind]))].sort(), ['cells', 'members', 'roster']);
  // The refusal reason stays, with its plain sentence, for a kind a newer version adds.
  assert.ok(ROSTER_REFUSALS['roster-kind-pending'].length > 20);
});
