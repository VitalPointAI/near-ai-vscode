// Need-to-know across label cells (31-15; D-22, D-25; DESIGN 8.1 rules 4 and 6): a device below a cell never receives the cell's grant, cannot open
// its entries, and its fold output holds nothing from the cell; and an entry in a lower cell that cites a higher cell is refused write-down when the
// context supplies the cell order. Builders beyond the shared roster world live in this file (the helper is not edited in wave 6).
import assert from 'node:assert/strict';
import { WRAP_SECURITY_SENTENCES } from '../domain/replica/wrapFormat';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, sealLabel, wrapEpochKey } from '../domain/replica/cellKeys';
import type { CellGrant } from '../domain/replica/cellKeys';
import { clientIdOf } from '../domain/replica/clientIds';
import { createLocalDoc, localInsert } from '../domain/replica/doc';
import { addEntries, createFoldState, foldEntries } from '../domain/replica/fold';
import type { FoldResult } from '../domain/replica/fold';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { rosterView } from '../domain/replica/roster';
import type { ReplicaContext } from '../domain/replica/rosterView';
import type { ProductVersions } from '../domain/replica/versions';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { rng, shuffled, streamId, updateData } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const CELL_X = streamId('cell-x-leak');
const LABEL_X = { scale: 'demo', level: 'SECRET', compartments: ['KESTREL'], releasability: [], handling: [] };
const ROLES = { owner: 'j2-chief', sectionLead: 'j2-lead', releaseGuard: 'release-guard' };
const X_PRODUCT = 'kestrel-estimate';
const X_TITLE = 'Kestrel ridge estimate';
const X_TEXT = 'Kestrel watchers hold the northern ridge.';
const X_REASON = 'Kestrel sourcing is thin';

type Grant = SignedPayload<CellGrant>;

function cellGrant(world: RosterWorld, signer: RosterDevice, options: { cell: string; epoch: number; roster: string; to: readonly RosterDevice[]; label?: unknown }): Grant {
  const key = world.epochKeyOf(options.cell, options.epoch);
  const wraps = options.to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell: options.cell, epoch: options.epoch, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
  const labelSealed = options.label === undefined ? '' : sealLabel(key, options.cell, options.epoch, options.label);
  const signed = buildGrant(signer.signer, { cell: options.cell, epoch: options.epoch, roster: options.roster, labelSealed, wraps });
  world.grants.push(signed);
  return signed;
}

const productCreate = (product: string, title: string): Record<string, unknown> => ({ product, section: 'j2', roles: ROLES, title });
const productsOf = (result: FoldResult): ProductVersions[] => result.families.versions as ProductVersions[];

interface LeakScene {
  world: RosterWorld;
  lead: RosterDevice;
  reader: RosterDevice;
  create: Written;
  // Everything the lead wrote in cell X.
  inX: Written[];
  baseProduct: Written;
}

// Two cells: the base cell (everyone) and X (a higher label). Lead L is on both; member B only on the base cell. L writes a product in X with text,
// and a decision on it, and one product in the base cell.
function leakScene(): LeakScene {
  const world = createRosterWorld();
  const lead = world.lead;
  const reader = world.device('BE', 'mbr-be');
  const { entry: genesis } = world.genesis();
  const invite = world.rosterEntry(lead, 'member.invite', {
    invite: 'inv-be', name: 'Be Reader', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret())
  }, genesis.hash);
  const admit = world.rosterEntry(lead, 'member.admit', {
    member: reader.member, invite: 'inv-be', name: 'Be Reader', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: reader.descriptor(2), agentSeats: []
  }, invite.hash);
  world.grant(lead, { roster: admit.hash, to: [reader] });
  // The lead computes who is cleared for X at write time: only the lead. B is never a recipient.
  const founding = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: admit.hash, to: [lead], label: LABEL_X });
  const create = world.rosterEntry(lead, 'cell.create', { cell: CELL_X, epoch: 1, grant: grantHash(founding) }, admit.hash);
  const roster = create.hash;
  const product = world.write(lead, { stream: CELL_X, kind: 'product.create', data: productCreate(X_PRODUCT, X_TITLE), roster });
  const clientId = clientIdOf(1, 7);
  const client = world.write(lead, { stream: CELL_X, kind: 'doc.client', data: { product: X_PRODUCT, clientId, actor: { kind: 'person' } }, roster });
  const update = world.write(lead, { stream: CELL_X, kind: 'doc.update', data: updateData(X_PRODUCT, localInsert(createLocalDoc(clientId), 0, X_TEXT)), roster });
  const decision = world.write(lead, {
    stream: CELL_X, kind: 'version.decide', roster, deps: [product],
    data: { product: X_PRODUCT, hash: 'e'.repeat(64), outcome: 'reject', reasons: [X_REASON], decisionsSeen: [] }
  });
  const baseProduct = world.write(lead, { kind: 'product.create', data: productCreate('base-summary', 'Daily summary'), roster });
  return { world, lead, reader, create, inX: [product, client, update, decision], baseProduct };
}

test('label leak: a device not cleared for cell X never receives its grant, holds every X entry missing-key, and its fold output has no X product, label or decision', () => {
  const { world, lead, reader, create, inX, baseProduct } = leakScene();
  // What is delivered to B: only the grants with a wrap for B (P-31-20). None of them is for X.
  const forReader = world.grants.filter((grant) => grant.payload.wraps.some((wrap) => wrap.writer === reader.writer));
  assert.ok(forReader.length > 0);
  assert.ok(forReader.every((grant) => grant.payload.cell !== CELL_X));
  const readerRing = world.ringFor(reader, forReader);
  assert.equal(readerRing(CELL_X, 1), undefined);
  const readerRoster = world.foldRoster({ keys: readerRing, grants: forReader });
  assert.deepEqual(readerRoster.refused, []);
  // B's roster knows the cell id exists (its roster entry is in the base cell) and nothing about who holds it.
  assert.equal(rosterView(readerRoster).cellGrantees?.(CELL_X, create.hash), undefined);
  // Every entry is offered to B's fold, X's included, sealed.
  const result = foldEntries(world.entries, world.ctxFor(readerRoster, readerRing));
  for (const written of inX) {
    assert.equal(result.held.find((item) => item.hash === written.hash)?.reason, 'missing-key', written.hash);
    assert.ok(!result.applied.includes(written.hash));
    assert.ok(!result.refused.some((item) => item.hash === written.hash));
    assert.ok(!result.kept.some((item) => item.hash === written.hash));
  }
  assert.ok(result.applied.includes(baseProduct.hash));
  assert.deepEqual(productsOf(result).map((product) => product.product), ['base-summary']);
  assert.equal(result.digests[CELL_X], undefined);
  // The whole serialised output, searched for X's product name, title, text, decision reason and label tokens, finds nothing.
  const serialised = JSON.stringify(result);
  for (const secret of [X_PRODUCT, 'Kestrel', 'KESTREL', 'SECRET', X_REASON]) assert.ok(!serialised.includes(secret), secret);

  // The lead's machine, with the X grant, folds the same entries and does see the product, its text and the decision: the test is not empty.
  const leadRoster = world.foldRoster();
  assert.deepEqual(rosterView(leadRoster).cellGrantees?.(CELL_X, create.hash), [lead.writer]);
  const leadResult = foldEntries(world.entries, world.ctxFor(leadRoster, world.ringFor(lead)));
  for (const written of inX) assert.ok(leadResult.applied.includes(written.hash), written.hash);
  assert.deepEqual(productsOf(leadResult).map((product) => product.product).sort(), ['base-summary', X_PRODUCT].sort());
  assert.ok(JSON.stringify(leadResult.families).includes(X_TEXT));
});

interface DownScene {
  world: RosterWorld;
  project: string;
  baseOne: Written;
  upInX: Written;
  downInBase: Written;
  afterInBase: Written;
  ctx: ReplicaContext;
  ordered: ReplicaContext;
}

// The lead alone, on both cells. baseOne is in the base cell; upInX in X cites it (write up); downInBase in the base cell cites upInX (write down);
// afterInBase follows downInBase in the lead's base-cell chain without citing anything.
function downScene(): DownScene {
  const world = createRosterWorld({ projectLabel: 'write-down-project' });
  const lead = world.lead;
  const { entry: genesis } = world.genesis();
  const founding = cellGrant(world, lead, { cell: CELL_X, epoch: 1, roster: genesis.hash, to: [lead] });
  const create = world.rosterEntry(lead, 'cell.create', { cell: CELL_X, epoch: 1, grant: grantHash(founding) }, genesis.hash);
  const roster = create.hash;
  const baseOne = world.write(lead, { kind: 'product.create', data: productCreate('base-one', 'Base one'), roster });
  const upInX = world.write(lead, { stream: CELL_X, kind: 'product.create', data: productCreate('cell-two', 'Cell two'), roster, deps: [baseOne] });
  const downInBase = world.write(lead, { kind: 'product.create', data: productCreate('base-three', 'Base three'), roster, deps: [upInX] });
  const afterInBase = world.write(lead, { kind: 'product.create', data: productCreate('base-four', 'Base four'), roster });
  const ctx = world.ctxFor(world.foldRoster(), world.ringFor(lead));
  const project = world.project;
  // X dominates the base cell; each cell dominates itself.
  const ordered: ReplicaContext = { ...ctx, cellOrder: (citing, cited) => citing === cited || (citing === CELL_X && cited === project) };
  return { world, project, baseOne, upInX, downInBase, afterInBase, ctx, ordered };
}

test('write up, never down: with the cell order an X entry citing the base cell applies and a base entry citing X is refused write-down; without it both apply', () => {
  const { world, baseOne, upInX, downInBase, afterInBase, ctx, ordered } = downScene();
  const withOrder = foldEntries(world.entries, ordered);
  for (const written of [baseOne, upInX, afterInBase]) assert.ok(withOrder.applied.includes(written.hash), written.hash);
  assert.deepEqual(withOrder.refused, [{ hash: downInBase.hash, reason: 'write-down', family: 'versions' }]);
  // Still a node of the lead's chain: the next base entry is admitted and applied.
  assert.ok(withOrder.order.includes(downInBase.hash));
  assert.ok(!withOrder.applied.includes(downInBase.hash));
  assert.deepEqual(productsOf(withOrder).map((product) => product.product).sort(), ['base-four', 'base-one', 'cell-two']);
  // Without the cell order (Phase 30 behaviour) every citation is allowed.
  const without = foldEntries(world.entries, ctx);
  assert.deepEqual(without.refused, []);
  for (const written of [baseOne, upInX, downInBase, afterInBase]) assert.ok(without.applied.includes(written.hash), written.hash);
  // A cell order that allows every citation changes nothing either.
  const open = foldEntries(world.entries, { ...ctx, cellOrder: () => true });
  assert.deepEqual(open.applied, without.applied);
  assert.deepEqual(open.families, without.families);
});

test('incremental and from-scratch folds agree on the write-down cases, in every delivery order tried and with and without the cell order', () => {
  const { world, ctx, ordered } = downScene();
  for (const context of [ordered, ctx]) {
    const scratch = foldEntries(world.entries, context);
    const random = rng(31_15);
    for (let round = 0; round < 6; round += 1) {
      const order = round === 0 ? [...world.entries] : round === 1 ? [...world.entries].reverse() : shuffled(world.entries, random);
      let state = createFoldState(context);
      for (const entry of order) state = addEntries(state, [entry]);
      assert.deepEqual(state.result, scratch, `round ${round}`);
      // Two batches give the same result too.
      const half = Math.floor(order.length / 2);
      const batched = addEntries(addEntries(createFoldState(context), order.slice(0, half)), order.slice(half));
      assert.deepEqual(batched.result, scratch, `round ${round} batched`);
    }
  }
});

test('SECURITY.md has the cell keys subsection once, inside the multi-user section, with the precise verified and pending key boundaries and no em-dash', () => {
  const text = readFileSync(path.resolve(__dirname, '..', '..', 'SECURITY.md'), 'utf8');
  const heading = '### Cell keys, wraps and rekey';
  assert.equal(text.split('\n').filter((line) => line === heading).length, 1);
  const start = text.indexOf('## Multi-user staff projects (preview)');
  const section = text.slice(start, text.indexOf('\n## ', start + 1));
  assert.ok(section.includes(heading));
  const subsection = section.slice(section.indexOf(heading));
  const terms = subsection.replace(/\s+/g, ' ');
  assert.ok(terms.includes('After a verified rotation, an affected cell has a new key wrapped to devices that still have access.'));
  assert.ok(terms.includes('A device that lost access keeps what it received under the old key.'));
  assert.ok(terms.includes('This computer pauses ordinary writes when it verifies that a revoked device received the current key.'));
  assert.ok(terms.includes('Roster recovery remains available.'));
  assert.ok(terms.includes('A computer can still write under an old key while it is waiting for an earlier grant that would show the revoked device held it (G552),'));
  assert.ok(terms.includes('or while rotation after a clearance reduction is pending (G551).'));
  for (const phrase of ['X25519', 'HKDF-SHA256', 'AES-256-GCM', 'signed', 'earlier epochs', 'write up, never down']) assert.ok(subsection.toLowerCase().includes(phrase.toLowerCase()), phrase);
  assert.doesNotMatch(text, /\u2014/);
});

test('SECURITY.md has "How cell keys are wrapped" once, inside the multi-user section, with every sentence of WRAP_SECURITY_SENTENCES word for word (33.2 D-11)', () => {
  const text = readFileSync(path.resolve(__dirname, '..', '..', 'SECURITY.md'), 'utf8');
  const heading = '### How cell keys are wrapped';
  assert.equal(text.split('\n').filter((line) => line === heading).length, 1);
  const start = text.indexOf('## Multi-user staff projects (preview)');
  const section = text.slice(start, text.indexOf('\n## ', start + 1));
  assert.ok(section.includes(heading));
  const after = section.slice(section.indexOf(heading) + heading.length);
  const subsection = after.slice(0, after.indexOf('\n### ')).replace(/\s+/g, ' ');
  for (const sentence of WRAP_SECURITY_SENTENCES) assert.ok(subsection.includes(sentence), sentence);
  for (const phrase of ['ML-KEM-768', 'P-256', 'HKDF-SHA256', 'AES-256-GCM', 'ITSP.40.111']) assert.ok(subsection.includes(phrase), phrase);
});
