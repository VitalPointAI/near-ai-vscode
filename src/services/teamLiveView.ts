import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { buildTeamLive, LiveAgentStat, teamLiveEvents, TeamLiveView } from '../agent/teamLiveState';
import { TeamDefinition, TeamLibrary } from '../agent/teams';
import type { ActivitySessionSummary } from '../domain/activity';
import { ActivityStore } from './activityStore';
import { ActivityChat, sharedActivityFeed } from './activityView';
import { AgentStats, taskLabel } from './agentActivity';
import { layoutProbeAsset, layoutProbeTag, registerLayoutProbe, sharedMedia } from './layoutProbe';
import { homeFolder, teamLibraryDir } from '../domain/teamStorage';

// Team Live (0.4.28, owner 2026-11-16: "watch the team leader delegate tasks visually"): an editor panel that draws the team of a run as a tree, the
// lead on top, and shows each hand-off as it happens. The host builds the picture from the activity feed (buildTeamLive) and says what changed since
// the page last looked (teamLiveEvents); the page only animates. Discrete changes (an agent queued, started, waiting for the person, ended) go at once;
// everything else at most twice a second, and nothing while the panel is hidden. The page never receives a prompt, a tool's input or output, or reply
// text, except the last 280 characters of one agent's reply, with secrets removed, while the person has that agent's card open.

const STATS_MS = 500;
const DISCRETE_MS = 30;
const EXCERPT_MS = 1_000;

let panel: vscode.WebviewPanel | undefined;
let chat: ActivityChat | undefined;
let wantedRun: string | undefined;
let selectRun: ((runId: string | undefined) => void) | undefined;

/** Set by the extension-host tests to observe the page's messages in both directions. */
export const teamLiveTap: { toView?: (message: unknown) => void; fromView?: (message: unknown) => void } = {};

export function registerTeamLive(context: vscode.ExtensionContext, sidebar?: ActivityChat): void {
  chat = sidebar;
  context.subscriptions.push(vscode.commands.registerCommand('nearAi.openTeamLive', (runId?: unknown) => openTeamLive(context, typeof runId === 'string' && RUN_ID.test(runId) ? runId : undefined)));
}

/** What the page may ask for; anything else is ignored. */
export type TeamLiveMessage =
  | { type: 'ready' }
  | { type: 'select-run'; runId: string }
  | { type: 'agent-control'; agentId: string; action: 'pause' | 'resume' | 'stop' }
  /** The person opened an agent's card (its reply's last lines are sent while it is open), or closed it (`agentId` absent). */
  | { type: 'open-card'; agentId?: string }
  | { type: 'show-in-chat' }
  | { type: 'open-activity'; agentId?: string };

const AGENT_ID = /^[a-z0-9][a-z0-9:_-]{0,90}-[a-f0-9]{6}$/i;
const RUN_ID = /^run-[a-z0-9-]{1,80}$/i;

export function parseTeamLiveMessage(value: unknown): TeamLiveMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  const agent = (key: string) => typeof message[key] === 'string' && AGENT_ID.test(message[key] as string);
  switch (message.type) {
    case 'ready': case 'show-in-chat': return { type: message.type };
    case 'select-run': return typeof message.runId === 'string' && RUN_ID.test(message.runId) ? { type: 'select-run', runId: message.runId } : undefined;
    case 'agent-control': return agent('agentId') && (message.action === 'pause' || message.action === 'resume' || message.action === 'stop') ? { type: 'agent-control', agentId: message.agentId as string, action: message.action } : undefined;
    case 'open-card': return message.agentId === undefined ? { type: 'open-card' } : agent('agentId') ? { type: 'open-card', agentId: message.agentId as string } : undefined;
    case 'open-activity': return message.agentId === undefined ? { type: 'open-activity' } : agent('agentId') ? { type: 'open-activity', agentId: message.agentId as string } : undefined;
    default: return undefined;
  }
}

/** One run the page may show: its main agent's id, a title, and whether it still runs. */
export interface LiveRun { runId: string; title: string; running: boolean; startedAt: number; conversationId?: string }

/** The runs worth a picture: those that lead or work with a team, or that started at least one agent; newest first. */
export function liveRuns(stats: Array<Pick<AgentStats, 'agentId' | 'agent' | 'runId' | 'status' | 'startedAt' | 'parentId' | 'team' | 'conversationId'>>): LiveRun[] {
  const helpers = new Set(stats.filter((stat) => stat.parentId).map((stat) => stat.runId));
  return stats
    .filter((stat) => stat.agentId === `main-${stat.runId}` && (stat.team || helpers.has(stat.runId)))
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((stat) => ({ runId: stat.runId, title: stat.agent, running: stat.status === 'running', startedAt: stat.startedAt, ...(stat.conversationId ? { conversationId: stat.conversationId } : {}) }));
}

/**
 * Which run to show: the one asked for while it is known; else the newest running run in the conversation on screen; else the newest running run; else
 * the newest run.
 */
export function pickRun(runs: LiveRun[], wanted: string | undefined, conversationId: string | undefined): LiveRun | undefined {
  return runs.find((run) => run.runId === wanted)
    ?? runs.find((run) => run.running && conversationId !== undefined && run.conversationId === conversationId)
    ?? runs.find((run) => run.running)
    ?? runs[0];
}

/** Everything the page shows, in one message, with what changed since `previous` (nothing when there was no previous view of the same run). */
export function teamLiveMessage(input: { stats: LiveAgentStat[]; runs: LiveRun[]; runId?: string; team?: TeamDefinition; previous?: TeamLiveView; excerpt?: { agentId: string; text?: string }; restored?: boolean; now?: number }): { message: Record<string, unknown>; view?: TeamLiveView } {
  const now = input.now ?? Date.now();
  const run = input.runs.find((candidate) => candidate.runId === input.runId);
  if (!run) return { message: { type: 'team-live', now, runs: input.runs.map(runForPage) } };
  const view = buildTeamLive({ runId: run.runId, stats: input.stats, ...(input.team ? { team: input.team } : {}), title: run.title });
  const events = teamLiveEvents(input.previous, view);
  return {
    view,
    message: {
      type: 'team-live', now, runs: input.runs.map(runForPage), runId: run.runId, view, events,
      ...(input.restored ? { restored: true } : {}),
      ...(input.excerpt ? { excerpt: { agentId: input.excerpt.agentId, ...(input.excerpt.text ? { text: input.excerpt.text } : {}) } } : {})
    }
  };
}

const runForPage = (run: LiveRun) => ({ runId: run.runId, title: run.title, running: run.running, startedAt: run.startedAt });

/**
 * A finished run drawn from the project's activity history after VS Code reloaded (the live feed starts empty then): each agent with the agent that
 * started it, its role, task label (redacted again here) and how it ended. One that never ended is interrupted, never working.
 */
export function statsFromHistory(session: ActivitySessionSummary): LiveAgentStat[] {
  const runId = session.runId;
  if (!runId) return [];
  const started = (timestamp: string) => Date.parse(timestamp) || 0;
  // A run with no recorded end, or one closed because VS Code reloaded (closeInterrupted), was interrupted.
  const reloaded = session.events.some((event) => event.kind === 'session' && event.status === 'cancelled' && /reloaded/i.test(event.summary));
  const outcome = session.runOutcome;
  const main: LiveAgentStat = {
    agentId: `main-${runId}`, agent: session.title ?? 'Run', runId, model: session.models[0] ?? '', startedAt: started(session.startedAt), turns: 0, toolCalls: 0, costUsd: 0, phase: 'thinking',
    status: outcome ?? 'running', ...(!outcome || reloaded ? { interrupted: true } : {})
  };
  const agents = new Map<string, LiveAgentStat>();
  for (const event of session.events) {
    if (event.kind !== 'agent' || !event.agentId || !AGENT_ID.test(event.agentId)) continue;
    const known = agents.get(event.agentId);
    const status = event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : event.status === 'cancelled' ? 'cancelled' : 'running';
    const task = taskLabel(event.action);
    agents.set(event.agentId, {
      agentId: event.agentId, agent: event.agentRole ?? known?.agent ?? 'agent', runId, model: event.model ?? known?.model ?? '', phase: 'thinking',
      status, startedAt: known?.startedAt ?? started(event.timestamp), turns: 0, toolCalls: 0, costUsd: event.estimatedCostUsd ?? known?.costUsd ?? 0,
      ...(event.parentAgentId ?? known?.parentId ? { parentId: event.parentAgentId ?? known?.parentId } : {}),
      ...(task ?? known?.task ? { task: task ?? known?.task } : {}),
      ...(status === 'running' ? { interrupted: true } : { endedAt: started(event.timestamp) })
    });
  }
  return [main, ...agents.values()];
}

/** The team a run of /team:<slug> used, for a run drawn from history: the team as it is now (the history does not keep the file). */
const TEAM_COMMAND = /^\/team:([a-z0-9][a-z0-9-]{0,60})(?:\s|$)/;

/** Opens the panel; with a run id, that run is shown. */
export function openTeamLive(context: vscode.ExtensionContext, runId?: string): void {
  wantedRun = runId;
  if (panel) { panel.reveal(); selectRun?.(runId); return; }
  const media = vscode.Uri.joinPath(context.extensionUri, 'media', 'teamLive');
  const view = vscode.window.createWebviewPanel('nearAiTeamLive', 'Team Live', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [media, sharedMedia(context.extensionUri)] });
  panel = view;
  view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'near-ai-vscode-icon.png');
  view.webview.html = teamLiveHtml(view.webview, media);
  registerLayoutProbe('team-live', view.webview);
  const feed = sharedActivityFeed();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  let subscription: { dispose(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSent = 0;
  let lastRevision = -1;
  let previous: TeamLiveView | undefined;
  let lastJson = '';
  let openCard: string | undefined;
  let excerpt: { agentId: string; text?: string; at: number } | undefined;
  const teams = new Map<string, TeamDefinition | undefined>();
  const post = (message: Record<string, unknown>) => { teamLiveTap.toView?.(message); void view.webview.postMessage(message); };
  const historyTeam = async (title: string | undefined): Promise<TeamDefinition | undefined> => {
    const slug = title ? TEAM_COMMAND.exec(title)?.[1] : undefined;
    if (!slug) return undefined;
    if (!teams.has(slug)) teams.set(slug, await new TeamLibrary(teamLibraryDir(homeFolder())).find(slug, root).catch(() => undefined));
    return teams.get(slug);
  };
  const send = async () => {
    timer = undefined;
    if (!subscription) return;
    lastSent = Date.now();
    lastRevision = feed.lifecycleRevision;
    const stats = feed.agentStats();
    let runs = liveRuns(stats);
    let source: LiveAgentStat[] = stats;
    let team: TeamDefinition | undefined;
    let restored = false;
    if (!runs.length && root) {
      // After a reload the feed is empty: the newest run in this project's history that started agents is drawn as it ended.
      const store = new ActivityStore(root);
      const sessions = await store.list().catch(() => [] as ActivitySessionSummary[]);
      const latest = sessions.filter((session) => session.runId && session.events.some((event) => event.kind === 'agent')).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      if (latest) {
        source = statsFromHistory(latest);
        runs = [{ runId: latest.runId!, title: latest.title ?? 'Last run', running: false, startedAt: Date.parse(latest.startedAt) || 0 }];
        team = await historyTeam(latest.title);
        restored = true;
      }
    }
    const run = pickRun(runs, wantedRun, feed.currentConversation);
    if (run && !restored) team = feed.runTeam(run.runId);
    if (openCard && (!excerpt || excerpt.agentId !== openCard || Date.now() - excerpt.at >= EXCERPT_MS)) excerpt = { agentId: openCard, text: restored ? undefined : feed.replyTail(openCard), at: Date.now() };
    const { message, view: next } = teamLiveMessage({ stats: source, runs, ...(run ? { runId: run.runId } : {}), ...(team ? { team } : {}), previous, ...(openCard && excerpt ? { excerpt } : {}), restored });
    previous = next;
    const json = JSON.stringify({ ...message, now: 0 });
    if (json === lastJson) return;
    lastJson = json;
    post(message);
  };
  // Discrete changes at once (a few milliseconds, so a burst goes as one); the rest at most every STATS_MS.
  const schedule = () => {
    const urgent = feed.lifecycleRevision !== lastRevision;
    const wait = urgent ? DISCRETE_MS : Math.max(0, STATS_MS - (Date.now() - lastSent));
    if (timer && !urgent) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void send(), wait);
  };
  const start = () => {
    if (subscription) return;
    subscription = feed.subscribe(() => schedule());
    previous = undefined;
    lastJson = '';
    void send();
  };
  const stop = () => {
    subscription?.dispose();
    subscription = undefined;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  selectRun = (runId) => { wantedRun = runId; previous = undefined; lastJson = ''; if (subscription) void send(); };
  view.onDidChangeViewState((event) => { if (!event.webviewPanel.visible) stop(); }, undefined, context.subscriptions);
  view.webview.onDidReceiveMessage(async (raw: unknown) => {
    teamLiveTap.fromView?.(raw);
    const message = parseTeamLiveMessage(raw);
    if (!message) return;
    if (message.type === 'ready') { stop(); if (view.visible) start(); }
    else if (message.type === 'select-run') selectRun?.(message.runId);
    else if (message.type === 'open-card') { openCard = message.agentId; excerpt = undefined; if (subscription) void send(); }
    else if (message.type === 'agent-control') {
      // As in Agent Activity: the main agent has no pause; stopping it stops its run's own conversation.
      if (message.agentId.startsWith('main-')) { if (message.action === 'stop') { const conversationId = feed.agentStat(message.agentId)?.conversationId; await chat?.request({ type: 'stop', ...(conversationId ? { conversationId } : {}) }); } }
      else await chat?.request({ type: 'agent-control', agentId: message.agentId, action: message.action });
      schedule();
    }
    else if (message.type === 'show-in-chat') await vscode.commands.executeCommand('nearAi.openChat');
    else if (message.type === 'open-activity') await vscode.commands.executeCommand('nearAi.openAgentActivity', message.agentId);
  }, undefined, context.subscriptions);
  view.onDidDispose(() => { stop(); panel = undefined; selectRun = undefined; }, undefined, context.subscriptions);
}

export function teamLiveHtml(webview: Pick<vscode.Webview, 'asWebviewUri' | 'cspSource'>, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const shared = vscode.Uri.joinPath(media, '..', 'shared');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(shared, 'base.css')).toString()}">
<link rel="stylesheet" href="${asset('teamLive.css')}"><title>Team Live</title></head><body>
<header class="top">
  <div class="heading">
    <h1 id="title" data-must-read>Team Live</h1>
    <p id="run-state" class="hint" data-must-read></p>
  </div>
  <div class="actions">
    <label id="run-picker" class="picker" hidden><span>Run</span> <select id="run"></select></label>
    <button id="calm" type="button" class="secondary" aria-pressed="false" title="Show states without any movement">Calm</button>
    <button id="layout" type="button" class="secondary" aria-pressed="false" title="Show the team as an indented list">List</button>
    <button id="show-chat" type="button" class="secondary">Show chat</button>
  </div>
</header>
<main>
  <p id="empty" class="hint">No team is working right now. Run a team with /team:&lt;name&gt; in the NEAR AI chat, or a workflow that starts agents, and watch it here.</p>
  <p id="restored" class="hint" hidden>The last run in this project, as it ended. It is drawn from the activity history kept on this computer.</p>
  <div id="stage" class="stage" hidden>
    <svg id="lines" class="lines" aria-hidden="true" focusable="false"></svg>
    <div id="tree" class="tree" role="tree" aria-label="The team: the lead, its members and helpers"></div>
    <div id="pulses" class="pulses" aria-hidden="true"></div>
  </div>
  <section id="card" class="card" aria-label="Agent details" hidden></section>
  <p class="hint">Shows what each agent is doing and who asked it, never prompts, files or tool results. An open card shows the end of that agent's latest reply, with secrets removed.</p>
</main>
<div id="announce" class="visually-hidden" role="status" aria-live="polite"></div>
${layoutProbeTag(nonce, layoutProbeAsset(webview, shared))}<script nonce="${nonce}" src="${asset('teamLive.js')}"></script></body></html>`;
}
