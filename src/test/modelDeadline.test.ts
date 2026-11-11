import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { DEFAULT_ROLE_MODELS, defaultRoleTier, modelForTier, roleModelFor } from '../gsd/library';
import type { AgentMessage, CompletionEvent, ToolDefinition } from '../services/nearAiClient';

// PERF-03: a slow model turn is retried on the backup model at its deadline, and judgement roles route to the deep tier, bulk roles to fast.

type Step = { wait: number; text?: string; progress?: boolean };
/** A fake NEAR: each model streams its steps (waiting before each), then answers. An abort during a wait ends the attempt. */
function client(scripts: Record<string, Step[]>, calls: string[]) {
  return {
    async *streamCompletion(model: string, _messages: AgentMessage[], _tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      calls.push(model);
      for (const step of scripts[model] ?? []) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, step.wait);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); }, { once: true });
        });
        if (step.text) yield { type: 'text', text: step.text };
        if (step.progress) yield { type: 'progress' };
      }
      yield { type: 'done', message: { role: 'assistant', content: `answer from ${model}` }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } };
    }
  };
}

async function run(options: { stallMs?: number; backupModel?: string; scripts: Record<string, Step[]> }) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-deadline-'));
  const calls: string[] = [];
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  try {
    const agent = new AgentRun({ client: client(options.scripts, calls), model: 'slow', tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('deadline'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event), ...(options.stallMs ? { stallMs: options.stallMs } : {}), ...(options.backupModel ? { backupModel: options.backupModel } : {}) });
    const result = await agent.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { result, calls, events };
  } finally {
    shell.dispose();
  }
}

const steady = (chunks: number, every: number, as: 'text' | 'progress' = 'text'): Step[] => Array.from({ length: chunks }, (_, index) => ({ wait: every, ...(as === 'text' ? { text: `part ${index} ` } : { progress: true }) }));

test('a slow but steady reply longer than the stall deadline completes on the primary model, text or tool-call progress alike', async () => {
  const text = await run({ stallMs: 60, backupModel: 'backup', scripts: { slow: steady(12, 20) } });
  assert.deepEqual(text.calls, ['slow'], 'never cut while it streams (about 240 ms against a 60 ms stall deadline)');
  assert.equal(text.result.messages.at(-1)?.content, 'answer from slow');
  assert.equal(text.events.some((event) => event.type === 'retry'), false, 'nothing streamed was discarded');
  const tools = await run({ stallMs: 60, backupModel: 'backup', scripts: { slow: steady(12, 20, 'progress') } });
  assert.deepEqual(tools.calls, ['slow'], 'tool-call arguments streaming count as progress');
});

test('a stalled first token retries on the backup, with nothing to discard', async () => {
  const { result, calls, events } = await run({ stallMs: 30, backupModel: 'backup', scripts: { slow: [{ wait: 5_000, text: 'late' }], backup: [{ wait: 1, text: 'quick ' }] } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls, ['slow', 'backup']);
  assert.equal(result.messages.at(-1)?.content, 'answer from backup');
  const retry = events.find((event) => event.type === 'retry');
  assert.ok(retry && retry.type === 'retry');
  assert.match(retry.reason, /^slow sent nothing for 0 s before its first token, so this turn is being retried on backup\.$/);
  assert.equal(retry.discardText, 0);
  const turn = events.find((event) => event.type === 'turn');
  assert.equal(turn?.type === 'turn' && turn.model, 'backup', 'the turn is recorded against the model that answered');
});

test('a stall in the middle of a reply retries on the backup without duplicating output', async () => {
  const { result, calls, events } = await run({ stallMs: 40, backupModel: 'backup', scripts: { slow: [{ wait: 1, text: 'half a ' }, { wait: 5_000, text: 'never' }], backup: [{ wait: 1, text: 'whole reply' }] } });
  assert.deepEqual(calls, ['slow', 'backup']);
  const retry = events.find((event) => event.type === 'retry');
  assert.ok(retry && retry.type === 'retry');
  assert.match(retry.reason, /in the middle of its reply/);
  // What a viewer shows: every streamed character, less what each retry discarded. The stalled half-reply is gone; the backup's reply appears once.
  let shown = '';
  for (const event of events) {
    if (event.type === 'text') shown += event.text;
    if (event.type === 'retry') shown = shown.slice(0, shown.length - event.discardText);
  }
  assert.equal(shown, 'whole reply');
  assert.equal(result.messages.at(-1)?.content, 'answer from backup');
});

test('the backup is not cut by the stall deadline, and without a backup nothing is cut', async () => {
  const slowBackup = await run({ stallMs: 20, backupModel: 'backup', scripts: { slow: [{ wait: 5_000 }], backup: [{ wait: 80 }] } });
  assert.deepEqual(slowBackup.calls, ['slow', 'backup'], 'the backup gets as long as it needs');
  assert.equal(slowBackup.result.outcome, 'completed');
  const none = await run({ stallMs: 20, scripts: { slow: [{ wait: 80 }] } });
  assert.deepEqual(none.calls, ['slow']);
  assert.equal(none.result.messages.at(-1)?.content, 'answer from slow');
  const same = await run({ stallMs: 20, backupModel: 'slow', scripts: { slow: [{ wait: 80 }] } });
  assert.deepEqual(same.calls, ['slow'], 'a backup that is the run\'s own model is no backup');
});

test('the client reports tool-call deltas as progress', async () => {
  const { NearAiClient } = await import('../services/nearAiClient');
  const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
  const body = chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"file_' } }] }) + chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a"}' } }] }, 'tool_calls') + 'data: [DONE]\n\n';
  const near = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async (url: string) => (String(url).endsWith('/models') ? new Response(JSON.stringify({ data: [] })) : new Response(body))) as typeof fetch });
  const types: string[] = [];
  for await (const event of near.streamCompletion('m', [{ role: 'user', content: 'hi' }], [])) types.push(event.type);
  assert.deepEqual(types, ['progress', 'progress', 'done']);
});

test('judgement roles route to the deep tier and bulk fetch and extract roles to fast; a role setting still wins', () => {
  for (const role of ['gsd-planner', 'gsd-plan-checker', 'gsd-verifier', 'analyst', 'editor', 'red-team', 'source-verifier']) assert.equal(defaultRoleTier(role), 'deep', role);
  for (const role of ['web-fetcher', 'bulk-fetch', 'extractor', 'gsd-phase-researcher', 'gsd-codebase-mapper']) assert.equal(defaultRoleTier(role), 'fast', role);
  assert.equal(defaultRoleTier('gsd-executor'), undefined, 'other roles follow their own definition');
  const tiers = { deep: 'deep-model', standard: 'standard-model', fast: 'fast-model' };
  assert.equal(modelForTier(roleModelFor('gsd-planner', DEFAULT_ROLE_MODELS), tiers, 'chat'), 'deep-model');
  assert.equal(modelForTier(roleModelFor('extractor', DEFAULT_ROLE_MODELS), tiers, 'chat'), 'fast-model');
  assert.equal(roleModelFor('gsd-planner', { ...DEFAULT_ROLE_MODELS, 'gsd-planner': 'standard' }), 'standard', 'an exact setting wins over a pattern');
});
