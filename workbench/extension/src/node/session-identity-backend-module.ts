import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';
import { MessagingListenerContribution } from '@theia/core/lib/node/messaging/messaging-listeners.js';
import type * as http from 'node:http';
import type { Application, Response } from '@theia/core/shared/express';
import { ACTION_STEP_UP_PATH, SESSION_IDENTITY_PATH, SessionIdentityService } from '../common/session-identity.js';
import { bindBackendService } from './backend-service.js';
import { readHostingConfig, type HostingConfig } from './hosting-config.js';
import { createOpenBaoClient } from './openbao-client.js';
import { createSessionIdentity, SessionIdentity } from './session-identity.js';
import { createPendingActions, type PendingActions } from './staff/person-signer.js';
import { STEP_UP_PAGE_HEADERS, actionReturnPage, actionSummaryPage, type PageAnswer } from './staff/step-up-page.js';

/** The pending person actions of this one session backend (33.1-17), in memory only. */
export const PendingActionsKey = Symbol('PendingActions');

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

/**
 * The step-up of one person action (33.1-17, 33.1 D-09), beside the forwarded-token handling: GET ACTION_STEP_UP_PATH/:nonce serves the summary
 * page, and GET ACTION_STEP_UP_PATH/:nonce/return is the only place a token is bound to an action. The early middleware above has already read this
 * request's forwarded token into the person check, so the return route binds that token and no other (bindStepUp, through actionReturnPage).
 */
@injectable()
export class ActionStepUpContribution implements BackendApplicationContribution {
  @inject(SessionIdentity) protected readonly identity!: SessionIdentity;
  @inject(PendingActionsKey) protected readonly actions!: PendingActions;

  configure(app: Application): void {
    const acr = stepUpAcrOf(this.identity);
    const send = (response: Response, answer: PageAnswer): void => {
      response.status(answer.status).set({ ...STEP_UP_PAGE_HEADERS }).send(answer.html);
    };
    app.get(`${ACTION_STEP_UP_PATH}/:nonce`, (request, response) => send(response, actionSummaryPage(this.actions, request.params.nonce, acr)));
    app.get(`${ACTION_STEP_UP_PATH}/:nonce/return`, (request, response) =>
      send(response, actionReturnPage(this.actions, () => this.identity.session(), request.headers, request.params.nonce)));
  }
}

/** The step-up acr the identity reports (STERLING_STEPUP_ACR), or undefined when none is set up. */
function stepUpAcrOf(identity: SessionIdentity): string | undefined {
  const status = identity.status();
  return status.mode === 'hosted' ? status.stepUp?.acr : undefined;
}

function pendingActionsFor(config: HostingConfig, identity: SessionIdentity): PendingActions {
  return createPendingActions({
    stepUpAcr: config.mode === 'hosted' ? config.stepUpAcr : undefined,
    windowSeconds: config.mode === 'hosted' ? config.stepUpMaxAgeSeconds : 0,
    latestAuthTime: () => identity.session()?.authTime,
  });
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
  bind(PendingActionsKey).toDynamicValue(context => pendingActionsFor(readHostingConfig(process.env), context.container.get<SessionIdentity>(SessionIdentity))).inSingletonScope();
  bind(ActionStepUpContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(ActionStepUpContribution);
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
