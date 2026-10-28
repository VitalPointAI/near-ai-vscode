import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { TaskBoard } from '../agent/taskBoard';
import type { Todo } from '../agent/tools';
import { AgentConversation, GsdContext } from '../services/agentSession';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// The Tasks panel follows sub-agents: an Agent call that names its task moves that item to in
// progress, then completed (or back to pending) as soon as that agent ends, without waiting for
// its siblings. Sub-agents' own lists show as steps in their row. The main agent's TodoWrite wins
// unless it only echoes its own stale status for an item the host moved.

const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const todo = (content: string, status: Todo['status'], activeForm?: string): Todo => ({ content, status, ...(activeForm ? { activeForm } : {}) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shown = (todos: Todo[]) => todos.map((item) => `${item.content}:${item.status}`).join(' ');

test('TaskBoard: matches exactly, then ignoring case and surrounding space, never fuzzily', () => {
  const board = new TaskBoard();
  board.write([todo('Write the parser', 'pending'), todo('write the parser tests', 'pending')]);
  assert.equal(board.set('Write the parser', 'in_progress'), 'Write the parser');
  assert.equal(board.set('  WRITE THE PARSER TESTS ', 'in_progress'), 'write the parser tests');
  assert.equal(board.set('Write parser', 'completed'), undefined, 'no fuzzy match');
  assert.equal(board.set('the parser', 'completed'), undefined);
});

test('TaskBoard: the main list wins, but an echo of its own stale status keeps what the host set', () => {
  const board = new TaskBoard();
  board.write([todo('A', 'in_progress'), todo('B', 'pending'), todo('C', 'pending')]);
  board.set('A', 'completed');
  board.set('B', 'completed');
  // The main agent resends its old list: A and B were not changed by it, so the host's status stays.
  assert.equal(shown(board.write([todo('A', 'in_progress'), todo('B', 'pending'), todo('C', 'in_progress')])), 'A:completed B:completed C:in_progress');
  // Now it changes B away from what it last sent: an explicit decision, which wins.
  assert.equal(shown(board.write([todo('A', 'in_progress'), todo('B', 'in_progress'), todo('C', 'completed')])), 'A:completed B:in_progress C:completed');
  // An item it drops is dropped.
  assert.equal(shown(board.write([todo('C', 'completed')])), 'C:completed');
  assert.equal(board.unfinished, false);
});

test('parallel sub-agents move their own task-list items as each one ends; a failure resets to pending', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  const mainRequests: AgentMessage[][] = [];
  const subTurns = new Map<string, number>();
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      const prompt = String(messages[1]?.content ?? '');
      const sub = /^do (\w)$/.exec(prompt);
      if (sub) {
        const which = sub[1];
        const turn = (subTurns.get(which) ?? 0) + 1;
        subTurns.set(which, turn);
        if (which === 'B' && turn === 1) {
          yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('bt', 'TodoWrite', { todos: [todo('Read the code', 'completed'), todo('Write tests', 'in_progress', 'Writing tests')] })] }, finishReason: 'tool_calls', usage };
          return;
        }
        // Staggered: B ends first, then C fails, then A.
        await sleep(which === 'A' ? 150 : which === 'B' ? 40 : 90);
        if (which === 'C') throw Object.assign(new Error('C broke'), { retryable: false });
        yield { type: 'done', message: { role: 'assistant', content: `${which} done` }, finishReason: 'stop', usage };
        return;
      }
      mainRequests.push([...messages]);
      const turn = mainRequests.length;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('t1', 'TodoWrite', { todos: [todo('Task A', 'pending'), todo('Task B', 'pending'), todo('Task C', 'pending')] })] }, finishReason: 'tool_calls', usage }; return; }
      if (turn === 2) {
        yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: ['A', 'B', 'C'].map((which) => call(`a${which}`, 'Agent', { description: `do ${which}`, prompt: `do ${which}`, task: which === 'B' ? '  task b ' : `Task ${which}` })) }, finishReason: 'tool_calls', usage };
        return;
      }
      // A stale echo of its first list: the host's statuses stay.
      if (turn === 3) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('t3', 'TodoWrite', { todos: [todo('Task A', 'pending'), todo('Task B', 'pending'), todo('Task C', 'pending')] })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'All set.' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'plan it', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd, maxParallelAgents: 4 });
    const lists = posted.filter((message) => message.type === 'todos').map((message) => shown(message.todos as Todo[]));
    assert.equal(lists[0], 'Task A:pending Task B:pending Task C:pending');
    assert.equal(lists[3], 'Task A:in_progress Task B:in_progress Task C:in_progress', 'each starts in progress as its agent starts');
    assert.deepEqual(lists.slice(4), [
      'Task A:in_progress Task B:completed Task C:in_progress',
      'Task A:in_progress Task B:completed Task C:pending',
      'Task A:completed Task B:completed Task C:pending',
      'Task A:completed Task B:completed Task C:pending'
    ], 'B completes first, C resets on failure, then A completes; the stale TodoWrite echo does not undo them');

    // What the main agent saw: each result says what happened to its item, plus a reminder while items are unfinished.
    const results = mainRequests[2].filter((message) => message.role === 'tool').map((message) => String(message.content)).slice(-3);
    assert.match(results[0], /A done\n\nTask list: "Task A" is now marked completed\.\nUpdate the task list with TodoWrite if this finished a task\.$/);
    assert.match(results[1], /Task list: "Task B" is now marked completed\./);
    assert.match(results[2], /C broke[\s\S]*Task list: "Task C" is back to pending/);

    // B's own steps showed in its row, not in the main list.
    const rows = posted.filter((message) => message.type === 'agents').flatMap((message) => message.agents as Array<{ label: string; description: string; steps?: unknown }>);
    assert.deepEqual(rows.find((row) => row.description === 'do B' && row.steps)?.steps, { done: 1, total: 2, active: 'Writing tests' });
    assert.equal(lists.some((list) => list.includes('Read the code')), false);
  } finally {
    conversation.dispose();
  }
});

test('the Agent result has no task-list reminder when there is no list, or nothing is unfinished', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-none-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-none-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  for (const list of [undefined, [todo('Only task', 'completed')]]) {
    const mainRequests: AgentMessage[][] = [];
    const near = {
      async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
        if (String(messages[1]?.content) === 'help') { yield { type: 'done', message: { role: 'assistant', content: 'helped' }, finishReason: 'stop', usage }; return; }
        mainRequests.push([...messages]);
        const turn = mainRequests.length;
        if (turn === 1 && list) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('t1', 'TodoWrite', { todos: list })] }, finishReason: 'tool_calls', usage }; return; }
        if (turn === (list ? 2 : 1)) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('a1', 'Agent', { description: 'help', prompt: 'help' })] }, finishReason: 'tool_calls', usage }; return; }
        yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
      },
      async actualCostsUsd() { return undefined; }
    };
    const conversation = new AgentConversation(root, () => undefined, path.join(root, '.ckpt'));
    try {
      await conversation.send({ text: 'go', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
      const result = mainRequests.at(-1)!.filter((message) => message.role === 'tool').map((message) => String(message.content)).at(-1);
      assert.equal(result, 'helped', JSON.stringify(list));
    } finally {
      conversation.dispose();
    }
  }
});

test('the Agent tool documents task, and the running-agents row shows steps', () => {
  const tools = readFileSync(path.join(__dirname, '..', '..', 'src', 'gsd', 'tools.ts'), 'utf8');
  assert.match(tools, /task: \{ type: 'string', description: 'The exact content of the task-list item this agent works on\./);
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /agent\.steps\.done \+ '\/' \+ agent\.steps\.total \+ ' steps'/);
});
