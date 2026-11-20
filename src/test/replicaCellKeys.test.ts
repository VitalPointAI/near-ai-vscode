// Label cells and their keys (31-15; D-21 to D-23, D-44, D-45; DESIGN 8.2, 8.3): cell.create and cell.rekey in the roster fold with the founding grant
// committed by hash, grant checks at the roster each grant names, grantees per cell, rekey plans for removals, revocations and lowered clearances,
// earlier epochs for a device admitted later, and the cell label sealed inside each grant.
// Builders beyond the shared roster world live in this file (the helper is not edited in wave 6).
import assert from 'node:assert/strict';
import test from 'node:test';
import { REKEY_KEEP_TEXT, buildGrant, grantHash, openLabel, planRekey, sealLabel, unwrapEpochKey, wrapEpochKey } from '../domain/replica/cellKeys';
import type { CellGrant } from '../domain/replica/cellKeys';
import { CELL_REFUSALS } from '../domain/replica/rosterCells';
import { rosterView } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
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
    assert.ok(text.length > 20 && text.endsWith('.') && !text.includes('—'), reason);
  }
});
