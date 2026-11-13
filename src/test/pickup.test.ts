// "Pick up where you left off" (D-03, SYNC-07): the card offered when the project's last chat was continued in another editor or on another computer.
// It only reopens that chat. It never resumes a run, never sends a model request, and so never spends money.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { derivePickup, nextGsdStep, type PickupModel, type PickupPointer, type PickupThread } from '../domain/state/pickup';
import { parseChatWebviewMessage } from '../services/chatBridge';
import { handlePickupAction, markPickupSeen, PICKUP_SEEN_KEY, pickupCardModel, readPickupPointer, writePickupPointer } from '../services/pickupCard';
import { stateHomeFor, type MementoLike } from '../services/stateHome';
import { gitInit, gitStatus, tempProject } from './helpers/stateFixtures';
import { FakeDocument, FakeNode } from './helpers/fakeDom';

const ROOT = path.join(__dirname, '..', '..');

const EDITOR_A = 'aaaaaaaa1111.hosta00001';
const EDITOR_A_LATER = 'aaaaaaaa1111.hosta00002';
const EDITOR_B = 'bbbbbbbb2222.hostb00001';
const CHAT = 'conv-abc123def';

const thread = (overrides: Partial<PickupThread> = {}): PickupThread => ({ id: CHAT, title: 'Fix the login bug', lastUsedAt: '2026-11-13T10:00:00.000Z', ...overrides });
const pointer = (overrides: Partial<PickupPointer> = {}): PickupPointer => ({ conversationId: CHAT, writer: EDITOR_B, at: '2026-11-13T10:05:00.000Z', ...overrides });

class Memory implements MementoLike {
  public readonly values = new Map<string, unknown>();
  public get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
}

// ---- the model ----

test('tracer: a pointer written by another editor shows the card with the chat title; the same editor never sees it', () => {
  const model = derivePickup({ pointer: pointer(), thisWriter: EDITOR_A, lastSeenAt: undefined, index: [thread()] });
  assert.equal(model.show, true);
  assert.deepEqual(model.lastChat, { id: CHAT, title: 'Fix the login bug', at: '2026-11-13T10:00:00.000Z' });
  assert.equal(model.pointerAt, '2026-11-13T10:05:00.000Z');
  // The same editor (another window of it, or after a reload) reopening: no card.
  const same = derivePickup({ pointer: pointer({ writer: EDITOR_A_LATER }), thisWriter: EDITOR_A, lastSeenAt: undefined, index: [thread()] });
  assert.equal(same.show, false);
  // No pointer, no card.
  assert.equal(derivePickup({ pointer: undefined, thisWriter: EDITOR_A, lastSeenAt: undefined, index: [thread()] }).show, false);
});

test('a pointer this editor has already seen is not shown again; a newer one is', () => {
  const seen = derivePickup({ pointer: pointer(), thisWriter: EDITOR_A, lastSeenAt: '2026-11-13T10:05:00.000Z', index: [thread()] });
  assert.equal(seen.show, false);
  const newer = derivePickup({ pointer: pointer({ at: '2026-11-13T11:00:00.000Z' }), thisWriter: EDITOR_A, lastSeenAt: '2026-11-13T10:05:00.000Z', index: [thread()] });
  assert.equal(newer.show, true);
  // A last-seen value that is not a time never hides a card for good.
  assert.equal(derivePickup({ pointer: pointer(), thisWriter: EDITOR_A, lastSeenAt: 'garbage', index: [thread()] }).show, true);
});

test('a chat that is locked or missing still shows the card, without a title', () => {
  const locked = derivePickup({ pointer: pointer(), thisWriter: EDITOR_A, lastSeenAt: undefined, index: [thread({ locked: true, title: '' })] });
  assert.equal(locked.show, true);
  assert.deepEqual(locked.lastChat, { id: CHAT, title: '', at: '2026-11-13T10:00:00.000Z', locked: true });
  const missing = derivePickup({ pointer: pointer(), thisWriter: EDITOR_A, lastSeenAt: undefined, index: [] });
  assert.equal(missing.show, true);
  assert.equal(missing.lastChat, undefined);
});

// ---- the pointer file and the host model ----

test('the pointer is written in the state home, ignored by git, and read back; a damaged one means no card', async () => {
  const root = await tempProject();
  gitInit(root);
  await writePickupPointer(root, pointer());
  assert.deepEqual(await readPickupPointer(root), pointer());
  assert.equal(gitStatus(root), '', 'the state home ignores its own files, so the pointer is never staged');
  const home = stateHomeFor(root);
  await writeFile(home.paths.pickup, '{"conversationId":"not an id","writer":"x","at":"nope"}\n');
  assert.equal(await readPickupPointer(root), undefined);
  await writeFile(home.paths.pickup, 'not json');
  assert.equal(await readPickupPointer(root), undefined);
  const deps = { workspaceState: new Memory(), writer: EDITOR_A, threads: { index: () => Promise.resolve([thread()]) } };
  assert.equal((await pickupCardModel(deps, root)).show, false);
});

test('building the model creates nothing in a project that has no state home', async () => {
  const root = await tempProject();
  const deps = { workspaceState: new Memory(), writer: EDITOR_A, threads: { index: () => Promise.resolve([thread()]) } };
  const model = await pickupCardModel(deps, root);
  assert.equal(model.show, false);
  assert.deepEqual(await readdir(root), [], 'opening a folder writes nothing');
});

test('the model reads the pointer another editor wrote and respects what this editor has seen', async () => {
  const root = await tempProject();
  await writePickupPointer(root, pointer());
  const state = new Memory();
  const deps = { workspaceState: state, writer: EDITOR_A, threads: { index: () => Promise.resolve([thread()]) } };
  const first = await pickupCardModel(deps, root);
  assert.equal(first.show, true);
  assert.equal(first.lastChat?.title, 'Fix the login bug');
  await markPickupSeen(state, first.pointerAt);
  assert.equal(state.get(PICKUP_SEEN_KEY), '2026-11-13T10:05:00.000Z');
  assert.equal((await pickupCardModel(deps, root)).show, false, 'after "Not now" the same pointer is never shown again');
  await writePickupPointer(root, pointer({ at: '2026-11-13T12:00:00.000Z' }));
  assert.equal((await pickupCardModel(deps, root)).show, true, 'a newer pointer from another editor shows again');
  // Remembering never moves backwards.
  await markPickupSeen(state, '2026-11-13T09:00:00.000Z');
  assert.equal(state.get(PICKUP_SEEN_KEY), '2026-11-13T10:05:00.000Z');
});

// ---- the card in the view ----

interface PickupKit {
  renderPickupCard(doc: FakeDocument, container: FakeNode, model: PickupModel | undefined, post: (message: unknown) => void, afterDismiss?: () => void): FakeNode | undefined;
  TEXT: Record<string, unknown>;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const kit = require(path.join(ROOT, 'media', 'chat', 'pickup.js')) as PickupKit;

function emptyChat(): { doc: FakeDocument; welcome: FakeNode } {
  const doc = new FakeDocument();
  const welcome = doc.createElement('section');
  welcome.id = 'welcome';
  welcome.append(doc.createElement('h2'));
  doc.body.append(welcome);
  return { doc, welcome };
}

const shown = (extra: Partial<PickupModel> = {}): PickupModel => ({ show: true, pointerAt: '2026-11-13T10:05:00.000Z', lastChat: { id: CHAT, title: 'Fix the login bug', at: '2026-11-13T10:00:00.000Z' }, ...extra });

test('the card is a labelled region with real buttons, and the click posts exactly the open message', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  const card = kit.renderPickupCard(doc, welcome, shown(), (message) => posts.push(message))!;
  assert.equal(welcome.children[0], card, 'above the welcome text');
  assert.equal(card.id, 'pickup-card');
  assert.equal(card.tagName, 'section');
  assert.equal(card.attributes.get('role'), 'region');
  assert.equal(card.attributes.get('aria-labelledby'), 'pickup-card-title');
  assert.equal(doc.getElementById('pickup-card-title')?.textContent, 'Pick up where you left off');
  const buttons = card.all((node) => node.tagName === 'button');
  assert.deepEqual(buttons.map((button) => [button.textContent, button.type]), [['Open chat', 'button'], ['Not now', 'button']], 'real buttons, reachable with Tab');
  assert.match(buttons[0].attributes.get('aria-label') ?? '', /^Open chat/, 'the accessible name starts with the visible label');
  assert.ok(card.all((node) => node.textContent.includes('Fix the login bug')).length > 0, 'the chat title is on the card');
  // Showing it again does not add a second card.
  kit.renderPickupCard(doc, welcome, shown(), (message) => posts.push(message));
  assert.equal(welcome.all((node) => node.id === 'pickup-card').length, 1);
  assert.deepEqual(posts, []);
  // Rebuilt for the click test: Open posts exactly { type, action, id } and the card goes away.
  const again = doc.getElementById('pickup-card')!;
  again.all((node) => node.tagName === 'button')[0].click();
  assert.deepEqual(posts, [{ type: 'pickup-card', action: 'open', id: CHAT }]);
  assert.equal(again.attached, false);
});

test('"Not now" hides the card, returns focus, and posts the later message', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  let focused = 0;
  const card = kit.renderPickupCard(doc, welcome, shown(), (message) => posts.push(message), () => { focused += 1; })!;
  card.all((node) => node.tagName === 'button')[1].click();
  assert.deepEqual(posts, [{ type: 'pickup-card', action: 'later' }]);
  assert.equal(card.attached, false);
  assert.equal(focused, 1);
});

test('a hidden model removes the card; titles are text, never markup', () => {
  const { doc, welcome } = emptyChat();
  kit.renderPickupCard(doc, welcome, shown({ lastChat: { id: CHAT, title: '<img src=x onerror=alert(1)>', at: '2026-11-13T10:00:00.000Z' } }), () => undefined);
  const lines = doc.getElementById('pickup-card')!.all((node) => node.tagName === 'p').map((node) => node.textContent);
  assert.ok(lines.some((line) => line.includes('<img src=x onerror=alert(1)>')), 'shown literally, as text');
  assert.equal(kit.renderPickupCard(doc, welcome, { ...shown(), show: false }, () => undefined), undefined);
  assert.equal(doc.getElementById('pickup-card'), undefined);
  assert.equal(kit.renderPickupCard(doc, welcome, undefined, () => undefined), undefined);
  const source = readFileSync(path.join(ROOT, 'media', 'chat', 'pickup.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/, 'data is only ever set with textContent');
  assert.doesNotMatch(JSON.stringify(kit.TEXT), /[—–]/);
});

// ---- the page-to-host message ----

test('the host accepts exactly the two card messages', () => {
  assert.deepEqual(parseChatWebviewMessage({ type: 'pickup-card', action: 'open', id: CHAT }), { type: 'pickup-card', action: 'open', id: CHAT });
  assert.deepEqual(parseChatWebviewMessage({ type: 'pickup-card', action: 'later' }), { type: 'pickup-card', action: 'later' });
  for (const bad of [
    { type: 'pickup-card', action: 'resume', id: CHAT },
    { type: 'pickup-card', action: 'open' },
    { type: 'pickup-card', action: 'open', id: 'not-a-conversation' },
    { type: 'pickup-card', action: 'open', id: CHAT, text: 'extra' },
    { type: 'pickup-card', action: 'later', id: CHAT },
    { type: 'pickup-card', action: 'later', extra: 1 },
    { type: 'pickup-card' }
  ]) assert.equal(parseChatWebviewMessage(bad), undefined, JSON.stringify(bad));
});

test('the chat loads the card helper before chat.js and wires it to the host, and the handler reaches only openSaved', () => {
  const panel = readFileSync(path.join(ROOT, 'src', 'services', 'panelView.ts'), 'utf8');
  assert.equal((panel.match(/asset\('pickup\.js'\)/g) ?? []).length, 1);
  assert.ok(panel.indexOf("asset('pickup.js')") < panel.indexOf("asset('chat.js')"), 'pickup.js loads before chat.js');
  const script = readFileSync(path.join(ROOT, 'media', 'chat', 'chat.js'), 'utf8');
  assert.match(script, /case 'pickup-card': pickupKit\.renderPickupCard\(document, welcomeReady, m\.model, post, \(\) => input\.focus\(\)\); break;/);
  assert.match(script, /window\.nearPickup \|\| \{ renderPickupCard: \(\) => undefined \}/);
  const chat = readFileSync(path.join(ROOT, 'src', 'services', 'chat.ts'), 'utf8');
  const start = chat.indexOf("message.type === 'pickup-card'");
  assert.ok(start > 0);
  const block = chat.slice(start, chat.indexOf('return;', start));
  assert.match(block, /openSaved/);
  assert.doesNotMatch(block, /settleInterrupted|autoResumeChoice|receive\(|continueStopped|resume-interrupted/);
});

test('the card handler opens the chat and nothing else', async () => {
  const calls: string[] = [];
  const host = { openSaved: (id: string) => { calls.push(`open:${id}`); return Promise.resolve(); }, markSeen: () => { calls.push('seen'); return Promise.resolve(); } };
  await handlePickupAction({ action: 'open', id: CHAT }, host);
  await handlePickupAction({ action: 'later' }, host);
  assert.deepEqual(calls, [`open:${CHAT}`, 'seen']);
});

// ---- the GSD phase and its next step ----

test('the next step follows the files in the phase folder', () => {
  const next = (files: string[], total: number | null = 5) => nextGsdStep(3, files, total).command;
  assert.equal(next([]), '/gsd-discuss-phase 3', 'no folder yet');
  assert.equal(next(['03-RESEARCH.md']), '/gsd-discuss-phase 3', 'no CONTEXT');
  assert.equal(next(['03-CONTEXT.md']), '/gsd-plan-phase 3');
  assert.equal(next(['03-CONTEXT.md', '03-01-PLAN.md']), '/gsd-execute-phase 3', 'a plan without its summary');
  assert.equal(next(['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-02-PLAN.md']), '/gsd-execute-phase 3', 'one of two plans summarised');
  assert.equal(next(['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-02-PLAN.md', '03-02-SUMMARY.md']), '/gsd-verify-work 3');
  assert.equal(next(['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-VERIFICATION.md']), '/gsd-discuss-phase 4');
  assert.equal(next(['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-UAT.md']), '/gsd-discuss-phase 4');
  assert.equal(nextGsdStep(5, ['05-CONTEXT.md', '05-01-PLAN.md', '05-01-SUMMARY.md', '05-VERIFICATION.md'], 5).command, '/gsd-complete-milestone', 'the last phase is done');
  assert.equal(nextGsdStep(3, ['03-CONTEXT.md'], 5).text, 'Next step: run /gsd-plan-phase 3 in the chat');
});

async function planning(root: string, options: { current?: number | string; heading?: string; folders?: Record<string, string[]> } = {}): Promise<void> {
  const dir = path.join(root, '.planning');
  await mkdir(path.join(dir, 'phases'), { recursive: true });
  await writeFile(path.join(dir, 'STATE.md'), `---\ncurrent_phase: ${options.current ?? 3}\ntotal_phases: 5\nstatus: executing\n---\n`);
  await writeFile(path.join(dir, 'ROADMAP.md'), `# Roadmap\n\n${options.heading ?? '### Phase 3: Build the sharing step'}\n\nGoal.\n`);
  for (const [folder, files] of Object.entries(options.folders ?? {})) {
    await mkdir(path.join(dir, 'phases', folder), { recursive: true });
    for (const file of files) await writeFile(path.join(dir, 'phases', folder, file), '# x\n');
  }
}

const depsFor = () => ({ workspaceState: new Memory(), writer: EDITOR_A, threads: { index: () => Promise.resolve([thread()]) } });

test('the card names the current phase and its next step from the planning folder', async () => {
  const cases: Array<[string[], string]> = [
    [[], '/gsd-discuss-phase 3'],
    [['03-RESEARCH.md'], '/gsd-discuss-phase 3'],
    [['03-CONTEXT.md'], '/gsd-plan-phase 3'],
    [['03-CONTEXT.md', '03-01-PLAN.md'], '/gsd-execute-phase 3'],
    [['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md'], '/gsd-verify-work 3'],
    [['03-CONTEXT.md', '03-01-PLAN.md', '03-01-SUMMARY.md', '03-VERIFICATION.md'], '/gsd-discuss-phase 4']
  ];
  for (const [files, command] of cases) {
    const root = await tempProject();
    await planning(root, { folders: { '03-build-the-sharing-step': files, '03.1-an-inserted-phase': ['03.1-CONTEXT.md'], '04-later': ['04-CONTEXT.md'] } });
    await writePickupPointer(root, pointer());
    const model = await pickupCardModel(depsFor(), root);
    assert.equal(model.phase?.number, 3);
    assert.equal(model.phase?.name, 'Build the sharing step');
    assert.equal(model.phase?.nextStep.command, command, files.join(','));
    assert.equal(model.phase?.nextStep.text, `Next step: run /${command.slice(1)} in the chat`);
  }
});

test('an unpadded phase folder is found too, and no .planning folder means no phase line', async () => {
  const root = await tempProject();
  await planning(root, { folders: { '3-sharing': ['3-CONTEXT.md'] } });
  await writePickupPointer(root, pointer());
  assert.equal((await pickupCardModel(depsFor(), root)).phase?.nextStep.command, '/gsd-plan-phase 3');
  const bare = await tempProject();
  await writePickupPointer(bare, pointer());
  const model = await pickupCardModel(depsFor(), bare);
  assert.equal(model.show, true);
  assert.equal(model.phase, undefined);
  assert.equal(model.lastChat?.title, 'Fix the login bug', 'the chat line is still there');
  // A STATE.md with no current phase gives no phase line either.
  const noPhase = await tempProject();
  await mkdir(path.join(noPhase, '.planning'), { recursive: true });
  await writeFile(path.join(noPhase, '.planning', 'STATE.md'), 'status: ready\n');
  await writePickupPointer(noPhase, pointer());
  assert.equal((await pickupCardModel(depsFor(), noPhase)).phase, undefined);
});

test('the card shows the next step as text and only ever posts the two card messages', () => {
  const { doc, welcome } = emptyChat();
  const posts: unknown[] = [];
  const card = kit.renderPickupCard(doc, welcome, shown({ phase: { number: 3, name: 'Build the sharing step', nextStep: { command: '/gsd-plan-phase 3', text: 'Next step: run /gsd-plan-phase 3 in the chat' } } }), (message) => posts.push(message))!;
  const lines = card.all((node) => node.tagName === 'p').map((node) => node.textContent);
  assert.ok(lines.includes('Phase 3: Build the sharing step'));
  assert.ok(lines.includes('Next step: run /gsd-plan-phase 3 in the chat'));
  for (const button of card.all((node) => node.tagName === 'button')) button.click();
  assert.deepEqual(posts.map((message) => (message as { action: string }).action), ['open', 'later']);
  assert.doesNotMatch(JSON.stringify(posts), /gsd-/, 'the command is never posted, so it is never run');
});
