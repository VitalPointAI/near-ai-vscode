// The intake's decision core (48.3-01; D-02, D-03, D-04, D-15, D-16): the owner's policy and the state machine, as pure code. Every case passes
// `now`, so dates are exact; nothing here touches the network, a tool or a key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluate, licenceAllowed, mergePolicy, policyHash } from '../supply/lib/policy.mjs';
import { STATES, newRecord, openStates, overdue, transition } from '../supply/lib/states.mjs';

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

// Task 3: the whole state machine (D-15) and its invariants.
const A = { subject: '11111111-1111-4111-8111-111111111111', entity: 'entity-a', at: NOW.toISOString() };
const B = { subject: '22222222-2222-4222-8222-222222222222', entity: 'entity-b', at: NOW.toISOString() };
const evaluatedWith = (facts, at = NOW) => ({ type: 'evaluated', result: evaluate(facts, POLICY, at), policy: POLICY });
const inReview = (facts = variant('publisher-change')) => transition(quarantined(), evaluatedWith(facts), NOW);
const approvedRecord = () => transition(quarantined(), evaluatedWith(base('npm')), NOW);
const later = (days) => new Date(NOW.getTime() + days * DAY);

test('each transition of D-15', () => {
  const requested = newRecord({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }, 'intake', NOW);
  assert.equal(requested.state, 'requested');
  assert.equal(transition(requested, { type: 'gathered' }, NOW).state, 'quarantined');
  assert.equal(transition(quarantined(), evaluatedWith(variant('malware')), NOW).state, 'refused');
  assert.equal(transition(quarantined(), evaluatedWith(variant('fast-lane-without-reason')), NOW).state, 'waiting');
  assert.equal(inReview().state, 'in-review');
  assert.equal(approvedRecord().state, 'approved');

  const waiting = transition(quarantined(), evaluatedWith(variant('fast-lane-without-reason')), NOW);
  assert.throws(() => transition(waiting, evaluatedWith(variant('fast-lane-without-reason')), NOW), /not yet released/);
  const afterRelease = later(6);
  const moved = transition(waiting, evaluatedWith(variant('fast-lane-without-reason'), afterRelease), afterRelease);
  assert.deepEqual([moved.state, moved.decidedBy], ['approved', 'automatic']);
  assert.equal(transition(waiting, evaluatedWith(variant('malware')), NOW).state, 'refused', 'a hard gate ends a wait at once');
  assert.equal(transition(waiting, evaluatedWith({ ...variant('fast-lane-without-reason'), publisher: 'new-maintainer' }, afterRelease), afterRelease).state, 'in-review');

  assert.equal(transition(inReview(), { type: 'approve', approval: A }, NOW).state, 'approved');
  assert.equal(transition(inReview(), { type: 'refuse', by: A.subject, reason: 'typosquat' }, NOW).state, 'refused');
  const reviewAgain = transition(approvedRecord(), { type: 'finding', finding: { id: 'CVE-2026-1', severity: 'high', kev: false }, policy: POLICY }, NOW);
  assert.equal(reviewAgain.state, 'under-review-again');
  assert.equal(transition(approvedRecord(), { type: 'yanked', policy: POLICY }, NOW).state, 'under-review-again');
  assert.equal(transition(reviewAgain, { type: 'approve', approval: A, reference: 'vex:sha256:abc' }, NOW).state, 'approved');
  assert.throws(() => transition(reviewAgain, { type: 'approve', approval: A }, NOW), /VEX statement or an accepted risk/);
  assert.equal(transition(reviewAgain, { type: 'withdraw', by: A.subject, reason: 'confirmed bad' }, NOW).state, 'withdrawn');
});

test('every open state has an exit', () => {
  const samples = {
    requested: [newRecord({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0' }, 'intake', NOW), { type: 'gathered' }, NOW],
    quarantined: [quarantined(), evaluatedWith(base('npm')), NOW],
    waiting: [transition(quarantined(), evaluatedWith(variant('fast-lane-without-reason')), NOW), evaluatedWith(variant('fast-lane-without-reason'), later(6)), later(6)],
    'in-review': [inReview(), { type: 'refuse', by: A.subject, reason: 'no' }, NOW],
    approved: [approvedRecord(), { type: 'yanked', policy: POLICY }, NOW],
    'under-review-again': [transition(approvedRecord(), { type: 'yanked', policy: POLICY }, NOW), { type: 'withdraw', by: A.subject, reason: 'bad' }, NOW],
  };
  assert.deepEqual([...openStates()].sort(), Object.keys(samples).sort());
  assert.deepEqual([...STATES].sort(), [...openStates(), 'refused', 'withdrawn'].sort());
  for (const state of openStates()) {
    const [record, event, at] = samples[state];
    assert.equal(record.state, state);
    assert.notEqual(transition(record, event, at).state, state, `${state} has an exit`);
  }
  const final = [
    transition(quarantined(), evaluatedWith(variant('malware')), NOW),
    transition(transition(approvedRecord(), { type: 'yanked', policy: POLICY }, NOW), { type: 'withdraw', by: A.subject, reason: 'bad' }, NOW),
  ];
  for (const record of final) {
    for (const event of [{ type: 'gathered' }, evaluatedWith(base('npm')), { type: 'approve', approval: A, reference: 'x' }, { type: 'refuse', by: A.subject },
      { type: 'finding', finding: { id: 'x', kev: true }, policy: POLICY }, { type: 'yanked', policy: POLICY }, { type: 'withdraw', by: A.subject }]) {
      assert.throws(() => transition(record, event, NOW), new RegExp(`${event.type} is not possible while left-pad@1.3.0 is ${record.state}\\.`));
    }
  }
});

test('no stuck waits', () => {
  assert.throws(() => transition(quarantined(), { type: 'evaluated', result: { outcome: 'waiting', flags: [], approversNeeded: 0 }, policy: POLICY }, NOW), /releaseAt/);
  const review = inReview();
  assert.equal(review.ownerRole, 'supply-approver');
  assert.equal(review.dueAt, '2026-12-02T12:00:00.000Z', '5 working days from Wednesday 2026-11-25');
  const kev = transition(approvedRecord(), { type: 'finding', finding: { id: 'CVE-2026-2', severity: 'medium', kev: true }, policy: POLICY }, NOW);
  assert.deepEqual([kev.ownerRole, kev.dueAt], ['supply-approver', '2026-11-26T12:00:00.000Z']);
  const mal = transition(approvedRecord(), { type: 'finding', finding: { id: 'MAL-2026-3', mal: true }, policy: POLICY }, NOW);
  assert.equal(mal.dueAt, '2026-11-26T12:00:00.000Z');
  const friday = new Date('2026-11-27T12:00:00.000Z');
  const fridayKev = transition(approvedRecord(), { type: 'finding', finding: { id: 'CVE-2026-4', kev: true }, policy: POLICY }, friday);
  assert.equal(fridayKev.dueAt, '2026-11-30T12:00:00.000Z', 'Saturday and Sunday are skipped');
  const yanked = transition(approvedRecord(), { type: 'yanked', policy: POLICY }, NOW);
  assert.equal(yanked.dueAt, '2026-12-02T12:00:00.000Z');
  assert.equal(overdue(review, later(7)), false, 'at the due time it is not yet overdue');
  assert.equal(overdue(review, later(8)), true);
  assert.equal(overdue(review, later(1)), false);
  assert.equal(overdue(approvedRecord(), later(30)), false, 'only reviews can be overdue');
  const stillReview = { ...review };
  overdue(stillReview, later(30));
  assert.equal(stillReview.state, 'in-review', 'overdue never changes the state');
});

test('no approval without approvers', () => {
  const twoNeeded = inReview(variant('postinstall'));
  assert.equal(twoNeeded.approversNeeded, 2);
  const once = transition(twoNeeded, { type: 'approve', approval: A }, NOW);
  assert.equal(once.state, 'in-review');
  assert.deepEqual(once.approvals.map((a) => a.subject), [A.subject]);
  const twice = transition(once, { type: 'approve', approval: { ...A, at: later(1).toISOString() } }, later(1));
  assert.equal(twice.state, 'in-review', 'the same subject twice counts once');
  assert.equal(twice.approvals.length, 1);
  const done = transition(twice, { type: 'approve', approval: B }, later(1));
  assert.deepEqual([done.state, done.decidedBy], ['approved', 'people']);
  assert.throws(() => transition(twoNeeded, { type: 'approve', approval: { entity: 'x' } }, NOW), /subject/);
  assert.throws(() => transition(quarantined(), { type: 'evaluated', result: { outcome: 'checks-passed', flags: ['licence'], approversNeeded: 1 }, policy: POLICY }, NOW), /automatic approval/);
  assert.throws(() => transition(quarantined(), { type: 'evaluated', result: { outcome: 'in-review', flags: ['licence'], approversNeeded: 0 }, policy: POLICY }, NOW), /approver/);
  const kev = transition(approvedRecord(), { type: 'finding', finding: { id: 'CVE-2026-2', kev: true }, policy: POLICY }, NOW);
  assert.equal(kev.approversNeeded, 2, 'a KEV match needs two approvers to return to approved (D-28)');
  assert.deepEqual(kev.approvals, [], 'earlier approvals do not count again');
  assert.equal(transition(kev, { type: 'approve', approval: A, reference: 'vex:1' }, NOW).state, 'under-review-again');
});

test('nothing deleted', () => {
  const steps = [];
  let record = newRecord({ ecosystem: 'npm', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' }, 'intake', NOW);
  for (const [event, at] of [
    [{ type: 'gathered' }, NOW],
    [evaluatedWith(variant('publisher-change')), NOW],
    [{ type: 'approve', approval: A }, NOW],
    [{ type: 'finding', finding: { id: 'CVE-2026-5', severity: 'high' }, policy: POLICY }, later(2)],
    [{ type: 'withdraw', by: B.subject, reason: 'confirmed bad' }, later(3)],
  ]) {
    const next = transition(record, event, at);
    for (const key of Object.keys(record)) assert.ok(Object.hasOwn(next, key), `${event.type} keeps ${key}`);
    assert.deepEqual(next.history.slice(0, record.history.length), record.history, `${event.type} keeps the history`);
    assert.deepEqual(next.artefact, record.artefact);
    steps.push(next);
    record = next;
  }
  assert.equal(record.state, 'withdrawn');
  assert.equal(record.withdrawnAt, later(3).toISOString());
  assert.equal(record.withdrawnBy, B.subject);
  assert.deepEqual(record.previousApprovals.map((a) => a.subject), [A.subject], 'the approvals before the finding are kept');
  assert.equal(record.history.length, 5);
  assert.equal(Object.isFrozen(STATES), true);
});
