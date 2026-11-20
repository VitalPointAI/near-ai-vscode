// The logistics host (design 10, 6.2; WP-LOG): the files behind the logistics server's tools. Node I/O only: this module never imports vscode, so the
// tests drive it directly. The rules are in src/domain/staff/logistics/.
//
// Where things live in the project (the host's root, the project the staff team works in):
// - planning factors:   .planning/.near-ai/staff-factors.json, written by a person (an agent must ask before writing there); the calculator reads only
// - calculator records: .planning/staff/calculator/<id>.json, written only through this host, never changed after
// - calculator ledger:  .planning/staff/ledger/calculator.jsonl, one signed entry per record with the SHA-256 of its file, chained like the product ledger
// - LOGSTAT reports:    .planning/staff/logistics/logstat/reports/<id>.json, and the validation log beside them (validation.jsonl)
// - the road graph:     .planning/staff/logistics/roads.json
// A record is written to a temporary file, entered in the ledger, then renamed into place, all under the ledger lock, so two members never take one id.
//
// In a shared (multi-user) project (.planning/staff/replica/project.json exists; D-29, plan 31-21) the three writes (a calculator record, a LOGSTAT
// report, the validation log) are refused with SHARED_PROJECT_REFUSAL before any file is touched; the reads answer from the files as they are.
import { appendFile, lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { snapshotOfBytes, writeIfUnchanged } from './staffFiles';
import * as path from 'node:path';
import { signPayload, verifyPayload } from '../domain/team/signedPayload';
import type { KeyStatusLookup } from '../domain/team/keyStatus';
import {
  CALC_LEDGER_ENTRY_VERSION, CALC_LEDGER_FILE, CALCULATOR_RECORD_DIR, checkCalcRecords, FACTORS_FILE, LOGSTAT_REPORTS_DIR, LOGSTAT_VALIDATION_FILE,
  MAX_CALC_LEDGER_ENTRIES, parseFactors, parseLogstatReport, parseRecord, parseRoadGraph, recordHash, renderRecord, replayCalcLedger, ROADS_FILE
} from '../domain/staff/logistics';
import type {
  CalcLedgerEntry, CalcLedgerReplay, CalcRecord, CalcRecordCheck, CalcResult, LogstatReport, PlanningFactor, RecordStamp, RoadGraph, ValidationLogEntry
} from '../domain/staff/logistics';
import { STAFF_SLUG } from '../domain/staff/parse';
import { withFileLock } from '../services/stateMirrorLock';
import type { StaffHostOptions } from './staffHost';
import { REPLICA_PROJECT_FILE, SHARED_PROJECT_REFUSAL, sharedCheckFailedText } from '../domain/staff/multiUser';

export const STAFF_LEDGER_DIR = '.planning/staff/ledger';
const CALC_LOCK = 'calculator.lock';
const LOGSTAT_LOCK = 'logstat.lock';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 5000;

const fail = <T>(message: string): CalcResult<T> => ({ ok: false, message });

/**
 * Thrown by a staff or logistics write that has no result to carry a refusal, in a shared project (D-29): its message is SHARED_PROJECT_REFUSAL, the
 * one plain sentence that points to Make a Single-Machine Copy. Callers show a thrown error's message as it is.
 */
export class SharedProjectError extends Error {
  public get refusal(): string { return this.message; }

  public constructor(message: string = SHARED_PROJECT_REFUSAL) {
    super(message);
    this.name = 'SharedProjectError';
  }
}

/**
 * Why a single-machine write must not run here, or undefined when it may: one stat of the replica project file, failing closed. The file present
 * gives SHARED_PROJECT_REFUSAL; any stat error but its absence gives a sentence naming that error, never the shared-project sentence (a folder
 * that cannot be read is not known to be shared). StaffHost and the watch host use the same check.
 */
export async function sharedProjectRefusal(root: string): Promise<string | undefined> {
  try {
    await stat(path.join(root, ...REPLICA_PROJECT_FILE.split('/')));
    return SHARED_PROJECT_REFUSAL;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : sharedCheckFailedText(code);
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    return text.length > MAX_FILE_BYTES ? undefined : text;
  } catch { return undefined; }
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

/** The project folder a relative path names, refused when any folder on the way is a symbolic link (a link could point the write outside the project). */
async function safeDir(root: string, relative: string): Promise<string | undefined> {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) return undefined;
    } catch { /* not there yet: created below */ }
  }
  return current;
}

async function ledgerLines(file: string): Promise<unknown[]> {
  const text = await readText(file);
  if (text === undefined) return [];
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => { try { return JSON.parse(line) as unknown; } catch { return line; } });
}

/** The calculator ledger of a project, replayed with every signature checked against the keys this computer trusts. */
export async function replayCalculatorLedger(root: string, keyStatus: KeyStatusLookup): Promise<CalcLedgerReplay> {
  return replayCalcLedger(await ledgerLines(path.join(root, STAFF_LEDGER_DIR, CALC_LEDGER_FILE)), (envelope) => verifyPayload(envelope, { purpose: 'staff-ledger', status: keyStatus }));
}

/** Every record file in the calculator folder, by id. Names that are not record ids are left out; so is a file over 2 MB. */
async function recordFiles(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let names: string[];
  try { names = await readdir(path.join(root, CALCULATOR_RECORD_DIR)); } catch { return out; }
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort().slice(0, MAX_RECORDS)) {
    const id = name.slice(0, -5);
    if (!STAFF_SLUG.test(id)) continue;
    const text = await readText(path.join(root, CALCULATOR_RECORD_DIR, name));
    if (text !== undefined) out.set(id, text);
  }
  return out;
}

/**
 * Which calculator records the calculator ledger vouches for: guard-scan's number rule (src/staff/staffHost.ts guardConfig) and the LOGSTAT rules read
 * this, so a record a member wrote by hand, or changed after the calculator wrote it, never stands behind a number.
 */
export async function readCalculatorCheck(root: string, keyStatus: KeyStatusLookup): Promise<CalcRecordCheck & { readonly records: ReadonlyMap<string, CalcRecord> }> {
  const [replay, files] = await Promise.all([replayCalculatorLedger(root, keyStatus), recordFiles(root)]);
  const check = checkCalcRecords(replay, files);
  const records = new Map<string, CalcRecord>();
  for (const id of check.verified) {
    const record = parseRecord(files.get(id)!);
    if (record && record.id === id) records.set(id, record);
  }
  return { ...check, records };
}

export type FactorRead = { readonly ok: true; readonly factors: PlanningFactor[] } | { readonly ok: false; readonly missing: boolean; readonly message: string };

export class LogisticsHost {
  private readonly now: () => number;

  public constructor(private readonly options: StaffHostOptions) {
    this.now = options.now ?? Date.now;
  }

  public get root(): string { return this.options.root; }

  public clock(): number { return this.now(); }

  /** The planning factors a person entered. Missing: there is no factor file, and the extension ships none. */
  public async factors(): Promise<FactorRead> {
    const text = await readText(path.join(this.options.root, FACTORS_FILE));
    if (text === undefined) return { ok: false, missing: true, message: `There is no ${FACTORS_FILE}. The calculator uses only planning factors a person entered there, and ships none.` };
    const parsed = parseFactors(text);
    return parsed.ok ? { ok: true, factors: parsed.value } : { ok: false, missing: false, message: parsed.message };
  }

  /** The records the calculator ledger vouches for, the files it does not, and the ledger's state. */
  public async records(): Promise<CalcRecordCheck & { readonly records: ReadonlyMap<string, CalcRecord> }> {
    return readCalculatorCheck(this.options.root, await this.options.keyStatus());
  }

  /**
   * Writes one calculator record and enters it in the calculator ledger. `build` makes the record from the stamp (the member, the run, the time); a
   * refusal from it, an id already used, a folder that is a symbolic link or a ledger that cannot be trusted writes nothing.
   */
  public async writeRecord(member: string, run: string, build: (stamp: RecordStamp) => CalcResult<CalcRecord>): Promise<CalcResult<{ record: CalcRecord; hash: string }>> {
    const shared = await sharedProjectRefusal(this.options.root);
    if (shared !== undefined) return fail(shared);
    const ledgerDir = await safeDir(this.options.root, STAFF_LEDGER_DIR);
    const recordDir = await safeDir(this.options.root, CALCULATOR_RECORD_DIR);
    if (!ledgerDir || !recordDir) return fail('A folder on the way to the calculator records or the staff ledger is a symbolic link, so nothing was written. Ask the person to replace it with a real folder.');
    await mkdir(ledgerDir, { recursive: true });
    await mkdir(recordDir, { recursive: true });
    return withFileLock(ledgerDir, CALC_LOCK, async () => {
      const replay = await replayCalculatorLedger(this.options.root, await this.options.keyStatus());
      if (replay.broken) return fail(`The calculator ledger cannot be trusted from entry ${replay.broken.seq + 1}: ${replay.broken.reason} Nothing more can be recorded until a person looks at it.`);
      if (replay.entries >= MAX_CALC_LEDGER_ENTRIES) return fail('The calculator ledger is full.');
      const at = isoOf(this.now());
      const built = build({ computedBy: member, run, at });
      if (!built.ok) return built;
      const record = built.value;
      const final = path.join(recordDir, `${record.id}.json`);
      const exists = await lstat(final).then(() => true, () => false);
      if (exists || replay.records.has(record.id)) return fail(`calc:${record.id} already exists. A record never changes; use a new id (for example ${record.id}-v2)${record.kind === 'movement' ? ' and name this one in supersedes' : ''}.`);
      const text = renderRecord(record);
      const hash = recordHash(text);
      // The record goes in only where no file is (staffFiles.ts, drop 1 review round 4): a file a member put at that name first is never replaced, and
      // the calculator refuses instead. Then the ledger entry; if that fails, the record is taken back out, but only if it is still the bytes written here.
      if (!(await writeIfUnchanged(final, { exists: false }, text))) return fail(`calc:${record.id} already exists. A record never changes; use a new id (for example ${record.id}-v2).`);
      try {
        const signer = await this.options.signer();
        const entry: CalcLedgerEntry = { v: CALC_LEDGER_ENTRY_VERSION, type: 'calculator-record', seq: replay.entries, prev: replay.head, at, run, member, record: record.id, kind: record.kind, hash };
        const envelope = signPayload(signer, 'staff-ledger', entry, { now: () => new Date(Date.parse(at)) });
        await appendFile(path.join(ledgerDir, CALC_LEDGER_FILE), `${JSON.stringify(envelope)}\n`, 'utf8');
      } catch (error) {
        await writeIfUnchanged(final, snapshotOfBytes(Buffer.from(text, 'utf8')), undefined).catch(() => undefined);
        throw error;
      }
      return { ok: true, value: { record, hash } };
    });
  }

  // ---- LOGSTAT ---------------------------------------------------------------------------------------------------------------------------------

  public async reports(): Promise<LogstatReport[]> {
    const dir = path.join(this.options.root, LOGSTAT_REPORTS_DIR);
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const out: LogstatReport[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.json')).sort().slice(0, MAX_RECORDS)) {
      const text = await readText(path.join(dir, name));
      if (text === undefined) continue;
      try {
        const parsed = parseLogstatReport(JSON.parse(text));
        if (parsed.ok && `${parsed.value.id}.json` === name) out.push(parsed.value);
      } catch { /* a damaged file is left out; logstat_read says how many were read */ }
    }
    return out;
  }

  /** Enters one unit's report as received. A report is never changed: a corrected report is a new one with its own id and a later time. */
  public async submitReport(member: string, raw: unknown): Promise<CalcResult<LogstatReport>> {
    const shared = await sharedProjectRefusal(this.options.root);
    if (shared !== undefined) return fail(shared);
    const parsed = parseLogstatReport(raw);
    if (!parsed.ok) return parsed;
    const dir = await safeDir(this.options.root, LOGSTAT_REPORTS_DIR);
    if (!dir) return fail('A folder on the way to the LOGSTAT reports is a symbolic link, so nothing was written.');
    await mkdir(dir, { recursive: true });
    const report: LogstatReport = { ...parsed.value, submittedBy: member, submittedAt: isoOf(this.now()) };
    try {
      await writeFile(path.join(dir, `${report.id}.json`), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return fail(`A LOGSTAT with the id ${report.id} is already in. A report is never changed; enter the unit's corrected report under a new id.`);
      throw error;
    }
    return { ok: true, value: report };
  }

  public async validationLog(): Promise<ValidationLogEntry[]> {
    const text = await readText(path.join(this.options.root, LOGSTAT_VALIDATION_FILE));
    if (text === undefined) return [];
    const out: ValidationLogEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as ValidationLogEntry;
        if (value && typeof value.report === 'string' && typeof value.passed === 'boolean' && Array.isArray(value.findings)) out.push(value);
      } catch { /* a damaged line is left out; the rules run again on every consolidation */ }
    }
    return out;
  }

  public async appendValidation(entries: readonly ValidationLogEntry[]): Promise<void> {
    if (!entries.length) return;
    const shared = await sharedProjectRefusal(this.options.root);
    if (shared !== undefined) throw new SharedProjectError(shared);
    const dir = await safeDir(this.options.root, path.posix.dirname(LOGSTAT_VALIDATION_FILE));
    if (!dir) throw new Error('A folder on the way to the LOGSTAT validation log is a symbolic link, so nothing was written.');
    await mkdir(dir, { recursive: true });
    await withFileLock(dir, LOGSTAT_LOCK, () => appendFile(path.join(this.options.root, LOGSTAT_VALIDATION_FILE), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8'));
  }

  /** The band settings come from the logstat-definitions skill a person fills in. */
  public async definitionsText(): Promise<string | undefined> {
    return readText(path.join(this.options.root, '.planning/staff/skills/logstat-definitions.md'));
  }

  // ---- Movement --------------------------------------------------------------------------------------------------------------------------------

  public async roads(): Promise<CalcResult<RoadGraph>> {
    const text = await readText(path.join(this.options.root, ROADS_FILE));
    if (text === undefined) return fail(`There is no road graph at ${ROADS_FILE}. The mobility planner or a person writes it: { "nodes": [{ "id": "port-a" }], "edges": [{ "from": "port-a", "to": "depot-b", "km": 42 }] }, with fictional places only.`);
    return parseRoadGraph(text);
  }
}
