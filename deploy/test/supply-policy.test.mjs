// The intake's decision core (48.3-01; D-02, D-03, D-04, D-15, D-16): the owner's policy and the state machine, as pure code. Every case passes
// `now`, so dates are exact; nothing here touches the network, a tool or a key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluate, licenceAllowed, mergePolicy, policyHash } from '../supply/lib/policy.mjs';
import { transition, newRecord } from '../supply/lib/states.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY = JSON.parse(readFileSync(path.join(ROOT, 'deploy/supply/policy.json'), 'utf8'));
const NOW = new Date('2026-11-25T12:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY).toISOString();

/** A clean npm version: every gate passes. */
const cleanNpm = (overrides = {}) => ({
  ecosystem: 'npm',
  name: 'left-pad',
  version: '1.3.0',
  purl: 'pkg:npm/left-pad@1.3.0',
  integrity: 'sha512-abc',
  integrityExpected: 'sha512-abc',
  registrySignature: 'valid',
  publishedAt: daysAgo(8),
  gatheredAt: NOW.toISOString(),
  scripts: {},
  licence: 'MIT',
  approvedNames: ['left-pad'],
  publisher: 'stevemao',
  previous: { publisher: 'stevemao', provenance: false, repository: null },
  provenance: { present: false, verified: false, repository: null },
  mal: [],
  findings: [],
  source: { kind: 'registry', url: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' },
  ...overrides,
});

const quarantined = () => transition(newRecord({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }, 'intake', NOW), { type: 'gathered' }, NOW);

test('clean version is approved automatically', () => {
  const result = evaluate(cleanNpm(), POLICY, NOW);
  assert.equal(result.outcome, 'checks-passed');
  assert.deepEqual(result.flags, []);
  assert.equal(result.approversNeeded, 0);
  const record = transition(quarantined(), { type: 'evaluated', result, policy: POLICY }, NOW);
  assert.equal(record.state, 'approved');
  assert.equal(record.decidedBy, 'automatic');
  assert.deepEqual(record.history.map((h) => h.to), ['quarantined', 'approved']);
});

test('young version waits', () => {
  const publishedAt = daysAgo(3);
  const result = evaluate(cleanNpm({ publishedAt }), POLICY, NOW);
  assert.equal(result.outcome, 'waiting');
  assert.equal(result.releaseAt, new Date(Date.parse(publishedAt) + 7 * DAY).toISOString());
  const record = transition(quarantined(), { type: 'evaluated', result, policy: POLICY }, NOW);
  assert.equal(record.state, 'waiting');
  assert.equal(record.releaseAt, result.releaseAt);
});

test('policy hash', () => {
  const canonical = (value) => (Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
      : JSON.stringify(value));
  const expected = createHash('sha256').update(canonical(POLICY)).digest('hex');
  assert.equal(policyHash(POLICY), expected);
  const reordered = Object.fromEntries(Object.entries(POLICY).reverse());
  assert.equal(policyHash(reordered), expected, 'key order does not change the hash');
  assert.notEqual(policyHash({ ...POLICY, minAgeDays: 8 }), expected);
});

// Task 2: every gate (D-16), the licence expressions (D-04), the approver counts and the fast lane (D-02, D-03), tighten-only site policy.
const FACTS = JSON.parse(readFileSync(path.join(ROOT, 'deploy/test/fixtures/supply/facts.json'), 'utf8'));
const base = (ecosystem) => structuredClone(FACTS.base[ecosystem]);
const variant = (name) => {
  const v = FACTS.variants[name];
  assert.ok(v, `fixture variant ${name}`);
  return { ...base(v.from), ...structuredClone(v.set) };
};
const judge = (facts) => evaluate(facts, POLICY, NOW);

for (const [name, gate] of [
  ['integrity-mismatch', 'integrity'],
  ['registry-signature-invalid', 'registry-signature'],
  ['registry-signature-missing', 'registry-signature'],
  ['malware', 'malware'],
  ['kev', 'kev'],
  ['critical-with-fix', 'critical-with-fix'],
  ['git-source', 'source-form'],
  ['http-source', 'source-form'],
  ['file-source', 'source-form'],
  ['tarball-off-registry', 'source-form'],
  ['name-too-long', 'name'],
]) {
  test(`refused: ${name}`, () => {
    const result = judge(variant(name));
    assert.equal(result.outcome, 'refused');
    assert.equal(result.refusedBy, gate);
    assert.deepEqual(result.flags, [], 'a refused item has no flags to review');
  });
}

for (const [name, flag] of [
  ['new-name', 'new-name'],
  ['similar-name', 'similar-name'],
  ['scope-mismatch', 'scope-mismatch'],
  ['licence-gpl', 'licence'],
  ['licence-agpl', 'licence'],
  ['licence-missing', 'licence'],
  ['licence-unknown', 'licence'],
  ['provenance-regression', 'provenance-regression'],
  ['repository-changed', 'repository-changed'],
  ['publisher-change', 'publisher-change'],
  ['high-finding', 'high-finding'],
]) {
  test(`in review with one approver: ${name}`, () => {
    const result = judge(variant(name));
    assert.equal(result.outcome, 'in-review');
    assert.ok(result.flags.includes(flag), `flag ${flag} in ${result.flags}`);
    assert.equal(result.approversNeeded, 1);
  });
}

test('provenance that is present but did not verify goes to review', () => {
  const result = judge({ ...base('npm'), provenance: { present: true, verified: false, repository: 'https://github.com/stevemao/left-pad' } });
  assert.deepEqual([result.outcome, result.flags, result.approversNeeded], ['in-review', ['provenance-unverified'], 1]);
});

test('a critical finding without a fix is recorded, not gated', () => {
  assert.equal(judge(variant('critical-without-fix')).outcome, 'checks-passed');
});

test('install scripts need two approvers', () => {
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
    const result = judge({ ...base('npm'), scripts: { [script]: 'node x.js' } });
    assert.equal(result.outcome, 'in-review', script);
    assert.deepEqual(result.flags, ['install-script'], script);
    assert.equal(result.approversNeeded, 2, script);
  }
  const flagged = judge(variant('has-install-script'));
  assert.deepEqual([flagged.outcome, flagged.flags, flagged.approversNeeded], ['in-review', ['install-script'], 2]);
});

test('several flags need the largest count, never the sum', () => {
  const result = judge(variant('install-script-and-flags'));
  assert.equal(result.outcome, 'in-review');
  assert.deepEqual([...result.flags].sort(), ['install-script', 'licence', 'publisher-change']);
  assert.equal(result.approversNeeded, 2);
});

test('refusals come before flags', () => {
  const result = judge(variant('refused-and-flagged'));
  assert.deepEqual([result.outcome, result.refusedBy, result.flags], ['refused', 'malware', []]);
});

test('licence expressions', () => {
  const allowed = (expression, separateComponent = false) => licenceAllowed(expression, POLICY, { separateComponent });
  assert.equal(allowed('MIT OR GPL-3.0-only'), 'pass');
  assert.equal(allowed('MIT AND GPL-3.0-only'), 'review');
  assert.equal(allowed('(Apache-2.0 OR MIT) AND BSD-3-Clause'), 'pass');
  assert.equal(allowed('LGPL-2.1-or-later', true), 'pass');
  assert.equal(allowed('LGPL-2.1-or-later'), 'review');
  assert.equal(allowed('MPL-2.0', true), 'pass');
  assert.equal(allowed('Apache-2.0 WITH LLVM-exception'), 'pass');
  assert.equal(allowed('GPL-2.0-only WITH Classpath-exception-2.0'), 'review');
  assert.equal(allowed('(MIT OR'), 'unparseable');
  assert.equal(allowed('MIT AND AND ISC'), 'unparseable');
  assert.equal(allowed(''), 'review');
  assert.equal(allowed(null), 'review');
  assert.equal(allowed('mit'), 'pass', 'SPDX ids match without case');
  assert.equal(allowed('x'.repeat(5000)), 'review', 'an odd string never throws');
});

test('an unparseable licence expression goes to review', () => {
  const result = judge({ ...base('npm'), licence: 'MIT AND (' });
  assert.deepEqual([result.outcome, result.flags, result.licence], ['in-review', ['licence'], 'unparseable']);
});

test('fast lane: two approvers and a reason', () => {
  const result = judge(variant('fast-lane'));
  assert.equal(result.outcome, 'in-review');
  assert.deepEqual(result.flags, ['fast-lane']);
  assert.equal(result.approversNeeded, 2);
  assert.equal(result.fastLane.reason, 'GHSA-xxxx-yyyy-zzzz');
  const without = judge(variant('fast-lane-without-reason'));
  assert.equal(without.outcome, 'waiting');
  assert.equal(without.releaseAt, '2026-11-30T12:00:00.000Z');
});

test('every ecosystem uses the same evaluator', () => {
  for (const ecosystem of ['image', 'go', 'maven', 'pypi', 'rpm']) {
    const result = judge(base(ecosystem));
    assert.equal(result.outcome, 'checks-passed', `${ecosystem}: ${JSON.stringify(result)}`);
  }
});

test('an image without a publish time ages from gatheredAt and records its licence', () => {
  const clean = judge(base('image'));
  assert.equal(clean.licence, 'recorded', 'base images carry many licences: recorded, not gated');
  const young = judge(variant('image-no-publish-time-young'));
  assert.deepEqual([young.outcome, young.releaseAt], ['waiting', '2026-12-01T12:00:00.000Z']);
});

test('a Maven artefact with only a recorded hash adds no flag (G520)', () => {
  const result = judge(variant('maven-recorded-hash-only'));
  assert.deepEqual([result.outcome, result.flags], ['checks-passed', []]);
});

test('an artefact without a date cannot be aged and is refused', () => {
  const result = judge(variant('no-dates'));
  assert.deepEqual([result.outcome, result.refusedBy], ['refused', 'age']);
});

test('a site policy may tighten the defaults', () => {
  const merged = mergePolicy(POLICY, { minAgeDays: 10, approvers: { flagged: 2 }, licences: { allow: POLICY.licences.allow.filter((l) => l !== 'ISC') } });
  assert.equal(merged.minAgeDays, 10);
  assert.equal(merged.approvers.flagged, 2);
  assert.equal(merged.approvers.installScript, 2);
  assert.ok(!merged.licences.allow.includes('ISC'));
  const older = { ...base('npm'), publishedAt: '2026-11-10T12:00:00.000Z' };
  assert.equal(evaluate({ ...older, licence: 'ISC' }, POLICY, NOW).outcome, 'checks-passed');
  assert.equal(evaluate({ ...older, licence: 'ISC' }, merged, NOW).outcome, 'in-review');
  assert.equal(evaluate({ ...older, publisher: 'new-maintainer' }, merged, NOW).approversNeeded, 2);
  assert.equal(evaluate({ ...base('npm'), publishedAt: '2026-11-17T12:00:00.000Z' }, merged, NOW).outcome, 'waiting');
  assert.deepEqual(mergePolicy(POLICY, undefined), POLICY);
});

test('a site policy may not loosen the defaults', () => {
  const looser = (site, field, value, dflt) => assert.throws(() => mergePolicy(POLICY, site), {
    message: `Your organization's supply policy may only tighten the defaults: ${field} ${value} is looser than ${dflt}.`,
  });
  looser({ minAgeDays: 3 }, 'minAgeDays', 3, 7);
  looser({ approvers: { flagged: 0 } }, 'approvers.flagged', 0, 1);
  looser({ licences: { allow: [...POLICY.licences.allow, 'GPL-3.0-only'] } }, 'licences.allow', 'GPL-3.0-only', 'the default list');
  looser({ vulnerabilities: { refuse: ['kev'] } }, 'vulnerabilities.refuse', 'without critical-with-fix', 'kev, critical-with-fix');
  looser({ review: { dueWorkingDays: 10 } }, 'review.dueWorkingDays', 10, 5);
  assert.throws(() => mergePolicy(POLICY, { fastLane: { needsReason: false } }), /may only tighten the defaults: fastLane.needsReason false/);
  assert.throws(() => mergePolicy(POLICY, { version: 2 }), /may only tighten the defaults: version cannot be set by your organization/);
});
