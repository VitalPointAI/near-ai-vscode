import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import type https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildGrant, grantHash, openLabel, sealLabel, unwrapEpochKey, wrapEpochKey } from '@ext/domain/replica/cellKeys';
import type { CellGrant } from '@ext/domain/replica/cellKeys';
import { entryHash, openBlob, openBody, sealBlob, writerIdOf } from '@ext/domain/replica/entry';
import { buildHubJoin, buildInvite, buildJoinRequest, checkJoinRequest, hubJoinCheckKey, hubJoinMac, joinRequestHash, newJoinSecret } from '@ext/domain/replica/invite';
import type { InvitePayload } from '@ext/domain/replica/invite';
import type { SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import type { KeyRing } from '@ext/domain/replica/rosterView';
import { verifyEntry } from '@ext/domain/replica/verify';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { HubTransport, enrolmentRequest } from '@ext/staff/replica/hubTransport';
import type { EventReader, EventReport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import type { HubMemory, SyncReport } from '@ext/staff/replica/hubSync';
import { blobsNamed, sealedOf } from '../src/append/rosterCache';
import { hubIdentityOf, issueHubFile } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { HealthRegistry } from '../src/health';
import { listen } from '../src/http/server';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { Logger } from '../src/log/logger';
import { Redactor } from '../src/log/redact';
import { composeHub } from '../src/main';
import type { ComposedHub } from '../src/main';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { HubConnection } from './helpers/hubClient';
import { HUB_ADDRESS, NOW_MS, createHubWorld, streamOf } from './helpers/hubWorld';
import type { HubWorld, WorldDevice, Written } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import type { MemoryReplica } from './helpers/memoryReplica';
import { EventClient } from './helpers/sseReader';
import { makeTlsFixture } from './helpers/tlsFixture';
import type { TlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 27 (D-24, D-55, MUS-08): the hub reads only the roster and the cells granted to it. Every other cell reaches it, rests on its disk
// and leaves it only as ciphertext. The proof is a byte capture over a real session: real clients (the extension's hub transport and one-shot sync
// over memory replicas built from hub-side modules) drive the real hub in process; a wrapper on the hub server's request listener records every
// request and response byte of every connection (event stream frames included); a logger sink records every log line the binary's wiring would
// write; and every file under the state folder (database, write-ahead log, shared memory file, blob folder) is read raw while the hub runs and
// again after a clean close. Canaries are searched as UTF-8, UTF-16LE, hex, base64 and base64url (the last two at all three byte offsets), and
// every clean search is paired with a positive control that finds a canary where it was put. All names and data are fictional.

// ---- The search -------------------------------------------------------------------------------------------------------------------------------

/** One place searched: what it is (a file, a request, a log line) and its bytes. */
interface Place {
  where: string;
  bytes: Buffer;
}

interface Hit {
  where: string;
  encoding: string;
}

/** base64 and base64url forms of some bytes at each of the three byte offsets they can start at inside a longer encoded value (only the characters
 *  fully decided by those bytes are kept, so the form matches wherever the bytes sit). */
function encodedForms(bytes: Buffer, prefix = ''): Array<{ encoding: string; bytes: Buffer }> {
  const forms: Array<{ encoding: string; bytes: Buffer }> = [];
  for (const encoding of ['base64', 'base64url'] as const) {
    for (let offset = 0; offset < 3; offset += 1) {
      const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/, '');
      const first = Math.ceil((8 * offset) / 6);
      const last = Math.floor((8 * (offset + bytes.length) - 6) / 6);
      forms.push({ encoding: `${prefix}${encoding}@${offset}`, bytes: Buffer.from(encoded.slice(first, last + 1), 'ascii') });
    }
  }
  return forms;
}

/**
 * The forms a canary takes in bytes: UTF-8, UTF-16LE, hex (both cases), base64 and base64url at all three offsets, and (beyond the plan's five)
 * each base64 or base64url form encoded once more, so text a document update carries (UTF-8 inside base64url update bytes) is found even inside a
 * body that was stored or sent without its seal.
 */
function canaryForms(value: string): Array<{ encoding: string; bytes: Buffer }> {
  const bytes = Buffer.from(value, 'utf8');
  const once = encodedForms(bytes);
  return [
    { encoding: 'utf8', bytes },
    { encoding: 'utf16le', bytes: Buffer.from(value, 'utf16le') },
    { encoding: 'hex', bytes: Buffer.from(bytes.toString('hex'), 'ascii') },
    { encoding: 'HEX', bytes: Buffer.from(bytes.toString('hex').toUpperCase(), 'ascii') },
    ...once,
    ...once.flatMap((form) => encodedForms(form.bytes, `${form.encoding} in `)),
  ];
}

/** Every place and encoding a canary is found in. */
function search(places: readonly Place[], canary: string): Hit[] {
  const forms = canaryForms(canary);
  const hits: Hit[] = [];
  for (const place of places) for (const form of forms) if (place.bytes.includes(form.bytes)) hits.push({ where: place.where, encoding: form.encoding });
  return hits;
}

/** Asserts that none of the canaries is in any of the places, naming each hit. */
function assertNowhere(places: readonly Place[], canaries: readonly string[], what: string): void {
  assert.ok(places.length > 0, `${what}: there are bytes to search`);
  const hits = canaries.flatMap((canary) => search(places, canary).map((hit) => `${canary} as ${hit.encoding} in ${hit.where}`));
  assert.deepEqual(hits, [], `${what}: a canary was found`);
}

/** Every file under a folder (recursing), its path from the folder and its bytes, the name searched with the bytes. */
function filesUnder(dir: string, label: string): Place[] {
  const out: Place[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else out.push({ where: `${label}:${path.relative(dir, file)}`, bytes: Buffer.concat([Buffer.from(`${path.relative(dir, file)}\n`, 'utf8'), readFileSync(file)]) });
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---- The hub in process, captured ---------------------------------------------------------------------------------------------------------

/** One request and its response, as the hub's request listener saw them, on one connection. */
interface Exchange {
  socket: object;
  method: string;
  path: string;
  request: Buffer[];
  response: Buffer[];
}

interface Capture {
  exchanges: Exchange[];
  /** The device that opened a session on a connection (from the session answer the hub accepted). */
  deviceOf(socket: object): string | undefined;
}

const toBuffer = (chunk: unknown, encoding?: unknown): Buffer => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  return Buffer.alloc(0);
};

/**
 * Replaces the hub server's request listener with one that tees every request (method, path, headers and each body chunk as the hub's own reader
 * receives it) and every response (status, headers, and each chunk given to write and end, event stream frames included) before passing both on.
 */
function captureServer(server: https.Server): Capture {
  const listeners = server.listeners('request') as Array<(req: http.IncomingMessage, res: http.ServerResponse) => void>;
  assert.equal(listeners.length, 1, 'the hub has one request listener');
  server.removeAllListeners('request');
  const exchanges: Exchange[] = [];
  const devices = new WeakMap<object, string>();
  server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
    const exchange: Exchange = { socket: req.socket, method: req.method ?? '', path: (req.url ?? '').split('?')[0] as string, request: [], response: [] };
    exchanges.push(exchange);
    exchange.request.push(Buffer.from(`${req.method ?? ''} ${req.url ?? ''}\n${req.rawHeaders.join('\n')}\n\n`, 'utf8'));
    const emit = req.emit.bind(req);
    req.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
      if (event === 'data') exchange.request.push(toBuffer(args[0]));
      return emit(event, ...args);
    }) as typeof req.emit;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    res.write = ((...args: unknown[]): boolean => {
      exchange.response.push(toBuffer(args[0], args[1]));
      return write(...args);
    }) as typeof res.write;
    const end = res.end.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.end = ((...args: unknown[]): http.ServerResponse => {
      if (typeof args[0] !== 'function') exchange.response.push(toBuffer(args[0], args[1]));
      return end(...args);
    }) as typeof res.end;
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => http.ServerResponse;
    res.writeHead = ((...args: unknown[]): http.ServerResponse => {
      exchange.response.push(Buffer.from(`${String(args[0])}\n${JSON.stringify(args.slice(1))}\n`, 'utf8'));
      return writeHead(...args);
    }) as typeof res.writeHead;
    res.on('finish', () => {
      exchange.response.push(Buffer.from(`${JSON.stringify(res.getHeaders())}\n`, 'utf8'));
      // A session answer the hub accepted names the device of this connection.
      if (exchange.path === '/v1/session' && res.statusCode === 200) {
        try {
          const body = JSON.parse(Buffer.concat(exchange.request.slice(1)).toString('utf8')) as { answer?: { signer?: { publicKey?: unknown } } };
          const publicKey = body.answer?.signer?.publicKey;
          if (typeof publicKey === 'string') devices.set(req.socket, writerIdOf(publicKey));
        } catch {
          // A challenge call: no device yet.
        }
      }
    });
    for (const listener of listeners) listener.call(server, req, res);
  });
  return { exchanges, deviceOf: (socket) => devices.get(socket) };
}

interface CapturedHub {
  port: number;
  dir: string;
  identity: HubIdentity;
  store: HubStore;
  composed: ComposedHub;
  capture: Capture;
  logLines: string[];
  logger: Logger;
  now(): number;
  advance(ms: number): void;
  /** The state folder read raw now (the hub running: the write-ahead log and shared memory file are there). */
  snapshot(label: string): Place[];
  /** Stops the hub cleanly (as the binary's stop does), then reads the state folder raw once more. */
  close(): Promise<Place[]>;
  /** Removes the state folder and the TLS fixture. */
  cleanup(): void;
}

/** The hub as the binary composes it, with the binary's log wiring onto a Logger whose sink records every line, and the capture on its server. */
async function startCapturedHub(): Promise<CapturedHub> {
  const tls: TlsFixture = makeTlsFixture();
  const root = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-capture-'));
  const dir = path.join(root, 'state');
  mkdirSync(dir, { mode: 0o700 });
  const store = await openHubStore(dir);
  const signing = readSigningKey(generateKeyFile('signing'));
  const identity = hubIdentityOf(signing, readEncryptionKey(generateKeyFile('encryption'), signing), tls.certPem, HUB_ADDRESS);
  let clock = NOW_MS;
  const logLines: string[] = [];
  const logger = new Logger(new Redactor(), (line) => logLines.push(line), () => clock);
  const health = new HealthRegistry({ version: '0.0.0-test', startedAt: clock, now: () => clock });
  // The same hooks main.ts wires for the binary.
  const composed = composeHub({
    store,
    identity,
    tls: { cert: tls.certPem, key: tls.keyPem },
    health,
    now: () => clock,
    onFailure: (route, error) => logger.error('http.failed', { route, name: error instanceof Error ? error.name : 'NonError' }),
    onCheckpointLog: (level, event, fields) => logger[level](event, fields),
    onJoinLog: (level, event, fields) => logger[level](event, fields),
    onRejected: (route, method, status) => {
      const fields = { route, method, status };
      if (status >= 500) logger.error('http.rejected', fields);
      else logger.warn('http.rejected', fields);
    },
  });
  const capture = captureServer(composed.server);
  const port = await listen(composed.server, '127.0.0.1', 0);
  let closed = false;
  return {
    port,
    dir,
    identity,
    store,
    composed,
    capture,
    logLines,
    logger,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    snapshot: (label) => filesUnder(dir, label),
    async close() {
      if (!closed) {
        closed = true;
        composed.checkpoints?.stop();
        await composed.checkpoints?.settled();
        composed.join.stop();
        composed.events.closeAll();
        composed.presence.close();
        composed.sessions.close();
        composed.server.closeAllConnections();
        await new Promise<void>((resolve) => composed.server.close(() => resolve()));
        store.close();
      }
      return filesUnder(dir, 'closed');
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      tls.cleanup();
    },
  };
}

/** Every byte the hub received or sent at the application layer, one place per request and one per response. */
function wireOf(capture: Capture, filter: (exchange: Exchange) => boolean = () => true): Place[] {
  return capture.exchanges.filter(filter).flatMap((exchange, index) => [
    { where: `request ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.request) },
    { where: `response ${index} ${exchange.method} ${exchange.path}`, bytes: Buffer.concat(exchange.response) },
  ]);
}

const logsOf = (hub: CapturedHub): Place[] => hub.logLines.map((line, index) => ({ where: `log line ${index}`, bytes: Buffer.from(line, 'utf8') }));

// ---- Clients ----------------------------------------------------------------------------------------------------------------------------------

/** The keys a device can open from the grants it holds. */
function ringFromGrants(grants: ReadonlyArray<{ signed: unknown }>, device: WorldDevice): KeyRing {
  const keys = new Map<string, Buffer>();
  for (const { signed } of grants) {
    const payload = (signed as SignedPayload<CellGrant>).payload;
    const mine = payload.wraps.find((item) => item.writer === device.writer);
    if (mine === undefined) continue;
    const key = unwrapEpochKey({ cell: payload.cell, epoch: payload.epoch, writer: device.writer, privateKey: device.x25519Private, wrap: mine.wrap });
    if (key !== undefined) keys.set(`${payload.cell}/${payload.epoch}`, key);
  }
  return (stream, epoch) => keys.get(`${stream}/${epoch}`);
}

/**
 * A person's computer: a memory replica that starts with the entries and grants the device was handed when it joined (no blob of anyone else), and
 * that, like the extension's ReplicaProject, names the blobs its own entries cite when it pushes and the blobs it is missing when it pulls. It opens
 * only what its own grants open.
 */
interface Client extends MemoryReplica {
  device: WorldDevice;
  ring(): Promise<KeyRing>;
  /** Every body and blob this computer can open, as plaintext, with the stream it came from. */
  opened(): Promise<Array<{ stream: string; text: string }>>;
}

function clientOf(world: HubWorld, device: WorldDevice, entries: readonly SealedEntry[], grants: ReadonlyArray<SignedPayload<CellGrant>>): Client {
  const base = memoryReplica({ ...world, grants: [...grants], blobs: new Map<string, SealedBlob>() }, device, entries);
  const ring = async (): Promise<KeyRing> => ringFromGrants(await base.grants(), device);
  const cited = async (list: readonly SealedEntry[]): Promise<Array<{ entry: string; blob: string; stream: string; epoch: number }>> => {
    const keys = await ring();
    const out: Array<{ entry: string; blob: string; stream: string; epoch: number }> = [];
    for (const entry of list) {
      for (const blob of blobsNamed([entry], keys)) out.push({ entry: hashOfEntry(entry), blob, stream: entry.header.stream, epoch: entry.header.epoch });
    }
    return out;
  };
  return {
    ...base,
    device,
    ring,
    async blobsCitedBy(hashes) {
      const wanted = new Set(hashes);
      return (await cited(base.all().filter((entry) => wanted.has(hashOfEntry(entry))))).map(({ entry, blob }) => ({ entry, blob }));
    },
    async wantedBlobs() {
      const missing: string[] = [];
      for (const item of await cited(base.all())) if ((await base.blob(item.blob)) === undefined) missing.push(item.blob);
      return missing;
    },
    async opened() {
      const keys = await ring();
      const out: Array<{ stream: string; text: string }> = [];
      for (const entry of base.all()) {
        const key = keys(entry.header.stream, entry.header.epoch);
        if (key === undefined) continue;
        const plain = openBody(key, entry.header, Buffer.from(entry.body, 'base64url'));
        if (plain !== undefined) out.push({ stream: entry.header.stream, text: plain.toString('utf8') });
      }
      for (const item of await cited(base.all())) {
        const key = keys(item.stream, item.epoch);
        const blob = await base.blob(item.blob);
        if (key === undefined || blob === undefined) continue;
        const plain = openBlob(key, item.stream, item.epoch, blob);
        if (plain !== undefined) out.push({ stream: item.stream, text: plain.toString('utf8') });
      }
      return out;
    },
  };
}

const hashOfEntry = (entry: SealedEntry): string => entryHash(entry.header);

/** The grants a device holds when it joins: the ones wrapped to it so far. */
const grantsTo = (world: HubWorld, device: WorldDevice): Array<SignedPayload<CellGrant>> => world.grants.filter((grant) => grant.payload.wraps.some((wrap) => wrap.writer === device.writer));
const baseEntries = (world: HubWorld): SealedEntry[] => world.entries.filter((entry) => entry.header.stream === world.project);

/** A write by a device, kept on its own computer (its blob too), as the extension keeps what it writes before any sync. */
function writeOn(world: HubWorld, client: Client, options: Parameters<HubWorld['write']>[1]): Written {
  const written = world.write(client.device, options);
  assert.ok(client.add(written.entry), 'the writer keeps its own entry');
  return written;
}

async function keepBlobs(client: Client, written: Written): Promise<void> {
  await client.ingest([], written.blobs);
}

function transportFor(hub: CapturedHub, world: HubWorld, device: WorldDevice): HubTransport {
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

const memories = new Map<string, HubMemory>();

/** One exchange of the device's computer with the hub, as the extension runs it. */
async function sync(hub: CapturedHub, world: HubWorld, client: Client): Promise<SyncReport> {
  // The checkpoint ask at the end of each exchange signs at once only when 10 seconds have passed since the last ask that signed (D-45).
  hub.advance(11_000);
  let memory = memories.get(client.device.writer);
  if (memory === undefined) {
    memory = hubMemoryOf(new MemorySecrets());
    memories.set(client.device.writer, memory);
  }
  const transport = transportFor(hub, world, client.device);
  try {
    const report = await syncOnce(transport, client, memory, { now: () => new Date(hub.now()) });
    assert.equal(report.outcome, 'synced', JSON.stringify(report));
    return report;
  } finally {
    transport.close();
    await hub.composed.checkpoints?.settled();
  }
}

/** Issues a hub file and enrols the project from the lead's computer, as connectProjectToHub does. */
async function enrol(hub: CapturedHub, world: HubWorld, lead: Client): Promise<void> {
  const issued = issueHubFile(hub.store, hub.identity, { days: 7, now: new Date(hub.now()) });
  assert.ok(issued.ok, issued.ok ? '' : issued.message);
  const body = await enrolmentRequest(lead, issued.file.payload, { genesisHash: world.genesisHash, rosterHead: world.head });
  const transport = transportFor(hub, world, world.lead);
  try {
    await transport.enrol(body);
  } finally {
    transport.close();
  }
}

/** A label cell whose founding grant carries its sealed label (as labelCells.ts makes one), wrapped to the given devices. */
function sealedLabelCell(world: HubWorld, name: string, token: string, to: ReadonlyArray<{ writer: string; x25519: string }>): { cell: string; key: Buffer; founding: SignedPayload<CellGrant>; entry: Written; label: unknown } {
  const cell = streamOf(`cell/${name}`);
  const key = world.keyOf(cell, 1);
  const label = { scale: 'org', level: 'Confidential', compartments: [token], releasability: [], handling: [] };
  const wraps = to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch: 1, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
  const founding = buildGrant(world.lead.signer, { cell, epoch: 1, roster: world.head, labelSealed: sealLabel(key, cell, 1, label), wraps });
  world.grants.push(founding);
  const entry = world.rosterEntry(world.lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) });
  return { cell, key, founding, entry, label };
}

// ---- Canaries and product shapes ------------------------------------------------------------------------------------------------------------

const ROLES = { owner: 'j2-analyst', sectionLead: 'j2-lead', releaseGuard: 'j2-guard' };
const VERSION_HASH = createHash('sha256').update('fictional version of the product', 'utf8').digest('hex');

/** The canaries of one cell, in the places a product carries text. Fictional strings, distinct per cell. */
interface Canaries {
  name: string;
  title: string;
  text: string;
  label: string;
  reason: string;
  blob: string;
}

const canariesOf = (tag: string): Canaries => ({
  name: `canary-${tag.toLowerCase()}-name-7f3a`,
  title: `CANARY-${tag}-TITLE-91c2`,
  text: `CANARY-${tag}-TEXT-4be8`,
  label: `CANARY-${tag}-LABEL-0d57`,
  reason: `CANARY-${tag}-REASON-c3a9`,
  blob: `CANARY-${tag}-BLOB-58e1`,
});

/** Update bytes as a document update carries them: a few structure bytes, then the inserted text as UTF-8. */
const updateBytes = (text: string): string => Buffer.concat([Buffer.from([1, 1, 0xb4, 0x9e, 0xc1, 0x07, 0, 4]), Buffer.from(text, 'utf8')]).toString('base64url');

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------

test('tracer: a product in a cell not granted to the hub reaches it, member B opens it, and its canaries are in no state folder byte, wire byte or log line', async () => {
  const hub = await startCapturedHub();
  try {
    const u1 = canariesOf('T1');
    const world = createHubWorld({ causalLamport: true });
    world.admitHub(hub.identity);
    const a = world.device('MEMBER-A', 'mbr-a');
    const b = world.device('MEMBER-B', 'mbr-b');
    world.admitMember(a);
    world.admitMember(b);
    const cell = sealedLabelCell(world, 'tracer-u1', u1.label, [world.lead, a, b]);
    const lead = clientOf(world, world.lead, world.entries, world.grants);
    await enrol(hub, world, lead);
    const clientA = clientOf(world, a, baseEntries(world), grantsTo(world, a));
    const clientB = clientOf(world, b, baseEntries(world), grantsTo(world, b));

    writeOn(world, clientA, { stream: cell.cell, kind: 'product.create', data: { product: u1.name, section: 'j2', roles: ROLES, title: u1.title } });
    writeOn(world, clientA, { stream: cell.cell, kind: 'doc.update', data: { product: u1.name, update: updateBytes(`Fictional patrol summary. ${u1.text}.`) } });
    const pushed = await sync(hub, world, clientA);
    assert.equal(pushed.pushed, 2);
    const pulled = await sync(hub, world, clientB);
    assert.equal(pulled.pulled, 2);

    // The hub holds the cell's entries: the capture saw their ciphertext arrive and leave.
    const sent = hub.store.entriesFrom(world.project, cell.cell, a.writer, 0, { limit: 10, maxBytes: 1 << 20 }).entries;
    assert.equal(sent.length, 2, 'the hub stored both entries');
    const wire = wireOf(hub.capture);
    for (const row of sent) assert.ok(wire.some((place) => place.where.startsWith('request') && place.bytes.includes(Buffer.from(row.body, 'utf8'))), 'the capture saw the sealed body arrive');
    for (const row of sent) assert.ok(wire.some((place) => place.where.startsWith('response') && place.bytes.includes(Buffer.from(row.body, 'utf8'))), 'the capture saw the sealed body leave');

    const running = hub.snapshot('running');
    assert.ok(running.some((place) => place.where.endsWith('-wal')), 'the write-ahead log was read while the hub ran');
    const closed = await hub.close();
    const all = [u1.name, u1.title, u1.text, u1.label];
    assertNowhere([...running, ...closed], all, 'state folder');
    assertNowhere(wire, all, 'application layer');
    assertNowhere(logsOf(hub), all, 'log lines');
    assert.ok(hub.logLines.length > 0, 'the logger recorded lines');

    // The scenario carried the canaries: B opens both entries with the cell's key and finds them.
    const opened = (await clientB.opened()).filter((item) => item.stream === cell.cell).map((item) => ({ where: 'B opened', bytes: Buffer.from(item.text, 'utf8') }));
    for (const canary of [u1.name, u1.title, u1.text]) assert.ok(search(opened, canary).length > 0, `B finds ${canary}`);
    const labelKey = (await clientB.ring())(cell.cell, 1);
    assert.ok(labelKey !== undefined, 'B holds the cell key');
    assert.deepEqual(openLabel(labelKey, cell.cell, 1, cell.founding.payload.labelSealed), cell.label, 'B opens the sealed label with its token');
  } finally {
    await hub.close();
    hub.cleanup();
  }
});

test('positive control: a canary planted in each of the five encodings in the state folder, a captured request and a log line is found where it was put', async () => {
  const hub = await startCapturedHub();
  try {
    const plant = 'CANARY-PLANT-CONTROL-6a1d';
    const forms = canaryForms(plant);
    // The state folder: one file per encoding, each holding the canary at a different offset inside other bytes.
    const plantDir = path.join(hub.dir, 'plant');
    mkdirSync(plantDir);
    const b64url = (text: Buffer): Buffer => Buffer.from(text.toString('base64url'), 'ascii');
    const planted = [
      { file: 'utf8', bytes: Buffer.from(`x${plant}y`, 'utf8'), encoding: /^utf8$/ },
      { file: 'utf16le', bytes: Buffer.from(`xy${plant}`, 'utf16le'), encoding: /^utf16le$/ },
      { file: 'hex', bytes: Buffer.from(`00${Buffer.from(plant).toString('hex')}ff`, 'ascii'), encoding: /^hex$/ },
      { file: 'base64', bytes: Buffer.from(Buffer.concat([Buffer.from('a'), Buffer.from(plant)]).toString('base64'), 'ascii'), encoding: /^base64@1$/ },
      { file: 'base64url', bytes: b64url(Buffer.concat([Buffer.from('ab'), Buffer.from(plant)])), encoding: /^base64url@2$/ },
      { file: 'nested', bytes: b64url(Buffer.concat([Buffer.from('{"u":"'), b64url(Buffer.concat([Buffer.from('xyz'), Buffer.from(plant)]))])), encoding: / in base64url@/ },
    ];
    for (const item of planted) writeFileSync(path.join(plantDir, item.file), item.bytes);
    const disk = hub.snapshot('running');
    for (const item of planted) {
      const hits = search(disk, plant).filter((hit) => hit.where === `running:plant/${item.file}`);
      assert.ok(hits.some((hit) => item.encoding.test(hit.encoding)), `the ${item.file} plant is found as ${String(item.encoding)}: ${JSON.stringify(hits)}`);
    }
    assert.equal(forms.length, 4 + 6 + 36, 'utf8, utf16le, two hex cases, six base64 forms and each of them encoded once more');

    // A captured request: the canary in plain text in a body the hub refuses, and in base64url in a header.
    const world = createHubWorld();
    const transport = transportFor(hub, world, world.lead);
    await assert.rejects(transport.enrol({ enrolment: plant }));
    transport.close();
    const wire = wireOf(hub.capture);
    assert.ok(search(wire, plant).some((hit) => hit.where.startsWith('request') && hit.encoding === 'utf8'), 'the plant is found in the captured request');
    assert.ok(search(wire, plant).every((hit) => hit.where.startsWith('request')), 'the hub did not echo it');

    // A log line written through the same logger.
    hub.logger.info('test.plant', { detail: plant });
    assert.ok(search(logsOf(hub), plant).length > 0, 'the plant is found in the log lines');
    // And a clean search over the same places finds a canary that was never written.
    const never = 'CANARY-NEVER-WRITTEN-2f0b';
    assertNowhere([...disk, ...wire, ...logsOf(hub)], [never], 'a canary never written');
  } finally {
    await hub.close();
    hub.cleanup();
  }
});

// ---- Task 2: two compartments, a granted cell, every canary kind, blobs and the positive controls --------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

interface CellScene {
  tag: string;
  cell: string;
  key: Buffer;
  founding: SignedPayload<CellGrant>;
  label: unknown;
  canaries: Canaries;
  /** Every entry written in the cell. */
  written: Written[];
  /** The entry whose data travelled as a blob. */
  large: Written;
}

interface Scene {
  hub: CapturedHub;
  world: HubWorld;
  lead: Client;
  m1: Client;
  m2: Client;
  g: CellScene;
  u1: CellScene;
  u2: CellScene;
  /** Event reports each device's stream received, by writer. */
  reports: Map<string, EventReport[]>;
  /** What the hub's own context made of the stored entries of each cell, read in memory before the hub stopped. */
  hubOpened: Map<string, Array<{ status: string; text: string }>>;
  /** G's blob as the hub opens it with its own ring. */
  hubOpenedBlob: string | undefined;
  /** Checkpoints the hub signed and stored, as JSON text. */
  checkpoints: string[];
  joinRequests: number;
  running: Place[];
  closed: Place[];
}

/** One cell's products: product.create (name and title), a text update, a large update that travels as a blob, and a decision with a reason. */
async function writeProducts(world: HubWorld, client: Client, cell: CellScene): Promise<void> {
  const { canaries } = cell;
  const product = canaries.name;
  cell.written.push(writeOn(world, client, { stream: cell.cell, kind: 'product.create', data: { product, section: 'j2', roles: ROLES, title: canaries.title } }));
  cell.written.push(writeOn(world, client, { stream: cell.cell, kind: 'doc.update', data: { product, update: updateBytes(`Fictional exercise estimate. ${canaries.text}.`) } }));
  // About 24 KiB of update bytes: the body passes 16 KiB, so its data moves into a sealed blob (entry.ts buildEntry).
  const filler = 'Fictional logistics annex line for a training exercise only. '.repeat(200);
  const large = writeOn(world, client, { stream: cell.cell, kind: 'doc.update', data: { product, update: updateBytes(`${filler}${canaries.blob} ${filler}`) } });
  assert.equal(large.blobs.length, 1, 'the large update travels as a blob');
  await keepBlobs(client, large);
  cell.written.push(large);
  cell.large = large;
  cell.written.push(writeOn(world, client, { stream: cell.cell, kind: 'version.verdict', data: { product, hash: VERSION_HASH, gate: 'guard', verdict: 'HOLD', reasons: [canaries.reason] } }));
}

/** The device's event stream on a connection and session of its own, read in the background into a list. */
async function openEvents(hub: CapturedHub, world: HubWorld, device: WorldDevice, reports: EventReport[]): Promise<{ transport: HubTransport; reader: EventReader }> {
  const transport = transportFor(hub, world, device);
  const reader = await transport.events();
  void (async () => {
    for await (const report of reader) reports.push(report);
  })().catch(() => undefined);
  return { transport, reader };
}

async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const framesOf = (reports: readonly EventReport[], event: string): Array<Record<string, unknown>> =>
  reports.flatMap((report) => (report.kind === 'frame' && report.event === event ? [report.data] : []));

/** Sealed presence bytes as a client makes them: the value sealed under the cell key, so the hub relays bytes it cannot open. */
const sealedPresence = (cell: CellScene, text: string): string => sealBlob(cell.key, cell.cell, 1, Buffer.from(text, 'utf8')).bytes;

async function buildScene(): Promise<Scene> {
  const hub = await startCapturedHub();
  const open: Array<{ close(): void }> = [];
  try {
    return await playScene(hub, open);
  } catch (error) {
    // A failed scene must not leave a stream or the server holding the run open.
    for (const item of open) item.close();
    await hub.close();
    hub.cleanup();
    throw error;
  }
}

async function playScene(hub: CapturedHub, open: Array<{ close(): void }>): Promise<Scene> {
  const world = createHubWorld({ projectLabel: 'compartments', causalLamport: true });
  world.admitHub(hub.identity);
  const lead = clientOf(world, world.lead, world.entries, world.grants);
  await enrol(hub, world, lead);

  // Two people join through the hub (32-25): the lead registers an invitation, each person posts a join request, the lead lists both and checks
  // each with the real join secret before admitting anyone.
  const people = [world.device('MEMBER-U1', 'mbr-u1'), world.device('MEMBER-U2', 'mbr-u2')] as const;
  const leadTransport = transportFor(hub, world, world.lead);
  const invites: Array<{ payload: InvitePayload; secret: string }> = [];
  try {
    for (const [index, person] of people.entries()) {
      const secret = newJoinSecret();
      const invite = `inv-compartment-${index + 1}`;
      const signed = buildInvite(world.lead.signer, {
        genesisHash: world.genesisHash,
        project: world.project,
        name: 'Exercise Compartments',
        lead: { member: world.lead.member, x25519: world.lead.x25519, publicKey: world.lead.publicKey },
        invite,
        secret,
        expiresAt: new Date(hub.now() + 7 * DAY_MS).toISOString(),
        now: new Date(hub.now()),
        hub: { address: HUB_ADDRESS, certPin: hub.identity.certPin, writer: hub.identity.writer },
      });
      invites.push({ payload: signed.payload, secret });
      await leadTransport.registerInvite({ invite, expiresAt: signed.payload.expiresAt, checkKey: hubJoinCheckKey(secret, invite) });
      const request = buildJoinRequest(person.signer, signed.payload, { name: `Person ${person.label}`, x25519: person.x25519, now: new Date(hub.now()) });
      const fields = { hub: hub.identity.writer, project: world.project, invite, request: joinRequestHash(request) };
      const join = buildHubJoin(person.signer, { hub: fields.hub, project: fields.project, request, hubMac: hubJoinMac(hubJoinCheckKey(secret, invite), fields), now: new Date(hub.now()) });
      const joiner = transportFor(hub, world, person);
      try {
        assert.equal((await joiner.postJoin({ join, request })).held, false);
      } finally {
        joiner.close();
      }
    }
    const pending = await leadTransport.joinRequests();
    assert.equal(pending.length, 2, 'the lead lists both join requests');
    for (const item of pending) {
      const invite = invites.find((candidate) => candidate.payload.invite === item.invite);
      assert.ok(invite !== undefined);
      assert.ok(checkJoinRequest(item.request, { invite: invite.payload, secret: invite.secret, now: new Date(hub.now()) }).ok, 'the lead checks the request with the join secret');
    }
  } finally {
    leadTransport.close();
  }

  // The lead admits both, makes G (granted to the hub after the trade-off) and the two compartments U1 and U2, each with its sealed label.
  const before = { entries: world.entries.length, grants: world.grants.length };
  const [p1, p2] = people;
  world.admitMember(p1);
  world.admitMember(p2);
  const cellOf = (tag: string, to: ReadonlyArray<{ writer: string; x25519: string }>): CellScene => {
    const canaries = canariesOf(tag);
    const made = sealedLabelCell(world, `compartment-${tag}`, canaries.label, to);
    return { tag, cell: made.cell, key: made.key, founding: made.founding, label: made.label, canaries, written: [], large: undefined as unknown as Written };
  };
  const g = cellOf('G', [world.lead]);
  world.rosterEntry(world.lead, 'hub.grant', { hub: hub.identity.hub, cell: g.cell });
  world.grants.push(buildGrant(world.lead.signer, {
    cell: g.cell,
    epoch: 1,
    roster: world.head,
    labelSealed: sealLabel(g.key, g.cell, 1, g.label),
    wraps: [{ writer: hub.identity.writer, wrap: wrapEpochKey({ cell: g.cell, epoch: 1, writer: hub.identity.writer, recipient: hub.identity.x25519, epochKey: g.key }) }],
  }));
  const u1 = cellOf('U1', [world.lead, p1]);
  const u2 = cellOf('U2', [world.lead, p2]);
  for (const entry of world.entries.slice(before.entries)) assert.ok(lead.add(entry));
  await lead.putGrants(world.grants.slice(before.grants));
  await sync(hub, world, lead);

  // Each person's computer starts from what joining handed it: the roster so far and its base cell grant. Its own cell's key comes from the hub.
  const baseOnly = (device: WorldDevice): Array<SignedPayload<CellGrant>> => grantsTo(world, device).filter((grant) => grant.payload.cell === world.project);
  const m1 = clientOf(world, p1, baseEntries(world), baseOnly(p1));
  const m2 = clientOf(world, p2, baseEntries(world), baseOnly(p2));
  await sync(hub, world, m1);
  await sync(hub, world, m2);
  assert.ok((await m1.ring())(u1.cell, 1) !== undefined, 'the U1 member received its cell key through the hub');
  assert.equal((await m1.ring())(u2.cell, 1), undefined);

  // Live: every device keeps an event stream open from here on.
  const reports = new Map<string, EventReport[]>();
  const streams: Array<{ transport: HubTransport; reader: EventReader }> = [];
  for (const client of [lead, m1, m2]) {
    const list: EventReport[] = [];
    reports.set(client.device.writer, list);
    const stream = await openEvents(hub, world, client.device, list);
    streams.push(stream);
    open.push(stream.reader, stream.transport);
  }

  await writeProducts(world, m1, u1);
  await sync(hub, world, m1);
  await writeProducts(world, m2, u2);
  await sync(hub, world, m2);
  await writeProducts(world, lead, g);
  const leadPush = await sync(hub, world, lead);

  // Presence: each person tells the others on its own cell that it is active, in bytes sealed under the cell key.
  const endpoint = { port: hub.port, now: () => hub.now(), connect: () => HubConnection.open(hub.port, hub.identity.certPin) };
  const posters: EventClient[] = [];
  for (const [client, cell] of [[m1, u1], [m2, u2]] as const) {
    const poster = await EventClient.open(endpoint, client.device, world.project);
    posters.push(poster);
    open.push(poster);
    const answer = await poster.call('POST', `/v1/projects/${world.project}/presence`, { json: { cell: cell.cell, sealed: sealedPresence(cell, `Active on ${cell.canaries.text}`) } });
    assert.equal(answer.status, 200, answer.text);
  }

  // Catch-up: the lead pulls both compartments with their blobs; each person pulls again and gets nothing of the other's cell.
  const leadPull = await sync(hub, world, lead);
  assert.equal(leadPush.pulled + leadPull.pulled, 8, 'the lead pulled four entries of each compartment');
  for (const written of [...u1.written, ...u2.written]) assert.ok(lead.has(written.hash));
  await sync(hub, world, m1);
  await sync(hub, world, m2);
  const leadReports = reports.get(world.lead.writer) as EventReport[];
  await until(() => new Set(framesOf(leadReports, 'presence').map((frame) => frame.cell)).size === 2, 'presence of both compartments on the lead stream');
  for (const client of [m1, m2]) await until(() => framesOf(reports.get(client.device.writer) as EventReport[], 'checkpoint').length > 0, 'a checkpoint event on each stream');

  // The hub's own context, in memory: what it can open of each cell's stored entries, and G's blob through its ring.
  const roster = await hub.composed.cache.get(world.project);
  const ctx = roster.context(new Date(hub.now()));
  const hubOpened = new Map<string, Array<{ status: string; text: string }>>();
  for (const [cell, writer] of [[g, world.lead.writer], [u1, p1.writer], [u2, p2.writer]] as const) {
    const rows = hub.store.entriesFrom(world.project, cell.cell, writer, 0, { limit: 100, maxBytes: 8 << 20 }).entries;
    assert.equal(rows.length, 4, `the hub stored the four ${cell.tag} entries`);
    hubOpened.set(cell.tag, await Promise.all(rows.map(async (row) => {
      // As the checkpointer reads an entry (checkpoints.ts openFrom): a body that names a blob is read again with that blob from the store.
      const sealed = sealedOf(row);
      let outcome = verifyEntry(sealed, ctx);
      if (outcome.status === 'held' && outcome.reason === 'missing-blob') {
        const blobs = new Map<string, SealedBlob>();
        for (const hash of blobsNamed([sealed], roster.ring)) {
          const bytes = await hub.store.readBlob(world.project, hash);
          if (bytes !== undefined) blobs.set(hash, { hash, bytes: bytes.toString('base64url') });
        }
        outcome = verifyEntry(sealed, { ...ctx, blobs: (hash) => ctx.blobs(hash) ?? blobs.get(hash) });
      }
      return { status: outcome.status === 'verified' ? 'verified' : `${outcome.status}:${'reason' in outcome ? String(outcome.reason) : ''}`, text: outcome.status === 'verified' ? JSON.stringify(outcome.entry.body) : '' };
    })));
  }
  const gKey = roster.ring(g.cell, 1);
  const gBlob = g.large.blobs[0] as SealedBlob;
  const stored = await hub.store.readBlob(world.project, gBlob.hash);
  const hubOpenedBlob = gKey === undefined || stored === undefined ? undefined : openBlob(gKey, g.cell, 1, { hash: gBlob.hash, bytes: stored.toString('base64url') })?.toString('utf8');
  const checkpoints = hub.store.checkpoints(world.project).map((row) => row.body);

  for (const stream of streams) {
    stream.reader.close();
    stream.transport.close();
  }
  for (const poster of posters) poster.close();
  const running = hub.snapshot('running');
  const closed = await hub.close();
  return { hub, world, lead, m1, m2, g, u1, u2, reports, hubOpened, hubOpenedBlob, checkpoints, joinRequests: 2, running, closed };
}

let built: Promise<Scene> | undefined;
const sceneOf = (): Promise<Scene> => (built ??= buildScene());
test.after(async () => {
  if (built === undefined) return;
  const scene = await built.catch(() => undefined);
  if (scene === undefined) return;
  await scene.hub.close();
  scene.hub.cleanup();
});

const ungranted = (scene: Scene, pick: (canaries: Canaries) => string): string[] => [pick(scene.u1.canaries), pick(scene.u2.canaries)];
const everywhere = (scene: Scene): { disk: Place[]; wire: Place[]; logs: Place[] } => ({ disk: [...scene.running, ...scene.closed], wire: wireOf(scene.hub.capture), logs: logsOf(scene.hub) });

function assertNowhereInHub(scene: Scene, canaries: readonly string[], what: string): void {
  const { disk, wire, logs } = everywhere(scene);
  assertNowhere(disk, canaries, `${what}, state folder`);
  assertNowhere(wire, canaries, `${what}, application layer`);
  assertNowhere(logs, canaries, `${what}, log lines`);
}

/** The bytes the hub sent to the connections one device authenticated on. */
const sentTo = (scene: Scene, device: WorldDevice): Place[] =>
  wireOf(scene.hub.capture, (exchange) => scene.hub.capture.deviceOf(exchange.socket) === device.writer).filter((place) => place.where.startsWith('response'));

test('positive control: the scene carried every canary; the lead opens U1 and U2 and finds the product name, title, text, label, decision reason and blob canaries of each', async () => {
  const scene = await sceneOf();
  const opened = (await scene.lead.opened()).map((item) => ({ where: `lead opened ${item.stream}`, bytes: Buffer.from(item.text, 'utf8') }));
  const ring = await scene.lead.ring();
  for (const cell of [scene.u1, scene.u2, scene.g]) {
    const inCell = opened.filter((place) => place.where === `lead opened ${cell.cell}`);
    for (const canary of [cell.canaries.name, cell.canaries.title, cell.canaries.text, cell.canaries.reason, cell.canaries.blob]) {
      assert.ok(search(inCell, canary).length > 0, `the lead finds ${canary}`);
    }
    const key = ring(cell.cell, 1);
    assert.ok(key !== undefined);
    assert.deepEqual(openLabel(key, cell.cell, 1, cell.founding.payload.labelSealed), cell.label, `the lead opens ${cell.tag}'s label with its token`);
  }
  // The large product's data really came as a blob from the hub: the lead's computer holds the blob the U1 member uploaded.
  for (const cell of [scene.u1, scene.u2]) assert.deepEqual(await scene.lead.blob((cell.large.blobs[0] as SealedBlob).hash), cell.large.blobs[0]);
  // Each person opens its own compartment and no other.
  const m1 = (await scene.m1.opened()).map((item) => ({ where: item.stream, bytes: Buffer.from(item.text, 'utf8') }));
  assert.ok(search(m1, scene.u1.canaries.text).length > 0);
  assert.deepEqual(search(m1, scene.u2.canaries.text), []);
  assert.equal(scene.joinRequests, 2);
});

test('no U1 or U2 product name, title or text canary is in any state folder byte, application-layer byte or log line', async () => {
  const scene = await sceneOf();
  assertNowhereInHub(scene, [...ungranted(scene, (c) => c.name), ...ungranted(scene, (c) => c.title), ...ungranted(scene, (c) => c.text)], 'product text');
});

test('no U1 or U2 label canary is in any state folder byte, application-layer byte or log line, though both sealed labels reached the hub', async () => {
  const scene = await sceneOf();
  const { wire } = everywhere(scene);
  for (const cell of [scene.u1, scene.u2]) {
    assert.ok(wire.some((place) => place.where.startsWith('request') && place.bytes.includes(Buffer.from(cell.founding.payload.labelSealed, 'utf8'))), `${cell.tag}'s sealed label arrived`);
  }
  assertNowhereInHub(scene, ungranted(scene, (c) => c.label), 'label');
});

test('no U1 or U2 decision reason canary is in any state folder byte, application-layer byte or log line', async () => {
  const scene = await sceneOf();
  assertNowhereInHub(scene, ungranted(scene, (c) => c.reason), 'decision reason');
});

test('blob: each compartment\'s large product travelled through the hub as a sealed blob, put and fetched, and its blob canary is nowhere in the hub', async () => {
  const scene = await sceneOf();
  const { wire } = everywhere(scene);
  for (const cell of [scene.u1, scene.u2]) {
    const blob = cell.large.blobs[0] as SealedBlob;
    const bytes = Buffer.from(blob.bytes, 'base64url');
    const put = scene.hub.capture.exchanges.filter((exchange) => exchange.method === 'PUT' && exchange.path === `/v1/blobs/${blob.hash}`);
    const got = scene.hub.capture.exchanges.filter((exchange) => exchange.method === 'GET' && exchange.path === `/v1/blobs/${blob.hash}`);
    assert.ok(put.some((exchange) => Buffer.concat(exchange.request).includes(bytes)), `${cell.tag}'s blob was put`);
    assert.ok(got.some((exchange) => Buffer.concat(exchange.response).includes(bytes) && scene.hub.capture.deviceOf(exchange.socket) === scene.world.lead.writer), `the lead fetched ${cell.tag}'s blob`);
    assert.ok(scene.closed.some((place) => place.where === `closed:${path.join('blobs', scene.world.project, blob.hash)}` || place.where.endsWith(blob.hash)), `${cell.tag}'s blob rests in the blob folder`);
  }
  assert.ok(wire.length > 0);
  assertNowhereInHub(scene, ungranted(scene, (c) => c.blob), 'blob');
});

test('positive control: the hub\'s own context opens the stored G entries and G\'s blob in memory and finds G\'s canaries; it opens no U1 or U2 entry', async () => {
  const scene = await sceneOf();
  const g = scene.hubOpened.get('G') ?? [];
  assert.deepEqual(g.map((item) => item.status), ['verified', 'verified', 'verified', 'verified']);
  const inMemory = [...g.map((item, index) => ({ where: `G entry ${index}`, bytes: Buffer.from(item.text, 'utf8') })), { where: 'G blob', bytes: Buffer.from(scene.hubOpenedBlob ?? '', 'utf8') }];
  for (const canary of [scene.g.canaries.name, scene.g.canaries.title, scene.g.canaries.text, scene.g.canaries.reason, scene.g.canaries.blob]) {
    assert.ok(search(inMemory, canary).length > 0, `the hub's context finds ${canary}`);
  }
  for (const tag of ['U1', 'U2']) {
    const rows = scene.hubOpened.get(tag) ?? [];
    assert.equal(rows.length, 4);
    assert.ok(rows.every((item) => item.status !== 'verified' && item.text === ''), `the hub opens no ${tag} entry: ${JSON.stringify(rows.map((item) => item.status))}`);
  }
  // The checkpoints the hub signed cover the base cell and G, never U1 or U2 (D-63).
  assert.ok(scene.checkpoints.length > 0, 'checkpoints were asked for and signed');
  const latest = scene.checkpoints.at(-1) as string;
  assert.ok(latest.includes(scene.g.cell));
  for (const text of scene.checkpoints) {
    assert.equal(text.includes(scene.u1.cell), false);
    assert.equal(text.includes(scene.u2.cell), false);
  }
});

test('G\'s canaries appear in no log line and in no answer or event frame sent to the U1-only or U2-only member\'s connections', async () => {
  const scene = await sceneOf();
  const gCanaries = [scene.g.canaries.name, scene.g.canaries.title, scene.g.canaries.text, scene.g.canaries.label, scene.g.canaries.reason, scene.g.canaries.blob];
  assertNowhere(logsOf(scene.hub), gCanaries, 'G in log lines');
  for (const member of [scene.m1, scene.m2]) {
    const sent = sentTo(scene, member.device);
    assert.ok(sent.length > 5, `the ${member.device.label} member's connections were captured`);
    assertNowhere(sent, gCanaries, `G to ${member.device.label}`);
    for (const written of scene.g.written) assert.equal(sent.some((place) => place.bytes.includes(Buffer.from(written.entry.body, 'utf8'))), false, `no G entry reached ${member.device.label}`);
  }
});

test('the U1-only member\'s connections receive no frame, page or blob of U2, and the U2-only member\'s none of U1 (D-24 over the hub)', async () => {
  const scene = await sceneOf();
  const marks = (cell: CellScene): Array<{ what: string; bytes: Buffer }> => [
    { what: `${cell.tag} cell id`, bytes: Buffer.from(cell.cell, 'utf8') },
    { what: `${cell.tag} founding grant hash`, bytes: Buffer.from(grantHash(cell.founding), 'utf8') },
    ...cell.written.flatMap((written, index) => [
      { what: `${cell.tag} entry ${index} hash`, bytes: Buffer.from(written.hash, 'utf8') },
      { what: `${cell.tag} entry ${index} sealed body`, bytes: Buffer.from(written.entry.body.slice(0, 64), 'utf8') },
    ]),
    { what: `${cell.tag} blob hash`, bytes: Buffer.from((cell.large.blobs[0] as SealedBlob).hash, 'utf8') },
    { what: `${cell.tag} sealed blob`, bytes: Buffer.from((cell.large.blobs[0] as SealedBlob).bytes.slice(0, 64), 'utf8') },
    { what: `${cell.tag} sealed blob bytes`, bytes: Buffer.from((cell.large.blobs[0] as SealedBlob).bytes, 'base64url').subarray(0, 48) },
  ];
  const found = (places: readonly Place[], cell: CellScene): string[] => marks(cell).filter((mark) => places.some((place) => place.bytes.includes(mark.bytes))).map((mark) => mark.what);
  const toM1 = sentTo(scene, scene.m1.device);
  const toM2 = sentTo(scene, scene.m2.device);
  assert.deepEqual(found(toM1, scene.u2), [], 'U2 reached the U1-only member');
  assert.deepEqual(found(toM2, scene.u1), [], 'U1 reached the U2-only member');
  // Controls: each member's connections did carry its own cell (the heads naming it, its key's grant), and the lead's carried both compartments'
  // entries, blobs and presence, so the same marks are found where they belong.
  assert.ok(found(toM1, scene.u1).includes('U1 cell id') && found(toM1, scene.u1).includes('U1 founding grant hash'));
  assert.ok(found(toM2, scene.u2).includes('U2 cell id') && found(toM2, scene.u2).includes('U2 founding grant hash'));
  const toLead = sentTo(scene, scene.world.lead);
  // (A blob is fetched by its hash in the request path and served as raw bytes, so its hash and base64url form are in no answer to anyone.)
  const servedAs = (cell: CellScene): string[] => marks(cell).map((mark) => mark.what).filter((what) => what !== `${cell.tag} blob hash` && what !== `${cell.tag} sealed blob`);
  for (const cell of [scene.u1, scene.u2]) assert.deepEqual(found(toLead, cell).sort(), servedAs(cell).sort(), `the lead received all of ${cell.tag}`);
  // The event streams: no frame to a member names the other compartment, and presence reached only the lead.
  for (const [member, other] of [[scene.m1, scene.u2], [scene.m2, scene.u1]] as const) {
    const frames = (scene.reports.get(member.device.writer) ?? []).filter((report) => report.kind === 'frame');
    assert.ok(frames.length > 0, `${member.device.label} heard frames`);
    assert.equal(JSON.stringify(frames).includes(other.cell), false);
    assert.deepEqual(framesOf(scene.reports.get(member.device.writer) ?? [], 'presence'), []);
  }
});
