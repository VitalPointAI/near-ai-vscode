import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// The spend ledger: every billable NEAR AI response this computer received, for one API key.
// Append-only JSONL, one folder per key identity (a hash; the key itself is never stored), one
// file per UTC month, shared by every VS Code window on the machine. Each window appends with
// O_APPEND and reads what the others wrote; every figure is a sum over entries, never a field
// that a later event overwrites. An entry starts with its estimate and is settled later with
// NEAR's actual cost (from /v1/billing/costs) in a separate record keyed by its inference-id.

/** What a request was for, so displays can show where the money went (`eval`: NEAR AI: Compare Models). */
export type SpendKind = 'main' | 'sub-agent' | 'safety' | 'summary' | 'attachment' | 'transcription' | 'image' | 'generation' | 'participant' | 'eval';
/** `open` while a stream is still arriving; `partial` when it broke off; `aborted` when it was cancelled or timed out. */
export type SpendStatus = 'open' | 'completed' | 'partial' | 'aborted';

/** Who a request is billed to inside the extension: set by callers around the work they start. */
export interface SpendTag {
  kind?: SpendKind;
  runId?: string;
  conversationId?: string;
  projectId?: string;
  agentId?: string;
}

const tags = new AsyncLocalStorage<SpendTag>();

/** Runs `work` with `tag` merged over the current one; every NEAR request it makes carries the result. */
export function withSpendTag<T>(tag: SpendTag, work: () => T): T {
  return tags.run({ ...(tags.getStore() ?? {}), ...stripUndefined(tag) }, work);
}

export function currentSpendTag(): SpendTag {
  return { ...(tags.getStore() ?? {}) };
}

export interface SpendEntry extends SpendTag {
  id: string;
  /** The window that wrote it. */
  writer: string;
  /** Milliseconds since the epoch when the response started. */
  at: number;
  /** When the response ended (completed, broke off, or was cancelled). */
  endedAt?: number;
  /** NEAR's `inference-id`, the key for its billing API. */
  requestId?: string;
  model?: string;
  path: string;
  status: SpendStatus;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** Estimate in nano-USD (integer). Provisional until the response ends. */
  estimateNanoUsd: number;
  /** NEAR's actual cost in nano-USD once reconciled. */
  actualNanoUsd?: number;
  /** How the actual was settled: by NEAR's billing answer, or as $0 after NEAR kept reporting no usage. */
  settledBy?: 'billing' | 'zero';
}

export interface SpendFilter {
  /** Inclusive start, ms. */
  since?: number;
  /** Exclusive end, ms. */
  until?: number;
  runId?: string;
  conversationId?: string;
  agentId?: string;
  requestId?: string;
  kind?: SpendKind;
}

export interface SpendTotals {
  /** Settled with NEAR's own figure. */
  confirmedNanoUsd: number;
  /** Has an inference-id and waits for NEAR's figure; counted at the estimate. */
  pendingNanoUsd: number;
  /** No inference-id to reconcile (a request that never got one): the estimate is all there is. */
  estimatedNanoUsd: number;
  requests: number;
  pendingRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export const emptyTotals = (): SpendTotals => ({ confirmedNanoUsd: 0, pendingNanoUsd: 0, estimatedNanoUsd: 0, requests: 0, pendingRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
export const totalNanoUsd = (totals: SpendTotals): number => totals.confirmedNanoUsd + totals.pendingNanoUsd + totals.estimatedNanoUsd;
export const nanoToUsd = (nano: number): number => nano / 1e9;
export const usdToNano = (usd: number | undefined): number => (typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1e9) : 0);

/** A stable, non-secret name for an API key: hash of the endpoint and a hash of the key. */
export function spendIdentity(baseUrl: string, apiKey: string): string {
  const fingerprint = createHash('sha256').update(apiKey).digest('hex');
  return createHash('sha256').update(`${baseUrl.replace(/\/+$/, '').toLowerCase()}\u0000${fingerprint}`).digest('hex').slice(0, 24);
}

export type DayBoundary = 'local' | 'utc';

/** Start (ms) of the calendar day containing `now`, in local time or UTC. */
export function dayStart(now: number, boundary: DayBoundary = 'local'): number {
  const date = new Date(now);
  return boundary === 'utc' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) : new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

type EntryRecord = { t: 'e'; id: string; v: number; w?: string; at?: number; end?: number; rid?: string; model?: string; path?: string; kind?: SpendKind; run?: string; conv?: string; proj?: string; agent?: string; st?: SpendStatus; in?: number; cin?: number; out?: number; est?: number };
type ActualRecord = { t: 'a'; rid: string; nano: number; how: 'billing' | 'zero'; at: number };
type LedgerRecord = EntryRecord | ActualRecord;

export interface SpendLedgerOptions {
  now?: () => number;
  /** Identifies this window's writes (default: random per instance). */
  writer?: string;
}

/** The fields a caller gives when a billable response starts. */
export interface SpendStart extends SpendTag {
  requestId?: string;
  model?: string;
  path: string;
  status?: SpendStatus;
  estimateNanoUsd: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type SpendFinish = Partial<Pick<SpendEntry, 'requestId' | 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'estimateNanoUsd'>> & { status: Exclude<SpendStatus, 'open'> };

/**
 * One key's ledger in one window. Reads are synchronous over what this instance has seen;
 * `refresh()` picks up what other windows appended. Writes are applied in memory at once and
 * appended to disk in order (`flush()` waits for them).
 */
export class SpendLedger {
  public readonly writer: string;
  private readonly now: () => number;
  private readonly entries = new Map<string, SpendEntry & { v: number }>();
  private readonly actuals = new Map<string, { nano: number; how: 'billing' | 'zero' }>();
  private readonly offsets = new Map<string, number>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private reading: Promise<void> | undefined;

  public constructor(public readonly dir: string, options: SpendLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.writer = options.writer ?? `${process.pid}-${randomBytes(4).toString('hex')}`;
  }

  /** Records a billable response; returns its entry id for `finish`. */
  public start(input: SpendStart): string {
    const id = `${this.now().toString(36)}-${randomBytes(6).toString('hex')}`;
    this.write({ t: 'e', id, v: 1, w: this.writer, at: this.now(), ...(input.status && input.status !== 'open' ? { end: this.now() } : {}), rid: input.requestId, model: input.model, path: input.path, kind: input.kind, run: input.runId, conv: input.conversationId, proj: input.projectId, agent: input.agentId, st: input.status ?? 'open', in: input.inputTokens, cin: input.cachedInputTokens, out: input.outputTokens, est: Math.max(0, Math.round(input.estimateNanoUsd)) });
    return id;
  }

  /** The response ended: its final tokens and estimate. */
  public finish(id: string, result: SpendFinish): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.write({ t: 'e', id, v: entry.v + 1, end: this.now(), st: result.status, rid: result.requestId, in: result.inputTokens, cin: result.cachedInputTokens, out: result.outputTokens, est: result.estimateNanoUsd === undefined ? undefined : Math.max(0, Math.round(result.estimateNanoUsd)) });
  }

  /** NEAR's actual cost for an inference-id. A billing answer replaces an earlier $0 settlement. */
  public settle(requestId: string, nanoUsd: number, how: 'billing' | 'zero' = 'billing'): void {
    const known = this.actuals.get(requestId);
    if (known && (known.how === 'billing' || how === 'zero')) return;
    this.write({ t: 'a', rid: requestId, nano: Math.max(0, Math.round(nanoUsd)), how, at: this.now() });
  }

  public get(id: string): SpendEntry | undefined {
    const entry = this.entries.get(id);
    return entry ? this.view(entry) : undefined;
  }

  public list(filter: SpendFilter = {}): SpendEntry[] {
    return [...this.entries.values()].filter((entry) => matches(entry, filter)).map((entry) => this.view(entry));
  }

  /** Entries with an inference-id and no actual cost yet. */
  public pending(): SpendEntry[] {
    const seen = new Set<string>();
    return [...this.entries.values()].filter((entry) => {
      if (!entry.requestId || this.actuals.has(entry.requestId) || seen.has(entry.requestId)) return false;
      seen.add(entry.requestId);
      return true;
    }).map((entry) => this.view(entry));
  }

  /** Sums over the entries that match. A request ID billed once counts once, even if recorded twice. */
  public totals(filter: SpendFilter = {}): SpendTotals {
    const totals = emptyTotals();
    const counted = new Set<string>();
    for (const entry of this.entries.values()) {
      if (!matches(entry, filter)) continue;
      totals.requests += 1;
      totals.inputTokens += entry.inputTokens ?? 0;
      totals.outputTokens += entry.outputTokens ?? 0;
      totals.cachedInputTokens += entry.cachedInputTokens ?? 0;
      const rid = entry.requestId;
      const actual = rid ? this.actuals.get(rid) : undefined;
      if (rid && counted.has(rid)) continue;
      if (rid) counted.add(rid);
      if (actual) totals.confirmedNanoUsd += actual.nano;
      else if (rid) { totals.pendingNanoUsd += entry.estimateNanoUsd; totals.pendingRequests += 1; }
      else totals.estimatedNanoUsd += entry.estimateNanoUsd;
    }
    return totals;
  }

  /** Called after anything changes (own writes and what `refresh` reads). */
  public onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Waits for this instance's appends to reach the disk. */
  public flush(): Promise<void> {
    return this.writes;
  }

  /** Reads what was appended since the last read (by any window) in this and last month's files. */
  public refresh(): Promise<void> {
    this.reading ??= this.readNew().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async readNew(): Promise<void> {
    let changed = false;
    for (const file of this.segments()) {
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(file, 'r');
        const { size } = await handle.stat();
        let offset = this.offsets.get(file) ?? 0;
        if (size < offset) offset = 0;
        if (size === offset) continue;
        const buffer = Buffer.alloc(size - offset);
        await handle.read(buffer, 0, buffer.length, offset);
        const end = buffer.lastIndexOf(0x0a);
        if (end < 0) continue;
        for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
          const record = parseRecord(line);
          if (record && this.apply(record)) changed = true;
        }
        this.offsets.set(file, offset + end + 1);
      } catch {
        /* a missing or unreadable file contributes nothing */
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
    if (changed) this.changed();
  }

  private write(record: LedgerRecord): void {
    this.apply(record);
    this.changed();
    const file = this.segment(this.now());
    const line = `${JSON.stringify(record)}\n`;
    // O_APPEND ('a'): concurrent windows never overwrite each other's lines.
    this.writes = this.writes.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, { encoding: 'utf8', flag: 'a' });
    }).catch(() => undefined);
  }

  /** Applies a record; replaying one already applied changes nothing. */
  private apply(record: LedgerRecord): boolean {
    if (record.t === 'a') {
      const known = this.actuals.get(record.rid);
      if (known && (known.how === 'billing' || record.how === 'zero')) return false;
      this.actuals.set(record.rid, { nano: record.nano, how: record.how });
      return true;
    }
    const version = this.versions.get(record.id) ?? 0;
    if (record.v <= version) return false;
    const existing = this.entries.get(record.id);
    if (!existing && (record.at === undefined || !record.path)) return false;
    this.versions.set(record.id, record.v);
    const base: SpendEntry & { v: number } = existing ?? { id: record.id, writer: record.w ?? '', at: record.at!, path: record.path!, status: 'open', estimateNanoUsd: 0, v: 0 };
    const next: SpendEntry & { v: number } = { ...base, v: record.v };
    if (record.end !== undefined) next.endedAt = record.end;
    if (record.rid) next.requestId = record.rid;
    if (record.model) next.model = record.model;
    if (record.kind) next.kind = record.kind;
    if (record.run) next.runId = record.run;
    if (record.conv) next.conversationId = record.conv;
    if (record.proj) next.projectId = record.proj;
    if (record.agent) next.agentId = record.agent;
    if (record.st) next.status = record.st;
    if (record.in !== undefined) next.inputTokens = record.in;
    if (record.cin !== undefined) next.cachedInputTokens = record.cin;
    if (record.out !== undefined) next.outputTokens = record.out;
    if (record.est !== undefined) next.estimateNanoUsd = record.est;
    this.entries.set(record.id, next);
    return true;
  }

  private view(entry: SpendEntry & { v: number }): SpendEntry {
    const { v: _version, ...rest } = entry;
    const actual = entry.requestId ? this.actuals.get(entry.requestId) : undefined;
    return actual ? { ...rest, actualNanoUsd: actual.nano, settledBy: actual.how } : rest;
  }

  private changed(): void {
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* a listener never breaks the ledger */ } }
  }

  private segment(at: number): string {
    const date = new Date(at);
    return path.join(this.dir, `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`);
  }

  private segments(): string[] {
    const now = new Date(this.now());
    const previous = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15);
    return [this.segment(previous), this.segment(now.getTime())];
  }
}

function matches(entry: SpendEntry, filter: SpendFilter): boolean {
  if (filter.since !== undefined && entry.at < filter.since) return false;
  if (filter.until !== undefined && entry.at >= filter.until) return false;
  if (filter.runId !== undefined && entry.runId !== filter.runId) return false;
  if (filter.conversationId !== undefined && entry.conversationId !== filter.conversationId) return false;
  if (filter.agentId !== undefined && entry.agentId !== filter.agentId) return false;
  if (filter.requestId !== undefined && entry.requestId !== filter.requestId) return false;
  if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
  return true;
}

function parseRecord(line: string): LedgerRecord | undefined {
  if (!line.trim()) return undefined;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.t === 'a') {
    if (typeof record.rid !== 'string' || typeof record.nano !== 'number' || !Number.isFinite(record.nano) || record.nano < 0) return undefined;
    return { t: 'a', rid: record.rid, nano: Math.round(record.nano), how: record.how === 'zero' ? 'zero' : 'billing', at: typeof record.at === 'number' ? record.at : 0 };
  }
  if (record.t !== 'e' || typeof record.id !== 'string' || typeof record.v !== 'number') return undefined;
  const num = (key: string) => (typeof record[key] === 'number' && Number.isFinite(record[key]) && (record[key] as number) >= 0 ? record[key] as number : undefined);
  const str = (key: string) => (typeof record[key] === 'string' && record[key] ? (record[key] as string).slice(0, 200) : undefined);
  const status = ['open', 'completed', 'partial', 'aborted'].includes(String(record.st)) ? record.st as SpendStatus : undefined;
  const kinds: SpendKind[] = ['main', 'sub-agent', 'safety', 'summary', 'attachment', 'transcription', 'image', 'generation', 'participant', 'eval'];
  const kind = kinds.includes(record.kind as SpendKind) ? record.kind as SpendKind : undefined;
  return stripUndefined({ t: 'e' as const, id: record.id, v: record.v, w: str('w'), at: num('at'), end: num('end'), rid: str('rid'), model: str('model'), path: str('path'), kind, run: str('run'), conv: str('conv'), proj: str('proj'), agent: str('agent'), st: status, in: num('in'), cin: num('cin'), out: num('out'), est: num('est') });
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
