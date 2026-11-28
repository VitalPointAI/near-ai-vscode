// The trigger log of model passports (Phase 74.1 D-15, design 12.1): for each passport hash, the place its model was first seen at and the re-evaluation
// triggers that have fired for it. Kept in one JSON file in the extension's global storage, written whole (temp file, then rename), so a fired trigger is
// still there after a restart. A new signed passport has a new hash, so it starts clean. A file that cannot be read counts as nothing seen and nothing
// fired (which never allows more than the passport itself would) and is reported once; it is kept aside, never overwritten, at the next write.
// Node I/O only, synchronous and small: the route check that reads it runs before a request is sent and does not wait.
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { REEVALUATION_TRIGGERS } from '../domain/gate/models';
import type { ReevaluationTrigger } from '../domain/gate/models';
import type { ObservedPlace } from '../domain/gate/passportState';

/** The log's file in the extension's global storage folder. Read by every later version: never renamed. */
export const PASSPORT_TRIGGER_FILE = 'passport-triggers.json';

/** Said once when the file cannot be read or written. Names no path. */
export const PASSPORT_TRIGGER_PROBLEM_TEXT = 'SovAI could not read or keep its record of model approvals that ended because a model changed. Approvals are checked without it until it can be kept again.';

export interface PassportTriggerLog {
  /** Keeps `place` as the first place seen for `passportHash` when none is kept yet, and returns the first place seen. */
  seen(passportHash: string, place: ObservedPlace): ObservedPlace;
  /** Keeps `trigger` for `passportHash`; true only the first time, so the caller records it once. */
  fire(passportHash: string, trigger: ReevaluationTrigger): boolean;
  /** The triggers fired for `passportHash`, in the order they fired. */
  fired(passportHash: string): readonly ReevaluationTrigger[];
}

export interface PassportTriggerStorage {
  /** The log's file: PASSPORT_TRIGGER_FILE in the extension's global storage folder. */
  readonly file: string;
  /** Told once when the file cannot be read or written. Never awaited. */
  readonly onProblem?: (text: string) => void;
}

interface Entry {
  firstSeen?: ObservedPlace;
  fired: ReevaluationTrigger[];
}

const HASH = /^[0-9a-f]{64}$/;
const MAX_PLACE_TEXT = 256;

function placeOf(value: unknown): ObservedPlace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: { privacyBoundary?: string; forwardedTo?: string } = {};
  for (const key of ['privacyBoundary', 'forwardedTo'] as const) {
    const found = (value as Record<string, unknown>)[key];
    if (found === undefined) continue;
    if (typeof found !== 'string' || found.length > MAX_PLACE_TEXT) return undefined;
    out[key] = found;
  }
  return out;
}

/** The entries of a file's text; undefined when the text is not a log this version can read whole. */
function parseLog(text: string): Map<string, Entry> | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) return undefined;
  const passports = (parsed as { passports?: unknown }).passports;
  if (typeof passports !== 'object' || passports === null || Array.isArray(passports)) return undefined;
  const out = new Map<string, Entry>();
  for (const [hash, value] of Object.entries(passports as Record<string, unknown>)) {
    if (!HASH.test(hash) || typeof value !== 'object' || value === null) return undefined;
    const record = value as { firstSeen?: unknown; fired?: unknown };
    const firstSeen = record.firstSeen === undefined ? undefined : placeOf(record.firstSeen);
    if (record.firstSeen !== undefined && firstSeen === undefined) return undefined;
    if (!Array.isArray(record.fired) || !record.fired.every((item) => (REEVALUATION_TRIGGERS as readonly unknown[]).includes(item))) return undefined;
    out.set(hash, { ...(firstSeen === undefined ? {} : { firstSeen }), fired: [...new Set(record.fired as ReevaluationTrigger[])] });
  }
  return out;
}

type Read = { readonly state: 'missing' } | { readonly state: 'read'; readonly entries: Map<string, Entry> } | { readonly state: 'unreadable' };

function readLog(file: string): Read {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  const entries = parseLog(text);
  return entries === undefined ? { state: 'unreadable' } : { state: 'read', entries };
}

/** Joins another copy's entries into `into`: the first place seen in `into` stays first, and every fired trigger is kept. */
function merge(into: Map<string, Entry>, from: Map<string, Entry>): void {
  for (const [hash, entry] of from) {
    const own = into.get(hash);
    if (own === undefined) { into.set(hash, { ...(entry.firstSeen === undefined ? {} : { firstSeen: entry.firstSeen }), fired: [...entry.fired] }); continue; }
    if (own.firstSeen === undefined && entry.firstSeen !== undefined) own.firstSeen = entry.firstSeen;
    for (const trigger of entry.fired) if (!own.fired.includes(trigger)) own.fired.push(trigger);
  }
}

/** The trigger log kept in `storage.file`. Nothing is read until it is first asked. */
export function createPassportTriggerLog(storage: PassportTriggerStorage): PassportTriggerLog {
  let entries: Map<string, Entry> | undefined;
  let unreadableKept = true;
  let told = false;
  const tell = (): void => {
    if (told) return;
    told = true;
    try { storage.onProblem?.(PASSPORT_TRIGGER_PROBLEM_TEXT); } catch { /* a notice never changes a decision */ }
  };
  const load = (): Map<string, Entry> => {
    if (entries !== undefined) return entries;
    const read = readLog(storage.file);
    if (read.state === 'unreadable') { unreadableKept = false; tell(); }
    entries = read.state === 'read' ? read.entries : new Map();
    return entries;
  };
  // Another window may have written since this one read: its entries are joined first, so neither loses a fired trigger.
  const write = (): void => {
    const own = load();
    try {
      mkdirSync(path.dirname(storage.file), { recursive: true });
      const read = readLog(storage.file);
      if (read.state === 'read') {
        const joined = new Map<string, Entry>();
        merge(joined, read.entries);
        merge(joined, own);
        entries = joined;
      } else if (read.state === 'unreadable' && !unreadableKept) {
        copyFileSync(storage.file, `${storage.file}.unreadable-${String(Date.now())}`);
        unreadableKept = true;
      }
      const body = { v: 1, passports: Object.fromEntries([...(entries ?? own)].map(([hash, entry]) => [hash, entry])) };
      const temporary = `${storage.file}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(body)}\n`, { encoding: 'utf8', flag: 'wx' });
        renameSync(temporary, storage.file);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    } catch {
      // Kept in memory for this window; the trigger still holds here.
      tell();
    }
  };
  return {
    seen(passportHash, place) {
      const log = load();
      const entry = log.get(passportHash);
      if (entry?.firstSeen !== undefined) return entry.firstSeen;
      const kept: ObservedPlace = Object.freeze({ ...(place.privacyBoundary === undefined ? {} : { privacyBoundary: place.privacyBoundary }), ...(place.forwardedTo === undefined ? {} : { forwardedTo: place.forwardedTo }) });
      if (entry === undefined) log.set(passportHash, { firstSeen: kept, fired: [] }); else entry.firstSeen = kept;
      write();
      return load().get(passportHash)?.firstSeen ?? kept;
    },
    fire(passportHash, trigger) {
      const log = load();
      const entry = log.get(passportHash);
      if (entry?.fired.includes(trigger) === true) return false;
      if (entry === undefined) log.set(passportHash, { fired: [trigger] }); else entry.fired.push(trigger);
      write();
      return true;
    },
    fired(passportHash) {
      return Object.freeze([...(load().get(passportHash)?.fired ?? [])]);
    }
  };
}

// ---- The log the client's route check reads ----

let active: PassportTriggerLog | undefined;

/** Sets the log every model request's route facts read (activation, with the extension's global storage), and returns what clears it again. */
export function setPassportTriggerLog(log: PassportTriggerLog | undefined): () => void {
  active = log;
  return () => { if (active === log) active = undefined; };
}

/** The log set at activation; undefined outside the extension (no trigger is kept, and the passport decides alone). */
export function passportTriggerLog(): PassportTriggerLog | undefined {
  return active;
}
