/**
 * The Staff Room's drawing (Phase 33 D-21 to D-26, D-59): a pure render of the rooms the backend sends (StaffRoomLiveView) as React elements, so the
 * unit tests draw it to markup without a page. Every sentence comes from the view or from STAFF_ROOM_TEXT; nothing here writes text of its own.
 * Each action is a button with its accessible name, and state is always said in words beside any dot or icon (codicons only).
 *
 * The workbench carries React through Theia but no React type package (and adds none, D-68), so the elements are made with createElement rather
 * than JSX.
 */
import React from '@theia/core/shared/react';
import { injectable } from '@theia/core/shared/inversify';
import { Emitter, type Event } from '@theia/core/lib/common/event.js';
import {
  STAFF_ROOM_TEXT, type StaffRoom, type StaffRoomAction, type StaffRoomCard, type StaffRoomClient, type StaffRoomLiveView,
} from '../../common/staff-room.js';

export interface StaffRoomHandlers {
  readonly act: (room: StaffRoom, action: StaffRoomAction) => void;
  /** The decision dialog's buttons: the outcome with the reasons typed, or cancel. */
  readonly decide: (room: StaffRoom, outcome: 'approve' | 'reject') => void;
  readonly cancel: (room: StaffRoom) => void;
}

/** This tab's Staff Room client: the rooms the backend sent, newest per shared work, and an event when one changed. */
@injectable()
export class StaffRoomEvents implements StaffRoomClient {
  private readonly changed = new Emitter<void>();
  private readonly byProject = new Map<string, StaffRoom>();
  readonly onDidChange: Event<void> = this.changed.event;

  get rooms(): StaffRoom[] {
    return [...this.byProject.values()];
  }

  onRoom(room: StaffRoom): void {
    this.byProject.set(room.project, room);
    this.changed.fire();
  }
}

/** The id of the reasons field of a shared work's decision dialog. */
export const reasonsFieldId = (room: StaffRoom): string => `sterling-staff-room-reasons-${room.project}`;

type Child = unknown;
const h = (tag: string, props: Record<string, unknown> | null, ...children: Child[]): unknown => React.createElement(tag, props, ...children);
const icon = (name: string): unknown => h('span', { className: `codicon ${name}`, 'aria-hidden': 'true' });

const ICONS: Readonly<Record<StaffRoomCard['kind'], string>> = {
  update: 'codicon-cloud-download',
  'early-share-copy': 'codicon-copy',
  contested: 'codicon-git-compare',
  join: 'codicon-person-add',
  'roster-split': 'codicon-git-merge',
  'owner-prompt': 'codicon-versions',
  agent: 'codicon-hubot',
  'switch-keys': 'codicon-shield',
  'move-keys': 'codicon-sync',
  'give-keys': 'codicon-key',
};

function button(room: StaffRoom, action: StaffRoomAction, handlers: StaffRoomHandlers, primary = false, key?: string): unknown {
  return h('button', {
    key, type: 'button', className: `theia-button ${primary ? '' : 'secondary'} sterling-staff-room-action`,
    'aria-label': action.accessibleName, title: action.accessibleName, onClick: () => handlers.act(room, action),
  }, action.label);
}

function card(room: StaffRoom, item: StaffRoomCard, handlers: StaffRoomHandlers): unknown {
  return h('li', { key: item.id, className: `sterling-staff-room-card sterling-staff-room-card-${item.kind}` },
    h('p', { className: 'sterling-staff-room-card-text' }, icon(ICONS[item.kind]), ' ', item.text),
    item.decisions === undefined ? null : h('ul', { className: 'sterling-staff-room-decisions' },
      ...item.decisions.map((decision, index) => h('li', { key: index }, h('strong', null, decision.name), `: ${decision.reasons.join(' ')}`))),
    item.trustLine === undefined ? null : h('p', { className: 'sterling-staff-room-trust' }, item.trustLine),
    item.branches === undefined ? null : h('ul', { className: 'sterling-staff-room-branches' },
      ...item.branches.map((branch) => h('li', { key: branch.action.branch }, branch.text, ' ', button(room, branch.action, handlers)))),
    item.actions.length === 0 ? null : h('div', { className: 'sterling-staff-room-actions' },
      ...item.actions.map((action, index) => button(room, action, handlers, index === 0, `${action.id}-${index}`))));
}

function decision(room: StaffRoom, handlers: StaffRoomHandlers): unknown {
  const pending = room.pending;
  if (pending === undefined) return null;
  const field = reasonsFieldId(room);
  return h('div', { className: 'sterling-staff-room-decision sterling-staff-room-card', role: 'dialog', 'aria-label': pending.title },
    h('p', null, icon('codicon-law'), ' ', pending.title),
    h('label', { htmlFor: field }, STAFF_ROOM_TEXT.reasons),
    h('textarea', { id: field, rows: 3 }),
    h('div', { className: 'sterling-staff-room-actions' },
      h('button', { type: 'button', className: 'theia-button', onClick: () => handlers.decide(room, 'approve') }, STAFF_ROOM_TEXT.dialogApprove),
      h('button', { type: 'button', className: 'theia-button secondary', onClick: () => handlers.decide(room, 'reject') }, STAFF_ROOM_TEXT.dialogReject),
      h('button', { type: 'button', className: 'theia-button secondary', onClick: () => handlers.cancel(room) }, STAFF_ROOM_TEXT.dialogCancel)));
}

function roomView(room: StaffRoom, handlers: StaffRoomHandlers): unknown {
  const view: StaffRoomLiveView = room.view;
  return h('section', { key: room.project, className: 'sterling-staff-room-section', 'aria-label': room.root },
    h('div', { className: 'sterling-staff-room-bar sterling-staff-room-card', role: 'status', 'aria-label': view.bar.accessibleName },
      h('span', { className: `sterling-staff-room-state sterling-staff-room-state-${view.bar.state}` }, view.bar.word),
      h('span', { className: 'sterling-staff-room-sentence' }, view.bar.sentence),
      button(room, view.bar.action, handlers)),
    view.banner === undefined ? null
      : h('div', { className: 'sterling-staff-room-banner sterling-staff-room-card', role: 'alert' }, icon('codicon-cloud-offline'), ' ', view.banner),
    h('h3', null, view.peopleHeading),
    h('ul', { className: 'sterling-staff-room-people' }, ...view.people.map((person) => h('li', {
      key: person.member, className: 'sterling-staff-room-person', 'aria-label': person.accessibleName, title: person.presence,
    },
    h('span', { className: `sterling-staff-room-dot ${person.live ? 'live' : 'away'}`, 'aria-hidden': 'true' }),
    h('span', { className: 'sterling-staff-room-name' }, person.name),
    person.position === undefined ? null : h('span', { className: 'sterling-staff-room-position' }, person.position),
    h('span', { className: 'sterling-staff-room-presence' }, person.presence)))),
    decision(room, handlers),
    view.cards.length === 0 ? null : h('ul', { className: 'sterling-staff-room-cards' }, ...view.cards.map((item) => card(room, item, handlers))),
    h('ul', { className: 'sterling-staff-room-rows' }, ...view.rows.map((row) => h('li', {
      key: row.product, className: 'sterling-staff-room-row sterling-staff-room-card', 'aria-label': row.accessibleName,
    },
    h('span', { className: 'sterling-staff-room-product' }, icon('codicon-file'), ' ', row.title),
    row.version === undefined ? null : h('span', { className: 'sterling-staff-room-version' }, row.version),
    row.label === undefined ? null : h('span', { className: 'sterling-staff-room-label' }, row.label),
    h('span', { className: 'sterling-staff-room-who' }, row.whoCanSee),
    row.unconfirmed === undefined ? null : h('span', { className: 'sterling-staff-room-unconfirmed' }, row.unconfirmed)))));
}

/** Every open shared work's room, or the one sentence when none is open. */
export function staffRoomView(rooms: readonly StaffRoom[], handlers: StaffRoomHandlers): unknown {
  return h('div', { className: 'sterling-staff-room' },
    h('h2', null, STAFF_ROOM_TEXT.title),
    rooms.length === 0 ? h('p', { className: 'sterling-staff-room-empty' }, STAFF_ROOM_TEXT.empty) : rooms.map((room) => roomView(room, handlers)));
}
