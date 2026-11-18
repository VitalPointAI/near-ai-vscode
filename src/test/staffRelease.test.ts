// The staff release state machine (design 10, 4.1; WP-0): every transition, allowed and refused, for every class of actor; that no agent can approve,
// reject, release or supersede from any state; and the forbidden steps the design names one by one (approve without guard, release without approval,
// approval of a stale hash, edit after approval, tradecraft skipped for J2, rejected without reasons, guard verdict for another version).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AGENT_PRODUCT_VERBS, HUMAN_ONLY_EVENTS, RELEASE_REFUSALS, RELEASE_STATES, RELEASE_TRANSITIONS, replay, startProduct, transition
} from '../domain/staff/release';
import type { ProductIdentity, ProductRecord, ReleaseEvent, ReleaseResult, ReleaseState, StaffActor } from '../domain/staff/release';

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const V1 = hash('v1');
const NEW = hash('new content');

const ACTORS = {
  owner: { kind: 'agent', member: 'lead-planner' },
  lead: { kind: 'agent', member: 'section-lead' },
  guard: { kind: 'agent', member: 'release-guard' },
  tradecraft: { kind: 'agent', member: 'tradecraft-reviewer' },
  other: { kind: 'agent', member: 'coa-cell-a' },
  person: { kind: 'person', name: 'A. Demo', role: 'Commander', deviceFingerprint: 'dev-0123456789abcdef' },
  unnamed: { kind: 'person', name: ' ', role: 'Commander', deviceFingerprint: 'dev-0123456789abcdef' }
} as const satisfies Record<string, StaffActor>;
type ActorName = keyof typeof ACTORS;
const ACTOR_NAMES = Object.keys(ACTORS) as ActorName[];
const AGENT_NAMES = ACTOR_NAMES.filter((name) => ACTORS[name].kind === 'agent');

const PLAIN: ProductIdentity = { product: 'concept-of-operations', section: 'j5', roles: { owner: 'lead-planner', sectionLead: 'section-lead', releaseGuard: 'release-guard' } };
const J2: ProductIdentity = { product: 'intelligence-estimate', section: 'j2', roles: { owner: 'lead-planner', sectionLead: 'section-lead', releaseGuard: 'release-guard', tradecraftReviewer: 'tradecraft-reviewer' } };

function must(result: ReleaseResult): ProductRecord {
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
  return result.record;
}

/** A plain product brought to each state by the allowed path. */
function recordIn(state: ReleaseState): ProductRecord {
  const draft = must(startProduct(PLAIN, ACTORS.owner, V1));
  if (state === 'draft') return draft;
  const checked = must(transition(draft, { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: V1, reasons: [] }, ACTORS.guard));
  if (state === 'guard-checked') return checked;
  const waiting = must(transition(checked, { type: 'submit', decisionFor: 'Commander' }, ACTORS.owner));
  if (state === 'awaiting-decision') return waiting;
  if (state === 'rejected') return must(transition(waiting, { type: 'reject', reasons: ['Return with guidance on the main effort.'] }, ACTORS.person));
  if (state === 'withdrawn') return must(transition(waiting, { type: 'withdraw', reason: 'Overtaken by events.' }, ACTORS.person));
  const approved = must(transition(waiting, { type: 'approve', hash: V1 }, ACTORS.person));
  if (state === 'approved') return approved;
  const released = must(transition(approved, { type: 'release', hash: V1 }, ACTORS.person));
  if (state === 'released') return released;
  return must(transition(released, { type: 'supersede', byVersion: 2 }, ACTORS.person));
}

const EVENTS: Readonly<Record<string, (record: ProductRecord) => ReleaseEvent>> = {
  propose: () => ({ type: 'propose', hash: NEW }),
  'guard-cleared': (record) => ({ type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: record.hash, reasons: [] }),
  'guard-hold': (record) => ({ type: 'verdict', gate: 'guard', verdict: 'HOLD', hash: record.hash, reasons: ['Marking found on page 2.'] }),
  submit: () => ({ type: 'submit', decisionFor: 'Commander' }),
  edit: () => ({ type: 'edit', hash: NEW }),
  approve: (record) => ({ type: 'approve', hash: record.hash }),
  'approve-and-release': (record) => ({ type: 'approve', hash: record.hash, releaseOnApproval: true }),
  reject: () => ({ type: 'reject', reasons: ['Not distinct enough.'] }),
  release: (record) => ({ type: 'release', hash: record.hash }),
  supersede: (record) => ({ type: 'supersede', byVersion: record.version + 1 }),
  withdraw: () => ({ type: 'withdraw', reason: 'No longer needed.' })
};

// The allowed steps, written out from the design's table (4.1), independently of the code: state, event, the actors that may take it, and the state after.
const EVERYONE = ACTOR_NAMES;
const ALLOWED: ReadonlyArray<readonly [ReleaseState, string, readonly ActorName[], ReleaseState]> = [
  ['draft', 'propose', ['owner'], 'draft'],
  ['draft', 'guard-cleared', ['guard'], 'guard-checked'],
  ['draft', 'guard-hold', ['guard'], 'draft'],
  ['draft', 'edit', EVERYONE, 'draft'],
  ['draft', 'withdraw', ['owner', 'person'], 'withdrawn'],
  ['guard-checked', 'submit', ['owner', 'lead'], 'awaiting-decision'],
  ['guard-checked', 'edit', EVERYONE, 'draft'],
  ['guard-checked', 'withdraw', ['owner', 'person'], 'withdrawn'],
  ['awaiting-decision', 'edit', EVERYONE, 'draft'],
  ['awaiting-decision', 'approve', ['person'], 'approved'],
  ['awaiting-decision', 'approve-and-release', ['person'], 'released'],
  ['awaiting-decision', 'reject', ['person'], 'rejected'],
  ['awaiting-decision', 'withdraw', ['owner', 'person'], 'withdrawn'],
  ['approved', 'release', ['person'], 'released'],
  ['approved', 'withdraw', ['person'], 'withdrawn'],
  ['rejected', 'propose', ['owner'], 'draft'],
  ['rejected', 'withdraw', ['owner', 'person'], 'withdrawn'],
  ['released', 'supersede', ['person'], 'superseded'],
  ['released', 'withdraw', ['person'], 'withdrawn']
];

function expected(state: ReleaseState, event: string, actor: ActorName): ReleaseState | undefined {
  return ALLOWED.find(([from, name, who]) => from === state && name === event && who.includes(actor))?.[3];
}

test('every state, event and actor: the allowed steps reach the state the design names, and every other step is refused and changes nothing', () => {
  let allowed = 0;
  let refused = 0;
  for (const state of RELEASE_STATES) {
    for (const event of Object.keys(EVENTS)) {
      for (const actor of ACTOR_NAMES) {
        const record = recordIn(state);
        const before = JSON.stringify(record);
        const result = transition(record, EVENTS[event](record), ACTORS[actor]);
        const want = expected(state, event, actor);
        const label = `${state} + ${event} by ${actor}`;
        assert.equal(JSON.stringify(record), before, `${label}: the record passed in is never changed`);
        if (want === undefined) {
          assert.equal(result.ok, false, `${label} must be refused`);
          if (!result.ok) assert.equal(result.message, RELEASE_REFUSALS[result.reason]);
          refused += 1;
        } else {
          assert.ok(result.ok, `${label} must be allowed${result.ok ? '' : ` (refused: ${result.reason})`}`);
          if (result.ok) {
            assert.equal(result.record.state, want, label);
            assert.equal(result.transitions[0].from, state, label);
            assert.equal(result.transitions[result.transitions.length - 1].to, want, label);
            assert.deepEqual(result.transitions[0].actor, ACTORS[actor]);
          }
          allowed += 1;
        }
      }
    }
  }
  assert.equal(allowed, ALLOWED.reduce((sum, row) => sum + row[2].length, 0));
  assert.ok(refused > 500, `the matrix covers the refusals too (${refused})`);
});

test('the transition table in the code lists the same steps as the design table', () => {
  const coded = new Set(RELEASE_TRANSITIONS.filter((row) => row.from !== null).map((row) => `${row.from} ${row.event} ${row.to}`));
  const designed = new Set(ALLOWED.map(([from, event, , to]) => `${from} ${event.startsWith('guard') ? 'verdict' : event === 'approve-and-release' ? 'approve' : event} ${to}`));
  designed.delete('awaiting-decision approve released');
  assert.deepEqual([...coded].sort(), [...designed].sort());
  assert.deepEqual(RELEASE_TRANSITIONS.filter((row) => row.from === null).map((row) => `${row.event} ${row.to}`), ['propose draft']);
});

test('no agent can approve, reject, release or supersede, from any state, whatever its role on the product', () => {
  for (const state of RELEASE_STATES) {
    for (const agent of AGENT_NAMES) {
      for (const event of ['approve', 'approve-and-release', 'reject', 'release', 'supersede']) {
        const record = recordIn(state);
        const result = transition(record, EVENTS[event](record), ACTORS[agent]);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.reason, 'agent-cannot-decide', `${state} ${event} by ${agent}`);
      }
    }
  }
  // An agent that owns the product cannot withdraw it once a person has approved it either: that would undo a person's decision.
  for (const state of ['approved', 'released'] as const) {
    const result = transition(recordIn(state), EVENTS.withdraw(recordIn(state)), ACTORS.owner);
    assert.equal(result.ok ? 'allowed' : result.reason, 'agent-cannot-decide');
  }
});

test('the agent tool verbs include no decision, and every human-only event is one no agent verb names', () => {
  assert.deepEqual([...AGENT_PRODUCT_VERBS], ['propose', 'verdict', 'submit', 'withdraw', 'status', 'list']);
  assert.deepEqual([...HUMAN_ONLY_EVENTS], ['approve', 'reject', 'release', 'supersede']);
  for (const verb of AGENT_PRODUCT_VERBS) assert.ok(!(HUMAN_ONLY_EVENTS as readonly string[]).includes(verb), verb);
});

test('a decision needs a named person: name, role and device key', () => {
  const waiting = recordIn('awaiting-decision');
  for (const person of [
    { kind: 'person', name: '', role: 'Commander', deviceFingerprint: 'dev-1' },
    { kind: 'person', name: 'A. Demo', role: '', deviceFingerprint: 'dev-1' },
    { kind: 'person', name: 'A. Demo', role: 'Commander', deviceFingerprint: '' },
    { kind: 'person', name: 'A. Demo\nApproved', role: 'Commander', deviceFingerprint: 'dev-1' }
  ] as const) {
    const result = transition(waiting, { type: 'approve', hash: V1 }, person);
    assert.equal(result.ok ? 'allowed' : result.reason, 'unnamed-person');
  }
  const approved = transition(waiting, { type: 'approve', hash: V1 }, ACTORS.person);
  assert.ok(approved.ok);
  if (approved.ok) assert.deepEqual(approved.record.approval, { hash: V1, by: ACTORS.person });
});

test('the forbidden steps the design names are refused with their own reasons', () => {
  const reason = (result: ReleaseResult): string => (result.ok ? 'allowed' : result.reason);
  // Approve without the guard: a draft cannot be approved.
  assert.equal(reason(transition(recordIn('draft'), { type: 'approve', hash: V1 }, ACTORS.person)), 'wrong-state');
  // Release without approval.
  assert.equal(reason(transition(recordIn('awaiting-decision'), { type: 'release', hash: V1 }, ACTORS.person)), 'wrong-state');
  // Approval of a stale hash.
  assert.equal(reason(transition(recordIn('awaiting-decision'), { type: 'approve', hash: hash('older') }, ACTORS.person)), 'stale-version');
  // Release of a hash other than the approved one.
  assert.equal(reason(transition(recordIn('approved'), { type: 'release', hash: NEW }, ACTORS.person)), 'stale-version');
  // Edit after approval or release.
  assert.equal(reason(transition(recordIn('approved'), { type: 'edit', hash: NEW }, ACTORS.person)), 'locked');
  assert.equal(reason(transition(recordIn('released'), { type: 'propose', hash: NEW }, ACTORS.owner)), 'locked');
  // Rejected or held without reasons.
  assert.equal(reason(transition(recordIn('awaiting-decision'), { type: 'reject', reasons: [] }, ACTORS.person)), 'reasons-required');
  assert.equal(reason(transition(recordIn('awaiting-decision'), { type: 'reject', reasons: ['  '] }, ACTORS.person)), 'reasons-required');
  assert.equal(reason(transition(recordIn('draft'), { type: 'verdict', gate: 'guard', verdict: 'HOLD', hash: V1, reasons: [] }, ACTORS.guard)), 'reasons-required');
  assert.equal(reason(transition(recordIn('draft'), { type: 'withdraw', reason: '' }, ACTORS.owner)), 'reasons-required');
  // A guard verdict for another version.
  assert.equal(reason(transition(recordIn('draft'), { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: hash('other'), reasons: [] }, ACTORS.guard)), 'stale-version');
  // A verdict word from the other gate, and a verdict from someone who is not the gate.
  assert.equal(reason(transition(recordIn('draft'), { type: 'verdict', gate: 'guard', verdict: 'SIGN-OFF', hash: V1, reasons: [] }, ACTORS.guard)), 'wrong-verdict');
  assert.equal(reason(transition(recordIn('draft'), { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: V1, reasons: [] }, ACTORS.owner)), 'not-gate-member');
  assert.equal(reason(transition(recordIn('draft'), { type: 'verdict', gate: 'tradecraft', verdict: 'SIGN-OFF', hash: V1, reasons: [] }, ACTORS.tradecraft)), 'no-tradecraft-gate');
  // Submit without naming the role that decides.
  assert.equal(reason(transition(recordIn('guard-checked'), { type: 'submit', decisionFor: ' ' }, ACTORS.owner)), 'decision-for-required');
  // The same content again is not a new version; a malformed hash is refused.
  assert.equal(reason(transition(recordIn('draft'), { type: 'edit', hash: V1 }, ACTORS.other)), 'no-change');
  assert.equal(reason(transition(recordIn('draft'), { type: 'propose', hash: 'not-a-hash' }, ACTORS.owner)), 'bad-input');
  // Superseded only by a newer version; nothing leaves a terminal state.
  assert.equal(reason(transition(recordIn('released'), { type: 'supersede', byVersion: 1 }, ACTORS.person)), 'out-of-order');
  assert.equal(reason(transition(recordIn('superseded'), { type: 'withdraw', reason: 'x' }, ACTORS.person)), 'terminal');
  assert.equal(reason(transition(recordIn('withdrawn'), { type: 'edit', hash: NEW }, ACTORS.person)), 'terminal');
});

test('J2 products need the tradecraft sign-off on the exact version before the guard can clear them', () => {
  const draft = must(startProduct(J2, ACTORS.owner, V1));
  const cleared = { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: V1, reasons: [] } as const;
  const skipped = transition(draft, cleared, ACTORS.guard);
  assert.equal(skipped.ok ? 'allowed' : skipped.reason, 'tradecraft-required');

  const notReady = must(transition(draft, { type: 'verdict', gate: 'tradecraft', verdict: 'NOT READY', hash: V1, reasons: ['Likelihood and confidence in one sentence.'] }, ACTORS.tradecraft));
  assert.equal(notReady.state, 'draft');
  assert.deepEqual(notReady.held, { gate: 'tradecraft', reasons: ['Likelihood and confidence in one sentence.'] });

  const signed = must(transition(notReady, { type: 'verdict', gate: 'tradecraft', verdict: 'SIGN-OFF', hash: V1, reasons: [] }, ACTORS.tradecraft));
  assert.equal(signed.held, undefined);
  assert.equal(signed.tradecraftSignOff, V1);

  // An edit voids the sign-off: the new version needs its own.
  const edited = must(transition(signed, { type: 'edit', hash: NEW }, ACTORS.other));
  assert.equal(edited.version, 2);
  assert.equal(edited.tradecraftSignOff, undefined);
  const stale = transition(edited, { ...cleared, hash: NEW }, ACTORS.guard);
  assert.equal(stale.ok ? 'allowed' : stale.reason, 'tradecraft-required');

  const checked = must(transition(signed, cleared, ACTORS.guard));
  assert.equal(checked.state, 'guard-checked');
  assert.equal(checked.guardCleared, V1);
  // The tradecraft reviewer is not the guard and the guard is not the tradecraft reviewer.
  assert.equal((r => (r.ok ? 'allowed' : r.reason))(transition(signed, cleared, ACTORS.tradecraft)), 'not-gate-member');
});

test('an edit voids every verdict and the pending decision, and counts the version up', () => {
  const waiting = recordIn('awaiting-decision');
  const edited = must(transition(waiting, { type: 'edit', hash: NEW }, ACTORS.other));
  assert.equal(edited.state, 'draft');
  assert.equal(edited.version, 2);
  assert.equal(edited.hash, NEW);
  assert.equal(edited.guardCleared, undefined);
  assert.equal(edited.decisionFor, undefined);
});

test('a rejected product keeps its reasons when the owner revises it', () => {
  const rejected = recordIn('rejected');
  const revised = must(transition(rejected, { type: 'propose', hash: NEW }, ACTORS.owner));
  assert.equal(revised.state, 'draft');
  assert.equal(revised.version, 2);
  assert.deepEqual(revised.rejection?.reasons, ['Return with guidance on the main effort.']);
  assert.equal(revised.rejection?.version, 1);
});

test('approve with release on approval records two steps, approval first', () => {
  const result = transition(recordIn('awaiting-decision'), { type: 'approve', hash: V1, releaseOnApproval: true }, ACTORS.person);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.transitions.map((step) => `${step.from}>${step.to}:${step.event}`), ['awaiting-decision>approved:approve', 'approved>released:release']);
  assert.equal(result.record.state, 'released');
});

test('starting a product: only the owner, with well-formed roles, where no gate checks its own work', () => {
  const reason = (result: ReleaseResult): string => (result.ok ? 'allowed' : result.reason);
  assert.equal(reason(startProduct(PLAIN, ACTORS.other, V1)), 'not-owner');
  assert.equal(reason(startProduct(PLAIN, ACTORS.person, V1)), 'not-owner');
  assert.equal(reason(startProduct({ ...PLAIN, roles: { ...PLAIN.roles, releaseGuard: 'lead-planner' } }, ACTORS.owner, V1)), 'bad-input');
  assert.equal(reason(startProduct({ ...J2, roles: { ...J2.roles, tradecraftReviewer: 'release-guard' } }, ACTORS.owner, V1)), 'bad-input');
  assert.equal(reason(startProduct({ ...PLAIN, product: 'Bad Name' }, ACTORS.owner, V1)), 'bad-input');
  assert.equal(reason(startProduct({ ...PLAIN, section: 'j10' as never }, ACTORS.owner, V1)), 'bad-input');
  const started = startProduct(PLAIN, ACTORS.owner, V1);
  assert.ok(started.ok);
  if (started.ok) {
    assert.deepEqual(started.transitions, [{ product: 'concept-of-operations', section: 'j5', version: 1, hash: V1, from: null, to: 'draft', event: 'propose', actor: ACTORS.owner }]);
  }
});

test('replay plays a whole life and returns every step in order, or the first refusal', () => {
  const life = replay(PLAIN, { actor: ACTORS.owner, hash: V1 }, [
    { event: { type: 'verdict', gate: 'guard', verdict: 'HOLD', hash: V1, reasons: ['Coordinates outside the exercise box.'] }, actor: ACTORS.guard },
    { event: { type: 'propose', hash: NEW }, actor: ACTORS.owner },
    { event: { type: 'verdict', gate: 'guard', verdict: 'CLEARED', hash: NEW, reasons: [] }, actor: ACTORS.guard },
    { event: { type: 'submit', decisionFor: 'Commander' }, actor: ACTORS.lead },
    { event: { type: 'approve', hash: NEW }, actor: ACTORS.person },
    { event: { type: 'release', hash: NEW }, actor: ACTORS.person }
  ]);
  assert.ok(life.ok);
  if (!life.ok) return;
  assert.deepEqual(life.transitions.map((step) => `${step.to}@${step.version}`), ['draft@1', 'draft@1', 'draft@2', 'guard-checked@2', 'awaiting-decision@2', 'approved@2', 'released@2']);
  assert.deepEqual(life.transitions[1].reasons, ['Coordinates outside the exercise box.']);
  const blocked = replay(PLAIN, { actor: ACTORS.owner, hash: V1 }, [{ event: { type: 'approve', hash: V1 }, actor: ACTORS.owner }]);
  assert.equal(blocked.ok ? 'allowed' : blocked.reason, 'agent-cannot-decide');
});

test('refusal sentences are plain: no em-dash, no provisional or preview wording', () => {
  for (const sentence of Object.values(RELEASE_REFUSALS)) {
    assert.ok(!sentence.includes(String.fromCharCode(0x2014)), sentence);
    assert.ok(!/provisional|preview/i.test(sentence), sentence);
  }
});
