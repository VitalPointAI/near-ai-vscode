// One list of where AI may run (FND-03, Phase 41 D-24 to D-28, D-52): the endpoint schema and its refusals, the ceiling, the lookup, which levels need an
// authorization, and the localHosts migration at today's effect. Fictional hosts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBundlePayload, parseBundle } from '../domain/gate/bundle';
import {
  ENDPOINT_CLASSES, MAX_ENDPOINTS, PATTERN_HOST_CEILING, THIRD_PARTY_REFUSED_LEVELS, endpointCeilingAllows, endpointHostOf, findEndpoint, migrateLocalHosts,
  needsEndpointAuthorization, parseEndpoints
} from '../domain/gate/endpoints';
import type { PolicyEndpoint } from '../domain/gate/endpoints';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { bundleViewOf, documentFromBundle, parsePolicyDocument } from '../domain/gate/policyDocument';
import { DEFAULT_ROUTING, THIS_COMPUTER_ONLY_LEVELS } from '../domain/gate/routing';
import type { RoutingTable } from '../domain/gate/routing';
import { FIXED_NOW, deviceKey, fixtureEndpoints } from './helpers/policyFixtures';

type Loose = any; // an entry under edit

const scales = SCALE_PRESETS;

function entry(overrides: Record<string, unknown> = {}): Loose {
  return { id: 'models-example-org', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Confidential'], ...overrides };
}

function reasonOf(list: unknown): string {
  const parsed = parseEndpoints(list, scales);
  return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
}

function one(overrides: Record<string, unknown>): string {
  return reasonOf([entry(overrides)]);
}

function routingWith(localHosts: string[]): RoutingTable {
  return { ...DEFAULT_ROUTING, localHosts };
}

test('D-24: one valid entry of every class parses, sorted by id, and the parsed list is frozen and equal to its input', () => {
  const list = fixtureEndpoints();
  const classes = new Set(list.map((item) => item['class']));
  assert.deepEqual([...classes].sort(), [...ENDPOINT_CLASSES].sort());
  const parsed = parseEndpoints(list, scales);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, list);
  assert.ok(Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value[0]) && Object.isFrozen(parsed.value[0]?.maxLabel));
  assert.equal(reasonOf([]), 'ok');
});

test('D-24: the list is sorted by id with unique ids and hosts, and holds at most 128 entries', () => {
  const a = entry({ id: 'a-server', host: 'a.example.org' });
  const b = entry({ id: 'b-server', host: 'b.example.org' });
  assert.equal(reasonOf([a, b]), 'ok');
  assert.equal(reasonOf([b, a]), 'not-sorted endpoints[1]');
  assert.equal(reasonOf([a, { ...b, id: 'a-server' }]), 'duplicate endpoints[1].id');
  assert.equal(reasonOf([a, { ...b, host: 'a.example.org' }]), 'duplicate endpoints[1].host');
  const many = (count: number): Loose[] => Array.from({ length: count }, (_, index) => entry({ id: `s${String(index).padStart(3, '0')}`, host: `s${String(index)}.example.org` }));
  assert.equal(MAX_ENDPOINTS, 128);
  assert.equal(reasonOf(many(128)), 'ok');
  assert.equal(reasonOf(many(129)), 'not-allowed-here endpoints');
  assert.equal(reasonOf('not a list'), 'wrong-type endpoints');
});

test('D-24: keys are exact, the id is a token, and class, scheme and region come from their closed lists', () => {
  assert.equal(one({ extra: 1 }), 'unknown-field endpoints[0].extra');
  const missing = entry();
  delete missing.region;
  assert.equal(reasonOf([missing]), 'missing-field endpoints[0].region');
  for (const id of ['Models', '-models', '', 'a'.repeat(65), 'models.example']) assert.equal(one({ id }), 'wrong-type endpoints[0].id', id);
  assert.equal(one({ id: 'a'.repeat(64) }), 'ok');
  assert.equal(one({ class: 'vendor' }), 'not-allowed-here endpoints[0].class');
  assert.equal(one({ scheme: 'http' }), 'not-allowed-here endpoints[0].scheme');
  assert.equal(one({ region: 'unknown' }), 'not-allowed-here endpoints[0].region');
  assert.equal(one({ region: 'ca' }), 'not-allowed-here endpoints[0].region');
  for (const region of ['CA', 'US', 'EU', 'unstated']) assert.equal(one({ region }), 'ok', region);
});

test('D-24: the host is exact and lowercase; * is refused, and a *. pattern is only for org-plain', () => {
  for (const host of ['Models.example.org', 'https://models.example.org', 'models.example.org:443', 'models.example.org/v1', '']) {
    assert.equal(one({ host }), 'wrong-type endpoints[0].host', host);
  }
  assert.equal(one({ host: '*' }), 'not-allowed-here endpoints[0].host');
  assert.equal(one({ host: '*.example.org' }), 'ok');
  for (const endpointClass of ['org-tee', 'nearai-tee', 'vendor-region', 'forwarded', 'closed-api']) {
    const extra = endpointClass === 'org-tee' ? { attestation: 'org-tee-v1' } : {};
    assert.equal(one({ class: endpointClass, host: '*.example.org', maxLabel: ['org/Public'], ...extra }), 'not-allowed-here endpoints[0].host', endpointClass);
  }
});

test('D-24: the class is local exactly for a loopback host, and http-loopback only there', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(one({ class: 'local', host, scheme: 'http-loopback', maxLabel: ['ca-classified/Top Secret'] }), 'ok', host);
    assert.equal(one({ class: 'local', host, scheme: 'https', maxLabel: ['org/Restricted'] }), 'ok', `${host} over https`);
    assert.equal(one({ host, scheme: 'http-loopback' }), 'not-allowed-here endpoints[0].class', `${host} as org-plain`);
  }
  assert.equal(one({ class: 'local', scheme: 'https' }), 'not-allowed-here endpoints[0].class', 'a remote host is never local');
  assert.equal(one({ class: 'local', host: '127.0.0.2', scheme: 'http-loopback' }), 'not-allowed-here endpoints[0].class', 'another loopback address is not this computer');
  assert.equal(one({ scheme: 'http-loopback' }), 'not-allowed-here endpoints[0].scheme');
});

test('D-24: TLS pins are zero to four sorted unique 64-hex hashes, and none on a loopback or pattern host', () => {
  const pins = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)];
  assert.equal(one({ tlsPins: pins }), 'ok');
  assert.equal(one({ tlsPins: [...pins, '5'.repeat(64)] }), 'not-allowed-here endpoints[0].tlsPins');
  assert.equal(one({ tlsPins: ['A'.repeat(64)] }), 'wrong-type endpoints[0].tlsPins[0]');
  assert.equal(one({ tlsPins: ['a'.repeat(63)] }), 'wrong-type endpoints[0].tlsPins[0]');
  assert.equal(one({ tlsPins: [pins[1], pins[0]] }), 'not-sorted endpoints[0].tlsPins[1]');
  assert.equal(one({ tlsPins: [pins[0], pins[0]] }), 'duplicate endpoints[0].tlsPins[1]');
  assert.equal(one({ tlsPins: 'none' }), 'wrong-type endpoints[0].tlsPins');
  assert.equal(one({ host: '*.example.org', tlsPins: [pins[0]] }), 'not-allowed-here endpoints[0].tlsPins');
  assert.equal(one({ class: 'local', host: 'localhost', scheme: 'http-loopback', tlsPins: [pins[0]] }), 'not-allowed-here endpoints[0].tlsPins');
});

test('D-25: maxLabel holds sorted keys of the document\'s scales, at most one level per scale', () => {
  assert.equal(one({ maxLabel: ['ca-protected/Protected A', 'org/Confidential'] }), 'ok');
  assert.equal(one({ maxLabel: [] }), 'ok', 'an empty ceiling reaches nothing, which is never wider');
  assert.equal(one({ maxLabel: ['org/Confidential', 'ca-protected/Protected A'] }), 'not-sorted endpoints[0].maxLabel[1]');
  assert.equal(one({ maxLabel: ['org/Confidential', 'org/Internal'] }), 'duplicate endpoints[0].maxLabel[1]');
  assert.equal(one({ maxLabel: ['org/Secret'] }), 'not-allowed-here endpoints[0].maxLabel[0]');
  assert.equal(one({ maxLabel: ['planet/Public'] }), 'not-allowed-here endpoints[0].maxLabel[0]');
  assert.equal(one({ maxLabel: ['Confidential'] }), 'wrong-type endpoints[0].maxLabel[0]');
  assert.equal(one({ maxLabel: [3] }), 'wrong-type endpoints[0].maxLabel[0]');
  assert.equal(one({ maxLabel: 'org/Public' }), 'wrong-type endpoints[0].maxLabel');
});

test('D-25, S1: a level that never leaves this computer, or one above it on its scale, is refused on every class but local', () => {
  for (const key of THIS_COMPUTER_ONLY_LEVELS) {
    for (const endpointClass of ENDPOINT_CLASSES) {
      const local = endpointClass === 'local';
      const shaped = local
        ? { class: 'local', host: 'localhost', scheme: 'http-loopback' }
        : { class: endpointClass, ...(endpointClass === 'org-tee' || endpointClass === 'vendor-tee' ? { attestation: 'verifier-v1' } : {}) };
      assert.equal(one({ ...shaped, maxLabel: [key] }), local ? 'ok' : 'not-allowed-here endpoints[0].maxLabel[0]', `${endpointClass} ${key}`);
    }
  }
  assert.equal(one({ class: 'org-tee', attestation: 'org-tee-v1', maxLabel: ['ca-protected/Protected B'] }), 'ok', 'Protected B may be named on your organization\'s own servers');
});

test('D-25: vendor, forwarded and closed-API places refuse org Restricted, Protected C, classified and NATO Restricted and above, and take the rest', () => {
  for (const endpointClass of ['vendor-tee', 'vendor-region', 'forwarded', 'closed-api']) {
    const extra = endpointClass === 'vendor-tee' ? { attestation: 'vendor-tee-v1' } : {};
    for (const key of THIRD_PARTY_REFUSED_LEVELS) assert.equal(one({ class: endpointClass, ...extra, maxLabel: [key] }), 'not-allowed-here endpoints[0].maxLabel[0]', `${endpointClass} ${key}`);
    for (const key of ['org/Confidential', 'ca-protected/Protected B', 'nato/NATO Unclassified']) assert.equal(one({ class: endpointClass, ...extra, maxLabel: [key] }), 'ok', `${endpointClass} ${key}`);
  }
  // Your organization's own plain server may hold org Restricted and NATO Restricted.
  assert.equal(one({ maxLabel: ['nato/NATO Restricted', 'org/Restricted'] }), 'ok');
});

test('D-24, D-52: a pattern host holds at most org Restricted, Protected A and NATO Unclassified, and nothing on another scale', () => {
  const pattern = (maxLabel: string[]): string => one({ host: '*.lab.example.org', maxLabel });
  assert.deepEqual([...PATTERN_HOST_CEILING], ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']);
  assert.equal(pattern(['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']), 'ok');
  assert.equal(pattern(['ca-protected/Protected B']), 'not-allowed-here endpoints[0].maxLabel[0]');
  assert.equal(pattern(['nato/NATO Restricted']), 'not-allowed-here endpoints[0].maxLabel[0]');
  const custom = { ...SCALE_PRESETS, plant: { name: 'Plant', levels: ['Open', 'Closed'] } };
  const parsed = parseEndpoints([entry({ host: '*.lab.example.org', maxLabel: ['plant/Open'] })], custom);
  assert.equal(parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`, 'not-allowed-here endpoints[0].maxLabel[0]', 'another scale gives a pattern host nothing');
  assert.equal(parseEndpoints([entry({ maxLabel: ['plant/Closed'] })], custom).ok, true, 'an exact host may hold a custom scale');
});

test('D-24: attestation is required for org-tee and vendor-tee and refused elsewhere; provider is an optional token', () => {
  assert.equal(one({ class: 'org-tee' }), 'missing-field endpoints[0].attestation');
  assert.equal(one({ class: 'vendor-tee', maxLabel: ['org/Public'] }), 'missing-field endpoints[0].attestation');
  assert.equal(one({ class: 'nearai-tee', attestation: 'nearai-v1' }), 'not-allowed-here endpoints[0].attestation');
  assert.equal(one({ attestation: 'org-tee-v1' }), 'not-allowed-here endpoints[0].attestation');
  assert.equal(one({ class: 'org-tee', attestation: 'Has Spaces' }), 'wrong-type endpoints[0].attestation');
  assert.equal(one({ provider: 'cohere' }), 'ok');
  assert.equal(one({ provider: '' }), 'wrong-type endpoints[0].provider');
  assert.equal(one({ provider: 7 }), 'wrong-type endpoints[0].provider');
});

test('endpointCeilingAllows compares scale and level only, and a scale the ceiling does not list allows nothing', () => {
  const endpoint = { maxLabel: ['ca-protected/Protected A', 'org/Confidential'] };
  const label = (scale: string, level: string): { scale: string; level: string } => ({ scale, level });
  assert.equal(endpointCeilingAllows(endpoint, label('org', 'Public'), scales), true);
  assert.equal(endpointCeilingAllows(endpoint, label('org', 'Confidential'), scales), true);
  assert.equal(endpointCeilingAllows(endpoint, label('org', 'Restricted'), scales), false);
  assert.equal(endpointCeilingAllows(endpoint, label('ca-protected', 'Protected B'), scales), false);
  assert.equal(endpointCeilingAllows(endpoint, label('nato', 'NATO Unclassified'), scales), false);
  assert.equal(endpointCeilingAllows(endpoint, label('org', 'Invented'), scales), false);
  assert.equal(endpointCeilingAllows({ maxLabel: [] }, label('org', 'Public'), scales), false);
});

test('findEndpoint: an exact host beats a pattern, the longest pattern wins, a pattern never matches its own base, and loopback is this computer', () => {
  const list = parseEndpoints([
    entry({ id: 'deep', host: '*.a.lab.example.org', maxLabel: ['org/Public'] }),
    entry({ id: 'exact', host: 'a.lab.example.org' }),
    entry({ id: 'lab', host: '*.lab.example.org', maxLabel: ['org/Public'] }),
    entry({ id: 'other', host: 'other.example.net' })
  ], scales);
  assert.ok(list.ok);
  if (!list.ok) return;
  const found = (address: string): string => {
    const match = findEndpoint(list.value, address);
    return match.kind === 'listed' ? `${match.endpoint.id} ${match.match}` : match.kind;
  };
  assert.equal(found('https://a.lab.example.org/v1'), 'exact exact');
  assert.equal(found('b.lab.example.org'), 'lab pattern');
  assert.equal(found('b.a.lab.example.org'), 'deep pattern');
  assert.equal(found('https://c.b.lab.example.org:8443'), 'lab pattern');
  assert.equal(found('lab.example.org'), 'none');
  assert.equal(found('xlab.example.org'), 'none');
  assert.equal(found('https://A.LAB.example.org'), 'exact exact', 'the URL parser lowercases the host');
  assert.equal(found('https://models.example.org@other.example.net'), 'other exact', 'userinfo never names the host');
  for (const address of ['http://localhost:11434', 'http://127.0.0.1:8080/v1', 'http://[::1]:11434']) assert.equal(found(address), 'this-computer', address);
  assert.equal(found('http://127.0.0.2'), 'none');
  assert.equal(found('::not a url'), 'none');
  assert.equal(found(''), 'none');
  assert.equal(endpointHostOf('https://Models.Example.org:443/v1'), 'models.example.org');
  assert.equal(endpointHostOf('   '), undefined);
  // A local entry that names a loopback host is that entry.
  const withLocal = parseEndpoints([entry({ id: 'laptop', class: 'local', host: 'localhost', scheme: 'http-loopback', maxLabel: ['org/Restricted'] })], scales);
  assert.ok(withLocal.ok);
  if (withLocal.ok) {
    const match = findEndpoint(withLocal.value, 'http://localhost:11434');
    assert.equal(match.kind === 'listed' ? match.endpoint.id : match.kind, 'laptop');
    assert.equal(findEndpoint(withLocal.value, 'http://127.0.0.1').kind, 'this-computer');
  }
});

test('D-26, D-52: Protected B and NATO Restricted need an authorization; org Restricted, Protected A and this-computer levels do not', () => {
  assert.equal(needsEndpointAuthorization('ca-protected/Protected B', DEFAULT_ROUTING), true);
  assert.equal(needsEndpointAuthorization('nato/NATO Restricted', DEFAULT_ROUTING), true);
  for (const key of ['org/Restricted', 'org/Public', 'org/Confidential', 'ca-protected/Protected A', 'nato/NATO Unclassified', ...THIS_COMPUTER_ONLY_LEVELS]) {
    assert.equal(needsEndpointAuthorization(key, DEFAULT_ROUTING), false, key);
  }
  // Protected B needs it however the table routes it.
  const relaxed: RoutingTable = { ...DEFAULT_ROUTING, levels: { ...DEFAULT_ROUTING.levels, 'ca-protected/Protected B': 'attested-cloud' } };
  assert.equal(needsEndpointAuthorization('ca-protected/Protected B', relaxed), true);
  // Any other level the table keeps local-only needs one too.
  const stricter: RoutingTable = { ...DEFAULT_ROUTING, levels: { ...DEFAULT_ROUTING.levels, 'org/Confidential': 'local-only' } };
  assert.equal(needsEndpointAuthorization('org/Confidential', stricter), true);
  assert.equal(needsEndpointAuthorization('__proto__', DEFAULT_ROUTING), false);
});

test('D-27: an exact host migrates at today\'s effect except Protected B and NATO Restricted, each loss listed', () => {
  const { endpoints, changes } = migrateLocalHosts(routingWith(['models.example.org']), scales);
  assert.deepEqual(endpoints, [{
    id: 'local-models-example-org', class: 'org-plain', host: 'models.example.org', scheme: 'https', tlsPins: [], region: 'unstated',
    maxLabel: ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']
  }]);
  assert.deepEqual(changes, [{ host: 'models.example.org', kind: 'exact', endpointId: 'local-models-example-org', lost: ['ca-protected/Protected B', 'nato/NATO Restricted'] }]);
  assert.equal(parseEndpoints(JSON.parse(JSON.stringify(endpoints)), scales).ok, true, 'a migrated entry is a valid entry');
});

test('D-27: a pattern host keeps what the patched routing gave it, loopback makes no entry, and colliding ids get -2', () => {
  const { endpoints, changes } = migrateLocalHosts(routingWith(['*.lab.example.org', 'localhost', 'a-b.example.org', 'a.b.example.org']), scales);
  assert.deepEqual(endpoints.map((item) => [item.id, item.host, [...item.maxLabel]]), [
    ['local-a-b-example-org', 'a-b.example.org', ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']],
    ['local-a-b-example-org-2', 'a.b.example.org', ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Restricted']],
    ['local-any-lab-example-org', '*.lab.example.org', ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Confidential']]
  ]);
  assert.deepEqual(changes.map((change) => [change.host, change.kind, change.endpointId, [...change.lost]]), [
    ['*.lab.example.org', 'pattern', 'local-any-lab-example-org', []],
    ['a-b.example.org', 'exact', 'local-a-b-example-org', ['ca-protected/Protected B', 'nato/NATO Restricted']],
    ['a.b.example.org', 'exact', 'local-a-b-example-org-2', ['ca-protected/Protected B', 'nato/NATO Restricted']],
    ['localhost', 'this-computer', undefined, []]
  ]);
  assert.equal(parseEndpoints(JSON.parse(JSON.stringify(endpoints)), scales).ok, true);
  // A long host is cut to fit the id, and an empty list makes nothing.
  const long = `${'x'.repeat(60)}.example.org`;
  const cut = migrateLocalHosts(routingWith([long]), scales).endpoints[0] as PolicyEndpoint;
  assert.equal(cut.id.length, 64);
  assert.deepEqual(migrateLocalHosts(DEFAULT_ROUTING, scales).endpoints, []);
});

test('D-27: the migration never widens: a level the table keeps on this computer or denies is never in a ceiling', () => {
  const routing: RoutingTable = {
    ...DEFAULT_ROUTING,
    levels: { ...DEFAULT_ROUTING.levels, 'org/Internal': 'deny', 'ca-protected/Protected C': 'any-cloud' },
    localHosts: ['models.example.org']
  };
  const { endpoints, changes } = migrateLocalHosts(routing, scales);
  assert.deepEqual([...(endpoints[0]?.maxLabel ?? [])], ['ca-protected/Protected A', 'nato/NATO Unclassified', 'org/Public']);
  // org Confidential and Restricted were served (attested and exact local-only) but sit above a denied level, so they are listed as lost.
  assert.deepEqual([...(changes[0]?.lost ?? [])], ['ca-protected/Protected B', 'nato/NATO Restricted', 'org/Confidential', 'org/Restricted']);
});

test('D-27 end to end: a v1 bundle with local hosts reads as the migration plus endpoints@1, and its view lists the same non-loopback hosts sorted', () => {
  const key = deviceKey();
  const payload = JSON.parse(JSON.stringify(defaultBundlePayload({ issuer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, now: FIXED_NOW })));
  payload.routing.localHosts = ['models.example.org', 'localhost', '*.lab.example.org'];
  const parsed = parsePolicyDocument(payload);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  assert.ok(parsed.value.requires.includes('endpoints@1'));
  const v1 = parseBundle(payload);
  assert.ok(v1.ok);
  if (!v1.ok) return;
  assert.deepEqual(parsed.value.endpoints, migrateLocalHosts(v1.value.routing, v1.value.scales).endpoints);
  assert.deepEqual([...bundleViewOf(parsed.value).routing.localHosts], ['*.lab.example.org', 'models.example.org']);
  // The document is its own wire form, endpoints included.
  const again = parsePolicyDocument(JSON.parse(JSON.stringify(parsed.value)));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.value, parsed.value);
  assert.deepEqual(documentFromBundle(v1.value), parsed.value);
});

test('D-24: a v2 document with endpoints must name endpoints@1, and an endpoint error is reported at its path in the document', () => {
  const key = deviceKey();
  const base = JSON.parse(JSON.stringify(documentFromBundle(defaultBundlePayload({ issuer: { fingerprint: key.fingerprint, publicKey: key.publicKey }, now: FIXED_NOW }))));
  base.endpoints = [entry()];
  const unnamed = parsePolicyDocument(base);
  assert.equal(unnamed.ok ? 'ok' : `${unnamed.reason} ${unnamed.path}`, 'missing-field requires');
  base.requires = ['agents@1', 'endpoints@1', 'labels@1', 'layers@1', 'people@1'];
  assert.equal(parsePolicyDocument(base).ok, true);
  base.endpoints = [entry({ maxLabel: ['ca-protected/Protected C'] })];
  const refused = parsePolicyDocument(base);
  assert.equal(refused.ok ? 'ok' : `${refused.reason} ${refused.path}`, 'not-allowed-here endpoints[0].maxLabel[0]');
});
