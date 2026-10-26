import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { RunCheckpoints } from '../agent/checkpoints';
import { AgentRun, ApprovalReply, ApprovalRequest } from '../agent/loop';
import { PermissionRules } from '../agent/permissions';
import { ShellSession } from '../agent/shell';
import { agentSystemPrompt } from '../agent/systemPrompt';
import { CORE_TOOLS } from '../agent/tools';
import { displayPath } from '../agent/workspace';
import type { ActionPolicy } from '../domain/policy';
import type { ActivityStore } from './activityStore';
import type { AgentMessage, NearAiClient, UsageMetadata } from './nearAiClient';

export interface AgentTurnRequest {
  text: string;
  client: NearAiClient;
  model: string;
  privacy: string;
  policy: ActionPolicy;
  rules: PermissionRules;
  activity?: { store: ActivityStore; sessionId: string };
  /** A local runtime has no billing API to ask for actual costs. */
  local?: boolean;
}

/**
 * One sidebar conversation with the agent. Keeps the message history and a persistent shell
 * across turns, routes approval cards to the webview and back, and keeps each run's file
 * checkpoints so the user can revert it.
 */
export class AgentConversation {
  private messages: AgentMessage[] = [];
  private shell: ShellSession | undefined;
  private abort: AbortController | undefined;
  private readonly approvals = new Map<string, (reply: ApprovalReply) => void>();
  private readonly runs = new Map<string, RunCheckpoints>();

  public constructor(
    private readonly root: string,
    private readonly post: (message: Record<string, unknown>) => void,
    private readonly checkpointDir: string,
    private readonly ripgrepPath?: string
  ) {}

  public get running(): boolean { return Boolean(this.abort); }

  public async send(request: AgentTurnRequest): Promise<void> {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    const runId = `run-${Date.now()}-${randomBytes(3).toString('hex')}`;
    const checkpoints = new RunCheckpoints(runId, this.checkpointDir);
    this.runs.set(runId, checkpoints);
    this.shell = this.shell ?? new ShellSession(this.root);
    if (!this.messages.length) {
      this.messages.push({ role: 'system', content: agentSystemPrompt({ root: this.root, platform: `${process.platform} ${process.arch}`, date: new Date().toISOString().slice(0, 10), isGitRepo: existsSync(path.join(this.root, '.git')), model: request.model }) });
    }
    this.messages.push({ role: 'user', content: request.text });
    this.post({ type: 'assistant-start', model: request.model, privacy: request.privacy });
    const record = (event: Parameters<ActivityStore['append']>[1]) => request.activity ? request.activity.store.append(request.activity.sessionId, event).catch(() => undefined) : Promise.resolve();
    const run = new AgentRun({
      client: request.client,
      model: request.model,
      tools: CORE_TOOLS,
      context: { root: this.root, checkpoints, shell: this.shell, readFiles: new Set(), ripgrepPath: this.ripgrepPath },
      policy: request.policy,
      rules: request.rules,
      requestApproval: (approval) => this.askApproval(approval, abort.signal),
      emit: (event) => {
        if (event.type === 'text') this.post({ type: 'assistant-delta', text: event.text });
        else if (event.type === 'tool-start') { this.post({ type: 'tool-start', callId: event.callId, tool: event.tool, title: event.title }); void record({ status: 'running', kind: 'tool', tool: event.tool, summary: event.title.slice(0, 200) }); }
        else if (event.type === 'tool-end') { this.post({ type: 'tool-end', callId: event.callId, ok: event.ok, output: event.output }); void record({ status: event.ok ? 'completed' : 'failed', kind: 'tool', summary: event.ok ? 'Tool call finished.' : 'Tool call failed or was declined.' }); }
        else if (event.type === 'todos') this.post({ type: 'todos', todos: event.todos });
        else if (event.type === 'turn') void record({ status: 'completed', kind: 'model', model: request.model, requestId: event.usage.requestId, summary: 'Model turn completed.', estimatedCostUsd: event.usage.estimatedCostUsd, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens, durationMs: event.usage.latencyMs });
      }
    });
    try {
      const result = await run.run(this.messages, abort.signal);
      this.messages = result.messages;
      const usage = sumUsage(result.usage);
      const changed = checkpoints.changedFiles.map((file) => displayPath(this.root, file));
      if (result.outcome === 'cancelled') this.post({ type: 'assistant-cancelled' });
      else {
        if (result.outcome === 'max-turns') this.post({ type: 'assistant-delta', text: '\n\n_Stopped after reaching the turn limit. Send a message to continue._' });
        this.post({ type: 'assistant-done', usage });
      }
      if (changed.length) this.post({ type: 'run-changes', runId, files: changed });
      await record({ status: result.outcome === 'cancelled' ? 'cancelled' : 'completed', kind: 'message', model: request.model, summary: `Agent run ${result.outcome}; ${changed.length} file(s) changed.`, estimatedCostUsd: usage.estimatedCostUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      const ids = result.usage.map((turn) => turn.requestId).filter((id): id is string => Boolean(id));
      if (result.outcome !== 'cancelled' && ids.length && !request.local) {
        const actual = await request.client.actualCostsUsd(ids).catch(() => undefined);
        if (actual !== undefined) {
          this.post({ type: 'assistant-cost', actualCostUsd: actual });
          await record({ status: 'completed', kind: 'model', model: request.model, summary: 'Actual cost reported by NEAR AI.', actualCostUsd: actual });
        }
      }
    } finally {
      if (this.abort === abort) this.abort = undefined;
      for (const resolve of this.approvals.values()) resolve({ decision: 'deny' });
      this.approvals.clear();
    }
  }

  public answerApproval(callId: string, reply: ApprovalReply): void {
    this.approvals.get(callId)?.(reply);
    this.approvals.delete(callId);
  }

  public stop(): void {
    this.abort?.abort();
    this.abort = undefined;
    for (const resolve of this.approvals.values()) resolve({ decision: 'deny' });
    this.approvals.clear();
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

  private askApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalReply> {
    if (signal.aborted) return Promise.resolve({ decision: 'deny' });
    return new Promise((resolve) => {
      this.approvals.set(request.callId, resolve);
      this.post({ type: 'approval-request', callId: request.callId, tool: request.tool, title: request.title, preview: request.preview });
    });
  }
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
