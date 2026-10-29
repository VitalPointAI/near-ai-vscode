import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatGsdStatusLine, parseGsdPlanningState, statusSnapshot, withLiveStatus } from '../domain/gsdStatus';
import { GSD_COMMANDS } from '../domain/gsdCommands';
import { AuthService } from './auth';
import { activeProvider, clientFor } from './providerCache';
import { projectMemoryScope } from '../agent/extraTools';
import { AGENT_MEMORY_ACTOR, AgentConversation, findSkill, GsdContext, newConversationId, spendAccountOf } from './agentSession';
import { GsdHost } from '../gsd/host';
import { findRipgrep } from '../agent/tools';
import { isEmergencyStopped, onDidChangeEmergencyStop } from './emergencyStop';
import { applyPolicyChoice, PolicyConfiguration, policyStateMessage } from './approvalPolicy';
import { OutboundGuard } from './outboundGuard';
import { configureSpendTracking, currentReportingTokenHint, onReportingTokenChange, runReportingTokenHint, spendAccountForRoot } from './spendTracking';
import { hintForView } from './reportingToken';
import { shownSpendAccount, showSpendAccount, SpendAccount } from './spendAccount';
import { withSpendTag } from './spendLedger';
import { ProfileStore } from './profileStore';
import { readAgentLimits, readAgentModels, readAgentRules, readModelTiers, readRoleModels, readSafetyModel, readSettings, shouldAutoInstallGsd, readRunBudget } from './settings';
import { sharedTranscriptKey, TranscriptStore } from './transcripts';
import { prepareAttachments, stageAttachment, StagedAttachment } from '../agent/attachments';
import { TeamDefinition, TeamLibrary, teamAgents } from '../agent/teams';
import type { GsdAgent } from '../gsd/library';
import { modelOptions, modelPrivacyLabel, modelsAsPrivateAs, privateSafetyModel, parseChatWebviewMessage, providerErrorMessage, discoverGsdArtifacts, isSafeArtifactPath, GsdArtifactLink, profileStatusMessage } from './chatBridge';
import type { ChatWebviewMessage } from './chatBridge';
import { sharedActivityFeed } from './activityView';
import { runTitleFor } from './activityOverview';
import { AGENT_DEFAULTS } from '../domain/agentDefaults';
import type { ModelInfo } from './nearAiClient';
import { RED_TEAM_WORKFLOW_STEP, redTeamEnabled } from '../agent/projectTypes';
import { securityAccess } from './securityScan';
import { webSearchProvider } from './webSearchSetup';
import { mcpRegistry } from './mcpView';
import { ActivityStore, closeInterruptedRuns } from './activityStore';
import { ConversationLog, ConversationOutcome, ConversationStatus, ConversationSummary, conversationStatus, conversationTitle, isOutput, MAX_OPEN_CONVERSATIONS, outcomeOf, parseSavedConversations, promptIdOf, PromptOutcome, savedConversations } from './conversations';
import { ReputationStore } from './reputation';
import { hostAttribution } from '../domain/activity';
import { ContextGraphMemory } from './contextGraphMemory';

/** Chat model and safety model pairs already told that auto approve has no private safety model. */
const warnedSafetyModels = new Set<string>();

export interface ChatHost {
  webview: vscode.Webview;
  onDidDispose: vscode.Event<void>;
}

export async function attachChatToView(context: vscode.ExtensionContext, auth: AuthService, view: vscode.WebviewView, html: string): Promise<void> {
  await initializeChat(context, auth, view, html);
}

/** Where the open conversation list is kept in the workspace's state. */
const OPEN_CONVERSATIONS_KEY = 'nearAi.chat.openConversations';
const STOP_AND_CLOSE = 'Stop and close';

/**
 * One open conversation (a tab in the sidebar): its agent, with its own run, sub-agents,
 * prompts, steering queue, task list, and spend and activity ID, plus what it showed the view,
 * so it can be shown again after the user looks at another one.
 */
interface ChatTab {
  /** The conversation ID: its agent's, its transcript's, and its spend and activity tag. */
  id: string;
  agent?: AgentConversation;
  log: ConversationLog;
  title: string;
  /** Message handlers for a turn (send or command) still in progress, from validation to the run's end. */
  turns: number;
  /** The model its last turn used, and that model's catalog entry for checking messages sent mid-run. */
  model?: string;
  modelInfo?: ModelInfo;
  outcome: ConversationOutcome;
  unread: boolean;
  /** Closed while its run was still ending: the agent is disposed once it has. */
  closing: boolean;
  /** Counts stops, so a turn still being prepared when its conversation is stopped never starts its run. */
  stops: number;
  /** How each settled prompt ended, for the record left in its place when the conversation is shown again. */
  outcomes: Map<string, PromptOutcome>;
  /** What was typed for each queued steer, so a re-shown conversation shows its queued messages. */
  steerTexts: Map<string, string>;
  /** Sends a message of this conversation: logged, and posted to the view when it is on screen. */
  post: (message: Record<string, unknown>) => void;
}

async function initializeChat(context: vscode.ExtensionContext, auth: AuthService, panel: ChatHost, html: string, initialPrompt?: string): Promise<void> {
  configureSpendTracking(context);
  const state = {
    activity: undefined as ActivityStore | undefined,
    guard: undefined as OutboundGuard | undefined
    ,attachments: new Map<string, StagedAttachment>()
    ,memory: undefined as ContextGraphMemory | undefined
    ,guardSettings: undefined as string | undefined
    /** The spend account the status line follows, and its change subscription. */
    ,spend: undefined as SpendAccount | undefined
    ,spendWatch: undefined as { dispose(): void } | undefined
    ,spendTimer: undefined as ReturnType<typeof setTimeout> | undefined
  };
  const tabs: ChatTab[] = [];
  let activeId = '';
  let disposed = false;
  const feed = sharedActivityFeed();
  const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const onScreen = (): ChatTab => tabs.find((tab) => tab.id === activeId) ?? tabs[0];
  /** The conversation a message names, or the one on screen; undefined for one that is no longer open. */
  const tabFor = (id: string | undefined): ChatTab | undefined => id ? tabs.find((tab) => tab.id === id) : onScreen();
  const isRunning = (tab: ChatTab) => tab.turns > 0 || Boolean(tab.agent?.running);
  const waitingCount = (tab: ChatTab) => tab.agent?.waitingPrompts().length ?? 0;
  const runningAgents = () => tabs.reduce((sum, tab) => sum + (tab.agent?.runningAgents ?? 0), 0);
  /** Never sent anything, so "New conversation" reuses it instead of opening another. */
  const isBlank = (tab: ChatTab) => !isRunning(tab) && !tab.title && (tab.agent?.isEmpty ?? true);

  // The tab list: posted when it changes, and saved so a reload reopens the same conversations.
  let lastSummary = '';
  let lastSaved = '';
  let lastBadge = '';
  const sendSummary = (force = false): void => {
    if (disposed) return;
    const items: ConversationSummary[] = tabs.map((tab) => ({ id: tab.id, title: tab.title, status: conversationStatus({ running: isRunning(tab), waiting: waitingCount(tab), outcome: tab.outcome }), unread: tab.unread, waiting: waitingCount(tab) }));
    const waiting = items.reduce((sum, item) => sum + item.waiting, 0);
    const waitingIn = items.filter((item) => item.waiting > 0).length;
    if (`${waiting}/${waitingIn}` !== lastBadge) { lastBadge = `${waiting}/${waitingIn}`; showWaitingBadge(panel, waiting, waitingIn); }
    const summary = { type: 'conversations', activeId: onScreen()?.id, items, waiting, max: MAX_OPEN_CONVERSATIONS };
    const json = JSON.stringify(summary);
    if (force || json !== lastSummary) { lastSummary = json; void panel.webview.postMessage(summary); }
    const saved = JSON.stringify(savedConversations(items, onScreen()?.id));
    if (saved !== lastSaved) { lastSaved = saved; void context.workspaceState?.update(OPEN_CONVERSATIONS_KEY, JSON.parse(saved)); }
  };

  const newTab = (id = newConversationId()): ChatTab => {
    const tab: ChatTab = { id, log: new ConversationLog(), title: '', turns: 0, outcome: 'idle', unread: false, closing: false, stops: 0, outcomes: new Map(), steerTexts: new Map(), post: () => undefined };
    tab.post = (message) => {
      tab.outcome = outcomeOf(message) ?? tab.outcome;
      if (message.type === 'approval-expired' && typeof message.callId === 'string') tab.outcomes.set(message.callId, { outcome: 'expired', ...(typeof message.minutes === 'number' ? { detail: message.minutes } : {}) });
      if (message.type === 'prompt-closed' && typeof message.id === 'string') tab.outcomes.set(message.id, { outcome: message.outcome === 'cancelled' ? 'cancelled' : 'closed' });
      const steerId = message.type === 'steer-state' ? String(message.id) : undefined;
      tab.log.add(steerId && message.state === 'queued' && tab.steerTexts.has(steerId) ? { ...message, text: tab.steerTexts.get(steerId) } : message);
      if (steerId && message.state !== 'queued') tab.steerTexts.delete(steerId);
      if (disposed) return;
      if (tab.id === activeId && tabs.includes(tab)) void panel.webview.postMessage(message);
      else if (isOutput(message)) tab.unread = true;
      sendSummary();
    };
    return tab;
  };
  const ensureAgent = (tab: ChatTab, root: string): AgentConversation => {
    if (!tab.agent) {
      tab.agent = conversationFor(context, root, panel, tab.post, () => tab.title || 'a conversation');
      tab.agent.adopt(tab.id);
      tab.agent.onWaitingChange = () => sendSummary();
    }
    return tab.agent;
  };
  /** Puts a conversation on screen: the view clears, then gets everything the conversation showed, with its prompts pinned again. */
  const show = (tab: ChatTab): void => {
    activeId = tab.id;
    tab.unread = false;
    feed.focusConversation(tab.id);
    void panel.webview.postMessage({ type: 'conversation-show', id: tab.id, title: tab.title, ...(tab.model ? { model: tab.model } : {}) });
    const waiting = new Map((tab.agent?.waitingPrompts() ?? []).map((prompt) => [promptIdOf(prompt) ?? '', prompt] as const).filter(([id]) => id));
    for (const message of tab.log.replay(waiting, tab.outcomes)) void panel.webview.postMessage(message);
    void panel.webview.postMessage({ type: 'conversation-shown', id: tab.id, busy: isRunning(tab) });
    sendSummary(true);
  };
  /** Opens a saved conversation's transcript into `tab`; false when it is no longer saved. */
  const restoreInto = async (tab: ChatTab, id: string, root: string, note: string): Promise<boolean> => {
    const agent = ensureAgent(tab, root);
    const turns = await agent.restore(id);
    if (!turns) return false;
    tab.id = agent.id;
    tab.title = conversationTitle(agent.displayTitle) ?? tab.title;
    tab.log.clear();
    tab.outcomes.clear();
    tab.outcome = 'done';
    tab.log.add({ type: 'transcript', turns, note });
    return true;
  };
  /** At the cap, asks which conversation to close; false when none was (or could be) closed. */
  const makeRoom = async (): Promise<boolean> => {
    if (tabs.length < MAX_OPEN_CONVERSATIONS) return true;
    const pick = typeof vscode.window.showQuickPick === 'function'
      ? await vscode.window.showQuickPick(tabs.map((tab) => ({ label: tab.title || 'New conversation', description: STATUS_WORDS[conversationStatus({ running: isRunning(tab), waiting: waitingCount(tab), outcome: tab.outcome })], id: tab.id })), { placeHolder: `${MAX_OPEN_CONVERSATIONS} conversations are open, the most at once. Choose one to close (its transcript stays in history).` })
      : undefined;
    if (!pick) { onScreen().post({ type: 'notice', text: `${MAX_OPEN_CONVERSATIONS} conversations are open, the most at once. Close one (×) to start another; its transcript stays in NEAR AI: Show Chat History.` }); return false; }
    await closeConversation(pick.id);
    return tabs.length < MAX_OPEN_CONVERSATIONS;
  };
  const newConversation = async (): Promise<void> => {
    const current = onScreen();
    if (current && isBlank(current)) { current.log.clear(); current.outcome = 'idle'; show(current); return; }
    if (!(await makeRoom())) return;
    const tab = newTab();
    tabs.push(tab);
    show(tab);
  };
  /** Closes a tab. A running (or waiting) conversation is stopped first, once the user confirms. */
  const closeConversation = async (id: string): Promise<void> => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    if (isRunning(tab) || waitingCount(tab)) {
      const choice = await vscode.window.showWarningMessage(`"${tab.title || 'This conversation'}" is still running. Stop it and close the conversation? Its transcript stays in NEAR AI: Show Chat History.`, { modal: true }, STOP_AND_CLOSE);
      if (choice !== STOP_AND_CLOSE) return;
    }
    const index = tabs.indexOf(tab);
    if (index === -1) return;
    tabs.splice(index, 1);
    tab.closing = true;
    tab.stops += 1;
    tab.agent?.stop();
    if (!tab.turns && !tab.agent?.running) tab.agent?.dispose();
    if (!tabs.length) tabs.push(newTab());
    if (activeId === id) show(tabs[Math.min(index, tabs.length - 1)]);
    else sendSummary(true);
  };
  /** History's "open conversation": shows it when open, otherwise opens it as a tab. */
  const openSaved = async (id: string): Promise<void> => {
    const open = tabs.find((tab) => tab.id === id);
    if (open) { show(open); return; }
    const root = workspaceRoot();
    if (!root) return;
    const current = onScreen();
    const reuse = current && isBlank(current) ? current : undefined;
    if (!reuse && !(await makeRoom())) return;
    const tab = reuse ?? newTab();
    if (!(await restoreInto(tab, id, root, 'Opened this conversation with its full context. Continue where you left off.'))) {
      onScreen().post({ type: 'history-error', text: 'That conversation is no longer saved on this machine.' });
      return;
    }
    if (!reuse) tabs.push(tab);
    show(tab);
  };

  // The status line follows the key's ledger and NEAR's usage summary as they settle, at most once a second.
  const followSpend = (account: SpendAccount | undefined): void => {
    if (!account || account === state.spend) return;
    showSpendAccount(account);
    state.spendWatch?.dispose();
    state.spend = account;
    state.spendWatch = account.onChange(() => {
      state.spendTimer ??= setTimeout(() => { state.spendTimer = undefined; void statusMessage({ agents: runningAgents(), account }).then((status) => panel.webview.postMessage(status)); }, 1_000);
      state.spendTimer.unref?.();
    });
  };
  panel.webview.html = html;

  // The open conversations come back after a reload. Runs cannot survive one: a conversation that
  // was running is shown as stopped, with its transcript, and its run is closed in the history.
  const ready = (async () => {
    const root = workspaceRoot();
    if (root) await closeInterruptedRuns(root);
    const saved = parseSavedConversations(context.workspaceState?.get(OPEN_CONVERSATIONS_KEY));
    for (const item of saved.items) {
      const tab = newTab(item.id);
      tab.title = item.title;
      if (root && await restoreInto(tab, item.id, root, 'Reopened after VS Code reloaded, with its full context.').catch(() => false)) tab.title ||= item.title;
      else if (root) ensureAgent(tab, root);
      tab.outcome = item.status === 'running' ? 'stopped' : item.status;
      if (item.status === 'running') tab.log.add({ type: 'notice', text: 'This conversation\'s run was stopped when VS Code reloaded (a run cannot continue across a reload). Everything up to the last saved turn is kept; send a message to continue.' });
      tabs.push(tab);
    }
    if (!tabs.length) tabs.push(newTab());
    activeId = saved.activeId ?? tabs[0].id;
    feed.focusConversation(activeId);
    sendSummary(true);
  })();

  const handle = async (message: ChatWebviewMessage, tab: ChatTab): Promise<void> => {
    if (message.type === 'stop') {
      const was = isRunning(tab);
      const outcome = tab.outcome;
      tab.stops += 1;
      tab.agent?.stop();
      tab.post({ type: 'assistant-cancelled', status: await readGsdStatusLine() });
      // Stopping a conversation that was not running leaves how its last turn ended.
      if (!was) { tab.outcome = outcome; sendSummary(); }
      return;
    }
    // Only the user's own choice in the composer's picker changes the approval policy.
    if (message.type === 'set-action-policy') {
      try {
        const result = await applyPolicyChoice(message.mode, policyConfiguration(), vscode.ConfigurationTarget, async (text) => await vscode.window.showWarningMessage(text, { modal: true }, FULL_AUTO_CONFIRM) === FULL_AUTO_CONFIRM);
        panel.webview.postMessage({ type: 'notice', text: result.text });
      } catch (error) {
        panel.webview.postMessage({ type: 'notice', text: `The approval policy could not be saved: ${providerErrorMessage(error)}` });
      }
      sendPolicyState(panel);
      return;
    }
    // A (re)loaded view shows the conversation on screen again, with the prompts still waiting pinned.
    if (message.type === 'chat-ready') { show(onScreen()); return; }
    if (message.type === 'switch-conversation') { const target = tabs.find((candidate) => candidate.id === message.id); if (target) show(target); return; }
    if (message.type === 'close-conversation') { await closeConversation(message.id); return; }
    if (message.type === 'new-chat') { await newConversation(); return; }
    if (message.type === 'resume-conversation') { await openSaved(message.id); return; }
    if (message.type === 'questions-reply') {
      tab.outcomes.set(message.id, { outcome: 'answered', detail: message.answers.join('; ') });
      tab.agent?.answerQuestions(message.id, message.answers);
      return;
    }
    if (message.type === 'attach-files') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', title: 'Attach files to your message' });
      for (const uri of picked ?? []) {
        try {
          const attachment = await stageAttachment(uri.fsPath);
          state.attachments.set(attachment.id, attachment);
          panel.webview.postMessage({ type: 'attachment-staged', id: attachment.id, name: attachment.name, kind: attachment.kind, size: attachment.size });
          if (attachment.note) panel.webview.postMessage({ type: 'notice', text: attachment.note });
        } catch (error) {
          panel.webview.postMessage({ type: 'notice', text: providerErrorMessage(error) });
        }
      }
      return;
    }
    if (message.type === 'attachment-remove') {
      state.attachments.delete(message.id);
      return;
    }
    // Sub-agent IDs are unique, so the one conversation running it takes the control.
    if (message.type === 'agent-control') {
      for (const candidate of tabs) if (candidate.agent?.controlAgent(message.agentId, message.action)) break;
      return;
    }
    if (message.type === 'open-setup') {
      await vscode.commands.executeCommand('nearAi.setup');
      return;
    }
    if (message.type === 'select-profile') {
      await vscode.commands.executeCommand('nearAi.selectProfile');
      return;
    }
    if (message.type === 'open-activity') {
      await vscode.commands.executeCommand('nearAi.openAgentActivity', message.agentId);
      return;
    }
    if (message.type === 'open-tools') {
      await vscode.commands.executeCommand('nearAi.openTools');
      return;
    }
    if (message.type === 'reporting-token') {
      await runReportingTokenHint();
      return;
    }
    if (message.type === 'approval-reply') {
      tab.outcomes.set(message.callId, { outcome: message.decision });
      tab.agent?.answerApproval(message.callId, { decision: message.decision, feedback: message.feedback });
      return;
    }
    if (message.type === 'revert-run') {
      const restored = await tab.agent?.revert(message.runId) ?? [];
      tab.post({ type: 'run-reverted', runId: message.runId, files: restored });
      return;
    }
    if (message.type === 'verify-response') {
      const result = tab.agent ? await tab.agent.verifyRun(message.runId).catch((error: Error) => ({ outcome: 'unavailable' as const, summary: `Verification failed: ${providerErrorMessage(error)}`, checks: {}, notChecked: [] })) : undefined;
      tab.post({ type: 'response-verification', runId: message.runId, result: result ?? { outcome: 'unavailable', summary: 'Nothing to verify.', checks: {}, notChecked: [] } });
      return;
    }
    if (message.type === 'insert-code') {
      await insertIntoActiveEditor(message.text);
      return;
    }
    if (message.type === 'refresh-status') {
      panel.webview.postMessage(await statusMessage({ agents: runningAgents(), account: state.spend }));
      await sendProfileStatus(panel, auth);
      await sendArtifacts(panel);
      return;
    }
    if (message.type === 'open-artifact') {
      const root = workspaceRoot();
      if (!root || !isSafeArtifactPath(root, message.path)) return;
      const artifacts = await discoverGsdArtifacts(root);
      await openGsdArtifact(root, message, artifacts);
      return;
    }
    if (message.type === 'load-models') {
      sendPolicyState(panel);
      await loadModels(panel, auth);
      return;
    }
    if (message.type !== 'send' && message.type !== 'open-command') return;
    if (message.type === 'send' && !message.text?.trim()) return;
    const stops = tab.stops;
    /** Stopped (or closed) while this turn was still being prepared: its run never starts. */
    const stopped = () => tab.closing || tab.stops !== stops;
    // What the user sent stays in the conversation's log (the view showed it as they sent it), and names a new conversation.
    const typed = message.type === 'send' ? message.text : `/${message.command}${message.args ? ` ${message.args}` : ''}`;
    if (!(message.type === 'send' && message.overrideToken)) {
      const names = message.type === 'send' ? (message.attachmentIds ?? []).map((id) => state.attachments.get(id)?.name).filter(Boolean) : [];
      tab.log.add({ type: 'user-turn', text: typed + (names.length ? `\n📎 ${names.join(', ')}` : '') });
    }
    if (!tab.title) tab.title = conversationTitle(typed) ?? '';
    sendSummary();
    if (isEmergencyStopped()) { tab.post({ type: 'outbound-blocked', text: '', model: '', reason: 'Emergency stop is on. Run "NEAR AI: Resume" to continue.', confirm: false }); return; }
    const root = workspaceRoot();
    let active;
    try {
      active = root ? await activeProvider(root, auth) : undefined;
    } catch (error) {
      tab.post({ type: 'auth-required', text: providerErrorMessage(error) });
      return;
    }
    if (!root || !active) {
      // Nothing is written here: a chat attempt before setup must not turn the workspace into a NEAR AI project.
      await sendProfileStatus(panel, auth);
      tab.post({ type: 'auth-required', text: 'Set up a NEAR AI profile for this project to start chatting.' });
      return;
    }
    const model = message.model?.trim() || tab.model || readSettings().defaultModel;
    if (!model) { tab.post({ type: 'assistant-error', text: 'Choose a model from the list below the message box.' }); return; }
    const modelInfo = active.models.find((candidate) => candidate.id === model);
    // Open-GSD: a slash command installs it when missing; plain chat uses it only if already installed.
    const gsdHost = gsdHostFor(context);
    let gsd: GsdContext | undefined;
    let skill: { name: string; args: string } | undefined;
    let team: TeamDefinition | undefined;
    let redTeamStep: { addendum: string; agents: GsdAgent[] } | undefined;
    try {
      if (message.type === 'open-command' && message.command.startsWith('team:')) {
        team = await new TeamLibrary(context.globalStorageUri.fsPath).find(message.command.slice(5), root).catch((error: Error) => { throw new Error(`That team file has a problem: ${error.message}`); });
        if (!team) { tab.post({ type: 'assistant-error', text: `There is no team called ${message.command.slice(5)}. Create one with NEAR AI: Team Studio.` }); return; }
        if (!message.args?.trim()) { tab.post({ type: 'assistant-error', text: `Tell the team what to do: /team:${team.slug} <task>` }); return; }
        gsd = await gsdHost.context();
      } else if (message.type === 'open-command') {
        if (!(await gsdHost.context())) {
          if (!shouldAutoInstallGsd()) { tab.post({ type: 'assistant-error', text: 'Open-GSD is not installed. Turn on nearAi.autoInstallGsd to install it when you run a workflow.' }); return; }
          tab.post({ type: 'notice', text: 'Installing Open-GSD for NEAR AI (first workflow only)…' });
        }
        gsd = await gsdHost.ensure();
        const found = findSkill(gsd.skills, message.command);
        if (!found) { tab.post({ type: 'assistant-error', text: `Open-GSD ${await gsdHost.runtime.installedVersion()} has no /${message.command} command.` }); return; }
        skill = { name: found.name, args: message.args ?? '' };
        // Projects set up with a red-team stage add it to GSD workflows that end in verification.
        if (/^gsd-(?:execute-phase|verify-work|autonomous)$/.test(found.name) && await redTeamEnabled(root)) {
          const project = await new TeamLibrary(context.globalStorageUri.fsPath).find('project', root).catch(() => undefined);
          const redTeam = project ? teamAgents(project).filter((agent) => agent.name === 'red-team') : [];
          redTeamStep = { addendum: RED_TEAM_WORKFLOW_STEP, agents: redTeam };
        }
        panel.webview.postMessage({ type: 'commands', commands: await commandList(gsdHost, context.globalStorageUri.fsPath, root) });
      } else {
        gsd = await gsdHost.context();
      }
    } catch (error) {
      tab.post({ type: 'assistant-error', text: providerErrorMessage(error) });
      return;
    }
    const text = message.type === 'send' ? message.text : team ? `/team:${team.slug} ${message.args ?? ''}`.trim() : `/${skill!.name}${skill!.args ? ` ${skill!.args}` : ''}`;
    // Attachments the user staged for this message.
    const staged = message.type === 'send' ? (message.attachmentIds ?? []).map((id) => state.attachments.get(id)).filter((item): item is StagedAttachment => Boolean(item)) : [];
    const agentModels = readAgentModels();
    if (readSettings().privacyMode === 'tee-only') {
      const needs = [...(staged.some((item) => item.kind === 'image') && !(modelInfo?.inputModalities ?? []).includes('image') ? [agentModels.visionModel] : []), ...(staged.some((item) => item.kind === 'audio') ? [agentModels.transcriptionModel] : [])];
      const forwarded = needs.find((id) => active.models.find((candidate) => candidate.id === id)?.privacyBoundary !== 'tee');
      if (forwarded) { tab.post({ type: 'outbound-blocked', text, model, reason: `TEE-only mode is on, and ${forwarded}, which would read your attachment, does not run in NEAR's TEE.`, confirm: false }); return; }
    }
    state.activity = state.activity ?? new ActivityStore(root);
    const settings = readSettings();
    if (!state.guard || state.guardSettings !== JSON.stringify([settings.privacyMode, settings.dailySpendLimitUsd, settings.actionPolicy])) {
      state.guard = new OutboundGuard(settings);
      state.guardSettings = JSON.stringify([settings.privacyMode, settings.dailySpendLimitUsd, settings.actionPolicy]);
    }
    // Documents are checked by their extracted text, which is what is sent.
    const attachedText = staged.map((item) => item.kind === 'text' ? item.bytes.toString('utf8') : item.kind === 'document' ? item.text ?? '' : '').filter(Boolean).join('\n');
    // Today's spend from the key's ledger (or NEAR's own total), never from activity history.
    const account = spendAccountOf(active.provider.client);
    followSpend(account);
    // Picks up what other windows on this computer spent with the same key.
    await account?.ledger.refresh();
    const spentToday = account?.spentTodayUsd().usd ?? 0;
    const verdict = state.guard.check({ model, modelInfo, text: attachedText ? `${text}\n${attachedText}` : text, overrideToken: message.type === 'send' ? message.overrideToken : undefined }, spentToday);
    // One run, with all its sub-agents, may spend at most the per-run cap and what is left of today's limit.
    const runBudget = readRunBudget();
    if (settings.dailySpendLimitUsd > 0) runBudget.maxCostUsd = Math.max(0, Math.min(runBudget.maxCostUsd, settings.dailySpendLimitUsd - spentToday));
    if (verdict.outcome !== 'allow') {
      tab.post({ type: 'outbound-blocked', text, model, reason: verdict.reason, overrideToken: message.type === 'send' ? verdict.overrideToken : undefined, confirm: verdict.outcome === 'confirm' });
      return;
    }
    if (stopped()) return;
    tab.model = model;
    tab.modelInfo = modelInfo;
    const attribution = hostAttribution(active.profiles.projectScopeId, path.basename(root), active.profile.profileId, active.profile.organization);
    const agent = ensureAgent(tab, root);
    const runId = AgentConversation.newRunId();
    const conversationId = agent.id;
    const title = runTitleFor(text);
    const session = await state.activity.start({ project: path.basename(root), attribution, model, runId, conversationId, ...(title ? { title } : {}), ...(skill ? { plans: [skill.name] } : {}), summary: skill ? `/${skill.name} started.` : 'Agent conversation turn started.' });
    try {
      const route = clientFor(active, model);
      const limits = readAgentLimits();
      let attachments;
      if (staged.length) {
        try {
          // Reading attachments (vision, transcription) is billed to the run they are for.
          attachments = await withSpendTag({ kind: 'attachment', runId, conversationId }, () => prepareAttachments(staged, { client: route.client, model, models: active.models, visionModel: agentModels.visionModel, transcriptionModel: agentModels.transcriptionModel, question: text }));
        } catch (error) {
          tab.post({ type: 'assistant-error', text: providerErrorMessage(error) });
          return;
        }
        for (const item of staged) state.attachments.delete(item.id);
        panel.webview.postMessage({ type: 'attachments-cleared' });
      }
      state.memory = state.memory ?? new ContextGraphMemory(root, { trustedActorIds: [AGENT_MEMORY_ACTOR] });
      const delegable = modelsAsPrivateAs(active.models, modelInfo);
      // MCP tools are optional for a message: if they can't be prepared, it is sent without them.
      const mcp = await (async () => { try { return await mcpRegistry(context).agentTools(); } catch (error) { return { tools: [], problems: [`MCP tools are unavailable: ${(error as Error).message}`] }; } })();
      for (const problem of mcp.problems) tab.post({ type: 'notice', text: problem });
      const imageModel = delegable.find((candidate) => candidate.id === agentModels.imageModel && (candidate.outputModalities ?? []).includes('image'));
      // Auto approve's safety model must run privately; without one, unclear commands ask.
      const safetyModel = settings.actionPolicy.mode === 'auto' ? privateSafetyModel(active.models, modelInfo, readSafetyModel()) : undefined;
      if (settings.actionPolicy.mode === 'auto' && !safetyModel && !warnedSafetyModels.has(`${model}|${readSafetyModel()}`)) {
        warnedSafetyModels.add(`${model}|${readSafetyModel()}`);
        tab.post({ type: 'notice', text: `Auto approve: ${readSafetyModel()} is not available as a private (TEE) model here, so commands the rules cannot decide will ask you.` });
      }
      if (stopped()) { await state.activity.append(session.sessionId, { status: 'cancelled', summary: 'Stopped before the run started.' }); return; }
      await agent.send({ text, skill, gsd, team, attachments, memory: { store: state.memory, projectScope: { kind: 'project', id: projectIdForWorkspace(root) } }, imageModel: route.local ? undefined : imageModel, reputation: new ReputationStore(root), tiers: readModelTiers(), roleModels: readRoleModels(), safetyModel, availableModels: delegable.map((candidate) => candidate.id), contextWindows: Object.fromEntries(active.models.map((candidate) => [candidate.id, candidate.contextLength])), maxParallelAgents: limits.maxParallelAgents, maxTurns: limits.maxTurns, client: route.client, model, privacy: modelPrivacyLabel(modelInfo), policy: settings.actionPolicy, rules: readAgentRules(), activity: { store: state.activity, sessionId: session.sessionId }, local: route.local, security: securityAccess(context, root), webSearch: await webSearchProvider(context.secrets), budget: runBudget, mcpTools: mcp.tools, maxOutputTokens: Math.max(1_000, Math.min(1_000_000, Number(vscode.workspace.getConfiguration('nearAi').get<number>('agent.maxOutputTokens', AGENT_DEFAULTS.maxOutputTokens)) || AGENT_DEFAULTS.maxOutputTokens)), shellEnvAllow: vscode.workspace.getConfiguration('nearAi').get<string[]>('agent.shellEnvAllow', []).filter((name) => typeof name === 'string'), runId, ...(redTeamStep ? { skillAddendum: redTeamStep.addendum, projectAgents: redTeamStep.agents } : {}) });
      panel.webview.postMessage(await statusMessage({ agents: runningAgents(), account }));
      await sendArtifacts(panel);
    } catch (error) {
      await state.activity.append(session.sessionId, { status: 'failed', summary: 'Agent run failed.', errorCode: error instanceof Error ? error.name : 'unknown' });
      tab.post({ type: 'assistant-error', text: providerErrorMessage(error) });
    }
  };
  // A message typed while a turn is in progress steers it: the running agent sees it before its
  // next model request. Once nothing is running it is an ordinary new message.
  const steer = async (message: Extract<ChatWebviewMessage, { type: 'steer' }>, tab: ChatTab): Promise<void> => {
    if (!tab.turns && !tab.agent?.running) {
      tab.post({ type: 'steer-state', id: message.id, state: 'sent-new' });
      await receive({ type: 'send', text: message.text, conversationId: tab.id, ...(tab.model ? { model: tab.model } : {}) });
      return;
    }
    const root = workspaceRoot();
    if (!root) return;
    // It goes to the provider like any message, so it passes the same outbound check.
    let reason: string | undefined;
    if (isEmergencyStopped()) reason = 'Emergency stop is on. Run "NEAR AI: Resume" to continue.';
    else {
      const guard = state.guard ?? new OutboundGuard(readSettings());
      const verdict = guard.check({ model: tab.model ?? '', modelInfo: tab.modelInfo, text: message.text }, state.spend?.spentTodayUsd().usd ?? 0);
      if (verdict.outcome !== 'allow') reason = `${verdict.reason} It was not sent to the running agent; send it after the run to choose what to do.`;
    }
    if (reason) { tab.post({ type: 'steer-state', id: message.id, state: 'blocked', reason, text: message.text }); return; }
    tab.steerTexts.set(message.id, message.text);
    ensureAgent(tab, root).steer(message.id, message.text);
  };
  const receive = async (value: unknown): Promise<void> => {
    await ready;
    const message = parseChatWebviewMessage(value);
    if (!message) return;
    // A message for a conversation that has been closed is dropped; one naming none is for the one on screen.
    const tab = tabFor((message as { conversationId?: string }).conversationId);
    if (!tab) return;
    if (message.type === 'steer') { await steer(message, tab); return; }
    const turn = message.type === 'send' || message.type === 'open-command';
    if (turn) { tab.turns += 1; sendSummary(); }
    try {
      await handle(message, tab);
    } finally {
      if (turn) { tab.turns -= 1; sendSummary(); }
    }
    if (tab.closing) { if (!tab.turns && !tab.agent?.running) tab.agent?.dispose(); return; }
    // Messages queued for a run that ended before taking them become the next turn, in order.
    if (!turn || tab.turns || tab.agent?.running) return;
    const left = tab.agent?.takeUndelivered() ?? [];
    if (!left.length) return;
    for (const item of left) tab.post({ type: 'steer-state', id: item.id, state: 'sent-new' });
    await receive({ type: 'send', text: left.map((item) => item.text).join('\n\n'), conversationId: tab.id, ...(tab.model ? { model: tab.model } : {}) });
  };
  panel.webview.onDidReceiveMessage(receive, undefined, context.subscriptions);
  // The picker follows settings.json edits and the emergency stop; each run reads the setting afresh.
  const policyWatch = vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('nearAi.actionPolicy')) sendPolicyState(panel); });
  // Setting or clearing the usage reporting token (anywhere) updates the spend line's link.
  const tokenWatch = onReportingTokenChange(() => { void statusMessage({ agents: runningAgents(), account: state.spend }).then((status) => panel.webview.postMessage(status)); });
  panel.onDidDispose(() => { disposed = true; for (const tab of tabs) tab.agent?.dispose(); policyWatch.dispose(); tokenWatch.dispose(); state.spendWatch?.dispose(); if (state.spendTimer) clearTimeout(state.spendTimer); }, undefined, context.subscriptions);
  // The emergency stop stops every conversation's run; the composer's Stop stops only the one on screen.
  onDidChangeEmergencyStop(async (engaged) => {
    sendPolicyState(panel);
    if (!engaged) return;
    const status = await readGsdStatusLine();
    for (const tab of [...tabs]) {
      const shown = tab.id === activeId;
      const was = isRunning(tab);
      tab.stops += 1;
      tab.agent?.stop();
      if (was || shown) tab.post({ type: 'assistant-cancelled', status });
    }
  }, undefined, context.subscriptions);
  sendPolicyState(panel);
  if (initialPrompt) panel.webview.postMessage({ type: 'prefill', text: initialPrompt });
  followSpend(await spendAccountForRoot(workspaceRoot(), auth));
  panel.webview.postMessage(await statusMessage({ agents: 0, account: state.spend }));
  panel.webview.postMessage({ type: 'commands', commands: await commandList(gsdHostFor(context), context.globalStorageUri.fsPath, workspaceRoot()) });
  await sendArtifacts(panel);
  await ready;
  state.activity = createActivityStore();
  await sendProfileStatus(panel, auth);
  await loadModels(panel, auth);
}

/** How the close picker describes each conversation. */
const STATUS_WORDS: Record<ConversationStatus, string> = { idle: 'new', running: 'running', waiting: 'waiting for you', done: 'done', error: 'stopped with an error', stopped: 'stopped' };

export async function openGsdArtifact(root: string, requested: Pick<GsdArtifactLink, 'path' | 'kind'>, artifacts: GsdArtifactLink[]): Promise<boolean> {
  const artifact = artifacts.find((candidate) => candidate.path === requested.path);
  if (!artifact || artifact.kind !== requested.kind || !isSafeArtifactPath(root, requested.path)) return false;
  const candidate = path.resolve(root, requested.path);
  const workspaceRoot = await fs.realpath(root).catch(() => path.resolve(root));
  const resolved = await fs.realpath(candidate).catch(() => undefined);
  if (!resolved || (resolved !== workspaceRoot && !resolved.startsWith(`${workspaceRoot}${path.sep}`))) return false;
  const stats = await fs.stat(resolved).catch(() => undefined);
  if (requested.kind === 'directory') {
    if (!stats?.isDirectory()) return false;
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(resolved));
    return true;
  }
  if (!stats?.isFile()) return false;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
  await vscode.window.showTextDocument(document, { preview: true });
  return true;
}

async function insertIntoActiveEditor(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { void vscode.window.showInformationMessage('Open a file to insert code at the cursor.'); return; }
  await editor.edit((edit) => editor.selections.forEach((selection) => edit.replace(selection, text)));
}

function ripgrepPath(): string | undefined {
  const appRoot = (vscode.env as { appRoot?: string } | undefined)?.appRoot;
  return appRoot ? findRipgrep(appRoot, (candidate) => existsSync(candidate)) : undefined;
}

function conversationFor(context: vscode.ExtensionContext, root: string, panel: ChatHost, post: (message: Record<string, unknown>) => void, title: () => string): AgentConversation {
  const storage = context.globalStorageUri.fsPath;
  const transcripts = readAgentLimits().saveTranscripts ? new TranscriptStore(storage, root, sharedTranscriptKey(context.secrets)) : undefined;
  const forward = (outbound: Record<string, unknown>) => {
    post(outbound);
    // An agent held for approval or an answer waits; say so when the chat isn't on screen.
    if ((outbound.type === 'approval-request' || outbound.type === 'questions-request') && (panel as { visible?: boolean }).visible === false) {
      const text = outbound.type === 'approval-request' ? `An agent in "${title()}" is waiting for your approval: ${String(outbound.title ?? 'an action')}` : `NEAR AI has a question for you in "${title()}" and is waiting for the answer.`;
      void vscode.window.showWarningMessage(text, 'Show chat').then((choice) => { if (choice) void vscode.commands.executeCommand('nearAiChatView.focus'); });
    }
  };
  const conversation = new AgentConversation(root, forward, path.join(storage, 'checkpoints'), ripgrepPath(), transcripts, sharedActivityFeed());
  const minutes = vscode.workspace.getConfiguration('nearAi').get<number>('agent.approvalTimeoutMinutes', AGENT_DEFAULTS.approvalTimeoutMinutes);
  conversation.approvalTimeoutMs = Math.max(0, Math.min(1_440, typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : AGENT_DEFAULTS.approvalTimeoutMinutes)) * 60_000;
  return conversation;
}

/** The view's badge while prompts wait for the user, in one conversation or several. */
export function waitingBadge(count: number, conversations = 1): { value: number; tooltip: string } | undefined {
  if (count <= 0) return undefined;
  return { value: count, tooltip: conversations > 1 ? `NEAR AI is waiting for you in ${conversations} conversations` : 'NEAR AI is waiting for you' };
}

function showWaitingBadge(panel: ChatHost, count: number, conversations: number): void {
  if ('badge' in panel) (panel as { badge?: { value: number; tooltip: string } }).badge = waitingBadge(count, conversations);
}

/** One GSD host per extension storage folder, shared by the sidebar chat and the Tools tab. */
const gsdHosts = new Map<string, GsdHost>();
export function gsdHostFor(context: vscode.ExtensionContext): GsdHost {
  const storage = context.globalStorageUri.fsPath;
  let host = gsdHosts.get(storage);
  if (!host) { host = new GsdHost(storage); gsdHosts.set(storage, host); }
  return host;
}

/** Slash commands for the composer: the installed skills, or the core workflows before the first install. */
async function commandList(host: GsdHost, storageDir?: string, root?: string): Promise<Array<{ command: string; title: string; description: string; argumentHint?: string }>> {
  const teams = storageDir ? (await new TeamLibrary(storageDir).list(root).catch(() => [])).flatMap((entry) => entry.team ? [{ command: `team:${entry.project ? 'project' : entry.team.slug}`, title: entry.team.name, description: `Run the "${entry.team.name}" team${entry.team.description ? ` — ${entry.team.description}` : ''}`, argumentHint: '<task for the team>' }] : []) : [];
  return [...teams, ...await gsdCommandList(host)];
}

async function gsdCommandList(host: GsdHost): Promise<Array<{ command: string; title: string; description: string; argumentHint?: string }>> {
  const installed = await host.commands().catch(() => []);
  if (installed.length) return installed.map((command) => ({ command: command.name, title: command.name, description: command.description, ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}) }));
  return GSD_COMMANDS.map((definition) => ({ command: `gsd-${definition.command}`, title: definition.title, description: definition.description }));
}

function createActivityStore(): ActivityStore | undefined {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? new ActivityStore(root) : undefined;
}

function projectIdForWorkspace(root: string): string { return projectMemoryScope(root).id; }
async function sendArtifacts(panel: ChatHost): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  panel.webview.postMessage({ type: 'artifacts', artifacts: root ? await discoverGsdArtifacts(root) : [] });
}



const FULL_AUTO_CONFIRM = 'Switch to Full auto';

function policyConfiguration(): PolicyConfiguration {
  return vscode.workspace.getConfiguration('nearAi');
}

function sendPolicyState(panel: ChatHost): void {
  panel.webview.postMessage(policyStateMessage(policyConfiguration(), isEmergencyStopped()));
}

async function loadModels(panel: ChatHost, auth: AuthService): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    const active = root ? await activeProvider(root, auth) : undefined;
    panel.webview.postMessage({ type: 'models', models: active ? modelOptions(active.models, readSettings().defaultModel) : [] });
  } catch (error) {
    panel.webview.postMessage({ type: 'models-error', text: providerErrorMessage(error) });
  }
}

async function sendProfileStatus(panel: ChatHost, auth: AuthService, existing?: ProfileStore): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    panel.webview.postMessage({ type: 'profile-status', value: profileStatusMessage([], 'No workspace', undefined, false) });
    return;
  }
  const profiles = existing ?? new ProfileStore(root, auth);
  const exported = await profiles.exportMetadata();
  const active = exported.activeProfileId;
  const configured = active ? Boolean(await auth.getScopedApiKey(profiles.getScope(active))) : false;
  const value = profileStatusMessage(exported.profiles, exported.projectId, active, configured);
  panel.webview.postMessage({ type: 'profile-status', value });
}

/** The status line with today's spend from the key's ledger (or NEAR's total), and what the figure means. */
async function statusMessage(live: { agents: number; account?: SpendAccount }): Promise<{ type: 'status'; value: string; tooltip?: string; token?: ReturnType<typeof hintForView> }> {
  const account = live.account ?? shownSpendAccount();
  const today = account?.today();
  const shown = today && (today.near || today.totals.requests > 0) ? today : undefined;
  // With a NEAR AI Cloud key, the spend line links to the usage reporting token (local runtimes have no NEAR bill).
  const hint = account ? await currentReportingTokenHint() : undefined;
  return { type: 'status', value: await readGsdStatusLine({ agents: live.agents, spend: shown?.text }), ...(shown ? { tooltip: shown.tooltip } : {}), ...(hint ? { token: hintForView(hint) } : {}) };
}

async function readGsdStatusLine(live?: { agents: number; spend?: string }): Promise<string> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return 'No workspace';
  const statePath = path.join(root, '.planning', 'STATE.md');
  const roadmapPath = path.join(root, '.planning', 'ROADMAP.md');
  let line: string;
  try {
    const [state, roadmap] = await Promise.all([fs.readFile(statePath, 'utf8'), fs.readFile(roadmapPath, 'utf8')]);
    line = formatGsdStatusLine(statusSnapshot(parseGsdPlanningState(state, roadmap)));
  } catch {
    line = 'No GSD project yet · type /gsd-new-project to start · Agents 0';
  }
  if (!live?.spend) { const today = shownSpendAccount()?.today(); if (today && (today.near || today.totals.requests > 0)) live = { agents: live?.agents ?? 0, spend: today.text }; }
  return withLiveStatus(line, { agents: live?.agents ?? 0, spend: live?.spend });
}
