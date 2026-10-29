import { runTitleFor } from './activityOverview';

// The sidebar keeps several conversations open at once, as Claude Code does: each has its own
// agent, run, prompts, and transcript, and the view shows one. This module holds the parts
// without VS Code: titles, status, the saved list, and the log a conversation keeps of what it
// sent the view, so switching to it (or a reloaded view) shows it again.

/** Conversations open at once; starting another asks to close one. */
export const MAX_OPEN_CONVERSATIONS = 8;

export type ConversationStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';
/** How the last turn ended, when nothing is running or waiting. */
export type ConversationOutcome = 'idle' | 'done' | 'error' | 'stopped';

export interface ConversationSummary {
  id: string;
  title: string;
  status: ConversationStatus;
  /** Output arrived while another conversation was on screen. */
  unread: boolean;
  /** Approvals and questions waiting for the user. */
  waiting: number;
}

const CONVERSATION_ID = /^conv-[a-z0-9-]{6,60}$/;
export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value);
}

/** A conversation's tab title: the first line of what was asked, redacted as run titles are, about 40 characters. */
export function conversationTitle(text: string): string | undefined {
  const title = runTitleFor(text);
  if (!title) return undefined;
  return title.length > 40 ? `${title.slice(0, 39).trimEnd()}…` : title;
}

/** Waiting for the user beats running, which beats how the last turn ended. */
export function conversationStatus(input: { running: boolean; waiting: number; outcome: ConversationOutcome }): ConversationStatus {
  if (input.waiting > 0) return 'waiting';
  if (input.running) return 'running';
  return input.outcome;
}

/** The turn outcome a message the conversation posted implies, if any. */
export function outcomeOf(message: Record<string, unknown>): ConversationOutcome | undefined {
  switch (message.type) {
    case 'assistant-done': return 'done';
    case 'assistant-cancelled': return 'stopped';
    case 'assistant-error': case 'outbound-blocked': case 'auth-required': return 'error';
    default: return undefined;
  }
}

/** Messages that count as new output in a conversation that is not on screen. */
const OUTPUT = new Set(['assistant-delta', 'assistant-done', 'assistant-error', 'assistant-cancelled', 'tool-start', 'notice', 'approval-request', 'questions-request', 'outbound-blocked', 'run-changes']);
export function isOutput(message: Record<string, unknown>): boolean { return OUTPUT.has(String(message.type)); }

/** The open conversations, kept in the workspace's state so a reload reopens them. */
export interface SavedConversations {
  activeId?: string;
  /** `running` marks one whose run (or prompt) a reload cut off. */
  items: Array<{ id: string; title: string; status: ConversationOutcome | 'running' }>;
}

const SAVED_STATUSES = new Set(['idle', 'done', 'error', 'stopped', 'running']);

/** Reads the saved list strictly: anything malformed is dropped, never trusted. */
export function parseSavedConversations(value: unknown): SavedConversations {
  if (!value || typeof value !== 'object') return { items: [] };
  const raw = value as { activeId?: unknown; items?: unknown };
  const items: SavedConversations['items'] = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!item || typeof item !== 'object') continue;
    const { id, title, status } = item as Record<string, unknown>;
    if (!isConversationId(id) || items.some((existing) => existing.id === id)) continue;
    items.push({ id, title: typeof title === 'string' ? conversationTitle(title) ?? '' : '', status: typeof status === 'string' && SAVED_STATUSES.has(status) ? status as SavedConversations['items'][number]['status'] : 'idle' });
    if (items.length >= MAX_OPEN_CONVERSATIONS) break;
  }
  return { ...(isConversationId(raw.activeId) && items.some((item) => item.id === raw.activeId) ? { activeId: raw.activeId } : {}), items };
}

/** What is saved for a summary list: a waiting or running conversation is one a reload would cut off. */
export function savedConversations(items: ConversationSummary[], activeId: string | undefined): SavedConversations {
  return { ...(activeId ? { activeId } : {}), items: items.map((item) => ({ id: item.id, title: item.title, status: item.status === 'waiting' || item.status === 'running' ? 'running' : item.status })) };
}

type Message = Record<string, unknown>;
/** How a settled prompt ended, as the view words it (allow, allow-run, deny, answered, expired, cancelled, closed). */
export interface PromptOutcome { outcome: string; detail?: string | number }

const PANELS = new Set(['agents', 'todos', 'context']);
/** Tool output kept for showing again; the full output is in the run's own context. */
const MAX_REPLAYED_OUTPUT = 20_000;

/**
 * What a conversation sent the view, so it can be shown again: when the user switches back to
 * it, or the view reloads. Streamed text is merged into one entry, the panels (agents, tasks,
 * context) keep only their latest state, and the oldest entries go once it is long.
 * Entries are copies: the messages already posted are never changed.
 */
export class ConversationLog {
  private entries: Message[] = [];
  private trimmed = false;

  public constructor(private readonly max = 4_000) {}

  public get size(): number { return this.entries.length; }

  public clear(): void { this.entries = []; this.trimmed = false; }

  public add(message: Message): void {
    const last = this.entries.at(-1);
    if (message.type === 'assistant-delta' && last?.type === 'assistant-delta') { last.text = `${String(last.text ?? '')}${String(message.text ?? '')}`; return; }
    if (message.type === 'progress' && last?.type === 'progress') { this.entries[this.entries.length - 1] = { ...message }; return; }
    if (PANELS.has(String(message.type))) this.entries = this.entries.filter((entry) => entry.type !== message.type);
    this.entries.push({ ...message });
    if (this.entries.length > this.max) {
      this.entries.splice(0, Math.ceil(this.max / 4));
      this.trimmed = true;
    }
  }

  /**
   * The messages that show the conversation again, marked as replays. A prompt still waiting
   * is pinned again where it was asked; one already settled becomes the record of its outcome.
   * Waiting prompts the log no longer holds are added at the end.
   */
  public replay(waiting: Map<string, Message>, outcomes: Map<string, PromptOutcome>): Message[] {
    const shown = new Set<string>();
    const out: Message[] = this.trimmed ? [{ type: 'notice', text: 'Earlier output of this conversation is no longer shown here; the agent still has its full context.', replay: true }] : [];
    for (const entry of this.entries) {
      if (entry.type === 'approval-expired' || entry.type === 'prompt-closed') continue;
      const promptId = promptIdOf(entry);
      if (promptId !== undefined) {
        const live = waiting.get(promptId);
        if (live) { shown.add(promptId); out.push({ ...live, replay: true }); }
        else out.push({ type: 'prompt-record', kind: entry.type === 'approval-request' ? 'approval' : 'questions', title: promptTitle(entry), ...(typeof entry.agent === 'string' ? { agent: entry.agent } : {}), outcome: outcomes.get(promptId)?.outcome ?? 'closed', ...(outcomes.get(promptId)?.detail !== undefined ? { detail: outcomes.get(promptId)?.detail } : {}), replay: true });
        continue;
      }
      if (entry.type === 'tool-end' && typeof entry.output === 'string' && entry.output.length > MAX_REPLAYED_OUTPUT) { out.push({ ...entry, output: `${entry.output.slice(0, MAX_REPLAYED_OUTPUT)}\n…`, replay: true }); continue; }
      out.push({ ...entry, replay: true });
    }
    for (const [id, prompt] of waiting) if (!shown.has(id)) out.push({ ...prompt, replay: true });
    return out;
  }
}

/** The id a pinned prompt is answered by: an approval's call id, or a question set's id. */
export function promptIdOf(message: Message): string | undefined {
  if (message.type === 'approval-request' && typeof message.callId === 'string') return message.callId;
  if (message.type === 'questions-request' && typeof message.id === 'string') return message.id;
  return undefined;
}

/** The prompt's one-line title, as the view's pinned header and transcript line word it. */
function promptTitle(message: Message): string {
  if (message.type === 'approval-request') return String(message.title ?? 'an action');
  const questions = Array.isArray(message.questions) ? message.questions as Array<{ question?: unknown }> : [];
  const first = typeof questions[0]?.question === 'string' ? questions[0].question : 'Questions';
  return first + (questions.length > 1 ? ` (+${questions.length - 1} more)` : '');
}
