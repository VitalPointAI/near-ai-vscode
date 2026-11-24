import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { test } from 'node:test'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { crosswalk, importSource, parseAnnex3a, parseProfile3, parseProfile3Pdf } from '../src/import/itsg-33.ts'; import { validateOscal } from '../src/validate.ts';
import { buildItsg33AssessorCatalogue } from '../src/import/itsg-33-assessor.ts';
const root = path.dirname(fileURLToPath(import.meta.url)); const read = (name:string) => readFileSync(path.join(root, 'fixtures/import/itsg33', name), 'utf8');
test('Annex 3A stores ids and titles only', () => { const controls = parseAnnex3a(read('annex-3a.html')); assert.equal(controls[1].id, 'ac-02.01'); assert.equal('prose' in controls[0], false); });
test('the Annex 3A index omits ID separators and preserves punctuation within titles', () => {
  const html = '<main><ul><li>SC-101 – UNCLASSIFIED TELECOMMUNICATIONS SYSTEMS IN SECURE FACILITIES</li><li>AC-13 SUPERVISION AND REVIEW — ACCESS CONTROL</li></ul></main>';
  assert.deepEqual(parseAnnex3a(html), [
    { id: 'sc-101', title: 'UNCLASSIFIED TELECOMMUNICATIONS SYSTEMS IN SECURE FACILITIES' },
    { id: 'ac-13', title: 'SUPERVISION AND REVIEW — ACCESS CONTROL' },
  ]);
});
test('Profile 3 selects Annex 3A ids', () => assert.deepEqual(parseProfile3(read('annex-4a-profile-3.html')), ['ac-02','ac-02.01']));
test('the official PDF extraction recognises selected controls and rejects an empty selection', () => { assert.deepEqual(parseProfile3Pdf('AC       2                          P1            X\nAC   2   (1)                        P2         X\n'), ['ac-02', 'ac-02.01']); assert.throws(() => parseProfile3Pdf('Profile shell without Table 4'), /no selected control identifiers/); });
test('same normalized ids and titles are same-id', () => assert.equal(crosswalk([{id:'ac-02',title:'Account Management'}],[{id:'ac-02',title:'Account Management'}])[0].relation, 'same-id'));
test('changed titles are text-changed', () => assert.equal(crosswalk([{id:'ac-02',title:'Old'}],[{id:'ac-02',title:'New'}])[0].relation, 'text-changed'));
test('missing ITSP ids are withdrawn and new ITSP ids added', () => assert.deepEqual(crosswalk([{id:'ac-02',title:'A'}],[{id:'au-02',title:'B'}]).map((row)=>row.relation).sort(), ['added','withdrawn']));
test('every generated crosswalk row is marked ours', () => assert.ok(crosswalk([{id:'ac-02',title:'A'}],[{id:'ac-02',title:'A'}]).every((row)=>row.ours)));
test('persists a valid Profile 3 and Annex 3A-to-ITSP crosswalk', async () => { const result = await importSource({ offlinePages: { annex3: read('annex-3a.html'), profile3Pdf: 'AC       2                          P1            X\nAC   2   (1)                        P2         X\n' }, itspControls: [{ id: 'ac-02', title: 'Account Management' }, { id: 'ac-02.01', title: 'Different current title' }] }); const profile = result.reports.find((report) => report.file === 'profiles/itsg33-profile3.json')?.content; const mapping: any = result.reports.find((report) => report.file === 'mappings/itsg33-to-itsp10033.json')?.content; assert.ok(profile && mapping); assert.deepEqual(validateOscal(profile, 'profile', { ours: true }), { ok: true, errors: [] }); assert.deepEqual((profile as any).profile.imports[0]['include-controls'][0]['with-ids'], ['ac-02', 'ac-02.01']); assert.deepEqual(mapping.mappings.map((row: any) => row.relation).slice(0, 2), ['same-id', 'text-changed']); });

test('assessor extraction preserves official statement hierarchy and publication notices', () => {
  const html = Buffer.from(`<main>
    <h4>AC-1 Example control</h4>
    <p><strong>Control:</strong> The organization:</p>
    <ol style="list-style-type: upper-alpha">
      <li>Uses [<em>Assignment: defined item</em>].
        <ol style="list-style-type: lower-alpha"><li>First sub-item.</li></ol>
      </li>
      <li value="27">Ends the list.</li>
    </ol>
    <p><strong>Supplemental Guidance:</strong> Guidance outside the statement.</p>
    <p><strong>Control Enhancements:</strong> Enhancement outside the statement.</p>
    <p><strong>References:</strong> Reference outside the statement.</p>
    <h4>AC-13 Incorporated control</h4>
    <p>[Withdrawn: Incorporated into AC-2].</p>
    <h4>AT-5 Withdrawn control</h4>
    <p>[Withdrawn]</p>
    <h4>SA-13 Unallocated control</h4>
    <p>[Not allocated in GC profiles. Example official notice.]</p>
  </main>`);
  const base = ['ac-01', 'ac-13', 'at-05', 'sa-13'];
  const retrieved = '2026-11-22T00:00:00Z';
  const { catalog } = buildItsg33AssessorCatalogue(html, base, retrieved);
  assert.deepEqual(catalog.controls.map((control) => control.parts[0].prose), [
    'The organization:\nA. Uses [Assignment: defined item].\n  a. First sub-item.\nAA. Ends the list.',
    '[Withdrawn: Incorporated into AC-2].',
    '[Withdrawn]',
    '[Not allocated in GC profiles. Example official notice.]',
  ]);
  assert.deepEqual(catalog.controls.filter((control) => control.props?.some((prop) => prop.value === 'withdrawn')).map(({ id }) => id), ['ac-13', 'at-05']);
  assert.throws(() => buildItsg33AssessorCatalogue(html, base.slice(1), retrieved), /unexpected: ac-01/);
});

test('the pinned assessor catalogue contains exactly the compact base controls with OSCAL statement parts', () => {
  const catalogueDir = path.join(root, '../catalogs/itsg-33');
  const base = JSON.parse(readFileSync(path.join(catalogueDir, 'annex-3a.json'), 'utf8'));
  const assessor: ReturnType<typeof buildItsg33AssessorCatalogue> = JSON.parse(readFileSync(path.join(catalogueDir, 'assessor-annex-3a.json'), 'utf8'));
  assert.deepEqual(assessor.catalog.controls.map(({ id }) => id), base.catalog.controls.map(({ id }: { id: string }) => id));
  for (const control of base.catalog.controls) {
    assert.deepEqual(Object.keys(control).sort(), ['id', 'title'], `Public reference ${control.id}`);
  }
  assert.equal(assessor.catalog.controls.find(({ id }) => id === 'sc-13')?.title, 'USE OF CRYPTOGRAPHY');
  for (const { id, parts } of assessor.catalog.controls) {
    assert.equal(parts[0].id, `${id}_smt`);
    assert.equal(parts[0].name, 'statement');
    assert.ok(parts[0].prose.trim(), `Missing statement for ${id}`);
  }
  assert.deepEqual(validateOscal(assessor, 'catalog', { ours: true }), { ok: true, errors: [] });
});
