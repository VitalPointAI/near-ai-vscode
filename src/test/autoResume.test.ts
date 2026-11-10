import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { MISSING_RESULT, repairTranscript } from '../services/agentSession';
import { AUTO_RESUME_WITHIN_MS, autoResumeNotice, shouldAutoResume } from '../services/runMarkers';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// PERF-05: a run a reload cut off carries on by itself, and nothing that had finished is run again.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('a transcript cut mid-batch gets a placeholder for each call without a result; finished calls keep theirs', () => {
  const cut: AgentMessage[] = [
    { role: 'system', content: 's' }, { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [call('a', 'Bash', { command: 'git commit -m x' }), call('b', 'Bash', { command: 'npm test' }), call('c', 'Read', { file_path: 'x' })] },
    { role: 'tool', tool_call_id: 'a', content: '[main 1234] x\n\n[exit code 0]' }
  ];
  const repaired = repairTranscript(cut);
  assert.deepEqual(repaired.slice(0, 4), cut, 'what was saved is kept as it was');
  assert.deepEqual(repaired.slice(4), [{ role: 'tool', tool_call_id: 'b', content: MISSING_RESULT }, { role: 'tool', tool_call_id: 'c', content: MISSING_RESULT }]);
  const whole: AgentMessage[] = [...cut.slice(0, 3), { role: 'tool', tool_call_id: 'a', content: 'ok' }, { role: 'tool', tool_call_id: 'c', content: 'ok' }, { role: 'tool', tool_call_id: 'b', content: 'ok' }, { role: 'assistant', content: 'done' }];
  assert.equal(repairTranscript(whole), whole, 'a complete transcript is returned unchanged');
});

test('the run saves its state after every finished call, so a reload loses at most the call in flight', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-progress-'));
  const saved: AgentMessage[][] = [];
  let turn = 0;
  const client = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { turn += 1; yield { type: 'done', message: turn === 1 ? { role: 'assistant', content: null, tool_calls: [call('w1', 'Bash', { command: 'echo one > one.txt' }), call('w2', 'Bash', { command: 'echo two > two.txt' }), call('w3', 'Bash', { command: 'echo three > three.txt' })] } : { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('progress'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: () => undefined, onProgress: (transcript) => { saved.push(structuredClone(transcript)); } });
    await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
  } finally {
    shell.dispose();
  }
  assert.equal(saved.length, 2, 'saved after the first and second call (the third is saved before the next model turn)');
  assert.deepEqual(saved.map((transcript) => transcript.filter((message) => message.role === 'tool').map((message) => (message as { tool_call_id: string }).tool_call_id)), [['w1'], ['w1', 'w2']]);
  const resumed = repairTranscript(saved[1]);
  assert.equal(resumed.filter((message) => message.role === 'tool' && message.content === MISSING_RESULT).length, 1, 'after a reload only w3 is unknown');
});

test('a cut-off run resumes by itself when recent and switched on, with a notice', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const recent = { activeAt: new Date(now - 30 * 60_000).toISOString() };
  const old = { activeAt: new Date(now - AUTO_RESUME_WITHIN_MS - 1).toISOString() };
  assert.equal(shouldAutoResume(recent, true, now), true);
  assert.equal(shouldAutoResume(recent, false, now), false, 'the setting turns it off');
  assert.equal(shouldAutoResume(old, true, now), false, 'an old cut-off waits for the person');
  assert.equal(shouldAutoResume({ activeAt: 'not a date' }, true, now), false);
  assert.match(autoResumeNotice(recent, now), /^Resuming automatically: this run was cut off by a reload at .*steps that had finished are not run again.*nearAi\.agent\.autoResumeAfterReload/);
});
