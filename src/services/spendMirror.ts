// This project's spend history, mirrored into the state home so every editor on this computer can show it (D-11, SYNC-01). The spend ledger of an
// editor lives in that editor's own storage, one folder per API key; this copies the lines that belong to the open project into
// .near-ai/state/spend/<yyyy>-<mm>.jsonl, in the ledger's own line format, so the same reader reads both.
//
// The daily spend limit is not touched: it still counts only this editor's own ledger (D-11, a follow-up release decides otherwise). Nothing in the
// editor's storage is written. No vscode here.
//
// A ledger entry is a series of lines with one id: the first carries what the request was (time, model, the project tag), later ones only what
// changed (it ended, its tokens, its final estimate). So the project tag is on the first line only, and an entry is the project's when ANY line of
// its id carries the tag; every line of that id is then copied. A settled cost is its own line keyed by the request's inference-id, copied when its
// request is the project's.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { unionLog } from '../domain/state/merge';
import { canonicalJson } from '../domain/state/records';
import { nanoToUsd, SpendLedger } from './spendLedger';
import { stateHomeFor, writeFileAtomic, type ProjectStateHome } from './stateHome';

export interface SpendMirrorOptions {
  /** The editor's spend folder: `<globalStorage>/spend`, holding one folder per key identity. Read only. */
  ledgerRoot: string;
  /** The project's credential scope id: the `proj` tag its requests carry. */
  projectScopeId: string;
  home: ProjectStateHome;
  /** Only look at this many of the newest months of the editor's ledger (what a run that just ended can have changed); all months by default. */
  recentMonths?: number;
}

type Line = Record<string, unknown>;

/** A ledger line made ready for unionLog: one identity per (entry id, version), so no later version of an entry replaces an earlier one. */
interface Tagged { id: string; v: number; line: Line }

const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;

function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as Line | null;
      if (!value || typeof value !== 'object') continue;
      if (value.t === 'e' && typeof value.id === 'string' && typeof value.v === 'number' && Number.isFinite(value.v)) lines.push(value);
      else if (value.t === 'a' && typeof value.rid === 'string') lines.push(value);
    } catch { /* a torn or damaged line is not copied */ }
  }
  return lines;
}

/**
 * Every version of an entry is a line of its own (a later one only adds what changed, so the highest version alone would lose the entry's start), and
 * a settled cost is one line per distinct content. unionLog then dedupes copies of one line and sorts them the same way whatever the order of the inputs.
 */
function tag(line: Line): Tagged {
  if (line.t === 'e') return { id: `${line.id as string}#${String(line.v as number).padStart(12, '0')}`, v: line.v as number, line };
  return { id: `a#${canonicalJson(line)}`, v: 0, line };
}

/** The ledger lines of a month file that are well formed (an entry version or a settled cost); torn or foreign lines are left out. */
export function parseSpendLines(text: string): Array<Record<string, unknown>> {
  return parseLines(text);
}

/** Two sets of ledger lines united the way the mirror unites them: every version of an entry is kept, a settled cost once per distinct content, in one fixed order. */
export function mergeSpendLines(a: ReadonlyArray<Record<string, unknown>>, b: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return unionLog(a.map(tag), b.map(tag)).map((item) => item.line);
}

/** The month file's text for a set of lines (the mirror's own form: canonical JSON, one line each). */
export function spendFileText(lines: ReadonlyArray<Record<string, unknown>>): string {
  return text(lines.map(tag));
}

const text = (lines: readonly Tagged[]): string => (lines.length ? `${lines.map((item) => canonicalJson(item.line)).join('\n')}\n` : '');

/** The ledger files of every key identity, grouped by month. */
async function sourceMonths(ledgerRoot: string, recentMonths: number | undefined): Promise<Map<string, Line[]>> {
  const months = new Map<string, Line[]>();
  for (const identity of (await readdir(ledgerRoot, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).map((item) => item.name).sort()) {
    for (const name of (await readdir(path.join(ledgerRoot, identity)).catch(() => [] as string[])).sort()) {
      const month = MONTH_FILE.exec(name)?.[1];
      if (!month) continue;
      const lines = parseLines(await readFile(path.join(ledgerRoot, identity, name), 'utf8').catch(() => ''));
      months.set(month, [...(months.get(month) ?? []), ...lines]);
    }
  }
  if (recentMonths === undefined) return months;
  const keep = new Set([...months.keys()].sort().reverse().slice(0, Math.max(1, recentMonths)));
  return new Map([...months].filter(([month]) => keep.has(month)));
}

/** What the state home's spend folder holds now, by month. */
async function mirroredMonths(home: ProjectStateHome): Promise<Map<string, { text: string; lines: Tagged[] }>> {
  const months = new Map<string, { text: string; lines: Tagged[] }>();
  for (const name of (await readdir(home.paths.spend).catch(() => [] as string[])).sort()) {
    const month = MONTH_FILE.exec(name)?.[1];
    if (!month) continue;
    const content = await readFile(path.join(home.paths.spend, name), 'utf8').catch(() => '');
    months.set(month, { text: content, lines: parseLines(content).map(tag) });
  }
  return months;
}

/**
 * Adds this project's spend lines from the editor's ledger to the state home, merging with what other editors put there. Returns how many lines were
 * added or changed. Writes nothing (and creates nothing) when there is nothing new, so running it again changes nothing.
 */
export async function mirrorProjectSpend(options: SpendMirrorOptions): Promise<number> {
  const { home } = options;
  const source = await sourceMonths(options.ledgerRoot, options.recentMonths);
  if (!source.size) return 0;
  const mirrored = await mirroredMonths(home);

  // What is already the project's: its entries stay the project's whatever the newest months say (a run that began last month ends this month).
  const ids = new Set<string>();
  const rids = new Set<string>();
  for (const { lines } of mirrored.values()) {
    for (const { line } of lines) {
      if (line.t === 'e') ids.add(line.id as string);
      if (typeof line.rid === 'string') rids.add(line.rid);
    }
  }
  for (const lines of source.values()) for (const line of lines) if (line.t === 'e' && line.proj === options.projectScopeId) ids.add(line.id as string);
  for (const lines of source.values()) for (const line of lines) if (line.t === 'e' && ids.has(line.id as string) && typeof line.rid === 'string') rids.add(line.rid);

  let added = 0;
  let prepared = false;
  for (const [month, lines] of [...source].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mine = lines.filter((line) => (line.t === 'e' ? ids.has(line.id as string) : rids.has(line.rid as string)));
    if (!mine.length) continue;
    const existing = mirrored.get(month);
    const merged = unionLog(existing?.lines ?? [], mine.map(tag));
    const known = new Set((existing?.lines ?? []).map((item) => canonicalJson(item.line)));
    const fresh = merged.filter((item) => !known.has(canonicalJson(item.line))).length;
    const next = text(merged);
    if (next === (existing?.text ?? '')) continue;
    if (!prepared) { await home.ensure(); await mkdir(home.paths.spend, { recursive: true, mode: 0o700 }); prepared = true; }
    await writeFileAtomic(path.join(home.paths.spend, `${month}.jsonl`), next);
    added += fresh;
  }
  return added;
}

export interface ProjectSpendMonth {
  /** `yyyy-mm`, UTC. */
  month: string;
  requests: number;
  /** Settled with NEAR's own figure, in USD. */
  confirmedUsd: number;
  /** Still waiting for NEAR's figure, or with none to wait for: counted at the estimate, in USD. */
  estimatedUsd: number;
  byModel: Array<{ model: string; requests: number; usd: number }>;
}

/**
 * The project's spend history from the state home's mirror, newest month first: what every editor that worked on the project spent. Reads the mirror
 * only. Empty when there is none. At most the newest 24 months are read.
 */
export async function readProjectSpend(home: ProjectStateHome, now: number = Date.now()): Promise<ProjectSpendMonth[]> {
  const names = (await readdir(home.paths.spend).catch(() => [] as string[])).filter((name) => MONTH_FILE.test(name)).sort();
  if (!names.length) return [];
  const [year, month] = names[0].slice(0, 7).split('-').map(Number);
  const earliest = Date.UTC(year, month - 1, 1);
  const latestStart = new Date(now);
  const from = Math.max(earliest, Date.UTC(latestStart.getUTCFullYear(), latestStart.getUTCMonth() - 23, 1));
  const ledger = new SpendLedger(home.paths.spend, { now: () => now, from });
  await ledger.refresh();
  const grouped = new Map<string, ReturnType<SpendLedger['list']>>();
  for (const entry of ledger.list()) {
    const at = new Date(entry.at);
    const key = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  const result: ProjectSpendMonth[] = [];
  for (const [key, entries] of grouped) {
    const [y, m] = key.split('-').map(Number);
    const totals = ledger.totals({ since: Date.UTC(y, m - 1, 1), until: Date.UTC(y, m, 1) });
    const byModel = new Map<string, { requests: number; nano: number }>();
    const counted = new Set<string>();
    for (const entry of entries) {
      const model = entry.model ?? 'unknown model';
      const row = byModel.get(model) ?? { requests: 0, nano: 0 };
      row.requests += 1;
      // A request settled once costs once, however many lines describe it.
      if (!entry.requestId || !counted.has(entry.requestId)) row.nano += entry.actualNanoUsd ?? entry.estimateNanoUsd;
      if (entry.requestId) counted.add(entry.requestId);
      byModel.set(model, row);
    }
    result.push({
      month: key, requests: totals.requests, confirmedUsd: nanoToUsd(totals.confirmedNanoUsd), estimatedUsd: nanoToUsd(totals.pendingNanoUsd + totals.estimatedNanoUsd),
      byModel: [...byModel].map(([model, row]) => ({ model, requests: row.requests, usd: nanoToUsd(row.nano) })).sort((a, b) => b.usd - a.usd || (a.model < b.model ? -1 : 1))
    });
  }
  return result.sort((a, b) => (a.month < b.month ? 1 : -1));
}

const usd = (value: number): string => `$${value.toFixed(4)}`;

/** The "Project spend history" section of the run report, in Markdown; empty when there is no history. */
export function formatProjectSpend(months: readonly ProjectSpendMonth[]): string {
  if (!months.length) return '';
  const lines = [
    '## Project spend history', '',
    'What this project spent with NEAR AI, from every editor that has worked on it on this computer. The daily spend limit still counts only this editor\'s own spending.', ''
  ];
  for (const month of months) {
    const rows = month.byModel.map((row) => `${row.model} (${row.requests} request${row.requests === 1 ? '' : 's'}, ${usd(row.usd)})`);
    lines.push(`### ${month.month}`, `- ${month.requests} request${month.requests === 1 ? '' : 's'}: ${usd(month.confirmedUsd)} confirmed, ${usd(month.estimatedUsd)} still estimated`, `- By model: ${rows.join('; ') || 'none'}`, '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * The "Project spend history" section for the run performance report: what every editor on this computer spent on the project, from the state home's
 * mirror (D-11). Empty when the project has no state home or no history, so the report is then what it was before. Reading creates nothing.
 */
export async function projectSpendSection(root: string, now: number = Date.now()): Promise<string> {
  const home = stateHomeFor(root);
  if (!(await home.exists())) return '';
  return formatProjectSpend(await readProjectSpend(home, now).catch(() => []));
}
