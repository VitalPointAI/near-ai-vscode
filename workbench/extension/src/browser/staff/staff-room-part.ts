import type { interfaces } from '@theia/core/shared/inversify';
import { bindViewContribution } from '@theia/core/lib/browser/shell/view-contribution.js';
import { WidgetFactory } from '@theia/core/lib/browser/widget-manager.js';
import { STAFF_ROOM_PATH, StaffRoomServer } from '../../common/staff-room.js';
import { bindFrontendService } from '../frontend-service.js';
import { StaffRoomEvents } from './staff-room-view.js';
import { StaffRoomContribution, StaffRoomWidget } from './staff-room-widget.js';

/** The browser part of the Staff Room (33-26): the room's client and proxy, the widget, and its view in the right panel. */
export function bindStaffRoomPart(bind: interfaces.Bind): void {
  bind(StaffRoomEvents).toSelf().inSingletonScope();
  bindFrontendService<StaffRoomServer>(bind, StaffRoomServer, STAFF_ROOM_PATH, (context) => context.container.get(StaffRoomEvents));
  bind(StaffRoomWidget).toSelf();
  bind(WidgetFactory).toDynamicValue((context) => ({ id: StaffRoomWidget.ID, createWidget: () => context.container.get(StaffRoomWidget) })).inSingletonScope();
  bindViewContribution(bind, StaffRoomContribution);
}
