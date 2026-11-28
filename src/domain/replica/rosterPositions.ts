// Positions and postings in the roster fold (Phase 33.1, D-01, D-02, D-09, D-12; DESIGN 3.1 to 3.8). Hub-side: pure, no clock, no I/O, no Yjs.
//
// A position is an organization-owned roster object that outlives its holder. A posting puts one member into one position: the lead orders it and the
// posted member's own device (the person key in a hosted session) reports, which makes that member the holder. Every record keeps the roster
// position it took effect at, so each answer is given at the roster an entry cites, as the members module does (D-11).
//
// This module holds the state and its queries. Who may write what is decided in one place, positionWriteProblem in roster.ts, which the roster fold
// and your organization's server both call, so the two cannot disagree. Kinds a later 33.1 plan applies (delegation, enrolment, decisions, ends,
// staged key changes, the signed mode) are refused there as not yet applied and never change this state.

/** Where positions and postings stand. Records are kept in the order they took effect; nothing is ever removed. */
export interface PositionRecord { position: string; title: string; section: string; from: number }
export interface PostingRecord {
  posting: string;
  position: string;
  member: string;
  kind: string;
  start: string;
  /** The member whose device signed the order: derived from the verified signer, never taken from the entry (D-19). */
  orderedBy: string;
  orderedAt: number;
  /** The roster position the report took, once reported. */
  reportedAt?: number;
}
export interface PostsState { positions: Map<string, PositionRecord>; postings: Map<string, PostingRecord> }

export const createPostsState = (): PostsState => ({ positions: new Map(), postings: new Map() });

export const POSITION_REFUSALS = {
  'order-not-allowed': 'Only the lead may make this order at this point, so it is refused.',
  'position-exists': 'A position with this id already exists, so it is refused.',
  'unknown-position': 'This names a position that does not exist at this point, so it is refused.',
  'position-not-vacant': 'This position already has a holder or a person posted to it, so this order is refused.',
  'posting-exists': 'A posting with this id already exists, so it is refused.',
  'unknown-posting': 'This names a posting that does not exist at this point, so it is refused.',
  'not-the-posted-member': 'Only the person this posting names may report for it, with their own key, so this report is refused.',
  'posting-not-open': 'This posting is not waiting for a report, so this report is refused.',
  'report-before-start': 'This report was signed before the posting starts, so it is refused.'
} as const;
export type PositionRefusal = keyof typeof POSITION_REFUSALS;

/** The position as it stands at a roster position, or undefined when it did not exist yet. */
export function positionAt(state: PostsState, position: string, at: number): PositionRecord | undefined {
  const record = state.positions.get(position);
  return record !== undefined && record.from <= at ? record : undefined;
}

/** The posting as it stands at a roster position, or undefined when it was not ordered yet. */
export function postingAt(state: PostsState, posting: string, at: number): PostingRecord | undefined {
  const record = state.postings.get(posting);
  return record !== undefined && record.orderedAt <= at ? record : undefined;
}

const reportedBy = (record: PostingRecord, at: number): boolean => record.reportedAt !== undefined && record.reportedAt <= at;

/** The member who holds the position at a roster position: the one whose posting to it was reported by then (D-01). */
export function holderAt(state: PostsState, position: string, at: number): { member: string; posting: string; orderedBy: string } | undefined {
  for (const record of state.postings.values()) {
    if (record.position === position && record.orderedAt <= at && reportedBy(record, at)) return { member: record.member, posting: record.posting, orderedBy: record.orderedBy };
  }
  return undefined;
}

/** True while the position has a holder or an ordered posting not reported yet, at a roster position. */
export function positionTakenAt(state: PostsState, position: string, at: number): boolean {
  for (const record of state.postings.values()) if (record.position === position && record.orderedAt <= at) return true;
  return false;
}

/** True when the posting was reported at or before the roster position. */
export const postingReportedAt = (record: PostingRecord, at: number): boolean => reportedBy(record, at);

interface CreateData { position: string; title: string; section: string }
interface OrderData { posting: string; position: string; person: { member: string }; kind: string; start: string }

/** Applies an entry positionWriteProblem already allowed at the roster it cites. position is the roster position it takes. */
export function applyPositionEntry(state: PostsState, kind: string, data: unknown, signer: string, position: number): void {
  if (kind === 'position.create') {
    const create = data as CreateData;
    state.positions.set(create.position, { position: create.position, title: create.title, section: create.section, from: position });
  } else if (kind === 'posting.order') {
    const order = data as OrderData;
    state.postings.set(order.posting, { posting: order.posting, position: order.position, member: order.person.member, kind: order.kind, start: order.start, orderedBy: signer, orderedAt: position });
  } else if (kind === 'posting.report') {
    const posting = (data as { posting: string }).posting;
    const record = state.postings.get(posting) as PostingRecord;
    state.postings.set(posting, { ...record, reportedAt: position });
  }
}
