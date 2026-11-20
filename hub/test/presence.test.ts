import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readHubFile } from '@ext/domain/replica/hubFile';
import { hubIdentityOf } from '../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { LIMITS } from '../src/limits';
import { PRESENCE_TIMING } from '../src/live/presence';
import { HubConnection } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { launchHub, startHubProcess, within } from './helpers/hubProcess';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { EventClient, ManualScheduler } from './helpers/sseReader';
import type { EventStream, Frame } from './helpers/sseReader';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 21 (D-38): presence. A device on a cell's access list posts sealed heartbeats for that cell; the hub keeps them in memory only for
// 30 seconds, coalesces them to at most one frame per cell every 250 ms with the latest value per device, and sends them only to the other devices
// on that cell's access list. The hub never opens the sealed bytes, and none of them reach its state directory or its log. All data is fictional.

interface Team {
  world: HubWorld;
  /** Base cell only. */
  analyst: WorldDevice;
  /** Base cell and the ops label cell. */
  officer: WorldDevice;
  ops: string;
}

function teamWorld(identity: Hub['identity']): Team {
  const world = createHubWorld();
  world.admitHub(identity);
  const analyst = world.device('ANALYST', 'mbr-analyst');
  const officer = world.device('OFFICER', 'mbr-officer');
  world.admitMember(analyst);
  world.admitMember(officer);
  const ops = world.labelCell('ops', [world.lead, officer]);
  return { world, analyst, officer, ops: ops.cell };
}

async function team(hub: Hub): Promise<Team> {
  const built = teamWorld(hub.identity);
  const enrolled = await hub.enrolProject(built.world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return built;
}

const withLive = (options: StartOptions, body: (hub: Hub, scheduler: ManualScheduler) => Promise<void>): Promise<void> => {
  const scheduler = new ManualScheduler();
  return withHub({ ...options, scheduler }, async (hub) => {
    scheduler.onAdvance = (ms) => hub.advance(ms);
    await body(hub, scheduler);
  });
};

const sealedOf = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');
const presencePath = (project: string): string => `/v1/projects/${project}/presence`;

/** Opens a session for the device and returns a poster for its presence on that connection. */
async function poster(hub: Hub, world: HubWorld, device: WorldDevice): Promise<(body: unknown) => Promise<{ status: number; json: Record<string, unknown>; headers: Record<string, unknown> }>> {
  const session = await hub.openSession(device, world.project);
  return async (body) => {
    const answer = await session.connection.post(presencePath(world.project), body, session.token);
    return { status: answer.status, json: answer.text === '' ? {} : answer.json(), headers: answer.headers };
  };
}

/** A base-stream note by device: a frame every other open stream receives, so nothing before it on that stream is still in flight. */
async function marker(hub: Hub, world: HubWorld, device: WorldDevice): Promise<void> {
  const written = world.write(device, { kind: 'note.add', data: { text: 'Fictional marker' } });
  const session = await hub.openSession(device, world.project);
  const answer = await session.connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, session.token);
  assert.equal(answer.status, 200, answer.text);
  session.connection.close();
}

const presenceFrames = (stream: EventStream): Frame[] => stream.frames.filter((frame) => frame.event === 'presence');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

test('presence: a heartbeat reaches the other devices on the cell within 250 ms and never a device off it, nor the one that posted it', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, analyst, officer, ops } = await team(hub);
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const own = await (await EventClient.open(hub, officer, world.project)).events();
    const outside = await (await EventClient.open(hub, analyst, world.project)).events();
    const post = await poster(hub, world, officer);
    const sealed = sealedOf('fictional sealed cursor 1');
    const answer = await post({ cell: ops, sealed });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json, { project: world.project, cell: ops });

    scheduler.advance(PRESENCE_TIMING.coalesceMs - 1);
    await settle();
    assert.equal(presenceFrames(lead).length, 0, 'a frame went out before the coalescing window closed');
    scheduler.advance(1);
    const frame = await lead.frame(1);
    assert.deepEqual(frame, { event: 'presence', id: '1', data: { project: world.project, cell: ops, devices: [{ writer: officer.writer, sealed }], left: [] } });

    await marker(hub, world, world.lead);
    await outside.until((item) => item.frames.length === 1, 'the marker to the analyst');
    assert.deepEqual(outside.frames.map((item) => item.event), ['heads']);
    await own.until((item) => item.frames.length === 1, 'the marker to the officer');
    assert.deepEqual(own.frames.map((item) => item.event), ['heads']);
  }));

test('presence: ten heartbeats from one device inside 250 ms give one frame carrying only the latest sealed value', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, officer, ops } = await team(hub);
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const post = await poster(hub, world, officer);
    for (let index = 0; index < 10; index += 1) {
      assert.equal((await post({ cell: ops, sealed: sealedOf(`fictional cursor ${index}`) })).status, 200);
      scheduler.advance(20);
    }
    scheduler.advance(PRESENCE_TIMING.coalesceMs);
    await lead.frame(1);
    await marker(hub, world, world.device('ANALYST', 'mbr-analyst'));
    await lead.until((item) => item.frames.some((frame) => frame.event === 'heads'), 'the marker');
    assert.equal(presenceFrames(lead).length, 1);
    assert.deepEqual((presenceFrames(lead)[0]?.data as { devices: unknown }).devices, [{ writer: officer.writer, sealed: sealedOf('fictional cursor 9') }]);
  }));

test('presence: a device not on the cell\'s access list is refused 403 and nothing is fanned out', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, analyst, ops } = await team(hub);
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const post = await poster(hub, world, analyst);
    const answer = await post({ cell: ops, sealed: sealedOf('fictional intrusion') });
    assert.equal(answer.status, 403);
    assert.equal(answer.json.error, 'forbidden');
    scheduler.advance(PRESENCE_TIMING.coalesceMs * 4);
    await marker(hub, world, analyst);
    await lead.until((item) => item.frames.length === 1, 'the marker');
    assert.deepEqual(lead.frames.map((frame) => frame.event), ['heads']);
    assert.equal(hub.presence.size, 0);
  }));

test('presence: a body over 2 KiB is refused 413 before it is parsed, and a malformed body is 400', () =>
  withLive({}, async (hub) => {
    const { world, officer, ops } = await team(hub);
    const big = await hub.openSession(officer, world.project);
    const tooLarge = await big.connection.post(presencePath(world.project), { cell: ops, sealed: 'A'.repeat(LIMITS.presenceBytes) }, big.token);
    assert.equal(tooLarge.status, 413);
    // A declared length past the cap is refused with no body sent at all.
    const declared = await hub.openSession(officer, world.project);
    const early = await declared.connection.call('POST', presencePath(world.project), { token: declared.token, declaredLength: LIMITS.presenceBytes + 1, headers: { 'content-type': 'application/json' } });
    assert.equal(early.status, 413);

    const post = await poster(hub, world, officer);
    const malformed: unknown[] = [
      { cell: ops },
      { cell: ops, sealed: '' },
      { cell: ops, sealed: 'not base64url!' },
      { cell: 'not-a-cell', sealed: sealedOf('x') },
      { cell: ops, leave: false },
      { cell: ops, sealed: sealedOf('x'), leave: true },
      { cell: ops, sealed: sealedOf('x'), extra: 1 },
      [ops],
      'fictional',
    ];
    for (const body of malformed) {
      const answer = await post(body);
      assert.equal(answer.status, 400, JSON.stringify(body));
      assert.equal(answer.json.error, 'malformed');
    }
    assert.equal(hub.presence.size, 0);
  }));

test('presence: an explicit leave removes the device and the next frame lists it in left', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, officer, ops } = await team(hub);
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const post = await poster(hub, world, officer);
    await post({ cell: ops, sealed: sealedOf('fictional cursor') });
    scheduler.advance(PRESENCE_TIMING.coalesceMs);
    await lead.frame(1);
    assert.equal(hub.presence.size, 1);
    assert.equal((await post({ cell: ops, leave: true })).status, 200);
    assert.equal(hub.presence.size, 0);
    scheduler.advance(PRESENCE_TIMING.coalesceMs);
    const left = await lead.frame(2);
    assert.deepEqual(left.data, { project: world.project, cell: ops, devices: [], left: [officer.writer] });
  }));

test('presence: a device that stops posting is listed in left 30 seconds after its last heartbeat, not before', () =>
  withLive({}, async (hub, scheduler) => {
    const { world, officer, ops } = await team(hub);
    const lead = await (await EventClient.open(hub, world.lead, world.project)).events();
    const post = await poster(hub, world, officer);
    await post({ cell: ops, sealed: sealedOf('fictional cursor') });
    scheduler.advance(PRESENCE_TIMING.coalesceMs);
    await lead.frame(1);
    scheduler.advance(PRESENCE_TIMING.ttlMs - PRESENCE_TIMING.coalesceMs - 1);
    await settle();
    assert.equal(presenceFrames(lead).length, 1, 'the device was listed in left before its time to live ran out');
    assert.equal(hub.presence.size, 1);
    scheduler.advance(PRESENCE_TIMING.sweepMs + PRESENCE_TIMING.coalesceMs + 1);
    const left = await lead.frame(2);
    assert.deepEqual(left.data, { project: world.project, cell: ops, devices: [], left: [officer.writer] });
    assert.equal(hub.presence.size, 0);
  }));

test('presence: heartbeats pass the per-writer token bucket, and a burst past it gets 429 with Retry-After', () =>
  withLive({ limits: { writerBurst: 3, writerPerSecond: 1 } }, async (hub) => {
    const { world, officer, ops } = await team(hub);
    const post = await poster(hub, world, officer);
    for (let index = 0; index < 3; index += 1) assert.equal((await post({ cell: ops, sealed: sealedOf(`fictional cursor ${index}`) })).status, 200);
    const refused = await post({ cell: ops, sealed: sealedOf('fictional cursor 3') });
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, 'rate-limited');
    assert.ok(Number(refused.headers['retry-after']) >= 1);
  }));

/** Every file under dir, recursively. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

test('presence: after a run of the hub binary, no sealed presence value is in any state directory file or any log line', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-presence-'));
  const tlsFixture = makeTlsFixture();
  const signingLine = generateKeyFile('signing');
  const encryptionLine = generateKeyFile('encryption');
  const secrets = { HUB_TLS_CERT: tlsFixture.certPem, HUB_TLS_KEY: tlsFixture.keyPem, HUB_SIGNING_KEY: `${signingLine}\n`, HUB_ENCRYPTION_KEY: `${encryptionLine}\n` };
  const stateDir = path.join(root, 'state');
  const signing = readSigningKey(signingLine);
  const identity = hubIdentityOf(signing, readEncryptionKey(encryptionLine, signing), tlsFixture.certPem, HUB_ADDRESS);
  const runs: Array<{ cleanup(): void }> = [];
  try {
    const issue = launchHub({ args: ['--hub-file', '7'], secrets, stateDir, env: { HUB_PUBLIC_ADDRESS: HUB_ADDRESS } });
    runs.push(issue);
    assert.equal((await within(issue.exited, 20_000, 'the hub file')).code, 0, issue.stdout());
    const file = readHubFile(issue.stdout().trim(), new Date());
    assert.ok(file.ok);
    const run = await startHubProcess({ secrets, stateDir });
    runs.push(run);
    const { world, officer, ops } = teamWorld(identity);
    const enrol = await HubConnection.open(run.port, identity.certPin);
    assert.equal((await enrol.post('/v1/enrol', world.enrolRequest(file.hubFile))).status, 201);
    enrol.close();

    const connections: HubConnection[] = [];
    const endpoint = {
      port: run.port,
      now: () => Date.now(),
      connect: async () => {
        const connection = await HubConnection.open(run.port, identity.certPin);
        connections.push(connection);
        return connection;
      },
    };
    const canaries = ['FICTIONAL-PRESENCE-CANARY-ALPHA', 'FICTIONAL-PRESENCE-CANARY-BRAVO'];
    const lead = await (await EventClient.open(endpoint, world.lead, world.project)).events();
    const officerClient = await EventClient.open(endpoint, officer, world.project);
    for (const canary of canaries) assert.equal((await officerClient.call('POST', presencePath(world.project), { json: { cell: ops, sealed: sealedOf(canary) } })).status, 200);
    await lead.until((item) => presenceFrames(item).length === 1, 'the presence frame', 10_000);
    assert.deepEqual((presenceFrames(lead)[0]?.data as { devices: unknown }).devices, [{ writer: officer.writer, sealed: sealedOf(canaries[1] as string) }]);
    assert.equal((await officerClient.call('POST', presencePath(world.project), { json: { cell: ops, leave: true } })).status, 200);
    await lead.until((item) => presenceFrames(item).length === 2, 'the left frame', 10_000);

    // A clean stop ends the open stream and closes the store.
    const stopped = await within(run.kill('SIGTERM'), 15_000, 'the stop');
    assert.equal(stopped.code, 0, run.stdout());
    for (const connection of connections) connection.close();

    const needles = canaries.flatMap((canary) => [Buffer.from(canary, 'utf8'), Buffer.from(sealedOf(canary), 'utf8')]);
    const files = filesUnder(stateDir);
    assert.ok(files.length > 0);
    for (const name of files) {
      const bytes = readFileSync(name);
      for (const needle of needles) assert.equal(bytes.includes(needle), false, `${path.relative(stateDir, name)} holds a presence value`);
    }
    const logs = run.stdout() + run.stderr();
    for (const needle of needles) assert.equal(logs.includes(needle.toString('utf8')), false, 'a log line holds a presence value');
  } finally {
    for (const item of runs) item.cleanup();
    tlsFixture.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
