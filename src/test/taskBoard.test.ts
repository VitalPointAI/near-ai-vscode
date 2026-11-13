import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { TaskBoard } from '../agent/taskBoard';
import type { Todo } from '../agent/tools';
import { isSyntheticMessage } from '../domain/state/threadCapture';
import { AgentConversation, GsdContext, visibleTurns } from '../services/agentSession';
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
      'Task A:completed Task B:completed Task C:pending',
      'Task A:completed Task B:completed Task C:pending'
    ], 'B completes first, C resets on failure, then A completes; the stale TodoWrite echo does not undo them; the run end posts the real list once more');
    const flagged = posted.filter((message) => message.type === 'todos');
    assert.deepEqual(flagged.map((message) => message.unconfirmed === true), flagged.map((_, index) => index === flagged.length - 1), 'only the run-end list is flagged unconfirmed');

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

// ---- Run-end task-list check (quick 261113-lbo) ------------------------------------------------------------------------------------------
// A run whose work finished but whose list was never updated gets one reminder to the model; the host itself never marks an item done.

const reply = (content: string | null, calls?: ToolCall[]): CompletionEvent => ({ type: 'done', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, finishReason: calls ? 'tool_calls' : 'stop', usage });
const listWrite = (id: string, ...items: Array<[string, Todo['status']]>) => reply(null, [call(id, 'TodoWrite', { todos: items.map(([content, status]) => todo(content, status)) })]);

interface Scripted { posted: Array<Record<string, unknown>>; requests: AgentMessage[][]; conversation: AgentConversation }

/** Runs `sends` on one conversation against a scripted main model: `script(n, messages)` answers its n-th request (1-based, across all sends). */
async function scripted(script: (n: number, messages: AgentMessage[]) => CompletionEvent, sends: string[] = ['go'], options: { maxTurns?: number; tolerate?: boolean } = {}): Promise<Scripted> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-run-'));
  const requests: AgentMessage[][] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      requests.push([...messages]);
      yield script(requests.length, messages);
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    for (const text of sends) await conversation.send({ text, client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}) }).catch((error) => { if (!options.tolerate) throw error; });
  } finally {
    conversation.dispose();
  }
  return { posted, requests, conversation };
}

const todoPosts = (posted: Array<Record<string, unknown>>) => posted.filter((message) => message.type === 'todos');
const reminders = (requests: AgentMessage[][]) => (requests.at(-1) ?? []).filter((message) => message.role === 'user' && message.content.startsWith('<task-list-check>'));

test('TaskBoard: revision goes up on write, on a matched set and on clear, not on a miss', () => {
  const board = new TaskBoard();
  const start = board.revision;
  board.write([todo('A', 'pending')]);
  assert.ok(board.revision > start);
  const afterWrite = board.revision;
  assert.equal(board.set('nothing like it', 'completed'), undefined);
  assert.equal(board.revision, afterWrite, 'a set that matches nothing changes nothing');
  assert.equal(board.set('A', 'in_progress'), 'A');
  assert.ok(board.revision > afterWrite);
  const afterSet = board.revision;
  board.clear();
  assert.ok(board.revision > afterSet);
});

test('TaskBoard: a completed status the host set survives two stale echoes in a row', () => {
  const board = new TaskBoard();
  board.write([todo('A', 'pending'), todo('B', 'pending')]);
  board.set('A', 'completed');
  assert.equal(shown(board.write([todo('A', 'pending'), todo('B', 'in_progress')])), 'A:completed B:in_progress');
  assert.equal(shown(board.write([todo('A', 'pending'), todo('B', 'completed')])), 'A:completed B:completed');
});

test('TaskBoard: a completed status the model sends always wins', () => {
  const first = new TaskBoard();
  first.write([todo('A', 'pending')]);
  first.set('A', 'in_progress');
  assert.equal(shown(first.write([todo('A', 'completed')])), 'A:completed');
  // A sub-agent for the item failed and the host moved it back to pending: the model's own completed, the same as its last status, still wins.
  const second = new TaskBoard();
  second.write([todo('A', 'completed')]);
  second.set('A', 'pending');
  assert.equal(shown(second.write([todo('A', 'completed')])), 'A:completed');
});

test('a run whose work finished but whose list was never updated gets one reminder and ends N/N', async () => {
  const { posted, requests } = await scripted((n, messages) => {
    if (n === 1) return listWrite('t1', ['A', 'pending'], ['B', 'pending'], ['C', 'pending']);
    if (n === 2) return reply('Done.');
    if (n === 3) {
      const last = messages.at(-1);
      assert.ok(last?.role === 'user' && last.content.startsWith('<task-list-check>') && last.content.endsWith('</task-list-check>'));
      for (const item of ['A', 'B', 'C']) assert.ok(last.content.includes(`"${item}" (pending)`), last.content);
      return listWrite('t3', ['A', 'completed'], ['B', 'completed'], ['C', 'completed']);
    }
    return reply('All three are done.');
  }, ['go'], { maxTurns: 10 });
  const last = todoPosts(posted).at(-1)!;
  assert.equal(shown(last.todos as Todo[]), 'A:completed B:completed C:completed');
  assert.equal(last.unconfirmed, undefined);
  assert.equal(reminders(requests).length, 1, 'one reminder in the whole transcript');
  assert.equal(requests.length, 4);
});

test('a model that ignores the reminder gets no second one, and the host never marks anything done', async () => {
  const { posted, requests } = await scripted((n) => {
    if (n === 1) return listWrite('t1', ['A', 'pending'], ['B', 'pending'], ['C', 'pending']);
    return reply('Done.');
  }, ['go'], { maxTurns: 10 });
  assert.equal(requests.length, 3, 'list, answer, then one answer to the reminder');
  assert.equal(reminders(requests).length, 1);
  assert.equal(posted.some((message) => message.type === 'run-stopped'), false);
  const last = todoPosts(posted).at(-1)!;
  assert.equal(shown(last.todos as Todo[]), 'A:pending B:pending C:pending');
  assert.equal(last.unconfirmed, true, 'the run ended with the items not confirmed done');
});

test('a run that did not touch the list, or ended with it all completed, gets no reminder', async () => {
  const untouched = await scripted((n) => (n === 1 ? listWrite('t1', ['A', 'pending']) : reply('Done.')), ['go', 'and another thing'], { maxTurns: 10 });
  // First run: list then answer, then the reminder's answer (3 requests). Second run: the list is unchanged in it, so exactly one request.
  assert.equal(untouched.requests.length, 4);
  const finished = await scripted((n) => (n === 1 ? listWrite('t1', ['A', 'completed']) : reply('Done.')), ['go'], { maxTurns: 10 });
  assert.equal(finished.requests.length, 2);
  assert.equal(reminders(finished.requests).length, 0);
});

test('the reminder never pushes a run into the turn limit: it needs two spare turns', async () => {
  const script = (n: number) => (n === 1 ? listWrite('t1', ['A', 'pending']) : reply('Done.'));
  const tight = await scripted(script, ['go'], { maxTurns: 2 });
  assert.equal(tight.requests.length, 2);
  assert.equal(tight.posted.some((message) => message.type === 'run-stopped'), false);
  const roomy = await scripted(script, ['go'], { maxTurns: 4 });
  assert.equal(reminders(roomy.requests).length, 1);
});

test('the reminder is hidden from the reopened view and from the thread log', () => {
  const messages: AgentMessage[] = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'Done.' },
    { role: 'user', content: '<task-list-check>\nYour task list still shows 1 of 1 items not completed: "A" (pending).\n</task-list-check>' },
    { role: 'assistant', content: 'ok' }
  ];
  assert.deepEqual(visibleTurns(messages).map((turn) => turn.role), ['user', 'assistant']);
  assert.equal(isSyntheticMessage(messages[2]), true);
  assert.equal(isSyntheticMessage(messages[0]), false);
});

// ---- Tolerant, numbered sub-agent task matching (quick 261113-lbo) ------------------------------------------------------------------------
// Deterministic steps only: a guess would mark the wrong item done, so an ambiguous or one-word name moves nothing.

const boardOf = (...contents: string[]) => { const board = new TaskBoard(); board.write(contents.map((content) => todo(content, 'pending'))); return board; };

test('TaskBoard: a task may name its item by number', () => {
  const board = boardOf('Write the parser', 'Add login page', 'Ship release 0.4.20');
  for (const task of ['2', '#2', 'item 2', 'task 2', ' Task 2 ']) assert.equal(board.set(task, 'in_progress'), 'Add login page', task);
  assert.equal(board.set('#3', 'in_progress'), 'Ship release 0.4.20');
  assert.equal(board.set('9', 'in_progress'), undefined);
  // An item whose content is literally "2" is matched exactly first.
  const literal = boardOf('First', '2', 'Third');
  assert.equal(literal.set('2', 'completed'), '2');
});

test('TaskBoard: punctuation, quotes and leading list markers are ignored', () => {
  const board = boardOf('Write the parser', 'Add login page');
  for (const task of ['"Write the parser."', '1. Write the parser', '- [ ] Write the parser', '* write the parser!', '[x] Write the parser', '#1 Write the parser']) assert.equal(board.set(task, 'in_progress'), 'Write the parser', task);
});

test('TaskBoard: a unique whole-word part of an item matches, an ambiguous or one-word name does not', () => {
  const board = boardOf('Write the parser', 'Add login page', 'Ship release 0.4.20');
  assert.equal(board.set('login page', 'in_progress'), 'Add login page');
  assert.equal(board.set('Ship release 0.4.20 to the marketplace', 'in_progress'), 'Ship release 0.4.20');
  assert.equal(board.set('tests', 'in_progress'), undefined);
  assert.equal(board.set('parser', 'in_progress'), undefined, 'one word moves nothing');
  const twins = boardOf('Write the parser', 'write the parser tests');
  assert.equal(twins.set('the parser', 'completed'), undefined, 'matches both items');
  assert.equal(shown(twins.list), 'Write the parser:pending write the parser tests:pending', 'nothing moved');
});

test('sub-agents that name their items by number or a quoted paraphrase end the list at 2/2 with no reminder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-num-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-tasks-num-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  const mainRequests: AgentMessage[][] = [];
  const near = {
    async *streamCompletion(_model: string, messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      if (/^do \w$/.test(String(messages[1]?.content ?? ''))) { yield reply('worker done'); return; }
      mainRequests.push([...messages]);
      const turn = mainRequests.length;
      if (turn === 1) { yield listWrite('t1', ['Task A', 'pending'], ['Task B', 'pending']); return; }
      if (turn === 2) { yield reply(null, [call('a1', 'Agent', { description: 'do A', prompt: 'do A', task: '2' }), call('a2', 'Agent', { description: 'do B', prompt: 'do B', task: '"task a."' })]); return; }
      yield reply('All set.');
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  try {
    await conversation.send({ text: 'plan it', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd, maxParallelAgents: 4 });
    assert.equal(shown(todoPosts(posted).at(-1)!.todos as Todo[]), 'Task A:completed Task B:completed');
    assert.equal(mainRequests.length, 3, 'no extra reminder turn');
    assert.equal(reminders(mainRequests).length, 0);
  } finally {
    conversation.dispose();
  }
});

// ---- "Not confirmed done" at the end of a run (quick 261113-lbo) --------------------------------------------------------------------------

test('a run that ends with unfinished items posts its real list once more, flagged unconfirmed, whatever the outcome', async () => {
  // Stopped short: the turn limit ends the run while the item is still pending.
  const limited = await scripted((n) => (n === 1 ? listWrite('t1', ['A', 'pending']) : reply(null, [call(`c${n}`, 'TodoWrite', { todos: [todo('A', 'pending')] })])), ['go'], { maxTurns: 3 });
  const lastLimited = todoPosts(limited.posted).at(-1)!;
  assert.equal(lastLimited.unconfirmed, true);
  assert.equal(shown(lastLimited.todos as Todo[]), 'A:pending');
  // Failed: the model request throws after the list was written.
  const failing = await scripted((n) => { if (n === 1) return listWrite('t1', ['A', 'in_progress']); throw Object.assign(new Error('model down'), { retryable: false }); }, ['go'], { tolerate: true });
  const lastFailing = todoPosts(failing.posted).at(-1)!;
  assert.equal(lastFailing.unconfirmed, true);
  assert.equal(shown(lastFailing.todos as Todo[]), 'A:in_progress', 'statuses are posted as they were');
});

test('a run that never touched the list posts no unconfirmed list', async () => {
  const { posted } = await scripted((n) => (n === 1 ? listWrite('t1', ['A', 'pending']) : reply('Done.')), ['go', 'again'], { maxTurns: 10 });
  const flagged = todoPosts(posted).filter((message) => message.unconfirmed === true);
  assert.equal(flagged.length, 1, 'only the first run, which wrote the list, is flagged');
});

test('the chat view shows "not confirmed done" for an unconfirmed list', () => {
  const script = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const styles = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.css'), 'utf8');
  assert.match(script, /renderTodos\(m\.todos \|\| \[\], m\.unconfirmed === true\)/);
  assert.match(script, /not confirmed done/);
  assert.match(styles, /#todos \.todo\.unconfirmed \{/);
  assert.match(styles, /#todos \.todo\.unconfirmed::before \{ content: '\?';/);
});
