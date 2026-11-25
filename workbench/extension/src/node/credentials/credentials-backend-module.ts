import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { IDENTITY_SERVICE_PATH, IdentityServiceRpc } from '../../common/identity.js';
import { bindBackendService } from '../backend-service.js';
import { KeyService } from '../key-service.js';
import { SessionIdentity } from '../session-identity.js';
import { defaultAppRoot } from '../team-preview-reader.js';
import { createIdentityService, openBaoKv, type IdentityEngine, type IdentityKv, type IdentityService } from './identity-service.js';
import { deviceSlotAllocator, listComputers, reportLostComputer, subjectOf } from './device-slots.js';
import { ISSUER_SERVICE_PATH, IssuerServiceRpc } from '../../common/issuer-service.js';
import { createIssuerService, inboxVerifier, openBaoIssuerLogin, type IssuerCaller, type IssuerEngine, type IssuerService, type IssuerServiceDeps } from './issuer-service.js';

/**
 * The person's identity in the Theia backend (Phase 71, 71-10). Once the session identity is active, the person's did:webvh is made once
 * (ensurePersonDid); the browser gets only status, Retry and binding a computer. People's DIDs live under STERLING_DID_DOMAIN; without it,
 * nothing is made. The engine bundle is engine/identity.cjs, loaded on first use, so a missing bundle means "not set up", never a crash.
 * The log reaches your organization's server at the person's first hub session (publishToHub), which arrives with Phase 33's hosted session.
 */
export const IdentityServiceId = Symbol('IdentityService');
export const IssuerServiceId = Symbol('IssuerService');
export const IssuerTrustId = Symbol('IssuerTrust');

/**
 * Where the issuer service and the inbox pickup read your organization's rules and reach its server: 71-13's hosted trust source and 33-23's hub
 * session provide them. Until both are on main they answer undefined, so issuing refuses with one sentence and inbox items wait (G465).
 */
type IssuerTrust = Pick<IssuerServiceDeps, 'policy' | 'hub'>;

/** The RPC is reached only from the native card in the person's own browser tab: a person, interactive. Agents never reach it (D-07). */
const CARD_CALLER: IssuerCaller = { presence: 'person', context: 'interactive' };

const WAIT_STEP_MS = 2000;
const WAIT_STEPS = 150;

@injectable()
export class IdentityStartContribution implements BackendApplicationContribution {
  @inject(SessionIdentity) protected readonly identity!: SessionIdentity;
  @inject(IdentityServiceId) protected readonly service!: IdentityService;
  @inject(IssuerTrustId) protected readonly trust!: IssuerTrust;

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
        // The credentials officers left for the person since their last session (71-12, D-15).
        await this.service.collectInbox(inboxVerifier({ engine: issuerEngine, ...this.trust }));
        return;
      }
      await new Promise(done => setTimeout(done, WAIT_STEP_MS).unref());
    }
  }
}

const loadEngine = engineLoader();
const issuerEngine = (): IssuerEngine | undefined => loadEngine() as unknown as IssuerEngine | undefined;

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

/** The revocation and suspension lists of your organization's rules in force (the first of each), for device slots (D-25). */
function listsOf(trust: IssuerTrust): () => { revocation: string; suspension: string } | undefined {
  return () => {
    const lists = trust.policy()?.section.statusLists ?? [];
    const revocation = lists.find(list => list.purpose === 'revocation')?.uri;
    const suspension = lists.find(list => list.purpose === 'suspension')?.uri;
    return revocation === undefined || suspension === undefined ? undefined : { revocation, suspension };
  };
}

export default new ContainerModule(bind => {
  bind(IssuerTrustId).toConstantValue({ policy: () => undefined, hub: () => undefined } satisfies IssuerTrust);
  bind(IdentityServiceId).toDynamicValue(context => {
    const identity = context.container.get<SessionIdentity>(SessionIdentity);
    const trust = context.container.get<IssuerTrust>(IssuerTrustId);
    const domain = process.env.STERLING_DID_DOMAIN;
    const kv = openBaoKv(() => identity.session());
    const entityId = (): string | undefined => identity.session()?.entityId;
    return createIdentityService({
      keys: context.container.get<KeyService>(KeyService),
      kv,
      entityId,
      space: () => identity.session()?.space,
      engine: loadEngine,
      domain: domain === undefined || domain === '' ? undefined : domain,
      // The person's own computer slots (D-25, owner 2026-11-25): create only, under their own entity, at most 5.
      statusAllocator: deviceSlotAllocator({ kv, entityId, lists: listsOf(trust) }),
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
      inboxNews: async () => service.inboxNews(),
      computers: () => listComputers({ kv: slotsKv(), entityId: slotsEntity() }),
      reportLostComputer: slot => reportLostComputer({ kv: slotsKv(), entityId: slotsEntity(), subject: () => subjectOf(slotsSession()?.forwardedToken) }, slot),
    };

    function slotsSession(): ReturnType<SessionIdentity['session']> {
      return context.container.get<SessionIdentity>(SessionIdentity).session();
    }
    function slotsKv(): IdentityKv {
      return openBaoKv(() => slotsSession());
    }
    function slotsEntity(): () => string | undefined {
      return () => slotsSession()?.entityId;
    }
  });
  bind(IssuerServiceId).toDynamicValue(context => {
    const identity = context.container.get<SessionIdentity>(SessionIdentity);
    const trust = context.container.get<IssuerTrust>(IssuerTrustId);
    const kv = openBaoKv(() => identity.session());
    const statusKey = process.env.STERLING_STATUS_LIST_KEY;
    return createIssuerService({
      keys: context.container.get<KeyService>(KeyService),
      ownKv: { read: path => kv.read(path), list: async folder => (await kv.list?.(folder)) ?? [] },
      entityId: () => identity.session()?.entityId,
      engine: issuerEngine,
      ...trust,
      login: openBaoIssuerLogin(() => identity.session(), statusKey === undefined || statusKey === '' ? undefined : statusKey,
        process.env.STERLING_OPENBAO_ISSUER_ROLE || 'sterling-issuer-stepup'),
    });
  }).inSingletonScope();
  bindBackendService<IssuerServiceRpc>(bind, IssuerServiceRpc, ISSUER_SERVICE_PATH, context => {
    const service = context.container.get<IssuerService>(IssuerServiceId);
    return {
      issuableTypes: () => service.issuableTypes(),
      review: request => service.review(request, CARD_CALLER),
      issue: request => service.issue(request, CARD_CALLER),
      listIssued: () => service.listIssued(CARD_CALLER),
      revoke: hash => service.revoke(hash, CARD_CALLER),
      suspend: hash => service.suspend(hash, CARD_CALLER),
      clearSuspension: hash => service.clearSuspension(hash, CARD_CALLER),
      listRevocationRequests: () => service.listRevocationRequests(CARD_CALLER),
      resolveRequest: id => service.resolveRequest(id, CARD_CALLER),
      revokeComputer: (id, slot) => service.revokeComputer(id, slot, CARD_CALLER),
    };
  });
});
