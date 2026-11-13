// CheckOriginality: the deterministic check the research team's plagiarism checker runs on a draft against the pages fetched in the run.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ToolContext } from '../agent/tools';
import { checkOriginality, checkOriginalityTool } from '../agent/webTools';

const URL = 'https://a.example/barrier';
const PAGE = 'Riverside Flood Barrier\n\nThe Riverside flood barrier was completed in 2019 at a cost of 48 million pounds. Engineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass freely during normal conditions. Local residents campaigned for the project for more than a decade after the severe floods that struck the town in 2007.';
const NOTE = `[^1]: Environment Agency, "Riverside Flood Barrier," 2020, ${URL}.`;
const pages = () => new Map([[URL, PAGE]]);

test('a copied run of words left out of quotation marks is caught, with its source and whether a note is attached', () => {
  const draft = `# Report\n\nEngineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass.[^1]\n\nThe town has a new barrier. Engineers designed the barrier to withstand a one-in-two-hundred-year flood event.\n\n${NOTE}\n`;
  const output = checkOriginality(draft, pages(), { label: 'REPORT.md' });
  assert.match(output, /Copied runs not in quotation marks \(2\):/);
  assert.match(output, /1\. line 3: "Engineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass" — 16 words verbatim from https:\/\/a\.example\/barrier, not in quotation marks \(note \[\^1\] attached\)/);
  assert.match(output, /2\. line 5: "Engineers designed[^"]*" — \d+ words verbatim from https:\/\/a\.example\/barrier, not in quotation marks \(NO note attached\)/);
  assert.match(output, /Put it in quotation marks \(a block quotation if long\) with a note, or rewrite it in your own words and cite it/);
  assert.match(output, /Limitation: this compares the draft only with the 1 page fetched with WebFetch in this run[\s\S]*WebSearch distinctive sentences/);
});

test('a passage in quotation marks with a note to the page that says it is not plagiarism', () => {
  const draft = `# Report\n\nThe agency reported that the barrier “was completed in 2019 at a cost of 48 million pounds.”[^1]\n\n> Engineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass freely during normal conditions.[^1]\n\n${NOTE}\n`;
  const output = checkOriginality(draft, pages());
  assert.match(output, /No copied runs, misquotations, unattributed quotations, or close paraphrases found/);
  assert.doesNotMatch(output, /Copied runs|Close paraphrase \(|differ/);
});

test('the bibliography and the note definitions are not compared: their titles naturally match the sources', () => {
  const draft = `# Report\n\nThe town finished its barrier in 2019.[^1]\n\n${NOTE}\n\n## Bibliography\n\nThe Riverside flood barrier was completed in 2019 at a cost of 48 million pounds. Engineers designed the barrier to withstand.\n`;
  assert.match(checkOriginality(draft, pages()), /No copied runs/);
});

test('a quotation that differs from the page its note cites is a misquote, and one with no note is reported', () => {
  const draft = `# Report\n\nThe agency said the barrier "was finished in 2019 at a cost of 50 million pounds."[^1]\n\nCritics said it was "far too expensive for a town of this size" at the time.\n\n${NOTE}\n`;
  const output = checkOriginality(draft, pages());
  assert.match(output, /Quotations that differ from the source their note cites \(1\):\n1\. line 3: "was finished in 2019 at a cost of 50 million pounds" \(\[\^1\]\) differs from https:\/\/a\.example\/barrier, which says: "[^"]*was completed in 2019 at a cost of 48 million[^"]*" \(\d+% of words\)\. Quote the source exactly/);
  assert.match(output, /Quotations with no note \(1\):\n1\. line 5: "far too expensive for a town of this size"/);
});

test('a sentence that keeps most of a source sentence with a few words swapped is close paraphrase, even with a note', () => {
  const draft = `# Report\n\nLocal people campaigned for the scheme for more than a decade after the serious floods that hit the town in 2007.[^1]\n\n${NOTE}\n`;
  const output = checkOriginality(draft, pages());
  assert.match(output, /Close paraphrase \(1\):\n1\. line 3: "Local people campaigned[^"]*" — (8\d|9\d|100)% of its words are together on https:\/\/a\.example\/barrier: "local residents campaigned[^"]*"\. Close paraphrase — quote it or rewrite it, and cite it \(note \[\^1\] attached\)/);
  assert.doesNotMatch(output, /Copied runs/);
  // A genuine rewording in the writer's own words is not flagged.
  const own = `# Report\n\nResidents pressed for flood defences for over ten years, after the town flooded badly in 2007.[^1]\n\n${NOTE}\n`;
  assert.match(checkOriginality(own, pages()), /No copied runs/);
});

test('it says plainly what it cannot see: no fetched pages, and a quotation whose cited page was not fetched', () => {
  const draft = `# Report\n\nThe barrier "was completed in 2019 at a cost of 48 million pounds."[^2]\n\n[^2]: Trade Weekly, "Barrier Opens," 2019, https://b.example/news.\n`;
  const none = checkOriginality(draft, new Map());
  assert.match(none, /^Nothing was compared: no pages were fetched with WebFetch in this run\./);
  assert.match(none, /Limitation: .*only with the 0 pages fetched/);
  const output = checkOriginality(draft, pages());
  assert.match(output, /Quotations not checked \(1\):\n1\. line 3: "was completed in 2019 at a cost of 48 million pounds" \(\[\^2\]\): its note cites https:\/\/b\.example\/news, which was not fetched in this run; fetch it and check again\. Its words are on https:\/\/a\.example\/barrier, which the note does not cite/);
});

test('the work is bounded: a large draft and many large pages finish quickly, and what was not compared is named', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const vocabulary = Array.from({ length: 4000 }, (_, index) => `w${index.toString(36)}`);
  const prose = (chars: number) => { const parts: string[] = []; let length = 0; while (length < chars) { const sentence = `${Array.from({ length: 12 }, () => vocabulary[Math.floor(random() * vocabulary.length)]).join(' ')}. `; parts.push(sentence); length += sentence.length; } return parts.join(''); };
  const fetched = new Map<string, string>();
  for (let index = 0; index < 20; index += 1) fetched.set(`https://p${index}.example/`, prose(400_000));
  const started = Date.now();
  const output = checkOriginality(prose(260_000), fetched);
  const seconds = (Date.now() - started) / 1000;
  assert.ok(seconds < 20, `took ${seconds}s`);
  assert.match(output, /only its first 200,000 characters/);
  assert.match(output, /Not compared \(over the 4,000,000-character budget\): https:\/\/p\d+\.example\//);
  // Every list is capped, so the report stays readable whatever the draft holds.
  for (const line of output.split('\n').filter((entry) => /^\d+\. /.test(entry))) assert.ok(Number(/^(\d+)\./.exec(line)![1]) <= 40);
});

test('the tool reads a Markdown draft from the workspace or takes text, never both, and clamps the run length', async () => {
  assert.throws(() => checkOriginalityTool.parse({}), /either path/);
  assert.throws(() => checkOriginalityTool.parse({ path: 'a.md', text: 'x' }), /either path/);
  assert.equal(checkOriginalityTool.parse({ text: 'x', min_words: 2 }).minWords, 5);
  assert.equal(checkOriginalityTool.parse({ text: 'x' }).minWords, 8);
  assert.equal(checkOriginalityTool.capability, 'read');
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-originality-'));
  await writeFile(path.join(root, 'REPORT.md'), `# Report\n\nEngineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass.\n`);
  const context = { root, pages: pages() } as unknown as ToolContext;
  const input = checkOriginalityTool.parse({ path: 'REPORT.md' });
  assert.equal(checkOriginalityTool.title(input, context), 'Check originality of REPORT.md');
  const output = await checkOriginalityTool.run(input, context);
  assert.match(output, /Originality check of REPORT\.md/);
  assert.match(output, /verbatim from https:\/\/a\.example\/barrier[^\n]*NO note attached/);
  await assert.rejects(checkOriginalityTool.run(checkOriginalityTool.parse({ path: '../outside.md' }), context));
});
