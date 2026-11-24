// The gate's clearance from credentials (Phase 71 plan 08 Task 2; D-08, D-19, VCRD-07): under your organization's policy with credentials@1 the
// clearances come only from the fresh verified wallet; otherwise the declared ones apply on this computer, as today. Fictional Example Organization.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { Clearance } from '../domain/gate/labels';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { CACHE_STATE_TEXT } from '../domain/credentials/cacheState';
import { factsFrom } from '../domain/credentials/mayRelease';
import { DECLARED_NOT_VERIFIED_TEXT, clearancesInForce } from '../gate/clearances';
import { GateHost } from '../gate/host';
import type { PolicyLayersView } from '../gate/organizationStore';
import { routePolicyFor } from '../gate/sessionMark';
import type { WalletView } from '../gate/wallet';
import { enrolmentTextFor, organizationSections } from './helpers/enrolmentFixtures';
import { FIXED_NOW, deviceKey, issuerKey, policyDocumentFor } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';

const SECRET: Clearance = Object.freeze({ scale: 'ca-classified', level: 'Secret', compartments: [], releasability: ['CAN'] });
const DECLARED_TOP_SECRET: Clearance = Object.freeze({ scale: 'ca-classified', level: 'Top Secret', compartments: [], releasability: [] });

function credentialsSection(): Record<string, unknown> {
  const scid = 'QmUy89VrfryQ254CeHZzQfmcKqByPoKNGqYykP3SeXuegQ';
  return {
    v: 1, root: { did: `did:webvh:${scid}:hq.example.org:org`, scid }, issuance: { ClearanceCredential: { role: 'IssuerRoleCredential' } }, suites: ['eddsa-jcs-2022'],
    didMethods: ['did:webvh'], statusLists: [], statusTtl: 900, maxOfflineAge: {}, requiredBySensitivity: {}
  };
}

function documents(withCredentials: boolean): { organization: PolicyDocument; effective: PolicyDocument } {
  const organization = { ...policyDocumentFor({ key: issuerKey(), layer: 'organization' }), ...(withCredentials ? { credentials: credentialsSection() } : {}) } as unknown as PolicyDocument;
  const personal = policyDocumentFor({ key: deviceKey() });
  const effective = { ...personal, ...(withCredentials ? { credentials: credentialsSection() } : {}), people: { v: 1, clearances: [DECLARED_TOP_SECRET] } } as unknown as PolicyDocument;
  return { organization, effective };
}

function view(state: 'fresh' | 'stale' | 'unavailable', clearances: readonly Clearance[] = [SECRET]): WalletView {
  const refreshedAt = state === 'stale' ? FIXED_NOW - 60 * 60 * 1000 : FIXED_NOW;
  return { cache: { state: state === 'unavailable' ? 'unavailable' : 'fresh', refreshedAt, ttlMs: 900_000 }, entries: [], facts: factsFrom([]), clearances };
}

test('under your organization\'s credentials@1 and a fresh wallet holding Secret, the clearances are the wallet\'s; the declared Top Secret is ignored', () => {
  const { organization, effective } = documents(true);
  const found = clearancesInForce(effective, organization, { state: 'fresh', clearances: [SECRET] });
  assert.deepEqual(found.clearances, [SECRET]);
  assert.equal(found.source, 'credentials');
});

test('a stale, unavailable or missing wallet gives no clearance under credentials@1, with the wallet state\'s sentence', () => {
  const { organization, effective } = documents(true);
  for (const state of ['stale', 'unavailable'] as const) {
    const found = clearancesInForce(effective, organization, { state, clearances: [SECRET] });
    assert.deepEqual(found.clearances, [], state);
    assert.equal(found.sentence, CACHE_STATE_TEXT[state].text);
  }
  assert.deepEqual(clearancesInForce(effective, organization, undefined).clearances, []);
});

test('with no organization, or one without credentials@1, the declared clearances apply as today, shown as declared, not verified', () => {
  const { organization, effective } = documents(false);
  for (const org of [undefined, organization]) {
    const found = clearancesInForce(effective, org, { state: 'fresh', clearances: [SECRET] });
    assert.deepEqual(found.clearances, [DECLARED_TOP_SECRET]);
    assert.equal(found.source, 'declared');
    assert.equal(found.sentence, DECLARED_NOT_VERIFIED_TEXT);
  }
});

function layers(organization: PolicyDocument, effective: PolicyDocument): PolicyLayersView {
  return {
    organization: { state: 'valid', document: organization, hash: 'a'.repeat(64), issuerPublicKey: organization.issuer.publicKey, fingerprintHex: '0'.repeat(64), contacts: [], issuedAt: organization.issuedAt, expiresAt: organization.expiresAt, endsSoon: false },
    personal: { document: policyDocumentFor({ key: deviceKey() }), hash: 'b'.repeat(64), stored: { bundleVersion: 2 } },
    effective, ignored: [], migration: []
  };
}

test('routePolicyFor takes the same clearances: the wallet\'s when fresh under credentials@1, none when stale, the declared ones otherwise', () => {
  const withCredentials = documents(true);
  const fresh = routePolicyFor(layers(withCredentials.organization, withCredentials.effective), FIXED_NOW, 'dev-device', 'bundle-2', { state: 'fresh', clearances: [SECRET] });
  assert.deepEqual(fresh?.clearances, [SECRET]);
  const stale = routePolicyFor(layers(withCredentials.organization, withCredentials.effective), FIXED_NOW, 'dev-device', 'bundle-2', { state: 'stale', clearances: [SECRET] });
  assert.deepEqual(stale?.clearances, []);
  const without = documents(false);
  assert.deepEqual(routePolicyFor(layers(without.organization, without.effective), FIXED_NOW, 'dev-device', 'bundle-2')?.clearances, [DECLARED_TOP_SECRET]);
});

async function withHost(work: (host: GateHost, wallet: { current: WalletView }) => Promise<void>, sections?: Record<string, unknown>): Promise<void> {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-credential-clearance-'));
  const wallet = { current: view('fresh') };
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.0.0-test', now: () => new Date(FIXED_NOW), wallet: { verifiedView: () => wallet.current } });
  try {
    await host.start();
    if (sections !== undefined) {
      const state = await host.acceptOrganizationFile(enrolmentTextFor(issuerKey(), { sections }), { wordsConfirmed: true });
      assert.equal(state.state, 'valid', state.state === 'failed-closed' ? state.sentence : '');
    }
    await work(host, wallet);
  } finally {
    await host.flush().catch(() => undefined);
    await rm(storage, { recursive: true, force: true });
  }
}

test('the host\'s labelPolicy follows the wallet under your organization\'s credentials@1: Secret while fresh, nothing once stale', async () => {
  await withHost(async (host, wallet) => {
    assert.deepEqual(host.labelPolicy().clearances, [SECRET]);
    assert.equal(host.clearancesNow().source, 'credentials');
    wallet.current = view('stale');
    assert.deepEqual(host.labelPolicy().clearances, []);
    assert.equal(host.clearancesNow().sentence, CACHE_STATE_TEXT.stale.text);
  }, organizationSections({ credentials: credentialsSection() }));
});

test('without your organization the host keeps the personal layer\'s declared clearances, whatever the wallet holds', async () => {
  await withHost(async (host) => {
    const declared = host.bundleState();
    assert.equal(declared.state, 'valid');
    if (declared.state === 'valid') assert.deepEqual(host.labelPolicy().clearances, declared.bundle.clearances);
    assert.equal(host.clearancesNow().source, 'declared');
    assert.equal(host.clearancesNow().sentence, DECLARED_NOT_VERIFIED_TEXT);
  });
});
