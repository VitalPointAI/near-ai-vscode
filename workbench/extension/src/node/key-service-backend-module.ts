import { ContainerModule } from '@theia/core/shared/inversify';
import { KEY_SERVICE_PATH, KeyServiceRpc } from '../common/key-service.js';
import { bindBackendService } from './backend-service.js';
import { createKeyService, KeyService, keyServiceRpc } from './key-service.js';
import { SessionIdentity } from './session-identity.js';

/**
 * The key service in the Theia backend (D-15, D-20, D-21; 46-07 planning choice 2): KeyService, with unwrapDataKey, for backend code (Phase
 * 33's), and at /services/sterling-key-service an RPC object with only sign and generateWrappedDataKey, so no plaintext data key can reach
 * the browser (T-46-29).
 */
export default new ContainerModule(bind => {
  bind(KeyService).toDynamicValue(context => createKeyService(context.container.get<SessionIdentity>(SessionIdentity))).inSingletonScope();
  bindBackendService<KeyServiceRpc>(bind, KeyServiceRpc, KEY_SERVICE_PATH, context => keyServiceRpc(context.container.get<KeyService>(KeyService)));
});
