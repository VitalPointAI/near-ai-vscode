import type { interfaces } from '@theia/core/shared/inversify';
import { StaffLiveSessionId } from '../staff-backend-module.js';
import { bindStaffBindingService } from './binding-service.js';
import { loadStaffEngine } from './staff-engine.js';
import type { StaffLiveSession } from './staff-live-engine.js';

/** The backend part of the editor binding (33-25): the binding service over the session's live engine and the engine bundle's binding core. */
export function bindBindingPart(bind: interfaces.Bind): void {
  bindStaffBindingService(bind, (context) => ({
    live: () => context.container.get<StaffLiveSession>(StaffLiveSessionId).current,
    engine: loadStaffEngine(),
    log: (line) => console.info(line),
  }));
}
