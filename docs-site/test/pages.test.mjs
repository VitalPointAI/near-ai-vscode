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
test('the matrix component uses the safe CSV helper', () => assert.match(readFileSync(new URL('../src/components/accreditation/ResponsibilityMatrix.jsx', import.meta.url), 'utf8'), /toCsv/));
test('the package page explains release verification', () => assert.match(readFileSync(new URL('../src/components/accreditation/PackageInfo.jsx', import.meta.url), 'utf8'), /gh attestation verify/));
test('the README describes the local refresh', () => assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /compliance:refresh/));

test('every level page asks for a level that exists, so no page silently shows no rows', () => {
  const levels = new Set(JSON.parse(readFileSync(new URL('../../compliance/levels.json', import.meta.url), 'utf8')).levels.map(({ id }) => id));
  for (const name of expected) {
    for (const [, id] of readFileSync(join(pages, name), 'utf8').matchAll(/levelId="([^"]+)"/g)) assert.ok(levels.has(id), `${name} asks for level ${id}, which compliance/levels.json does not define`);
  }
});
