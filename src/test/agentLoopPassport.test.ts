// Phase 74.1-04 Task 3 (D-14, MPRV-04, T-74.1-14): nothing moves to another model by itself. A run whose model the passport step refuses ends with that
// refusal; a stalled run never sends to a backup the gate refuses, and moves on only to a fallback the gate allows. The real client and gate decide; a
// counting fake fetch stands in for NEAR AI Cloud. No network, no model, no key.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import type { AgentEvent } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { DecisionRecord } from '../domain/gate/record';
import { withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { NearAiClient } from '../services/nearAiClient';
import { newTestRun, testBundleState } from './helpers/gatedRuns';
import { evaluatedModels } from './helpers/policyFixtures';

const NEAR = 'https://cloud-api.near.ai/v1';
const PRC = 'z-ai/glm-5.3';
const WESTERN = 'openai/gpt-oss-120b';
const NEMOTRON = 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8';

/** A NEAR AI Cloud stand-in: every model runs in private hardware; `stalls` never answers until the request is aborted; every other model answers "done". */
async function nearClient(stalls?: string): Promise<{ client: NearAiClient; sent: string[] }> {
  const sent: string[] = [];
  const ids = [PRC, WESTERN, NEMOTRON];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.endsWith('/models')) return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    if (method === 'GET' && url.endsWith('/model/list')) return new Response(JSON.stringify({ models: ids.map((modelId) => ({ modelId, metadata: { attestationSupported: true, providerType: 'vllm' } })) }), { status: 200 });
    if (new URL(url).pathname.endsWith('/attestation/report')) return new Response('{}', { status: 404 });
    const model = String((JSON.parse(String(init?.body ?? '{}')) as { model?: unknown }).model);
    sent.push(model);
    if (model === stalls) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })), { once: true });
      });
    }
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    const body = chunk({ id: 'c1', choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + chunk({ id: 'c1', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + 'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const client = new NearAiClient({ baseUrl: NEAR, apiKey: 'test-key', fetchFn, route: 'near' });
  await client.listModels();
  return { client, sent };
}

const EVALUATED = evaluatedModels('enforce', ['nvidia/nemotron-3-super', 'openai/gpt-oss']);

/** An agent run's route under your organization's enforcing model policy, recording every model request. */
function enforcingRoute(records: DecisionRecord[]): SessionRoute {
  const state = testBundleState();
  return {
    markOf: () => [], bundleState: () => state, actor: { kind: 'agent', deviceFingerprint: 'device-test', sessionId: 'loop-passport' }, attestation: { failed: false },
    clock: () => Date.now(), sink: { record: (record) => { records.push(record); } }, useOf: () => ({ tools: true }),
    routePolicy: () => ({
      endpoints: [], authorizations: [], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: Date.now(),
      // 74.1-06 (D-16): your organization has evaluated gpt-oss and Nemotron 3 Super, so the gate allows them for agent work.
      policyVersion: 'bundle-2', models: EVALUATED
    })
  };
}

async function runOn(model: string, options: { stalls?: string; backupModel?: string; fallbackModels?: string[] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-loop-passport-'));
  const shell = new ShellSession(root);
  const near = await nearClient(options.stalls);
  const records: DecisionRecord[] = [];
  const events: AgentEvent[] = [];
  try {
    const agent = newTestRun({
      client: near.client, model, tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('loop-passport'), shell, readFiles: new Set() },
      policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event),
      ...(options.backupModel === undefined ? {} : { backupModel: options.backupModel, stallMs: 40 }), ...(options.fallbackModels === undefined ? {} : { fallbackModels: options.fallbackModels })
    });
    let outcome: string;
    try {
      const result = await withSessionRoute(enforcingRoute(records), () => agent.run([{ role: 'user', content: 'go' }], new AbortController().signal));
      outcome = `${result.outcome}: ${String(result.messages.at(-1)?.content ?? '')}`;
    } catch (error) {
      outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { outcome, sent: near.sent, records, events };
  } finally {
    shell.dispose();
  }
}

const passportRefusals = (records: readonly DecisionRecord[], model: string) => records.filter((record) => record.authorizations[0]?.policy.name === 'route.passport' && record.unmapped.nearAi.capability.verb === 'infer' && (record.unmapped.nearAi.capability as { model?: string }).model === model);

test('T-74.1-14: a run whose model the passport step refuses ends with that refusal, and no other model is asked', async () => {
  const { outcome, sent, records, events } = await runOn(PRC, { fallbackModels: [WESTERN] });
  assert.match(outcome, /^error: Nothing was sent\. z-ai\/glm-5\.3 is approved for research only/);
  assert.deepEqual(sent, [], 'nothing was sent to any model');
  assert.equal(passportRefusals(records, PRC).length, 1);
  assert.equal(events.some((event) => event.type === 'model-switch'), false, 'the run did not move itself to another model');
});

test('T-74.1-14: a stalled primary never sends to a backup the gate refuses; it moves on only to a fallback the gate allows', async () => {
  const { outcome, sent, records, events } = await runOn(WESTERN, { stalls: WESTERN, backupModel: PRC, fallbackModels: [NEMOTRON] });
  assert.match(outcome, /^completed: /);
  assert.deepEqual(sent, [WESTERN, NEMOTRON], 'the refused backup was never sent anything');
  const refused = passportRefusals(records, PRC);
  assert.equal(refused.length, 1, 'the refused backup is recorded once');
  assert.equal(refused[0]?.unmapped.nearAi.passportGap, 'tier-exceeded');
  const moved = events.find((event) => event.type === 'model-switch');
  assert.ok(moved !== undefined && moved.type === 'model-switch' && moved.to === NEMOTRON && moved.cause === 'refused');
});

test('T-74.1-14: with no fallback the gate allows, a stalled run whose backup is refused ends with the refusal sentence', async () => {
  const { outcome, sent } = await runOn(WESTERN, { stalls: WESTERN, backupModel: PRC });
  assert.match(outcome, /^error: Nothing was sent\. z-ai\/glm-5\.3 is approved for research only/);
  assert.deepEqual(sent, [WESTERN]);
});
