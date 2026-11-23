import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGuideInbound } from '../domain/setup/guideMessages';
import { nextSession, questionOrder, startSession, type GuideEvent, type GuideSession } from '../domain/setup/session';
import type { Recommendation } from '../domain/setup/recommend';
import { CHECKING_CEILING_MS, type ViabilityResult } from '../domain/setup/viability';
import type { ApplyReport, ChangeItem } from '../domain/setup/changes';

const viable: ViabilityResult = {
  optionId: 'near-private', kind: 'near-private', state: 'viable', answeredAt: 10, models: [], hostKind: 'desktop',
};
const recommendation: Recommendation = {
  state: 'recommended', recommendedId: viable.optionId, reasonId: 'only-viable', reason: 'It can handle this work.',
  options: [{ optionId: viable.optionId, kind: viable.kind, outcome: 'recommended' }],
};

test('SC1 path, pure', () => {
  let session = startSession({ now: 0 });
  assert.equal(session.state, 'answering');
  let transition;
  for (const raw of [
    { type: 'answer', key: 'kindOfWork', value: 'software' }, { type: 'next' },
    { type: 'answer', key: 'data', value: ['internal'] }, { type: 'next' },
    { type: 'answer', key: 'canada', value: 'no' }, { type: 'next' },
  ]) {
    const event = parseGuideInbound(raw);
    assert.ok(event?.type === 'answer' || event?.type === 'next');
    transition = nextSession(session, event, 10);
    session = transition.session;
  }
  assert.equal(session.state, 'checking');
  assert.deepEqual(transition?.effects.map(({ type }) => type), ['run-viability', 'start-ceiling']);
  transition = nextSession(session, { type: 'viability-done', results: [viable] }, 10);
  assert.deepEqual(transition.effects.map(({ type }) => type), ['compute-recommendation']);
  session = nextSession(transition.session, { type: 'recommendation', recommendation }, 10).session;
  assert.deepEqual([session.state, session.screen], ['choosing', 'options']);
  session = nextSession(session, { type: 'choose', optionId: viable.optionId }, 10).session;
  transition = nextSession(session, { type: 'review' }, 10);
  assert.deepEqual(transition.effects.map(({ type }) => type), ['compute-changes']);
  session = nextSession(transition.session, { type: 'changes-ready', changes: [] }, 10).session;
  assert.deepEqual([session.state, session.screen], ['reviewing', 'check-answers']);
  transition = nextSession(session, { type: 'apply' }, 10);
  assert.equal(transition.session.state, 'applying');
  assert.deepEqual(transition.effects.map(({ type }) => type), ['apply']);
});

test('strict messages', () => {
  const valid = { type: 'answer', key: 'canada', value: 'no' };
  assert.deepEqual(parseGuideInbound(valid), valid);
  for (const invalid of [
    { type: 'unknown' },
    { ...valid, key: 'unknown' },
    { ...valid, extra: true },
    { ...valid, value: 1 },
    { type: 'reason', text: 'x'.repeat(201) },
  ]) {
    assert.equal(parseGuideInbound(invalid), undefined);
  }
});

const base = startSession({ now: 0, answers: { kindOfWork: 'software', data: ['internal'], canada: 'no' } });
const stateAt = (state: GuideSession['state'], screen: GuideSession['screen']): GuideSession => ({ ...base, state, screen });

test('D-17: every transition', () => {
  const review = stateAt('reviewing', 'check-answers');
  const label: ChangeItem = { id: 'label', area: 'label', group: 'changed', effect: 'apply', text: 'Set the project label.' };
  const connection: ChangeItem = { id: 'connection:near-private', area: 'connection', group: 'added', effect: 'apply', text: 'Add a connection.' };
  const applying = { ...stateAt('applying', 'applying'), changes: [label, connection] };
  const partial: ApplyReport = { state: 'partly-applied', steps: [{ id: label.id, outcome: 'failed' }, { id: connection.id, outcome: 'done' }] };
  const partly = { ...applying, state: 'partly-applied' as const, report: partial };
  const completed = { ...stateAt('applied', 'done'), previous: { v: 1 as const, answers: base.answers, chosen: [], pending: [] } };
  const scenarios: readonly [GuideSession, GuideEvent, GuideSession['state']][] = [
    [startSession({ now: 0, started: false }), { type: 'start' }, 'answering'],
    [stateAt('answering', 'canada'), { type: 'next' }, 'checking'],
    [review, { type: 'change', screen: 'data' }, 'answering'],
    [review, { type: 'apply' }, 'applying'],
    [applying, { type: 'apply-done', report: { state: 'applied', steps: [] } }, 'applied'],
    [applying, { type: 'apply-done', report: partial }, 'partly-applied'],
    [partly, { type: 'restart' }, 'reviewing'],
    [completed, { type: 'restart' }, 'answering'],
  ];
  for (const [from, event, to] of scenarios) {
    assert.equal(nextSession(from, event, 1).session.state, to, `${from.state} -> ${event.type}`);
  }
  assert.deepEqual(nextSession(partly, { type: 'restart' }, 1).session.changes, [label]);
  assert.deepEqual(nextSession(completed, { type: 'restart' }, 1).session.answers, base.answers);
});

test('pause and abandon every state before Apply', () => {
  for (const [state, screen] of [
    ['not-started', 'kind-of-work'], ['answering', 'kind-of-work'], ['checking', 'checking'],
    ['choosing', 'options'], ['reviewing', 'check-answers'],
  ] as const) {
    const original = stateAt(state, screen);
    const paused = nextSession(original, { type: 'pause' }, 10);
    assert.equal(paused.session.state, 'paused');
    assert.ok(paused.effects.some(({ type }) => type === 'save-progress'));
    const resumed = nextSession(paused.session, { type: 'resume' }, 20);
    assert.deepEqual([resumed.session.state, resumed.session.screen], [state, screen]);
    assert.deepEqual(resumed.session.answers, original.answers);
    assert.deepEqual(nextSession(paused.session, { type: 'abandon' }, 10).effects, [{ type: 'record-abandoned', screen }]);
    const abandoned = nextSession(original, { type: 'abandon' }, 10);
    assert.equal(abandoned.session.state, 'abandoned');
    assert.deepEqual(abandoned.effects, [{ type: 'record-abandoned', screen }]);
    assert.equal(nextSession(abandoned.session, { type: 'next' }, 10).session, abandoned.session);
  }
  const applying = stateAt('applying', 'applying');
  for (const type of ['next', 'pause', 'abandon', 'back', 'apply'] as const) {
    assert.equal(nextSession(applying, { type }, 0).session, applying);
  }
});

test('no state waits forever on a slow probe', () => {
  const checking = nextSession(stateAt('answering', 'canada'), { type: 'next' }, 0).session;
  const slow: ViabilityResult = { ...viable, state: 'checking', answeredAt: undefined };
  const inFlight = nextSession(checking, { type: 'viability-progress', result: slow }, 1).session;
  assert.equal(nextSession(inFlight, { type: 'ceiling' }, CHECKING_CEILING_MS - 1).session, inFlight);
  assert.equal(nextSession(inFlight, { type: 'continue-without-slow' }, 1).session, inFlight);
  const ceiling = nextSession(inFlight, { type: 'ceiling' }, CHECKING_CEILING_MS).session;
  assert.equal(ceiling.state, 'checking');
  assert.deepEqual(ceiling.stillChecking, [slow.optionId]);
  const continued = nextSession(ceiling, { type: 'continue-without-slow' }, CHECKING_CEILING_MS);
  assert.ok(continued.effects.some(({ type }) => type === 'compute-recommendation'));
  const noFit: Recommendation = { state: 'none', reasonId: 'no-option', reason: 'Ask your contact.', options: [] };
  assert.equal(nextSession(continued.session, { type: 'recommendation', recommendation: noFit }, CHECKING_CEILING_MS).session.state, 'choosing');
});

test('D16 and D-39: fixed and locked answers skip their questions', () => {
  const start = startSession({ now: 0, prefill: { fixed: ['kind-of-work'], kindOfWork: 'staff' }, locked: { canada: true } });
  assert.equal(start.screen, 'data');
  assert.equal(start.answers.canada, 'yes');
  assert.equal(nextSession(start, { type: 'answer', key: 'canada', value: 'no' }, 0).session, start);
  assert.deepEqual(questionOrder({ ...start.answers, data: ['personal', 'contract'] }, start.fixed, start.locked),
    ['data', 'data-personal', 'data-contract', 'checking']);
});

test('forged and stale choices cannot advance to Apply', () => {
  const checking = stateAt('checking', 'checking');
  assert.equal(nextSession(checking, { type: 'apply' }, 0).session, checking);
  const choosing = { ...stateAt('choosing', 'options'), results: [viable], recommendation };
  assert.equal(nextSession(choosing, { type: 'choose', optionId: 'near-all' }, 10).session, choosing);
  assert.equal(nextSession(choosing, { type: 'choose', optionId: 'near-private' }, 700_000).session, choosing);
  const stopped = { ...choosing, screen: 'stopped' as const, recommendation: { ...recommendation, state: 'stopped' as const } };
  assert.equal(nextSession(stopped, { type: 'choose', optionId: 'near-private' }, 10).session, stopped);
  const requested = nextSession(stopped, { type: 'review' }, 10).session;
  const label: ChangeItem = { id: 'label', area: 'label', group: 'changed', effect: 'apply', text: 'Set the project label.' };
  const connection: ChangeItem = { ...label, id: 'connection:near-private', area: 'connection' };
  assert.deepEqual(nextSession(requested, { type: 'changes-ready', changes: [label, connection] }, 10).session.changes, [label]);
});

test('answer changes invalidate an earlier review', () => {
  const review = stateAt('reviewing', 'check-answers');
  const edited = nextSession(review, { type: 'answer', key: 'agentWork', value: 'answers-only' }, 1);
  assert.equal(edited.session.state, 'checking');
  assert.equal(edited.session.answers.agentWork, 'answers-only');
  assert.ok(edited.effects.some(({ type }) => type === 'run-viability'));
  assert.equal(nextSession(edited.session, { type: 'apply' }, 1).session, edited.session);
});

test('a provider removal requires an explicit confirmation', () => {
  const review = { ...stateAt('reviewing', 'check-answers'), changes: [
    { id: 'connection:this-computer', area: 'connection', group: 'removed', effect: 'apply', text: 'The connection stops working.' },
  ] } satisfies GuideSession;
  assert.equal(nextSession(review, { type: 'apply' }, 1).session, review);
  assert.equal(nextSession(review, { type: 'apply', confirmRemoval: true }, 1).session.state, 'applying');
});

test('a stale partial retry checks again and still offers only the remaining changes', () => {
  const label: ChangeItem = { id: 'label', area: 'label', group: 'changed', effect: 'apply', text: 'Set the project label.' };
  const connection: ChangeItem = { ...label, id: 'connection:near-private', area: 'connection' };
  const now = 700_000;
  const partial: GuideSession = {
    ...stateAt('partly-applied', 'done'), changes: [label, connection], chosen: viable.optionId, results: [viable], recommendation,
    report: { state: 'partly-applied', steps: [{ id: label.id, outcome: 'failed' }, { id: connection.id, outcome: 'done' }] },
  };
  const restarted = nextSession(partial, { type: 'restart' }, now).session;
  const review = nextSession(restarted, { type: 'changes-ready', changes: [label, connection] }, now).session;
  const checking = nextSession(review, { type: 'apply' }, now).session;
  assert.equal(checking.state, 'checking');
  assert.deepEqual(checking.retryIds, [label.id]);
  const done = nextSession(checking, { type: 'viability-done', results: [{ ...viable, answeredAt: now }] }, now).session;
  const options = nextSession(done, { type: 'recommendation', recommendation }, now).session;
  const chosen = nextSession(options, { type: 'choose', optionId: viable.optionId }, now).session;
  const requested = nextSession(chosen, { type: 'review' }, now).session;
  assert.deepEqual(nextSession(requested, { type: 'changes-ready', changes: [label, connection] }, now).session.changes, [label]);
});

test('an Apply recheck discards a selection ruled out by the new recommendation', () => {
  const applying: GuideSession = {
    ...stateAt('applying', 'applying'), chosen: viable.optionId, choiceReason: 'Capacity',
    results: [viable], recommendation, checkId: 3, retryIds: ['label']
  };
  const recheck: GuideEvent = { type: 'apply-recheck' };
  const transition = nextSession(applying, recheck, 10);
  const checking = transition.session;
  assert.equal(checking.state, 'checking');
  assert.deepEqual(checking.retryIds, ['label']);
  assert.deepEqual(transition.effects.map(({ type }) => type), ['run-viability', 'start-ceiling']);
  assert.equal(nextSession(checking, recheck, 10).session, checking);
  assert.equal(nextSession(checking, { type: 'viability-done', results: [viable], checkId: 3 }, 10).session, checking);
  const done = nextSession(checking, { type: 'viability-done', results: [viable], checkId: 4 }, 10).session;
  const nowRuledOut: Recommendation = {
    state: 'none', reasonId: 'no-option', reason: 'Choose another option.',
    options: [{ optionId: viable.optionId, kind: viable.kind, outcome: 'ruled-out' }]
  };
  const options = nextSession(done, { type: 'recommendation', recommendation: nowRuledOut, checkId: 4 }, 10).session;
  assert.equal(options.state, 'choosing');
  assert.equal(options.chosen, undefined);
  assert.equal(options.choiceReason, undefined);
  assert.equal(nextSession(options, { type: 'review' }, 10).session, options);
});

test('the page parser refuses malformed arrays, IDs and actions', () => {
  for (const raw of [
    { type: 'answer', key: 'data', value: ['personal', 'personal'] },
    { type: 'answer', key: 'data', value: Array(1) },
    { type: 'choose', optionId: 'this-computer:other' },
    { type: 'fix', optionId: 'near-private', action: 'terminal' },
    { type: 'approve-candidate', candidateId: 'https://example.com' },
    { type: 'scan-confirm', ranges: ['192.0.2.2/15'] },
    { type: 'scan-confirm', ranges: Array(1) },
    { type: 'apply', confirmRemoval: 'true' },
    { type: 'apply-recheck' },
  ]) assert.equal(parseGuideInbound(raw), undefined);
  assert.deepEqual(parseGuideInbound({ type: 'scan-confirm', ranges: ['192.0.2.0/24'] }),
    { type: 'scan-confirm', ranges: ['192.0.2.0/24'] });
});
