import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { HubConnection } from '../../hub/test/helpers/hubClient';
import { withHub } from '../../hub/test/helpers/hubHarness';
import { createHubWorld, otherCertPin } from '../../hub/test/helpers/hubWorld';
import { EventClient, type EventStream } from '../../hub/test/helpers/sseReader';
import { HUB_HOLD_MS, HUB_PEOPLE, openFixtureHub, type HubSmoke } from '../src/hub.ts';

function report(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('Hub worker requires fixture IPC'));
    process.send(message, (error) => { if (error) reject(error); else resolve(); });
  });
}

const origin = (port: number) => `https://127.0.0.1:${port}`;

async function smoke(): Promise<HubSmoke> {
  let result: HubSmoke | undefined;
  await withHub({ checkpoints: false }, async (hub) => {
    const registered = origin(hub.port);
    const label = randomUUID();
    const world = createHubWorld({ projectLabel: label, leadLabel: `lead-${label}` });
    world.admitHub(hub.identity);
    const participants = [world.lead];
    for (let index = 1; index < HUB_PEOPLE; index++) {
      const person = world.device(`${label}-${index}`, `mbr-${index}`);
      world.admitMember(person);
      participants.push(person);
    }
    if ((await hub.enrolProject(world))?.status !== 201) throw new Error('Fixture enrolment failed');
    const streams: EventStream[] = [];
    const appends: Awaited<ReturnType<typeof hub.openSession>>[] = [];
    const connect = () => openFixtureHub(origin(hub.port), registered, () => hub.connect());
    const sessions = { port: hub.port, now: hub.now, connect };
    for (const participant of participants) {
      const stream = await (await EventClient.open(sessions, participant, world.project)).events();
      if (stream.status !== 200 || !String(stream.headers['content-type']).startsWith('text/event-stream')) throw new Error('Fixture stream did not open');
      streams.push(stream);
      appends.push(await hub.openSession(participant, world.project, await connect()));
    }
    const health = await connect();
    await report({ type: 'ready' });
    const start = performance.now();
    const end = start + HUB_HOLD_MS;
    const appendMs: number[] = [];
    const healthMs: number[] = [];
    let refusals = 0;
    const elapsed = () => Math.max(0, Math.floor(performance.now() - start));
    const pending = appends.map(async ({ connection, token }, index) => {
      const written = world.write(participants[index]!, { kind: 'note.add', data: { text: 'Synthetic note' } });
      try {
        const response = await connection.post(`/v1/projects/${world.project}/append`, { entries: [written.entry] }, token);
        if (performance.now() >= end) return;
        const accepted = response.json<{ accepted?: unknown }>().accepted;
        if (response.status === 200 && Array.isArray(accepted) && accepted.length === 1 && accepted[0] === written.hash) appendMs.push(elapsed());
        else refusals++;
      } catch {
        if (performance.now() < end) refusals++;
      }
    });
    const probe = (async () => {
      try {
        const response = await health.get('/healthz');
        if (performance.now() >= end) return;
        if (response.status === 200) healthMs.push(elapsed());
        else refusals++;
      } catch {
        if (performance.now() < end) refusals++;
      }
    })();
    await delay(HUB_HOLD_MS);
    const openStreams = streams.filter((stream) => !stream.ended).length;
    for (const stream of streams) stream.close();
    for (const { connection } of appends) connection.close();
    health.close();
    await Promise.allSettled([...pending, probe]);
    if (openStreams !== HUB_PEOPLE || appendMs.length === 0 || healthMs.length === 0) throw new Error('Fixture observations incomplete');
    result = {
      label: 'fixture-hub', persons: participants.length, streams: openStreams, appends: appendMs.length,
      durationMs: HUB_HOLD_MS, refusals, appendMs: appendMs.sort((a, b) => a - b),
      healthMs, cpuMillicores: null, memoryBytes: null
    };
  });
  if (!result) throw new Error('Fixture observations missing');
  return result;
}

async function wrongPin(): Promise<void> {
  await withHub({ checkpoints: false }, async (hub) => {
    let requests = 0;
    hub.server.on('request', () => { requests++; });
    const registered = origin(hub.port);
    try {
      const connection = await openFixtureHub(origin(hub.port), registered, (port) => HubConnection.open(port, otherCertPin()));
      connection.close();
      throw new Error('Fixture pin unexpectedly matched');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('certificate whose pin') || requests !== 0) throw error;
    }
  });
  await report({ type: 'pin-refused' });
}

async function run(message: unknown): Promise<void> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error('Invalid fixture IPC');
  const input = message as Record<string, unknown>;
  if (input.mode === 'smoke' && Object.keys(input).length === 1) {
    await report({ type: 'result', result: await smoke() });
    return;
  }
  if (input.mode === 'wrong-pin' && Object.keys(input).length === 1) {
    await wrongPin();
    return;
  }
  if (input.mode === 'stall' && Object.keys(input).length === 3 &&
      typeof input.port === 'number' && typeof input.pin === 'string') {
    const { port, pin } = input;
    process.on('SIGTERM', () => {});
    await report({ type: 'stalled' });
    await openFixtureHub(origin(port), origin(port), (candidate) => HubConnection.open(candidate, pin));
    throw new Error('Fixture handshake unexpectedly completed');
  }
  throw new Error('Invalid fixture IPC');
}

if (!process.send || Object.keys(networkInterfaces()).join(',') !== 'lo') {
  process.exitCode = 1;
} else {
  const disconnected = () => process.exit(1);
  const finish = () => {
    process.off('disconnect', disconnected);
    if (process.connected) process.disconnect?.();
  };
  process.once('disconnect', disconnected);
  process.once('message', (message: unknown) => {
    void run(message).then(finish, () => {
      process.exitCode = 1;
      void report({ type: 'failed' }).catch(() => {}).finally(finish);
    });
  });
}
