// Label cells and their keys (31-15; D-21 to D-23, D-44, D-45; DESIGN 8.2, 8.3): cell.create and cell.rekey in the roster fold with the founding grant
// committed by hash, grant checks at the roster each grant names, grantees per cell, rekey plans for removals, revocations and lowered clearances,
// earlier epochs for a device admitted later, and the cell label sealed inside each grant.
// Builders beyond the shared roster world live in this file (the helper is not edited in wave 6).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { GRANT_MAX_BYTES, MAX_GRANT_WRAPS, MAX_LABEL_BYTES, REKEY_KEEP_TEXT, WRAP_BYTES, buildGrant, grantHash, openLabel, planRekey, readGrant, sealLabel, unwrapEpochKey, wrapEpochKey } from '../domain/replica/cellKeys';
import { earlierEpochGrants } from '../domain/replica/grantPages';
import type { RekeyReason } from '../domain/replica/cellKeys';
import type { CellGrant } from '../domain/replica/cellKeys';
import { CELL_REFUSALS, epochsAt, granteesAt } from '../domain/replica/rosterCells';
import { deviceAt } from '../domain/replica/rosterMembers';
import type { MembersState } from '../domain/replica/rosterMembers';
import { rosterView } from '../domain/replica/roster';
import { CELL_REKEY_REASONS } from '../domain/replica/kindSchemas/roster';
import type { RosterState } from '../domain/replica/roster';
import { canonicalBytes } from '../domain/team/canonical';
import { MAX_PAYLOAD_BYTES } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { streamId } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';

const CELL_X = streamId('cell-x');
const CELL_Y = streamId('cell-y');
// The cell's label (DESIGN 4.1): fictional tokens on the demo scale. It travels sealed inside the grant, so only a cleared device learns it.
const LABEL_X = { scale: 'demo', level: 'SECRET', compartments: ['KESTREL'], releasability: [], handling: [] };

type Grant = SignedPayload<CellGrant>;

// A grant for any cell and epoch with the label sealed in it. The key is the world's key for the cell and epoch, so entries the world writes in that
// cell open with it. Pushed into world.grants like the helper's own grants.
function cellGrant(world: RosterWorld, signer: RosterDevice, options: { cell: string; epoch: number; roster: string; to: readonly RosterDevice[]; label?: unknown }): Grant {
  const key = world.epochKeyOf(options.cell, options.epoch);
  const wraps = options.to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell: options.cell, epoch: options.epoch, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
  const labelSealed = options.label === undefined ? '' : sealLabel(key, options.cell, options.epoch, options.label);
  const signed = buildGrant(signer.signer, { cell: options.cell, epoch: options.epoch, roster: options.roster, labelSealed, wraps });
  world.grants.push(signed);
  return signed;
}

interface CellScene {
  world: RosterWorld;
  lead: RosterDevice;
  member: RosterDevice;
  genesis: Written;
  admit: Written;
  // The roster entries up to the admission, and the grants delivered up to then (the base cell's).
  base: Written[];
  baseGrants: Grant[];
}

// The lead founds the project and admits member M's device at slot 2, then grants M the base cell.
function admitted(): CellScene {
  const world = createRosterWorld();
  const lead = world.lead;
  const member = world.device('MO', 'mbr-mo');
  const { entry: genesis } = world.genesis();
  const invite = world.rosterEntry(lead, 'member.invite', {
    invite: 'inv-mo', name: 'Mo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, genesis.hash);
  const admit = world.rosterEntry(lead, 'member.admit', {
    member: member.member, invite: 'inv-mo', name: 'Mo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: member.descriptor(2), agentSeats: []
  }, invite.hash);
  world.grant(lead, { roster: admit.hash, to: [member] });
  return { world, lead, member, genesis, admit, base: [genesis, invite, admit], baseGrants: [...world.grants] };
}

interface CreatedScene extends CellScene { create: Written; founding: Grant }

// The lead creates cell X citing the admission roster, with the founding grant of epoch 1 wrapped to the lead and M.
function createdX(): CreatedScene {
  const scene = admitted();
  const { world, lead, member, admit } = scene;
  const founding = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: admit.hash, to: [lead, member], label: LABEL_X });
  const create = world.rosterEntry(lead, 'cell.create', { cell: CELL_X, epoch: 1, grant: grantHash(founding) }, admit.hash);
  return { ...scene, create, founding };
}

const fold = (world: RosterWorld, entries: readonly Written[], grants: readonly Grant[]): RosterState =>
  world.foldRoster({ entries: entries.map((written) => written.entry), grants });

const grantRefusals = (state: RosterState): Array<[string, string]> =>
  state.refused.filter((item) => item.kind === 'grant').map((item): [string, string] => [item.hash, item.reason]);

test('cell.create founds epoch 1 of a cell: the founding grant it commits to lists the lead and M as grantees, and M opens its wrap and reads the label', () => {
  const scene = createdX();
  const { world, lead, member, create, founding } = scene;
  const state = fold(world, [...scene.base, create], [...scene.baseGrants, founding]);
  assert.deepEqual(state.refused, []);
  assert.equal(state.positions[state.positions.length - 1], create.hash);
  const view = rosterView(state);
  assert.deepEqual(view.cellGrantees?.(CELL_X, create.hash), [lead.writer, member.writer].sort());
  // Before the cell.create applies, the roster does not know the cell.
  assert.equal(view.cellGrantees?.(CELL_X, scene.admit.hash), undefined);
  // M's machine: the wrap addressed to M opens the epoch key, and the key opens the label sealed in the grant.
  const ring = world.ringFor(member, [founding]);
  const key = ring(CELL_X, 1);
  assert.deepEqual(key, world.epochKeyOf(CELL_X, 1));
  assert.deepEqual(openLabel(key as Buffer, CELL_X, 1, founding.payload.labelSealed), LABEL_X);
});

test('a grant is refused unless it is the committed one, signed by a roster writer, and wrapped only to devices admitted at the roster it names', () => {
  const scene = createdX();
  const { world, lead, member, admit, create, founding } = scene;
  const stranger = world.device('STRANGER', 'mbr-stranger');
  // Another grant for X epoch 1 at the founding roster: its hash is not the commitment.
  const forged = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: admit.hash, to: [lead] });
  // A later grant of epoch 1 that wraps the key to a device never admitted.
  const toStranger = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: create.hash, to: [lead, stranger] });
  // A later grant of epoch 1 signed by M's device, which is admitted but may not write the roster.
  const byMember = cellGrant(world, member, { cell: CELL_X, epoch: 1, roster: create.hash, to: [member] });
  // A grant for an epoch the roster has not founded.
  const unknownEpoch = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: create.hash, to: [lead] });
  const state = fold(world, [...scene.base, create], [...scene.baseGrants, founding, forged, toStranger, byMember, unknownEpoch]);
  assert.deepEqual(grantRefusals(state).sort(), [
    [grantHash(forged), 'grant-mismatch'],
    [grantHash(toStranger), 'grant-recipient'],
    [grantHash(byMember), 'grant-signer'],
    [grantHash(unknownEpoch), 'grant-epoch-unknown']
  ].sort());
  // None of the refused grants changes who holds the cell.
  assert.deepEqual(rosterView(state).cellGrantees?.(CELL_X, create.hash), [lead.writer, member.writer].sort());
  // The committed grant alone, with the forged one first in the list, is still placed: the order grants arrive in decides nothing.
  const reordered = fold(world, [...scene.base, create], [forged, ...scene.baseGrants, founding]);
  assert.deepEqual(rosterView(reordered).cellGrantees?.(CELL_X, create.hash), [lead.writer, member.writer].sort());
});

test('removal: planRekey drops M from X, cell.rekey moves X to epoch 2 wrapped only to the lead, and M keeps epoch 1 but cannot open epoch 2', () => {
  const scene = createdX();
  const { world, lead, member, create, founding } = scene;
  const before = rosterView(fold(world, [...scene.base, create], [...scene.baseGrants, founding]));
  // member.remove itself is 31-14's; the host passes the grantees from the view and the devices cleared now (31-20 runs the whole removal).
  const plans = planRekey({
    change: { kind: 'member-removed', writers: [member.writer] },
    cells: [{ cell: CELL_X, grantees: [...(before.cellGrantees?.(CELL_X, create.hash) ?? [])], clearedNow: [lead.writer] }]
  });
  assert.deepEqual(plans, [{ cell: CELL_X, reason: 'member-removed', recipients: [lead.writer], dropped: [member.writer], text: REKEY_KEEP_TEXT }]);
  assert.equal(plans[0].text, 'They keep what they already received. They will not receive anything new.');
  const recipients = plans[0].recipients.map((writer) => [lead, member].find((device) => device.writer === writer) as RosterDevice);
  const next = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: create.hash, to: recipients, label: LABEL_X });
  const rekey = world.rosterEntry(lead, 'cell.rekey', { cell: CELL_X, epoch: 2, reason: 'member-removed', grant: grantHash(next) }, create.hash);
  const state = fold(world, [...scene.base, create, rekey], [...scene.baseGrants, founding, next]);
  assert.deepEqual(state.refused, []);
  const view = rosterView(state);
  assert.deepEqual(view.cellGrantees?.(CELL_X, rekey.hash), [lead.writer]);
  // Answers at the earlier roster do not change.
  assert.deepEqual(view.cellGrantees?.(CELL_X, create.hash), [lead.writer, member.writer].sort());
  // M's machine holds only the grants addressed to it: epoch 1 opens, epoch 2 has no wrap for M, and the lead's wrap does not open with M's key.
  const ring = world.ringFor(member, [founding, next]);
  assert.deepEqual(ring(CELL_X, 1), world.epochKeyOf(CELL_X, 1));
  assert.equal(ring(CELL_X, 2), undefined);
  assert.equal(next.payload.wraps.some((wrap) => wrap.writer === member.writer), false);
  const leadWrap = next.payload.wraps[0];
  assert.equal(unwrapEpochKey({ cell: CELL_X, epoch: 2, writer: member.writer, privateKey: member.x25519Private, wrap: leadWrap.wrap }), undefined);
  assert.equal(unwrapEpochKey({ cell: CELL_X, epoch: 2, writer: lead.writer, privateKey: member.x25519Private, wrap: leadWrap.wrap }), undefined);
  // The lead opens epoch 2.
  assert.deepEqual(world.ringFor(lead, [next])(CELL_X, 2), world.epochKeyOf(CELL_X, 2));
});

test('a grant of the new epoch that names a roster from before the rekey is refused grant-epoch-unknown, so a removed device cannot be slipped in through it', () => {
  // At the admission roster M is still admitted, so the recipient check alone would pass; the epoch does not exist there, so the grant is refused.
  const scene = createdX();
  const { world, lead, member, admit, create, founding } = scene;
  const next = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: create.hash, to: [lead] });
  const rekey = world.rosterEntry(lead, 'cell.rekey', { cell: CELL_X, epoch: 2, reason: 'member-removed', grant: grantHash(next) }, create.hash);
  const early = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: admit.hash, to: [lead, member] });
  const state = fold(world, [...scene.base, create, rekey], [...scene.baseGrants, founding, next, early]);
  assert.deepEqual(grantRefusals(state), [[grantHash(early), 'grant-epoch-unknown']]);
  assert.deepEqual(rosterView(state).cellGrantees?.(CELL_X, rekey.hash), [lead.writer]);
});

test('cell.create and cell.rekey refusals: cell-exists, cell-unknown, epoch-not-next and grant-missing, each changing no position or answer', () => {
  const scene = createdX();
  const { world, lead, create, founding } = scene;
  const grants = [...scene.baseGrants, founding];
  const reference = fold(world, [...scene.base, create], grants);
  const hash = grantHash(founding);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['cell.create', { cell: CELL_X, epoch: 1, grant: hash }, 'cell-exists'],
    ['cell.create', { cell: CELL_Y, epoch: 2, grant: hash }, 'epoch-not-next'],
    ['cell.create', { cell: CELL_Y, epoch: 1 }, 'grant-missing'],
    ['cell.create', { cell: CELL_Y, grant: hash }, 'epoch-not-next'],
    ['cell.rekey', { cell: CELL_Y, epoch: 2, reason: 'scheduled', grant: hash }, 'cell-unknown'],
    ['cell.rekey', { cell: CELL_X, epoch: 3, reason: 'scheduled', grant: hash }, 'epoch-not-next'],
    ['cell.rekey', { cell: CELL_X, epoch: 1, reason: 'scheduled', grant: hash }, 'epoch-not-next'],
    ['cell.rekey', { cell: CELL_X, epoch: 2, reason: 'scheduled' }, 'grant-missing']
  ];
  for (const [kind, data, reason] of cases) {
    const written = world.rosterEntry(lead, kind, data, create.hash);
    const state = fold(world, [...scene.base, create, written], grants);
    assert.deepEqual(state.refused, [{ hash: written.hash, kind, reason }], `${kind} ${reason}`);
    assert.deepEqual(state.positions, reference.positions, `${kind} ${reason}`);
    assert.deepEqual(rosterView(state).cellGrantees?.(CELL_X, create.hash), rosterView(reference).cellGrantees?.(CELL_X, create.hash));
    assert.equal(rosterView(state).cellGrantees?.(CELL_Y, create.hash), undefined);
  }
  for (const reason of ['cell-exists', 'cell-unknown', 'epoch-not-next', 'grant-missing', 'grant-mismatch', 'grant-signer', 'grant-recipient', 'grant-epoch-unknown'] as const) {
    const text = CELL_REFUSALS[reason];
    assert.ok(text.length > 20 && text.endsWith('.') && !text.includes('\u2014'), reason);
  }
});

// ---- every rekey reason (D-23) ----

// Writer ids for the planning tests: planRekey reads only ids, never keys.
const W = (letter: string): string => letter.repeat(64);
const [LEAD_W, M1, M2, D1, D2, HUB] = ['a', 'b', 'c', 'd', 'e', 'f'].map(W);

test('planRekey for device-revoked drops only the revoked device, plans each cell it was on, and leaves the other cells alone', () => {
  const plans = planRekey({
    change: { kind: 'device-revoked', writers: [M2] },
    cells: [
      // The host's cleared list may still name the revoked device: a revocation drops it anyway.
      { cell: CELL_X, grantees: [LEAD_W, M1, M2], clearedNow: [LEAD_W, M1, M2] },
      { cell: CELL_Y, grantees: [M2, LEAD_W], clearedNow: [LEAD_W] },
      { cell: streamId('cell-z'), grantees: [LEAD_W, M1], clearedNow: [LEAD_W, M1] }
    ]
  });
  assert.deepEqual(plans, [
    { cell: CELL_X, reason: 'device-revoked', recipients: [LEAD_W, M1], dropped: [M2], text: REKEY_KEEP_TEXT },
    { cell: CELL_Y, reason: 'device-revoked', recipients: [LEAD_W], dropped: [M2], text: REKEY_KEEP_TEXT }
  ].sort((a, b) => (a.cell < b.cell ? -1 : 1)));
});

test('planRekey for clearance-lowered drops the member\'s devices only from the cells their clearance no longer covers and keeps the others', () => {
  const cellZ = streamId('cell-z');
  const plans = planRekey({
    change: { kind: 'clearance-lowered', writers: [D1, D2] },
    cells: [
      // X is above the lowered clearance: neither device is cleared now.
      { cell: CELL_X, grantees: [LEAD_W, D1, D2, M1], clearedNow: [LEAD_W, M1] },
      // Y is still covered: both devices stay, so no rekey.
      { cell: CELL_Y, grantees: [LEAD_W, D1, D2], clearedNow: [LEAD_W, D1, D2] },
      // Z never had the member: no rekey, even though another grantee is not cleared now (that is another change's rekey).
      { cell: cellZ, grantees: [LEAD_W, M2], clearedNow: [LEAD_W] }
    ]
  });
  assert.deepEqual(plans, [{ cell: CELL_X, reason: 'clearance-lowered', recipients: [LEAD_W, M1], dropped: [D1, D2], text: REKEY_KEEP_TEXT }]);
});

test('planRekey for hub-revoked plans the hub device\'s cells; scheduled is a new epoch for every cell to the same cleared recipients; recipients are never uncleared', () => {
  const cells = [
    { cell: CELL_X, grantees: [LEAD_W, M1, HUB], clearedNow: [LEAD_W, M1, HUB] },
    { cell: CELL_Y, grantees: [LEAD_W, M1], clearedNow: [LEAD_W, M1] }
  ];
  assert.deepEqual(planRekey({ change: { kind: 'hub-revoked', writers: [HUB] }, cells }), [
    { cell: CELL_X, reason: 'hub-revoked', recipients: [LEAD_W, M1], dropped: [HUB], text: REKEY_KEEP_TEXT }
  ]);
  const scheduled = planRekey({ change: { kind: 'scheduled', writers: [] }, cells });
  assert.deepEqual(scheduled.map((plan) => [plan.cell, plan.recipients, plan.dropped]).sort(), [
    [CELL_X, [LEAD_W, M1, HUB].sort(), []],
    [CELL_Y, [LEAD_W, M1], []]
  ].sort());
  // P-31-20: a grantee the host no longer counts as cleared is never a recipient of the new key, whatever the reason.
  const stale = planRekey({ change: { kind: 'scheduled', writers: [] }, cells: [{ cell: CELL_X, grantees: [LEAD_W, M1], clearedNow: [LEAD_W] }] });
  assert.deepEqual([stale[0].recipients, stale[0].dropped], [[LEAD_W], [M1]]);
  for (const reason of CELL_REKEY_REASONS) {
    const plans = planRekey({ change: { kind: reason, writers: [M1] }, cells: [{ cell: CELL_X, grantees: [LEAD_W, M1], clearedNow: [LEAD_W] }] });
    assert.ok(plans.every((plan) => !plan.recipients.includes(M1) && plan.text === REKEY_KEEP_TEXT), reason);
  }
  assert.throws(() => planRekey({ change: { kind: 'tidy-up' as RekeyReason, writers: [] }, cells }));
});

test('after a device-revoked rekey the grantees at the rekey roster are the new grant\'s recipients, and a device the members module no longer admits is never listed', () => {
  const scene = createdX();
  const { world, lead, member, create, founding } = scene;
  const plans = planRekey({ change: { kind: 'device-revoked', writers: [member.writer] }, cells: [{ cell: CELL_X, grantees: [lead.writer, member.writer], clearedNow: [lead.writer, member.writer] }] });
  assert.deepEqual(plans.map((plan) => plan.recipients), [[lead.writer]]);
  const next = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: create.hash, to: [lead] });
  const rekey = world.rosterEntry(lead, 'cell.rekey', { cell: CELL_X, epoch: 2, reason: 'device-revoked', grant: grantHash(next) }, create.hash);
  const state = fold(world, [...scene.base, create, rekey], [...scene.baseGrants, founding, next]);
  assert.deepEqual(state.refused, []);
  assert.deepEqual(rosterView(state).cellGrantees?.(CELL_X, rekey.hash), [lead.writer]);
  // device.revoke itself is 31-14's: a members state where M's device ends at the cell.create position stands in for it.
  const createAt = state.positionOf.get(create.hash) as number;
  const members = structuredClone(state.members) as MembersState;
  const versions = members.devices.get(member.writer) ?? [];
  for (const version of versions) version.until = createAt;
  const admittedIn = (source: MembersState) => (writer: string): boolean => deviceAt(source, writer, createAt) !== undefined;
  assert.deepEqual(granteesAt(state.cells, CELL_X, createAt, admittedIn(state.members)), [lead.writer, member.writer].sort());
  assert.deepEqual(granteesAt(state.cells, CELL_X, createAt, admittedIn(members)), [lead.writer]);
});

// ---- earlier epochs for a device admitted later (D-45) ----

test('a device admitted at epoch 3 receives one grant per epoch 1, 2 and 3, each valid at the admission roster and each opening with its own key', () => {
  const scene = createdX();
  const { world, lead, member, create, founding } = scene;
  const second = cellGrant(world, lead, { cell: CELL_X, epoch: 2, roster: create.hash, to: [lead], label: LABEL_X });
  const rekey2 = world.rosterEntry(lead, 'cell.rekey', { cell: CELL_X, epoch: 2, reason: 'member-removed', grant: grantHash(second) }, create.hash);
  const third = cellGrant(world, lead, { cell: CELL_X, epoch: 3, roster: rekey2.hash, to: [lead], label: LABEL_X });
  const rekey3 = world.rosterEntry(lead, 'cell.rekey', { cell: CELL_X, epoch: 3, reason: 'scheduled', grant: grantHash(third) }, rekey2.hash);
  const newcomer = world.device('NU', 'mbr-nu');
  const invite = world.rosterEntry(lead, 'member.invite', {
    invite: 'inv-nu', name: 'Nu Planner', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, rekey3.hash);
  const admitNu = world.rosterEntry(lead, 'member.admit', {
    member: newcomer.member, invite: 'inv-nu', name: 'Nu Planner', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: newcomer.descriptor(3), agentSeats: []
  }, invite.hash);
  const entries = [...scene.base, create, rekey2, rekey3, invite, admitNu];
  const before = fold(world, entries, [...scene.baseGrants, founding, second, third]);
  const epochs = epochsAt(before.cells, CELL_X, before.positionOf.get(admitNu.hash) as number).map((item) => ({ epoch: item.epoch, key: world.epochKeyOf(CELL_X, item.epoch) }));
  assert.deepEqual(epochs.map((item) => item.epoch), [1, 2, 3]);
  const history = earlierEpochGrants(lead.signer, { cell: CELL_X, epochs, roster: admitNu.hash, writer: newcomer.writer, recipient: newcomer.x25519, label: LABEL_X });
  assert.equal(history.length, 3);
  const state = fold(world, entries, [...scene.baseGrants, founding, second, third, ...history]);
  assert.deepEqual(state.refused, []);
  const ring = world.ringFor(newcomer, history);
  for (const epoch of [1, 2, 3]) {
    const key = ring(CELL_X, epoch);
    assert.deepEqual(key, world.epochKeyOf(CELL_X, epoch), `epoch ${epoch}`);
    assert.deepEqual(openLabel(key as Buffer, CELL_X, epoch, history[epoch - 1].payload.labelSealed), LABEL_X);
  }
  const view = rosterView(state);
  assert.deepEqual(view.cellGrantees?.(CELL_X, admitNu.hash), [lead.writer, newcomer.writer].sort());
  assert.deepEqual(view.cellGrantees?.(CELL_X, rekey3.hash), [lead.writer]);
  // M, removed from X at epoch 2, still holds only epoch 1.
  const memberRing = world.ringFor(member, [founding, second, third, ...history]);
  assert.deepEqual([1, 2, 3].map((epoch) => memberRing(CELL_X, epoch) !== undefined), [true, false, false]);
  // The same grants named at a roster before the device was admitted, or signed by a member device, are refused.
  const early = earlierEpochGrants(lead.signer, { cell: CELL_X, epochs: epochs.slice(2), roster: rekey3.hash, writer: newcomer.writer, recipient: newcomer.x25519 });
  const byMember = earlierEpochGrants(member.signer, { cell: CELL_X, epochs: epochs.slice(2), roster: admitNu.hash, writer: newcomer.writer, recipient: newcomer.x25519 });
  const refused = fold(world, entries, [...scene.baseGrants, founding, second, third, ...early, ...byMember]);
  assert.deepEqual(grantRefusals(refused).sort(), [[grantHash(early[0]), 'grant-recipient'], [grantHash(byMember[0]), 'grant-signer']].sort());
  assert.throws(() => earlierEpochGrants(lead.signer, { cell: CELL_X, epochs: [], roster: admitNu.hash, writer: newcomer.writer, recipient: newcomer.x25519 }));
});

test('a wrap copied from one grant into another cell\'s or another epoch\'s grant fails to open', () => {
  const scene = createdX();
  const { world, lead, member, admit, founding } = scene;
  const mine = founding.payload.wraps.find((wrap) => wrap.writer === member.writer);
  assert.ok(mine !== undefined);
  const copiedToY = buildGrant(lead.signer, { cell: CELL_Y, epoch: 1, roster: admit.hash, labelSealed: '', wraps: [mine] });
  const copiedToEpoch2 = buildGrant(lead.signer, { cell: CELL_X, epoch: 2, roster: admit.hash, labelSealed: '', wraps: [mine] });
  const ring = world.ringFor(member, [copiedToY, copiedToEpoch2]);
  assert.equal(ring(CELL_Y, 1), undefined);
  assert.equal(ring(CELL_X, 2), undefined);
  assert.equal(unwrapEpochKey({ cell: CELL_Y, epoch: 1, writer: member.writer, privateKey: member.x25519Private, wrap: mine.wrap }), undefined);
  assert.equal(unwrapEpochKey({ cell: CELL_X, epoch: 2, writer: member.writer, privateKey: member.x25519Private, wrap: mine.wrap }), undefined);
  // The original still opens.
  assert.deepEqual(world.ringFor(member, [founding])(CELL_X, 1), world.epochKeyOf(CELL_X, 1));
});

test('a machine without the founding grant of the current epoch does not know who holds the cell, and a sealed label opens only under its own key, cell and epoch', () => {
  const scene = createdX();
  const { world, lead, member, create, founding } = scene;
  // The roster says the cell exists (its roster entry is in the base cell), but the grantees are unknown without the grant.
  const withoutGrant = fold(world, [...scene.base, create], scene.baseGrants);
  assert.deepEqual(withoutGrant.refused, []);
  assert.equal(rosterView(withoutGrant).cellGrantees?.(CELL_X, create.hash), undefined);
  assert.deepEqual(epochsAt(withoutGrant.cells, CELL_X, withoutGrant.positionOf.get(create.hash) as number).map((item) => item.grant), [grantHash(founding)]);
  // An additional grant without the founding one does not make the grantees known either.
  const extra = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: create.hash, to: [member] });
  assert.equal(rosterView(fold(world, [...scene.base, create], [...scene.baseGrants, extra])).cellGrantees?.(CELL_X, create.hash), undefined);
  const key = world.epochKeyOf(CELL_X, 1);
  const sealed = founding.payload.labelSealed;
  assert.deepEqual(openLabel(key, CELL_X, 1, sealed), LABEL_X);
  assert.equal(openLabel(world.epochKeyOf(CELL_X, 2), CELL_X, 1, sealed), undefined);
  assert.equal(openLabel(key, CELL_Y, 1, sealed), undefined);
  assert.equal(openLabel(key, CELL_X, 2, sealed), undefined);
  assert.equal(openLabel(key, CELL_X, 1, ''), undefined);
  const changedSeal = Buffer.from(sealed, 'base64url');
  changedSeal[changedSeal.length - 1] ^= 1;
  assert.equal(openLabel(key, CELL_X, 1, changedSeal.toString('base64url')), undefined);
  assert.equal(openLabel(key, CELL_X, 1, 'not base64url!'), undefined);
  // The sealed form is not the label in clear, and two seals of one label differ (a fresh iv each time).
  assert.ok(!Buffer.from(sealed, 'base64url').toString('utf8').includes('KESTREL'));
  assert.notEqual(sealLabel(key, CELL_X, 1, LABEL_X), sealLabel(key, CELL_X, 1, LABEL_X));
  assert.throws(() => sealLabel(key, CELL_X, 1, { text: 'x'.repeat(7000) }));
});

test('MN-04: a grant to the most devices a project can hold, with the longest label, is signed and reads back; one more wrap is refused by shape, not by size', () => {
  const lead = createRosterWorld().lead;
  const key = Buffer.alloc(32, 7);
  // Wraps of the right length (a wrap is checked by shape when a grant is signed or read; only its own device opens it), one per slot.
  const wraps = Array.from({ length: MAX_GRANT_WRAPS + 1 }, (_, index) => ({
    writer: createHash('sha256').update(`mn04/${index}`).digest('hex'),
    wrap: Buffer.concat([createHash('sha512').update(`mn04/wrap/${index}`).digest(), createHash('sha512').update(`mn04/more/${index}`).digest()]).subarray(0, WRAP_BYTES).toString('base64url')
  }));
  const label = { text: 'x'.repeat(MAX_LABEL_BYTES - 20) };
  const labelSealed = sealLabel(key, CELL_X, 1, label);
  const full = buildGrant(lead.signer, { cell: CELL_X, epoch: 1, roster: '0'.repeat(64), labelSealed, wraps: wraps.slice(0, MAX_GRANT_WRAPS) });
  const size = canonicalBytes(full).length;
  assert.ok(size > MAX_PAYLOAD_BYTES, `the full grant (${size} bytes) is larger than other signed items`);
  assert.ok(size <= GRANT_MAX_BYTES, `the full grant (${size} bytes) fits the grant limit`);
  const read = readGrant(full);
  assert.ok(read.ok, 'the full grant reads');
  assert.equal(read.grant.wraps.length, MAX_GRANT_WRAPS);
  assert.deepEqual(openLabel(key, CELL_X, 1, read.grant.labelSealed), label);
  assert.throws(() => buildGrant(lead.signer, { cell: CELL_X, epoch: 1, roster: '0'.repeat(64), labelSealed, wraps }), { message: 'The grant was not signed: bad wraps.' });
});
