// Residency (FND-05, Phase 41 D-33): the regions content may be sent to, for every request (`required`) and per label (`byLevel`). A place satisfies the
// rule only when its stated region is in every list that applies; `unstated` never does; this computer always does; a residency-exception authorization
// naming the place, the project and every label of the request lets it go and is what allowed it. Pure: no I/O, no clock, no key.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AuthorizationBody } from '../domain/gate/authorizations';
import { allowedRegions, residencyAllows } from '../domain/gate/residency';
import type { RouteEndpoint, VerifiedAuthorization } from '../domain/gate/routing';
import type { ResidencySection } from '../domain/gate/sections';
import { DAY_MS, FIXED_NOW, authorizationFor } from './helpers/policyFixtures';

const NOW = FIXED_NOW;
const PROTECTED_A = { scale: 'ca-protected', level: 'Protected A' };
const PROTECTED_B = { scale: 'ca-protected', level: 'Protected B' };
const INTERNAL = { scale: 'org', level: 'Internal' };

function place(region: RouteEndpoint['region'], extra: Partial<RouteEndpoint> = {}): RouteEndpoint {
  return { id: 'service-1', class: 'vendor-region', region, implicit: false, tlsPins: [], ...extra };
}

function verified(body: AuthorizationBody, selfSigned = false): VerifiedAuthorization {
  return { body, selfSigned };
}

function residency(section: Omit<ResidencySection, 'v'>): ResidencySection {
  return { v: 1, ...section };
}

function allows(input: Partial<Parameters<typeof residencyAllows>[0]>): boolean {
  return residencyAllows({ endpoint: place('CA'), labels: [INTERNAL], authorizations: [], now: NOW, ...input }).ok;
}

test('allowedRegions: nothing applies without a section or a matching list; otherwise the sorted intersection of required and each label\'s list', () => {
  assert.equal(allowedRegions(undefined, [INTERNAL]), undefined);
  assert.equal(allowedRegions(residency({}), [INTERNAL]), undefined);
  assert.equal(allowedRegions(residency({ byLevel: { 'ca-protected/Protected A': ['CA'] } }), [INTERNAL]), undefined, 'a list for another label does not apply');
  assert.deepEqual(allowedRegions(residency({ required: ['CA', 'EU'] }), [INTERNAL]), ['CA', 'EU']);
  assert.deepEqual(allowedRegions(residency({ byLevel: { 'ca-protected/Protected A': ['CA', 'EU'] } }), [PROTECTED_A]), ['CA', 'EU']);
  assert.deepEqual(allowedRegions(residency({ required: ['CA', 'EU', 'US'], byLevel: { 'ca-protected/Protected A': ['EU', 'US'] } }), [PROTECTED_A, INTERNAL]), ['EU', 'US']);
  assert.deepEqual(allowedRegions(residency({ byLevel: { 'ca-protected/Protected A': ['CA', 'EU'], 'org/Internal': ['EU', 'US'] } }), [PROTECTED_A, INTERNAL]), ['EU']);
  // A key such as __proto__ is never read as a list.
  assert.equal(allowedRegions(residency({ byLevel: { 'ca-protected/Protected A': ['CA'] } }), [{ scale: '__proto__', level: '' }]), undefined);
});

test('required [CA]: a place in Canada is allowed; the United States, the European Union and an unstated region are refused, naming the allowed list', () => {
  const section = residency({ required: ['CA'] });
  assert.deepEqual(residencyAllows({ endpoint: place('CA'), labels: [INTERNAL], residency: section, authorizations: [], now: NOW }), { ok: true });
  for (const region of ['US', 'EU', 'unstated'] as const) {
    assert.deepEqual(residencyAllows({ endpoint: place(region), labels: [INTERNAL], residency: section, authorizations: [], now: NOW }), { ok: false, allowed: ['CA'] }, region);
  }
});

test('byLevel for Protected A [CA, EU]: the European Union is allowed for Protected A, the United States is refused, and another label is not held to it', () => {
  const section = residency({ byLevel: { 'ca-protected/Protected A': ['CA', 'EU'] } });
  assert.equal(allows({ endpoint: place('EU'), labels: [PROTECTED_A], residency: section }), true);
  assert.equal(allows({ endpoint: place('US'), labels: [PROTECTED_A], residency: section }), false);
  assert.equal(allows({ endpoint: place('US'), labels: [INTERNAL], residency: section }), true);
  assert.equal(allows({ endpoint: place('US'), labels: [INTERNAL, PROTECTED_A], residency: section }), false, 'every label of the mark counts');
});

test('required [CA] with byLevel [EU] for a label cannot be met by any region, so it is refused', () => {
  const section = residency({ required: ['CA'], byLevel: { 'ca-protected/Protected A': ['EU'] } });
  for (const region of ['CA', 'EU', 'US', 'unstated'] as const) {
    assert.deepEqual(residencyAllows({ endpoint: place(region), labels: [PROTECTED_A], residency: section, authorizations: [], now: NOW }), { ok: false, allowed: [] }, region);
  }
});

test('this computer always satisfies residency, whatever its stated region', () => {
  const section = residency({ required: ['EU'], byLevel: { 'ca-protected/Protected B': ['CA'] } });
  for (const region of ['CA', 'US', 'unstated'] as const) {
    assert.equal(allows({ endpoint: { class: 'local', region }, labels: [PROTECTED_B], residency: section }), true, region);
  }
});

test('no residency section, or an empty one, allows every place', () => {
  assert.equal(allows({ endpoint: place('unstated'), residency: undefined }), true);
  assert.equal(allows({ endpoint: place('unstated'), residency: residency({}) }), true);
  assert.equal(allows({ endpoint: undefined, residency: residency({}) }), true);
});

test('a place your rules do not name counts as unstated: refused whenever a list applies', () => {
  assert.deepEqual(residencyAllows({ endpoint: undefined, labels: [INTERNAL], residency: residency({ required: ['CA', 'EU', 'US'] }), authorizations: [], now: NOW }), { ok: false, allowed: ['CA', 'EU', 'US'] });
});

test('a residency exception naming the place, the project and every label allows the request and is returned as what allowed it', () => {
  const section = residency({ required: ['CA'] });
  const body = authorizationFor({
    kind: 'residency-exception', id: 'residency-exception-7', subject: { endpoint: 'service-1' }, scope: { projects: ['project-alpha'], labels: ['ca-protected/Protected A', 'org/Internal'] }
  });
  const exception = verified(body);
  const result = residencyAllows({ endpoint: place('US'), labels: [INTERNAL, PROTECTED_A], residency: section, authorizations: [exception], project: 'project-alpha', now: NOW });
  assert.deepEqual(result, { ok: true, exception });
  // An exception with no scope lists covers any project and label.
  const open = verified(authorizationFor({ kind: 'residency-exception', id: 'residency-exception-8', subject: { endpoint: 'service-1' } }));
  assert.deepEqual(residencyAllows({ endpoint: place('US'), labels: [PROTECTED_B], residency: section, authorizations: [open], now: NOW }), { ok: true, exception: open });
});

test('a residency exception for another label, place or project, an expired or revoked one, another kind, or a place with no id does not allow it', () => {
  const section = residency({ required: ['CA'] });
  const refusedWith = (body: AuthorizationBody, extra: Partial<Parameters<typeof residencyAllows>[0]> = {}): void => {
    const result = residencyAllows({ endpoint: place('US'), labels: [INTERNAL, PROTECTED_A], residency: section, authorizations: [verified(body)], project: 'project-alpha', now: NOW, ...extra });
    assert.deepEqual(result, { ok: false, allowed: ['CA'] }, body.id);
  };
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'one-label', subject: { endpoint: 'service-1' }, scope: { labels: ['org/Internal'] } }));
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'other-place', subject: { endpoint: 'service-2' } }));
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'other-project', subject: { endpoint: 'service-1' }, scope: { projects: ['project-beta'] } }));
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'scoped', subject: { endpoint: 'service-1' }, scope: { projects: ['project-alpha'] } }), { project: undefined });
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'expired', subject: { endpoint: 'service-1' }, issuedAt: new Date(NOW - 100 * DAY_MS).toISOString(), days: 90 }));
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'revoked', subject: { endpoint: 'service-1' }, revokedBy: 'residency-exception-9' }));
  refusedWith(authorizationFor({ kind: 'protected-b', id: 'other-kind', subject: { endpoint: 'service-1' } }));
  refusedWith(authorizationFor({ kind: 'residency-exception', id: 'no-id', subject: { endpoint: 'service-1' } }), { endpoint: place('US', { id: undefined }) });
});
