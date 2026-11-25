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
  DAY_MS, FIXED_NOW, FIXTURE_PASSPORT_ID, authorizationFor, deviceKey, fixtureEndpoints, fixtureModelsSection, fixtureOrganizationBlock, fixturePassport,
  fullDocumentFor, issuerKey, policyDocumentFor, signAuthorization, signerEntry
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

test('IN-02: wideningOf compares whole values, not the shortened display text', () => {
  const org = organization((doc) => { doc.agents.mcp.unattended = ['srv-a']; });
  // Two wider lists whose display text shares its first 77 characters and is cut at 80: only the last server differs.
  const shared = ['a'.repeat(31), 'b'.repeat(31)];
  const base = personal((doc) => { doc.agents.mcp.unattended = ['srv-a', ...shared, `${'c'.repeat(30)}1`]; });
  const next = personal((doc) => { doc.agents.mcp.unattended = ['srv-a', ...shared, `${'c'.repeat(30)}2`]; });
  const before = composeLayers({ organization: org, personal: base }).ignored.find((entry) => entry.key === 'agents.mcp.unattended');
  const after = composeLayers({ organization: org, personal: next }).ignored.find((entry) => entry.key === 'agents.mcp.unattended');
  assert.ok(before !== undefined && after !== undefined, 'both lists are wider than your organization allows');
  assert.equal(before.yours, after.yours, 'the display text is the same for both');
  assert.ok(before.yours.endsWith('...'));
  // The new server is a new widening, refused before signing.
  const found = wideningOf(org, base, next);
  assert.equal(found?.key, 'agents.mcp.unattended');
  assert.equal(found?.allowed, 'srv-a');
  // The same clamped value again, or an unrelated edit beside it, is not refused.
  const same = personal((doc) => { doc.agents.mcp.unattended = ['srv-a', ...shared, `${'c'.repeat(30)}1`]; withSection(doc, 'limits', { v: 1, spend: { dailyNanoUsd: 50 } }, 'limits@1'); });
  assert.equal(wideningOf(org, base, same), undefined);
  assert.equal(wideningOf(org, base, base), undefined);
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

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Wave 2 merge: the models section (41-05, D-42) and people.organization (41-06, D-40)

/** The fixtures' models section with one edit applied, added to a plain document. */
function withModels(doc: Loose, edit: (models: Loose) => void = () => undefined): void {
  const models = plain(fixtureModelsSection());
  edit(models);
  withSection(doc, 'models', models, 'models@1');
}

const PASSPORT_KEY = `models.passports[${FIXTURE_PASSPORT_ID}]`;

test('D-42: every models key the walk holds has the direction its meaning needs', () => {
  const parsed = parsePolicyDocument(fullyFilled());
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  const paths = walk(parsed.value);
  const expected: Record<string, string> = {
    'models.mode': 'tier-stricter',
    'models.unknownMaxTier': 'tier-stricter',
    'models.tierByLevel.*': 'tier-stricter',
    'models.tierByProject.*': 'tier-stricter',
    'models.passports[].hosting': 'subset',
    'models.passports[].maxTier': 'organization-only',
    'models.passports[].match': 'organization-only',
    'models.passports[].lineage.teachers[].origin': 'organization-only',
    'models.passports[].artifact.remoteCode': 'organization-only',
    'models.passports[].evaluation.report': 'organization-only',
    'models.passports[].legal.entityList': 'organization-only',
    'models.defaults.*': 'organization-only',
    'models.localCatalogue[].minFitBand': 'organization-only',
    'models.localCatalogue[].artifacts[].licence.url': 'organization-only',
    'models.order': 'organization-only',
    'people.organization.mode': 'subset',
    'people.organization.allowedModes': 'organization-only',
    'people.organization.settings.mayDecline': 'boolean-safe',
    'people.organization.settings.overdueDays': 'number-lower'
  };
  for (const [key, direction] of Object.entries(expected)) {
    assert.ok(paths.has(key), `${key} is walked`);
    assert.equal(directionOf(key)?.direction, direction, key);
  }
  // The lists themselves (the walk goes into their items): catalogue membership narrows to fewer entries, passport membership is your organization's.
  assert.equal(directionOf('models.localCatalogue')?.direction, 'subset');
  assert.equal(directionOf(PASSPORT_KEY)?.direction, 'organization-only');
  // A request raised to a higher use tier needs a more trusted model, so the higher tier is the narrower one (useTierFor only raises).
  assert.deepEqual(NARROWING['models.tierByLevel.*']?.order, ['T0', 'T1', 'T2', 'T3']);
  assert.equal(NARROWING['models.tierByLevel.*']?.absent, 'weakest');
  // No entry under models covers a whole subtree: each key is declared on its own.
  assert.deepEqual(Object.keys(NARROWING).filter((key) => key.startsWith('models.') && NARROWING[key]?.subtree === true), []);
});

interface ModelsRow {
  readonly name: string;
  readonly key: string;
  readonly organization: (models: Loose) => void;
  readonly narrower: (models: Loose) => void;
  readonly wider: (models: Loose) => void;
  readonly read: (doc: PolicyDocument) => unknown;
  readonly narrowerValue: unknown;
  readonly organizationValue: unknown;
}

const MODELS_ROWS: readonly ModelsRow[] = [
  {
    name: 'mode report to enforce', key: 'models.mode',
    organization: (models) => { models.mode = 'enforce'; }, narrower: (models) => { models.mode = 'enforce'; }, wider: (models) => { models.mode = 'report'; },
    read: (doc) => doc.models?.mode, narrowerValue: 'enforce', organizationValue: 'enforce'
  },
  {
    name: 'a level raised to a higher use tier', key: 'models.tierByLevel.org/Internal',
    organization: (models) => { models.tierByLevel = { 'org/Internal': 'T1' }; },
    narrower: (models) => { models.tierByLevel = { 'org/Internal': 'T2' }; },
    wider: (models) => { models.tierByLevel = { 'org/Internal': 'T0' }; },
    read: (doc) => doc.models?.tierByLevel?.['org/Internal'], narrowerValue: 'T2', organizationValue: 'T1'
  },
  {
    name: 'a project kind raised to a higher use tier', key: 'models.tierByProject.staff',
    organization: (models) => { models.tierByProject = { staff: 'T2' }; },
    narrower: (models) => { models.tierByProject = { staff: 'T3' }; },
    wider: (models) => { models.tierByProject = { staff: 'T1' }; },
    read: (doc) => doc.models?.tierByProject?.['staff'], narrowerValue: 'T3', organizationValue: 'T2'
  },
  {
    name: 'a passport on fewer kinds of hosting', key: `${PASSPORT_KEY}.hosting`,
    organization: () => undefined,
    narrower: (models) => { models.passports[0].hosting = ['local']; },
    wider: (models) => { models.passports[0].hosting = ['closed-api', 'local', 'org-plain']; },
    read: (doc) => doc.models?.passports?.[0]?.hosting, narrowerValue: ['local'], organizationValue: ['local', 'org-plain']
  },
  {
    name: 'fewer local catalogue entries', key: 'models.localCatalogue',
    organization: () => undefined,
    narrower: (models) => { models.localCatalogue = []; },
    wider: (models) => { models.localCatalogue[0].minFitBand = 'phone-4gb'; },
    read: (doc) => doc.models?.localCatalogue?.map((entry) => entry.minFitBand), narrowerValue: [], organizationValue: ['laptop-16gb']
  },
  {
    name: 'your organization\'s preference order', key: 'models.order',
    organization: (models) => { models.passports = [fixturePassport(), fixturePassport({ id: 'example-model-8b', match: ['example/model-8b'] })]; models.order = [FIXTURE_PASSPORT_ID, 'example-model-8b']; },
    narrower: (models) => { models.passports = [fixturePassport(), fixturePassport({ id: 'example-model-8b', match: ['example/model-8b'] })]; models.order = [FIXTURE_PASSPORT_ID, 'example-model-8b']; },
    wider: (models) => { models.passports = [fixturePassport(), fixturePassport({ id: 'example-model-8b', match: ['example/model-8b'] })]; models.order = ['example-model-8b', FIXTURE_PASSPORT_ID]; },
    read: (doc) => doc.models?.order, narrowerValue: [FIXTURE_PASSPORT_ID, 'example-model-8b'], organizationValue: [FIXTURE_PASSPORT_ID, 'example-model-8b']
  }
];

test('D-42: each models direction composes both ways', () => {
  for (const row of MODELS_ROWS) {
    const org = organization((doc) => withModels(doc, row.organization));
    const kept = composeLayers({ organization: org, personal: personal((doc) => withModels(doc, (models) => { row.organization(models); row.narrower(models); })) });
    assert.deepEqual(row.read(kept.effective), row.narrowerValue, `${row.name}: the narrower personal value stays`);
    assert.deepEqual(kept.ignored, [], `${row.name}: nothing is listed`);
    const clamped = composeLayers({ organization: org, personal: personal((doc) => withModels(doc, (models) => { row.organization(models); row.wider(models); })) });
    assert.deepEqual(row.read(clamped.effective), row.organizationValue, `${row.name}: the wider personal value is replaced`);
    assert.deepEqual(keysOf(clamped.ignored), [row.key], `${row.name}: the wider value is listed`);
    assert.ok(parsePolicyDocument(plain(clamped.effective)).ok, `${row.name}: the effective policy parses`);
  }
});

test('D-42: a personal layer can neither add a passport nor drop, raise or lower one of your organization\'s', () => {
  const org = organization((doc) => withModels(doc, (models) => { models.passports[0].maxTier = 'T2'; }));
  // Added: a personal passport would give a model with no passport (T0) a tier, or replace a shipped passport by id. It is dropped and listed.
  const added = composeLayers({
    organization: org,
    personal: personal((doc) => withModels(doc, (models) => {
      models.passports[0].maxTier = 'T2';
      models.passports.push(fixturePassport({ id: 'example-model-9b', match: ['example/model-9b'] }));
    }))
  });
  assert.deepEqual(added.effective.models?.passports?.map((passport) => passport.id), [FIXTURE_PASSPORT_ID]);
  assert.deepEqual(keysOf(added.ignored), ['models.passports[example-model-9b]']);
  // Dropped: without your organization's passport, a shipped passport with its id, or a looser one that matches the same model, would take its place.
  const dropped = composeLayers({
    organization: org, personal: personal((doc) => withModels(doc, (models) => { models.passports = []; delete models.defaults; delete models.localCatalogue; delete models.order; }))
  });
  assert.deepEqual(dropped.effective.models?.passports?.map((passport) => passport.id), [FIXTURE_PASSPORT_ID]);
  // Raised and lowered: a lower tier changes which matching passport is the stricter and so which hosting applies; both stay your organization's.
  for (const tier of ['T3', 'T1']) {
    // A T1 passport cannot be the default for a job that needs T2, so that personal layer names no defaults (your organization's then apply).
    const changed = composeLayers({
      organization: org, personal: personal((doc) => withModels(doc, (models) => { models.passports[0].maxTier = tier; if (tier === 'T1') delete models.defaults; }))
    });
    assert.equal(changed.effective.models?.passports?.[0]?.maxTier, 'T2', tier);
    assert.deepEqual(changed.ignored, [{ key: `${PASSPORT_KEY}.maxTier`, layer: 'personal', yours: tier, allowed: 'T2' }], tier);
  }
  // Under your organization's empty models section, the personal passports, defaults, catalogue and order all go, and the result parses.
  const empty = composeLayers({ organization: organization((doc) => withSection(doc, 'models', { v: 1 }, 'models@1')), personal: personal((doc) => withModels(doc)) });
  assert.ok(parsePolicyDocument(plain(empty.effective)).ok);
  assert.deepEqual(empty.effective.models?.passports, []);
  assert.equal(empty.effective.models?.defaults, undefined);
  assert.deepEqual(keysOf(empty.ignored), [PASSPORT_KEY, 'models.defaults.standard', 'models.localCatalogue', 'models.order']);
  assert.ok(!empty.ignored.some((entry) => entry.key === 'personal layer'));
});

test('D-42: narrowingOf judges models changes by their rules', () => {
  assert.equal(narrowingOf('models.tierByLevel.org/Internal', 'T1', 'T2'), 'narrows');
  assert.equal(narrowingOf('models.tierByLevel.org/Internal', 'T2', 'T1'), 'widens');
  assert.equal(narrowingOf('models.tierByLevel.org/Internal', undefined, 'T1'), 'narrows');
  assert.equal(narrowingOf('models.mode', 'report', 'enforce'), 'narrows');
  assert.equal(narrowingOf(`${PASSPORT_KEY}.hosting`, ['local', 'org-plain'], ['local']), 'narrows');
  assert.equal(narrowingOf(`${PASSPORT_KEY}.hosting`, ['local'], ['closed-api', 'local']), 'widens');
  assert.equal(narrowingOf(`${PASSPORT_KEY}.maxTier`, 'T3', 'T1'), undefined);
  assert.equal(narrowingOf('models.order', ['a'], ['b']), undefined);
});

/** A personal layer with its own people.organization block, one edit applied. */
function personalBlock(edit: (block: Loose) => void): PolicyDocument {
  return personal((doc) => {
    const block = plain(fixtureOrganizationBlock());
    edit(block);
    doc.people.organization = block;
  });
}

test('D-40: people.organization composes under your organization\'s block', () => {
  const org = organization((doc) => { doc.people.organization = plain(fixtureOrganizationBlock()); });
  // Allowed: a mode your organization allows, a shorter overdue time, less delegation, a permission turned off, a duty turned on.
  const narrower = composeLayers({
    organization: org,
    personal: personalBlock((block) => {
      block.mode = 'military'; block.allowedModes = ['military']; block.projectMayChoose = false;
      block.settings = { ...block.settings, overdueDays: 1, maxDelegationDepth: 0 };
    })
  });
  const kept = narrower.effective.people?.organization;
  assert.equal(kept?.mode, 'military');
  assert.deepEqual(kept?.allowedModes, ['corporate', 'military']);
  assert.equal(kept?.projectMayChoose, false);
  assert.equal(kept?.settings.overdueDays, 1);
  assert.equal(kept?.settings.maxDelegationDepth, 0);
  assert.deepEqual(keysOf(narrower.ignored), ['people.organization.allowedModes']);
  // Refused: a mode your organization does not allow, a project choice it turned off, more delegation, a later overdue time, a permission it turned off.
  const wider = composeLayers({
    organization: organization((doc) => { doc.people.organization = { ...plain(fixtureOrganizationBlock()), projectMayChoose: false }; }),
    personal: personalBlock((block) => {
      block.mode = 'capital'; block.allowedModes = ['capital']; block.projectMayChoose = true;
      block.settings = { ...block.settings, overdueDays: 9, maxDelegationDepth: 2, acting: true };
    })
  });
  const clamped = wider.effective.people?.organization;
  assert.equal(clamped?.mode, 'corporate');
  assert.equal(clamped?.projectMayChoose, false);
  assert.equal(clamped?.settings.overdueDays, 3);
  assert.equal(clamped?.settings.maxDelegationDepth, 1);
  assert.equal(clamped?.settings.acting, false);
  assert.deepEqual(keysOf(wider.ignored).sort(), [
    'people.organization.allowedModes', 'people.organization.mode', 'people.organization.projectMayChoose', 'people.organization.settings.acting',
    'people.organization.settings.maxDelegationDepth', 'people.organization.settings.overdueDays'
  ]);
  assert.ok(parsePolicyDocument(plain(wider.effective)).ok);
});

test('D-40: a permission your organization leaves to the mode is never turned on by the personal layer, and a personal block with no organization block goes', () => {
  // Your organization writes no acting setting (the mode decides) and allows corporate, which does not offer acting.
  const org = organization((doc) => {
    const block = plain(fixtureOrganizationBlock());
    delete block.settings.acting;
    doc.people.organization = block;
  });
  const on = composeLayers({ organization: org, personal: personalBlock((block) => { block.mode = 'military'; block.allowedModes = ['military']; block.settings.acting = true; }) });
  assert.equal(on.effective.people?.organization?.settings.acting, undefined, 'the mode decides, as your organization left it');
  assert.ok(!keysOf(on.ignored).includes('people.organization.settings.acting'));
  assert.ok(!on.ignored.some((entry) => entry.key === 'personal layer'), 'the effective policy parses without the fallback');
  const off = composeLayers({ organization: org, personal: personalBlock((block) => { block.settings.acting = false; }) });
  assert.equal(off.effective.people?.organization?.settings.acting, false, 'turning a permission off stays');
  const none = composeLayers({ organization: organization(), personal: personalBlock(() => undefined) });
  assert.equal(none.effective.people?.organization, undefined);
  assert.deepEqual(keysOf(none.ignored), ['people.organization']);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// Phase 70.1 (D-17): lower layers only tighten the classification section

const CLS_SECRET = { scale: 'ca-classified', level: 'Secret', compartments: [], releasability: [], handling: [] };

function clsRule(id: string): Loose {
  return {
    id, guideRef: `SCG ${id}`, label: { ...CLS_SECRET, level: 'Confidential' }, description: 'A unit with its location and a future move date',
    when: { allOf: ['future-date', 'location', 'unit'], sameSubject: true }, then: CLS_SECRET
  };
}

function classificationSection(extra: Loose = {}): Loose {
  return {
    v: 1, systemHigh: [CLS_SECRET],
    thresholds: { 'ca-classified/Secret': { costRatio: 19, recallTarget: 9800, secondFamily: true } },
    shadow: { defaultMode: 'shadow', levels: [] },
    markings: [{ id: 'banner-secret', pattern: 'SECRET', label: CLS_SECRET }],
    guideRules: [clsRule('r-1'), clsRule('r-2')],
    ...extra
  };
}

function withClassification(doc: Loose, section: Loose): void {
  doc.classification = section;
  doc.requires = [...doc.requires, 'classification@1'].sort();
}

function composedClassification(org: Loose, mine: Loose): { section: Loose; ignored: readonly IgnoredSetting[] } {
  const composed = composeLayers({ organization: organization((doc) => withClassification(doc, org)), personal: personal((doc) => withClassification(doc, mine)) });
  return { section: composed.effective.classification as Loose, ignored: composed.ignored };
}

test('70.1 D-17: a personal layer may lower Secret\'s threshold (a higher cost ratio), and is kept and not listed', () => {
  const { section, ignored } = composedClassification(classificationSection(), classificationSection({ thresholds: { 'ca-classified/Secret': { costRatio: 49, recallTarget: 9900, secondFamily: true } } }));
  assert.deepEqual(section.thresholds['ca-classified/Secret'], { costRatio: 49, recallTarget: 9900, secondFamily: true });
  assert.deepEqual(ignored, []);
});

test('70.1 D-17: raising a threshold (a lower cost ratio) or dropping the second family is refused and listed', () => {
  const { section, ignored } = composedClassification(classificationSection(), classificationSection({ thresholds: { 'ca-classified/Secret': { costRatio: 9, recallTarget: 9800, secondFamily: false } } }));
  assert.deepEqual(section.thresholds['ca-classified/Secret'], { costRatio: 19, recallTarget: 9800, secondFamily: true });
  assert.deepEqual(ignored.map((entry) => entry.key), ['classification.thresholds.ca-classified/Secret']);
});

test('70.1 D-17: removing a rule is refused; adding a rule is kept', () => {
  const removed = composedClassification(classificationSection(), classificationSection({ guideRules: [clsRule('r-1')] }));
  assert.deepEqual(removed.section.guideRules.map((rule: Loose) => rule.id), ['r-1', 'r-2']);
  const added = composedClassification(classificationSection(), classificationSection({ guideRules: [clsRule('r-1'), clsRule('r-2'), clsRule('r-3')] }));
  assert.deepEqual(added.section.guideRules.map((rule: Loose) => rule.id), ['r-1', 'r-2', 'r-3']);
  assert.deepEqual(added.ignored, []);
  const changed = composedClassification(classificationSection(), classificationSection({ guideRules: [clsRule('r-1'), { ...clsRule('r-2'), then: { ...CLS_SECRET, level: 'Confidential' } }] }));
  assert.deepEqual(changed.section.guideRules[1].then, CLS_SECRET, 'your organization\'s rule stands');
  assert.deepEqual(changed.ignored.map((entry) => entry.key), ['classification.guideRules[r-2]']);
});

test('70.1 D-17: changing systemHigh is refused and listed', () => {
  const { section, ignored } = composedClassification(classificationSection(), classificationSection({ systemHigh: [{ ...CLS_SECRET, level: 'Top Secret' }] }));
  assert.deepEqual(section.systemHigh, [CLS_SECRET]);
  assert.ok(ignored.some((entry) => entry.key.startsWith('classification.systemHigh')));
});

test('70.1 D-17: moving a level from shadow to enforce is refused, by the default mode or by the levels list', () => {
  const byDefault = composedClassification(classificationSection(), classificationSection({ shadow: { defaultMode: 'enforce', levels: [] } }));
  assert.equal(byDefault.section.shadow.defaultMode, 'shadow');
  const byList = composedClassification(classificationSection(), classificationSection({ shadow: { defaultMode: 'shadow', levels: ['ca-classified/Secret'] } }));
  assert.deepEqual(byList.section.shadow.levels, []);
  assert.ok(byList.ignored.some((entry) => entry.key === 'classification.shadow.levels'));
});

test('70.1 D-17: adding a code word, a marking and a fact type is kept; your organization\'s code-word list label stands', () => {
  const orgWords = { listLabel: CLS_SECRET, entries: [{ id: 'cw-1', token: 'NORTHERNEXAMPLE', label: CLS_SECRET }] };
  const mineWords = { listLabel: { ...CLS_SECRET, level: 'Confidential' }, entries: [...orgWords.entries, { id: 'cw-2', token: 'SOUTHERNEXAMPLE', label: CLS_SECRET }] };
  const { section, ignored } = composedClassification(classificationSection({ codeWords: orgWords }), classificationSection({
    codeWords: mineWords, markings: [{ id: 'banner-secret', pattern: 'SECRET', label: CLS_SECRET }, { id: 'banner-tres-secret', pattern: 'TRÈS SECRET', label: CLS_SECRET }],
    factTypes: ['convoy-route']
  }));
  assert.deepEqual(section.codeWords.entries.map((entry: Loose) => entry.id), ['cw-1', 'cw-2']);
  assert.deepEqual(section.codeWords.listLabel, CLS_SECRET);
  assert.deepEqual(section.markings.map((entry: Loose) => entry.id), ['banner-secret', 'banner-tres-secret']);
  assert.deepEqual(section.factTypes, ['convoy-route']);
  assert.deepEqual(ignored, []);
});

test('70.1 D-17: review.jumpLevels may only fall, and topLevel may only turn on', () => {
  const lower = composedClassification(classificationSection({ review: { jumpLevels: 2, topLevel: false } }), classificationSection({ review: { jumpLevels: 1, topLevel: true } }));
  assert.equal(lower.section.review.jumpLevels, 1);
  assert.equal(lower.section.review.topLevel, true);
  const higher = composedClassification(classificationSection(), classificationSection({ review: { jumpLevels: 3, topLevel: false } }));
  assert.equal(higher.section.review.jumpLevels, 1);
  assert.equal(higher.section.review.topLevel, true);
  assert.deepEqual(higher.ignored.map((entry) => entry.key).sort(), ['classification.review.jumpLevels', 'classification.review.topLevel']);
});

test('70.1 D-17: a personal layer cannot change the roles, and without an organization section it cannot set the system-high or enforce', () => {
  const role = { passport: 'openai/gpt-oss', role: 'primary', levels: ['ca-classified/Secret'], evaluation: 'e'.repeat(64), since: '2026-11-24T00:00:00.000Z' };
  const roles = composedClassification(classificationSection(), classificationSection({ roles: [role] }));
  assert.deepEqual(roles.section.roles, []);
  const composed = composeLayers({ organization: organization(), personal: personal((doc) => withClassification(doc, classificationSection({ shadow: { defaultMode: 'enforce', levels: [] } }))) });
  const section = composed.effective.classification as Loose;
  assert.equal(section.systemHigh, undefined);
  assert.equal(section.shadow.defaultMode, 'shadow');
  assert.deepEqual(section.guideRules.map((rule: Loose) => rule.id), ['r-1', 'r-2'], 'the personal rules still tighten');
});

test('70.1 D-17: a newer organization layer may change anything in the section', () => {
  const org = organization((doc) => withClassification(doc, classificationSection({ shadow: { defaultMode: 'enforce', levels: [] }, guideRules: [] })));
  assert.equal(org.classification?.shadow.defaultMode, 'enforce');
  assert.deepEqual(org.classification?.guideRules, []);
});

test('70.1 D-17: an Edit Policy draft that lowers a threshold narrows; one that removes a rule or raises a threshold widens', () => {
  assert.equal(narrowingOf('classification.thresholds.ca-classified/Secret.costRatio', 19, 49), 'narrows');
  assert.equal(narrowingOf('classification.thresholds.ca-classified/Secret.costRatio', 19, 9), 'widens');
  assert.equal(narrowingOf('classification.guideRules[r-1]', clsRule('r-1'), undefined), 'widens');
  assert.equal(narrowingOf('classification.guideRules[r-3]', undefined, clsRule('r-3')), 'narrows');
  assert.equal(narrowingOf('classification.thresholds.ca-classified/Top Secret', undefined, { costRatio: 49, recallTarget: 9900, secondFamily: true }), 'narrows');
  assert.equal(narrowingOf('classification.systemHigh', [CLS_SECRET], []), undefined, 'your organization\'s alone');
  assert.equal(directionOf('classification.shadow.defaultMode')?.direction, 'organization-only');
});
