// "Check now" (owner, 2026-11-06): the chat was waiting on a CI or review verdict the person could already see was in, and there was no way to make it
// look again immediately.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { CHECK_NOW_MARKER, WAITING_INSTRUCTIONS, checkNowMessage, isCheckNow } from '../domain/checkNow';

test('the Check now message is marked, and says exactly what to do', () => {
  const message = checkNowMessage();
  assert.match(message, new RegExp(`^\\[${CHECK_NOW_MARKER}\\]`), 'it carries the marker');
  assert.match(message, /Check the real state now instead of waiting/);
  assert.match(message, /review verdict from GitHub again/);
  assert.match(message, /Do not sleep or wait again for this same verdict/);
  // It stands for itself: no em or en dash, plain words.
  assert.equal(/[\u2013\u2014]/.test(message), false);
  assert.equal(isCheckNow(message), true);
  assert.equal(isCheckNow('carry on with the plan'), false);
});

test('a run is told to wait in short polls, so a Check now lands quickly and an early verdict is seen at once', () => {
  assert.match(WAITING_INSTRUCTIONS, /never sleep for minutes in one command/);
  assert.match(WAITING_INSTRUCTIONS, /Poll in short steps/);
  assert.match(WAITING_INSTRUCTIONS, /no more than about 20 seconds/);
  assert.match(WAITING_INSTRUCTIONS, /Check now/);
  assert.match(WAITING_INSTRUCTIONS, /Steer/);
  assert.match(WAITING_INSTRUCTIONS, /\.near-ai\/scratch\//);
});

test('the chat shows a Check now button on a running agent, and it sends the marked message', () => {
  const page = readFileSync(path.join(__dirname, '..', '..', 'media', 'chat', 'chat.js'), 'utf8');
  // 0.4.18 review: assert the real click, not just that the words appear somewhere. The control is on the running row and posts the nudge action.
  assert.match(page, /textButton\('Check now', \(\) => post\(\{ type: 'agent-control', agentId: agent\.id, action: 'nudge' \}\)\)/, 'the button posts the nudge action');
});

test('the nudge action goes through the sidebar parser and reaches the agent as an interruption', async () => {
  const { parseChatWebviewMessage } = await import('../services/chatBridge');
  // The page posts this; the parser must accept it, or the button does nothing at all.
  const message = { type: 'agent-control', agentId: 'agent-1-abc123', action: 'nudge' };
  assert.deepEqual(parseChatWebviewMessage(message), { type: 'agent-control', agentId: 'agent-1-abc123', action: 'nudge' });
  // And the old actions are unchanged.
  for (const action of ['pause', 'resume', 'stop'] as const) {
    const parsed = parseChatWebviewMessage({ type: 'agent-control', agentId: 'agent-1-abc123', action }) as { action?: string } | undefined;
    assert.equal(parsed?.action, action);
  }
  assert.equal(parseChatWebviewMessage({ type: 'agent-control', agentId: 'agent-1-abc123', action: 'restart' }), undefined, 'an unknown action is refused');
});
