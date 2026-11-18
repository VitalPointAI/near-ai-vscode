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
import { AgentConversation, LOWERING_OVERTAKEN_TEXT, UNREADABLE_CHAT_LABEL_TEXT } from '../services/agentSession';
import { RouteRefusedError } from '../services/nearAiClient';
import { ROUTE_REFUSALS } from '../domain/gate/routing';
import { NETWORK_AT_MARK_TEXT } from '../agent/gateAdapter';
import { stateHomeFor } from '../services/stateHome';
import { stateKeysFor } from '../services/stateKeys';
import { ThreadStore, chatLabelOf, mergeMeta, registerLabelLoweringJudge, registerLoweringOutcomes, validMeta } from '../services/threadStore';
import { chatLoweringKeys, judgeChatLowering, signChatLowering } from '../gate/chatLabel';
import type { ChatLowering } from '../gate/chatLabel';
import { NO_KNOWN_KEYS } from '../domain/team/keyStatus';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import { signPayload } from '../domain/team/signedPayload';
import type { SignedPayload } from '../domain/team/signedPayload';
import { createDeviceIdentity } from '../team/identity';
import type { DeviceIdentity } from '../team/identity';
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
import { chatInView, onChatInViewChange, queueChatNotice, setChatInView, takeChatNotices } from '../services/chatInView';
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
const keys_ = (mark: readonly Label[]): string[] => keys(mark);
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
  // Review round 3: every label event has one shape, `mark` the chat's mark after it and `from` the mark before it.
  assert.deepEqual(record.unmapped.nearAi.mark?.map((each) => each.level), ['Internal'], 'the chat\'s mark after the event');
  assert.deepEqual(record.unmapped.nearAi.from?.map((each) => each.level), ['Restricted'], 'the old label');
  assert.ok(JSON.stringify(record).includes('Reviewed: the plan was published last week.'), 'the reason given');
  assert.match(stub.inputRequests.at(-1)?.prompt ?? '', /travels with its encrypted metadata to your other computers/);
  // Owner answer: other computers cannot check this key yet, so the person is told the copies there keep the higher label.
  assert.ok(stub.notifications.some((entry) => entry.message.includes(gateCommands.LOWERED_HERE_ONLY_TEXT)));
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

// ---- Task 3: a lowering reaches another copy only as a signed declassification that copy can check, and never undoes a raise ----

const CHAT = 'conv-signed-lower-1';
const T0 = '2026-11-17T10:00:00.000Z';
const AT = '2026-11-17T11:00:00.000Z';
const LATER = '2026-11-17T12:00:00.000Z';
const ACTIVE_FOR = (fingerprint: string): KeyStatusLookup => (key) => (key.fingerprint === fingerprint ? { state: 'active' } : { state: 'unknown' });

async function signerOf(): Promise<DeviceIdentity> {
  return createDeviceIdentity(new MemorySecrets());
}

function lowered(identity: DeviceIdentity, from: Mark, to: Mark, extra: Partial<ChatLowering> = {}): SignedPayload<ChatLowering> {
  return signChatLowering(identity, { chatId: CHAT, from, to, reason: 'reviewed and cleared', at: AT, ...extra });
}

/** The copy that was lowered (used at LATER, after the lowering) and the other copy (last used at `otherUsed`). */
function copies(lowering: unknown, otherMark: Mark, otherUsed = T0): [ThreadMeta, ThreadMeta] {
  return [meta(CHAT, LATER, { mark: [PUBLIC], lowerings: [lowering] }), meta(CHAT, otherUsed, { mark: [...otherMark] })];
}

/** Runs `work` with a judge over `keys` registered, collecting what it judged; clears both registrations after. */
function judged<T>(keys: KeyStatusLookup | undefined, work: () => T): { result: T; outcomes: Array<{ applied: boolean; cause?: string }> } {
  const outcomes: Array<{ applied: boolean; cause?: string }> = [];
  const stopJudge = keys === undefined ? () => undefined : registerLabelLoweringJudge((lowering, context) => judgeChatLowering(lowering, context, keys));
  const stopOutcomes = registerLoweringOutcomes((outcome) => outcomes.push({ applied: outcome.applied, ...(outcome.cause === undefined ? {} : { cause: outcome.cause }) }));
  try {
    return { result: work(), outcomes };
  } finally {
    stopJudge();
    stopOutcomes();
  }
}

test('a valid signed lowering whose from-mark covers the other copy, unused since, is applied in both orders; a higher other mark or a from-mark below it keeps the join', async () => {
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  const valid = lowered(identity, [RESTRICTED], [PUBLIC]);
  const [low, high] = copies(valid, [RESTRICTED]);
  const applied = judged(keys, () => both(low, high));
  for (const merged of applied.result) assert.deepEqual(markOf(merged), ['org/Public']);
  assert.deepEqual(applied.result[0], applied.result[1], 'both orders give the same meta');
  assert.ok(applied.outcomes.every((outcome) => outcome.applied));
  const compartment = judged(keys, () => both(...copies(valid, [label('org', 'Restricted', ['X'])])));
  for (const merged of compartment.result) assert.deepEqual(markOf(merged), ['org/Restricted+X']);
  assert.deepEqual(compartment.outcomes.map((outcome) => outcome.cause), ['higher-mark', 'higher-mark']);
  const fromBelow = judged(keys, () => both(...copies(lowered(identity, [CONFIDENTIAL], [PUBLIC]), [RESTRICTED])));
  for (const merged of fromBelow.result) assert.deepEqual(markOf(merged), ['org/Restricted']);
});

test('a lowering is not applied when the other copy was used after it', async () => {
  const identity = await signerOf();
  const outcome = judged(ACTIVE_FOR(identity.fingerprint), () => both(...copies(lowered(identity, [RESTRICTED], [PUBLIC]), [RESTRICTED], LATER)));
  for (const merged of outcome.result) assert.deepEqual(markOf(merged), ['org/Restricted']);
  assert.deepEqual([...new Set(outcome.outcomes.map((each) => each.cause))], ['used-after']);
});

test('a changed byte, another purpose, another chat and a bare time with no signature are each ignored with their cause, and the join wins', async () => {
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  const valid = lowered(identity, [RESTRICTED], [PUBLIC]);
  const changed = { ...valid, payload: { ...valid.payload, reason: 'changed after signing' } };
  const purpose = signPayload(identity, 'label-map', valid.payload, { now: () => new Date(AT) });
  const elsewhere = lowered(identity, [RESTRICTED], [PUBLIC], { chatId: 'conv-another-chat-1' });
  for (const [lowering, cause] of [[changed, 'does-not-verify'], [purpose, 'another-purpose'], [elsewhere, 'another-chat'], [{ at: AT }, 'no-signature']] as const) {
    const outcome = judged(keys, () => both(...copies(lowering, [RESTRICTED])));
    for (const merged of outcome.result) assert.deepEqual(markOf(merged), ['org/Restricted'], cause);
    assert.deepEqual([...new Set(outcome.outcomes.map((each) => each.cause))], [cause]);
  }
});

test('a key this computer has revoked, one replaced before the signing time, and one it does not know are each refused with their cause', async () => {
  const identity = await signerOf();
  const valid = lowered(identity, [RESTRICTED], [PUBLIC]);
  const revoked: KeyStatusLookup = () => ({ state: 'revoked' });
  const rotated: KeyStatusLookup = () => ({ state: 'rotated', since: T0 });
  for (const [keys, cause] of [[revoked, 'key-revoked'], [rotated, 'key-rotated'], [NO_KNOWN_KEYS, 'key-unknown']] as const) {
    const outcome = judged(keys, () => both(...copies(valid, [RESTRICTED])));
    for (const merged of outcome.result) assert.deepEqual(markOf(merged), ['org/Restricted'], cause);
    assert.deepEqual([...new Set(outcome.outcomes.map((each) => each.cause))], [cause]);
  }
  // Team Mode: only this person's own devices count, never a teammate's.
  const roster = { members: new Map([['member-me', { devices: [] }], ['member-other', { devices: [{ fingerprint: identity.fingerprint, publicKey: identity.publicKey }] }]]), deviceIndex: new Map([[identity.fingerprint, 'member-other']]) };
  const teamKeys = chatLoweringKeys(NO_KNOWN_KEYS, { state: roster as never, memberId: 'member-me' });
  assert.equal(teamKeys({ fingerprint: identity.fingerprint, publicKey: identity.publicKey }).state, 'unknown', 'a teammate\'s device does not vouch for my lowering');
});

test('with no judge registered every lowering from another copy is rejected, and the merged meta keeps the union of signed lowerings, newest 20', async () => {
  const identity = await signerOf();
  const valid = lowered(identity, [RESTRICTED], [PUBLIC]);
  const outcome = judged(undefined, () => both(...copies(valid, [RESTRICTED])));
  for (const merged of outcome.result) assert.deepEqual(markOf(merged), ['org/Restricted']);
  assert.ok(outcome.outcomes.every((each) => each.cause === 'no-judge'));
  const many = Array.from({ length: 25 }, (_, index) => lowered(identity, [RESTRICTED], [PUBLIC], { at: new Date(Date.parse(T0) - (25 - index) * 60_000).toISOString() }));
  const left = meta(CHAT, T0, { mark: [RESTRICTED], lowerings: many.slice(0, 15) });
  const right = meta(CHAT, T0, { mark: [RESTRICTED], lowerings: many.slice(10) });
  const merged = judged(undefined, () => both(left, right)).result;
  assert.deepEqual(merged[0], merged[1]);
  const kept = (merged[0].label as unknown as { lowerings: Array<{ sig: string }> }).lowerings;
  assert.equal(kept.length, 20);
  assert.deepEqual(kept.map((each) => each.sig), many.slice(5).map((each) => each.sig), 'the newest 20, oldest first');
});

test('the gate host records an applied lowering once as label.declassify, a rejected one once as label.declassify-rejected, and the chat is told once naming the Lower command', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-lower-host-')));
  const storage = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-lower-storage-')));
  const secrets = new MemorySecrets();
  const told: Array<[string, string]> = [];
  const host = new GateHost({ globalStorageDir: storage, secrets, productVersion: '0.4.30-test', projectRoot: root, home: storage, onLoweringRejected: (chatId, sentence) => { told.push([chatId, sentence]); queueChatNotice(chatId, sentence); } });
  assert.equal((await host.start()).state, 'valid');
  const signed = await host.signChatLowering({ chatId: CHAT, from: [RESTRICTED], to: [PUBLIC], reason: 'reviewed and cleared', at: AT });
  assert.ok(signed !== undefined, 'this install signs its own lowering');
  const stop = host.registerLabelLowerings();
  try {
    await host.refreshLoweringKeys();
    const [low, high] = copies(signed, [RESTRICTED]);
    for (const merged of both(low, high)) assert.deepEqual(markOf(merged), ['org/Public']);
    both(low, high);
    const stranger = lowered(await signerOf(), [RESTRICTED], [PUBLIC]);
    for (const merged of both(...copies(stranger, [RESTRICTED]))) assert.deepEqual(markOf(merged), ['org/Restricted']);
    both(...copies(stranger, [RESTRICTED]));
  } finally {
    stop();
  }
  const records = await recordsOf(host, storage, root);
  const rule = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';
  assert.equal(records.filter((record) => rule(record) === 'label.declassify').length, 1, 'applied, recorded once');
  assert.match(JSON.stringify(records.find((record) => rule(record) === 'label.declassify')), /another copy of this chat/);
  const rejected = records.filter((record) => rule(record) === 'label.declassify-rejected');
  assert.equal(rejected.length, 1, 'rejected, recorded once');
  assert.match(JSON.stringify(rejected[0]), /unknown to this computer/);
  assert.equal(told.length, 1);
  assert.match(told[0]![1], /NEAR AI: Lower This Chat's Label/);
  assert.deepEqual(takeChatNotices(CHAT), [told[0]![1]], 'the chat shows it once when it is open or next opened');
  assert.deepEqual(takeChatNotices(CHAT), []);
});

// ---- PR #87 review round 2 ----

test('review 2.1: an applied lowering lands exactly on its signed target, never on a lower stored mark, and what is reported matches the state, in both orders', async () => {
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  const signed = lowered(identity, [RESTRICTED], [CONFIDENTIAL]);
  // The lowering copy's stored mark was hand-edited (or left by an old sync) below the signed target.
  const stale = meta(CHAT, LATER, { mark: [PUBLIC], lowerings: [signed] });
  const high = meta(CHAT, T0, { mark: [RESTRICTED] });
  const reported: Array<{ applied: boolean; result?: string[] }> = [];
  const stopJudge = registerLabelLoweringJudge((lowering, context) => judgeChatLowering(lowering, context, keys));
  const stopOutcomes = registerLoweringOutcomes((outcome) => reported.push({ applied: outcome.applied, ...(outcome.result === undefined ? {} : { result: keys_(outcome.result) }) }));
  try {
    for (const merged of both(stale, high)) assert.deepEqual(markOf(merged), ['org/Confidential'], 'exactly the signed target');
  } finally {
    stopJudge();
    stopOutcomes();
  }
  assert.ok(reported.length > 0 && reported.every((each) => each.applied && JSON.stringify(each.result) === JSON.stringify(['org/Confidential'])), JSON.stringify(reported));
});

test('review 2.3: a merged label keeps fields this version does not know, with or without an applied lowering', async () => {
  const left = meta(ID, '2026-11-10T00:00:00.000Z', { mark: [CONFIDENTIAL], futureLabelField: 'kept' });
  const right = meta(ID, '2026-11-12T00:00:00.000Z', { mark: [PUBLIC] });
  for (const merged of both(left, right)) assert.equal((merged.label as unknown as { futureLabelField?: string }).futureLabelField, 'kept');
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  const low = meta(CHAT, LATER, { mark: [PUBLIC], lowerings: [lowered(identity, [RESTRICTED], [PUBLIC])], futureLabelField: 'kept' });
  const high = meta(CHAT, T0, { mark: [RESTRICTED] });
  const outcome = judged(keys, () => both(low, high));
  for (const merged of outcome.result) {
    assert.deepEqual(markOf(merged), ['org/Public']);
    assert.equal((merged.label as unknown as { futureLabelField?: string }).futureLabelField, 'kept');
  }
});

test('review 3.4: the person\'s lowering and a lowering applied by a merge write label events of one shape: label the target, mark after, from before', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-label-shape-')));
  const { host, storage } = await labelHost(root);
  const chat = viewOf(root, [RESTRICTED], 'conv-shape-person-1');
  resetUi();
  stub.quickPickAnswers.push('org/Internal');
  stub.inputAnswers.push('reviewed');
  assert.equal(await gateCommands.lowerChatLabel(host, chat), true);
  const signed = await host.signChatLowering({ chatId: CHAT, from: [RESTRICTED], to: [PUBLIC], reason: 'reviewed and cleared', at: AT });
  assert.ok(signed !== undefined);
  const stop = host.registerLabelLowerings();
  try {
    await host.refreshLoweringKeys();
    both(...copies(signed, [RESTRICTED]));
  } finally {
    stop();
  }
  const declassify = (await recordsOf(host, storage, root)).filter((record) => record.authorizations[0]?.policy.name === 'label.declassify');
  assert.equal(declassify.length, 2);
  const shape = (record: DecisionRecord) => ({ label: record.unmapped.nearAi.label?.level, mark: record.unmapped.nearAi.mark?.map((each) => each.level), from: record.unmapped.nearAi.from?.map((each) => each.level) });
  const person = declassify.find((record) => JSON.stringify(record).includes('conv-shape-person-1'))!;
  const merged = declassify.find((record) => JSON.stringify(record).includes(CHAT))!;
  assert.deepEqual(shape(person), { label: 'Internal', mark: ['Internal'], from: ['Restricted'] });
  assert.deepEqual(shape(merged), { label: 'Public', mark: ['Public'], from: ['Restricted'] });
});

test('review 5.2: a copy holding one valid and one invalid fresh lowering applies the valid one and records exactly one label.declassify and one label.declassify-rejected', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-label-mixed-')));
  const { host, storage } = await labelHost(root);
  const valid = await host.signChatLowering({ chatId: CHAT, from: [RESTRICTED], to: [PUBLIC], reason: 'reviewed and cleared', at: AT });
  assert.ok(valid !== undefined);
  const forged = { ...valid, sig: `${valid.sig.slice(0, -4)}AAAA`, payload: { ...valid.payload, reason: 'changed' } };
  const stop = host.registerLabelLowerings();
  let merged: ThreadMeta[];
  try {
    await host.refreshLoweringKeys();
    merged = both(meta(CHAT, LATER, { mark: [PUBLIC], lowerings: [valid, forged] }), meta(CHAT, T0, { mark: [RESTRICTED] }));
  } finally {
    stop();
  }
  for (const each of merged) assert.deepEqual(markOf(each), ['org/Public'], 'the verified lowering applies, from its signed target');
  const records = await recordsOf(host, storage, root);
  const rule = (record: DecisionRecord): string => record.authorizations[0]?.policy.name ?? '';
  assert.equal(records.filter((record) => rule(record) === 'label.declassify').length, 1);
  assert.equal(records.filter((record) => rule(record) === 'label.declassify-rejected').length, 1);
  assert.deepEqual(records.find((record) => rule(record) === 'label.declassify')?.unmapped.nearAi.mark?.map((each) => each.level), ['Public'], 'the record matches the state');
});

// ---- PR #87 review, last rounds (fixed in PR 4d) ----

test('review 4.1: a verified signed lowering whose target is not below its from-mark, or is below the project\'s label, is not applied', async () => {
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  // A target equal to (or above) its from-mark is not a lowering, however it verifies.
  const notLower = judged(keys, () => both(...copies(lowered(identity, [CONFIDENTIAL], [CONFIDENTIAL, label('ca-protected', 'Protected A')]), [CONFIDENTIAL])));
  assert.deepEqual([...new Set(notLower.outcomes.map((each) => each.cause))], ['not-lower']);
  // Below the project's label as this computer last ran the chat at: refused; at it: applied.
  const { noteChatProjectMark } = await import('../domain/gate/lowerings');
  noteChatProjectMark(CHAT, [label('org', 'Internal')]);
  try {
    const below = judged(keys, () => both(...copies(lowered(identity, [RESTRICTED], [PUBLIC]), [RESTRICTED])));
    for (const merged of below.result) assert.deepEqual(markOf(merged), ['org/Restricted']);
    assert.deepEqual([...new Set(below.outcomes.map((each) => each.cause))], ['below-project']);
    const at = judged(keys, () => both(meta(CHAT, LATER, { mark: [label('org', 'Internal')], lowerings: [lowered(identity, [RESTRICTED], [label('org', 'Internal')])] }), meta(CHAT, T0, { mark: [RESTRICTED] })));
    for (const merged of at.result) assert.deepEqual(markOf(merged), ['org/Internal']);
  } finally {
    noteChatProjectMark(CHAT, []);
  }
});

test('review 4.2: times are compared as times: a use 500 ms before the signing is not after it, and a time that cannot be read refuses the lowering', async () => {
  const identity = await signerOf();
  const keys = ACTIVE_FOR(identity.fingerprint);
  const signedAt = '2026-11-17T11:00:00.500Z';
  const lowering = signChatLowering(identity, { chatId: CHAT, from: [RESTRICTED], to: [PUBLIC], reason: 'reviewed', at: signedAt });
  // As text, "…11:00:00Z" sorts after "…11:00:00.500Z" ('Z' > '.'), which read the earlier use as later. As times it is earlier.
  const earlierUse = judged(keys, () => both(...copies(lowering, [RESTRICTED], '2026-11-17T11:00:00Z')));
  for (const merged of earlierUse.result) assert.deepEqual(markOf(merged), ['org/Public']);
  const unreadable = judged(keys, () => both(...copies(lowering, [RESTRICTED], 'not a time')));
  for (const merged of unreadable.result) assert.deepEqual(markOf(merged), ['org/Restricted']);
  assert.deepEqual([...new Set(unreadable.outcomes.map((each) => each.cause))], ['unreadable-time']);
});

test('review 4.6: the person\'s lowering records the strictest label of the new mark, and a chat in view that has not run yet gets its own sentence', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-label-strictest-')));
  const { host, storage } = await labelHost(root);
  // Lowered to Public on the org scale while Protected B stays: the record's label is Protected B (local-only), not the first label of the mark.
  const chat = viewOf(root, [RESTRICTED, label('ca-protected', 'Protected B')], 'conv-strictest-1');
  resetUi();
  stub.quickPickAnswers.push('org/Public, ca-protected/Protected B');
  stub.inputAnswers.push('reviewed');
  assert.equal(await gateCommands.lowerChatLabel(host, chat), true);
  const record = (await recordsOf(host, storage, root)).find((each) => each.authorizations[0]?.policy.name === 'label.declassify');
  assert.equal(record?.unmapped.nearAi.label?.level, 'Protected B');
  resetUi();
  const notRun: ChatInView = { id: 'conv-not-run-1', root, mark: () => undefined, defaultLabel: () => SHIPPED_DEFAULT_LABEL, prepareLowering: () => undefined };
  assert.equal(await gateCommands.lowerChatLabel(host, notRun), false);
  assert.ok(stub.notifications.some((entry) => entry.message === gateCommands.CHAT_NOT_RUN_TEXT));
  assert.ok(!stub.notifications.some((entry) => entry.message === gateCommands.NO_CHAT_IN_VIEW_TEXT));
});

test('review 4.7: a lowering saved after a sync raised the stored label above its from-mark keeps the higher label, and the chat is raised and told', async () => {
  const root = labelledProject();
  const store = storeFor(root);
  const posts: Array<Record<string, unknown>> = [];
  const conversation = await chatIn(root, store, posts);
  await conversation.send(request([call('r1', 'Read', { file_path: 'conf.md' })]));
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Confidential']);
  // A sync raises the stored label to Restricted while the person is choosing.
  await store.setChatLabel(conversation.id, [RESTRICTED]);
  conversation.prepareLowering(true);
  conversation.mark!.lowerByPerson([PUBLIC], 'reviewed');
  for (let wait = 0; wait < 50 && !posts.some((post) => post.type === 'notice' && post.text === LOWERING_OVERTAKEN_TEXT); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(markOf((await store.meta(conversation.id))!), ['org/Restricted'], 'the raise is kept');
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Restricted'], 'the chat is raised to it');
  assert.ok(posts.some((post) => post.type === 'notice' && post.text === LOWERING_OVERTAKEN_TEXT));
  // Without a raise meanwhile the lowering is saved as it was made.
  assert.equal(await store.setChatLabel(conversation.id, [PUBLIC], true, [RESTRICTED]), 'saved');
  assert.deepEqual(markOf((await store.meta(conversation.id))!), ['org/Public']);
});

test('review 4.9: an unsigned lowering survives a reload: the reopened chat starts at the lowered label', async () => {
  const root = labelledProject();
  const store = storeFor(root);
  const conversation = await chatIn(root, store);
  await conversation.send(request([call('r1', 'Read', { file_path: 'docs/plan.md' })]));
  assert.deepEqual(keys(conversation.mark!.current()), ['org/Restricted']);
  // This install could not sign the lowering (`true`), so it is kept on this computer only.
  conversation.prepareLowering(true);
  conversation.mark!.lowerByPerson([label('org', 'Internal')], 'reviewed');
  for (let wait = 0; wait < 50 && markOf((await store.meta(conversation.id))!).join() !== 'org/Internal'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const id = conversation.id;
  // A window reload: a new conversation over a new store on the same project opens the chat again.
  const reopened = await chatIn(root, storeFor(root));
  await reopened.restore(id);
  assert.deepEqual(keys(reopened.mark!.current()), ['org/Internal']);
});

// ---- PR #89 review: Lower This Chat's Label is reachable where people look (owner, after the 0.4.31 check) ----

/** Every node under `root`, depth first. */
function nodesUnder(root: { children: unknown[] } | undefined): Array<{ id: string; className: string; textContent: string; children: unknown[]; click(): void; tagName: string }> {
  const out: Array<{ id: string; className: string; textContent: string; children: unknown[]; click(): void; tagName: string }> = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    out.push(node as never);
    for (const child of (node as { children?: unknown[] }).children ?? []) walk(child);
  };
  for (const child of root?.children ?? []) walk(child);
  return out;
}
const lowerButtons = (root: { children: unknown[] } | undefined) => nodesUnder(root).filter((node) => node.tagName === 'button' && node.textContent === 'Lower This Chat’s Label');

test('review 89.6: the label chip is a button with its tooltip, and a click asks to lower this chat\'s label', () => {
  const html = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'panelView.ts'), 'utf8');
  assert.ok(html.includes('<button id="chat-label" class="chip chat-label" type="button" title="This chat\'s label. Click to lower it." hidden></button>'), 'a native button: Enter and Space work, and it is in the tab order');
  const page = chatPage();
  page.send({ type: 'chat-label', text: 'org/Confidential' });
  const chip = page.nodes.get('chat-label')!;
  assert.equal(chip.hidden, false);
  chip.click();
  assert.deepEqual(page.sent().filter((message) => (message as { type: string }).type === 'lower-chat-label'), [{ type: 'lower-chat-label' }]);
});

test('review 89.6: a refusal that names Lower This Chat\'s Label shows a button that runs it, in an error notice and under a refused tool call; other notices do not', () => {
  const page = chatPage();
  const transcript = page.nodes.get('transcript');
  page.send({ type: 'assistant-error', text: ROUTE_REFUSALS['route.no-local-model'] });
  page.send({ type: 'notice', text: 'Nothing to do with labels.' });
  const buttons = lowerButtons(transcript);
  assert.equal(buttons.length, 1);
  buttons[0]!.click();
  assert.equal(page.sent().filter((message) => (message as { type: string }).type === 'lower-chat-label').length, 1);
  page.send({ type: 'tool-start', callId: 'c1', title: 'WebFetch' });
  page.send({ type: 'tool-end', callId: 'c1', ok: false, output: NETWORK_AT_MARK_TEXT });
  page.send({ type: 'tool-start', callId: 'c2', title: 'Read' });
  page.send({ type: 'tool-end', callId: 'c2', ok: false, output: 'File not found.' });
  assert.equal(lowerButtons(transcript).length, 2, 'one more, under the refused call only');
  // Every route.* and label.* refusal text that names the command gets the button through the same check.
  for (const text of [...Object.values(ROUTE_REFUSALS), NETWORK_AT_MARK_TEXT]) {
    if (!text.includes("NEAR AI: Lower This Chat's Label")) continue;
    const fresh = chatPage();
    fresh.send({ type: 'assistant-error', text });
    assert.equal(lowerButtons(fresh.nodes.get('transcript')).length, 1, text.slice(0, 60));
  }
});

test('review 89.6: the page asks for lower-chat-label only in its known shape, and the command runs on the chat it is given', async () => {
  const { parseChatWebviewMessage } = await import('../services/chatBridge');
  assert.deepEqual(parseChatWebviewMessage({ type: 'lower-chat-label' }), { type: 'lower-chat-label' });
  assert.deepEqual(parseChatWebviewMessage({ type: 'lower-chat-label', conversationId: 'conv-abcdef-1' }), { type: 'lower-chat-label', conversationId: 'conv-abcdef-1' });
  assert.equal(parseChatWebviewMessage({ type: 'lower-chat-label', extra: 1 }), undefined);
  const chatSource = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'chat.ts'), 'utf8');
  assert.ok(chatSource.includes("executeCommand('nearAi.label.lowerChat', inView(tab))"), 'the page\'s own conversation, not whichever chat the status bar shows');
  const { isChatInView } = await import('../services/chatInView');
  assert.equal(isChatInView({ fsPath: '/x' }), false, 'an Explorer argument is not a chat');
  assert.equal(isChatInView(viewOf('/tmp/x', [RESTRICTED])), true);
});

test('review 89.6: lowering a file\'s label with Set Label tells the chat in view that read it that it keeps its label, with a button that lowers it', async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-chat-keeps-')));
  const { host } = await labelHost(root);
  await host.changeLabels(root, (map) => setLabelEntry(map, 'conf.md', CONFIDENTIAL));
  const chat = viewOf(root, [CONFIDENTIAL], 'conv-keeps-label-1');
  setChatInView(chat);
  try {
    resetUi();
    stub.messageAnswers.length = 0;
    stub.notificationActions.length = 0;
    stub.quickPickAnswers.push('org', 'Internal', []);
    stub.inputAnswers.push('', 'the budget was published');
    // The first message is "conf.md is labelled ..."; the second is the chat's notice, answered with its button.
    stub.messageAnswers.push(undefined, gateCommands.LOWER_CHAT_LABEL_ACTION);
    stub.quickPickAnswers.push('org/Internal');
    stub.inputAnswers.push('it only read the published budget');
    assert.equal(await gateCommands.setLabel(host, { root, path: 'conf.md' }), true);
    const index = stub.notifications.findIndex((entry) => entry.message === gateCommands.CHAT_KEEPS_LABEL_TEXT);
    assert.ok(index >= 0, 'the chat keeps its label, and says so');
    assert.deepEqual(stub.notificationActions[index], [gateCommands.LOWER_CHAT_LABEL_ACTION]);
    for (let wait = 0; wait < 50 && keys(chat.session.current()).join() !== 'org/Internal'; wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(keys(chat.session.current()), ['org/Internal'], 'the button ran Lower This Chat\'s Label on that chat');
    // Raising a label, or a chat that does not hold the old label, says nothing.
    resetUi();
    stub.messageAnswers.length = 0;
    stub.notificationActions.length = 0;
    const other = viewOf(root, [PUBLIC], 'conv-keeps-label-2');
    setChatInView(other);
    stub.quickPickAnswers.push('org', 'Public', []);
    stub.inputAnswers.push('', 'published');
    assert.equal(await gateCommands.setLabel(host, { root, path: 'conf.md' }), true);
    assert.ok(!stub.notifications.some((entry) => entry.message === gateCommands.CHAT_KEEPS_LABEL_TEXT));
  } finally {
    setChatInView(undefined);
  }
});

// PR 4e replaced the Verify signature row with the trust badge (CLAS-08), which keeps this rule: it is placed only under its own run's answer, never under
// another one. The badge is posted after its answer, so it never waits; one for a run whose answer is not on the page draws nothing.
test('review 89.4: a trust badge is placed only under its own run\'s answer, never under another one', async () => {
  const page = chatPage();
  const transcript = page.nodes.get('transcript')!;
  const answer = async (runId: string) => {
    page.send({ type: 'assistant-start', model: 'tee-model', privacy: 'Private' });
    page.send({ type: 'assistant-done', runId, usage: { inputTokens: 1, outputTokens: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return transcript.children.at(-1) as never as { children: unknown[] };
  };
  const failed = { state: 'not-verified', title: 'Not verified', explanation: 'NEAR AI could not show that a private model on NEAR AI Cloud sent this answer.', reasons: ['The check failed: The signature does not match the signing address.'], helpers: 'Helpers.' };
  const reply1 = await answer('run-1-aaaaaa');
  // run-2's badge arrives before run-2's answer is on the page: it goes nowhere, least of all under run-1's answer.
  page.send({ type: 'trust-badge', runId: 'run-2-bbbbbb', badge: failed });
  const badges = (root: { children: unknown[] }) => nodesUnder(root).filter((node) => node.tagName === 'button' && node.className === 'trust-badge');
  assert.equal(badges(transcript as never).length, 0, 'not placed under run-1\'s answer, or anywhere');
  const reply2 = await answer('run-2-bbbbbb');
  assert.notEqual(reply2, reply1);
  page.send({ type: 'trust-badge', runId: 'run-2-bbbbbb', badge: failed });
  assert.equal(badges(reply2).length, 1, 'under run-2\'s own answer');
  assert.equal(badges(reply1).length, 0);
  // A badge for a run whose answer is already on the page goes straight under it.
  page.send({ type: 'trust-badge', runId: 'run-1-aaaaaa', badge: failed });
  assert.equal(badges(reply1).length, 1);
  assert.equal(badges(transcript as never).length, 2);
});

// ---- PR #89 last review, minor findings ----

test('review 89 minor 1: Set Label says the chat keeps its label only when the new label is absent or does not cover the chat\'s mark; a raise says nothing', () => {
  const scales = SCALE_PRESETS;
  const internal = label('org', 'Internal');
  // The chat held the file's old label (Confidential).
  assert.equal(gateCommands.chatKeepsLabel([CONFIDENTIAL], [CONFIDENTIAL], internal, scales), true, 'lowered to Internal: the chat keeps Confidential');
  assert.equal(gateCommands.chatKeepsLabel([CONFIDENTIAL], [CONFIDENTIAL], undefined, scales), true, 'the label removed');
  assert.equal(gateCommands.chatKeepsLabel([CONFIDENTIAL], [CONFIDENTIAL], RESTRICTED, scales), false, 'a raise to Restricted covers the chat: nothing to keep');
  assert.equal(gateCommands.chatKeepsLabel([CONFIDENTIAL], [CONFIDENTIAL], CONFIDENTIAL, scales), false, 'the same level covers it too');
  const nato = label('nato', 'NATO Restricted');
  assert.equal(gateCommands.chatKeepsLabel([CONFIDENTIAL], [CONFIDENTIAL], nato, scales), true, 'a label on another scale does not cover the chat\'s org label');
  assert.equal(gateCommands.chatKeepsLabel([PUBLIC], [CONFIDENTIAL], internal, scales), false, 'a chat that did not hold the old label is told nothing');
  // setLabel decides with it, after its own lowering check.
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'gateCommands.ts'), 'utf8');
  assert.match(source, /if \(held !== undefined && chatKeepsLabel\(held, current\.mark, label, policy\.scales\)\)/);
});

test('review 89 minor 4: the ChatInView doc comment sits directly above its type, and isChatInView has its own', () => {
  const source = readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'chatInView.ts'), 'utf8').split('\n');
  const typeLine = source.findIndex((line) => line.startsWith('export interface ChatInView'));
  assert.equal(source[typeLine - 1], '/** What the label surfaces need of the chat on screen. */');
  const guardLine = source.findIndex((line) => line.startsWith('export function isChatInView'));
  assert.match(source[guardLine - 1]!, /^\/\*\* Whether a value passed to a command is a ChatInView/);
  assert.equal(source.filter((line) => line === '/** What the label surfaces need of the chat on screen. */').length, 1);
});
