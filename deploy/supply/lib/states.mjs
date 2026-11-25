// The intake's state machine (48.3-01; D-15). Pure: no network, no files; `now` (a Date) is always passed in. A transition returns a new
// record and never mutates or drops anything from the one it was given: no field is removed, the history only grows, earlier approvals move to
// `previousApprovals`, and a withdrawal keeps the artefact reference.
//
// Events ({ type, ... }):
//   gathered                                  requested -> quarantined
//   evaluated { result, policy }              quarantined or waiting -> refused | waiting | in-review | approved (automatic, zero flags only);
//                                             `result` is policy.mjs evaluate()'s; a wait is left before its releaseAt only by a refusal or a fast lane
//   approve { approval: { subject, entity, at }, reference? }
//                                             in-review or under-review-again: counts distinct subjects; approved once they reach approversNeeded;
//                                             under-review-again also needs a reference (a VEX statement or an accepted risk)
//   refuse { by, reason }                     in-review -> refused
//   finding { finding: { id, severity, kev, mal, fixAvailable }, policy } and yanked { policy }
//                                             approved -> under-review-again
//   withdraw { by, reason }                   under-review-again -> withdrawn
// refused and withdrawn accept no event: a new request makes a new record.
export const STATES = Object.freeze(['requested', 'quarantined', 'waiting', 'in-review', 'approved', 'refused', 'under-review-again', 'withdrawn']);
const FINAL = new Set(['refused', 'withdrawn']);
const REVIEWS = new Set(['in-review', 'under-review-again']);
const DAY_MS = 86_400_000;

const label = (record) => `${record.artefact.name}@${record.artefact.version}`;

/** Every state that still has an exit (all but refused and withdrawn). */
export function openStates() {
  return STATES.filter((state) => !FINAL.has(state));
}

/** `days` working days after `from` (Saturday and Sunday skipped, UTC; no holiday calendar). */
function addWorkingDays(from, days) {
  let at = from.getTime();
  let left = days;
  while (left > 0) {
    at += DAY_MS;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return new Date(at).toISOString();
}

const review = (policy, now, urgent) => ({
  ownerRole: policy.review.ownerRole,
  dueAt: addWorkingDays(now, urgent ? policy.review.urgentDueWorkingDays : policy.review.dueWorkingDays),
});

/** True when a review is past its due date. It raises an alert (48.3-19) and never changes the state. */
export function overdue(record, now) {
  return REVIEWS.has(record.state) && typeof record.dueAt === 'string' && now.getTime() > Date.parse(record.dueAt);
}

/** A new request for one artefact. */
export function newRecord(artefact, requestedBy, now) {
  return { artefact: { ...artefact }, requestedBy, requestedAt: now.toISOString(), state: 'requested', history: [], approvals: [], previousApprovals: [] };
}

function move(record, to, event, now, changes = {}) {
  return { ...record, ...changes, state: to, history: [...record.history, { from: record.state, to, event: event.type, at: now.toISOString() }] };
}

function evaluated(record, event, now) {
  const { result, policy } = event;
  const at = now.toISOString();
  if (record.state === 'waiting' && now.getTime() < Date.parse(record.releaseAt)) {
    const early = result.outcome === 'refused' || (result.outcome === 'in-review' && result.flags.includes('fast-lane'));
    if (!early) throw new Error(`${label(record)} is waiting and not yet released: it can move on at ${record.releaseAt}.`);
  }
  switch (result.outcome) {
    case 'refused':
      return move(record, 'refused', event, now, { refusedBy: result.refusedBy, decidedAt: at });
    case 'waiting':
      if (typeof result.releaseAt !== 'string' || Number.isNaN(Date.parse(result.releaseAt))) {
        throw new Error(`${label(record)} cannot wait without a releaseAt: nothing may wait forever.`);
      }
      return move(record, 'waiting', event, now, { releaseAt: result.releaseAt });
    case 'in-review':
      if (!(result.approversNeeded >= 1)) throw new Error(`${label(record)} is in review and needs at least one approver.`);
      return move(record, 'in-review', event, now, {
        flags: [...result.flags], approversNeeded: result.approversNeeded, ...(result.fastLane ? { fastLane: { ...result.fastLane } } : {}), ...review(policy, now, false),
      });
    case 'checks-passed':
      if (result.flags.length > 0) throw new Error(`${label(record)} has flags (${result.flags.join(', ')}): automatic approval needs zero flags.`);
      return move(record, 'approved', event, now, { flags: [], approversNeeded: 0, decidedBy: 'automatic', decidedAt: at });
    default:
      throw new Error(`${label(record)}: unknown evaluation outcome ${JSON.stringify(result.outcome)}.`);
  }
}

function approve(record, event, now) {
  const { approval } = event;
  if (!approval || typeof approval.subject !== 'string' || approval.subject === '') throw new Error(`An approval of ${label(record)} must name the approver's subject.`);
  if (record.state === 'under-review-again' && !(typeof event.reference === 'string' && event.reference !== '')) {
    throw new Error(`Returning ${label(record)} to approved needs a VEX statement or an accepted risk as its reference.`);
  }
  if (record.approvals.some((a) => a.subject === approval.subject)) return record;
  const approvals = [...record.approvals, { ...approval }];
  const changes = { approvals, ...(event.reference ? { reference: event.reference } : {}) };
  if (approvals.length < record.approversNeeded) return move(record, record.state, event, now, changes);
  return move(record, 'approved', event, now, { ...changes, decidedBy: 'people', decidedAt: now.toISOString() });
}

function reviewAgain(record, event, now) {
  const { policy } = event;
  const finding = event.finding ?? {};
  const mal = finding.mal === true || String(finding.id ?? '').startsWith('MAL-');
  const kev = finding.kev === true;
  const criticalWithFix = String(finding.severity ?? '').toLowerCase() === 'critical' && finding.fixAvailable === true;
  // D-28: one approver returns it to approved, two when the finding is a KEV match or a critical with a fix.
  const approversNeeded = kev || criticalWithFix ? Math.max(2, policy.approvers.flagged) : policy.approvers.flagged;
  return move(record, 'under-review-again', event, now, {
    approvals: [],
    previousApprovals: [...(record.previousApprovals ?? []), ...record.approvals],
    approversNeeded,
    ...(event.type === 'finding' ? { finding: { ...finding } } : { yankedAt: now.toISOString() }),
    ...review(policy, now, kev || mal),
  });
}

const TABLE = {
  requested: { gathered: (record, event, now) => move(record, 'quarantined', event, now, { gatheredAt: now.toISOString() }) },
  quarantined: { evaluated },
  waiting: { evaluated },
  'in-review': {
    approve,
    refuse: (record, event, now) => move(record, 'refused', event, now, { refusedBy: 'review', refusedBySubject: event.by ?? null, refusedReason: event.reason ?? null, decidedAt: now.toISOString() }),
  },
  approved: { finding: reviewAgain, yanked: reviewAgain },
  'under-review-again': {
    approve,
    withdraw: (record, event, now) => {
      if (typeof event.by !== 'string' || event.by === '') throw new Error(`A withdrawal of ${label(record)} must name who withdrew it.`);
      return move(record, 'withdrawn', event, now, { withdrawnAt: now.toISOString(), withdrawnBy: event.by, withdrawnReason: event.reason ?? null });
    },
  },
};

/** Applies one event ({ type, ... }) to a record and returns the new record. */
export function transition(record, event, now) {
  const handler = TABLE[record.state]?.[event.type];
  if (!handler) throw new Error(`${event.type} is not possible while ${label(record)} is ${record.state}.`);
  return handler(record, event, now);
}
