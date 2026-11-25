import { ContainerModule } from '@theia/core/shared/inversify';
import { GUEST_SECRETS_PATH, GuestSecretsRpc } from '../common/guest-secrets.js';
import { bindBackendService } from './backend-service.js';
import { createGuestSecretsService, GuestSecretsService } from './guest-secrets-service.js';
import { SessionIdentity } from './session-identity.js';

/** Removing ended guests' secrets (Phase 47 D-84): the service, and at /services/sterling-guest-secrets its three RPC methods. */
export default new ContainerModule(bind => {
  bind(GuestSecretsService).toDynamicValue(context => createGuestSecretsService(context.container.get<SessionIdentity>(SessionIdentity))).inSingletonScope();
  bindBackendService<GuestSecretsRpc>(bind, GuestSecretsRpc, GUEST_SECRETS_PATH, context => context.container.get<GuestSecretsService>(GuestSecretsService));
});
