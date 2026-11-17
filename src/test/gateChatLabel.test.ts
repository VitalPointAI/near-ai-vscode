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
import { createVscodeStub, installVscodeStub } from './helpers/vscodeStub';
import { mkdtempSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SessionMark } from '../domain/gate/dominance';
import type { Mark } from '../domain/gate/dominance';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { setLabelEntry, setProjectLabel } from '../domain/gate/labelMap';
import type { DecisionRecord } from '../domain/gate/record';
import { GateHost } from '../gate/host';
import { DECISIONS_DIR, projectLogKey } from '../gate/decisionLog';
import { chatInView, onChatInViewChange, setChatInView } from '../services/chatInView';
import type { ChatInView } from '../services/chatInView';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';

const stub = createVscodeStub();
const uninstall = installVscodeStub(stub);
// Loaded after the stub: these modules import vscode.
const gateCommands = require('../services/gateCommands') as typeof import('../services/gateCommands');
const statusBar = require('../services/gateStatusBar') as typeof import('../services/gateStatusBar');
test.after(() => { uninstall(); });

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

// ---- Task 2: only a person lowers a chat's label, with a recorded reason; the status bar shows the chat in view ----

/** A gate host on temporary storage, its label file signed by this install, for the chat label tests. */
async function labelHost(root: string, project?: Label): Promise<{ host: GateHost; storage: string }> {
  const storage = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-label-storage-')));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.30-test', projectRoot: root, home: storage });
  assert.equal((await host.start()).state, 'valid');
  if (project !== undefined) await host.changeLabels(root, (map) => setProjectLabel(map, project));
  return { host, storage };
}

async function recordsOf(host: GateHost, storage: string, root: string): Promise<DecisionRecord[]> {
  await host.flush();
  const file = path.join(storage, 'gate', DECISIONS_DIR, `${projectLogKey(root)}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as DecisionRecord);
}

/** A chat in view over a SessionMark at `mark`, recording what it was told to save. */
function viewOf(root: string, mark: Mark, id = 'conv-in-view-1'): ChatInView & { lowered: unknown[]; session: SessionMark } {
  const session = new SessionMark(mark);
  const lowered: unknown[] = [];
  return { id, root, mark: () => session, defaultLabel: () => SHIPPED_DEFAULT_LABEL, prepareLowering: (signed) => { lowered.push(signed); }, lowered, session };
}

function resetUi(): void {
  stub.quickPickAnswers.length = 0;
  stub.quickPickRequests.length = 0;
  stub.inputAnswers.length = 0;
  stub.notifications.length = 0;
}

test('Lower This Chat\'s Label offers only labels below the chat\'s mark, down to the project\'s label; with no chat in view it says so and changes nothing', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-label-project-')));
  const { host } = await labelHost(root, label('org', 'Internal'));
  resetUi();
  setChatInView(undefined);
  assert.equal(await gateCommands.lowerChatLabel(host), false);
  assert.ok(stub.notifications.some((entry) => entry.message === gateCommands.NO_CHAT_IN_VIEW_TEXT));
  const chat = viewOf(root, [RESTRICTED]);
  resetUi();
  assert.equal(await gateCommands.lowerChatLabel(host, chat), false, 'dismissed: nothing changes');
  assert.deepEqual(stub.quickPickRequests[0]?.items.map((item) => item.label), ['org/Confidential', 'org/Internal']);
  assert.deepEqual(keys(chat.session.current()), ['org/Restricted']);
  assert.deepEqual(gateCommands.lowerChoices([RESTRICTED], [label('org', 'Restricted')], SCALE_PRESETS), [], 'never below the project');
});

test('with an empty reason nothing changes and nothing is recorded; with a reason the mark is lowered, the chat keeps it, and label.declassify holds both labels and the reason', async () => {
  const root = labelledProject();
  const { host, storage } = await labelHost(root);
  const store = storeFor(root);
  const conversation = await chatIn(root, store);
  await conversation.send(request([call('r1', 'Read', { file_path: 'docs/plan.md' })]));
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Restricted']);
  const chat: ChatInView = { id: conversation.id, root, mark: () => conversation.mark, defaultLabel: () => conversation.chatDefaultLabel, prepareLowering: (signed) => conversation.prepareLowering(signed) };
  resetUi();
  stub.quickPickAnswers.push('org/Internal');
  stub.inputAnswers.push('   ');
  assert.equal(await gateCommands.lowerChatLabel(host, chat), false);
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Restricted']);
  assert.equal((await recordsOf(host, storage, root)).filter((record) => record.authorizations[0]?.policy.name === 'label.declassify').length, 0);
  resetUi();
  stub.quickPickAnswers.push('org/Internal');
  stub.inputAnswers.push('Reviewed: the plan was published last week.');
  assert.equal(await gateCommands.lowerChatLabel(host, chat), true);
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Internal']);
  for (let wait = 0; wait < 50 && markOf((await store.meta(conversation.id))!).join() !== 'org/Internal'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(markOf((await store.meta(conversation.id))!), ['org/Internal'], 'the chat\'s meta holds the lowered mark');
  const records = (await recordsOf(host, storage, root)).filter((record) => record.authorizations[0]?.policy.name === 'label.declassify');
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.unmapped.nearAi.label?.level, 'Internal', 'the new label');
  assert.deepEqual(record.unmapped.nearAi.mark?.map((each) => each.level), ['Restricted'], 'the old label');
  assert.ok(JSON.stringify(record).includes('Reviewed: the plan was published last week.'), 'the reason given');
  assert.match(stub.inputRequests.at(-1)?.prompt ?? '', /travels with its encrypted metadata to your other computers/);
});

test('gateStatusText shows the chat in view\'s label above the default, and nothing for it at the default or with no chat; showing another chat changes it', () => {
  const state = undefined;
  const plain = statusBar.gateStatusText(state, 0);
  assert.equal(statusBar.gateStatusText(state, 0, { mark: [CONFIDENTIAL], defaultLabel: PUBLIC }).text, `${plain.text} · org/Confidential`);
  assert.match(statusBar.gateStatusText(state, 0, { mark: [CONFIDENTIAL], defaultLabel: PUBLIC }).tooltip, /The chat in view is labelled org\/Confidential/);
  assert.equal(statusBar.gateStatusText(state, 0, { mark: [PUBLIC], defaultLabel: PUBLIC }).text, plain.text);
  assert.equal(statusBar.gateStatusText(state, 0, undefined).text, plain.text);
  let told = 0;
  const stop = onChatInViewChange(() => { told += 1; });
  const first = viewOf('/project', [CONFIDENTIAL], 'conv-first-1');
  const second = viewOf('/project', [RESTRICTED], 'conv-second-1');
  setChatInView(first);
  assert.equal(chatInView()?.id, 'conv-first-1');
  setChatInView(second);
  assert.deepEqual(keys(chatInView()!.mark()!.current()), ['org/Restricted']);
  setChatInView(undefined);
  stop();
  assert.equal(told, 3);
});

test('no agent tool can lower a chat\'s label: lowerByPerson is called only from gateCommands.ts', () => {
  const src = path.join(__dirname, '..', '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'test') walk(path.join(dir, entry.name)); } else if (entry.name.endsWith('.ts')) files.push(path.join(dir, entry.name));
    }
  };
  walk(src);
  const callers = files.filter((file) => /\.lowerByPerson\(/.test(readFileSync(file, 'utf8'))).map((file) => path.relative(src, file).split(path.sep).join('/'));
  assert.deepEqual(callers, ['services/gateCommands.ts']);
  const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
  assert.deepEqual(manifest.contributes.commands.find((command) => command.command === 'nearAi.label.lowerChat'), { command: 'nearAi.label.lowerChat', title: "Lower This Chat's Label", category: 'NEAR AI' });
});
