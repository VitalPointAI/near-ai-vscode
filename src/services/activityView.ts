import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ActivityEntry, ActivityFeed, AgentStats, timeBreakdown } from './agentActivity';
import { readActivityLimits } from './settings';
import { shownSpendAccount } from './spendAccount';
import { nanoToUsd, totalNanoUsd } from './spendLedger';

// The Agent Activity page: a live stream of every agent's prompts, replies, reasoning, and tool
// calls with per-agent statistics. It streams only while visible: hiding the tab drops its page
// (retainContextWhenHidden is off) and the subscription; showing it again sends a fresh snapshot.

const FLUSH_MS = 250;
const STATS_MS = 1_000;
const SNAPSHOT_ENTRIES = 1_500;

let feed: ActivityFeed | undefined;
let panel: vscode.WebviewPanel | undefined;

/** Set by the extension-host tests to observe the page's messages in both directions. */
export const activityTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

/** The one feed every conversation writes to. */
let focusAgent: string | undefined;

export function sharedActivityFeed(): ActivityFeed {
  feed ??= new ActivityFeed(readActivityLimits());
  return feed;
}

export function registerAgentActivity(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('nearAi.openAgentActivity', (agentId?: unknown) => openAgentActivity(context, typeof agentId === 'string' ? agentId : undefined)),
    vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi.activity')) sharedActivityFeed().setLimits(readActivityLimits()); })
  );
}

/** Opens the page; with an agent ID, the stream is filtered to that agent. */
export function openAgentActivity(context: vscode.ExtensionContext, agentId?: string): void {
  focusAgent = agentId;
  if (panel) { panel.reveal(); if (agentId) void panel.webview.postMessage({ type: 'focus-agent', agentId }); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'activity');
  const view = vscode.window.createWebviewPanel('nearAiAgentActivity', 'Agent Activity', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  view.webview.html = activityHtml(view.webview, media);
  const activity = sharedActivityFeed();
  let subscription: { dispose(): void } | undefined;
  let pending = new Map<number, ActivityEntry>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let statsTimer: ReturnType<typeof setInterval> | undefined;
  const post = (message: Record<string, unknown>) => { activityTap.toView?.(message); void view.webview.postMessage(message); };
  const status = () => activityStatus(activity);
  const flush = () => {
    flushTimer = undefined;
    if (!pending.size) return;
    const entries = [...pending.values()].map((entry) => ({ ...entry }));
    pending = new Map();
    post({ type: 'entries', entries, ...status() });
  };
  const start = () => {
    if (subscription) return;
    const subscribed = activity.subscribe((change) => {
      if (change.cleared) { pending = new Map(); post({ type: 'cleared', ...status() }); }
      for (const entry of change.entries) pending.set(entry.seq, entry);
      flushTimer ??= setTimeout(flush, FLUSH_MS);
    });
    subscription = subscribed;
    post({ type: 'snapshot', entries: subscribed.snapshot.slice(-SNAPSHOT_ENTRIES), ...status() });
    if (focusAgent) { post({ type: 'focus-agent', agentId: focusAgent }); focusAgent = undefined; }
    statsTimer = setInterval(() => post({ type: 'stats', ...status() }), STATS_MS);
  };
  const stop = () => {
    subscription?.dispose();
    subscription = undefined;
    if (flushTimer) clearTimeout(flushTimer);
    if (statsTimer) clearInterval(statsTimer);
    flushTimer = undefined;
    statsTimer = undefined;
    pending = new Map();
  };
  view.onDidChangeViewState((event) => { if (!event.webviewPanel.visible) stop(); }, undefined, context.subscriptions);
  view.webview.onDidReceiveMessage(async (message: { type?: unknown; format?: unknown }) => {
    activityTap.fromView?.(message);
    if (message?.type === 'ready') { stop(); if (view.visible) start(); }
    else if (message?.type === 'clear') activity.clear();
    else if (message?.type === 'export') await exportActivity(activity, message.format === 'json' ? 'json' : 'markdown');
  }, undefined, context.subscriptions);
  view.onDidDispose(() => { stop(); panel = undefined; }, undefined, context.subscriptions);
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

function activityHtml(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset('activity.css')}"><title>Agent Activity</title></head><body>
<header class="top">
  <div class="heading"><h1>Agent activity</h1><span id="live" class="live" title="Updates stream while this tab is visible">Live</span></div>
  <dl id="totals" class="totals" aria-label="Totals"></dl>
</header>
<section class="agents" aria-labelledby="agents-heading"><h2 id="agents-heading">Agents</h2><div class="table-wrap"><table id="agents"><thead><tr>
  <th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" class="num">Turns</th><th scope="col" class="num">Tokens in</th><th scope="col" class="num" title="Share of input tokens NEAR served from its prompt cache, billed at the lower cache-read price">Cache</th><th scope="col" class="num">Tokens out</th><th scope="col" class="num" title="Of tokens out, the share spent reasoning (estimated from the streamed text when NEAR does not report it)">Reasoning</th><th scope="col" class="num" title="Generation speed, not counting the wait for each reply's first token">Tok/s</th><th scope="col" title="Where the time went: waiting for replies to start, generating them, and tools and sub-agents">Time split</th><th scope="col" class="num">Est. cost</th><th scope="col" class="num">Tools</th><th scope="col" class="num">Retries</th><th scope="col">Security</th><th scope="col" class="num">Time</th>
</tr></thead><tbody></tbody></table></div><p id="empty-agents" class="hint">No agents have run yet. Send a message or run a workflow in the NEAR AI chat.</p></section>
<section class="stream-section" aria-labelledby="stream-heading">
  <div class="toolbar" role="toolbar" aria-label="Stream filters">
    <h2 id="stream-heading">Stream</h2>
    <label>Agent <select id="filter-agent"><option value="">All agents</option></select></label>
    <label><input type="checkbox" data-kind="prompt" checked> Prompts</label>
    <label><input type="checkbox" data-kind="text" checked> Replies</label>
    <label><input type="checkbox" data-kind="reasoning"> Reasoning</label>
    <label><input type="checkbox" data-kind="tool" checked> Tools</label>
    <label><input type="checkbox" data-kind="system"> System prompts</label>
    <label><input type="checkbox" data-kind="security" checked> Security</label>
    <input id="search" type="search" placeholder="Search" aria-label="Search the stream">
    <button id="pause" type="button" aria-pressed="false" title="Pause the stream to read it; new activity is held until you resume (P)">Pause</button>
    <label><input id="follow" type="checkbox" checked> Follow</label>
    <button id="export-md" type="button">Export</button>
    <button id="export-json" type="button" class="secondary">JSON</button>
    <button id="clear" type="button" class="secondary">Clear</button>
  </div>
  <p id="usage" class="hint" aria-live="polite"></p>
  <ol id="stream" class="stream" aria-live="off"></ol>
</section>
<script nonce="${nonce}" src="${asset('activity.js')}"></script></body></html>`;
}
