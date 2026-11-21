import assert from 'node:assert/strict';
import type https from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSessionAnswer, readSessionAnswer } from '@ext/domain/replica/hubFile';
import type { SessionExpectation, SessionRead } from '@ext/domain/replica/hubFile';
import type { PayloadSigner } from '@ext/domain/team/signedPayload';
import { enrolProject, hubIdentityOf, issueHubFile } from '../../src/enrol';
import type { HubIdentity } from '../../src/enrol';
import { HealthRegistry } from '../../src/health';
import type { SessionRegistry } from '../../src/http/session';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../../src/keys';
import type { RateLimitOptions } from '../../src/limits';
import type { RosterCache } from '../../src/append/rosterCache';
import type { Checkpointer } from '../../src/checkpoints';
import type { JoinChecks, JoinDesk } from '../../src/join';
import type { EventHub, Scheduler } from '../../src/live/events';
import type { PresenceHub } from '../../src/live/presence';
import { composeHub, sweepBlobsOnce } from '../../src/main';
import { listen } from '../../src/http/server';
import { openHubStore } from '../../src/store/hubStore';
import type { HubStore } from '../../src/store/hubStore';
import type { EquivocationProof } from '@ext/domain/replica/equivocation';
import { HubConnection } from './hubClient';
import type { HubResponse } from './hubClient';
import { HUB_ADDRESS, NOW_MS } from './hubWorld';
import type { HubWorld } from './hubWorld';
import { makeTlsFixture } from './tlsFixture';
import type { TlsFixture } from './tlsFixture';

// The hub in process for the API and session tests (32-20): the same composition the binary runs (main.ts composeHub), with a temporary state
// directory, a fresh TLS certificate from openssl, fresh hub key lines, port 0, and an injectable clock, authentication deadline and rate limits.
// The clock starts at the hub world's time; tests move it with advance(). Every answer check is counted, so a test can show the hub refused a call
// before it verified anything.

export interface StartOptions {
  now?: number;
  deadlineMs?: number;
  limits?: RateLimitOptions;
  /** Event streams one address may hold (WR-04); the hub's own limit when absent. */
  eventStreamsPerAddress?: number;
  /** The scheduler of the event streams (32-21): keep-alive comments, stuck readers and presence; real timers when absent. */
  scheduler?: Scheduler;
  /** Signed checkpoints (32-22); on unless false. */
  checkpoints?: boolean;
  /** A state directory to use and keep (32-22, a hub restarted on the same or a restored database); a fresh one removed on close when absent. */
  dir?: string;
  /** The hub's key lines and TLS pair to reuse (32-22, the same hub started again); fresh ones when absent. A given TLS pair is not cleaned up. */
  keys?: { signing: string; encryption: string };
  tls?: TlsFixture;
  /** The join post's signature and MAC checks (32-25), so a test can count them; the real ones when absent. */
  joinChecks?: JoinChecks;
}

export interface OpenedSession {
  connection: HubConnection;
  token: string;
  project: string;
  expiresAt: string;
}

export interface Hub {
  port: number;
  dir: string;
  tls: TlsFixture;
  store: HubStore;
  identity: HubIdentity;
  sessions: SessionRegistry;
  cache: RosterCache;
  server: https.Server;
  /** The open event streams (32-21). */
  events: EventHub;
  /** Presence in memory (32-21). */
  presence: PresenceHub;
  /** The checkpoint signer (32-22); undefined when turned off. */
  checkpoints: Checkpointer | undefined;
  /** Invitations and join requests (32-25). */
  join: JoinDesk;
  /** Every join desk log line (32-25). */
  joinLogs: Array<{ level: string; event: string; fields: Record<string, string | number> }>;
  /** Every checkpoint log line (32-22). */
  checkpointLogs: Array<{ level: string; event: string; fields: Record<string, string | number> }>;
  /** The key lines the hub runs with, to start the same hub again. */
  keys: { signing: string; encryption: string };
  /** The injected clock, in milliseconds. */
  now(): number;
  advance(ms: number): void;
  /** How many session answers reached the signature check. */
  answerChecks(): number;
  accepted: Array<{ project: string; accepted: readonly string[]; rosterChanged: boolean }>;
  equivocations: Array<{ project: string; proofs: readonly EquivocationProof[] }>;
  /** A new connection to the hub, its pin checked. */
  connect(): Promise<HubConnection>;
  /** Issues a hub file and enrols the world's project over HTTPS on its own connection; returns the answer. */
  enrolProject(world: HubWorld, options?: { direct?: boolean }): Promise<HubResponse | undefined>;
  /** Opens a session for a device on a new connection (or the one given) and returns the token. */
  openSession(device: { signer: PayloadSigner }, project: string, connection?: HubConnection): Promise<OpenedSession>;
  /** One run of the hourly blob sweep at the injected clock. */
  sweep(): Promise<number>;
  close(): Promise<void>;
}

export async function startHub(options: StartOptions = {}): Promise<Hub> {
  const tlsFixture = options.tls ?? makeTlsFixture();
  const dir = options.dir ?? (await mkdtemp(path.join(tmpdir(), 'near-ai-hub-api-')));
  const store = await openHubStore(dir);
  const keys = options.keys ?? { signing: generateKeyFile('signing'), encryption: generateKeyFile('encryption') };
  const signing = readSigningKey(keys.signing);
  const encryption = readEncryptionKey(keys.encryption, signing);
  const identity = hubIdentityOf(signing, encryption, tlsFixture.certPem, HUB_ADDRESS);
  let clock = options.now ?? NOW_MS;
  let checks = 0;
  const accepted: Hub['accepted'] = [];
  const equivocations: Hub['equivocations'] = [];
  const checkpointLogs: Hub['checkpointLogs'] = [];
  const joinLogs: Hub['joinLogs'] = [];
  const readAnswer = (answer: unknown, expected: SessionExpectation): SessionRead => {
    checks += 1;
    return readSessionAnswer(answer, expected);
  };
  const health = new HealthRegistry({ version: '0.0.0-test', startedAt: clock, now: () => clock });
  const composed = composeHub({
    store,
    identity,
    tls: { cert: tlsFixture.certPem, key: tlsFixture.keyPem },
    health,
    now: () => clock,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.limits === undefined ? {} : { rateLimits: options.limits }),
    ...(options.eventStreamsPerAddress === undefined ? {} : { eventStreamsPerAddress: options.eventStreamsPerAddress }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    readAnswer,
    signCheckpoints: options.checkpoints !== false,
    onCheckpointLog: (level, event, fields) => checkpointLogs.push({ level, event, fields }),
    ...(options.joinChecks === undefined ? {} : { joinChecks: options.joinChecks }),
    onJoinLog: (level, event, fields) => joinLogs.push({ level, event, fields }),
    onAccepted: (project, list, rosterChanged) => accepted.push({ project, accepted: list, rosterChanged }),
    onEquivocation: (project, proofs) => equivocations.push({ project, proofs }),
  });
  const port = await listen(composed.server, '127.0.0.1', 0);
  const connections: HubConnection[] = [];

  const hub: Hub = {
    port,
    dir,
    tls: tlsFixture,
    store,
    identity,
    sessions: composed.sessions,
    cache: composed.cache,
    server: composed.server,
    events: composed.events,
    presence: composed.presence,
    checkpoints: composed.checkpoints,
    checkpointLogs,
    join: composed.join,
    joinLogs,
    keys,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    answerChecks: () => checks,
    accepted,
    equivocations,
    async connect() {
      const connection = await HubConnection.open(port, identity.certPin);
      connections.push(connection);
      return connection;
    },
    async enrolProject(world, enrolOptions = {}) {
      const issued = issueHubFile(store, identity, { days: 7, now: new Date(clock) });
      assert.ok(issued.ok, issued.ok ? '' : issued.message);
      const request = world.enrolRequest(issued.file.payload);
      if (enrolOptions.direct === true) {
        const result = await enrolProject({ store, identity, now: new Date(clock), cache: composed.cache }, request);
        assert.ok(result.ok, result.ok ? '' : result.message);
        return undefined;
      }
      const connection = await hub.connect();
      try {
        return await connection.post('/v1/enrol', request);
      } finally {
        connection.close();
      }
    },
    async openSession(device, project, given) {
      const connection = given ?? (await hub.connect());
      const challenge = await connection.post('/v1/session', { project });
      assert.equal(challenge.status, 200, challenge.text);
      const body = challenge.json<{ project: string; hub: string; challenge: string }>();
      const answer = buildSessionAnswer(device.signer, { hub: body.hub, project, challenge: body.challenge, keying: connection.keying(), now: new Date(clock) });
      const opened = await connection.post('/v1/session', { answer });
      assert.equal(opened.status, 200, opened.text);
      const session = opened.json<{ project: string; token: string; expiresAt: string }>();
      return { connection, token: session.token, project: session.project, expiresAt: session.expiresAt };
    },
    sweep: () => sweepBlobsOnce(store, clock),
    async close() {
      composed.checkpoints?.stop();
      await composed.checkpoints?.settled();
      composed.join.stop();
      composed.events.closeAll();
      composed.presence.close();
      for (const connection of connections) connection.close();
      composed.sessions.close();
      composed.server.closeAllConnections();
      await new Promise<void>((resolve) => composed.server.close(() => resolve()));
      store.close();
      if (options.dir === undefined) await rm(dir, { recursive: true, force: true });
      if (options.tls === undefined) tlsFixture.cleanup();
    },
  };
  return hub;
}

/** Runs body with a fresh hub and always closes it. */
export async function withHub(options: StartOptions, body: (hub: Hub) => Promise<void>): Promise<void> {
  const hub = await startHub(options);
  try {
    await body(hub);
  } finally {
    await hub.close();
  }
}
