// Label policy profiles with provenance (45.2-11, CONTEXT D-20 to D-22). The NATO draft (public, not yet verified) and the Canadian DND/CAF draft
// (assumed) ship in resources/label-profiles/ and parse under the same rules as an adopted profile. The public NATO identifier, its OID and the NATO
// classification names appear only in the NATO data file and in this test (D-02); every other profile here is fictional (EXAMPLE-ORG).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import {
  ASSUMED_VALUES_TEXT,
  LABEL_PROFILE_FORMAT,
  NO_CONTEXT_VALUES_TEXT,
  PROVENANCE_LEVELS,
  parseLabelProfile,
  placeholderText,
  profileLeaves,
  provenanceCheck,
  valuesFor,
  withTargetOverrides,
  type AssumedException,
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
  assert.equal(NO_CONTEXT_VALUES_TEXT, "This label policy has no context values; they come with the mission's policy file.");
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

test('D-21: the Canadian DND/CAF draft parses as assumed, with its OID a placeholder set per target system', () => {
  const profile = canadian();
  assert.equal(valueOf(profile.policyIdentifier), 'CAN');
  assert.deepEqual(profile.classifications.map((entry) => valueOf(entry.value)), ['PROTECTED A', 'PROTECTED B', 'PROTECTED C', 'CONFIDENTIAL', 'SECRET', 'TOP SECRET']);
  assert.deepEqual(profile.categories, []);
  const uri = profile.uri as { placeholder?: string; configurablePerTarget?: boolean };
  assert.equal(uri.configurablePerTarget, true);
  assert.equal(uri.placeholder, "The Canadian policy identifier's OID");
  for (const { path: where, leaf } of profileLeaves(profile)) {
    assert.equal(leaf.provenance, 'assumed', where);
    assert.match(leaf.source, /assumed from DND security orders \(CAN SECRET, CAN PROTECTED B\); OID, caveats, releasability and SPIF unknown/i, where);
  }
  assert.doesNotMatch(readFileSync(path.join(PROFILES, 'can-dnd.label-profile.json'), 'utf8'), /urn:oid/, 'no Canadian OID is invented');
});

/** The values of a Canadian PROTECTED B label. */
function canadianUsed(profile = canadian()): ReturnType<typeof valuesFor> {
  return valuesFor(profile, { classification: 2 });
}

const TODAY = '2026-11-25';

test('D-22: an operational export with assumed values and no exception is refused', () => {
  const profile = canadian();
  const values = canadianUsed(profile);
  assert.ok(values.ok);
  // Without the placeholder, only the assumed values decide.
  const assumedOnly = values.value.used.filter((entry) => !('placeholder' in entry.leaf));
  const verdict = provenanceCheck(assumedOnly, { purpose: 'operational', exceptions: [], today: TODAY });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.ok ? '' : verdict.message, ASSUMED_VALUES_TEXT(profile.title));
  assert.equal(ASSUMED_VALUES_TEXT('X'), 'This export would use assumed label values (X). Your security officer can record an exception, or the values must be verified first.');
});

test('D-22: an exception your security officer recorded lets assumed values through until it ends', () => {
  const values = canadianUsed();
  assert.ok(values.ok);
  const assumedOnly = values.value.used.filter((entry) => !('placeholder' in entry.leaf));
  const exception: AssumedException = { profile: 'can-dnd-draft', values: ['CAN', 'protected b'], reason: 'Trial with the target system owner', until: '2026-12-31' };
  const verdict = provenanceCheck(assumedOnly, { purpose: 'operational', exceptions: [exception], today: TODAY });
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.message);
  assert.deepEqual(verdict.exceptionsUsed, [exception]);
  assert.equal(verdict.lowestProvenance, 'assumed');
  const expired = provenanceCheck(assumedOnly, { purpose: 'operational', exceptions: [{ ...exception, until: '2026-11-24' }], today: TODAY });
  assert.equal(expired.ok, false, 'an expired exception is refused');
  const partial = provenanceCheck(assumedOnly, { purpose: 'operational', exceptions: [{ ...exception, values: ['CAN'] }], today: TODAY });
  assert.equal(partial.ok, false, 'an exception that does not name every assumed value is refused');
  const otherProfile = provenanceCheck(assumedOnly, { purpose: 'operational', exceptions: [{ ...exception, profile: 'example-org' }], today: TODAY });
  assert.equal(otherProfile.ok, false, 'an exception for another profile is refused');
});

test('D-22: a placeholder is refused for every operational export, with or without an exception', () => {
  const values = canadianUsed();
  assert.ok(values.ok);
  const exception: AssumedException = { profile: 'can-dnd-draft', values: ['CAN', 'PROTECTED B'], reason: 'Trial', until: '2026-12-31' };
  for (const exceptions of [[], [exception]]) {
    const verdict = provenanceCheck(values.value.used, { purpose: 'operational', exceptions, today: TODAY });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok ? '' : verdict.reason, 'placeholder');
    assert.equal(verdict.ok ? '' : verdict.message, "The Canadian policy identifier's OID is not known for this target system.");
  }
  assert.equal(placeholderText("EXAMPLE-ORG's OID"), "EXAMPLE-ORG's OID is not known for this target system.");
});

test('D-22: a trial export may use assumed values and placeholders, and says so', () => {
  const values = canadianUsed();
  assert.ok(values.ok);
  const verdict = provenanceCheck(values.value.used, { purpose: 'trial', exceptions: [], today: TODAY });
  assert.ok(verdict.ok);
  assert.equal(verdict.lowestProvenance, 'assumed');
  assert.deepEqual(verdict.shown, [{ profile: 'can-dnd-draft', title: canadian().title, provenance: 'assumed' }]);
});

test('D-22: public, not yet verified values pass an operational export and are reported', () => {
  const values = valuesFor(nato(), { classification: 4, releasableTo: ['CAN'] });
  assert.ok(values.ok);
  const verdict = provenanceCheck(values.value.used, { purpose: 'operational', exceptions: [], today: TODAY });
  assert.ok(verdict.ok);
  assert.equal(verdict.lowestProvenance, 'public-unverified');
  assert.deepEqual(verdict.shown.map((entry) => [entry.profile, entry.provenance]), [['nato-draft', 'public-unverified']]);
  assert.deepEqual(verdict.exceptionsUsed, []);
  assert.equal(provenanceCheck([], { purpose: 'operational', exceptions: [], today: TODAY }).ok, true);
});

test('D-12, D-21: a per-target override with a verified URI replaces the placeholder for that target only', () => {
  const profile = canadian();
  const overridden = withTargetOverrides(profile, { uri: { value: 'urn:oid:1.3.6.1.4.1.32473.45', provenance: 'verified', source: 'EXAMPLE-ORG target system policy owner', date: '2026-11-25' } });
  assert.ok(overridden.ok, overridden.ok ? '' : overridden.message);
  assert.equal(valueOf(overridden.value.uri), 'urn:oid:1.3.6.1.4.1.32473.45');
  assert.equal(overridden.value.uri?.provenance, 'verified');
  assert.ok('placeholder' in (profile.uri ?? {}), 'the shipped profile keeps its placeholder');
  const values = valuesFor(overridden.value, { classification: 2 });
  assert.ok(values.ok);
  const exception: AssumedException = { profile: 'can-dnd-draft', values: ['CAN', 'PROTECTED B'], reason: 'Trial', until: '2026-12-31' };
  assert.equal(provenanceCheck(values.value.used, { purpose: 'operational', exceptions: [exception], today: TODAY }).ok, true, 'no placeholder is left');
  // Only a placeholder can be overridden, and an override follows the same value rules.
  const notPlaceholder = withTargetOverrides(profile, { policyIdentifier: { value: 'EXA', provenance: 'verified', source: 'EXAMPLE-ORG', date: '2026-11-25' } });
  assert.equal(notPlaceholder.ok ? '' : `${notPlaceholder.reason} ${notPlaceholder.path}`, 'not-allowed-here policyIdentifier');
  const badUri = withTargetOverrides(profile, { uri: { value: 'urn:x:1', provenance: 'verified', source: 'EXAMPLE-ORG', date: '2026-11-25' } });
  assert.equal(badUri.ok ? '' : `${badUri.reason} ${badUri.path}`, 'wrong-type uri.value');
});

/** The gap ids named by the values of a profile that are not verified, with any id the register does not hold listed as missing. */
function gapCitations(profile: LabelProfile, register: ReadonlySet<string>): { cited: Set<string>; missing: string[] } {
  const cited = new Set<string>();
  const missing: string[] = [];
  for (const { path: where, leaf } of profileLeaves(profile)) {
    if (leaf.provenance === 'verified') continue;
    if (leaf.gap === undefined || !register.has(leaf.gap)) missing.push(`${profile.id} ${where}: ${leaf.gap ?? 'no gap'}`);
    else cited.add(leaf.gap);
  }
  return { cited, missing };
}

test('D-20: every value of the shipped profiles that is not verified names a gap id that exists in compliance/gaps.json', () => {
  const register = JSON.parse(readFileSync(path.join(REPO_ROOT, 'compliance', 'gaps.json'), 'utf8')) as { gaps: Array<{ id: string; appliesAt?: string; blocksProduction?: boolean }> };
  const rows = new Map(register.gaps.map((gap) => [gap.id, gap]));
  const ids = new Set(rows.keys());
  const files = readdirSync(PROFILES).filter((file) => file.endsWith('.label-profile.json')).sort();
  assert.deepEqual(files, ['can-dnd.label-profile.json', 'nato.label-profile.json'], 'every shipped profile is checked');
  for (const file of files) {
    const { cited, missing } = gapCitations(parsed(rawProfile(file)), ids);
    assert.deepEqual(missing, [], `${file}: every value that is not verified names a gap id in the register`);
    for (const id of cited) assert.equal(rows.get(id)?.appliesAt, 'coalition-exchange', `${file}: ${id} applies to coalition exchange`);
  }
  assert.equal(rows.get('G355')?.blocksProduction, true, 'the Canadian umbrella row blocks production');
  // Teeth: a value naming an id the register does not hold is reported.
  const planted = example();
  (planted.policyIdentifier as Record<string, unknown>).gap = 'G99999';
  assert.deepEqual(gapCitations(parsed(planted), ids).missing, ['example-org policyIdentifier: G99999']);
});
