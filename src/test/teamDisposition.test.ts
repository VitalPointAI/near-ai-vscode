// The v0.6.0 disposition record (.planning/research/v0.6.0-disposition.md, Phase 69, TMR-01 and
// TMR-04) is a planning file, not product code, but L2 starts from it and the roadmap links to it, so
// its shape is pinned here: one row per v0.6.0 phase in the archive's order, a disposition from a
// closed list and a reason on every row, the archive's full commit sha, no local machine path, and
// the two link lines. The expected lists are hard-coded because CI does not fetch the archive branch.

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RECORD = '.planning/research/v0.6.0-disposition.md';
const ARCHIVE_SHA = '4207080ca394d36cf36bbed37b179d8f8400b721';

const V060_PHASES = ['60', '61', '62', '62.1', '63', '64', '65', '66', '67'];

// The archive's REQUIREMENTS.md order. Its header says 33 but it lists these 34.
const V060_REQUIREMENTS = [
  'TEAM-01', 'TEAM-02', 'TEAM-03', 'TEAM-04',
  'BOARD-01', 'BOARD-02', 'BOARD-03', 'BOARD-04',
  'ASSIGN-01', 'ASSIGN-02', 'ASSIGN-03',
  'CLAIM-01', 'CLAIM-02', 'CLAIM-03', 'CLAIM-04', 'CLAIM-05',
  'INTEG-01', 'INTEG-02', 'INTEG-03',
  'BUDGET-01', 'BUDGET-02', 'BUDGET-03', 'BUDGET-04', 'BUDGET-05',
  'METRIC-01',
  'COLLAB-01', 'COLLAB-02',
  'SEC-01', 'SEC-02', 'SEC-03', 'SEC-04',
  'FLOW-01', 'SETUP-01', 'UX-01',
];

// Ids that collide with a live v0.7.0 id carry the TM- prefix (D-16); every other id stays as it is.
const PREFIXED = new Set(['TEAM-01', 'TEAM-02', 'TEAM-03', 'TEAM-04', 'SETUP-01']);

// The only ids recorded as landed in Phase 69, each with the Phase 69 tests that cover it (T-69-39).
const LANDED_WITH_TESTS: Record<string, string[]> = {
  'TM-TEAM-01': ['teamEnable', 'teamCommands'],
  'TM-TEAM-04': ['teamForgery', 'teamMaterialize'],
  'SEC-01': ['teamEnable', 'teamCommands'],
  'SEC-04': ['teamPermissions', 'teamForgery'],
};

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
  assert.ok(!record.includes('\u2014'), 'the record uses plain punctuation, no em-dash');
});

test('REQUIREMENTS.md and ROADMAP.md link to the record', async () => {
  for (const file of ['.planning/REQUIREMENTS.md', '.planning/ROADMAP.md']) {
    const text = await readRepoFile(file);
    assert.ok(text.includes(RECORD), `${file} must point to ${RECORD}`);
  }
});

// Requirement table columns: archive id, meaning, id from now on, disposition, same id elsewhere, reason.
const REQ_COLUMNS = 6;
const REQ_DISPOSITION = 3;
const REQ_REASON = 5;

test('the requirement table has exactly the 34 archive ids in the archive order, each with a disposition and a reason', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Requirements'));
  assert.equal(V060_REQUIREMENTS.length, 34);
  assert.deepEqual(rows.map((row) => row[0]), V060_REQUIREMENTS);
  assert.deepEqual(rowProblems(rows, REQ_COLUMNS, REQ_DISPOSITION, REQ_REASON), []);
});

test('the requirement checker names a row with an empty cell', () => {
  const table = [
    '| Id | Meaning | Now | Disposition | Same id | Reason |',
    '|---|---|---|---|---|---|',
    '| TEAM-01 | Enable | TM-TEAM-01 | Landed in Phase 69 | v0.7.0 TEAM-01 | ported |',
    '| TEAM-02 | Invite | TM-TEAM-02 | Carried to L2 |  | later |',
  ].join('\n');
  const problems = rowProblems(tableRows(table), REQ_COLUMNS, REQ_DISPOSITION, REQ_REASON);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.ok(problems[0]?.includes('"TEAM-02"') && problems[0].includes('empty cell'));
});

test('ids that collide with v0.7.0 ids carry the TM- prefix and every other id keeps its own', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Requirements'));
  for (const row of rows) {
    const id = row[0] ?? '';
    const expected = PREFIXED.has(id) ? `TM-${id}` : id;
    assert.equal(row[2], expected, `${id} must be called ${expected} from now on`);
  }
});

test('the same-id column names the near collisions: v0.4.0 for SEC-01..03 and UX-01, BUDG for BUDGET, v0.7.0 for TEAM and SETUP', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Requirements'));
  const same = (id: string): string => rows.find((row) => row[0] === id)?.[4] ?? '';
  for (const id of ['SEC-01', 'SEC-02', 'SEC-03', 'UX-01']) assert.ok(same(id).includes('v0.4.0'), `${id} names the v0.4.0 archive`);
  for (const id of ['BUDGET-01', 'BUDGET-02', 'BUDGET-03', 'BUDGET-04', 'BUDGET-05']) assert.ok(same(id).includes('BUDG'), `${id} names BUDG`);
  for (const id of ['TEAM-01', 'TEAM-02', 'TEAM-03', 'TEAM-04']) assert.ok(same(id).includes('v0.7.0') && same(id).includes('TEAM-'), `${id} names the v0.7.0 TEAM ids`);
  assert.ok(same('SETUP-01').includes('v0.7.0') && same('SETUP-01').includes('SETUP-'), 'SETUP-01 names the v0.7.0 SETUP ids');
});

test('exactly TM-TEAM-01, TM-TEAM-04, SEC-01 and SEC-04 are landed in Phase 69, each naming a Phase 69 test that exists', async () => {
  const record = await readRepoFile(RECORD);
  const rows = tableRows(section(record, 'Requirements'));
  const landed = rows.filter((row) => (row[REQ_DISPOSITION] ?? '').startsWith('Landed in Phase 69'));
  assert.deepEqual(landed.map((row) => row[2]), Object.keys(LANDED_WITH_TESTS));
  for (const row of landed) {
    const cell = `${row[REQ_DISPOSITION]} ${row[REQ_REASON]}`;
    const named = [...cell.matchAll(/\b(team[A-Z][A-Za-z]*)\.test\.ts\b/g)].map((match) => match[1] as string);
    assert.ok(named.length >= 1, `${row[2]} names no Phase 69 test file`);
    for (const test of LANDED_WITH_TESTS[row[2] ?? ''] ?? []) assert.ok(named.includes(test), `${row[2]} must name ${test}.test.ts`);
    for (const file of named) await access(path.join(REPO_ROOT, 'src', 'test', `${file}.test.ts`));
  }
});

test('the archive section says 33 is wrong, lists the archive paths L2 needs and the sync-branch rule for Phase 65', async () => {
  const record = await readRepoFile(RECORD);
  const lists = section(record, 'Requirements');
  assert.ok(/33/.test(lists) && /34/.test(lists), 'the record says the archive header counts 33 but lists 34');
  const archive = section(record, 'What L2 finds on the archive');
  for (const needed of [
    '4207080',
    '.planning/phases/60-team-core-identity-signed-event-log-git-transport-roster',
    '.planning/phases/61-invitations-joining-removal-near-org-and-key-integration',
    '.planning/phases/62-work-model-gsd-import-team-board-live-read-and-move',
    '.planning/research/v0.6.0-team-mode-addendum.md',
  ]) assert.ok(archive.includes(needed), `the archive section must list ${needed}`);
  assert.ok(archive.includes('collidesWithSyncRef') && archive.includes('Phase 65'), 'Phase 65 integration branch must refuse the sync branch');
});

test('the notes state D-28 and the shared code-server limit, with SHRD-02 and SHRD-03', async () => {
  const notes = section(await readRepoFile(RECORD), 'Consequences and notes');
  assert.ok(/one (device )?fingerprint per person/i.test(notes), 'one fingerprint per person in every team joined');
  assert.ok(/readable by anyone who can read the project's remote/.test(notes), 'who can read the signed log');
  assert.ok(/code-server/i.test(notes) && notes.includes('SHRD-02') && notes.includes('SHRD-03'), 'shared code-server and the follow-ups that own it');
});

test('the notes carry the local key rotation effect on one line, with the status-report and did:key hand-offs', async () => {
  const notes = section(await readRepoFile(RECORD), 'Consequences and notes');
  const rotation = notes.split(/\r?\n/).filter((line) => line.includes('device.rotated') && line.includes('read-only'));
  assert.ok(rotation.length >= 1, 'a single markdown line names device.rotated and read-only');
  assert.ok(rotation.some((line) => /revok/.test(line)), 'the line warns that revoking the previous key first leaves no signer');
  assert.ok(notes.includes('teamKeyStatus') && notes.includes('verifyAll'), 'rotated keys read from teamKeyStatus, not the verifyAll device report');
  assert.ok(notes.includes('did:key'), 'the device key becomes a did:key');
});
