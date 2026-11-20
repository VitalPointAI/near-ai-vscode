// FND-09, D-43: the provider interface. The chat message types live in the pure folder src/domain/provider, ModelEndpoint says what the agent needs from
// any AI service, and NearAiClient is its first adapter with one new getter (`facts`) and no behaviour change.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import type { SafetyModelClient } from '../agent/safetyModel';
import { DEFAULT_BASE_URL } from '../domain/config';
import type { EndpointFacts, ModelEndpoint } from '../domain/provider/endpoint';
import type { LocalInstallRequest, LocalModelRef, LocalServerAdmin } from '../domain/provider/localServer';
import type { AgentMessage as DomainAgentMessage, CompletionEvent } from '../domain/provider/messages';
import { NearAiClient } from '../services/nearAiClient';
import type { AgentMessage as ClientAgentMessage } from '../services/nearAiClient';
import { newTestRun } from './helpers/gatedRuns';

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const usage = { inputTokens: 3, outputTokens: 2, verificationStatus: 'unknown' as const, latencyMs: 1 };

test('D-43: NearAiClient is a ModelEndpoint', () => {
  const endpoint: ModelEndpoint = new NearAiClient({ baseUrl: DEFAULT_BASE_URL, apiKey: 'k', route: 'near' });
  assert.deepEqual(endpoint.facts, { route: 'near', baseUrl: DEFAULT_BASE_URL, nearEndpoint: true });
  assert.ok(Object.isFrozen(endpoint.facts), 'facts is frozen');
  assert.deepEqual(Object.keys(endpoint.facts).sort(), ['baseUrl', 'nearEndpoint', 'route'], 'facts hold the route, the base URL and a boolean, never the key');

  const local: ModelEndpoint = new NearAiClient({ baseUrl: LOCAL_URL, apiKey: 'k', route: 'local' });
  assert.deepEqual(local.facts, { route: 'local', baseUrl: LOCAL_URL, nearEndpoint: false });
  assert.ok(Object.isFrozen(local.facts));

  const unrouted = new NearAiClient({ baseUrl: LOCAL_URL, apiKey: 'k' });
  const facts: EndpointFacts = unrouted.facts;
  assert.equal(Object.prototype.hasOwnProperty.call(facts, 'route'), false, 'a client built with no route has no route key');
  assert.deepEqual(facts, { baseUrl: LOCAL_URL, nearEndpoint: false });
  assert.ok(Object.isFrozen(facts));
  assert.throws(() => { (facts as { nearEndpoint: boolean }).nearEndpoint = true; }, TypeError, 'a frozen fact cannot be changed');
});

test('D-43: a fake ModelEndpoint drives the agent loop to a finished run', async () => {
  let streamed = 0;
  const fake: ModelEndpoint = {
    facts: Object.freeze({ route: 'local', baseUrl: LOCAL_URL, nearEndpoint: false }),
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      streamed += 1;
      yield { type: 'done', message: { role: 'assistant', content: 'finished by the fake' }, finishReason: 'stop', usage };
    },
    completeOnce: () => Promise.reject(new Error('the loop never asks for a one-shot answer'))
  };
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-endpoint-'));
  const shell = new ShellSession(root);
  const events: AgentEvent[] = [];
  try {
    const run = newTestRun({
      client: fake, model: 'example/model', tools: [],
      context: { root, checkpoints: new RunCheckpoints('endpoint'), shell, readFiles: new Set() },
      policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
      requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event)
    });
    const result = await run.run([{ role: 'user', content: 'say something' }], new AbortController().signal);
    assert.equal(result.outcome, 'completed');
    const last = result.messages[result.messages.length - 1];
    assert.deepEqual(last, { role: 'assistant', content: 'finished by the fake' }, 'the run ends with the assistant text');
    assert.equal(streamed, 1, 'streamCompletion was called once');
  } finally {
    shell.dispose();
  }
});

test('D-43: the moved types are the same types', () => {
  const fromDomain: DomainAgentMessage = { role: 'user', content: 'hello' };
  const asClient: ClientAgentMessage = fromDomain;
  const fromClient: ClientAgentMessage = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] };
  const asDomain: DomainAgentMessage = fromClient;
  assert.equal(asClient, fromDomain);
  assert.equal(asDomain, fromClient);
});

// The scanner of teamBoundaries.test.ts, copied (importing that file would register its tests twice): every static import or re-export, side-effect
// import, dynamic import() and require() with a string specifier, matched from the start of a line so a word in a comment is not an import.
const STATIC_FORM = /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[^;'"]*?\bfrom[ \t]*['"]([^'"\n]+)['"]/gm;
const SIDE_EFFECT_FORM = /^[ \t]*import[ \t]*['"]([^'"\n]+)['"]/gm;
const CALL_FORM = /(?:^|[^\w.$])(?:import|require)[ \t]*\([ \t]*['"]([^'"\n]+)['"]/gm;

function specifiersOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(STATIC_FORM)) found.push(match[3] as string);
  for (const match of text.matchAll(SIDE_EFFECT_FORM)) found.push(match[1] as string);
  for (const match of text.matchAll(CALL_FORM)) found.push(match[1] as string);
  return found;
}

const SRC = path.resolve(__dirname, '..', '..', 'src');
const PROVIDER_FOLDER = path.join(SRC, 'domain', 'provider');

/** The imports of a file in src/domain/provider that reach outside src/domain (a package, the editor, services, agent), as `file: specifier`. */
function providerLeaks(file: string, text: string): string[] {
  const leaks: string[] = [];
  for (const specifier of specifiersOf(text)) {
    if (specifier === 'node:crypto') continue;
    const target = specifier.startsWith('.') ? path.relative(SRC, path.resolve(path.dirname(file), specifier)).split(path.sep).join('/') : undefined;
    if (target === undefined || !(target === 'domain' || target.startsWith('domain/'))) leaks.push(`${path.basename(file)}: ${specifier}`);
  }
  return leaks;
}

test('D-43: the agent and domain state files import the provider types from src/domain/provider', () => {
  for (const relative of ['agent/loop.ts', 'agent/context.ts', 'agent/safetyModel.ts', 'domain/state/threadView.ts', 'domain/state/threadCapture.ts']) {
    const specifiers = specifiersOf(readFileSync(path.join(SRC, relative), 'utf8'));
    assert.deepEqual(specifiers.filter((specifier) => specifier.endsWith('services/nearAiClient')), [], `${relative} imports no type from the NEAR AI client file`);
    assert.ok(specifiers.some((specifier) => /(^|\/)(domain\/provider|provider)\/(messages|endpoint)$/.test(specifier) && path.resolve(path.join(SRC, path.dirname(relative)), specifier).startsWith(PROVIDER_FOLDER)), `${relative} imports from src/domain/provider`);
  }
});

test('src/domain/provider imports only src/domain and no package', () => {
  const files = readdirSync(PROVIDER_FOLDER).filter((name) => name.endsWith('.ts')).map((name) => path.join(PROVIDER_FOLDER, name));
  for (const expected of ['messages.ts', 'endpoint.ts', 'localServer.ts']) assert.ok(files.some((file) => file.endsWith(expected)), `src/domain/provider/${expected} exists`);
  for (const file of files) assert.deepEqual(providerLeaks(file, readFileSync(file, 'utf8')), [], `${path.basename(file)} stays inside src/domain`);

  // Teeth: a planted import of services, an editor import, a package and a dynamic require are each reported; a word in a comment is not.
  const planted = path.join(PROVIDER_FOLDER, 'planted.ts');
  const text = [
    "import { x } from '../../services/chat';",
    "import * as vscode from 'vscode';",
    "import type { Foo } from 'some-package';",
    "const late = require('../../agent/loop');",
    "// import { y } from '../../services/nearAiClient' is only a comment",
    "import type { Label } from '../gate/labels';",
    "import { createHash } from 'node:crypto';"
  ].join('\n');
  assert.deepEqual(providerLeaks(planted, text), ['planted.ts: ../../services/chat', 'planted.ts: vscode', 'planted.ts: some-package', 'planted.ts: ../../agent/loop']);
});

test('D-43: LocalServerAdmin is an interface with kind as data', async () => {
  const installed: LocalModelRef[] = [{ name: 'example-model:7b', sha256: 'a'.repeat(64), sizeBytes: 4_000 }, { name: 'example-small' }];
  const admin: LocalServerAdmin = {
    kind: 'example-server',
    identify: async () => ({ version: '1.2.3' }),
    listInstalled: async () => installed,
    verifyHash: async (name, sha256) => installed.some((model) => model.name === name && model.sha256 === sha256)
  };
  assert.equal(admin.kind, 'example-server', 'kind is a plain string, so a new server needs no change to the interface');
  assert.equal(admin.install, undefined, 'install is optional');
  assert.equal(admin.remove, undefined, 'remove is optional');
  assert.deepEqual(await admin.identify(), { version: '1.2.3' });
  const listed: readonly LocalModelRef[] = await admin.listInstalled();
  assert.deepEqual(listed.map((model) => model.name), ['example-model:7b', 'example-small']);
  assert.equal(await admin.verifyHash('example-model:7b', 'a'.repeat(64)), true);
  assert.equal(await admin.verifyHash('example-model:7b', 'b'.repeat(64)), false, 'a different hash is refused');
  assert.equal(await admin.verifyHash('example-small', 'a'.repeat(64)), false, 'a model with no known hash is refused');
  const request: LocalInstallRequest = { name: 'example-model:7b', sha256: 'a'.repeat(64) };
  assert.deepEqual(Object.keys(request).sort(), ['name', 'sha256']);
});

test('a SafetyModelClient fake written for today\'s shape still compiles', async () => {
  const fake: SafetyModelClient = { async completeOnce() { return { text: '{"allow":false,"reason":"example"}', usage }; } };
  const answer = await fake.completeOnce('example/model', [{ role: 'user', content: 'ls' }], { maxTokens: 10 });
  assert.equal(answer.text, '{"allow":false,"reason":"example"}');
});
