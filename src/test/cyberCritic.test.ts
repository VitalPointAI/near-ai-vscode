// The critic (CYBER-05, D-22): a finding is verified only by a reproduction command or stored
// evidence, an unverified finding says what is missing, a bounded re-probe can upgrade it, and the
// bound is never exceeded. A not-vulnerable verdict is never rendered as clean.

import assert from 'node:assert/strict';
import test from 'node:test';
import { criticLabel, REPROBE_ATTEMPTS, reProbe, verifyFinding } from '../agent/cyberCritic';
import type { Finding } from '../domain/cyber';

const base: Finding = {
  id: 'missing-hsts-1',
  checkId: 'missing-hsts',
  title: 'Strict-Transport-Security header is missing',
  severity: 'medium',
  verdict: 'could_not_determine',
  cvssVector: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N',
  cwes: [],
  wstg: ['WSTG-CONF-02'],
  evidenceExcerpt: '200 OK',
  evidenceHash: 'c'.repeat(64),
  reproductionCommand: "curl -sS -I 'https://example.test/'",
  remediation: 'Send HSTS.'
};

const storeWith = (hashes: string[]) => ({ has: async (hash: string) => hashes.includes(hash) });

test('a finding with a reproduction command and a stored blob verifies', async () => {
  const result = await verifyFinding(base, storeWith([base.evidenceHash]));
  assert.equal(result.verified, true);
  assert.match(result.reason, /reproduction command and a stored evidence blob/);
});

test('a finding with neither support is unverified and the reason names what is missing', async () => {
  const bare: Finding = { ...base, reproductionCommand: '', evidenceHash: '' };
  const result = await verifyFinding(bare, storeWith([]));
  assert.equal(result.verified, false);
  assert.match(result.reason, /^Unverified: /);
  assert.match(result.reason, /no evidence hash/);
  assert.match(result.reason, /no reproduction command/);

  const knownButMissing = await verifyFinding({ ...base, reproductionCommand: '' }, storeWith([]));
  assert.equal(knownButMissing.verified, false);
  assert.match(knownButMissing.reason, /is not in the store/);
});

test('a re-probe that confirms the finding upgrades it and keeps the confirming evidence hash', async () => {
  const bare: Finding = { ...base, reproductionCommand: '', evidenceHash: '' };
  const recorded: Array<{ attempt: number; output: string }> = [];
  const result = await reProbe(bare, async (_finding, attempt) => ({ output: attempt === 1 ? 'nothing useful' : 'strict-transport-security: missing', evidenceHash: 'd'.repeat(64) }), {
    confirmPattern: /strict-transport-security: missing/i,
    onEvidence: (attempt, output) => { recorded.push({ attempt, output: output.output }); return undefined; }
  });
  assert.equal(result.verified, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.finding.evidenceHash, 'd'.repeat(64));
  assert.match(result.reason, /Attempt 2 reproduced/);
  assert.equal(recorded.length, 2, 'every attempt is recorded as evidence');
});

test('re-probing is bounded at two attempts and says so when they are exhausted', async () => {
  let calls = 0;
  const result = await reProbe({ ...base, reproductionCommand: '', evidenceHash: '' }, async () => { calls += 1; return { output: 'no match here' }; }, { confirmPattern: /never-appears/ });
  assert.equal(calls, REPROBE_ATTEMPTS);
  assert.equal(REPROBE_ATTEMPTS, 2);
  assert.equal(calls, 2, 'the probe is called exactly twice, never three times');
  assert.equal(result.verified, false);
  assert.match(result.reason, /re-probe attempts exhausted after 2/);
});

test('a probe that throws does not exceed the bound either', async () => {
  let calls = 0;
  const result = await reProbe(base, async () => { calls += 1; throw new Error('probe unreachable'); }, { confirmPattern: /x/ });
  assert.equal(calls, 2);
  assert.equal(result.verified, false);
  assert.match(result.reason, /attempt 2 failed: probe unreachable/);
});

test('a not-vulnerable verdict is never rendered as clean', () => {
  const unverified = criticLabel({ ...base, verdict: 'not_vulnerable' }, false);
  assert.match(unverified, /unverified/);
  assert.match(unverified, /not vulnerable by exploit attempt only/);
  assert.doesNotMatch(unverified, /\(verified\)|clean/i);

  const failedExploit = criticLabel({ ...base, verdict: 'exploit_failed' }, false);
  assert.match(failedExploit, /vulnerable, exploit did not succeed/);

  assert.match(criticLabel(base, true), /\(verified\)/);
});
