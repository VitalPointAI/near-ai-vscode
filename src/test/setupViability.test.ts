import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import type { ConnectionBindingFact } from '../domain/gate/routing';
import type { ModelEndpoint } from '../domain/provider/endpoint';
import type { ModelInfo } from '../domain/provider/messages';
import { optionIdOf } from '../domain/setup/ids';
import type { OptionCheckInput, OptionSource, ViabilityResult } from '../domain/setup/viability';
import { FLOOR_ON_TEXT, NO_LOCAL_SERVER_TEXT, SERVER_NEEDS_KEY_TEXT, initialViability, isChoosable, nextViability } from '../domain/setup/viability';
import { NearAiClient, SpendLimitError } from '../services/nearAiClient';
import { pinnedFetch } from '../services/connectionBinding';
import { hostKindOf, memoryOnlyDeviceProvider } from '../services/setup/deviceFacts';
import { createIdentify, listServerModels } from '../services/setup/identify';
import { createLocalServersSource } from '../services/setup/localServersOption';
import { createNearAiSource } from '../services/setup/nearAiOption';
import { runTestRequest } from '../services/setup/testRequest';
import { runViability } from '../services/setup/viabilityRunner';
import { currentSpendTag } from '../services/spendLedger';
import { createFakeModelServer, MODEL_TEST_CA, MODEL_TEST_PIN, startFakeModelServer } from './helpers/fakeModelServers';

const NOW = 1_000;
const input: OptionCheckInput = {
  now: () => NOW, hostKind: 'desktop', policyHash: 'example-policy', endpoints: [], candidates: [],
  device: {
    class: 'unknown', platform: 'linux', totalMemoryBytes: 16e9, gpuUsableSource: 'not-measured',
    estimate: false, hostKind: 'desktop', providerId: 'memory-only',
  },
  floorOn: false, identify: async () => ({ state: 'no-answer' }), progress: () => {},
};

async function checkLocal(fake = createFakeModelServer('ollama'), overrides: Partial<OptionCheckInput> = {}, pinFetch?: (pin: string) => typeof fetch) {
  const deps = { fetch: fake.fetch, rows: [fake.row], fetchForPin: pinFetch };
  const source = createLocalServersSource({
    ...deps, identify: createIdentify(deps),
    listModels: (target, kind, signal) => listServerModels(target, kind, deps, signal),
    localClient: (baseUrl, fetchFn) => new NearAiClient({ apiKey: '', baseUrl, fetchFn: fetchFn ?? fake.fetch, route: 'local' }),
  });
  const run = await runViability({ sources: [source], input: { ...input, ...overrides } });
  run.dispose();
  return { result: run.results.find((row) => row.optionId === optionIdOf('this-computer'))!, results: run.results, fake };
}

test('owner viability rule, end to end with an injected transport', async () => {
  const { result } = await checkLocal();
  assert.equal(result.state, 'viable');
  assert.equal(result.server?.kind, 'ollama');
  assert.deepEqual(result.models.map(({ id }) => id), ['example-model']);
  assert.deepEqual(result.routeFacts, {
    clientRoute: 'local', host: 'http://127.0.0.1:11434/v1',
    model: { id: 'example-model', privacyBoundary: 'local' },
  });
  assert.equal(isChoosable(result, NOW), true);
});

test('D-10: fixed text', async () => {
  const { fake } = await checkLocal();
  assert.deepEqual(fake.messages, [[{ role: 'user', content: 'Reply with the single word OK.' }]]);
});

test('loopback transport: an Ollama server answers the setup test over HTTP', async (t) => {
  const server = await startFakeModelServer('ollama');
  t.after(server.close);
  const deps = { fetch: globalThis.fetch, rows: [server.row] };
  const source = createLocalServersSource({
    ...deps, identify: createIdentify(deps),
    listModels: (target, kind, signal) => listServerModels(target, kind, deps, signal),
    localClient: (baseUrl, fetchFn) => new NearAiClient({ apiKey: '', baseUrl, fetchFn, route: 'local' }),
  });
  const run = await runViability({ sources: [source], input });
  t.after(run.dispose);
  assert.equal(run.results[0]?.state, 'viable');
  assert.equal(run.results[0]?.server?.kind, 'ollama');
  assert.deepEqual(server.requests.map(({ method, path }) => [method, path]), [
    ['GET', '/api/version'], ['GET', '/api/tags'], ['POST', '/v1/chat/completions'],
  ]);
  assert.deepEqual(server.messages, [[{ role: 'user', content: 'Reply with the single word OK.' }]]);
});

test('D-37: spend tag', async () => {
  let tag: ReturnType<typeof currentSpendTag> | undefined;
  await runTestRequest({
    completeOnce: async () => {
      tag = currentSpendTag();
      return completion;
    },
  }, 'example-model', { projectId: 'example-project' });
  assert.deepEqual(tag, { kind: 'eval', projectId: 'example-project' });
});

test('a local server which needs a key receives only the keyless signature request', async () => {
  const { result, fake } = await checkLocal(createFakeModelServer('jan'));
  assert.equal(result.state, 'not-configured');
  assert.equal(result.sentence, SERVER_NEEDS_KEY_TEXT);
  assert.deepEqual(fake.requests, [{ method: 'GET', path: '/v1/models', headerNames: ['accept'], bodyBytes: 0 }]);
});

test('an identified server with zero listed models cannot be chosen', async () => {
  const { result, fake } = await checkLocal(createFakeModelServer('ollama', {
    answer: (r) => r.path === '/api/tags' ? Response.json({ models: [] }) : undefined,
  }));
  assert.equal(result.state, 'test-failed');
  assert.equal(result.fix?.action, 'configure');
  assert.equal(fake.messages.length, 0);
});

test('a successful HTTP response with no completion does not make the server viable', async () => {
  const { result } = await checkLocal(createFakeModelServer('ollama', {
    answer: (r) => r.method === 'POST' ? Response.json({}) : undefined,
  }));
  assert.equal(result.state, 'test-failed');
  assert.equal(isChoosable(result, NOW), false);
});

const endpoint: PolicyEndpoint = {
  id: 'example-gpu', class: 'org-plain', host: '127.0.0.1', scheme: 'https',
  tlsPins: [MODEL_TEST_PIN], region: 'unstated', maxLabel: [],
};

for (const matching of [true, false]) {
  test(`a policy-named server ${matching ? 'uses its pin for the test' : 'refuses a pin mismatch'}`, async () => {
    const fake = createFakeModelServer('openai-compatible', { port: 443 });
    const pin = matching ? MODEL_TEST_PIN : '0'.repeat(64);
    const configured = { ...endpoint, tlsPins: [pin] };
    let namedRequests = 0;
    const onlyNamed = { ...fake, fetch: async () => { throw new Error('No loopback HTTP listener'); } };
    const { results } = await checkLocal(onlyNamed, { endpoints: [configured] }, (pin) => async (url, init) => {
      assert.equal(new URL(String(url)).protocol, 'https:');
      if (pin !== MODEL_TEST_PIN) throw new Error('Pin mismatch');
      namedRequests += 1;
      return fake.fetch(url, init);
    });
    const named = results.find((row) => row.optionId === 'org-server:example-gpu');
    assert.equal(named?.state, matching ? 'viable' : 'not-detected');
    assert.equal(named?.endpoint?.id, endpoint.id);
    assert.equal(namedRequests, matching ? 3 : 0);
    assert.equal(fake.requests.length, namedRequests);
  });
}

test('loopback transport: a policy-named HTTPS server only receives traffic with the correct certificate pin', async (t) => {
  const server = await startFakeModelServer('openai-compatible', { tls: true });
  t.after(server.close);
  const deps = {
    fetch: globalThis.fetch,
    fetchForPin: (pin: string) => pinnedFetch(pin, 'public-key-sha256', { tls: { ca: MODEL_TEST_CA } }),
  };
  const source = createLocalServersSource({
    ...deps, identify: createIdentify(deps), rows: [],
    listModels: (target, kind, signal) => listServerModels(target, kind, deps, signal),
    localClient: (baseUrl, fetchFn) => new NearAiClient({ apiKey: '', baseUrl, fetchFn, route: 'local' }),
  });
  const check = async (pin: string) => {
    const run = await runViability({
      sources: [source], input: { ...input, endpoints: [{ ...endpoint, host: new URL(server.url).host, tlsPins: [pin] }] },
    });
    run.dispose();
    return run.results.find(({ kind }) => kind === 'org-server');
  };
  assert.equal((await check('0'.repeat(64)))?.state, 'not-detected');
  assert.deepEqual(server.requests, []);
  assert.equal((await check(MODEL_TEST_PIN))?.state, 'viable');
  assert.equal(server.requests.length, 3);
});

test('D-41: memory only and the missing local server sentence', async () => {
  const device = await memoryOnlyDeviceProvider({ totalmem: () => 16e9, platform: () => 'linux' }).read();
  assert.equal(device.class, 'unknown');
  assert.equal(device.gpuUsableSource, 'not-measured');
  assert.equal(device.totalMemoryBytes, 16e9);
  const { result } = await checkLocal(createFakeModelServer('ollama', { answer: () => { throw new Error('Offline'); } }), { device });
  assert.equal(result.state, 'not-detected');
  assert.equal(result.sentence, NO_LOCAL_SERVER_TEXT.replace('{memory}', '16 GB'));
  assert.equal(result.fix?.action, 'configure');
});

test('D-08: host kind identifies the machine where the extension runs', async () => {
  assert.equal(hostKindOf({ remoteName: 'dev-container', inContainer: false }), 'container');
  assert.equal(hostKindOf({ remoteName: 'ssh-remote' }), 'remote');
  assert.equal(hostKindOf({ inContainer: true }), 'container');
  assert.equal(hostKindOf({}), 'desktop');
});

const NEAR_HOST = 'https://cloud-api.near.ai/v1';
const models: ModelInfo[] = [{ id: 'example-cloud', privacyBoundary: 'cloud' }, { id: 'example-tee', privacyBoundary: 'tee' }];
const completion: Awaited<ReturnType<ModelEndpoint['completeOnce']>> = {
  text: 'OK', usage: { latencyMs: 0, verificationStatus: 'unknown' },
};

async function checkNear(options: {
  floorOn?: boolean; hasKey?: boolean;
  list?: () => Promise<ModelInfo[]>;
  fact?: ConnectionBindingFact;
  current?: () => ConnectionBindingFact;
  test?: ModelEndpoint['completeOnce'];
} = {}) {
  const calls: string[] = [];
  const fact = options.fact ?? { state: 'bound', host: NEAR_HOST, checkedAt: NOW };
  const source = createNearAiSource({
    hasKey: async () => options.hasKey ?? true,
    baseUrl: () => NEAR_HOST,
    binding: () => ({
      current: () => options.current?.() ?? fact, markNotBound: () => {},
      refresh: async (host) => { assert.equal(host, NEAR_HOST); calls.push('bind'); return fact; },
    }),
    client: async () => {
      calls.push('client');
      return {
        listModels: async () => { calls.push('list'); return options.list ? options.list() : models; },
        cachedTeeModel: () => undefined,
        completeOnce: async (...args) => {
          calls.push(args[0]);
          return options.test ? options.test(...args) : completion;
        },
      };
    },
  });
  const run = await runViability({ sources: [source], input: { ...input, floorOn: options.floorOn ?? false } });
  run.dispose();
  return {
    calls, nearPrivate: run.results.find((result) => result.kind === 'near-private'),
    nearAll: run.results.find((result) => result.kind === 'near-all'),
  };
}

test('NEAR AI checks a fresh connection and sends one test to the private model for both options', async () => {
  const { calls, nearPrivate, nearAll } = await checkNear();
  assert.equal(nearPrivate?.state, 'viable');
  assert.equal(nearPrivate.routeFacts?.binding?.state, 'bound');
  assert.deepEqual(nearPrivate.routeFacts?.model, { id: 'example-tee', privacyBoundary: 'tee' });
  assert.equal(nearAll?.state, 'viable');
  assert.deepEqual(calls, ['client', 'list', 'bind', 'example-tee']);
});

test('NEAR AI without a configured key makes no client calls', async () => {
  const { calls, nearPrivate, nearAll } = await checkNear({ hasKey: false });
  assert.equal(nearPrivate?.state, 'not-configured');
  assert.equal(nearAll?.state, 'not-configured');
  assert.equal(nearPrivate?.fix?.label, 'Add a key');
  assert.deepEqual(calls, []);
});

test('an unreachable NEAR AI catalog prevents the binding check and test', async () => {
  const { calls, nearPrivate, nearAll } = await checkNear({ list: async () => { throw new Error('Offline'); } });
  assert.equal(nearPrivate?.state, 'not-detected');
  assert.equal(nearAll?.state, 'not-detected');
  assert.deepEqual(calls, ['client', 'list']);
});

for (const fact of [
  { state: 'not-bound', host: NEAR_HOST, checkedAt: NOW },
  { state: 'bound', host: NEAR_HOST, checkedAt: NOW - 600_000 },
  { state: 'bound', host: 'https://models.example.test/v1', checkedAt: NOW },
] as const) {
  test(`NEAR AI refuses a binding with state ${fact.state} from ${fact.host} at ${fact.checkedAt}`, async () => {
    const { calls, nearPrivate } = await checkNear({ fact });
    assert.equal(nearPrivate?.state, 'test-failed');
    assert.deepEqual(calls, ['client', 'list', 'bind']);
  });
}

test('the floor disables NEAR AI all models and still allows the private hardware check', async () => {
  const { nearPrivate, nearAll, calls } = await checkNear({ floorOn: true });
  assert.equal(nearAll?.state, 'not-allowed');
  assert.equal(nearAll?.sentence, FLOOR_ON_TEXT);
  assert.equal(nearAll?.fix?.label, 'Open settings');
  assert.equal(nearPrivate?.state, 'viable');
  assert.deepEqual(calls, ['client', 'list', 'bind', 'example-tee']);
});

test('a daily spending refusal yields an unavailable option and a plain cause', async () => {
  const { nearPrivate } = await checkNear({
    test: async () => { throw new SpendLimitError(5, 5, 'local'); },
  });
  assert.equal(nearPrivate?.state, 'test-failed');
  assert.match(nearPrivate.sentence ?? '', /daily spending limit/);
  assert.equal(isChoosable(nearPrivate, NOW), false);
});

test('NEAR AI is unavailable if the connection loses its binding during the test', async () => {
  let bound = true;
  const { nearPrivate, nearAll } = await checkNear({
    current: () => ({ state: bound ? 'bound' : 'not-bound', host: NEAR_HOST, checkedAt: NOW }),
    test: async () => { bound = false; return completion; },
  });
  assert.equal(nearPrivate?.state, 'test-failed');
  assert.equal(nearAll?.state, 'test-failed');
});

test('the 90-second ceiling returns finished rows and delivers late results until disposal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const progress: ViabilityResult[] = [];
  let finishSlow!: (result: ViabilityResult) => void;
  let finishDiscarded!: (result: ViabilityResult) => void;
  const pending = new Promise<ViabilityResult>((resolve) => { finishSlow = resolve; });
  const discarded = new Promise<ViabilityResult>((resolve) => { finishDiscarded = resolve; });
  let slowSignal: AbortSignal | undefined;
  const answer = (kind: 'this-computer' | 'near-private' | 'near-all') => nextViability(
    initialViability(kind, kind, 'desktop'), { type: 'answered', at: Date.now(), models: [] },
  );
  const sources: OptionSource[] = [
    { id: 'fast', kinds: ['this-computer'], check: () => new Promise((resolve) => setTimeout(() => resolve(answer('this-computer')), 10_000)) },
    { id: 'slow', kinds: ['near-private'], check: (_input, signal) => { slowSignal = signal; return pending; } },
    { id: 'discarded', kinds: ['near-all'], check: () => discarded },
  ];
  let finished = false;
  const running = runViability({ sources, input, clock: { now: Date.now, setTimeout, clearTimeout }, onProgress: (row) => progress.push(row) })
    .then((run) => { finished = true; return run; });
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(80_000);
  const run = await running;
  assert.deepEqual(run.stillChecking, ['near-private', 'near-all']);
  assert.deepEqual(run.results.map(({ state, reasonCode }) => [state, reasonCode]), [
    ['viable', undefined], ['checking', 'still-checking'], ['checking', 'still-checking'],
  ]);
  finishSlow(answer('near-private'));
  await Promise.resolve();
  assert.deepEqual(progress.map(({ optionId }) => optionId), ['this-computer', 'near-private']);
  run.dispose();
  assert.equal(slowSignal?.aborted, true);
  finishDiscarded(answer('near-all'));
  await Promise.resolve();
  assert.equal(progress.length, 2);
});

test('a thrown source yields one undetected option per kind', async () => {
  const run = await runViability({
    sources: [{ id: 'broken', kinds: ['near-private', 'near-all'], check: async () => { throw new Error('Unavailable'); } }],
    input,
  });
  assert.deepEqual(run.results.map(({ state }) => state), ['not-detected', 'not-detected']);
  assert.deepEqual(run.stillChecking, []);
  run.dispose();
});
