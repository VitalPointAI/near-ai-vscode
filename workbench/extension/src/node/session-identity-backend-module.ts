import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';
import { MessagingListenerContribution } from '@theia/core/lib/node/messaging/messaging-listeners.js';
import type * as http from 'node:http';
import { SESSION_IDENTITY_PATH, SessionIdentityService } from '../common/session-identity.js';
import { bindBackendService } from './backend-service.js';
import { readHostingConfig } from './hosting-config.js';
import { createOpenBaoClient } from './openbao-client.js';
import { createSessionIdentity, SessionIdentity } from './session-identity.js';

/**
 * Session identity in the Theia backend (D-22, D-23, D-38). The forwarded sign-in headers are read on every HTTP request (early middleware)
 * and on each WebSocket upgrade, because a long-lived WebSocket carries only its connect-time token; the check starts with the backend and the
 * OpenBao token is revoked when it stops (SIGINT and SIGTERM reach onStop through Theia's graceful shutdown). The browser gets only status()
 * and retry(): never a token or an entity id (T-46-06).
 */
@injectable()
export class ForwardedTokenContribution implements BackendApplicationContribution, MessagingListenerContribution {
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;
  @inject(SessionIdentity) protected readonly identity!: SessionIdentity;

  initialize(): void {
    this.early.handlers.push((request, _response, next) => {
      this.identity.observe(request.headers);
      next();
    });
  }

  onStart(): void {
    void this.identity.start();
  }

  async onStop(): Promise<void> {
    await this.identity.stop();
  }

  onDidWebSocketUpgrade(request: http.IncomingMessage): void {
    this.identity.observe(request.headers);
  }
}

/** Builds the process's one SessionIdentity. An invalid hosted setting stops the backend with one line naming it (46-02 planning choice 3). */
function sessionIdentityFromEnvironment(): SessionIdentity {
  try {
    const config = readHostingConfig(process.env);
    const client = config.mode === 'hosted' ? createOpenBaoClient({ addr: config.addr, caFile: config.caFile }) : undefined;
    return createSessionIdentity({ config, client });
  } catch (error) {
    console.error(`The Sterling workbench cannot start: ${(error as Error).message}`);
    process.exit(1);
  }
}

export default new ContainerModule(bind => {
  bind(SessionIdentity).toDynamicValue(() => sessionIdentityFromEnvironment()).inSingletonScope();
  bind(ForwardedTokenContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(ForwardedTokenContribution);
  bind(MessagingListenerContribution).toService(ForwardedTokenContribution);
  bindBackendService<SessionIdentityService>(bind, SessionIdentityService, SESSION_IDENTITY_PATH, context => {
    const identity = context.container.get<SessionIdentity>(SessionIdentity);
    return {
      status: async () => identity.status(),
      retry: async () => {
        await identity.retry();
        return identity.status();
      },
    };
  });
});
