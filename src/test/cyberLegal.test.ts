// The legal catalogue (D-13..D-18, CYBER-03): all twelve regions present with a plain-language
// statement naming the statute and the own-or-authorized confirmation, locale detection that fails
// safe to `us` with a visible override, the four re-acceptance triggers, and the public-sector warning
// tier that warns but never blocks.

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResolvedScope } from '../domain/cyber';
import {
  AcceptanceRecord,
  publicSectorWarning,
  REGION_CATALOGUE,
  REGION_CODES,
  regionEntry,
  detectRegion,
  DEFAULT_REGION,
  LEGAL_NAME_PROMPT,
  needsReacceptance,
  scopeFingerprint
} from '../domain/cyberLegal';

const acceptance: AcceptanceRecord = {
  acceptor: 'Example Organisation Ltd',
  osUser: 'sample-user',
  machine: 'sample-workstation',
  extensionVersion: '0.4.10',
  textVersion: REGION_CATALOGUE.us.textVersion,
  region: 'us',
  acceptedAt: '2026-11-02T00:00:00Z',
  scope: '{"hosts":["example.com"],"ports":[443],"paths":["/"],"exclusions":[]}'
};

const current = {
  region: 'us',
  scope: acceptance.scope,
  extensionVersion: '0.4.10',
  textVersion: REGION_CATALOGUE.us.textVersion
};

test('all twelve regions ship a statement naming the statute and the own-or-authorized confirmation', () => {
  assert.equal(REGION_CODES.length, 12);
  assert.equal(Object.keys(REGION_CATALOGUE).length, 12);
  for (const code of REGION_CODES) {
    const entry = REGION_CATALOGUE[code];
    assert.equal(entry.code, code);
    assert.ok(entry.name.length > 0, `${code} has a name`);
    assert.ok(entry.statute.length > 0, `${code} names its statute`);
    assert.match(entry.statement, /authoriz/i, `${code} states the authorization confirmation`);
    assert.match(entry.statement, /own /i, `${code} states ownership`);
    assert.ok(entry.textVersion.length > 0, `${code} carries a text version`);
    assert.equal(entry.ownerReview, 'reviewed', `${code} has had owner review`);
  }
});

test('locale detection maps representative timezones and falls back to us', () => {
  assert.equal(detectRegion('Europe/London'), 'uk');
  assert.equal(detectRegion('Europe/Berlin'), 'eu');
  assert.equal(detectRegion('America/New_York'), 'us');
  assert.equal(detectRegion('Australia/Sydney'), 'au');
  assert.equal(detectRegion('Pacific/Auckland'), 'nz');
  assert.equal(detectRegion('Asia/Tokyo'), 'jp');
  assert.equal(detectRegion('Asia/Kolkata'), 'in');
  assert.equal(detectRegion('America/Sao_Paulo'), 'br');
  assert.equal(detectRegion('Africa/Johannesburg'), 'za');
  assert.equal(detectRegion('Asia/Singapore'), 'sg');
  assert.equal(detectRegion('Asia/Dubai'), 'ae');
  assert.equal(detectRegion('Mars/Olympus_Mons'), DEFAULT_REGION);
  assert.equal(detectRegion(undefined), 'us');
});

test('re-acceptance flips on region, scope, extension version, or text version, and stays false otherwise', () => {
  assert.equal(needsReacceptance(acceptance, current), false);
  assert.equal(needsReacceptance(acceptance, { ...current, region: 'uk' }), true);
  assert.equal(needsReacceptance(acceptance, { ...current, scope: '{"hosts":["other.example"],"ports":[],"paths":[],"exclusions":[]}' }), true);
  assert.equal(needsReacceptance(acceptance, { ...current, extensionVersion: '0.4.11' }), true);
  assert.equal(needsReacceptance(acceptance, { ...current, textVersion: '2027-01-01' }), true);
});

test('the scope fingerprint is order-independent over hosts, ports, paths, and exclusions', () => {
  const left: ResolvedScope = { hosts: ['B.example', 'a.example'], ports: [443, 80], paths: ['/'], exclusions: [] };
  const right: ResolvedScope = { hosts: ['a.example', 'b.example'], ports: [80, 443], paths: ['/'], exclusions: [] };
  assert.equal(scopeFingerprint(left), scopeFingerprint(right));
  assert.notEqual(scopeFingerprint(left), scopeFingerprint({ ...right, exclusions: ['.git'] }));
});

test('public-sector and metadata targets are warned, never blocked', () => {
  assert.match(String(publicSectorWarning('https://example.gov/')), /public-sector/i);
  assert.match(String(publicSectorWarning('https://host.gov.uk/')), /public-sector/i);
  assert.match(String(publicSectorWarning('https://example.mil/')), /public-sector/i);
  assert.match(String(publicSectorWarning('http://169.254.169.254/latest/meta-data/')), /metadata/i);
  assert.match(String(publicSectorWarning('http://100.64.0.1/')), /carrier-grade/i);
  assert.equal(publicSectorWarning('https://example.com/'), undefined);
  assert.equal(publicSectorWarning('192.168.1.10'), undefined);
  assert.equal(typeof publicSectorWarning('100.64.0.1'), 'string');
});

test('a region code outside the twelve has no entry and the legal-name prompt asks for a legal name', () => {
  assert.equal(regionEntry('us')?.name, 'United States');
  assert.equal(regionEntry('xx'), undefined);
  assert.match(LEGAL_NAME_PROMPT, /legal name/i);
});

test('no statement ships pending owner review', () => {
  // The release gate: a statement added without review fails here rather than reaching a user.
  const pending = REGION_CODES.filter((code) => REGION_CATALOGUE[code].ownerReview === 'pending-owner-review');
  assert.deepEqual(pending, [], `statements awaiting owner review: ${pending.join(', ')}`);
  assert.equal(REGION_CODES.length, 12, 'all twelve regions are present');
  assert.equal(new Set(REGION_CODES.map((code) => REGION_CATALOGUE[code].textVersion)).size, 1, 'one statement version across all regions');
});
