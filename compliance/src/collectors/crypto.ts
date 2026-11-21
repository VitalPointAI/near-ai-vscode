// Crypto inventory collector (44-07, D-09, D-23, D-24). It reads the documented
// ITSP standing row by row and records only the algorithm id and pass/fail status.
import path from 'node:path';
import type { Observation } from '../model.ts';
import { LAST_REVIEWED_PATTERN, reviewedAt } from './documents.ts';
import type { Collector, CollectorContext } from './types.ts';

export interface CryptoInput {
  readonly repoRoot: string;
}

const INVENTORY_PATH = 'docs/security/crypto-inventory.md';
const HEADERS = ['Algorithm', 'Where used', 'ITSP.40.111 (version 5)', 'Basis'];
const STANDINGS = new Set(['listed', 'listed with conditions', 'not listed']);

const cells = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
const divider = (row: readonly string[]): boolean => row.length === HEADERS.length && row.every((cell) => /^:?-{3,}:?$/.test(cell));

function inventoryRows(text: string): readonly { algorithm: string; standing: string }[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === '## Algorithms');
  if (start < 0) throw new Error('crypto collector: inventory has no ## Algorithms section');
  let headerLine = -1;
  for (let index = start + 1; index < lines.length && !lines[index].startsWith('## '); index++) {
    if (lines[index].startsWith('|')) { headerLine = index; break; }
  }
  if (headerLine < 0) throw new Error('crypto collector: Algorithms has no table');
  const headers = cells(lines[headerLine]);
  if (headers.length !== HEADERS.length || HEADERS.some((header, index) => headers[index] !== header)) throw new Error('crypto collector: inventory table headers do not match the documented contract');
  if (!divider(cells(lines[headerLine + 1] ?? ''))) throw new Error('crypto collector: inventory table has no divider');
  const rows: { algorithm: string; standing: string }[] = [];
  for (let index = headerLine + 2; index < lines.length && lines[index].startsWith('|'); index++) {
    const row = cells(lines[index]);
    if (row.length !== headers.length || row.some((cell) => cell === '')) throw new Error(`crypto collector: invalid inventory row ${index + 1}`);
    if (!STANDINGS.has(row[2])) throw new Error(`crypto collector: unknown ITSP standing in row ${index + 1}: ${row[2]}`);
    rows.push({ algorithm: row[0], standing: row[2] });
  }
  return rows;
}

function subjectFor(algorithm: string): string {
  const subject = algorithm.trim().toLowerCase().replace(/\s+/g, '-');
  if (subject === '') throw new Error('crypto collector: inventory has an empty Algorithm cell');
  return subject;
}

/** One document-window observation per inventory row. `not listed` is informative failing evidence. */
export const cryptoCollector: Collector<CryptoInput> = Object.freeze({
  id: 'crypto',
  window: 'document',
  async collect(input: CryptoInput, context: CollectorContext): Promise<Observation[]> {
    if (!input || typeof input.repoRoot !== 'string' || input.repoRoot === '') throw new Error('crypto collector: input.repoRoot is required');
    const root = path.resolve(input.repoRoot);
    const file = path.resolve(root, INVENTORY_PATH);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error('crypto collector: inventory path escapes repo root');
    let text: string;
    try { text = await context.readFile(file); } catch (error) { throw new Error(`crypto collector: could not read inventory: ${error instanceof Error ? error.message : String(error)}`); }
    const review = reviewedAt(LAST_REVIEWED_PATTERN.exec(text.split(/\r?\n/, 40).join('\n'))?.[1] ?? '');
    if (!review) throw new Error('crypto collector: inventory is missing a valid Last reviewed date');
    return inventoryRows(text).map((row): Observation => ({ collector: 'crypto', subject: subjectFor(row.algorithm), passed: row.standing !== 'not listed', collectedAt: review.toISOString(), commit: context.commit }));
  }
});
