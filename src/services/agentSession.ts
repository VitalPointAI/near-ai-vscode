import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { compactConversation, contextStatus, DEFAULT_CONTEXT_WINDOW, DEFAULT_THRESHOLDS, estimateTokens, trimOldToolResults } from '../agent/context';
import { AgentEvent, AgentRun, AgentRunError, ApprovalReply, ApprovalRequest, RunInput, RunResult } from '../agent/loop';
import { PermissionRules, RunGrants } from '../agent/permissions';
import { SafetyModelCheck } from '../agent/safetyModel';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt, projectInstructions } from '../agent/systemPrompt';
import { GRAPHICS_TOOLS } from '../agent/graphicsTools';
import { grantsMcpTool } from '../mcp/tools';
import { checkCitationsTool, webFetchTool, webSearchTool } from '../agent/webTools';
import type { SearchProvider } from '../agent/webSearch';
import { SecurityAccess, securityTool } from '../agent/securityTool';
import { AgentTool, CORE_TOOLS, Todo, ToolContext } from '../agent/tools';
import { TaskBoard } from '../agent/taskBoard';
import { displayPath } from '../agent/workspace';
import { AgentWorktree, createAgentWorktree, finishAgentWorktree, worktreeReport } from '../agent/worktree';
import type { ActionPolicy } from '../domain/policy';
import { expandPrompt, GsdAgent, GsdSkill, modelForTier, roleModelFor } from '../gsd/library';
import { trustedPreambles } from '../gsd/preamble';
import { gsdTools, Question } from '../gsd/tools';
import type { ActivityFeed } from './agentActivity';
import type { ActivityStore } from './activityStore';
import { saveHandoff } from './handoff';
import type { AgentMessage, ModelInfo, NearAiClient, UsageMetadata } from './nearAiClient';
import { TranscriptStore } from './transcripts';
import { NOT_CHECKED_IN_EDITOR, type ResponseEvidence, type VerificationResult } from './attestation';
import { PreparedAttachments } from '../agent/attachments';
import { imageTool, memoryPreamble, memoryTools } from '../agent/extraTools';
import { TeamDefinition, teamAgents, teamLeadPrompt } from '../agent/teams';
import type { MemoryScope } from '../domain/contextGraph';
import type { AgentRole } from '../domain/agents';
import type { ContextGraphMemory } from './contextGraphMemory';
import type { ReputationStore } from './reputation';
import { SpendAccount } from './spendAccount';
import { nanoToUsd, totalNanoUsd, withSpendTag } from './spendLedger';

/** What the installed Open-GSD runtime provides to a conversation. */
export interface GsdContext {
  home: string;
  skills: GsdSkill[];
  agents: GsdAgent[];
  shellEnv: NodeJS.ProcessEnv;
}

export interface ModelTiers { deep: string; standard: string; fast: string }

export interface AgentTurnRequest {
  /** What the user typed, shown in the transcript. */
  text: string;
  /** Run an installed skill: its expanded instructions become the turn's prompt. */
  skill?: { name: string; args: string };
  client: NearAiClient;
  model: string;
  privacy: string;
  policy: ActionPolicy;
  rules: PermissionRules;
  activity?: { store: ActivityStore; sessionId: string };
  /** A local runtime has no billing API to ask for actual costs. */
  local?: boolean;
  gsd?: GsdContext;
  /** NEAR models for GSD's model tiers; a tier model the provider lacks falls back to `model`. */
  tiers?: ModelTiers;
  availableModels?: string[];
  /** The model's context window in tokens, from the catalog. */
  contextWindows?: Record<string, number | undefined>;
  maxParallelAgents?: number;
  maxTurns?: number;
  /** Run a team: a lead agent delegates `text` to the team's members. */
  team?: TeamDefinition;
  /** Attachments already read (text inlined, images described, audio transcribed). */
  attachments?: PreparedAttachments;
  /** Project memory: relevant facts start each turn, and Remember/Recall are available. */
  memory?: { store: ContextGraphMemory; projectScope: MemoryScope };
  /** The provider's image model, when it has one; enables GenerateImage. */
  imageModel?: ModelInfo;
  reputation?: ReputationStore;
  /** Dependency vulnerability checks for the SecurityScan tool. */
  security?: SecurityAccess;
  /** The WebSearch tool's provider; without one, WebSearch says search is not set up. */
  webSearch?: SearchProvider;
  /** Added after a GSD skill's instructions (e.g. the project's red-team stage). */
  skillAddendum?: string;
  /** Project team members a GSD workflow may spawn by name (e.g. red-team). */
  projectAgents?: GsdAgent[];
  /** Tools of the MCP servers switched on for this project. */
  mcpTools?: AgentTool<any>[];
  /** Caps for the whole run (the agent and all its sub-agents), checked before every model turn. */
  budget?: { maxCostUsd: number; maxTokens: number };
  /** Environment variables to pass to the agent's shell even though they look like credentials. */
  shellEnvAllow?: string[];
  /** Output tokens one reply may use (nearAi.agent.maxOutputTokens). */
  maxOutputTokens?: number;
  /** The auto mode's private safety model; without one, commands the rules cannot decide ask. */
  safetyModel?: string;
  /** Model or tier per agent role (nearAi.agent.roleModels); a team member's own model line wins. */
  roleModels?: Record<string, string>;
  /** The run's ID, when the host already tagged spend for it (attachments read before the run). */
  runId?: string;
}

/** The spend account of a client, when spend tracking is on for it. */
export function spendAccountOf(client: unknown): SpendAccount | undefined {
  const spend = (client as { spend?: unknown } | undefined)?.spend;
  return spend instanceof SpendAccount ? spend : undefined;
}

type Record_ = (event: Parameters<ActivityStore['append']>[1]) => Promise<unknown>;

interface LiveAgent {
  id: string;
  label: string;
  description: string;
  model: string;
  abort: AbortController;
  paused: boolean;
  resume?: () => void;
  background: boolean;
  /** What it is doing now, for the agents strip and progress lines. */
  activity: string;
  activitySince: number;
  /** The last tool it ran, shown while it thinks about the result. */
  lastAction?: string;
  startedAt: number;
  toolCalls: number;
  turns: number;
  /** The sub-agent's own TodoWrite list, shown as steps in its row (not in the main task list). */
  todos?: Todo[];
}

/** A sub-agent's task list as its row shows it: done of total, and the step in progress. */
export function agentSteps(todos: Todo[]): { done: number; total: number; active?: string } {
  const active = todos.find((todo) => todo.status === 'in_progress');
  return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length, ...(active ? { active: active.activeForm || active.content } : {}) };
}

/** A message the user sent while a run was going. */
export interface SteerMessage { id: string; text: string }

/** How a message sent during a run reaches the agent: marked, so it knows it is new direction. */
export function steeringContent(text: string): string {
  return `<user-message-during-run>\n${text}\n</user-message-during-run>\nThe user sent this while you were working. It is new direction: it takes precedence over your current plan, so adjust what you are doing (or stop and answer) and say briefly how you changed course.`;
}

const minutesSince = (at: number) => { const seconds = Math.max(0, Math.round((Date.now() - at) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)} min`; };

/**
 * One sidebar conversation with the agent. Keeps the message history (saved locally so it can be
 * resumed) and a persistent shell, routes approvals and questions to the webview, runs GSD skills
 * and sub-agents (foreground or background, with pause/stop and a concurrency limit), manages the
 * context window, and keeps each run's file checkpoints so the user can revert it.
 */
export class AgentConversation {
  private messages: AgentMessage[] = [];
  private readonly verifiable = new Map<string, { model: string; evidence: ResponseEvidence; client: NearAiClient }>();
  /** What the user typed, keyed by a hash of the message the model saw (survives compaction). */
  private display = new Map<string, string>();
  private conversationId = newConversationId();
  private title = '';
  private shell: ShellSession | undefined;
  private shellEnvAllow: string[] = [];
  private shellEnvKey = '';
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (reply: ApprovalReply, cancelled?: boolean) => void>();
  private readonly questions = new Map<string, (answers: string[], cancelled?: boolean) => void>();
  /** Approvals and questions waiting for the user, oldest first, as they were posted (replayed when the view reloads). */
  private readonly waiting = new Map<string, Record<string, unknown>>();
  /** Told how many prompts are waiting whenever that changes, so the host can badge the view. */
  public onWaitingChange: ((count: number) => void) | undefined;
  private readonly runs = new Map<string, RunCheckpoints>();
  private readonly agents = new Map<string, LiveAgent>();
  private readonly background = new Set<Promise<void>>();
  private notifications: AgentMessage[] = [];
  /** The main run's task list; sub-agents started for one of its items move that item along. */
  private readonly tasks = new TaskBoard();
  /** Messages the user sent while a run was going, oldest first, until a model request takes them. */
  private steering: SteerMessage[] = [];
  private readonly steerListeners = new Set<() => void>();
  private slotWaiters: Array<() => void> = [];
  private slotsInUse = 0;
  private contextWarned = false;
  private agentsTimer: ReturnType<typeof setTimeout> | undefined;
  private lastVisibleAt = Date.now();
  private heartbeats = 0;
  /** A progress line after this long without visible output, then at the longer interval while it stays quiet. */
  public progressTiming = { firstMs: 60_000, everyMs: 120_000, checkMs: 15_000 };
  /** Estimated cost and tokens of the current run, across the agent and its sub-agents. */
  /** The current run's auto-mode safety check, shared with its sub-agents. */
  private runSafety: SafetyModelCheck | undefined;
  private spend = { costUsd: 0, tokens: 0, totalTokens: 0, cachedTokens: 0, stopped: false };
  /** The current run's ID and the key's spend ledger: run cost, the run budget, and progress lines read it. */
  private runSpendSource: { runId: string; account: SpendAccount } | undefined;

  public constructor(
    private readonly root: string,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly checkpointDir: string,
    private readonly ripgrepPath?: string,
    private readonly transcripts?: TranscriptStore,
    private readonly activity?: ActivityFeed
  ) {}

  /** Where sub-agents' git worktrees live: the extension's storage, never the project. */
  private get worktreeDir(): string { return path.join(path.dirname(this.checkpointDir), 'worktrees'); }

  public get running(): boolean { return Boolean(this.abort); }
  /** This conversation's ID (spend for "this conversation" is tagged with it). */
  public get id(): string { return this.conversationId; }
  /** A new run ID, for spend the host records before the run starts (attachments). */
  public static newRunId(): string { return `run-${Date.now()}-${randomBytes(3).toString('hex')}`; }
  public get runningAgents(): number { return this.agents.size; }

  public async send(request: AgentTurnRequest): Promise<void> {
    // Messages queued while this turn was being prepared stay queued: the run delivers them.
    this.halt();
    const abort = new AbortController();
    this.abort = abort;
    this.spend = { costUsd: 0, tokens: 0, totalTokens: 0, cachedTokens: 0, stopped: false };
    const runId = request.runId ?? AgentConversation.newRunId();
    const account = request.local ? undefined : spendAccountOf(request.client);
    this.runSpendSource = account ? { runId, account } : undefined;
    const checkpoints = new RunCheckpoints(runId, this.checkpointDir);
    this.runs.set(runId, checkpoints);
    this.shellEnvAllow = request.shellEnvAllow ?? [];
    const shell = this.shellFor(request.gsd?.shellEnv ?? {});
    const freshConversation = !this.messages.length;
    if (freshConversation) this.messages.push({ role: 'system', content: this.systemPrompt(request) });
    if (!this.title) this.title = request.text.replace(/\s+/g, ' ').slice(0, 80);
    let prompt = request.text;
    if (request.team) prompt = teamLeadPrompt(request.team, request.text.replace(/^\/team:\S+\s*/, ''));
    if (request.skill && request.gsd) {
      const skill = findSkill(request.gsd.skills, request.skill.name);
      if (!skill) throw new Error(`Open-GSD has no skill named ${request.skill.name}.`);
      prompt = `The user ran /${skill.name}${request.skill.args ? ` ${request.skill.args}` : ''}. Follow these instructions:\n\n${await expandPrompt(skill.body, { args: request.skill.args, home: request.gsd.home, root: this.root })}${request.skillAddendum ?? ''}`;
    }
    const extraUsage: UsageMetadata[] = [...(request.attachments?.usage ?? [])];
    if (request.attachments?.text) prompt = `${request.attachments.text}\n\n${prompt}`;
    const remembered = request.memory ? await memoryPreamble(request.memory.store, request.memory.projectScope, request.text).catch(() => undefined) : undefined;
    if (remembered) prompt = `<project-memory>\n${remembered}\n</project-memory>\n\n${prompt}`;
    this.display.set(contentKey(prompt), request.text);
    this.messages.push({ role: 'user', content: prompt });
    const mainId = `main-${runId}`;
    this.activity?.agentStarted({ agentId: mainId, agent: request.skill ? `/${request.skill.name}` : request.team ? `team:${request.team.slug}` : 'agent', runId, model: request.model }, prompt, freshConversation ? String(this.messages[0].content) : undefined);
    this.post({ type: 'assistant-start', model: request.model, privacy: request.privacy });
    for (const note of request.attachments?.notes ?? []) this.post({ type: 'notice', text: note });
    const record: Record_ = (event) => request.activity ? request.activity.store.append(request.activity.sessionId, event).catch(() => undefined) : Promise.resolve();
    const grants = new RunGrants();
    // Attached files are outside content, so the run starts out treated as having read some.
    if (request.attachments?.text) grants.tainted = true;
    for (const event of request.attachments?.security ?? []) this.activity?.security(mainId, event);
    const context: Omit<ToolContext, 'signal' | 'onTodos'> = { root: this.root, checkpoints, shell, readFiles: new Set(), pages: new Map(), ripgrepPath: this.ripgrepPath, readOnlyRoots: request.gsd ? [request.gsd.home] : [], trustedToolRoots: request.gsd ? [request.gsd.home] : [], ...(request.gsd ? { gsdRuntime: { home: request.gsd.home, preambles: await trustedPreambles(request.gsd.home) } } : {}) };
    const tools = this.toolsFor(request, context, grants, extraUsage, record, abort.signal, runId);
    // One safety check per run, shared with sub-agents, so each command is asked about once.
    const safety = request.policy.mode === 'auto' && request.safetyModel ? new SafetyModelCheck({ client: request.client, model: request.safetyModel, task: request.text, onUsage: (usage) => extraUsage.push(usage) }) : undefined;
    this.runSafety = safety;
    const run = new AgentRun({
      client: request.client,
      model: request.model,
      tools,
      context,
      policy: request.policy,
      rules: request.rules,
      grants,
      safety,
      maxTurns: request.maxTurns,
      maxOutputTokens: request.maxOutputTokens,
      beforeTurn: async (transcript, lastUsage, signal) => {
        this.enforceBudget(request, abort);
        const pending = this.drainNotifications();
        const managed = await this.manageContext(pending.length ? [...transcript, ...pending] : transcript, lastUsage, request, signal, true);
        return managed ?? (pending.length ? [...transcript, ...pending] : undefined);
      },
      afterAnswer: async (_transcript, signal) => this.waitForBackground(signal),
      input: this.steeringInput,
      requestApproval: (approval) => this.askApproval(approval, abort.signal),
      emit: (event) => {
        this.track(mainId, event);
        if (event.type !== 'reasoning' && event.type !== 'turn') this.markVisible();
        if (event.type === 'todos') this.post({ type: 'todos', todos: this.tasks.write(event.todos) });
        else this.forward(event, request.model, record);
      }
    });
    const runStartedAt = Date.now();
    let costAsked = false;
    this.markVisible();
    const heartbeat = setInterval(() => this.heartbeat(runStartedAt), this.progressTiming.checkMs);
    try {
      let result: RunResult;
      try {
        // Every NEAR request the run makes (sub-agents, safety checks, summaries included) is tagged with it.
        result = await withSpendTag({ kind: 'main', runId, conversationId: this.conversationId, agentId: mainId }, () => run.run(this.messages, abort.signal));
      } catch (error) {
        this.activity?.agentEnded(mainId, 'failed', error instanceof Error ? error.message : String(error));
        // Keep what the run did, so the next message continues from there.
        if (error instanceof AgentRunError) { this.messages = error.messages; throw error.cause; }
        throw error;
      }
      this.activity?.agentEnded(mainId, result.outcome);
      this.messages = result.messages;
      const allUsage = [...result.usage, ...extraUsage];
      const usage = sumUsage(allUsage);
      // The run's cost is the ledger's sum over every request it made, not just its model turns.
      if (account) usage.estimatedCostUsd = nanoToUsd(totalNanoUsd(account.totals({ runId })));
      const changed = checkpoints.changedFiles.map((file) => displayPath(this.root, file));
      if (result.outcome === 'cancelled') this.post({ type: 'assistant-cancelled' });
      else {
        if (result.outcome === 'max-turns') this.post({ type: 'assistant-delta', text: '\n\n_Stopped after reaching the turn limit. Send a message to continue._' });
        this.post({ type: 'assistant-done', usage, runId, ...(account ? { spend: spendLine(account.window('run', { runId })) } : {}) });
        const evidence = result.usage.at(-1)?.evidence;
        if (evidence && !request.local && request.privacy.startsWith('Private')) {
          this.verifiable.set(runId, { model: request.model, evidence, client: request.client });
          for (const old of [...this.verifiable.keys()].slice(0, -20)) this.verifiable.delete(old);
          this.post({ type: 'response-verifiable', runId });
        }
      }
      if (changed.length) this.post({ type: 'run-changes', runId, files: changed });
      await record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'message', model: request.model, summary: `${request.skill ? `/${request.skill.name} run` : 'Agent run'} ${result.outcome}; ${changed.length} file(s) changed.`, estimatedCostUsd: usage.estimatedCostUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      await this.saveTranscript(request.model);
      const ids = allUsage.map((turn) => turn.requestId).filter((id): id is string => Boolean(id));
      if (account) {
        if (result.outcome !== 'cancelled') { costAsked = true; await this.reportRunCost(account, runId, request.model, record); }
      } else if (result.outcome !== 'cancelled' && ids.length && !request.local) {
        const actual = await request.client.actualCostsUsd(ids).catch(() => undefined);
        if (actual !== undefined) {
          this.post({ type: 'assistant-cost', actualCostUsd: actual });
          await record({ status: 'completed', kind: 'model', model: request.model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd: actual });
        }
      }
    } finally {
      clearInterval(heartbeat);
      if (this.abort === abort) this.abort = undefined;
      this.releasePending();
      // Stopped or failed runs are reconciled too: NEAR bills what they used.
      if (account && !costAsked) void account.settleNow((entry) => entry.runId === runId);
    }
  }

  /**
   * Asks NEAR for the run's actual cost at once; the footer shows it when every request is settled,
   * now or (NEAR records usage a few seconds late) when the ledger's reconciliation settles them.
   */
  private async reportRunCost(account: SpendAccount, runId: string, model: string, record: Record_): Promise<void> {
    await account.settleNow((entry) => entry.runId === runId);
    const settled = () => { const totals = account.totals({ runId }); return totals.requests > 0 && totals.pendingNanoUsd === 0 && totals.estimatedNanoUsd === 0 ? totals : undefined; };
    const report = async (late: boolean) => {
      const totals = settled();
      if (!totals) return false;
      const actualCostUsd = nanoToUsd(totals.confirmedNanoUsd);
      this.post(late ? { type: 'assistant-cost', actualCostUsd, runId } : { type: 'assistant-cost', actualCostUsd });
      await record({ status: 'completed', kind: 'model', model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd });
      return true;
    };
    if (await report(false)) return;
    let done = false;
    const watch = account.onChange(() => { if (!done && settled()) { done = true; watch.dispose(); clearTimeout(expiry); void report(true); } });
    const expiry = setTimeout(() => { done = true; watch.dispose(); }, 30 * 60_000);
    expiry.unref?.();
  }

  public answerApproval(callId: string, reply: ApprovalReply): void {
    this.approvals.get(callId)?.(reply);
    this.approvals.delete(callId);
  }

  public answerQuestions(id: string, answers: string[]): void {
    this.questions.get(id)?.(answers);
    this.questions.delete(id);
  }

  /** Pause (before its next model turn), resume, or stop one sub-agent. */
  public controlAgent(agentId: string, action: 'pause' | 'resume' | 'stop'): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (action === 'stop') agent.abort.abort();
    else if (action === 'pause') agent.paused = true;
    else { agent.paused = false; agent.resume?.(); agent.resume = undefined; }
    this.postAgents();
    return true;
  }

  /** Stops the run and its sub-agents. Messages still queued for it go back to the composer. */
  public stop(): void {
    this.halt();
    for (const item of this.takeUndelivered()) this.post({ type: 'steer-state', id: item.id, state: 'returned', text: item.text });
  }

  private halt(): void {
    this.abort?.abort();
    this.abort = undefined;
    for (const agent of this.agents.values()) agent.abort.abort();
    this.releasePending();
  }

  /**
   * Queues a message the user sent while a run is going (or about to start). The run appends it to
   * its transcript before its next model request; a retry wait ends early for it.
   */
  public steer(id: string, text: string): void {
    this.steering.push({ id, text });
    this.post({ type: 'steer-state', id, state: 'queued' });
    for (const listener of [...this.steerListeners]) listener();
  }

  /** Queued messages no run took (it ended first), oldest first; the caller sends them as a new turn. */
  public takeUndelivered(): SteerMessage[] {
    const left = this.steering;
    this.steering = [];
    return left;
  }

  private readonly steeringInput: RunInput = {
    pending: () => this.steering.length > 0,
    take: () => this.takeUndelivered().map((item) => {
      const content = steeringContent(item.text);
      this.display.set(contentKey(content), item.text);
      this.post({ type: 'steer-state', id: item.id, state: 'delivered' });
      return { role: 'user', content };
    }),
    subscribe: (listener) => { this.steerListeners.add(listener); return () => { this.steerListeners.delete(listener); }; }
  };

  /** Checks NEAR's signature and TDX attestation for a run's final answer. */
  public async verifyRun(runId: string): Promise<VerificationResult> {
    const entry = this.verifiable.get(runId);
    if (!entry) return { outcome: 'unavailable', summary: 'This response can no longer be verified from the editor (only the last 20 are kept).', checks: {}, notChecked: NOT_CHECKED_IN_EDITOR };
    return entry.client.verifyResponse(entry.model, entry.evidence);
  }

  /** Undoes every file change a run made with the file tools. */
  public async revert(runId: string): Promise<string[]> {
    const checkpoints = this.runs.get(runId) ?? await RunCheckpoints.load(runId, this.checkpointDir);
    if (!checkpoints) return [];
    const restored = await checkpoints.revert();
    this.runs.delete(runId);
    return restored.map((file) => displayPath(this.root, file));
  }

  /** Continues an earlier conversation with its full context; returns its visible turns for the view. */
  public async restore(id: string): Promise<Array<{ role: 'user' | 'assistant'; text: string; tools: number }> | undefined> {
    const transcript = await this.transcripts?.load(id);
    if (!transcript) return undefined;
    this.reset();
    this.messages = transcript.messages;
    this.display = new Map(transcript.display ?? []);
    this.conversationId = transcript.id;
    this.title = transcript.title;
    return visibleTurns(transcript.messages, this.display);
  }

  public reset(): void {
    this.halt();
    this.steering = [];
    this.tasks.clear();
    this.messages = [];
    this.display = new Map();
    this.conversationId = newConversationId();
    this.title = '';
    this.contextWarned = false;
    this.notifications = [];
    this.shell?.dispose();
    this.shell = undefined;
  }

  public dispose(): void { this.reset(); }

  private systemPrompt(request: AgentTurnRequest, root = this.root): string {
    const base = `${agentSystemPrompt({ security: Boolean(request.security), root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: existsSync(path.join(root, '.git')), model: request.model })}${projectInstructions(root)}`;
    if (!request.gsd) return base;
    return `${base}\n\n# Open-GSD\nOpen-GSD is installed at ${request.gsd.home} (read-only to you). Its skills, agents, workflows, templates, and references live there; read them with Read when instructions point to them. Run gsd-tools as the workflows show; CLAUDE_CONFIG_DIR is already set in your shell. When a workflow says to spawn an agent, use the Agent tool with that subagent_type (run_in_background works). When the agent does an item on your task list, pass that item's exact content as the Agent call's task: the list then shows it in progress and marks it completed (or back to pending) when the agent ends, even while other agents still run. Background agents' reports arrive as messages on their own: once you have nothing else to do, end your turn to wait for them. Never wait with sleep or by polling for output files. When it says to ask the user, use AskUserQuestion.`;
  }

  private shellFor(env: NodeJS.ProcessEnv): ShellSession {
    const key = JSON.stringify([env, this.shellEnvAllow]);
    if (!this.shell || this.shellEnvKey !== key) {
      this.shell?.dispose();
      this.shell = new ShellSession(this.root, undefined, env, this.shellEnvAllow);
      this.shellEnvKey = key;
    }
    return this.shell;
  }

  /**
   * Keeps the transcript inside the model's window. Over 60% used, old tool output is trimmed;
   * at Open-GSD's warning threshold the user is told; at the critical threshold earlier history
   * is summarized by the model and, for the main run, a handoff is saved. If summarizing fails,
   * trimming still applies and the user is told, so work continues rather than overflowing.
   */
  private async manageContext(transcript: AgentMessage[], lastUsage: UsageMetadata | undefined, request: AgentTurnRequest, signal: AbortSignal, mainRun: boolean): Promise<AgentMessage[] | undefined> {
    const window = request.contextWindows?.[request.model] ?? DEFAULT_CONTEXT_WINDOW;
    const reported = lastUsage?.inputTokens !== undefined ? lastUsage.inputTokens + (lastUsage.outputTokens ?? 0) : undefined;
    const used = Math.max(reported ?? 0, estimateTokens(transcript));
    const status = contextStatus(used, window, DEFAULT_THRESHOLDS);
    if (mainRun) this.post({ type: 'context', remainingPercent: status.remainingPercent, level: status.level });
    if (status.remainingPercent > 40) return undefined;
    let next = trimOldToolResults(transcript);
    if (status.level === 'warning' && mainRun && !this.contextWarned) {
      this.contextWarned = true;
      this.post({ type: 'notice', text: `Context is ${100 - status.remainingPercent}% full. Older tool output is being trimmed; at ${100 - DEFAULT_THRESHOLDS.criticalRemaining}% the conversation is summarized automatically.` });
    }
    if (status.level !== 'critical') return next;
    try {
      next = await compactConversation(request.client, request.model, next, signal);
      if (mainRun) {
        this.post({ type: 'notice', text: 'The conversation was summarized to stay within the model\'s context window. A handoff was saved to .planning/HANDOFF.json.' });
        await saveHandoff(this.root, { reason: 'context-critical', currentAction: this.title || 'Agent conversation', nextAction: 'Continue from the summarized conversation, or resume it from NEAR AI history.', activeAgents: this.agents.size, pendingApprovals: this.approvals.size }).catch(() => undefined);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (mainRun) this.post({ type: 'notice', text: `Summarizing the conversation failed (${(error as Error).message}); older tool output was trimmed instead. Consider starting a new chat soon.` });
    }
    return next;
  }

  private toolsFor(request: AgentTurnRequest, context: Omit<ToolContext, 'signal' | 'onTodos'>, grants: RunGrants, extraUsage: UsageMetadata[], record: Record_, runSignal: AbortSignal, runId: string): AgentTool<any>[] {
    const media = request.imageModel ? [imageTool(request.client, request.imageModel)] : [];
    const memoryFor = (agentScope?: MemoryScope, source = runId) => request.memory ? memoryTools(request.memory.store, { project: request.memory.projectScope, agent: agentScope }, AGENT_MEMORY_ACTOR, source) : [];
    const base = [...CORE_TOOLS, webFetchTool, webSearchTool(request.webSearch), checkCitationsTool, ...GRAPHICS_TOOLS, ...media, ...(request.security ? [securityTool(request.security)] : []), ...(request.mcpTools ?? []), ...memoryFor()];
    const agents = [...(request.gsd?.agents ?? []), ...(request.team ? teamAgents(request.team) : []), ...(request.projectAgents ?? [])];
    if (!agents.length) return base;
    const gsd = request.gsd;
    let all: AgentTool<any>[] = [];
    const extra = gsdTools({
      home: gsd?.home ?? '',
      root: this.root,
      skills: gsd?.skills ?? [],
      agents,
      ask: (questions, askSignal) => this.askQuestions(questions, askSignal),
      spawn: async (spawn, callSignal) => {
        const label = spawn.agent?.name ?? spawn.type;
        const tiers = request.tiers ?? { deep: request.model, standard: request.model, fast: request.model };
        // A team member's own model line wins; then the role's configured model; then the tier the workflow asked for.
        const teamMember = Boolean(spawn.agent && (!gsd || !spawn.agent.file.startsWith(gsd.home)));
        const roleModel = spawn.agent && !(teamMember && spawn.agent.model) ? roleModelFor(label, request.roleModels ?? {}) : undefined;
        const wanted = modelForTier(roleModel ?? spawn.model ?? spawn.agent?.model, tiers, request.model);
        const model = !request.availableModels || request.availableModels.includes(wanted) ? wanted : request.model;
        const agentBody = spawn.agent ? (gsd ? await expandPrompt(spawn.agent.body, { home: gsd.home, root: this.root }) : spawn.agent.body) : undefined;
        // Each sub-agent's Remember/Recall also reach its own private memory.
        const privateMemory = memoryFor({ kind: 'private-agent', id: `agent-${label}`.slice(0, 80) }, `${runId}-${label}`.slice(0, 100));
        const pool = [...all.filter((tool) => tool.name !== 'Remember' && tool.name !== 'Recall'), ...privateMemory];
        // A listed tool, Task for Agent, and MCP tools by name, mcp:<server>, or a trailing-* pattern.
        const allowed = spawn.agent?.tools.length ? pool.filter((tool) => spawn.agent!.tools.includes(tool.name) || (tool.name === 'Task' && spawn.agent!.tools.includes('Agent')) || (tool.name.startsWith('mcp__') && grantsMcpTool(spawn.agent!.tools, tool.name))) : pool.filter((tool) => tool.name !== 'Agent' && tool.name !== 'Task');
        // The task-list item this agent does, when the call names one that is on the list.
        const todo = spawn.task ? this.moveTask(spawn.task, 'in_progress') : undefined;
        const agent: LiveAgent = { id: `${label}-${randomBytes(3).toString('hex')}`, label, description: spawn.description, model, abort: new AbortController(), paused: false, background: spawn.background, activity: 'Waiting for a free slot', activitySince: Date.now(), startedAt: Date.now(), toolCalls: 0, turns: 0 };
        // A background agent outlives the tool call but not the run; a foreground one ends with the call too.
        const parent = spawn.background ? runSignal : callSignal;
        const onParentAbort = () => agent.abort.abort();
        parent.addEventListener('abort', onParentAbort, { once: true });
        const execute = async (): Promise<string> => {
          await this.acquireSlot(request.maxParallelAgents ?? 4, agent.abort.signal);
          const releaseSlot = () => this.releaseSlot();
          let shell: ShellSession | undefined;
          let worktree: AgentWorktree | undefined;
          let worktreeState: 'removed' | 'kept' | undefined;
          agent.startedAt = Date.now();
          this.setActivity(agent, 'Starting');
          this.agents.set(agent.id, agent);
          this.postAgents();
          const started = Date.now();
          const usage: UsageMetadata[] = [];
          void record({ status: 'running', kind: 'agent', agentId: agent.id, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} started.` });
          try {
            if (spawn.isolation === 'worktree') worktree = await createAgentWorktree(this.root, this.worktreeDir, agent.id);
            const agentRoot = worktree?.path ?? this.root;
            // Its own shell, so parallel agents neither queue behind each other's commands nor share a cwd.
            shell = new ShellSession(agentRoot, undefined, request.gsd?.shellEnv ?? {}, request.shellEnvAllow ?? []);
            // Research agents gather outside content; their writes belong in .planning/ (others ask).
            const agentContext = { ...context, root: agentRoot, shell, readFiles: new Set<string>(), pages: new Map<string, string>(), ...(/research|synthesi|red-team/i.test(label) ? { writeScope: '.planning' } : {}) };
            const isolationNote = worktree ? `\n\n# Isolation\nYou are working in an isolated git worktree at ${worktree.path} on branch ${worktree.branch}. Commit your work on this branch; do not switch branches or touch the main checkout at ${this.root}.` : '';
            const base = `${this.systemPrompt({ ...request, model }, agentRoot)}${isolationNote}`;
            const system = agentBody ? `${agentBody}\n\n${base}` : base;
            this.activity?.agentStarted({ agentId: agent.id, agent: label, runId, model, parentId: `main-${runId}` }, spawn.prompt, system);
            const child = new AgentRun({
              client: request.client, model, tools: allowed, context: agentContext, policy: request.policy, rules: request.rules, grants, safety: this.runSafety, maxTurns: request.maxTurns, maxOutputTokens: request.maxOutputTokens,
              beforeTurn: async (transcript, lastUsage, signal) => {
                if (this.abort) this.enforceBudget(request, this.abort);
                while (agent.paused && !signal.aborted) await new Promise<void>((resolve) => { agent.resume = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
                return this.manageContext(transcript, lastUsage, { ...request, model }, signal, false);
              },
              requestApproval: (approval) => this.askApproval({ ...approval, callId: `${agent.id}:${approval.callId}`, title: `${label} › ${approval.title}` }, agent.abort.signal, label),
              emit: (event) => {
                this.track(agent.id, event);
                this.observe(agent, event);
                if (event.type === 'tool-start') this.forward({ ...event, callId: `${agent.id}:${event.callId}`, title: `${label} › ${event.title}` }, model, record);
                else if (event.type === 'tool-end') this.forward({ ...event, callId: `${agent.id}:${event.callId}` }, model, record);
                else if (event.type === 'turn') { usage.push(event.usage); extraUsage.push(event.usage); this.forward(event, model, record); }
                else if (event.type === 'retry') this.post({ type: 'notice', text: `${label}: ${retryNotice(event)}` });
              }
            });
            const result = await withSpendTag({ kind: 'sub-agent', agentId: agent.id }, () => child.run([{ role: 'system', content: system }, { role: 'user', content: spawn.prompt }], agent.abort.signal));
            this.activity?.agentEnded(agent.id, result.outcome);
            const total = sumUsage(usage);
            const report = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content;
            await this.recordReputation(request.reputation, label, result.outcome === 'completed' ? 1 : result.outcome === 'max-turns' ? 0 : -1, agent.id);
            void record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'agent', agentId: agent.id, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} ${result.outcome}.`, inputTokens: total.inputTokens, outputTokens: total.outputTokens, estimatedCostUsd: total.estimatedCostUsd, durationMs: Date.now() - started });
            shell.dispose();
            worktreeState = worktree ? await finishAgentWorktree(worktree).catch(() => 'kept' as const) : undefined;
            const isolated = worktree && worktreeState ? `\n\n${worktreeReport(worktree, worktreeState)}` : '';
            const done = result.outcome === 'completed';
            if (todo) this.moveTask(todo, done ? 'completed' : 'pending');
            const note = this.taskNote(todo, done);
            if (result.outcome === 'cancelled') return `${label} was stopped before it finished.${isolated}${note}`;
            return `${typeof report === 'string' && report.trim() ? report : `${label} finished without a written report.`}${isolated}${note}`;
          } catch (error) {
            if (todo) this.moveTask(todo, 'pending');
            this.activity?.agentEnded(agent.id, 'failed', error instanceof Error ? error.message : String(error));
            await this.recordReputation(request.reputation, label, -1, agent.id);
            void record({ status: 'failed', kind: 'agent', agentId: agent.id, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} failed.`, errorCode: error instanceof Error ? error.name : 'unknown', durationMs: Date.now() - started });
            throw error;
          } finally {
            shell?.dispose();
            // A failed agent's empty worktree is removed too; one with changes stays for recovery.
            if (worktree && !worktreeState) await finishAgentWorktree(worktree).catch(() => undefined);
            parent.removeEventListener('abort', onParentAbort);
            this.agents.delete(agent.id);
            releaseSlot();
            this.postAgents();
          }
        };
        if (!spawn.background) return execute().catch((error: Error) => { throw new Error(`${error.message}${this.taskNote(todo, false)}`); });
        const task = execute()
          .then((report) => { this.notifications.push({ role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="finished">\n${report}\n</agent-notification>` }); })
          .catch((error: Error) => { this.notifications.push({ role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="failed">\n${error.message}${this.taskNote(todo, false)}\n</agent-notification>` }); })
          .finally(() => { this.background.delete(task); });
        this.background.add(task);
        return `Started ${label} in the background as ${agent.id}. Its report will arrive in a later message when it finishes; there is no output file to poll. Continue with other work, or end your turn to wait; do not sleep.`;
      }
    });
    all = [...base, ...extra.filter((tool) => gsd || (tool.name !== 'Skill' && tool.name !== 'SlashCommand'))];
    return all;
  }

  /** Reliability evidence for the sub-agent's role (when it maps to one), so routing history is explainable. */
  private async recordReputation(store: ReputationStore | undefined, label: string, value: number, agentId: string): Promise<void> {
    const role = roleFor(label);
    if (!store || !role) return;
    await store.record({ evidenceId: `evidence-${agentId}`.slice(0, 100), profileId: `agent-${label}`.slice(0, 100), role, kind: 'reliability', value, recordedAt: new Date().toISOString(), source: 'runtime', outcome: value > 0 ? 'success' : value < 0 ? 'failure' : 'partial' }).catch(() => undefined);
  }

  /** Reports from background agents that finished since the last turn, as user messages. */
  private drainNotifications(): AgentMessage[] {
    const pending = this.notifications;
    this.notifications = [];
    return pending;
  }

  /** When the model is done but background agents are still running, wait for the next report. */
  private async waitForBackground(signal: AbortSignal): Promise<AgentMessage[] | undefined> {
    const ready = this.drainNotifications();
    if (ready.length) return ready;
    if (!this.background.size || signal.aborted) return undefined;
    this.post({ type: 'notice', text: `Waiting for ${this.background.size} background agent${this.background.size === 1 ? '' : 's'} to finish…` });
    // A message from the user wakes the agent too.
    let unsubscribe: (() => void) | undefined;
    await Promise.race([...this.background, new Promise<void>((resolve) => { signal.addEventListener('abort', () => resolve(), { once: true }); unsubscribe = this.steeringInput.subscribe(resolve); })]);
    unsubscribe?.();
    return signal.aborted ? undefined : [...this.drainNotifications(), ...this.steeringInput.take()];
  }

  /** Reserves a slot in the same synchronous step as the check, so parallel spawns cannot overshoot the limit. */
  private async acquireSlot(limit: number, signal: AbortSignal): Promise<void> {
    while (this.slotsInUse >= Math.max(1, limit)) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      await new Promise<void>((resolve) => { this.slotWaiters.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); });
    }
    if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
    this.slotsInUse += 1;
  }

  private releaseSlot(): void {
    this.slotsInUse = Math.max(0, this.slotsInUse - 1);
    const waiters = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of waiters) wake();
  }

  private postAgents(): void {
    if (this.agentsTimer) { clearTimeout(this.agentsTimer); this.agentsTimer = undefined; }
    this.post({ type: 'agents', count: this.agents.size, agents: [...this.agents.values()].map((agent) => ({ id: agent.id, label: agent.label, description: agent.description, model: agent.model, paused: agent.paused, background: agent.background, activity: agent.activity, activitySince: agent.activitySince, lastAction: agent.lastAction, startedAt: agent.startedAt, toolCalls: agent.toolCalls, turns: agent.turns, ...(agent.todos?.length ? { steps: agentSteps(agent.todos) } : {}) })) });
  }

  /** Refreshes the agents strip at most once a second. */
  private schedulePostAgents(): void {
    this.agentsTimer ??= setTimeout(() => { this.agentsTimer = undefined; this.postAgents(); }, 1_000);
  }

  private setActivity(agent: LiveAgent, activity: string): void {
    if (agent.activity === activity) return;
    agent.activity = activity;
    agent.activitySince = Date.now();
  }

  /** Moves a task-list item and shows the list at once, without waiting for sibling agents. */
  private moveTask(task: string, status: Todo['status']): string | undefined {
    const content = this.tasks.set(task, status);
    if (content !== undefined) this.post({ type: 'todos', todos: this.tasks.list });
    return content;
  }

  /** What an Agent result tells the main agent about its task list, so its next TodoWrite agrees with the host. */
  private taskNote(task: string | undefined, done: boolean): string {
    const lines: string[] = [];
    if (task) lines.push(done ? `Task list: "${task}" is now marked completed.` : `Task list: "${task}" is back to pending, because the agent did not finish.`);
    if (this.tasks.unfinished) lines.push('Update the task list with TodoWrite if this finished a task.');
    return lines.length ? `\n\n${lines.join('\n')}` : '';
  }

  /** Keeps each sub-agent's live status current from its own events. */
  private observe(agent: LiveAgent, event: AgentEvent): void {
    // A step finishing is worth showing at once, unlike the stream of activity updates.
    if (event.type === 'todos') { agent.todos = event.todos; return void this.postAgents(); }
    if (event.type === 'tool-start') { agent.toolCalls += 1; agent.lastAction = event.title; this.setActivity(agent, event.title); }
    else if (event.type === 'tool-end') this.setActivity(agent, 'Thinking');
    else if (event.type === 'reasoning') { this.setActivity(agent, 'Thinking'); return void this.schedulePostAgents(); }
    else if (event.type === 'text') this.setActivity(agent, 'Writing');
    else if (event.type === 'turn') agent.turns += 1;
    else if (event.type === 'retry') this.setActivity(agent, 'Retrying after NEAR AI went quiet');
    this.schedulePostAgents();
  }

  /** A progress line in the chat when nothing has appeared there for a while (sub-agents show only in the strip), so long runs show they are moving. */
  private heartbeat(runStartedAt: number): void {
    const quietFor = Date.now() - this.lastVisibleAt;
    const due = this.heartbeats === 0 ? this.progressTiming.firstMs : this.progressTiming.everyMs;
    if (quietFor < due) return;
    this.heartbeats += 1;
    this.lastVisibleAt = Date.now();
    // Consecutive progress lines replace each other in the chat, so a long quiet stretch is one updating line.
    const agents = [...this.agents.values()];
    const detail = agents.length
      ? agents.map((agent) => `${agent.description || agent.label}: ${agent.paused ? 'paused' : agent.activity === 'Thinking' ? `thinking for ${minutesSince(agent.activitySince)}${agent.lastAction ? ` after ${agent.lastAction}` : ''}` : agent.activity} (${minutesSince(agent.startedAt)}, ${agent.toolCalls} tool call${agent.toolCalls === 1 ? '' : 's'})`).join(' · ')
      : 'the agent is thinking';
    const spent = this.runCostUsd();
    const cost = spent > 0 ? ` · about $${spent.toFixed(2)} so far` : '';
    this.post({ type: 'progress', text: `Still working (${minutesSince(runStartedAt)}): ${detail}${cost}.` });
  }

  private markVisible(): void {
    this.lastVisibleAt = Date.now();
    this.heartbeats = 0;
  }

  private async saveTranscript(model: string): Promise<void> {
    if (!this.transcripts || this.messages.length < 2) return;
    await this.transcripts.save({ id: this.conversationId, title: this.title || 'Conversation', model, updatedAt: new Date().toISOString(), turns: this.messages.filter((message) => message.role === 'user').length, messages: this.messages, display: [...this.display.entries()].filter(([key]) => this.messages.some((message) => message.role === 'user' && contentKey(message.content) === key)) }).catch(() => undefined);
  }

  private tally(usage: UsageMetadata): void {
    const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    this.spend.totalTokens += tokens;
    this.spend.cachedTokens += usage.cachedInputTokens ?? 0;
    // Priced turns are bounded by the cost limit; the token limit is for models without known prices.
    if (usage.estimatedCostUsd !== undefined) this.spend.costUsd += usage.estimatedCostUsd;
    else this.spend.tokens += tokens;
  }

  /** The current or last run's estimated cost and tokens, across its sub-agents. */
  public get runSpend(): { costUsd: number; totalTokens: number; cachedTokens: number; unpricedTokens: number } {
    return { costUsd: this.runCostUsd(), totalTokens: this.spend.totalTokens, cachedTokens: this.spend.cachedTokens, unpricedTokens: this.spend.tokens };
  }

  /** The run's cost so far: every request in the ledger tagged with it (sub-agents, safety checks, summaries), or the model turns' estimates without a ledger. */
  private runCostUsd(): number {
    const source = this.runSpendSource;
    return source ? nanoToUsd(totalNanoUsd(source.account.totals({ runId: source.runId }))) : this.spend.costUsd;
  }

  /** Stops the whole run, keeping its work, once its estimated cost or tokens reach the budget. */
  private enforceBudget(request: AgentTurnRequest, abort: AbortController): void {
    if (this.spend.stopped) return;
    // The daily limit, before every model turn: NEAR's total for today when known, else this computer's ledger.
    const reached = this.runSpendSource?.account.limitReached();
    if (reached) {
      this.spend.stopped = true;
      this.post({ type: 'notice', text: `Stopped the run: today's NEAR AI spend ($${reached.spentUsd.toFixed(2)}${reached.source === 'near' ? ', from NEAR\'s usage summary' : ''}) reached your daily limit of $${reached.limitUsd.toFixed(2)} (nearAi.dailySpendLimitUsd). Everything it did is kept.` });
      abort.abort();
      return;
    }
    const budget = request.budget;
    if (!budget) return;
    const costUsd = this.runCostUsd();
    const overCost = costUsd >= budget.maxCostUsd;
    const overTokens = this.spend.tokens >= budget.maxTokens;
    if (!overCost && !overTokens) return;
    this.spend.stopped = true;
    this.post({ type: 'notice', text: overCost
      ? `Stopped the run: its estimated cost reached $${costUsd.toFixed(2)}, the limit for one run ($${budget.maxCostUsd.toFixed(2)}; nearAi.agent.maxRunCostUsd, and never more than what is left of nearAi.dailySpendLimitUsd). Everything it did is kept; send a message to continue.`
      : `Stopped the run: it used ${Math.round(this.spend.tokens).toLocaleString('en-US')} tokens on models without published prices, the limit for one run (nearAi.agent.maxRunTokens). Everything it did is kept; send a message to continue.` });
    abort.abort();
  }

  /** Mirrors an agent's events into the Agent Activity feed. */
  private track(agentId: string, event: AgentEvent): void {
    const feed = this.activity;
    if (!feed) return;
    if (event.type === 'text' || event.type === 'reasoning') feed.stream(agentId, event.type, event.text);
    else if (event.type === 'tool-start') feed.toolStarted(agentId, event.callId, event.title, event.input);
    else if (event.type === 'tool-end') feed.toolEnded(agentId, event.callId, event.ok, event.output);
    else if (event.type === 'turn') feed.turn(agentId, event.usage);
    else if (event.type === 'retry') feed.retry(agentId, retryNotice(event));
    else if (event.type === 'security') feed.security(agentId, event);
  }

  private forward(event: AgentEvent, model: string, record: Record_): void {
    if (event.type === 'text') this.post({ type: 'assistant-delta', text: event.text });
    else if (event.type === 'tool-start') { this.post({ type: 'tool-start', callId: event.callId, tool: event.tool, title: event.title }); void record({ status: 'running', kind: 'tool', tool: event.tool, summary: event.title.slice(0, 200) }); }
    else if (event.type === 'tool-end') { this.post({ type: 'tool-end', callId: event.callId, ok: event.ok, output: event.output }); void record({ status: event.ok ? 'completed' : 'failed', kind: 'tool', summary: event.ok ? 'Tool call finished.' : 'Tool call failed or was declined.' }); }
    else if (event.type === 'todos') this.post({ type: 'todos', todos: event.todos });
    else if (event.type === 'retry') { this.post({ type: 'assistant-retry', discard: event.discardText, text: retryNotice(event) }); void record({ status: 'running', kind: 'model', model, summary: `Model turn failed; retrying (attempt ${event.attempt + 1}).` }); }
    else if (event.type === 'turn') this.tally(event.usage);
    if (event.type === 'turn') void record({ status: 'completed', kind: 'model', model, requestId: event.usage.requestId, summary: 'Model turn completed.', estimatedCostUsd: event.usage.estimatedCostUsd, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, durationMs: event.usage.latencyMs });
  }

  /** How long an approval may wait before it is declined, so an unattended run carries on (0: wait indefinitely). */
  public approvalTimeoutMs = 15 * 60_000;

  /** The prompts still waiting for the user, oldest first, marked as replays for a reloaded view. */
  public waitingPrompts(): Array<Record<string, unknown>> {
    return [...this.waiting.values()].map((message) => ({ ...message, replay: true }));
  }

  private openPrompt(id: string, message: Record<string, unknown>): void {
    this.waiting.set(id, message);
    this.post(message);
    this.onWaitingChange?.(this.waiting.size);
  }

  /** Forgets a waiting prompt; one cancelled by a stop or the run ending is reported so the view unpins it. */
  private closePrompt(id: string, cancelled = false): void {
    if (!this.waiting.delete(id)) return;
    if (cancelled) this.post({ type: 'prompt-closed', id, outcome: 'cancelled' });
    this.onWaitingChange?.(this.waiting.size);
  }

  private askApproval(request: ApprovalRequest, signal: AbortSignal, agent?: string): Promise<ApprovalReply> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny' });
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (reply: ApprovalReply, cancelled = false) => { if (timer) clearTimeout(timer); this.closePrompt(request.callId, cancelled); resolve(reply); };
      this.approvals.set(request.callId, settle);
      signal.addEventListener('abort', () => { if (this.approvals.delete(request.callId)) settle({ decision: 'deny' }, true); }, { once: true });
      if (this.approvalTimeoutMs > 0) {
        timer = setTimeout(() => {
          if (!this.approvals.delete(request.callId)) return;
          const minutes = Math.round(this.approvalTimeoutMs / 60_000);
          this.post({ type: 'approval-expired', callId: request.callId, minutes, text: `No one approved "${request.title}" within ${minutes} minute${minutes === 1 ? '' : 's'}, so it was declined and the agent continued without it.` });
          settle({ decision: 'deny', feedback: `Nobody answered within ${minutes} minute${minutes === 1 ? '' : 's'} (the user may be away). Continue without this action if you can, and report what still needs their approval.` });
        }, this.approvalTimeoutMs);
      }
      this.openPrompt(request.callId, { type: 'approval-request', callId: request.callId, tool: request.tool, title: request.title, preview: request.preview, ...(request.reason ? { reason: request.reason } : {}), ...(agent ? { agent } : {}) });
    });
  }

  private askQuestions(questions: Question[], signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) return Promise.resolve([]);
    const id = `q-${randomBytes(6).toString('hex')}`;
    return new Promise((resolve) => {
      const settle = (answers: string[], cancelled = false) => { this.closePrompt(id, cancelled); resolve(answers); };
      this.questions.set(id, settle);
      signal.addEventListener('abort', () => { if (this.questions.delete(id)) settle([], true); }, { once: true });
      this.openPrompt(id, { type: 'questions-request', id, questions });
    });
  }

  private releasePending(): void {
    const approvals = [...this.approvals.values()];
    const questions = [...this.questions.values()];
    this.approvals.clear();
    this.questions.clear();
    for (const settle of approvals) settle({ decision: 'deny' }, true);
    for (const settle of questions) settle([], true);
  }
}

/** The memory actor the runner writes as; the host registers it as trusted when it creates the memory service. */
export const AGENT_MEMORY_ACTOR = 'near-ai-agent';

/** Maps an agent definition name onto the reputation roles. */
export function roleFor(label: string): AgentRole | undefined {
  const name = label.toLowerCase();
  if (/secur/.test(name)) return 'security';
  if (/plan/.test(name)) return 'planner';
  if (/research|mapper|analy/.test(name)) return 'researcher';
  if (/test|nyquist|uat/.test(name)) return 'tester';
  if (/review|check|verif|audit/.test(name)) return 'reviewer';
  if (/exec|implement|fix|writer|build/.test(name)) return 'implementer';
  return undefined;
}

/** Finds a skill by its name, its name without the `gsd-` prefix, or a legacy `gsd:name` form. */
export function findSkill(skills: GsdSkill[], name: string): GsdSkill | undefined {
  const wanted = name.replace(/^\//, '').trim();
  return skills.find((skill) => skill.name === wanted) ?? skills.find((skill) => skill.name === `gsd-${wanted}` || skill.name.replace(/:/g, '-') === wanted);
}

/** The user-visible turns of a saved conversation: what the user typed and what the agent answered. */
export function visibleTurns(messages: AgentMessage[], display = new Map<string, string>()): Array<{ role: 'user' | 'assistant'; text: string; tools: number }> {
  const turns: Array<{ role: 'user' | 'assistant'; text: string; tools: number }> = [];
  for (const message of messages) {
    const shown = message.role === 'user' ? display.get(contentKey(message.content)) : undefined;
    if (shown !== undefined) { turns.push({ role: 'user', text: shown, tools: 0 }); continue; }
    if (message.role === 'user') {
      const ran = /^The user ran (\/\S+(?: [^\n.]*)?)\. Follow these instructions:/.exec(message.content);
      if (message.content.startsWith('<agent-notification') || message.content.startsWith('<conversation-summary>')) continue;
      turns.push({ role: 'user', text: ran ? ran[1] : message.content, tools: 0 });
    } else if (message.role === 'assistant') {
      const last = turns.at(-1);
      if (last?.role === 'assistant') { last.text += message.content ? `${last.text ? '\n\n' : ''}${message.content}` : ''; last.tools += message.tool_calls?.length ?? 0; }
      else turns.push({ role: 'assistant', text: message.content ?? '', tools: message.tool_calls?.length ?? 0 });
    }
  }
  return turns;
}

export function retryNotice(event: Extract<AgentEvent, { type: 'retry' }>): string {
  return `${event.reason} Retrying in ${Math.round(event.delayMs / 1000)} s (attempt ${event.attempt + 1}); the run continues from where it was.`;
}

function contentKey(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 24);
}

function newConversationId(): string {
  return `conv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** A spend figure for the webview: its text and what it means. */
export function spendLine(view: { text: string; tooltip: string; source: string }): { text: string; tooltip: string; source: string } {
  return { text: view.text, tooltip: view.tooltip, source: view.source };
}

function sumUsage(turns: UsageMetadata[]): UsageMetadata {
  const total: UsageMetadata = { verificationStatus: 'unknown', latencyMs: turns.reduce((sum, turn) => sum + turn.latencyMs, 0) };
  const add = (key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'estimatedCostUsd') => {
    const values = turns.map((turn) => turn[key]).filter((value): value is number => value !== undefined);
    if (values.length) total[key] = values.reduce((sum, value) => sum + value, 0);
  };
  add('inputTokens');
  add('cachedInputTokens');
  add('outputTokens');
  add('estimatedCostUsd');
  return total;
}
