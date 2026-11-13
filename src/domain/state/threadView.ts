// How a thread's entries are shown and how they become the model's messages again. Pure: no VS Code, no files.
import type { AgentMessage, ToolCall } from '../../services/nearAiClient';
import type { ThreadEntry, ThreadLines } from './threadEntries';

/** One turn of the reopened view: what the person typed, or what the agent answered with a count of the tool steps it took. */
export interface ViewTurn { role: 'user' | 'assistant'; text: string; tools: number }

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}

function textOf(body: unknown, name = 'text'): string {
  const value = field(body, name);
  return typeof value === 'string' ? value : '';
}

/**
 * The turns of the main line, in the shape the view already shows: a user turn per user entry, and one assistant turn for each run of assistant
 * text and tool steps between two user entries.
 */
export function entriesToTurns(lines: Pick<ThreadLines, 'main'>): ViewTurn[] {
  const turns: ViewTurn[] = [];
  for (const entry of lines.main) {
    if (entry.role === 'user') {
      turns.push({ role: 'user', text: textOf(entry.body), tools: 0 });
    } else if (entry.role === 'assistant') {
      const text = textOf(entry.body);
      const last = turns.at(-1);
      if (last?.role === 'assistant') last.text += text ? `${last.text ? '\n\n' : ''}${text}` : '';
      else turns.push({ role: 'assistant', text, tools: 0 });
    } else if (entry.role === 'tool-call') {
      const last = turns.at(-1);
      if (last?.role === 'assistant') last.tools += 1;
      else turns.push({ role: 'assistant', text: '', tools: 1 });
    }
  }
  return turns;
}

/**
 * Rebuilds the model's messages from the main line so the agent loop accepts them: a user message carries the text the model saw (the stored model
 * text, else what the person typed), an assistant message carries its text and the tool calls that follow it, and a tool result becomes a tool message.
 * Consecutive tool-call entries belong to one assistant message.
 */
export function entriesToMessages(main: readonly ThreadEntry[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const attach = (entry: ThreadEntry): void => {
    const args = field(entry.body, 'args');
    const call: ToolCall = {
      id: textOf(entry.body, 'callId'),
      type: 'function',
      function: { name: textOf(entry.body, 'name'), arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
    };
    const last = messages.at(-1);
    if (last?.role === 'assistant') last.tool_calls = [...(last.tool_calls ?? []), call];
    else messages.push({ role: 'assistant', content: '', tool_calls: [call] });
  };
  for (const entry of main) {
    if (entry.role === 'user') {
      messages.push({ role: 'user', content: textOf(entry.body, 'modelText') || textOf(entry.body) });
    } else if (entry.role === 'assistant') {
      messages.push({ role: 'assistant', content: textOf(entry.body) });
    } else if (entry.role === 'tool-call') {
      attach(entry);
    } else if (entry.role === 'tool-result') {
      messages.push({ role: 'tool', tool_call_id: textOf(entry.body, 'callId'), content: textOf(entry.body, 'output') });
    }
  }
  return messages;
}

// ---- the full view of a reopened thread (D-07) ------------------------------------------------------------------------------------------

/** What the view shows for a thread that was migrated with only part of its earlier messages (Pitfall 15). */
export const PARTIAL_HISTORY_NOTE = 'Earlier messages of this chat were summarised before this version and cannot be restored';

/** The line before a continuation the main line does not contain: the thread was also continued on another computer. */
export const OTHER_CONTINUATION_LABEL = 'Also continued on another computer';

/** The history marker a thread migrated from before 0.4.20 carries when its earliest messages were already summarised away. */
export const PARTIAL_HISTORY = 'partial-before-0.4.20';

/** The most characters of a tool call's arguments the view carries; the log keeps them whole. The card shows a one-line preview of them. */
export const VIEW_ARGS_LIMIT = 2_000;

/** One thing the reopened view shows, in the order it happened. A tool step carries no output: the card asks for it when it is opened. */
export type ViewItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | {
    kind: 'tool';
    /** The id of the tool-call entry: what the card asks the host for. */
    entryId: string;
    name: string;
    args: string;
    /** Whether the call has a stored result. */
    ok: boolean;
    shortenedBytes?: number;
    /** Said on the card when the stored output was cut at the 2 MiB cap (D-12), for example "output shortened, 3 MB". */
    note?: string;
  }
  | { kind: 'notice'; text: string }
  | { kind: 'divider'; text: string };

/** "output shortened, 3 MB": how much of a tool result was not stored. One decimal at most, and no ".0". */
export function shortenedNote(bytes: number): string {
  const megabytes = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `output shortened, ${megabytes} MB`;
}

/**
 * Pairs each tool call of a run of entries with its result: the first result with the same call id after it. A provider may reuse a call id in a later
 * turn, so a result answers the nearest call before it. Keys are the ids of the tool-call entries.
 */
export function pairToolResults(segment: readonly ThreadEntry[]): Map<string, ThreadEntry> {
  const open = new Map<string, string>();
  const pairs = new Map<string, ThreadEntry>();
  for (const entry of segment) {
    const callId = textOf(entry.body, 'callId');
    if (entry.role === 'tool-call') open.set(callId, entry.id);
    else if (entry.role === 'tool-result' && open.has(callId)) { pairs.set(open.get(callId)!, entry); open.delete(callId); }
  }
  return pairs;
}

function argumentsText(body: unknown): string {
  const args = field(body, 'args');
  const text = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return text.length > VIEW_ARGS_LIMIT ? `${text.slice(0, VIEW_ARGS_LIMIT)}…` : text;
}

function segmentItems(segment: readonly ThreadEntry[]): ViewItem[] {
  const results = pairToolResults(segment);
  const answered = new Set([...results.values()].map((entry) => entry.id));
  const items: ViewItem[] = [];
  for (const entry of segment) {
    if (entry.role === 'user') items.push({ kind: 'user', text: textOf(entry.body) });
    else if (entry.role === 'assistant') items.push({ kind: 'assistant', text: textOf(entry.body) });
    else if (entry.role === 'notice') items.push({ kind: 'notice', text: textOf(entry.body) });
    else if (entry.role === 'tool-call') {
      const result = results.get(entry.id);
      const shortened = result ? field(result.body, 'shortenedBytes') : undefined;
      const shortenedBytes = typeof shortened === 'number' && Number.isFinite(shortened) && shortened > 0 ? shortened : undefined;
      items.push({ kind: 'tool', entryId: entry.id, name: textOf(entry.body, 'name') || 'tool', args: argumentsText(entry.body), ok: result !== undefined, ...(shortenedBytes !== undefined ? { shortenedBytes, note: shortenedNote(shortenedBytes) } : {}) });
    } else if (entry.role === 'tool-result' && !answered.has(entry.id)) {
      // A result whose call has not arrived (a partial delivery) is still shown, as a step of its own, so nothing is hidden.
      const shortened = field(entry.body, 'shortenedBytes');
      const shortenedBytes = typeof shortened === 'number' && Number.isFinite(shortened) && shortened > 0 ? shortened : undefined;
      items.push({ kind: 'tool', entryId: entry.id, name: 'tool', args: '', ok: true, ...(shortenedBytes !== undefined ? { shortenedBytes, note: shortenedNote(shortenedBytes) } : {}) });
    }
  }
  return items;
}

/**
 * Every entry of a thread as the reopened view shows it, in order: the main line first (a tool call and its result are one card), then each other
 * continuation after a divider. A thread migrated with partial history starts with a note saying so. Nothing is skipped and nothing is cut off.
 */
export function entriesToView(lines: Pick<ThreadLines, 'main' | 'branches'>, meta: { history?: string } = {}): ViewItem[] {
  const items: ViewItem[] = [];
  if (meta.history === PARTIAL_HISTORY) items.push({ kind: 'notice', text: PARTIAL_HISTORY_NOTE });
  items.push(...segmentItems(lines.main));
  for (const branch of lines.branches) {
    items.push({ kind: 'divider', text: OTHER_CONTINUATION_LABEL }, ...segmentItems(branch.entries));
  }
  return items;
}

/** The items cut into batches of at most `size`, in order, so a long thread reaches the view in pieces. */
export function batchView<T>(items: readonly T[], size = 200): T[][] {
  const step = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += step) batches.push(items.slice(start, start + step));
  return batches;
}
