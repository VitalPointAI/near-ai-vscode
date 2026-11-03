// Share Team Setup (G-61-3). Declared only; the experience follows.
import type { TeamFile } from '../../domain/team/types';
import type { GitRunner } from '../../team/runGit';

export type ShareReason = 'command' | 'enable' | 'invite' | 'link';
export type ShareOutcome = 'shared' | 'already' | 'declined' | 'not-reachable' | 'failed';
export interface ShareDeps { output: { appendLine(line: string): void; show?(preserveFocus?: boolean): void }; announce(level: 'info' | 'warn' | 'error', message: string): void }

// Every sentence and button label of the share experience. Plain words only; the technical reason goes to the NEAR AI Team channel.
export const SHARE_TEXT = Object.freeze({
  question: 'Share your team setup so teammates can join?',
  inviteQuestion: 'Before you invite anyone, your team setup must be online so the invite can find the team. Share it now?',
  linkQuestion: 'Share your team setup so teammates see the organization link?',
  onlySetup: 'Only the team setup is shared. Nothing else in your project changes.',
  firstUpload: 'This puts your project online for the first time, with the team setup in it.',
  share: 'Share',
  shareAndContinue: 'Share and continue',
  checking: 'Checking your team setup online',
  progress: 'Sharing your team setup',
  shared: 'Your team setup is online. Teammates can now join.',
  already: 'Your team setup is already online, so teammates can join.',
  declined: 'Nothing was shared.',
  rejected: 'The online home of your project did not accept the team setup. It may only accept changes through a review. Choose Show details for more.',
  offline: 'Your team setup could not be shared because the online home of your project could not be reached. Check your internet connection, then choose Try again. Nothing was lost.',
  changed: 'Your team setup could not be shared because the project changed online at the same moment. Choose Try again.',
  recordMissing: 'Your team setup could not be shared because the team record is not online yet. Choose Show details for more.',
  notHere: 'Your team setup could not be shared from this computer. Choose Show details for more.'
} as const);

export async function ensureTeamSetupShared(_deps: ShareDeps, _input: { projectRoot: string; teamFile: TeamFile; branch: string; reason: ShareReason; git?: GitRunner }): Promise<ShareOutcome> {
  throw new Error('not implemented');
}
