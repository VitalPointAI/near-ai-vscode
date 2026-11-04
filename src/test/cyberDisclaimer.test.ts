// The per-engagement disclaimer gate (D-13, D-17, D-18, CYBER-03). The modal itself is panel work in
// 25-07; what this file pins is the semantics every run depends on: no mode starts without an accepted
// record, declining leaves the target untouched, a nameless acceptor is refused, and a stale acceptance
// is refused until it is re-accepted. `gateRun` is the helper the panel's Run button will follow.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { CyberMode, DisclaimerAcceptance, ResolvedScope, Target } from '../domain/cyber';
import { isoTimestamp } from '../domain/cyber';
import type { AcceptanceRecord } from '../domain/cyberLegal';
import { needsReacceptance, REGION_CATALOGUE, scopeFingerprint } from '../domain/cyberLegal';

/** What a run attempt asks for: the modes the engagement allows and the scope it resolved. */
interface RunRequest {
  modes: CyberMode[];
  target: Target;
  resolvedScope: ResolvedScope;
  extensionVersion: string;
  /** The region the engagement now names; a change from the accepted one voids the acceptance (D-18). */
  region: string;
}

interface AcceptedChoice {
  choice: 'accepted';
  acceptance: AcceptanceRecord;
}

interface DeclinedChoice {
  choice: 'declined';
  acceptance: AcceptanceRecord;
}

type GateChoice = AcceptedChoice | DeclinedChoice;

interface Refusal {
  kind: 'refused';
  reason: string;
}

interface Started {
  kind: 'started';
  modes: CyberMode[];
}

type GateResult = Refusal | Started;

const scope: ResolvedScope = { hosts: ['example.com'], ports: [443], paths: ['/'], exclusions: [] };

const request: RunRequest = {
  modes: ['passive', 'active', 'intrusive'],
  target: { kind: 'url', value: 'https://example.com/' },
  resolvedScope: scope,
  extensionVersion: '0.4.10',
  region: 'us'
};

const record = (overrides: Partial<AcceptanceRecord> = {}): AcceptanceRecord => ({
  acceptor: 'Example Organisation Ltd',
  osUser: 'sample-user',
  machine: 'sample-workstation',
  extensionVersion: '0.4.10',
  textVersion: REGION_CATALOGUE.us.textVersion,
  region: 'us',
  acceptedAt: isoTimestamp('2026-11-02T00:00:00Z'),
  scope: scopeFingerprint(scope),
  ...overrides
});

/**
 * The gate a Run button follows: validate the acceptance record, then the D-18 freshness rules, and
 * only then decide. A refusal never mutates the request — the target and scope stay as they were.
 */
function gateRun(attempt: RunRequest, choice: GateChoice): GateResult {
  if (choice.choice === 'declined') return { kind: 'refused', reason: 'the disclaimer was declined' };
  const acceptance: DisclaimerAcceptance = choice.acceptance;
  if (!acceptance.acceptor.trim()) return { kind: 'refused', reason: 'a legal name or organization is required' };
  if (!acceptance.osUser.trim() || !acceptance.machine.trim()) return { kind: 'refused', reason: 'the acceptance is missing the OS user or machine' };
  if (!acceptance.acceptedAt) return { kind: 'refused', reason: 'the acceptance has no timestamp' };
  const entry = REGION_CATALOGUE[acceptance.region as keyof typeof REGION_CATALOGUE];
  if (!entry) return { kind: 'refused', reason: `the region "${acceptance.region}" is not in the catalogue` };
  const stale = needsReacceptance(choice.acceptance, {
    region: attempt.region,
    scope: scopeFingerprint(attempt.resolvedScope),
    extensionVersion: attempt.extensionVersion,
    textVersion: entry.textVersion
  });
  if (stale) return { kind: 'refused', reason: 'the acceptance is stale for this scope or version; re-accept it' };
  const allowed = attempt.modes.filter((mode) => request.modes.includes(mode));
  if (!allowed.length) return { kind: 'refused', reason: 'the engagement allows no modes' };
  return { kind: 'started', modes: allowed };
}

test('an accepted complete record allows passive, active, and intrusive modes', () => {
  for (const mode of request.modes) {
    const result = gateRun(request, { choice: 'accepted', acceptance: record() });
    assert.equal(result.kind, 'started');
    assert.deepEqual(result.kind === 'started' ? result.modes : [], request.modes);
    assert.ok(mode.length > 0);
  }
});

test('declining leaves the target and scope untouched and creates no run', () => {
  const targetBefore = JSON.stringify(request.target);
  const scopeBefore = JSON.stringify(request.resolvedScope);
  const result = gateRun(request, { choice: 'declined', acceptance: record() });
  assert.equal(result.kind, 'refused');
  assert.match(result.kind === 'refused' ? result.reason : '', /declined/i);
  assert.equal(JSON.stringify(request.target), targetBefore);
  assert.equal(JSON.stringify(request.resolvedScope), scopeBefore);
});

test('an acceptance with no legal name is refused', () => {
  const result = gateRun(request, { choice: 'accepted', acceptance: record({ acceptor: '   ' }) });
  assert.equal(result.kind, 'refused');
  assert.match(result.kind === 'refused' ? result.reason : '', /legal name/i);
});

test('an acceptance from a changed extension version is refused until it is re-accepted', () => {
  const stale = gateRun(request, { choice: 'accepted', acceptance: record({ extensionVersion: '0.4.9' }) });
  assert.equal(stale.kind, 'refused');
  assert.match(stale.kind === 'refused' ? stale.reason : '', /re-accept/i);
  const fresh = gateRun({ ...request, extensionVersion: '0.4.9' }, { choice: 'accepted', acceptance: record({ extensionVersion: '0.4.9' }) });
  assert.equal(fresh.kind, 'started');
});
