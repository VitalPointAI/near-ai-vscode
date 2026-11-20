import assert from 'node:assert/strict';
import test from 'node:test';
import { proposalOf } from '../domain/gate/proposal';
import type { DirectionOf, ProposalDirection } from '../domain/gate/proposal';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { ROUTING_TIERS, TIER_ORDER } from '../domain/gate/routing';
import type { RoutingTier } from '../domain/gate/routing';
import { deviceKey, policyDocumentFor } from './helpers/policyFixtures';

// The proposal of a policy change (FND-09, Phase 41 D-44): every changed key with one plain sentence, and a key whose direction is not known counts as
// widening. Fictional keys made at test time; no key material is written here.

/** The starting rules as a v2 document. */
function startingRules(): PolicyDocument {
  return policyDocumentFor({ key: deviceKey() });
}

/** A plain, editable copy of a document; `edit` changes it and the result is used as the next document. */
function edited(base: PolicyDocument, edit: (doc: Record<string, any>) => void): PolicyDocument {
  const copy = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  edit(copy);
  return copy as unknown as PolicyDocument;
}

const isTier = (value: unknown): value is RoutingTier => typeof value === 'string' && (ROUTING_TIERS as readonly string[]).includes(value);

/** A judge that compares two routing levels by strictness (TIER_ORDER), as 41-02's narrowingOf does; undefined for anything else. */
const tierJudge: DirectionOf = (section, key, before, after): ProposalDirection | undefined => {
  if (section !== 'labels' || !key.startsWith('routing.levels.') || !isTier(before) || !isTier(after)) return undefined;
  if (TIER_ORDER[after] === TIER_ORDER[before]) return 'neutral';
  return TIER_ORDER[after] < TIER_ORDER[before] ? 'widens' : 'narrows';
};

test('D-44: a routing change gives one change with its plain sentence', () => {
  const base = startingRules();
  const next = edited(base, (doc) => { doc['labels'].routing.levels['org/Internal'] = 'any-cloud'; });
  const changes = proposalOf(base, next, tierJudge);
  assert.deepEqual(changes, [{
    section: 'labels',
    key: 'routing.levels.org/Internal',
    before: 'attested-cloud',
    after: 'any-cloud',
    direction: 'widens',
    effect: 'Organization: Internal work could go to a server that is not verified.'
  }]);
  assert.ok(Object.isFrozen(changes), 'the change list is frozen');
});

test('D-44: a routing change judged stricter says where the work will only go', () => {
  const base = startingRules();
  const next = edited(base, (doc) => { doc['labels'].routing.levels['org/Public'] = 'attested-cloud'; doc['labels'].routing.levels['org/Internal'] = 'local-only'; });
  const changes = proposalOf(base, next, tierJudge);
  assert.deepEqual(changes.map((change) => [change.key, change.direction, change.effect]), [
    ['routing.levels.org/Internal', 'narrows', 'Organization: Internal work will only go to this computer.'],
    ['routing.levels.org/Public', 'narrows', 'Organization: Public work will only go to NEAR AI private hardware or this computer.']
  ]);
  assert.deepEqual(proposalOf(base, base, tierJudge), [], 'equal rules give no change');
});
