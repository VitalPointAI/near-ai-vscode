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

function client(delays: Record<string, number>, calls: string[]) {
  return {
    async *streamCompletion(model: string, _messages: AgentMessage[], _tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<CompletionEvent> {
      calls.push(model);
      yield { type: 'text', text: `thinking on ${model}…` };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delays[model] ?? 0);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })); }, { once: true });
      });
      yield { type: 'done', message: { role: 'assistant', content: `answer from ${model}` }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: delays[model] ?? 0 } };
    }
  };
}

async function run(options: { deadlineMs?: number; backupModel?: string; delays: Record<string, number> }) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-deadline-'));
  const calls: string[] = [];
  const events: AgentEvent[] = [];
  const shell = new ShellSession(root);
  try {
    const agent = new AgentRun({ client: client(options.delays, calls), model: 'slow', tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('deadline'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event), ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}), ...(options.backupModel ? { backupModel: options.backupModel } : {}) });
    const result = await agent.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { result, calls, events };
  } finally {
    shell.dispose();
  }
}

test('a turn past its deadline is retried once on the backup model', async () => {
  const { result, calls, events } = await run({ deadlineMs: 30, backupModel: 'backup', delays: { slow: 5_000, backup: 1 } });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(calls, ['slow', 'backup']);
  assert.equal(result.messages.at(-1)?.content, 'answer from backup');
  const retry = events.find((event) => event.type === 'retry');
  assert.ok(retry && retry.type === 'retry');
  assert.match(retry.reason, /slow had not finished its reply after 0 s, so this turn is being retried on backup\./);
  assert.ok(retry.discardText > 0, 'the abandoned reply\'s streamed text is discarded');
  const turn = events.find((event) => event.type === 'turn');
  assert.equal(turn?.type === 'turn' && turn.model, 'backup', 'the turn is recorded against the model that answered');
});

test('the backup is not cut by the deadline, and without a backup nothing is cut', async () => {
  const slowBackup = await run({ deadlineMs: 20, backupModel: 'backup', delays: { slow: 5_000, backup: 80 } });
  assert.deepEqual(slowBackup.calls, ['slow', 'backup'], 'the backup gets as long as it needs');
  assert.equal(slowBackup.result.outcome, 'completed');
  const none = await run({ deadlineMs: 20, delays: { slow: 80 } });
  assert.deepEqual(none.calls, ['slow']);
  assert.equal(none.result.messages.at(-1)?.content, 'answer from slow');
  const same = await run({ deadlineMs: 20, backupModel: 'slow', delays: { slow: 80 } });
  assert.deepEqual(same.calls, ['slow'], 'a backup that is the run\'s own model is no backup');
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
