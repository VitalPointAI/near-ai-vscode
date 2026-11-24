// The cutover rule (33.2-05 Task 1; 33.2-CONTEXT D-06): after roster.require names wrap@2, an epoch founded later may carry no X25519 wrap on any
// grant or page; epochs founded before keep theirs and may still be granted either way. The rule reads only roster positions. Fictional people.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildGrant, grantHash, wrapEpochKey } from '../domain/replica/cellKeys';
import type { CellGrant, GrantWrap } from '../domain/replica/cellKeys';
import { kemPublicFromSeeds, wrapEpochKeyV2 } from '../domain/replica/cellWrapV2';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import type { RosterState } from '../domain/replica/roster';
import { granteesAt } from '../domain/replica/rosterCells';
import { WRAP_FEATURE, WRAP_FORMAT_REFUSALS, wrapFormatFor, wrapFormatProblem } from '../domain/replica/wrapFormat';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';
import { streamId } from './helpers/replicaWorld';
import type { Written } from './helpers/replicaWorld';

const KEM = kemPublicFromSeeds({ p256: createHash('sha256').update('cutover p256').digest(), mlkem768: createHash('sha512').update('cutover mlkem').digest() });
const CELL_A = streamId('cutover-a');
const CELL_B = streamId('cutover-b');

interface Scene { world: RosterWorld; pat: RosterDevice; head: string }

// The lead admits Pat (slot 2).
function scene(): Scene {
  const world = createRosterWorld();
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  const { entry: genesis } = world.genesis();
  const invite = world.rosterEntry(world.lead, 'member.invite', { invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) }, genesis.hash);
  const admit = world.rosterEntry(world.lead, 'member.admit', { member: 'mbr-pat', invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: pat.descriptor(2), agentSeats: [] }, invite.hash);
  return { world, pat, head: admit.hash };
}

const v1To = (s: Scene, device: RosterDevice, cell: string, epoch: number): GrantWrap => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch, writer: device.writer, recipient: device.x25519, epochKey: s.world.epochKeyOf(cell, epoch) }) });
const v2To = (s: Scene, device: RosterDevice, cell: string, epoch: number): GrantWrap => ({ writer: device.writer, wrap: wrapEpochKeyV2({ cell, epoch, writer: device.writer, recipient: KEM, epochKey: s.world.epochKeyOf(cell, epoch) }) });

// A one-page grant: v1 only builds the v1 grant; any v2 wrap makes a page (pages: []).
function grant(s: Scene, cell: string, epoch: number, roster: string, wraps: GrantWrap[]): SignedPayload<CellGrant> {
  const paged = wraps.some((item) => Buffer.from(item.wrap, 'base64url').length !== 92);
  return buildGrant(s.world.lead.signer, { cell, epoch, roster, labelSealed: '', wraps, ...(paged ? { pages: [] } : {}) });
}

function create(s: Scene, cell: string, wraps: (cell: string) => GrantWrap[]): { entry: Written; grant: SignedPayload<CellGrant> } {
  const founding = grant(s, cell, 1, s.head, wraps(cell));
  const entry = s.world.rosterEntry(s.world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) }, s.head);
  s.head = entry.hash;
  return { entry, grant: founding };
}

function switchOn(s: Scene): Written {
  const entry = s.world.rosterEntry(s.world.lead, 'roster.require', { features: [WRAP_FEATURE] }, s.head);
  s.head = entry.hash;
  return entry;
}

const fold = (s: Scene, grants: readonly unknown[], entries: readonly unknown[] = s.world.entries): RosterState => s.world.foldRoster({ entries, grants: [...s.world.grants, ...grants] });
const refusedReason = (state: RosterState, signed: unknown): string | undefined => state.refused.find((item) => item.hash === grantHash(signed))?.reason;
const holders = (state: RosterState, cell: string): readonly string[] | undefined => granteesAt(state.cells, cell, state.positions.length - 1, () => true);

test('wrapFormatProblem: no switch, or an epoch founded at or before it, allows v1; after it one v1 wrap is refused and all-v2 is fine', () => {
  const s = scene();
  const v1 = { wraps: [v1To(s, s.pat, CELL_A, 1)] };
  const v2 = { wraps: [v2To(s, s.pat, CELL_A, 1)] };
  const mixed = { wraps: [v2To(s, s.world.lead, CELL_A, 1), v1To(s, s.pat, CELL_A, 1)] };
  assert.equal(wrapFormatProblem(v1, 9, undefined), undefined);
  assert.equal(wrapFormatProblem(v1, 5, 5), undefined);
  assert.equal(wrapFormatProblem(v1, 6, 5), 'old-wrap-after-switch');
  assert.equal(wrapFormatProblem(mixed, 6, 5), 'old-wrap-after-switch');
  assert.equal(wrapFormatProblem(v2, 6, 5), undefined);
  assert.ok(WRAP_FORMAT_REFUSALS['old-wrap-after-switch'].length > 0);
});

test('wrapFormatFor: either before the switch and for an epoch founded before it; v2 for later epochs and for a new epoch once switched', () => {
  assert.equal(wrapFormatFor(undefined, 3), 'either');
  assert.equal(wrapFormatFor(5, 4), 'either');
  assert.equal(wrapFormatFor(5, 6), 'v2');
  assert.equal(wrapFormatFor(5, undefined), 'v2');
});

test('before the switch a v1 grant and a v2 page both fold', () => {
  const s = scene();
  const a = create(s, CELL_A, (cell) => [v1To(s, s.world.lead, cell, 1), v1To(s, s.pat, cell, 1)]);
  const b = create(s, CELL_B, (cell) => [v2To(s, s.world.lead, cell, 1), v2To(s, s.pat, cell, 1)]);
  const state = fold(s, [a.grant, b.grant]);
  assert.equal(holders(state, CELL_A)?.length, 2);
  assert.equal(holders(state, CELL_B)?.length, 2);
});

test('after the switch a new epoch whose grant holds one v1 wrap is refused old-wrap-after-switch; an all-v2 grant folds', () => {
  const s = scene();
  switchOn(s);
  const mixed = create(s, CELL_A, (cell) => [v2To(s, s.world.lead, cell, 1), v1To(s, s.pat, cell, 1)]);
  const clean = create(s, CELL_B, (cell) => [v2To(s, s.world.lead, cell, 1), v2To(s, s.pat, cell, 1)]);
  const state = fold(s, [mixed.grant, clean.grant]);
  assert.equal(refusedReason(state, mixed.grant), 'old-wrap-after-switch');
  assert.equal(holders(state, CELL_A), undefined, 'the epoch has no placed founding grant');
  assert.equal(holders(state, CELL_B)?.length, 2);
});

test('a later grant of an epoch founded before the switch may hold v1 or v2 wraps', () => {
  const s = scene();
  const a = create(s, CELL_A, (cell) => [v1To(s, s.world.lead, cell, 1)]);
  const switched = switchOn(s);
  const laterV1 = grant(s, CELL_A, 1, switched.hash, [v1To(s, s.pat, CELL_A, 1)]);
  const state = fold(s, [a.grant, laterV1]);
  assert.equal(refusedReason(state, laterV1), undefined);
  assert.ok(holders(state, CELL_A)?.includes(s.pat.writer));
});

test('every fold order gives the same refusals and holders (the rule reads roster positions only)', () => {
  const s = scene();
  const before = create(s, CELL_A, (cell) => [v1To(s, s.world.lead, cell, 1)]);
  switchOn(s);
  const after = create(s, CELL_B, (cell) => [v1To(s, s.world.lead, cell, 1)]);
  const expected = fold(s, [before.grant, after.grant]);
  assert.equal(refusedReason(expected, after.grant), 'old-wrap-after-switch');
  let seed = 11;
  const random = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 6; round += 1) {
    const shuffled = [...s.world.entries].sort(() => random() - 0.5);
    const grants = random() < 0.5 ? [after.grant, before.grant] : [before.grant, after.grant];
    const state = fold(s, grants, shuffled);
    assert.equal(refusedReason(state, after.grant), 'old-wrap-after-switch', `order ${round}`);
    assert.deepEqual(holders(state, CELL_A), holders(expected, CELL_A));
  }
});
