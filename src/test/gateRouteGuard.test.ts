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
import * as ts from 'typescript';
import { DEFAULT_RULES } from '../agent/permissions';
import { runAgentInFolder } from '../benchmark/runner';
import { createProjectCredentialScope } from '../domain/auth';
import type { OrganizationProfile } from '../domain/auth';
import type { Mark } from '../domain/gate/dominance';
import type { Label } from '../domain/gate/labels';
import { BINDING_REFUSALS, DEFAULT_ROUTING, ROUTE_CHECK_FAILED_TEXT } from '../domain/gate/routing';
import type { ActorRef, DecisionSink } from '../domain/gate/decide';
import { buildDecisionRecord, isModelRequestRecord, validateDecisionRecord } from '../domain/gate/record';
import type { DecisionRecord } from '../domain/gate/record';
import type { Capability } from '../domain/gate/vocabulary';
import { GATE_DIR_NAME } from '../gate/bundleStore';
import { DECISIONS_DIR, DecisionLog, INSTALL_LOG_KEY, MODEL_REQUESTS_DIR, projectLogKey } from '../gate/decisionLog';
import { GateHost, MAX_PROJECT_LOGS, NO_SESSION_ID } from '../gate/host';
import { currentSessionRoute, defaultSessionRoute, recordedModelName, routeRecordFor, sessionRouteFrom, setDefaultSessionRoute, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { BILLABLE_PATHS, CONTENT_PATHS, NON_CONTENT_POST_PATHS, NearAiClient, NearAiError, RouteRefusedError, needsRouteCheck } from '../services/nearAiClient';
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
/** The most a short infer record may take in the log with real-sized ids (owner decision after PR 4a: it was 1,350 bytes before its repeats were dropped). */
const SHORT_RECORD_BUDGET_BYTES = 1_100;
const SRC = path.join(REPO, 'src');

/** Every production source, keyed by its repository path (src/...), as written (the syntax-tree scans skip comments themselves). */
function productionSources(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (full !== path.join(SRC, 'test')) walk(full); continue; }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) found.set(path.relative(REPO, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
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
const CLIENT_FILE = 'src/services/nearAiClient.ts';

/**
 * The files that call a model request method, and how each one's requests run inside a session route (PR 4a review: the call site itself, not the file):
 * - `self`: every request call in the file is wrapped where it is written;
 * - `inside`: the file's requests run only inside the listed callers, and in each caller every call of the listed entry (`via`) is wrapped; the caller imports
 *   the file, or reaches it through an object the run is given (a tool, the safety check), which loop.ts only touches inside AgentRun's methods;
 * - `dormant`: nothing in the extension reaches it (the import scan below).
 * "Wrapped" is read from the syntax tree, never from the text: see wrappedIn.
 */
type Entry = { readonly caller: string; readonly via: readonly string[]; readonly imports: boolean };
type Placement = { readonly self: true } | { readonly inside: readonly Entry[] } | { readonly dormant: true };
const REQUEST_SITES: Readonly<Record<string, Placement>> = {
  'src/agent/attachments.ts': { inside: [{ caller: 'src/services/chat.ts', via: ['prepareAttachments'], imports: true }] },
  'src/agent/context.ts': { inside: [{ caller: 'src/services/agentSession.ts', via: ['compactConversation'], imports: true }] },
  // The image tool's request runs when the run calls the tool; toolRunScan.ts holds that a tool's run is reached only in loop.ts.
  'src/agent/extraTools.ts': { inside: [{ caller: 'src/agent/loop.ts', via: ['tool.run'], imports: false }] },
  'src/agent/loop.ts': { inside: [
    { caller: 'src/services/agentSession.ts', via: ['run.run', 'child.run'], imports: true },
    { caller: 'src/benchmark/runner.ts', via: ['run.run'], imports: true }
  ] },
  // The run hands the safety check to the command checks only from inside its own methods.
  'src/agent/safetyModel.ts': { inside: [{ caller: 'src/agent/loop.ts', via: ['this.options.safety'], imports: false }] },
  'src/services/chatParticipant.ts': { self: true },
  'src/services/cyberAssembly.ts': { self: true },
  'src/services/cyberHandoff.ts': { self: true },
  'src/services/teamStudioPanel.ts': { self: true },
  'src/services/generationService.ts': { dormant: true }
};

function importsModule(source: string, from: string, target: string): boolean {
  const relative = path.posix.relative(path.posix.dirname(from), target).replace(/\.ts$/, '');
  const spec = relative.startsWith('.') ? relative : `./${relative}`;
  return new RegExp(String.raw`from\s+'${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(source);
}

function parsed(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every node of the tree that `pick` accepts. */
function nodesOf<T extends ts.Node>(root: ts.Node, pick: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (pick(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** The calls of a model request method: `<anything>.streamCompletion(`, `.completeOnce(` and the rest. */
function requestCalls(source: ts.SourceFile): ts.CallExpression[] {
  return nodesOf(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && REQUEST_METHODS.includes(node.expression.name.text));
}

/** The places an entry is reached: a call whose callee is written `via`, or (for a member such as `this.options.safety`) a read of it. */
function entrySites(source: ts.SourceFile, via: string): ts.Node[] {
  return nodesOf(source, (node): node is ts.Node => (ts.isCallExpression(node) && node.expression.getText(source) === via)
    || (ts.isPropertyAccessExpression(node) && node.getText(source) === via && !(ts.isCallExpression(node.parent) && node.parent.expression === node)));
}

function isWithSessionRoute(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withSessionRoute';
}

function isFunctionLike(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** True when every use of a local name, other than where it is declared, is the work handed to withSessionRoute (`withSessionRoute(route, prepare)`). */
function onlyHandedToWithSessionRoute(source: ts.SourceFile, declaration: ts.VariableDeclaration): boolean {
  if (!ts.isIdentifier(declaration.name)) return false;
  const name = declaration.name.text;
  const uses = nodesOf(source, (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === name && node !== declaration.name);
  return uses.length > 0 && uses.every((use) => isWithSessionRoute(use.parent) && use.parent.arguments.indexOf(use as ts.Expression) >= 1);
}

/**
 * Whether a node runs only inside a session route, by the shape of the code around it:
 * (a) it is inside the work given to withSessionRoute (any argument after the route);
 * (b) it is inside a function kept in a local name whose every use is the work given to withSessionRoute;
 * (c) it is inside a hook of `new AgentRun({ ... })` (beforeTurn and the rest), which the run calls only from run(), whose own call is checked;
 * (d) it is inside a method of the file's class whose every `this.<method>(` call is itself covered;
 * (e) in loop.ts only, it is inside a method of AgentRun other than the constructor: those run only from run().
 */
function wrappedIn(source: ts.SourceFile, node: ts.Node, agentRunMethods: boolean, seen: ReadonlySet<string> = new Set()): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (isWithSessionRoute(parent) && parent.arguments.indexOf(child as ts.Expression) >= 1) return true;
    if (isFunctionLike(child)) {
      if (ts.isVariableDeclaration(parent) && parent.initializer === child && onlyHandedToWithSessionRoute(source, parent)) return true;
      if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent) && ts.isNewExpression(parent.parent.parent)
        && parent.parent.parent.expression.getText(source) === 'AgentRun') return true;
    }
    if (ts.isMethodDeclaration(child) && ts.isClassDeclaration(parent)) {
      if (agentRunMethods && parent.name?.text === 'AgentRun') return true;
      const name = child.name.getText(source);
      if (seen.has(name)) return false;
      const calls = nodesOf(source, (each): each is ts.CallExpression => ts.isCallExpression(each) && each.expression.getText(source) === `this.${name}`);
      const next = new Set([...seen, name]);
      return calls.length > 0 && calls.every((call) => wrappedIn(source, call, agentRunMethods, next));
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** What breaks the rule that every model request runs inside a session route. Empty when it holds. */
function siteViolations(sources: ReadonlyMap<string, string>, sites: Readonly<Record<string, Placement>>): string[] {
  const out: string[] = [];
  const trees = new Map<string, ts.SourceFile>();
  const tree = (file: string): ts.SourceFile => {
    let found = trees.get(file);
    if (found === undefined) { found = parsed(file, sources.get(file) ?? ''); trees.set(file, found); }
    return found;
  };
  for (const file of sources.keys()) {
    if (file === CLIENT_FILE || requestCalls(tree(file)).length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(sites, file)) out.push(`${file} calls a model request method and is not on the list of request sites`);
  }
  for (const [file, placement] of Object.entries(sites)) {
    const text = sources.get(file);
    if (text === undefined || requestCalls(tree(file)).length === 0) { out.push(`${file} is listed but makes no model request (remove it)`); continue; }
    if ('self' in placement) {
      for (const call of requestCalls(tree(file))) if (!wrappedIn(tree(file), call, false)) out.push(`${file}:${lineOf(tree(file), call)} makes a model request outside withSessionRoute`);
    }
    if ('inside' in placement) {
      for (const entry of placement.inside) {
        const caller = tree(entry.caller);
        if (entry.imports && !importsModule(sources.get(entry.caller) ?? '', entry.caller, file)) out.push(`${entry.caller} does not import ${file}`);
        for (const via of entry.via) {
          const sitesOf = entrySites(caller, via);
          if (sitesOf.length === 0) out.push(`${entry.caller} never reaches ${via} (update the list)`);
          for (const site of sitesOf) {
            if (!wrappedIn(caller, site, entry.caller === 'src/agent/loop.ts')) out.push(`${entry.caller}:${lineOf(caller, site)} reaches ${via} (${file}) outside withSessionRoute`);
          }
        }
      }
    }
  }
  return out;
}

test('CLAS-06: every model request call site runs inside a session route, read from the syntax tree, and planted unwrapped calls are reported', () => {
  const sources = productionSources();
  assert.ok(sources.size > 200, 'the scan read all of src');
  assert.deepEqual(siteViolations(sources, REQUEST_SITES), []);
  const planted = new Map(sources);
  const with_ = (file: string, extra: string): void => { planted.set(file, `${sources.get(file) ?? ''}\n${extra}\n`); };
  // A new file that calls the client.
  planted.set('src/services/newFeature.ts', "export async function go(client) { return client.completeOnce('m', [], { maxTokens: 1 }); }");
  // A run started outside any route, in a file that wraps other calls (the old text scan passed this).
  with_('src/services/agentSession.ts', 'export function planted(run: { run(): unknown }) { return run.run(); }');
  // Attachments read outside the route, beside the wrapped read.
  with_('src/services/chat.ts', 'export function plantedRead() { return prepareAttachments([], {} as never); }');
  // A self site whose work is also called directly, so the name is not only handed to withSessionRoute.
  planted.set('src/services/teamStudioPanel.ts', (sources.get('src/services/teamStudioPanel.ts') ?? '').replace('return withSessionRoute(', 'void send(); return withSessionRoute('));
  // A request in a self site written outside the wrap.
  with_('src/services/cyberHandoff.ts', "export function plantedRole(client: { completeOnce(m: string, x: never[], o: { maxTokens: number }): unknown }) { return client.completeOnce('m', [], { maxTokens: 1 }); }");
  const found = siteViolations(planted, REQUEST_SITES);
  const has = (pattern: RegExp): boolean => found.some((line) => pattern.test(line));
  assert.ok(has(/^src\/services\/newFeature\.ts calls a model request method/), found.join('\n'));
  assert.ok(has(/^src\/services\/agentSession\.ts:\d+ reaches run\.run \(src\/agent\/loop\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/chat\.ts:\d+ reaches prepareAttachments \(src\/agent\/attachments\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/teamStudioPanel\.ts:\d+ makes a model request outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/cyberHandoff\.ts:\d+ makes a model request outside withSessionRoute/), found.join('\n'));
  assert.equal(found.length, 5, found.join('\n'));
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
    const unrouted = clientConstructions(withoutComments(text)).filter((args) => !/\broute\s*:/.test(args)).length;
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
  // The routine record is the short one: the capability names the model and provider once (owner decision after PR 4a's measurement).
  assert.deepEqual(open.resources, []);
  assert.equal(open.api.operation, 'infer');
  assert.equal(open.authorizations[0]?.policy.name, 'route.any-cloud');
  assert.equal(open.action_id, 1);
  assert.equal(open.ai_agent?.ai_model, undefined, 'the short record names the model once, in the capability');
  // A full record keeps the model as its resource and, for an agent, as its model.
  assert.deepEqual(refused.resources, [{ name: 'tee-model', type: 'model' }]);
  assert.deepEqual(refused.ai_agent?.ai_model, { name: 'tee-model', ai_provider: 'near-ai' });
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
  // Measured as the model-request log stores them: one JSON line each, with the sequence the log writes.
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-size-'));
  const problems: string[] = [];
  const log = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'project')), kind: 'model-requests', onWriteFailure: (message) => problems.push(message) });
  await log.append(short);
  await log.append(full);
  const dir = path.join(storage, GATE_DIR_NAME, MODEL_REQUESTS_DIR);
  const [file] = await readdir(dir);
  const [shortLine, fullLine] = (await readFile(path.join(dir, file as string), 'utf8')).split('\n');
  const shortBytes = Buffer.byteLength(`${shortLine ?? ''}\n`);
  const fullBytes = Buffer.byteLength(`${fullLine ?? ''}\n`);
  assert.deepEqual(problems, []);
  assert.ok(shortBytes > 0 && shortBytes < fullBytes, `short ${shortBytes} bytes, full ${fullBytes} bytes`);
  t.diagnostic(`infer record bytes: short ${shortBytes}, full ${fullBytes}`);
});

/** Every leaf path of a record, sorted, so a test can pin exactly which fields a record has. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [`${prefix}[]`] : value.flatMap((entry, index) => leafPaths(entry, `${prefix}[${index}]`));
  if (value !== null && typeof value === 'object') return Object.keys(value).flatMap((key) => leafPaths((value as Record<string, unknown>)[key], prefix === '' ? key : `${prefix}.${key}`));
  return [prefix];
}

test('the short record writes nothing twice, has exactly its pinned fields, and stays within its byte budget with real-sized ids', () => {
  // Real-sized ids: a 36-character model id, a 64-hex device fingerprint and policy hash, today's conversation and agent id shapes, a UUID record id.
  const model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
  const hash = 'a'.repeat(64);
  const facts = { clientRoute: 'near' as const, host: NEAR, nearEndpoint: true, model: { id: model, privacyBoundary: 'cloud' }, attestationFailed: false };
  const decision = { allowed: true, tier: 'any-cloud' as const, rule: 'route.any-cloud' as const };
  const context = { mark: [], defaultLabel: org('Public'), bundleHash: hash, routing: DEFAULT_ROUTING };
  const actors: ActorRef[] = [
    { kind: 'agent', deviceFingerprint: 'f'.repeat(64), sessionId: 'conv-mvxrqmdo-f6c69e9e', agentId: 'main-run-1793536426359-a48b19', agentLabel: 'agent' },
    { kind: 'sub-agent', deviceFingerprint: 'f'.repeat(64), sessionId: 'conv-mvxrqmdo-f6c69e9e', agentId: 'gsd-planner-mvxrqmdo-1a2b3c', agentLabel: 'gsd-planner' },
    { kind: 'person', deviceFingerprint: 'f'.repeat(64), sessionId: 'conv-mvxrqmdo-f6c69e9e' }
  ];
  for (const actor of actors) {
    const route = routeAt([], { actor, clock: () => 1_794_830_400_000, productVersion: '0.4.30', newRecordId: () => '0b4c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d' });
    const record = routeRecordFor(route, decision, facts, { model }, context);
    assert.equal(validateDecisionRecord(record).ok, true);
    const text = JSON.stringify({ ...record, metadata: { ...record.metadata, sequence: 123_456 } });
    assert.equal(text.split(model).length - 1, 1, 'the model id is written once');
    assert.equal(text.split(hash).length - 1, 1, 'the policy hash is written once');
    assert.equal(text.split('0b4c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d').length - 1, 1, 'the record id is written once');
    const bytes = Buffer.byteLength(`${text}\n`);
    assert.ok(bytes <= SHORT_RECORD_BUDGET_BYTES, `${actor.kind}: ${bytes} bytes, budget ${SHORT_RECORD_BUDGET_BYTES}`);
    const agentFields = actor.kind === 'person' ? [] : ['ai_agent.instance_uid', 'ai_agent.name', 'ai_agent.uid'];
    assert.deepEqual(leafPaths(record).sort(), [
      'action_id', 'activity_id', 'activity_name', 'actor.session.uid', 'actor.user.uid', ...agentFields, 'api.operation', 'api.request.uid',
      'authorizations[0].decision', 'authorizations[0].policy.is_applied', 'authorizations[0].policy.name', 'authorizations[0].policy.version', 'category_uid',
      'class_uid', 'disposition_id', 'metadata.product.name', 'metadata.product.vendor_name', 'metadata.product.version', 'metadata.profiles[0]', 'metadata.sequence',
      'metadata.uid', 'metadata.version', 'resources[]', 'severity_id', 'src_endpoint.name', 'status_id', 'time', 'type_uid', 'unmapped.nearAi.bundleHash',
      'unmapped.nearAi.capability.model', 'unmapped.nearAi.capability.provider', 'unmapped.nearAi.capability.tier', 'unmapped.nearAi.capability.verb',
      'unmapped.nearAi.recordVersion'
    ].sort(), actor.kind);
  }
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
  const read = async (folder: string): Promise<DecisionRecord[]> => (await readFile(path.join(storage, GATE_DIR_NAME, folder, `${projectLogKey(project)}.jsonl`), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as DecisionRecord);
  // The model request is in the project's model-request log; its decision log holds only the policy's own events.
  const infer = await read(MODEL_REQUESTS_DIR);
  assert.equal(infer.length, 1);
  assert.equal(validateDecisionRecord(infer[0]).ok, true);
  assert.equal(infer[0]?.authorizations[0]?.policy.name, 'route.default-session');
  assert.equal(infer[0]?.actor.session.uid, NO_SESSION_ID);
  assert.notEqual(infer[0]?.actor.user.uid, 'device-unknown', 'the device the started policy names');
  assert.match(infer[0]?.unmapped.nearAi.bundleHash ?? '', /^[0-9a-f]{64}$/, 'the policy hash, written once');
  assert.ok((await read(DECISIONS_DIR)).every((record) => record.api.operation.startsWith('policy.')));
});

test('an infer record never lands in the decision log, and a tool or policy record never in the model-request log', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-split-'));
  const project = path.join(storage, 'project');
  const problems: string[] = [];
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.30-test', projectRoot: () => project, onProblem: (message) => problems.push(message) });
  await host.start();
  // One run's runtime receives both kinds through its one sink, as a run does: its tool calls, and (through its session route) its model requests.
  const runtime = await host.runtimeFor({ root: project, actor: ACTOR, presence: 'person', context: 'interactive' });
  const near = await nearClient();
  await withSessionRoute(sessionRouteFrom(runtime), () => ask(near.client, 'cloud-model'));
  await assert.rejects(() => withSessionRoute(sessionRouteFrom(runtime, { markOf: () => [org('Restricted')] }), () => ask(near.client, 'tee-model')), RouteRefusedError);
  const tool = buildDecisionRecord({
    recordId: 'tool-1', sequence: 0, time: 1, productVersion: '0.4.30-test', actor: runtime.actor, callId: 'call-1', capability: { verb: 'infer', tier: 'any-cloud', provider: 'near-ai', model: 'image-model' },
    resource: { name: 'GenerateImage', type: 'tool' }, outcome: 'allowed', rule: 'settings.mode.other', bundleHash: ''
  });
  runtime.sink.record(tool);
  await host.flush();
  const dir = (folder: string) => path.join(storage, GATE_DIR_NAME, folder, `${projectLogKey(project)}.jsonl`);
  const decisions = (await readFile(dir(DECISIONS_DIR), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as DecisionRecord);
  const requests = (await readFile(dir(MODEL_REQUESTS_DIR), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as DecisionRecord);
  assert.deepEqual(requests.map((record) => record.authorizations[0]?.policy.name), ['route.any-cloud', 'route.no-local-model']);
  assert.ok(requests.every((record) => isModelRequestRecord(record)), 'only model requests in the model-request log');
  assert.ok(decisions.every((record) => !isModelRequestRecord(record)), 'no model request in the decision log');
  assert.ok(decisions.some((record) => record.metadata.uid === 'tool-1'), 'a tool decision whose effect is infer stays in the decision log');
  assert.equal(problems.length, 0, problems.join('; '));
  // The log itself refuses the wrong kind, whoever offers it, and says so once; nothing is written to the wrong file.
  const wrongDecisions = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'other')), onWriteFailure: (message) => problems.push(message) });
  await wrongDecisions.append(requests[0]!);
  const wrongRequests = new DecisionLog({ globalStorageDir: storage, projectKey: projectLogKey(path.join(storage, 'other')), kind: 'model-requests', onWriteFailure: (message) => problems.push(message) });
  await wrongRequests.append(tool);
  assert.equal(problems.length, 2, problems.join('\n'));
  for (const folder of [DECISIONS_DIR, MODEL_REQUESTS_DIR]) {
    await assert.rejects(readFile(path.join(storage, GATE_DIR_NAME, folder, `${projectLogKey(path.join(storage, 'other'))}.jsonl`)), { code: 'ENOENT' });
  }
});

test('model-request logs follow the host\'s log rules: let go with their folder, at most MAX_PROJECT_LOGS per kind, one writer per key, and flush waits for them', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-retain-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.30-test' });
  await host.start();
  const near = await nearClient();
  const roots = Array.from({ length: MAX_PROJECT_LOGS + 2 }, (_unused, index) => path.join(storage, `project-${index}`));
  for (const root of roots) {
    const runtime = await host.runtimeFor({ root, actor: ACTOR, presence: 'person', context: 'interactive' });
    await withSessionRoute(sessionRouteFrom(runtime), () => ask(near.client, 'cloud-model'));
  }
  const projectRequestLogs = host.openModelRequestLogKeys().filter((key) => key !== INSTALL_LOG_KEY);
  assert.equal(projectRequestLogs.length, MAX_PROJECT_LOGS, 'the oldest model-request logs were let go');
  assert.deepEqual(projectRequestLogs, roots.slice(2).map((root) => projectLogKey(root)), 'least recently used first, the two oldest gone');
  assert.equal(host.openLogKeys().filter((key) => key !== INSTALL_LOG_KEY).length, MAX_PROJECT_LOGS, 'the decision logs keep their own count');
  // A closed folder's model-request log is let go with its decision log; the open ones stay.
  host.retainProjectLogs([roots[9]!]);
  assert.deepEqual(host.openModelRequestLogKeys().filter((key) => key !== INSTALL_LOG_KEY), [projectLogKey(roots[9]!)]);
  // A record after it was let go opens it again, and flush waits for every one of them, the let-go ones included.
  const again = await host.runtimeFor({ root: roots[2]!, actor: ACTOR, presence: 'person', context: 'interactive' });
  await withSessionRoute(sessionRouteFrom(again), () => ask(near.client, 'cloud-model'));
  await host.flush();
  for (const root of roots) {
    const lines = (await readFile(path.join(storage, GATE_DIR_NAME, MODEL_REQUESTS_DIR, `${projectLogKey(root)}.jsonl`), 'utf8')).trim().split('\n');
    const sequences = lines.map((line) => (JSON.parse(line) as DecisionRecord).metadata.sequence);
    assert.deepEqual(sequences, sequences.map((_unused, index) => index + 1), 'one writer per key: the sequence never repeats or skips');
    assert.equal(lines.length, root === roots[2] ? 2 : 1);
  }
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

// ---- PR 4a review round 1 ----

test('one list of content paths: billing is the same set, every POST the client writes is a content path or a named non-content one, and any other request but a GET is route checked', async () => {
  assert.equal(BILLABLE_PATHS, CONTENT_PATHS, 'the same set, never a copy that could drift');
  const source = parsed(CLIENT_FILE, readFileSync(path.join(REPO, CLIENT_FILE), 'utf8'));
  const requests = nodesOf(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && node.expression.getText(source) === 'this.request');
  let posts = 0;
  for (const call of requests) {
    const [target, init] = call.arguments;
    const method = init !== undefined && ts.isObjectLiteralExpression(init)
      ? init.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(source) === 'method')?.initializer.getText(source)
      : undefined;
    if (method === "'GET'") continue;
    posts += 1;
    assert.ok(target !== undefined && ts.isStringLiteral(target), `${call.getText(source).slice(0, 80)}: a request that is not a GET names its path as a literal`);
    assert.ok(CONTENT_PATHS.has(target.text) || NON_CONTENT_POST_PATHS.has(target.text), `${target.text} is neither a content path nor a named non-content one`);
  }
  assert.ok(posts >= 8, `${posts} requests that are not GETs`);
  assert.equal(needsRouteCheck('/chat/completions', 'POST'), true);
  assert.equal(needsRouteCheck('/responses', 'POST'), true, 'a path nobody listed is checked, never sent unchecked');
  assert.equal(needsRouteCheck('/responses', 'put'), true);
  assert.equal(needsRouteCheck('/check_api_key', 'POST'), false);
  assert.equal(needsRouteCheck('/billing/costs?x=1', 'POST'), false);
  assert.equal(needsRouteCheck('/models', 'GET'), false);
  assert.equal(needsRouteCheck('/models', undefined), false);
  // Behaviour: a POST to a path nobody listed is refused like a content request; the key check is not checked.
  const near = await nearClient();
  const raw = near.client as unknown as { request(target: string, init: RequestInit, overrides: object): Promise<Response> };
  await assert.rejects(() => withSessionRoute(routeAt([org('Restricted')]), () => raw.request('/responses', { method: 'POST', body: '{}' }, { model: 'tee-model' })), RouteRefusedError);
  assert.equal(near.content.length, 0);
  await withSessionRoute(routeAt([org('Restricted')]), () => raw.request('/check_api_key', { method: 'POST' }, {}));
  assert.deepEqual(near.content, ['POST /v1/check_api_key']);
});

/** The test policy with one routing level changed, or with a routing table that is not one. */
function routeWithRouting(mark: Mark, records: DecisionRecord[], routing: unknown): SessionRoute {
  const state = testBundleState();
  if (state.state !== 'valid') throw new Error('unreachable');
  const changed = { ...state, bundle: { ...state.bundle, routing: routing as typeof state.bundle.routing } };
  return recordingRoute(mark, records, { bundleState: () => changed });
}

test('a refused request always records the label that decided it: the default label when nothing raised the mark, otherwise the mark\'s deciding label', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  // A policy whose default label (org Public) is local-only: refused at the default label, with an empty mark.
  const strict = { ...DEFAULT_ROUTING, levels: { ...DEFAULT_ROUTING.levels, 'org/Public': 'local-only' } };
  await assert.rejects(() => withSessionRoute(routeWithRouting([], records, strict), () => ask(near.client, 'tee-model')), RouteRefusedError);
  await assert.rejects(() => withSessionRoute(recordingRoute([org('Internal'), org('Restricted')], records), () => ask(near.client, 'tee-model')), RouteRefusedError);
  const [atDefault, raised] = records as [DecisionRecord, DecisionRecord];
  assert.deepEqual(atDefault.unmapped.nearAi.label, org('Public'));
  assert.deepEqual(atDefault.metadata.data_classifications?.map((entry) => entry.confidentiality), ['org/Public']);
  assert.equal(atDefault.unmapped.nearAi.mark, undefined, 'the mark is the default, so it is not written');
  assert.deepEqual(raised.unmapped.nearAi.label, org('Restricted'), 'the label whose tier decided');
  assert.deepEqual(raised.metadata.data_classifications?.map((entry) => entry.confidentiality), ['org/Restricted', 'org/Internal'], 'each level once');
  for (const record of records) assert.equal(validateDecisionRecord(record).ok, true);
});

test('a routing table that throws is refused with a fixed rule and a plain sentence, recorded, and nothing is sent', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  await assert.rejects(
    () => withSessionRoute(routeWithRouting([], records, { levels: null, handling: null, compartments: null, localHosts: null }), () => ask(near.client, 'cloud-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.deny' && error.message === ROUTE_CHECK_FAILED_TEXT
  );
  assert.equal(near.content.length, 0);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.authorizations[0]?.policy.name, 'route.deny');
  assert.equal(records[0]?.status_detail, ROUTE_CHECK_FAILED_TEXT);
  assert.equal(records[0]?.unmapped.nearAi.label, undefined, 'no label decided it');
  assert.equal(validateDecisionRecord(records[0]).ok, true);
  assert.match(ROUTE_CHECK_FAILED_TEXT, /^Nothing was sent\. /);
});

test('a policy state that cannot be read for its routing (valid, with no bundle in it) is refused as route.deny, recorded, and nothing is sent', async () => {
  const records: DecisionRecord[] = [];
  const near = await nearClient();
  // A malformed state: it says valid but carries no bundle, so reading its routing table throws inside the route check.
  const malformed = recordingRoute([], records, { bundleState: () => ({ state: 'valid' }) as never });
  await assert.rejects(
    () => withSessionRoute(malformed, () => ask(near.client, 'cloud-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.deny' && error.message === ROUTE_CHECK_FAILED_TEXT
  );
  assert.equal(near.content.length, 0);
  assert.equal(records.length, 1, 'the refusal is on record');
  assert.equal(records[0]?.authorizations[0]?.policy.name, 'route.deny');
  assert.equal(records[0]?.unmapped.nearAi.bundleHash, '', 'no policy hash could be read');
  assert.equal(validateDecisionRecord(records[0]).ok, true);
});
