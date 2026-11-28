// Phase 33 plan 26 (D-21 to D-23, D-59): the native Staff Room draws the room the backend built with the live model from the engine bundle, and only
// draws it: the people, the sync sentence with one action, the cards and rows; a room that goes offline redraws with the banner. The browser's view
// type is the model's own (checked here, because the browser cannot import src/). Fictional exercise data only.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { StaffRoomEvents, staffRoomView, type StaffRoomHandlers } from '../extension/src/browser/staff/staff-room-view.ts';
import type { StaffRoom, StaffRoomLiveView } from '../extension/src/common/staff-room.ts';
import type { StaffRoomLiveInput, StaffRoomLiveView as ModelView } from '../../src/domain/staff/staffRoomLive.ts';
import { engine } from './helpers/staff-binding-world.ts';

type ViewMatches = ModelView extends StaffRoomLiveView ? true : never;
const viewMatches: ViewMatches = true;

// React's server renderer, from the copy Theia ships (the workbench has no React type package, so it is typed here).
const ReactDOMServer = createRequire(import.meta.url)('@theia/core/shared/react-dom/server') as { renderToStaticMarkup(element: unknown): string };

const AT_1402 = Date.parse('2026-11-24T14:02:00.000Z');
const handlers: StaffRoomHandlers = { act: () => undefined, decide: () => undefined, cancel: () => undefined };

function roomWith(status: StaffRoomLiveInput['status']): StaffRoom {
  const input: StaffRoomLiveInput = {
    status, isLeadDevice: false,
    people: [
      { member: 'mbr-avery', name: 'Avery Lead', position: 'j4-lead', live: true, lastSeen: AT_1402 },
      { member: 'mbr-blake', name: 'Blake Rivers', position: 'j4-planner', live: false, lastSeen: AT_1402 },
    ],
    products: [{ product: 'logistics-estimate', label: 'Internal', whoCanSee: ['Avery Lead', 'Blake Rivers'] }],
    versions: [{ product: 'logistics-estimate', hash: 'b'.repeat(64), number: 5, text: 'v5 awaiting decision, 37 changes since', changesSince: 37, ownerPromptDue: false }],
    contested: [], unconfirmed: [], joins: [], splits: [], agents: [],
  };
  return { project: 'a'.repeat(32), root: '/home/sterling/workspace/exercise', view: engine.staffRoomLive(input as never) as StaffRoomLiveView };
}

const text = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/\s+/g, ' ');
const buttons = (markup: string): string[] => [...markup.matchAll(/<button[^>]*aria-label="([^"]*)"/g)].map((match) => match[1]);

test('the room shows the names, the sync sentence and one action, with the product row in the model\'s words', () => {
  assert.equal(viewMatches, true);
  const markup = ReactDOMServer.renderToStaticMarkup(staffRoomView([roomWith({ state: 'live', findings: [] })], handlers) as never);
  const shown = text(markup);
  for (const words of ['Avery Lead', 'Blake Rivers', 'Live', 'Last seen 14:02', 'Synced with your organization\'s server.', 'v5 awaiting decision, 37 changes since', 'Who can see this: Avery Lead, Blake Rivers']) {
    assert.ok(shown.includes(words), words);
  }
  assert.deepEqual(buttons(markup), ['Sync Now'], 'one action');
  assert.doesNotMatch(markup, /role="alert"/, 'no banner while live');
  assert.match(markup, /class="codicon codicon-file"/, 'codicons only');
});

test('a room that goes offline redraws with the exact banner', () => {
  const events = new StaffRoomEvents();
  let changes = 0;
  events.onDidChange(() => { changes += 1; });
  events.onRoom(roomWith({ state: 'live', findings: [] }));
  events.onRoom(roomWith({ state: 'offline', findings: [], lastSyncedAt: AT_1402 }));
  assert.equal(changes, 2);
  assert.equal(events.rooms.length, 1, 'one room per shared work, the newest');
  const shown = text(ReactDOMServer.renderToStaticMarkup(staffRoomView(events.rooms, handlers) as never));
  assert.ok(shown.includes('You are offline. Your changes are kept here and will sync when your organization\'s server is back. Decisions you make now may become contested if someone else decides the same thing.'));
});

test('an open decision shows its dialog with the reasons field and three named buttons; no shared work shows the one sentence', () => {
  const room = { ...roomWith({ state: 'live', findings: [] }), pending: { ticket: 't-1', product: 'logistics-estimate', hash: 'b'.repeat(64), number: 5, settle: true, title: 'v5 of logistics-estimate' } };
  const markup = ReactDOMServer.renderToStaticMarkup(staffRoomView([room], handlers) as never);
  assert.match(markup, /role="dialog" aria-label="v5 of logistics-estimate"/);
  assert.match(markup, /<label for="sterling-staff-room-reasons-a{32}">Your reasons<\/label><textarea id="sterling-staff-room-reasons-a{32}"/);
  assert.deepEqual([...markup.matchAll(/<button type="button" class="theia-button[^"]*">([^<]+)</g)].map((match) => match[1]), ['Approve', 'Reject', 'Cancel']);
  assert.ok(text(ReactDOMServer.renderToStaticMarkup(staffRoomView([], handlers) as never)).includes('No shared work is open in this session.'));
});
