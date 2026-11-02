import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { CORE_TOOLS } from '../agent/tools';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Guards against runs that burn tokens without producing anything: an agent repeating the same
// action is nudged and then stopped, and a run stops at its cost or token budget.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function runScript(next: (turn: number, messages: AgentMessage[]) => ToolCall[] | string) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-loop-guard-'));
  let turn = 0;
  const transcripts: AgentMessage[][] = [];
  const client = { async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> { transcripts.push(structuredClone(messages)); const step = next(turn++, messages); yield { type: 'done', message: typeof step === 'string' ? { role: 'assistant', content: step } : { role: 'assistant', content: null, tool_calls: step }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  const texts: string[] = [];
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, maxTurns: 60, context: { root, checkpoints: new RunCheckpoints('guard'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => { if (event.type === 'text') texts.push(event.text); } });
    const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { result, turns: turn, transcripts, texts };
  } finally {
    shell.dispose();
  }
}

test('an agent repeating the same action with the same result is nudged, then warned, then stopped as stuck', async () => {
  // 0.4.12: the first Write creates the file and every later one replaces it with the same
  // result, so the count starts at the second call: nudge at 8, warning at 11, stop at 14 repeats.
  const { result, turns, transcripts, texts } = await runScript((turn) => [call(`w${turn}`, 'Write', { file_path: '.planning/probe.cjs', content: `// attempt ${turn}` })]);
  assert.equal(result.outcome, 'stuck');
  assert.deepEqual(result.stop, { kind: 'loop', action: 'Write .planning/probe.cjs', count: 14 });
  assert.equal(turns, 15, 'stopped at the 14th repetition of the same result, not the 60-turn limit');
  const guard = (start: string) => transcripts.at(-1)!.filter((message) => message.role === 'user' && String(message.content).startsWith(start));
  const nudges = guard('<loop-guard>You have repeated');
  assert.equal(nudges.length, 1, 'nudged once, at the 8th repetition');
  assert.match(String(nudges[0].content), /Write \.planning\/probe\.cjs.*8 times.*result did not change/);
  const warnings = guard('<loop-guard>Warning:');
  assert.equal(warnings.length, 1, 'warned once, at the 11th repetition');
  assert.match(String(warnings[0].content), /Write \.planning\/probe\.cjs 11 times and got the same result every time \(it starts: "Replaced \.planning\/probe\.cjs \(1 lines\)\."\)\. .*Change your approach now: run a different command, read the error in that result and fix its cause, or finish and report/);
  assert.match(String(result.messages.at(-1)?.content), /^<loop-guard>Stopped: you ran the same action \(Write \.planning\/probe\.cjs\) 14 times and its result did not change/);
  assert.doesNotMatch(texts.join(''), /Stopped/, 'the run reports the stop through its outcome; the chat words it');
});

test('the owner\'s case: many different `cd <worktree> && ...` commands with different output are never a loop', async () => {
  // As the model wrote them: the same `cd <worktree> &&` prefix on every command (a real
  // directory here, so the commands run), different commands, different output.
  const worktree = tmpdir();
  const commands = ['npm test', 'git status', 'npx tsc --noEmit', 'git diff --stat', 'ls src'];
  const { result, turns, transcripts } = await runScript((turn) => {
    if (turn >= 24) return 'Nothing is blocking: the facade typechecks.';
    return [call(`b${turn}`, 'Bash', { command: `cd ${worktree} && echo "${commands[turn % commands.length]} run ${turn}"` })];
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(turns, 25);
  assert.equal(transcripts.at(-1)!.some((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>')), false, 'never nudged');
});

test('the same command whose output keeps changing is not a loop', async () => {
  const { result, turns, transcripts } = await runScript((turn) => (turn < 24 ? [call(`b${turn}`, 'Bash', { command: 'cd . && echo run >> runs.log && wc -l < runs.log' })] : 'done'));
  assert.equal(result.outcome, 'completed');
  assert.equal(turns, 25);
  assert.equal(transcripts.at(-1)!.some((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>')), false);
});

test('a genuine loop (same command, same output) is nudged, warned, then stopped; changing approach after the nudge lets it finish', async () => {
  const stuck = await runScript((turn) => [call(`b${turn}`, 'Bash', { command: `cd . &&  FORCE_COLOR=0 cat missing-${'file'}.txt` })]);
  assert.equal(stuck.result.outcome, 'stuck');
  assert.deepEqual(stuck.result.stop, { kind: 'loop', action: 'Bash cat missing-file.txt', count: 14 });
  assert.equal(stuck.turns, 14);
  const last = stuck.transcripts.at(-1)!;
  assert.equal(last.filter((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>You have repeated the same action (Bash cat missing-file.txt) 8 times')).length, 1);
  const warning = last.find((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>Warning:'));
  assert.match(String(warning?.content), /run Bash cat missing-file\.txt 11 times and got the same result every time \(it starts: "cat: missing-file\.txt: No such file or directory/);

  // The agent reads the nudge and does something else: no warning, no stop.
  const recovered = await runScript((turn, messages) => {
    const nudged = messages.some((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>'));
    if (!nudged) return [call(`b${turn}`, 'Bash', { command: 'cat missing.txt' })];
    return turn < 16 ? [call(`r${turn}`, 'Bash', { command: `echo fixed-${turn}` })] : 'Created the file and moved on.';
  });
  assert.equal(recovered.result.outcome, 'completed');
  assert.equal(recovered.transcripts.at(-1)!.filter((message) => message.role === 'user' && String(message.content).startsWith('<loop-guard>')).length, 1, 'one nudge, then it recovered on its own');
});

test('loop keys: leading cd and variable assignments are removed and the whole command is kept; results ignore timestamps and durations', async () => {
  const { loopActionKey, normalizeShellCommand, resultSignature } = await import('../agent/loop');
  assert.equal(normalizeShellCommand('cd /a/b && npm test'), 'npm test');
  assert.equal(normalizeShellCommand('cd "/a b" ; cd sub &&  CI=1 NODE_ENV=test   npm run test -- --grep x'), 'npm run test -- --grep x');
  assert.equal(normalizeShellCommand('cd /a/b'), 'cd /a/b', 'a bare cd stays itself');
  assert.notEqual(normalizeShellCommand('cd X && npm test'), normalizeShellCommand('cd X && git status'));
  assert.equal(loopActionKey(call('1', 'Bash', { command: 'cd /w && git status' })), 'Bash git status');
  const owner = 'cd /home/aaron/projects/codequity/near-ai-vscode/.claude/worktrees/cyber-harness && ';
  assert.notEqual(loopActionKey(call('3', 'Bash', { command: `${owner}npm test` })), loopActionKey(call('4', 'Bash', { command: `${owner}git status` })), 'the owner\'s commands are different actions');
  assert.equal(loopActionKey(call('2', 'Read', { file_path: 'a.ts', offset: 40 })), 'Read a.ts@40');
  assert.equal(resultSignature('ok 12 tests in 3.4s at 2026-11-02T10:00:01Z (10:00:01)'), resultSignature('ok 12 tests in 5.1s at 2026-11-02T10:07:44Z (10:07:44)'));
  assert.notEqual(resultSignature('ok 12 tests'), resultSignature('ok 13 tests'));
});

test('varied work, and reading one file in chunks, are not treated as a loop', async () => {
  const { result, turns } = await runScript((turn) => (turn < 30 ? [call(`c${turn}`, turn % 2 ? 'Write' : 'Read', turn % 2 ? { file_path: `src/file${turn}.js`, content: 'x' } : { file_path: 'big.log', offset: turn * 100 })] : 'done'));
  assert.equal(result.outcome, 'completed');
  assert.equal(turns, 31);
});

test('a run stops at its cost budget, counting its sub-agents, and keeps its work', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-budget-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-budget-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let childTurns = 0;
  let parentTurns = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { inputTokens: 10_000, outputTokens: 500, estimatedCostUsd: 1, verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are the worker.')) { childTurns += 1; yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`r${childTurns}`, 'Read', { file_path: `f${childTurns}.txt` })] }, finishReason: 'tool_calls', usage }; return; }
      parentTurns += 1;
      yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', prompt: 'keep going' })] }, finishReason: 'tool_calls', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd, budget: { maxCostUsd: 3.5, maxTokens: 10_000_000 } });
  } finally {
    conversation.dispose();
  }
  assert.equal(parentTurns + childTurns, 4, `stopped after $4 of $3.50 (parent ${parentTurns}, child ${childTurns})`);
  assert.ok(posted.some((message) => message.type === 'notice' && /Stopped the run: its estimated cost reached \$4\.00, the limit for one run \(\$3\.50/.test(String(message.text))));
  assert.ok(posted.some((message) => message.type === 'assistant-cancelled'));
});

test('an approval nobody answers is declined after the timeout, and the run carries on', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-approval-timeout-'));
  let turn = 0;
  let toolResult = '';
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('w1', 'Write', { file_path: 'notes.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
      toolResult = String(messages.at(-1)?.content);
      yield { type: 'done', message: { role: 'assistant', content: 'Could not write notes.md: it needs your approval.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.approvalTimeoutMs = 50;
  try {
    await conversation.send({ text: 'write notes', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  } finally {
    conversation.dispose();
  }
  assert.ok(posted.some((message) => message.type === 'approval-request'));
  assert.match(String(posted.find((message) => message.type === 'approval-expired')?.text), /No one approved "Write notes\.md" within 0 minutes, so it was declined/);
  assert.match(toolResult, /declined[\s\S]*Nobody answered within 0 minutes/);
  assert.ok(posted.some((message) => message.type === 'assistant-done'), 'the run finished instead of waiting');
});

test('each reply is capped, a cut-off reply asks for a shorter continuation and its tool call is not run, and repeated cut-offs stop the agent', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const { NearAiClient } = await import('../services/nearAiClient');
  const capped = new NearAiClient({ baseUrl: 'https://example.test/v1', apiKey: 'k', fetchFn: (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'small', max_output_tokens: 8_000 }, { id: 'big' }] }));
    sent.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }) as typeof fetch });
  await capped.listModels().catch(() => undefined);
  for await (const event of capped.streamCompletion('small', [{ role: 'user', content: 'hi' }], [])) void event;
  for await (const event of capped.streamCompletion('big', [{ role: 'user', content: 'hi' }], [], undefined, { maxOutputTokens: 12_000 })) void event;
  assert.deepEqual(sent.map((body) => body.max_tokens), [8_000, 12_000], 'the default 32,000 is lowered to the model\'s own limit; a setting applies otherwise');

  const { result, turns, transcripts, texts } = await runScriptWithFinish((turn) => (turn === 0 ? { calls: [call('w1', 'Write', { file_path: 'half.md', content: 'trunc' })], finish: 'length' } : turn < 6 ? { text: 'and so on and so on', finish: 'length' } : { text: 'done', finish: 'stop' }));
  assert.match(String(transcripts[1].at(-1)?.content), /^<output-limit>Your last reply hit the output limit and was cut off/);
  assert.ok(!transcripts[1].some((message) => message.role === 'tool'), 'the cut-off tool call was not run');
  // 0.4.12: a stop for not making progress has its own outcome, and the chat words it (see stopNotice).
  assert.equal(result.outcome, 'stuck');
  assert.deepEqual(result.stop, { kind: 'output-limit' });
  assert.equal(turns, 4, 'stopped at the fourth cut-off reply');
  const { stopNotice } = await import('../services/agentSession');
  assert.equal(stopNotice(result), 'Stopped: the agent\'s replies kept running past the output limit.');
  void texts;
});

async function runScriptWithFinish(next: (turn: number) => { calls?: ToolCall[]; text?: string; finish: string }) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-output-limit-'));
  let turn = 0;
  const transcripts: AgentMessage[][] = [];
  const client = { async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> { transcripts.push(structuredClone(messages)); const step = next(turn++); yield { type: 'done', message: { role: 'assistant', content: step.text ?? null, ...(step.calls ? { tool_calls: step.calls } : {}) }, finishReason: step.finish, usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  const texts: string[] = [];
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, maxTurns: 30, context: { root, checkpoints: new RunCheckpoints('limit'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => { if (event.type === 'text') texts.push(event.text); } });
    return { result: await run.run([{ role: 'user', content: 'go' }], new AbortController().signal), turns: turn, transcripts, texts };
  } finally {
    shell.dispose();
  }
}

test('the token limit applies only to turns without a known price; priced turns are bounded by cost', async () => {
  const runWith = async (priced: boolean) => {
    const root = await mkdtemp(path.join(tmpdir(), 'near-ai-token-cap-'));
    let turns = 0;
    const near = {
      async *streamCompletion(): AsyncGenerator<CompletionEvent> {
        turns += 1;
        const usage = { inputTokens: 900_000, cachedInputTokens: 850_000, outputTokens: 1_000, ...(priced ? { estimatedCostUsd: 0.05 } : {}), verificationStatus: 'unknown' as const, latencyMs: 1 };
        yield { type: 'done', message: turns < 6 ? { role: 'assistant', content: null, tool_calls: [call(`r${turns}`, 'Read', { file_path: `f${turns}.txt` })] } : { role: 'assistant', content: 'done' }, finishReason: turns < 6 ? 'tool_calls' : 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    const posted: Array<Record<string, unknown>> = [];
    const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
    try {
      await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, budget: { maxCostUsd: 5, maxTokens: 2_000_000 } });
    } finally {
      conversation.dispose();
    }
    return { turns, posted, spend: conversation.runSpend };
  };
  const priced = await runWith(true);
  assert.equal(priced.turns, 6, 'about 5.4M mostly cached tokens costing $0.30 run to the end');
  assert.ok(!priced.posted.some((message) => message.type === 'notice' && /Stopped the run/.test(String(message.text))));
  assert.deepEqual([priced.spend.totalTokens, priced.spend.cachedTokens, priced.spend.unpricedTokens], [5_406_000, 5_100_000, 0]);
  const unpriced = await runWith(false);
  assert.equal(unpriced.turns, 3, 'without prices, the token limit stops it');
  assert.ok(unpriced.posted.some((message) => message.type === 'notice' && /tokens on models without published prices/.test(String(message.text))));
});

test('a sub-agent stopped for repeating itself tells its lead it did not finish, and the stop sentences are honest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-stuck-child-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-stuck-child-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let report = '';
  let childTurns = 0;
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
      if (String(messages[0].content).startsWith('You are the worker.')) { childTurns += 1; yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call(`r${childTurns}`, 'Read', { file_path: 'missing.txt' })] }, finishReason: 'tool_calls', usage }; return; }
      const done = messages.some((message) => message.role === 'tool');
      if (done) report = String(messages.at(-1)?.content);
      yield { type: 'done', message: done ? { role: 'assistant', content: 'The worker got stuck.' } : { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-worker', prompt: 'read it' })] }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  } finally {
    conversation.dispose();
  }
  assert.equal(childTurns, 14);
  assert.match(report, /gsd-worker did not finish\. Stopped: the agent kept repeating Read missing\.txt with the same result\./);

  const { stopNotice } = await import('../services/agentSession');
  assert.equal(stopNotice({ outcome: 'max-turns', stop: { kind: 'turn-limit', turns: 400 } }), 'Stopped after reaching the turn limit (400 turns).');
  assert.equal(stopNotice({ outcome: 'stuck', stop: { kind: 'loop', action: 'Bash npm test', count: 14 } }), 'Stopped: the agent kept repeating Bash npm test with the same result.');
  assert.equal(stopNotice({ outcome: 'completed' }), undefined);
  assert.equal(stopNotice({ outcome: 'cancelled' }), undefined);
});
