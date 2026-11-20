// Layer composition (FND-01, Phase 41 D-18 to D-22, D-28, D-31, D-60, D-62): your organization's layer is the ceiling, the personal layer can only narrow
// it key by declared key, a wider personal value is replaced and listed (never a lock-out), and a new widening edit is named before it is signed.
// Keys are made at test time; every name is fictional.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { effectiveMode } from '../domain/gate/decide';
import {
  LAYER_ENVELOPE_KEYS, NARROWING, composeLayers, directionOf, ignoredSettingsNotice, narrowingOf, parseProjectLayer, wideningOf, widerThanOrganizationText
} from '../domain/gate/layers';
import type { IgnoredSetting, ProjectLayer } from '../domain/gate/layers';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { ROUTING_TIERS } from '../domain/gate/routing';
import type { ActionPolicyMode } from '../domain/policy';
import { bundleViewOf, parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import {
  DAY_MS, FIXED_NOW, authorizationFor, deviceKey, fixtureEndpoints, fullDocumentFor, issuerKey, policyDocumentFor, signAuthorization, signerEntry
} from './helpers/policyFixtures';

type Loose = any; // a document under edit: each test changes the values it is about

function plain<T>(value: T): Loose {
  return JSON.parse(JSON.stringify(value)) as Loose;
}

/** Parses a plain document, failing the test with the refusal when it does not parse. */
function documentOf(value: unknown): PolicyDocument {
  const parsed = parsePolicyDocument(value);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

/** The starting rules as your organization's layer, with one edit applied. */
function organization(edit: (doc: Loose) => void = () => undefined, now = FIXED_NOW): PolicyDocument {
  const doc = plain(policyDocumentFor({ key: issuerKey(), layer: 'organization', now }));
  edit(doc);
  return documentOf(doc);
}

/** The starting rules as this device's personal layer, with one edit applied. */
function personal(edit: (doc: Loose) => void = () => undefined, now = FIXED_NOW): PolicyDocument {
  const doc = plain(policyDocumentFor({ key: deviceKey(), now }));
  edit(doc);
  return documentOf(doc);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 1: the tracer

test('D-18: without an organization layer the personal layer is the whole policy, the same object, with nothing ignored', () => {
  const mine = policyDocumentFor({ key: deviceKey() });
  const composed = composeLayers({ personal: mine });
  assert.equal(composed.effective, mine);
  assert.deepEqual(composed.ignored, []);
  assert.deepEqual(bundleViewOf(composed.effective), bundleViewOf(mine));
});

test('D-20: a personal routing level wider than the organization\'s is replaced and listed', () => {
  const org = organization((doc) => { doc.labels.routing.levels['org/Internal'] = 'local-only'; });
  const mine = personal((doc) => { doc.labels.routing.levels['org/Internal'] = 'attested-cloud'; });
  const composed = composeLayers({ organization: org, personal: mine });
  assert.equal(composed.effective.labels.routing.levels['org/Internal'], 'local-only');
  assert.deepEqual(composed.ignored, [{ key: 'labels.routing.levels.org/Internal', layer: 'personal', yours: 'attested-cloud', allowed: 'local-only' }]);
});

test('a personal level stricter than the organization\'s stays and is not listed', () => {
  const org = organization((doc) => { doc.labels.routing.levels['org/Confidential'] = 'attested-cloud'; });
  const mine = personal((doc) => { doc.labels.routing.levels['org/Confidential'] = 'deny'; });
  const composed = composeLayers({ organization: org, personal: mine });
  assert.equal(composed.effective.labels.routing.levels['org/Confidential'], 'deny');
  assert.ok(!composed.ignored.some((entry) => entry.key === 'labels.routing.levels.org/Confidential'));
  assert.deepEqual(composed.ignored, []);
});

test('the effective policy parses again and ends at the earlier of the two layers', () => {
  const org = organization((doc) => {
    doc.limits = { v: 1, spend: { dailyNanoUsd: 9 } };
    doc.requires = [...doc.requires, 'limits@1'].sort();
  }, FIXED_NOW - 10 * DAY_MS);
  const mine = personal();
  const composed = composeLayers({ organization: org, personal: mine });
  const again = parsePolicyDocument(JSON.parse(JSON.stringify(composed.effective)));
  assert.ok(again.ok, again.ok ? '' : again.message);
  assert.equal(composed.effective.expiresAt, org.expiresAt);
  assert.ok(Date.parse(org.expiresAt) < Date.parse(mine.expiresAt));
  assert.deepEqual(composed.effective.requires, [...new Set([...org.requires, ...mine.requires])].sort());
  assert.ok(composed.effective.requires.includes('limits@1'));
  assert.equal(composed.effective.issuer.fingerprint, mine.issuer.fingerprint);
  assert.equal(composed.effective.layer, 'personal');
  assert.ok(Object.isFrozen(composed.effective));
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 2: every direction, endpoints and authorizations, scale clean-up, the widening check

/** Adds a section to a plain document and names its feature in `requires`. */
function withSection(doc: Loose, section: string, value: unknown, feature: string): void {
  doc[section] = value;
  if (!doc.requires.includes(feature)) doc.requires = [...doc.requires, feature].sort();
}

function keysOf(ignored: readonly IgnoredSetting[]): string[] {
  return ignored.map((entry) => entry.key);
}

const CONTACT_A = { topic: 'security', name: 'Security desk', how: 'security@example.org' };
const CONTACT_B = { topic: 'security', name: 'Someone else', how: 'someone@example.org' };

const ENDPOINT = (maxLabel: string[]): Loose => ({ ...(fixtureEndpoints().find((entry) => entry.id === 'models-example-org') as Loose), maxLabel });

interface DirectionRow {
  readonly name: string;
  readonly key: string;
  readonly organization: (doc: Loose) => void;
  readonly narrower: (doc: Loose) => void;
  readonly wider: (doc: Loose) => void;
  readonly read: (doc: PolicyDocument) => unknown;
  readonly narrowerValue: unknown;
  readonly organizationValue: unknown;
}

const DIRECTION_ROWS: readonly DirectionRow[] = [
  {
    name: 'tier-stricter (agent modes)', key: 'agents.maxMode.unattended',
    organization: (doc) => { doc.agents.maxMode.unattended = 'auto'; },
    narrower: (doc) => { doc.agents.maxMode.unattended = 'approve-risky'; },
    wider: (doc) => { doc.agents.maxMode.unattended = 'fully-autonomous'; },
    read: (doc) => doc.agents.maxMode.unattended, narrowerValue: 'approve-risky', organizationValue: 'auto'
  },
  {
    name: 'subset (contexts)', key: 'agents.contexts.shell',
    organization: (doc) => { doc.agents.contexts.shell = ['interactive']; },
    narrower: (doc) => { doc.agents.contexts.shell = []; },
    wider: (doc) => { doc.agents.contexts.shell = ['interactive', 'unattended']; },
    read: (doc) => doc.agents.contexts.shell, narrowerValue: [], organizationValue: ['interactive']
  },
  {
    name: 'number-lower (spend)', key: 'limits.spend.dailyNanoUsd',
    organization: (doc) => withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 100 } }, 'limits@1'),
    narrower: (doc) => withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 50 } }, 'limits@1'),
    wider: (doc) => withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 200 } }, 'limits@1'),
    read: (doc) => doc.limits?.spend?.dailyNanoUsd, narrowerValue: 50, organizationValue: 100
  },
  {
    name: 'ceiling-dominated (endpoint ceiling)', key: 'endpoints[models-example-org].maxLabel',
    organization: (doc) => withSection(doc, 'endpoints', [ENDPOINT(['ca-protected/Protected A', 'org/Internal'])], 'endpoints@1'),
    narrower: (doc) => withSection(doc, 'endpoints', [ENDPOINT(['org/Public'])], 'endpoints@1'),
    wider: (doc) => withSection(doc, 'endpoints', [ENDPOINT(['ca-protected/Protected A', 'org/Restricted'])], 'endpoints@1'),
    read: (doc) => doc.endpoints?.[0]?.maxLabel, narrowerValue: ['org/Public'], organizationValue: ['ca-protected/Protected A', 'org/Internal']
  },
  {
    name: 'boolean-safe (accredited devices)', key: 'agents.requireAccreditedDevice',
    organization: (doc) => { doc.agents.requireAccreditedDevice = true; },
    narrower: (doc) => { doc.agents.requireAccreditedDevice = true; },
    wider: (doc) => { doc.agents.requireAccreditedDevice = false; },
    read: (doc) => doc.agents.requireAccreditedDevice, narrowerValue: true, organizationValue: true
  },
  {
    name: 'organization-only (contacts)', key: 'onboarding.contacts',
    organization: (doc) => withSection(doc, 'onboarding', { v: 1, contacts: [CONTACT_A] }, 'onboarding@1'),
    narrower: (doc) => withSection(doc, 'onboarding', { v: 1, contacts: [CONTACT_A] }, 'onboarding@1'),
    wider: (doc) => withSection(doc, 'onboarding', { v: 1, contacts: [CONTACT_B] }, 'onboarding@1'),
    read: (doc) => doc.onboarding?.contacts, narrowerValue: [CONTACT_A], organizationValue: [CONTACT_A]
  }
];

test('D-19: each direction composes both ways', () => {
  for (const row of DIRECTION_ROWS) {
    const org = organization(row.organization);
    const kept = composeLayers({ organization: org, personal: personal(row.narrower) });
    assert.deepEqual(row.read(kept.effective), row.narrowerValue, `${row.name}: the narrower personal value stays`);
    assert.ok(!keysOf(kept.ignored).includes(row.key), `${row.name}: a narrower value is not listed`);
    const clamped = composeLayers({ organization: org, personal: personal(row.wider) });
    assert.deepEqual(row.read(clamped.effective), row.organizationValue, `${row.name}: the wider personal value is replaced`);
    assert.equal(clamped.ignored.filter((entry) => entry.key === row.key).length, 1, `${row.name}: the wider value is listed once`);
    for (const entry of clamped.ignored) assert.equal(entry.layer, 'personal');
    assert.ok(parsePolicyDocument(plain(clamped.effective)).ok, `${row.name}: the effective policy parses`);
  }
});

const FOUND_SERVER = (maxLabel: string[]): Loose => ({
  id: 'found-server', class: 'org-plain', host: 'found.example.org', scheme: 'https', tlsPins: [], region: 'CA', maxLabel
});

test('D-28: a personal endpoint the organization lacks is kept only at org/Public and only when personalApprovals is true', () => {
  const approvals = (flag: boolean) => organization((doc) => withSection(doc, 'onboarding', { v: 1, discovery: { personalApprovals: flag } }, 'onboarding@1'));
  const mine = (maxLabel: string[]) => personal((doc) => withSection(doc, 'endpoints', [FOUND_SERVER(maxLabel)], 'endpoints@1'));
  const off = composeLayers({ organization: approvals(false), personal: mine(['org/Public']) });
  assert.equal(off.effective.endpoints, undefined);
  assert.deepEqual(keysOf(off.ignored), ['endpoints[found-server]']);
  const on = composeLayers({ organization: approvals(true), personal: mine(['org/Public']) });
  assert.deepEqual(on.effective.endpoints?.map((entry) => entry.id), ['found-server']);
  assert.deepEqual(on.ignored, []);
  const higher = composeLayers({ organization: approvals(true), personal: mine(['org/Internal']) });
  assert.equal(higher.effective.endpoints, undefined);
  assert.deepEqual(keysOf(higher.ignored), ['endpoints[found-server]']);
});

test('an endpoint both layers name keeps the organization\'s host, scheme, class, region and pins; only maxLabel can be lower', () => {
  const org = organization((doc) => withSection(doc, 'endpoints', [ENDPOINT(['ca-protected/Protected A', 'org/Internal'])], 'endpoints@1'));
  const mine = personal((doc) => withSection(doc, 'endpoints', [{
    ...ENDPOINT(['org/Public']), host: 'elsewhere.example.org', region: 'US', tlsPins: ['f'.repeat(64)]
  }], 'endpoints@1'));
  const composed = composeLayers({ organization: org, personal: mine });
  const endpoint = composed.effective.endpoints?.[0];
  assert.ok(endpoint !== undefined);
  assert.equal(endpoint.host, 'models.example.org');
  assert.equal(endpoint.region, 'CA');
  assert.equal(endpoint.class, 'org-plain');
  assert.equal(endpoint.scheme, 'https');
  assert.deepEqual(endpoint.tlsPins, ENDPOINT([]).tlsPins);
  assert.deepEqual(endpoint.maxLabel, ['org/Public']);
  assert.deepEqual(keysOf(composed.ignored).sort(), [
    'endpoints[models-example-org].host', 'endpoints[models-example-org].region', 'endpoints[models-example-org].tlsPins'
  ]);
  // A personal list that leaves an organization endpoint out narrows: the endpoint is not reachable.
  const none = composeLayers({ organization: org, personal: personal((doc) => withSection(doc, 'endpoints', [], 'endpoints@1')) });
  assert.deepEqual(none.effective.endpoints, []);
  assert.deepEqual(none.ignored, []);
  // A personal layer with no endpoints takes the organization's.
  assert.deepEqual(composeLayers({ organization: org, personal: personal() }).effective.endpoints, org.endpoints);
});

test('D-31: a personal authorization counts only when its signer is listed in the organization\'s people.signers', () => {
  const approver = issuerKey('approver');
  const org = organization((doc) => { doc.people = { v: 1, clearances: doc.people.clearances, signers: [signerEntry(approver)] }; });
  const listed = signAuthorization(authorizationFor({ kind: 't1-risk', id: 't1-risk-listed' }), approver);
  const unlisted = signAuthorization(authorizationFor({ kind: 't1-risk', id: 't1-risk-self' }), deviceKey());
  const mine = personal((doc) => withSection(doc, 'authorizations', plain([listed, unlisted]), 'authorizations@1'));
  const composed = composeLayers({ organization: org, personal: mine });
  assert.deepEqual(composed.effective.authorizations?.map((entry) => entry.payload.id), ['t1-risk-listed']);
  assert.deepEqual(composed.ignored, [{ key: 'authorizations[t1-risk-self]', layer: 'personal', yours: 't1-risk-self', allowed: 'nothing' }]);
  // Without a signer list at all, no personal authorization counts under an organization layer.
  const none = composeLayers({ organization: organization(), personal: mine });
  assert.equal(none.effective.authorizations, undefined);
  assert.deepEqual(keysOf(none.ignored), ['authorizations[t1-risk-listed]', 'authorizations[t1-risk-self]']);
});

test('a personal clearance or mapping on a scale the organization does not have is dropped and listed, and the effective policy still parses', () => {
  const org = organization((doc) => {
    delete doc.labels.scales.nato;
    for (const key of Object.keys(doc.labels.routing.levels)) if (key.startsWith('nato/')) delete doc.labels.routing.levels[key];
  });
  const mine = personal((doc) => {
    doc.labels.mappings = [{ from: { scale: 'nato', level: 'NATO Secret' }, covers: { scale: 'org', level: 'Confidential' } }];
    doc.people.clearances = [{ scale: 'nato', level: 'NATO Secret', compartments: [], releasability: [] }, ...doc.people.clearances];
    doc.agents.mcp.labelCeilings = { git: { scale: 'nato', level: 'NATO Restricted', compartments: [], releasability: [] } };
    withSection(doc, 'residency', { v: 1, byLevel: { 'nato/NATO Secret': ['CA'], 'org/Internal': ['CA'] } }, 'residency@1');
    // The strictest tier on a scale your organization lacks is not wider, but it names a level the effective scales lack.
    doc.labels.routing.levels['nato/Cosmic Top Secret'] = 'deny';
  });
  const composed = composeLayers({ organization: org, personal: mine });
  assert.ok(parsePolicyDocument(plain(composed.effective)).ok);
  assert.deepEqual(composed.effective.labels.mappings, []);
  assert.deepEqual(composed.effective.people?.clearances, [{ scale: 'org', level: 'Restricted', compartments: [], releasability: [] }]);
  assert.equal(composed.effective.agents.mcp.labelCeilings, undefined);
  assert.deepEqual(composed.effective.residency?.byLevel, { 'org/Internal': ['CA'] });
  const keys = keysOf(composed.ignored);
  for (const key of [
    'labels.mappings', 'people.clearances', 'agents.mcp.labelCeilings.git', 'residency.byLevel.nato/NATO Secret', 'labels.routing.levels.nato/NATO Secret',
    'labels.routing.levels.nato/Cosmic Top Secret'
  ]) {
    assert.ok(keys.includes(key), `${key} is listed`);
  }
  assert.ok(!composed.ignored.some((entry) => entry.key === 'personal layer'), 'the layers combine without the fallback');
});

test('a clearance your organization\'s list contains stays; one above it is dropped and listed', () => {
  const org = organization((doc) => { doc.people.clearances = [{ scale: 'org', level: 'Confidential', compartments: ['ALPHA'], releasability: ['CAN'] }]; });
  const mine = personal((doc) => {
    doc.people.clearances = [
      { scale: 'org', level: 'Confidential', compartments: ['ALPHA', 'BRAVO'], releasability: [] },
      { scale: 'org', level: 'Internal', compartments: [], releasability: ['CAN'] }
    ];
  });
  const composed = composeLayers({ organization: org, personal: mine });
  assert.deepEqual(composed.effective.people?.clearances, [{ scale: 'org', level: 'Internal', compartments: [], releasability: ['CAN'] }]);
  assert.deepEqual(composed.ignored, [{ key: 'people.clearances', layer: 'personal', yours: 'org/Confidential', allowed: 'org/Confidential' }]);
});

test('defaults and reserved values are never listed', () => {
  const org = organization((doc) => { doc.labels.routing.levels['org/Internal'] = 'local-only'; });
  const mine = personal((doc) => {
    doc.reserved = { v: 1, anchorRoots: [], statusLists: [], maxOfflineAge: { 'org/Restricted': 3600 } };
    withSection(doc, 'onboarding', { v: 1 }, 'onboarding@1');
    withSection(doc, 'limits', { v: 1 }, 'limits@1');
  });
  const composed = composeLayers({ organization: org, personal: mine });
  assert.deepEqual(keysOf(composed.ignored), ['labels.routing.levels.org/Internal']);
  assert.deepEqual(keysOf(composeLayers({ organization: org, personal: personal() }).ignored), ['labels.routing.levels.org/Internal']);
});

test('D-20: wideningOf names the key a new edit widens', () => {
  const org = organization((doc) => { doc.labels.routing.levels['org/Internal'] = 'local-only'; });
  const base = personal((doc) => { doc.labels.routing.levels['org/Internal'] = 'attested-cloud'; withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 100 } }, 'limits@1'); });
  const wider = personal((doc) => { doc.labels.routing.levels['org/Internal'] = 'any-cloud'; withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 100 } }, 'limits@1'); });
  const found = wideningOf(org, base, wider);
  assert.deepEqual(found, { key: 'labels.routing.levels.org/Internal', layer: 'personal', yours: 'any-cloud', allowed: 'local-only' });
  // The old clamped value does not block an unrelated narrowing edit.
  const narrower = personal((doc) => { doc.labels.routing.levels['org/Internal'] = 'attested-cloud'; withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 50 } }, 'limits@1'); });
  assert.equal(wideningOf(org, base, narrower), undefined);
  assert.equal(wideningOf(undefined, base, wider), undefined);
  assert.equal(widerThanOrganizationText(found as IgnoredSetting), 'Your organization\'s rules do not allow labels.routing.levels.org/Internal to be wider than local-only.');
});

test('ignoredSettingsNotice lists at most five settings, then how many more, and has no em-dash', () => {
  assert.equal(ignoredSettingsNotice([]), undefined);
  const entries: IgnoredSetting[] = Array.from({ length: 7 }, (_, index) => ({ key: `limits.key${String(index)}`, layer: 'personal', yours: '9', allowed: '1' }));
  const notice = ignoredSettingsNotice(entries) as string;
  assert.ok(notice.startsWith('These personal settings are wider than your organization allows and have no effect: '));
  assert.ok(notice.includes('limits.key0 (yours: 9, allowed: 1); limits.key1 (yours: 9, allowed: 1)'));
  assert.ok(notice.includes('limits.key4'));
  assert.ok(!notice.includes('limits.key5'));
  assert.ok(notice.endsWith(', and 2 more.'));
  assert.ok(!notice.includes(String.fromCharCode(0x2014)));
  assert.equal(ignoredSettingsNotice(entries.slice(0, 1)), 'These personal settings are wider than your organization allows and have no effect: limits.key0 (yours: 9, allowed: 1).');
});

test('narrowingOf judges one change by its declared rule', () => {
  assert.equal(narrowingOf('labels.routing.levels.org/Internal', 'attested-cloud', 'any-cloud'), 'widens');
  assert.equal(narrowingOf('labels.routing.levels.org/Internal', 'any-cloud', 'attested-cloud'), 'narrows');
  assert.equal(narrowingOf('labels.routing.levels.org/Internal', 'local-only', 'local-only'), 'neutral');
  assert.equal(narrowingOf('limits.spend.dailyNanoUsd', 5, 3), 'narrows');
  assert.equal(narrowingOf('limits.spend.dailyNanoUsd', 3, 5), 'widens');
  assert.equal(narrowingOf('exportControl.regimes', ['ITAR'], ['CGP', 'ITAR']), 'narrows');
  assert.equal(narrowingOf('exportControl.regimes', ['CGP', 'ITAR'], ['ITAR']), 'widens');
  assert.equal(narrowingOf('exportControl.suggestRules', 'off', 'standard'), 'narrows');
  assert.equal(narrowingOf('agents.contexts.shell', ['interactive', 'unattended'], ['interactive']), 'narrows');
  assert.equal(narrowingOf('agents.requireAccreditedDevice', true, false), 'widens');
  assert.equal(narrowingOf('endpoints[models-example-org].maxLabel', ['org/Internal'], ['org/Public']), 'narrows');
  assert.equal(narrowingOf('endpoints[models-example-org].maxLabel', ['org/Internal'], ['org/Restricted']), 'widens');
  assert.equal(narrowingOf('labels.routing.levels.org/Internal', 'attested-cloud', 'somewhere'), 'widens');
  assert.equal(narrowingOf('onboarding.contacts', [], [CONTACT_A]), undefined);
  assert.equal(narrowingOf('limits.plantedKey', 1, 2), undefined);
});

test('the tier orders are routing.ts\'s tiers and effectiveMode\'s modes, weakest first', () => {
  assert.deepEqual(NARROWING['labels.routing.levels.*']?.order, [...ROUTING_TIERS]);
  const modes = NARROWING['agents.maxMode.*']?.order as readonly ActionPolicyMode[];
  for (const a of modes) {
    for (const b of modes) assert.equal(effectiveMode(a, b), modes.indexOf(a) >= modes.indexOf(b) ? a : b, `${a} and ${b}`);
  }
});

test('layers that cannot be combined into a policy that parses give your organization\'s rules whole, with the personal layer listed', () => {
  // Your organization's layer ends before the personal layer was signed: no combined envelope parses.
  const org = organization(() => undefined, FIXED_NOW - 400 * DAY_MS);
  const composed = composeLayers({ organization: org, personal: personal() });
  assert.equal(composed.effective, org);
  assert.equal(composed.ignored[composed.ignored.length - 1]?.key, 'personal layer');
});

const EXPORT = (regimes: string[], officials: Record<string, string>, extra: Loose = {}): Loose => ({
  v: 1, regimes, officials: regimes.map((regime) => ({ regime, position: officials[regime] as string })), ...extra
});

test('D-60: export regimes add up and suggestRules only moves towards automatic', () => {
  const org = organization((doc) => withSection(doc, 'exportControl', EXPORT(['ITAR'], { ITAR: 'empowered-official' }), 'export-control@1'));
  const added = composeLayers({
    organization: org,
    personal: personal((doc) => withSection(doc, 'exportControl', EXPORT(['CGP'], { CGP: 'designated-official' }, { suggestRules: 'off' }), 'export-control@1'))
  });
  assert.deepEqual(added.effective.exportControl?.regimes, ['CGP', 'ITAR']);
  assert.deepEqual(added.effective.exportControl?.officials, [{ regime: 'CGP', position: 'designated-official' }, { regime: 'ITAR', position: 'empowered-official' }]);
  assert.equal(added.effective.exportControl?.suggestRules, 'standard');
  assert.deepEqual(added.ignored, [{ key: 'exportControl.suggestRules', layer: 'personal', yours: 'off', allowed: 'standard' }]);
  assert.equal(added.effective.exportControl?.agentNetwork, 'refuse');
  assert.equal(added.effective.exportControl?.retention.neverAutoPrune, true);
  const automatic = composeLayers({
    organization: org,
    personal: personal((doc) => withSection(doc, 'exportControl', EXPORT(['ITAR'], { ITAR: 'empowered-official' }, { suggestRules: 'automatic' }), 'export-control@1'))
  });
  assert.equal(automatic.effective.exportControl?.suggestRules, 'automatic');
  assert.deepEqual(automatic.ignored, []);
  const replaced = composeLayers({
    organization: org,
    personal: personal((doc) => withSection(doc, 'exportControl', EXPORT(['ITAR'], { ITAR: 'someone-else' }, {
      registration: { ITAR: { registered: true, reference: 'REG-0001', endsOn: null } }
    }), 'export-control@1'))
  });
  assert.deepEqual(replaced.effective.exportControl?.officials, [{ regime: 'ITAR', position: 'empowered-official' }]);
  assert.equal(replaced.effective.exportControl?.registration, undefined);
  assert.deepEqual(keysOf(replaced.ignored), ['exportControl.officials', 'exportControl.registration']);
  // A personal layer with no export control section takes the organization's whole.
  assert.deepEqual(composeLayers({ organization: org, personal: personal() }).effective.exportControl, org.exportControl);
});

test('D-60, D-62: widening edits on export control are refused with the key named', () => {
  const org = organization((doc) => {
    withSection(doc, 'exportControl', EXPORT(['ITAR'], { ITAR: 'empowered-official' }), 'export-control@1');
    // D-62: the reserved compartments are CGP, ITAR and EAR; here your organization keeps ITAR local-only and says nothing about EAR.
    doc.labels.routing.compartments = { CGP: 'local-only', ITAR: 'local-only' };
  });
  const both = EXPORT(['CGP', 'ITAR'], { CGP: 'designated-official', ITAR: 'empowered-official' });
  const base = personal((doc) => withSection(doc, 'exportControl', both, 'export-control@1'));
  const dropped = personal((doc) => withSection(doc, 'exportControl', EXPORT(['CGP'], { CGP: 'designated-official' }), 'export-control@1'));
  assert.deepEqual(wideningOf(org, base, dropped), { key: 'exportControl.regimes', layer: 'personal', yours: 'CGP', allowed: 'ITAR' });
  const looser = personal((doc) => { withSection(doc, 'exportControl', both, 'export-control@1'); doc.labels.routing.compartments.ITAR = 'attested-cloud'; });
  assert.equal(wideningOf(org, base, looser)?.key, 'labels.routing.compartments.ITAR');
  const ear = personal((doc) => {
    withSection(doc, 'exportControl', EXPORT(['CGP', 'EAR', 'ITAR'], { CGP: 'designated-official', EAR: 'empowered-official', ITAR: 'empowered-official' }), 'export-control@1');
    doc.labels.routing.compartments.EAR = 'local-only';
  });
  assert.equal(wideningOf(org, base, ear), undefined);
  assert.equal(composeLayers({ organization: org, personal: ear }).effective.labels.routing.compartments['EAR'], 'local-only');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Task 3: every accepted key has a direction, and the project layer

/**
 * 41-01's fully filled document, plus one licence-based export-person record so the one optional authorization key the fixture lacks
 * (`authorityExpiresAt`) is walked too. The fixture file itself is never edited.
 */
function fullyFilled(): Loose {
  const doc = fullDocumentFor(issuerKey()) as Loose;
  const licence = signAuthorization(authorizationFor({
    kind: 'export-person', id: 'export-person-2', subject: { person: 'person-0143' }, scope: { regimes: ['ITAR'] },
    conditions: { ITAR: { basis: 'licence', authority: 'DSP-5 0001', authorityExpiresAt: new Date(FIXED_NOW + 365 * DAY_MS).toISOString() } }
  }), issuerKey());
  doc.authorizations = [...doc.authorizations, plain(licence)].sort((a: Loose, b: Loose) => (a.payload.id < b.payload.id ? -1 : a.payload.id > b.payload.id ? 1 : 0));
  return doc;
}

function isEnvelopePath(key: string): boolean {
  return LAYER_ENVELOPE_KEYS.some((envelope) => key === envelope || key.startsWith(`${envelope}.`));
}

/** A walked child key: its own name when the table or the envelope names it, `*` when the table has a data-key entry there, else its own name. */
function walkedChild(parent: string, key: string): string {
  const literal = parent === '' ? key : `${parent}.${key}`;
  const names = [...Object.keys(NARROWING), ...LAYER_ENVELOPE_KEYS];
  if (names.some((name) => name === literal || name.startsWith(`${literal}.`) || name.startsWith(`${literal}[`))) return literal;
  const wildcard = parent === '' ? '*' : `${parent}.*`;
  return names.some((name) => name === wildcard || name.startsWith(`${wildcard}.`)) ? wildcard : literal;
}

/** Every key path of a value: list items as `[]`, data keys of a `*` entry as `*`; a list of plain values and an empty record end a path. */
function walk(value: unknown, at = '', out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    const records = value.filter((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
    if (records.length === 0) out.add(at);
    for (const item of records) walk(item, `${at}[]`, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 0) out.add(at);
    for (const key of keys) walk((value as Loose)[key], walkedChild(at, key), out);
    return out;
  }
  out.add(at);
  return out;
}

function undirected(value: unknown): string[] {
  return [...walk(value)].filter((key) => !isEnvelopePath(key) && directionOf(key) === undefined).sort();
}

test('D-19: every key a fully filled v2 policy holds has a declared direction', () => {
  const parsed = parsePolicyDocument(fullyFilled());
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  const paths = walk(parsed.value);
  assert.ok(paths.size > 80, `the walk reaches every key (${String(paths.size)} paths)`);
  assert.deepEqual(undirected(parsed.value), []);
  // D-60: each exportControl key the walk holds, by name.
  const expected: Record<string, string> = {
    'exportControl.regimes': 'superset',
    'exportControl.suggestRules': 'tier-stricter',
    'exportControl.officials[].regime': 'organization-only',
    'exportControl.officials[].position': 'organization-only',
    'exportControl.registration.CGP.registered': 'organization-only',
    'exportControl.incidents.contacts': 'organization-only',
    'exportControl.agentNetwork': 'tier-stricter',
    'exportControl.retention.neverAutoPrune': 'boolean-safe'
  };
  for (const [key, direction] of Object.entries(expected)) {
    assert.ok(paths.has(key), `${key} is walked`);
    assert.equal(directionOf(key)?.direction, direction, key);
  }
  // D-62: the reserved compartments CGP, ITAR and EAR can only be made stricter, and an entry your organization lacks changes nothing.
  for (const token of ['CGP', 'ITAR', 'EAR']) {
    const found = directionOf(`labels.routing.compartments.${token}`);
    assert.equal(found?.direction, 'tier-stricter', token);
    assert.equal(found?.absent, 'weakest', token);
  }
});

test('D-19 has teeth: a path with no direction is reported', () => {
  const parsed = parsePolicyDocument(fullyFilled());
  assert.ok(parsed.ok);
  const planted = plain(parsed.value);
  planted.limits.plantedKey = 1;
  assert.deepEqual(undirected(planted), ['limits.plantedKey']);
});

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SECTION_SOURCES = [
  'src/domain/gate/policyDocument.ts', 'src/domain/gate/sections.ts', 'src/domain/gate/endpoints.ts', 'src/domain/gate/authorizations.ts',
  'src/domain/gate/models.ts', 'src/domain/org/peopleSection.ts'
];
/** Inside a key, signer or issuer envelope: a key's fingerprint and public key, an issuer's did, a parent's hash. They are checked as one value, never composed. */
const ENVELOPE_INNER_KEYS = ['fingerprint', 'publicKey', 'did', 'hash'];
/** bundle.ts BUNDLE_FIELDS and the BundleCeiling keys: only the v1 wire form uses them, and documentFromBundle maps them onto v2 sections. */
const V1_WIRE_KEYS = [
  'bundleVersion', 'vocabulary', 'issuer', 'issuedAt', 'expiresAt', 'ceiling', 'scales', 'mappings', 'clearances', 'routing', 'defaultLabel', 'anchorRoots',
  'statusLists', 'maxOfflineAge', 'maxMode', 'contexts', 'unattendedMcp', 'mcpLabelCeilings', 'localHosts'
];

/** The quoted names inside every checkKeys( and openSection( call and every `const X_KEYS`, `_FIELDS`, `_REQUIRED` or `_OPTIONAL` list of a source text. */
function namedKeys(source: string): string[] {
  const out = new Set<string>();
  const quoted = (text: string): void => { for (const match of text.matchAll(/'([^'\\]+)'/g)) out.add(match[1] as string); };
  for (const match of source.matchAll(/\b(checkKeys|openSection)\(/g)) {
    let depth = 0;
    let end = (match.index as number) + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      if (source[end] === ')') { depth -= 1; if (depth === 0) break; }
    }
    quoted(source.slice(match.index as number, end));
  }
  for (const match of source.matchAll(/const [A-Z][A-Z0-9_]*_(KEYS|FIELDS|REQUIRED|OPTIONAL)\b[^=]*=[^[]*\[([^\]]*)\]/g)) quoted(match[2] as string);
  return [...out].sort();
}

function unaccounted(sources: readonly string[]): string[] {
  const parsed = parsePolicyDocument(fullyFilled());
  assert.ok(parsed.ok);
  const segments = new Set<string>([...ENVELOPE_INNER_KEYS, ...V1_WIRE_KEYS]);
  for (const key of [...walk(parsed.value), ...Object.keys(NARROWING), ...LAYER_ENVELOPE_KEYS]) {
    for (const segment of key.split('.')) segments.add(segment.replace(/\[\]$/, ''));
  }
  return sources.flatMap(namedKeys).filter((name) => !segments.has(name)).sort();
}

test('D-19: every key a section parser names is accounted for', () => {
  const sources = SECTION_SOURCES.map((file) => readFileSync(path.join(REPO_ROOT, file), 'utf8'));
  const names = sources.flatMap(namedKeys);
  for (const name of ['maxLabel', 'tlsPins', 'regimes', 'officials', 'signers', 'personalApprovals', 'authorityExpiresAt', 'labelCeilings']) {
    assert.ok(names.includes(name), `the scan reads ${name}`);
  }
  assert.deepEqual(unaccounted(sources), []);
  assert.deepEqual(unaccounted([...sources, "const keys = checkKeys(value, path, ['plantedKey']);"]), ['plantedKey']);
});

const EXERCISE = { reason: 'Quarterly staff exercise, fictional data only.', setAt: '2026-11-19T12:00:00.000Z' };
const INTERNAL_LABEL = { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [] };

test('D-22: the project layer parses strictly', () => {
  const good = { v: 1, label: INTERNAL_LABEL, mode: 'corporate', exercise: EXERCISE, locked: { canada: true }, regimes: ['EAR'] };
  const parsed = parseProjectLayer(good, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  assert.deepEqual(parsed.value, good);
  assert.ok(Object.isFrozen(parsed.value));
  assert.ok(parseProjectLayer({ v: 1 }, SCALE_PRESETS).ok);
  const refusals: Array<[unknown, string, string]> = [
    [{ v: 1, colour: 'red' }, 'unknown-field', 'colour'],
    [{ v: 1, exercise: { ...EXERCISE, reason: '' } }, 'wrong-type', 'exercise.reason'],
    [{ v: 1, exercise: { reason: 'Drill' } }, 'missing-field', 'exercise.setAt'],
    [{ v: 1, label: { ...INTERNAL_LABEL, scale: 'unknown-scale' } }, 'not-allowed-here', 'label.scale'],
    [{ v: 2 }, 'unknown-version', 'v'],
    [{ v: 1, mode: 'Not A Mode' }, 'wrong-type', 'mode'],
    [{ v: 1, locked: { residency: true } }, 'unknown-field', 'locked.residency'],
    [{ v: 1, locked: { canada: 'yes' } }, 'wrong-type', 'locked.canada'],
    [{ v: 1, regimes: ['XYZ'] }, 'not-allowed-here', 'regimes[0]'],
    [{ v: 1, regimes: [] }, 'empty-list', 'regimes']
  ];
  for (const [value, reason, at] of refusals) {
    const result = parseProjectLayer(value, SCALE_PRESETS);
    assert.ok(!result.ok, JSON.stringify(value));
    assert.equal(result.reason, reason, JSON.stringify(value));
    assert.equal(result.path, at, JSON.stringify(value));
  }
});

function projectOf(value: unknown): ProjectLayer {
  const parsed = parseProjectLayer(value, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

test('D-22: the project mode is kept only within the organization\'s allowedModes, the organization\'s locked answers win, and the label and exercise flag are carried', () => {
  const org = organization((doc) => withSection(doc, 'onboarding', { v: 1, locked: { canada: true } }, 'onboarding@1'));
  const mine = personal();
  const project = projectOf({ v: 1, label: INTERNAL_LABEL, mode: 'corporate', exercise: EXERCISE, locked: { canada: false } });
  const composed = composeLayers({ organization: org, personal: mine, project });
  assert.deepEqual(composed.project?.label, INTERNAL_LABEL);
  assert.deepEqual(composed.project?.exercise, EXERCISE);
  assert.equal(composed.project?.mode, 'corporate', 'no allowedModes exist, so the mode is kept');
  assert.deepEqual(composed.project?.locked, { canada: true });
  assert.deepEqual(composed.ignored, [{ key: 'onboarding.locked.canada', layer: 'project', yours: 'false', allowed: 'true' }]);
  // The project layer never changes the effective policy.
  assert.deepEqual(plain(composed.effective), plain(composeLayers({ organization: org, personal: mine }).effective));
  // A locked answer that agrees with your organization's is kept and not listed.
  const agreeing = composeLayers({ organization: org, personal: mine, project: projectOf({ v: 1, locked: { canada: true } }) });
  assert.deepEqual(agreeing.ignored, []);
  // The effective policy's allowedModes decide the mode (people.organization arrives with 41-06; here it is set on the in-memory document).
  const withModes = Object.freeze({
    ...mine, people: Object.freeze({ v: 1, organization: Object.freeze({ mode: 'corporate', allowedModes: ['corporate', 'military'], projectMayChoose: true, settings: {} }) })
  }) as unknown as PolicyDocument;
  const refusedMode = composeLayers({ personal: withModes, project: projectOf({ v: 1, mode: 'academic' }) });
  assert.equal(refusedMode.effective, withModes);
  assert.equal(refusedMode.project?.mode, undefined);
  assert.deepEqual(refusedMode.ignored, [{ key: 'people.organization.mode', layer: 'project', yours: 'academic', allowed: 'corporate, military' }]);
  const keptMode = composeLayers({ personal: withModes, project: projectOf({ v: 1, mode: 'military' }) });
  assert.equal(keptMode.project?.mode, 'military');
  assert.deepEqual(keptMode.ignored, []);
});

test('D-60: a project layer may add export regimes and never remove one', () => {
  const org = organization((doc) => withSection(doc, 'exportControl', EXPORT(['ITAR'], { ITAR: 'empowered-official' }), 'export-control@1'));
  const composed = composeLayers({ organization: org, personal: personal(), project: projectOf({ v: 1, regimes: ['EAR'] }) });
  assert.deepEqual(composed.project?.regimes, ['EAR', 'ITAR']);
  assert.deepEqual(composed.effective.exportControl?.regimes, ['ITAR']);
  const none = composeLayers({ organization: org, personal: personal(), project: projectOf({ v: 1 }) });
  assert.deepEqual(none.project?.regimes, ['ITAR']);
  const refused = parseProjectLayer({ v: 1, regimes: ['ITAR', 'NOFORN'] }, SCALE_PRESETS);
  assert.ok(!refused.ok);
  assert.equal(refused.path, 'regimes[1]');
});
