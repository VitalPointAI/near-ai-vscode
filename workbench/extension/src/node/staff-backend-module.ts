/**
 * The staff backend module (Phase 33 D-51, D-52): the session's live engine and its status service, and the three backend part slots that 33-25 to
 * 33-27 fill in. The engine follows the session (StaffLiveSession): in local mode it starts at once with this computer's keyring as its secret
 * store; in a hosted session it starts when the sign-in is active, with the session keys and the opened encryption key (33-23) and the person's
 * OpenBao key store, and stops when the session stops. Shared projects are looked for in the workspace folder and the folders directly in it.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContainerModule, inject, injectable, type interfaces } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { KeyStoreService } from '@theia/core/lib/common/key-store.js';
import { WorkspaceServer } from '@theia/workspace/lib/common/workspace-protocol.js';
import { SecretStoreService } from '../common/secret-store.js';
import { StaffStatusServer } from '../common/staff-live.js';
import { KeyService } from './key-service.js';
import type { KeyStore } from './key-stores.js';
import { PendingActionsKey } from './session-identity-backend-module.js';
import type { PendingActions } from './staff/person-signer.js';
import { SessionIdentity } from './session-identity.js';
import { bindBindingPart } from './staff/binding-part.js';
import { openEncryptionKey } from './staff/encryption-key.js';
import { keyStoreSecrets, STAFF_SECRET_SERVICE } from './staff/keystore-secrets.js';
import { startSessionKeys } from './staff/session-keys.js';
import { bindSharePart } from './staff/share-part.js';
import { loadStaffEngine } from './staff/staff-engine.js';
import { StaffLiveEngine, StaffLiveSession } from './staff/staff-live-engine.js';
import { bindStaffRoomPart } from './staff/staff-room-part.js';
import { bindStaffStatusService, type StaffStatusService } from './staff/staff-status-service.js';

export const StaffLiveSessionId = Symbol('StaffLiveSession');

export interface StaffBackendParts {
  readonly binding: (bind: interfaces.Bind) => void;
  readonly staffRoom: (bind: interfaces.Bind) => void;
  readonly share: (bind: interfaces.Bind) => void;
}

const PARTS: StaffBackendParts = { binding: bindBindingPart, staffRoom: bindStaffRoomPart, share: bindSharePart };

/** Where the engine keeps its per-person files (genesis pins, the hub address, the projector's record), beside the person's home. */
export function staffStateDir(): string {
  return path.join(homedir(), '.sterling', 'staff');
}

/** The workspace folder and the folders directly in it: a shared project's folder is one of them. */
async function workspaceRoots(server: WorkspaceServer): Promise<string[]> {
  const uri = await server.getMostRecentlyUsedWorkspace();
  if (uri === undefined || !uri.startsWith('file:')) return [];
  const folder = fileURLToPath(uri);
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return [folder, ...entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(folder, entry.name))];
  } catch {
    return [folder];
  }
}

/** Builds the session's engine: the keyring path on a single machine, the session keys and the encryption key in a hosted session. */
async function createEngine(context: interfaces.Context, log: (line: string) => void): Promise<StaffLiveEngine | undefined> {
  const identity = context.container.get<SessionIdentity>(SessionIdentity);
  const keyStore = context.container.get<KeyStore>(KeyStoreService);
  const status = await context.container.get<SecretStoreService>(SecretStoreService).status();
  const engine = loadStaffEngine();
  const workspace = context.container.get<WorkspaceServer>(WorkspaceServer);
  const secrets = keyStoreSecrets(keyStore, STAFF_SECRET_SERVICE, status.store);
  const common = { engine, roots: () => workspaceRoots(workspace), globalStorageDir: staffStateDir(), secrets, log };
  if (identity.status().mode === 'local') {
    if (status.store === 'unavailable') { log('staff: no secret store, so shared projects do not open'); return undefined; }
    return new StaffLiveEngine(common);
  }
  const keyService = context.container.get<KeyService>(KeyService);
  const actions = context.container.isBound(PendingActionsKey) ? context.container.get<PendingActions>(PendingActionsKey) : undefined;
  const keys = await startSessionKeys(keyService, identity, { now: () => Date.now() }, { engine, actions });
  if (keys.kind === 'refused') { log('staff: the session keys were not made, so shared projects do not open'); return undefined; }
  const encryption = await openEncryptionKey(keyService, secrets, engine);
  if (encryption.kind === 'refused') {
    keys.value.stop();
    log('staff: the encryption key was not opened, so shared projects do not open');
    return undefined;
  }
  return new StaffLiveEngine({ ...common, hosted: { keys: keys.value, encryption: encryption.value } });
}

@injectable()
class StaffLiveContribution implements BackendApplicationContribution {
  @inject(StaffLiveSessionId) protected readonly session!: StaffLiveSession;

  onStart(): void {
    void this.session.watch();
  }

  async onStop(): Promise<void> {
    await this.session.dispose();
  }
}

export function createStaffBackendModule(parts: StaffBackendParts = PARTS, log: (line: string) => void = (line) => console.info(line)): ContainerModule {
  return new ContainerModule((bind) => {
    bind(StaffLiveSessionId).toDynamicValue((context) => new StaffLiveSession({
      identity: context.container.get<SessionIdentity>(SessionIdentity),
      create: () => createEngine(context, log),
      started: (engine) => { context.container.get<StaffStatusService>(StaffStatusServer).attach(engine); },
    })).inSingletonScope();
    bindStaffStatusService(bind, (context) => () => context.container.get<StaffLiveSession>(StaffLiveSessionId).current);
    bind(StaffLiveContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(StaffLiveContribution);
    parts.binding(bind);
    parts.staffRoom(bind);
    parts.share(bind);
  });
}

export default createStaffBackendModule();
