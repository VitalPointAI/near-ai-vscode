import type http from 'node:http';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';
import { SESSION_ACTIVITY_PATH, SessionActivityService } from '../common/session-activity.js';
import { bindBackendService } from './backend-service.js';
import { createSessionActivity, createTrackerServer, SessionActivity, trackerAddress, WORKBENCH_PORT } from './session-activity.js';

/** Checks STERLING_LISTEN_HOST once at start; an invalid one stops the backend with one line naming it, like the outbound settings. */
function readTrackerAddress(): string | undefined {
  try {
    return trackerAddress(process.env);
  } catch (error) {
    console.error(`The Sterling workbench cannot start: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * Theia Cloud's activity tracker in the Theia backend (common/session-activity.ts). The /monitor answers are early middleware, like
 * /healthz, so they need no cookie and no frontend files; the session identity check ignores them, as they carry no sign-in token. The
 * browser gets only report() and state(). In hosted mode with a pod IP in STERLING_LISTEN_HOST the same answers are also served on that
 * address, and nothing else is: the operator calls the pod address directly, while Theia stays on loopback behind the sidecar.
 */
@injectable()
export class MonitorContribution implements BackendApplicationContribution {
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;
  @inject(SessionActivity) protected readonly activity!: SessionActivity;
  private readonly address = readTrackerAddress();
  private tracker: http.Server | undefined;

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

  async onStart(): Promise<void> {
    const address = this.address;
    if (address === undefined) return;
    const tracker = createTrackerServer(this.activity);
    this.tracker = tracker;
    await new Promise<void>((resolve) => {
      tracker.once('error', (error: NodeJS.ErrnoException) => {
        // Without this listener the operator never sees a use and stops the session early, so a failed listen stops start visibly.
        console.error(`The Sterling workbench cannot start: the activity tracker cannot listen on ${address} port ${WORKBENCH_PORT} (${error.code ?? 'error'}).`);
        process.exit(1);
      });
      tracker.listen(WORKBENCH_PORT, address, resolve);
    });
  }

  onStop(): void {
    this.tracker?.close();
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
