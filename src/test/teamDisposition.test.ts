// The v0.6.0 disposition record (.planning/research/v0.6.0-disposition.md, Phase 69, TMR-01 and
// TMR-04) is a planning file, not product code, but L2 starts from it and the roadmap links to it, so
// its shape is pinned here: one row per v0.6.0 phase in the archive's order, a disposition from a
// closed list and a reason on every row, the archive's full commit sha, no local machine path, and
// the two link lines. The expected lists are hard-coded because CI does not fetch the archive branch.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECORD = '.planning/research/v0.6.0-disposition.md';
const ARCHIVE_SHA = '4207080ca394d36cf36bbed37b179d8f8400b721';

const V060_PHASES = ['60', '61', '62', '62.1', '63', '64', '65', '66', '67'];

const DISPOSITION_PREFIXES = ['Landed in Phase 69', 'Carried to L2', 'Folded into Phase ', 'Retired'];

// A path such as a home folder, a Windows drive or a scratch folder must never reach a repo file (T-69-40).
const LOCAL_PATH = /\/(home|Users|mnt|tmp)\/|[A-Za-z]:[\\]/;

async function readRepoFile(relative: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relative), 'utf8');
}

/** The text under one H2 heading, up to the next H2. Empty when the heading is missing. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/** Body rows of the first markdown table in the text (header and separator rows dropped). */
function tableRows(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('|'));
  return lines.slice(2).map(splitRow);
}

/** Problems in rows whose columns are [id, ..., disposition, ..., reason]; empty list when sound. */
function rowProblems(rows: string[][], columns: number, dispositionIndex: number, reasonIndex: number): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    if (row.length !== columns) problems.push(`row "${row[0] ?? ''}" has ${row.length} cells, expected ${columns}`);
    if (row.some((cell) => cell === '')) problems.push(`row "${row[0] ?? ''}" has an empty cell`);
    const disposition = row[dispositionIndex] ?? '';
    if (!DISPOSITION_PREFIXES.some((prefix) => disposition.startsWith(prefix))) {
      problems.push(`row "${row[0] ?? ''}" has the disposition "${disposition}", which does not start with an allowed prefix`);
    }
    if ((row[reasonIndex] ?? '') === '') problems.push(`row "${row[0] ?? ''}" has no reason`);
  }
  return problems;
}

/** The leading phase number of a first cell such as "62.1 Board timeline". */
function phaseNumber(cell: string): string {
  return cell.split(/\s+/)[0] ?? '';
}

test('the checker names an empty cell, a missing reason and a disposition outside the list', () => {
  const table = [
    '| Phase | State | Disposition | Reason |',
    '|---|---|---|---|',
    '| 60 Team core | Complete | Landed in Phase 69 | ported |',
    '| 61 Invitations | Open |  | later |',
    '| 62 Board | Open | Carried to L2 |  |',
    '| 63 Claims | Open | Maybe later | later |',
  ].join('\n');
  const problems = rowProblems(tableRows(table), 4, 2, 3);
  assert.ok(problems.some((p) => p.includes('"61 Invitations"') && p.includes('empty cell')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('"62 Board"') && p.includes('no reason')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('"63 Claims"') && p.includes('allowed prefix')), problems.join('\n'));
  assert.ok(!problems.some((p) => p.includes('"60 Team core"')), 'a complete row must pass');
});

test('the TMR-01 section records the archive commit in full', async () => {
  const record = await readRepoFile(RECORD);
  const archive = section(record, 'TMR-01: the archive');
  assert.ok(archive.includes(ARCHIVE_SHA), 'the section must carry the full archive sha, not a short one');
  assert.ok(archive.includes('777'), 'the section must carry the commit count above the fork point');
  assert.ok(archive.includes('path kept out of the repository'), 'the legacy worktree is named without its path');
});

test('the phase table has exactly the nine v0.6.0 phases in roadmap order, each with a disposition and a reason', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Phases'));
  assert.deepEqual(rows.map((row) => phaseNumber(row[0] ?? '')), V060_PHASES);
  assert.deepEqual(rowProblems(rows, 4, 2, 3), []);
});

test('only Phase 60 is recorded as landed in Phase 69, and Phase 67 retires the relay transport', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Phases'));
  const landed = rows.filter((row) => (row[2] ?? '').startsWith('Landed in Phase 69')).map((row) => phaseNumber(row[0] ?? ''));
  assert.deepEqual(landed, ['60']);
  const sixtySeven = rows.find((row) => phaseNumber(row[0] ?? '') === '67');
  assert.ok(sixtySeven?.[3]?.includes('relayTransport.ts') && /retired/i.test(sixtySeven[3]), 'Phase 67 names the retired relay transport');
});

test('no line of the record holds a local machine path or an em-dash', async () => {
  const record = await readRepoFile(RECORD);
  const lines = record.split(/\r?\n/);
  const pathLines = lines.map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => LOCAL_PATH.test(line));
  assert.deepEqual(pathLines, [], 'a local path would publish the owner\'s machine layout');
  assert.ok(!record.includes('—'), 'the record uses plain punctuation, no em-dash');
});

test('REQUIREMENTS.md and ROADMAP.md link to the record', async () => {
  for (const file of ['.planning/REQUIREMENTS.md', '.planning/ROADMAP.md']) {
    const text = await readRepoFile(file);
    assert.ok(text.includes(RECORD), `${file} must point to ${RECORD}`);
  }
});
