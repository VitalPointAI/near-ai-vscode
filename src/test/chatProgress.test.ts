import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePrompt, progressCardFromEvent, validatePromptResponse } from '../domain/chatProgress';

const prompt = normalizePrompt({
  sessionId: 'session-demo-001', promptId: 'choose-plan', question: 'Which plan should Open-GSD run?',
  choices: [{ id: 'safe', label: 'Safe plan', description: 'Review before execution.' }, { id: 'fast', label: 'Fast plan' }],
  freeForm: { enabled: true, minLength: 3, maxLength: 80 }, state: 'active', phase: '03', plans: ['03-05']
});

test('structured prompt accepts ordered choices and free-form answers', () => {
  assert.ok(prompt);
  assert.equal(prompt?.choices[0].id, 'safe');
  assert.equal(validatePromptResponse({ type: 'prompt-choice', sessionId: 'session-demo-001', promptId: 'choose-plan', choiceId: 'fast' }, prompt), true);
  assert.equal(validatePromptResponse({ type: 'prompt-answer', sessionId: 'session-demo-001', promptId: 'choose-plan', text: 'custom answer' }, prompt), true);
  assert.equal(validatePromptResponse({ type: 'prompt-choice', sessionId: 'session-demo-001', promptId: 'choose-plan', choiceId: 'unknown' }, prompt), false);
});

test('prompt rejects credential-shaped questions and malformed choices', () => {
  assert.equal(normalizePrompt({ ...prompt, question: 'apiKey: secret' }), undefined);
  assert.equal(normalizePrompt({ ...prompt, choices: [{ id: 'bad id', label: 'No' }] }), undefined);
  assert.equal(normalizePrompt({ sessionId: 'session-other-001', promptId: 'choose-plan', question: 'Choose', choices: [], state: 'active', plans: [] })?.sessionId, 'session-other-001');
});

test('prompt responses are bound to the active session and prompt and cancellation is valid', () => {
  assert.ok(prompt);
  assert.equal(validatePromptResponse({ type: 'prompt-cancel', sessionId: 'session-other-001', promptId: 'choose-plan' }, prompt), false);
  assert.equal(validatePromptResponse({ type: 'prompt-cancel', sessionId: 'session-demo-001', promptId: 'choose-plan' }, prompt), true);
  assert.equal(validatePromptResponse({ type: 'prompt-resume', sessionId: 'session-demo-001', promptId: 'choose-plan' }, { ...prompt!, state: 'waiting' }), true);
});

test('progress cards normalize lifecycle states, redact output, and expose recovery', () => {
  const states = ['started', 'running', 'waiting', 'retry', 'completed', 'cancelled', 'failed'];
  for (const state of states) {
    const card = progressCardFromEvent({ state, command: 'progress', phase: '03-05', model: 'model-a', agent: 'planner', agentCount: 2, attempt: state === 'retry' ? 2 : 1, text: state === 'failed' ? 'authorization=secret and chain-of-thought hidden' : state });
    assert.equal(card.reducedMotionSafe, true);
    assert.equal(card.phase, '03-05');
    assert.doesNotMatch(card.summary, /secret|chain-of-thought/);
    if (state === 'failed' || state === 'cancelled' || state === 'completed') assert.ok(card.recovery);
  }
  assert.equal(progressCardFromEvent({ state: 'waiting', command: 'progress', approvalRequired: true }).state, 'approval');
});
