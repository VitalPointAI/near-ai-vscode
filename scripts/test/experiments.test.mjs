// The two experiment scripts: the spend report that says what a run cost, and the blind A/B that says whether a cheaper setup is still as good. Every
// claim the owner will read comes from one of these, so the parts that decide the numbers are tested here.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blindPairs, judgePrompt, parseJudgement, score } from '../ab-task.mjs';
import { readRequests, summarise } from '../spend-report.mjs';

function ledger(rows) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'spend-')), '2026-11.jsonl');
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n'));
  return file;
}

test('the spend report pairs each request\'s opening and closing lines, and sums cost and time per kind', () => {
  const file = ledger([
    { t: 'e', id: 'r1', v: 1, at: Date.now() - 60_000, model: 'big', kind: 'main', run: 'run-1', est: 500_000_000 },
    { t: 'e', id: 'r1', v: 2, end: Date.now() - 30_000, st: 'completed', in: 1000, cin: 900, out: 100 },
    { t: 'e', id: 'r2', v: 1, at: Date.now() - 20_000, model: 'fast', kind: 'sub-agent', run: 'run-1', est: 250_000_000 },
    { t: 'e', id: 'r2', v: 2, end: Date.now() - 10_000, st: 'completed', in: 2000, cin: 0, out: 400 }
  ]);
  const { requests } = readRequests([file]);
  assert.equal(requests.length, 2);
  const report = summarise(requests, { days: 1 });
  assert.equal(report.window.requests, 2);
  assert.equal(report.totals.cost, 0.75, 'the estimates are nano-dollars');
  assert.equal(report.totals.input, 3000);
  assert.equal(report.totals.cached, 900);
  assert.equal(report.totals.output, 500);
  // Two requests, each 30s and 10s apart.
  assert.equal(report.totals.meanSeconds, 20);
  const byKind = Object.fromEntries(report.byKind.map((row) => [row.name, row]));
  assert.equal(byKind.main.cost, 0.5);
  assert.equal(byKind['sub-agent'].cost, 0.25);
});

test('the spend report ignores an unfinished request and one older than the window, so a running turn does not skew the numbers', () => {
  const old = Date.now() - 40 * 86_400_000;
  const file = ledger([
    // Old, and finished: outside a 7-day window.
    { t: 'e', id: 'old', v: 1, at: old, end: undefined, model: 'big', kind: 'main', est: 900_000_000 },
    { t: 'e', id: 'old', v: 2, end: old + 1000, st: 'completed', in: 10, cin: 0, out: 10 },
    // Recent but still open: no closing line yet.
    { t: 'e', id: 'open', v: 1, at: Date.now() - 1000, model: 'big', kind: 'main', est: 900_000_000 }
  ]);
  const report = summarise(readRequests([file]).requests, { days: 7 });
  assert.equal(report.window.requests, 0);
  assert.equal(report.totals.cost, 0);
  assert.equal(report.totals.input, 0);
});

test('the A/B pairs the two setups in a shuffled order, so a judge that always likes the first answer does not decide the result', () => {
  for (const seed of [0, 1, 7, 42]) {
    const pairs = blindPairs({ a: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], b: ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'] }, seed);
    assert.equal(pairs.length, 6);
    for (const pair of pairs) {
      assert.notEqual(pair.first.side, pair.second.side, 'one answer from each setup');
      assert.equal(pair.first.text.length, 2);
    }
    const firstA = pairs.filter((pair) => pair.first.side === 'a').length;
    assert.ok(firstA > 0 && firstA < pairs.length, `seed ${seed}: the order is shuffled, not fixed (A first ${firstA}/6)`);
  }
});

test('a pair is judged blind: the prompt names no setup, and an unreadable reply is a tie, never a silent win', () => {
  const pair = blindPairs({ a: ['the A answer'], b: ['the B answer'] }, 3)[0];
  const prompt = judgePrompt('Name three risks.', pair);
  assert.match(prompt, /Name three risks\./);
  assert.doesNotMatch(prompt, /\bA answer\b.*\bB answer\b[\s\S]*setup A/, 'no setup name appears besides the answers themselves');
  assert.match(prompt, /Better: first \| second \| tie/);
  assert.deepEqual(parseJudgement(`Better: first\nWhy: it cites sources.`, pair), { winner: pair.first.side, why: 'it cites sources.' });
  assert.deepEqual(parseJudgement('Better: tie', pair), { winner: 'tie', why: '' });
  const unreadable = parseJudgement('The first one is probably better.', pair);
  assert.equal(unreadable.winner, 'tie');
  assert.match(unreadable.why, /could not be read/);
});

test('a setup that fails a run is counted as failed rather than as fast, and the score reads wins from either position', () => {
  const runs = [
    { ok: true, answer: 'x'.repeat(100), ms: 2_000 },
    { ok: true, answer: 'x'.repeat(300), ms: 4_000 },
    { ok: false, answer: '', ms: 10 }
  ];
  const judged = [{ winner: 'a' }, { winner: 'b' }, { winner: 'tie' }];
  assert.deepEqual(score('a', runs, judged), { runs: 3, failed: 1, meanMs: 3_000, fastestMs: 2_000, meanChars: 200, wins: 1, losses: 1, ties: 1 });
  assert.deepEqual(score('b', runs, judged), { runs: 3, failed: 1, meanMs: 3_000, fastestMs: 2_000, meanChars: 200, wins: 1, losses: 1, ties: 1 });
  // A setup whose every run failed has no timing at all, so it cannot look fast.
  assert.equal(score('a', [{ ok: false, answer: '', ms: 1 }], []).meanMs, undefined);
});
