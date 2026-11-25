// Facts about content and a session's running fact set (Phase 70.1, D-18; research 3.5). Pure: no I/O, no clock, no vscode, no package.
// A fact is its type and, when it names something, an opaque subject key the caller derives per session, plus the item it came from. Never the value:
// a fact with any other key is refused, so the set cannot carry content (T-70.1-13). The set holds at most SESSION_FACT_CAP facts; reaching the cap goes to
// a person as an aggregate-cap exception instead of dropping facts, which could miss a compilation (owner-confirmed item 4).
import { BASE_FACT_TYPES, FACT_TYPE_PATTERN } from '../gate/classificationSection';
import type { ClassificationSection } from '../gate/classificationSection';
import { checkKeys, isRecord, ownValue, refused } from '../gate/shape';
import type { Parsed } from '../gate/shape';

export { BASE_FACT_TYPES };

/** The most facts a session's running set holds (D-18). */
export const SESSION_FACT_CAP = 4096;

/** A fact in a session's running set: type, opaque subject key and item id only. */
export interface SessionFact {
  readonly type: string;
  readonly subject?: string;
  readonly item?: string;
}

export interface AddedFacts {
  readonly facts: readonly SessionFact[];
  /** Set when the new facts would pass the cap: the set is returned unchanged and the caller queues the exception. */
  readonly exception?: 'aggregate-cap';
}

const SUBJECT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const ITEM_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

/** The fact types a section knows: the base vocabulary and the section's additions. */
export function factTypesOf(section: Pick<ClassificationSection, 'factTypes'>): readonly string[] {
  return Object.freeze([...BASE_FACT_TYPES, ...section.factTypes]);
}

/** One fact read strictly: type, and optionally subject and item, nothing else. */
export function parseSessionFact(value: unknown, path = ''): Parsed<SessionFact> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ['type'], ['subject', 'item']);
  if (keys !== undefined) return keys;
  const type = ownValue(value, 'type');
  if (typeof type !== 'string' || !FACT_TYPE_PATTERN.test(type)) return refused('wrong-type', `${path}.type`);
  const out: Record<string, string> = { type };
  for (const [key, pattern] of [['subject', SUBJECT_KEY], ['item', ITEM_ID]] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const entry = ownValue(value, key);
    if (typeof entry !== 'string' || !pattern.test(entry)) return refused('wrong-type', `${path}.${key}`);
    out[key] = entry;
  }
  return { ok: true, value: Object.freeze(out) as unknown as SessionFact };
}

function factKey(fact: SessionFact): string {
  return `${fact.type}\u0000${fact.subject ?? ''}\u0000${fact.item ?? ''}`;
}

/**
 * A new set: the session's facts with the item's added (each without an item takes `item`), duplicates once. A malformed fact refuses the whole call.
 * When the result would hold more than SESSION_FACT_CAP facts, the session's set comes back unchanged with an aggregate-cap exception.
 */
export function addFacts(session: readonly SessionFact[], incoming: readonly unknown[], item?: string): Parsed<AddedFacts> {
  const seen = new Set(session.map(factKey));
  const added: SessionFact[] = [];
  for (let index = 0; index < incoming.length; index += 1) {
    const parsed = parseSessionFact(incoming[index], `facts[${String(index)}]`);
    if (!parsed.ok) return parsed;
    const fact = parsed.value.item === undefined && item !== undefined ? Object.freeze({ ...parsed.value, item }) : parsed.value;
    const key = factKey(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    added.push(fact);
  }
  if (session.length + added.length > SESSION_FACT_CAP) return { ok: true, value: Object.freeze({ facts: session, exception: 'aggregate-cap' }) };
  return { ok: true, value: Object.freeze({ facts: Object.freeze([...session, ...added]) }) };
}
