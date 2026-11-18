// The NEAR AI Cloud connection binding (CLAS-05 as the owner amplified it, D-50, D-55, OFFL-01): NEAR AI Cloud's own attestation decides whether a
// connection is bound, and an attested request only travels over a connection pinned to the attested key. Every test runs against fixture reports, a local
// TLS server on 127.0.0.1 with the cyber fixture certificate and counting fake fetches; nothing reaches NEAR AI Cloud and no key is read.
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as https from 'node:https';
import * as net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import type { ActorRef } from '../domain/gate/decide';
import { validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import { BINDING_REFUSALS } from '../domain/gate/routing';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { attestedTlsFingerprint } from '../services/attestation';
import { ConnectionNotBoundError, NEAR_TLS_FINGERPRINT_KIND, NearConnectionBinding, normaliseFingerprint, pinnedFetch } from '../services/connectionBinding';
import type { ConnectionBindingSource } from '../services/connectionBinding';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
import { TEST_ROOT, testQuote } from './helpers/attestationFixtures';
import { testBundleState } from './helpers/gatedRuns';

const CERTS = path.resolve(__dirname, '../../test/fixtures/cyber/certs/patched');
const CA = readFileSync(path.join(CERTS, 'ca.pem'));
const SERVER_CERT = readFileSync(path.join(CERTS, 'server.pem'));
const SERVER_KEY = readFileSync(path.join(CERTS, 'server.key'));
/** The fixture server certificate's public-key fingerprint, the kind NEAR AI Cloud's gateway binds. */
const SERVER_PRINT = createHash('sha256').update(new X509Certificate(SERVER_CERT).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const OTHER_PRINT = 'ab'.repeat(32);
const SIGNER = '0x1563915e194d8cfba1943570603f7606a3115508';
const TRUST = { trustedRoot: TEST_ROOT };
const HEX64 = /[0-9a-f]{64}/gi;

/** A local TLS server on 127.0.0.1 with the fixture certificate; counts the requests it receives. */
async function fixtureServer(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void = (_request, response) => { response.end('ok'); }): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = https.createServer({ cert: SERVER_CERT, key: SERVER_KEY }, (request, response) => { count += 1; handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `https://127.0.0.1:${String(port)}`,
    requests: () => count,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

/** A report whose gateway attestation names `print`, with a test quote whose report_data binds `bindPrint` (or the padded address) and `nonce`. */
function report(nonce: string, options: { print?: string | null; bindPrint?: string | null; quoteNonce?: string; forged?: boolean } = {}): Record<string, unknown> {
  const print = options.print === undefined ? SERVER_PRINT : options.print;
  const bindPrint = options.bindPrint === undefined ? print : options.bindPrint;
  const address = Buffer.from(SIGNER.slice(2), 'hex');
  const reportData = Buffer.alloc(64);
  if (bindPrint === null) address.copy(reportData, 0);
  else createHash('sha256').update(address).update(Buffer.from(bindPrint, 'hex')).digest().copy(reportData, 0);
  Buffer.from(options.quoteNonce ?? nonce, 'hex').copy(reportData, 32);
  let quote = testQuote(reportData);
  if (options.forged === true) { const bytes = Buffer.from(quote, 'hex'); bytes[600] ^= 1; quote = bytes.toString('hex'); }
  const gateway: Record<string, unknown> = { signing_address: SIGNER, signing_algo: 'ecdsa', intel_quote: quote };
  if (print !== null) gateway.tls_cert_fingerprint = print;
  return { gateway_attestation: gateway, model_attestations: [] };
}

/** A fake authenticated GET answering the report path with `answer(nonce)`; records the paths asked for. */
function fakeGet(answer: (nonce: string) => unknown): { get: (path: string) => Promise<unknown>; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    get: async (requestPath: string) => {
      paths.push(requestPath);
      const nonce = new URL(requestPath, 'https://example.invalid').searchParams.get('nonce') ?? '';
      return answer(nonce);
    }
  };
}

function source(get: (path: string) => Promise<unknown>, timeoutMs?: number): NearConnectionBinding {
  return new NearConnectionBinding({ get, teeModel: () => 'tee-model', tls: { ca: CA }, trust: { trustedRoot: TEST_ROOT }, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

test('the research named the gateway attestation and its public-key fingerprint, and attestedTlsFingerprint proves it with the shared report_data check', () => {
  assert.equal(NEAR_TLS_FINGERPRINT_KIND, 'public-key-sha256');
  const nonce = 'cd'.repeat(32);
  const proved = attestedTlsFingerprint(report(nonce), nonce, TRUST);
  assert.deepEqual(proved, { state: 'bound-in-quote', fingerprint: SERVER_PRINT, signingAddress: SIGNER, role: 'gateway' });
  assert.deepEqual(attestedTlsFingerprint(report(nonce, { print: null }), nonce, TRUST), { state: 'absent' });
  assert.equal(attestedTlsFingerprint(report(nonce), nonce).state, 'invalid', 'a quote not rooted at Intel never proves a binding');
  assert.equal(attestedTlsFingerprint({ model_attestations: [report(nonce).gateway_attestation] }, nonce, TRUST).state, 'absent', 'only the gateway attestation names the endpoint\'s key');
});

test('a report binding the fixture server\'s key, with this check\'s nonce, and a TLS probe that sees the same key give bound', async () => {
  const server = await fixtureServer();
  try {
    const fake = fakeGet((nonce) => report(nonce));
    const binding = source(fake.get);
    const before = Date.now();
    const fact = await binding.refresh(`${server.url}/v1`);
    assert.equal(fact.state, 'bound', fact.detail);
    assert.equal(fact.fingerprint, SERVER_PRINT);
    assert.ok(typeof fact.checkedAt === 'number' && fact.checkedAt >= before);
    assert.deepEqual(binding.current(`${server.url}/v1`), fact, 'the fact is kept in memory for the decision');
    assert.equal(fake.paths.length, 1);
    assert.match(fake.paths[0]!, /^\/attestation\/report\?model=tee-model&nonce=[0-9a-f]{64}&signing_algo=ecdsa&include_tls_fingerprint=true$/);
    assert.equal(server.requests(), 0, 'the probe reads the certificate and sends nothing');
  } finally { await server.close(); }
});

test('a different fingerprint, a forged quote, a wrong nonce or report_data without the fingerprint give not-bound; no fingerprint gives unavailable', async () => {
  const server = await fixtureServer();
  try {
    const cases: Array<[string, (nonce: string) => unknown]> = [
      ['another key', (nonce) => report(nonce, { print: OTHER_PRINT })],
      ['forged quote', (nonce) => report(nonce, { forged: true })],
      ['wrong nonce', (nonce) => report(nonce, { quoteNonce: '00'.repeat(32) })],
      ['fingerprint not in the hash', (nonce) => report(nonce, { bindPrint: null })],
      ['fingerprint of another key in the hash', (nonce) => report(nonce, { bindPrint: OTHER_PRINT })]
    ];
    for (const [name, answer] of cases) {
      const fact = await source(fakeGet(answer).get).refresh(`${server.url}/v1`);
      assert.equal(fact.state, 'not-bound', name);
      assert.equal(fact.fingerprint, undefined, name);
    }
    const absent = await source(fakeGet((nonce) => report(nonce, { print: null })).get).refresh(`${server.url}/v1`);
    assert.equal(absent.state, 'unavailable');
  } finally { await server.close(); }
});

test('a report GET that throws, a TLS server that never answers, or no private model listed give unknown', async () => {
  const failing = await source(async () => { throw new Error('offline'); }).refresh('https://127.0.0.1:9/v1');
  assert.equal(failing.state, 'unknown');
  assert.match(failing.detail ?? '', /offline/);
  // Accepts the TCP connection and never says anything: the TLS handshake never finishes.
  const sockets: net.Socket[] = [];
  const silent = net.createServer((socket) => { sockets.push(socket); });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    const port = (silent.address() as net.AddressInfo).port;
    const started = Date.now();
    const hung = await source(fakeGet((nonce) => report(nonce)).get, 50).refresh(`https://127.0.0.1:${String(port)}/v1`);
    assert.equal(hung.state, 'unknown');
    assert.match(hung.detail ?? '', /did not finish within 50 ms/);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
  const noModel = new NearConnectionBinding({ get: async () => { throw new Error('never asked'); }, teeModel: () => undefined });
  assert.equal((await noModel.refresh('https://cloud-api.near.ai/v1')).state, 'unknown');
  assert.equal(noModel.current('https://cloud-api.near.ai/v1'), undefined, 'nothing was checked, so nothing is kept and the next route check asks again');
});

test('pinnedFetch to the fixture key gets the answer with its status, headers and streamed body; to another key it rejects and the server sees nothing', async () => {
  const server = await fixtureServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      response.writeHead(201, { 'x-test': 'yes', 'content-type': 'text/plain' });
      response.write(`${request.method ?? ''} ${request.url ?? ''} `);
      setTimeout(() => response.end(`${body} ${String(request.headers.authorization)}`), 10);
    });
  });
  try {
    const pinned = pinnedFetch(SERVER_PRINT, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } });
    const answer = await pinned(`${server.url}/v1/chat/completions?x=1`, { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' }, body: '{"a":1}' });
    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('x-test'), 'yes');
    assert.equal(await answer.text(), 'POST /v1/chat/completions?x=1 {"a":1} Bearer test-key');
    assert.equal(server.requests(), 1);
    const wrong = pinnedFetch(OTHER_PRINT, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } });
    await assert.rejects(() => wrong(`${server.url}/v1/chat/completions`, { method: 'POST', body: 'secret content' }), ConnectionNotBoundError);
    assert.equal(server.requests(), 1, 'the server received zero requests over the mismatched connection');
    // The normal certificate checks still run first: a server the CA does not vouch for is refused even when the pin would match.
    const untrusted = pinnedFetch(SERVER_PRINT, NEAR_TLS_FINGERPRINT_KIND);
    await assert.rejects(() => untrusted(`${server.url}/v1/models`));
    assert.equal(server.requests(), 1);
    await assert.rejects(() => pinned('http://127.0.0.1:9/v1/models'), ConnectionNotBoundError, 'only https is sent');
  } finally { await server.close(); }
});

test('an aborted signal ends a pinned request', async () => {
  const server = await fixtureServer(() => { /* never answers */ });
  try {
    const pinned = pinnedFetch(SERVER_PRINT, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } });
    const controller = new AbortController();
    const sent = pinned(`${server.url}/v1/models`, { signal: controller.signal });
    while (server.requests() === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(() => sent, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    const already = new AbortController();
    already.abort();
    await assert.rejects(() => pinned(`${server.url}/v1/models`, { signal: already.signal }), (error: unknown) => error instanceof Error && error.name === 'AbortError');
  } finally { await server.close(); }
});

test('encoding: fingerprints compare without colons and case, and one of another length or with a non-hex character never matches', async () => {
  const upper = SERVER_PRINT.toUpperCase().match(/.{2}/g)!.join(':');
  assert.equal(normaliseFingerprint(upper), SERVER_PRINT);
  assert.equal(normaliseFingerprint(SERVER_PRINT), SERVER_PRINT);
  assert.equal(normaliseFingerprint(SERVER_PRINT.slice(2)), undefined, 'shorter');
  assert.equal(normaliseFingerprint(`${SERVER_PRINT}00`), undefined, 'longer');
  assert.equal(normaliseFingerprint(`${SERVER_PRINT.slice(1)}g`), undefined, 'not hex');
  assert.equal(normaliseFingerprint(undefined), undefined);
  const server = await fixtureServer();
  try {
    assert.equal((await pinnedFetch(upper, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } })(`${server.url}/x`)).status, 200, 'an upper-case, colon form matches');
    await assert.rejects(() => pinnedFetch(`${SERVER_PRINT.slice(1)}g`, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } })(`${server.url}/x`), ConnectionNotBoundError);
    assert.equal(server.requests(), 1);
  } finally { await server.close(); }
});

// ---- Through the client ----

const NEAR = 'https://cloud-api.near.ai/v1';
const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'binding', agentId: 'main', agentLabel: 'agent' };
const label = (scale: string, level: string): Label => ({ scale, level, compartments: [], releasability: [], handling: [] });

const STATE = testBundleState();

function routeAt(mark: Mark, records: DecisionRecord[] = []): SessionRoute {
  const state = STATE;
  return { markOf: () => mark, bundleState: () => state, actor: ACTOR, sink: { record: (record) => { records.push(record); } }, attestation: { failed: false } };
}

/** A binding source with a fact set by hand, whose pinned fetch is a counting fake; refresh never settles unless told to. */
class HandSource implements ConnectionBindingSource {
  public refreshes = 0;
  public pinnedCalls: string[] = [];
  public marked: string[] = [];
  public constructor(public fact: ConnectionBindingFact | undefined, private readonly pinned: (url: string) => Promise<Response>) {}
  public current(): ConnectionBindingFact | undefined { return this.fact; }
  public refresh(): Promise<ConnectionBindingFact> { this.refreshes += 1; return new Promise(() => undefined); }
  public markNotBound(host: string, detail: string): void { this.marked.push(detail); this.fact = { state: 'not-bound', host, checkedAt: Date.now() }; }
  public fetchFor(): typeof fetch { return (async (input: string | URL | Request) => { this.pinnedCalls.push(String(input)); return this.pinned(String(input)); }) as typeof fetch; }
}

function completion(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
}

async function nearWith(binding: ConnectionBindingSource, load = true): Promise<{ client: NearAiClient; content: string[] }> {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'tee-model' }] }), { status: 200 });
    if ((init?.method ?? 'GET') === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: [{ modelId: 'tee-model', metadata: { attestationSupported: true, providerType: 'vllm' } }] }), { status: 200 });
    content.push(url);
    return completion();
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near', binding, maxRetries: 0 });
  if (load) await client.listModels();
  return { client, content };
}

const ask = (client: NearAiClient) => client.completeOnce('tee-model', [{ role: 'user', content: 'hello' }], { maxTokens: 32 });

// The owner's decision of 2026-11-18 (PR #95): a Public request to NEAR AI Cloud also goes over the pinned connection while a fresh proof exists. Before it,
// this test asserted that Public went over the normal fetch; it now asserts the pinned one, and the tests below cover the fallback.
test('with a bound fact a Confidential request and a Public one both go over the pinned connection, and the record holds no fingerprint', async () => {
  const fingerprint = SERVER_PRINT;
  const binding = new HandSource({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint }, async () => completion());
  const near = await nearWith(binding);
  const records: DecisionRecord[] = [];
  assert.equal((await withSessionRoute(routeAt([label('org', 'Confidential')], records), () => ask(near.client))).text, 'ok');
  assert.equal(binding.pinnedCalls.length, 1);
  assert.equal(near.content.length, 0, 'the normal fetch was not used for the attested request');
  assert.equal((await withSessionRoute(routeAt([label('org', 'Public')]), () => ask(near.client))).text, 'ok');
  assert.equal(near.content.length, 0, 'any-cloud with a fresh proof is pinned too');
  assert.equal(binding.pinnedCalls.length, 2);
  const record = records.find((entry) => entry.authorizations[0]?.policy.name === 'route.attested-cloud');
  assert.ok(record !== undefined);
  assert.ok(validateDecisionRecord(JSON.parse(JSON.stringify(record))).ok, 'the record of a bound request validates');
  const text = JSON.stringify(record);
  assert.ok(!text.includes(fingerprint), 'no fingerprint in the record');
  assert.ok(!text.includes('cloud-api.near.ai'), 'no host in the record');
  const bundleHash = (STATE as { hash?: string }).hash ?? '';
  for (const found of text.match(HEX64) ?? []) assert.equal(found, bundleHash, 'the only 64-hex value is the policy hash');
  assert.match(text, /"connection":"bound"/);
});

test('a pinned connection that refuses marks the host not-bound, fails with route.connection-not-bound, and the next Confidential request is refused before fetch', async () => {
  const binding = new HandSource({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: SERVER_PRINT }, async () => { throw new ConnectionNotBoundError(); });
  const near = await nearWith(binding);
  const records: DecisionRecord[] = [];
  const route = routeAt([label('org', 'Confidential')], records);
  await assert.rejects(() => withSessionRoute(route, () => ask(near.client)), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.connection-not-bound' && error.message.startsWith(BINDING_REFUSALS['not-bound']));
  assert.equal(binding.marked.length, 1);
  assert.equal(binding.fact?.state, 'not-bound');
  assert.ok(records.some((entry) => entry.authorizations[0]?.policy.name === 'route.connection-not-bound'), 'the refusal is recorded');
  await assert.rejects(() => withSessionRoute(route, () => ask(near.client)), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && error.message.startsWith(BINDING_REFUSALS['not-bound']));
  assert.equal(binding.pinnedCalls.length, 1, 'the second request never reached a connection');
  assert.equal(near.content.length, 0);
});

test('a source that gives no pinned fetch cannot carry an attested request: refused, never sent unpinned', async () => {
  const fact: ConnectionBindingFact = { state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: SERVER_PRINT };
  const bare: ConnectionBindingSource = { current: () => fact, refresh: async () => fact, markNotBound: () => undefined };
  const near = await nearWith(bare);
  await assert.rejects(() => withSessionRoute(routeAt([label('org', 'Confidential')]), () => ask(near.client)), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.connection-not-bound');
  assert.equal(near.content.length, 0);
});

test('concurrency: ten parallel route checks for one host with no fact start exactly one refresh, and none waits for it', async () => {
  const binding = new HandSource(undefined, async () => completion());
  // The catalog is not loaded yet, so loading it does not start the refresh first.
  const near = await nearWith(binding, false);
  const route = routeAt([label('org', 'Public')]);
  const answers = await Promise.all(Array.from({ length: 10 }, () => withSessionRoute(route, () => ask(near.client))));
  assert.equal(answers.length, 10);
  assert.equal(near.content.length, 10, 'every request was sent without waiting');
  assert.equal(binding.refreshes, 1, 'one refresh in flight for the host');
  // The refresh never settles: loading the catalog starts no second one, and a Confidential request is refused at once rather than waiting for it.
  await near.client.listModels();
  await assert.rejects(() => withSessionRoute(routeAt([label('org', 'Confidential')]), () => ask(near.client)), (error: unknown) => error instanceof RouteRefusedError && error.message.startsWith(BINDING_REFUSALS.unknown));
  assert.equal(binding.refreshes, 1);
});

test('a refresh that throws at once never reaches the request', async () => {
  const throwing: ConnectionBindingSource = { current: () => undefined, refresh: () => { throw new Error('broken source'); }, markNotBound: () => undefined };
  const near = await nearWith(throwing);
  assert.equal((await withSessionRoute(routeAt([label('org', 'Public')]), () => ask(near.client))).text, 'ok');
});

test('the provider factory gives the NEAR AI Cloud client a binding source and starts one refresh; a client on another endpoint gets none', async () => {
  const { createNearAiProvider } = await import('../services/providerFactory');
  const { AuthService } = await import('../services/auth');
  const { createProjectCredentialScope } = await import('../domain/auth');
  const values = new Map<string, string>();
  const auth = new AuthService({ get: async (key) => values.get(key), store: async (key, value) => { values.set(key, value); }, delete: async (key) => { values.delete(key); } });
  const original = NearConnectionBinding.prototype.refresh;
  let refreshes = 0;
  NearConnectionBinding.prototype.refresh = function (this: NearConnectionBinding, host: string) { refreshes += 1; return original.call(this, host); };
  try {
    const fetchFn = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    const profile = (baseUrl: string) => ({ version: 1 as const, profileId: 'profile-company', displayName: 'Company', organization: 'Example Company', provider: 'near-ai' as const, baseUrl, authMode: 'apiKey' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'valid' as const, validatedAt: '2026-01-01T00:00:00Z' } });
    const nearScope = createProjectCredentialScope('/workspace/a', 'profile-company');
    await auth.saveScopedApiKey(nearScope, 'test-key', 'https://cloud-api.near.ai/v1');
    const near = await createNearAiProvider({ auth, profile: profile('https://cloud-api.near.ai/v1'), scope: nearScope, fetchFn });
    assert.ok(near.client.connectionBinding instanceof NearConnectionBinding);
    assert.equal(refreshes, 1, 'one refresh started at creation');
    const otherScope = createProjectCredentialScope('/workspace/b', 'profile-company');
    await auth.saveScopedApiKey(otherScope, 'test-key', 'https://example.test/v1');
    const other = await createNearAiProvider({ auth, profile: profile('https://example.test/v1'), scope: otherScope, fetchFn });
    assert.equal(other.client.connectionBinding, undefined);
    assert.equal(refreshes, 1);
  } finally {
    NearConnectionBinding.prototype.refresh = original;
  }
});

// PR #89 review: the pin must hold even when a layer replaces the agent and drops the request's TLS options, as VS Code's proxy support may.
test('when a layer replaces the agent and ignores the request\'s TLS options, the live socket is checked and a different server gets nothing', async () => {
  const pinnedServer = await fixtureServer();
  const otherCert = readFileSync(path.resolve(__dirname, '../../test/fixtures/cyber/certs/vulnerable/server.pem'));
  const otherKey = readFileSync(path.resolve(__dirname, '../../test/fixtures/cyber/certs/vulnerable/server.key'));
  let otherRequests = 0;
  const other = https.createServer({ cert: otherCert, key: otherKey }, (_request, response) => { otherRequests += 1; response.end('other'); });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = (other.address() as net.AddressInfo).port;
  const otherPrint = createHash('sha256').update(new X509Certificate(otherCert).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  assert.notEqual(otherPrint, SERVER_PRINT, 'the two servers present different keys');
  // Stands in for a proxy layer that patches https.request: it swaps the agent for one with no checks and drops checkServerIdentity and ca.
  const httpsModule = require('node:https') as { request: typeof https.request };
  const original = httpsModule.request;
  const rerouteTo = (port: number | undefined) => ((options: https.RequestOptions, callback?: (response: import('node:http').IncomingMessage) => void) => {
    const { checkServerIdentity: _check, ca: _ca, agent: _agent, ...rest } = options;
    return original({ ...rest, ...(port === undefined ? {} : { port }), rejectUnauthorized: false, agent: new https.Agent({ rejectUnauthorized: false }) }, callback);
  }) as typeof https.request;
  try {
    httpsModule.request = rerouteTo(otherPort);
    const pinned = pinnedFetch(SERVER_PRINT, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } });
    await assert.rejects(() => pinned(`${pinnedServer.url}/v1/chat/completions`, { method: 'POST', body: 'labelled content' }), ConnectionNotBoundError);
    assert.equal(otherRequests, 0, 'the other server received no request, not even its headers');
    // The same layer reaching the pinned server itself: the live socket matches and the request goes through.
    httpsModule.request = rerouteTo(undefined);
    const answer = await pinnedFetch(SERVER_PRINT, NEAR_TLS_FINGERPRINT_KIND, { tls: { ca: CA } })(`${pinnedServer.url}/v1/models`);
    assert.equal(answer.status, 200);
    assert.equal(await answer.text(), 'ok');
  } finally {
    httpsModule.request = original;
    other.closeAllConnections();
    await new Promise<void>((resolve) => other.close(() => resolve()));
    await pinnedServer.close();
  }
});

// ---- The owner's decision of 2026-11-18 (PR #95): Public requests over the pinned connection, with an unpinned fallback on a mismatch ----

const PUBLIC_MARK: Mark = [label('org', 'Public')];
const inferRecords = (records: DecisionRecord[]) => records.filter((entry) => (entry.unmapped.nearAi.capability as { verb?: string }).verb === 'infer');
async function badgeFor(near: NearAiClient, usage: import('../services/nearAiClient').UsageMetadata) {
  const { answerFactsOf } = await import('../services/agentSession');
  const { trustBadgeFor } = await import('../domain/gate/trustBadge');
  const facts = answerFactsOf({ client: near, model: 'tee-model', privacy: 'Private · runs in NEAR TEE', modelCatalog: undefined }, { ...usage, evidence: { chatId: 'c', requestHash: 'a', responseHash: 'b' } });
  return trustBadgeFor({ ...facts, verification: 'signed', earlierCheckFailed: false })!;
}

test('a Public request with a fresh proof goes over the pinned connection, is recorded as before, and its signed answer can show Verified private model', async () => {
  const binding = new HandSource({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: SERVER_PRINT }, async () => completion());
  const near = await nearWith(binding);
  const records: DecisionRecord[] = [];
  const answer = await withSessionRoute(routeAt(PUBLIC_MARK, records), () => ask(near.client));
  assert.equal(binding.pinnedCalls.length, 1, 'pinned');
  assert.equal(near.content.length, 0, 'the normal fetch was not used');
  assert.equal(answer.usage.connectionPinned, true);
  const infer = inferRecords(records);
  assert.equal(infer.length, 1, 'one record for the request');
  assert.equal(infer[0]!.unmapped.nearAi.connectionFallback, undefined);
  assert.ok(validateDecisionRecord(JSON.parse(JSON.stringify(infer[0]))).ok);
  assert.equal((await badgeFor(near.client, answer.usage)).state, 'verified-private');
});

test('a Public request whose pinned connection meets another key is sent unpinned instead, recorded as a fallback naming no content, and its badge is Model verified, connection not proven', async () => {
  const binding = new HandSource({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: SERVER_PRINT }, async () => { throw new ConnectionNotBoundError(); });
  const near = await nearWith(binding);
  const records: DecisionRecord[] = [];
  const answer = await withSessionRoute(routeAt(PUBLIC_MARK, records), () => ask(near.client));
  assert.equal(answer.text, 'ok', 'sent, not refused');
  assert.equal(binding.pinnedCalls.length, 1, 'the pinned connection was tried first and refused before writing');
  assert.equal(near.content.length, 1, 'then the same request went over the normal fetch, once');
  assert.equal(binding.marked.length, 1, 'the host is no longer bound');
  assert.equal(answer.usage.connectionPinned, undefined);
  assert.equal(answer.usage.connection?.state, 'not-bound');
  const infer = inferRecords(records);
  assert.equal(infer.length, 1, 'one record for the request');
  assert.equal(infer[0]!.unmapped.nearAi.connectionFallback, 'unpinned');
  assert.equal(infer[0]!.authorizations[0]?.policy.name, 'route.any-cloud');
  assert.ok(validateDecisionRecord(JSON.parse(JSON.stringify(infer[0]))).ok);
  const text = JSON.stringify(infer[0]);
  assert.ok(!text.includes(SERVER_PRINT) && !text.includes('cloud-api.near.ai') && !text.includes('hello'), 'no fingerprint, host or content');
  const badge = await badgeFor(near.client, answer.usage);
  assert.equal(badge.state, 'model-verified');
  assert.ok(badge.reasons.some((reason) => reason.includes('did not match')), JSON.stringify(badge.reasons));
  // The next Public request has no fresh proof (the host is not bound): sent as before, unpinned, with no fallback to record.
  await withSessionRoute(routeAt(PUBLIC_MARK, records), () => ask(near.client));
  assert.equal(binding.pinnedCalls.length, 1);
  assert.equal(near.content.length, 2);
  assert.equal(inferRecords(records)[1]!.unmapped.nearAi.connectionFallback, undefined);
});

test('at Confidential a mismatch on the pinned connection still refuses: nothing goes over the normal fetch and nothing falls back', async () => {
  const binding = new HandSource({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: SERVER_PRINT }, async () => { throw new ConnectionNotBoundError(); });
  const near = await nearWith(binding);
  const records: DecisionRecord[] = [];
  await assert.rejects(() => withSessionRoute(routeAt([label('org', 'Confidential')], records), () => ask(near.client)), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.connection-not-bound');
  assert.equal(near.content.length, 0, 'never sent unpinned');
  assert.ok(!records.some((entry) => entry.unmapped.nearAi.connectionFallback !== undefined));
});

test('with no fresh proof a Public request is sent as today: the normal fetch, no pin, a record written before sending, no fallback field', async () => {
  for (const fact of [undefined, { state: 'unknown' as const, host: NEAR }, { state: 'not-bound' as const, host: NEAR, checkedAt: Date.now() }, { state: 'bound' as const, host: NEAR, checkedAt: Date.now() - 11 * 60_000, fingerprint: SERVER_PRINT }, { state: 'bound' as const, host: 'https://other.example/v1', checkedAt: Date.now(), fingerprint: SERVER_PRINT }]) {
    const binding = new HandSource(fact, async () => completion());
    const near = await nearWith(binding);
    const records: DecisionRecord[] = [];
    let recordedBeforeSend = false;
    const route = routeAt(PUBLIC_MARK, records);
    await withSessionRoute(route, async () => { const sent = ask(near.client); recordedBeforeSend = inferRecords(records).length === 1; await sent; });
    assert.equal(binding.pinnedCalls.length, 0, JSON.stringify(fact));
    assert.equal(near.content.length, 1, JSON.stringify(fact));
    assert.ok(recordedBeforeSend, 'recorded at the decision, as before');
    assert.equal(inferRecords(records)[0]!.unmapped.nearAi.connectionFallback, undefined);
  }
});
