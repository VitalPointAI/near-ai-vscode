import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintPage } from '../../compliance/src/wordLint.ts';

const pages = join(new URL('..', import.meta.url).pathname, 'content/accreditation');
const expected = ['index.mdx', 'unclassified.mdx', 'protected-a.mdx', 'protected-b.mdx', 'classified.mdx', 'controlled-goods-canada.mdx', 'itar.mdx'];
test('has each level and overlay page', () => expected.forEach((name) => assert.ok(readdirSync(pages).includes(name), name)));
test('each accreditation page has a sidebar position', () => readdirSync(pages).filter((name) => name.endsWith('.mdx')).forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /sidebar_position:/, name)));
test('level pages open with the organization decision', () => ['unclassified.mdx', 'protected-a.mdx', 'protected-b.mdx', 'classified.mdx'].forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /Your organization decides/, name)));
test('overlay pages open with their legal obligation', () => { assert.match(readFileSync(join(pages, 'controlled-goods-canada.mdx'), 'utf8'), /Meeting the Controlled Goods Program/); assert.match(readFileSync(join(pages, 'itar.mdx'), 'utf8'), /Meeting the ITAR/); });
test('unclassified calls this good practice rather than accreditation', () => assert.match(readFileSync(join(pages, 'unclassified.mdx'), 'utf8'), /good practice, not accreditation/));
test('classified says the appliance makes no claim', () => assert.match(readFileSync(join(pages, 'classified.mdx'), 'utf8'), /makes no claim/));
test('pages have no prohibited claim wording', () => readdirSync(pages).filter((name) => name.endsWith('.mdx')).forEach((name) => assert.deepEqual(lintPage(readFileSync(join(pages, name), 'utf8'), name), [], name)));
test('level pages use the shared data reader', () => expected.slice(0, 7).forEach((name) => assert.match(readFileSync(join(pages, name), 'utf8'), /AccreditationData/, name)));
