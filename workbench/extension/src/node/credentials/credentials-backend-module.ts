import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { IDENTITY_SERVICE_PATH, IdentityServiceRpc } from '../../common/identity.js';
import { bindBackendService } from '../backend-service.js';
import { KeyService } from '../key-service.js';
import { SessionIdentity } from '../session-identity.js';
import { defaultAppRoot } from '../team-preview-reader.js';
import { createIdentityService, openBaoKv, type IdentityEngine, type IdentityService } from './identity-service.js';

/**
 * The person's identity in the Theia backend (Phase 71, 71-10). Once the session identity is active, the person's did:webvh is made once
 * (ensurePersonDid); the browser gets only status, Retry and binding a computer. People's DIDs live under STERLING_DID_DOMAIN; without it,
 * nothing is made. The engine bundle is engine/identity.cjs, loaded on first use, so a missing bundle means "not set up", never a crash.
 * The log reaches your organization's server at the person's first hub session (publishToHub), which arrives with Phase 33's hosted session.
 */
export const IdentityServiceId = Symbol('IdentityService');

const WAIT_STEP_MS = 2000;
const WAIT_STEPS = 150;

@injectable()
export class IdentityStartContribution implements BackendApplicationContribution {
  @inject(SessionIdentity) protected readonly identity!: SessionIdentity;
  @inject(IdentityServiceId) protected readonly service!: IdentityService;

  onStart(): void {
    void this.whenActive();
  }

  /** Waits for the session check to settle (at most five minutes), then makes the identity once; Retry covers anything later. */
  protected async whenActive(): Promise<void> {
    for (let step = 0; step < WAIT_STEPS; step += 1) {
      const status = this.identity.status();
      if (status.mode === 'local' || status.state === 'stopping' || status.state === 'stopped') return;
      if (status.state === 'active') {
        await this.service.ensurePersonDid();
        return;
      }
      await new Promise(done => setTimeout(done, WAIT_STEP_MS).unref());
    }
  }
}

function engineLoader(): () => IdentityEngine | undefined {
  const file = resolve(defaultAppRoot(), 'engine', 'identity.cjs');
  let engine: IdentityEngine | undefined;
  return () => {
    if (engine === undefined) {
      try {
        engine = createRequire(file)(file) as IdentityEngine;
      } catch {
        return undefined;
      }
    }
    return engine;
  };
}

export default new ContainerModule(bind => {
  bind(IdentityServiceId).toDynamicValue(context => {
    const identity = context.container.get<SessionIdentity>(SessionIdentity);
    const domain = process.env.STERLING_DID_DOMAIN;
    return createIdentityService({
      keys: context.container.get<KeyService>(KeyService),
      kv: openBaoKv(() => identity.session()),
      entityId: () => identity.session()?.entityId,
      engine: engineLoader(),
      domain: domain === undefined || domain === '' ? undefined : domain,
    });
  }).inSingletonScope();
  bind(IdentityStartContribution).toSelf().inSingletonScope();
  bind(BackendApplicationContribution).toService(IdentityStartContribution);
  bindBackendService<IdentityServiceRpc>(bind, IdentityServiceRpc, IDENTITY_SERVICE_PATH, context => {
    const service = context.container.get<IdentityService>(IdentityServiceId);
    return {
      status: async () => service.status(),
      retry: () => service.ensurePersonDid(),
      bindComputer: (didKey, words, deviceClass) => service.bindComputer(didKey, words, deviceClass),
    };
  });
});
