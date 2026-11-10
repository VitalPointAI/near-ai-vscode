import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { contextAction, DEFAULT_COMPACT_AT_TOKENS } from '../agent/context';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { readTool } from '../agent/tools';
import { ActivityStore } from '../services/activityStore';
import { ActivityFeed } from '../services/agentActivity';
import { AgentConversation, boundedReport, MAX_REPORT_CHARS } from '../services/agentSession';
import { completionRequestBody, type AgentMessage, type CompletionEvent, type ToolCall, type ToolDefinition } from '../services/nearAiClient';

// PERF-02: transcripts stay small (an absolute compaction threshold, ranged reads, bounded sub-agent reports) and cacheable (a byte-stable prefix).

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('compaction happens at the absolute threshold even on a very large window, and trimming starts at 80% of it', () => {
  assert.equal(DEFAULT_COMPACT_AT_TOKENS, 70_000);
  const million = 1_000_000;
  assert.equal(contextAction(10_000, million), 'none');
  assert.equal(contextAction(56_000, million), 'trim');
  assert.equal(contextAction(70_000, million), 'compact');
  assert.equal(contextAction(190_000, million), 'compact', 'the measured median request would now be compacted');
  assert.equal(contextAction(190_000, million, 0), 'none', '0 keeps only the window thresholds');
  assert.equal(contextAction(660_000, million, 0), 'warn');
  assert.equal(contextAction(760_000, million, 0), 'compact');
  assert.equal(contextAction(100_000, 128_000), 'compact', 'the window thresholds still apply first on a small window');
});

test('a Read without a range on a large file returns 400 lines and an outline; a range is honoured as before', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-ranged-read-'));
  const lines = Array.from({ length: 1_000 }, (_, index) => (index % 100 === 0 ? `## Section ${index / 100}` : `line ${index + 1}`));
  await writeFile(path.join(root, 'report.md'), lines.join('\n'));
  const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('ranged'), shell: undefined as never, readFiles: new Set<string>() };
  const whole = await readTool.run(readTool.parse({ file_path: 'report.md' }), context);
  assert.match(whole, /^\s*1\t## Section 0/);
  assert.match(whole, /\b400\tline 400\n/);
  assert.doesNotMatch(whole, /\t line 401|\b401\tline 401/);
  assert.match(whole, /This file has 1000 lines; only the first 400 are shown\. Read the part you need with offset and limit, using this outline/);
  assert.match(whole, /\s901 {2}## Section 9/);
  const ranged = await readTool.run(readTool.parse({ file_path: 'report.md', offset: 802, limit: 50 }), context);
  assert.match(ranged, /^802\tline 802/);
  assert.doesNotMatch(ranged, /outline/);
  const small = await writeFile(path.join(root, 'small.md'), 'a\nb\n').then(() => readTool.run(readTool.parse({ file_path: 'small.md' }), context));
  assert.equal(small, '1\ta\n2\tb');
});

test('a sub-agent report over the cap is cut with a note', () => {
  assert.equal(boundedReport('short', 'helper'), 'short');
  const cut = boundedReport('x'.repeat(MAX_REPORT_CHARS + 500), 'helper');
  assert.ok(cut.length < MAX_REPORT_CHARS + 400);
  assert.match(cut, /helper's report was cut to 12,000 of 12,500 characters/);
});

test('every request\'s tools are identical and its messages are a byte-identical prefix of the next request\'s, and cached tokens reach the activity log', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cache-prefix-'));
  await writeFile(path.join(root, 'notes.md'), 'hello\n');
  const bodies: Array<{ messages: string; tools: string }> = [];
  let turn = 0;
  const near = {
    async *streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[]): AsyncGenerator<CompletionEvent> {
      const body = JSON.parse(completionRequestBody(model, messages, tools, 32_000)) as { messages: unknown; tools: unknown };
      bodies.push({ messages: JSON.stringify(body.messages), tools: JSON.stringify(body.tools) });
      turn += 1;
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 5, inputTokens: 1_000 * turn, cachedInputTokens: turn > 1 ? 900 * (turn - 1) : 0, outputTokens: 20 };
      const steps: ToolCall[][] = [[call('r1', 'Read', { file_path: 'notes.md' })], [call('b1', 'Bash', { command: 'echo hi' })], [call('g1', 'Glob', { pattern: '*.md' }), call('r2', 'Read', { file_path: 'notes.md' })]];
      const next = steps[turn - 1];
      yield { type: 'done', message: next ? { role: 'assistant', content: null, tool_calls: next } : { role: 'assistant', content: 'Done.' }, finishReason: next ? 'tool_calls' : 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const store = new ActivityStore(root);
  const session = await store.start({ sessionId: 'session-cache-prefix', project: 'demo' });
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'), undefined, undefined, new ActivityFeed({ maxAgeMs: 60 * 60_000, maxBytes: 8 * 1024 * 1024 }));
  try {
    await conversation.send({ text: 'look', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, activity: { store, sessionId: session.sessionId } });
    await conversation.send({ text: 'and again', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, activity: { store, sessionId: session.sessionId } });
  } finally {
    conversation.dispose();
  }
  assert.ok(bodies.length >= 5);
  for (let index = 1; index < bodies.length; index += 1) {
    assert.equal(bodies[index].tools, bodies[0].tools, `turn ${index + 1} sends the same tools, byte for byte`);
    const previous = bodies[index - 1].messages;
    assert.ok(bodies[index].messages.startsWith(previous.slice(0, -1)), `turn ${index + 1}'s messages start with every byte of turn ${index}'s`);
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const saved = await new ActivityStore(root).get(session.sessionId);
  const models = saved!.events.filter((event) => event.kind === 'model' && event.summary === 'Model turn completed.');
  assert.ok(models.some((event) => (event.cachedInputTokens ?? 0) > 0 && event.cacheHit === true), 'cached tokens are recorded per model call');
  assert.ok(saved!.run && saved!.run.cachedInputTokens > 0, 'and in the run split');
  const ended = saved!.events.filter((event) => event.kind === 'tool' && event.status === 'completed');
  assert.ok(ended.every((event) => event.tool && event.durationMs !== undefined), 'tool ends name their tool and duration');
  void ShellSession;
});

// Merge with main (PR 33): #33 lets a long run from a single request be summarized; with PERF-02's 70k threshold that must happen once when the
// transcript reaches it, not again on the turns right after (the summary itself is small), and no summary is announced when nothing was cut.
test('a long single-request run is summarized at the absolute threshold once, and the turns after it are not summarized again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-single-request-compact-'));
  for (let index = 0; index < 12; index += 1) await writeFile(path.join(root, `part-${index}.md`), Array.from({ length: 500 }, (_, line) => `evidence line ${line} ${'x'.repeat(40)}`).join('\n'));
  const sent: Array<{ summary: boolean; tokens: number }> = [];
  let turn = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[], tools: ToolDefinition[]): AsyncGenerator<CompletionEvent> {
      const summary = tools.length === 0 && String(messages[0]?.content ?? '').startsWith('You compress');
      const tokens = Math.ceil(messages.reduce((total, message) => total + String(message.content ?? '').length, 0) / 4);
      sent.push({ summary, tokens });
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1, inputTokens: tokens, outputTokens: 20 };
      if (summary) { yield { type: 'done', message: { role: 'assistant', content: 'Read parts 0 to N; each holds evidence.' }, finishReason: 'stop', usage }; return; }
      turn += 1;
      const next = turn <= 12 ? [call(`r${turn}`, 'Read', { file_path: `part-${turn - 1}.md` })] : undefined;
      yield { type: 'done', message: next ? { role: 'assistant', content: null, tool_calls: next } : { role: 'assistant', content: 'Done.' }, finishReason: next ? 'tool_calls' : 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'read every part', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, contextWindows: { m: 1_000_000 } });
  } finally {
    conversation.dispose();
  }
  const summaries = sent.map((request, index) => (request.summary ? index : -1)).filter((index) => index >= 0);
  assert.ok(summaries.length >= 1, 'the single-request run was summarized');
  for (const index of summaries) assert.equal(sent[index + 1]?.summary, false, 'a summary is never followed directly by another');
  const turns = sent.filter((request) => !request.summary);
  assert.ok(turns.every((request) => request.tokens < 70_000 + 8_000), `no turn is sent far past the threshold (${Math.max(...turns.map((request) => request.tokens))})`);
  assert.ok(summaries.length < turns.length / 2, `summaries (${summaries.length}) are rare compared with turns (${turns.length})`);
  assert.equal(posted.filter((message) => message.type === 'notice' && /was summarized/.test(String(message.text))).length, summaries.length, 'each real summary is announced once, none without one');
});
