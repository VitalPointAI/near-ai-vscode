// The label table for allies (label-interop@1) and one label out and back (Phase 45.1 plan 01 Task 1; D-02, XCHG-01). Every policy identifier, category
// and value here is a fictional placeholder (EXAMPLE-...), never a real NATO or national value: no NATO value ships (D-02).
import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultBundlePayload } from '../domain/gate/bundle';
import { FEATURE_IDS, POLICY_SECTIONS, featureForSection } from '../domain/gate/features';
import { parseLabelInteropSection } from '../domain/gate/labelInteropSection';
import type { LabelInteropTable } from '../domain/gate/labelInteropSection';
import { SCALE_PRESETS } from '../domain/gate/labels';
import type { Label } from '../domain/gate/labels';
import { documentFromBundle, parsePolicyDocument } from '../domain/gate/policyDocument';
import { LABEL_INTEROP_REFUSALS, mapIn, mapOut } from '../domain/exchange/labelInterop';
import type { ExternalLabel } from '../domain/exchange/labelInterop';
import { FIXED_NOW, deviceKey, policyDocumentFor } from './helpers/policyFixtures';
import { mulberry32 } from './helpers/teamEvents';

type Loose = Record<string, any>;

const RELEASABLE = ['AUS', 'CAN', 'GBR', 'NZL', 'USA'];

function tableValue(): Loose {
  return {
    v: 1,
    version: 3,
    scales: {
      'ca-protected': {
        policy: 'EXAMPLE-POLICY-PROTECTED',
        levels: { 'Protected A': 'EXAMPLE-PA', 'Protected B': 'EXAMPLE-PB' },
        compartments: { CEO: { category: 'EXAMPLE-SPECIAL', value: 'EXAMPLE-CEO' }, PROJECT_X: { category: 'EXAMPLE-SPECIAL', value: 'EXAMPLE-X' } },
        releasableTo: { category: 'EXAMPLE-RELEASABLE-TO', values: Object.fromEntries(RELEASABLE.map((token) => [token, `EXAMPLE-${token}`])) }
      },
      'ca-classified': {
        policy: 'EXAMPLE-POLICY-CLASSIFIED',
        levels: { Confidential: 'EXAMPLE-C', Secret: 'EXAMPLE-S' },
        compartments: { SIGINT: { category: 'EXAMPLE-COMPARTMENT', value: 'EXAMPLE-SI' } },
        releasableTo: { category: 'EXAMPLE-RELEASABLE-TO', values: { CAN: 'EXAMPLE-CAN', GBR: 'EXAMPLE-GBR' } }
      }
    }
  };
}

function table(edit: (value: Loose) => void = () => undefined): LabelInteropTable {
  const value = tableValue();
  edit(value);
  const parsed = parseLabelInteropSection(value, SCALE_PRESETS);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return parsed.value;
}

function refusalOf(value: Loose): string {
  const parsed = parseLabelInteropSection(value, SCALE_PRESETS);
  return parsed.ok ? 'ok' : `${parsed.reason} ${parsed.path}`;
}

function label(scale: string, level: string, compartments: string[] = [], releasability: string[] = [], handling: string[] = []): Label {
  return { scale, level, compartments, releasability, handling };
}

test('a policy with labelInterop parses and must name label-interop@1, which comes after the Phase 71 ids', () => {
  const doc = plain(policyDocumentFor({ key: deviceKey() })) as unknown as Loose;
  doc.labelInterop = tableValue();
  doc.requires = [...doc.requires, 'label-interop@1'].sort();
  const parsed = parsePolicyDocument(doc);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (parsed.ok) {
    assert.equal(parsed.value.labelInterop?.version, 3);
    assert.equal(parsed.value.labelInterop?.scales['ca-protected']?.policy, 'EXAMPLE-POLICY-PROTECTED');
    const again = parsePolicyDocument(plain(parsed.value));
    assert.ok(again.ok);
    if (again.ok) assert.deepEqual(again.value, parsed.value);
  }
  const without = plain(doc);
  without.requires = without.requires.filter((id: string) => id !== 'label-interop@1');
  const refused = parsePolicyDocument(without);
  assert.equal(refused.ok ? 'ok' : `${refused.reason} ${refused.path}`, 'missing-field requires');
  // Append-only: the new id and section follow the Phase 71 ones.
  assert.ok(FEATURE_IDS.indexOf('label-interop@1') > FEATURE_IDS.indexOf('agreements@1'));
  assert.ok(POLICY_SECTIONS.indexOf('labelInterop') > POLICY_SECTIONS.indexOf('agreements'));
  assert.equal(featureForSection('labelInterop'), 'label-interop@1');
});

test('the section refuses a scale or level the document does not have, a reused value, a shared policy identifier and a mixed category', () => {
  assert.equal(refusalOf(tableValue()), 'ok');
  assert.equal(refusalOf({ ...tableValue(), v: 2 }), 'unknown-version labelInterop.v');
  assert.equal(refusalOf({ ...tableValue(), version: 0 }), 'wrong-type labelInterop.version');
  assert.equal(refusalOf({ ...tableValue(), scales: {} }), 'empty-list labelInterop.scales');
  assert.equal(refusalOf({ ...tableValue(), invented: true }), 'unknown-field labelInterop.invented');
  const edit = (change: (value: Loose) => void): string => { const value = tableValue(); change(value); return refusalOf(value); };
  assert.equal(edit((v) => { v.scales['no-such-scale'] = v.scales['ca-protected']; }), 'not-allowed-here labelInterop.scales.no-such-scale');
  assert.equal(edit((v) => { v.scales['ca-protected'].levels['Protected D'] = 'EXAMPLE-PD'; }), 'not-allowed-here labelInterop.scales.ca-protected.levels.Protected?D');
  assert.equal(edit((v) => { v.scales['ca-protected'].levels['Protected B'] = 'EXAMPLE-PA'; }), 'duplicate labelInterop.scales.ca-protected.levels.Protected?B');
  assert.equal(edit((v) => { v.scales['ca-classified'].policy = 'EXAMPLE-POLICY-PROTECTED'; }), 'duplicate labelInterop.scales.ca-classified.policy');
  assert.equal(edit((v) => { v.scales['ca-protected'].compartments.CEO.value = 'EXAMPLE-X'; }), 'duplicate labelInterop.scales.ca-protected.compartments.PROJECT_X');
  assert.equal(edit((v) => { v.scales['ca-protected'].compartments.CEO.category = 'EXAMPLE-RELEASABLE-TO'; }), 'not-allowed-here labelInterop.scales.ca-protected.compartments.CEO');
  assert.equal(edit((v) => { v.scales['ca-protected'].releasableTo.values['RELEASABLE-TO-NONE'] = 'EXAMPLE-NONE'; }), 'not-allowed-here labelInterop.scales.ca-protected.releasableTo.values.RELEASABLE-TO-NONE');
  assert.equal(edit((v) => { v.scales['ca-protected'].releasableTo.values.GBR = 'EXAMPLE-CAN'; }), 'duplicate labelInterop.scales.ca-protected.releasableTo.values.GBR');
  assert.equal(edit((v) => { v.scales['ca-protected'].levels['Protected A'] = 'bad\u0007value'; }), 'wrong-type labelInterop.scales.ca-protected.levels.Protected?A');
});

test('Protected B releasable to CAN and GBR goes out as the identifier, the classification and one Releasable To category, and comes back the same', () => {
  const interop = table();
  const out = mapOut(label('ca-protected', 'Protected B', [], ['CAN', 'GBR']), interop);
  assert.ok(out.ok, out.ok ? '' : out.message);
  if (!out.ok) return;
  assert.deepEqual(plain(out.value), {
    mapping: 3,
    policy: 'EXAMPLE-POLICY-PROTECTED',
    classification: 'EXAMPLE-PB',
    categories: [{ tag: 'EXAMPLE-RELEASABLE-TO', type: 'permissive', values: ['EXAMPLE-CAN', 'EXAMPLE-GBR'] }]
  });
  const back = mapIn(plain(out.value), interop);
  assert.ok(back.ok, back.ok ? '' : back.message);
  if (back.ok) assert.deepEqual(plain(back.value), plain(label('ca-protected', 'Protected B', [], ['CAN', 'GBR'])));
});

test('compartments go out as restrictive categories, grouped by category and sorted', () => {
  const out = mapOut(label('ca-protected', 'Protected A', ['CEO', 'PROJECT_X'], ['USA']), table());
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.deepEqual(plain(out.value.categories), [
    { tag: 'EXAMPLE-RELEASABLE-TO', type: 'permissive', values: ['EXAMPLE-USA'] },
    { tag: 'EXAMPLE-SPECIAL', type: 'restrictive', values: ['EXAMPLE-CEO', 'EXAMPLE-X'] }
  ]);
});

test('seeded property: mapIn(mapOut(label)) gives back the same label for 1,000 labels the table covers', () => {
  const interop = table();
  const random = mulberry32(45_101);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const subset = (items: readonly string[]): string[] => items.filter(() => random() < 0.5).sort();
  let cases = 0;
  let withCategories = 0;
  for (let index = 0; index < 1000; index += 1) {
    const scale = pick(['ca-protected', 'ca-classified']);
    const entry = interop.scales[scale] as NonNullable<LabelInteropTable['scales'][string]>;
    const original = label(scale, pick(Object.keys(entry.levels)), subset(Object.keys(entry.compartments)), subset(Object.keys(entry.releasableTo.values)));
    const out = mapOut(original, interop);
    assert.ok(out.ok, `case ${String(index)}: ${out.ok ? '' : out.reason}`);
    if (!out.ok) continue;
    if (out.value.categories.length > 0) withCategories += 1;
    const back = mapIn(JSON.parse(JSON.stringify(out.value)), interop);
    assert.ok(back.ok, `case ${String(index)}: ${back.ok ? '' : back.reason}`);
    if (back.ok) assert.deepEqual(plain(back.value), plain(original));
    cases += 1;
  }
  assert.equal(cases, 1000);
  assert.ok(withCategories > 500, 'most cases carry categories, so the property is not vacuous');
});

test('a level, compartment, releasability token or scale with no entry is refused no-mapping, never guessed', () => {
  const interop = table();
  const reason = (l: Label): string => { const out = mapOut(l, interop); return out.ok ? 'ok' : out.reason; };
  assert.equal(reason(label('ca-protected', 'Protected C')), 'no-mapping');
  assert.equal(reason(label('ca-protected', 'Protected B', ['UNLISTED'])), 'no-mapping');
  assert.equal(reason(label('ca-protected', 'Protected B', [], ['FRA'])), 'no-mapping');
  assert.equal(reason(label('org', 'Internal')), 'no-mapping');
  assert.equal(reason(label('ca-classified', 'Secret', ['CEO'])), 'no-mapping', 'a compartment of another scale is not this one\'s');
});

test('releasable to no one and a label with handling flags are refused for export', () => {
  const interop = table();
  const none = mapOut(label('ca-protected', 'Protected B', [], ['RELEASABLE-TO-NONE']), interop);
  assert.equal(none.ok ? 'ok' : none.reason, 'releasable-to-none');
  const local = mapOut(label('ca-protected', 'Protected B', [], ['CAN'], ['local-only']), interop);
  assert.equal(local.ok ? 'ok' : local.reason, 'handling');
  const tools = mapOut(label('ca-protected', 'Protected A', [], [], ['no-agent-tools']), interop);
  assert.equal(tools.ok ? 'ok' : tools.reason, 'handling');
});

test('the shipped default policy has no label table, and mapOut and mapIn refuse every label under it', () => {
  const doc = documentFromBundle(defaultBundlePayload({ issuer: { fingerprint: deviceKey().fingerprint, publicKey: deviceKey().publicKey }, now: FIXED_NOW }));
  assert.equal(doc.labelInterop, undefined);
  assert.ok(!doc.requires.includes('label-interop@1' as never));
  for (const scale of Object.keys(SCALE_PRESETS)) {
    for (const level of (SCALE_PRESETS[scale] as { levels: readonly string[] }).levels) {
      const out = mapOut(label(scale, level), doc.labelInterop);
      assert.equal(out.ok ? 'ok' : out.reason, 'not-set', `${scale}/${level}`);
    }
  }
  const back = mapIn({ mapping: 1, policy: 'EXAMPLE-POLICY-PROTECTED', classification: 'EXAMPLE-PA', categories: [] }, doc.labelInterop);
  assert.equal(back.ok ? 'ok' : back.reason, 'not-set');
});

test('a label from outside is refused when it is malformed, from another mapping version, or names anything the table does not cover', () => {
  const interop = table();
  const good: ExternalLabel = { mapping: 3, policy: 'EXAMPLE-POLICY-PROTECTED', classification: 'EXAMPLE-PB', categories: [{ tag: 'EXAMPLE-RELEASABLE-TO', type: 'permissive', values: ['EXAMPLE-CAN'] }] };
  const reason = (change: (value: Loose) => void): string => {
    const value = JSON.parse(JSON.stringify(good)) as Loose;
    change(value);
    const back = mapIn(value, interop);
    return back.ok ? 'ok' : back.reason;
  };
  assert.equal(reason(() => undefined), 'ok');
  assert.equal(reason((v) => { v.mapping = 2; }), 'mapping-version');
  assert.equal(reason((v) => { v.policy = 'EXAMPLE-OTHER'; }), 'no-mapping');
  assert.equal(reason((v) => { v.classification = 'EXAMPLE-PZ'; }), 'no-mapping');
  assert.equal(reason((v) => { v.categories[0].values = ['EXAMPLE-FRA']; }), 'no-mapping');
  assert.equal(reason((v) => { v.categories[0].tag = 'EXAMPLE-OTHER-PERMISSIVE'; }), 'no-mapping');
  assert.equal(reason((v) => { v.categories.push({ tag: 'EXAMPLE-SPECIAL', type: 'restrictive', values: ['EXAMPLE-UNKNOWN'] }); }), 'no-mapping');
  assert.equal(reason((v) => { v.categories[0].type = 'informative'; }), 'malformed');
  assert.equal(reason((v) => { v.categories[0].values = ['EXAMPLE-GBR', 'EXAMPLE-CAN']; }), 'malformed', 'values must be sorted');
  assert.equal(reason((v) => { v.extra = true; }), 'malformed');
  assert.equal(reason((v) => { v.classification = 'EXAMPLE\nPB'; }), 'malformed');
  assert.equal(mapIn(null, interop).ok, false);
});

test('refusal sentences never name a label part or a category value', () => {
  for (const sentence of Object.values(LABEL_INTEROP_REFUSALS)) {
    assert.doesNotMatch(sentence, /EXAMPLE|Protected|CAN|GBR/);
    assert.ok(sentence.endsWith('.'));
  }
});

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
