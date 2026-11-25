import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution, EarlyExpressMiddleware } from '@theia/core/lib/node/backend-application.js';
import { BackendRequestAllowedContribution } from '@theia/core/lib/node/request/backend-request-facade.js';
import { readOutboundSettings } from './egress.js';
import { SterlingRequestAllowList } from './egress-contribution.js';
import { EVIDENCE_SERVICE_PATH, SterlingEvidenceService } from '../common/sterling-evidence.js';
import { bindBackendService } from './backend-service.js';
import { createEvidenceService } from './sterling-evidence-service.js';

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

/** Reads the outbound address settings once at start; an invalid one stops the backend with one line naming it (D-06, D-26). */
function outboundAllowList(): SterlingRequestAllowList {
  try {
    return new SterlingRequestAllowList(readOutboundSettings(process.env));
  } catch (error) {
    console.error(`The Sterling workbench cannot start: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** Resolves the allow list while the backend initializes, so a bad address setting stops start instead of a later request. */
@injectable()
export class OutboundSettingsContribution implements BackendApplicationContribution {
  @inject(SterlingRequestAllowList) protected readonly allowList!: SterlingRequestAllowList;

  initialize(): void {
    // The injection above has already read and checked the settings.
  }
}

export default new ContainerModule(bind => {
  bind(HealthContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(HealthContribution);
  bind(SterlingRequestAllowList).toDynamicValue(() => outboundAllowList()).inSingletonScope();
  bind(BackendRequestAllowedContribution).toService(SterlingRequestAllowList);
  bind(OutboundSettingsContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(OutboundSettingsContribution);
  // The release evidence, checked and re-judged against the current time for the Compliance view (48.2-01, D-01, D-11).
  bindBackendService<SterlingEvidenceService>(bind, SterlingEvidenceService, EVIDENCE_SERVICE_PATH, () => createEvidenceService());
});
