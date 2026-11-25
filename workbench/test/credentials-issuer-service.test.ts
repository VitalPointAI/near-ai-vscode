// Phase 71, plan 12, task 2 (D-07, D-14, D-15, D-22; O4, O7): an officer issues, revokes and suspends credentials in their own session, the person
// receives them at their next session, and the revocation requests 47-20 and 47-31 file reach the officers who issued to that person. Fakes for
// the key service, the officer's own KV, the issuer step-up vault and the hub; the engine is the real code (tools/identity-entry.ts), and every
// DID, key, credential and list is made at run time for the fictional Example Organization. Flat file name, so the workbench runner runs it (H-71-01).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as realEngine from '../tools/identity-entry.ts';
import { REVOCATIONS, SUSPENSIONS, issue as issueFixture, list as signedList, makeWorld, newKey, person, type Key, type Person } from '../../src/test/helpers/credentialWorld.ts';
import { decodePublicKeyMultibase } from '../../src/domain/credentials/multibase.ts';
import { verifyStatusList, statusAt } from '../../src/domain/credentials/statusList.ts';
import { ISSUER_TEXT, type IssueRequest } from '../extension/src/common/issuer-service.ts';
import { ISSUE_FORM_TEXT } from '../../src/domain/credentials/issueForm.ts';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { ok, refused } from '../extension/src/common/service-result.ts';
import { createIdentityService, ownRecordPath, type IdentityKv } from '../extension/src/node/credentials/identity-service.ts';
import {
  INBOX_FORMAT, ISSUED_FORMAT, REVOCATION_FORMAT, WALLET_ITEM_FORMAT, createIssuerService, inboxVerifier, walletFolder,
  type HubStatusSession, type IssuerCaller, type IssuerEngine, type IssuerLogin, type IssuerPolicy, type IssuerVault,
} from '../extension/src/node/credentials/issuer-service.ts';
import { DEVICE_INDEX_FROM } from '../extension/src/node/credentials/device-slots.ts';

const engine = realEngine as unknown as IssuerEngine;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const PERSON: IssuerCaller = { presence: 'person', context: 'interactive' };
const OFFICER_ENTITY = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const ALEX_ENTITY = '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c';
const OTHER_OFFICER_ENTITY = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';

/** KV in memory: create with check-and-set 0, folders listed by their direct children. */
class Store {
  readonly data = new Map<string, Record<string, unknown>>();
  read(path: string): Record<string, unknown> | undefined { return this.data.get(path); }
  create(path: string, value: Record<string, unknown>): 'created' | 'exists' {
    if (this.data.has(path)) return 'exists';
    this.data.set(path, structuredClone(value));
    return 'created';
  }
  list(folder: string): string[] {
    const names = new Set<string>();
    for (const key of this.data.keys()) if (key.startsWith(folder)) { const rest = key.slice(folder.length); names.add(rest.includes('/') ? `${rest.split('/')[0]}/` : rest); }
    return [...names];
  }
}

/** The hub's status routes: GET the newest list, PUT exactly one version above with a 409 otherwise (71-09); DID logs by path. */
function fakeHub(logs: Record<string, string>): HubStatusSession & { lists: Map<string, string>; puts: number; clashOnce: (text: string) => void } {
  const lists = new Map<string, string>();
  let clash: string | undefined;
  const hub = {
    lists, puts: 0,
    /** The next put loses to another officer's version, `text`, which arrives first. */
    clashOnce: (text: string) => { clash = text; },
    async getLog(path: string) { return logs[path]; },
    async getList(name: string) { return lists.get(name); },
    async putList(name: string, text: string) {
      hub.puts += 1;
      if (clash !== undefined) {
        lists.set(name, clash);
        clash = undefined;
        return { status: 409 };
      }
      const version = (JSON.parse(text) as { credentialSubject: { version: number } }).credentialSubject.version;
      const held = lists.get(name);
      if (held !== undefined && (JSON.parse(held) as { credentialSubject: { version: number } }).credentialSubject.version + 1 !== version) return { status: 409 };
      lists.set(name, text);
      return { status: 201 };
    },
  };
  return hub;
}

interface Officer { person: Person; entity: string; own: Store; fresh: boolean; signs: number }

async function signedRole(root: Person, officer: Person, credentialType = 'ClearanceCredential', upTo = 'Secret', validUntil = '2027-03-01T00:00:00Z') {
  return issueFixture(root.signer, root.did, 'IssuerRoleCredential', { id: officer.did, credentialType, scale: 'ca-classified', upTo }, { validUntil });
}

async function setup(options: { roleUpTo?: string; noRole?: boolean; roleUntil?: string; suites?: string[] } = {}) {
  const world = await makeWorld();
  // One status-list key for the site (D-14): both lists name it.
  const statusKey = newKey();
  const policy: IssuerPolicy = {
    section: { ...world.section, ...(options.suites === undefined ? {} : { suites: options.suites }), statusLists: [{ uri: REVOCATIONS, purpose: 'revocation', key: statusKey.multikey }, { uri: SUSPENSIONS, purpose: 'suspension', key: statusKey.multikey }] },
    scales: world.policy.scales,
  } as unknown as IssuerPolicy;
  const alex = await person(['people', 'alex-subject']);
  const second = await person(['people', 'morgan']);
  const logs: Record<string, string> = { org: world.root.log, 'people/alex': world.officer.log, 'people/morgan': second.log, 'people/alex-subject': alex.log };
  const hub = fakeHub(logs);
  const site = new Store();
  site.create(`site/people/${ALEX_ENTITY}`, { did: alex.did });
  site.create(`site/people/${OFFICER_ENTITY}`, { did: world.officer.did });
  const entities: Record<string, string> = { [`keycloak-kc-alex`]: ALEX_ENTITY, [`guest-kc-alex`]: ALEX_ENTITY };
  const vaultEvents = { logins: 0, ended: 0, statusSigns: 0 };

  async function officerFrom(p: Person, entity: string, role: Awaited<ReturnType<typeof signedRole>> | undefined): Promise<Officer> {
    const own = new Store();
    own.create(ownRecordPath(entity), { format: 'sterling-person-did/1', did: p.did, path: 'people/x', log: p.log, published: true });
    if (role !== undefined) own.create(`${walletFolder(entity)}/${role.hash}`, { format: WALLET_ITEM_FORMAT, credential: role.credential });
    return { person: p, entity, own, fresh: true, signs: 0 };
  }
  const officer = await officerFrom(world.officer, OFFICER_ENTITY,
    options.noRole ? undefined : await signedRole(world.root, world.officer, 'ClearanceCredential', options.roleUpTo ?? 'Secret', options.roleUntil));
  const otherOfficer = await officerFrom(second, OTHER_OFFICER_ENTITY, await signedRole(world.root, second));

  function vault(who: Officer, key: Key): IssuerVault {
    return {
      async read(path) { return site.read(path); },
      async create(path, value) { return site.create(path, value); },
      async list(folder) { return site.list(folder); },
      async remove(path) { site.data.delete(path); },
      async entityId(name) { return entities[name]; },
      async signStatus(message) { vaultEvents.statusSigns += 1; return Buffer.from(await key.signer.sign(new Uint8Array(Buffer.from(message, 'base64')))).toString('base64'); },
      async end() { vaultEvents.ended += 1; void who; },
    };
  }

  function serviceFor(who: Officer, extra: { hub?: HubStatusSession | undefined; policy?: IssuerPolicy | undefined; login?: () => Promise<IssuerLogin>; randomIndex?: (size: number) => number } = {}) {
    const raw = decodePublicKeyMultibase(who.person.issuing.multikey).key;
    return createIssuerService({
      keys: {
        personPublicKey: async () => ok({ publicKey: Buffer.from(raw).toString('base64url'), keyVersion: 1 }),
        sign: async (message: string) => {
          if (!who.fresh) return refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm);
          who.signs += 1;
          return ok({ signature: Buffer.from(await who.person.issuing.signer.sign(new Uint8Array(Buffer.from(message, 'base64')))).toString('base64'), keyVersion: 1 });
        },
      },
      ownKv: { read: async (path) => who.own.read(path), list: async (folder) => who.own.list(folder) },
      entityId: () => who.entity,
      engine: () => engine,
      policy: () => ('policy' in extra ? extra.policy : policy),
      hub: () => ('hub' in extra ? extra.hub : hub),
      login: extra.login ?? (async () => { if (!who.fresh) return 'step-up'; vaultEvents.logins += 1; return vault(who, statusKey); }),
      now: () => NOW,
      randomIndex: extra.randomIndex ?? (() => { let next = 4000; return () => next++; })(),
    });
  }

  const request = (overrides: Partial<IssueRequest> = {}): IssueRequest => ({
    type: 'ClearanceCredential', subject: alex.did, personName: 'Alex', claims: { scale: 'ca-classified', atLeast: 'Secret' }, until: '2027-02-28', delivery: 'inbox', ...overrides,
  });
  const listBit = (uri: string, index: number, purpose: 'revocation' | 'suspension'): boolean | undefined => {
    const text = hub.lists.get(uri.slice(uri.lastIndexOf('/') + 1));
    if (text === undefined) return undefined;
    const verified = verifyStatusList(JSON.parse(text), decodePublicKeyMultibase(statusKey.multikey));
    assert.ok(verified.ok, 'every list on the hub verifies against the site key');
    return verified.ok ? statusAt(verified.list, index, purpose) : undefined;
  };
  return { world, policy, alex, hub, site, officer, otherOfficer, serviceFor, request, vaultEvents, listBit, statusKey };
}

test('an officer with the matching role issues a Secret clearance to Alex: signed by their person key, an inbox item and a register entry, no body in it', async () => {
  const s = await setup();
  const result = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  if (result.kind !== 'ok') return;
  assert.equal(result.value.delivered, 'inbox');
  assert.equal(result.value.sentence, ISSUER_TEXT.issuedInbox);
  assert.equal(s.officer.signs, 1, 'one signature, with the person key');
  const item = s.site.read(`users/${ALEX_ENTITY}/credentials-inbox/${result.value.hash}`) as { format: string; credential: Record<string, unknown> };
  assert.equal(item.format, INBOX_FORMAT);
  assert.equal(realEngine.credentialHash(item.credential), result.value.hash);
  assert.equal((item.credential.credentialSubject as { id: string }).id, s.alex.did);
  assert.equal(item.credential.issuer, s.officer.person.did);
  const registered = s.site.read(`site/issued/${ALEX_ENTITY}/${result.value.hash}`) as Record<string, unknown>;
  assert.deepEqual(registered, {
    format: ISSUED_FORMAT, type: 'ClearanceCredential', issuer: s.officer.person.did, personName: 'Alex', validUntil: '2027-03-01T00:00:00Z',
    revocation: { list: REVOCATIONS, index: 4000 }, suspension: { list: SUSPENSIONS, index: 4001 },
  });
  assert.ok(!JSON.stringify(registered).includes('proof'), 'never a credential body in the register');
  assert.ok(s.site.read(`site/status-index/revocation-revocation-1/4000`) && s.site.read(`site/status-index/suspension-suspension-1/4001`), 'each place claimed once');
  assert.equal(s.vaultEvents.ended, s.vaultEvents.logins, 'every issuer token is revoked after use');
  assert.ok(!JSON.stringify(result.value).includes('"index"') && !JSON.stringify(result.value).includes('statusListIndex'), 'no status index reaches the browser');
});

test('no fresh step-up: refused with the passkey sentence, and nothing is signed, claimed or delivered', async () => {
  const s = await setup();
  s.officer.fresh = false;
  const result = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  assert.deepEqual(result, refused(ISSUER_TEXT.stepUp, ISSUER_TEXT.confirm));
  assert.equal(s.officer.signs, 0);
  assert.equal(s.site.list('site/status-index/').length, 0);
  assert.equal(s.site.list('site/issued/').length, 0);
});

test('without the role, above the role\'s ceiling, past the role\'s end, or to a did:key: refused before any signature or login', async () => {
  const cases: Array<[Parameters<typeof setup>[0], Partial<IssueRequest>, string]> = [
    [{ noRole: true }, {}, ISSUER_TEXT.noRole],
    [{ roleUpTo: 'Confidential' }, {}, ISSUE_FORM_TEXT.aboveCeiling],
    [{ roleUntil: '2027-01-01T00:00:00Z' }, { until: '2027-03-01' }, ISSUE_FORM_TEXT.pastRole],
    // The form passes, and issuerAuthority itself refuses: your organization's rules no longer accept this kind of signature.
    [{ suites: ['ecdsa-jcs-2019'] }, {}, ISSUER_TEXT.noRole],
    [{}, { subject: newKey().did }, ISSUER_TEXT.notAPerson],
    [{}, { type: 'IssuerRoleCredential', claims: { credentialType: 'ClearanceCredential' } }, ISSUER_TEXT.noRole],
  ];
  for (const [options, overrides, sentence] of cases) {
    const s = await setup(options);
    const result = await s.serviceFor(s.officer).issue(s.request(overrides), PERSON);
    assert.deepEqual(result, refused(sentence), JSON.stringify(overrides));
    assert.equal(s.officer.signs, 0);
    assert.equal(s.vaultEvents.logins, 0, 'no issuer login either');
  }
});

test('an agent or an unattended run cannot issue, revoke or list anything (D-07)', async () => {
  const s = await setup();
  const service = s.serviceFor(s.officer);
  for (const caller of [{ presence: 'none', context: 'interactive' }, { presence: 'person', context: 'unattended' }] as IssuerCaller[]) {
    assert.deepEqual(await service.issue(s.request(), caller), refused(ISSUER_TEXT.personOnly));
    assert.deepEqual(await service.revoke('a'.repeat(64), caller), refused(ISSUER_TEXT.personOnly));
    assert.deepEqual(await service.listRevocationRequests(caller), refused(ISSUER_TEXT.personOnly));
  }
  assert.equal(s.officer.signs + s.vaultEvents.logins, 0);
});

test('a .near-vc file for a single computer, and a person not in the directory needs one', async () => {
  const s = await setup();
  const stranger = await person(['people', 'stranger']);
  const inbox = await s.serviceFor(s.officer).issue(s.request({ subject: stranger.did }), PERSON);
  assert.deepEqual(inbox, refused(ISSUER_TEXT.unknownPerson));
  const file = await s.serviceFor(s.officer).issue(s.request({ subject: stranger.did, delivery: 'file' }), PERSON);
  assert.equal(file.kind, 'ok');
  if (file.kind !== 'ok') return;
  assert.match(file.value.file?.fileName ?? '', /^credential-[0-9a-f]{8}\.near-vc$/);
  assert.equal(realEngine.credentialHash(JSON.parse(file.value.file?.text ?? '{}')), file.value.hash);
});

test('a clash on a status list place is retried once with a new place', async () => {
  const s = await setup();
  s.site.create('site/status-index/revocation-revocation-1/4000', { issuer: 'someone' });
  const result = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') return;
  const registered = s.site.read(`site/issued/${ALEX_ENTITY}/${result.value.hash}`) as { revocation: { index: number }; suspension: { index: number } };
  assert.equal(registered.revocation.index, 4001);
  assert.equal(registered.suspension.index, 4002);
});

test('revoke sets the bit in a new version signed by the status-list key; a 409 re-reads once; there is no way back', async () => {
  const s = await setup();
  const issued = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  assert.equal(issued.kind, 'ok');
  if (issued.kind !== 'ok') return;
  s.hub.clashOnce(JSON.stringify((await signedList(s.statusKey, REVOCATIONS, 'revocation', [17], { version: 1, validFrom: '2026-11-24T11:00:00Z', validUntil: '2026-12-01T11:00:00Z' })).credential));
  const revoked = await s.serviceFor(s.officer).revoke(issued.value.hash, PERSON);
  assert.equal(revoked.kind, 'ok', JSON.stringify(revoked));
  if (revoked.kind === 'ok') assert.equal(revoked.value.state, 'revoked');
  assert.equal(s.listBit(REVOCATIONS, 4000, 'revocation'), true);
  assert.equal(s.listBit(REVOCATIONS, 17, 'revocation'), true, 'the other officer\'s revocation is kept');
  assert.equal(s.hub.puts, 2, 'one clash, one re-read and a second put');
  const listed = await s.serviceFor(s.officer).listIssued(PERSON);
  assert.deepEqual(listed.kind === 'ok' && listed.value.map((view) => [view.personName, view.state]), [['Alex', 'revoked']]);
  // Neither clearing a suspension nor anything else undoes a revocation.
  assert.deepEqual(await s.serviceFor(s.officer).clearSuspension(issued.value.hash, PERSON), refused(ISSUER_TEXT.revocationFinal));
  assert.equal(s.listBit(REVOCATIONS, 4000, 'revocation'), true);
});

test('suspend, and clearing it: only an issuer of that type, after a step-up', async () => {
  const s = await setup();
  const issued = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  if (issued.kind !== 'ok') return assert.fail('not issued');
  assert.equal((await s.serviceFor(s.officer).suspend(issued.value.hash, PERSON)).kind, 'ok');
  assert.equal(s.listBit(SUSPENSIONS, 4001, 'suspension'), true);
  // An officer whose role is for nationality, not clearance, cannot lift it.
  const nationality = { ...s.otherOfficer, own: new Store() };
  nationality.own.create(ownRecordPath(nationality.entity), s.otherOfficer.own.read(ownRecordPath(nationality.entity)) as Record<string, unknown>);
  const role = await signedRole(s.world.root, nationality.person, 'NationalityCredential');
  nationality.own.create(`${walletFolder(nationality.entity)}/${role.hash}`, { format: WALLET_ITEM_FORMAT, credential: role.credential });
  assert.deepEqual(await s.serviceFor(nationality).clearSuspension(issued.value.hash, PERSON), refused(ISSUER_TEXT.noRole));
  s.officer.fresh = false;
  assert.deepEqual(await s.serviceFor(s.officer).clearSuspension(issued.value.hash, PERSON), refused(ISSUER_TEXT.stepUp, ISSUER_TEXT.confirm));
  s.officer.fresh = true;
  // Another clearance officer may lift it: the issuer of that type, not only the one who issued.
  assert.equal((await s.serviceFor(s.otherOfficer).clearSuspension(issued.value.hash, PERSON)).kind, 'ok');
  assert.equal(s.listBit(SUSPENSIONS, 4001, 'suspension'), false);
  assert.deepEqual(await s.serviceFor(s.officer).clearSuspension(issued.value.hash, PERSON), refused(ISSUER_TEXT.notSuspended));
});

test('a revocation request shows each officer only what they issued to that person; a newer format is left alone', async () => {
  const s = await setup();
  const mine = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  const theirs = await s.serviceFor(s.otherOfficer).issue(s.request({ claims: { scale: 'ca-classified', atLeast: 'Confidential' } }), PERSON);
  assert.ok(mine.kind === 'ok' && theirs.kind === 'ok');
  // Shaped as 47-31 writes it (a person disabled in Keycloak), and one from a newer job version.
  s.site.create('site/revocation-requests/keycloak-kc-alex-disabled', { format: REVOCATION_FORMAT, entity: 'keycloak-kc-alex', keycloakId: 'kc-alex', reason: 'disabled', seenAt: '2026-11-24T09:00:00Z', job: 'users.mjs sync' });
  s.site.create('site/revocation-requests/keycloak-kc-zed-removed', { format: 'sterling-revocation-request/2', entity: 'keycloak-kc-zed' });
  const listed = await s.serviceFor(s.officer).listRevocationRequests(PERSON);
  assert.equal(listed.kind, 'ok');
  if (listed.kind !== 'ok' || mine.kind !== 'ok') return;
  const current = listed.value.find((view) => view.id === 'keycloak-kc-alex-disabled');
  assert.ok(current?.current);
  if (!current?.current) return;
  assert.equal(current.personName, 'Alex');
  assert.equal(current.reasonText, 'disabled in sign-in');
  assert.equal(current.seenAt, '2026-11-24T09:00:00Z');
  assert.deepEqual(current.credentials.map((view) => view.hash), [mine.value.hash], 'only this officer\'s');
  assert.deepEqual(listed.value.find((view) => view.id === 'keycloak-kc-zed-removed'), { id: 'keycloak-kc-zed-removed', current: false, message: ISSUER_TEXT.newerRequest });
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest('keycloak-kc-zed-removed', PERSON), refused(ISSUER_TEXT.newerRequest));
  assert.ok(s.site.read('site/revocation-requests/keycloak-kc-zed-removed'), 'never removed');
  assert.ok(!JSON.stringify(listed.value).includes(ALEX_ENTITY), 'no entity id reaches the browser');
});

test('a request is removed only once every credential issued to that person, by any officer, is revoked or suspended; a guest-ended one alike', async () => {
  const s = await setup();
  const mine = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  const theirs = await s.serviceFor(s.otherOfficer).issue(s.request({ claims: { scale: 'ca-classified', atLeast: 'Confidential' } }), PERSON);
  if (mine.kind !== 'ok' || theirs.kind !== 'ok') return assert.fail('not issued');
  // Shaped as 47-19's fileRevocationRequest files an early guest end.
  const id = 'guest-kc-alex-guest-ended';
  s.site.create(`site/revocation-requests/${id}`, { format: REVOCATION_FORMAT, entity: 'guest-kc-alex', keycloakId: 'kc-alex', reason: 'guest-ended', seenAt: '2026-11-24T10:00:00Z', job: 'guests.mjs end' });
  assert.equal((await s.serviceFor(s.officer).revoke(mine.value.hash, PERSON)).kind, 'ok');
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), ok({ removed: false, remaining: 1 }));
  assert.ok(s.site.read(`site/revocation-requests/${id}`), 'stays while one is unrevoked');
  assert.equal((await s.serviceFor(s.otherOfficer).suspend(theirs.value.hash, PERSON)).kind, 'ok');
  assert.deepEqual(await s.serviceFor(s.otherOfficer).resolveRequest(id, PERSON), ok({ removed: true, remaining: 0 }));
  assert.equal(s.site.read(`site/revocation-requests/${id}`), undefined);
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), refused(ISSUER_TEXT.noRequest));
});

test('without your organization\'s rules or server in this session nothing is issued, and the sentence says which', async () => {
  const s = await setup();
  assert.deepEqual(await s.serviceFor(s.officer, { policy: undefined }).issue(s.request(), PERSON), refused(ISSUER_TEXT.noRules));
  assert.deepEqual(await s.serviceFor(s.officer, { hub: undefined }).issue(s.request(), PERSON), refused(ISSUER_TEXT.noServer));
  assert.deepEqual(await s.serviceFor(s.officer, { login: async () => 'not-officer' }).issue(s.request(), PERSON), refused(ISSUER_TEXT.notOfficer));
  assert.equal(s.officer.signs, 0);
});

/** The subject's own KV, with list and remove, for the inbox pickup. */
function personKv(store: Store): IdentityKv {
  return {
    async read(path) { return store.read(path); },
    async create(path, value) { return store.create(path, value); },
    async write(path, value) { store.data.set(path, structuredClone(value)); },
    async list(folder) { return store.list(folder); },
    async remove(path) { store.data.delete(path); },
  };
}

test('at Alex\'s next session the item verifies, moves into the wallet and leaves the inbox; a tampered one stays out and is reported', async () => {
  const s = await setup();
  const issued = await s.serviceFor(s.officer).issue(s.request(), PERSON);
  const second = await s.serviceFor(s.officer).issue(s.request({ claims: { scale: 'ca-classified', atLeast: 'Confidential' } }), PERSON);
  if (issued.kind !== 'ok' || second.kind !== 'ok') return assert.fail('not issued');
  // Alex's own view of KV: the person's own prefix, which holds the inbox the officer wrote.
  const own = new Store();
  own.create(ownRecordPath(ALEX_ENTITY), { format: 'sterling-person-did/1', did: s.alex.did, path: 'people/alex-subject', log: s.alex.log, published: true });
  for (const hash of [issued.value.hash, second.value.hash]) own.create(`users/${ALEX_ENTITY}/credentials-inbox/${hash}`, s.site.read(`users/${ALEX_ENTITY}/credentials-inbox/${hash}`) as Record<string, unknown>);
  const tampered = own.read(`users/${ALEX_ENTITY}/credentials-inbox/${second.value.hash}`) as { credential: { credentialSubject: Record<string, unknown> } };
  tampered.credential.credentialSubject.atLeast = 'Top Secret';
  const identity = createIdentityService({
    keys: { sign: async () => refused('unused'), personPublicKey: async () => refused('unused') }, kv: personKv(own), entityId: () => ALEX_ENTITY,
    engine: () => undefined, domain: 'hq.example.org', now: () => NOW,
  });
  const result = await identity.collectInbox(inboxVerifier({ engine: () => engine, policy: () => s.policy, hub: () => s.hub, now: () => NOW }));
  assert.deepEqual({ arrived: result.arrived, refused: result.refused, waiting: result.waiting }, { arrived: 1, refused: 1, waiting: 0 });
  assert.deepEqual(result.sentences, [
    'Your wallet received a credential: clearance.',
    'A credential sent to you did not check, so it was not added to your wallet. Tell your organization\'s security officer.',
  ]);
  assert.equal((own.read(`${walletFolder(ALEX_ENTITY)}/${issued.value.hash}`) as { format: string }).format, WALLET_ITEM_FORMAT);
  assert.equal(own.read(`users/${ALEX_ENTITY}/credentials-inbox/${issued.value.hash}`), undefined, 'removed from the inbox');
  assert.equal(own.read(`${walletFolder(ALEX_ENTITY)}/${second.value.hash}`), undefined, 'the tampered one is not in the wallet');
  assert.ok(own.read(`users/${ALEX_ENTITY}/credentials-inbox/${second.value.hash}`), 'and stays in the inbox');
  // Without the rules or the server in this session, items wait and the person is told so.
  const later = await identity.collectInbox(inboxVerifier({ engine: () => engine, policy: () => undefined, hub: () => s.hub, now: () => NOW }));
  assert.deepEqual(later.sentences, ['Credentials sent to you cannot be checked in this session yet, so they wait until they can.']);
});

test('the card\'s form and review: the types the officer may issue, and the review sentence before any step-up or signature', async () => {
  const s = await setup();
  const types = await s.serviceFor(s.officer).issuableTypes();
  assert.equal(types.kind, 'ok');
  if (types.kind !== 'ok') return;
  assert.deepEqual(types.value.map((entry) => [entry.type, entry.ceiling]), [['ClearanceCredential', 'Secret on the Canadian classified scale']]);
  assert.deepEqual(await s.serviceFor(s.officer).review(s.request(), PERSON),
    ok({ sentence: 'You are about to issue: Secret clearance on the Canadian classified scale to Alex, until 28 February 2027.' }));
  assert.deepEqual(await s.serviceFor(s.officer).review(s.request({ claims: { scale: 'ca-classified', atLeast: 'Top Secret' } }), PERSON), refused(ISSUE_FORM_TEXT.aboveCeiling));
  assert.equal(s.officer.signs + s.vaultEvents.logins, 0, 'reviewing signs nothing');
});

test('D-25: a reported lost computer reaches the officers; revoking it sets its device bit, and resolving frees the person\'s slot', async () => {
  const s = await setup();
  const slot = { format: 'sterling-device-slot/1', device: `dev-${'c'.repeat(32)}`, revocation: { list: REVOCATIONS, index: 120_000 }, suspension: { list: SUSPENSIONS, index: 120_001 }, claimedAt: '2026-11-25T08:00:00Z' };
  s.site.create(`site/device-slots/${ALEX_ENTITY}/slot-2`, slot);
  s.site.create(`site/device-slots/${ALEX_ENTITY}/slot-3`, { ...slot, device: `dev-${'d'.repeat(32)}`, revocation: { list: REVOCATIONS, index: 120_002 } });
  const id = 'keycloak-kc-alex-computer-lost-2';
  s.site.create(`site/revocation-requests/${id}`, { format: REVOCATION_FORMAT, entity: 'keycloak-kc-alex', keycloakId: 'kc-alex', reason: 'computer-lost', slot: 2, device: slot.device, seenAt: '2026-11-25T08:30:00Z', job: 'workbench: a lost computer' });
  const listed = await s.serviceFor(s.officer).listRevocationRequests(PERSON);
  const view = listed.kind === 'ok' ? listed.value.find((entry) => entry.id === id) : undefined;
  assert.ok(view?.current);
  if (!view?.current) return;
  assert.equal(view.reasonText, 'reported a lost computer');
  assert.deepEqual(view.computers.map((computer) => [computer.slot, computer.device, computer.state]), [[2, slot.device, 'active']], 'only the computer reported lost');
  assert.deepEqual(view.credentials, [], 'a lost computer is not about the person\'s credentials');
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), ok({ removed: false, remaining: 1 }));
  assert.deepEqual(await s.serviceFor(s.officer).revokeComputer(id, 3, PERSON), refused(ISSUER_TEXT.noComputer), 'only the slot the request names');
  const revoked = await s.serviceFor(s.officer).revokeComputer(id, 2, PERSON);
  assert.equal(revoked.kind === 'ok' && revoked.value.state, 'revoked');
  assert.equal(s.listBit(REVOCATIONS, 120_000, 'revocation'), true);
  assert.equal(s.listBit(REVOCATIONS, 120_002, 'revocation'), false, 'the person\'s other computer still works');
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), ok({ removed: true, remaining: 0 }));
  assert.equal(s.site.read(`site/device-slots/${ALEX_ENTITY}/slot-2`), undefined, 'the slot is free for another computer');
  assert.ok(s.site.read(`site/device-slots/${ALEX_ENTITY}/slot-3`));
  assert.equal(s.site.read(`site/revocation-requests/${id}`), undefined);
});

test('D-25: when a person\'s access ends their computers are listed and must be revoked too; officers\' places stay below the device quarter', async () => {
  const s = await setup();
  s.site.create(`site/device-slots/${ALEX_ENTITY}/slot-1`, { format: 'sterling-device-slot/1', device: `dev-${'e'.repeat(32)}`, revocation: { list: REVOCATIONS, index: 130_000 }, suspension: { list: SUSPENSIONS, index: 130_001 }, claimedAt: '2026-11-25T08:00:00Z' });
  const id = 'keycloak-kc-alex-disabled';
  s.site.create(`site/revocation-requests/${id}`, { format: REVOCATION_FORMAT, entity: 'keycloak-kc-alex', keycloakId: 'kc-alex', reason: 'disabled', seenAt: '2026-11-25T08:30:00Z', job: 'users.mjs sync' });
  const listed = await s.serviceFor(s.officer).listRevocationRequests(PERSON);
  const view = listed.kind === 'ok' ? listed.value.find((entry) => entry.id === id) : undefined;
  assert.deepEqual(view?.current && view.computers.map((computer) => computer.slot), [1]);
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), ok({ removed: false, remaining: 1 }));
  assert.equal((await s.serviceFor(s.officer).revokeComputer(id, 1, PERSON)).kind, 'ok');
  assert.deepEqual(await s.serviceFor(s.officer).resolveRequest(id, PERSON), ok({ removed: true, remaining: 0 }));
  assert.ok(s.site.read(`site/device-slots/${ALEX_ENTITY}/slot-1`), 'an ended person\'s slots are kept as the record');
  // An officer's credential never draws from the device quarter.
  const sizes: number[] = [];
  const service = s.serviceFor(s.officer, { randomIndex: (size) => { sizes.push(size); return size - sizes.length; } });
  assert.equal((await service.issue(s.request(), PERSON)).kind, 'ok');
  assert.deepEqual(sizes, [DEVICE_INDEX_FROM, DEVICE_INDEX_FROM]);
});
