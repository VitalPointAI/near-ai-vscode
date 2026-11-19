// The VS Code commands a person uses to decide on staff products (design 10, 4.1; WP-SHARED), named here with no vscode import so the Staff Room's
// message mapping and its tests can name them too. The commands themselves live in src/services/staffCommands.ts: each asks the person who they are,
// shows a modal confirmation and signs with this device's key. No agent tool runs a VS Code command.
export const STAFF_COMMANDS = {
  approve: 'nearAi.staff.approveProduct',
  reject: 'nearAi.staff.rejectProduct',
  release: 'nearAi.staff.releaseProduct',
  withdraw: 'nearAi.staff.withdrawProduct',
  show: 'nearAi.staff.showProducts',
  setAside: 'nearAi.staff.setAsideLedger',
  useBranchLedger: 'nearAi.staff.useBranchLedger',
  decidePir: 'nearAi.staff.decidePir'
} as const;

/** The person-only decision commands, the only commands the Staff Room's decision buttons may run. */
export const PERSON_DECISION_COMMANDS: readonly string[] = [STAFF_COMMANDS.approve, STAFF_COMMANDS.reject, STAFF_COMMANDS.release];

/** The command that opens the Staff Room. */
export const OPEN_STAFF_ROOM_COMMAND = 'nearAi.openStaffRoom';

/**
 * The person-run feed file import (WP-IMP): it picks a file, shows what will be imported and asks before writing. It is a VS Code command only: no agent
 * tool runs a VS Code command, so a member can never import a file into the observation store.
 */
export const STAFF_IMPORT_FEED_COMMAND = 'nearAi.staff.importFeedFile';
