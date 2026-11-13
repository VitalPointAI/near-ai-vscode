// "Pick up where you left off" (D-03, SYNC-07): what the card shows when the project is opened in another interface or on another machine.
// Pure: no vscode, no files. The host reads the pointer, the thread index, the run marker and the planning folder and passes them in.
//
// The card only reports. Nothing here, and nothing the card does, starts, resumes or continues a run, or sends a model request.

/** Where the last person-driven work stopped: written when a run ends and when a person opens a thread, by the editor that did it. */
export interface PickupPointer {
  conversationId: string;
  runId?: string;
  /** `<editor>.<instance>` of the extension host that wrote it. */
  writer: string;
  /** ISO time. */
  at: string;
}

export type RunCardState = 'finished' | 'cut-off' | 'waiting' | 'running-elsewhere';

export interface PickupPhase {
  number: number;
  name?: string;
  nextStep: NextStep;
}

export interface NextStep {
  /** The slash command that would do it, shown as text and never run. */
  command: string;
  /** The sentence the card shows. */
  text: string;
}

export interface PickupModel {
  show: boolean;
  /** The pointer this model is about: "Not now" remembers it. */
  pointerAt: string;
  lastChat?: { id: string; title: string; at: string; locked?: boolean };
  lastRun?: { state: RunCardState; at: string };
  phase?: PickupPhase;
}

/** The part of a thread index line the card needs. */
export interface PickupThread {
  id: string;
  title: string;
  lastUsedAt: string;
  locked?: boolean;
}

export interface PickupInput {
  pointer: PickupPointer | undefined;
  /** This extension host's writer id. */
  thisWriter: string;
  /** The `at` of the pointer this editor last saw or dismissed. */
  lastSeenAt: string | undefined;
  index: readonly PickupThread[];
  run?: { state: RunCardState; at: string };
  phase?: PickupPhase;
}

/** The editor part of a writer id (`<editor>.<instance>`), or undefined when there is none. */
function editorOf(writer: string | undefined): string | undefined {
  if (!writer) return undefined;
  const dot = writer.indexOf('.');
  return dot > 0 ? writer.slice(0, dot) : undefined;
}

const CONVERSATION_ID = /^conv-[a-z0-9-]{6,60}$/;
const RUN_ID = /^run-\d+-[a-f0-9]{6}$/;
const WRITER = /^[a-z0-9]{6,40}\.[a-z0-9]{6,40}$/;

/** Reads a pointer strictly: anything malformed means no card (T-27-62). */
export function parsePickupPointer(value: unknown): PickupPointer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.conversationId !== 'string' || !CONVERSATION_ID.test(raw.conversationId)) return undefined;
  if (typeof raw.writer !== 'string' || !WRITER.test(raw.writer)) return undefined;
  if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return undefined;
  const runId = typeof raw.runId === 'string' && RUN_ID.test(raw.runId) ? raw.runId : undefined;
  return { conversationId: raw.conversationId, ...(runId ? { runId } : {}), writer: raw.writer, at: raw.at };
}

/**
 * Whether the card shows, and what it says. It shows when the newest pointer was written by another editor (a different interface or machine) and
 * is newer than the last one this editor saw. The same editor reopening never sees it.
 */
export function derivePickup(input: PickupInput): PickupModel {
  const { pointer } = input;
  if (!pointer) return { show: false, pointerAt: '' };
  const foreign = editorOf(pointer.writer) !== undefined && editorOf(pointer.writer) !== editorOf(input.thisWriter);
  const seenAt = input.lastSeenAt ? Date.parse(input.lastSeenAt) : Number.NEGATIVE_INFINITY;
  const unseen = Date.parse(pointer.at) > (Number.isNaN(seenAt) ? Number.NEGATIVE_INFINITY : seenAt);
  const thread = input.index.find((item) => item.id === pointer.conversationId);
  return {
    show: foreign && unseen,
    pointerAt: pointer.at,
    ...(thread ? { lastChat: { id: thread.id, title: thread.locked ? '' : thread.title, at: thread.lastUsedAt, ...(thread.locked ? { locked: true } : {}) } } : {}),
    ...(input.run ? { lastRun: input.run } : {}),
    ...(input.phase ? { phase: input.phase } : {})
  };
}

const PLAN = /-PLAN\.md$/;
const SUMMARY = /-SUMMARY\.md$/;
const CONTEXT = /-CONTEXT\.md$/;
const CHECKED = /-(VERIFICATION|UAT)\.md$/;

/**
 * The next step of GSD's loop, from the files in the phase folder (research A8): no CONTEXT is discuss; CONTEXT without a PLAN is plan; a PLAN without its
 * SUMMARY is execute; every plan summarised but not verified is verify; otherwise the next phase's discuss. When there is no later phase the milestone
 * can be completed. It is text for the person to act on, never a command the extension runs.
 */
export function nextGsdStep(phaseNumber: number, phaseFiles: readonly string[], totalPhases: number | null): NextStep {
  const step = (command: string, number: number): NextStep => ({ command: `${command} ${number}`, text: `Next step: run ${command} ${number} in the chat` });
  const plans = phaseFiles.filter((file) => PLAN.test(file));
  const summarised = new Set(phaseFiles.filter((file) => SUMMARY.test(file)).map((file) => file.replace(SUMMARY, '')));
  if (!phaseFiles.some((file) => CONTEXT.test(file))) return step('/gsd-discuss-phase', phaseNumber);
  if (!plans.length) return step('/gsd-plan-phase', phaseNumber);
  if (plans.some((file) => !summarised.has(file.replace(PLAN, '')))) return step('/gsd-execute-phase', phaseNumber);
  if (!phaseFiles.some((file) => CHECKED.test(file))) return step('/gsd-verify-work', phaseNumber);
  if (totalPhases !== null && phaseNumber >= totalPhases) return { command: '/gsd-complete-milestone', text: 'Next step: every phase is verified; run /gsd-complete-milestone in the chat' };
  return step('/gsd-discuss-phase', phaseNumber + 1);
}
