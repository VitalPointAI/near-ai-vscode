import assert from 'node:assert/strict';
import type http from 'node:http';
import test from 'node:test';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import { withHub } from './helpers/hubHarness';
import type { Hub } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';

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
