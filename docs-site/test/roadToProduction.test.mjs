// The road to production page (scripts/build-road-to-production.mjs) is generated from the gap register. These tests keep the committed
// page in step with it, refuse a register entry without its level or production flag, and keep phase summaries citing their open conditions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE, checkRoadToProduction, loadRegister, main, renderRoadToProduction } from '../../scripts/build-road-to-production.mjs';
import { lintPage } from '../../compliance/src/wordLint.ts';

const root = new URL('../..', import.meta.url).pathname;
const quiet = (fn) => {
  const out = process.stdout.write; const err = process.stderr.write;
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return fn(); } finally { process.stdout.write = out; process.stderr.write = err; }
};

test('the road to production page is what the register renders, and every phase summary cites its open conditions', () => {
  assert.deepEqual(checkRoadToProduction(root), []);
});

test('the page lists every register entry once and makes no compliance claim', () => {
  const page = readFileSync(join(root, PAGE), 'utf8');
  assert.deepEqual(lintPage(page, PAGE), []);
  for (const gap of loadRegister(root).gaps) assert.equal(page.split(`- **${gap.id}. `).length - 1, 1, gap.id);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'road-to-production-'));
  const write = (file, value) => { mkdirSync(join(dir, file, '..'), { recursive: true }); writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value)); };
  mkdirSync(join(dir, 'compliance/schemas'), { recursive: true });
  copyFileSync(join(root, 'compliance/schemas/gaps.schema.json'), join(dir, 'compliance/schemas/gaps.schema.json'));
  mkdirSync(join(dir, 'docs-site/content/security'), { recursive: true });
  const gap = { id: 'G1', title: 'A gap', controls: ['sc-13'], remediation: 'Fix it.', ownerRole: 'maintainers', closesInPhase: '46', appliesAt: 'protected-b', blocksProduction: true };
  const poamGap = { id: 'G2', title: 'Another gap', controls: ['ac-02'], remediation: 'Accept it.', ownerRole: 'owner', poam: 'g02', appliesAt: 'coalition-exchange', blocksProduction: false };
  write('compliance/gaps.json', { gaps: [gap, poamGap] });
  write('compliance/poam/g02.json', { id: 'g02', gap: 'G2', title: 'Another gap', controls: ['ac-02'], remediation: 'Accept it.', ownerRole: 'owner', milestones: [{ targetDate: '2027-03-31', title: 'Accepted' }] });
  return { dir, write, gap, poamGap };
}

test('the page groups by level then by production, and the check finds a stale page', () => {
  const { dir, write, gap, poamGap } = fixture();
  assert.equal(quiet(() => main([], dir)), 0);
  assert.deepEqual(checkRoadToProduction(dir), []);
  const page = readFileSync(join(dir, PAGE), 'utf8');
  assert.ok(page.indexOf('## From Protected B') < page.indexOf('### Blocks production {#protected-b-blocks}'));
  assert.ok(page.indexOf('### Blocks production {#protected-b-blocks}') < page.indexOf('- **G1. A gap.**'));
  assert.ok(page.indexOf('### Does not block production {#coalition-exchange-does-not-block}') < page.indexOf('- **G2. Another gap.**'));
  assert.match(page, /Tracked as POA&M item g02; first milestone: Accepted \(by 2027-03-31\)\./);
  write('compliance/gaps.json', { gaps: [{ ...gap, remediation: 'Fix it another way.' }, poamGap] });
  assert.match(checkRoadToProduction(dir).join('\n'), /road-to-production\.md differs from compliance\/gaps\.json/);
});

test('an entry without its level or production flag, or with an unknown level, is refused', () => {
  const { dir, write, gap, poamGap } = fixture();
  const { appliesAt, ...noLevel } = gap;
  const { blocksProduction, ...noFlag } = poamGap;
  write('compliance/gaps.json', { gaps: [noLevel, noFlag, { ...gap, id: 'G3', appliesAt: 'restricted' }, { ...gap, id: 'G4', blocksProduction: 'yes' }] });
  const said = checkRoadToProduction(dir).join('\n');
  assert.match(said, /G1: appliesAt is missing/);
  assert.match(said, /G2: blocksProduction is missing/);
  assert.match(said, /G3: appliesAt is missing or not one of now, protected-a/);
  assert.match(said, /G4: blocksProduction is missing or not true or false/);
  assert.throws(() => renderRoadToProduction(dir), /appliesAt is missing/);
});

test('a phase summary must cite an existing gap for each open condition', () => {
  const { dir, write } = fixture();
  quiet(() => main([], dir));
  const summary = (completed, section) => `---\nphase: 99\ncompleted: ${completed}\n---\n\n# Summary\n${section}\n## Self-Check: PASSED\n`;
  const problemsFor = (text) => { write('.planning/phases/99-x/99-01-SUMMARY.md', text); return checkRoadToProduction(dir).join('\n'); };
  assert.equal(problemsFor(summary('2026-11-30', '\n## Open conditions\n\nNone.\n')), '');
  assert.equal(problemsFor(summary('2026-11-30', '\n## Open conditions\n\n- G1: the module is not validated\n- Both G1 and G2 wait on the owner\n')), '');
  assert.match(problemsFor(summary('2026-11-30', '\n## Open conditions\n\n- The registry cannot restart under Deny\n')), /names no gap id/);
  assert.match(problemsFor(summary('2026-11-30', '\n## Open conditions\n\n- G9: not filed\n')), /gap G9 is not in compliance\/gaps\.json/);
  assert.match(problemsFor(summary('2026-11-30', '\n## Open conditions\n\n')), /section is empty/);
  assert.match(problemsFor(summary('2026-11-30', '')), /no "## Open conditions" section/);
  assert.equal(problemsFor(summary('2026-11-20', '')), '');
});
