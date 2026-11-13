// The host side of "Pick up where you left off" (D-03, SYNC-07). It writes the pick-up pointer in the project's state home when a run ends and when a
// person opens a thread, reads it back in another editor, and works out what the card says. No vscode here, so tests run on plain node.
//
// Reading never creates anything (opening a folder writes nothing). The card's one click reopens the chat through the history path and does nothing else:
// no Resume, no auto-resume, no model request, so nothing re-runs and nothing is spent.
import { readFile } from 'node:fs/promises';
import { derivePickup, parsePickupPointer, type PickupModel, type PickupPointer, type PickupThread } from '../domain/state/pickup';
import { stateHomeFor, writeFileAtomic, type MementoLike } from './stateHome';

/** The workspaceState key that remembers the newest pointer this editor has seen or dismissed. */
export const PICKUP_SEEN_KEY = 'nearAi.pickup.lastSeen';

/** What the card needs from the host. The thread index is read-only: it must not create the state home. */
export interface PickupDeps {
  workspaceState: MementoLike | undefined;
  /** This extension host's writer id (`<editor>.<instance>`). */
  writer: string;
  threads: { index(): Promise<readonly PickupThread[]> };
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

/** What the card says now. Reads only. */
export async function pickupCardModel(deps: PickupDeps, root: string): Promise<PickupModel> {
  const pointer = await readPickupPointer(root);
  const seen = deps.workspaceState?.get<string>(PICKUP_SEEN_KEY);
  const index = pointer ? await deps.threads.index().catch(() => [] as readonly PickupThread[]) : [];
  return derivePickup({ pointer, thisWriter: deps.writer, lastSeenAt: typeof seen === 'string' ? seen : undefined, index });
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
