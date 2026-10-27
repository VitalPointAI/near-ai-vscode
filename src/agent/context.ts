import { contextLevel } from '../domain/continuity';
import type { AgentMessage, CompletionEvent, ToolDefinition } from '../services/nearAiClient';

export const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Open-GSD's defaults: warn when 35% of the window remains, act at 25%. */
export const DEFAULT_THRESHOLDS = { warningRemaining: 35, criticalRemaining: 25 };
const KEEP_RECENT_TOOL_RESULTS = 8;
const TRIM_TOOL_RESULT_CHARS = 2_000;

type Client = { streamCompletion(model: string, messages: AgentMessage[], tools: ToolDefinition[], signal?: AbortSignal): AsyncGenerator<CompletionEvent> };

/** A rough token count (about four characters per token), used when the provider has not reported one yet. */
export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content ?? '').length + 16;
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) chars += call.function.name.length + call.function.arguments.length;
  }
  return Math.ceil(chars / 4);
}

export interface ContextStatus { usedTokens: number; window: number; remainingPercent: number; level: 'normal' | 'warning' | 'critical' }

export function contextStatus(usedTokens: number, window: number, thresholds = DEFAULT_THRESHOLDS): ContextStatus {
  const remainingPercent = Math.max(0, Math.round(100 - (usedTokens / Math.max(1, window)) * 100));
  const level = contextLevel(remainingPercent, { warningRemaining: thresholds.warningRemaining, criticalRemaining: thresholds.criticalRemaining });
  return { usedTokens, window, remainingPercent, level: level === 'critical' ? 'critical' : level === 'warning' ? 'warning' : 'normal' };
}

/** First, cheap step: shorten large tool outputs except the most recent ones. Returns a new array. */
export function trimOldToolResults(messages: AgentMessage[], keepRecent = KEEP_RECENT_TOOL_RESULTS): AgentMessage[] {
  const toolIndexes = messages.map((message, index) => (message.role === 'tool' ? index : -1)).filter((index) => index >= 0);
  const protectedIndexes = new Set(toolIndexes.slice(-keepRecent));
  return messages.map((message, index) => {
    if (message.role !== 'tool' || protectedIndexes.has(index) || message.content.length <= TRIM_TOOL_RESULT_CHARS) return message;
    return { ...message, content: `${message.content.slice(0, 600)}\n\n[Older tool output trimmed to save context; ${message.content.length - 600} characters removed. Re-run the tool if you need it.]` };
  });
}

/**
 * Second step: ask the model to summarize everything before the most recent exchanges, then
 * continue from [system, summary, recent]. The cut always lands on a user message so no tool
 * call is separated from its result.
 */
export async function compactConversation(client: Client, model: string, messages: AgentMessage[], signal: AbortSignal, keepRecentMessages = 8): Promise<AgentMessage[]> {
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const body = messages.slice(system.length);
  let cut = Math.max(0, body.length - keepRecentMessages);
  while (cut > 0 && body[cut].role !== 'user') cut -= 1;
  if (cut <= 0) return messages;
  const older = body.slice(0, cut);
  const recent = body.slice(cut);
  const transcript = older.map((message) => {
    if (message.role === 'tool') return `[tool result] ${message.content.slice(0, 1_500)}`;
    if (message.role === 'assistant') return `[assistant] ${message.content ?? ''}${message.tool_calls?.length ? ` (called ${message.tool_calls.map((call) => `${call.function.name} ${call.function.arguments.slice(0, 200)}`).join('; ')})` : ''}`;
    return `[${message.role}] ${message.content}`;
  }).join('\n\n');
  const request: AgentMessage[] = [
    { role: 'system', content: 'You compress an agent conversation so the work can continue in a smaller context. Write a faithful summary, not a new answer.' },
    { role: 'user', content: `Summarize this conversation for the agent continuing it. Keep: the user's goal and constraints, decisions made, files read and changed (with paths), commands run and their results, errors still open, the current state, and the exact next steps. Be specific and concise.\n\n<conversation>\n${transcript}\n</conversation>` }
  ];
  let summary = '';
  for await (const event of client.streamCompletion(model, request, [], signal)) if (event.type === 'done') summary = event.message.content ?? '';
  if (!summary.trim()) throw new Error('The model returned an empty summary.');
  return [...system, { role: 'user', content: `<conversation-summary>\nEarlier parts of this conversation were summarized to save context:\n\n${summary.trim()}\n</conversation-summary>` }, { role: 'assistant', content: 'Understood. Continuing from the summary.' }, ...recent];
}
