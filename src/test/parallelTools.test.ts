import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun } from '../agent/loop';
import { DEFAULT_RULES } from '../agent/permissions';
import { isReadOnlyShellCommand } from '../agent/readOnlyShell';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { teamLeadPrompt } from '../agent/teams';
import { bashTool, CORE_TOOLS } from '../agent/tools';
import { checkCitationsTool, webFetchTool, webSearchTool } from '../agent/webTools';
import { Slots } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// PERF-04: lookups run side by side (the web tools, CheckCitations, and read-only shell commands), anything that changes state still runs alone and in
// order, worktree agents are capped, and the prompts tell agents to batch.

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function oneTurn(root: string, calls: ToolCall[]): Promise<{ events: AgentEvent[]; messages: AgentMessage[] }> {
  let turn = 0;
  const client = { async *streamCompletion(): AsyncGenerator<CompletionEvent> { turn += 1; yield { type: 'done', message: turn === 1 ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: 'done' }, finishReason: 'stop', usage: { verificationStatus: 'unknown', latencyMs: 1 } }; } };
  const shell = new ShellSession(root);
  const events: AgentEvent[] = [];
  try {
    const run = new AgentRun({ client, model: 'm', tools: CORE_TOOLS, context: { root, checkpoints: new RunCheckpoints('parallel'), shell, readFiles: new Set() }, policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, requestApproval: async () => ({ decision: 'allow' }), emit: (event) => events.push(event) });
    const result = await run.run([{ role: 'user', content: 'go' }], new AbortController().signal);
    return { events, messages: result.messages };
  } finally {
    shell.dispose();
  }
}

const order = (events: AgentEvent[]) => events.filter((event) => event.type === 'tool-start' || event.type === 'tool-end').map((event) => `${event.type === 'tool-start' ? 'start' : 'end'}:${event.callId}`);

test('WebFetch, WebSearch and CheckCitations run concurrently', () => {
  assert.equal(webFetchTool.concurrent, true);
  assert.equal(webSearchTool(undefined).concurrent, true);
  assert.equal(checkCitationsTool.capability, 'read', 'reads join every batch');
});

test('read-only shell commands are recognised strictly', () => {
  for (const command of ['git status', 'git log --oneline -5', 'git diff --stat HEAD~1', 'git show HEAD:README.md', 'ls -la src', 'grep -rn "TODO" src | head -20', 'wc -l a.md b.md', 'cat report.md | sort | uniq -c', 'git branch --show-current', 'find . -name "*.md"', 'rg foo && rg bar']) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
  for (const command of ['echo hi > out.txt', 'cat a >> b', 'git commit -m x', 'git push', 'git branch -D old', 'git tag v1', 'git remote add o url', 'cd src && ls', 'ls; rm x', 'ls & sleep 1', 'cat $(echo x)', 'cat `x`', 'echo $HOME', 'sed -n 1p a', 'find . -delete', 'find . -exec rm {} +', 'sort -o out a', 'npm test', 'node script.js', 'git diff --output=x', 'git -c core.pager=less log', 'cat a\nrm b', '']) {
    assert.equal(isReadOnlyShellCommand(command), false, JSON.stringify(command));
  }
});

test('read-only Bash calls in one turn start together; a command that changes state runs alone, in order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-parallel-'));
  const together = await oneTurn(root, [call('a', 'Bash', { command: 'ls' }), call('b', 'Bash', { command: 'git status' }), call('c', 'Read', { file_path: 'x.md' })]);
  assert.deepEqual(order(together.events).slice(0, 3), ['start:a', 'start:b', 'start:c'], 'all three started before any ended');
  const serial = await oneTurn(root, [call('w', 'Bash', { command: 'echo hi > out.txt' }), call('r', 'Bash', { command: 'cat out.txt' })]);
  assert.deepEqual(order(serial.events), ['start:w', 'end:w', 'start:r', 'end:r'], 'the write finished before the read started');
  assert.match(String(serial.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'r')?.content), /^hi/);
});

test('a read-only command runs at the agent shell\'s current folder, in a shell of its own', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-fork-'));
  await mkdir(path.join(root, 'sub'));
  const shell = new ShellSession(root);
  try {
    await shell.run('cd sub');
    const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('fork'), shell, readFiles: new Set<string>() };
    const output = await bashTool.run(bashTool.parse({ command: 'pwd' }), context);
    assert.match(output, /sub\n\n\[exit code 0\]$/);
    assert.equal(bashTool.concurrentFor?.(bashTool.parse({ command: 'pwd' })), true);
    assert.equal(bashTool.concurrentFor?.(bashTool.parse({ command: 'pwd', run_in_background: true })), false);
  } finally {
    shell.dispose();
  }
});

test('worktree agents beyond the cap wait for a slot', async () => {
  const slots = new Slots();
  const signal = new AbortController().signal;
  await slots.acquire(2, signal);
  await slots.acquire(2, signal);
  let third = false;
  const waiting = slots.acquire(2, signal).then(() => { third = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(third, false, 'the third waits while two are in use');
  slots.release();
  await waiting;
  assert.equal(third, true);
  assert.equal(slots.inUse, 2);
  const aborted = new AbortController();
  const refused = slots.acquire(2, aborted.signal);
  aborted.abort();
  await assert.rejects(refused);
});

test('the prompts tell agents to batch independent calls and teams to use worktrees for parallel writers', () => {
  const prompt = agentSystemPrompt({ root: '/p', platform: 'linux', date: '2026-11-10', isGitRepo: true, model: 'm' });
  assert.match(prompt, /# Working fast\n- Batch independent tool calls in one turn: .*every read-only Bash command/);
  const lead = teamLeadPrompt({ slug: 't', name: 'T', description: '', file: '/t.md', members: [{ name: 'a', tools: [], instructions: 'x' }] }, 'task');
  assert.match(lead, /start each with `isolation: "worktree"`/);
});

// Merge with main (PR 33): a command that ends the agent's shell finishes at once and resets the folder to the workspace; read-only commands forked
// from that shell afterwards (and side by side in one turn) still run, at the workspace.
test('read-only commands still run side by side after a command ended the agent\'s shell, at the folder the shell was reset to', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-fork-exit-'));
  await mkdir(path.join(root, 'sub'));
  const shell = new ShellSession(root);
  try {
    const context = { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('fork-exit'), shell, readFiles: new Set<string>() };
    await bashTool.run(bashTool.parse({ command: 'cd sub' }), context);
    const ended = await bashTool.run(bashTool.parse({ command: 'exit 3' }), context);
    assert.match(ended, /ended the shell/);
    const outputs = await Promise.all([bashTool.run(bashTool.parse({ command: 'pwd' }), context), bashTool.run(bashTool.parse({ command: 'ls' }), context)]);
    assert.match(outputs[0], new RegExp(`${path.basename(root)}\\n\\n\\[exit code 0\\]$`), 'the fork starts where the reset shell is: the workspace');
    assert.match(outputs[1], /^sub\n\n\[exit code 0\]$/);
    assert.match(await bashTool.run(bashTool.parse({ command: 'echo still-serial' }), context), /^still-serial/, 'the persistent shell starts again for the next command');
  } finally {
    shell.dispose();
  }
  const calls = [call('x', 'Bash', { command: 'exit 1' }), call('a', 'Bash', { command: 'git status' }), call('b', 'Bash', { command: 'ls' })];
  const { events } = await oneTurn(root, calls);
  assert.deepEqual(order(events).slice(0, 2), ['start:x', 'end:x'], 'the shell-ending command runs alone and finishes');
  assert.deepEqual(order(events).slice(2, 4), ['start:a', 'start:b'], 'the read-only calls after it still start together');
});
