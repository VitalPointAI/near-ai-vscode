import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentEvent, AgentRun, ApprovalReply, ApprovalRequest } from '../agent/loop';
import { PermissionRules, RunGrants } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { AgentTool, CORE_TOOLS, ToolContext } from '../agent/tools';
import { displayPath } from '../agent/workspace';
import type { ActionPolicy } from '../domain/policy';
import { expandPrompt, GsdAgent, GsdSkill, modelForTier } from '../gsd/library';
import { gsdTools, Question } from '../gsd/tools';
import type { ActivityStore } from './activityStore';
import type { AgentMessage, NearAiClient, UsageMetadata } from './nearAiClient';

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
}

/**
 * One sidebar conversation with the agent. Keeps the message history and a persistent shell
 * across turns, routes approval cards and questions to the webview and back, runs GSD skills and
 * sub-agents, and keeps each run's file checkpoints so the user can revert it.
 */
export class AgentConversation {
  private messages: AgentMessage[] = [];
  private shell: ShellSession | undefined;
  private shellEnvKey = '';
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (reply: ApprovalReply) => void>();
  private readonly questions = new Map<string, (answers: string[]) => void>();
  private readonly runs = new Map<string, RunCheckpoints>();
  private activeAgents = 0;

  public constructor(
    private readonly root: string,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly checkpointDir: string,
    private readonly ripgrepPath?: string
  ) {}

  public get running(): boolean { return Boolean(this.abort); }
  public get runningAgents(): number { return this.activeAgents; }

  public async send(request: AgentTurnRequest): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    const runId = `run-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const checkpoints = new RunCheckpoints(runId, this.checkpointDir);
    this.runs.set(runId, checkpoints);
    const shell = this.shellFor(request.gsd?.shellEnv ?? {});
    if (!this.messages.length) this.messages.push({ role: 'system', content: this.systemPrompt(request) });
    let prompt = request.text;
    if (request.skill && request.gsd) {
      const skill = findSkill(request.gsd.skills, request.skill.name);
      if (!skill) throw new Error(`Open-GSD has no skill named ${request.skill.name}.`);
      prompt = `The user ran /${skill.name}${request.skill.args ? ` ${request.skill.args}` : ''}. Follow these instructions:\n\n${await expandPrompt(skill.body, { args: request.skill.args, home: request.gsd.home, root: this.root })}`;
    }
    this.messages.push({ role: 'user', content: prompt });
    this.post({ type: 'assistant-start', model: request.model, privacy: request.privacy });
    const record = (event: Parameters<ActivityStore['append']>[1]) => request.activity ? request.activity.store.append(request.activity.sessionId, event).catch(() => undefined) : Promise.resolve();
    const extraUsage: UsageMetadata[] = [];
    const grants = new RunGrants();
    const context: Omit<ToolContext, 'signal' | 'onTodos'> = { root: this.root, checkpoints, shell, readFiles: new Set(), ripgrepPath: this.ripgrepPath, readOnlyRoots: request.gsd ? [request.gsd.home] : [] };
    const tools = this.toolsFor(request, context, grants, extraUsage, record);
    const run = new AgentRun({
      client: request.client,
      model: request.model,
      tools,
      context,
      policy: request.policy,
      rules: request.rules,
      grants,
      requestApproval: (approval) => this.askApproval(approval, abort.signal),
      emit: (event) => this.forward(event, request.model, record)
    });
    try {
      const result = await run.run(this.messages, abort.signal);
      this.messages = result.messages;
      const allUsage = [...result.usage, ...extraUsage];
      const usage = sumUsage(allUsage);
      const changed = checkpoints.changedFiles.map((file) => displayPath(this.root, file));
      if (result.outcome === 'cancelled') this.post({ type: 'assistant-cancelled' });
      else {
        if (result.outcome === 'max-turns') this.post({ type: 'assistant-delta', text: '\n\n_Stopped after reaching the turn limit. Send a message to continue._' });
        this.post({ type: 'assistant-done', usage });
      }
      if (changed.length) this.post({ type: 'run-changes', runId, files: changed });
      await record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'message', model: request.model, summary: `${request.skill ? `/${request.skill.name} run` : 'Agent run'} ${result.outcome}; ${changed.length} file(s) changed.`, estimatedCostUsd: usage.estimatedCostUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
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

  public stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.releasePending();
  }

  /** Undoes every file change a run made with the file tools. */
  public async revert(runId: string): Promise<string[]> {
    const checkpoints = this.runs.get(runId) ?? await RunCheckpoints.load(runId, this.checkpointDir);
    if (!checkpoints) return [];
    const restored = await checkpoints.revert();
    this.runs.delete(runId);
    return restored.map((file) => displayPath(this.root, file));
  }

  public reset(): void {
    this.stop();
    this.messages = [];
    this.shell?.dispose();
    this.shell = undefined;
  }

  public dispose(): void { this.reset(); }

  private systemPrompt(request: AgentTurnRequest): string {
    const base = agentSystemPrompt({ root: this.root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: existsSync(path.join(this.root, '.git')), model: request.model });
    if (!request.gsd) return base;
    return `${base}\n\n# Open-GSD\nOpen-GSD is installed at ${request.gsd.home} (read-only to you). Its skills, agents, workflows, templates, and references live there; read them with Read when instructions point to them. Run gsd-tools as the workflows show; CLAUDE_CONFIG_DIR is already set in your shell. When a workflow says to spawn an agent, use the Agent tool with that subagent_type. When it says to ask the user, use AskUserQuestion.`;
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

  private toolsFor(request: AgentTurnRequest, context: Omit<ToolContext, 'signal' | 'onTodos'>, grants: RunGrants, extraUsage: UsageMetadata[], record: (event: Parameters<ActivityStore['append']>[1]) => Promise<unknown>): AgentTool<any>[] {
    if (!request.gsd) return CORE_TOOLS;
    const gsd = request.gsd;
    let all: AgentTool<any>[] = [];
    const extra = gsdTools({
      home: gsd.home,
      root: this.root,
      skills: gsd.skills,
      agents: gsd.agents,
      ask: (questions, askSignal) => this.askQuestions(questions, askSignal),
      spawn: async (spawn, spawnSignal) => {
        const label = spawn.agent?.name ?? spawn.type;
        const prefix = `${label}-${randomBytes(3).toString('hex')}`;
        const wanted = modelForTier(spawn.model ?? spawn.agent?.model, request.tiers ?? { deep: request.model, standard: request.model, fast: request.model }, request.model);
        const model = !request.availableModels || request.availableModels.includes(wanted) ? wanted : request.model;
        const system = spawn.agent ? `${await expandPrompt(spawn.agent.body, { home: gsd.home, root: this.root })}\n\n${this.systemPrompt({ ...request, model })}` : this.systemPrompt({ ...request, model });
        const allowed = spawn.agent?.tools.length ? all.filter((tool) => spawn.agent!.tools.includes(tool.name) || (tool.name === 'Task' && spawn.agent!.tools.includes('Agent'))) : all.filter((tool) => tool.name !== 'Agent' && tool.name !== 'Task');
        this.activeAgents += 1;
        this.post({ type: 'agents', count: this.activeAgents });
        void record({ status: 'running', kind: 'agent', agentRole: label, model, summary: `Sub-agent ${label} started.` });
        try {
          const child = new AgentRun({
            client: request.client, model, tools: allowed, context, policy: request.policy, rules: request.rules, grants,
            requestApproval: (approval) => this.askApproval({ ...approval, callId: `${prefix}:${approval.callId}`, title: `${label} › ${approval.title}` }, spawnSignal),
            emit: (event) => {
              if (event.type === 'tool-start') this.forward({ ...event, callId: `${prefix}:${event.callId}`, title: `${label} › ${event.title}` }, model, record);
              else if (event.type === 'tool-end') this.forward({ ...event, callId: `${prefix}:${event.callId}` }, model, record);
              else if (event.type === 'turn') { extraUsage.push(event.usage); this.forward(event, model, record); }
            }
          });
          const result = await child.run([{ role: 'system', content: system }, { role: 'user', content: spawn.prompt }], spawnSignal);
          const report = [...result.messages].reverse().find((message) => message.role === 'assistant' && message.content)?.content;
          void record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'agent', agentRole: label, model, summary: `Sub-agent ${label} ${result.outcome}.` });
          return typeof report === 'string' && report.trim() ? report : `${label} finished without a written report.`;
        } catch (error) {
          void record({ status: 'failed', kind: 'agent', agentRole: label, model, summary: `Sub-agent ${label} failed.` });
          throw error;
        } finally {
          this.activeAgents -= 1;
          this.post({ type: 'agents', count: this.activeAgents });
        }
      }
    });
    all = [...CORE_TOOLS, ...extra];
    return all;
  }

  private forward(event: AgentEvent, model: string, record: (event: Parameters<ActivityStore['append']>[1]) => Promise<unknown>): void {
    if (event.type === 'text') this.post({ type: 'assistant-delta', text: event.text });
    else if (event.type === 'tool-start') { this.post({ type: 'tool-start', callId: event.callId, tool: event.tool, title: event.title }); void record({ status: 'running', kind: 'tool', tool: event.tool, summary: event.title.slice(0, 200) }); }
    else if (event.type === 'tool-end') { this.post({ type: 'tool-end', callId: event.callId, ok: event.ok, output: event.output }); void record({ status: event.ok ? 'completed' : 'failed', kind: 'tool', summary: event.ok ? 'Tool call finished.' : 'Tool call failed or was declined.' }); }
    else if (event.type === 'todos') this.post({ type: 'todos', todos: event.todos });
    else if (event.type === 'turn') void record({ status: 'completed', kind: 'model', model, requestId: event.usage.requestId, summary: 'Model turn completed.', estimatedCostUsd: event.usage.estimatedCostUsd, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, durationMs: event.usage.latencyMs });
  }

  private askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny' });
    return new Promise((resolve) => {
      this.approvals.set(request.callId, resolve);
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

/** Finds a skill by its name, its name without the `gsd-` prefix, or a legacy `gsd:name` form. */
export function findSkill(skills: GsdSkill[], name: string): GsdSkill | undefined {
  const wanted = name.replace(/^\//, '').trim();
  return skills.find((skill) => skill.name === wanted) ?? skills.find((skill) => skill.name === `gsd-${wanted}` || skill.name.replace(/:/g, '-') === wanted);
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
