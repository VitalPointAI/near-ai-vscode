// Phase 33 plan 24 (D-47 superseded, D-50 to D-52, D-61, D-64, D-67; the hooks of superseded 33-10). The live engine of a person's session, from
// the engine bundle (engine/staff.cjs): shared projects in the workspace roots go live, one replicator each, and every connected tab hears their
// status; a folder without shared work starts nothing. The hooks: roster.require on a lead device, the projector after an exchange, the compactor
// after a checkpoint, join requests on a lead's device only, Sync Now, and a project that needs a newer Sterling stops with the D-67 sentence and
// keeps every entry. The session lifecycle starts the engine at active and stops it at stopping. The real-hub tests follow D-46. The browser bundle
// holds no Yjs and no replica module. Fictional exercise data only.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { loadStaffEngine, type EngineLiveStatus, type EngineProject, type EngineReplicator, type StaffEngine } from '../../extension/src/node/staff/staff-engine.ts';
import { StaffLiveEngine, StaffLiveSession, type StaffLiveEngineOptions } from '../../extension/src/node/staff/staff-live-engine.ts';
import type { StaffJoinRequest, StaffStatusRow } from '../../extension/src/common/staff-live.ts';
import type * as StaffEntry from '../../tools/staff-engine-entry.ts';
import { clientIdOf } from '../../../src/domain/replica/clientIds.ts';
import { createLocalDoc, docText, localInsert, snapshotOf } from '../../../src/domain/replica/doc.ts';
import { staffProductPath } from '../../../src/domain/staff/writeLimits.ts';
import { writeHubAddress } from '../../../src/staff/replica/hubAddress.ts';
import { appendProductEntry, proposeVersion } from '../../../src/staff/replica/labelCells.ts';
import { productBodyOf } from '../../../src/staff/replica/projection.ts';
import { hubNodeOrSkip, startHubChild } from '../../../src/test/helpers/hubChild.ts';
import { createLiveWorld, type LiveDevice, type LiveWorld } from '../../../src/test/helpers/liveWorld.ts';
import { MemorySecrets } from '../../../src/test/helpers/labelCellWorld.ts';
import { loadOrCreateEncryptionKey, loadOrCreateKemKeys } from '../../../src/staff/replica/keyring.ts';
import { identityDir } from '../../../src/team/identity.ts';
import type { KeyObject } from 'node:crypto';
import { startSessionKeys } from '../../extension/src/node/staff/session-keys.ts';

type EntryMatches = typeof StaffEntry extends StaffEngine ? true : never;
const entryMatches: EntryMatches = true;

const workbenchRoot = fileURLToPath(new URL('../../..', import.meta.url));
const engine = loadStaffEngine<StaffEngine>(workbenchRoot);
const PRODUCT = 'logistics-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const UPDATE = 'This shared work needs a newer version of Sterling. Ask your administrator to update it.';

const emptyFolder = (): string => mkdtempSync(path.join(tmpdir(), 'staff-not-shared-'));

/** An engine over one person's install from the live world, on the single-machine path (their own device key), with extra options. */
function engineFor(device: LiveDevice, extra: Partial<StaffLiveEngineOptions> = {}): StaffLiveEngine {
  return new StaffLiveEngine({ engine, roots: async () => [device.at.root], globalStorageDir: device.at.global, secrets: device.at.secrets, ...extra });
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean, what: string | (() => string), ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---- a fake replicator, so the hooks can be driven one at a time ----------------------------------------------------------------------------------

class FakeReplicator implements EngineReplicator {
  public static made: FakeReplicator[] = [];
  public status: EngineLiveStatus = { state: 'connecting', since: 0, findings: [], pulled: 0, pushed: 0 };
  public started = 0;
  public stopped = 0;
  public synced = 0;
  public appended = 0;
  private readonly listeners: Array<(status: EngineLiveStatus) => void> = [];
  constructor(public readonly options: Record<string, unknown> & { isLeadDevice: () => Promise<boolean>; onJoinRequest: (invite?: string) => void; onCheckpoint: (frame: object) => void; signer: { publicKey: string }; certificate?: unknown }) {
    FakeReplicator.made.push(this);
  }
  onStatus(listener: (status: EngineLiveStatus) => void) { this.listeners.push(listener); return { dispose: () => undefined }; }
  async start() { this.started += 1; }
  async stop() { this.stopped += 1; }
  syncNow() { this.synced += 1; }
  localAppended() { this.appended += 1; }
  emit(change: Partial<EngineLiveStatus>) { this.status = { ...this.status, ...change }; for (const listener of this.listeners) listener(this.status); }
  /** A join-request frame, as LiveReplicator handles it: only a lead device passes it on (D-12). */
  async joinFrame(invite: string) { if (await this.options.isLeadDevice()) this.options.onJoinRequest(invite); }
}

interface Spies { projected: Array<ReadonlySet<string> | undefined>; compacted: number; armed: number; compactedFor?: string[] }

/** The real engine bundle with the replicator faked and the projector, compactor and require arming counted. */
function spiedEngine(spies: Spies, compacted: string[] = []): StaffEngine {
  return {
    ...engine,
    LiveReplicator: FakeReplicator as never,
    projectLive: async (_root: string, _input: never, options: { bound?: ReadonlySet<string> }) => { spies.projected.push(options.bound); return { written: [], left: [] }; },
    compactAfterCheckpoint: async (_project: never, input: { hub: string }) => { spies.compacted += 1; spies.compactedFor?.push(input.hub); return { compacted }; },
    ensureRequireArmed: async (project: never) => { spies.armed += 1; return engine.ensureRequireArmed(project); },
  } as StaffEngine;
}

const settle = async (): Promise<void> => { for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };

async function worldOfTwo(): Promise<LiveWorld> {
  return createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }] });
}

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

async function realHub(t: TestContext, run: (world: LiveWorld) => Promise<void>): Promise<void> {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const server = await startHubChild(node);
  try {
    const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }], hub: { fileText: await server.hubFileText() } });
    try {
      // The address of your organization's server for this project on each computer (the join flow writes it; 33-27).
      for (const device of world.devices) {
        await writeHubAddress(device.at.global, { v: 1, project: device.project.projectId, hub: world.hub?.id as string, address: world.hub?.address as string, setAt: new Date().toISOString() });
      }
      await run(world);
    } finally {
      await world.close();
    }
  } finally {
    await server.dispose();
  }
}

test('tracer: a shared project in a workspace root goes live through a real hub, and a connected tab receives its live row', (t) => realHub(t, async (world) => {
  assert.equal(entryMatches, true);
  const [avery] = world.devices;
  const rows: StaffStatusRow[] = [];
  const live = engineFor(avery, { roots: async () => [emptyFolder(), avery.at.root] });
  live.onStatus((row) => rows.push(row));
  try {
    await live.start();
    await until(() => rows.at(-1)?.state, (state) => state === 'live', 'the live row');
    assert.deepEqual(live.projects().map((row) => [row.project, row.root, row.state]), [[avery.project.projectId, avery.at.root, 'live']]);
    assert.equal(rows.at(-1)?.sentence, 'Synced with your organization\'s server.');
  } finally {
    await live.stop();
  }
}));

test('after an exchange that brought a change, the product file that is not open is written from the fold', (t) => realHub(t, async (world) => {
  const [avery, blake] = world.devices;
  const created = await appendProductEntry(avery.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Logistics estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? '' : created.message);
  const { roster } = await avery.project.state();
  const clientId = clientIdOf(roster.members.devices.get(avery.project.deviceWriter)?.[0]?.slot ?? 1, 0);
  assert.ok((await appendProductEntry(avery.host, 'doc.client', { product: PRODUCT, clientId, actor: { kind: 'person' } })).ok);
  const doc = createLocalDoc(clientId);
  assert.ok((await appendProductEntry(avery.host, 'doc.update', { product: PRODUCT, update: Buffer.from(localInsert(doc, 0, 'Fuel for three days.')).toString('base64url') })).ok);
  const proposed = await proposeVersion(avery.host, { product: PRODUCT, text: docText(doc), header: { kind: 'estimate', label: LABEL, profile: 'j4', level: 'official' }, pins: [], snapshot: snapshotOf(doc) });
  assert.ok(proposed.ok, proposed.ok ? '' : proposed.message);
  const logs: string[] = [];
  const averyLive = engineFor(avery, { log: (line) => logs.push(`A ${line}`) });
  const blakeLive = engineFor(blake, { log: (line) => logs.push(`B ${line}`) });
  try {
    await averyLive.start();
    await until(() => averyLive.projects()[0]?.state, (state) => state === 'live', 'Avery live');
    await blakeLive.start();
    const file = path.join(blake.at.root, ...staffProductPath('j4', PRODUCT).split('/'));
    await until(() => existsSync(file), (found) => found, () => `Blake's product file (${JSON.stringify((engine.syncStatusFor(blake.at.root) as unknown as { status?: unknown }).status)}; ${logs.slice(-30).join(' | ')})`);
    assert.equal(productBodyOf(readFileSync(file, 'utf8')), 'Fuel for three days.');
  } finally {
    await averyLive.stop();
    await blakeLive.stop();
  }
}));

test('a folder without shared work starts no replicator and shows no row', async () => {
  FakeReplicator.made = [];
  const live = new StaffLiveEngine({ engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }), roots: async () => [emptyFolder(), emptyFolder()], globalStorageDir: emptyFolder(), secrets: new Map() as never });
  await live.start();
  assert.deepEqual(live.projects(), []);
  assert.equal(FakeReplicator.made.length, 0);
  await live.stop();
});

// ---- Task 2: every hook of superseded 33-10 ------------------------------------------------------------------------------------------------------

test('on the lead\'s device roster.require stays armed once and a member\'s device writes nothing; each opens with its own device key', async () => {
  const world = await worldOfTwo();
  try {
    const [avery, blake] = world.devices;
    const spies: Spies = { projected: [], compacted: 0, armed: 0 };
    const requires = async (device: LiveDevice): Promise<number> => (await device.project.findOwnAll('roster.require', () => true)).length;
    const before = [await requires(avery), await requires(blake)];
    for (const device of [avery, blake]) {
      FakeReplicator.made = [];
      const live = engineFor(device, { engine: spiedEngine(spies) });
      await live.start();
      assert.equal(FakeReplicator.made.length, 1);
      assert.equal(FakeReplicator.made[0].options.signer.publicKey, device.project.signer.publicKey, 'the device key signs on a single machine');
      assert.equal(FakeReplicator.made[0].options.certificate, undefined);
      assert.equal(FakeReplicator.made[0].options.startFromBase, true, 'a log this computer holds nothing of starts from the newest trusted checkpoint (D-43)');
      await live.stop();
    }
    assert.equal(spies.armed, 2, 'the check runs on every device');
    assert.deepEqual([await requires(avery), await requires(blake)], before, 'armed at creation: nothing is written twice, and never by a member');
    assert.equal(before[0], 1);
    assert.equal(before[1], 0);
  } finally {
    await world.close();
  }
});

test('a join request reaches the clients from the lead\'s device only', async () => {
  const world = await worldOfTwo();
  try {
    const [avery, blake] = world.devices;
    const heard: Array<[string, StaffJoinRequest]> = [];
    for (const [device, who] of [[avery, 'lead'], [blake, 'member']] as const) {
      FakeReplicator.made = [];
      const live = engineFor(device, { engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }) });
      live.onJoinRequest((request) => heard.push([who, request]));
      await live.start();
      await FakeReplicator.made[0].joinFrame('inv-casey');
      await live.stop();
    }
    assert.deepEqual(heard, [['lead', { project: avery.project.projectId, invite: 'inv-casey' }]]);
  } finally {
    await world.close();
  }
});

test('rows reach every listener and the workspace status store; the projector runs only after an exchange brought something, around bound products', async () => {
  const world = await worldOfTwo();
  try {
    const [avery] = world.devices;
    const spies: Spies = { projected: [], compacted: 0, armed: 0 };
    FakeReplicator.made = [];
    const live = engineFor(avery, { engine: spiedEngine(spies) });
    const rows: StaffStatusRow[] = [];
    live.onStatus((row) => rows.push(row));
    await live.start();
    const replicator = FakeReplicator.made[0];
    live.setBound(avery.project.projectId, ['logistics-estimate']);
    replicator.emit({ state: 'live', lastSyncedAt: 1_795_000_000_000 });
    await settle();
    assert.equal(spies.projected.length, 0, 'nothing pulled, nothing projected');
    replicator.emit({ pulled: 3 });
    await until(() => spies.projected.length, (count) => count > 0, 'the projector');
    assert.deepEqual(spies.projected.map((bound) => [...(bound ?? [])]), [['logistics-estimate']]);
    replicator.emit({ pushed: 2 });
    await settle();
    assert.equal(spies.projected.length, 1, 'a push alone projects nothing');
    assert.deepEqual(rows.at(-1), { project: avery.project.projectId, root: avery.at.root, state: 'live', sentence: 'Synced with your organization\'s server.', lastSyncedAt: 1_795_000_000_000 });
    assert.equal((engine.syncStatusFor(avery.at.root) as unknown as { status?: { state: string } }).status?.state, 'live');
    await live.stop();
  } finally {
    await world.close();
  }
});

test('after a checkpoint the compactor runs for the server\'s writer id, and a compaction it wrote is pushed', async () => {
  const world = await worldOfTwo();
  try {
    const [avery] = world.devices;
    const spies: Spies = { projected: [], compacted: 0, armed: 0, compactedFor: [] };
    FakeReplicator.made = [];
    const live = engineFor(avery, { engine: { ...spiedEngine(spies, ['c'.repeat(64)]), hubStanding: async () => [{ hub: 'hub-north', writer: 'd'.repeat(64), certPin: 'e'.repeat(64), standing: 'admitted' as const }] } });
    await live.start();
    FakeReplicator.made[0].options.onCheckpoint({});
    await settle();
    assert.equal(spies.compacted, 1);
    // Found in 33-14: the hub id here named no witness and no checkpoint signer, so the engine never compacted.
    assert.deepEqual(spies.compactedFor, ['d'.repeat(64)], 'the compactor names the server by its writer id, as the exchange does');
    assert.equal(FakeReplicator.made[0].appended, 1);
    await live.stop();
  } finally {
    await world.close();
  }
});

test('Sync Now runs one exchange for an open project; a project not open here gives nothing', async () => {
  const world = await worldOfTwo();
  try {
    const [avery] = world.devices;
    FakeReplicator.made = [];
    const live = engineFor(avery, { engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }) });
    await live.start();
    assert.equal(live.syncNow(avery.project.projectId)?.project, avery.project.projectId);
    assert.equal(FakeReplicator.made[0].synced, 1);
    assert.equal(live.syncNow('f'.repeat(32)), undefined);
    await live.stop();
  } finally {
    await world.close();
  }
});

test('a project that needs a newer Sterling stops with the D-67 sentence and keeps every entry', async () => {
  const world = await worldOfTwo();
  try {
    const [avery] = world.devices;
    FakeReplicator.made = [];
    const live = engineFor(avery, { engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }) });
    await live.start();
    const files = (): string[] => readdirSync(path.join(avery.at.root, '.planning', 'staff', 'replica'), { recursive: true }).map(String).sort();
    const before = files();
    FakeReplicator.made[0].emit({ state: 'needs-update', reason: 'needs-update' });
    await settle();
    assert.equal(FakeReplicator.made[0].stopped, 1);
    assert.deepEqual(live.projects().map((row) => [row.state, row.sentence]), [['needs-update', UPDATE]]);
    assert.deepEqual(files(), before);
    await live.stop();
  } finally {
    await world.close();
  }
});

// ---- Task 3: the session lifecycle and the browser bundle boundary --------------------------------------------------------------------------------

test('the engine starts when the sign-in is active and stops at stopping; a failed sign-in starts nothing; local mode starts at once', async () => {
  const states: string[] = [];
  const made: Array<{ started: number; stopped: number }> = [];
  const fake = (): StaffLiveEngine => {
    const record = { started: 0, stopped: 0 };
    made.push(record);
    return { start: async () => { record.started += 1; }, stop: async () => { record.stopped += 1; } } as unknown as StaffLiveEngine;
  };
  let state = 'identity';
  const session = new StaffLiveSession({ identity: { status: () => ({ mode: 'hosted', state }) }, create: async () => fake(), started: () => states.push(state) });
  await session.check();
  state = 'failed';
  await session.check();
  assert.equal(made.length, 0, 'nothing before active, and nothing for a failed sign-in');
  state = 'active';
  await session.check();
  await session.check();
  assert.deepEqual(made, [{ started: 1, stopped: 0 }]);
  assert.ok(session.current);
  state = 'stopping';
  await session.check();
  assert.deepEqual(made, [{ started: 1, stopped: 1 }]);
  assert.equal(session.current, undefined);
  state = 'active';
  await session.check();
  assert.equal(made.length, 1, 'a session that stopped does not start again');

  const local = new StaffLiveSession({ identity: { status: () => ({ mode: 'local' }) }, create: async () => fake() });
  await local.check();
  assert.equal(made.length, 2);
  await local.dispose();
  assert.deepEqual(made[1], { started: 1, stopped: 1 });
  assert.deepEqual(states, ['active']);
});

test('stop drops the hosted session\'s keys and the opened encryption key', async () => {
  let keysStopped = 0;
  let dropped = 0;
  const live = new StaffLiveEngine({
    engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }), roots: async () => [], globalStorageDir: emptyFolder(), secrets: new Map() as never,
    hosted: { keys: { stop: () => { keysStopped += 1; } } as never, encryption: { drop: () => { dropped += 1; } } as never },
  });
  await live.start();
  await live.stop();
  await live.stop();
  assert.deepEqual([keysStopped, dropped], [1, 1]);
});

test('the built browser bundle holds no Yjs and no replica module (T-33-N11)', (t) => {
  const frontend = path.join(workbenchRoot, 'lib', 'frontend');
  if (!existsSync(frontend)) {
    const reason = 'Run npm --prefix workbench run build to scan the browser bundle';
    console.log(reason);
    t.skip(reason);
    return;
  }
  const files = readdirSync(frontend, { recursive: true }).map(String).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = readFileSync(path.join(frontend, name), 'utf8');
    assert.doesNotMatch(text, /\byjs\b|y-protocols|lib0\//, `${name} holds Yjs`);
    assert.doesNotMatch(text, /staff[\\/]replica[\\/]|replicaProject|liveReplicator|DeviceKeyRing|sessionCertifyData/, `${name} holds a replica module`);
  }
});

test('a hosted session opens the project with the person key as its device: the session key signs, the certificate goes to the transport, and no private key is stored', async () => {
  const world = await createLiveWorld({ people: [{ label: 'avery', name: 'Avery Lead' }] });
  try {
    const [avery] = world.devices;
    const person = avery.project.signer;
    const keyService = {
      sign: async (message: string) => ({ kind: 'ok' as const, value: { signature: Buffer.from(person.sign(Buffer.from(message, 'base64')), 'base64url').toString('base64'), keyVersion: 1 } }),
    };
    const identity = { status: () => ({ mode: 'hosted' as const, state: 'active' as const }) };
    const started = await startSessionKeys(keyService, identity, { now: () => Date.now() }, { personPublicKey: person.publicKey, engine });
    assert.equal(started.kind, 'ok');
    if (started.kind !== 'ok') return;
    const x25519 = await loadOrCreateEncryptionKey(avery.at.secrets, { identityDir: identityDir(avery.at.global), identity: person });
    // The person's post-quantum keys, as the session's envelope holds them (33.2-04): new shared work starts post-quantum (33.2-06).
    const kem = await loadOrCreateKemKeys(avery.at.secrets, { identityDir: identityDir(avery.at.global) });
    let dropped = 0;
    const encryption = { publicKey: x25519.publicKey, privateKey: x25519.privateKey as KeyObject | undefined, kem: { publicKeys: kem.publicKeys, privateKeys: kem.privateKeys }, drop: () => { dropped += 1; } };
    const secrets = new MemorySecrets();
    FakeReplicator.made = [];
    const live = new StaffLiveEngine({
      engine: spiedEngine({ projected: [], compacted: 0, armed: 0 }), roots: async () => [avery.at.root], globalStorageDir: avery.at.global, secrets,
      hosted: { keys: started.value, encryption },
    });
    await live.start();
    assert.equal(FakeReplicator.made.length, 1);
    const options = FakeReplicator.made[0].options;
    assert.equal(options.signer, started.value.sessionSigner, 'the session key signs the session answer and ordinary work');
    assert.ok(options.certificate !== undefined, 'the session.certify entry goes to the transport');
    const opened = live.project(avery.project.projectId) as EngineProject;
    assert.equal(opened.deviceWriter, avery.project.deviceWriter, 'the person key is this project\'s device');
    const { roster } = await opened.state();
    assert.equal((roster as unknown as { sessions: Map<string, { member: string }> }).sessions.get(engine.writerIdOf(started.value.sessionSigner.publicKey))?.member, avery.member);
    assert.ok([...secrets.values.keys()].every((name) => !name.startsWith('nearAi.identity.')), [...secrets.values.keys()].join(', '));
    await live.stop();
    assert.equal(dropped, 1);
    assert.throws(() => started.value.sessionSigner.sign(Buffer.from('after the end')));
  } finally {
    await world.close();
  }
});
