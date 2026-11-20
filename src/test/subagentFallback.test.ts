import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRunError, AgentRunOptions, ModelStalledError, ModelUnavailableError } from '../agent/loop';
import { failureReason, modelDisplayName, ModelTrouble, switchNotice, switchReason } from '../agent/modelFallback';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { buildTeamLive } from '../agent/teamLiveState';
import { activityLine } from '../domain/staff/staffRoom';
import { fallbackModelsFor } from '../gsd/library';
import { ActivityFeed } from '../services/agentActivity';
import { GsdContext } from '../services/agentSession';
import { CompletionEvent, NearAiClient, NearAiError, PACED_CONCURRENCY, RouteRefusedError, StreamInterruptedError, type AgentMessage, type ToolCall } from '../services/nearAiClient';
import { newTestConversation, newTestRun } from './helpers/gatedRuns';

// Owner's D-48 run: a J2 staff run started 12 members; members on GLM 5.3 got "429 service_overloaded" until they failed together after about 248 s,
// members on Kimi K3 sent nothing for 90 s again and again and failed after 9 to 13 minutes, while Qwen 3.6 and the lead's model answered. A member now
// moves to the next model of a chain at least as private as its own, the client paces one model's requests while NEAR refuses it, and a member that
// still fails says why in words.

const KIMI = 'moonshotai/kimi-k3';
const GLM = 'z-ai/glm-5.3';
const QWEN = 'Qwen/Qwen3.6-35B-A3B-FP8';
const FLASH = 'deepseek-ai/DeepSeek-V4.1-Flash';
const CLOUD = 'cloud/frontier';
const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };

const overloaded = (model: string) => new NearAiError(429, `NEAR AI request failed with HTTP 429 for ${model}: The service is temporarily overloaded. Please retry with exponential backoff. (service_overloaded).`, true, undefined, { model, retryAfterMs: 2_000, errorType: 'service_overloaded' });
const silent = (model: string) => new StreamInterruptedError('NEAR AI sent nothing for 90 s.', true, undefined, { kind: 'stalled', idleMs: 90_000, model });

/** A model client: each model fails with what `fail` gives for it (undefined: it answers), and `cooling` models report a cooldown. */
function fakeClient(fail: (model: string) => Error | undefined, cooling: ReadonlySet<string> = new Set()) {
  const calls: string[] = [];
  return {
    calls,
    cooldownRemainingMs: (model: string) => (cooling.has(model) ? 5_000 : 0),
    async *streamCompletion(model: string): AsyncGenerator<CompletionEvent> {
      calls.push(model);
      const failure = fail(model);
      if (failure) throw failure;
      yield { type: 'done', message: { role: 'assistant', content: `answered by ${model}` }, finishReason: 'stop', usage };
    }
  };
}

/** One AgentRun with no tools on a fake clock: each wait moves the clock on at once. */
async function runOn(client: AgentRunOptions['client'], extra: Partial<AgentRunOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-fallback-'));
  const shell = new ShellSession(root);
  const events: AgentEvent[] = [];
  let now = 1_000_000;
  const run = newTestRun({
    client, model: KIMI, tools: [],
    context: { root, checkpoints: new RunCheckpoints('fallback'), shell, readFiles: new Set() },
    policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES,
    requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event),
    now: () => now, sleep: async (ms) => { now += ms; }, random: () => 0.5,
    ...extra
  });
  try {
    const result = await run.run([{ role: 'user', content: 'collect' }], new AbortController().signal).catch((error: unknown) => error);
    return { result, events, run };
  } finally { shell.dispose(); }
}

const switchesOf = (events: AgentEvent[]) => events.filter((event): event is Extract<AgentEvent, { type: 'model-switch' }> => event.type === 'model-switch');

test('model names read as a person says them', () => {
  assert.equal(modelDisplayName(KIMI), 'Kimi K3');
  assert.equal(modelDisplayName(QWEN), 'Qwen 3.6');
  assert.equal(modelDisplayName(GLM), 'GLM 5.3');
  assert.equal(modelDisplayName(FLASH), 'DeepSeek V4.1 Flash');
  assert.equal(modelDisplayName('plain'), 'Plain');
});

test('the switch line names the member, both models and the reason in plain words', () => {
  assert.equal(switchNotice('threat-analyst', KIMI, QWEN, switchReason(KIMI, 'overloaded')), 'threat-analyst switched from Kimi K3 to Qwen 3.6: Kimi K3 is overloaded at NEAR AI.');
  assert.equal(switchReason(KIMI, 'stalled', 90_000), 'Kimi K3 gave no answer for 90 s');
  assert.equal(switchReason(GLM, 'refused'), 'GLM 5.3 is not allowed for this chat by policy');
  assert.match(switchNotice('collector', KIMI, QWEN, 'x', true), /Its team file names Kimi K3; it goes back to it on its next task\.$/, 'a pinned member says the person chose the model');
});

test('an overloaded model: the turn carries on on the next model after the switch time, and every later turn stays there', async () => {
  const client = fakeClient((model) => (model === GLM ? overloaded(model) : undefined));
  const { result, events, run } = await runOn(client, { model: GLM, fallbackModels: [QWEN, FLASH] });
  assert.equal((result as { outcome?: string }).outcome, 'completed', String(result));
  const [moved] = switchesOf(events);
  assert.deepEqual([moved.from, moved.to, moved.cause, moved.reason], [GLM, QWEN, 'overloaded', 'GLM 5.3 is overloaded at NEAR AI']);
  assert.equal(run.model, QWEN);
  const turn = events.find((event): event is Extract<AgentEvent, { type: 'turn' }> => event.type === 'turn');
  assert.equal(turn?.model, QWEN, 'the turn (and so spend and the model record) names the model actually used');
  assert.ok(client.calls.filter((model) => model === GLM).length >= 2, 'it tried its own model first, more than once');
  const retried = events.filter((event) => event.type === 'retry').length;
  assert.ok(retried >= 2 && retried <= 6, `it switched after the switch time (${retried} retries), not at the first 429 and not after four minutes`);
});

test('a silent model: two stalls in one turn move the member on', async () => {
  const client = fakeClient((model) => (model === KIMI ? silent(model) : undefined));
  const { result, events } = await runOn(client, { fallbackModels: [QWEN] });
  assert.equal((result as { outcome?: string }).outcome, 'completed');
  const [moved] = switchesOf(events);
  assert.deepEqual([moved.from, moved.to, moved.cause, moved.reason], [KIMI, QWEN, 'stalled', 'Kimi K3 gave no answer for 90 s']);
  assert.equal(client.calls.filter((model) => model === KIMI).length, 2, 'two stalls, then the move');
});

test('a fallback that is cooling down, or that another member just left, is skipped', async () => {
  const trouble = new ModelTrouble(() => 0);
  trouble.mark(QWEN);
  const client = fakeClient((model) => (model === KIMI ? silent(model) : undefined), new Set([GLM]));
  const { events } = await runOn(client, { fallbackModels: [GLM, QWEN, FLASH], modelAnswering: (model) => trouble.answering(model) });
  assert.deepEqual(switchesOf(events).map((event) => event.to), [FLASH]);
  assert.ok(!client.calls.includes(GLM) && !client.calls.includes(QWEN));
});

test('the run tells the others which model it left, and never moves back to it', async () => {
  const left: string[] = [];
  const client = fakeClient((model) => (model === KIMI || model === QWEN ? silent(model) : undefined));
  const { result, events } = await runOn(client, { fallbackModels: [QWEN, KIMI, FLASH], modelTrouble: (model) => left.push(model) });
  assert.equal((result as { outcome?: string }).outcome, 'completed');
  assert.deepEqual(switchesOf(events).map((event) => [event.from, event.to]), [[KIMI, QWEN], [QWEN, FLASH]]);
  assert.deepEqual(left, [KIMI, QWEN]);
});

test('with no fallback answering, the run keeps its model and fails as before, naming it', async () => {
  const client = fakeClient((model) => (model === GLM ? overloaded(model) : undefined), new Set([QWEN]));
  const { result, events } = await runOn(client, { model: GLM, fallbackModels: [QWEN] });
  assert.ok(result instanceof AgentRunError && result.cause instanceof ModelUnavailableError, String(result));
  assert.equal((result.cause as ModelUnavailableError).model, GLM);
  assert.equal(switchesOf(events).length, 0);
  assert.equal(failureReason(result), 'GLM 5.3 is overloaded at NEAR AI');
});

test('the route gate refusing a fallback moves on to the next one; refusing the last one fails with the refusal', async () => {
  const refuse = (model: string) => (model === QWEN ? new RouteRefusedError('route.tier-forbidden' as never, 'This chat\'s label does not allow that model.') : model === KIMI ? silent(model) : undefined);
  const next = await runOn(fakeClient(refuse), { fallbackModels: [QWEN, FLASH] });
  assert.equal((next.result as { outcome?: string }).outcome, 'completed');
  assert.deepEqual(switchesOf(next.events).map((event) => [event.to, event.cause]), [[QWEN, 'stalled'], [FLASH, 'refused']]);
  const last = await runOn(fakeClient(refuse), { fallbackModels: [QWEN] });
  assert.ok(last.result instanceof AgentRunError);
  assert.match(failureReason(last.result) ?? '', /^refused by policy: This chat's label does not allow that model\./);
});

test('the fallback chain is never less private: TEE stays TEE, a private member stays private, TEE-only keeps it private', () => {
  const catalog = [
    { id: KIMI, privacyBoundary: 'tee', outputPricePerMillion: 3 },
    { id: GLM, privacyBoundary: 'tee', outputPricePerMillion: 2 },
    { id: QWEN, privacyBoundary: 'tee', outputPricePerMillion: 1 },
    { id: CLOUD, privacyBoundary: 'cloud', outputPricePerMillion: 30 },
    { id: 'local/llama', privacyBoundary: 'local' },
    { id: 'tee/embed', privacyBoundary: 'tee', outputPricePerMillion: 9 }
  ];
  const teeRoute = (candidate: { privacyBoundary?: string }) => candidate.privacyBoundary === 'tee';
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [undefined, GLM, KIMI, QWEN, CLOUD], catalog }), [GLM, QWEN], 'a TEE model moves only to TEE models, preferred order first; never an embedding model');
  assert.deepEqual(fallbackModelsFor({ current: CLOUD, preferred: [CLOUD, QWEN], catalog }), [QWEN, KIMI, GLM], 'a forwarded model may move to a more private one, but not to a local one (another route)');
  assert.deepEqual(fallbackModelsFor({ current: CLOUD, preferred: [], catalog, privateMember: true, allowed: teeRoute }), [KIMI, GLM, QWEN], 'a private member on whatever model moves only to a private one its route can carry');
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [CLOUD], catalog, privateMember: true, allowed: () => false }), [], 'and to none when the route carries none');
  assert.deepEqual(fallbackModelsFor({ current: CLOUD, preferred: [CLOUD], catalog: catalog.filter((model) => model.privacyBoundary === 'cloud' || model.id === CLOUD), teeOnly: true }), [], 'TEE-only: never a forwarded model');
  assert.deepEqual(fallbackModelsFor({ current: 'local/llama', preferred: [KIMI], catalog }), [], 'local stays local');
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [GLM, QWEN], catalog, available: [KIMI, QWEN] }), [QWEN], 'only models offered to the run');
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [GLM, CLOUD] }), [GLM, CLOUD], 'without a catalog: the preferred models (the chat offers only ones as private as its own)');
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [GLM], privateMember: true }), [], 'without a catalog a private member gets no fallback');
  assert.deepEqual(fallbackModelsFor({ current: KIMI, preferred: [GLM], teeOnly: true }), [], 'nor does anyone in TEE-only mode');
});

test('a failure says why in words, not only its error name', () => {
  assert.equal(failureReason(new ModelUnavailableError(GLM, 429, 248_000, 9, 'x')), 'GLM 5.3 is overloaded at NEAR AI');
  assert.equal(failureReason(new AgentRunError(new ModelStalledError(KIMI, 3, 'no data for 90 s', 'x'), [])), 'Kimi K3 gave no answer for 90 s');
  assert.equal(failureReason(silent(KIMI)), 'Kimi K3 gave no answer for 90 s');
  assert.equal(failureReason(overloaded(GLM)), 'GLM 5.3 is overloaded at NEAR AI');
  assert.match(failureReason(new RouteRefusedError('route.tier-forbidden' as never, 'Nothing was sent.')) ?? '', /^refused by policy: Nothing was sent\./);
  assert.equal(failureReason(new Error('disk full')), undefined, 'no words: the caller keeps the message');
});

test('Team Live and the Staff Room show the switch and the failure reason in words', () => {
  const feed = new ActivityFeed({ maxAgeMs: 60_000, maxBytes: 1_000_000 });
  feed.agentStarted({ agentId: 'main-r1', agent: 'lead', runId: 'r1', model: FLASH });
  feed.agentStarted({ agentId: 'ta-1', agent: 'threat-analyst', runId: 'r1', model: KIMI, parentId: 'main-r1' });
  feed.agentStarted({ agentId: 'col-1', agent: 'collector', runId: 'r1', model: GLM, parentId: 'main-r1' });
  const text = switchNotice('threat-analyst', KIMI, QWEN, switchReason(KIMI, 'overloaded'));
  feed.modelSwitched('ta-1', QWEN, text);
  feed.agentEnded('col-1', 'failed', 'collector failed: GLM 5.3 is overloaded at NEAR AI.');
  const view = buildTeamLive({ runId: 'r1', stats: feed.agentStats() });
  const analyst = view.nodes.find((node) => node.name === 'threat-analyst');
  assert.equal(analyst?.model, QWEN, 'the card names the model it uses now');
  assert.match(analyst?.activity ?? '', /· switched from Kimi K3 to Qwen 3.6: Kimi K3 is overloaded at NEAR AI\.$/);
  assert.equal(view.nodes.find((node) => node.name === 'collector')?.activity, 'Did not finish: GLM 5.3 is overloaded at NEAR AI.');
  const settings = {} as never;
  const switched = activityLine(settings, { type: 'staff.lane.switched', run: 'r1', at: '2026-11-19T00:00:00.000Z', section: 'command', member: 'threat-analyst', from: 'Kimi K3', to: 'Qwen 3.6', reason: 'Kimi K3 is overloaded at NEAR AI' });
  assert.match(switched?.text ?? '', /^threat-analyst switched from Kimi K3 to Qwen 3.6: Kimi K3 is overloaded at NEAR AI\.$/);
  const failed = activityLine(settings, { type: 'staff.lane.finished', run: 'r1', at: '2026-11-19T00:00:00.000Z', section: 'command', member: 'collector', outcome: 'failed', reason: 'GLM 5.3 is overloaded at NEAR AI' });
  assert.match(failed?.text ?? '', /^collector failed: GLM 5.3 is overloaded at NEAR AI\.$/);
});

test('pacing: while a model answers 429, its concurrent requests go at most a few at a time, and the probe backs off past Retry-After', async () => {
  let refuse = 1;
  let inFlight = 0;
  let most = 0;
  const encoder = new TextEncoder();
  const body = () => new ReadableStream<Uint8Array>({
    async start(controller) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`));
      inFlight -= 1;
      controller.close();
    }
  });
  const client = new NearAiClient({
    baseUrl: 'https://example.test/v1', apiKey: 'k', cooldownBaseMs: 20, random: () => 0.5,
    fetchFn: (async () => {
      if (refuse > 0) { refuse -= 1; return new Response('{"error":{"message":"The service is temporarily overloaded.","type":"service_overloaded"}}', { status: 429, headers: { 'retry-after-ms': '30' } }); }
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Response(body(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch
  });
  const drain = async (stream: AsyncGenerator<CompletionEvent>) => { for await (const _event of stream) { /* to the end */ } };
  await assert.rejects(() => drain(client.streamCompletion(GLM, [{ role: 'user', content: 'a' }], [])), (error: NearAiError) => error.status === 429);
  assert.ok(client.isPaced(GLM));
  await Promise.all([0, 1, 2, 3, 4, 5].map((index) => drain(client.streamCompletion(GLM, [{ role: 'user', content: String(index) }], []))));
  assert.ok(most <= PACED_CONCURRENCY, `${most} requests to one paced model at once`);
  assert.equal(inFlight, 0);
  assert.ok(!client.isPaced(QWEN), 'only the model NEAR refused is paced');

  let now = 1_000;
  const probes = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', cooldownBaseMs: 5_000, now: () => now, fetchFn: (async () => new Response('', { status: 429, headers: { 'retry-after': '1' } })) as typeof fetch });
  await assert.rejects(() => drain(probes.streamCompletion(GLM, [{ role: 'user', content: 'a' }], [])));
  assert.equal(probes.cooldownRemainingMs(GLM), 1_000, 'the first refusal waits what NEAR asked');
  now += 1_001;
  await assert.rejects(() => drain(probes.streamCompletion(GLM, [{ role: 'user', content: 'b' }], [])));
  assert.equal(probes.cooldownRemainingMs(GLM), 10_000, 'a refused probe backs off exponentially, never less than Retry-After');
});

test('a staff member on an overloaded or silent model moves to a private fallback and says so; one that fails says why', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-fallback-run-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-fallback-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const teamFile = path.join(root, '.planning', '.near-ai', 'team.md');
  const member = (name: string, model: string, privacy?: 'private') => ({ name, description: name, tools: ['Read'], body: `You are ${name}.`, file: teamFile, model, ...(privacy ? { privacy } : {}) });
  const gsd: GsdContext = { home, skills: [], shellEnv: {}, agents: [member('threat-analyst', KIMI, 'private'), member('collector', GLM)] };
  const call = (id: string, type: string): ToolCall => ({ id, type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ subagent_type: type, prompt: 'go' }) } });
  const catalog = [
    { id: KIMI, privacyBoundary: 'tee', outputPricePerMillion: 3 },
    { id: GLM, privacyBoundary: 'tee', outputPricePerMillion: 2 },
    { id: QWEN, privacyBoundary: 'tee', outputPricePerMillion: 1 },
    { id: CLOUD, privacyBoundary: 'cloud', outputPricePerMillion: 30 }
  ];
  const modelsUsed = new Map<string, string[]>();
  const toolResults: string[] = [];
  const notices: string[] = [];
  const near = {
    cooldownRemainingMs: (model: string) => (model === GLM ? 5_000 : 0),
    async *streamCompletion(model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const who = /^You are ([\w-]+)\./.exec(String(messages[0].content))?.[1];
      if (who) {
        modelsUsed.set(who, [...(modelsUsed.get(who) ?? []), model]);
        // Kimi sends nothing; GLM is overloaded until NEAR's patience runs out; Qwen answers.
        if (model === KIMI) throw silent(model);
        if (model === GLM) throw new ModelUnavailableError(GLM, 429, 248_000, 9, 'The service is temporarily overloaded.');
        yield { type: 'done', message: { role: 'assistant', content: 'report' }, finishReason: 'stop', usage };
        return;
      }
      if (!messages.some((message) => message.role === 'tool')) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'threat-analyst'), call('a2', 'collector')] }, finishReason: 'tool_calls', usage }; return; }
      toolResults.push(...messages.filter((message) => message.role === 'tool').map((message) => String(message.content)));
      yield { type: 'done', message: { role: 'assistant', content: 'all done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const feed = new ActivityFeed({ maxAgeMs: 600_000, maxBytes: 5_000_000 });
  const conversation = newTestConversation(root, (message) => { if (message.type === 'notice') notices.push(String(message.text)); }, path.join(root, '.ckpt'), undefined, undefined, feed);
  try {
    // The chat runs on a forwarded model: the private member must still never move to it (PERF-03's stall backup included).
    await conversation.send({ text: 'go', client: near as never, model: CLOUD, privacy: 'Not private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, tiers: { deep: KIMI, standard: GLM, fast: QWEN }, availableModels: catalog.map((entry) => entry.id), modelCatalog: catalog, route: { kind: 'near', attestation: true }, modelStallMs: 120_000 });
  } finally {
    conversation.dispose();
  }
  assert.deepEqual(modelsUsed.get('threat-analyst'), [KIMI, KIMI, QWEN], 'two silences on Kimi K3, then Qwen 3.6 (GLM 5.3 is cooling down, so it is skipped); never the forwarded chat model');
  assert.ok(notices.includes('threat-analyst switched from Kimi K3 to Qwen 3.6: Kimi K3 gave no answer for 90 s. Its team file names Kimi K3; it goes back to it on its next task.'), notices.join('\n'));
  const analyst = toolResults.find((result) => /threat-analyst ran on/.test(result)) ?? '';
  assert.match(analyst, new RegExp(`threat-analyst ran on ${QWEN.replace(/[./]/g, '\\$&')}\\..*It switched from ${KIMI.replace(/[./]/g, '\\$&')}`), 'the lead hears which model did the work');
  assert.ok(toolResults.some((result) => /^(?:Error: )?collector failed: GLM 5\.3 is overloaded at NEAR AI\. NEAR AI kept rate limiting/.test(result)), toolResults.join('\n---\n'));
  const stats = feed.agentStats();
  assert.equal(stats.find((stat) => stat.agent === 'threat-analyst')?.model, QWEN);
  assert.equal(stats.find((stat) => stat.agent === 'collector')?.failReason, 'collector failed: GLM 5.3 is overloaded at NEAR AI.');
});
