// The route check at the client's one choke point (CLAS-06, CLAS-05 as the owner amplified it, D-31, D-50): every content request is decided in
// NearAiClient.request, from the session route it runs inside and local facts only, before anything is sent. Every fetch here is a counting stub; nothing
// reaches the network and no key is read.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
import type { ActorRef } from '../domain/gate/decide';
import { currentSessionRoute, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient, RouteRefusedError } from '../services/nearAiClient';
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
