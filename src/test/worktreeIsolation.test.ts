import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { DEFAULT_RULES } from '../agent/permissions';
import { gsdTools } from '../gsd/tools';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Open-GSD treats this runner as a `harness-worktree` host: an Agent call with
// isolation="worktree" must run in its own git worktree on a new branch, leave the main checkout
// alone, and keep the branch for the orchestrator to merge.

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const usage = { inputTokens: 10, outputTokens: 5, verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const done = (message: Extract<AgentMessage, { role: 'assistant' }>): CompletionEvent => ({ type: 'done', message, finishReason: message.tool_calls ? 'tool_calls' : 'stop', usage });

async function repository() {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-wt-storage-'));
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-wt-'));
  await git(root, 'init', '-q');
  await git(root, 'config', 'user.email', 'test@example.invalid');
  await git(root, 'config', 'user.name', 'Test');
  await writeFile(path.join(root, 'README.md'), 'sample\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-qm', 'initial');
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-wt-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-executor', description: 'Executes', tools: ['Bash', 'Write'], body: 'You are the executor.', file: path.join(home, 'agents', 'gsd-executor.md') }], shellEnv: {} };
  return { root, storage, gsd };
}

test('isolation="worktree" runs each agent on its own branch in its own directory, and keeps the main checkout untouched', async () => {
  const { root, storage, gsd } = await repository();
  const systems: string[] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const system = String(messages[0]?.content);
      if (system.startsWith('You are the executor.')) {
        systems.push(system);
        const task = String(messages[1]?.content);
        const last = messages.at(-1)!;
        if (last.role === 'user' && task === 'noop') { yield done({ role: 'assistant', content: 'nothing to do' }); return; }
        if (last.role === 'user') {
          yield done({ role: 'assistant', content: null, tool_calls: [call(`b-${task}`, 'Bash', { command: `echo ${task} > ${task}.txt && git add ${task}.txt && git commit -qm "add ${task}" && git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD` })] });
          return;
        }
        yield done({ role: 'assistant', content: `done ${task}: ${String(last.content).trim()}` });
        return;
      }
      if (!messages.some((message) => message.role === 'tool')) {
        yield done({ role: 'assistant', content: null, tool_calls: ['alpha', 'beta', 'noop'].map((task) => call(`a-${task}`, 'Agent', { subagent_type: 'gsd-executor', prompt: task, isolation: 'worktree' })) });
        return;
      }
      yield done({ role: 'assistant', content: 'wave complete' });
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(storage, 'checkpoints'));
  try {
    await conversation.send({ text: 'execute', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  } finally {
    conversation.dispose();
  }
  const result = (task: string) => String(posted.find((message) => message.type === 'tool-end' && message.callId === `a-${task}`)?.output);
  assert.equal(existsSync(path.join(root, 'alpha.txt')), false, 'nothing landed in the main checkout');
  assert.equal(await git(root, 'status', '--porcelain'), '');
  assert.equal(await git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), (await git(root, 'branch', '--show-current')), 'the main checkout stayed on its branch');
  for (const task of ['alpha', 'beta']) {
    const branch = /on branch (worktree-agent-gsd-executor-[a-f0-9]{6})/.exec(result(task))?.[1];
    assert.ok(branch, `the report names the branch: ${result(task)}`);
    const worktree = /at (\S+) and have not been merged/.exec(result(task))![1];
    assert.ok(!worktree.startsWith(root), 'the worktree is outside the project');
    assert.ok(worktree.startsWith(path.join(storage, 'worktrees')));
    assert.match(result(task), new RegExp(`done ${task}: ${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n${branch}`), 'the agent ran with the worktree as its root and HEAD on its branch');
    assert.equal(await git(root, 'log', '-1', '--format=%s', branch!), `add ${task}`, 'its commit is on its branch');
  }
  assert.match(result('noop'), /changed nothing, so the worktree was removed/);
  assert.deepEqual((await git(root, 'branch', '--list', 'worktree-agent-*')).split('\n').length, 2, 'only the branches with work remain');
  assert.ok(systems.every((system) => /isolated git worktree at .* on branch worktree-agent-/.test(system)), 'each agent is told where it works');
});

test('isolation="worktree" outside a git repository is refused with a clear reason', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-wt-nogit-'));
  const { gsd, storage } = await repository();
  let parentTurns = 0;
  const near = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      parentTurns += 1;
      if (parentTurns === 1) yield done({ role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { subagent_type: 'gsd-executor', prompt: 'x', isolation: 'worktree' })] });
      else yield done({ role: 'assistant', content: 'ok' });
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(storage, 'checkpoints'));
  try {
    await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
  } finally {
    conversation.dispose();
  }
  assert.match(String(posted.find((message) => message.type === 'tool-end' && message.callId === 'a1')?.output), /needs a git repository/);
});

test('SlashCommand loads the named skill with its arguments, as workflows use it to chain', async () => {
  const tools = gsdTools({ home: '/none', root: '/none', agents: [], ask: async () => [], spawn: async () => '', skills: [{ name: 'gsd-plan-phase', description: 'Plan', allowedTools: [], body: 'Plan phase with: $ARGUMENTS', file: '/none/SKILL.md', includes: [] }] });
  const slash = tools.find((tool) => tool.name === 'SlashCommand')!;
  const input = slash.parse({ command: '/gsd-plan-phase 1 --auto' });
  assert.deepEqual(input, { name: 'gsd-plan-phase', args: '1 --auto' });
  assert.match(await slash.run(input, {} as never), /Plan phase with: 1 --auto/);
  assert.throws(() => slash.parse({ command: '' }), /must look like/);
});
