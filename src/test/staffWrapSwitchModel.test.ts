// The cards of the switch to post-quantum keys (33.2-07 Task 1; 33.2-CONTEXT D-05, D-11): the lead's Switch card, the Move card after the switch,
// and Give keys for a computer that published its keys late. Every card is the one next step of one person and disappears with its condition; the
// table test walks every transition. Fictional people and keys.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildGrant, grantHash } from '../domain/replica/cellKeys';
import type { CellGrant } from '../domain/replica/cellKeys';
import { kemPublicFromSeeds, wrapEpochKeyV2 } from '../domain/replica/cellWrapV2';
import type { KemPublicKeys } from '../domain/replica/cellWrapV2';
import { signKemBinding } from '../domain/replica/deviceKem';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import { WRAP_FEATURE } from '../domain/replica/wrapFormat';
import { staffRoomLive } from '../domain/staff/staffRoomLive';
import type { StaffRoomCard } from '../domain/staff/staffRoomLive';
import {
  GIVE_KEYS_ACTION_TEXT, MOVE_CARD_EXPLAIN_TEXT, MOVE_CARD_TEXT, MOVE_NOW_TEXT, MOVE_WAITING_TEXT, SWITCH_CARD_EXPLAIN_TEXT, SWITCH_CARD_TEXT, SWITCH_NOT_READY_TEXT,
  giveKeysText, wrapSwitchCards,
} from '../domain/staff/wrapSwitchModel';
import type { WrapCard } from '../domain/staff/wrapSwitchModel';
import type { SignedPayload } from '../domain/team/signedPayload';
import { DEMO_CLEARANCE, INVITE_EXPIRES, createRosterWorld } from './helpers/replicaRosterWorld';
import type { RosterDevice, RosterWorld } from './helpers/replicaRosterWorld';

const keysOf = (label: string): KemPublicKeys =>
  kemPublicFromSeeds({ p256: createHash('sha256').update(`card ${label} p256`).digest(), mlkem768: createHash('sha512').update(`card ${label} mlkem`).digest() });

interface Scene { world: RosterWorld; pat: RosterDevice; admitted: string; head: string; grants: Array<SignedPayload<CellGrant>> }

// The lead admits Pat Analyst and gives Pat the base cell's first key (an older X25519 wrap, as every project made before the switch has).
function scene(): Scene {
  const world = createRosterWorld();
  const pat = world.device('PAT-LAPTOP', 'mbr-pat');
  const { entry: genesis } = world.genesis();
  const invite = world.rosterEntry(world.lead, 'member.invite', { invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) }, genesis.hash);
  const admit = world.rosterEntry(world.lead, 'member.admit', { member: 'mbr-pat', invite: 'inv-pat', name: 'Pat Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, device: pat.descriptor(2), agentSeats: [] }, invite.hash);
  world.grant(world.lead, { roster: admit.hash, to: [pat] });
  return { world, pat, admitted: admit.hash, head: admit.hash, grants: [] };
}

function publish(s: Scene, device: RosterDevice): void {
  // Cites the admission roster, sealed under the base cell's first key, which both devices hold.
  s.world.write(device, { kind: 'device.kem', data: { device: device.writer, ...signKemBinding(keysOf(device.label), device.writer, (bytes) => device.signer.sign(bytes)) }, roster: s.admitted });
}

function switchOn(s: Scene): void {
  s.head = s.world.rosterEntry(s.world.lead, 'roster.require', { features: [WRAP_FEATURE] }, s.head).hash;
}

// A new base cell epoch wrapped as v2 to the devices given (a scheduled rekey after the switch).
function rekeyV2(s: Scene, to: readonly RosterDevice[]): void {
  const cell = s.world.project;
  const key = s.world.epochKeyOf(cell, 2);
  const wraps = to.map((device) => ({ writer: device.writer, wrap: wrapEpochKeyV2({ cell, epoch: 2, writer: device.writer, recipient: keysOf(device.label), epochKey: key }) }));
  const founding = buildGrant(s.world.lead.signer, { cell, epoch: 2, roster: s.head, labelSealed: '', wraps, pages: [] });
  s.grants.push(founding);
  s.head = s.world.rosterEntry(s.world.lead, 'cell.rekey', { cell, epoch: 2, reason: 'scheduled', grant: grantHash(founding) }, s.head).hash;
}

function giveLater(s: Scene, device: RosterDevice): void {
  const cell = s.world.project;
  const wrap = wrapEpochKeyV2({ cell, epoch: 2, writer: device.writer, recipient: keysOf(device.label), epochKey: s.world.epochKeyOf(cell, 2) });
  s.grants.push(buildGrant(s.world.lead.signer, { cell, epoch: 2, roster: s.head, labelSealed: '', wraps: [{ writer: device.writer, wrap }], pages: [] }));
}

const cardsOf = (s: Scene, me: RosterDevice, cleared?: (writer: string, cell: string) => boolean): WrapCard[] =>
  wrapSwitchCards(s.world.foldRoster({ grants: [...s.world.grants, ...s.grants] }), me.writer, cleared);
const kinds = (cards: readonly WrapCard[]): string[] => cards.map((card) => card.kind);

test('no keys published and no switch: nobody sees a card', () => {
  const s = scene();
  assert.deepEqual(cardsOf(s, s.world.lead), []);
  assert.deepEqual(cardsOf(s, s.pat), []);
});

test('the lead\'s device has published: the lead sees Switch with its sentence and Pat by name; Pat, not a lead, sees nothing', () => {
  const s = scene();
  publish(s, s.world.lead);
  assert.deepEqual(cardsOf(s, s.world.lead), [{ kind: 'switch', text: SWITCH_CARD_TEXT, explain: SWITCH_CARD_EXPLAIN_TEXT, notReady: ['Pat Analyst'] }]);
  assert.deepEqual(cardsOf(s, s.pat), []);
});

test('once Pat has published too, the Switch card names nobody', () => {
  const s = scene();
  publish(s, s.world.lead);
  publish(s, s.pat);
  const [card] = cardsOf(s, s.world.lead);
  assert.equal(card.kind === 'switch' && card.notReady.length, 0);
});

test('after the switch the lead sees Move while the base cell\'s current key still has older wraps: ready when every holder has keys', () => {
  const s = scene();
  publish(s, s.world.lead);
  publish(s, s.pat);
  switchOn(s);
  assert.deepEqual(cardsOf(s, s.world.lead), [{ kind: 'move', text: MOVE_CARD_TEXT, ready: [s.world.project], waiting: [] }]);
  assert.deepEqual(cardsOf(s, s.pat), [], 'Move is the lead\'s');
});

test('a holder without keys puts the cell under waiting', () => {
  const s = scene();
  publish(s, s.world.lead);
  switchOn(s);
  const [card] = cardsOf(s, s.world.lead);
  assert.deepEqual(card, { kind: 'move', text: MOVE_CARD_TEXT, ready: [], waiting: [s.world.project] });
});

test('after the move Pat, who had no keys, is left out; once Pat publishes, the lead sees Give keys for Pat; after the grant no card is left', () => {
  const s = scene();
  publish(s, s.world.lead);
  switchOn(s);
  rekeyV2(s, [s.world.lead]);
  assert.deepEqual(cardsOf(s, s.world.lead), [], 'nothing to move, and Pat has no keys yet');
  publish(s, s.pat);
  assert.deepEqual(cardsOf(s, s.world.lead), [{ kind: 'give-keys', text: giveKeysText(1), grants: [{ cell: s.world.project, epoch: 2, writers: [s.pat.writer] }] }]);
  assert.deepEqual(cardsOf(s, s.pat), [], 'only a holder gives keys');
  giveLater(s, s.pat);
  assert.deepEqual(cardsOf(s, s.world.lead), []);
});

test('a computer the host says may not hold the part is never offered keys', () => {
  const s = scene();
  publish(s, s.world.lead);
  switchOn(s);
  rekeyV2(s, [s.world.lead]);
  publish(s, s.pat);
  assert.deepEqual(cardsOf(s, s.world.lead, () => false), []);
});

test('the Give keys sentence counts computers in words', () => {
  assert.equal(giveKeysText(2), 'Two computers are ready for keys. Give keys.');
  assert.equal(giveKeysText(1), 'One computer is ready for keys. Give keys.');
  assert.equal(giveKeysText(12), '12 computers are ready for keys. Give keys.');
});

test('table: every transition between no card, Switch, Move and Give keys, as the lead sees it, and each card leaves with its condition', () => {
  const s = scene();
  const steps: Array<[string, () => void, string[]]> = [
    ['start', () => undefined, []],
    ['the lead publishes', () => publish(s, s.world.lead), ['switch']],
    ['the lead switches', () => switchOn(s), ['move']],
    ['the base cell moves without Pat', () => rekeyV2(s, [s.world.lead]), []],
    ['Pat publishes late', () => publish(s, s.pat), ['give-keys']],
    ['the lead gives Pat the key', () => giveLater(s, s.pat), []]
  ];
  for (const [what, step, expected] of steps) {
    step();
    assert.deepEqual(kinds(cardsOf(s, s.world.lead)), expected, what);
  }
});

// The cards as the Staff Room draws them (33-26 attention cards): each with its words and the one way forward, the names in the sentence.
const roomCards = (cards: readonly WrapCard[]): StaffRoomCard[] => [...staffRoomLive({
  status: { state: 'live', findings: [] }, isLeadDevice: true, people: [], products: [], versions: [], contested: [], unconfirmed: [], joins: [], splits: [], agents: [], wrapCards: cards,
}).cards];
const shown = (card: StaffRoomCard): [string, string, string[][]] => [card.kind, card.text, card.actions.map((action) => [action.id, action.label, action.accessibleName])];

test('in the Staff Room, Switch names who has no keys, Move moves what is ready or everything now, and Give keys gives; each has one way forward', () => {
  const s = scene();
  publish(s, s.world.lead);
  assert.deepEqual(roomCards(cardsOf(s, s.world.lead)).map(shown), [
    ['switch-keys', `${SWITCH_CARD_EXPLAIN_TEXT} ${SWITCH_NOT_READY_TEXT} Pat Analyst.`, [['switch-keys', SWITCH_CARD_TEXT, SWITCH_CARD_TEXT]]],
  ]);
  assert.equal(SWITCH_CARD_EXPLAIN_TEXT, 'This protects shared work against future quantum computers.', 'post-quantum is explained once, on the card (D-11)');
  switchOn(s);
  assert.deepEqual(roomCards(cardsOf(s, s.world.lead)).map(shown), [
    ['move-keys', `${MOVE_CARD_EXPLAIN_TEXT} ${MOVE_WAITING_TEXT}`, [['move-keys-now', MOVE_NOW_TEXT, MOVE_NOW_TEXT]]],
  ], 'only waiting parts: the card still has its way forward, now');
  publish(s, s.pat);
  assert.deepEqual(roomCards(cardsOf(s, s.world.lead)).map(shown), [
    ['move-keys', MOVE_CARD_EXPLAIN_TEXT, [['move-keys', MOVE_CARD_TEXT, MOVE_CARD_TEXT]]],
  ]);
  assert.deepEqual(roomCards([{ kind: 'move', text: MOVE_CARD_TEXT, ready: ['a'], waiting: ['b'] }]).map(shown), [
    ['move-keys', `${MOVE_CARD_EXPLAIN_TEXT} ${MOVE_WAITING_TEXT}`, [['move-keys', MOVE_CARD_TEXT, MOVE_CARD_TEXT], ['move-keys-now', MOVE_NOW_TEXT, MOVE_NOW_TEXT]]],
  ], 'ready parts move first; the rest wait or move now');
  const s2 = scene();
  publish(s2, s2.world.lead);
  switchOn(s2);
  rekeyV2(s2, [s2.world.lead]);
  publish(s2, s2.pat);
  assert.deepEqual(roomCards(cardsOf(s2, s2.world.lead)).map(shown), [
    ['give-keys', 'One computer is ready for keys. Give keys.', [['give-keys', GIVE_KEYS_ACTION_TEXT, GIVE_KEYS_ACTION_TEXT]]],
  ]);
  assert.deepEqual(roomCards([]), [], 'no card, nothing drawn');
});
