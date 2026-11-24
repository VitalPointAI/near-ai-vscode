import type { interfaces } from '@theia/core/shared/inversify';
import { SessionIdentity } from '../session-identity.js';
import { StaffLiveSessionId } from '../staff-backend-module.js';
import { loadStaffEngine } from './staff-engine.js';
import type { StaffLiveSession } from './staff-live-engine.js';
import { bindStaffRoomService } from './staff-room-service.js';

/** The backend part of the Staff Room (33-26): the room service over the session's live engine, with the step-up sign-in of the session. */
export function bindStaffRoomPart(bind: interfaces.Bind): void {
  bindStaffRoomService(bind, (context) => ({
    live: () => context.container.get<StaffLiveSession>(StaffLiveSessionId).current,
    engine: loadStaffEngine(),
    stepUpAcr: () => {
      const status = context.container.get<{ status(): { mode: string; stepUp?: { acr: string } } }>(SessionIdentity).status();
      return status.mode === 'hosted' ? status.stepUp?.acr : undefined;
    },
    log: (line) => console.info(line),
  }));
}
