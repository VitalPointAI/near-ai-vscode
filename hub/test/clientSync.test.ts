import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import type { HubMemory, SyncReport } from '@ext/staff/replica/hubSync';
import { enrolProject, hubIdentityOf, issueHubFile } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { HealthRegistry } from '../src/health';
import { listen } from '../src/http/server';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { composeHub } from '../src/main';
import type { ComposedHub } from '../src/main';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { HUB_ADDRESS, NOW_MS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import type { MemoryReplica } from './helpers/memoryReplica';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 23 (D-35, D-36, D-46, D-49, D-54): the extension's hub transport and one-shot sync against the real hub, in process. Two people's
// computers are memory replicas built from hub-side modules (no fold, no Yjs); each talks to the hub over its own pinned TLS 1.3 connection with a
// session bound to that connection. All names and data are fictional.

interface RequestSeen { method: string; path: string; token: boolean }

/** Every request the hub's server receives: method, path and whether it carried a bearer token (never the token itself). */
function recordRequests(hub: Hub): RequestSeen[] {
  const seen: RequestSeen[] = [];
  hub.server.on('request', (req: http.IncomingMessage) => {
    const url = req.url ?? '';
    seen.push({ method: req.method ?? '', path: url.split('?')[0] as string, token: typeof req.headers.authorization === 'string' });
  });
  return seen;
}

function transportFor(hub: Hub, world: HubWorld, device: WorldDevice): HubTransport {
  return new HubTransport({
    address: `127.0.0.1:${hub.port}`,
    project: world.project,
    hub: hub.identity.writer,
    trust: { pin: hub.identity.certPin },
    signer: device.signer,
    servername: 'localhost',
    now: () => new Date(hub.now()),
  });
}

/** The world's project with the hub admitted and a member B, enrolled over HTTPS. */
async function enrolled(hub: Hub): Promise<{ world: HubWorld; member: WorldDevice }> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  world.admitMember(member);
  const answer = await hub.enrolProject(world);
  assert.equal(answer?.status, 201, answer?.text ?? 'no answer');
  return { world, member };
}

test('tracer: device A pushes one entry through the real hub and device B pulls it, both over pinned sessions bound to their connections', () =>
  withHub({}, async (hub) => {
    const { world, member } = await enrolled(hub);
    const a = memoryReplica(world, world.lead);
    const b = memoryReplica(world, member);
    const note = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional patrol report' } });
    assert.ok(a.add(note.entry), 'A holds its new entry');
    assert.equal(b.has(note.hash), false);
    const seen = recordRequests(hub);
    const checksBefore = hub.answerChecks();

    const transportA = transportFor(hub, world, world.lead);
    const pushed = await syncOnce(transportA, a, hubMemoryOf(new MemorySecrets()), { now: () => new Date(hub.now()) });
    transportA.close();
    assert.equal(pushed.outcome, 'synced', JSON.stringify(pushed));
    assert.equal(pushed.pushed, 1);
    assert.equal(pushed.pulled, 0);
    assert.deepEqual(pushed.findings, []);

    const transportB = transportFor(hub, world, member);
    const pulled = await syncOnce(transportB, b, hubMemoryOf(new MemorySecrets()), { now: () => new Date(hub.now()) });
    transportB.close();
    assert.equal(pulled.outcome, 'synced', JSON.stringify(pulled));
    assert.equal(pulled.pulled, 1);
    assert.equal(pulled.pushed, 0);
    assert.ok(b.has(note.hash), 'B holds the entry with the same hash');
    assert.deepEqual(b.all().at(-1), note.entry);

    // Each exchange opened a session the hub accepted: the answer named the hub's writer id, the project and that connection's keying material.
    assert.equal(hub.answerChecks() - checksBefore, 2, 'one session answer per device');
    const sessionCalls = seen.filter((item) => item.path === '/v1/session');
    assert.equal(sessionCalls.length, 4, 'a challenge and an answer per device');
    assert.ok(sessionCalls.every((item) => !item.token), 'the session calls carry no token');
    // After the session call the hub saw no request without a token.
    const others = seen.filter((item) => item.path !== '/v1/session');
    assert.ok(others.length >= 4, `the exchanges made their calls (${others.length})`);
    assert.deepEqual(others.filter((item) => !item.token), []);
  }));

// ---- Task 3: a hub restored from an older copy, refusals and pins over the real hub ----

/** A hub in process whose state folder survives a stop, so a test can copy it, put an older copy back and start the hub again (D-54). */
interface RestartableHub {
  identity: HubIdentity;
  dir: string;
  port(): number;
  store(): HubStore;
  composed(): ComposedHub;
  start(): Promise<void>;
  stop(): Promise<void>;
  cleanup(): void;
}

function restartableHub(): RestartableHub {
  const tls = makeTlsFixture();
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-client-'));
  const dir = path.join(root, 'state');
  mkdirSync(dir, { mode: 0o700 });
  const signing = readSigningKey(generateKeyFile('signing'));
  const encryption = readEncryptionKey(generateKeyFile('encryption'), signing);
  const identity = hubIdentityOf(signing, encryption, tls.certPem, HUB_ADDRESS);
  let running: { store: HubStore; composed: ComposedHub; port: number } | undefined;
  const live = (): { store: HubStore; composed: ComposedHub; port: number } => {
    assert.ok(running !== undefined, 'the hub is running');
    return running;
  };
  return {
    identity,
    dir,
    port: () => live().port,
    store: () => live().store,
    composed: () => live().composed,
    async start() {
      const store = await openHubStore(dir);
      const health = new HealthRegistry({ version: '0.0.0-test', startedAt: NOW_MS, now: () => NOW_MS });
      const composed = composeHub({ store, identity, tls: { cert: tls.certPem, key: tls.keyPem }, health, now: () => NOW_MS });
      const port = await listen(composed.server, '127.0.0.1', 0);
      running = { store, composed, port };
    },
    async stop() {
      const { store, composed } = live();
      composed.events.closeAll();
      composed.presence.close();
      composed.sessions.close();
      composed.server.closeAllConnections();
      await new Promise<void>((resolve) => composed.server.close(() => resolve()));
      store.close();
      running = undefined;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}

async function syncWith(hub: RestartableHub, world: HubWorld, device: WorldDevice, replica: MemoryReplica, memory: HubMemory): Promise<SyncReport> {
  const transport = new HubTransport({
    address: `127.0.0.1:${hub.port()}`,
    project: world.project,
    hub: hub.identity.writer,
    trust: { pin: hub.identity.certPin },
    signer: device.signer,
    servername: 'localhost',
    now: () => new Date(NOW_MS),
  });
  try {
    return await syncOnce(transport, replica, memory, { now: () => new Date(NOW_MS) });
  } finally {
    transport.close();
  }
}

test('restored hub: after B syncs, the hub state folder is replaced by an earlier copy and the hub restarted; A names rolled-back and re-pushes, and B then pulls everything again', async () => {
  const hub = restartableHub();
  await hub.start();
  try {
    const world = createHubWorld();
    world.admitHub(hub.identity);
    const member = world.device('MEMBER-B', 'mbr-b');
    world.admitMember(member);
    const issued = issueHubFile(hub.store(), hub.identity, { days: 7, now: new Date(NOW_MS) });
    assert.ok(issued.ok);
    const enrolled = await enrolProject({ store: hub.store(), identity: hub.identity, now: new Date(NOW_MS), cache: hub.composed().cache }, world.enrolRequest(issued.file.payload));
    assert.ok(enrolled.ok, enrolled.ok ? '' : enrolled.message);
    const a = memoryReplica(world, world.lead);
    const b = memoryReplica(world, member);
    const memoryA = hubMemoryOf(new MemorySecrets());
    const memoryB = hubMemoryOf(new MemorySecrets());

    // The operator's backup: the state folder copied while the hub is stopped.
    await hub.stop();
    const backup = `${hub.dir}-backup`;
    cpSync(hub.dir, backup, { recursive: true });
    await hub.start();

    const first = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional first report' } });
    assert.ok(a.add(first.entry));
    const pushed = await syncWith(hub, world, world.lead, a, memoryA);
    assert.equal(pushed.outcome, 'synced', JSON.stringify(pushed));
    assert.equal(pushed.pushed, 1);
    const pulled = await syncWith(hub, world, member, b, memoryB);
    assert.equal(pulled.outcome, 'synced', JSON.stringify(pulled));
    assert.equal(pulled.pulled, 1);
    const second = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional second report' } });
    assert.ok(a.add(second.entry));

    // The restore: the older copy goes back and the hub starts on it.
    await hub.stop();
    rmSync(hub.dir, { recursive: true, force: true });
    cpSync(backup, hub.dir, { recursive: true });
    await hub.start();
    assert.equal(hub.store().headOf(world.project, world.project, world.lead.writer)?.hash === first.hash, false, 'the restored hub lost the first report');

    const after = await syncWith(hub, world, world.lead, a, memoryA);
    assert.ok(after.findings.some((item) => item.kind === 'rolled-back'), JSON.stringify(after.findings));
    assert.equal(after.outcome, 'attention');
    assert.equal(after.repushed, true);
    assert.equal(after.pushed, 2, 'both reports went back to the hub');
    assert.equal(hub.store().headOf(world.project, world.project, world.lead.writer)?.hash, second.hash);

    const caught = await syncWith(hub, world, member, b, memoryB);
    assert.equal(caught.outcome, 'synced', JSON.stringify(caught));
    assert.equal(caught.pulled, 1);
    assert.deepEqual(await b.heads(), await a.heads(), 'B holds everything A holds');
    rmSync(backup, { recursive: true, force: true });
  } finally {
    await hub.stop().catch(() => undefined);
    hub.cleanup();
  }
});

test('a device the hub does not admit ends refused not-admitted, and a client holding another pin ends attention with no request sent', () =>
  withHub({}, async (hub) => {
    const { world } = await enrolled(hub);
    const stranger = world.device('STRANGER', 'mbr-stranger');
    const refused = await syncOnce(transportFor(hub, world, stranger), memoryReplica(world, stranger), hubMemoryOf(new MemorySecrets()), { now: () => new Date(hub.now()) });
    assert.equal(refused.outcome, 'refused');
    assert.equal(refused.reason, 'not-admitted');

    const seen = recordRequests(hub);
    const wrongPin = new HubTransport({ address: `127.0.0.1:${hub.port}`, project: world.project, hub: hub.identity.writer, trust: { pin: '2'.repeat(64) }, signer: world.lead.signer, servername: 'localhost' });
    const attention = await syncOnce(wrongPin, memoryReplica(world, world.lead), hubMemoryOf(new MemorySecrets()));
    wrongPin.close();
    assert.equal(attention.outcome, 'attention');
    assert.equal(attention.reason, 'pin-mismatch');
    assert.deepEqual(seen, []);
  }));
