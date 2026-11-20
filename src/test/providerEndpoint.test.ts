// FND-09, D-43: the provider interface. The chat message types live in the pure folder src/domain/provider, ModelEndpoint says what the agent needs from
// any AI service, and NearAiClient is its first adapter with one new getter (`facts`) and no behaviour change.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { DEFAULT_BASE_URL } from '../domain/config';
import type { EndpointFacts, ModelEndpoint } from '../domain/provider/endpoint';
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
