// The product's one copy lint (FND-07, Phase 41 D-41 and D-64; GLOSSARY section 5). It reads every user copy source from the repository root and counts
// the hits of each rule per file. src/test/copy-lint-baseline.json holds today's counts, so the lint passes on the day it lands and fails on any new or
// increased count; each copy fix deletes or lowers baseline counts, and the closing plan of a phase sets NEAR_AI_BASELINE_TIGHT=1 so no stale count stays.
//
// Re-recording the baseline is one step: run this file once with NEAR_AI_WRITE_BASELINE=1 (it writes the baseline from the current scan and then fails on
// purpose, so it can never pass silently), review the diff of src/test/copy-lint-baseline.json, and run it again without the flag. A new hit is fixed in the
// copy with the glossary's user word, never by raising the baseline; re-record only to move a count with code that moved, or to drop counts a fix removed.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BASELINE_PATH, CopyCounts, baselineText, compareWithBaseline, countHits, extractPackage, increaseMessage, readBaseline, scanRepository, writeBaselineAndFail
} from './helpers/copyLintScan';

const EM_DASH = String.fromCharCode(0x2014);

test('D-41: a planted em-dash in a command title and a setting description is counted under package.json', () => {
  const manifest = {
    contributes: {
      commands: [{ command: 'nearAi.example', title: `Open the example ${EM_DASH} quickly`, category: 'NEAR AI' }],
      configuration: { title: 'NEAR AI', properties: { 'nearAi.example': { type: 'boolean', description: `Turns the example on ${EM_DASH} or off.` } } }
    }
  };
  const texts = extractPackage(manifest);
  assert.deepEqual(countHits(texts, 'package.json'), { 'package.json': { 'em-dash': 2 } });
  // Without the planted dashes nothing is counted.
  const clean = JSON.parse(JSON.stringify(manifest).split(EM_DASH).join(',')) as unknown;
  assert.deepEqual(countHits(extractPackage(clean), 'package.json'), {});
});

test('D-41: the package source reads command, setting, view and view container text', () => {
  const manifest = {
    contributes: {
      commands: [{ command: 'a', title: 'T1', category: 'C1' }],
      configuration: [{ title: 'S0', properties: { a: { description: 'D1', markdownDescription: 'M1', enumDescriptions: ['E1', 'E2'], deprecationMessage: 'X1' } } }],
      views: { container: [{ id: 'v', name: 'V1' }] },
      viewsContainers: { activitybar: [{ id: 'c', title: 'VC1' }] }
    }
  };
  const texts = extractPackage(manifest).map((entry) => entry.text).sort();
  for (const expected of ['T1', 'C1', 'D1', 'M1', 'E1', 'E2', 'X1', 'V1', 'VC1']) assert.ok(texts.includes(expected), expected);
});

test('D-41: the ratchet fails on a new or increased count and passes on an equal or lower one', () => {
  const baseline: CopyCounts = { 'a.ts': { 'em-dash': 2 }, 'b.ts': { 'em-dash': 1 } };
  assert.deepEqual(compareWithBaseline({ 'a.ts': { 'em-dash': 2 }, 'b.ts': { 'em-dash': 1 } }, baseline), { increased: [], stale: [] });
  const lower = compareWithBaseline({ 'a.ts': { 'em-dash': 1 } }, baseline);
  assert.deepEqual(lower.increased, []);
  assert.deepEqual(lower.stale, ['a.ts  em-dash  2 -> 1', 'b.ts  em-dash  1 -> 0']);
  const higher = compareWithBaseline({ 'a.ts': { 'em-dash': 3 }, 'b.ts': { 'em-dash': 1 }, 'c.ts': { 'em-dash': 1 } }, baseline);
  assert.deepEqual(higher.increased, ['a.ts  em-dash  2 -> 3', 'c.ts  em-dash  0 -> 1']);
  assert.deepEqual(higher.stale, []);
  const message = increaseMessage(higher.increased);
  assert.match(message, /em-dash/);
  assert.match(message, /c\.ts/);
  assert.match(message, /a colon, a comma or two sentences/);
  assert.match(message, /total must not grow/);
});

test('D-41: the baseline text is sorted, two-space indented, ends in a newline and leaves zero counts out', () => {
  const text = baselineText({ 'z.ts': { 'em-dash': 1 }, 'a.ts': { 'em-dash': 0 }, 'm.ts': { 'em-dash': 3 } });
  assert.equal(text, '{\n  "m.ts": {\n    "em-dash": 3\n  },\n  "z.ts": {\n    "em-dash": 1\n  }\n}\n');
});

test('D-41: the write mode writes the baseline and then fails on purpose', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'near-ai-copy-lint-')), 'baseline.json');
  const counts: CopyCounts = { 'b.ts': { 'em-dash': 1 }, 'a.ts': { 'em-dash': 2 } };
  assert.throws(() => writeBaselineAndFail(file, counts), /baseline written; review the diff and run again without NEAR_AI_WRITE_BASELINE/);
  assert.equal(readFileSync(file, 'utf8'), baselineText(counts));
});

test('D-41: the repository passes against its baseline', () => {
  const counts = scanRepository();
  if (process.env.NEAR_AI_WRITE_BASELINE === '1') writeBaselineAndFail(BASELINE_PATH, counts);
  const { increased } = compareWithBaseline(counts, readBaseline());
  assert.deepEqual(increased, [], increaseMessage(increased));
});
