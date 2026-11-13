import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { Finding } from '../domain/cyber';
import type { LedgerEntry, LedgerFields } from '../domain/cyberLedger';
import { appendEntry, chainBreak, verifyChain } from '../domain/cyberLedger';

// The append-only, hash-chained run ledger (CYBER-11, D-28). One JSONL file per run, written with
// fs.appendFile and never rewritten; the domain layer computes each hash and enforces the index
// sequence. There is no update and no delete — a refusal is a new entry, never an edit. Replay reads
// the stored chain and never touches a network or executes a tool.

const RUN_ID = /^run-[a-z0-9-]{6,80}$/;

export class LedgerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** One recorded step, as replay renders it back. */
export interface ReplayedStep {
  index: number;
  timestamp: string;
  tool: string;
  arguments: string;
  result: string;
  reasoning: string;
  evidenceHash: string;
}

export interface Replay {
  runId: string;
  steps: ReplayedStep[];
  findings: Finding[];
  /** The chain's verdict, so a replay never presents a tampered run as sound. */
  chainOk: boolean;
  chainBreak?: string;
}

/** A finding as the run persists it; the ledger is the only place findings are stored. */
export const FINDING_MARKER = 'finding:';

export class CyberLedgerStore {
  private writeQueue: Promise<void> = Promise.resolve();

  /** `directory` is the engagement's own storage folder; the extension host API stays outside. */
  public constructor(private readonly directory: string) {}

  public runPath(runId: string): string {
    if (!RUN_ID.test(runId)) throw new LedgerError(`"${runId}" is not a run id.`);
    return path.join(this.directory, 'runs', runId, 'ledger.jsonl');
  }

  public async entries(runId: string): Promise<LedgerEntry[]> {
    const text = await readFile(this.runPath(runId), 'utf8').catch(() => '');
    const entries: LedgerEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line) as LedgerEntry); } catch { throw new LedgerError(`The ledger for ${runId} holds a line that is not JSON.`); }
    }
    return entries;
  }

  /**
   * Appends the next entry. The caller supplies the fields; the store supplies the index and the
   * previous hash, so a caller cannot renumber or re-link the chain.
   */
  public append(runId: string, fields: Omit<LedgerFields, 'index'> & { index?: number }): Promise<LedgerEntry> {
    const done = this.writeQueue.then(async () => {
      const entries = await this.entries(runId);
      const entry = appendEntry(entries, { ...fields, index: fields.index ?? entries.length });
      const file = this.runPath(runId);
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
      return entry;
    });
    this.writeQueue = done.then(() => undefined, () => undefined);
    return done;
  }

  /** The chain's verdict (true) or false; the first break is available through breakAt. */
  public async verify(runId: string): Promise<boolean> {
    return verifyChain(await this.entries(runId));
  }

  public async breakAt(runId: string): Promise<string | undefined> {
    return chainBreak(await this.entries(runId));
  }

  /** Offline re-render: steps in order plus the findings the run recorded. No network, no tools. */
  public async replay(runId: string): Promise<Replay> {
    const entries = await this.entries(runId);
    const steps: ReplayedStep[] = entries.map((entry) => ({ index: entry.index, timestamp: entry.timestamp, tool: entry.tool, arguments: entry.arguments, result: entry.result, reasoning: entry.modelReasoning, evidenceHash: entry.evidenceHash }));
    const findings: Finding[] = [];
    for (const entry of entries) {
      if (!entry.result.startsWith(FINDING_MARKER)) continue;
      const body = entry.result.slice(FINDING_MARKER.length);
      try { findings.push(JSON.parse(body) as Finding); } catch { /* a mangled finding line is already a chain break */ }
    }
    const broken = chainBreak(entries);
    return { runId, steps, findings, chainOk: broken === undefined, ...(broken ? { chainBreak: broken } : {}) };
  }
}

/** Evidence blobs, content-addressed by SHA-256 (D-27, D-28). */
export const HASH_SHAPE = /^[a-f0-9]{64}$/;
/** How many runs keep their evidence blobs; the ledger itself is never pruned. */
export const PRUNE_KEEP_RUNS = 3;

export class EvidenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

/** The record written when a check could not run, so absence is hash-chained like any evidence. */
export interface AbsentRecord {
  kind: 'absent';
  tool: string;
  installCommand: string;
  reason: string;
}

export class CyberEvidenceStore {
  public constructor(private readonly directory: string) {}

  private evidenceDir(runId: string): string {
    if (!RUN_ID.test(runId)) throw new EvidenceError(`"${runId}" is not a run id.`);
    return path.join(this.directory, 'runs', runId, 'evidence');
  }

  private blobPath(runId: string, hash: string): string {
    // The hash comes from a report, so it is validated before it can name a path (T-25-38).
    if (!HASH_SHAPE.test(hash)) throw new EvidenceError(`"${hash}" is not an evidence hash.`);
    return path.join(this.evidenceDir(runId), hash);
  }

  /** Stores the bytes unmodified and returns the SHA-256 of exactly those bytes. */
  public async put(runId: string, blob: string | Buffer): Promise<string> {
    const bytes = Buffer.isBuffer(blob) ? blob : Buffer.from(blob, 'utf8');
    const hash = createHashOf(bytes);
    const file = this.blobPath(runId, hash);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
    return hash;
  }

  /** Absence as evidence: a named record, stored through the same hashing path. */
  public async putAbsent(runId: string, record: AbsentRecord): Promise<string> {
    const canonical = JSON.stringify({ installCommand: record.installCommand, kind: record.kind, reason: record.reason, tool: record.tool });
    return this.put(runId, canonical);
  }

  public async get(runId: string, hash: string): Promise<Buffer> {
    const file = this.blobPath(runId, hash);
    const bytes = await readFile(file).catch(() => undefined);
    if (!bytes) throw new EvidenceError(`No evidence blob ${hash} in run ${runId}.`);
    // Re-hash on read, so a swapped blob is caught rather than trusted (T-25-37).
    if (createHashOf(bytes) !== hash) throw new EvidenceError(`Evidence blob ${hash} in run ${runId} no longer matches its hash.`);
    return bytes;
  }

  /**
   * Deletes the evidence directories of runs older than the newest `keep`. The ledger is never
   * pruned; a note entry naming what was removed is appended for each pruned run by the caller.
   */
  public async prune(runIdsOldestFirst: string[], keep = PRUNE_KEEP_RUNS): Promise<string[]> {
    const cutoff = Math.max(0, runIdsOldestFirst.length - Math.max(0, keep));
    const pruned: string[] = [];
    for (const runId of runIdsOldestFirst.slice(0, cutoff)) {
      const directory = this.evidenceDir(runId);
      const names = await readdir(directory).catch(() => [] as string[]);
      if (!names.length) continue;
      await rm(directory, { recursive: true, force: true });
      pruned.push(runId);
    }
    return pruned;
  }
}

function createHashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
