import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_ROUTING, ROUTE_REFUSALS, decideRoute } from '../domain/gate/routing';
import type { RouteFacts, RoutePolicy } from '../domain/gate/routing';
import { GateHost } from '../gate/host';
import { createProjectLayerSource } from '../services/setup/projectStore';
import { SHIPPED_DEFAULT_LABEL } from '../domain/gate/bundle';
import { composeLayers, parseProjectLayer } from '../domain/gate/layers';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { RESIDENCY_REGIONS, type ResidencyRegion } from '../domain/gate/sections';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { PolicyLayersView } from '../gate/organizationStore';
import { routePolicyFor } from '../gate/sessionMark';
import { FIXED_NOW, authorizationFor, deviceKey, issuerKey, policyDocumentFor, signAuthorization } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';

const NEAR: RouteFacts = {
  clientRoute: 'near', host: 'https://cloud-api.near.ai/v1', nearEndpoint: true,
  model: { id: 'example/private', privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW
};
const LOCAL: RouteFacts = {
  ...NEAR, clientRoute: 'local', host: 'http://127.0.0.1:11434', nearEndpoint: false,
  model: { id: 'example/local', privacyBoundary: 'local' }
};
const route = (facts: RouteFacts, policy: RoutePolicy | undefined) => decideRoute([], DEFAULT_ROUTING, facts, SHIPPED_DEFAULT_LABEL, undefined, policy);

async function fixture(text: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-project-route-'));
  const file = path.join(root, '.planning/.near-ai/project.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const host = new GateHost({
    globalStorageDir: path.join(root, 'install'), secrets: new MemorySecrets(), projectRoot: root,
    now: () => new Date(FIXED_NOW), productVersion: '0.4.40'
  });
  await host.start();
  const runtime = await host.runtimeFor({ root, actor: { kind: 'agent', sessionId: 'example' }, presence: 'person', context: 'interactive' });
  return { host, root, runtime, file };
}

const canada = JSON.stringify({ projectLayer: { v: 1, residency: { required: ['CA'] } } });

function installSource(host: GateHost): void {
  host.useProjectLayerSource(createProjectLayerSource({ readFileSync, statSync, scales: () => SCALE_PRESETS, now: () => FIXED_NOW }).read);
}

test('owner D14, D-34: the project Canada rule reaches the route decision', async () => {
  const { host, runtime } = await fixture(canada);
  installSource(host);
  const policy = runtime.routePolicy?.(FIXED_NOW);
  const denied = route(NEAR, policy);
  assert.equal(denied.rule, 'route.residency');
  assert.equal(denied.reason, ROUTE_REFUSALS['route.residency']);
  assert.deepEqual(policy?.residency?.required, ['CA']);
  assert.equal(route(LOCAL, policy).allowed, true);
});

test('a project file without the layer key leaves the route policy unchanged', async () => {
  const { host, runtime } = await fixture('{}');
  const before = runtime.routePolicy?.(FIXED_NOW);
  assert.ok(before);
  installSource(host);
  assert.equal(JSON.stringify(runtime.routePolicy?.(FIXED_NOW)), JSON.stringify(before));
});

test('one Gate host keeps restrictions scoped to the runtime project', async () => {
  const restricted = await fixture(canada);
  const unrestricted = await fixture('{}');
  const { host } = restricted;
  const source = createProjectLayerSource({ readFileSync, statSync, scales: () => host.labelPolicy().scales, now: () => FIXED_NOW });
  const registration = host.useProjectLayerSource(source.read);
  const otherRuntime = await host.runtimeFor({
    root: unrestricted.root, actor: { kind: 'agent', sessionId: 'other-project' }, presence: 'person', context: 'interactive'
  });

  assert.equal(route(NEAR, restricted.runtime.routePolicy?.(FIXED_NOW)).rule, 'route.residency');
  assert.equal(route(NEAR, otherRuntime.routePolicy?.(FIXED_NOW)).allowed, true);
  assert.equal(route(NEAR, restricted.runtime.routePolicy?.(FIXED_NOW)).rule, 'route.residency');
  registration.dispose();
  assert.equal(route(NEAR, restricted.runtime.routePolicy?.(FIXED_NOW)).allowed, true);
});

test('sessionless routes also use the open project rule', async () => {
  const { host } = await fixture(canada);
  const session = host.sessionRouteWithoutContext();
  installSource(host);
  assert.equal(route({ ...NEAR, sessionless: true }, session.routePolicy?.(FIXED_NOW)).rule, 'route.residency');
});

for (const [name, text] of [
  ['empty region list', '{"projectLayer":{"v":1,"residency":{"required":[]}}}'],
  ['unknown layer version', '{"projectLayer":{"v":2}}'],
  ['unknown region', '{"projectLayer":{"v":1,"residency":{"required":["XX"]}}}'],
  ['invalid JSON with the layer key', '{"projectLayer":']
]) {
  test(`D-34: ${name} keeps the route on this computer`, async () => {
    const { host, runtime } = await fixture(text);
    installSource(host);
    const policy = runtime.routePolicy?.(FIXED_NOW);
    assert.deepEqual(policy?.residency?.required, []);
    assert.equal(route(NEAR, policy).rule, 'route.residency');
    assert.equal(route(LOCAL, policy).allowed, true);
  });
}

test('legacy text without a project-layer key keeps the previous route policy', async () => {
  const { host, runtime } = await fixture('{broken unrelated settings');
  const before = runtime.routePolicy?.(FIXED_NOW);
  installSource(host);
  assert.deepEqual(runtime.routePolicy?.(FIXED_NOW), before);
});

test('project residency uses the region parser and accepts only the required key', () => {
  for (const [residency, reason] of [
    [{ required: ['US', 'CA'] }, 'not-sorted'],
    [{ required: ['CA', 'CA'] }, 'duplicate'],
    [{ required: ['CA'], byLevel: {} }, 'unknown-field']
  ] as const) {
    const result = parseProjectLayer({ v: 1, residency }, SCALE_PRESETS);
    assert.equal(result.ok ? 'accepted' : result.reason, reason);
  }
  assert.deepEqual(parseProjectLayer({ v: 1, residency: { required: ['CA'] } }, SCALE_PRESETS), {
    ok: true, value: { v: 1, residency: { required: ['CA'] } }
  });
});

test('a throwing source fails closed, and disposing a replaced source preserves its replacement', async () => {
  const { host, runtime } = await fixture('{}');
  const original = host.useProjectLayerSource(() => ({ state: 'none' }));
  const replacement = host.useProjectLayerSource(() => { throw new Error('unreadable source'); });
  original.dispose();
  assert.equal(route(NEAR, runtime.routePolicy?.(FIXED_NOW)).rule, 'route.residency');
  assert.equal(route(LOCAL, runtime.routePolicy?.(FIXED_NOW)).allowed, true);
  replacement.dispose();
  assert.equal(route(NEAR, runtime.routePolicy?.(FIXED_NOW)).allowed, true);
});

test('the source caches each root briefly and rechecks changed project files', async () => {
  const first = await fixture(canada);
  const second = await fixture('{}');
  let now = 0;
  let reads = 0;
  const source = createProjectLayerSource({
    readFileSync: (file, encoding) => { reads += 1; return readFileSync(file, encoding); },
    statSync, scales: () => SCALE_PRESETS, now: () => now
  });
  assert.equal(source.read(first.root).state, 'valid');
  assert.equal(source.read(second.root).state, 'none');
  await writeFile(first.file, '{}');
  assert.equal(source.read(first.root).state, 'valid');
  assert.equal(reads, 2);
  now += 1_000;
  assert.equal(source.read(first.root).state, 'none');
  assert.equal(source.read(second.root).state, 'none');
  assert.equal(reads, 3);
});

const places = RESIDENCY_REGIONS.map((region) => ({
  id: `vendor-${region.toLowerCase()}`, host: `${region.toLowerCase()}.example.org`, region,
  class: 'vendor-region' as const, scheme: 'https' as const, tlsPins: [], maxLabel: ['org/Public']
}));

function vendorRoute(host: string, policy: RoutePolicy | undefined) {
  return route({ ...NEAR, clientRoute: 'local', nearEndpoint: false, host: `https://${host}` }, policy);
}

function layersFor(personal: PolicyDocument, organization?: PolicyDocument): PolicyLayersView {
  const { effective, ignored } = composeLayers({ personal, organization });
  return {
    effective: { ...effective, endpoints: places }, ignored, migration: [],
    personal: { document: personal, hash: '', stored: undefined },
    organization: organization === undefined ? { state: 'none' } : {
      state: 'valid', document: organization, hash: '', issuerPublicKey: organization.issuer.publicKey,
      fingerprintHex: organization.issuer.fingerprint, contacts: [], issuedAt: organization.issuedAt,
      expiresAt: organization.expiresAt, endsSoon: false
    }
  };
}

test('invariant: a project route stays inside every applicable region list', () => {
  const personal = policyDocumentFor({ key: deviceKey() });
  const organization = policyDocumentFor({ key: issuerKey(), layer: 'organization' });
  const lists = Array.from({ length: 8 }, (_, mask) => RESIDENCY_REGIONS.filter((_, index) => (mask & (1 << index)) !== 0));
  const withRegions = (document: PolicyDocument, required: readonly ResidencyRegion[]): PolicyDocument => required.length === 0 ? document : {
    ...document, requires: [...document.requires, 'residency@1' as const].sort(), residency: { v: 1, required }
  };
  for (const hasOrg of [false, true]) {
    for (const orgList of lists) for (const ownList of lists) {
      const layers = layersFor(withRegions(personal, ownList), hasOrg ? withRegions(organization, orgList) : undefined);
      for (const projectList of lists.slice(1)) {
        const context = JSON.stringify({ hasOrg, orgList, ownList, projectList });
        const policy = routePolicyFor(layers, FIXED_NOW, personal.issuer.fingerprint, 'bundle-2',
          { state: 'valid', layer: { v: 1, residency: { required: projectList } } });
        const allowed = places.filter(({ host }) => vendorRoute(host, policy).allowed).map(({ region }) => region);
        const expected = projectList.filter((region) => (!hasOrg || orgList.length === 0 || orgList.includes(region))
          && (ownList.length === 0 || ownList.includes(region)));
        assert.deepEqual(allowed, expected, context);
        assert.equal(route(LOCAL, policy).allowed, true, context);
      }
    }
  }
});

test('a residency exception cannot send content outside the project rule', () => {
  const signer = deviceKey();
  const personal = policyDocumentFor({ key: signer });
  const us = places.find(({ region }) => region === 'US')!;
  const layers = layersFor({
    ...personal, residency: { v: 1, required: ['CA'] }, authorizations: [
      signAuthorization(authorizationFor({ kind: 'residency-exception', id: 'project-test-exception', subject: { endpoint: us.id } }), signer)
    ]
  });
  const unrestricted = routePolicyFor(layers, FIXED_NOW, signer.fingerprint, 'bundle-2');
  assert.equal(vendorRoute(us.host, unrestricted).allowed, true);
  for (const project of [{ state: 'valid', layer: { v: 1, residency: { required: ['CA'] } } }, { state: 'unreadable' }] as const) {
    assert.equal(vendorRoute(us.host, routePolicyFor(layers, FIXED_NOW, signer.fingerprint, 'bundle-2', project)).rule, 'route.residency');
  }
});
