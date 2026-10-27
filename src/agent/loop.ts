import type { ActionCapability, ActionPolicy } from '../domain/policy';
import type { AgentMessage, CompletionEvent, ToolCall, ToolDefinition, UsageMetadata } from '../services/nearAiClient';
import { decidePermission, normalizeCommand, PermissionRules, RunGrants } from './permissions';
import { truncate } from './shell';
import type { AgentTool, Todo, ToolContext, ToolPreview } from './tools';
import { ToolError } from './workspace';

export interface ApprovalRequest { callId: string; tool: string; title: string; capability: ActionCapability; preview?: ToolPreview }
export interface ApprovalReply { decision: 'allow' | 'allow-run' | 'deny'; feedback?: string }

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; callId: string; tool: string; title: string }
  | { type: 'tool-end'; callId: string; ok: boolean; output: string }
  | { type: 'todos'; todos: Todo[] }
  | { type: 'turn'; model: string; usage: UsageMetadata };

export type RunOutcome = 'completed' | 'max-turns' | 'cancelled';

export interface AgentRunOptions {
  client: { streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<CompletionEvent> };
  model: string;
  tools: AgentTool<any>[];
  context: Omit<ToolContext, 'signal' | 'onTodos'>;
  policy: ActionPolicy;
  rules: PermissionRules;
  maxTurns?: number;
  /** Shared with sub-agents so "allow for this run" covers the whole run. */
  grants?: RunGrants;
  requestApproval(request: ApprovalRequest): Promise<ApprovalReply>;
  emit(event: AgentEvent): void;
}

export interface RunResult { outcome: RunOutcome; messages: AgentMessage[]; usage: UsageMetadata[] }

const MAX_TOOL_RESULT_CHARS = 40_000;
const UI_OUTPUT_CHARS = 6_000;

/**
 * One agent run: model turns alternate with tool execution until the model answers without
 * calling a tool, the turn limit is reached, or the run is cancelled.
 */
export class AgentRun {
  public readonly grants: RunGrants;
  private readonly byName: Map<string, AgentTool<any>>;
  private readonly definitions: ToolDefinition[];

  public constructor(private readonly options: AgentRunOptions) {
    this.grants = options.grants ?? new RunGrants();
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.definitions = options.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  }

  public async run(messages: AgentMessage[], signal: AbortSignal): Promise<RunResult> {
    const transcript = [...messages];
    const usage: UsageMetadata[] = [];
    const maxTurns = this.options.maxTurns ?? 60;
    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        let assistant: Extract<AgentMessage, { role: 'assistant' }> | undefined;
        for await (const event of this.options.client.streamCompletion(this.options.model, transcript, this.definitions, signal)) {
          if (event.type === 'text') this.options.emit({ type: 'text', text: event.text });
          else if (event.type === 'reasoning') this.options.emit({ type: 'reasoning', text: event.text });
          else {
            assistant = event.message;
            usage.push(event.usage);
            this.options.emit({ type: 'turn', model: this.options.model, usage: event.usage });
          }
        }
        if (!assistant) throw new Error('The model ended its turn without a response.');
        transcript.push(assistant);
        if (!assistant.tool_calls?.length) return { outcome: 'completed', messages: transcript, usage };
        transcript.push(...await this.executeCalls(assistant.tool_calls, signal));
      }
      return { outcome: 'max-turns', messages: transcript, usage };
    } catch (error) {
      if (signal.aborted) return { outcome: 'cancelled', messages: transcript, usage };
      throw error;
    }
  }

  /** Runs consecutive read-only calls together; anything that changes state runs alone, in order. */
  private async executeCalls(calls: ToolCall[], signal: AbortSignal): Promise<AgentMessage[]> {
    const results: AgentMessage[] = [];
    let index = 0;
    while (index < calls.length) {
      const batch = [calls[index]];
      if (this.isReadOnly(calls[index])) while (index + batch.length < calls.length && this.isReadOnly(calls[index + batch.length])) batch.push(calls[index + batch.length]);
      const outputs = await Promise.all(batch.map((call) => this.executeCall(call, signal)));
      batch.forEach((call, offset) => results.push({ role: 'tool', tool_call_id: call.id, content: outputs[offset] }));
      index += batch.length;
    }
    return results;
  }

  private isReadOnly(call: ToolCall): boolean {
    const capability = this.byName.get(call.function.name)?.capability;
    return capability === 'read' || capability === 'plan';
  }

  private async executeCall(call: ToolCall, signal: AbortSignal): Promise<string> {
    if (signal.aborted) return 'Cancelled before this tool ran.';
    const tool = this.byName.get(call.function.name);
    if (!tool) return `Error: unknown tool "${call.function.name}". Available tools: ${[...this.byName.keys()].join(', ')}.`;
    const context: ToolContext = { ...this.options.context, signal, onTodos: (todos) => this.options.emit({ type: 'todos', todos }) };
    let input: unknown;
    let title = tool.name;
    try {
      const raw = JSON.parse(call.function.arguments || '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError('Arguments must be a JSON object.');
      input = tool.parse(raw as Record<string, unknown>);
      title = tool.title(input, context);
    } catch (error) {
      const message = error instanceof SyntaxError ? `Arguments are not valid JSON: ${error.message}` : (error as Error).message;
      this.options.emit({ type: 'tool-start', callId: call.id, tool: tool.name, title });
      this.options.emit({ type: 'tool-end', callId: call.id, ok: false, output: message });
      return `Error: ${message}`;
    }
    this.options.emit({ type: 'tool-start', callId: call.id, tool: tool.name, title });
    const command = tool.capability === 'shell' ? String((input as { command?: unknown }).command ?? '') : undefined;
    const sensitive = tool.sensitive?.(input);
    const decided = decidePermission(tool.capability, command, this.options.policy, this.options.rules, this.grants);
    const permission = sensitive && decided.decision === 'allow' && this.options.policy.mode !== 'fully-autonomous' ? { decision: 'ask' as const } : decided;
    if (permission.decision === 'deny') return this.finish(call.id, false, `Not allowed: ${permission.reason}`);
    if (permission.decision === 'ask') {
      let preview: ToolPreview | undefined;
      try { preview = sensitive ? { kind: 'note', text: sensitive } : await tool.preview?.(input, context); } catch (error) { return this.finish(call.id, false, `Error: ${(error as Error).message}`); }
      const reply = await this.options.requestApproval({ callId: call.id, tool: tool.name, title, capability: tool.capability, preview });
      if (reply.decision === 'deny') return this.finish(call.id, false, `The user declined this action.${reply.feedback ? ` Their note: ${reply.feedback}` : ''} Do not retry it unchanged; adjust or ask what they want.`);
      if (reply.decision === 'allow-run') {
        if (tool.capability === 'workspaceWrite') this.grants.edits = true;
        if (command) this.grants.commands.add(normalizeCommand(command));
      }
    }
    try {
      return this.finish(call.id, true, await tool.run(input, context));
    } catch (error) {
      if (signal.aborted) return this.finish(call.id, false, 'Cancelled.');
      return this.finish(call.id, false, `Error: ${(error as Error).message}`);
    }
  }

  private finish(callId: string, ok: boolean, output: string): string {
    const bounded = output.length > MAX_TOOL_RESULT_CHARS ? truncate(output) : output;
    this.options.emit({ type: 'tool-end', callId, ok, output: bounded.length > UI_OUTPUT_CHARS ? `${bounded.slice(0, UI_OUTPUT_CHARS)}\n…` : bounded });
    return bounded;
  }
}
