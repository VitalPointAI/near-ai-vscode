import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { test } from 'node:test'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { checkCpcscLevel1, CPCSC_LEVEL_1_IDS } from '../src/import/cpcsc-level-1.ts';
const root = path.dirname(fileURLToPath(import.meta.url)); const json = (name: string): any => JSON.parse(readFileSync(path.join(root, '..', name), 'utf8'));
const cpcscPage = readFileSync(path.join(root, 'fixtures/import/cpcsc/level-1.html'), 'utf8');
test('CPCSC profile has exactly the researched thirteen ITSP.10.171 selections', () => assert.equal(CPCSC_LEVEL_1_IDS.length, 13));
test('CPCSC page ids equal the declared profile ids', () => assert.deepEqual(checkCpcscLevel1(cpcscPage).difference, []));
test('CPCSC differences are reported when a source id changes', () => assert.deepEqual(checkCpcscLevel1(cpcscPage.replace('03.14.02', '03.14.03')).difference, ['03.14.02', '03.14.03']));
test('CPCSC profile is ids and link only, with no prose', () => { const profile = json('profiles/cpcsc-level-1.json'); assert.equal(JSON.stringify(profile).includes('prose'), false); assert.match(profile.profile['back-matter'].resources[0].rlinks[0].href, /^https:/); });
test('unclassified selectors equal the baseline mapping target ids', () => { const targets = json('mappings/baseline-to-itsp10033.json').targets.sort(); const selected = json('profiles/unclassified.json').profile.imports[0]['include-controls'].map((item: any) => item['with-ids'][0]).sort(); assert.deepEqual(selected, targets); });
