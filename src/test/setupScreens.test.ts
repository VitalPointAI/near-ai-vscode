import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFor, type CardOutcome } from '../domain/setup/cards';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_ROUTING } from '../domain/gate/routing';
import type { OptionOutcome } from '../domain/setup/recommend';
import { GET_STARTED_BODY, screenFor, type ScreenInputs } from '../domain/setup/screens';
import { STOP_CLASSIFIED_TEXT } from '../domain/setup/words';
import { startSession } from '../domain/setup/session';

type AssertTrue<T extends true> = T;
export type CardContract = AssertTrue<OptionOutcome extends CardOutcome ? true : false>;

const inputs: ScreenInputs = {
  cards: [], candidates: [], scan: { offered: false, running: false, ranges: [] },
  checkedOn: 'development computer', contacts: [], startingRules: false,
};

test('screens on the way', () => {
  const session = startSession({ now: 0 });
  const screen = screenFor(session, inputs);
  assert.equal(screen.kind, 'question');
  assert.match(screen.heading, /^Step 1 of /);
  assert.equal(screen.choices.length, 6);
  assert.equal(screen.choices.at(-1)?.text, 'Something else');

  const outcome: OptionOutcome = { optionId: 'near-private', kind: 'near-private', outcome: 'recommended' };
  const recommended = cardFor({
    outcome, viability: { optionId: outcome.optionId, kind: outcome.kind, models: [], state: 'viable', hostKind: 'desktop' },
    context: { mark: [], routing: DEFAULT_ROUTING }, scales: SCALE_PRESETS,
  });
  const options = screenFor({ ...session, state: 'choosing', screen: 'options' }, {
    ...inputs, cards: [{ ...recommended, optionId: 'near-all', outcome: 'available' }, recommended],
  });
  assert.equal(options.kind, 'options');
  assert.equal(options.recommended[0], recommended);
  const check = screenFor({ ...session, state: 'reviewing', screen: 'check-answers' }, inputs);
  assert.equal(check.kind, 'check');
  assert.equal(check.applyText, 'Apply these settings');
});

test('headings for screen readers count only visible questions', () => {
  const session = startSession({ now: 0, prefill: { fixed: ['kind-of-work'], kindOfWork: 'software', data: ['personal', 'contract'] },
    locked: { canada: true } });
  for (const [index, question] of (['data', 'data-personal', 'data-contract'] as const).entries()) {
    const model = screenFor({ ...session, screen: question }, inputs);
    assert.equal(model.kind, 'question');
    assert.match(model.heading, new RegExp(`^Step ${index + 1} of 3: `));
    assert.equal(model.steps.filter(({ state }) => state === 'current').length, 1);
  }
});

test('fixed answers name their source and the check page offers Q4', () => {
  const session = startSession({ now: 0, prefill: { fixed: ['kind-of-work'], kindOfWork: 'software', data: ['internal'] }, locked: { canada: true } });
  const model = screenFor({ ...session, state: 'reviewing', screen: 'check-answers' }, inputs);
  assert.equal(model.kind, 'check');
  assert.ok('answers' in model);
  const answers = model.answers as readonly { key: string; source?: string; changeText?: string; value: readonly string[] }[];
  assert.equal(answers.find(({ key }) => key === 'kindOfWork')?.source, 'Set by this project');
  assert.equal(answers.find(({ key }) => key === 'canada')?.source, 'Set by your organization');
  assert.deepEqual(answers.find(({ key }) => key === 'agentWork')?.value, ['Yes, that is the point']);
});

test('stopped shows only the reason and the device approval note', () => {
  const session = { ...startSession({ now: 0, answers: { data: ['classified'] } }), state: 'choosing', screen: 'stopped',
    recommendation: { state: 'stopped', reasonId: 'classified', reason: STOP_CLASSIFIED_TEXT, options: [] } } as const;
  const model = screenFor(session, { ...inputs, approvedDevice: 'Station officer' });
  assert.equal(String(model.kind), 'stopped');
  assert.ok('sentence' in model && 'approvedDevice' in model);
  assert.match(String(model.sentence), /security officer/);
  assert.equal(model.approvedDevice, 'Recorded as approved for that level by Station officer.');
  assert.equal('available' in model, false);
});

test('failed-closed policy exposes only fix information', () => {
  const model = screenFor({ ...startSession({ now: 0 }), state: 'choosing', screen: 'options' }, {
    ...inputs, policy: { state: 'failed-closed', sentence: 'Reload your rules.', contacts:
      [{ topic: 'security', name: 'Security team', how: 'security@example.test' }] },
  });
  assert.equal(String(model.kind), 'fix');
  assert.ok('sentence' in model);
  assert.equal(model.sentence, 'Reload your rules.');
  assert.match(model.whoToAsk, /Security team/);
  assert.deepEqual(model.steps, []);
  assert.equal('pauseText' in model, false);
});

test('partly applied lists completed and pending work with landing details', () => {
  const session = startSession({ now: 0 });
  const model = screenFor({ ...session, state: 'partly-applied', screen: 'done',
    changes: [
      { id: 'label', area: 'label', group: 'changed', effect: 'apply', text: 'Changed the project label.' },
      { id: 'answers', area: 'answers', group: 'changed', effect: 'apply', text: 'Save your answers.' },
    ],
    report: { state: 'partly-applied', steps: [{ id: 'label', outcome: 'done' }, { id: 'answers', outcome: 'waiting', message: 'Try again later.' }] },
  }, { ...inputs, landing: { target: 'chat', checklist: [] } });
  assert.equal(String(model.kind), 'done');
  assert.ok('done' in model && 'notDone' in model && 'landing' in model);
  assert.match(JSON.stringify(model.done), /Changed the project label/);
  assert.match(JSON.stringify(model.notDone), /Try again later/);
  assert.deepEqual(model.landing, { target: 'chat', checklist: [] });
});

test('check page renders label names and describes a run with nothing to apply', () => {
  const model = screenFor({ ...startSession({ now: 0, answers: { data: ['protected-b', 'classified'] } }),
    state: 'reviewing', screen: 'check-answers' }, inputs);
  assert.equal(model.kind, 'check');
  assert.ok('nothingChangedText' in model);
  assert.match(String(model.nothingChangedText), /No settings will change/);
  assert.match(JSON.stringify(model), /Canada, Protected: Protected B/);
  assert.doesNotMatch(JSON.stringify(model), /(?:org|ca-protected|ca-classified|nato)\/[A-Z]/);
});

test('page skeleton has one polite region and a focusable heading', () => {
  assert.equal((GET_STARTED_BODY.match(/aria-live="polite"/g) ?? []).length, 1);
  assert.match(GET_STARTED_BODY, /<h1 id="heading" tabindex="-1">/);
});

test('checking and options preserve the same help and surface scan text', () => {
  const start = startSession({ now: 0 });
  const sharedInputs = { ...inputs, candidates: [{ id: 'server', name: 'Lab server', host: 'server.local', port: 8080,
    state: 'found' as const, action: 'ask' as const }], scan: { offered: true, running: false, ranges: ['192.0.2.0/24'], confirmText: 'Check this network range.' } };
  const checking = screenFor({ ...start, state: 'checking', screen: 'checking', stillChecking: ['this-computer'] }, sharedInputs);
  const options = screenFor({ ...start, state: 'choosing', screen: 'options' }, sharedInputs);
  assert.equal(checking.kind, 'checking');
  assert.ok('continueText' in checking);
  assert.equal(checking.continueText, 'Continue without them');
  assert.equal(options.kind, 'options');
  assert.ok('candidates' in options && 'scan' in options);
  assert.match(JSON.stringify(options.candidates), /Ask .* to approve it/);
  assert.match(JSON.stringify(options.scan), /Check this network range/);
  assert.equal(checking.whoToAsk, options.whoToAsk);
});
