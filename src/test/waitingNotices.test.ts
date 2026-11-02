import assert from 'node:assert/strict';
import test from 'node:test';
import { announceNow, WaitingNotices } from '../services/waitingNotices';

// 0.4.11: an approval or question waiting while VS Code (or its browser tab) is in the background is announced.

test('waiting prompts: announced when the chat is hidden or the window is not focused, once per prompt', () => {
  assert.equal(announceNow({ panelVisible: true, windowFocused: true }), false);
  assert.equal(announceNow({ panelVisible: false, windowFocused: true }), true, 'the existing hidden-chat case');
  assert.equal(announceNow({ panelVisible: true, windowFocused: false }), true, 'a background browser tab counts as visible but is not focused');
  assert.equal(announceNow({}), false, 'unknown state: the chat shows it');
  const notices = new WaitingNotices();
  assert.equal(notices.opened('a', { panelVisible: true, windowFocused: false }, ['a']), true);
  assert.equal(notices.opened('a', { panelVisible: true, windowFocused: false }, ['a']), false, 'never twice');
  assert.equal(notices.opened('b', { panelVisible: true, windowFocused: true }, ['a', 'b']), false, 'the user is looking at the chat');
  assert.deepEqual(notices.focusRegained(['a', 'b']), ['b'], 'back in the window: the one not announced yet');
  assert.deepEqual(notices.focusRegained(['a', 'b']), [], 'once per prompt');
  // Settled prompts are forgotten; a new prompt reusing an ID is a new prompt.
  assert.deepEqual(notices.focusRegained([]), []);
  assert.equal(notices.opened('a', { windowFocused: false }, ['a']), true);
});
