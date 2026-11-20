import assert from 'node:assert/strict';
import test from 'node:test';
import { POLICY_SECTION_IDS, PROPOSAL_FILE_EXTENSION, UNKNOWN_WIDENS, policySections, proposalOf, proposalPayload } from '../domain/gate/proposal';
import type { DirectionOf, ProposalChange, ProposalDirection } from '../domain/gate/proposal';
import { parsePolicyDocument } from '../domain/gate/policyDocument';
import type { PolicyDocument } from '../domain/gate/policyDocument';
import { ROUTING_TIERS, TIER_ORDER } from '../domain/gate/routing';
import type { RoutingTier } from '../domain/gate/routing';
import { canonicalBytes } from '../domain/team/canonical';
import { PayloadError, signPayload } from '../domain/team/signedPayload';
import { deviceKey, fullDocumentFor, issuerKey, policyDocumentFor } from './helpers/policyFixtures';

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

/** Your organization's rules with every section and optional key, parsed as the extension reads them. */
function fullRules(): PolicyDocument {
  const parsed = parsePolicyDocument(fullDocumentFor(issuerKey()));
  assert.ok(parsed.ok, `the full fixture parses: ${parsed.ok ? '' : parsed.message}`);
  return parsed.value;
}

/** An AI service in Canada run by an outside company, allowed up to Organization: Internal (fictional host). */
const VAULT = Object.freeze({ id: 'vault-ca', class: 'vendor-region', host: 'vault.example.net', scheme: 'https', tlsPins: [], region: 'CA', maxLabel: ['org/Internal'], provider: 'example' });

/** Judges every change with one answer. */
const always = (direction: ProposalDirection): DirectionOf => () => direction;

/** Words that never appear in a sentence a person reads on the rules page (GLOSSARY sections 1 and 3, the plan's copy rule). */
const FORBIDDEN = [/—/, /endpoint/i, /\bTEE\b/i, /\btier/i, /\blayer/i, /\bissuer/i, /policy bundle/i, /NEAR(\s+AI)?('s)?\s+organization/i, /\bteam\b/i];

function assertPlain(text: string): void {
  for (const word of FORBIDDEN) assert.doesNotMatch(text, word, `"${text}" has ${String(word)}`);
}

test('D-44: list items are keyed by id', () => {
  const base = startingRules();
  const withVault = edited(base, (doc) => { doc['endpoints'] = [VAULT]; });
  const added = proposalOf(base, withVault);
  assert.equal(added.length, 1);
  assert.equal(added[0]?.section, 'endpoints');
  assert.equal(added[0]?.key, '[vault-ca]');
  assert.equal('before' in (added[0] as object), false, 'before is absent, never null');
  assert.deepEqual(added[0]?.after, VAULT);
  const removed = proposalOf(withVault, base);
  assert.equal(removed.length, 1);
  assert.equal(removed[0]?.key, '[vault-ca]');
  assert.deepEqual(removed[0]?.before, VAULT);
  assert.equal('after' in (removed[0] as object), false);
  // An authorization envelope is keyed by its payload id.
  const full = fullRules();
  const fewer = edited(full, (doc) => { doc['authorizations'] = doc['authorizations'].filter((envelope: any) => envelope.payload.id !== 't1-risk-1'); });
  const dropped = proposalOf(full, fewer);
  assert.deepEqual(dropped.map((change) => [change.section, change.key, 'after' in change]), [['authorizations', '[t1-risk-1]', false]]);
  // A list of plain values, or of objects with no id, is one key.
  const kinds = proposalOf(full, edited(full, (doc) => { doc['onboarding'].kindsOfWork = ['software']; doc['people'].clearances = []; }));
  assert.deepEqual(kinds.map((change) => [change.section, change.key]), [['people', 'clearances'], ['onboarding', 'kindsOfWork']]);
  assert.deepEqual(kinds[1]?.before, ['staff', 'software']);
  assert.deepEqual(kinds[1]?.after, ['software']);
});

test('D-44: a nested list keyed by id and nested objects give dotted keys, sorted by section then key', () => {
  const full = fullRules();
  const next = edited(full, (doc) => {
    doc['onboarding'].discovery.networks = [{ id: 'head-office', dnsSuffix: 'corp.example.org' }, { id: 'yard', gateway: '10.30.0.1' }];
    doc['agents'].maxMode.interactive = 'approve-risky';
    doc['limits'].spend.vaultHoursPerDay = 4;
  });
  const changes = proposalOf(full, next);
  assert.deepEqual(changes.map((change) => [change.section, change.key]), [
    ['agents', 'maxMode.interactive'],
    ['onboarding', 'discovery.networks[head-office]'],
    ['onboarding', 'discovery.networks[yard]'],
    ['limits', 'spend.vaultHoursPerDay']
  ]);
  assert.ok(Object.isFrozen(changes[0]), 'each change is frozen');
});

test('D-44: envelope fields are not proposals', () => {
  const full = fullRules();
  const next = edited(full, (doc) => {
    doc['issuedAt'] = '2027-01-01T00:00:00.000Z';
    doc['expiresAt'] = '2028-01-01T00:00:00.000Z';
    doc['issuer'] = { fingerprint: deviceKey().fingerprint, publicKey: deviceKey().publicKey };
    doc['layer'] = 'personal';
    doc['parent'] = { hash: 'f'.repeat(64), issuer: issuerKey().fingerprint };
    doc['requires'] = ['agents@1', 'labels@1', 'layers@1'];
    doc['minClient'] = '0.5.0';
  });
  assert.deepEqual(proposalOf(full, next), []);
  // The reserved fields are validated and ignored, so they are not proposals either.
  assert.deepEqual(proposalOf(full, edited(full, (doc) => { doc['reserved'].maxOfflineAge = {}; })), []);
});

test('D-44: unknown direction counts as widening', () => {
  const full = fullRules();
  const next = edited(full, (doc) => {
    doc['agents'].maxMode.interactive = 'approve-risky';
    doc['limits'].spend.dailyNanoUsd = 1_000_000_000;
    doc['labels'].routing.levels['org/Public'] = 'local-only';
  });
  const unknown = proposalOf(full, next, UNKNOWN_WIDENS);
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every((change) => change.direction === 'widens'), 'every unjudged change is wider');
  assert.deepEqual(proposalOf(full, next).map((change) => change.direction), ['widens', 'widens', 'widens'], 'the default judge is UNKNOWN_WIDENS');
  const judged = proposalOf(full, next, (section) => (section === 'agents' ? 'narrows' : section === 'limits' ? 'neutral' : undefined));
  assert.deepEqual(judged.map((change) => [change.section, change.direction]), [['labels', 'widens'], ['agents', 'narrows'], ['limits', 'neutral']]);
  // A judge is never asked about equal values: they give no change at all.
  let asked = 0;
  assert.deepEqual(proposalOf(full, edited(full, () => undefined), () => { asked += 1; return 'widens'; }), []);
  assert.equal(asked, 0);
});

test('D-44: every effect is one plain sentence', () => {
  const base = startingRules();
  const withVault = edited(base, (doc) => { doc['endpoints'] = [VAULT]; });
  assert.equal(proposalOf(base, withVault)[0]?.effect, 'Organization: Internal work could go to vault.example.net (an outside AI service in Canada).');
  assert.equal(proposalOf(withVault, base)[0]?.effect, 'Nothing will go to vault.example.net any more.');
  const limited = edited(base, (doc) => { doc['limits'] = { v: 1, spend: { dailyNanoUsd: 5_000_000_000 } }; });
  const spend = edited(base, (doc) => { doc['limits'] = { v: 1, spend: { dailyNanoUsd: 2_000_000_000 } }; });
  assert.equal(proposalOf(limited, spend, always('narrows'))[0]?.effect, 'Limits: spend.dailyNanoUsd changes. This makes the rules stricter.');
  assert.equal(proposalOf(limited, spend, always('widens'))[0]?.effect, 'Limits: spend.dailyNanoUsd changes. This makes the rules wider.');
  assert.equal(proposalOf(limited, spend, always('neutral'))[0]?.effect, 'Limits: spend.dailyNanoUsd changes.');
  assert.equal(proposalOf(limited, spend)[0]?.effect, 'Limits: spend.dailyNanoUsd changes. This makes the rules wider.');
  // A value added where there was none is one change of the whole value.
  assert.deepEqual(proposalOf(base, spend).map((change) => [change.key, change.effect]), [['spend', 'Limits: spend changes. This makes the rules wider.']]);
  // Every change from the starting rules to a document with every section, both ways, reads plainly.
  const full = fullRules();
  const all = [...proposalOf(base, full), ...proposalOf(full, base), ...proposalOf(base, full, always('narrows')), ...proposalOf(full, base, always('neutral'))];
  assert.ok(all.length > 30, `many changes (${String(all.length)})`);
  for (const change of all) {
    assertPlain(change.effect);
    assert.match(change.effect, /^[A-Z].*\.$/, `one sentence that starts with a capital and ends with a full stop: ${change.effect}`);
    assert.ok(change.effect.length <= 300, `short: ${change.effect}`);
  }
  // Each endpoint class reads with its "Runs on" words.
  const runsOn = proposalOf(base, full).filter((change) => change.section === 'endpoints').map((change) => change.effect);
  assert.ok(runsOn.some((effect) => effect.includes('(this computer)')));
  assert.ok(runsOn.some((effect) => effect.includes("(your organization's server)")));
  assert.ok(runsOn.some((effect) => effect.includes('(NEAR AI private hardware)')));
  assert.ok(runsOn.some((effect) => effect.includes('(an outside AI service in the European Union)')));
  assert.ok(runsOn.some((effect) => effect.includes('(an outside AI service)')));
});

test('D-44: policySections names the eight sections in order', () => {
  const full = fullRules();
  const sections = policySections(full, full.labels.scales);
  assert.deepEqual(sections.map((section) => section.id), [...POLICY_SECTION_IDS]);
  assert.deepEqual(sections.map((section) => section.title), [
    'Labels and where they may go', 'Where AI runs', 'Models', 'Authorizations', 'Agents and tools', 'People and organization', 'Setup and discovery', 'Limits'
  ]);
  for (const section of sections) {
    assertPlain(section.title);
    assert.ok(section.rows.length > 0, `${section.title} has rows`);
    for (const row of section.rows) {
      assert.equal(typeof row.name, 'string');
      assert.equal(typeof row.value, 'string');
      assertPlain(row.name);
    }
  }
  const text = JSON.stringify(sections);
  assert.ok(!text.includes('a'.repeat(64)), 'reserved fields are not shown');
  assert.ok(!/reserved/i.test(text));
  assert.ok(text.includes('Organization: Internal'), 'labels are shown by name');
  assert.ok(!text.includes('org/Internal'), 'never the scale id');
  assert.ok(text.includes('models.example.org'));
  assert.ok(text.includes('Security desk'));
  // The starting rules show the same eight sections, each with at least one row.
  const starting = policySections(startingRules(), startingRules().labels.scales);
  assert.deepEqual(starting.map((section) => section.id), [...POLICY_SECTION_IDS]);
  assert.ok(starting.every((section) => section.rows.length > 0));
});

test('D-44: proposalPayload is stable and signs without a secret-scanner refusal', () => {
  assert.equal(PROPOSAL_FILE_EXTENSION, '.near-policy-proposal');
  const base = startingRules();
  const full = fullRules();
  const changes = proposalOf(base, full);
  assert.ok(changes.some((change) => change.section === 'authorizations'), 'the change list carries authorization envelopes');
  const target = { layer: 'organization' as const, hash: 'c'.repeat(64), issuer: issuerKey().fingerprint };
  const forward = proposalPayload({ target, from: 'Example flow', reason: 'Add the vault.', changes });
  const backward = proposalPayload({ target, from: 'Example flow', reason: 'Add the vault.', changes: [...changes].reverse() });
  assert.deepEqual(canonicalBytes(forward), canonicalBytes(backward), 'the same change list in any order gives the same bytes');
  assert.equal(forward.v, 1);
  assert.deepEqual(forward.target, target);
  for (const change of forward.changes) {
    assert.equal('effect' in change, false, 'the sentence is not part of the signed request');
    assert.ok(!Object.values(change).includes(null), 'absent values are left out, never null');
  }
  const added = forward.changes.find((change) => change.section === 'endpoints');
  assert.ok(added !== undefined && !('before' in added));
  const envelope = signPayload(deviceKey(), 'policy-proposal', forward);
  assert.equal(envelope.purpose, 'policy-proposal');
  assert.equal(proposalPayload({ target, from: 'Example flow', changes }).reason, undefined);
  assert.equal('reason' in proposalPayload({ target, from: 'Example flow', changes }), false);
  // A number that is not a whole, non-negative safe number is refused before anything is signed (D-08).
  const odd = (after: unknown): ProposalChange[] => [{ section: 'limits', key: 'spend.dailyNanoUsd', after, direction: 'widens', effect: 'Limits: spend.dailyNanoUsd changes.' }];
  for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, { nested: [0.25] }]) {
    assert.throws(() => proposalPayload({ target, from: 'Example flow', changes: odd(bad) }), (error: unknown) => error instanceof PayloadError && /Nothing was signed/.test(error.message));
  }
  assert.equal(proposalPayload({ target, from: 'Example flow', changes: odd(0) }).changes.length, 1, 'zero and whole numbers are fine');
  assert.throws(() => proposalPayload({ target: { ...target, hash: 'not-a-hash' }, from: 'Example flow', changes }), PayloadError);
});
