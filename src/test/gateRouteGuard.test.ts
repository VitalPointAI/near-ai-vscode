// The route check at the client's one choke point (CLAS-06, CLAS-05 as the owner amplified it, D-31, D-50): every content request is decided in
// NearAiClient.request, from the session route it runs inside and local facts only, before anything is sent. Every fetch here is a counting stub; nothing
// reaches the network and no key is read.
import assert from 'node:assert/strict';
// `import x = require()` hands back the real module object, which the OFFL-01 stubs can replace; an `import * as` namespace is a read-only copy.
import dns = require('node:dns');
import http = require('node:http');
import https = require('node:https');
import net = require('node:net');
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { runAgentInFolder } from '../benchmark/runner';
import { createProjectCredentialScope } from '../domain/auth';
import type { OrganizationProfile } from '../domain/auth';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { BINDING_REFUSALS } from '../domain/gate/routing';
import type { ActorRef, DecisionSink } from '../domain/gate/decide';
import { validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import type { Capability } from '../domain/gate/vocabulary';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { DECISIONS_DIR, DecisionLog, projectLogKey } from '../gate/decisionLog';
import { GateHost, NO_SESSION_ID } from '../gate/host';
import { currentSessionRoute, defaultSessionRoute, recordedModelName, setDefaultSessionRoute, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, NearAiError, RouteRefusedError } from '../services/nearAiClient';
import type { SpendSink } from '../services/spendAccount';
import type { AgentMessage, CompletionEvent, NearAiClientOptions } from '../services/nearAiClient';
import type { AgentTurnRequest, GsdContext } from '../services/agentSession';
import { TranscriptStore } from '../services/transcripts';
import { AuthService } from '../services/auth';
import { createNearAiProvider } from '../services/providerFactory';
import { newTestConversation, testBundleState, testGateRuntime } from './helpers/gatedRuns';
import { MemorySecrets } from './helpers/teamHarness';

const NEAR = 'https://cloud-api.near.ai/v1';
const LOCAL = 'http://127.0.0.1:11434/v1';

function org(level: string): Label {
  return { scale: 'org', level, compartments: [], releasability: [], handling: [] };
}

/** A fake fetch that serves a catalog and answers every content request, counting the content requests it was given. */
function fakeFetch(catalog: { tee?: string[]; cloud?: string[]; local?: string[] }): { fetchFn: typeof fetch; content: string[] } {
  const content: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) {
      const ids = [...(catalog.tee ?? []), ...(catalog.cloud ?? []), ...(catalog.local ?? [])];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    if (method === 'GET' && url.endsWith('/model/list')) {
      const models = [
        ...(catalog.tee ?? []).map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })),
        ...(catalog.cloud ?? []).map((modelId) => ({ modelId, metadata: { providerType: 'external', providerConfig: { base_url: 'https://api.example.org/v1' } } }))
      ];
      return new Response(JSON.stringify({ models }), { status: 200 });
    }
    content.push(`${method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, content };
}

const ACTOR: ActorRef = { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'session-test', agentId: 'main-1', agentLabel: 'agent' };

function routeAt(mark: Mark, extra: Partial<SessionRoute> = {}): SessionRoute {
  const state = testBundleState();
  return { markOf: () => mark, bundleState: () => state, actor: ACTOR, attestation: { failed: false }, ...extra };
}

async function nearClient(options: Partial<NearAiClientOptions> = {}, catalog: { tee?: string[]; cloud?: string[] } = { tee: ['tee-model'], cloud: ['cloud-model'] }): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch(catalog);
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn: fake.fetchFn, route: 'near', ...options });
  await client.listModels();
  return { client, content: fake.content };
}

async function localClient(options: Partial<NearAiClientOptions> = {}): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ local: ['local-model'] });
  const client = new NearAiClient({ baseUrl: LOCAL, apiKey: '', fetchFn: fake.fetchFn, route: 'local', ...options });
  await client.listLocalModels();
  return { client, content: fake.content };
}

const ask = (client: NearAiClient, model: string) => client.completeOnce(model, [{ role: 'user', content: 'hello' }], { maxTokens: 32 });

test('tracer: a session route reaches the client\'s one choke point, and a request its tier refuses throws before fetch', async () => {
  // local-only with no local model: refused, nothing sent.
  const restricted = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Restricted')]), () => ask(restricted.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && /^Nothing was sent\./.test(error.message)
  );
  assert.equal(restricted.content.length, 0, 'the fake fetch was never given the content request');

  // attested-cloud with a catalog TEE model on NEAR AI Cloud's own endpoint, but no binding source (D-50): refused, the cause first.
  const confidential = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Confidential')]), () => ask(confidential.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model' && error.message.startsWith(BINDING_REFUSALS.unknown)
  );
  assert.equal(confidential.content.length, 0);

  // A local client on a loopback host serving a catalog local model sends Restricted content.
  const local = await localClient();
  const answer = await withSessionRoute(routeAt([org('Restricted')]), () => ask(local.client, 'local-model'));
  assert.equal(answer.text, 'ok');
  assert.deepEqual(local.content, ['POST /v1/chat/completions']);

  // The default mark (empty: the policy's default label, org Public) sends through the NEAR client, as today.
  const open = await nearClient();
  assert.equal((await withSessionRoute(routeAt([]), () => ask(open.client, 'cloud-model'))).text, 'ok');
  assert.equal(open.content.length, 1);
});

test('the provider factory says each client\'s route: a local profile and a hybrid profile\'s local client are local, a hybrid NEAR client knows a local model is there', async () => {
  const secrets = new MemorySecrets();
  const auth = new AuthService(secrets);
  const scope = createProjectCredentialScope('/workspace/project-a', 'profile-hybrid');
  await auth.saveScopedApiKey(scope, 'cloud-secret', NEAR);
  const base: OrganizationProfile = {
    version: 1, profileId: 'profile-hybrid', displayName: 'hybrid', organization: 'Example Company', provider: 'hybrid', baseUrl: NEAR, localBaseUrl: LOCAL, authMode: 'apiKey',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', validation: { status: 'valid', validatedAt: '2026-01-01T00:00:00Z' }
  };
  const fake = fakeFetch({ tee: ['tee-model'], local: ['local-model'] });
  const hybrid = await createNearAiProvider({ auth, profile: base, scope, fetchFn: fake.fetchFn });
  assert.ok(hybrid.localClient);
  await hybrid.client.listModels();
  await hybrid.localClient.listLocalModels();
  // Internal is attested-cloud: with a local model there, the NEAR client's refusal names the connection, and the local client sends.
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Internal')]), () => ask(hybrid.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.connection-not-bound'
  );
  assert.equal((await withSessionRoute(routeAt([org('Internal')]), () => ask(hybrid.localClient!, 'local-model'))).text, 'ok');

  const localScope = createProjectCredentialScope('/workspace/project-a', 'profile-local');
  const local = await createNearAiProvider({ auth, profile: { ...base, profileId: 'profile-local', provider: 'local', baseUrl: LOCAL }, scope: localScope, fetchFn: fake.fetchFn });
  await local.client.listLocalModels();
  assert.equal((await withSessionRoute(routeAt([org('Restricted')]), () => ask(local.client, 'local-model'))).text, 'ok');

  const cloudScope = createProjectCredentialScope('/workspace/project-a', 'profile-cloud');
  await auth.saveScopedApiKey(cloudScope, 'cloud-secret', NEAR);
  const cloud = await createNearAiProvider({ auth, profile: { ...base, profileId: 'profile-cloud', provider: 'near-ai' }, scope: cloudScope, fetchFn: fake.fetchFn });
  await cloud.client.listModels();
  await assert.rejects(
    () => withSessionRoute(routeAt([org('Internal')]), () => ask(cloud.client, 'tee-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model'
  );
  assert.deepEqual(fake.content, ['POST /v1/chat/completions', 'POST /v1/chat/completions'], 'only the two local requests were sent');
});

// ---- Task 2: every production request site runs inside a session route, and three scans keep it that way ----

const REPO = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO, 'src');

/** Every production source, keyed by its repository path (src/...), with whole-line and trailing comments removed. */
function productionSources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (full !== path.join(SRC, 'test')) walk(full); continue; }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.set(path.relative(REPO, full).split(path.sep).join('/'), withoutComments(readFileSync(full, 'utf8')));
    }
  };
  walk(SRC);
  return found;
}

function withoutComments(text: string): string {
  return text.split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).map((line) => line.replace(/\s\/\/\s.*$/, '')).join('\n');
}

/** The client methods that send content to a model. Every other client method sends none (lists, billing, key checks, verification GETs). */
const REQUEST_METHODS = ['streamCompletion', 'completeOnce', 'generateImage', 'editImage', 'describeImage', 'transcribeAudio', 'streamChat', 'streamChatEvents'];
const REQUEST_CALL = new RegExp(String.raw`\.\s*(?:${REQUEST_METHODS.join('|')})\s*\(`);
const CLIENT_FILE = 'src/services/nearAiClient.ts';

/**
 * The files that call a model request method, and how each runs inside a session route: it wraps its own calls (`self`), it runs only inside a caller that
 * does (`inside`: each caller imports it and contains withSessionRoute), or nothing in the extension reaches it (`dormant`, checked by the import scan).
 */
type Placement = { readonly self: true } | { readonly inside: readonly string[] } | { readonly dormant: true };
const REQUEST_SITES: Readonly<Record<string, Placement>> = {
  'src/agent/attachments.ts': { inside: ['src/services/chat.ts'] },
  'src/agent/context.ts': { inside: ['src/services/agentSession.ts'] },
  'src/agent/extraTools.ts': { inside: ['src/services/agentSession.ts'] },
  'src/agent/loop.ts': { inside: ['src/services/agentSession.ts', 'src/benchmark/runner.ts'] },
  'src/agent/safetyModel.ts': { inside: ['src/services/agentSession.ts'] },
  'src/services/chatParticipant.ts': { self: true },
  'src/services/cyberAssembly.ts': { self: true },
  'src/services/cyberHandoff.ts': { self: true },
  'src/services/teamStudioPanel.ts': { self: true },
  'src/services/generationService.ts': { dormant: true }
};

const WRAPS = /\bwithSessionRoute\(/;

function importsModule(source: string, from: string, target: string): boolean {
  const relative = path.posix.relative(path.posix.dirname(from), target).replace(/\.ts$/, '');
  const spec = relative.startsWith('.') ? relative : `./${relative}`;
  return new RegExp(String.raw`from\s+'${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(source);
}

/** What breaks the rule that every model request runs inside a session route. Empty when it holds. */
function siteViolations(sources: ReadonlyMap<string, string>, sites: Readonly<Record<string, Placement>>): string[] {
  const out: string[] = [];
  for (const [file, text] of sources) {
    if (file === CLIENT_FILE || !REQUEST_CALL.test(text)) continue;
    if (!Object.prototype.hasOwnProperty.call(sites, file)) out.push(`${file} calls a model request method and is not on the list of request sites`);
  }
  for (const [file, placement] of Object.entries(sites)) {
    const text = sources.get(file);
    if (text === undefined || !REQUEST_CALL.test(text)) { out.push(`${file} is listed but makes no model request (remove it)`); continue; }
    if ('self' in placement && !WRAPS.test(text)) out.push(`${file} makes model requests and never calls withSessionRoute`);
    if ('inside' in placement) {
      for (const caller of placement.inside) {
        const callerText = sources.get(caller) ?? '';
        if (!WRAPS.test(callerText)) out.push(`${file} runs inside ${caller}, which never calls withSessionRoute`);
        if (!importsModule(callerText, caller, file)) out.push(`${caller} does not import ${file}`);
      }
    }
  }
  return out;
}

test('CLAS-06: every file that makes a model request runs it inside a session route, and a planted violation is reported', () => {
  const sources = productionSources();
  assert.ok(sources.size > 200, 'the scan read all of src');
  assert.deepEqual(siteViolations(sources, REQUEST_SITES), []);
  // Planted: a new file that calls the client, a listed self site that stops wrapping, and a caller that stops wrapping.
  const planted = new Map(sources);
  planted.set('src/services/newFeature.ts', "export async function go(client) { return client.completeOnce('m', [], { maxTokens: 1 }); }");
  planted.set('src/services/teamStudioPanel.ts', (sources.get('src/services/teamStudioPanel.ts') ?? '').replace(/withSessionRoute\(/g, 'somethingElse('));
  planted.set('src/benchmark/runner.ts', (sources.get('src/benchmark/runner.ts') ?? '').replace(/withSessionRoute\(/g, 'somethingElse('));
  const found = siteViolations(planted, REQUEST_SITES);
  assert.ok(found.some((line) => line.startsWith('src/services/newFeature.ts calls a model request method')), found.join('\n'));
  assert.ok(found.some((line) => line.startsWith('src/services/teamStudioPanel.ts makes model requests and never calls')), found.join('\n'));
  assert.ok(found.some((line) => line === 'src/agent/loop.ts runs inside src/benchmark/runner.ts, which never calls withSessionRoute'), found.join('\n'));
});

/** The modules a module imports at run time (type-only imports are erased), resolved to repository paths. */
function runtimeImports(file: string, source: string, exists: (candidate: string) => boolean): string[] {
  const specs: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+'(\.[^']+)'/gm)) specs.push(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+'(\.[^']+)'/gm)) specs.push(match[1]!);
  for (const match of source.matchAll(/\b(?:import|require)\(\s*'(\.[^']+)'\s*\)/g)) specs.push(match[1]!);
  for (const match of source.matchAll(/^\s*import\s+\w+\s*=\s*require\('(\.[^']+)'\)/gm)) specs.push(match[1]!);
  const out: string[] = [];
  for (const spec of specs) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
    const candidate = [`${base}.ts`, `${base}/index.ts`, base].find(exists);
    if (candidate !== undefined) out.push(candidate);
  }
  return out;
}

function reachableFrom(entry: string, sources: ReadonlyMap<string, string>): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const next of runtimeImports(file, sources.get(file) ?? '', (candidate) => sources.has(candidate))) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/** Classes with their own provider checks that nothing in the extension constructs (research 2.3, A6): no module the extension loads may import them. */
const DORMANT_MODULES = ['src/services/agentOrchestrator.ts', 'src/services/multimodalOrchestrator.ts', 'src/services/generationService.ts', 'src/services/approvalService.ts', 'src/services/stakingService.ts'];

test('A6: AgentOrchestrator, MultimodalOrchestrator, GenerationService, ApprovalService and StakingService are not reachable from the extension, and a planted import is found', () => {
  const sources = new Map([...productionSources()].map(([file]) => [file, readFileSync(path.join(REPO, file), 'utf8')]));
  const reachable = reachableFrom('src/extension.ts', sources);
  assert.ok(reachable.size > 100, `the walk followed the extension's imports (${reachable.size} modules)`);
  assert.ok(reachable.has('src/services/nearAiClient.ts') && reachable.has('src/services/agentSession.ts'));
  for (const dormant of DORMANT_MODULES) {
    assert.ok(sources.has(dormant), `${dormant} exists`);
    assert.ok(!reachable.has(dormant), `${dormant} is reachable from src/extension.ts, so its own provider checks are an unguarded path`);
  }
  for (const [file, placement] of Object.entries(REQUEST_SITES)) if ('dormant' in placement) assert.ok(!reachable.has(file), file);
  // Planted: one reachable module imports a dormant one, at run time; a type-only import is erased and does not count.
  const planted = new Map(sources);
  planted.set('src/services/chat.ts', `${sources.get('src/services/chat.ts') ?? ''}\nimport { StakingService } from './stakingService';\n`);
  assert.ok(reachableFrom('src/extension.ts', planted).has('src/services/stakingService.ts'));
  const typeOnly = new Map(sources);
  typeOnly.set('src/services/chat.ts', `${sources.get('src/services/chat.ts') ?? ''}\nimport type { StakingService } from './stakingService';\n`);
  assert.ok(!reachableFrom('src/extension.ts', typeOnly).has('src/services/stakingService.ts'));
});

/** Clients built outside tests that send no content, and so need no route: a key check and a usage reader that attaches to a spend account. */
const ROUTELESS_CLIENTS: Readonly<Record<string, number>> = { 'src/services/spendTracking.ts': 2 };

/** The argument text of each `new NearAiClient(` or `createNearAiClient(` call, matched to its closing parenthesis. */
function clientConstructions(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/\b(?:new\s+NearAiClient|createNearAiClient)\s*\(/g)) {
    let depth = 1;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    for (; index < source.length && depth > 0; index += 1) {
      if (source[index] === '(') depth += 1;
      else if (source[index] === ')') depth -= 1;
    }
    out.push(source.slice(start, index - 1));
  }
  return out;
}

function clientViolations(sources: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const [file, text] of sources) {
    if (file === CLIENT_FILE) continue;
    const unrouted = clientConstructions(text).filter((args) => !/\broute\s*:/.test(args)).length;
    const allowed = ROUTELESS_CLIENTS[file] ?? 0;
    if (unrouted !== allowed) out.push(`${file}: ${unrouted} client(s) built without a route, ${allowed} named`);
  }
  return out;
}

test('every NearAiClient built outside tests says its route, except the two named ones that send no content, and a planted one is found', () => {
  const sources = productionSources();
  assert.deepEqual(clientViolations(sources), []);
  assert.ok(clientConstructions(sources.get('src/services/providerFactory.ts') ?? '').length >= 2);
  const planted = new Map(sources);
  planted.set('src/services/newFeature.ts', "const c = new NearAiClient({ baseUrl: url, apiKey: key, fetchFn: f(x) });");
  assert.deepEqual(clientViolations(planted), ['src/services/newFeature.ts: 1 client(s) built without a route, 0 named']);
});

test('a main run and its sub-agent each request inside their own route, sharing the chat\'s attestation state and the lead\'s mark', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-route-run-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-route-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-planner', description: 'Plans', tools: ['Read'], body: 'You are the planner.', file: path.join(home, 'agents', 'gsd-planner.md') }], shellEnv: {} };
  const conversation = newTestConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, new TranscriptStore(path.join(root, '.store'), root));
  const seen: Array<{ who: string; route: SessionRoute | undefined }> = [];
  let parentTurns = 0;
  const client = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const child = messages[0]?.content?.startsWith('You are the planner.') === true;
      seen.push({ who: child ? 'child' : 'parent', route: currentSessionRoute() });
      const calls = !child && parentTurns++ === 0 ? [{ id: 'a1', type: 'function' as const, function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: 'gsd-planner', prompt: 'plan it' }) } }] : undefined;
      yield { type: 'done', message: { role: 'assistant', content: calls ? null : 'done', ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } };
    },
    async actualCostsUsd() { return undefined; }
  };
  const request: AgentTurnRequest = { text: 'go', client: client as never, model: 'z-ai/glm-5.3', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd };
  await conversation.send(request);
  const parent = seen.filter((entry) => entry.who === 'parent');
  const child = seen.filter((entry) => entry.who === 'child');
  assert.ok(parent.length >= 2 && child.length >= 1, JSON.stringify(seen.map((entry) => entry.who)));
  for (const entry of seen) assert.ok(entry.route, `${entry.who} requested outside a session route`);
  assert.equal(parent[0]!.route!.actor.kind, 'agent');
  assert.equal(child[0]!.route!.actor.kind, 'sub-agent');
  assert.equal(parent[0]!.route!.attestation, conversation.routeAttestation, 'the run shares the chat\'s attestation state');
  assert.equal(child[0]!.route!.attestation, conversation.routeAttestation, 'the sub-agent shares it too');
  assert.equal(child[0]!.route!.markOf, parent[0]!.route!.markOf, 'the sub-agent reads the lead\'s mark');
  assert.deepEqual(parent[0]!.route!.markOf(), [], 'the default label until plan 22 gives a chat its mark');
});

test('runAgentInFolder (comparison, benchmark and role-suite runs) requests inside a route from its gate, and with no gate host from the failed-closed one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-route-folder-'));
  const routes: Array<SessionRoute | undefined> = [];
  const client = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      routes.push(currentSessionRoute());
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } };
    }
  };
  const gate = testGateRuntime({ presence: 'none', context: 'unattended', actor: { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'compare-1', agentLabel: 'm on t' } });
  await runAgentInFolder(client, 'm', root, 'do it', { maxTurns: 2, rules: DEFAULT_RULES, gate });
  assert.equal(routes[0]?.actor.sessionId, 'compare-1');
  assert.equal(routes[0]?.bundleState().state, 'valid');
  await runAgentInFolder(client, 'm', root, 'do it', { maxTurns: 2, rules: DEFAULT_RULES });
  assert.ok(routes[1], 'a run with no gate host still runs inside a route');
  assert.equal(routes[1]?.bundleState().state, 'failed-closed');
});

// ---- Task 3: every model request leaves a record (GATE-07, D-52), and the edges of CLAS-06 and OFFL-01 ----

/** A route over the test policy whose records land in `records`. */
function recordingRoute(mark: Mark, records: DecisionRecord[], extra: Partial<SessionRoute> = {}): SessionRoute {
  return routeAt(mark, { sink: { record: (record) => { records.push(record); } }, clock: () => 1_794_830_400_000, productVersion: '0.4.30-test', ...extra });
}

function inferOf(record: DecisionRecord): Extract<Capability, { verb: 'infer' }> {
  const capability = record.unmapped.nearAi.capability;
  assert.equal(capability.verb, 'infer');
  return capability as Extract<Capability, { verb: 'infer' }>;
}

test('each content request inside a session writes one infer record; a refused one writes a denied record with the sentence', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  await withSessionRoute(recordingRoute([], records), () => ask(near.client, 'cloud-model'));
  await assert.rejects(() => withSessionRoute(recordingRoute([org('Restricted')], records), () => ask(near.client, 'tee-model')), RouteRefusedError);
  const local = await localClient();
  await withSessionRoute(recordingRoute([org('Restricted')], records), () => ask(local.client, 'local-model'));
  assert.equal(records.length, 3);
  for (const record of records) assert.equal(validateDecisionRecord(record).ok, true, JSON.stringify(record));
  const [open, refused, onLocal] = records as [DecisionRecord, DecisionRecord, DecisionRecord];
  assert.deepEqual(inferOf(open), { verb: 'infer', tier: 'any-cloud', provider: 'near-ai', model: 'cloud-model' });
  assert.deepEqual(open.resources, [{ name: 'cloud-model', type: 'model' }]);
  assert.equal(open.api.operation, 'infer');
  assert.equal(open.authorizations[0]?.policy.name, 'route.any-cloud');
  assert.equal(open.action_id, 1);
  assert.equal(open.ai_agent?.ai_model?.name, 'cloud-model', 'an agent\'s record names the model');
  assert.equal(open.ai_agent?.ai_model?.ai_provider, 'near-ai');
  assert.equal(refused.authorizations[0]?.policy.name, 'route.no-local-model');
  assert.equal(refused.action_id, 2);
  assert.match(refused.status_detail ?? '', /^Nothing was sent\./);
  assert.deepEqual(inferOf(refused), { verb: 'infer', tier: 'local-only', provider: 'near-ai', model: 'tee-model' });
  assert.deepEqual(refused.unmapped.nearAi.mark, [org('Restricted')], 'a mark above the default label is kept');
  assert.equal(onLocal.authorizations[0]?.policy.name, 'route.local-only');
  assert.equal(inferOf(onLocal).provider, 'local');
});

test('D-52: a routine allowed request writes the short record, smaller than a full one, and the sizes are what the log grows by', async (t) => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  await withSessionRoute(recordingRoute([], records), () => ask(near.client, 'cloud-model'));
  await withSessionRoute(recordingRoute([org('Public')], records), () => ask(near.client, 'cloud-model'));
  await assert.rejects(() => withSessionRoute(recordingRoute([org('Internal')], records), () => ask(near.client, 'tee-model')), RouteRefusedError);
  const [short, publicMark, full] = records as [DecisionRecord, DecisionRecord, DecisionRecord];
  for (const record of [short, publicMark]) {
    assert.equal(record.status_detail, undefined, 'no reason');
    assert.equal(record.metadata.data_classifications, undefined, 'no label');
    assert.equal(record.unmapped.nearAi.mark, undefined, 'no mark at the default label');
    assert.equal(record.unmapped.nearAi.tier, undefined, 'the capability already names the tier');
    assert.equal(record.unmapped.nearAi.connection, undefined, 'any-cloud does not read the connection');
  }
  // The full record: the reason, the mark, and the connection state attested-cloud read.
  assert.equal(full.unmapped.nearAi.connection, 'unknown');
  assert.ok(full.status_detail?.startsWith(BINDING_REFUSALS.unknown));
  assert.deepEqual(full.metadata.data_classifications?.map((entry) => entry.confidentiality), ['org/Internal']);
  // Measured as the log stores them: one JSON line each, with the sequence the log writes.
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-size-'));
  const problems: string[] = [];
  const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'project')), onWriteFailure: (message) => problems.push(message) });
  await log.append(short);
  await log.append(full);
  const dir = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR);
  const [file] = await readdir(dir);
  const [shortLine, fullLine] = (await readFile(path.join(dir, file as string), 'utf8')).split('\n');
  const shortBytes = Buffer.byteLength(`${shortLine ?? ''}\n`);
  const fullBytes = Buffer.byteLength(`${fullLine ?? ''}\n`);
  assert.deepEqual(problems, []);
  assert.ok(shortBytes > 0 && shortBytes < fullBytes, `short ${shortBytes} bytes, full ${fullBytes} bytes`);
  t.diagnostic(`infer record bytes: short ${shortBytes}, full ${fullBytes}`);
});

test('no infer record carries a host, a URL or a path: a LAN runtime, the NEAR endpoint, and a model named by its file', async () => {
  const records: DecisionRecord[] = [];
  const lanFake = fakeFetch({ local: ['/home/someone/models/llama-3-8b.gguf', 'qwen3:8b'] });
  const lan = new NearAiClient({ baseUrl: 'https://192.168.1.5:11434/v1', apiKey: '', fetchFn: lanFake.fetchFn, route: 'local' });
  await lan.listLocalModels();
  await withSessionRoute(recordingRoute([], records), () => ask(lan, '/home/someone/models/llama-3-8b.gguf'));
  await withSessionRoute(recordingRoute([], records), () => ask(lan, 'qwen3:8b'));
  // Restricted on a host the policy does not name as local: refused, and the record still names no host.
  await assert.rejects(() => withSessionRoute(recordingRoute([org('Restricted')], records), () => ask(lan, 'qwen3:8b')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.local-host-not-local');
  const near = await nearClient();
  await withSessionRoute(recordingRoute([], records), () => ask(near.client, 'cloud-model'));
  await assert.rejects(() => withSessionRoute(recordingRoute([org('Internal')], records), () => ask(near.client, 'tee-model')), RouteRefusedError);
  assert.equal(records.length, 5);
  for (const record of records) {
    const text = JSON.stringify(record);
    for (const forbidden of ['192.168.1.5', 'cloud-api.near.ai', '://', '/home/someone', 'someone']) assert.ok(!text.includes(forbidden), `${forbidden} in ${text}`);
  }
  assert.equal(inferOf(records[0]!).model, 'llama-3-8b.gguf');
  assert.equal(inferOf(records[1]!).model, 'qwen3:8b');
  assert.equal(recordedModelName('C:\\models\\x.gguf'), 'x.gguf');
  assert.equal(recordedModelName('https://models.example.org/v1/m'), 'm');
  assert.equal(recordedModelName('~/m.gguf'), 'm.gguf');
  assert.equal(recordedModelName('z-ai/glm-5.3'), 'z-ai/glm-5.3', 'a provider/model id is a name, not a place');
  assert.equal(recordedModelName(undefined), 'unknown-model');
  // Plain http to a host that is not this computer is refused before the route is decided: nothing is sent and nothing is recorded.
  const plain = new NearAiClient({ baseUrl: 'http://192.168.1.5:11434/v1', apiKey: '', fetchFn: lanFake.fetchFn, route: 'local' });
  await assert.rejects(() => withSessionRoute(recordingRoute([], records), () => ask(plain, 'qwen3:8b')), (error: unknown) => error instanceof NearAiError && !(error instanceof RouteRefusedError));
  assert.equal(records.length, 5);
});

test('a content request outside any session is decided with the default route and recorded under route.default-session, or its refusing rule', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  try {
    setDefaultSessionRoute(recordingRoute([], records));
    await ask(near.client, 'cloud-model');
    setDefaultSessionRoute(recordingRoute([org('Restricted')], records));
    await assert.rejects(() => ask(near.client, 'tee-model'), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.no-local-model');
  } finally {
    setDefaultSessionRoute(undefined);
  }
  assert.deepEqual(records.map((record) => record.authorizations[0]?.policy.name), ['route.default-session', 'route.no-local-model']);
  assert.equal(records[0]?.status_detail, undefined, 'routine: the short record');
  // With nothing set the default route is failed closed: the default label goes where it always did, labelled content does not leave, nothing is recorded.
  assert.equal(defaultSessionRoute().bundleState().state, 'failed-closed');
  assert.equal(defaultSessionRoute().sink, undefined);
  assert.equal((await ask(near.client, 'cloud-model')).text, 'ok');
});

test('the gate host\'s route for requests outside every session writes to the open project\'s log, as a person with no session', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-host-'));
  const project = path.join(storage, 'project');
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.30-test', projectRoot: () => project });
  await host.start();
  const near = await nearClient();
  try {
    setDefaultSessionRoute(host.sessionRouteWithoutContext());
    assert.equal((await ask(near.client, 'cloud-model')).text, 'ok');
  } finally {
    setDefaultSessionRoute(undefined);
  }
  await host.flush();
  const dir = path.join(storage, GATE_DIR_NAME, DECISIONS_DIR);
  const lines = (await readFile(path.join(dir, `${projectLogKey(project)}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as DecisionRecord);
  const infer = lines.filter((record) => record.api.operation === 'infer');
  assert.equal(infer.length, 1);
  assert.equal(validateDecisionRecord(infer[0]).ok, true);
  assert.equal(infer[0]?.authorizations[0]?.policy.name, 'route.default-session');
  assert.equal(infer[0]?.actor.session.uid, NO_SESSION_ID);
  assert.notEqual(infer[0]?.actor.user.uid, 'device-unknown', 'the device the started policy names');
  assert.ok(infer[0]?.authorizations[0]?.policy.uid, 'the policy hash');
});

test('CLAS-06 concurrency: sibling contexts in parallel are each decided by their own mark, and a mark that rises during a retry is seen by the next request', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  const lead = recordingRoute([], records, { actor: { ...ACTOR, agentId: 'lead' } });
  const helper = recordingRoute([org('Restricted')], records, { actor: { ...ACTOR, kind: 'sub-agent', agentId: 'helper' } });
  const results = await Promise.allSettled([
    withSessionRoute(lead, async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return ask(near.client, 'cloud-model'); }),
    withSessionRoute(helper, () => ask(near.client, 'cloud-model')),
    withSessionRoute(lead, () => ask(near.client, 'cloud-model'))
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
  const byAgent = (id: string) => records.filter((record) => record.ai_agent?.uid === id).map((record) => record.authorizations[0]?.policy.name);
  assert.deepEqual(byAgent('lead'), ['route.any-cloud', 'route.any-cloud']);
  assert.deepEqual(byAgent('helper'), ['route.no-local-model']);

  // A request retried once inside request() is decided once and recorded once; the mark raised during its backoff is read by the next request.
  let mark: Mark = [];
  const retried: DecisionRecord[] = [];
  let attempts = 0;
  const fake = fakeFetch({ cloud: ['cloud-model'] });
  const flaky = new NearAiClient({ baseUrl: NEAR, apiKey: 'k', route: 'near', retryBaseDelayMs: 0, fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && attempts++ === 0) { mark = [org('Restricted')]; return new Response('', { status: 502 }); }
    return fake.fetchFn(input, init);
  }) as typeof fetch });
  await flaky.listModels();
  const route = recordingRoute([], retried, { markOf: () => mark });
  const sent = await withSessionRoute(route, () => flaky.streamChatEvents('cloud-model', [{ role: 'user', content: 'hi' }]).next());
  assert.equal(sent.done, false, 'the retried request went through');
  assert.equal(attempts, 2);
  assert.deepEqual(retried.map((record) => record.authorizations[0]?.policy.name), ['route.any-cloud']);
  await assert.rejects(() => withSessionRoute(route, () => ask(flaky, 'cloud-model')), RouteRefusedError);
  assert.deepEqual(retried.map((record) => record.authorizations[0]?.policy.name), ['route.any-cloud', 'route.no-local-model']);
});

test('CLAS-06 ordering: a refused request leaves the spend ledger untouched, takes no concurrency slot and is not held by a cooling model', async () => {
  let limitChecks = 0;
  let began = 0;
  const spend: SpendSink = {
    begin: () => { began += 1; return () => undefined; },
    limitReached: () => { limitChecks += 1; return undefined; },
    attach: () => undefined
  };
  let cools = true;
  const fake = fakeFetch({ tee: ['tee-model'] });
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'k', route: 'near', spend, fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST' && cools) { cools = false; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); }
    return fake.fetchFn(input, init);
  }) as typeof fetch });
  await client.listModels();
  // The model is now cooling for a minute after a 429.
  await assert.rejects(() => withSessionRoute(routeAt([]), () => ask(client, 'tee-model')), (error: unknown) => error instanceof NearAiError && error.status === 429);
  assert.ok(client.cooldownRemainingMs('tee-model') > 0);
  const checksBefore = limitChecks;
  const beganBefore = began;
  // Refused at once by the route, not held or refused by the cooldown, and the spend check is never reached.
  await assert.rejects(() => withSessionRoute(routeAt([org('Restricted')]), () => ask(client, 'tee-model')), RouteRefusedError);
  assert.equal(limitChecks, checksBefore, 'the daily limit was not even checked');
  assert.equal(began, beganBefore, 'nothing was entered in the ledger');
  assert.equal(fake.content.length, 0);
  // A local client with no spend sink is checked too: the route check does not depend on spend tracking.
  const local = await localClient();
  await withSessionRoute(routeAt([org('Restricted')]), () => ask(local.client, 'local-model'));
  const lanLocal = new NearAiClient({ baseUrl: 'https://models.example.org/v1', apiKey: '', route: 'local', fetchFn: fakeFetch({ local: ['m'] }).fetchFn });
  await lanLocal.listLocalModels();
  await assert.rejects(() => withSessionRoute(routeAt([org('Restricted')]), () => ask(lanLocal, 'm')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.local-host-not-local');
});

test('a sink that throws leaves the request\'s outcome unchanged', async () => {
  const throwing: DecisionSink = { record: () => { throw new Error('disk full'); } };
  const near = await nearClient();
  assert.equal((await withSessionRoute(routeAt([], { sink: throwing }), () => ask(near.client, 'cloud-model'))).text, 'ok');
  await assert.rejects(() => withSessionRoute(routeAt([org('Restricted')], { sink: throwing }), () => ask(near.client, 'tee-model')), RouteRefusedError);
  const markThrows = routeAt([], { markOf: () => { throw new Error('unreadable'); } });
  await assert.rejects(() => withSessionRoute(markThrows, () => ask(near.client, 'cloud-model')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.deny');
});

test('OFFL-01: with fetch, net, dns, http and https stubbed to throw, route decisions complete from local data, including one right after a verifyResponse call', async () => {
  const calls: string[] = [];
  const restore: Array<() => void> = [];
  const stub = (owner: object, key: string, name: string): void => {
    const original = (owner as Record<string, unknown>)[key];
    (owner as Record<string, unknown>)[key] = (): never => { calls.push(name); throw new Error(`${name} was called by a route decision`); };
    restore.push(() => { (owner as Record<string, unknown>)[key] = original; });
  };
  const near = await nearClient();
  const local = await localClient();
  stub(globalThis, 'fetch', 'fetch');
  stub(net, 'connect', 'net.connect');
  stub(net, 'createConnection', 'net.createConnection');
  stub(dns, 'lookup', 'dns.lookup');
  stub(dns.promises, 'lookup', 'dns.promises.lookup');
  stub(http, 'request', 'http.request');
  stub(https, 'request', 'https.request');
  try {
    const records: DecisionRecord[] = [];
    // The answer check goes through the client's own fetchFn (here, the fake); it finishes, unverified, and the next decision is still local.
    const verification = await near.client.verifyResponse('tee-model', { chatId: 'chat-1', requestHash: 'a'.repeat(64), responseHash: 'b'.repeat(64) });
    assert.notEqual(verification.outcome, 'verified');
    await assert.rejects(() => withSessionRoute(recordingRoute([org('Confidential')], records), () => ask(near.client, 'tee-model')), RouteRefusedError);
    await withSessionRoute(recordingRoute([], records), () => ask(near.client, 'cloud-model'));
    await withSessionRoute(recordingRoute([org('Restricted')], records), () => ask(local.client, 'local-model'));
    assert.equal(records.length, 3);
  } finally {
    for (const undo of restore.reverse()) undo();
  }
  assert.deepEqual(calls, []);
});
