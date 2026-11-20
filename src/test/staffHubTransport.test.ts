// The client side of your organization's sync hub (32-23; D-29, D-35, D-36, D-37, D-41, D-46, D-49 to D-51, D-54, D-58, D-70): the pinned transport
// against a scripted hub on 127.0.0.1 with the cyber fixture certificate, and the one-shot sync against that hub with a real ReplicaProject. Every
// connection state and every finding has a test. All names and data are fictional.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import * as net from 'node:net';
import test from 'node:test';
import { buildGrant, grantHash, wrapEpochKey, x25519PrivateFromSeed, x25519PublicRaw } from '../domain/replica/cellKeys';
import { certPinOf } from '../domain/replica/hubFile';
import { canonicalBytes, fingerprintOf } from '../domain/team/canonical';
import type { PayloadSigner } from '../domain/team/signedPayload';
import { APPEND_MAX_ENTRIES, CONNECT_TIMEOUT_MS, HubTransport, HubTransportError, RESPONSE_MAX_BYTES, appendBatches } from '../staff/replica/hubTransport';
import type { EventReport, HubTransportOptions } from '../staff/replica/hubTransport';
import { FIXTURE_CA, FIXTURE_CERT, FakeHubServer } from './helpers/fakeHubServer';
import type { FakeAnswer, FakeHandler, FakeHubOptions } from './helpers/fakeHubServer';

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
