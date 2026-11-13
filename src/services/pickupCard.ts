// The host side of "Pick up where you left off" (D-03, SYNC-07). It writes the pick-up pointer in the project's state home when a run ends and when a
// person opens a thread, reads it back in another editor, and works out what the card says. No vscode here, so tests run on plain node.
//
// Reading never creates anything (opening a folder writes nothing). The card's one click reopens the chat through the history path and does nothing else:
// no Resume, no auto-resume, no model request, so nothing re-runs and nothing is spent.
import { readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseGsdPlanningState } from '../domain/gsdStatus';
import { derivePickup, nextGsdStep, runCardState, parsePickupPointer, type PickupModel, type PickupPhase, type PickupPointer, type PickupThread } from '../domain/state/pickup';
import type { RunMarkers } from './runMarkers';
import { shouldShowSyncPrompt } from '../domain/state/syncStatus';
import { stateHomeFor, writeFileAtomic, type MementoLike } from './stateHome';
import { syncPromptDismissed } from './syncPanel';
import type { SyncStatus } from './syncFlows';

/** The workspaceState key that remembers the newest pointer this editor has seen or dismissed. */
export const PICKUP_SEEN_KEY = 'nearAi.pickup.lastSeen';

/** What the card needs from the host. The thread index is read-only: it must not create the state home. */
export interface PickupDeps {
  workspaceState: MementoLike | undefined;
  /** This extension host's writer id (`<editor>.<instance>`). */
  writer: string;
  threads: { index(): Promise<readonly PickupThread[]> };
  /** The run markers of this project, for the run line of the card. */
  markers?: Pick<RunMarkers, 'markerOf' | 'runState'>;
  /** The project's sync status now. Without it the card says nothing about sync. */
  syncStatus?: SyncStatus;
}

/** Records where work stopped. Called from a person's action or a run ending, so it may create the state home. A failure never stops anything. */
export async function writePickupPointer(root: string, pointer: PickupPointer): Promise<void> {
  try {
    const home = stateHomeFor(root);
    await home.ensure();
    await writeFileAtomic(home.paths.pickup, `${JSON.stringify(pointer)}\n`);
  } catch {
    // The card is a convenience; losing a pointer must not break a run or a reopen.
  }
}

/** The pointer in the state home, or undefined when there is none or it is not valid (a damaged file means no card). Never creates anything. */
export async function readPickupPointer(root: string): Promise<PickupPointer | undefined> {
  try { return parsePickupPointer(JSON.parse(await readFile(stateHomeFor(root).paths.pickup, 'utf8'))); } catch { return undefined; }
}

/** Remembers that this editor has seen (or dismissed) the pointer written at `at`, so the card is never shown again for it. Never moves backwards. */
export async function markPickupSeen(state: MementoLike | undefined, at: string): Promise<void> {
  if (!state || !at || Number.isNaN(Date.parse(at))) return;
  const current = state.get<string>(PICKUP_SEEN_KEY);
  if (typeof current === 'string' && Date.parse(current) >= Date.parse(at)) return;
  await state.update(PICKUP_SEEN_KEY, at);
}

/** Phase names are shown as text; a very long heading is cut. */
const MAX_PHASE_NAME = 120;

/**
 * The project's current GSD phase and what to do next, from .planning (STATE.md for the phase, ROADMAP.md for its name, the phase folder for its files).
 * Undefined when there is no .planning folder or no current phase. Reads only; the next step is text, never run.
 */
export async function readPickupPhase(root: string): Promise<PickupPhase | undefined> {
  const planning = path.join(root, '.planning');
  const state = await readFile(path.join(planning, 'STATE.md'), 'utf8').catch(() => undefined);
  if (state === undefined) return undefined;
  const roadmap = await readFile(path.join(planning, 'ROADMAP.md'), 'utf8').catch(() => '');
  const parsed = parseGsdPlanningState(state, roadmap);
  const number = parsed.currentPhase;
  if (number === null || !Number.isSafeInteger(number) || number < 0) return undefined;
  // The folder is the phase number (two digits or more, or unpadded) and a dash; 03.1-x is another phase (an inserted one), not phase 3.
  const folderName = new RegExp(`^0*${number}-`);
  const phasesDir = path.join(planning, 'phases');
  const folder = (await readdir(phasesDir).catch(() => [] as string[])).filter((name) => folderName.test(name)).sort()[0];
  const files = folder ? await readdir(path.join(phasesDir, folder)).catch(() => [] as string[]) : [];
  const heading = roadmap.match(new RegExp(`^#{2,4}[ \\t]*Phase[ \\t]+0*${number}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, 'm'))?.[1];
  const name = heading ? heading.slice(0, MAX_PHASE_NAME) : undefined;
  return { number, ...(name ? { name } : {}), nextStep: nextGsdStep(number, files, parsed.totalPhases) };
}

/** What the card says now. Reads only. */
export async function pickupCardModel(deps: PickupDeps, root: string): Promise<PickupModel> {
  const pointer = await readPickupPointer(root);
  const seen = deps.workspaceState?.get<string>(PICKUP_SEEN_KEY);
  const index = pointer ? await deps.threads.index().catch(() => [] as readonly PickupThread[]) : [];
  const phase = pointer ? await readPickupPhase(root).catch(() => undefined) : undefined;
  const marker = pointer && deps.markers ? await deps.markers.markerOf(pointer.conversationId).catch(() => undefined) : undefined;
  const run = marker && deps.markers ? runCardState(marker, deps.markers.runState(marker)) : undefined;
  const model = derivePickup({ pointer, thisWriter: deps.writer, lastSeenAt: typeof seen === 'string' ? seen : undefined, index, ...(run ? { run } : {}), ...(phase ? { phase } : {}) });
  const status = deps.syncStatus;
  if (!status) return model;
  // D-17: while the pull on open runs the card says so; D-16: before sync is on it carries the invitation, until the person dismisses it for this project.
  const checking = status.state === 'syncing' && status.reason === 'open';
  const syncPrompt = shouldShowSyncPrompt({ syncOn: status.state !== 'off', dismissed: syncPromptDismissed(deps.workspaceState) });
  return { ...model, ...(checking ? { checking: true as const } : {}), ...(syncPrompt ? { syncPrompt: true as const } : {}) };
}

/** The card's messages from the page. */
export type PickupAction = { action: 'open'; id: string } | { action: 'later' };

/**
 * What the card's buttons do on the host, and nothing else (T-27-59): "open" reopens the chat through the history path; "later" remembers the
 * pointer. It has no way to resume, continue, settle or send anything.
 */
export async function handlePickupAction(message: PickupAction, host: { openSaved(id: string): Promise<void>; markSeen(): Promise<void> }): Promise<void> {
  if (message.action === 'open') { await host.openSaved(message.id); return; }
  await host.markSeen();
}
