import assert from 'node:assert/strict';
import test from 'node:test';
import type { ThreadEntry } from '../domain/state/threadEntries';
import { recordParticipantTurn, resolveParticipantThread, ResponseRecorder, type ParticipantTurnLike, type ResponseStreamLike } from '../services/participantRecorder';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore } from '../services/threadStore';
import { MemorySecrets, tempProject } from './helpers/stateFixtures';

// Phase 27, plan 08 (SYNC-01, D-07): the @near chat participant's turns are recorded in the project's state home, whatever VS Code's own 20-turn
// window shows the model. Each test works on a temporary project folder.

class FakeMarkdown { public constructor(public value: string) {} }

/** The reply stream of a chat request: what the person would see, in order. */
class FakeStream implements ResponseStreamLike {
  public readonly seen: string[] = [];
  public markdown(value: string | { value: string }): unknown { this.seen.push(typeof value === 'string' ? value : value.value); return this; }
  public button(): unknown { return this; }
  public progress(): unknown { return this; }
}

function storeFor(root: string, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer });
}

const textOf = (entry: ThreadEntry): string => (entry.body as { text: string }).text;

/** A reply turn as VS Code's history returns it. */
function reply(text: string, metadata: Record<string, unknown> = {}): ParticipantTurnLike {
  return { participant: 'nearAi', result: { metadata }, response: [{ value: new FakeMarkdown(text) }] };
}

function request(prompt: string, command?: string): ParticipantTurnLike {
  return { participant: 'nearAi', prompt, ...(command ? { command } : {}) };
}

test('a streamed reply with its usage footer is stored as one prompt and one reply in a Chat view thread', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const stream = new FakeStream();
  const recorder = new ResponseRecorder(stream);
  recorder.progress('Asking m…');
  recorder.markdown('Hello');
  recorder.markdown(new FakeMarkdown(' world'));
  recorder.markdown('\n\n*m · 12 tokens · $0.0001*');
  assert.deepEqual(stream.seen, ['Hello', ' world', '\n\n*m · 12 tokens · $0.0001*'], 'the real stream receives everything unchanged');
  const finished = recorder.finish('completed');
  assert.equal(finished.text, 'Hello world\n\n*m · 12 tokens · $0.0001*');

  const { threadId } = await resolveParticipantThread([], store);
  await recordParticipantTurn(store, { threadId, writer: 'edA.1', prompt: 'Say hello', reply: finished.text, model: 'm' });

  const main = (await store.lines(threadId)).main;
  assert.deepEqual(main.map((entry) => entry.role), ['user', 'assistant']);
  assert.equal(textOf(main[0]), 'Say hello');
  assert.equal(textOf(main[1]), 'Hello world\n\n*m · 12 tokens · $0.0001*', 'the reply is kept exactly as the person saw it, footer included');
  const meta = await store.meta(threadId);
  assert.equal(meta?.origin, 'chat-view');
  assert.equal(meta?.title, 'Say hello');
  assert.equal(meta?.turns, 1);
  assert.equal((await store.index()).find((item) => item.id === threadId)?.origin, 'chat-view');
});

test('the thread id rides in the newest reply, so the next turn continues the same thread, and a first request starts a new one', async () => {
  const root = await tempProject();
  const store = storeFor(root);
  const first = await resolveParticipantThread([], store);
  assert.match(first.threadId, /^conv-[a-z0-9-]{6,60}$/);
  await recordParticipantTurn(store, { threadId: first.threadId, writer: 'edA.1', prompt: 'One', reply: 'Answer one', model: 'm' });

  const history = [request('One'), reply('Answer one', { threadId: first.threadId })];
  const second = await resolveParticipantThread(history, store);
  assert.equal(second.threadId, first.threadId);
  await recordParticipantTurn(store, { threadId: second.threadId, writer: 'edA.1', prompt: 'Two', reply: 'Answer two', model: 'm' });

  const main = (await store.lines(first.threadId)).main;
  assert.deepEqual(main.map(textOf), ['One', 'Answer one', 'Two', 'Answer two']);
  assert.equal((await store.index()).filter((item) => item.origin === 'chat-view').length, 1, 'both turns are one thread');
  assert.equal((await store.meta(first.threadId))?.turns, 2);
});
