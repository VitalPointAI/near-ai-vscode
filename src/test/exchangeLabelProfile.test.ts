// Label policy profiles with provenance (45.2-11, CONTEXT D-20 to D-22). The NATO draft (public, not yet verified) and the Canadian DND/CAF draft
// (assumed) ship in resources/label-profiles/ and parse under the same rules as an adopted profile. The public NATO identifier, its OID and the NATO
// classification names appear only in the NATO data file and in this test (D-02); every other profile here is fictional (EXAMPLE-ORG).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  LABEL_PROFILE_FORMAT,
  NO_CONTEXT_VALUES_TEXT,
  PROVENANCE_LEVELS,
  parseLabelProfile,
  profileLeaves,
  valuesFor,
  type LabelProfile,
  type ProfileValue
} from '../domain/exchange/labelProfile';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PROFILES = path.join(REPO_ROOT, 'resources', 'label-profiles');

function rawProfile(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(PROFILES, file), 'utf8')) as Record<string, unknown>;
}

function parsed(input: unknown): LabelProfile {
  const result = parseLabelProfile(input);
  if (!result.ok) assert.fail(`refused: ${result.message}`);
  return result.value;
}

const nato = (): LabelProfile => parsed(rawProfile('nato.label-profile.json'));
const canadian = (): LabelProfile => parsed(rawProfile('can-dnd.label-profile.json'));

function valueOf(leaf: unknown): string | undefined {
  return (leaf as ProfileValue | undefined)?.value;
}

/** A small fictional profile to break one rule at a time. */
function example(): Record<string, unknown> {
  const leaf = (value: string): Record<string, unknown> => ({ value, provenance: 'assumed', source: 'EXAMPLE-ORG policy guide, section 2', date: '2026-11-20', gap: 'G355' });
  return {
    format: 'label-profile/1',
    id: 'example-org',
    title: 'EXAMPLE-ORG label policy',
    policyIdentifier: leaf('EXAMPLE-ORG'),
    uri: { value: 'urn:oid:1.3.6.1.4.1.32473.7', provenance: 'verified', source: 'EXAMPLE-ORG registry', date: '2026-11-20' },
    classifications: [{ value: leaf('LOW'), rank: 1 }, { value: leaf('HIGH'), rank: 2 }],
    categories: [{ type: 'PERMISSIVE', tagName: leaf('Releasable To'), values: [leaf('EXA')] }],
    note: 'Fictional.'
  };
}

function refusalOf(input: unknown): string {
  const result = parseLabelProfile(input);
  assert.equal(result.ok, false, 'expected a refusal');
  return result.ok ? '' : `${result.reason} ${result.path}`;
}

test('D-21 tracer: the NATO draft parses, and every value says where it came from and how sure we are', () => {
  const profile = nato();
  assert.equal(profile.format, LABEL_PROFILE_FORMAT);
  assert.equal(valueOf(profile.policyIdentifier), 'NATO');
  assert.equal(valueOf(profile.uri), 'urn:oid:1.3.26.1.3.1');
  assert.deepEqual(profile.classifications.map((entry) => [valueOf(entry.value), entry.rank]), [['UNCLASSIFIED', 1], ['RESTRICTED', 2], ['CONFIDENTIAL', 3], ['SECRET', 4], ['TOP SECRET', 5]]);
  assert.equal(valueOf(profile.classifications[4]?.marking), 'COSMIC TOP SECRET');
  assert.deepEqual(profile.categories.map((category) => [category.type, valueOf(category.tagName), valueOf(category.uri)]), [
    ['PERMISSIVE', 'Context', 'urn:oid:1.3.26.1.4.4'],
    ['PERMISSIVE', 'Releasable To', 'urn:oid:1.3.26.1.4.2'],
    ['PERMISSIVE', 'Only', 'urn:oid:1.3.26.1.4.5'],
    ['RESTRICTIVE', 'Additional Sensitivity', 'urn:oid:1.3.26.1.4.1'],
    ['INFORMATIVE', 'Administrative', 'urn:oid:1.3.26.1.4.3']
  ]);
  assert.deepEqual(profile.categories[1]?.values.map(valueOf), ['CAN']);
  const leaves = profileLeaves(profile);
  assert.ok(leaves.length >= 18, `every value is a leaf (${leaves.length})`);
  for (const { path: where, leaf } of leaves) {
    assert.equal(leaf.provenance, 'public-unverified', where);
    assert.ok(leaf.source.length > 10, where);
    assert.match(leaf.date, /^\d{4}-\d{2}-\d{2}$/, where);
    assert.match(leaf.gap ?? '', /^G\d+$/, where);
  }
  assert.deepEqual([...PROVENANCE_LEVELS], ['verified', 'public-unverified', 'assumed']);
});

test('D-21: the values of one label come from the profile with their provenance', () => {
  const profile = nato();
  const result = valuesFor(profile, { classification: 3, releasableTo: ['can'] });
  assert.ok(result.ok, result.ok ? '' : result.message);
  assert.equal(valueOf(result.value.policyIdentifier), 'NATO');
  assert.equal(valueOf(result.value.uri), 'urn:oid:1.3.26.1.3.1');
  assert.equal(valueOf(result.value.classification), 'CONFIDENTIAL');
  assert.equal(result.value.marking, undefined);
  assert.deepEqual(result.value.categories.map((category) => [category.type, valueOf(category.tagName), valueOf(category.uri), category.values.map(valueOf)]), [
    ['PERMISSIVE', 'Releasable To', 'urn:oid:1.3.26.1.4.2', ['CAN']]
  ]);
  assert.equal(result.value.lowestProvenance, 'public-unverified');
  assert.deepEqual(result.value.used.map((entry) => entry.path), ['policyIdentifier', 'uri', 'classifications[2].value', 'categories[1].tagName', 'categories[1].uri', 'categories[1].values[0]']);
  assert.ok(result.value.used.every((entry) => entry.profile === 'nato-draft'));
  const top = valuesFor(profile, { classification: 5 });
  assert.ok(top.ok);
  assert.equal(valueOf(top.value.marking), 'COSMIC TOP SECRET');
  const missing = valuesFor(profile, { classification: 9 });
  assert.equal(missing.ok ? '' : missing.reason, 'unknown-classification');
  const country = valuesFor(profile, { classification: 2, releasableTo: ['EXA'] });
  assert.equal(country.ok ? '' : country.reason, 'unknown-value');
});

test('D-21: the profile carries no context values, and asking for one says where they come from', () => {
  const profile = nato();
  assert.deepEqual(profile.categories[0]?.values, []);
  const result = valuesFor(profile, { classification: 2, context: ['EXAMPLE-ALLIANCE'] });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? '' : result.message, NO_CONTEXT_VALUES_TEXT);
  assert.equal(NO_CONTEXT_VALUES_TEXT, "This profile has no context values; they come with the mission's policy file.");
});

test('D-21: a value with no provenance, or a provenance outside the three levels, is refused', () => {
  const noProvenance = example();
  delete (noProvenance.policyIdentifier as Record<string, unknown>).provenance;
  assert.equal(refusalOf(noProvenance), 'missing-field policyIdentifier.provenance');
  const outside = example();
  (outside.classifications as Array<Record<string, Record<string, unknown>>>)[1]!.value!.provenance = 'probably';
  assert.equal(refusalOf(outside), 'wrong-type classifications[1].value.provenance');
});

test('D-21: a value that is not verified must name a gap id; a verified one need not', () => {
  const missingGap = example();
  delete ((missingGap.categories as Array<Record<string, unknown>>)[0]!.values as Array<Record<string, unknown>>)[0]!.gap;
  assert.equal(refusalOf(missingGap), 'missing-field categories[0].values[0].gap');
  const badGap = example();
  (badGap.policyIdentifier as Record<string, unknown>).gap = 'gap-355';
  assert.equal(refusalOf(badGap), 'wrong-type policyIdentifier.gap');
  assert.equal(parseLabelProfile(example()).ok, true, 'the verified URI has no gap');
});

test('D-21: a URI must be a urn:oid URN or a marked placeholder', () => {
  for (const uri of ['http://example.org/policy', 'urn:oid:', 'urn:oid:1.3.6.1.4.1.32473.07', 'oid:1.3.6.1.4.1.32473.7']) {
    const profile = example();
    (profile.uri as Record<string, unknown>).value = uri;
    assert.equal(refusalOf(profile), 'wrong-type uri.value', uri);
  }
  const placeholder = example();
  placeholder.uri = { placeholder: "EXAMPLE-ORG's OID", configurablePerTarget: true, provenance: 'assumed', source: 'not known', date: '2026-11-20', gap: 'G355' };
  assert.equal(parseLabelProfile(placeholder).ok, true);
  const notAssumed = example();
  notAssumed.uri = { placeholder: "EXAMPLE-ORG's OID", configurablePerTarget: true, provenance: 'verified', source: 'not known', date: '2026-11-20', gap: 'G355' };
  assert.equal(refusalOf(notAssumed), 'not-allowed-here uri.provenance');
});

test('D-21: duplicate classification ranks, ranks out of order and an unknown field are refused', () => {
  const duplicate = example();
  (duplicate.classifications as Array<Record<string, unknown>>)[1]!.rank = 1;
  assert.equal(refusalOf(duplicate), 'duplicate classifications[1].rank');
  const unordered = example();
  (unordered.classifications as Array<Record<string, unknown>>).reverse();
  assert.equal(refusalOf(unordered), 'not-sorted classifications[1].rank');
  const unknown = example();
  unknown.contextValues = [];
  assert.equal(refusalOf(unknown), 'unknown-field contextValues');
  const leafField = example();
  (leafField.policyIdentifier as Record<string, unknown>).confidence = 'high';
  assert.equal(refusalOf(leafField), 'unknown-field policyIdentifier.confidence');
  const version = example();
  version.format = 'label-profile/2';
  assert.equal(refusalOf(version), 'unknown-version format');
});

test('D-02: the public NATO identifier, its OID and the NATO top-level marking appear in no exchange code', () => {
  const banned = /['"`]NATO['"`]|1\.3\.26\.|COSMIC/;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.push(full);
    }
  };
  walk(path.join(REPO_ROOT, 'src', 'domain', 'exchange'));
  assert.ok(files.some((file) => file.endsWith('labelProfile.ts')));
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), banned, path.relative(REPO_ROOT, file));
});
