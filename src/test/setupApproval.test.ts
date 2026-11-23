import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENDPOINT_ID_PATTERN, parseEndpoints, type PolicyEndpoint } from '../domain/gate/endpoints';
import { composeLayers } from '../domain/gate/layers';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import { APPROVAL_ASK_TEXT, APPROVAL_FROM_TEXT, endpointProposalFor, FOUND_NOT_APPROVED_TEXT, foundEndpointId, type ApprovalInput } from '../services/setup/approval';
import { deviceKey, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

const pin = 'a'.repeat(64);
const base: ApprovalInput = {
  candidate: {
    target: { host: '192.0.2.1', port: 11434, scheme: 'https', source: 'scanned' },
    foundBy: 'scanned', foundAt: 30
  },
  identity: { kind: 'ollama', version: '0.12.3' }, pin, region: 'CA', maxLabel: ['org/Internal'],
  organization: false, personalApprovals: false
};
const personal = policyDocumentFor({ key: deviceKey() });
const organization = policyDocumentFor({ key: issuerKey(), layer: 'organization' });
const endpoint: PolicyEndpoint = {
  id: 'found-192-0-2-1-11434', class: 'org-plain', host: '192.0.2.1', scheme: 'https',
  tlsPins: [pin], region: 'CA', maxLabel: ['org/Internal'], provider: 'ollama'
};

test('a found TLS server yields a pinned personal proposal without changing the current document', () => {
  const before = structuredClone(personal);
  const proposal = endpointProposalFor(base);
  assert.equal(proposal.target, 'personal');
  assert.equal(proposal.requiresPersonalAuthority, true);
  assert.equal(proposal.from, APPROVAL_FROM_TEXT);
  assert.match(proposal.reason ?? '', /Found on your network: ollama 0\.12\.3/);
  const next = proposal.next(personal);
  assert.deepEqual(next.endpoints, [...(personal.endpoints ?? []), endpoint]);
  assert.ok(next.requires.includes('endpoints@1'));
  assert.ok(parseEndpoints(next.endpoints, next.labels.scales).ok);
  assert.ok(parsePolicyDocument(next).ok);
  assert.deepEqual(personal, before);
});

test('organization approval is the default and permitted personal approval stays at org/Public', () => {
  const orgProposal = endpointProposalFor({ ...base, organization: true });
  assert.equal(orgProposal.target, 'organization');
  assert.deepEqual(orgProposal.next(organization).endpoints?.at(-1), endpoint);
  const personalProposal = endpointProposalFor({ ...base, organization: true, personalApprovals: true });
  assert.equal(personalProposal.target, 'personal');
  assert.equal(personalProposal.requiresPersonalAuthority, undefined);
  const next = personalProposal.next(personal);
  const org = parsePolicyDocument({
    ...organization,
    requires: [...organization.requires, 'onboarding@1' as const].sort(),
    onboarding: { v: 1 as const, discovery: { personalApprovals: true } }
  });
  assert.ok(org.ok);
  assert.deepEqual(composeLayers({ organization: org.value, personal: next }).effective.endpoints, [{ ...endpoint, maxLabel: ['org/Public'] }]);
  assert.throws(() => orgProposal.next(personal));
});

test('an endpoint proposal refuses hosts, schemes and pins that do not identify one exact TLS server', () => {
  for (const target of [
    { host: '*.example.org' }, { host: 'EXAMPLE.org' }, { host: 'example.org/url' }, { host: 'example.org:443' },
    { host: '127.1' }, { host: '127.0.0.1' }, { port: 0 }, { port: 65536 }, { scheme: 'http-loopback' as const },
    { tlsPin: 'b'.repeat(64) }
  ]) {
    assert.throws(() => endpointProposalFor({ ...base, candidate: { ...base.candidate, target: { ...base.candidate.target, ...target } } }));
  }
  for (const invalid of ['', 'abc', 'A'.repeat(64)]) {
    assert.throws(() => endpointProposalFor({ ...base, pin: invalid }));
  }
});

test('proposals keep existing entries in policy order and refuse a duplicate host or unaccepted ceiling', () => {
  const previousEndpoint: PolicyEndpoint = { ...endpoint, id: 'z-existing', host: '198.51.100.5' };
  const current = { ...personal, endpoints: [previousEndpoint] };
  const proposal = endpointProposalFor(base);
  assert.deepEqual(proposal.next(current).endpoints, [endpoint, previousEndpoint]);
  assert.deepEqual(current.endpoints, [previousEndpoint]);
  assert.throws(() => proposal.next({ ...current, endpoints: [{ ...previousEndpoint, host: endpoint.host }] }));
  assert.throws(() => endpointProposalFor({ ...base, maxLabel: ['org/not-a-level'] }).next(personal));
});

test('found IDs use the expected safe schema and text identifies a proposal', () => {
  assert.equal(foundEndpointId('192.0.2.1', 11434), endpoint.id);
  const longId = foundEndpointId(`${'a'.repeat(63)}.example.org`, 11434);
  assert.match(longId, ENDPOINT_ID_PATTERN);
  assert.match(longId, /-11434$/);
  assert.equal(APPROVAL_ASK_TEXT, 'Ask {contact} to approve it.');
  assert.equal(FOUND_NOT_APPROVED_TEXT, 'Found on your network, not approved');
});
