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
