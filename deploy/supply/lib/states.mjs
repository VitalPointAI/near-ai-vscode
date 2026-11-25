// The intake's state machine (48.3-01; D-15). Pure: no network, no files; `now` is always passed in. A transition returns a new record and
// never mutates or drops anything from the one it was given.
export const STATES = Object.freeze(['requested', 'quarantined', 'waiting', 'in-review', 'approved', 'refused', 'under-review-again', 'withdrawn']);

const label = (record) => `${record.artefact.name}@${record.artefact.version}`;

/** A new request for one artefact. */
export function newRecord(artefact, requestedBy, now) {
  return { artefact: { ...artefact }, requestedBy, requestedAt: now.toISOString(), state: 'requested', history: [], approvals: [] };
}

function move(record, to, event, now, changes = {}) {
  return { ...record, ...changes, state: to, history: [...record.history, { from: record.state, to, event: event.type, at: now.toISOString() }] };
}

function evaluated(record, event, now) {
  const { result } = event;
  if (result.outcome === 'waiting') return move(record, 'waiting', event, now, { releaseAt: result.releaseAt });
  return move(record, 'approved', event, now, { decidedBy: 'automatic', decidedAt: now.toISOString() });
}

const TABLE = {
  requested: { gathered: (record, event, now) => move(record, 'quarantined', event, now) },
  quarantined: { evaluated },
};

/** Applies one event ({ type, ... }) to a record and returns the new record. */
export function transition(record, event, now) {
  const handler = TABLE[record.state]?.[event.type];
  if (!handler) throw new Error(`${event.type} is not possible while ${label(record)} is ${record.state}.`);
  return handler(record, event, now);
}
