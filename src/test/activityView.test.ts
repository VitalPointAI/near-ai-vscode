import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { countersOf } from '../services/activityOverview';
import { ActivityStore } from '../services/activityStore';
import type { ActivityFeed } from '../services/agentActivity';

// The Agent Activity page's host controller, driven as VS Code drives it: a stand-in panel, the
// real shared feed the chat writes to, and the project's activity history on disk written by a
// separate store, as the chat's is. Runs here take milliseconds, like the e2e fake model's.

type Message = Record<string, unknown>;
type Handler = (value: unknown) => unknown;

interface Harness {
  feed: ActivityFeed;
  posted: Message[];
  page: { ready(): Promise<void>; hide(): void; show(): void };
  open(): void;
}

function harness(root: string): Harness {
  const posted: Message[] = [];
  const handlers: { message?: Handler; viewState?: Handler } = {};
  const uri = (value: string) => ({ path: value, fsPath: value, toString: () => value });
  const panel = {
    visible: true,
    iconPath: undefined as unknown,
    webview: {
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (value: unknown) => value,
      postMessage: async (message: Message) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: Handler) => { handlers.message = handler; return { dispose: () => undefined }; }
    },
    onDidChangeViewState: (handler: Handler) => { handlers.viewState = handler; return { dispose: () => undefined }; },
    onDidDispose: () => ({ dispose: () => undefined }),
    reveal: () => undefined
  };
  const vscode = {
    Uri: { joinPath: (base: { path: string }, ...parts: string[]) => uri([base.path, ...parts].join('/')) },
    ViewColumn: { Active: -1 },
    window: { createWebviewPanel: () => panel },
    workspace: { workspaceFolders: [{ uri: uri(root) }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
    commands: { executeCommand: async () => undefined, registerCommand: () => ({ dispose: () => undefined }) }
  };
  const nodeModule = require('node:module') as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const originalLoad = nodeModule._load;
  nodeModule._load = (request, parent, isMain) => request === 'vscode' ? vscode : originalLoad(request, parent, isMain);
  let view: typeof import('../services/activityView');
  try { view = require('../services/activityView') as typeof import('../services/activityView'); } finally { nodeModule._load = originalLoad; }
  const context = { extensionUri: uri('/extension'), subscriptions: [] as unknown[] };
  return {
    feed: view.sharedActivityFeed(),
    posted,
    open: () => view.openAgentActivity(context as never),
    page: {
      // The page script says "ready" each time its webview loads (when opened, and when shown again).
      ready: async () => { await handlers.message?.({ type: 'ready' }); },
      hide: () => { panel.visible = false; handlers.viewState?.({ webviewPanel: panel }); },
      show: () => { panel.visible = true; handlers.viewState?.({ webviewPanel: panel }); }
    }
  };
}

const overviews = (posted: Message[], from = 0) => posted.slice(from).filter((message) => message.type === 'overview');
const titles = (message: Message) => (message.history as { rows: Array<{ title: string }> }).rows.map((row) => row.title);
const runs = (message: Message) => (message.summary as { runs: number }).runs;

async function until(posted: Message[], predicate: (message: Message) => boolean, from: number, timeoutMs: number): Promise<Message> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = overviews(posted, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No such overview within ${timeoutMs} ms. Sent: ${overviews(posted, from).map((message) => JSON.stringify({ runs: runs(message), history: titles(message) })).join(' | ') || 'nothing'}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A run as the chat records it: its session first, then the feed; `end` saves its counters. */
async function startRun(feed: ActivityFeed, store: ActivityStore, id: string, title: string, conversationId: string): Promise<{ end(): Promise<void> }> {
  const runId = `run-${id}`;
  const agentId = `main-${runId}`;
  const session = await store.start({ project: 'demo', model: 'fake-coder', runId, conversationId, title, summary: 'Agent conversation turn started.' });
  feed.agentStarted({ agentId, agent: 'agent', runId, model: 'fake-coder', conversationId }, title);
  return {
    end: async () => {
      feed.stream(agentId, 'text', 'Hi from the fake model.');
      feed.turn(agentId, { verificationStatus: 'unknown', latencyMs: 2, inputTokens: 5, outputTokens: 3 });
      feed.agentEnded(agentId, 'completed');
      assert.ok(await store.addStats(session.sessionId, countersOf(feed.agentStat(agentId)!), { outcome: 'completed' }));
      feed.markPersisted(agentId);
    }
  };
}

const quickRun = async (feed: ActivityFeed, store: ActivityStore, id: string, title: string, conversationId: string) => (await startRun(feed, store, id, title, conversationId)).end();
const running = (message: Message) => (message.running as Array<{ agentId: string }>).map((row) => row.agentId);

test('a run that ends while Agent Activity is visible shows in its overview and history, and the figures never drop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-activity-view-'));
  const { feed, posted, open, page } = harness(root);
  const chatStore = new ActivityStore(root);
  const conversationId = 'conv-activity-view-1';
  await quickRun(feed, chatStore, 'first-aaaaaa', 'Say hi', conversationId);

  open();
  await page.ready();
  const first = await until(posted, () => true, 0, 2_000);
  assert.deepEqual(titles(first), ['Say hi']);
  assert.equal(runs(first), 1);

  // The e2e case: a run that starts and ends within the history's 3 s reload interval, with no
  // change after it. It used to send nothing at all.
  let from = posted.length;
  await quickRun(feed, chatStore, 'second-bbbbbb', 'Say hi again', conversationId);
  const after = await until(posted, (message) => titles(message).includes('Say hi again'), from, 2_500);
  assert.deepEqual(titles(after), ['Say hi again', 'Say hi']);
  assert.equal(runs(after), 2, 'the ended run counts once, from its saved counters');

  // A run seen live, that ends within the interval: its counters move from the live figures to
  // the history in one update. They used to drop out until the history was read again.
  from = posted.length;
  const third = await startRun(feed, chatStore, 'third-cccccc', 'Third', conversationId);
  const live = await until(posted, (message) => running(message).length === 1, from, 2_500);
  assert.equal(runs(live), 3, 'the running run counts live');
  await third.end();
  const ended = await until(posted, (message) => !running(message).length && titles(message).includes('Third'), from, 2_500);
  assert.equal(runs(ended), 3);
  const seen = overviews(posted).map(runs);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), `the run count never goes down: ${seen.join(', ')}`);

  // A run that has started and shows nothing else for a while is in History once the interval is up.
  from = posted.length;
  await startRun(feed, chatStore, 'fourth-dddddd', 'Fourth', conversationId);
  const quiet = await until(posted, (message) => titles(message).includes('Fourth'), from, 4_500);
  assert.deepEqual(running(quiet), ['main-run-fourth-dddddd']);
  feed.agentEnded('main-run-fourth-dddddd', 'completed');

  // Hidden: nothing is sent; shown again (the webview reloads and says "ready"), it catches up.
  page.hide();
  const hidden = posted.length;
  await quickRun(feed, chatStore, 'hidden-eeeeee', 'Say hi while hidden', conversationId);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(posted.length, hidden, 'no messages while the page is hidden');
  page.show();
  await page.ready();
  const again = await until(posted, (message) => titles(message).includes('Say hi while hidden'), hidden, 2_000);
  assert.equal(titles(again)[0], 'Say hi while hidden');
  page.hide();
});
