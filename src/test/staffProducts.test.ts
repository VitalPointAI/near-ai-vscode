// Staff product headers, kinds, the shared product ownership map and the UI events (design 10, 4.1, 4.3, 4.5; UX concept 11 and 12.5; WP-0).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { STAFF_SECTION_IDS } from '../domain/staff/doctrine';
import { eventsForTransition, NESTED_TEAM_STATES, STAFF_EVENT_TYPES } from '../domain/staff/events';
import { mayWrite, proposalFolder, SHARED_PRODUCTS, STAFF_MODES, STAFF_PHASES, writerOf } from '../domain/staff/ownership';
import {
  parseProductFile, parseProductHeader, PRODUCT_KIND_RENDERERS, PRODUCT_KINDS, renderProductHeader, STAFF_MARKERS, STAFF_MEMBER_PREAMBLE, staffPreambleText
} from '../domain/staff/products';
import type { ProductHeader } from '../domain/staff/products';
import { startProduct, transition } from '../domain/staff/release';
import type { ProductRecord, ReleaseResult } from '../domain/staff/release';

const HEADER: ProductHeader = {
  product: 'intelligence-estimate',
  kind: 'estimate',
  section: 'j2',
  owner: 'j2-chief',
  profile: 'us-joint',
  level: 'operational',
  version: 3,
  state: 'awaiting-decision',
  label: 'org/Internal',
  decisionFor: 'commander',
  dependsOn: [{ product: 'jipoe-steps-1-2', version: 2 }, { product: 'adversary-coas', version: 4 }],
  guard: { verdict: 'CLEARED', at: '2026-11-18T14:02:00.000Z', report: 'guard/intelligence-estimate-v3.md' },
  tradecraft: { verdict: 'SIGN-OFF', at: '2026-11-18T13:40:00.000Z', report: 'guard/intelligence-estimate-v3-tradecraft.md' }
};

test('a product header round trips through render and parse', () => {
  const text = `${renderProductHeader(HEADER)}\n# Intelligence estimate\n`;
  const parsed = parseProductFile(text);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.header, HEADER);
  assert.equal(parsed.value.body, '\n# Intelligence estimate\n');
  assert.equal(renderProductHeader(parsed.value.header), renderProductHeader(HEADER));
  const minimal: ProductHeader = { product: 'warning-order-1', kind: 'order', section: 'j5', owner: 'lead-planner', profile: 'nato-ca', level: 'tactical', version: 1, state: 'draft', label: 'nato/NATO Unclassified', dependsOn: [] };
  const again = parseProductHeader(renderProductHeader(minimal).split('\n').slice(1, -2).join('\n'));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.value, minimal);
});

test('the header reads notes after values, and the design\'s example shape', () => {
  const block = [
    'product: intelligence-estimate',
    'section: j2',
    'kind: estimate',
    'owner: j2-chief',
    'profile: us-joint          # profile and level it was written under',
    'level: operational',
    'version: 3',
    'state: awaiting-decision',
    'label: org/Internal        # from the Phase 70 label map; exercise data only',
    'decision_for: commander    # the human role',
    'depends_on: [jipoe-steps-1-2@2, adversary-coas@4]',
    'guard: { verdict: CLEARED, at: 2026-11-18T14:02:00.000Z, report: guard/intelligence-estimate-v3.md }'
  ].join('\n');
  const parsed = parseProductHeader(block);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  if (parsed.ok) assert.equal(parsed.value.decisionFor, 'commander');
});

test('the header parser refuses bad input with the field named', () => {
  const base = renderProductHeader(HEADER).split('\n').slice(1, -2);
  const swap = (key: string, line: string | undefined): string => base.flatMap((entry) => (entry.startsWith(`${key}:`) ? (line === undefined ? [] : [line]) : [entry])).join('\n');
  const cases: Array<[string, string, string]> = [
    [swap('state', 'state: approved-by-me'), 'unknown-value', 'state'],
    [swap('kind', 'kind: memo'), 'unknown-value', 'kind'],
    [swap('section', 'section: j10'), 'unknown-value', 'section'],
    [swap('owner', 'owner: J2 Chief'), 'wrong-type', 'owner'],
    [swap('profile', 'profile: caf-opp'), 'unknown-value', 'profile'],
    [swap('level', 'level: tactical'), 'not-offered', 'level'],
    [swap('version', 'version: 0'), 'wrong-type', 'version'],
    [swap('version', 'version: 3.5'), 'wrong-type', 'version'],
    [swap('label', 'label: Internal'), 'wrong-type', 'label'],
    [swap('product', undefined), 'missing-field', 'product'],
    [`${base.join('\n')}\nproduct: other`, 'duplicate-field', 'product'],
    [`${base.join('\n')}\nreviewer: someone`, 'unknown-field', 'reviewer'],
    [`${base.join('\n')}\n  indented: line`, 'bad-syntax', 'header.line14'],
    [swap('depends_on', 'depends_on: [adversary-coas]'), 'wrong-type', 'depends_on[0]'],
    [swap('depends_on', 'depends_on: [adversary-coas@1, adversary-coas@2]'), 'duplicate-entry', 'depends_on[1]'],
    [swap('depends_on', 'depends_on: [intelligence-estimate@2]'), 'not-allowed-here', 'depends_on[0]'],
    [swap('depends_on', 'depends_on: adversary-coas@1'), 'wrong-type', 'depends_on'],
    [swap('guard', 'guard: { verdict: CLEARED, at: 2026-11-18T14:02Z, report: guard/x.md }'), 'wrong-type', 'guard.at'],
    [swap('guard', 'guard: { verdict: SIGN-OFF, at: 2026-11-18T14:02:00.000Z, report: guard/x.md }'), 'unknown-value', 'guard.verdict'],
    [swap('guard', 'guard: { verdict: CLEARED, at: 2026-11-18T14:02:00.000Z, report: ../secrets.md }'), 'wrong-type', 'guard.report'],
    [swap('guard', 'guard: { verdict: CLEARED, at: 2026-11-18T14:02:00.000Z, report: /etc/passwd }'), 'wrong-type', 'guard.report'],
    [swap('guard', 'guard: { verdict: CLEARED, at: 2026-11-18T14:02:00.000Z }'), 'missing-field', 'guard.report'],
    [swap('guard', 'guard: { verdict: CLEARED, verdict: HOLD, at: 2026-11-18T14:02:00.000Z, report: g.md }'), 'duplicate-field', 'guard.verdict'],
    [swap('guard', 'guard: { verdict: HOLD, at: 2026-11-18T14:02:00.000Z, report: guard/x.md }'), 'missing-field', 'guard'],
    [swap('guard', undefined), 'missing-field', 'guard'],
    [swap('decision_for', undefined), 'missing-field', 'decision_for']
  ];
  for (const [block, reason, where] of cases) {
    const result = parseProductHeader(block);
    assert.equal(result.ok, false, `${reason} at ${where} should be refused`);
    if (!result.ok) assert.deepEqual([result.reason, result.path], [reason, where]);
  }
  const noHeader = parseProductFile('# Just a heading\n');
  assert.equal(noHeader.ok ? 'ok' : noHeader.reason, 'missing-field');
});

test('every product kind renders as a card, plus at most one view of its own', () => {
  for (const kind of PRODUCT_KINDS) {
    const renderers = PRODUCT_KIND_RENDERERS[kind];
    assert.equal(renderers[0], 'card', kind);
    assert.equal(new Set(renderers).size, renderers.length, kind);
  }
  assert.deepEqual(PRODUCT_KIND_RENDERERS['coa-statement'], ['card', 'map-layer', 'document']);
});

test('every shared product has exactly one writer in every phase and mode, and parts name their own writer', () => {
  for (const entry of SHARED_PRODUCTS) {
    assert.ok(STAFF_SECTION_IDS.length > 0);
    for (const phase of STAFF_PHASES) {
      for (const mode of STAFF_MODES) {
        const writer = writerOf(entry.product, { phase, mode });
        assert.ok(writer, `${entry.product} in ${phase} (${mode})`);
        assert.ok((STAFF_SECTION_IDS as readonly string[]).includes(writer.section));
        assert.ok(mayWrite(entry.product, writer, { phase, mode }));
      }
    }
  }
  assert.equal(new Set(SHARED_PRODUCTS.map((entry) => entry.product)).size, SHARED_PRODUCTS.length, 'no shared product listed twice');
  const planning = { phase: 'planning', mode: 'full-staff' } as const;
  const execution = { phase: 'execution', mode: 'full-staff' } as const;
  assert.deepEqual(writerOf('sync-matrix', planning), { section: 'j5', member: 'lead-planner' });
  assert.deepEqual(writerOf('sync-matrix', execution), { section: 'j3', member: 'future-ops-planner' });
  assert.deepEqual(writerOf('assessment-plan', planning), { section: 'j5', member: 'design-planner' });
  assert.deepEqual(writerOf('assessment-plan', execution), { section: 'j3', member: 'assessment-analyst' });
  assert.deepEqual(writerOf('battle-rhythm-calendar', planning), { section: 'command', member: 'chief-of-staff' });
  assert.deepEqual(writerOf('battle-rhythm-calendar', { phase: 'planning', mode: 'standalone' }), { section: 'j3', member: 'joc-chief' });
  assert.deepEqual(writerOf('ccir-register', planning, 'pir'), { section: 'j2', member: 'requirements-manager' });
  assert.equal(mayWrite('ccir-register', { section: 'j2', member: 'requirements-manager' }, planning), false, 'the PIR writer proposes to the whole register');
  assert.equal(mayWrite('cop-threat-layer', { section: 'j3', member: 'joc-chief' }, planning), false);
  assert.equal(writerOf('not-shared', planning), undefined);
  assert.equal(writerOf('ccir-register', planning, 'toString'), undefined);
  assert.equal(proposalFolder('rfi-tracker'), '.planning/staff/proposals/rfi-tracker/');
});

test('the ownership map has teeth: a product with two writers for one phase throws instead of picking one', () => {
  const entry = SHARED_PRODUCTS.find((item) => item.product === 'rfi-tracker') as unknown as { owners: unknown[] };
  const saved = entry.owners;
  try {
    entry.owners = [...saved, { phase: 'any', mode: 'any', writer: { section: 'j2', member: 'requirements-manager' } }];
    assert.throws(() => writerOf('rfi-tracker', { phase: 'planning', mode: 'full-staff' }), /has 2 writers/);
  } finally {
    entry.owners = saved;
  }
});

test('events: one product.state per transition, plus the gate verdict, the decision request and the person\'s decision', () => {
  const hash = createHash('sha256').update('v1').digest('hex');
  const identity = { product: 'ccir-register', section: 'j3', roles: { owner: 'j3-director', sectionLead: 'lead', releaseGuard: 'release-guard' } } as const;
  const must = (result: ReleaseResult): ProductRecord & { log: ReleaseResult } => {
    if (!result.ok) throw new Error(result.reason);
    return Object.assign(result.record, { log: result });
  };
  const person = { kind: 'person', name: 'A. Demo', role: 'Commander', deviceFingerprint: 'dev-1' } as const;
  const started = startProduct(identity, { kind: 'agent', member: 'j3-director' }, hash);
  const draft = must(started);
  const cleared = transition(draft, { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash, reasons: [] }, { kind: 'agent', member: 'release-guard' });
  const checked = must(cleared);
  const submitted = transition(checked, { type: 'submit', decisionFor: 'Commander' }, { kind: 'agent', member: 'j3-director' });
  const waiting = must(submitted);
  const approved = transition(waiting, { type: 'approve', hash }, person);
  assert.ok(started.ok && cleared.ok && submitted.ok && approved.ok);
  if (!(started.ok && cleared.ok && submitted.ok && approved.ok)) return;
  const at = '2026-11-18T14:02:00.000Z';
  assert.deepEqual(eventsForTransition('run-1', at, started.transitions[0]).map((event) => event.type), ['staff.product.state']);
  const verdict = eventsForTransition('run-1', at, cleared.transitions[0], { gate: 'guard', verdict: 'CLEARED' });
  assert.deepEqual(verdict.map((event) => event.type), ['staff.product.state', 'staff.gate.verdict']);
  assert.deepEqual(eventsForTransition('run-1', at, submitted.transitions[0], { decisionFor: 'Commander' }).map((event) => event.type), ['staff.product.state', 'staff.decision.requested']);
  const decided = eventsForTransition('run-1', at, approved.transitions[0], { decisionFor: 'Commander' });
  assert.deepEqual(decided.map((event) => event.type), ['staff.product.state', 'staff.decision.recorded']);
  const recorded = decided[1];
  assert.ok(recorded.type === 'staff.decision.recorded' && recorded.decision === 'approved' && recorded.person.name === 'A. Demo');
  const state = decided[0];
  assert.ok(state.type === 'staff.product.state' && state.from === 'awaiting-decision' && state.to === 'approved' && state.run === 'run-1' && state.at === at);
  for (const event of [...verdict, ...decided]) assert.ok((STAFF_EVENT_TYPES as readonly string[]).includes(event.type));
});

test('the event list covers design 4.5 and the UX concept\'s wargame turn; nested team states match design 5.4', () => {
  assert.deepEqual([...STAFF_EVENT_TYPES].sort(), [
    'staff.ccir.triggered', 'staff.cop.updated', 'staff.decision.recorded', 'staff.decision.requested', 'staff.gate.verdict', 'staff.lane.finished',
    'staff.lane.started', 'staff.lane.switched', 'staff.merge.conflict', 'staff.merge.resolved', 'staff.merge.started', 'staff.product.state', 'staff.rfi.answered',
    'staff.rfi.opened', 'staff.rfi.overdue', 'staff.step.entered', 'staff.team.nested', 'staff.waiting', 'staff.wargame.turn'
  ]);
  assert.equal(NESTED_TEAM_STATES.length, 14);
});

test('the member preamble has the four lines, uses the markers, and promises no decision', () => {
  assert.equal(STAFF_MEMBER_PREAMBLE.length, 4);
  const text = staffPreambleText();
  assert.match(text, /^1\. Read \.planning\/staff\/PROFILE\.md first/);
  assert.ok(text.includes(`${STAFF_MARKERS.decisionFor} <role of the human>`));
  assert.ok(text.includes(`${STAFF_MARKERS.waitingOn} <section>`));
  assert.ok(text.includes('a named human decides'));
  assert.ok(!text.includes(String.fromCharCode(0x2014)));
});
