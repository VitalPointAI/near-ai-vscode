/**
 * The browser part of the sync status entry (Phase 33 D-57, 33-28): this tab's StaffSyncStatus over Theia's status bar, fed by the status rows the
 * backend sends (33-24) and seeded from rows() at start, and the Sync Now command the entry runs. A Sterling status item bound by 32.1 native
 * (SterlingStatusItem) takes the word instead of a new entry. StaffStatusEvents is read inside the binding only (never at module load), because
 * the staff frontend module imports this file.
 */
import type { interfaces } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar-types.js';
import { CommandContribution, type CommandRegistry } from '@theia/core/lib/common/command.js';
import { StaffStatusServer } from '../../common/staff-live.js';
import { StaffStatusEvents } from '../staff-frontend-module.js';
import { STAFF_SYNC_COMMAND, StaffSyncStatus, SterlingStatusItem, type StaffSyncBar } from './staff-sync-status.js';

/** Left, beside the sign-in entry (priority 100) and the secret store entry (99). */
const PRIORITY = 98;

class StaffSyncContribution implements FrontendApplicationContribution, CommandContribution {
  constructor(private readonly status: StaffSyncStatus, private readonly events: StaffStatusEvents, private readonly server: StaffStatusServer) {}

  onStart(): void {
    this.events.onDidChangeStatus((row) => { void this.status.update(row); });
    void this.server.rows().then((rows) => this.status.reset(rows), () => undefined);
  }

  registerCommands(registry: CommandRegistry): void {
    registry.registerCommand({ id: STAFF_SYNC_COMMAND, label: 'Sync Now' }, {
      execute: async () => {
        const project = this.status.shownProject;
        if (project === undefined) return;
        const answer = await this.server.syncNow(project);
        if (answer.kind === 'ok') await this.status.update(answer.value);
      },
      isEnabled: () => this.status.shownProject !== undefined,
    });
  }
}

const StaffSyncContributionId = Symbol('StaffSyncContribution');

/** Theia's status bar as StaffSyncStatus writes it: the entry on the left at one priority. */
function barOf(statusBar: StatusBar): StaffSyncBar {
  return {
    setElement: (id, entry) => statusBar.setElement(id, { ...entry, alignment: StatusBarAlignment.LEFT, priority: PRIORITY }),
    removeElement: (id) => statusBar.removeElement(id),
  };
}

/** The browser part of the sync status entry (33-28). */
export function bindStatusPart(bind: interfaces.Bind): void {
  bind(StaffSyncContributionId).toDynamicValue((context) => {
    const { container } = context;
    const item = container.isBound(SterlingStatusItem) ? container.get<SterlingStatusItem>(SterlingStatusItem) : undefined;
    const status = new StaffSyncStatus(barOf(container.get<StatusBar>(StatusBar)), item);
    return new StaffSyncContribution(status, container.get(StaffStatusEvents), container.get<StaffStatusServer>(StaffStatusServer));
  }).inSingletonScope();
  bind(FrontendApplicationContribution).toService(StaffSyncContributionId);
  bind(CommandContribution).toService(StaffSyncContributionId);
}
