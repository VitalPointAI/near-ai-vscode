import { contextLevel } from '../domain/continuity';
import type { AgentMessage, CompletionEvent, ToolDefinition } from '../services/nearAiClient';
import { withSpendTag } from '../services/spendLedger';

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

/** Trimming advances in steps of this many tool results, so the conversation's start changes rarely. */
const TRIM_STEP = 10;

/**
 * First, cheap step: shorten large tool outputs except the most recent ones. Returns a new array.
 * NEAR caches prompt prefixes, and rewriting an early message makes every later turn miss the
 * cache, so the trimmed region grows in steps of TRIM_STEP rather than by one result each turn.
 */
export function trimOldToolResults(messages: AgentMessage[], keepRecent = KEEP_RECENT_TOOL_RESULTS, step = TRIM_STEP): AgentMessage[] {
  const toolIndexes = messages.map((message, index) => (message.role === 'tool' ? index : -1)).filter((index) => index >= 0);
  const trimmable = Math.floor(Math.max(0, toolIndexes.length - keepRecent) / step) * step;
  const protectedIndexes = new Set(toolIndexes.slice(trimmable));
  return messages.map((message, index) => {
    if (message.role !== 'tool' || protectedIndexes.has(index) || message.content.length <= TRIM_TOOL_RESULT_CHARS) return message;
    return { ...message, content: `${message.content.slice(0, 600)}\n\n[Older tool output trimmed to save context; ${message.content.length - 600} characters removed. Re-run the tool if you need it.]` };
  });
}

/**
 * Second step: ask the model to summarize everything before the most recent exchanges, then
 * continue from [system, summary, recent]. The cut lands at the start of a user message or of an
 * assistant message (with the tool results that follow it), never between a tool call and its
 * result, so a long run from a single request can be summarized too. Returns undefined when there
 * is nothing worth summarizing (nothing older than the recent messages, or less than a fifth of the
 * conversation), so the caller does not report a summary that never happened.
 */
export async function compactConversation(client: Client, model: string, messages: AgentMessage[], signal: AbortSignal, keepRecentMessages = 8): Promise<AgentMessage[] | undefined> {
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const body = messages.slice(system.length);
  let cut = Math.max(0, body.length - keepRecentMessages);
  while (cut > 0 && body[cut].role !== 'user' && body[cut].role !== 'assistant') cut -= 1;
  if (cut <= 0) return undefined;
  const older = body.slice(0, cut);
  // Summarizing a sliver (say, only the previous summary) frees almost nothing and would repeat on every turn.
  if (estimateTokens(older) < estimateTokens(body) / 5) return undefined;
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
  // Recorded in the spend ledger as a summary request of the run that needed it.
  const summary = await withSpendTag({ kind: 'summary' }, async () => {
    let text = '';
    for await (const event of client.streamCompletion(model, request, [], signal)) if (event.type === 'done') text = event.message.content ?? '';
    return text;
  });
  if (!summary.trim()) throw new Error('The model returned an empty summary.');
  const summaryMessage: AgentMessage = { role: 'user', content: `<conversation-summary>\nEarlier parts of this conversation were summarized to save context:\n\n${summary.trim()}\n</conversation-summary>` };
  // A kept part that starts with the assistant's own tool calls follows the summary directly, so two assistant messages never sit side by side.
  if (recent[0].role === 'assistant') return [...system, summaryMessage, ...recent];
  return [...system, summaryMessage, { role: 'assistant', content: 'Understood. Continuing from the summary.' }, ...recent];
}
