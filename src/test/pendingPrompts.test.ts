import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import { AgentConversation, GsdContext } from '../services/agentSession';
import { parseChatWebviewMessage } from '../services/chatBridge';
import type { AgentMessage, CompletionEvent, ToolCall } from '../services/nearAiClient';

// Prompts that block a run (approvals, questions) are pinned above the composer until settled:
// the view's queue and wording, and the host side that tracks what is waiting, replays it to a
// reloaded view, badges the view, and reports every prompt a stop or the run's end cancels.

interface Item { id: string; kind: 'approval' | 'questions' | 'choice'; agent?: string; title: string }
interface Queue {
  add(item: Item): boolean; resolve(id: string): Item | undefined; has(id: string): boolean; readonly size: number;
  current(): Item | undefined; position(): number; select(id: string): boolean; step(delta: number): Item | undefined; list(): Item[]; clear(): Item[];
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pending = require(path.join(__dirname, '..', '..', 'media', 'chat', 'pending.js')) as {
  createPendingQueue(): Queue;
  headerText(item: Item | undefined, position: number, size: number): string;
  waitingText(item: Item): string;
  outcomeText(item: Item, outcome: string, detail?: unknown): string;
};

const approval = (id: string, title: string, agent?: string): Item => ({ id, kind: 'approval', title, ...(agent ? { agent } : {}) });

test('the pending queue shows the oldest prompt first and ignores a replayed one', () => {
  const queue = pending.createPendingQueue();
  assert.equal(queue.current(), undefined);
  assert.equal(queue.position(), 0);
  assert.equal(queue.add(approval('a', 'Run npm test')), true);
  assert.equal(queue.add(approval('b', 'Edit app.ts', 'gsd-executor')), true);
  assert.equal(queue.add(approval('a', 'Run npm test')), false, 'a replay of a prompt already pinned is not added twice');
  assert.equal(queue.size, 2);
  assert.equal(queue.current()?.id, 'a');
  assert.equal(queue.position(), 1);
});

test('stepping wraps around, and answering keeps the next oldest on show', () => {
  const queue = pending.createPendingQueue();
  ['a', 'b', 'c'].forEach((id) => queue.add(approval(id, id)));
  assert.equal(queue.step(1)?.id, 'b');
  assert.equal(queue.step(1)?.id, 'c');
  assert.equal(queue.step(1)?.id, 'a', 'wraps to the oldest');
  assert.equal(queue.step(-1)?.id, 'c', 'wraps back to the newest');
  assert.equal(queue.resolve('c')?.id, 'c');
  assert.equal(queue.current()?.id, 'b', 'the shown prompt was the last; the one before it shows');
  queue.select('b');
  assert.equal(queue.resolve('a')?.id, 'a');
  assert.equal(queue.current()?.id, 'b', 'answering an older prompt keeps the shown one');
  assert.equal(queue.position(), 1);
  assert.equal(queue.resolve('missing'), undefined);
  assert.equal(queue.resolve('b')?.id, 'b');
  assert.equal(queue.current(), undefined);
  assert.equal(queue.size, 0);
});

test('clear empties the queue and returns what was waiting', () => {
  const queue = pending.createPendingQueue();
  queue.add(approval('a', 'a'));
  queue.add(approval('b', 'b'));
  queue.step(1);
  assert.deepEqual(queue.clear().map((item) => item.id), ['a', 'b']);
  assert.equal(queue.size, 0);
  assert.equal(queue.add(approval('c', 'c')), true);
  assert.equal(queue.current()?.id, 'c');
});

test('the pinned header says who is asking and how many wait', () => {
  assert.equal(pending.headerText(approval('a', 'x'), 1, 1), 'NEAR AI needs your approval');
  assert.equal(pending.headerText(approval('a', 'x', 'gsd-planner'), 2, 3), 'gsd-planner needs your approval · 2 of 3 waiting');
  assert.equal(pending.headerText({ id: 'q', kind: 'questions', title: 'Which phase?' }, 1, 1), 'NEAR AI is asking you');
});

test('the transcript line records the outcome, with the answer for questions', () => {
  const item = approval('a', 'npm test');
  assert.equal(pending.waitingText(item), 'Waiting for your approval: npm test');
  assert.equal(pending.waitingText({ id: 'q', kind: 'questions', title: 'Which phase?' }), 'Waiting for your answer: Which phase?');
  assert.equal(pending.outcomeText(item, 'allow'), 'Approved: npm test');
  assert.equal(pending.outcomeText(item, 'allow-run'), 'Approved for this run: npm test');
  assert.equal(pending.outcomeText(item, 'deny'), 'Declined: npm test');
  assert.equal(pending.outcomeText(item, 'expired', 15), 'Expired after 15 min, declined: npm test');
  assert.equal(pending.outcomeText(item, 'expired'), 'Expired, declined: npm test');
  assert.equal(pending.outcomeText(item, 'cancelled'), 'Cancelled, the run stopped: npm test');
  assert.equal(pending.outcomeText({ id: 'q', kind: 'questions', title: 'Which phase?' }, 'answered', 'Phase 9; Yes'), 'Answered: Phase 9; Yes');
});

test('the sidebar has a pinned region between the panels and the composer, and loads its script', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  const footer = source.slice(source.indexOf('<footer>'), source.indexOf('</footer>'));
  assert.ok(footer.indexOf('id="todos"') < footer.indexOf('id="pending"') && footer.indexOf('id="pending"') < footer.indexOf('class="composer"'));
  assert.match(source, /asset\('pending\.js'\)/);
  assert.ok(source.indexOf("asset('pending.js')") < source.indexOf("asset('chat.js')"), 'the queue loads before the chat script that uses it');
  assert.deepEqual(parseChatWebviewMessage({ type: 'chat-ready' }), { type: 'chat-ready' });
  assert.equal(parseChatWebviewMessage({ type: 'chat-ready', replay: true }), undefined);
});

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const usage = { verificationStatus: 'unknown' as const, latencyMs: 1 };

/** A conversation whose model asks to write a file, then answers once the tool result is back. */
function writingConversation(root: string) {
  let turn = 0;
  const near = {
    async *streamCompletion(): AsyncGenerator<CompletionEvent> {
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('w1', 'Write', { file_path: 'notes.md', content: 'x' })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'done' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const counts: number[] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.onWaitingChange = (count) => counts.push(count);
  const send = () => conversation.send({ text: 'write notes', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES });
  return { conversation, posted, counts, send };
}

async function until<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

test('a waiting approval is replayable until answered, and the count drives the badge', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-pending-'));
  const { conversation, posted, counts, send } = writingConversation(root);
  try {
    const running = send();
    const request = await until(() => posted.find((message) => message.type === 'approval-request'));
    assert.deepEqual(counts, [1]);
    assert.deepEqual(conversation.waitingPrompts(), [{ ...request, replay: true }], 'a reloaded view gets the same request again, marked as a replay');
    conversation.answerApproval(String(request.callId), { decision: 'allow' });
    await running;
    assert.deepEqual(counts, [1, 0], 'the badge clears once answered');
    assert.deepEqual(conversation.waitingPrompts(), []);
    assert.equal(posted.some((message) => message.type === 'prompt-closed'), false, 'the view already knows about its own answer');
  } finally {
    conversation.dispose();
  }
});

test('stopping a run cancels its waiting approval and tells the view to unpin it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-pending-stop-'));
  const { conversation, posted, counts, send } = writingConversation(root);
  try {
    const running = send();
    const request = await until(() => posted.find((message) => message.type === 'approval-request'));
    conversation.stop();
    await running;
    assert.deepEqual(posted.filter((message) => message.type === 'prompt-closed'), [{ type: 'prompt-closed', id: request.callId, outcome: 'cancelled' }]);
    assert.deepEqual(counts, [1, 0]);
    assert.deepEqual(conversation.waitingPrompts(), []);
  } finally {
    conversation.dispose();
  }
});

test('an expired approval says after how long, and is no longer waiting', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-pending-expire-'));
  const { conversation, posted, counts, send } = writingConversation(root);
  conversation.approvalTimeoutMs = 60_000;
  const timers = { set: globalThis.setTimeout };
  // Fire the 1-minute timeout at once, so the test does not wait a minute.
  globalThis.setTimeout = ((handler: () => void, ms?: number) => timers.set(handler, ms === 60_000 ? 5 : ms)) as typeof setTimeout;
  try {
    await send();
  } finally {
    globalThis.setTimeout = timers.set;
    conversation.dispose();
  }
  const expired = posted.find((message) => message.type === 'approval-expired');
  assert.equal(expired?.minutes, 1);
  assert.match(String(expired?.text), /within 1 minute, so it was declined/);
  assert.deepEqual(counts, [1, 0]);
  assert.equal(posted.some((message) => message.type === 'prompt-closed'), false, 'the expiry message already closes it');
});

test('questions wait, replay, and are cancelled when the run is stopped', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-pending-questions-'));
  const home = await mkdtemp(path.join(tmpdir(), 'near-ai-pending-gsd-'));
  await mkdir(path.join(home, 'gsd-core'), { recursive: true });
  const gsd: GsdContext = { home, skills: [], agents: [{ name: 'gsd-worker', description: 'Works', tools: ['Read'], body: 'You are the worker.', file: path.join(home, 'agents', 'gsd-worker.md') }], shellEnv: {} };
  let turn = 0;
  const near = {
    async *streamCompletion(_model: string, _messages: AgentMessage[]): AsyncGenerator<CompletionEvent> {
      turn += 1;
      if (turn === 1) { yield { type: 'done', message: { role: 'assistant', content: null, tool_calls: [call('ask1', 'AskUserQuestion', { questions: [{ question: 'Which phase?', options: [{ label: 'Phase 9' }, { label: 'Phase 10' }] }] })] }, finishReason: 'tool_calls', usage }; return; }
      yield { type: 'done', message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage };
    },
    async actualCostsUsd() { return undefined; }
  };
  const posted: Array<Record<string, unknown>> = [];
  const counts: number[] = [];
  const conversation = new AgentConversation(root, (message) => posted.push(message), path.join(root, '.ckpt'));
  conversation.onWaitingChange = (count) => counts.push(count);
  try {
    const running = conversation.send({ text: 'ask me', client: near as never, model: 'm', privacy: 'Private', policy: { mode: 'approve-risky', emergencyStop: false }, rules: DEFAULT_RULES, gsd });
    const request = await until(() => posted.find((message) => message.type === 'questions-request'));
    assert.deepEqual(conversation.waitingPrompts().map((message) => message.id), [request.id]);
    conversation.stop();
    await running;
    assert.deepEqual(posted.filter((message) => message.type === 'prompt-closed'), [{ type: 'prompt-closed', id: request.id, outcome: 'cancelled' }]);
    assert.deepEqual(counts, [1, 0]);
  } finally {
    conversation.dispose();
  }
});
