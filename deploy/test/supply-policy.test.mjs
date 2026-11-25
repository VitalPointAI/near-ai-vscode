// The intake's decision core (48.3-01; D-02, D-03, D-04, D-15, D-16): the owner's policy and the state machine, as pure code. Every case passes
// `now`, so dates are exact; nothing here touches the network, a tool or a key.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { evaluate, policyHash } from '../supply/lib/policy.mjs';
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
