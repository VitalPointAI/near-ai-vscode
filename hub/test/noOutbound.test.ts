import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readHubFile } from '@ext/domain/replica/hubFile';
import { buildHubJoin, buildInvite, buildJoinRequest, hubJoinCheckKey, hubJoinMac, joinRequestHash, newJoinSecret } from '@ext/domain/replica/invite';
import { HubTransport } from '@ext/staff/replica/hubTransport';
import type { EventReport } from '@ext/staff/replica/hubTransport';
import { hubMemoryOf, syncOnce } from '@ext/staff/replica/hubSync';
import { hubIdentityOf } from '../src/enrol';
import type { HubIdentity } from '../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../src/keys';
import { healthcheckHost } from '../src/main';
import { HubConnection } from './helpers/hubClient';
import { hubRoot, launchHub, startHubProcess, within } from './helpers/hubProcess';
import type { HubRun } from './helpers/hubProcess';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { MemorySecrets, memoryReplica } from './helpers/memoryReplica';
import { EventClient } from './helpers/sseReader';
import { makeTlsFixture } from './helpers/tlsFixture';

// Phase 32, plan 27 (D-62): the hub calls nobody; it only answers. A small module preloaded with --import (through NODE_OPTIONS, the way the
// built hub runs as a child here) wraps every client network API Node offers a program: net.Socket.prototype.connect (net.connect,
// net.createConnection and every http request end there), tls.connect (https), dns.lookup and dns.promises.lookup, dgram.createSocket and the
// global fetch. Each call appends one line (kind and target) to the file named by NEAR_AI_TEST_OUTBOUND_LOG (outside the HUB_ prefix, so the
// hub's settings check does not refuse it) and then fails. A lookup of an address literal is passed through unlogged: Node answers it at once
// without a query, and net.Server.listen asks for one when it binds HUB_HOST. A control child shows the hook catches each API; the built hub then
// runs a whole session under it and logs nothing; the --healthcheck invocation reaches only the hub's own loopback port; and a source scan shows
// no hub file but the health check names a network client API. All names and data are fictional.

const HOOK = `// The outbound recording hook of hub/test/noOutbound.test.ts (written by the test; fictional test tooling only).
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';

const file = process.env.NEAR_AI_TEST_OUTBOUND_LOG;
const refused = (kind, target) => {
  if (file) appendFileSync(file, kind + ' ' + target + '\\n');
  const error = new Error('outbound ' + kind + ' refused by the test hook');
  error.code = 'NEAR_AI_TEST_OUTBOUND';
  return error;
};
const targetOf = (args) => {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return 'path:' + first.path;
    return String(first.host ?? first.hostname ?? 'localhost') + ':' + String(first.port ?? '');
  }
  if (typeof first === 'number' || /^[0-9]+$/.test(String(first))) return String(typeof args[1] === 'string' ? args[1] : 'localhost') + ':' + String(first);
  return 'path:' + String(first);
};

net.Socket.prototype.connect = function connect(...args) {
  throw refused('net', targetOf(args));
};
tls.connect = function connect(...args) {
  throw refused('tls', targetOf(args));
};
const lookup = dns.lookup;
dns.lookup = function hookedLookup(host, ...rest) {
  if (net.isIP(String(host)) !== 0) return lookup.call(this, host, ...rest);
  throw refused('dns', String(host));
};
const promisesLookup = dns.promises.lookup;
dns.promises.lookup = function hookedPromisesLookup(host, ...rest) {
  if (net.isIP(String(host)) !== 0) return promisesLookup.call(this, host, ...rest);
  return Promise.reject(refused('dns', String(host)));
};
dgram.createSocket = function createSocket(type) {
  throw refused('udp', typeof type === 'string' ? type : String(type?.type));
};
globalThis.fetch = async function fetch(input) {
  throw refused('fetch', String(input?.url ?? input));
};
syncBuiltinESMExports();
`;

/** The control child: one fetch to 127.0.0.1, or one call of every wrapped API. */
const CONTROL_ONE = `try { await fetch('http://127.0.0.1:9/'); } catch {}
`;
const CONTROL_EVERY = `import dgram from 'node:dgram';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { connect as namedConnect } from 'node:net';
import tls from 'node:tls';
process.on('uncaughtException', () => undefined);
const tries = [
  () => fetch('https://example.invalid/report'),
  () => net.connect(443, 'example.invalid'),
  () => tls.connect(443, 'example.invalid'),
  () => new Promise((resolve) => dns.lookup('example.invalid', () => resolve())),
  () => dns.promises.lookup('example.invalid'),
  () => dgram.createSocket('udp4'),
  () => https.get('https://example.invalid/telemetry'),
  () => namedConnect({ host: 'example.invalid', port: 80 }),
  () => new Promise((resolve, reject) => dns.lookup('127.0.0.1', (error) => (error ? reject(error) : resolve()))),
];
for (const attempt of tries) {
  try { await attempt(); } catch {}
}
`;

interface Hooked {
  dir: string;
  hookUrl: string;
  /** The environment a child needs to load the hook and write to its own log file. */
  env(log: string): Record<string, string>;
  lines(log: string): string[];
  cleanup(): void;
}

function hookFolder(): Hooked {
  const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-hub-outbound-'));
  const hook = path.join(dir, 'outbound-hook.mjs');
  writeFileSync(hook, HOOK);
  const hookUrl = pathToFileURL(hook).href;
  return {
    dir,
    hookUrl,
    env: (log) => ({ NODE_OPTIONS: `--import=${hookUrl}`, NEAR_AI_TEST_OUTBOUND_LOG: path.join(dir, log) }),
    lines: (log) => {
      const file = path.join(dir, log);
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '') : [];
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs a script as a child with only PATH, HOME and the given environment, and waits for it to exit. */
async function runChild(script: string, env: Record<string, string>): Promise<number | null> {
  const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  return within(new Promise((resolve) => child.on('close', (code) => resolve(code))), 20_000, 'the control child');
}

test('control: a child with the recording hook logs exactly one line for one fetch to 127.0.0.1, and one line for each wrapped client API', async () => {
  const hooked = hookFolder();
  try {
    const one = path.join(hooked.dir, 'control-one.mjs');
    writeFileSync(one, CONTROL_ONE);
    assert.equal(await runChild(one, hooked.env('one.log')), 0);
    assert.deepEqual(hooked.lines('one.log'), ['fetch http://127.0.0.1:9/']);

    const every = path.join(hooked.dir, 'control-every.mjs');
    writeFileSync(every, CONTROL_EVERY);
    await runChild(every, hooked.env('every.log'));
    assert.deepEqual(hooked.lines('every.log'), [
      'fetch https://example.invalid/report',
      'net example.invalid:443',
      'tls example.invalid:443',
      'dns example.invalid',
      'dns example.invalid',
      'udp udp4',
      'tls example.invalid:443',
      'net example.invalid:80',
    ]);

    // Without the hook the same child writes nothing to the log (the lines come from the hook alone).
    const plain = { NEAR_AI_TEST_OUTBOUND_LOG: path.join(hooked.dir, 'plain.log') };
    await runChild(one, plain);
    assert.deepEqual(hooked.lines('plain.log'), []);
  } finally {
    hooked.cleanup();
  }
});

// ---- The built hub under the hook ---------------------------------------------------------------------------------------------------------

interface HubSecrets {
  secrets: Record<string, string>;
  identity: HubIdentity;
  cleanup(): void;
}

/** The four secrets the operator gives the hub, and the identity they make (to admit the hub into the world's roster). */
function hubSecrets(): HubSecrets {
  const tls = makeTlsFixture();
  const signingLine = generateKeyFile('signing');
  const encryptionLine = generateKeyFile('encryption');
  const signing = readSigningKey(signingLine);
  const identity = hubIdentityOf(signing, readEncryptionKey(encryptionLine, signing), tls.certPem, HUB_ADDRESS);
  return {
    secrets: { HUB_TLS_CERT: tls.certPem, HUB_TLS_KEY: tls.keyPem, HUB_SIGNING_KEY: `${signingLine}\n`, HUB_ENCRYPTION_KEY: `${encryptionLine}\n` },
    identity,
    cleanup: () => tls.cleanup(),
  };
}

function transportFor(port: number, identity: HubIdentity, world: HubWorld, device: WorldDevice): HubTransport {
  return new HubTransport({ address: `127.0.0.1:${port}`, project: world.project, hub: identity.writer, trust: { pin: identity.certPin }, signer: device.signer, servername: 'localhost' });
}

async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the serving hub opens no outbound connection: session, enrolment, append, catch-up, blobs, events, presence, checkpoint ask, invitation and join', async () => {
  const hooked = hookFolder();
  const keys = hubSecrets();
  const stateDir = path.join(hooked.dir, 'state');
  const runs: HubRun[] = [];
  const closers: Array<{ close(): void }> = [];
  try {
    // The hub file, issued by the binary under the hook too.
    const issue = launchHub({ args: ['--hub-file', '7'], secrets: keys.secrets, stateDir, env: { HUB_PUBLIC_ADDRESS: HUB_ADDRESS, ...hooked.env('hub-file.log') } });
    runs.push(issue);
    assert.equal((await within(issue.exited, 20_000, 'the hub file')).code, 0, issue.stdout() + issue.stderr());
    const file = readHubFile(issue.stdout().trim(), new Date());
    assert.ok(file.ok, 'the hub file reads');

    const run = await startHubProcess({ secrets: keys.secrets, stateDir, env: hooked.env('hub.log') });
    runs.push(run);
    const { identity } = keys;

    // The world: the hub admitted, a member, and an operations cell for both people.
    const world = createHubWorld({ projectLabel: 'outbound', causalLamport: true });
    world.admitHub(identity);
    const member = world.device('MEMBER-B', 'mbr-b');
    world.admitMember(member);
    const ops = world.labelCell('ops', [world.lead, member]);

    // Enrolment (no session) through the client transport.
    const enroller = transportFor(run.port, identity, world, world.lead);
    closers.push(enroller);
    assert.deepEqual(await enroller.enrol(world.enrolRequest(file.hubFile)), { project: world.project, rosterHead: world.head, hub: identity.hub });

    // Events: the member keeps a stream open.
    const memberTransport = transportFor(run.port, identity, world, member);
    closers.push(memberTransport);
    const reader = await memberTransport.events();
    closers.push(reader);
    const reports: EventReport[] = [];
    void (async () => {
      for await (const report of reader) reports.push(report);
    })().catch(() => undefined);

    // Session, append and catch-up: the lead pushes a note, the member pulls it (each exchange ends with a checkpoint ask).
    const a = memoryReplica(world, world.lead);
    const b = memoryReplica(world, member);
    const note = world.write(world.lead, { kind: 'note.add', data: { text: 'Fictional situation report' } });
    assert.ok(a.add(note.entry));
    const leadTransport = transportFor(run.port, identity, world, world.lead);
    closers.push(leadTransport);
    const pushed = await syncOnce(leadTransport, a, hubMemoryOf(new MemorySecrets()));
    assert.equal(pushed.outcome, 'synced', JSON.stringify(pushed));
    await until(() => reports.some((report) => report.kind === 'frame' && report.event === 'heads'), 'a heads frame on the member stream');
    const pulled = await syncOnce(memberTransport, b, hubMemoryOf(new MemorySecrets()));
    assert.equal(pulled.outcome, 'synced', JSON.stringify(pulled));
    assert.ok(b.has(note.hash));

    // Blobs: a large update in the operations cell travels as a blob, put on a 409 blob-missing and fetched by the member.
    const large = world.write(world.lead, { stream: ops.cell, kind: 'doc.update', data: { product: 'ops-annex', update: Buffer.from('Fictional annex line. '.repeat(1200), 'utf8').toString('base64url') } });
    const blob = large.blobs[0];
    assert.ok(blob !== undefined, 'the update travels as a blob');
    const appended = await leadTransport.append({ entries: [large.entry], blobRefs: [{ entry: large.hash, blob: blob.hash }] }, (hash) => (hash === blob.hash ? blob : undefined));
    assert.deepEqual(appended.accepted, [large.hash]);
    const fetched = await memberTransport.getBlob(blob.hash);
    assert.equal(fetched.kind, 'blob');

    // Presence on the operations cell, and an explicit checkpoint ask.
    const endpoint = { port: run.port, now: () => Date.now(), connect: () => HubConnection.open(run.port, identity.certPin) };
    const poster = await EventClient.open(endpoint, member, world.project);
    closers.push(poster);
    assert.equal((await poster.call('POST', `/v1/projects/${world.project}/presence`, { json: { cell: ops.cell, sealed: Buffer.from('fictional sealed presence').toString('base64url') } })).status, 200);
    assert.equal((await leadTransport.askCheckpoint()).project, world.project);

    // Invitation registration and a join post through the hub.
    const secret = newJoinSecret();
    const invite = 'inv-outbound-1';
    const signed = buildInvite(world.lead.signer, {
      genesisHash: world.genesisHash,
      project: world.project,
      name: 'Exercise Outbound',
      lead: { member: world.lead.member, x25519: world.lead.x25519, publicKey: world.lead.publicKey },
      invite,
      secret,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      now: new Date(),
      hub: { address: HUB_ADDRESS, certPin: identity.certPin, writer: identity.writer },
    });
    await leadTransport.registerInvite({ invite, expiresAt: signed.payload.expiresAt, checkKey: hubJoinCheckKey(secret, invite) });
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const request = buildJoinRequest(joiner.signer, signed.payload, { name: 'Person J', x25519: joiner.x25519, now: new Date() });
    const fields = { hub: identity.writer, project: world.project, invite, request: joinRequestHash(request) };
    const join = buildHubJoin(joiner.signer, { hub: fields.hub, project: fields.project, request, hubMac: hubJoinMac(hubJoinCheckKey(secret, invite), fields), now: new Date() });
    const joinerTransport = transportFor(run.port, identity, world, joiner);
    closers.push(joinerTransport);
    assert.equal((await joinerTransport.postJoin({ join, request })).held, false);
    assert.equal((await leadTransport.joinRequests()).length, 1);
    await until(() => reports.some((report) => report.kind === 'frame' && report.event === 'checkpoint'), 'a checkpoint frame on the member stream');

    for (const closer of closers) closer.close();
    const stopped = await within(run.kill('SIGTERM'), 15_000, 'the stop');
    assert.equal(stopped.code, 0, run.stdout() + run.stderr());
    const events = run.events();
    for (const expected of ['hub.listening', 'checkpoint.signed', 'join.accepted', 'hub.stopped']) assert.ok(events.includes(expected), `the hub logged ${expected}: ${events.join(',')}`);

    assert.deepEqual(hooked.lines('hub-file.log'), [], 'the hub file run made no outbound call');
    assert.deepEqual(hooked.lines('hub.log'), [], 'the serving hub made no outbound call');
  } finally {
    for (const closer of closers) closer.close();
    for (const run of runs) run.cleanup();
    keys.cleanup();
    hooked.cleanup();
  }
});

test('healthcheck: the --healthcheck invocation under the hook connects only to the hub\'s own loopback address and port', async () => {
  const hooked = hookFolder();
  const keys = hubSecrets();
  const runs: HubRun[] = [];
  try {
    const run = await startHubProcess({ secrets: keys.secrets });
    runs.push(run);
    const checked = launchHub({ args: ['--healthcheck'], env: { HUB_PORT: String(run.port), ...hooked.env('healthcheck.log') } });
    runs.push(checked);
    await within(checked.exited, 20_000, 'the health check under the hook');
    const lines = hooked.lines('healthcheck.log');
    assert.ok(lines.length > 0, 'the health check tried to connect');
    assert.deepEqual(lines.filter((line) => line !== `tls 127.0.0.1:${run.port}` && line !== `net 127.0.0.1:${run.port}`), [], `every target is the hub's own loopback port: ${lines.join(', ')}`);
    // Control: without the hook the health check reaches the hub and passes.
    const plain = launchHub({ args: ['--healthcheck'], env: { HUB_PORT: String(run.port) } });
    runs.push(plain);
    assert.equal((await within(plain.exited, 20_000, 'the health check')).code, 0, plain.stdout() + plain.stderr());

    // HUB_HOST bound to every address is checked on loopback.
    assert.equal(healthcheckHost('0.0.0.0'), '127.0.0.1');
    assert.equal(healthcheckHost('::'), '::1');
  } finally {
    for (const run of runs) run.cleanup();
    keys.cleanup();
    hooked.cleanup();
  }
});

// ---- The source scan -------------------------------------------------------------------------------------------------------------------------

/** Client network APIs a hub source line may not name (D-62). */
const CLIENT_APIS: ReadonlyArray<{ what: string; pattern: RegExp }> = [
  { what: 'fetch', pattern: /\bfetch\s*\(/ },
  { what: 'http or https request or get', pattern: /\bhttps?2?\s*\.\s*(request|get|connect)\s*\(/ },
  { what: 'net or tls connect', pattern: /\b(net|tls)\s*\.\s*(connect|createConnection)\s*\(/ },
  { what: 'createConnection', pattern: /\bcreateConnection\s*\(/ },
  { what: 'a named client import', pattern: /^\s*import\s*\{[^}]*\b(request|get|connect|createConnection|lookup|resolve)\b[^}]*\}\s*from\s*['"](node:)?(https?|http2|net|tls|dns)(\/promises)?['"]/ },
  { what: 'dgram', pattern: /['"](node:)?dgram['"]/ },
  { what: 'node:dns', pattern: /['"](node:)?dns(\/promises)?['"]/ },
  { what: 'http2', pattern: /['"](node:)?http2['"]/ },
  { what: 'a browser client', pattern: /\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b/ },
  { what: 'undici', pattern: /\bundici\b/ },
];

/** A line that is a comment and nothing else. */
const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

/** The client API lines of one source text, comment lines filtered out, with their 1-based line numbers. */
function clientCalls(text: string): Array<{ line: number; what: string; text: string }> {
  const found: Array<{ line: number; what: string; text: string }> = [];
  text.split('\n').forEach((line, index) => {
    if (isComment(line)) return;
    for (const api of CLIENT_APIS) if (api.pattern.test(line)) found.push({ line: index + 1, what: api.what, text: line.trim() });
  });
  return found;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The lines of runHealthcheck in main.ts: from its declaration to the closing brace at the start of a line. */
function healthcheckLines(text: string): { first: number; last: number } {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.startsWith('export async function runHealthcheck(')) + 1;
  assert.ok(first > 0, 'main.ts declares runHealthcheck');
  const last = lines.findIndex((line, index) => index >= first && line === '}') + 1;
  assert.ok(last > first, 'runHealthcheck ends');
  return { first, last };
}

test('source: no hub source file outside the health check calls a network client API, with comment lines filtered out', () => {
  const src = path.join(hubRoot(), 'src');
  const files = sourceFiles(src);
  assert.ok(files.length >= 20, `the hub sources were found (${files.length})`);
  const outside: string[] = [];
  let inHealthcheck = 0;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const name = path.relative(src, file);
    const range = name === 'main.ts' ? healthcheckLines(text) : undefined;
    for (const call of clientCalls(text)) {
      if (range !== undefined && call.line > range.first && call.line < range.last) inHealthcheck += 1;
      else outside.push(`${name}:${call.line} ${call.what}: ${call.text}`);
    }
  }
  assert.deepEqual(outside, []);
  // The one call is the health check's own request, to the address healthcheckHost maps the bind address to (loopback for a wildcard bind).
  assert.equal(inHealthcheck, 1, 'runHealthcheck makes exactly one request');
  const main = readFileSync(path.join(src, 'main.ts'), 'utf8');
  const { first, last } = healthcheckLines(main);
  const body = main.split('\n').slice(first, last - 1).join('\n');
  assert.match(body, /const host = healthcheckHost\(config\.host\);/);
  assert.match(body, /\bhost,\s*\n\s*port: config\.port,/);
});

test('source: the scanner has teeth: every client API form is reported, a comment line naming one is not, and the health check range is exact', () => {
  const offending = [
    "const answer = await fetch('https://example.invalid/');",
    "https.request({ host: 'example.invalid' });",
    "http.get('http://example.invalid/');",
    "net.connect(443, 'example.invalid');",
    "tls.connect({ host: 'example.invalid', port: 443 });",
    "const socket = createConnection({ port: 80 });",
    "import { request } from 'node:https';",
    "import { lookup } from 'node:dns/promises';",
    "import dgram from 'node:dgram';",
    "import dns from 'dns';",
    "import http2 from 'node:http2';",
    "const ws = new WebSocket('wss://example.invalid');",
    "import { fetch as undiciFetch } from 'undici';",
  ];
  for (const line of offending) assert.ok(clientCalls(line).length > 0, `reported: ${line}`);
  for (const line of offending) assert.deepEqual(clientCalls(`// ${line}`), [], `a comment line is not reported: ${line}`);
  assert.deepEqual(clientCalls(" * see fetch('https://example.invalid/') in the docs"), []);
  // Server APIs and type imports are not client calls.
  for (const line of ["import https from 'node:https';", 'const server = https.createServer(options, handler);', "import type { TLSSocket } from 'node:tls';", 'socket.exportKeyingMaterial(32, label, Buffer.alloc(0));']) {
    assert.deepEqual(clientCalls(line), [], `not reported: ${line}`);
  }
  const range = healthcheckLines(['x', 'export async function runHealthcheck(config) {', '  https.request({});', '}', 'https.get(url);'].join('\n'));
  assert.deepEqual(range, { first: 2, last: 4 });
});
