// Labels v1 (CLAS-01, CLAS-02, D-22, D-23, D-27, D-40, D-47). A label is a closed shape: an unknown scale, level, handling value or field is refused with
// a plain reason, and equal labels have exactly one canonical form.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLEARANCE_SELF_ASSERTED_TEXT, DEFAULT_SCALE, HANDLING_FLAGS, LABELS_NOT_ACCREDITATION_TEXT, LABEL_TOKEN_PATTERN, RELEASABILITY_NONE, SCALE_PRESETS,
  SCALE_PRESETS_CAVEAT_TEXT, expiryMs, labelKey, levelIndex, parseClearance, parseLabel, parseMapping
} from '../domain/gate/labels';
import { GATE_SHAPE_FAILURES } from '../domain/gate/shape';
import type { GateShapeFailure } from '../domain/gate/shape';

function label(overrides: Record<string, unknown> = {}): unknown {
  return { scale: 'org', level: 'Internal', compartments: [], releasability: [], handling: [], ...overrides };
}

function clearance(overrides: Record<string, unknown> = {}): unknown {
  return { scale: 'org', level: 'Internal', compartments: [], releasability: [], ...overrides };
}

function labelReason(value: unknown): GateShapeFailure | 'accepted' {
  const parsed = parseLabel(value, SCALE_PRESETS);
  return parsed.ok ? 'accepted' : parsed.reason;
}

test('an org label parses and keeps its level as a name, not a number', () => {
  const parsed = parseLabel(label(), SCALE_PRESETS);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.level, 'Internal');
  assert.equal(labelKey(parsed.value), 'org/Internal');
  assert.equal(DEFAULT_SCALE, 'org');
  assert.equal(levelIndex(SCALE_PRESETS, 'org', 'Confidential'), 2);
  assert.equal(levelIndex(SCALE_PRESETS, 'org', 'Secret'), -1);
  assert.equal(levelIndex(SCALE_PRESETS, '__proto__', 'Public'), -1);
  assert.equal(levelIndex(SCALE_PRESETS, 'constructor', 'Public'), -1);
});

test('each of the four presets equals its CLAS-02 list, in order, element by element', () => {
  const expected: Record<string, readonly string[]> = {
    org: ['Public', 'Internal', 'Confidential', 'Restricted'],
    'ca-protected': ['Protected A', 'Protected B', 'Protected C'],
    'ca-classified': ['Confidential', 'Secret', 'Top Secret'],
    nato: ['NATO Unclassified', 'NATO Restricted', 'NATO Confidential', 'NATO Secret', 'Cosmic Top Secret']
  };
  assert.deepEqual(Object.keys(SCALE_PRESETS).sort(), Object.keys(expected).sort());
  for (const [id, levels] of Object.entries(expected)) {
    const scale = SCALE_PRESETS[id];
    assert.ok(scale, id);
    assert.equal(scale.levels.length, levels.length, id);
    levels.forEach((level, index) => assert.equal(scale.levels[index], level, `${id} level ${String(index)}`));
    assert.ok(scale.name.length > 0);
  }
  assert.ok(Object.isFrozen(SCALE_PRESETS) && Object.isFrozen(SCALE_PRESETS.org) && Object.isFrozen(SCALE_PRESETS.org?.levels));
});

test('the same level name on two scales is two different labels', () => {
  const org = parseLabel(label({ level: 'Confidential' }), SCALE_PRESETS);
  const classified = parseLabel(label({ scale: 'ca-classified', level: 'Confidential' }), SCALE_PRESETS);
  assert.ok(org.ok && classified.ok);
  assert.equal(labelKey(org.value), 'org/Confidential');
  assert.equal(labelKey(classified.value), 'ca-classified/Confidential');
  assert.notEqual(labelKey(org.value), labelKey(classified.value));
  assert.equal(parseLabel(label({ scale: 'ca-protected', level: 'Confidential' }), SCALE_PRESETS).ok, false);
});

test('every label refusal has one plain reason from the closed list', () => {
  assert.equal(labelReason(label({ level: 'Secret' })), 'not-allowed-here');
  assert.equal(labelReason(label({ scale: 'galaxy' })), 'not-allowed-here');
  assert.equal(labelReason(label({ scale: '__proto__' })), 'not-allowed-here');
  assert.equal(labelReason(label({ colour: 'red' })), 'unknown-field');
  assert.equal(labelReason({ scale: 'org', level: 'Public', compartments: [], releasability: [] }), 'missing-field');
  assert.equal(labelReason(label({ level: 2 })), 'wrong-type');
  assert.equal(labelReason(label({ scale: 7 })), 'wrong-type');
  assert.equal(labelReason(label({ compartments: 'A' })), 'wrong-type');
  assert.equal(labelReason(label({ compartments: ['lower'] })), 'wrong-type');
  assert.equal(labelReason(label({ compartments: [''] })), 'wrong-type');
  assert.equal(labelReason(label({ compartments: ['A'.repeat(33)] })), 'wrong-type');
  assert.equal(labelReason(label({ releasability: [4] })), 'wrong-type');
  assert.equal(labelReason(label({ handling: [7] })), 'wrong-type');
  assert.equal(labelReason('org/Internal'), 'wrong-type');
  assert.equal(labelReason(null), 'wrong-type');
  assert.equal(labelReason([]), 'wrong-type');
  assert.equal(labelReason(label({ level: 'internal' })), 'not-allowed-here', 'no case folding');
  assert.equal(labelReason(label({ level: 'Internal ' })), 'not-allowed-here', 'no trimming');
  assert.equal(labelReason(label({ level: 'Café' })), 'not-allowed-here', 'no Unicode normalisation');
  for (const reason of ['not-allowed-here', 'unknown-field', 'missing-field', 'wrong-type'] as const) assert.ok(GATE_SHAPE_FAILURES[reason].length > 0);
  const refused = parseLabel(label({ colour: 'red' }), SCALE_PRESETS);
  assert.ok(!refused.ok);
  assert.equal(refused.path, 'colour');
  assert.ok(refused.message.startsWith(GATE_SHAPE_FAILURES['unknown-field']));
});

test('a hostile prototype key is an unknown field, never trusted', () => {
  const hostile = JSON.parse('{"scale":"org","level":"Public","compartments":[],"releasability":[],"handling":[],"__proto__":{"level":"Restricted"}}') as unknown;
  assert.equal(labelReason(hostile), 'unknown-field');
  const parsed = parseLabel(label(), SCALE_PRESETS);
  assert.ok(parsed.ok);
  assert.equal(Object.getPrototypeOf(parsed.value), Object.prototype);
  assert.ok(Object.isFrozen(parsed.value) && Object.isFrozen(parsed.value.compartments));
});

test('handling flags are exactly local-only and no-agent-tools, so a label can never relax a routing tier', () => {
  assert.deepEqual([...HANDLING_FLAGS], ['local-only', 'no-agent-tools']);
  assert.equal(labelReason(label({ handling: ['local-only'] })), 'accepted');
  assert.equal(labelReason(label({ handling: ['local-only', 'no-agent-tools'] })), 'accepted');
  assert.equal(labelReason(label({ handling: ['attested-cloud-ok'] })), 'not-allowed-here');
  assert.equal(labelReason(label({ handling: ['any-cloud'] })), 'not-allowed-here');
  assert.equal(labelReason(label({ handling: ['LOCAL-ONLY'] })), 'not-allowed-here');
  assert.equal(labelReason(label({ handling: ['no-agent-tools', 'local-only'] })), 'not-sorted');
  assert.equal(labelReason(label({ handling: ['local-only', 'local-only'] })), 'duplicate');
});

test('compartments, releasability and handling must be sorted and unique: equal labels have one canonical form', () => {
  assert.equal(labelReason(label({ compartments: ['A', 'B'] })), 'accepted');
  assert.equal(labelReason(label({ compartments: ['B', 'A'] })), 'not-sorted');
  assert.equal(labelReason(label({ compartments: ['A', 'A'] })), 'duplicate');
  assert.equal(labelReason(label({ releasability: ['CAN', 'USA'] })), 'accepted');
  assert.equal(labelReason(label({ releasability: ['USA', 'CAN'] })), 'not-sorted');
  assert.equal(labelReason(label({ releasability: ['CAN', 'CAN'] })), 'duplicate');
  assert.equal(labelReason(label({ compartments: ['A1', 'A_1', 'A-1'] })), 'not-sorted', 'code unit order puts - before 1 before _');
});

test('compartment and releasability tokens match the pattern exactly, with no case folding', () => {
  for (const good of ['A', '9', 'SI', 'TK_1', 'A-B', 'A'.repeat(32)]) assert.equal(LABEL_TOKEN_PATTERN.test(good), true, good);
  for (const bad of ['', 'a', 'Si', '-A', '_A', 'A B', 'A.B', 'A'.repeat(33), 'A\n', 'А']) assert.equal(LABEL_TOKEN_PATTERN.test(bad), false, JSON.stringify(bad));
});

test('the reserved releasable-to-no-one token is a valid label entry only on its own, and never a valid clearance entry', () => {
  assert.equal(LABEL_TOKEN_PATTERN.test(RELEASABILITY_NONE), true);
  assert.equal(labelReason(label({ releasability: [RELEASABILITY_NONE] })), 'accepted');
  assert.equal(labelReason(label({ releasability: ['CAN', RELEASABILITY_NONE] })), 'not-allowed-here');
  assert.equal(parseClearance(clearance({ releasability: [RELEASABILITY_NONE] }), SCALE_PRESETS).ok, false);
});

test('a clearance parses with an optional real expiry and refuses everything else', () => {
  assert.ok(parseClearance(clearance(), SCALE_PRESETS).ok);
  const withExpiry = parseClearance(clearance({ expiresAt: '2030-01-31T23:59:59.000Z' }), SCALE_PRESETS);
  assert.ok(withExpiry.ok);
  assert.equal(withExpiry.value.expiresAt, '2030-01-31T23:59:59.000Z');
  assert.ok(parseClearance(clearance({ expiresAt: '2030-01-31T23:59:59.250Z' }), SCALE_PRESETS).ok);
  const reasonOf = (value: unknown) => {
    const parsed = parseClearance(value, SCALE_PRESETS);
    return parsed.ok ? 'accepted' : parsed.reason;
  };
  assert.equal(reasonOf(clearance({ expiresAt: 'tomorrow' })), 'wrong-type');
  assert.equal(reasonOf(clearance({ expiresAt: '2030-02-30T00:00:00.000Z' })), 'wrong-type', 'a rolled-over date is not real');
  assert.equal(reasonOf(clearance({ expiresAt: '2030-01-31T23:59:59.000+02:00' })), 'wrong-type', 'UTC only');
  assert.equal(reasonOf(clearance({ expiresAt: 1893456000000 })), 'wrong-type');
  assert.equal(reasonOf(clearance({ expiresAt: undefined })), 'wrong-type');
  assert.equal(reasonOf(clearance({ level: 'Secret' })), 'not-allowed-here');
  assert.equal(reasonOf(clearance({ handling: [] })), 'unknown-field');
  assert.equal(reasonOf({ scale: 'org', level: 'Public', compartments: [] }), 'missing-field');
  assert.equal(reasonOf(clearance({ compartments: ['B', 'A'] })), 'not-sorted');
  assert.equal(reasonOf('Restricted'), 'wrong-type');
  assert.ok(Number.isNaN(expiryMs('2030-02-30T00:00:00.000Z')));
  assert.ok(!Number.isNaN(expiryMs('2030-02-28T00:00:00.000Z')));
});

test('a clearance expiry is one form only: YYYY-MM-DDTHH:MM:SS.sssZ with exactly three fraction digits, the same form a bundle uses', () => {
  const accepted = ['2030-01-31T23:59:59.000Z', '2030-01-31T23:59:59.250Z', '2030-02-28T00:00:00.999Z', '2028-02-29T12:00:00.001Z'];
  for (const text of accepted) {
    assert.ok(parseClearance(clearance({ expiresAt: text }), SCALE_PRESETS).ok, text);
    assert.equal(expiryMs(text), Date.parse(text), text);
  }
  const refusedForms = [
    '2030-01-31T23:59:59Z', '2030-01-31T23:59:59.5Z', '2030-01-31T23:59:59.25Z', '2030-01-31T23:59:59.2500Z', '2030-01-31T23:59:59.250000Z',
    '2030-01-31T23:59:59.250z', '2030-01-31t23:59:59.250Z', '2030-01-31T23:59:59.250+00:00', '2030-01-31T23:59:59.250+02:00', '2030-01-31T23:59:59.250',
    '2030-01-31 23:59:59.250Z', '2030-01-31T23:59:59.250Z ', ' 2030-01-31T23:59:59.250Z', '2030-02-29T00:00:00.000Z', '2030-01-31T24:00:00.000Z'
  ];
  for (const text of refusedForms) {
    const parsed = parseClearance(clearance({ expiresAt: text }), SCALE_PRESETS);
    assert.equal(parsed.ok ? 'accepted' : parsed.reason, 'wrong-type', text);
    assert.ok(Number.isNaN(expiryMs(text)), text);
  }
});

test('a mapping names two real levels on two different scales and nothing else', () => {
  const good = { from: { scale: 'ca-classified', level: 'Secret' }, covers: { scale: 'ca-protected', level: 'Protected B' } };
  const parsed = parseMapping(good, SCALE_PRESETS);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, good);
  const reasonOf = (value: unknown) => {
    const result = parseMapping(value, SCALE_PRESETS);
    return result.ok ? 'accepted' : result.reason;
  };
  assert.equal(reasonOf({ from: { scale: 'org', level: 'Public' }, covers: { scale: 'org', level: 'Restricted' } }), 'not-allowed-here', 'same scale');
  assert.equal(reasonOf({ from: { scale: 'nato', level: 'Secret' }, covers: { scale: 'org', level: 'Public' } }), 'not-allowed-here', 'a level name is not a level of another scale');
  assert.equal(reasonOf({ from: { scale: 'org', level: 'Public' } }), 'missing-field');
  assert.equal(reasonOf({ from: { scale: 'org', level: 'Public' }, covers: { scale: 'nato', level: 'NATO Secret' }, via: 'x' }), 'unknown-field');
  assert.equal(reasonOf({ from: { scale: 'org', level: 'Public', extra: 1 }, covers: { scale: 'nato', level: 'NATO Secret' } }), 'unknown-field');
  assert.equal(reasonOf({ from: 'org/Public', covers: { scale: 'nato', level: 'NATO Secret' } }), 'wrong-type');
  assert.equal(reasonOf({ from: { scale: 'org', level: 'Public' }, covers: { scale: 'nato', level: 'NATO Secret' } }), 'accepted');
});

test('the plain texts are fixed once, say what they must, and never overclaim', () => {
  const research =
    'Labels and routing are an organizational control that helps prevent mistakes. They check what NEAR AI itself sends to a model and what its own file tools read, and they cannot see everything a shell command or an add-on server does. They do not make this device accredited for classified information. Until verified credentials arrive, your clearance is the one you declared yourself, so it is not an enforced boundary.';
  assert.equal(LABELS_NOT_ACCREDITATION_TEXT, research);
  assert.ok(CLEARANCE_SELF_ASSERTED_TEXT.startsWith('Until verified credentials arrive'));
  assert.match(CLEARANCE_SELF_ASSERTED_TEXT, /self-declared/);
  assert.match(CLEARANCE_SELF_ASSERTED_TEXT, /not an enforced clearance boundary/);
  const denial = /\b(?:does|do) not\b[^.]*\baccredited\b/;
  assert.match(LABELS_NOT_ACCREDITATION_TEXT, denial);
  assert.ok(LABELS_NOT_ACCREDITATION_TEXT.search(/\b(?:does|do) not\b/) < LABELS_NOT_ACCREDITATION_TEXT.indexOf('accredited'));
  assert.match(SCALE_PRESETS_CAVEAT_TEXT, /secondary copies/);
  assert.match(SCALE_PRESETS_CAVEAT_TEXT, /security officer/);
  for (const text of [CLEARANCE_SELF_ASSERTED_TEXT, LABELS_NOT_ACCREDITATION_TEXT, SCALE_PRESETS_CAVEAT_TEXT]) {
    assert.ok(!text.includes('\u2014'), 'no em-dash');
    assert.ok(!text.includes('\u2013'), 'no en-dash');
    assert.ok(!/NEAR organization/i.test(text));
    assert.ok(!/\bverified clearance\b/i.test(text));
  }
});

// ---- Coherence review S7 and S8: one label ranking on the active policy's scales, and labels shown by the scale's name ----

test('S7: the label module ranks on the active policy\'s scales, falls back to the presets only with no usable source, and the staff checks use it', async () => {
  const algebra = await import('../domain/gate/labelAlgebra');
  const observation = await import('../domain/staff/obs/observation');
  // A policy that extends the organization scale with a level between Internal and Confidential.
  const extended = { ...SCALE_PRESETS, org: { name: 'Organization', levels: ['Public', 'Internal', 'Partner', 'Confidential', 'Restricted'] } };
  // With no source: the presets, as before.
  assert.equal(algebra.labelKeyAtLeast('org/Partner', 'org/Internal'), false, 'an unknown level is never at least anything');
  assert.equal(observation.joinTemplateLabels(['org/Public', 'org/Partner']), undefined);
  const clear = algebra.setActiveScaleSource(() => extended);
  try {
    assert.equal(algebra.activeScales(), extended);
    assert.equal(algebra.labelKeyAtLeast('org/Partner', 'org/Internal'), true);
    assert.equal(algebra.labelKeyAtLeast('org/Internal', 'org/Partner'), false);
    assert.equal(observation.labelAtLeast('org/Partner', 'org/Internal'), true, 'the staff check reads the policy');
    assert.equal(observation.joinTemplateLabels(['org/Public', 'org/Partner', 'org/Internal']), 'org/Partner');
    assert.equal(observation.joinTemplateLabels(['org/Public', 'nato/NATO Unclassified']), undefined, 'different scales still do not join');
    assert.equal(algebra.labelKeyRank('org/Confidential'), 3);
  } finally { clear(); }
  assert.equal(algebra.activeScales(), SCALE_PRESETS);
  // A source that throws or gives nothing usable leaves the presets (the gate's own failed-closed scales).
  for (const broken of [() => { throw new Error('unreadable'); }, () => ({}) as never, () => null as never]) {
    const undo = algebra.setActiveScaleSource(broken);
    try { assert.equal(algebra.activeScales(), SCALE_PRESETS); } finally { undo(); }
  }
  // A replaced source is never cleared by its predecessor.
  const firstClear = algebra.setActiveScaleSource(() => extended);
  const secondClear = algebra.setActiveScaleSource(() => SCALE_PRESETS);
  firstClear();
  assert.equal(algebra.activeScales(), SCALE_PRESETS);
  secondClear();
});

test('S8: a label is shown as the scale\'s name with the level; the organization\'s Confidential reads Sensitive and its id is unchanged', async () => {
  const algebra = await import('../domain/gate/labelAlgebra');
  assert.equal(algebra.labelKeyShown({ scale: 'org', level: 'Confidential' }), 'Organization: Sensitive');
  assert.equal(algebra.labelKeyShown('ca-classified/Confidential'), 'Canada, Classified: Confidential');
  assert.equal(algebra.labelKeyShown({ scale: 'ca-protected', level: 'Protected B' }), 'Canada, Protected: Protected B');
  assert.equal(algebra.labelKeyShown({ scale: 'nato', level: 'NATO Secret' }), 'NATO: NATO Secret');
  assert.equal(algebra.labelKeyShown({ scale: 'org', level: 'Internal' }), 'Organization: Internal');
  // A scale the policy does not know shows its id rather than a guess; a text without a scale is left as it is.
  assert.equal(algebra.labelKeyShown({ scale: 'custom', level: 'High' }), 'custom: High');
  assert.equal(algebra.labelKeyShown('no-slash'), 'no-slash');
  // The policy's own scale name is used when it has one.
  const clear = algebra.setActiveScaleSource(() => ({ ...SCALE_PRESETS, custom: { name: 'Project', levels: ['Low', 'High'] } }));
  try { assert.equal(algebra.labelKeyShown({ scale: 'custom', level: 'High' }), 'Project: High'); } finally { clear(); }
  // Ids are unchanged: a label still parses and keys by its stored level name.
  assert.equal(labelKey({ scale: 'org', level: 'Confidential' }), 'org/Confidential');
  assert.equal(parseLabel({ scale: 'org', level: 'Sensitive', compartments: [], releasability: [], handling: [] }, SCALE_PRESETS).ok, false, 'the display name is never an id');
  assert.equal(algebra.levelShown('ca-classified', 'Confidential'), 'Confidential', 'only the organization scale is renamed');
});
