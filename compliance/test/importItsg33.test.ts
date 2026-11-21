import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { test } from 'node:test'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { crosswalk, parseAnnex3a, parseProfile3 } from '../src/import/itsg-33.ts';
const root = path.dirname(fileURLToPath(import.meta.url)); const read = (name:string) => readFileSync(path.join(root, 'fixtures/import/itsg33', name), 'utf8');
test('Annex 3A stores ids and titles only', () => { const controls = parseAnnex3a(read('annex-3a.html')); assert.equal(controls[1].id, 'ac-02.01'); assert.equal('prose' in controls[0], false); });
test('Profile 3 selects Annex 3A ids', () => assert.deepEqual(parseProfile3(read('annex-4a-profile-3.html')), ['ac-02','ac-02.01']));
test('same normalized ids and titles are same-id', () => assert.equal(crosswalk([{id:'ac-02',title:'Account Management'}],[{id:'ac-02',title:'Account Management'}])[0].relation, 'same-id'));
test('changed titles are text-changed', () => assert.equal(crosswalk([{id:'ac-02',title:'Old'}],[{id:'ac-02',title:'New'}])[0].relation, 'text-changed'));
test('missing ITSP ids are withdrawn and new ITSP ids added', () => assert.deepEqual(crosswalk([{id:'ac-02',title:'A'}],[{id:'au-02',title:'B'}]).map((row)=>row.relation).sort(), ['added','withdrawn']));
test('every generated crosswalk row is marked ours', () => assert.ok(crosswalk([{id:'ac-02',title:'A'}],[{id:'ac-02',title:'A'}]).every((row)=>row.ours)));
