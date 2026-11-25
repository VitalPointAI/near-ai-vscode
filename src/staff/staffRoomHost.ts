// The Staff Room's host side, without vscode (WP-ROOM): what the panel does with each message the page sends. Every message is validated first
// (parseStaffRoomMessage); a decision button only ever runs one of the person-only staff commands, for a product on the decision list the host last
// sent, at the version hash the person saw. The command then asks who the person is, shows a modal confirmation and signs; nothing here records a
// decision, and there is no message that could.
import { STAFF_COMMANDS } from '../domain/staff/commands';
import { decisionCommand, parseStaffRoomMessage } from '../domain/staff/staffRoom';
import type { StaffRoomMessage, StaffRoomModel } from '../domain/staff/staffRoom';

/** Set Up a Staff Team, run for one section from a section card. */
const SET_UP_STAFF_TEAM = 'nearAi.setUpStaffTeam';

/** The commands the panel's links open. Each is a person's own command; none decides anything. */
export const STAFF_ROOM_OPEN_COMMANDS: Readonly<Record<Extract<StaffRoomMessage, { type: 'open' }>['target'], string>> = {
  'team-live': 'nearAi.openTeamLive',
  'load-scenario': 'nearAi.loadStaffScenario',
  'set-up-staff': 'nearAi.setUpStaffTeam',
  'show-products': STAFF_COMMANDS.show
};

export interface StaffRoomEffects {
  /** The model the page was last sent, or undefined before the first. */
  readonly model: () => StaffRoomModel | undefined;
  readonly runCommand: (command: string, args?: unknown) => Promise<unknown>;
  readonly openFile: (relative: string) => Promise<unknown>;
  readonly selectRun: (run: string) => void;
  /** Sends the page the whole picture again. */
  readonly refresh: () => void;
  /** A short line the page shows (and announces) when a request could not be done. */
  readonly notice: (text: string) => void;
  /** Focuses the SovAI chat and puts `/team:<team> ` in its message box, nothing sent. Without it, "Task in chat" says it cannot. */
  readonly taskInChat?: (team: string) => Promise<unknown>;
}

/** Handles one raw message from the page. Returns what it did, for the tests and the extension-host tap. */
export async function handleStaffRoomMessage(raw: unknown, effects: StaffRoomEffects): Promise<'ignored' | 'refused' | 'done'> {
  const message = parseStaffRoomMessage(raw);
  if (!message) return 'ignored';
  switch (message.type) {
    case 'ready': effects.refresh(); return 'done';
    case 'decide': {
      const model = effects.model();
      const command = decisionCommand(message, model?.decisions ?? []);
      if (!command.ok) { effects.notice(command.message); effects.refresh(); return 'refused'; }
      await effects.runCommand(command.command, command.args);
      effects.refresh();
      return 'done';
    }
    case 'open-product': {
      const row = effects.model()?.ledger.find((entry) => entry.product === message.product);
      if (!row) { effects.notice(`${message.product} is not in the product ledger.`); return 'refused'; }
      await effects.openFile(row.path);
      return 'done';
    }
    case 'select-run': {
      if (!effects.model()?.runs.some((run) => run.id === message.run)) return 'refused';
      effects.selectRun(message.run);
      return 'done';
    }
    case 'open': await effects.runCommand(STAFF_ROOM_OPEN_COMMANDS[message.target]); return 'done';
    case 'task-team': {
      // Only a team the host itself last sent as ready for that section: the page names the section, never the command.
      const team = effects.model()?.squads.find((squad) => squad.section === message.section)?.team;
      if (team?.state !== 'ready' || !team.name) { effects.notice(`The ${message.section.toUpperCase()} has no team to task. Set it up first.`); effects.refresh(); return 'refused'; }
      if (!effects.taskInChat) { effects.notice('The SovAI chat is not available here.'); return 'refused'; }
      await effects.taskInChat(team.name);
      return 'done';
    }
    case 'set-up-section': await effects.runCommand(SET_UP_STAFF_TEAM, { section: message.section }); effects.refresh(); return 'done';
    default: return 'ignored';
  }
}
