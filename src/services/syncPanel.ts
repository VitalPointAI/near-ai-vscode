// What the chat panel is told about project sync (D-16): the status message for the sync control and the "Turn on sync" invitation. No vscode, so it runs on
// plain node. The status text is redacted here, so a problem shown on the control never carries a password, token or git credential.
import { redactSecrets } from '../domain/redaction';
import { syncStatusMessage, type SyncStatusMessage } from '../domain/state/syncStatus';
import type { MementoLike } from './stateHome';
import { redactGitMessage } from './stateGit';
import type { SyncStatus } from './syncFlows';

/** The workspaceState key that remembers the person dismissed the "Turn on sync" invitation for this project. */
export const SYNC_PROMPT_DISMISSED_KEY = 'nearAi.sync.promptDismissed';

/** Status text for the panel: secrets and git credentials removed. */
export const redactSyncText = (text: string): string => redactSecrets(redactGitMessage(text));

/** Whether the person has dismissed the invitation for this project. */
export function syncPromptDismissed(state: MementoLike | undefined): boolean {
  return state?.get<boolean>(SYNC_PROMPT_DISMISSED_KEY) === true;
}

/** The message the panel gets on open and on every status change. */
export function syncPanelMessage(status: SyncStatus, state: MementoLike | undefined, now: number = Date.now()): SyncStatusMessage {
  return syncStatusMessage(status, { now, dismissed: syncPromptDismissed(state), redact: redactSyncText });
}
