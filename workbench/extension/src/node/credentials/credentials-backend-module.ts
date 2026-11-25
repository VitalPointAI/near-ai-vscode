import { ContainerModule, inject, injectable, optional, type interfaces } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { IDENTITY_SERVICE_PATH, IdentityServiceRpc, type IdentityStatus } from '../../common/identity.js';
import { bindBackendService } from '../backend-service.js';
import { KeyService } from '../key-service.js';
import { SessionIdentity } from '../session-identity.js';
import { defaultAppRoot } from '../team-preview-reader.js';
import { createIdentityService, openBaoKv, type IdentityEngine, type IdentityKv, type IdentityService } from './identity-service.js';
import { deviceSlotAllocator, listComputers, reportLostComputer, subjectOf } from './device-slots.js';
import { ISSUER_SERVICE_PATH, IssuerServiceRpc } from '../../common/issuer-service.js';
import { createIssuerService, inboxVerifier, openBaoIssuerLogin, type IssuerCaller, type IssuerEngine, type IssuerService, type IssuerServiceDeps } from './issuer-service.js';
import { CredentialCacheId, createCredentialCache, identityStatusWith, type CredentialCache, type CredentialEngine } from './credential-cache.js';
import { tokenFactsOf } from './token-facts.js';
import { loadStaffEngine } from '../staff/staff-engine.js';
import { StaffLiveSessionId } from '../staff-backend-module.js';
import type { StaffLiveSession } from '../staff/staff-live-engine.js';

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
 * Where the issuer service and the inbox pickup read your organization's rules and reach its server (71-13): the credential cache's verified rules
 * and the person's hub session through a live shared project. While either is missing they answer undefined, so issuing refuses with one sentence
 * and inbox items wait (G465).
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
  @inject(CredentialCacheId) protected readonly credentials!: CredentialCache;
  @inject(StaffLiveSessionId) @optional() protected readonly staff: StaffLiveSession | undefined;
  private collectedWithHub = false;
  private hubSeen = false;

  onStart(): void {
    void this.whenActive();
  }

  onStop(): void {
    this.credentials.stop();
  }

  /** Waits for the session check to settle (at most five minutes), then makes the identity once; Retry covers anything later. */
  protected async whenActive(): Promise<void> {
    for (let step = 0; step < WAIT_STEPS; step += 1) {
      const status = this.identity.status();
      if (status.mode === 'local' || status.state === 'stopping' || status.state === 'stopped') return;
      if (status.state === 'active') {
        await this.service.ensurePersonDid();
        // The credentials officers left for the person since their last session (71-12, D-15).
        await this.collect();
        // The session's credential check (71-13, D-18): the wallet is checked now and kept fresh from your organization's hub. Once a hub session
        // is live, the person's own identity log is posted through it (D-24) and the inbox items that waited for it are picked up.
        this.credentials.onDidChange(() => { void this.whenHub(); });
        await this.credentials.start();
        await this.whenHub();
        return;
      }
      await new Promise(done => setTimeout(done, WAIT_STEP_MS).unref());
    }
  }

  /** Once per session, when a hub session is first live: the person's log is posted (D-24), waiting inbox items are picked up, and the check runs. */
  private async whenHub(): Promise<void> {
    const hub = staffTrustOf(this.staff);
    if (hub === undefined || this.hubSeen) return;
    this.hubSeen = true;
    await this.service.publishToHub(hub);
    if (!this.collectedWithHub) await this.collect();
    await this.credentials.refresh();
  }

  private async collect(): Promise<void> {
    if (this.trust.hub() !== undefined) this.collectedWithHub = true;
    await this.service.collectInbox(inboxVerifier({ engine: issuerEngine, ...this.trust }));
  }
}

const RULES_RECHECK_MS = 60_000;

/**
 * Your organization's signed rules for the session (71-13), as the hub reads its own: STERLING_ORGANIZATION_POLICY, the absolute path of the signed
 * rules file the site mounts, and STERLING_ORGANIZATION_POLICY_KEY, your organization's policy issuer key (43 base64url characters). Read at most
 * once a minute; without both, or when the file cannot be read, there are none and nothing about credentials changes (D-08).
 */
function organizationRules(env: NodeJS.ProcessEnv): () => { readonly text: string; readonly key: string } | undefined {
  const file = env.STERLING_ORGANIZATION_POLICY;
  const key = env.STERLING_ORGANIZATION_POLICY_KEY;
  if (file === undefined || key === undefined || !isAbsolute(file) || !/^[A-Za-z0-9_-]{43}$/.test(key)) return () => undefined;
  let held: { text: string; at: number } | undefined;
  return () => {
    const now = Date.now();
    if (held === undefined || now - held.at >= RULES_RECHECK_MS) {
      try {
        held = { text: readFileSync(file, 'utf8'), at: now };
      } catch {
        held = undefined;
        return undefined;
      }
    }
    return { text: held.text, key };
  };
}

/** The person's hub session through the first live shared project (Phase 33's hosted session), or undefined while none is live. */
function staffTrust(context: interfaces.Context): ReturnType<NonNullable<StaffLiveSession['current']>['trustSession']> {
  return staffTrustOf(context.container.isBound(StaffLiveSessionId) ? context.container.get<StaffLiveSession>(StaffLiveSessionId) : undefined);
}

function staffTrustOf(session: StaffLiveSession | undefined): ReturnType<NonNullable<StaffLiveSession['current']>['trustSession']> {
  return session?.current?.trustSession();
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
  bind(CredentialCacheId).toDynamicValue(context => {
    const identity = context.container.get<SessionIdentity>(SessionIdentity);
    const kv = openBaoKv(() => identity.session());
    return createCredentialCache({
      engine: () => {
        try {
          return loadStaffEngine<CredentialEngine>();
        } catch {
          return undefined;
        }
      },
      rules: organizationRules(process.env),
      kv: { read: path => kv.read(path), list: async folder => (await kv.list?.(folder)) ?? [] },
      session: () => {
        const active = identity.session();
        const token = tokenFactsOf(active?.forwardedToken);
        return active === undefined || token === undefined ? undefined : { token, entityId: active.entityId, ...(active.space === undefined ? {} : { space: active.space }) };
      },
      holder: async () => {
        const status = await context.container.get<IdentityService>(IdentityServiceId).status();
        return status.state === 'ready' ? status.did : undefined;
      },
      hub: () => staffTrust(context),
    });
  }).inSingletonScope();
  bind(IssuerTrustId).toDynamicValue(context => {
    const credentials = context.container.get<CredentialCache>(CredentialCacheId);
    return { policy: () => credentials.policy(), hub: () => staffTrust(context) } satisfies IssuerTrust;
  }).inSingletonScope();
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
      status: async () => withCredentials(await service.status()),
      retry: async () => {
        const status = await service.ensurePersonDid();
        await credentials().refresh();
        return withCredentials(status);
      },
      bindComputer: (didKey, words, deviceClass) => service.bindComputer(didKey, words, deviceClass),
      inboxNews: async () => service.inboxNews(),
      computers: () => listComputers({ kv: slotsKv(), entityId: slotsEntity() }),
      reportLostComputer: slot => reportLostComputer({ kv: slotsKv(), entityId: slotsEntity(), subject: () => subjectOf(slotsSession()?.forwardedToken) }, slot),
    };

    function credentials(): CredentialCache {
      return context.container.get<CredentialCache>(CredentialCacheId);
    }
    function withCredentials(status: IdentityStatus): IdentityStatus {
      return identityStatusWith(status, credentials());
    }
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
