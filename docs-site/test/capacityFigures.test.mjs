// Capacity figures come only from load runs (Phase 48 D-09, D-10): the published and operator docs may state one only inside the block generated
// from the committed run files in loadtest/runs/, and that block must be exactly what those files render.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCapacityBlock, findCapacityFigures, renderCapacity, renderCapacityPage } from '../../loadtest/src/capacity.ts';
import { loadRunFiles } from '../../loadtest/src/runfile.ts';
import { makeRun, notReached, stage } from '../../loadtest/test/fixtures/run.ts';
import { hashRun } from '../../loadtest/src/runfile.ts';

const root = new URL('../..', import.meta.url).pathname;
const runs = () => loadRunFiles(join(root, 'loadtest/runs'));
const sealed = (run) => ({ ...run, hash: hashRun(run) });

/** The published and operator docs, as git tracks them (drafts and generated copies are not published). */
function publishedDocs() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'docs', 'docs-site/content', 'hub/README.md', 'relay/README.md', 'workbench/README.md', 'deploy'], { cwd: root, encoding: 'utf8' });
  return listed.split('\0').filter(Boolean).filter((file) => (file.startsWith('deploy/') ? file.endsWith('.md') : /\.mdx?$/.test(file)));
}

test('every committed run file verifies', () => runs().forEach((run) => assert.match(run.hash, /^sha256:/)));
test('the capacity page block is what the committed load runs render', () => assert.deepEqual(checkCapacityBlock(readFileSync(join(root, 'docs/hosting/capacity.md'), 'utf8'), runs()), []));
test('the capacity page is what the committed load runs render, byte for byte', () => assert.equal(readFileSync(join(root, 'docs/hosting/capacity.md'), 'utf8'), renderCapacityPage(runs())));
test('the published docs include the capacity page', () => assert.ok(publishedDocs().includes('docs/hosting/capacity.md')));
test('no published or operator doc states a capacity figure outside the generated block', () => {
  const found = publishedDocs().flatMap((file) => findCapacityFigures(readFileSync(join(root, file), 'utf8')).map((hit) => `${file}:${hit.line}: ${hit.text}`));
  assert.deepEqual(found, []);
});
test('any generated block outside the capacity page is also what the run files render', () => publishedDocs().forEach((file) => {
  const text = readFileSync(join(root, file), 'utf8');
  if (text.includes('capacity:begin')) assert.deepEqual(checkCapacityBlock(text, runs()), [], file);
}));

test('a hand-typed session count is flagged', () => assert.equal(findCapacityFigures('The site supports 1,000 concurrent sessions.').length, 1));
test('a hand-typed memory figure per person is flagged', () => assert.equal(findCapacityFigures('Plan for about 2 GiB per person.').length, 1));
test('a hand-typed CPU figure per user is flagged', () => assert.equal(findCapacityFigures('Each workbench needs 0.5 vCPU per user.').length, 1));
test('a figure split over two lines of one sentence is flagged on the line it starts', () => assert.deepEqual(findCapacityFigures('Intro.\n\nA session needs\nabout 2 GiB of memory.').map((hit) => hit.line), [3]));
test('a memory figure in a sentence about neither a session nor a person is not a capacity claim', () => assert.deepEqual(findCapacityFigures('The release image is 2 GiB.'), []));
// The three sentences the first strict pattern caught in the real tree, kept as the reasons it was narrowed (not an allowlist of figures).
test('a version before "sessions" and a rate limit naming a session are not capacity claims', () => {
  assert.deepEqual(findCapacityFigures('| Sync hub | TLS 1.3 sessions bound to the connection |'), []);
  assert.deepEqual(findCapacityFigures("the hub's per-address limits (120 session openings, 10 join requests a minute)"), []);
  assert.deepEqual(findCapacityFigures('At most 4 MiB per append, 8 MiB per attachment, and per address 120 session openings a minute.'), []);
});
test('figures inside the generated block are not flagged by the scan', () => assert.deepEqual(findCapacityFigures(renderCapacityPage([sealed(makeRun())])), []));
test('a block naming a dry-run fails', () => {
  const dry = sealed(makeRun({ kind: 'dry-run', id: '20261123T110000Z-rig1' }));
  const forged = `<!-- capacity:begin runs=${dry.id} -->\n1,000 sessions\n<!-- capacity:end -->\n`;
  assert.ok(checkCapacityBlock(forged, [dry]).some((problem) => /dry-run/.test(problem)));
  assert.doesNotMatch(renderCapacity([dry]), /20261123T110000Z/);
});
test('a stage not reached renders "not reached", and a block printing a number for it fails', () => {
  const run = sealed(makeRun({ stages: [stage(50), notReached(250, 'starts failed: 30 of 200')] }));
  const page = renderCapacityPage([run]);
  assert.match(page, /\| 250 \| not reached: starts failed: 30 of 200 \|/);
  const forged = page.replace('| 250 | not reached: starts failed: 30 of 200 |', '| 250 | reached |');
  assert.notEqual(forged, page);
  assert.ok(checkCapacityBlock(forged, [run]).length > 0);
});
test('a page with no generated block, or with two, fails', () => {
  assert.ok(checkCapacityBlock('# Capacity\n', []).length > 0);
  const block = renderCapacity([]);
  assert.ok(checkCapacityBlock(`${block}\n${block}`, []).length > 0);
});
