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
import { BINDING_REFUSALS, DEFAULT_ROUTING, ROUTE_CHECK_FAILED_TEXT, ROUTE_REFUSALS } from '../domain/gate/routing';
import type { RoutePolicy, VerifiedAuthorization } from '../domain/gate/routing';
import { createHash } from 'node:crypto';
import { parseModelsSection } from '../domain/gate/models';
import { parseResidencySection } from '../domain/gate/sections';
import { ConnectionNotBoundError } from '../services/connectionBinding';
import { pinnedFetchAny } from '../services/privateRoute';
import { parseEndpoints } from '../domain/gate/endpoints';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyRecordVersion } from '../domain/gate/record';
import type { PayloadSigner } from '../domain/team/signedPayload';
import type { PolicyLayersView } from '../gate/organizationStore';
import { policyVersionOf } from '../gate/host';
import { routePolicyFor } from '../gate/sessionMark';
import { DAY_MS, FIXED_NOW, authorizationFor, deviceKey, fixtureModelsSection, issuerKey, policyDocumentFor, signAuthorization, signerEntry } from './helpers/policyFixtures';
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
function fakeFetch(catalog: { tee?: string[]; cloud?: string[]; local?: string[] }): { fetchFn: typeof fetch; content: string[]; checks: string[] } {
  const content: string[] = [];
  // The background connection check of a NEAR AI Cloud client (plan 25) asks for an attestation report; it carries no content and is counted apart.
  const checks: string[] = [];
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
    if (method === 'GET' && new URL(url).pathname.endsWith('/attestation/report')) {
      checks.push(`${method} ${new URL(url).pathname}`);
      return new Response('{}', { status: 404 });
    }
    content.push(`${method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, content, checks };
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
  // The two NEAR AI Cloud clients asked for an attestation report in the background (no content), and nothing else was sent.
  assert.ok(fake.checks.length >= 1 && fake.checks.every((check) => check === 'GET /v1/attestation/report'), fake.checks.join(', '));
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
  // 74.1-07: the research workspace sends each message inside its research-lane route.
  'src/services/researchWorkspace.ts': { self: true },
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

/** What the scan knows about AgentRun (src/agent/loop.ts): the methods run() reaches, and the options (hooks) those methods read. */
interface ScanContext {
  /** Set only while reading loop.ts itself: an AgentRun method counts as inside the run's route only when run() reaches it. */
  readonly agentRunReached?: ReadonlySet<string>;
  /** The AgentRun options that a method run() reaches reads (`this.options.<name>`): only a function given under one of these names is called by the run. */
  readonly hooks: ReadonlySet<string>;
}

const LOOP_FILE = 'src/agent/loop.ts';

/** The methods of a class declared in the file, by name. */
function classMethods(source: ts.SourceFile, className: string): Map<string, ts.MethodDeclaration> {
  const out = new Map<string, ts.MethodDeclaration>();
  for (const declaration of nodesOf(source, (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === className)) {
    for (const member of declaration.members) if (ts.isMethodDeclaration(member)) out.set(member.name.getText(source), member);
  }
  return out;
}

/** The methods of `className` reached from `start`, following every `this.<method>` (a call or a reference handed on) from a method already reached. */
function reachedMethods(source: ts.SourceFile, className: string, start: string): Set<string> {
  const methods = classMethods(source, className);
  const reached = new Set<string>();
  const queue = methods.has(start) ? [start] : [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (reached.has(name)) continue;
    reached.add(name);
    const body = methods.get(name)!;
    for (const access of nodesOf(body, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)) {
      const next = access.name.text;
      if (methods.has(next) && !reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

/** The options the reached AgentRun methods read (`this.options.<name>`). */
function hooksRead(source: ts.SourceFile, reached: ReadonlySet<string>): Set<string> {
  const methods = classMethods(source, 'AgentRun');
  const out = new Set<string>();
  for (const name of reached) {
    const body = methods.get(name);
    if (body === undefined) continue;
    for (const access of nodesOf(body, (node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ThisKeyword && node.expression.name.text === 'options')) out.add(access.name.text);
  }
  return out;
}

/**
 * Whether a node runs only inside a session route, by the shape of the code around it:
 * (a) it is inside the work given to withSessionRoute (any argument after the route);
 * (b) it is inside a function kept in a local name whose every use is the work given to withSessionRoute;
 * (c) it is inside a hook of `new AgentRun({ ... })` under a name that a method run() reaches reads (beforeTurn and the rest), so the run calls it only
 *     from run(), whose own call is checked; a function under any other name is not a hook (PR #81 review);
 * (d) it is inside a method of the file's class whose every `this.<method>(` call is itself covered;
 * (e) in loop.ts only, it is inside a method of AgentRun that run() reaches (PR #81 review: not every method, since a public one could be called from outside).
 */
function wrappedIn(source: ts.SourceFile, node: ts.Node, context: ScanContext, seen: ReadonlySet<string> = new Set()): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined) {
    if (isWithSessionRoute(parent) && parent.arguments.indexOf(child as ts.Expression) >= 1) return true;
    if (isFunctionLike(child)) {
      if (ts.isVariableDeclaration(parent) && parent.initializer === child && onlyHandedToWithSessionRoute(source, parent)) return true;
      if (ts.isPropertyAssignment(parent) && ts.isObjectLiteralExpression(parent.parent) && ts.isNewExpression(parent.parent.parent)
        && parent.parent.parent.expression.getText(source) === 'AgentRun' && context.hooks.has(parent.name.getText(source))) return true;
    }
    if (ts.isMethodDeclaration(child) && ts.isClassDeclaration(parent)) {
      const name = child.name.getText(source);
      if (context.agentRunReached !== undefined && parent.name?.text === 'AgentRun') return context.agentRunReached.has(name);
      if (seen.has(name)) return false;
      const calls = nodesOf(source, (each): each is ts.CallExpression => ts.isCallExpression(each) && each.expression.getText(source) === `this.${name}`);
      const next = new Set([...seen, name]);
      return calls.length > 0 && calls.every((call) => wrappedIn(source, call, context, next));
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

/** The top-level functions of a file reached from `start`, following every name of another top-level function used in a body already reached. */
function reachedFunctions(source: ts.SourceFile, start: string): Set<ts.FunctionDeclaration> {
  const functions = new Map<string, ts.FunctionDeclaration>();
  for (const statement of source.statements) if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) functions.set(statement.name.text, statement);
  const reached = new Set<ts.FunctionDeclaration>();
  const queue = functions.has(start) ? [functions.get(start)!] : [];
  while (queue.length > 0) {
    const fn = queue.shift()!;
    if (reached.has(fn)) continue;
    reached.add(fn);
    for (const id of nodesOf(fn, (node): node is ts.Identifier => ts.isIdentifier(node))) {
      const next = functions.get(id.text);
      if (next !== undefined && !reached.has(next)) queue.push(next);
    }
  }
  return reached;
}

function within(node: ts.Node, container: ts.Node): boolean {
  return node.getStart() >= container.getStart() && node.getEnd() <= container.getEnd();
}

/** The class in `file` that has a method named after a dotted entry's last part (`run.run` names AgentRun.run), if any. */
function entryClass(source: ts.SourceFile, via: string): { readonly name: string; readonly method: string } | undefined {
  const method = via.split('.').pop() ?? '';
  for (const declaration of nodesOf(source, (node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name !== undefined)) {
    if (declaration.members.some((member) => ts.isMethodDeclaration(member) && member.name.getText(source) === method)) return { name: declaration.name!.text, method };
  }
  return undefined;
}

/** The names a file calls `via` (a function exported by `target`) under: the name itself, an alias it was imported as, or `<namespace>.<name>`. */
function namesFor(source: ts.SourceFile, from: string, target: string, via: string): string[] {
  const names = new Set<string>([via]);
  for (const declaration of nodesOf(source, (node): node is ts.ImportDeclaration => ts.isImportDeclaration(node))) {
    if (!ts.isStringLiteral(declaration.moduleSpecifier)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), declaration.moduleSpecifier.text));
    if (`${resolved}.ts` !== target) continue;
    const bindings = declaration.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.add(`${bindings.name.text}.${via}`);
    else for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === via) names.add(element.name.text);
  }
  return [...names];
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
  const reached = reachedMethods(tree(LOOP_FILE), 'AgentRun', 'run');
  const hooks = hooksRead(tree(LOOP_FILE), reached);
  const contextFor = (file: string): ScanContext => (file === LOOP_FILE ? { agentRunReached: reached, hooks } : { hooks });
  const identifierEntries = new Set<string>();
  for (const placement of Object.values(sites)) if ('inside' in placement) for (const entry of placement.inside) for (const via of entry.via) if (!via.includes('.')) identifierEntries.add(via);
  for (const file of sources.keys()) {
    if (file === CLIENT_FILE || requestCalls(tree(file)).length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(sites, file)) out.push(`${file} calls a model request method and is not on the list of request sites`);
  }
  for (const [file, placement] of Object.entries(sites)) {
    const text = sources.get(file);
    if (text === undefined || requestCalls(tree(file)).length === 0) { out.push(`${file} is listed but makes no model request (remove it)`); continue; }
    if ('self' in placement) {
      for (const call of requestCalls(tree(file))) if (!wrappedIn(tree(file), call, contextFor(file))) out.push(`${file}:${lineOf(tree(file), call)} makes a model request outside withSessionRoute`);
    }
    if ('inside' in placement) {
      const callers = new Set(placement.inside.map((entry) => entry.caller));
      // The file's own requests: each one must be inside what an entry reaches (a function named by it and what that calls, or the methods a class's entry
      // method reaches), so a new export of the file that requests directly is caught. An entry the file does not declare (a tool's run) is left to its own scan.
      let ownChecked = false;
      for (const entry of placement.inside) {
        for (const via of entry.via) {
          if (ownChecked) break;
          const own = tree(file);
          const owner = via.includes('.') ? entryClass(own, via) : undefined;
          const containers: ts.Node[] = owner !== undefined
            ? [...reachedMethods(own, owner.name, owner.method)].map((name) => classMethods(own, owner.name).get(name)!).filter(Boolean)
            : !via.includes('.') ? [...reachedFunctions(own, via)] : [];
          if (containers.length === 0) continue;
          ownChecked = true;
          for (const call of requestCalls(own)) if (!containers.some((container) => within(call, container))) out.push(`${file}:${lineOf(own, call)} makes a model request that ${via} does not reach`);
          // Whoever makes the class an entry runs must be a listed caller: a new module that builds its own and runs it is outside every route.
          if (owner !== undefined) {
            for (const other of sources.keys()) {
              if (other === file || callers.has(other)) continue;
              for (const made of nodesOf(tree(other), (node): node is ts.NewExpression => ts.isNewExpression(node) && node.expression.getText(tree(other)) === owner.name)) {
                if (importsModule(sources.get(other) ?? '', other, file)) out.push(`${other}:${lineOf(tree(other), made)} makes an ${owner.name} (${file}) and is not a listed caller`);
              }
            }
          }
        }
      }
      for (const entry of placement.inside) {
        const caller = tree(entry.caller);
        if (entry.imports && !importsModule(sources.get(entry.caller) ?? '', entry.caller, file)) out.push(`${entry.caller} does not import ${file}`);
        for (const via of entry.via) {
          const sitesOf = entrySites(caller, via);
          if (sitesOf.length === 0) out.push(`${entry.caller} never reaches ${via} (update the list)`);
          for (const site of sitesOf) {
            if (!wrappedIn(caller, site, contextFor(entry.caller))) out.push(`${entry.caller}:${lineOf(caller, site)} reaches ${via} (${file}) outside withSessionRoute`);
          }
        }
      }
      // A function entry is checked wherever it is called (PR #81 review): every call of it, under any name it was imported as, in a file that is not one of
      // its listed callers must be wrapped, or be inside a function that is itself a listed entry.
      for (const via of new Set(placement.inside.flatMap((entry) => entry.via).filter((each) => !each.includes('.')))) {
        for (const other of sources.keys()) {
          if (other === file || callers.has(other)) continue;
          const source = tree(other);
          const names = namesFor(source, other, file, via);
          for (const call of nodesOf(source, (node): node is ts.CallExpression => ts.isCallExpression(node) && names.includes(node.expression.getText(source)))) {
            if (wrappedIn(source, call, contextFor(other))) continue;
            const enclosing = nodesOf(source, (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name !== undefined && identifierEntries.has(node.name.text)).some((fn) => within(call, fn));
            if (!enclosing) out.push(`${other}:${lineOf(source, call)} reaches ${via} (${file}) outside withSessionRoute`);
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

test('CLAS-06: a request entry is checked wherever it is reached, an AgentRun method counts only when run() reaches it, and only a hook the run calls counts as wrapped', () => {
  const sources = productionSources();
  const planted = new Map(sources);
  const with_ = (file: string, extra: string): void => { planted.set(file, `${sources.get(file) ?? ''}\n${extra}\n`); };
  const loop = sources.get('src/agent/loop.ts') ?? '';
  assert.ok(loop.includes('  public async run(messages'), 'AgentRun.run is where the planted methods go');
  // An AgentRun method nothing in run() reaches: a model call, a tool run and the safety check made there are outside every session route.
  planted.set('src/agent/loop.ts', loop.replace('  public async run(messages', [
    '  public async plantedSummary(messages: AgentMessage[], signal: AbortSignal): Promise<unknown> { return this.options.client.streamCompletion(this.options.model, messages, [], signal); }',
    '  public async plantedTool(tool: AgentTool<any>, context: ToolContext): Promise<unknown> { return tool.run({}, context); }',
    '  public plantedSafety(): unknown { return this.options.safety; }',
    '  public async run(messages'
  ].join('\n')));
  // A new module that calls a request entry directly, with and without an alias, and one that runs an AgentRun of its own.
  planted.set('src/services/plantedAttach.ts', "import { prepareAttachments } from '../agent/attachments';\nexport function go() { return prepareAttachments([], {} as never); }");
  planted.set('src/services/plantedCompact.ts', "import { compactConversation as squeeze } from '../agent/context';\nexport function go() { return squeeze({} as never, 'm', [], new AbortController().signal); }");
  planted.set('src/services/plantedRun.ts', "import { AgentRun } from '../agent/loop';\nexport function go() { return new AgentRun({} as never).run([], new AbortController().signal); }");
  // A function in `new AgentRun({ ... })` under a name the run never calls is not a hook, so it is not inside the run's route.
  with_('src/services/agentSession.ts', 'export function plantedHook() { return new AgentRun({ notAHook: async () => compactConversation({} as never, \'m\', [], new AbortController().signal) } as never); }');
  const found = siteViolations(planted, REQUEST_SITES);
  const has = (pattern: RegExp): boolean => found.some((line) => pattern.test(line));
  assert.ok(has(/^src\/agent\/loop\.ts:\d+ makes a model request that run\.run does not reach/), found.join('\n'));
  assert.ok(has(/^src\/agent\/loop\.ts:\d+ reaches tool\.run \(src\/agent\/extraTools\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/agent\/loop\.ts:\d+ reaches this\.options\.safety \(src\/agent\/safetyModel\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/plantedAttach\.ts:\d+ reaches prepareAttachments \(src\/agent\/attachments\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/plantedCompact\.ts:\d+ reaches compactConversation \(src\/agent\/context\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.ok(has(/^src\/services\/plantedRun\.ts:\d+ makes an AgentRun \(src\/agent\/loop\.ts\) and is not a listed caller/), found.join('\n'));
  assert.ok(has(/^src\/services\/agentSession\.ts:\d+ reaches compactConversation \(src\/agent\/context\.ts\) outside withSessionRoute/), found.join('\n'));
  assert.equal(found.length, 7, found.join('\n'));
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
  // Plan 22: the chat's mark starts at the project's resolved label (here the policy's default label, org/Public), never at an empty mark.
  assert.deepEqual(parent[0]!.route!.markOf().map((label) => `${label.scale}/${label.level}`), ['org/Public'], 'the chat starts at the project\'s label');
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

test('CLAS-06 ordering: a refused request leaves the spend ledger untouched, takes no cooldown probe slot and is not held by a cooling model', async () => {
  let limitChecks = 0;
  let began = 0;
  const spend: SpendSink = {
    begin: () => { began += 1; return () => undefined; },
    limitReached: () => { limitChecks += 1; return undefined; },
    attach: () => undefined
  };
  let cools = true;
  let clock = 1_000_000;
  const fake = fakeFetch({ tee: ['tee-model'] });
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'k', route: 'near', spend, now: () => clock, fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
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
  // The client's only request slot is the one probe a model gets after its cooldown (admit). Once the cooldown is over, a refused request must not have
  // taken it: the next allowed request is that probe and is sent at once, rather than waiting on a probe that never settles.
  clock += 120_000;
  await assert.rejects(() => withSessionRoute(routeAt([org('Restricted')]), () => ask(client, 'tee-model')), RouteRefusedError);
  const probe = withSessionRoute(routeAt([]), () => ask(client, 'tee-model'));
  const settled = await Promise.race([probe.then(() => 'sent'), new Promise((resolve) => setTimeout(() => resolve('held'), 2000))]);
  assert.equal(settled, 'sent', 'the probe slot was free');
  assert.equal(fake.content.length, 1);
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

test('Team Studio asks the gate host for its runtime once per panel and folder, not before each model call', async () => {
  const text = readFileSync(path.join(REPO, 'src/services/teamStudioPanel.ts'), 'utf8');
  const deps = text.slice(text.indexOf('async function teamAiDeps'), text.indexOf('export async function openTeamStudio'));
  assert.ok(deps.length > 0);
  assert.ok(!deps.includes('.runtimeFor('), 'no runtime is asked of the host inside a model call');
  const open = text.slice(text.indexOf('export async function openTeamStudio'));
  assert.equal(open.match(/runtimePerRoot\(/g)?.length, 1, 'the panel makes one resolver when it opens');
  // The resolver itself: one host call per folder, however many model calls ask, and a slow start is waited for once.
  const { runtimePerRoot } = await import('../gate/host');
  let asked = 0;
  const slowHost = { runtimeFor: async () => { asked += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return testGateRuntime(); } };
  const resolve = runtimePerRoot(slowHost, (root) => ({ root, actor: { kind: 'person', sessionId: 'team-studio' }, presence: 'person', context: 'interactive' }));
  const started = Date.now();
  await Promise.all([resolve('/work/a'), resolve('/work/a'), resolve('/work/a')]);
  await resolve('/work/a');
  assert.equal(asked, 1);
  assert.ok(Date.now() - started < 1000);
  await resolve('/work/b');
  assert.equal(asked, 2, 'another folder has its own runtime');
  assert.equal(await runtimePerRoot(undefined, () => ({ actor: { kind: 'person', sessionId: 's' }, presence: 'person', context: 'interactive' }))('/work/a'), undefined, 'no host, no runtime');
});

test('the lists of content and non-content paths cannot be changed by a caller', () => {
  for (const list of [CONTENT_PATHS, BILLABLE_PATHS, NON_CONTENT_POST_PATHS]) {
    const before = [...(list as Iterable<string>)];
    const asSet = list as unknown as Partial<Set<string>>;
    for (const change of [() => asSet.add?.('/models'), () => asSet.delete?.('/chat/completions'), () => asSet.clear?.(), () => Set.prototype.add.call(list, '/models')]) {
      try { change(); } catch { /* refused, as it should be */ }
    }
    assert.deepEqual([...(list as Iterable<string>)], before, 'unchanged');
    assert.equal(list.has('/models'), false);
    assert.ok(Object.isFrozen(list));
  }
  assert.equal(needsRouteCheck('/chat/completions', 'POST'), true);
  assert.equal(needsRouteCheck('/billing/costs', 'POST'), false, 'the non-content list still works');
});

// ---- Phase 41 (41-13, D-36, D-10): the effective policy reaches decideRoute at the client's one choke point ----

const POLICY_NOW = FIXED_NOW;

/** The parsed list of places of a test policy, sorted by id. */
function placesOf(...entries: Array<Record<string, unknown>>): readonly PolicyEndpoint[] {
  const parsed = parseEndpoints([...entries].sort((a, b) => (String(a['id']) < String(b['id']) ? -1 : 1)), SCALE_PRESETS);
  assert.equal(parsed.ok, true, parsed.ok ? '' : `${parsed.reason} ${parsed.path}`);
  if (!parsed.ok) throw new Error('unreachable');
  return parsed.value;
}

/** A route policy as the host gives it: the effective policy's inputs and the version every record of the request names. */
function routePolicyOf(overrides: Partial<RoutePolicy> = {}, policyVersion: PolicyRecordVersion = 'bundle-2'): RoutePolicy & { readonly policyVersion: PolicyRecordVersion } {
  return { endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: POLICY_NOW, policyVersion, ...overrides };
}

const MODELS_CA = { id: 'models-ca', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Internal'] };
const ORG_SERVER = 'https://models.example.org/v1';

/** A route at `mark` whose policy names `localHosts` as local, with the route policy `routePolicy` gives, recording into `records`. */
function policyRoute(mark: Mark, records: DecisionRecord[], routePolicy: SessionRoute['routePolicy'], localHosts: readonly string[] = ['models.example.org'], extra: Partial<SessionRoute> = {}): SessionRoute {
  const state = testBundleState();
  if (state.state !== 'valid') throw new Error('unreachable');
  const changed = { ...state, bundle: { ...state.bundle, routing: { ...state.bundle.routing, localHosts } } };
  return recordingRoute(mark, records, { bundleState: () => changed, ...(routePolicy === undefined ? {} : { routePolicy }), ...extra });
}

async function serverClient(baseUrl = ORG_SERVER, options: Partial<NearAiClientOptions> = {}): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ local: ['local-model'] });
  const client = new NearAiClient({ baseUrl, apiKey: '', fetchFn: fake.fetchFn, route: 'local', ...options });
  await client.listLocalModels();
  return { client, content: fake.content };
}

const versionOf = (record: DecisionRecord | undefined): string | undefined => record?.authorizations[0]?.policy.version;
const ruleOf = (record: DecisionRecord | undefined): string | undefined => record?.authorizations[0]?.policy.name;

test('41-13 tracer: your organization\'s list of places reaches the client, and org Confidential to a place whose ceiling is org Internal is refused before it is sent', async () => {
  const records: DecisionRecord[] = [];
  const server = await serverClient();
  const policy = routePolicyOf({ endpoints: placesOf(MODELS_CA) });
  await assert.rejects(
    () => withSessionRoute(policyRoute([org('Confidential')], records, () => policy), () => ask(server.client, 'local-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.endpoint-ceiling' && error.message === ROUTE_REFUSALS['route.endpoint-ceiling']
  );
  assert.equal(server.content.length, 0, 'the counting fetch saw no content request');
  assert.equal(records.length, 1);
  assert.equal(ruleOf(records[0]), 'route.endpoint-ceiling');
  assert.equal(versionOf(records[0]), 'bundle-2');
  assert.equal(validateDecisionRecord(records[0]).ok, true);
});

test('41-13: the same place carries org Internal and its record names bundle-2; with no route policy, or one that gives none, the request is decided as before (bundle-1)', async () => {
  const records: DecisionRecord[] = [];
  const server = await serverClient();
  const policy = routePolicyOf({ endpoints: placesOf(MODELS_CA) });
  assert.equal((await withSessionRoute(policyRoute([org('Internal')], records, () => policy), () => ask(server.client, 'local-model'))).text, 'ok');
  assert.equal(server.content.length, 1);
  assert.equal(versionOf(records[0]), 'bundle-2');
  assert.equal(ruleOf(records[0]), 'route.attested-cloud');
  // No route policy: org Confidential goes to the named host as the safety patch decided it.
  assert.equal((await withSessionRoute(policyRoute([org('Confidential')], records, undefined), () => ask(server.client, 'local-model'))).text, 'ok');
  assert.equal(versionOf(records[1]), 'bundle-1');
  // A route policy that gives none: the same.
  assert.equal((await withSessionRoute(policyRoute([org('Confidential')], records, () => undefined), () => ask(server.client, 'local-model'))).text, 'ok');
  assert.equal(versionOf(records[2]), 'bundle-1');
  assert.equal(server.content.length, 3);
  // A route policy that throws is a route that cannot be worked out: refused, recorded, nothing sent.
  await assert.rejects(() => withSessionRoute(policyRoute([org('Internal')], records, () => { throw new Error('unreadable'); }), () => ask(server.client, 'local-model')), (error: unknown) => error instanceof RouteRefusedError && error.message === ROUTE_CHECK_FAILED_TEXT);
  assert.equal(server.content.length, 3);
  for (const record of records) assert.equal(validateDecisionRecord(record).ok, true);
});

/** The layers the host holds, for the pure policyVersionOf and routePolicyFor. */
function layersOf(options: { organization?: PolicyDocument; personal?: PolicyDocument; stored?: unknown; effective?: PolicyDocument; failed?: boolean }): PolicyLayersView {
  const organization: PolicyLayersView['organization'] = options.failed === true
    ? { state: 'failed', reason: 'bad-signature', sentence: 'Your organization\'s rules could not be checked.' }
    : options.organization === undefined
      ? { state: 'none' }
      : {
        state: 'valid', document: options.organization, hash: 'a'.repeat(64), issuerPublicKey: options.organization.issuer.publicKey, fingerprintHex: '0'.repeat(64),
        contacts: [], issuedAt: options.organization.issuedAt, expiresAt: options.organization.expiresAt, endsSoon: false
      };
  return {
    organization,
    ...(options.personal === undefined ? {} : { personal: { document: options.personal, hash: 'b'.repeat(64), stored: options.stored ?? { bundleVersion: 1 } } }),
    ...(options.effective === undefined ? {} : { effective: options.effective }),
    ignored: [],
    migration: [],
    ...(options.failed === true ? { failedLayer: 'organization' as const } : {})
  };
}

test('41-13: policyVersionOf says bundle-2 for your organization\'s layer or a stored version 2 personal layer, and bundle-1 for the starting rules or a failed-closed state', () => {
  const device = deviceKey('route-version');
  const issuer = issuerKey('route-version');
  const personal = policyDocumentFor({ key: device });
  const organization = policyDocumentFor({ key: issuer, layer: 'organization' });
  assert.equal(policyVersionOf(layersOf({ personal, effective: personal })), 'bundle-1', 'the starting rules (a version 1 personal layer)');
  assert.equal(policyVersionOf(layersOf({ personal, effective: personal, stored: { bundleVersion: 2 } })), 'bundle-2', 'a stored version 2 personal layer');
  assert.equal(policyVersionOf(layersOf({ personal, organization, effective: personal })), 'bundle-2', 'a valid organization layer');
  assert.equal(policyVersionOf(layersOf({ personal, failed: true })), 'bundle-1', 'a failed-closed state');
  assert.equal(policyVersionOf(layersOf({ personal, effective: personal, stored: { bundleVersion: 2 }, failed: true })), 'bundle-1', 'a failed organization layer never says bundle-2');
  assert.equal(policyVersionOf({ organization: { state: 'none' }, ignored: [], migration: [] }), 'bundle-1', 'no layers read yet');
});

test('41-13: routePolicyFor gives nothing without an effective policy, and verifies each authorization against one key source: your organization\'s signers, or this device alone', () => {
  const device = deviceKey('route-policy');
  const issuer = issuerKey('route-policy');
  const stranger = deviceKey('route-policy-stranger');
  const personal = policyDocumentFor({ key: device });
  assert.equal(routePolicyFor(layersOf({ personal }), POLICY_NOW, device.fingerprint, 'bundle-1'), undefined, 'no effective policy');
  assert.equal(routePolicyFor(layersOf({ personal, failed: true }), POLICY_NOW, device.fingerprint, 'bundle-1'), undefined, 'a failed-closed state');
  const accredited = (id: string, key: PayloadSigner) => signAuthorization(authorizationFor({ kind: 'accredited-device', id, subject: { device: device.fingerprint } }), key);
  // Your organization's layer: only its signers count, never this device.
  const organization = { ...policyDocumentFor({ key: issuer, layer: 'organization' }), people: { v: 1, clearances: [], signers: [signerEntry(issuer)] } } as unknown as PolicyDocument;
  const effective = {
    ...personal,
    authorizations: [accredited('by-officer', issuer), accredited('by-this-device', device), accredited('by-stranger', stranger)],
    agents: { ...personal.agents, requireAccreditedDevice: true },
    endpoints: [],
    people: { v: 1, clearances: [{ scale: 'org', level: 'Confidential', compartments: [] }] }
  } as unknown as PolicyDocument;
  const underOrganization = routePolicyFor(layersOf({ personal, organization, effective }), POLICY_NOW, device.fingerprint, 'bundle-2');
  assert.ok(underOrganization !== undefined);
  assert.deepEqual(underOrganization.authorizations.map((found) => [found.body.id, found.selfSigned]), [['by-officer', false]]);
  assert.equal(underOrganization.organization, true);
  assert.equal(underOrganization.requireAccreditedDevice, true);
  assert.equal(underOrganization.deviceId, device.fingerprint);
  assert.equal(underOrganization.policyVersion, 'bundle-2');
  assert.equal(underOrganization.project, undefined, 'a route does not know its project: a project-scoped authorization covers nothing (D-54)');
  assert.deepEqual(underOrganization.clearances, [{ scale: 'org', level: 'Confidential', compartments: [] }]);
  assert.equal(underOrganization.now, POLICY_NOW);
  // No organization layer: this device alone, and what it signed is self-signed (D-15).
  const alone = routePolicyFor(layersOf({ personal, effective }), POLICY_NOW, device.fingerprint, 'bundle-1');
  assert.ok(alone !== undefined);
  assert.deepEqual(alone.authorizations.map((found) => [found.body.id, found.selfSigned]), [['by-this-device', true]]);
  assert.equal(alone.organization, false);
  assert.equal(alone.policyVersion, 'bundle-1');
  // An expired authorization is left out.
  const expired = { ...effective, authorizations: [signAuthorization(authorizationFor({ kind: 'accredited-device', id: 'old', subject: { device: device.fingerprint }, days: 1 }), device)] } as unknown as PolicyDocument;
  assert.deepEqual(routePolicyFor(layersOf({ personal, effective: expired }), POLICY_NOW + 2 * DAY_MS, device.fingerprint, 'bundle-1')?.authorizations, []);
});

test('41-13: the gate host gives each runtime and its route for requests outside every session a route policy from its own layers', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-policy-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.40-test' });
  await host.start();
  const outside = host.sessionRouteWithoutContext().routePolicy?.(host.now());
  assert.ok(outside !== undefined, 'the starting rules are an effective policy');
  assert.equal(outside.policyVersion, 'bundle-1');
  assert.equal(outside.organization, false);
  const runtime = await host.runtimeFor({ actor: { kind: 'agent', sessionId: 'route-policy', agentLabel: 'agent' }, presence: 'person', context: 'interactive' });
  assert.equal(runtime.routePolicy?.(host.now())?.policyVersion, 'bundle-1');
  // A session route made from the runtime carries the runtime's route policy.
  assert.equal(sessionRouteFrom(runtime).routePolicy, runtime.routePolicy);
  await host.flush();
});

test('WR-02: a route policy the host cannot work out is a failed check: the request is refused (route.deny) and recorded, never decided without the policy', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-route-policy-throws-'));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.40-test' });
  await host.start();
  const local = await localClient();
  const records: DecisionRecord[] = [];
  const route = (): SessionRoute => ({ ...host.sessionRouteWithoutContext(), sink: { record: (record) => { records.push(record); } } });
  // The allowed side: with layers the host can read, a request for a model on this computer goes.
  assert.equal((await withSessionRoute(route(), () => ask(local.client, 'local-model'))).text, 'ok');
  assert.equal(local.content.length, 1);
  // Layers that throw when read: the route policy throws rather than giving none, which would decide as if no policy existed.
  Object.defineProperty(host, 'policyLayers', { configurable: true, value: () => { throw new Error('unreadable layers'); } });
  try {
    assert.throws(() => host.sessionRouteWithoutContext().routePolicy?.(host.now()), /unreadable layers/);
    const runtime = await host.runtimeFor({ actor: { kind: 'agent', sessionId: 'route-policy-throws', agentLabel: 'agent' }, presence: 'person', context: 'interactive' });
    assert.throws(() => runtime.routePolicy?.(host.now()), /unreadable layers/);
    await assert.rejects(
      () => withSessionRoute(route(), () => ask(local.client, 'local-model')),
      (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.deny' && error.message === ROUTE_CHECK_FAILED_TEXT
    );
    assert.equal(local.content.length, 1, 'nothing more was sent');
    assert.equal(ruleOf(records[records.length - 1]), 'route.deny');
    assert.equal(validateDecisionRecord(records[records.length - 1]).ok, true);
  } finally {
    delete (host as unknown as Record<string, unknown>)['policyLayers'];
  }
  await host.flush();
});

// ---- 41-13 Task 3 (D-26, D-33, D-34, D-42): Protected B over the pinned connection, residency and reports through the client ----

const PROTECTED_B: Label = { scale: 'ca-protected', level: 'Protected B', compartments: [], releasability: [], handling: [] };
const SECRET: Label = { scale: 'ca-classified', level: 'Secret', compartments: [], releasability: [], handling: [] };

/** A SHA-256 hex made at test time from a word, the shape of a TLS pin; never a written key. */
function pinOf(word: string): string {
  return createHash('sha256').update(word, 'utf8').digest('hex');
}

// A place's pins are kept sorted.
const [PIN_ONE, PIN_TWO] = [pinOf('pin-one'), pinOf('pin-two')].sort() as [string, string];
const MODELS_PB = { id: 'models-pb', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [PIN_ONE, PIN_TWO], region: 'CA', maxLabel: ['ca-protected/Protected B', 'org/Internal'] };
const DEVICE_ID = 'dev-0123456789abcdef0123456789abcdef';

/** A verified authorization as the host hands it to the decision (the signature was checked by routePolicyFor). */
function verified(body: ReturnType<typeof authorizationFor>, selfSigned = false): VerifiedAuthorization {
  return { body, selfSigned };
}

const PROTECTED_B_ON_MODELS_PB = verified(authorizationFor({ kind: 'protected-b', id: 'pb-models', subject: { endpoint: 'models-pb' }, scope: { labels: ['ca-protected/Protected B'] } }));

/** A server client whose pinned fetch is the hook's: every pin list asked for is kept, and the content the hook's fetch carried is counted apart. */
async function pinnedServerClient(hookFetch?: (pins: readonly string[]) => typeof fetch): Promise<{ client: NearAiClient; plain: string[]; pinned: string[]; asked: string[][] }> {
  const plain = fakeFetch({ local: ['local-model'] });
  const viaPin = fakeFetch({ local: ['local-model'] });
  const asked: string[][] = [];
  const client = new NearAiClient({
    baseUrl: ORG_SERVER, apiKey: '', fetchFn: plain.fetchFn, route: 'local',
    pinnedFetchFor: (pins) => { asked.push([...pins]); return hookFetch?.(pins) ?? viaPin.fetchFn; }
  });
  await client.listLocalModels();
  return { client, plain: plain.content, pinned: viaPin.content, asked };
}

test('41-13 D-26: Protected B to your organization\'s server goes only through a connection pinned to that place\'s TLS pins, never the plain fetch', async () => {
  const records: DecisionRecord[] = [];
  const server = await pinnedServerClient();
  const policy = routePolicyOf({ endpoints: placesOf(MODELS_PB), authorizations: [PROTECTED_B_ON_MODELS_PB] });
  assert.equal((await withSessionRoute(policyRoute([PROTECTED_B], records, () => policy), () => ask(server.client, 'local-model'))).text, 'ok');
  assert.deepEqual(server.asked, [[PIN_ONE, PIN_TWO]], 'exactly the place\'s pins');
  assert.equal(server.pinned.length, 1, 'the content went over the pinned connection');
  assert.equal(server.plain.length, 0, 'never over the plain fetch');
  assert.equal(ruleOf(records[0]), 'route.local-only');
});

test('41-13 D-26: without an authorization naming the place, Protected B is refused before fetch (route.authorization-missing) and recorded', async () => {
  const records: DecisionRecord[] = [];
  const server = await pinnedServerClient();
  const policy = routePolicyOf({ endpoints: placesOf(MODELS_PB) });
  await assert.rejects(() => withSessionRoute(policyRoute([PROTECTED_B], records, () => policy), () => ask(server.client, 'local-model')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.authorization-missing');
  assert.equal(server.plain.length + server.pinned.length, 0);
  assert.deepEqual(server.asked, []);
  assert.equal(ruleOf(records[0]), 'route.authorization-missing');
  assert.equal(versionOf(records[0]), 'bundle-2');
});

test('41-13 D-26: a connection that matches none of the pins is refused (route.endpoint-pin) with a refusal record, and nothing was sent', async () => {
  const records: DecisionRecord[] = [];
  const tried: string[] = [];
  const server = await pinnedServerClient((pins) => pinnedFetchAny(pins, (pin) => (async () => { tried.push(pin); throw new ConnectionNotBoundError('The server presented another key, so nothing was sent.'); }) as typeof fetch));
  const policy = routePolicyOf({ endpoints: placesOf(MODELS_PB), authorizations: [PROTECTED_B_ON_MODELS_PB] });
  await assert.rejects(
    () => withSessionRoute(policyRoute([PROTECTED_B], records, () => policy), () => ask(server.client, 'local-model')),
    (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.endpoint-pin' && error.message === ROUTE_REFUSALS['route.endpoint-pin']
  );
  assert.deepEqual(tried, [PIN_ONE, PIN_TWO], 'every pin was tried, in order');
  assert.equal(server.plain.length + server.pinned.length, 0, 'nothing was sent');
  const refusal = records.find((record) => ruleOf(record) === 'route.endpoint-pin');
  assert.ok(refusal !== undefined, 'the refusal is recorded');
  // The record keeps the sentence, cut to the record's length for a reason.
  assert.ok((refusal.status_detail ?? '').length > 40 && ROUTE_REFUSALS['route.endpoint-pin'].startsWith(refusal.status_detail ?? ''), refusal.status_detail);
  assert.equal(versionOf(refusal), 'bundle-2');
  assert.equal(validateDecisionRecord(refusal).ok, true);
});

test('41-13 regression: Protected B to an exact https host your rules list with no pin and no authorization, which the safety patch sent, is refused (route.endpoint-pin)', async () => {
  const unpinned = { ...MODELS_PB, tlsPins: [] };
  const records: DecisionRecord[] = [];
  const server = await pinnedServerClient();
  // The safety patch sends it: an exact local-hosts entry over https.
  assert.equal((await withSessionRoute(policyRoute([PROTECTED_B], records, undefined), () => ask(server.client, 'local-model'))).text, 'ok');
  assert.equal(server.plain.length, 1);
  const policy = routePolicyOf({ endpoints: placesOf(unpinned) });
  await assert.rejects(() => withSessionRoute(policyRoute([PROTECTED_B], records, () => policy), () => ask(server.client, 'local-model')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.endpoint-pin');
  assert.equal(server.plain.length + server.pinned.length, 1, 'nothing more was sent');
});

test('41-13: pinnedFetchAny tries the pins in order and moves on only when a connection is not bound; any other error stops at once', async () => {
  const tried: string[] = [];
  const answer = new Response('{}', { status: 200 });
  const second = pinnedFetchAny(['a', 'b', 'c'], (pin) => (async () => {
    tried.push(pin);
    if (pin === 'a') throw new ConnectionNotBoundError('another key');
    return answer;
  }) as typeof fetch);
  assert.equal(await second('https://models.example.org/v1/chat/completions', { method: 'POST' }), answer);
  assert.deepEqual(tried, ['a', 'b'], 'stopped at the first pin that matched');
  tried.length = 0;
  const broken = pinnedFetchAny(['a', 'b'], (pin) => (async () => { tried.push(pin); throw new Error('network down'); }) as typeof fetch);
  await assert.rejects(() => broken('https://models.example.org/v1/chat/completions', { method: 'POST' }), /network down/);
  assert.deepEqual(tried, ['a'], 'another error stops at once');
  tried.length = 0;
  const none = pinnedFetchAny(['a', 'b'], (pin) => (async () => { tried.push(pin); throw new Error('wrapped', { cause: new ConnectionNotBoundError(`mismatch ${pin}`) }); }) as typeof fetch);
  await assert.rejects(() => none('https://models.example.org/v1/chat/completions', { method: 'POST' }), (error: unknown) => (error as Error).message === 'wrapped' && ((error as Error).cause as Error).message === 'mismatch b');
  assert.deepEqual(tried, ['a', 'b'], 'a not-bound cause moves on too; the last error is thrown');
  await assert.rejects(() => pinnedFetchAny([])('https://models.example.org/v1/chat/completions', { method: 'POST' }), ConnectionNotBoundError);
});

test('41-13 D-33: residency through the client: a request to a place in the United States under a Canada-only rule is refused before fetch (route.residency) and recorded', async () => {
  const records: DecisionRecord[] = [];
  const server = await serverClient();
  const residency = parseResidencySection({ v: 1, required: ['CA'] }, SCALE_PRESETS);
  assert.equal(residency.ok, true);
  if (!residency.ok) throw new Error('unreachable');
  const policy = routePolicyOf({ endpoints: placesOf({ ...MODELS_CA, region: 'US' }), residency: residency.value });
  await assert.rejects(() => withSessionRoute(policyRoute([org('Internal')], records, () => policy), () => ask(server.client, 'local-model')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.residency');
  assert.equal(server.content.length, 0);
  assert.equal(ruleOf(records[0]), 'route.residency');
  // The same place in Canada is sent.
  const canada = routePolicyOf({ endpoints: placesOf(MODELS_CA), residency: residency.value });
  assert.equal((await withSessionRoute(policyRoute([org('Internal')], records, () => canada), () => ask(server.client, 'local-model'))).text, 'ok');
});

/** A NEAR AI Cloud client whose binding source holds a fresh bound fact for its host, so attested-cloud requests are sent. */
async function boundNearClient(): Promise<{ client: NearAiClient; content: string[] }> {
  const fake = fakeFetch({ tee: ['tee-model'], cloud: ['cloud-model'] });
  const client = new NearAiClient({
    baseUrl: NEAR, apiKey: 'test-key', fetchFn: fake.fetchFn, route: 'near',
    binding: {
      current: () => ({ state: 'bound', host: NEAR, checkedAt: Date.now() - 60_000, fingerprint: 'ab'.repeat(32) }),
      refresh: async () => ({ state: 'bound', host: NEAR, checkedAt: Date.now(), fingerprint: 'ab'.repeat(32) }),
      markNotBound: () => undefined,
      fetchFor: () => fake.fetchFn
    }
  });
  await client.listModels();
  return { client, content: fake.content };
}

test('41-13 D-42: with a models section, a model with no passport on NEAR AI Cloud is sent and its record says route.passport would refuse', async () => {
  const records: DecisionRecord[] = [];
  const near = await boundNearClient();
  const models = parseModelsSection(fixtureModelsSection(), SCALE_PRESETS);
  assert.equal(models.ok, true);
  if (!models.ok) throw new Error('unreachable');
  const policy = routePolicyOf({ models: models.value, now: Date.now() });
  // The bound fact is read against the system clock, so this route keeps it too.
  const now = { clock: () => Date.now() };
  assert.equal((await withSessionRoute(policyRoute([org('Internal')], records, () => policy, [], now), () => ask(near.client, 'tee-model'))).text, 'ok');
  assert.equal(near.content.length, 1);
  assert.deepEqual(records[0]?.unmapped.nearAi.wouldRefuse, ['route.passport']);
  assert.equal(validateDecisionRecord(records[0]).ok, true);
  // Without a models section the step reports with the shipped passports (74.1 D-12): tee-model has none, so it is reported and still sent.
  assert.equal((await withSessionRoute(policyRoute([org('Internal')], records, () => routePolicyOf({ now: Date.now() }), [], now), () => ask(near.client, 'tee-model'))).text, 'ok');
  // The second request's own record (an answer check after the first may have been recorded in between).
  const requests = records.filter((record) => ruleOf(record) === ruleOf(records[0]));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.unmapped.nearAi.wouldRefuse, ['route.passport']);
});

/** A loopback route at Secret with its own chat state, keeping its records and its chat notices. */
function secretRoute(records: DecisionRecord[], notices: string[], routePolicy: SessionRoute['routePolicy'], attestation = { failed: false }): SessionRoute {
  return policyRoute([SECRET], records, routePolicy, [], { onNotice: (text) => notices.push(text), attestation });
}

const notAccreditedEvents = (records: readonly DecisionRecord[]) => records.filter((record) => ruleOf(record) === 'route.not-accredited');

test('41-13 D-34: Secret on this computer with no accredited-device authorization says the notice once, records route.not-accredited once, and the request\'s record reports route.accredited-device', async () => {
  const records: DecisionRecord[] = [];
  const notices: string[] = [];
  const loopback = await localClient();
  const policy = routePolicyOf({ organization: false, deviceId: DEVICE_ID });
  const chat = { failed: false };
  assert.equal((await withSessionRoute(secretRoute(records, notices, () => policy, chat), () => ask(loopback.client, 'local-model'))).text, 'ok');
  assert.equal((await withSessionRoute(secretRoute(records, notices, () => policy, chat), () => ask(loopback.client, 'local-model'))).text, 'ok');
  assert.equal(notices.length, 1);
  assert.equal(notAccreditedEvents(records).length, 1);
  const requests = records.filter((record) => ruleOf(record) === 'route.local-only');
  assert.equal(requests.length, 2);
  // 74.1 D-12: local-model has no passport, so the passport report stands beside the accredited-device one.
  for (const request of requests) assert.deepEqual(request.unmapped.nearAi.wouldRefuse, ['route.accredited-device', 'route.passport']);
  for (const record of records) assert.equal(validateDecisionRecord(record).ok, true);
});

test('41-13 D-34: with an accredited-device authorization covering this device there is no notice and no event; with your organization\'s switch on and none, Secret is refused', async () => {
  const loopback = await localClient();
  const covered: DecisionRecord[] = [];
  const told: string[] = [];
  const accredited = verified(authorizationFor({ kind: 'accredited-device', id: 'acc-1', subject: { device: DEVICE_ID } }));
  const policy = routePolicyOf({ organization: true, deviceId: DEVICE_ID, authorizations: [accredited] });
  assert.equal((await withSessionRoute(secretRoute(covered, told, () => policy), () => ask(loopback.client, 'local-model'))).text, 'ok');
  assert.deepEqual(told, []);
  assert.deepEqual(notAccreditedEvents(covered), []);
  assert.deepEqual(covered[0]?.unmapped.nearAi.wouldRefuse, ['route.passport'], 'only the passport report of 74.1 D-12 is left');
  // Your organization turns refusal on and no authorization covers this device: refused, nothing sent, no notice.
  const refused: DecisionRecord[] = [];
  const quiet: string[] = [];
  const strict = routePolicyOf({ organization: true, requireAccreditedDevice: true, deviceId: DEVICE_ID });
  await assert.rejects(() => withSessionRoute(secretRoute(refused, quiet, () => strict), () => ask(loopback.client, 'local-model')), (error: unknown) => error instanceof RouteRefusedError && error.rule === 'route.accredited-device');
  assert.equal(ruleOf(refused[0]), 'route.accredited-device');
  assert.deepEqual(quiet, []);
  assert.equal(loopback.content.length, 1);
  // No policy: the safety patch's notice, as before.
  const patch: DecisionRecord[] = [];
  const patchNotices: string[] = [];
  assert.equal((await withSessionRoute(secretRoute(patch, patchNotices, undefined), () => ask(loopback.client, 'local-model'))).text, 'ok');
  assert.equal(patchNotices.length, 1);
  assert.equal(notAccreditedEvents(patch).length, 1);
});
