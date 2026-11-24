import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';

/**
 * `GET /healthz` answers 200 `ok` for the image's HEALTHCHECK and the container tests (research C11: Theia core has no health endpoint).
 * It is pushed onto the early middleware in `initialize()`, which Theia runs before it applies those handlers, so it needs no cookie and no
 * frontend files, and it says nothing about the session.
 */
@injectable()
export class HealthContribution implements BackendApplicationContribution {
  @inject(EarlyExpressMiddleware) protected readonly early!: EarlyExpressMiddleware;

  initialize(): void {
    this.early.handlers.push((request, response, next) => {
      if (request.method === 'GET' && request.path === '/healthz') {
        response.status(200).type('text/plain').send('ok');
        return;
      }
      next();
    });
  }
}

export default new ContainerModule(bind => {
  bind(HealthContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(HealthContribution);
});
