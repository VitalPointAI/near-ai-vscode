// Layer composition (FND-01, Phase 41 D-18 to D-22, D-28, D-31, D-60, D-62): your organization's layer is the ceiling, the personal layer can only narrow
// it key by declared key, a wider personal value is replaced and listed (never a lock-out), and a new widening edit is named before it is signed.
// Keys are made at test time; every name is fictional.
import assert from 'node:assert/strict';
import test from 'node:test';
import { composeLayers } from '../domain/gate/layers';
import { bundleViewOf, parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { DAY_MS, FIXED_NOW, deviceKey, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

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
