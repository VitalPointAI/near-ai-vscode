// The fake DOM's nodes stay small when a failing assertion prints them (the 62-12 out-of-memory incident). Node's strict assert inspects both sides
// at depth 1000 and diffs the lines with a myers diff whose memory grows with the square of the line count, even when the assertion has its own
// message. While every node linked to the whole page through enumerable properties (doc, parentNode, childNodes), one failing focus or
// "no Edit button" check printed millions of lines and used gigabytes, and the OOM killer took VS Code down with the test process.
// The assertions here compare numbers and booleans only, never a node, and the cheap bare-page check runs first, so a regression fails in
// milliseconds instead of exhausting memory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { buildBoardModel } from '../domain/team/board';
import { boardWorld, seedStandardBoard } from './helpers/teamBoardWorld';
import { createBoardHarness } from './helpers/fakeDom';
import type { FakeNode } from './helpers/fakeDom';

/** The options Node's AssertionError uses to print each side of a failed comparison (internal/assert/assertion_error.js, inspectValue). */
const ASSERT_INSPECT = { compact: false, customInspect: false, depth: 1000, maxArrayLength: Infinity, showHidden: false, showProxy: false, sorted: true, getters: true } as const;
const lines = (value: unknown): number => inspect(value, ASSERT_INSPECT).split('\n').length;
/** A node prints its own fields and attributes, about 20 to 40 lines. The incident printed 1,509 lines for a detached button and millions in a drawn board. */
const NODE_LINES = 80;
const LINKS = ['doc', 'parentNode', 'childNodes', 'listeners'];

/** The tripwire: a button under #root in a page with nothing loaded. Broken links cost about two thousand lines here, which is cheap to detect. */
function assertBarePageNodesAreSmall(): void {
  const h = createBoardHarness();
  const button = h.document.createElement('button');
  button.setAttribute('type', 'button');
  button.addEventListener('click', () => undefined);
  button.appendChild(h.document.createTextNode('Edit'));
  h.root.appendChild(button);
  for (const key of LINKS) assert.equal(Object.keys(button).includes(key), false, `${key} is kept out of what inspect prints`);
  const sizes = [button, button.firstChild!, h.root, h.document.body].map(lines);
  assert.ok(sizes.every((size) => size < NODE_LINES), `nodes print small, got ${sizes.join(', ')} lines`);
  assert.equal(button.parentNode === h.root && h.root.childNodes.includes(button) && button.doc === h.document, true, 'the links still work');
}

function failureOf(run: () => void): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('the assertion was expected to fail');
}

test('a node in a bare page prints only itself, and the tree links still work', () => {
  assertBarePageNodesAreSmall();
});

test('a failing assertion on a node of the drawn board, with the detail open, has a short message', async () => {
  assertBarePageNodesAreSmall();
  const world = await boardWorld();
  seedStandardBoard(world);
  const h = createBoardHarness({ width: 800 });
  h.load(['board.js', 'menu.js', 'detail.js']);
  h.deliver({ type: 'state', model: buildBoardModel(world.state, { nowMs: Date.parse('2026-03-05T12:00:00.000Z'), status: { kind: 'live', text: 'Live' }, canWrite: true, viewerId: world.owner.memberId }) });
  const opener: FakeNode = h.$('.card[data-id="plan:90-01"] .card-main')!;
  opener.focus();
  h.press(opener, 'Enter');
  const nodes = h.document.all();
  assert.ok(nodes.length > 200, `the board is drawn (${nodes.length} elements)`);
  const largest = Math.max(...nodes.map(lines));
  assert.ok(largest < NODE_LINES, `every element prints small, the largest printed ${largest} lines`);

  // The incident's own shape: a node where undefined was expected, with a custom message. Before the fix this allocated gigabytes.
  const heading = h.focused();
  const error = failureOf(() => assert.equal(heading, undefined, 'imported items are not edited here'));
  const messageLines = error.message.split('\n').length;
  assert.ok(messageLines < NODE_LINES + 10, `the failure message is ${messageLines} lines`);
  assert.match(error.message, /imported items are not edited here/);
  assert.match(error.message, /localName: 'h2'/, 'the message still says which element it was');
});
