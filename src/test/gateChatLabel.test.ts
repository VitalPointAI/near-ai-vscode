// A chat's label lasts and shows (CLAS-01, CLAS-04, D-29, D-33, D-58): it is saved in the chat's thread meta, a reopened chat starts at it, a sync merge is
// raise-only whichever copy is newer, an unreadable stored value opens at org/Restricted and is never replaced by a lower one, and the page shows the label
// beside the model with text only. Every project is under the temporary folder; every key is made in the test; nothing reaches the network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_RULES } from '../agent/permissions';
import type { Label } from '../domain/gate/labels';
import { providerErrorMessage } from '../services/chatBridge';
import { AgentConversation, UNREADABLE_CHAT_LABEL_TEXT } from '../services/agentSession';
import { RouteRefusedError } from '../services/nearAiClient';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore, chatLabelOf, mergeMeta, validMeta } from '../services/threadStore';
import type { ThreadMeta } from '../services/threadStore';
import { chatPage } from './helpers/chatPage';
import { testGateHost } from './helpers/gatedRuns';
import { call, keys, label, labelledProject, scripted } from './helpers/markFixtures';
import { MemorySecrets } from './helpers/stateFixtures';

const PUBLIC = label('org', 'Public');
const CONFIDENTIAL = label('org', 'Confidential');
const RESTRICTED = label('org', 'Restricted');

function storeFor(root: string, secrets = new MemorySecrets(), writer = 'edA.1'): ThreadStore {
  return new ThreadStore(stateHomeFor(root), stateKeysFor(root, secrets), { writer });
}

export function meta(id: string, lastUsedAt: string, labelValue?: unknown, extra: Partial<ThreadMeta> = {}): ThreadMeta {
  return { id, title: 'Chat', model: 'm', origin: 'panel', createdAt: '2026-11-01T00:00:00.000Z', lastUsedAt, turns: 1, entries: 2, bytes: 10, tip: 't', ...(labelValue === undefined ? {} : { label: labelValue as never }), ...extra };
}

const ID = 'conv-label-merge-1';
const both = (a: ThreadMeta, b: ThreadMeta): [ThreadMeta, ThreadMeta] => [mergeMeta(a, b), mergeMeta(b, a)];
const markOf = (value: ThreadMeta): string[] => { const read = chatLabelOf(value); return read.kind === 'mark' ? keys(read.mark) : [read.kind]; };

async function chatIn(root: string, store: ThreadStore, posts: Array<Record<string, unknown>> = []): Promise<AgentConversation> {
  const conversation = new AgentConversation(root, (message) => posts.push(message), path.join(root, '.ckpt'), undefined, store);
  conversation.gateHost = testGateHost();
  return conversation;
}

const request = (calls: ReturnType<typeof call>[]) => ({ text: 'go', client: scripted(calls) as never, model: 'm', privacy: 'Private', policy: { mode: 'fully-autonomous' as const, emergencyStop: false }, rules: DEFAULT_RULES });

test('tracer: a chat raised to Confidential saves that label, keeps it when reopened, and shows it next to the model', async () => {
  const root = labelledProject();
  const store = storeFor(root);
  const posts: Array<Record<string, unknown>> = [];
  const chat = await chatIn(root, store, posts);
  await chat.send(request([call('r1', 'Read', { file_path: 'conf.md' })]));
  assert.deepEqual(keys(chat.mark!.current()), ['org/Confidential']);
  for (let wait = 0; wait < 50 && markOf((await store.meta(chat.id))!).join() !== 'org/Confidential'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(markOf((await store.meta(chat.id))!), ['org/Confidential'], 'ThreadMeta.label holds the mark');
  const shown = posts.filter((post) => post.type === 'chat-label').at(-1);
  assert.equal(shown?.text, 'org/Confidential');
  const reopened = await chatIn(root, store);
  assert.ok(await reopened.restore(chat.id));
  assert.deepEqual(keys(reopened.mark!.current()), ['org/Confidential'], 'a reopened chat starts at the stored mark');
});

test('a chat at the default label shows nothing beside the model', async () => {
  const root = labelledProject();
  const posts: Array<Record<string, unknown>> = [];
  const chat = await chatIn(root, storeFor(root), posts);
  await chat.send(request([call('r1', 'Read', { file_path: 'notes.md' })]));
  assert.equal(posts.filter((post) => post.type === 'chat-label').at(-1)?.text, '');
});

test('mergeMeta is raise-only: a newer Public copy never lowers a Confidential one; two scales are both kept; both orders agree', () => {
  const older = meta(ID, '2026-11-10T00:00:00.000Z', { mark: [CONFIDENTIAL] });
  const newer = meta(ID, '2026-11-12T00:00:00.000Z', { mark: [PUBLIC] });
  for (const merged of both(older, newer)) assert.deepEqual(markOf(merged), ['org/Confidential']);
  const [x, y] = both(older, newer);
  assert.deepEqual(x, y);
  const protectedB = meta(ID, '2026-11-13T00:00:00.000Z', { mark: [label('ca-protected', 'Protected B')] });
  for (const merged of both(older, protectedB)) assert.deepEqual(markOf(merged), ['ca-protected/Protected B', 'org/Confidential']);
});

test('a copy at Public carrying an unsigned or hand-written lowering never lowers a Restricted copy', () => {
  const high = meta(ID, '2026-11-10T00:00:00.000Z', { mark: [RESTRICTED] });
  for (const lowering of [{ at: '2026-11-11T00:00:00.000Z' }, { from: [RESTRICTED], to: [PUBLIC], at: '2026-11-11T00:00:00.000Z', reason: 'trust me' }, 'lowered']) {
    const low = meta(ID, '2026-11-12T00:00:00.000Z', { mark: [PUBLIC], lowerings: [lowering] });
    for (const merged of both(high, low)) assert.deepEqual(markOf(merged), ['org/Restricted'], JSON.stringify(lowering));
  }
});

test('an unreadable stored label opens the chat at org/Restricted with the sentence naming Lower This Chat\'s Label, and a merge keeps the unreadable value', async () => {
  const unreadable = meta(ID, '2026-11-10T00:00:00.000Z', { mark: [{ scale: 'org', level: 'Classified-ish' }] });
  const readable = meta(ID, '2026-11-12T00:00:00.000Z', { mark: [PUBLIC] });
  assert.equal(chatLabelOf(unreadable).kind, 'unreadable');
  for (const merged of both(unreadable, readable)) assert.deepEqual(merged.label, unreadable.label);
  assert.match(UNREADABLE_CHAT_LABEL_TEXT, /NEAR AI: Lower This Chat's Label/);
  const root = labelledProject();
  const store = storeFor(root);
  const chat = await chatIn(root, store);
  await chat.send(request([]));
  await store.setChatLabel(chat.id, [{ scale: 'org', level: 'Classified-ish' } as unknown as Label], true);
  const posts: Array<Record<string, unknown>> = [];
  const reopened = await chatIn(root, store, posts);
  assert.ok(await reopened.restore(chat.id));
  assert.deepEqual(keys(reopened.mark!.current()), ['org/Restricted']);
  assert.ok(posts.some((post) => post.type === 'notice' && post.text === UNREADABLE_CHAT_LABEL_TEXT));
  // A raise saved later never replaces the unreadable value with a lower one.
  await store.setChatLabel(chat.id, [PUBLIC]);
  assert.equal(chatLabelOf(await store.meta(chat.id)).kind, 'unreadable');
});

test('validMeta keeps a field it does not know, and a meta with no label merged with a labelled one keeps the label', () => {
  const kept = validMeta({ ...meta(ID, '2026-11-10T00:00:00.000Z'), futureField: 1 }, ID) as ThreadMeta & { futureField?: number };
  assert.equal(kept.futureField, 1);
  const labelled = validMeta(meta(ID, '2026-11-10T00:00:00.000Z', { mark: [CONFIDENTIAL], futureLabelField: 'x' }), ID)!;
  assert.deepEqual(labelled.label, { mark: [CONFIDENTIAL], futureLabelField: 'x' });
  const plain = meta(ID, '2026-11-12T00:00:00.000Z');
  for (const merged of both(labelled, plain)) assert.deepEqual(markOf(merged), ['org/Confidential']);
});

test('the page shows the label beside the model with text only, and hides it at the default label', () => {
  const page = chatPage();
  page.send({ type: 'chat-label', text: 'org/Confidential' });
  const chip = page.nodes.get('chat-label');
  assert.ok(chip);
  assert.equal(chip.textContent, 'Label: org/Confidential');
  assert.equal(chip.hidden, false);
  page.send({ type: 'chat-label', text: '<img src=x onerror=alert(1)>' });
  assert.equal(chip.textContent, 'Label: <img src=x onerror=alert(1)>', 'set as text, never as markup');
  assert.equal(chip.children.length, 0);
  page.send({ type: 'chat-label', text: '' });
  assert.equal(chip.hidden, true);
  const source = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  const handler = source.slice(source.indexOf("case 'chat-label'"), source.indexOf("case 'assistant-start'"));
  assert.ok(!/innerHTML/.test(handler));
});

test('a route refusal reaches the page as its own plain sentence', () => {
  const error = new RouteRefusedError('route.no-local-model', 'Nothing was sent. This chat has read content that may only go to a model running on this computer.');
  assert.equal(providerErrorMessage(error), error.message);
});
