/**
 * The native Staff Room's channel (Phase 33 D-21 to D-26, D-44, D-59, D-60). The backend builds each open shared work's room with the pure live model
 * (src/domain/staff/staffRoomLive.ts) and sends it to every tab; the browser only draws it. A decision is two steps: beginDecision takes the
 * decision stamp of the version on screen and keeps it in the backend, and decide (or settle) writes the decision with it, signed by the person
 * key. When the version changed meanwhile, nothing is written and the answer is the changed-while-deciding sentence; when the confirmation with the
 * passkey or security key is too old, the answer carries the link that confirms it, and the same decision finishes after the person returns.
 *
 * The view types repeat the model's plain data here, because the browser cannot import src/; a workbench test checks the two match. Nothing here
 * imports Theia.
 */
import type { ServiceResult } from './service-result.js';

export const STAFF_ROOM_PATH = '/services/sterling-staff-room';
export const StaffRoomServer = Symbol('StaffRoomServer');

export interface StaffRoomAction {
  readonly id: string;
  readonly label: string;
  readonly accessibleName: string;
  readonly product?: string;
  readonly hash?: string;
  readonly invite?: string;
  readonly branch?: string;
}

export interface StaffRoomPerson {
  readonly member: string;
  readonly name: string;
  readonly position?: string;
  readonly live: boolean;
  readonly presence: string;
  readonly accessibleName: string;
}

export interface StaffRoomCard {
  readonly kind: 'update' | 'preview-copy' | 'contested' | 'join' | 'roster-split' | 'owner-prompt' | 'agent';
  readonly id: string;
  readonly text: string;
  readonly actions: readonly StaffRoomAction[];
  readonly decisions?: ReadonlyArray<{ readonly name: string; readonly outcome: string; readonly reasons: readonly string[] }>;
  readonly branches?: ReadonlyArray<{ readonly text: string; readonly action: StaffRoomAction }>;
  readonly trustLine?: string;
}

export interface StaffRoomRow {
  readonly product: string;
  readonly title: string;
  readonly version?: string;
  readonly label?: string;
  readonly whoCanSee: string;
  readonly unconfirmed?: string;
  readonly accessibleName: string;
}

/** The Staff Room's view of one shared work (staffRoomLive.ts StaffRoomLiveView). */
export interface StaffRoomLiveView {
  readonly peopleHeading: string;
  readonly people: readonly StaffRoomPerson[];
  readonly bar: { readonly state: string; readonly word: string; readonly sentence: string; readonly action: StaffRoomAction; readonly accessibleName: string };
  readonly banner?: string;
  readonly cards: readonly StaffRoomCard[];
  readonly rows: readonly StaffRoomRow[];
}

/** A decision begun and not finished: the backend keeps its stamp for the step-up window, so it survives the trip to confirm and back. */
export interface StaffPendingDecision {
  readonly ticket: string;
  readonly product: string;
  readonly hash: string;
  readonly number: number;
  readonly settle: boolean;
  /** The words the dialog shows for it. */
  readonly title: string;
}

/** One open shared work's room. */
export interface StaffRoom {
  readonly project: string;
  readonly root: string;
  readonly view: StaffRoomLiveView;
  readonly pending?: StaffPendingDecision;
}

/** The answer of decide and settle: written, refused with the sentence (and a fix), or a confirmation needed first. */
export type StaffDecisionResult =
  | { readonly kind: 'ok'; readonly value: { readonly hash: string } }
  | { readonly kind: 'refused'; readonly reason: string; readonly fix?: string }
  | { readonly kind: 'step-up'; readonly reason: string; readonly fix: string; readonly url: string };

export interface StaffRoomClient {
  /** A room changed; every tab redraws it. */
  onRoom(room: StaffRoom): void;
}

export interface StaffRoomServer {
  rooms(): Promise<StaffRoom[]>;
  /** Takes the stamp of the version on screen; the decision dialog opens only with its ticket. */
  beginDecision(project: string, product: string, hash: string, settle: boolean): Promise<ServiceResult<StaffPendingDecision>>;
  /** Writes the decision with the stamp taken at begin. `returnTo` is this page's path, where the confirmation comes back to. */
  decide(ticket: string, outcome: 'approve' | 'reject', reasons: readonly string[], returnTo: string): Promise<StaffDecisionResult>;
  /** Puts a begun decision away; nothing is written. */
  cancelDecision(ticket: string): Promise<void>;
  admit(project: string, invite: string): Promise<ServiceResult<string>>;
  decline(project: string, invite: string): Promise<ServiceResult<string>>;
  choose(project: string, branch: string): Promise<ServiceResult<string>>;
  propose(project: string, product: string): Promise<ServiceResult<string>>;
  dismiss(project: string, product: string, hash: string): Promise<void>;
}

/** Every sentence of the Staff Room's own (the room's words come from the model). */
export const STAFF_ROOM_TEXT = {
  title: 'Staff Room',
  empty: 'No shared work is open in this session.',
  notOpen: 'This shared work is not open in this session.',
  decisionGone: 'This decision is no longer open. Look again.',
  notVersion: 'This version is not in the shared record on this computer.',
  joinLater: 'Admitting people is done from Share with People.',
  copyLater: 'Make a single-machine copy from Share with People.',
  decided: 'Your decision was saved.',
  dialogApprove: 'Approve',
  dialogReject: 'Reject',
  dialogCancel: 'Cancel',
  reasons: 'Your reasons',
  confirm: 'Confirm with your passkey or security key',
  finish: 'Finish your decision',
} as const;
