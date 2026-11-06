// Which model a cyber scan runs on (owner decision 2026-11-05). The rule is pure, so it is pinned here on its own: an engagement's own
// choice wins, the only abliterated model offered is used silently, several ask, none falls back with a note.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHOOSE_ABLITERATED_TEXT, NO_ABLITERATED_TEXT, chooseCyberModel, isAbliteratedModel } from '../domain/cyberModel';

const ABLITERATED = 'deepseek-ai/DeepSeek-V4.1-Flash-1017-abliterated';
const OTHER_ABLITERATED = 'z-ai/z-abliterated';

test('an abliterated model is one whose id says so, whatever its casing', () => {
  assert.equal(isAbliteratedModel(ABLITERATED), true);
  assert.equal(isAbliteratedModel('some/Abliterated-Model-7b'), true);
  assert.equal(isAbliteratedModel('deepseek-ai/DeepSeek-V4.1-Flash-1017'), false);
  assert.equal(isAbliteratedModel('qwen/qwen3-coder'), false);
  assert.equal(isAbliteratedModel(''), false);
});

test('with one abliterated model offered it is used, and a stored choice always wins', () => {
  assert.deepEqual(chooseCyberModel(['chat-model', ABLITERATED], undefined, 'chat-model'), { kind: 'use', model: ABLITERATED });
  // A person's own choice is never overridden, even by the only abliterated model, and even when it is a safety-tuned one.
  assert.deepEqual(chooseCyberModel(['chat-model', ABLITERATED], 'chat-model', 'chat-model'), { kind: 'use', model: 'chat-model' });
  assert.deepEqual(chooseCyberModel(['chat-model', ABLITERATED], OTHER_ABLITERATED, 'chat-model'), { kind: 'use', model: OTHER_ABLITERATED });
});

test('with several abliterated models the person is asked, and nothing is guessed between equals', () => {
  assert.deepEqual(chooseCyberModel(['chat-model', ABLITERATED, OTHER_ABLITERATED], undefined, 'chat-model'), { kind: 'choose', models: [ABLITERATED, OTHER_ABLITERATED] });
  // The same model listed twice is one choice, not two.
  assert.deepEqual(chooseCyberModel([ABLITERATED, ABLITERATED], undefined, 'chat-model'), { kind: 'use', model: ABLITERATED });
});

test('with none offered the default stands and says so', () => {
  const none = chooseCyberModel(['chat-model', 'other-model'], undefined, 'chat-model');
  assert.deepEqual(none, { kind: 'none', fallback: 'chat-model' });
  assert.deepEqual(chooseCyberModel([], undefined, 'chat-model'), { kind: 'none', fallback: 'chat-model' });
  // Blank entries in the list never count as a model.
  assert.deepEqual(chooseCyberModel(['  ', ''], undefined, 'chat-model'), { kind: 'none', fallback: 'chat-model' });
});

test('the sentences the panel shows are plain words with no em or en dash', () => {
  for (const text of [NO_ABLITERATED_TEXT, CHOOSE_ABLITERATED_TEXT]) {
    assert.equal(/[\u2013\u2014]/.test(text), false, text);
    assert.ok(text.length > 20, 'a whole sentence, not a fragment');
  }
  assert.match(NO_ABLITERATED_TEXT, /abliterated model/);
  assert.match(CHOOSE_ABLITERATED_TEXT, /Several abliterated models/);
});
