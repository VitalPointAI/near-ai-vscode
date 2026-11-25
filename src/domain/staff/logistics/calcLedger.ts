// The calculator ledger (WP-LOG): the part of the staff ledger that proves the calculator wrote a record. Pure: no I/O, no clock, no vscode.
//
// guard-scan used to hold a J4 number unless a file named by its calc:<id> existed in .planning/staff/calculator/. That proved a file exists, not that the
// calculator wrote it: the folder is ordinary project files, and a member with Write could put any numbers there. Now every record the logistics server
// writes is entered in .planning/staff/ledger/calculator.jsonl, beside the product ledger and kept the same way (src/domain/staff/ledger.ts): one entry
// per line, signed with this device's key (purpose `staff-ledger`), chained to the entry before it by the SHA-256 of its canonical form, and holding the
// SHA-256 of the record file's exact bytes. An agent never holds the key, so it cannot add an entry that verifies. A record counts only when its file's
// hash matches a trusted entry; a file with no entry, or one changed after the calculator wrote it, is held, and the finding says which.
//
// A record never changes: an id is entered once, and a second entry for the same id breaks the chain like any other entry NEAR AI would not write.
import type { PayloadVerdict } from '../../team/signedPayload';
import { canonicalize } from '../../team/canonical';
import { entryDigest, LEDGER_GENESIS } from '../ledger';
import { checkStaffKeys, isOneLine, isRecord, ownValue, STAFF_SLUG } from '../parse';
import { PRODUCT_HASH_PATTERN } from '../release';
import { CALC_RECORD_KINDS, recordHash } from './calculator';
import type { CalcRecordKind } from './calculator';

export const CALC_LEDGER_FILE = 'calculator.jsonl';
export const CALC_LEDGER_ENTRY_VERSION = 1;
export const MAX_CALC_LEDGER_ENTRIES = 20_000;

export interface CalcLedgerEntry {
  readonly v: typeof CALC_LEDGER_ENTRY_VERSION;
  /** Marks the entry as a calculator entry, so a product ledger entry copied in never reads as one. */
  readonly type: 'calculator-record';
  readonly seq: number;
  readonly prev: string;
  readonly at: string;
  readonly run: string;
  readonly member: string;
  readonly record: string;
  readonly kind: CalcRecordKind;
  /** The SHA-256 of the record file's exact bytes. */
  readonly hash: string;
}

const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Reads one calculator ledger entry strictly. Undefined when the value is not one. */
export function parseCalcLedgerEntry(value: unknown): CalcLedgerEntry | undefined {
  if (!isRecord(value) || checkStaffKeys(value, '', ['v', 'type', 'seq', 'prev', 'at', 'run', 'member', 'record', 'kind', 'hash'])) return undefined;
  if (ownValue(value, 'v') !== CALC_LEDGER_ENTRY_VERSION || ownValue(value, 'type') !== 'calculator-record') return undefined;
  const seq = ownValue(value, 'seq');
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) return undefined;
  const prev = ownValue(value, 'prev');
  const hash = ownValue(value, 'hash');
  if (typeof prev !== 'string' || !PRODUCT_HASH_PATTERN.test(prev) || typeof hash !== 'string' || !PRODUCT_HASH_PATTERN.test(hash)) return undefined;
  const at = ownValue(value, 'at');
  if (typeof at !== 'string' || !ISO_MILLIS.test(at)) return undefined;
  if (!isOneLine(ownValue(value, 'run'), 120)) return undefined;
  const member = ownValue(value, 'member');
  const record = ownValue(value, 'record');
  if (typeof member !== 'string' || !STAFF_SLUG.test(member) || typeof record !== 'string' || !STAFF_SLUG.test(record)) return undefined;
  if (!(CALC_RECORD_KINDS as readonly unknown[]).includes(ownValue(value, 'kind'))) return undefined;
  return JSON.parse(canonicalize(value)) as CalcLedgerEntry;
}

export interface CalcLedgerReplay {
  /** The trusted entry for each record id. */
  readonly records: ReadonlyMap<string, CalcLedgerEntry>;
  readonly entries: number;
  readonly head: string;
  /** Where the chain broke, when it did: nothing after it is trusted. */
  readonly broken?: { readonly seq: number; readonly reason: string };
}

export const CALC_LEDGER_PROBLEMS = {
  unreadable: 'A calculator ledger line could not be read as a signed entry.',
  signature: 'A calculator ledger entry is not signed by a key this computer trusts, so it was written outside SovAI or changed.',
  chain: 'A calculator ledger entry does not follow the one before it, so an entry was removed, reordered or added outside SovAI.',
  repeated: 'A calculator ledger entry names a record that already has one; records never change, so it was not written by SovAI.'
} as const;

/** Replays the calculator ledger: the first line that fails a check breaks the chain, and nothing after it is trusted. */
export function replayCalcLedger(envelopes: readonly unknown[], verify: (envelope: unknown) => PayloadVerdict<unknown>): CalcLedgerReplay {
  const records = new Map<string, CalcLedgerEntry>();
  let head = LEDGER_GENESIS;
  let entries = 0;
  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index];
    const broken = (problem: keyof typeof CALC_LEDGER_PROBLEMS): CalcLedgerReplay => ({ records, entries, head, broken: { seq: index, reason: CALC_LEDGER_PROBLEMS[problem] } });
    const verdict = verify(envelope);
    if (!verdict.ok) return broken(verdict.reason === 'malformed' ? 'unreadable' : 'signature');
    const entry = parseCalcLedgerEntry(verdict.payload);
    if (!entry) return broken('unreadable');
    if (entry.seq !== index || entry.prev !== head) return broken('chain');
    if (records.has(entry.record)) return broken('repeated');
    records.set(entry.record, entry);
    head = entryDigest(envelope);
    entries += 1;
  }
  return { records, entries, head };
}

export const CALC_RECORD_PROBLEMS = {
  'no-entry': 'has a file in the calculator folder but no entry in the calculator ledger, so the calculator did not write it. Run the calculation with the logistics server\'s calc tools and cite the record it gives.',
  changed: 'changed after the calculator wrote it: the file no longer matches the hash in the calculator ledger. Run the calculation again under a new id and cite that record.'
} as const;

export interface CalcRecordCheck {
  /** Record ids whose file matches a trusted ledger entry: the only ids a product may cite. */
  readonly verified: ReadonlySet<string>;
  /** Record ids with a file the ledger does not vouch for, with the sentence guard-scan shows. */
  readonly problems: ReadonlyMap<string, string>;
  /** Why the calculator ledger cannot be trusted past some entry, when it cannot. */
  readonly ledgerProblem?: string;
}

/** Which record files the ledger vouches for: `files` maps each record id in the folder to its file's text. */
export function checkCalcRecords(replay: CalcLedgerReplay, files: ReadonlyMap<string, string>): CalcRecordCheck {
  const verified = new Set<string>();
  const problems = new Map<string, string>();
  const ledgerProblem = replay.broken ? `Calculator ledger entry ${replay.broken.seq + 1}: ${replay.broken.reason}` : undefined;
  for (const [id, text] of files) {
    const entry = replay.records.get(id);
    if (!entry) problems.set(id, `calc:${id} ${CALC_RECORD_PROBLEMS['no-entry']}${ledgerProblem ? ` (${ledgerProblem} Entries after it are not trusted.)` : ''}`);
    else if (recordHash(text) !== entry.hash) problems.set(id, `calc:${id} ${CALC_RECORD_PROBLEMS.changed}`);
    else verified.add(id);
  }
  return { verified, problems, ...(ledgerProblem ? { ledgerProblem } : {}) };
}
