import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseTeam } from '../agent/teams';
import { ActivityStore } from '../services/activityStore';
import { ActivityFeed } from '../services/agentActivity';

// 0.4.28: the Team Live panel's host, driven as VS Code drives it (a stand-in panel and the real shared feed), and its pure parts. What the page
// receives is checked as much as how often it receives it.

type Message = Record<string, any>;
type Handler = (value: unknown) => unknown;
const KEY = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');

const TEAM = parseTeam(`---
name: Research
description: Finds and writes
---

## researcher
role: researcher

Search the web. Report each finding with its URL.

## writer
role: writer
reports-to: researcher

Write the brief. Report where it is.
`, 'research.md');

function load(root: string) {
  const posted: Message[] = [];
  const commands: Array<[string, unknown]> = [];
  const handlers: { message?: Handler; viewState?: Handler; dispose?: Handler } = {};
  const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });
  const panel = {
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      html: '', cspSource: 'vscode-resource:', asWebviewUri: (value: unknown) => value,
      postMessage: async (message: Message) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: Handler) => { handlers.message = handler; return { dispose: () => undefined }; }
    },
    onDidChangeViewState: (handler: Handler) => { handlers.viewState = handler; return { dispose: () => undefined }; },
    onDidDispose: (handler: Handler) => { handlers.dispose = handler; return { dispose: () => undefined }; },
    reveal: () => undefined
  };
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')) },
    ViewColumn: { Active: -1 },
    window: { createWebviewPanel: () => panel },
    workspace: { workspaceFolders: [{ uri: uri(root) }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    commands: { executeCommand: async (command: string, arg?: unknown) => { commands.push([command, arg]); }, registerCommand: () => ({ dispose: () => undefined }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let live: typeof import('../services/teamLiveView');
  let activity: typeof import('../services/activityView');
  // Fresh modules for each test, bound to this test's stand-in panel.
  for (const name of ['../services/teamLiveView', '../services/activityView']) delete require.cache[require.resolve(name)];
  try {
    live = require('../services/teamLiveView') as typeof import('../services/teamLiveView');
    activity = require('../services/activityView') as typeof import('../services/activityView');
  } finally { nodeModule._load = originalLoad; }
  const context = { extensionUri: uri('/extension'), subscriptions: [] as unknown[] };
  return {
    live, panel, posted, commands, feed: activity.sharedActivityFeed(),
    open: (runId?: string) => live.openTeamLive(context as never, runId),
    send: async (message: unknown) => { await handlers.message?.(message); },
    hide: () => { panel.visible = false; handlers.viewState?.({ webviewPanel: panel }); },
    show: () => { panel.visible = true; handlers.viewState?.({ webviewPanel: panel }); },
    close: () => handlers.dispose?.(undefined)
  };
}

const frames = (posted: Message[], from = 0) => posted.slice(from).filter((message) => message.type === 'team-live');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(posted: Message[], from: number, predicate: (message: Message) => boolean, timeoutMs = 2_000): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames(posted, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no such frame; sent ${frames(posted, from).length}`);
    await wait(10);
  }
}

test('page messages: only known kinds, agent ids by shape, run ids by shape', async () => {
  const { live } = load(await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-')));
  const good: unknown[] = [{ type: 'ready' }, { type: 'show-in-chat' }, { type: 'select-run', runId: 'run-1700000000000-abc123' }, { type: 'agent-control', agentId: 'writer-abc123', action: 'pause' }, { type: 'open-card' }, { type: 'open-card', agentId: 'main-run-1700000000000-abc123' }, { type: 'open-activity', agentId: 'writer-abc123' }];
  for (const message of good) assert.ok(live.parseTeamLiveMessage(message), JSON.stringify(message));
  const bad: unknown[] = [null, [], { type: 'eval' }, { type: 'select-run', runId: '../x' }, { type: 'agent-control', agentId: 'writer', action: 'pause' }, { type: 'agent-control', agentId: 'writer-abc123', action: 'delete' }, { type: 'open-card', agentId: 5 }, { type: 'open-activity', agentId: 'x y' }];
  for (const message of bad) assert.equal(live.parseTeamLiveMessage(message), undefined, JSON.stringify(message));
});

test('which run is shown: the one asked for, else the newest running one in the conversation on screen, else the newest running, else the newest', async () => {
  const { live } = load(await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-')));
  const stat = (runId: string, extra: Record<string, unknown>) => ({ agentId: `main-${runId}`, agent: 'agent', runId, status: 'running' as const, startedAt: 0, ...extra });
  const runs = live.liveRuns([
    stat('run-a', { startedAt: 1, conversationId: 'conv-a', team: 'research' }), stat('run-b', { startedAt: 2, conversationId: 'conv-b', status: 'completed', team: 'research' }),
    stat('run-c', { startedAt: 3, conversationId: 'conv-c' }), { agentId: 'writer-abc123', agent: 'writer', runId: 'run-c', status: 'running', startedAt: 4, parentId: 'main-run-c' },
    stat('run-d', { startedAt: 5 })
  ]);
  assert.deepEqual(runs.map((run) => run.runId), ['run-c', 'run-b', 'run-a'], 'a plain chat run with no team and no agents is not a team to watch');
  assert.equal(live.pickRun(runs, 'run-b', 'conv-a')?.runId, 'run-b');
  assert.equal(live.pickRun(runs, undefined, 'conv-a')?.runId, 'run-a');
  assert.equal(live.pickRun(runs, 'run-gone', undefined)?.runId, 'run-c');
  assert.equal(live.pickRun(runs.filter((run) => !run.running), undefined, undefined)?.runId, 'run-b');
  assert.equal(live.pickRun([], undefined, undefined), undefined);
});

test('the panel: the picture at once with no catch-up, hand-offs as they happen, discrete changes quickly and the rest at most twice a second', async () => {
  const h = load(await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-')));
  const feed = h.feed;
  const runId = 'run-1700000000000-aaa111';
  const main = `main-${runId}`;
  feed.setRunTeam(runId, TEAM);
  feed.agentStarted({ agentId: main, agent: 'team:research', runId, model: 'm', team: 'research', conversationId: 'conv-live-1' }, `PROMPT ${KEY}`, 'SYSTEM PROMPT');
  feed.agentStarted({ agentId: 'researcher-aaa111', agent: 'researcher', runId, model: 'm', parentId: main, task: 'Find sources', member: true }, 'RESEARCH PROMPT', 'MEMBER SYSTEM');
  h.open();
  await h.send({ type: 'ready' });
  const first = await until(h.posted, 0, () => true);
  assert.equal(first.runId, runId);
  assert.deepEqual(first.events, [], 'opening mid-run draws the current state with no catch-up animation');
  assert.deepEqual(first.view.nodes.map((node: Message) => [node.id, node.state]), [['lead', 'working'], ['m:researcher', 'working'], ['m:writer', 'bench']]);
  // A discrete change goes out quickly.
  const before = h.posted.length;
  const sent = Date.now();
  feed.agentQueued({ agentId: 'writer-bbb111', agent: 'writer', runId, model: 'm', parentId: main, task: 'Draft the brief', member: true });
  feed.agentStarted({ agentId: 'writer-bbb111', agent: 'writer', runId, model: 'm', parentId: main, task: 'Draft the brief', member: true }, 'WRITER PROMPT');
  const handOff = await until(h.posted, before, (message) => message.events.some((event: Message) => event.kind === 'delegate'));
  assert.ok(Date.now() - sent < 400, `a hand-off is sent at once (${Date.now() - sent} ms)`);
  assert.deepEqual(handOff.events.filter((event: Message) => event.kind === 'delegate'), [{ kind: 'delegate', from: 'lead', to: 'm:writer', agentId: 'writer-bbb111', task: 'Draft the brief' }]);
  // Activity alone is batched: many tool calls, few frames.
  const busy = h.posted.length;
  for (let index = 0; index < 40; index += 1) { feed.toolStarted('writer-bbb111', `c${index}`, `Bash cat secret-${index}.txt`, `{"command":"TOOL-INPUT-${index}"}`, 'Bash'); feed.toolEnded('writer-bbb111', `c${index}`, true, `TOOL-OUTPUT-${index}`); feed.stream('writer-bbb111', 'text', `REPLY ${index} `); }
  await wait(1_100);
  const batched = frames(h.posted, busy).length;
  assert.ok(batched >= 1 && batched <= 4, `${batched} frames for 40 tool calls in about a second`);
  // Nothing the page gets carries a prompt, a system prompt, reply text or a tool's input or output.
  const everything = JSON.stringify(h.posted);
  for (const banned of ['PROMPT', 'SYSTEM', 'TOOL-INPUT', 'TOOL-OUTPUT', 'REPLY', KEY, 'secret-']) assert.doesNotMatch(everything, new RegExp(banned), banned);
  // An open card gets the end of that agent's reply, with secrets removed, and only while it is open.
  feed.stream('writer-bbb111', 'text', `The key is ${KEY}. Brief drafted.`);
  const opened = h.posted.length;
  await h.send({ type: 'open-card', agentId: 'writer-bbb111' });
  const withExcerpt = await until(h.posted, opened, (message) => message.excerpt?.agentId === 'writer-bbb111');
  assert.match(withExcerpt.excerpt.text, /Brief drafted\.$/);
  assert.doesNotMatch(withExcerpt.excerpt.text, new RegExp(KEY));
  assert.ok(withExcerpt.excerpt.text.length <= 280);
  await h.send({ type: 'open-card' });
  const closed = h.posted.length;
  feed.agentEnded('writer-bbb111', 'completed');
  const report = await until(h.posted, closed, (message) => message.events.some((event: Message) => event.kind === 'report'));
  assert.equal(report.excerpt, undefined, 'no reply text once the card is closed');
  assert.deepEqual(report.events.find((event: Message) => event.kind === 'report'), { kind: 'report', from: 'm:writer', to: 'lead', agentId: 'writer-bbb111', ok: true });
  // Controls go through the chat, as Agent Activity's do; Show in Agent Activity opens it on that agent.
  await h.send({ type: 'open-activity', agentId: 'researcher-aaa111' });
  assert.deepEqual(h.commands.at(-1), ['nearAi.openAgentActivity', 'researcher-aaa111']);
  // Hidden: nothing is sent.
  h.hide();
  const hidden = h.posted.length;
  feed.agentEnded('researcher-aaa111', 'completed');
  await wait(700);
  assert.equal(frames(h.posted, hidden).length, 0, 'nothing while hidden');
  // Shown again: the page says ready and gets the current picture, again without catch-up.
  h.panel.visible = true;
  await h.send({ type: 'ready' });
  const again = await until(h.posted, hidden, () => true);
  assert.deepEqual(again.events, []);
  assert.equal(again.view.nodes.find((node: Message) => node.id === 'm:researcher').state, 'done');
  // Review of PR 72: hidden again, then shown by a page VS Code kept alive, which sends no "ready": the host restarts the feed itself.
  h.hide();
  const kept = h.posted.length;
  h.show();
  const resumed = await until(h.posted, kept, () => true);
  assert.deepEqual(resumed.events, [], 'the current picture, without catch-up');
  feed.agentEnded(main, 'completed');
  h.close();
});

test('after a reload, the newest run with agents is drawn from the history as it ended; an agent that never ended is interrupted, never working', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-'));
  const store = new ActivityStore(root);
  const runId = 'run-1700000000000-ccc333';
  const session = await store.start({ project: 'demo', model: 'm', runId, conversationId: 'conv-history-1', title: '/team:research find sources' });
  await store.append(session.sessionId, { status: 'running', kind: 'agent', agentId: 'researcher-ccc111', parentAgentId: `main-${runId}`, agentRole: 'researcher', action: `Find sources with ${KEY}`, model: 'm', summary: 'Sub-agent researcher started.' });
  await store.append(session.sessionId, { status: 'completed', kind: 'agent', agentId: 'researcher-ccc111', parentAgentId: `main-${runId}`, agentRole: 'researcher', action: `Find sources with ${KEY}`, model: 'm', summary: 'Sub-agent researcher completed.' });
  await store.append(session.sessionId, { status: 'running', kind: 'agent', agentId: 'helper-ddd111', parentAgentId: 'researcher-ccc111', agentRole: 'gsd-verifier', action: 'Check a quote', model: 'm', summary: 'Sub-agent gsd-verifier started.' });
  await store.closeInterrupted();
  await store.flush();
  const saved = (await new ActivityStore(root).get(session.sessionId))!;
  const h = load(root);
  const stats = h.live.statsFromHistory(saved);
  assert.deepEqual(stats.map((stat) => [stat.agentId, stat.status, Boolean(stat.interrupted), stat.parentId ?? '']), [
    [`main-${runId}`, 'cancelled', true, ''], ['researcher-ccc111', 'completed', false, `main-${runId}`], ['helper-ddd111', 'running', true, 'researcher-ccc111']
  ]);
  assert.doesNotMatch(JSON.stringify(stats), new RegExp(KEY), 'the task label is redacted again when read back');
  // Review of PR 72: the run's title comes from the person's own message; it reaches the page only as a short redacted label.
  const leaky = h.live.statsFromHistory({ ...saved, title: `deploy it with ${KEY} ${'and more '.repeat(30)}` });
  assert.doesNotMatch(leaky[0].agent, new RegExp(KEY));
  assert.ok(leaky[0].agent.length <= 80, leaky[0].agent);
  assert.equal(h.live.pageTitle(undefined, 'Last run'), 'Last run');
  assert.equal(h.live.pageTitle(`<b>${KEY}</b>`, 'Run').includes(KEY), false);
  const { message } = h.live.teamLiveMessage({ stats, runs: [{ runId, title: 'Last run', running: false, startedAt: 0 }], runId, team: TEAM, restored: true });
  const view = message.view as { nodes: Array<{ id: string; state: string }>; state: string };
  assert.deepEqual(view.nodes.map((node) => [node.id, node.state]), [['lead', 'interrupted'], ['m:researcher', 'done'], ['m:writer', 'bench'], ['g:m:researcher>gsd-verifier', 'interrupted']]);
  assert.equal(message.restored, true);
});

test('the page: only the status region speaks; the card, rebuilt with every frame, is never a live region (review of PR 72)', async () => {
  const { live } = load(await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-')));
  const html = live.teamLiveHtml({ asWebviewUri: (value: unknown) => value, cspSource: 'csp' } as never, { fsPath: '/media', path: '/media', toString: () => '/media' } as never);
  const regions = html.match(/<[^>]*aria-live[^>]*>/g) ?? [];
  assert.equal(regions.length, 1, regions.join('\n'));
  assert.match(regions[0], /id="announce"/);
  assert.match(html, /<section id="card"(?![^>]*aria-live)[^>]*>/);
});

test('sends run one at a time, so an older picture never lands after a newer one; a panel closed mid-send gets nothing more', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-live-view-serial-'));
  const store = new ActivityStore(root);
  const runId = 'run-1700000000000-eee555';
  const session = await store.start({ project: 'demo', model: 'm', runId, title: '/team:research find sources' });
  await store.append(session.sessionId, { status: 'completed', kind: 'agent', agentId: 'researcher-eee111', parentAgentId: `main-${runId}`, agentRole: 'researcher', action: 'Find sources', model: 'm', summary: 'Sub-agent researcher completed.' });
  await store.flush();
  const h = load(root);
  // Each send reads the history (the feed is empty after a reload); count how many reads overlap.
  const list = ActivityStore.prototype.list;
  let inFlight = 0;
  let most = 0;
  ActivityStore.prototype.list = async function (this: ActivityStore) {
    inFlight += 1; most = Math.max(most, inFlight);
    try { await wait(30); return await list.call(this); } finally { inFlight -= 1; }
  };
  try {
    h.open();
    await h.send({ type: 'ready' });
    await h.send({ type: 'open-card', agentId: 'researcher-eee111' });
    await h.send({ type: 'select-run', runId });
    await until(h.posted, 0, (message) => message.runId === runId);
    await wait(150);
    assert.equal(most, 1, 'never two sends at once');
    // Closed while a send reads the history: nothing is posted after the close, and nothing keeps running.
    const before = frames(h.posted).length;
    await h.send({ type: 'open-card' });
    h.close();
    await wait(150);
    assert.equal(frames(h.posted).length, before, 'no frame after the panel closed');
  } finally {
    ActivityStore.prototype.list = list;
  }
});
