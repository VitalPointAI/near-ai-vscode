// Where a multi-user staff project keeps its shared state, as paths relative to the project root (D-27, D-46). Pure: no I/O, so the staff host can
// ask "is this project multi-user?" without loading anything under src/staff/replica/.
//
// - REPLICA_DIR holds the replica store: one append-only file per writer per stream, sealed blobs by content hash, signed grants and checkpoints. It
//   ignores itself in git (its own .gitignore), because the store is fed by the transport, not by git, and a tracked append-only folder would be
//   rolled back by a branch switch and conflict on merge.
// - REPLICA_PROJECT_FILE is the convenience copy of the project's genesis pin; the trusted pin lives in extension storage outside the project.
// - LEGACY_DIR is where migration moves today's single-machine ledgers (renamed, never deleted).
//
// It also holds the texts every multi-user result shows (D-13), so a command can show them without loading anything under src/staff/replica/. The
// setting that switches the multi-user commands on lives with those commands in src/services/staffMultiUserCommands.ts (D-36).
import { CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT } from '../gate/labels';

/** The replica store folder of a multi-user staff project. */
export const REPLICA_DIR = '.planning/staff/replica';

/** The convenience copy of the project's genesis pin, inside the store folder. */
export const REPLICA_PROJECT_FILE = '.planning/staff/replica/project.json';

/** Where the single-machine ledgers go once a project has become multi-user. */
export const LEGACY_DIR = '.planning/staff/legacy';

/** Shown with every multi-user result until verified credentials arrive (D-13). */
export const MULTI_USER_DECLARED_TEXT = 'People and clearances in this project are declared by the staff lead, not verified.';

/** The notices every multi-user screen and command result shows, in this order: the two label notices, then the declared-people sentence (D-13). */
export function multiUserNoticeLines(): string[] {
  return [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, MULTI_USER_DECLARED_TEXT];
}

/** What a step that only works on a single-machine project says in a shared project (D-29), pointing to the way to work alone. */
export const SHARED_PROJECT_REFUSAL = 'This project is shared, so its history lives in the shared record and this step is not available here. To work alone, use Make a Single-Machine Copy.';
