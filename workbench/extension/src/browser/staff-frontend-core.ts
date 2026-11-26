/**
 * The staff frontend module's bindings (Phase 33 D-52): the status client this tab passes to the backend, the status server proxy, and the five
 * browser part slots that 33-25 to 33-29 fill in. The registered module (staff-frontend-module.ts) passes the real parts; this file imports no part,
 * so the unit tests load it without Theia's widget and editor code, which needs a page. No engine, Yjs or key module reaches the browser (D-51).
 */
import { ContainerModule, injectable, type interfaces } from '@theia/core/shared/inversify';
import { Emitter, type Event } from '@theia/core/lib/common/event.js';
import { STAFF_STATUS_PATH, StaffStatusServer, type StaffJoinRequest, type StaffStatusClient, type StaffStatusRow } from '../common/staff-live.js';
import { bindFrontendService } from './frontend-service.js';

/** This tab's client: the backend's notifications as events the parts listen to. */
@injectable()
export class StaffStatusEvents implements StaffStatusClient {
  private readonly statusEmitter = new Emitter<StaffStatusRow>();
  private readonly joinEmitter = new Emitter<StaffJoinRequest>();
  readonly onDidChangeStatus: Event<StaffStatusRow> = this.statusEmitter.event;
  readonly onDidRequestJoin: Event<StaffJoinRequest> = this.joinEmitter.event;

  onStatus(row: StaffStatusRow): void {
    this.statusEmitter.fire(row);
  }

  onJoinRequest(request: StaffJoinRequest): void {
    this.joinEmitter.fire(request);
  }
}

export interface StaffFrontendParts {
  readonly binding: (bind: interfaces.Bind) => void;
  readonly presence: (bind: interfaces.Bind) => void;
  readonly staffRoom: (bind: interfaces.Bind) => void;
  readonly share: (bind: interfaces.Bind) => void;
  readonly status: (bind: interfaces.Bind) => void;
}

export function createStaffFrontendModule(parts: StaffFrontendParts): ContainerModule {
  return new ContainerModule((bind) => {
    bind(StaffStatusEvents).toSelf().inSingletonScope();
    bindFrontendService<StaffStatusServer>(bind, StaffStatusServer, STAFF_STATUS_PATH, (context) => context.container.get(StaffStatusEvents));
    parts.binding(bind);
    parts.presence(bind);
    parts.staffRoom(bind);
    parts.share(bind);
    parts.status(bind);
  });
}
