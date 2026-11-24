import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';
import { SESSION_ACTIVITY_PATH, SessionActivityService } from '../common/session-activity.js';
import { bindBackendService } from './backend-service.js';
import { createSessionActivity, SessionActivity } from './session-activity.js';

/**
 * Theia Cloud's activity tracker in the Theia backend (common/session-activity.ts). The /monitor answers are early middleware, like
 * /healthz, so they need no cookie and no frontend files; the session identity check ignores them, as they carry no sign-in token. The
 * browser gets only report() and state().
 */
@injectable()
export class MonitorContribution implements BackendApplicationContribution {
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;
  @inject(SessionActivity) protected readonly activity!: SessionActivity;

  initialize(): void {
    this.early.handlers.push((request, response, next) => {
      const answer = this.activity.answer(request.method, request.path, request.headers.authorization);
      if (answer === undefined) {
        next();
        return;
      }
      // These paths are reachable without sign-in, so never hand out Theia's browser connection-token cookie on them (its early middleware
      // may have set it already, depending on the order the contributions initialized).
      response.removeHeader('Set-Cookie');
      response.status(answer.status).set('Cache-Control', 'no-store').type('text/plain').send(answer.body);
    });
  }
}

export default new ContainerModule(bind => {
  bind(SessionActivity).toDynamicValue(() => createSessionActivity(process.env)).inSingletonScope();
  bind(MonitorContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(MonitorContribution);
  bindBackendService<SessionActivityService>(bind, SessionActivityService, SESSION_ACTIVITY_PATH, context => {
    const activity = context.container.get<SessionActivity>(SessionActivity);
    return {
      report: async () => activity.report(),
      state: async () => activity.state(),
    };
  });
});
