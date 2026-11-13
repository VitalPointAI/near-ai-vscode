// Turns the model's message list into thread entries (D-07), the original messages the person saw, without the things only the model sees. Pure: no
// VS Code, no files. The thread log is built from this before the model's context is trimmed or compacted, so the log is never the compacted list.
import { createHash } from 'node:crypto';
import type { AgentMessage } from '../../services/nearAiClient';
import { capToolResult, entryId, type ThreadEntry } from './threadEntries';

/** The assistant message `compactConversation` puts after its summary. */
export const COMPACTION_ACK = 'Understood. Continuing from the summary.';

/** A short hash of a message's text; the key of the map from what the model saw to what the person typed (it survives compaction). */
export function contentKey(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 24);
}

/**
 * Whether a message belongs to the model's working context only: the system prompt, a conversation summary, the acknowledgement that follows it, and a
 * background agent's notification. None of these is something the person typed or saw, so none is written to the thread log.
 */
export function isSyntheticMessage(message: AgentMessage): boolean {
  if (message.role === 'system') return true;
  if (message.role === 'user') return message.content.startsWith('<conversation-summary>') || message.content.startsWith('<agent-notification');
  return message.role === 'assistant' && message.content === COMPACTION_ACK && !message.tool_calls?.length;
}

const COMMAND_PROMPT = /^The user ran (\/\S+(?: [^\n.]*)?)\. Follow these instructions:/;

/** The "/command args" a person typed when the message the model saw is a slash-command expansion; undefined otherwise. */
export function commandForm(content: string): string | undefined {
  return COMMAND_PROMPT.exec(content)?.[1];
}

export interface CaptureMeta {
  thread: string;
  writer: string;
  /** When the entries are written (an ISO time); the current time when omitted. */
  at?: string;
}

function parsedArguments(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The entries for `messages`, in order, chained from `parent`. Synthetic messages are skipped. A user message is stored as what the person typed
 * (the display text, or the slash-command form), with the model's own text only when it differs; a tool result is stored whole up to the 2 MiB cap
 * (D-12), which is the only shortening there is.
 */
export function messagesToEntries(messages: readonly AgentMessage[], display: ReadonlyMap<string, string>, parent: string | null, meta: CaptureMeta): ThreadEntry[] {
  const at = meta.at ?? new Date().toISOString();
  const entries: ThreadEntry[] = [];
  let last = parent;
  const push = (role: ThreadEntry['role'], body: unknown): void => {
    const id = entryId(last, role, body);
    entries.push({ id, thread: meta.thread, parent: last, at, writer: meta.writer, role, body });
    last = id;
  };
  for (const message of messages) {
    if (isSyntheticMessage(message)) continue;
    if (message.role === 'user') {
      const text = display.get(contentKey(message.content)) ?? commandForm(message.content) ?? message.content;
      push('user', text === message.content ? { text } : { text, modelText: message.content });
    } else if (message.role === 'assistant') {
      if (message.content) push('assistant', { text: message.content });
      for (const call of message.tool_calls ?? []) push('tool-call', { callId: call.id, name: call.function.name, args: parsedArguments(call.function.arguments) });
    } else if (message.role === 'tool') {
      const { text, shortenedBytes } = capToolResult(message.content);
      push('tool-result', { callId: message.tool_call_id, output: text, ...(shortenedBytes !== undefined ? { shortenedBytes } : {}) });
    }
  }
  return entries;
}
