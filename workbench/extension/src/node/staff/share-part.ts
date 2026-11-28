/**
 * The backend part of Share with people (Phase 33 D-58, 33-27): the share service at STAFF_SHARE_PATH, over the session's live engine and the
 * engine bundle. The open staff project is the workspace folder. StaffLiveSessionId is read inside the binding only (never at module load), because
 * the staff backend module imports this file.
 */
import { fileURLToPath } from 'node:url';
import type { interfaces } from '@theia/core/shared/inversify';
import { WorkspaceServer } from '@theia/workspace/lib/common/workspace-protocol.js';
import { STAFF_SHARE_PATH, StaffShareServer } from '../../common/staff-share.js';
import { bindBackendService } from '../backend-service.js';
import { PendingActionsKey } from '../session-identity-backend-module.js';
import type { PendingActions } from './person-signer.js';
import { StaffLiveSessionId } from '../staff-backend-module.js';
import { StaffShareService, type StaffShareApi } from './share-service.js';
import { loadStaffEngine, type StaffEngine } from './staff-engine.js';
import type { StaffLiveSession } from './staff-live-engine.js';

/** The open workspace folder, as a path; undefined when none is open or it is not a local folder. */
async function workspaceFolder(server: WorkspaceServer): Promise<string | undefined> {
  const uri = await server.getMostRecentlyUsedWorkspace();
  return uri !== undefined && uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
}

/** The backend part of Share with people (33-27). */
export function bindSharePart(bind: interfaces.Bind): void {
  bindBackendService<StaffShareService>(bind, StaffShareServer, STAFF_SHARE_PATH, (context) => new StaffShareService({
    engine: loadStaffEngine<StaffEngine & StaffShareApi & { x25519BindingBytes(rawX25519: string, writer: string): Buffer }>(),
    live: () => context.container.get<StaffLiveSession>(StaffLiveSessionId).current,
    actions: context.container.isBound(PendingActionsKey) ? context.container.get<PendingActions>(PendingActionsKey) : undefined,
    root: () => workspaceFolder(context.container.get<WorkspaceServer>(WorkspaceServer)),
    log: (line) => console.info(line),
  }));
}
