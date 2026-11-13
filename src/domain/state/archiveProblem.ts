// Why an archived conversation could not be opened, in words a person can act on (D-08, SYNC-01). Pure: no vscode, no files.
//
// An archived conversation is kept whole and never deleted, so when it cannot be opened the person is told so plainly and nothing is changed: the
// archive files stay exactly as they are, and an empty view is never made to stand in for the conversation, so nothing can be saved over it.

/** `damaged`: a part was modified, belongs to another conversation or is missing. `needs-recovery-code`: this computer has no key for the project's state yet. `offline`: the archive is saved online and could not be fetched now. */
export type ArchiveProblemReason = 'damaged' | 'needs-recovery-code' | 'offline';

export interface ArchiveProblem { reason: ArchiveProblemReason }

/** Thrown when something would write to a conversation whose archive cannot be opened: the archive is never replaced by a new, empty conversation. */
export class ArchiveUnreadableError extends Error {
  public readonly reason: ArchiveProblemReason;
  public constructor(reason: ArchiveProblemReason) {
    super(archiveProblemText(reason));
    this.name = 'ArchiveUnreadableError';
    this.reason = reason;
  }
}

const TEXT: Readonly<Record<ArchiveProblemReason, string>> = {
  damaged: "This conversation's archive could not be opened because part of it is damaged. The archive was left exactly as it is, and nothing was changed.",
  'needs-recovery-code': "This conversation's archive could not be opened because this computer does not have the recovery code for the project yet. Enter the recovery code to open it. Nothing was changed.",
  offline: "This conversation is saved online with your project, and it could not be downloaded just now. Check your connection and try again. Nothing was changed."
};

/** One or two plain sentences for the person: what could not be opened, why, and that nothing was touched. */
export function archiveProblemText(reason: ArchiveProblemReason): string {
  return TEXT[reason];
}
