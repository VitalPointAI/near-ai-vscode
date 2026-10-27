import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { compactConversation, contextStatus, DEFAULT_CONTEXT_WINDOW, DEFAULT_THRESHOLDS, estimateTokens, trimOldToolResults } from '../agent/context';
import { AgentEvent, AgentRun, AgentRunError, ApprovalReply, ApprovalRequest, RunResult } from '../agent/loop';
import { PermissionRules, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { GRAPHICS_TOOLS } from '../agent/graphicsTools';
import { AgentTool, CORE_TOOLS, ToolContext } from '../agent/tools';
import { displayPath } from '../agent/workspace';
import { AgentWorktree, createAgentWorktree, finishAgentWorktree, worktreeReport } from '../agent/worktree';
import type { ActionPolicy } from '../domain/policy';
import { expandPrompt, GsdAgent, GsdSkill, modelForTier } from '../gsd/library';
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
}

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
  private shellEnvKey = '';
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (reply: ApprovalReply) => void>();
  private readonly questions = new Map<string, (answers: string[]) => void>();
  private readonly runs = new Map<string, RunCheckpoints>();
  private readonly agents = new Map<string, LiveAgent>();
  private readonly background = new Set<Promise<void>>();
  private notifications: AgentMessage[] = [];
  private slotWaiters: Array<() => void> = [];
  private slotsInUse = 0;
  private contextWarned = false;

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
  public get runningAgents(): number { return this.agents.size; }

  public async send(request: AgentTurnRequest): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    const runId = `run-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const checkpoints = new RunCheckpoints(runId, this.checkpointDir);
    this.runs.set(runId, checkpoints);
    const shell = this.shellFor(request.gsd?.shellEnv ?? {});
    const freshConversation = !this.messages.length;
    if (freshConversation) this.messages.push({ role: 'system', content: this.systemPrompt(request) });
    if (!this.title) this.title = request.text.replace(/\s+/g, ' ').slice(0, 80);
    let prompt = request.text;
    if (request.team) prompt = teamLeadPrompt(request.team, request.text.replace(/^\/team:\S+\s*/, ''));
    if (request.skill && request.gsd) {
      const skill = findSkill(request.gsd.skills, request.skill.name);
      if (!skill) throw new Error(`Open-GSD has no skill named ${request.skill.name}.`);
      prompt = `The user ran /${skill.name}${request.skill.args ? ` ${request.skill.args}` : ''}. Follow these instructions:\n\n${await expandPrompt(skill.body, { args: request.skill.args, home: request.gsd.home, root: this.root })}`;
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
    const context: Omit<ToolContext, 'signal' | 'onTodos'> = { root: this.root, checkpoints, shell, readFiles: new Set(), ripgrepPath: this.ripgrepPath, readOnlyRoots: request.gsd ? [request.gsd.home] : [] };
    const tools = this.toolsFor(request, context, grants, extraUsage, record, abort.signal, runId);
    const run = new AgentRun({
      client: request.client,
      model: request.model,
      tools,
      context,
      policy: request.policy,
      rules: request.rules,
      grants,
      maxTurns: request.maxTurns,
      beforeTurn: async (transcript, lastUsage, signal) => {
        const pending = this.drainNotifications();
        const managed = await this.manageContext(pending.length ? [...transcript, ...pending] : transcript, lastUsage, request, signal, true);
        return managed ?? (pending.length ? [...transcript, ...pending] : undefined);
      },
      afterAnswer: async (_transcript, signal) => this.waitForBackground(signal),
      requestApproval: (approval) => this.askApproval(approval, abort.signal),
      emit: (event) => { this.track(mainId, event); this.forward(event, request.model, record); }
    });
    try {
      let result: RunResult;
      try {
        result = await run.run(this.messages, abort.signal);
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
      const changed = checkpoints.changedFiles.map((file) => displayPath(this.root, file));
      if (result.outcome === 'cancelled') this.post({ type: 'assistant-cancelled' });
      else {
        if (result.outcome === 'max-turns') this.post({ type: 'assistant-delta', text: '\n\n_Stopped after reaching the turn limit. Send a message to continue._' });
        this.post({ type: 'assistant-done', usage });
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
      if (result.outcome !== 'cancelled' && ids.length && !request.local) {
        const actual = await request.client.actualCostsUsd(ids).catch(() => undefined);
        if (actual !== undefined) {
          this.post({ type: 'assistant-cost', actualCostUsd: actual });
          await record({ status: 'completed', kind: 'model', model: request.model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd: actual });
        }
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
      this.releasePending();
    }
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

  public stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    for (const agent of this.agents.values()) agent.abort.abort();
    this.releasePending();
  }

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
    this.stop();
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
    const base = agentSystemPrompt({ root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: existsSync(path.join(root, '.git')), model: request.model });
    if (!request.gsd) return base;
    return `${base}\n\n# Open-GSD\nOpen-GSD is installed at ${request.gsd.home} (read-only to you). Its skills, agents, workflows, templates, and references live there; read them with Read when instructions point to them. Run gsd-tools as the workflows show; CLAUDE_CONFIG_DIR is already set in your shell. When a workflow says to spawn an agent, use the Agent tool with that subagent_type (run_in_background works). Background agents' reports arrive as messages on their own: once you have nothing else to do, end your turn to wait for them. Never wait with sleep or by polling for output files. When it says to ask the user, use AskUserQuestion.`;
  }

  private shellFor(env: NodeJS.ProcessEnv): ShellSession {
    const key = JSON.stringify(env);
    if (!this.shell || this.shellEnvKey !== key) {
      this.shell?.dispose();
      this.shell = new ShellSession(this.root, undefined, env);
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
    const base = [...CORE_TOOLS, ...GRAPHICS_TOOLS, ...media, ...memoryFor()];
    const agents = [...(request.gsd?.agents ?? []), ...(request.team ? teamAgents(request.team) : [])];
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
        const wanted = modelForTier(spawn.model ?? spawn.agent?.model, request.tiers ?? { deep: request.model, standard: request.model, fast: request.model }, request.model);
        const model = !request.availableModels || request.availableModels.includes(wanted) ? wanted : request.model;
        const agentBody = spawn.agent ? (gsd ? await expandPrompt(spawn.agent.body, { home: gsd.home, root: this.root }) : spawn.agent.body) : undefined;
        // Each sub-agent's Remember/Recall also reach its own private memory.
        const privateMemory = memoryFor({ kind: 'private-agent', id: `agent-${label}`.slice(0, 80) }, `${runId}-${label}`.slice(0, 100));
        const pool = [...all.filter((tool) => tool.name !== 'Remember' && tool.name !== 'Recall'), ...privateMemory];
        const allowed = spawn.agent?.tools.length ? pool.filter((tool) => spawn.agent!.tools.includes(tool.name) || (tool.name === 'Task' && spawn.agent!.tools.includes('Agent'))) : pool.filter((tool) => tool.name !== 'Agent' && tool.name !== 'Task');
        const agent: LiveAgent = { id: `${label}-${randomBytes(3).toString('hex')}`, label, description: spawn.description, model, abort: new AbortController(), paused: false, background: spawn.background };
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
          this.agents.set(agent.id, agent);
          this.postAgents();
          const started = Date.now();
          const usage: UsageMetadata[] = [];
          void record({ status: 'running', kind: 'agent', agentId: agent.id, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} started.` });
          try {
            if (spawn.isolation === 'worktree') worktree = await createAgentWorktree(this.root, this.worktreeDir, agent.id);
            const agentRoot = worktree?.path ?? this.root;
            // Its own shell, so parallel agents neither queue behind each other's commands nor share a cwd.
            shell = new ShellSession(agentRoot, undefined, request.gsd?.shellEnv ?? {});
            const agentContext = { ...context, root: agentRoot, shell, readFiles: new Set<string>() };
            const isolationNote = worktree ? `\n\n# Isolation\nYou are working in an isolated git worktree at ${worktree.path} on branch ${worktree.branch}. Commit your work on this branch; do not switch branches or touch the main checkout at ${this.root}.` : '';
            const base = `${this.systemPrompt({ ...request, model }, agentRoot)}${isolationNote}`;
            const system = agentBody ? `${agentBody}\n\n${base}` : base;
            this.activity?.agentStarted({ agentId: agent.id, agent: label, runId, model, parentId: `main-${runId}` }, spawn.prompt, system);
            const child = new AgentRun({
              client: request.client, model, tools: allowed, context: agentContext, policy: request.policy, rules: request.rules, grants, maxTurns: request.maxTurns,
              beforeTurn: async (transcript, lastUsage, signal) => {
                while (agent.paused && !signal.aborted) await new Promise<void>((resolve) => { agent.resume = resolve; signal.addEventListener('abort', () => resolve(), { once: true }); });
                return this.manageContext(transcript, lastUsage, { ...request, model }, signal, false);
              },
              requestApproval: (approval) => this.askApproval({ ...approval, callId: `${agent.id}:${approval.callId}`, title: `${label} › ${approval.title}` }, agent.abort.signal),
              emit: (event) => {
                this.track(agent.id, event);
                if (event.type === 'tool-start') this.forward({ ...event, callId: `${agent.id}:${event.callId}`, title: `${label} › ${event.title}` }, model, record);
                else if (event.type === 'tool-end') this.forward({ ...event, callId: `${agent.id}:${event.callId}` }, model, record);
                else if (event.type === 'turn') { usage.push(event.usage); extraUsage.push(event.usage); this.forward(event, model, record); }
                else if (event.type === 'retry') this.post({ type: 'notice', text: `${label}: ${retryNotice(event)}` });
              }
            });
            const result = await child.run([{ role: 'system', content: system }, { role: 'user', content: spawn.prompt }], agent.abort.signal);
            this.activity?.agentEnded(agent.id, result.outcome);
            const total = sumUsage(usage);
            const report = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content;
            await this.recordReputation(request.reputation, label, result.outcome === 'completed' ? 1 : result.outcome === 'max-turns' ? 0 : -1, agent.id);
            void record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'agent', agentId: agent.id, agentRole: label, action: spawn.description, model, summary: `Sub-agent ${label} ${result.outcome}.`, inputTokens: total.inputTokens, outputTokens: total.outputTokens, estimatedCostUsd: total.estimatedCostUsd, durationMs: Date.now() - started });
            shell.dispose();
            worktreeState = worktree ? await finishAgentWorktree(worktree).catch(() => 'kept' as const) : undefined;
            const isolated = worktree && worktreeState ? `\n\n${worktreeReport(worktree, worktreeState)}` : '';
            if (result.outcome === 'cancelled') return `${label} was stopped before it finished.${isolated}`;
            return `${typeof report === 'string' && report.trim() ? report : `${label} finished without a written report.`}${isolated}`;
          } catch (error) {
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
        if (!spawn.background) return execute();
        const task = execute()
          .then((report) => { this.notifications.push({ role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="finished">\n${report}\n</agent-notification>` }); })
          .catch((error: Error) => { this.notifications.push({ role: 'user', content: `<agent-notification id="${agent.id}" agent="${label}" status="failed">\n${error.message}\n</agent-notification>` }); })
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
    await Promise.race([...this.background, new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))]);
    return signal.aborted ? undefined : this.drainNotifications();
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
    this.post({ type: 'agents', count: this.agents.size, agents: [...this.agents.values()].map((agent) => ({ id: agent.id, label: agent.label, description: agent.description, model: agent.model, paused: agent.paused, background: agent.background })) });
  }

  private async saveTranscript(model: string): Promise<void> {
    if (!this.transcripts || this.messages.length < 2) return;
    await this.transcripts.save({ id: this.conversationId, title: this.title || 'Conversation', model, updatedAt: new Date().toISOString(), turns: this.messages.filter((message) => message.role === 'user').length, messages: this.messages, display: [...this.display.entries()].filter(([key]) => this.messages.some((message) => message.role === 'user' && contentKey(message.content) === key)) }).catch(() => undefined);
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
  }

  private forward(event: AgentEvent, model: string, record: Record_): void {
    if (event.type === 'text') this.post({ type: 'assistant-delta', text: event.text });
    else if (event.type === 'tool-start') { this.post({ type: 'tool-start', callId: event.callId, tool: event.tool, title: event.title }); void record({ status: 'running', kind: 'tool', tool: event.tool, summary: event.title.slice(0, 200) }); }
    else if (event.type === 'tool-end') { this.post({ type: 'tool-end', callId: event.callId, ok: event.ok, output: event.output }); void record({ status: event.ok ? 'completed' : 'failed', kind: 'tool', summary: event.ok ? 'Tool call finished.' : 'Tool call failed or was declined.' }); }
    else if (event.type === 'todos') this.post({ type: 'todos', todos: event.todos });
    else if (event.type === 'retry') { this.post({ type: 'assistant-retry', discard: event.discardText, text: retryNotice(event) }); void record({ status: 'running', kind: 'model', model, summary: `Model turn failed; retrying (attempt ${event.attempt + 1}).` }); }
    else if (event.type === 'turn') void record({ status: 'completed', kind: 'model', model, requestId: event.usage.requestId, summary: 'Model turn completed.', estimatedCostUsd: event.usage.estimatedCostUsd, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, durationMs: event.usage.latencyMs });
  }

  private askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny' });
    return new Promise((resolve) => {
      this.approvals.set(request.callId, resolve);
      signal.addEventListener('abort', () => { if (this.approvals.delete(request.callId)) resolve({ decision: 'deny' }); }, { once: true });
      this.post({ type: 'approval-request', callId: request.callId, tool: request.tool, title: request.title, preview: request.preview });
    });
  }

  private askQuestions(questions: Question[], signal: AbortSignal): Promise<string[]> {
    if (signal.aborted) return Promise.resolve([]);
    const id = `q-${randomBytes(6).toString('hex')}`;
    return new Promise((resolve) => {
      this.questions.set(id, resolve);
      this.post({ type: 'questions-request', id, questions });
    });
  }

  private releasePending(): void {
    for (const resolve of this.approvals.values()) resolve({ decision: 'deny' });
    this.approvals.clear();
    for (const resolve of this.questions.values()) resolve([]);
    this.questions.clear();
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

function sumUsage(turns: UsageMetadata[]): UsageMetadata {
  const total: UsageMetadata = { verificationStatus: 'unknown', latencyMs: turns.reduce((sum, turn) => sum + turn.latencyMs, 0) };
  const add = (key: 'inputTokens' | 'outputTokens' | 'estimatedCostUsd') => {
    const values = turns.map((turn) => turn[key]).filter((value): value is number => value !== undefined);
    if (values.length) total[key] = values.reduce((sum, value) => sum + value, 0);
  };
  add('inputTokens');
  add('outputTokens');
  add('estimatedCostUsd');
  return total;
}
