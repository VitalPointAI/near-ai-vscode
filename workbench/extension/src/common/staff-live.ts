/**
 * The status of shared projects as the browser sees it (Phase 33 D-52, D-57): the RPC path, the rows the backend sends every connected tab, and
 * the join requests it sends the lead's and deputy's tabs only. A row carries the state word and the sentence a person reads, never project text,
 * a key or a token. Nothing here imports Theia, so the backend and the tests share it.
 */
import type { ServiceResult } from './service-result.js';

export const STAFF_STATUS_PATH = '/services/sterling-staff-status';
export const StaffStatusServer = Symbol('StaffStatusServer');

/** One shared project's state: the sync state word and the sentence for it (liveSentences.ts), and when it was last in step. */
export interface StaffStatusRow {
  /** The project id (32 hex characters). */
  readonly project: string;
  /** The project's folder, as the workspace names it. */
  readonly root: string;
  readonly state: string;
  readonly sentence: string;
  readonly lastSyncedAt?: number;
}

/** A join request reaching a lead or deputy: the invitation's name and the code to compare with the person, as the hub carried it. */
export interface StaffJoinRequest {
  readonly project: string;
  readonly invite?: string;
}

/** What each connected tab answers: notifications only (Theia sends on* methods without waiting for an answer). */
export interface StaffStatusClient {
  onStatus(row: StaffStatusRow): void;
  onJoinRequest(request: StaffJoinRequest): void;
}

export interface StaffStatusServer {
  /** Every open shared project's row. */
  rows(): Promise<StaffStatusRow[]>;
  /** Runs one exchange for the project now; refused when it is not open here. */
  syncNow(project: string): Promise<ServiceResult<StaffStatusRow>>;
}

export const STAFF_STATUS_TEXT = {
  notOpen: 'This shared project is not open in this session.',
  /** The status bar's tooltip for a state this build does not know (a newer engine). */
  unknownState: 'Sterling cannot show this sync state. Ask your administrator.',
} as const;
