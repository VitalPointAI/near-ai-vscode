import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintPage } from '../../compliance/src/wordLint.ts';

const pages = join(new URL('..', import.meta.url).pathname, 'content/accreditation');
const expected = ['index.mdx', 'unclassified.mdx', 'protected-a.mdx', 'protected-b.mdx', 'classified.mdx', 'controlled-goods-canada.mdx', 'itar.mdx', 'gaps.mdx', 'responsibility-matrix.mdx', 'evidence.mdx', 'package.mdx'];
test('has each level and overlay page', () => expected.forEach((name) => assert.ok(readdirSync(pages).includes(name), name)));
test('each accreditation page has a sidebar position', () => readdirSync(pages).filter((name) => name.endsWith('.mdx')).forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /sidebar_position:/, name)));
test('level pages open with the organization decision', () => ['unclassified.mdx', 'protected-a.mdx', 'protected-b.mdx', 'classified.mdx'].forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /Your organization decides/, name)));
test('overlay pages open with their legal obligation', () => { assert.match(readFileSync(join(pages, 'controlled-goods-canada.mdx'), 'utf8'), /Meeting the Controlled Goods Program/); assert.match(readFileSync(join(pages, 'itar.mdx'), 'utf8'), /Meeting the ITAR/); });
test('unclassified calls this good practice rather than accreditation', () => assert.match(readFileSync(join(pages, 'unclassified.mdx'), 'utf8'), /good practice, not accreditation/));
test('classified says the appliance makes no claim', () => assert.match(readFileSync(join(pages, 'classified.mdx'), 'utf8'), /makes no claim/));
test('pages have no prohibited claim wording', () => readdirSync(pages).filter((name) => name.endsWith('.mdx')).forEach((name) => assert.deepEqual(lintPage(readFileSync(join(pages, name), 'utf8'), name), [], name)));
test('level pages use the shared data reader', () => expected.slice(0, 7).forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /AccreditationData/, name)));
test('supporting pages open with the organization decision', () => expected.slice(7).forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /Your organization decides/, name)));
// Phase 48 (D-18, VER-07): the hosted pages read the hosted levels from the same data and page component as the other level pages.
const hosted = [['hosted-protected-a.mdx', 'hosted-protected-a'], ['hosted-protected-b.mdx', 'hosted-protected-b']];
const firstParagraph = (source) => source.replace(/^---\n[\s\S]*?\n---\n/, '').split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith('import '));
test('hosted level pages open with the organization decision and use the shared level page', () => hosted.forEach(([name, levelId]) => {
  assert.ok(readdirSync(pages).includes(name), name);
  const source = readFileSync(join(pages, name), 'utf8');
  assert.match(firstParagraph(source), /^Your organization decides/, name);
  assert.match(source, /<AccreditationData>/, name);
  assert.match(source, /<LevelPage /, name);
  assert.equal(source.split(`levelId="${levelId}"`).length - 1, 1, name);
}));
test('the matrix component uses the safe CSV helper', () => assert.match(readFileSync(new URL('../src/components/accreditation/ResponsibilityMatrix.jsx', import.meta.url), 'utf8'), /toCsv/));
test('the package page explains release verification', () => assert.match(readFileSync(new URL('../src/components/accreditation/PackageInfo.jsx', import.meta.url), 'utf8'), /gh attestation verify/));
test('the README describes the local refresh', () => assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /compliance:refresh/));

test('every level page asks for a level that exists, so no page silently shows no rows', () => {
  const levels = new Set(JSON.parse(readFileSync(new URL('../../compliance/levels.json', import.meta.url), 'utf8')).levels.map(({ id }) => id));
  for (const name of expected) {
    for (const [, id] of readFileSync(join(pages, name), 'utf8').matchAll(/levelId="([^"]+)"/g)) assert.ok(levels.has(id), `${name} asks for level ${id}, which compliance/levels.json does not define`);
  }
});
test('the drawer names each component with its own state, applicability and reason, never the row\'s reason in its place (44.1-08, D-20)', () => {
  const source = readFileSync(new URL('../src/components/accreditation/ControlDrawer.jsx', import.meta.url), 'utf8');
  const section = /row\.components\?\.map\(\(component\) => <section[\s\S]*?<\/section>\)/.exec(source)?.[0];
  assert.ok(section, 'the drawer has one section per component');
  assert.match(section, /\{component\.component\}/, 'the component id');
  assert.match(section, /<StateBadge state=\{component\.state\} \/>/, 'the component state word');
  assert.match(section, /component\.applicability/, 'the applicability when present');
  assert.match(section, /component\.statement \?\? component\.reasonText/, 'its own statement or reason');
  assert.doesNotMatch(section, /row\.reasonText/, 'never the row reason in place of a component reason');
});
