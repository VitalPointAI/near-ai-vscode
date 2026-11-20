// The client side of your organization's sync hub (32-23; D-29, D-35, D-36, D-37, D-41, D-46, D-49 to D-51, D-54, D-58, D-70): the pinned transport
// against a scripted hub on 127.0.0.1 with the cyber fixture certificate, and the one-shot sync against that hub with a real ReplicaProject. Every
// connection state and every finding has a test. All names and data are fictional.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import * as net from 'node:net';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { buildGrant, grantHash, wrapEpochKey, x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '../domain/replica/cellKeys';
import { checkpointHash, signCheckpoint } from '../domain/replica/checkpoint';
import type { SignedCheckpoint } from '../domain/replica/checkpoint';
import { GENESIS_PREV, buildEntry, entryHash } from '../domain/replica/entry';
import type { BuiltEntry, Dep, SealedBlob, SealedEntry } from '../domain/replica/entry';
import { certPinOf } from '../domain/replica/hubFile';
import { WITHHELD_GRACE_MS, createWitness, readWitness, serializeWitness } from '../domain/replica/hubWitness';
import type { WitnessState } from '../domain/replica/hubWitness';
import { joinSecretHash, newJoinSecret } from '../domain/replica/invite';
import type { SecretStorageLike } from '../services/auth';
import { HUB_WITNESS_SECRET_PREFIX, hubMemoryOf, hubWitnessKey, syncOnce } from '../staff/replica/hubSync';
import type { SyncReport } from '../staff/replica/hubSync';
import { ReplicaProject, syncLocalOf } from '../staff/replica/replicaProject';
import type { ReplicaProjectDeps } from '../staff/replica/replicaProject';
import { DEMO_CLEARANCE, INVITE_EXPIRES } from './helpers/replicaRosterWorld';
import { canonicalBytes, fingerprintOf } from '../domain/team/canonical';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { APPEND_MAX_ENTRIES, CONNECT_TIMEOUT_MS, HubTransport, HubTransportError, RESPONSE_MAX_BYTES, appendBatches } from '../staff/replica/hubTransport';
import type { EventReport, HubTransportOptions } from '../staff/replica/hubTransport';
import { FIXTURE_CA, FIXTURE_CERT, FakeHubServer, fakeHubState, hubRoutes, seedGrants, seedHub } from './helpers/fakeHubServer';
import type { FakeAnswer, FakeHandler, FakeHubOptions, FakeHubState } from './helpers/fakeHubServer';

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
// The 16-byte PKCS8 prefix of an Ed25519 private key; the 32-byte seed follows it. A DER header, not a key.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A device signer whose key comes from a label alone. */
function labelSigner(label: string): PayloadSigner & { writer: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, sha256(`hub-transport/${label}`)]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const publicKey = raw.toString('base64url');
  return { fingerprint: fingerprintOf(raw), publicKey, writer: sha256Hex(raw), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
}

const PROJECT = sha256('hub-transport/project').toString('hex').slice(0, 32);
const OTHER_PROJECT = sha256('hub-transport/other-project').toString('hex').slice(0, 32);
const OTHER_STREAM = sha256('hub-transport/other-stream').toString('hex').slice(0, 32);
const HUB = sha256Hex(sha256('hub-transport/hub'));
const DEVICE = labelSigner('DEVICE');
const PIN = certPinOf(FIXTURE_CERT);
const NOW = new Date('2026-11-20T10:00:00.000Z');
const HASH_A = sha256Hex(Buffer.from('a'));

const headsBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ project: PROJECT, rosterHead: HASH_A, streams: [], grants: [], ...extra });

function options(fake: FakeHubServer, more: Partial<HubTransportOptions> = {}): HubTransportOptions {
  return { address: fake.address, project: PROJECT, hub: HUB, trust: { pin: PIN }, signer: DEVICE, servername: 'localhost', now: () => NOW, ...more };
}

/** A scripted hub and a transport to it; both closed afterwards. */
async function withFake(fakeOptions: Partial<FakeHubOptions>, body: (fake: FakeHubServer, transport: HubTransport) => Promise<void>, more: Partial<HubTransportOptions> = {}): Promise<void> {
  const fake = await FakeHubServer.start({ project: PROJECT, hub: HUB, ...fakeOptions });
  const transport = new HubTransport(options(fake, more));
  try {
    await body(fake, transport);
  } finally {
    transport.close();
    await fake.close();
  }
}

/** Routes by method and path; a path not listed answers 404. */
function routes(table: Record<string, FakeHandler>): FakeHandler {
  return (req) => {
    const route = table[`${req.method} ${req.path}`];
    return route === undefined ? { status: 404, json: { error: 'not-found', message: 'Nothing here.' } } : route(req);
  };
}

async function failure(promise: Promise<unknown>): Promise<HubTransportError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HubTransportError, `a HubTransportError, got ${String(error)}`);
    return error;
  }
  assert.fail('the call did not fail');
}

const HEADS = `GET /v1/projects/${PROJECT}/heads`;

// ---- Task 2: pins, CA, sessions per connection, limits ---------------------------------------------------------------------------------------------

test('pin-mismatch: a hub presenting the fixture certificate to a transport with another pin is refused before any request byte, and the server records zero requests', async () => {
  await withFake({ handle: () => ({ json: headsBody() }) }, async (fake, transport) => {
    const error = await failure(transport.hubHeads());
    assert.equal(error.failure, 'pin-mismatch');
    assert.equal(fake.requests.length, 0, 'no request reached the server');
    assert.ok(error.message.includes('nothing was sent'));
  }, { trust: { pin: '0'.repeat(64) } });
});

test('the right pin works: the session answer names the hub writer id, the project and that connection\'s keying material, and heads are read', async () => {
  await withFake({ handle: routes({ [HEADS]: () => ({ json: headsBody({ streams: [{ stream: PROJECT, heads: [{ writer: DEVICE.writer, seq: 3, hash: HASH_A }] }], grants: [HASH_A] }) }) }) }, async (fake, transport) => {
    const heads = await transport.hubHeads();
    assert.deepEqual(heads.streams, [{ stream: PROJECT, heads: [{ writer: DEVICE.writer, seq: 3, hash: HASH_A }] }]);
    assert.deepEqual(heads.grants, [HASH_A]);
    // The scripted hub checked the answer with readSessionAnswer against its writer id, the project, the challenge and its own keying material.
    assert.deepEqual(fake.sessions.map((item) => [item.connection, item.answerOk]), [[1, true]]);
    assert.equal(fake.sessions[0]?.keying.length, 32);
    const call = fake.calls()[0];
    assert.equal(call?.tokenOf, call?.connection, 'the token was used on the connection it was issued on');
    assert.equal(transport.kind, 'hub');
    assert.equal(transport.live, true);
    assert.equal(transport.enforcesAppend, true);
  });
});

test('your organization\'s CA mode accepts the fixture server certificate through the fixture CA and checks the address it names', async () => {
  await withFake({ handle: () => ({ json: headsBody() }) }, async (fake, transport) => {
    const heads = await transport.hubHeads();
    assert.equal(heads.project, PROJECT);
    assert.equal(fake.calls().length, 1);
  }, { trust: { ca: FIXTURE_CA }, servername: '127.0.0.1' });
  // The same CA, but the certificate does not name the host the transport expects.
  await withFake({ handle: () => ({ json: headsBody() }) }, async (fake, transport) => {
    assert.equal((await failure(transport.hubHeads())).failure, 'ca-refused');
    assert.equal(fake.requests.length, 0);
  }, { trust: { ca: FIXTURE_CA }, servername: 'hub.example.org' });
});

test('CA mode refuses ca-refused a server whose certificate the pinned CA did not issue, before any request', async () => {
  await withFake({ otherCert: true, handle: () => ({ json: headsBody() }) }, async (fake, transport) => {
    const error = await failure(transport.hubHeads());
    assert.equal(error.failure, 'ca-refused');
    assert.equal(fake.requests.length, 0);
  }, { trust: { ca: FIXTURE_CA }, servername: '127.0.0.1' });
});

test('trust is a closed choice of a pin or your organization\'s CA: none, both, a malformed pin or a CA that is not PEM is refused, so the system\'s authorities are never the trust', () => {
  const base = { address: '127.0.0.1:1', project: PROJECT, hub: HUB, signer: DEVICE };
  for (const trust of [undefined, {}, { pin: PIN, ca: FIXTURE_CA }, { pin: 'abc' }, { pin: PIN.toUpperCase() }, { ca: 'not a certificate' }, { system: true }]) {
    assert.throws(() => new HubTransport({ ...base, trust } as unknown as HubTransportOptions), /trusted/);
  }
  assert.throws(() => new HubTransport({ ...base, trust: { pin: PIN }, address: 'no-port' }), /host:port/);
  assert.throws(() => new HubTransport({ ...base, trust: { pin: PIN }, hub: 'hub-1234' }), /writer id/);
  assert.equal(CONNECT_TIMEOUT_MS, 10_000);
});

test('unreachable: a hub that never finishes TLS within the injected limit ends unreachable, and so does a closed port', async () => {
  const held: net.Socket[] = [];
  const silent = net.createServer((socket) => { held.push(socket); });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const port = (silent.address() as net.AddressInfo).port;
  try {
    const transport = new HubTransport({ address: `127.0.0.1:${port}`, project: PROJECT, hub: HUB, trust: { pin: PIN }, signer: DEVICE, connectTimeoutMs: 150 });
    const started = Date.now();
    assert.equal((await failure(transport.hubHeads())).failure, 'unreachable');
    assert.ok(Date.now() - started < 5_000, 'the injected limit ended the wait');
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
  const closed = new HubTransport({ address: `127.0.0.1:${port}`, project: PROJECT, hub: HUB, trust: { pin: PIN }, signer: DEVICE, connectTimeoutMs: 2_000 });
  assert.equal((await failure(closed.hubHeads())).failure, 'unreachable');
});

test('session refused: a 403 session-refused answer ends session-refused with the hub\'s reason id, for not-admitted and quarantined', async () => {
  for (const reason of ['not-admitted', 'quarantined', 'not-a-person-device']) {
    await withFake({ session: (step) => (step === 'answer' ? { status: 403, json: { error: 'session-refused', reason, message: 'Refused.' } } : undefined) }, async (fake, transport) => {
      const error = await failure(transport.hubHeads());
      assert.equal(error.failure, 'session-refused');
      assert.equal(error.reason, reason);
      assert.equal(fake.calls().length, 0, 'no call after a refused session');
    });
  }
});

test('a call refused 401 revoked ends session-refused revoked, and no new session is tried for it', async () => {
  await withFake({ handle: () => ({ status: 401, json: { error: 'unauthenticated', reason: 'revoked', message: 'Revoked.' } }) }, async (fake, transport) => {
    const error = await failure(transport.hubHeads());
    assert.equal(error.failure, 'session-refused');
    assert.equal(error.reason, 'revoked');
    assert.equal(fake.sessions.length, 1);
  });
});

test('new session: after the hub closes the connection, the next call opens a new connection and a new session first, and the old token is never sent on it', async () => {
  await withFake({ handle: routes({ [HEADS]: () => ({ json: headsBody(), closeAfter: true }) }) }, async (fake, transport) => {
    await transport.hubHeads();
    // Wait until the client has seen the close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await transport.hubHeads();
    assert.equal(fake.connections, 2);
    assert.deepEqual(fake.sessions.map((item) => [item.connection, item.answerOk]), [[1, true], [2, true]]);
    const calls = fake.calls();
    assert.deepEqual(calls.map((call) => [call.connection, call.tokenOf]), [[1, 1], [2, 2]]);
    assert.ok(fake.requests.every((req) => req.tokenOf === undefined || req.tokenOf === req.connection), 'no token was sent on another connection');
  });
});

test('new session on the same connection when the hub no longer knows the token (401 unknown-token), then the call is tried once more', async () => {
  let first = true;
  await withFake({
    handle: routes({ [HEADS]: () => ({ json: headsBody() }) }),
    tokenCheck: () => {
      if (!first) return undefined;
      first = false;
      return { status: 401, json: { error: 'unauthenticated', reason: 'token-expired', message: 'Expired.' } };
    }
  }, async (fake, transport) => {
    const heads = await transport.hubHeads();
    assert.equal(heads.project, PROJECT);
    assert.equal(fake.connections, 1, 'the same connection');
    assert.equal(fake.sessions.length, 2, 'a new session on it');
    assert.equal(fake.calls().length, 2);
  });
});

test('a call on a reused connection that the hub drops in flight is tried once more on a new connection with a new session', async () => {
  let calls = 0;
  await withFake({ handle: routes({ [HEADS]: () => (++calls === 2 ? { destroy: true } : { json: headsBody() }) }) }, async (fake, transport) => {
    await transport.hubHeads();
    await transport.hubHeads();
    assert.equal(fake.connections, 2);
    assert.equal(fake.sessions.length, 2);
    assert.equal(calls, 3);
  });
});

test('429 rate-limited surfaces the hub\'s Retry-After', async () => {
  await withFake({ handle: () => ({ status: 429, headers: { 'retry-after': '17' }, json: { error: 'rate-limited', message: 'Wait.' } }) }, async (_fake, transport) => {
    const error = await failure(transport.hubHeads());
    assert.equal(error.failure, 'rate-limited');
    assert.equal(error.retryAfterSeconds, 17);
  });
});

test('too-large: an answer whose declared length passes the limit (4 MiB plus envelope) is refused before it is read, and a streamed one when it passes it', async () => {
  assert.equal(RESPONSE_MAX_BYTES, 4 * 1024 * 1024 + 256 * 1024);
  await withFake({ handle: () => ({ json: headsBody(), headers: { 'content-length': String(RESPONSE_MAX_BYTES + 1) } }) }, async (_fake, transport) => {
    assert.equal((await failure(transport.hubHeads())).failure, 'too-large');
  });
  const big = Buffer.alloc(RESPONSE_MAX_BYTES + 1024, 0x20);
  await withFake({
    handle: () => ({
      stream: (res): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"project":"');
        res.end(big);
      }
    })
  }, async (_fake, transport) => {
    assert.equal((await failure(transport.hubHeads())).failure, 'too-large');
  });
});

test('wrong-project: heads naming another project, and a catch-up page naming another stream or writer, are refused and nothing from them is returned', async () => {
  await withFake({ handle: () => ({ json: headsBody({ project: OTHER_PROJECT }) }) }, async (_fake, transport) => {
    const error = await failure(transport.hubHeads());
    assert.equal(error.failure, 'wrong-project');
    assert.deepEqual(error.detail.label, { project: OTHER_PROJECT });
  });
  const page = (extra: Record<string, unknown>): FakeAnswer => ({ json: { project: PROJECT, stream: PROJECT, writer: DEVICE.writer, entries: [{ header: {}, body: '' }], more: false, head: null, ...extra } });
  for (const extra of [{ stream: OTHER_STREAM }, { writer: HASH_A }, { project: OTHER_PROJECT }]) {
    await withFake({ handle: () => page(extra) }, async (_fake, transport) => {
      const error = await failure(transport.entries(PROJECT, DEVICE.writer, 0));
      assert.equal(error.failure, 'wrong-project');
    });
  }
  await withFake({ handle: () => page({}) }, async (_fake, transport) => {
    const read = await transport.entries(PROJECT, DEVICE.writer, 0);
    assert.equal(read.entries.length, 1);
  });
});

test('wrong-hub: a challenge naming another hub is refused before any answer is sent', async () => {
  await withFake({ session: (step) => (step === 'challenge' ? { json: { project: PROJECT, hub: HASH_A, challenge: Buffer.alloc(32, 1).toString('base64url') } } : undefined) }, async (fake, transport) => {
    assert.equal((await failure(transport.hubHeads())).failure, 'wrong-hub');
    assert.equal(fake.requests.length, 1, 'only the challenge request');
  });
});

// ---- the event reader ----

const EVENTS = `GET /v1/projects/${PROJECT}/events`;

/** A stream that writes its frames and ends at once, or after endAfterMs (so a reader that misses a stop still sees the end). */
function sse(frames: string[], endAfterMs = 0): FakeAnswer {
  return {
    stream: (res): void => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const frame of frames) res.write(frame);
      if (endAfterMs === 0) res.end();
      else setTimeout(() => res.end(), endAfterMs).unref();
    }
  };
}

async function readAll(transport: HubTransport): Promise<EventReport[]> {
  const reader = await transport.events();
  const reports: EventReport[] = [];
  for await (const report of reader) reports.push(report);
  return reports;
}

test('event reader: frames parsed in order, comment lines ignored, retry read, an id gap reported, on a connection and session of its own', { timeout: 10_000 }, async () => {
  const data = (value: Record<string, unknown>): string => JSON.stringify({ project: PROJECT, ...value });
  await withFake({
    handle: routes({
      [HEADS]: () => ({ json: headsBody() }),
      [EVENTS]: () => sse([
        'retry: 2500\n\n',
        `event: heads\nid: 1\ndata: ${data({ stream: PROJECT, heads: [{ writer: DEVICE.writer, seq: 1, hash: HASH_A }] })}\n\n`,
        ': keep-alive\n\n',
        `event: roster\nid: 2\ndata: ${data({ head: HASH_A })}\n\n`,
        `event: presence\nid: 4\ndata: ${data({ cell: PROJECT, devices: [], left: [] })}\n\n`,
        `event: checkpoint\nid: 5\ndata: ${data({})}\n\n`
      ])
    })
  }, async (fake, transport) => {
    await transport.hubHeads();
    const reader = await transport.events();
    const reports: EventReport[] = [];
    for await (const report of reader) reports.push(report);
    assert.equal(reader.retryMs, 2500);
    assert.deepEqual(reports.map((report) => (report.kind === 'frame' ? `${report.event}:${report.id}` : report.kind === 'gap' ? `gap:${report.expected}>${report.got}` : report.kind)), ['heads:1', 'roster:2', 'gap:3>4', 'presence:4', 'checkpoint:5', 'closed']);
    const stream = fake.requests.find((req) => req.path.endsWith('/events'));
    const heads = fake.requests.find((req) => req.path.endsWith('/heads'));
    assert.ok(stream !== undefined && heads !== undefined);
    assert.notEqual(stream.connection, heads.connection, 'the stream has its own connection');
    assert.equal(stream.tokenOf, stream.connection, 'and its own session');
    assert.equal(stream.headers['last-event-id'], undefined, 'Last-Event-ID is never sent');
    assert.equal(fake.sessions.length, 2);
  });
});

test('event reader: 204 is reported as stopped, and the reader ends', { timeout: 10_000 }, async () => {
  await withFake({ handle: routes({ [EVENTS]: () => ({ stream: (res): void => { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); } }) }) }, async (_fake, transport) => {
    assert.deepEqual(await readAll(transport), [{ kind: 'stopped' }]);
  });
});

test('event reader: resync is reported and the stream closed for catch-up; a frame naming another project is refused; a stream that ends is reported closed', { timeout: 10_000 }, async () => {
  const frame = (event: string, id: number, project = PROJECT): string => `event: ${event}\nid: ${id}\ndata: ${JSON.stringify({ project })}\n\n`;
  await withFake({ handle: routes({ [EVENTS]: () => sse([frame('roster', 1), frame('heads', 2, OTHER_PROJECT), frame('resync', 3), frame('roster', 4)], 300) }) }, async (_fake, transport) => {
    const reports = await readAll(transport);
    assert.deepEqual(reports.map((report) => report.kind), ['frame', 'wrong-project', 'resync']);
  });
  await withFake({ handle: routes({ [EVENTS]: () => sse([frame('roster', 1)]) }) }, async (_fake, transport) => {
    assert.deepEqual((await readAll(transport)).map((report) => report.kind), ['frame', 'closed']);
  });
});

test('subscribe hands heads frames to onHeads and each presence device\'s sealed bytes to onPresence', { timeout: 10_000 }, async () => {
  const sealed = Buffer.from('fictional sealed cursor').toString('base64url');
  const data = (value: Record<string, unknown>): string => JSON.stringify({ project: PROJECT, ...value });
  await withFake({
    handle: routes({
      [EVENTS]: () => sse([
        `event: heads\nid: 1\ndata: ${data({ stream: PROJECT, heads: [{ writer: DEVICE.writer, seq: 2, hash: HASH_A }] })}\n\n`,
        `event: presence\nid: 2\ndata: ${data({ cell: PROJECT, devices: [{ writer: HASH_A, sealed }], left: [] })}\n\n`
      ])
    })
  }, async (_fake, transport) => {
    const heads: unknown[] = [];
    const presence: string[] = [];
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { done = resolve; });
    const stop = transport.subscribe((value) => heads.push(value), (bytes) => { presence.push(Buffer.from(bytes).toString('utf8')); done(); });
    await finished;
    stop();
    assert.deepEqual(heads, [{ streams: [{ stream: PROJECT, heads: [{ writer: DEVICE.writer, seq: 2, hash: HASH_A }] }] }]);
    assert.deepEqual(presence, ['fictional sealed cursor']);
  });
});

// ---- enrol, append, blobs, grants, checkpoints ----

test('enrol posts without a session on a connection of its own and returns the project, roster head and hub id', async () => {
  await withFake({ handle: routes({ 'POST /v1/enrol': (req) => ({ status: 201, json: { project: PROJECT, rosterHead: HASH_A, hub: 'hub-0123456789abcdef', echo: (req.json() as { marker: string }).marker } }) }) }, async (fake, transport) => {
    const answer = await transport.enrol({ marker: 'fictional' });
    assert.deepEqual(answer, { project: PROJECT, rosterHead: HASH_A, hub: 'hub-0123456789abcdef' });
    assert.equal(fake.sessions.length, 0, 'no session');
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0]?.headers.authorization, undefined);
  });
});

test('append carries grants and blobRefs, and a 409 blob-missing answer puts the named blob and sends the batch once more', async () => {
  const blobBytes = Buffer.from('fictional sealed blob bytes');
  const blob = { hash: sha256Hex(blobBytes), bytes: blobBytes.toString('base64url') };
  const entry = { header: { v: 2, stream: PROJECT, writer: DEVICE.writer, seq: 0, prev: '0'.repeat(64), epoch: 1, body: { hash: HASH_A, size: 1 }, sig: 'x' }, body: 'AA' } as never;
  const stored = new Map<string, Buffer>();
  const appends: unknown[] = [];
  await withFake({
    handle: routes({
      [`POST /v1/projects/${PROJECT}/append`]: (req) => {
        appends.push(req.json());
        if (!stored.has(blob.hash)) return { status: 409, json: { error: 'blob-missing', message: 'Missing.' } };
        return { json: { project: PROJECT, accepted: [HASH_A], refused: [], rosterHead: HASH_A } };
      },
      [`PUT /v1/blobs/${blob.hash}`]: (req) => {
        stored.set(blob.hash, req.body);
        return { status: 201, json: { project: PROJECT, hash: blob.hash } };
      }
    })
  }, async (_fake, transport) => {
    const answer = await transport.append({ entries: [entry], grants: [{ fictional: 'grant' }], blobRefs: [{ entry: HASH_A, blob: blob.hash }] }, (hash) => (hash === blob.hash ? blob : undefined));
    assert.deepEqual(answer.accepted, [HASH_A]);
    assert.equal(answer.blobsPut, true);
    assert.deepEqual(stored.get(blob.hash), blobBytes);
    assert.equal(appends.length, 2, 'sent once more after the blob was put');
    assert.deepEqual(appends[0], { entries: [entry], grants: [{ fictional: 'grant' }], blobRefs: [{ entry: HASH_A, blob: blob.hash }] });
  });
});

test('appendBatches keeps each append within 200 entries and 64 grants, grants first, with the blobRefs of its own entries', () => {
  const entries = Array.from({ length: 450 }, (_, seq) => ({ header: { seq }, body: '' }) as never);
  const grants = Array.from({ length: 70 }, (_, n) => ({ grant: n }));
  const refs = [{ entry: 'e-0', blob: 'b-0' }, { entry: 'e-449', blob: 'b-449' }];
  const batches = appendBatches(entries, grants, refs, (entry) => `e-${(entry as { header: { seq: number } }).header.seq}`);
  assert.ok(batches.every((batch) => batch.entries.length <= APPEND_MAX_ENTRIES && (batch.grants?.length ?? 0) <= 64));
  assert.equal(batches.reduce((total, batch) => total + batch.entries.length, 0), 450);
  assert.equal(batches.reduce((total, batch) => total + (batch.grants?.length ?? 0), 0), 70);
  assert.equal(batches[0]?.grants?.length, 64);
  assert.deepEqual(batches.flatMap((batch) => batch.blobRefs ?? []), refs);
});

test('blobs: put, get with the sha256 checked (corrupt-blob on a mismatch), 404 is missing, and an answer naming another project is refused', async () => {
  const bytes = Buffer.from('fictional blob');
  const hash = sha256Hex(bytes);
  const corruptHash = sha256Hex(Buffer.from('what the name says'));
  const elsewhere = sha256Hex(Buffer.from('elsewhere'));
  await withFake({
    handle: (req): FakeAnswer => {
      if (req.method === 'PUT') return { status: 201, json: { project: PROJECT, hash } };
      if (req.path.endsWith(hash)) return { bytes, headers: { 'x-near-ai-project': PROJECT } };
      if (req.path.endsWith(corruptHash)) return { bytes: Buffer.from('something else'), headers: { 'x-near-ai-project': PROJECT } };
      if (req.path.endsWith(elsewhere)) return { bytes: Buffer.from('elsewhere'), headers: { 'x-near-ai-project': OTHER_PROJECT } };
      return { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
    }
  }, async (fake, transport) => {
    await transport.putBlob(hash, bytes);
    assert.deepEqual(fake.calls()[0]?.body, bytes);
    assert.deepEqual(await transport.getBlob(hash), { kind: 'blob', hash, bytes });
    assert.equal((await transport.getBlob(corruptHash)).kind, 'corrupt');
    assert.deepEqual(await transport.getBlob(HASH_A), { kind: 'missing', hash: HASH_A });
    assert.equal((await failure(transport.getBlob(elsewhere))).failure, 'wrong-project');
  });
});

test('grants listed by hash in heads are fetched through GET /v1/blobs/:hash and checked with readGrant; a grant that does not read is refused', async () => {
  const lead = labelSigner('LEAD');
  const x25519 = x25519PublicRaw(x25519PrivateFromSeed(sha256('hub-transport/x25519'))).toString('base64url');
  const signed = buildGrant(lead, { cell: PROJECT, epoch: 1, roster: HASH_A, labelSealed: '', wraps: [{ writer: DEVICE.writer, wrap: wrapEpochKey({ cell: PROJECT, epoch: 1, writer: DEVICE.writer, recipient: x25519, epochKey: Buffer.alloc(32, 7) }) }] });
  const good = canonicalBytes(signed);
  const goodHash = grantHash(signed);
  const tampered = canonicalBytes({ ...signed, payload: { ...signed.payload, epoch: 2 } });
  const tamperedHash = sha256Hex(tampered);
  await withFake({
    handle: (req): FakeAnswer => {
      if (req.path.endsWith(goodHash)) return { bytes: good, headers: { 'x-near-ai-project': PROJECT } };
      if (req.path.endsWith(tamperedHash)) return { bytes: tampered, headers: { 'x-near-ai-project': PROJECT } };
      return { status: 404, json: { error: 'not-found', message: 'Nothing here.' } };
    }
  }, async (fake, transport) => {
    // The hub serves the canonical text, so its sha256 is the grant hash.
    assert.equal(sha256Hex(good), goodHash);
    const fetched = await transport.grant(goodHash);
    assert.equal(fetched.kind, 'grant');
    assert.deepEqual(fetched.kind === 'grant' ? fetched.signed : undefined, signed);
    assert.deepEqual(await transport.grant(tamperedHash), { kind: 'refused', hash: tamperedHash, reason: 'bad-signature' });
    assert.equal((await transport.grant(HASH_A)).kind, 'missing');
    assert.ok(fake.calls().every((call) => call.method === 'GET' && call.path.startsWith('/v1/blobs/')));
  });
});

test('the checkpoint ask posts {known: [signed]} to the checkpoint route and reads kept and the latest checkpoint', async () => {
  const known = [{ v: 1, purpose: 'staff-replica', fictional: 'checkpoint' }] as never;
  let posted: unknown;
  await withFake({
    handle: routes({
      [`POST /v1/projects/${PROJECT}/checkpoint`]: (req) => {
        posted = req.json();
        return { json: { project: PROJECT, kept: 1, checkpoint: { latest: true } } };
      }
    })
  }, async (_fake, transport) => {
    assert.deepEqual(await transport.askCheckpoint(known), { project: PROJECT, kept: 1, checkpoint: { latest: true } });
    assert.deepEqual(posted, { known });
    await assert.rejects(transport.askCheckpoint(Array.from({ length: 17 }, () => known[0])), /At most 16/);
  });
});

test('pull pages one writer until more is false, from the seq after each page\'s head', async () => {
  const froms: number[] = [];
  const entry = (seq: number): unknown => ({ header: { seq }, body: '' });
  await withFake({
    handle: (req): FakeAnswer => {
      const from = Number(req.query.get('from'));
      froms.push(from);
      const seqs = from === 0 ? [0, 1] : from === 2 ? [2, 3] : [4];
      return { json: { project: PROJECT, stream: PROJECT, writer: DEVICE.writer, entries: seqs.map(entry), more: from < 4, head: { seq: seqs[seqs.length - 1], hash: HASH_A } } };
    }
  }, async (_fake, transport) => {
    const seen: number[] = [];
    for await (const item of transport.pull([{ stream: PROJECT, writer: DEVICE.writer, fromSeq: 0 }])) seen.push((item as unknown as { header: { seq: number } }).header.seq);
    assert.deepEqual(seen, [0, 1, 2, 3, 4]);
    assert.deepEqual(froms, [0, 2, 4]);
  });
});

// ---- Task 3: the one-shot sync against the scripted hub, with a real ReplicaProject ----------------------------------------------------------------

class MemorySecrets implements SecretStorageLike {
  public readonly values = new Map<string, string>();
  public get(key: string): Promise<string | undefined> { return Promise.resolve(this.values.get(key)); }
  public store(key: string, value: string): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
  public delete(key: string): Promise<void> { this.values.delete(key); return Promise.resolve(); }
}

const NOW_TEXT = '2026-11-20T10:00:00.000Z';
const SYNC_NOW = new Date(NOW_TEXT);
const LABEL_MAP_HASH = 'c'.repeat(64);

interface SyncWorld {
  a: ReplicaProject;
  project: string;
  secrets: MemorySecrets;
  hubSigner: PayloadSigner & { writer: string };
  member: PayloadSigner & { writer: string };
  /** The roster head after the hub and the member were admitted. */
  head: string;
  baseKey: Buffer;
  memberEntries: BuiltEntry[];
  /** The member's next entry in the base cell (a doc.update with a blob when big is set). */
  memberWrite(options?: { big?: boolean; text?: string; deps?: Dep[] }): BuiltEntry;
  checkpoint(heads: ReadonlyArray<{ writer: string; seq: number; hash: string }>, count: number, orderTip?: string): SignedCheckpoint;
  /** Every entry this computer holds, in seq order per writer. */
  held(): Promise<SealedEntry[]>;
}

/** A lead's shared project on disk with the hub admitted (hub.admit at slot 3) and one member admitted (slot 2) whose device is only keys here. */
async function syncWorld(label: string): Promise<SyncWorld> {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-hub-sync-${label}-`));
  const secrets = new MemorySecrets();
  const deps: ReplicaProjectDeps = { secrets, globalStorageDir: path.join(base, 'global'), now: () => SYNC_NOW };
  const created = await ReplicaProject.createSharedProject(path.join(base, 'project'), deps, {
    name: 'Exercise Northwind', profile: 'j2', level: 'official', labelMapHash: LABEL_MAP_HASH, lead: { member: 'mbr-lead', name: 'Lee Lead' }
  });
  assert.ok(created instanceof ReplicaProject, 'the project is created');
  const a = created;
  const project = a.projectId;
  const descriptor = (signer: PayloadSigner & { writer: string }, seed: string, slot: number): Record<string, unknown> => {
    const x25519 = x25519PublicRaw(x25519PrivateFromSeed(sha256(`hub-transport/x25519/${seed}`))).toString('base64url');
    return { writer: signer.writer, publicKey: signer.publicKey, x25519, x25519Sig: signer.sign(x25519BindingBytes(x25519, signer.writer)), slot };
  };
  const hubSigner = labelSigner(`HUB-${label}`);
  const admitHub = await a.appendOwn('hub.admit', { hub: 'hub-test', device: descriptor(hubSigner, `hub-${label}`, 3), certPin: PIN, ceiling: DEMO_CLEARANCE });
  assert.ok('ok' in admitHub, 'hub.admit is written');
  const member = labelSigner(`MEMBER-${label}`);
  const invited = await a.appendOwn('member.invite', { invite: 'inv-1', name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(newJoinSecret()) });
  assert.ok('ok' in invited);
  const admitted = await a.appendOwn('member.admit', { member: 'mbr-jo', invite: 'inv-1', name: 'Jo Analyst', seat: 'j2-chief', roles: ['member'], clearance: DEMO_CLEARANCE, agentSeats: [], device: descriptor(member, `member-${label}`, 2) });
  assert.ok('ok' in admitted);
  const head = admitted.hash;
  const baseKey = a.keys.epochKey(project, 1) as Buffer;
  const memberEntries: BuiltEntry[] = [];
  const world: SyncWorld = {
    a, project, secrets, hubSigner, member, head, baseKey, memberEntries,
    memberWrite(options = {}) {
      const last = memberEntries[memberEntries.length - 1];
      const seq = memberEntries.length;
      const data = options.big === true ? { product: 'intel-estimate', update: Buffer.alloc(20_000, seq + 1).toString('base64url') } : { text: options.text ?? `Fictional observation ${seq}` };
      const built = buildEntry({
        signer: member, key: baseKey, stream: project, seq, prev: last === undefined ? GENESIS_PREV : last.hash, epoch: 1,
        body: { deps: options.deps ?? [], roster: head, lamport: 100 + seq, at: NOW_TEXT, actor: { kind: 'person' }, kind: options.big === true ? 'doc.update' : 'note.add', data }
      });
      memberEntries.push(built);
      return built;
    },
    checkpoint(heads, count, orderTip = 'a'.repeat(64)) {
      return signCheckpoint(hubSigner, {
        type: 'checkpoint', v: 2, project, signer: hubSigner.writer, rosterHead: head,
        streams: [{ stream: project, heads: heads.map((item) => ({ writer: item.writer, seq: item.seq, hash: item.hash, lamport: 1, roster: head })), count, orderTip }]
      });
    },
    async held() {
      const out: SealedEntry[] = [];
      for (const stream of await a.heads()) for (const item of stream.heads) out.push(...(await a.entriesAfter(stream.stream, item.writer, -1)));
      return out;
    }
  };
  return world;
}

/** A scripted hub for the world's project, holding what is given (the lead's entries and grants by default). */
async function hubFor(world: SyncWorld, seed?: { entries?: readonly SealedEntry[]; grants?: readonly unknown[] }): Promise<{ fake: FakeHubServer; state: FakeHubState }> {
  const state = fakeHubState(world.project, world.head);
  seedHub(state, seed?.entries ?? await world.held());
  seedGrants(state, seed?.grants ?? (await world.a.signedGrants()).map((grant) => grant.signed));
  const fake = await FakeHubServer.start({ project: world.project, hub: world.hubSigner.writer, handle: hubRoutes(state) });
  return { fake, state };
}

function syncTransport(world: SyncWorld, address: string, more: Partial<HubTransportOptions> = {}): HubTransport {
  return new HubTransport({ address, project: world.project, hub: world.hubSigner.writer, trust: { pin: PIN }, signer: world.a.signer, servername: 'localhost', now: () => SYNC_NOW, ...more });
}

async function syncA(world: SyncWorld, address: string, options: { now?: Date; more?: Partial<HubTransportOptions> } = {}): Promise<SyncReport> {
  const transport = syncTransport(world, address, options.more);
  try {
    return await syncOnce(transport, syncLocalOf(world.a), hubMemoryOf(world.secrets), { now: () => options.now ?? SYNC_NOW });
  } finally {
    transport.close();
  }
}

/** Runs body with a fresh world and scripted hub; closes the hub and the project's decode worker. */
async function withSync(label: string, body: (world: SyncWorld, fake: FakeHubServer, state: FakeHubState) => Promise<void>): Promise<void> {
  const world = await syncWorld(label);
  const { fake, state } = await hubFor(world);
  try {
    await body(world, fake, state);
  } finally {
    await fake.close();
    await world.a.close();
  }
}

const kinds = (report: SyncReport): string[] => report.findings.map((item) => item.kind);
const witnessOf = (world: SyncWorld): WitnessState => {
  const text = world.secrets.values.get(hubWitnessKey(world.hubSigner.writer, world.project));
  assert.ok(text !== undefined, 'the witness state was saved');
  const read = readWitness(text, { hub: world.hubSigner.writer, project: world.project });
  assert.ok(read.ok, 'the witness state reads back');
  return read.state;
};

test('synced: entries the hub holds are pulled through ingestForeign into the store, and a second exchange pulls nothing', async () => {
  await withSync('pull', async (world, fake, state) => {
    seedHub(state, [world.memberWrite().entry, world.memberWrite().entry, world.memberWrite().entry]);
    const report = await syncA(world, fake.address);
    assert.equal(report.outcome, 'synced', JSON.stringify(report));
    assert.equal(report.pulled, 3);
    assert.equal(report.pushed, 0);
    assert.deepEqual(report.findings, []);
    assert.deepEqual([...(await world.a.holds(world.memberEntries.map((item) => item.hash)))].sort(), world.memberEntries.map((item) => item.hash).sort());
    assert.deepEqual(await world.a.head(world.project, world.member.writer), { seq: 2, hash: world.memberEntries[2]?.hash });
    const again = await syncA(world, fake.address);
    assert.equal(again.outcome, 'synced');
    assert.equal(again.pulled, 0);
    assert.equal(state.appends.length, 0, 'nothing was pushed: the hub held everything');
  });
});

test('pages served in reverse seq order are put in order per writer before the prev check', async () => {
  await withSync('reverse', async (world, fake, state) => {
    seedHub(state, Array.from({ length: 5 }, () => world.memberWrite().entry));
    state.reversePages = true;
    state.pageSize = 2;
    const report = await syncA(world, fake.address);
    assert.equal(report.outcome, 'synced', JSON.stringify(report));
    assert.equal(report.pulled, 5);
    assert.deepEqual(report.findings, []);
    assert.equal((await world.a.head(world.project, world.member.writer))?.seq, 4);
  });
});

test('a gap stops that writer: nothing after it is stored, the hub\'s head stays cited, and past the grace period the next exchange names withheld', async () => {
  await withSync('gap', async (world, fake, state) => {
    seedHub(state, Array.from({ length: 4 }, () => world.memberWrite().entry));
    state.skipSeq = new Map([[`${world.project}/${world.member.writer}`, 2]]);
    const first = await syncA(world, fake.address);
    assert.equal(first.outcome, 'synced', JSON.stringify(first));
    assert.equal(first.pulled, 2);
    assert.deepEqual(kinds(first), []);
    assert.equal((await world.a.head(world.project, world.member.writer))?.seq, 1);
    assert.equal(witnessOf(world).waiting.length, 1, 'the hub\'s head is cited and waiting');
    const later = await syncA(world, fake.address, { now: new Date(SYNC_NOW.getTime() + WITHHELD_GRACE_MS) });
    assert.deepEqual(kinds(later), ['withheld']);
    assert.equal(later.findings[0]?.count, 1);
    assert.equal((await world.a.head(world.project, world.member.writer))?.seq, 1, 'still nothing past the gap');
  });
});

test('withheld by a dep: an entry citing one the hub never serves (and no head names) is held, its dep cited, and past the grace period named withheld (D-50, D-63)', async () => {
  await withSync('dep', async (world, fake, state) => {
    // The cited entry is the lead's own place far ahead of its log, which neither this computer nor the hub's heads name: only the dep shows it.
    const unseen: Dep = { writer: world.a.deviceWriter, seq: 900, hash: createHash('sha256').update('fictional unseen entry').digest('hex') };
    const citing = world.memberWrite({ text: 'Fictional assessment of an unseen sighting', deps: [unseen] });
    seedHub(state, [citing.entry]);
    const first = await syncA(world, fake.address);
    assert.equal(first.outcome, 'synced', JSON.stringify(first));
    assert.equal(first.pulled, 1);
    assert.deepEqual(kinds(first), []);
    assert.deepEqual(await world.a.missingDeps(), [{ stream: world.project, writer: unseen.writer, seq: unseen.seq, hash: unseen.hash }]);
    assert.deepEqual(witnessOf(world).waiting.map((row) => row.hash), [unseen.hash], 'the dep is cited and waiting');
    const later = await syncA(world, fake.address, { now: new Date(SYNC_NOW.getTime() + WITHHELD_GRACE_MS) });
    assert.deepEqual(kinds(later), ['withheld']);
    assert.equal(later.findings[0]?.detail.writer, world.a.deviceWriter.slice(0, 12));
    assert.equal(later.findings[0]?.detail.seq, 900);
  });
});

test('injected: an entry whose signature does not verify against the roster is named and not stored, and nothing after it is taken', async () => {
  await withSync('injected', async (world, fake, state) => {
    const real = world.memberWrite();
    const forger = labelSigner('FORGER');
    const forged = buildEntry({ signer: forger, key: world.baseKey, stream: world.project, seq: 0, prev: GENESIS_PREV, epoch: 1, body: { deps: [], roster: world.head, lamport: 5, at: NOW_TEXT, actor: { kind: 'person' }, kind: 'note.add', data: { text: 'Forged' } } });
    const injected = { header: { ...forged.entry.header, writer: world.member.writer }, body: forged.entry.body } as SealedEntry;
    state.logs.set(`${world.project}/${world.member.writer}`, [injected]);
    const report = await syncA(world, fake.address);
    assert.deepEqual(kinds(report), ['injected']);
    assert.equal(report.findings[0]?.detail.reason, 'bad-signature');
    assert.equal(report.outcome, 'synced', 'an injected entry is refused, not a reason to stop');
    assert.equal(report.pulled, 0);
    assert.equal((await world.a.holds([entryHash(injected.header), real.hash])).size, 0);
  });
});

test('a validly signed entry whose prev does not name the stored head is not stored, so the chain is never extended out of order', async () => {
  await withSync('prev', async (world, fake, state) => {
    const first = world.memberWrite();
    const stray = buildEntry({ signer: world.member, key: world.baseKey, stream: world.project, seq: 1, prev: HASH_A, epoch: 1, body: { deps: [], roster: world.head, lamport: 9, at: NOW_TEXT, actor: { kind: 'person' }, kind: 'note.add', data: { text: 'Out of order' } } });
    state.logs.set(`${world.project}/${world.member.writer}`, [first.entry, stray.entry]);
    const report = await syncA(world, fake.address);
    assert.equal(report.pulled, 1);
    assert.deepEqual(await world.a.head(world.project, world.member.writer), { seq: 0, hash: first.hash });
    assert.equal((await world.a.holds([stray.hash])).size, 0);
  });
});

test('replayed: an entry this computer already holds is counted and harmless', async () => {
  await withSync('replayed', async (world, fake, state) => {
    const first = world.memberWrite();
    const second = world.memberWrite();
    const ingested = await world.a.ingestForeign([first.entry], []);
    assert.ok('ok' in ingested && ingested.added === 1);
    seedHub(state, [first.entry, second.entry]);
    state.extra = new Map([[`${world.project}/${world.member.writer}`, [first.entry]]]);
    const report = await syncA(world, fake.address);
    assert.equal(report.outcome, 'synced');
    assert.equal(report.pulled, 1);
    assert.deepEqual(kinds(report), ['replayed']);
    assert.equal(report.findings[0]?.count, 1);
    assert.equal(witnessOf(world).replayed, 1);
  });
});

test('corrupt-blob: a blob whose bytes do not hash to its name is named and not stored; once the hub serves the right bytes the waiting entry gets it', async () => {
  await withSync('blob', async (world, fake, state) => {
    const built = world.memberWrite({ big: true });
    const blob = built.blobs[0];
    assert.ok(blob !== undefined, 'the big update moved into a blob');
    seedHub(state, [built.entry]);
    state.blobs.set(blob.hash, Buffer.from(blob.bytes, 'base64url'));
    state.corruptBlobs = new Set([blob.hash]);
    const first = await syncA(world, fake.address);
    assert.equal(first.pulled, 1);
    assert.deepEqual(kinds(first), ['corrupt-blob']);
    assert.deepEqual(await world.a.wantedBlobs(), [blob.hash]);
    assert.equal(await world.a.blob(blob.hash), undefined, 'the corrupt bytes were not stored');
    state.corruptBlobs = new Set();
    const second = await syncA(world, fake.address);
    assert.deepEqual(kinds(second), []);
    assert.equal(second.blobs, 1);
    assert.deepEqual(await world.a.blob(blob.hash), blob);
    assert.ok(fake.calls().some((call) => call.method === 'GET' && call.path === `/v1/blobs/${blob.hash}`));
  });
});

test('push: own entries, other writers\' entries the hub lacks, the blobs they cite and the grants the hub lacks are pushed; nothing the hub already has is sent', async () => {
  const world = await syncWorld('push');
  try {
    const before = await world.held();
    const grants = (await world.a.signedGrants()).map((grant) => grant.signed);
    // The member's entries reached this computer another way; the hub never saw them.
    const memberEntries = [world.memberWrite().entry, world.memberWrite().entry];
    assert.ok('ok' in (await world.a.ingestForeign(memberEntries, [])));
    const own = await world.a.appendOwn('note.add', { text: 'Fictional long report '.repeat(1200) });
    assert.ok('ok' in own && own.built.blobs.length === 1, 'the own entry carries a blob');
    const extraGrant = buildGrant(world.a.signer, { cell: world.project, epoch: 1, roster: world.head, labelSealed: '', wraps: [{ writer: world.member.writer, wrap: wrapEpochKey({ cell: world.project, epoch: 1, writer: world.member.writer, recipient: x25519PublicRaw(x25519PrivateFromSeed(sha256('hub-transport/x25519/member-push'))).toString('base64url'), epochKey: world.baseKey }) }] });
    assert.ok('ok' in (await world.a.putGrants([extraGrant])));
    const { fake, state } = await hubFor(world, { entries: before, grants });
    try {
      const report = await syncA(world, fake.address);
      assert.equal(report.outcome, 'synced', JSON.stringify(report));
      const expected = [...memberEntries.map((entry) => entryHash(entry.header)), own.hash].sort();
      assert.equal(report.pushed, 3);
      const sent = state.appends.flatMap((item) => item.entries.map((entry) => entryHash(entry.header)));
      assert.deepEqual([...sent].sort(), expected, 'exactly what the hub lacked');
      assert.deepEqual(state.appends.flatMap((item) => item.grants).map(grantHash), [grantHash(extraGrant)]);
      assert.deepEqual(state.appends.flatMap((item) => item.blobRefs), [{ entry: own.hash, blob: own.built.blobs[0]?.hash }]);
      assert.ok(state.blobs.has(own.built.blobs[0]?.hash as string), 'the blob was put after the hub said it was missing');
      // A second exchange sends nothing.
      const appends = state.appends.length;
      const again = await syncA(world, fake.address);
      assert.equal(again.pushed, 0);
      assert.equal(state.appends.length, appends);
    } finally {
      await fake.close();
    }
  } finally {
    await world.a.close();
  }
});

test('WR-06: HubTransport.push names the blob each entry uses (from its blobsCitedBy source) and puts it when the hub asks, so the blob reaches the hub', async () => {
  const world = await syncWorld('transport-push');
  try {
    const before = await world.held();
    const own = await world.a.appendOwn('note.add', { text: 'Fictional long report '.repeat(1200) });
    assert.ok('ok' in own && own.built.blobs.length === 1, 'the own entry carries a blob');
    const blob = own.built.blobs[0] as SealedBlob;
    const { fake, state } = await hubFor(world, { entries: before });
    try {
      const cited = { servername: 'localhost', blobsCitedBy: (hashes: readonly string[]) => world.a.blobsCitedBy(hashes) };
      const transport = syncTransport(world, fake.address, cited);
      try {
        const result = await transport.push([own.built.entry], own.built.blobs);
        assert.deepEqual(result, { accepted: [own.hash], refused: [] });
        assert.deepEqual(state.appends.flatMap((item) => item.blobRefs), [{ entry: own.hash, blob: blob.hash }]);
        assert.deepEqual(state.blobs.get(blob.hash), Buffer.from(blob.bytes, 'base64url'), 'the blob given to push is on the hub');
      } finally {
        transport.close();
      }
      // An entry whose blob was not given is not sent, nor the rest of its log: refused blob-not-held, and the hub is not asked.
      const big = world.memberWrite({ big: true });
      const next = world.memberWrite();
      assert.ok('ok' in (await world.a.ingestForeign([big.entry, next.entry], [])));
      const without = syncTransport(world, fake.address, cited);
      try {
        const appends = state.appends.length;
        assert.deepEqual(await without.push([big.entry, next.entry], []), { accepted: [], refused: [{ hash: big.hash, reason: 'blob-not-held' }, { hash: next.hash, reason: 'blob-not-held' }] });
        assert.equal(state.appends.length, appends);
      } finally {
        without.close();
      }
      // Without a source of blob references the transport cannot name the blobs, so it sends nothing rather than lose them.
      const blind = syncTransport(world, fake.address);
      try {
        const appends = state.appends.length;
        await assert.rejects(blind.push([own.built.entry], own.built.blobs), /blobsCitedBy/);
        assert.equal(state.appends.length, appends);
      } finally {
        blind.close();
      }
    } finally {
      await fake.close();
    }
  } finally {
    await world.a.close();
  }
});

test('WR-07: an entry whose blob neither this computer nor the hub holds waits with the rest of its log; everything else is pushed and the exchange ends synced', async () => {
  const world = await syncWorld('blob-held-back');
  try {
    const before = await world.held();
    // The member's long note and the entry after it reached this computer without the long note's blob; the hub has neither.
    const big = world.memberWrite({ text: 'Fictional long observation '.repeat(1200) });
    const next = world.memberWrite();
    const blob = big.blobs[0] as SealedBlob;
    assert.ok('ok' in (await world.a.ingestForeign([big.entry, next.entry], [])));
    assert.equal(await world.a.blob(blob.hash), undefined, 'this computer does not hold the blob');
    const own = await world.a.appendOwn('note.add', { text: 'Fictional short report' });
    assert.ok('ok' in own);
    const { fake, state } = await hubFor(world, { entries: before });
    try {
      const report = await syncA(world, fake.address);
      assert.equal(report.outcome, 'synced', JSON.stringify(report));
      assert.equal(report.pushed, 1);
      assert.equal(report.heldBack, 2, 'the big update and the entry after it wait');
      assert.deepEqual(state.appends.flatMap((item) => item.entries.map((entry) => entryHash(entry.header))), [own.hash], 'only what can go with its blobs');
      assert.ok(state.appends.every((item) => item.blobRefs.every((ref) => state.blobs.has(ref.blob))), 'no reference to a blob this computer could not put');
      assert.deepEqual(report.refusedByHub, []);
      // Once the blob reaches this computer, the next exchange pushes the waiting log with it: named, put when the hub asks, then accepted.
      assert.ok('ok' in (await world.a.ingestForeign([], [blob])));
      const healed = await syncA(world, fake.address);
      assert.equal(healed.outcome, 'synced', JSON.stringify(healed));
      assert.equal(healed.pushed, 2);
      assert.deepEqual(state.blobs.get(blob.hash), Buffer.from(blob.bytes, 'base64url'));
      assert.equal(healed.heldBack, 0);
      assert.deepEqual(state.appends.at(-1)?.blobRefs, [{ entry: big.hash, blob: blob.hash }]);
    } finally {
      await fake.close();
    }
  } finally {
    await world.a.close();
  }
});

test('checkpoints: a valid newer checkpoint replaces the kept newest and each is stored as evidence', async () => {
  await withSync('checkpoint', async (world, fake, state) => {
    const leadHead = await world.a.head(world.project, world.a.deviceWriter) as { seq: number; hash: string };
    const cp1 = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }], 4);
    state.checkpoint = cp1;
    const first = await syncA(world, fake.address);
    assert.equal(first.outcome, 'synced', JSON.stringify(first));
    assert.equal(checkpointHash(witnessOf(world).newest as SignedCheckpoint), checkpointHash(cp1));
    const added = world.memberWrite();
    seedHub(state, [added.entry]);
    const cp2 = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }, { writer: world.member.writer, seq: 0, hash: added.hash }], 5);
    state.checkpoint = cp2;
    const second = await syncA(world, fake.address);
    assert.equal(second.outcome, 'synced', JSON.stringify(second));
    assert.equal(checkpointHash(witnessOf(world).newest as SignedCheckpoint), checkpointHash(cp2));
    assert.deepEqual((await world.a.checkpoints()).map(checkpointHash).sort(), [checkpointHash(cp1), checkpointHash(cp2)].sort());
  });
});

test('rolled-back: a checkpoint with a head below the kept newest is named, the newer one is handed back, and the client re-pushes what the hub lost', async () => {
  await withSync('rollback-cp', async (world, fake, state) => {
    const leadHead = await world.a.head(world.project, world.a.deviceWriter) as { seq: number; hash: string };
    const cpOld = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }], 4);
    const own = await world.a.appendOwn('note.add', { text: 'Fictional situation report' });
    assert.ok('ok' in own);
    seedHub(state, [own.built.entry]);
    const cpNew = world.checkpoint([{ writer: world.a.deviceWriter, seq: leadHead.seq + 1, hash: own.hash }], 5);
    state.checkpoint = cpNew;
    assert.equal((await syncA(world, fake.address)).outcome, 'synced');
    // The hub is restored from an older copy: the new entry and the newer checkpoint are gone.
    state.logs.set(`${world.project}/${world.a.deviceWriter}`, (state.logs.get(`${world.project}/${world.a.deviceWriter}`) ?? []).filter((entry) => entryHash(entry.header) !== own.hash));
    state.checkpoint = cpOld;
    state.askAnswer = cpNew;
    const report = await syncA(world, fake.address);
    assert.ok(kinds(report).includes('rolled-back'), JSON.stringify(report.findings));
    assert.equal(report.outcome, 'attention');
    assert.equal(report.repushed, true);
    assert.equal(report.pushed, 1);
    assert.ok(state.logs.get(`${world.project}/${world.a.deviceWriter}`)?.some((entry) => entryHash(entry.header) === own.hash), 'the hub holds it again');
    assert.equal(report.handedBack, 1);
    assert.deepEqual(state.handedBack.map((item) => checkpointHash(item as SignedCheckpoint)), [checkpointHash(cpNew)]);
    assert.equal(checkpointHash(witnessOf(world).newest as SignedCheckpoint), checkpointHash(cpNew), 'the kept newest is unchanged');
  });
});

test('rolled-back heads: with no checkpoint at all, hub heads below what this computer saw the hub accept are named rolled-back and re-pushed', async () => {
  await withSync('rollback-heads', async (world, fake, state) => {
    const own = await world.a.appendOwn('note.add', { text: 'Fictional patrol report' });
    assert.ok('ok' in own);
    const first = await syncA(world, fake.address);
    assert.equal(first.pushed, 1);
    assert.equal(first.outcome, 'synced');
    const key = `${world.project}/${world.a.deviceWriter}`;
    state.logs.set(key, (state.logs.get(key) ?? []).filter((entry) => entryHash(entry.header) !== own.hash));
    const report = await syncA(world, fake.address);
    assert.deepEqual(kinds(report), ['rolled-back']);
    assert.equal(report.outcome, 'attention');
    assert.equal(report.repushed, true);
    assert.equal(report.pushed, 1);
    assert.ok(report.message?.includes('older copy'));
  });
});

test('forked-view: a checkpoint that conflicts with the kept newest (same count, other order tip) is named, both are stored, the kept newest is the proof\'s first, and nothing more is exchanged', async () => {
  await withSync('fork', async (world, fake, state) => {
    const leadHead = await world.a.head(world.project, world.a.deviceWriter) as { seq: number; hash: string };
    const kept = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }], 4, 'a'.repeat(64));
    state.checkpoint = kept;
    assert.equal((await syncA(world, fake.address)).outcome, 'synced');
    const other = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }], 4, 'b'.repeat(64));
    state.checkpoint = other;
    const own = await world.a.appendOwn('note.add', { text: 'Not sent to a forked hub' });
    assert.ok('ok' in own);
    const appends = state.appends.length;
    const report = await syncA(world, fake.address);
    assert.deepEqual(kinds(report), ['forked-view']);
    assert.equal(report.outcome, 'attention');
    assert.equal(state.appends.length, appends, 'nothing was pushed');
    const witness = witnessOf(world);
    assert.equal(witness.distrusted, true);
    assert.equal(checkpointHash(witness.proof?.a as SignedCheckpoint), checkpointHash(kept));
    assert.equal(checkpointHash(witness.proof?.b as SignedCheckpoint), checkpointHash(other));
    assert.deepEqual((await world.a.checkpoints()).map(checkpointHash).sort(), [checkpointHash(kept), checkpointHash(other)].sort());
    // A distrusted hub stays distrusted on the next exchange.
    assert.deepEqual(kinds(await syncA(world, fake.address)), ['forked-view']);
  });
});

test('hand-back: when the hub\'s latest checkpoint is older than the kept newest, the newer held hub checkpoints go back through the checkpoint ask before anything is pushed', async () => {
  await withSync('handback', async (world, fake, state) => {
    const leadHead = await world.a.head(world.project, world.a.deviceWriter) as { seq: number; hash: string };
    const added = world.memberWrite();
    seedHub(state, [added.entry]);
    const newer = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }, { writer: world.member.writer, seq: 0, hash: added.hash }], 5);
    state.checkpoint = newer;
    assert.equal((await syncA(world, fake.address)).outcome, 'synced');
    // The hub lost its latest checkpoint (an honest restore with every entry kept) and this computer has an own entry to push.
    delete state.checkpoint;
    const own = await world.a.appendOwn('note.add', { text: 'Fictional assessment' });
    assert.ok('ok' in own);
    const mark = fake.requests.length;
    const report = await syncA(world, fake.address);
    assert.equal(report.outcome, 'synced', JSON.stringify(report));
    assert.equal(report.handedBack, 1);
    const later = fake.requests.slice(mark);
    const ask = later.findIndex((req) => req.path.endsWith('/checkpoint') && ((req.json() as { known: unknown[] }).known.length > 0));
    const append = later.findIndex((req) => req.path.endsWith('/append'));
    assert.ok(ask >= 0 && append > ask, 'the hand-back came before the push');
    assert.deepEqual(state.handedBack.map((item) => checkpointHash(item as SignedCheckpoint)), [checkpointHash(newer)]);
  });
});

test('the witness state lives in SecretStorage under nearAi.staff.hubWitness., holds no secret or token, reads back with readWitness and survives a new syncOnce', async () => {
  await withSync('memory', async (world, fake, state) => {
    const leadHead = await world.a.head(world.project, world.a.deviceWriter) as { seq: number; hash: string };
    state.checkpoint = world.checkpoint([{ writer: world.a.deviceWriter, ...leadHead }], 4);
    seedHub(state, [world.memberWrite().entry]);
    assert.equal((await syncA(world, fake.address)).outcome, 'synced');
    const keys = [...world.secrets.values.keys()].filter((key) => key.startsWith(HUB_WITNESS_SECRET_PREFIX));
    assert.deepEqual(keys, [hubWitnessKey(world.hubSigner.writer, world.project)]);
    const saved = world.secrets.values.get(keys[0] as string) as string;
    for (const [key, value] of world.secrets.values) if (!key.startsWith(HUB_WITNESS_SECRET_PREFIX)) assert.ok(!saved.includes(value), `the witness state holds the secret ${key}`);
    for (const token of fake.issuedTokens()) assert.ok(!saved.includes(token), 'the witness state holds a session token');
    const state1 = witnessOf(world);
    assert.equal(state1.hub, world.hubSigner.writer);
    assert.ok(state1.newest !== undefined);
    assert.ok(state1.seen.length > 0);
    // A new exchange starts from the saved state: same newest checkpoint, no finding.
    const again = await syncA(world, fake.address);
    assert.deepEqual(kinds(again), []);
    assert.deepEqual(witnessOf(world).newest, state1.newest);
  });
});

test('a stored state for another hub or another project is not used: the exchange starts from a fresh witness', async () => {
  const secrets = new MemorySecrets();
  const memory = hubMemoryOf(secrets);
  const otherHub = { ...createWitness(HASH_A, PROJECT), replayed: 7 };
  await secrets.store(hubWitnessKey(HUB, PROJECT), serializeWitness(otherHub));
  assert.deepEqual(await memory.load(HUB, PROJECT), createWitness(HUB, PROJECT));
  const otherProject = { ...createWitness(HUB, OTHER_PROJECT), replayed: 7 };
  await secrets.store(hubWitnessKey(HUB, PROJECT), serializeWitness(otherProject));
  assert.deepEqual(await memory.load(HUB, PROJECT), createWitness(HUB, PROJECT));
  await secrets.store(hubWitnessKey(HUB, PROJECT), 'not json');
  assert.deepEqual(await memory.load(HUB, PROJECT), createWitness(HUB, PROJECT));
  // Its own state reads back.
  const own = { ...createWitness(HUB, PROJECT), replayed: 3 };
  await memory.save(own);
  assert.deepEqual(await memory.load(HUB, PROJECT), own);
  assert.notEqual(hubWitnessKey(HUB, PROJECT), hubWitnessKey(HASH_A, PROJECT));
  assert.ok(hubWitnessKey(HUB, PROJECT).startsWith('nearAi.staff.hubWitness.'));
});

test('outcome offline: a hub that cannot be reached ends offline with the plain sentence, and nothing is stored', async () => {
  const world = await syncWorld('offline');
  try {
    const silent = net.createServer();
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => silent.close(() => resolve()));
    const report = await syncA(world, `127.0.0.1:${port}`, { more: { connectTimeoutMs: 2_000 } });
    assert.equal(report.outcome, 'offline');
    assert.equal(report.reason, 'unreachable');
    assert.ok(report.message?.includes('could not be reached'));
    assert.equal(report.pulled + report.pushed, 0);
  } finally {
    await world.a.close();
  }
});

test('outcome refused: a hub that refuses this device\'s session ends refused with the hub\'s reason id', async () => {
  const world = await syncWorld('refused');
  const fake = await FakeHubServer.start({ project: world.project, hub: world.hubSigner.writer, session: (step) => (step === 'answer' ? { status: 403, json: { error: 'session-refused', reason: 'not-admitted', message: 'Refused.' } } : undefined) });
  try {
    const report = await syncA(world, fake.address);
    assert.equal(report.outcome, 'refused');
    assert.equal(report.reason, 'not-admitted');
    assert.equal(fake.calls().length, 0);
  } finally {
    await fake.close();
    await world.a.close();
  }
});

test('outcome attention: a pin mismatch ends attention before any request, and a heads answer for another project ends attention with wrong-project', async () => {
  await withSync('attention', async (world, fake, state) => {
    const pinned = await syncA(world, fake.address, { more: { trust: { pin: '1'.repeat(64) } } });
    assert.equal(pinned.outcome, 'attention');
    assert.equal(pinned.reason, 'pin-mismatch');
    assert.equal(fake.requests.length, 0);
    state.wrongProjectHeads = OTHER_PROJECT;
    seedHub(state, [world.memberWrite().entry]);
    const wrong = await syncA(world, fake.address);
    assert.equal(wrong.outcome, 'attention');
    assert.deepEqual(kinds(wrong), ['wrong-project']);
    assert.equal(wrong.pulled, 0);
  });
});

test('no finding sentence or detail carries a key, a token or a full hash', async () => {
  await withSync('sentences', async (world, fake, state) => {
    const blobEntry = world.memberWrite({ big: true });
    const blob = blobEntry.blobs[0] as SealedBlob;
    seedHub(state, [blobEntry.entry]);
    state.blobs.set(blob.hash, Buffer.from(blob.bytes, 'base64url'));
    state.corruptBlobs = new Set([blob.hash]);
    state.extra = new Map([[`${world.project}/${world.member.writer}`, [blobEntry.entry, { header: { ...world.memberWrite().entry.header, sig: 'A'.repeat(86) }, body: 'AA' }]]]);
    const report = await syncA(world, fake.address);
    assert.ok(report.findings.length >= 2, JSON.stringify(report.findings));
    const text = JSON.stringify(report.findings) + (report.message ?? '');
    assert.doesNotMatch(text, /[0-9a-f]{64}/, 'no full hash');
    assert.doesNotMatch(text, /[A-Za-z0-9_-]{43}/, 'no key or token');
    for (const token of fake.issuedTokens()) assert.ok(!text.includes(token));
    assert.ok(!text.includes(world.member.publicKey) && !text.includes(world.a.signer.publicKey));
    assert.doesNotMatch(text, /\u2014/);
  });
});

test('replicaProject read accessors: heads, entries after a seq, wanted and cited blobs, signed grants and checkpoints', async () => {
  const world = await syncWorld('accessors');
  try {
    const { a, project } = world;
    const own = await a.appendOwn('note.add', { text: 'Fictional annex '.repeat(1400) });
    assert.ok('ok' in own);
    const blobEntry = world.memberWrite({ big: true });
    assert.ok('ok' in (await a.ingestForeign([blobEntry.entry], [])));
    const heads = await a.heads();
    const base = heads.find((item) => item.stream === project);
    assert.deepEqual(base?.heads.find((head) => head.writer === a.deviceWriter), { writer: a.deviceWriter, seq: (await a.head(project, a.deviceWriter))?.seq, hash: own.hash });
    assert.deepEqual(base?.heads.find((head) => head.writer === world.member.writer), { writer: world.member.writer, seq: 0, hash: blobEntry.hash });
    const after = await a.entriesAfter(project, a.deviceWriter, 0);
    assert.ok(after.length >= 1 && after.every((entry, index) => entry.header.seq === index + 1));
    assert.equal(entryHash((after[after.length - 1] as SealedEntry).header), own.hash);
    assert.deepEqual(await a.holds([own.hash, HASH_A]), new Set([own.hash]));
    assert.deepEqual(await a.wantedBlobs(), [blobEntry.blobs[0]?.hash]);
    assert.deepEqual(await a.blobsCitedBy([own.hash, blobEntry.hash]), [{ entry: own.hash, blob: own.built.blobs[0]?.hash }, { entry: blobEntry.hash, blob: blobEntry.blobs[0]?.hash }].sort((x, y) => (x.entry === own.hash ? -1 : 1) - (y.entry === own.hash ? -1 : 1)));
    assert.deepEqual(await a.blob(own.built.blobs[0]?.hash as string), own.built.blobs[0]);
    const grants = await a.signedGrants();
    assert.ok(grants.length >= 1 && grants.every((grant) => grant.hash === grantHash(grant.signed)));
    const cp = world.checkpoint([{ writer: a.deviceWriter, seq: 0, hash: a.anchor.genesisHash }], 1);
    assert.ok('ok' in (await a.putCheckpoint(cp)));
    assert.deepEqual((await a.checkpoints()).map(checkpointHash), [checkpointHash(cp)]);
    const local = syncLocalOf(a);
    assert.equal(local.project, project);
    assert.equal(local.writer, a.deviceWriter);
    assert.ok((await local.roster()).checkpointSigner(world.hubSigner.writer, world.head));
  } finally {
    await world.a.close();
  }
});
