// Phase 33.2 plan 07 Task 3 (33.2-CONTEXT D-05, D-11): the switch to post-quantum keys in the native Staff Room. The live engine gives the lead's
// cards to the room, and Switch, Move and Give keys are actions of the Staff Room's channel. Each refusal comes back as plain data with its
// sentence; a confirmation that is too old answers with the step-up link and writes nothing. The cards draw with the room's existing card
// renderer. Fictional exercise data only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadStaffEngine, type EngineLiveStatus, type EngineReplicator, type StaffEngine } from '../../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine } from '../../extension/src/node/staff/staff-live-engine.ts';
import { StaffRoomService } from '../../extension/src/node/staff/staff-room-service.ts';
import { KEY_SERVICE_TEXT } from '../../extension/src/common/key-service.ts';
import { stepUpUrl } from '../../extension/src/common/session-identity.ts';
import { STAFF_ROOM_TEXT, type StaffRoom, type StaffRoomCard, type StaffRoomLiveView } from '../../extension/src/common/staff-room.ts';
import { staffRoomView, type StaffRoomHandlers } from '../../extension/src/browser/staff/staff-room-view.ts';
import { WRAP_FEATURE } from '../../../src/domain/replica/wrapFormat.ts';
import { ensureDeviceKem } from '../../../src/staff/replica/kemPublish.ts';
import { loadOrCreateKemKeys } from '../../../src/staff/replica/keyring.ts';
import { updateMember } from '../../../src/staff/replica/membership.ts';
import { ReplicaProject } from '../../../src/staff/replica/replicaProject.ts';
import { identityDir } from '../../../src/team/identity.ts';
import { LEAD_MEMBER, bringIn, hostOf, install, ok, orgClearance, project, syncTo, type Seat } from '../../../src/test/helpers/labelCellWorld.ts';

const workbenchRoot = fileURLToPath(new URL('../../..', import.meta.url));
const engine = loadStaffEngine<StaffEngine>(workbenchRoot);
const ReactDOMServer = createRequire(import.meta.url)('@theia/core/shared/react-dom/server') as { renderToStaticMarkup(element: unknown): string };
const ACR = 'urn:example:stepup';
const RETURN_TO = '/staff?room=1';
const KEY_CARDS = new Set(['switch-keys', 'move-keys', 'give-keys']);

/** The replicator faked: the room's actions only tell it to push. */
class QuietReplicator implements EngineReplicator {
  public status: EngineLiveStatus = { state: 'live', since: 0, findings: [], pulled: 0, pushed: 0 };
  public appended = 0;
  onStatus() { return { dispose: () => undefined }; }
  async start() { /* nothing */ }
  async stop() { /* nothing */ }
  syncNow() { /* nothing */ }
  localAppended() { this.appended += 1; }
}

/** A lead whose shared work was made before the switch, with Pat Analyst admitted; neither computer has published post-quantum keys yet. */
async function unswitched(label: string): Promise<{ lead: Seat; pat: Seat }> {
  const at = install(label);
  at.deps.wrapV2AtCreation = false;
  const p = project(await ReplicaProject.createSharedProject(at.root, at.deps, { name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LEAD_MEMBER } }));
  const host = hostOf(p, at);
  ok(await updateMember(host, { member: LEAD_MEMBER, roles: ['member', 'section_lead:j4'], clearance: orgClearance('Confidential') }), 'the lead declares a clearance');
  const lead: Seat = { at, p, host, member: LEAD_MEMBER, writer: p.deviceWriter, results: [] };
  const pat = await bringIn(lead, `${label}-pat`, 'Pat Analyst', orgClearance('Internal'));
  return { lead, pat };
}

/** The lead's live engine (it publishes this computer's post-quantum keys at open, as a single machine does) and the Staff Room over it. */
async function roomOf(seat: Seat) {
  let replicator: QuietReplicator | undefined;
  const live = new StaffLiveEngine({
    engine: { ...engine, LiveReplicator: function Made() { replicator = new QuietReplicator(); return replicator; } as never, projectLive: async () => ({ written: [], left: [] }) } as StaffEngine,
    roots: async () => [seat.at.root], globalStorageDir: seat.at.global, secrets: seat.at.secrets,
  });
  await live.start();
  const service = new StaffRoomService({ live: () => live, engine, stepUpAcr: () => ACR });
  const id = live.projects()[0].project;
  const cards = async (): Promise<StaffRoomCard[]> => (await service.rooms())[0].view.cards.filter((card) => KEY_CARDS.has(card.kind));
  return { live, service, id, cards, replicator: () => replicator as QuietReplicator };
}

const actionsOf = (card: StaffRoomCard): string[][] => card.actions.map((action) => [action.id, action.label]);
const switches = async (seat: Seat): Promise<number> => (await seat.p.findOwnAll('roster.require', (data: unknown) => ((data as { features?: string[] }).features ?? []).includes(WRAP_FEATURE))).length;

test('the lead\'s room shows Switch with Pat by name; Switch over the room\'s channel writes one roster.require, and pressing it again answers its sentence', async () => {
  const { lead } = await unswitched('room-switch');
  const { live, service, id, cards, replicator } = await roomOf(lead);
  try {
    const [card] = await cards();
    assert.equal(card.kind, 'switch-keys');
    assert.equal(card.text, 'This protects shared work against future quantum computers. These people have a computer that has not published its post-quantum keys yet. It gets its keys once it does: Pat Analyst.');
    assert.deepEqual(actionsOf(card), [['switch-keys', 'Switch to post-quantum keys']]);

    assert.equal((await service.switchToV2(id, RETURN_TO)).kind, 'ok');
    assert.equal((await lead.p.state()).roster.required.includes(WRAP_FEATURE), true);
    assert.equal(await switches(lead), 1);
    assert.equal(replicator().appended, 1, 'the replicator was told to push');
    assert.deepEqual((await cards()).map((item) => [item.kind, actionsOf(item)]), [['move-keys', [['move-keys-now', 'Move it now without waiting']]]], 'Switch gives way to Move');

    assert.deepEqual(await service.switchToV2(id, RETURN_TO), { kind: 'refused', reason: STAFF_ROOM_TEXT.keysAlreadySwitched });
    assert.equal(await switches(lead), 1, 'nothing more was written');
    assert.deepEqual(await service.switchToV2('0'.repeat(32), RETURN_TO), { kind: 'refused', reason: STAFF_ROOM_TEXT.notOpen });
  } finally {
    await live.stop();
  }
});

test('Move now moves the shared work without Pat; when Pat publishes, Give keys gives Pat the key and no card is left, each over the room\'s channel', async () => {
  const { lead, pat } = await unswitched('room-move');
  const { live, service, id, cards } = await roomOf(lead);
  try {
    assert.equal((await service.switchToV2(id, RETURN_TO)).kind, 'ok');
    assert.deepEqual(await service.moveCellsToV2(id, false, RETURN_TO), { kind: 'refused', reason: STAFF_ROOM_TEXT.keysNothingToDo }, 'nothing is ready without Pat');
    assert.deepEqual(await service.giveKeys(id, RETURN_TO), { kind: 'refused', reason: STAFF_ROOM_TEXT.keysNothingToDo });

    assert.equal((await service.moveCellsToV2(id, true, RETURN_TO)).kind, 'ok');
    assert.deepEqual(await cards(), [], 'moved; Pat has no keys yet, so nothing waits on anyone here');

    await ensureDeviceKem(pat.p, { loadKeys: () => loadOrCreateKemKeys(pat.at.secrets, { identityDir: identityDir(pat.at.global) }) });
    await syncTo(pat, lead);
    const [give] = await cards();
    assert.deepEqual([give.kind, give.text, actionsOf(give)], ['give-keys', 'One computer is ready for keys. Give keys.', [['give-keys', 'Give keys']]]);

    assert.equal((await service.giveKeys(id, RETURN_TO)).kind, 'ok');
    assert.deepEqual(await cards(), [], 'Pat holds the key; nobody was removed for being late');
    assert.ok((await lead.p.state()).roster.members.devices.has(pat.writer));
  } finally {
    await live.stop();
  }
});

test('with a confirmation that is too old, Switch answers the fix and the step-up link and writes nothing; after a fresh one it completes', async () => {
  const { lead } = await unswitched('room-stepup');
  const { live, service, id, cards } = await roomOf(lead);
  try {
    // The person key as a hosted session has it: KeyService refuses until the passkey or security key confirmed again.
    const opened = live.shared(id)?.project as unknown as { signerOf(kind: string): { fingerprint: string; publicKey: string; sign(bytes: Buffer): unknown } };
    const device = opened.signerOf.bind(opened);
    let fresh = false;
    opened.signerOf = (kind: string) => {
      const signer = device(kind);
      return kind !== 'roster.require' ? signer : {
        fingerprint: signer.fingerprint, publicKey: signer.publicKey,
        sign: async (bytes: Buffer) => (fresh ? signer.sign(bytes) : { refused: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm }),
      };
    };
    assert.deepEqual(await service.switchToV2(id, RETURN_TO), { kind: 'step-up', reason: KEY_SERVICE_TEXT.stepUpNeeded, fix: KEY_SERVICE_TEXT.confirm, url: stepUpUrl(RETURN_TO, ACR) });
    assert.equal(await switches(lead), 0, 'nothing written');
    assert.equal((await cards())[0]?.kind, 'switch-keys', 'the card stays with its action');
    fresh = true;
    assert.equal((await service.switchToV2(id, RETURN_TO)).kind, 'ok');
    assert.equal(await switches(lead), 1);
  } finally {
    await live.stop();
  }
});

test('the room draws the three cards with its existing card renderer: a lifted card each, its words, and one named button per action', () => {
  const view = engine.staffRoomLive({
    status: { state: 'live', findings: [] }, isLeadDevice: true, people: [], products: [], versions: [], contested: [], unconfirmed: [], joins: [], splits: [], agents: [],
    wrapCards: [
      { kind: 'switch', text: 'Switch to post-quantum keys', explain: 'This protects shared work against future quantum computers.', notReady: [] },
      { kind: 'move', text: 'Move all shared work to the new keys', ready: ['a'], waiting: ['b'] },
      { kind: 'give-keys', text: 'Two computers are ready for keys. Give keys.', grants: [{ cell: 'a', epoch: 2, writers: ['w1', 'w2'] }] },
    ],
  } as never) as StaffRoomLiveView;
  const room: StaffRoom = { project: 'a'.repeat(32), root: '/home/sterling/workspace/exercise', view };
  const handlers: StaffRoomHandlers = { act: () => undefined, decide: () => undefined, cancel: () => undefined };
  const markup = ReactDOMServer.renderToStaticMarkup(staffRoomView([room], handlers) as never);
  for (const kind of KEY_CARDS) assert.match(markup, new RegExp(`class="sterling-staff-room-card sterling-staff-room-card-${kind}"`), kind);
  assert.deepEqual([...markup.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((match) => match[1]).slice(1),
    ['Switch to post-quantum keys', 'Move all shared work to the new keys', 'Move it now without waiting', 'Give keys'], 'after the sync bar\'s one action');
  const shown = markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const words of ['This protects shared work against future quantum computers.', 'Two computers are ready for keys. Give keys.']) assert.ok(shown.includes(words), words);
  assert.doesNotMatch(markup, /class="codicon undefined"/, 'every card kind has its codicon');
});
