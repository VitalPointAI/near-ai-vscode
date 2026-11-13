// Records the @near chat participant's conversations in the project's state home (D-07). VS Code keeps the Chat view's turns itself, per editor, and the
// extension stored nothing, so this wraps the reply stream, keeps what was streamed, and appends each turn to a thread of the thread store. The thread's
// id rides in ChatResult.metadata, so the next request knows which thread it continues. No vscode here: structural types only, so tests run on plain node.
import { entryId, type ThreadEntry, type ThreadRole } from '../domain/state/threadEntries';
import { newConversationId } from './agentSession';
import type { ThreadStore } from './threadStore';

export const PARTICIPANT_ID = 'nearAi';

/** Same shape as every thread id: checked before an id from VS Code's chat metadata or a button argument is used for anything (T-27-31). */
const THREAD_ID = /^conv-[a-z0-9-]{6,60}$/;
export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID.test(value);
}

/** The part of vscode.ChatResponseStream the participant uses. */
export interface ResponseStreamLike {
  markdown(value: string | { value: string }): unknown;
  button(button: unknown): unknown;
  progress(value: string): unknown;
}

/** How a reply ended. `not-sent` means nothing reached the model (no folder, no profile, the outbound guard held it back), so there is no exchange to keep. */
export type ReplyOutcome = 'completed' | 'cancelled' | 'failed' | 'not-sent';

export interface RecordedReply {
  /** What was streamed as markdown, exactly as sent: the usage footer is part of it. */
  text: string;
  outcome: ReplyOutcome;
}

/**
 * Passes everything to the real stream and keeps the markdown that was sent. Buttons and progress lines are forwarded and not kept: they are not part
 * of the reply the person reads back.
 */
export class ResponseRecorder implements ResponseStreamLike {
  private readonly parts: string[] = [];

  public constructor(private readonly stream: ResponseStreamLike) {}

  public markdown(value: string | { value: string }): unknown {
    this.parts.push(typeof value === 'string' ? value : String(value.value));
    return this.stream.markdown(value);
  }

  public button(button: unknown): unknown { return this.stream.button(button); }

  public progress(value: string): unknown { return this.stream.progress(value); }

  /** The reply so far. */
  public text(): string { return this.parts.join(''); }

  public finish(outcome: ReplyOutcome): RecordedReply { return { text: this.text(), outcome }; }
}

/** One turn of VS Code's chat history, as much of it as is read here (a request turn has a prompt, a response turn has a result and parts). */
export interface ParticipantTurnLike {
  participant: string;
  prompt?: string;
  command?: string;
  result?: { metadata?: { threadId?: unknown; command?: unknown } };
  response?: ReadonlyArray<{ value?: unknown }>;
}

function isResponse(turn: ParticipantTurnLike): boolean {
  return !('prompt' in turn) && turn.response !== undefined;
}

/** The markdown text of a response turn. Progress lines and buttons are not markdown, so they add nothing. */
function replyText(turn: ParticipantTurnLike): string {
  return (turn.response ?? []).map((part) => {
    const value = part.value as { value?: unknown } | null | undefined;
    return value && typeof value === 'object' && typeof value.value === 'string' ? value.value : '';
  }).join('');
}

function participantTurns(turns: readonly ParticipantTurnLike[]): ParticipantTurnLike[] {
  return turns.filter((turn) => turn.participant === PARTICIPANT_ID);
}

function threadIdOf(turn: ParticipantTurnLike): string | undefined {
  const id = turn.result?.metadata?.threadId;
  return isThreadId(id) ? id : undefined;
}

/** One entry still to be chained into a thread: its role and body. */
export interface SeedItem { role: ThreadRole; body: unknown }

/** The notice kept after a reply that was cut off, cancelled or failed. */
export const PARTICIPANT_STOPPED_NOTICE = 'The reply stopped before it finished.';

/**
 * What a /gsd-* command typed in the Chat view is kept as: one notice, since the workflow itself runs in the NEAR AI panel and the model never saw it
 * as a message. It says what was run and repeats the reply the person read.
 */
export function commandNoticeText(command: string, args: string, reply: string): string {
  const typed = `/gsd-${command}${args.trim() ? ` ${args.trim()}` : ''}`;
  return `You ran ${typed} in the Chat view.${reply.trim() ? `\n\n${reply.trim()}` : ''}`;
}

/** A notice that is shown in the thread and is never sent to the model. */
function notice(text: string): SeedItem {
  return { role: 'notice', body: { text, forContext: false } };
}

/**
 * The turns of a session that began before turns were recorded, as entries in order: a prompt is a user entry, a reply an assistant entry, and a
 * command with its reply one notice. Built from the full history, before the 20-turn slice the model sees.
 */
export function seedEntries(turns: readonly ParticipantTurnLike[]): SeedItem[] {
  const items: SeedItem[] = [];
  let pending: { command: string; prompt: string } | undefined;
  const flushCommand = (reply: string): void => {
    if (pending) items.push(notice(commandNoticeText(pending.command, pending.prompt, reply)));
    pending = undefined;
  };
  for (const turn of participantTurns(turns)) {
    if (!isResponse(turn)) {
      flushCommand('');
      if (turn.command) pending = { command: turn.command, prompt: turn.prompt ?? '' };
      else if ((turn.prompt ?? '').trim()) items.push({ role: 'user', body: { text: turn.prompt } });
      continue;
    }
    const text = replyText(turn);
    if (typeof turn.result?.metadata?.command === 'string') {
      if (pending) flushCommand(text);
      else if (text.trim()) items.push(notice(text));
    } else {
      flushCommand('');
      if (text.trim()) items.push({ role: 'assistant', body: { text } });
    }
  }
  flushCommand('');
  return items;
}

export interface ResolvedThread {
  threadId: string;
  /** Set only for a session that began before turns were recorded: its earlier turns, to be stored once with the next turn. */
  seed?: SeedItem[];
}

/** The newest thread begun in the Chat view whose last reply is this exact exchange. A weak match is no match: when unsure, a new thread starts. */
async function threadWithTail(turns: readonly ParticipantTurnLike[], store: ThreadStore): Promise<string | undefined> {
  const mine = participantTurns(turns);
  const newest = mine.at(-1);
  if (!newest || !isResponse(newest) || typeof newest.result?.metadata?.command === 'string') return undefined;
  const lastReply = replyText(newest).trim();
  const lastPrompt = mine.filter((turn) => !isResponse(turn)).at(-1)?.prompt?.trim() ?? '';
  if (!lastReply || !lastPrompt) return undefined;
  const candidate = (await store.index()).filter((item) => item.origin === 'chat-view' && !item.locked)[0];
  // An archived thread is not read here: reading it would bring it back and reorder the history for a guess.
  if (!candidate || candidate.state !== 'live') return undefined;
  const main = (await store.lines(candidate.id)).main;
  let end = main.length - 1;
  while (end >= 0 && main[end].role === 'notice' && textOf(main[end]) === PARTICIPANT_STOPPED_NOTICE) end -= 1;
  const tail = main[end];
  const before = main.slice(0, end).filter((entry) => entry.role === 'user').at(-1);
  return tail?.role === 'assistant' && textOf(tail).trim() === lastReply && before && textOf(before).trim() === lastPrompt ? candidate.id : undefined;
}

function textOf(entry: ThreadEntry): string {
  const text = (entry.body as { text?: unknown } | null)?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Which thread this request belongs to (D-07, Pitfall 16).
 * - The newest reply of this participant carries it in ChatResult.metadata.threadId.
 * - A first request has no reply yet: a new thread.
 * - A reply without the id (a session restored without its metadata) joins a thread only on an exact tail match; otherwise a new thread starts and no
 *   existing thread is touched.
 * - A session that began before turns were recorded (no reply carries an id) is seeded once, from the full history, into its new thread.
 */
export async function resolveParticipantThread(turns: readonly ParticipantTurnLike[], store: ThreadStore): Promise<ResolvedThread> {
  const mine = participantTurns(turns);
  const newest = mine.filter(isResponse).at(-1);
  const known = newest ? threadIdOf(newest) : undefined;
  if (known) return { threadId: known };
  if (!newest) return { threadId: newConversationId() };
  const joined = await threadWithTail(turns, store);
  if (joined) return { threadId: joined };
  const seed = mine.some((turn) => isResponse(turn) && threadIdOf(turn)) ? [] : seedEntries(turns);
  return { threadId: newConversationId(), ...(seed.length ? { seed } : {}) };
}

export interface ParticipantTurnInput {
  threadId: string;
  /** The editor writing (`editorWriter(...)`): kept on every entry, so two editors' entries stay told apart. */
  writer: string;
  prompt: string;
  /** The reply exactly as streamed. */
  reply: string;
  model: string;
  /** The reply was cut off, cancelled or failed: a notice says so after what was streamed. */
  stopped?: boolean;
  /** A /gsd-* command typed in the Chat view, as its bare name (`plan-phase`): kept as a notice, not as a message the model sees. */
  command?: string;
  /** From resolveParticipantThread: stored first when the thread has nothing yet. */
  seed?: SeedItem[];
  now?: () => Date;
}

const TITLE_LENGTH = 80;

/** The title of a thread begun in the Chat view: the first 80 characters of its first prompt, on one line. */
function titleOf(items: readonly SeedItem[]): string {
  const first = items.find((item) => item.role === 'user') ?? items[0];
  const text = (first?.body as { text?: unknown } | undefined)?.text;
  return (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LENGTH) || 'Chat view';
}

/**
 * Appends one turn to the thread, creating it (origin 'chat-view') on the first one: the prompt and the reply as streamed; a notice after a reply that
 * stopped early; a single notice for a command. A thread that has nothing yet first gets the seed. The entries continue the thread's main line, so a
 * turn is never written into the middle of another. The model's 20-turn window is not involved: this stores everything.
 */
export async function recordParticipantTurn(store: ThreadStore, input: ParticipantTurnInput): Promise<void> {
  const existing = await store.lines(input.threadId);
  const drafts: SeedItem[] = existing.main.length === 0 && input.seed?.length ? [...input.seed] : [];
  if (input.command) drafts.push(notice(commandNoticeText(input.command, input.prompt, input.reply)));
  else {
    drafts.push({ role: 'user', body: { text: input.prompt } });
    if (input.reply) drafts.push({ role: 'assistant', body: { text: input.reply } });
    if (input.stopped) drafts.push(notice(PARTICIPANT_STOPPED_NOTICE));
  }
  await append(store, input, existing, drafts);
}

/** Stores only the seed: the earlier turns of a session that began before turns were recorded, when the request in hand has no exchange of its own to keep. */
export async function recordSeed(store: ThreadStore, input: Pick<ParticipantTurnInput, 'threadId' | 'writer' | 'model' | 'now'> & { seed: SeedItem[] }): Promise<void> {
  const existing = await store.lines(input.threadId);
  if (existing.main.length === 0 && input.seed.length) await append(store, input, existing, input.seed);
}

async function append(store: ThreadStore, input: Pick<ParticipantTurnInput, 'threadId' | 'writer' | 'model' | 'now'>, existing: { main: readonly ThreadEntry[] }, drafts: readonly SeedItem[]): Promise<void> {
  let parent = existing.main.at(-1)?.id ?? null;
  const started = (input.now?.() ?? new Date()).getTime();
  const entries: ThreadEntry[] = drafts.map((draft, index) => {
    const entry: ThreadEntry = {
      id: entryId(parent, draft.role, draft.body), thread: input.threadId, parent,
      at: new Date(started + index).toISOString(), writer: input.writer, role: draft.role, body: draft.body
    };
    parent = entry.id;
    return entry;
  });
  await store.create({ id: input.threadId, title: titleOf(drafts), model: input.model, origin: 'chat-view' });
  await store.appendEntries(input.threadId, entries);
}

/** The NEAR AI panel, as far as opening a thread in it needs. */
export interface ThreadPanelLike {
  focus(): PromiseLike<unknown>;
  resume(threadId: string): PromiseLike<unknown>;
}

/**
 * The command behind a reply's "Open this chat in the NEAR AI panel" button: shows the panel and reopens the thread there with its whole history
 * (nearAi.openThread). The id comes from a button argument, so it is checked before it goes anywhere (T-27-31); a bad one is refused with a message.
 */
export async function openThreadInPanel(threadId: unknown, panel: ThreadPanelLike, warn: (text: string) => void): Promise<boolean> {
  if (!isThreadId(threadId)) { warn('That chat cannot be opened: its id is not valid.'); return false; }
  await panel.focus();
  await panel.resume(threadId);
  return true;
}
