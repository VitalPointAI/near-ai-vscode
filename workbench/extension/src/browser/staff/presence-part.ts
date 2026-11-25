import type { interfaces } from '@theia/core/shared/inversify';
import { CommandContribution } from '@theia/core/lib/common/command.js';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution.js';
import { QuickInputService } from '@theia/core/lib/common/quick-pick-service.js';
import { StaffRemoteCursors } from './remote-cursors.js';
import { StaffWhoWroteThis, WhoWroteThisPicker, type PickerRow } from './who-wrote-this.js';
import './staff-cursors.css';

/**
 * The browser part of presence and cursors (33-29): other people's cursors in bound editors, this tab's selection to the backend, and Show Who
 * Wrote This with its list of authors in Theia's quick pick. The editors' decorations and selections come from the binding part's editor source.
 */
export function bindPresencePart(bind: interfaces.Bind): void {
  bind(StaffRemoteCursors).toSelf().inSingletonScope();
  bind(FrontendApplicationContribution).toDynamicValue((context) => ({ onStart: () => context.container.get(StaffRemoteCursors).onStart() })).inSingletonScope();
  bind(WhoWroteThisPicker).toDynamicValue((context) => ({
    show: async (title: string, rows: PickerRow[]) => {
      await context.container.get<QuickInputService>(QuickInputService).showQuickPick(rows.map((row) => ({ label: row.label, description: row.description })), { title });
    },
  })).inSingletonScope();
  bind(StaffWhoWroteThis).toSelf().inSingletonScope();
  bind(CommandContribution).toService(StaffWhoWroteThis);
}
