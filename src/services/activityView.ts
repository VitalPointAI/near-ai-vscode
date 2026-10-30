import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ActivitySessionSummary } from '../domain/activity';
import { buildWindowSummary, historyPage, nowRows, OverviewSpend, OverviewWindow } from './activityOverview';
import { ActivityStore } from './activityStore';
import { ActivityEntry, ActivityFeed, AgentStats, timeBreakdown } from './agentActivity';
import type { ChatWebviewMessage } from './chatBridge';
import { readActivityLimits } from './settings';
import { SpendAccount, shownSpendAccount } from './spendAccount';
import type { SpendInsight } from './spendInsight';
import { DayBoundary, nanoToUsd, totalNanoUsd } from './spendLedger';
import { currentReportingTokenHint, onReportingTokenChange, openConsoleBilling, readDayBoundary, reportingTokenState, runReportingTokenHint, testReportingToken } from './spendTracking';
import { hintForView, ReportingTokenHint, SET_REPORTING_TOKEN_COMMAND } from './reportingToken';

// The Agent Activity page: an overview of agent activity, not a log (the chat shows the work
// itself). Now: the agents running, what each is doing, and controls. A window (this
// conversation, today, the last 7 days): runs, where the time went, tokens, cost, tool calls,
// approvals, and problems by model. History: past runs, one line each, that open in the chat.
// Figures come from the project's activity history and the key's spend ledger, plus the live
// feed for agents still running. It updates at most once a second, only while visible; the raw
// entries stay in memory for "Export details" only.

const UPDATE_MS = 1_000;
const RELOAD_MS = 3_000;

let feed: ActivityFeed | undefined;
let panel: vscode.WebviewPanel | undefined;

/** Set by the extension-host tests to observe the page's messages in both directions. */
export const activityTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

/** The chat the page's controls act through (the sidebar). */
export interface ActivityChat { request(payload: ChatWebviewMessage): Promise<void> }

let focusAgent: string | undefined;
let chat: ActivityChat | undefined;

/** The one feed every conversation writes to. */
export function sharedActivityFeed(): ActivityFeed {
  feed ??= new ActivityFeed(readActivityLimits());
  return feed;
}

export function registerAgentActivity(context: vscode.ExtensionContext, sidebar?: ActivityChat): void {
  chat = sidebar;
  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.openAgentActivity', (agentId?: unknown) => openAgentActivity(context, typeof agentId === 'string' ? agentId : undefined)),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi.activity')) sharedActivityFeed().setLimits(readActivityLimits()); })
  );
}

/** What the page may ask for; anything else is ignored. */
export type ActivityViewMessage =
  | { type: 'ready' }
  | { type: 'set-window'; window: OverviewWindow }
  | { type: 'history-page'; page: number }
  | { type: 'agent-control'; agentId: string; action: 'pause' | 'resume' | 'stop' }
  | { type: 'show-in-chat' }
  | { type: 'open-conversation'; conversationId: string }
  | { type: 'export'; format: 'markdown' | 'json' }
  | { type: 'export-usage' }
  /** The cost header's token link; the host decides what it runs. */
  | { type: 'reporting-token' }
  /** Spend: check the stored token against NEAR now. */
  | { type: 'test-token' }
  /** Spend: the token is failing; open the setting that links to Set and Clear. */
  | { type: 'fix-token' }
  /** Spend: open the NEAR AI Cloud console to top up or see the remaining credits. */
  | { type: 'open-console' };

const AGENT_ID = /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i;
const WINDOWS: OverviewWindow[] = ['conversation', 'today', 'week'];

export function parseActivityViewMessage(value: unknown): ActivityViewMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === 'ready' || message.type === 'show-in-chat' || message.type === 'export-usage' || message.type === 'reporting-token' || message.type === 'test-token' || message.type === 'fix-token' || message.type === 'open-console') return { type: message.type };
  if (message.type === 'set-window' && WINDOWS.includes(message.window as OverviewWindow)) return { type: 'set-window', window: message.window as OverviewWindow };
  if (message.type === 'history-page' && Number.isInteger(message.page) && (message.page as number) >= 0 && (message.page as number) < 10_000) return { type: 'history-page', page: message.page as number };
  if (message.type === 'agent-control' && typeof message.agentId === 'string' && AGENT_ID.test(message.agentId) && (message.action === 'pause' || message.action === 'resume' || message.action === 'stop')) return { type: 'agent-control', agentId: message.agentId, action: message.action };
  if (message.type === 'open-conversation' && typeof message.conversationId === 'string' && /^conv-[a-z0-9-]{6,60}$/.test(message.conversationId)) return { type: 'open-conversation', conversationId: message.conversationId };
  if (message.type === 'export') return { type: 'export', format: message.format === 'json' ? 'json' : 'markdown' };
  return undefined;
}

/** Everything the page shows, in one message. */
export function overviewMessage(input: { feed: ActivityFeed; sessions: ActivitySessionSummary[]; spend?: OverviewSpend; window: OverviewWindow; page: number; now?: number; boundary?: DayBoundary; hasProject?: boolean; token?: ReportingTokenHint; insight?: SpendInsight }): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const boundary = input.boundary ?? 'local';
  const live = input.feed.agentStats();
  const conversationId = input.feed.currentConversation;
  return {
    type: 'overview',
    now,
    boundary,
    hasProject: input.hasProject !== false,
    // With a NEAR AI Cloud key's ledger, the cost header links to the usage reporting token.
    ...(input.spend && input.token ? { token: hintForView(input.token) } : {}),
    // Where the costs come from, totals by period, burn rate, credits, and top up (a NEAR AI Cloud key only).
    ...(input.spend && input.insight ? { insight: input.insight } : {}),
    running: nowRows(live, input.spend),
    summary: buildWindowSummary({ sessions: input.sessions, live, spend: input.spend, window: input.window, now, boundary, conversationId }),
    history: historyPage(input.sessions, input.page, input.spend, now)
  };
}

/** Where the page scrolls for an agent the chat named: its row in Now, or its run in History once it ended. */
export function focusMessage(activity: ActivityFeed, agentId: string): Record<string, unknown> {
  const stat = activity.agentStat(agentId);
  const runId = stat?.runId ?? (/^main-(run-.+)$/.exec(agentId)?.[1]);
  return { type: 'focus-agent', agentId, ...(runId ? { runId } : {}), running: stat?.status === 'running' };
}

/** Opens the page; with an agent ID, that agent's row is highlighted and scrolled to. */
export function openAgentActivity(context: vscode.ExtensionContext, agentId?: string): void {
  focusAgent = agentId;
  const activity = sharedActivityFeed();
  if (panel) { panel.reveal(); if (agentId) void panel.webview.postMessage(focusMessage(activity, agentId)); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity');
  const view = vscode.window.createWebviewPanel('nearAiAgentActivity', 'Agent Activity', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  view.webview.html = activityHtml(view.webview, media);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const store = root ? new ActivityStore(root) : undefined;
  let sessions: ActivitySessionSummary[] = [];
  let loadedAt = 0;
  let window: OverviewWindow = 'today';
  let page = 0;
  let subscription: { dispose(): void } | undefined;
  let spendWatch: { dispose(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A read of the history the interval put off, made when it is up if nothing else made it first.
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadDue = false;
  // The agents whose saved counters the loaded history includes.
  let readSaved = '';
  let lastSent = 0;
  let lastJson = '';
  const post = (message: Record<string, unknown>) => { activityTap.toView?.(message); void view.webview.postMessage(message); };
  const savedAgents = () => activity.agentStats().filter((stat) => stat.persisted).map((stat) => stat.agentId).join(',');
  const send = async (reload = false) => {
    timer = undefined;
    if (store) {
      const saved = savedAgents();
      // The history is read at most every RELOAD_MS, and also as soon as an agent's counters are
      // saved to it: they leave the live figures then, so a stale history would drop them (and a
      // run that ended within the interval would not show at all).
      if (reload || reloadDue || saved !== readSaved || Date.now() - loadedAt >= RELOAD_MS) {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = undefined;
        reloadDue = false;
        await store.reload().catch(() => undefined);
        sessions = await store.list().catch(() => sessions);
        loadedAt = Date.now();
        readSaved = saved;
      } else if (subscription) {
        // Put off: read it when the interval is up even if no other change comes (a run's history
        // row, its cost), through the same once-a-second update.
        reloadTimer ??= setTimeout(() => { reloadTimer = undefined; reloadDue = true; schedule(); }, Math.max(0, RELOAD_MS - (Date.now() - loadedAt)));
      }
    }
    if (!subscription) return;
    const account = shownSpendAccount();
    const insight = account ? await spendInsightFor(account, reload) : undefined;
    const message = overviewMessage({ feed: activity, sessions, spend: account, window, page, boundary: readDayBoundary(), hasProject: Boolean(store), token: await currentReportingTokenHint(), insight });
    // Nothing changed: no message, so the page does not redraw.
    const json = JSON.stringify({ ...message, now: 0 });
    if (json === lastJson && !reload) return;
    lastJson = json;
    lastSent = Date.now();
    post(message);
  };
  // At most one update a second, however busy the agents are.
  const schedule = () => { timer ??= setTimeout(() => void send(), Math.max(0, UPDATE_MS - (Date.now() - lastSent))); };
  let tokenWatch: { dispose(): void } | undefined;
  const start = () => {
    if (subscription) return;
    subscription = activity.subscribe(schedule);
    spendWatch = shownSpendAccount()?.onChange(schedule);
    tokenWatch = onReportingTokenChange(schedule);
    void send(true).then(() => {
      if (focusAgent) { post(focusMessage(activity, focusAgent)); focusAgent = undefined; }
    });
  };
  const stop = () => {
    subscription?.dispose();
    spendWatch?.dispose();
    tokenWatch?.dispose();
    subscription = undefined;
    spendWatch = undefined;
    tokenWatch = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
    lastJson = '';
  };
  view.onDidChangeViewState((event) => { if (!event.webviewPanel.visible) stop(); }, undefined, context.subscriptions);
  view.webview.onDidReceiveMessage(async (raw: unknown) => {
    activityTap.fromView?.(raw);
    const message = parseActivityViewMessage(raw);
    if (!message) return;
    if (message.type === 'ready') { stop(); if (view.visible) start(); }
    else if (message.type === 'set-window') { window = message.window; await send(true); }
    else if (message.type === 'history-page') { page = message.page; await send(true); }
    else if (message.type === 'agent-control') {
      // The main agent has no pause; stopping it stops the run, as the chat's Stop does.
      // It stops that run's own conversation, which need not be the one on screen.
      if (message.agentId.startsWith('main-')) { if (message.action === 'stop') { const conversationId = activity.agentStat(message.agentId)?.conversationId; await chat?.request({ type: 'stop', ...(conversationId ? { conversationId } : {}) }); } }
      else await chat?.request({ type: 'agent-control', agentId: message.agentId, action: message.action });
      schedule();
    }
    else if (message.type === 'show-in-chat') await vscode.commands.executeCommand('nearAi.openChat');
    else if (message.type === 'open-conversation') await chat?.request({ type: 'resume-conversation', id: message.conversationId });
    else if (message.type === 'export') await exportActivity(activity, message.format);
    else if (message.type === 'export-usage') await vscode.commands.executeCommand('nearAi.exportAnalytics');
    else if (message.type === 'reporting-token') await runReportingTokenHint();
    else if (message.type === 'fix-token') await vscode.commands.executeCommand(SET_REPORTING_TOKEN_COMMAND);
    else if (message.type === 'open-console') await openConsoleBilling();
    else if (message.type === 'test-token') {
      post({ type: 'token-test', running: true, text: 'Asking NEAR\'s usage summary…' });
      const result = await testReportingToken(shownSpendAccount());
      post({ type: 'token-test', running: false, ok: result.ok, text: result.text });
      await send(true);
    }
  }, undefined, context.subscriptions);
  view.onDidDispose(() => { stop(); panel = undefined; }, undefined, context.subscriptions);
}

/** The spend section's figures; the ledgers are read again at most every few seconds (or at once on `fresh`). */
const INSIGHT_MS = 5_000;
let insightCache: { account: SpendAccount; at: number; insight: SpendInsight; state: string } | undefined;
async function spendInsightFor(account: SpendAccount, fresh: boolean): Promise<SpendInsight | undefined> {
  const state = await reportingTokenState() ?? 'missing';
  if (!fresh && insightCache && insightCache.account === account && insightCache.state === state && Date.now() - insightCache.at < INSIGHT_MS) return insightCache.insight;
  try {
    const insight = await account.insight(state);
    insightCache = { account, at: Date.now(), insight, state };
    return insight;
  } catch {
    return insightCache?.account === account ? insightCache.insight : undefined;
  }
}

/**
 * The page's statistics. Costs come from the key's spend ledger: each agent's requests (its
 * model turns, safety checks, and summaries), and today's total, labelled by how sure it is.
 */
export function activityStatus(activity: ActivityFeed, account = shownSpendAccount()): { stats: AgentStats[]; usage: ActivityFeed['usage']; spend?: { text: string; tooltip: string; source: string } } {
  const stats = activity.agentStats();
  if (!account) return { stats, usage: activity.usage };
  for (const stat of stats) {
    const totals = account.totals({ agentId: stat.agentId });
    if (totals.requests) stat.costUsd = nanoToUsd(totalNanoUsd(totals));
  }
  const today = account.today();
  return { stats, usage: activity.usage, spend: { text: today.text, tooltip: today.tooltip, source: today.source } };
}

async function exportActivity(activity: ActivityFeed, format: 'markdown' | 'json'): Promise<void> {
  const subscription = activity.subscribe(() => undefined);
  subscription.dispose();
  const entries = subscription.snapshot;
  const stats = activityStatus(activity).stats;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`agent-activity-${stamp}.${format === 'json' ? 'json' : 'md'}`), filters: format === 'json' ? { JSON: ['json'] } : { Markdown: ['md'] }, title: 'Export agent activity' });
  if (!target) return;
  await writeFile(target.fsPath, format === 'json' ? JSON.stringify({ exportedAt: new Date().toISOString(), stats, entries }, null, 2) : activityMarkdown(entries, stats), 'utf8');
  void vscode.window.showInformationMessage(`Exported ${entries.length} activity entries to ${target.fsPath}.`);
}

export function activityMarkdown(entries: ActivityEntry[], stats: AgentStats[]): string {
  const time = (at: number) => new Date(at).toISOString().slice(11, 19);
  const fence = (text: string) => `\`\`\`\`\n${text}\n\`\`\`\``;
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
  const lines = ['# Agent activity', '', '| Agent | Model | Status | Turns | Tokens in | Tokens out | Reasoning | Tok/s | Waiting | Generating | Tools and other | Est. cost | Tool calls (errors) | Retries | Injections flagged | Hidden removed | Held | Blocked |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const stat of stats) {
    const time = timeBreakdown(stat);
    lines.push(`| ${stat.agent} | ${stat.model} | ${stat.status} | ${stat.turns} | ${stat.inputTokens} | ${stat.outputTokens} | ${time.reasoningShare === undefined ? '–' : `${Math.round(100 * time.reasoningShare)}%${stat.reasoningEstimated ? ' (est.)' : ''}`} | ${time.tokensPerSecond?.toFixed(1) ?? '–'} | ${seconds(time.waitMs)} | ${seconds(time.generateMs)} | ${seconds(time.otherMs)} | $${stat.costUsd.toFixed(4)} | ${stat.toolCalls} (${stat.toolErrors}) | ${stat.retries} | ${stat.injections} | ${stat.hiddenRemoved} | ${stat.held} | ${stat.blocked} |`);
  }
  lines.push('');
  for (const entry of entries) {
    lines.push(`### ${time(entry.at)} · ${entry.agent} · ${entry.kind}${entry.title ? ` · ${entry.title}` : ''}${entry.ok === false ? ' (failed)' : ''}`, '');
    if (entry.input) lines.push(fence(entry.input), '');
    if (entry.text) lines.push(fence(entry.text), '');
  }
  return `${lines.join('\n')}\n`;
}

export function activityHtml(webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('activity.css')}"><title>Agent Activity</title></head><body>
<header class="top">
  <h1>Agent activity</h1>
  <div class="actions">
    <button id="export-usage" type="button" class="secondary" title="Usage and activity per run and per model, as CSV or JSON, with no prompt content">Export usage and activity</button>
    <button id="export-details" type="button" class="secondary" aria-haspopup="true" aria-expanded="false" title="Everything kept in memory for this window (prompts, replies, tool calls), for debugging">Export details</button>
    <div id="export-menu" class="menu" role="menu" hidden>
      <button type="button" role="menuitem" data-format="markdown">Markdown</button>
      <button type="button" role="menuitem" data-format="json">JSON</button>
    </div>
  </div>
</header>
<main>
<section aria-labelledby="now-heading">
  <h2 id="now-heading">Now</h2>
  <p id="now-empty" class="hint">No agents are running. Send a message or run a workflow in the NEAR AI chat.</p>
  <div class="table-wrap" id="now-wrap" hidden><table id="now" aria-labelledby="now-heading"><thead><tr>
    <th scope="col">Agent</th><th scope="col">Model</th><th scope="col">State</th><th scope="col" class="num">Elapsed</th><th scope="col" class="num">Turns</th><th scope="col" class="num">Tool calls</th><th scope="col" class="num">Cost so far</th><th scope="col"><span class="sr-only">Controls</span></th>
  </tr></thead><tbody></tbody></table></div>
  <p id="focus-note" class="hint" role="status" hidden></p>
</section>
<section id="spend-section" aria-labelledby="spend-heading" hidden>
  <div class="section-head">
    <h2 id="spend-heading">Spend</h2>
    <div class="actions">
      <button id="test-token" type="button" class="secondary" title="Ask NEAR AI Cloud's usage summary with the stored usage reporting token now, and say whether it works" hidden>Test token now</button>
      <button id="top-up" type="button" class="secondary">Top up credits</button>
    </div>
  </div>
  <p class="source-line"><span class="source-key">Cost source:</span> <strong id="source-label" class="source-badge"></strong> <span id="source-detail" class="hint-inline"></span></p>
  <p id="token-status" class="hint"></p>
  <div id="token-problem" class="problem" role="alert" hidden><span id="token-problem-text"></span> <button id="fix-token" type="button" class="link" title="Sign in to NEAR AI Cloud to make a new usage reporting token, or paste one">Fix token</button></div>
  <p id="token-test" class="hint" role="status" aria-live="polite" hidden></p>
  <h3 id="periods-heading">Spent</h3>
  <dl id="periods" class="totals periods" aria-labelledby="periods-heading"></dl>
  <h3 id="credits-heading">Credits</h3>
  <dl id="credits" class="pairs credits" aria-labelledby="credits-heading"></dl>
  <p id="credits-note" class="hint" hidden>NEAR's API does not give an API key or a usage reporting token the remaining credits, so the time until they run out is not shown. <button id="open-console" type="button" class="link" title="Opens the NEAR AI Cloud console in your browser; you may need to sign in">See them in the NEAR AI Cloud console</button></p>
</section>
<section aria-labelledby="summary-heading">
  <div class="section-head">
    <h2 id="summary-heading">Overview</h2>
    <div class="segmented" role="radiogroup" aria-label="Period">
      <button type="button" role="radio" data-window="conversation" aria-checked="false">This conversation</button>
      <button type="button" role="radio" data-window="today" aria-checked="true">Today</button>
      <button type="button" role="radio" data-window="week" aria-checked="false">Last 7 days</button>
    </div>
  </div>
  <p id="token-line" class="hint" hidden><button id="reporting-token" type="button" class="link"></button></p>
  <p id="summary-empty" class="hint" hidden></p>
  <div id="summary">
    <dl id="totals" class="totals"></dl>
    <h3 id="time-heading">Where the time went</h3>
    <div id="time-bar" class="bar" role="img" aria-labelledby="time-heading"></div>
    <ul id="time-legend" class="legend"></ul>
    <div class="columns">
      <div>
        <h3 id="tools-heading">Tool calls</h3>
        <p id="tools-empty" class="hint" hidden>No tool calls.</p>
        <div class="table-wrap"><table id="tools" aria-labelledby="tools-heading"><thead><tr><th scope="col">Tool</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Failed</th></tr></thead><tbody></tbody></table></div>
      </div>
      <div>
        <h3 id="approvals-heading">Approvals</h3>
        <dl id="approvals" class="pairs" aria-labelledby="approvals-heading"></dl>
      </div>
    </div>
    <h3 id="problems-heading">Problems by model</h3>
    <p id="problems-summary" class="hint"></p>
    <div class="table-wrap"><table id="models" aria-labelledby="problems-heading"><thead><tr>
      <th scope="col">Model</th><th scope="col" class="num">Agents</th><th scope="col" class="num">Turns</th><th scope="col" class="num" title="NEAR answered 429: too many requests">Rate limited (429)</th><th scope="col" class="num">Retries</th><th scope="col" class="num">Errors</th><th scope="col" class="num">Stopped</th><th scope="col" class="num">Tokens in</th><th scope="col" class="num">Tokens out</th>
    </tr></thead><tbody></tbody></table></div>
  </div>
</section>
<section aria-labelledby="history-heading">
  <h2 id="history-heading">History</h2>
  <p id="history-empty" class="hint" hidden>No runs recorded in this project yet.</p>
  <div class="table-wrap"><table id="history" aria-labelledby="history-heading"><thead><tr>
    <th scope="col">Started</th><th scope="col">Asked</th><th scope="col" class="num">Agents</th><th scope="col" class="num">Duration</th><th scope="col" class="num">Cost</th><th scope="col">Outcome</th>
  </tr></thead><tbody></tbody></table></div>
  <nav class="pager" aria-label="History pages"><button id="prev" type="button" class="secondary">Newer</button><span id="page" aria-live="polite"></span><button id="next" type="button" class="secondary">Older</button></nav>
</section>
<p class="hint">Figures come from this project's activity history and your API key's spend ledger on this computer, kept across reloads; nothing here includes prompt or reply content beyond each run's first line, redacted. Live agents update about once a second while this tab is visible.</p>
</main>
<script nonce="${nonce}" src="${asset('activity.js')}"></script></body></html>`;
}
