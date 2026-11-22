import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { importSource, parseItsp171 } from '../src/import/itsp-10-171.ts';
import { validateOscal } from '../src/validate.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(root, 'fixtures', 'import', 'itsp10171', name), 'utf8');
const pages = { requirements: fixture('requirements.html'), assessment: fixture('assessment.html') };

const nestedPages = {
  requirements: '<main><section><details><summary><h4 id="03-01-01">03.01.01 Account management</h4></summary><p>Current requirement text.</p><h5>Discussion</h5><p>Current guidance.</p><h5>References</h5><p>AC-02.</p></details></section></main>',
  assessment: '<main><section><details><summary><h4>03.01.01 Account management</h4></summary><p>Determine whether the current requirement is met.</p></details></section></main>'
};

test('imports an ITSP.10.171 requirement into its section group with a statement and guidance', () => {
  const result = parseItsp171(pages);
  const control: any = result.catalog.catalog.groups[0].controls[0];
  assert.equal(control.id, 'itsp171-03.01.01');
  assert.equal(control.props[0].value, '03.01.01');
  assert.equal(control.parts.find((part: any) => part.name === 'statement').prose, 'The contractor manages accounts and access approvals.');
  assert.match(control.parts.find((part: any) => part.name === 'guidance').prose, /least privilege/);
});

test('attaches assessment determinations as assessment-objective parts', () => {
  const control: any = parseItsp171(pages).catalog.catalog.groups[0].controls[0];
  assert.equal(control.parts.find((part: any) => part.name === 'assessment-objective').prose, 'Determine whether account reviews occur at the required interval.');
});

test('reports a determination whose requirement is absent rather than attaching it', () => {
  const result = parseItsp171(pages);
  assert.deepEqual(result.unmatchedAssessmentIds, ['03.99.99']);
  assert.equal(JSON.stringify(result.catalog).includes('unmatched requirement'), false);
});

test('parses the current nested details headings and fails closed when none are available', () => {
  const result = parseItsp171(nestedPages);
  assert.equal(result.catalog.catalog.groups.length, 1);
  assert.equal(result.catalog.catalog.groups[0].controls.length, 1);
  assert.match(result.catalog.catalog.groups[0].controls[0].parts.find((part: any) => part.name === 'assessment-objective').prose, /Determine whether/);
  assert.throws(() => parseItsp171({ requirements: '<main><h4>Unnumbered heading</h4></main>', assessment: '<main></main>' }), /no parseable requirement headings/);
});

test('keeps an active accordion separate from the preceding withdrawal notice', () => {
  const requirements = `<main><section>
    <h4 id="03-01-15">03.01.15 Not allocated</h4><p>Withdrawn by <abbr>NIST</abbr>.</p>
    <details><summary><h4 id="03-01-16">03.01.16 Wireless access</h4></summary>
      <p>Approve wireless connections.</p>
      <h5>Discussion</h5><p>Document approval criteria.</p>
      <h5>References</h5><p>AC-18 and AC-18. See also AC-18(1) and AC-18(01).</p>
    </details>
    <h4 id="03-01-17">03.01.17 Not allocated</h4><p>Withdrawn by NIST.</p>
  </section></main>`;
  const assessment = `<main><section>
    <h4>03.01.15 Not allocated</h4><p>Withdrawn by NIST.</p>
    <details><summary><h4>03.01.16 Wireless access</h4></summary>
      <p>Determine whether approvals are recorded.</p>
    </details>
    <h4>03.01.17 Not allocated</h4><p>Withdrawn by NIST.</p>
  </section></main>`;
  const result = parseItsp171({ requirements, assessment });
  const [withdrawn, active, next] = result.catalog.catalog.groups[0].controls;
  assert.equal(withdrawn.id, 'itsp171-03.01.15');
  assert.deepEqual(withdrawn.parts.map(({ name, prose }: any) => [name, prose]), [
    ['statement', 'Withdrawn by NIST.'],
  ]);
  assert.equal(active.id, 'itsp171-03.01.16');
  assert.deepEqual(active.parts.map(({ name, prose }: any) => [name, prose]), [
    ['statement', 'Approve wireless connections.'],
    ['guidance', 'Document approval criteria.'],
    ['assessment-objective', 'Determine whether approvals are recorded.'],
  ]);
  assert.equal(next.id, 'itsp171-03.01.17');
  const rows = result.mapping['mapping-collection'].mappings.maps;
  assert.deepEqual(rows.map(({ sources, targets }: any) => [sources[0]['id-ref'], targets[0]['id-ref']]), [
    ['itsp171-03.01.16', 'ac-18'],
    ['itsp171-03.01.16', 'ac-18.01'],
  ]);
  assert.deepEqual(result.report, { unmatchedAssessmentIds: [], requirementsWithoutSourceControls: 2 });
});

test('produces a valid ITSP.10.171 catalogue through the importer entry point', async () => {
  const result = await importSource({ offlinePages: pages });
  assert.equal(result.sourceId, 'itsp-10-171');
  assert.equal(result.file, 'catalogs/itsp-10-171/catalog.json');
  assert.deepEqual(validateOscal(result.catalog, 'catalog', { ours: true }), { ok: true, errors: [] });
  const otherCatalog = JSON.parse(readFileSync(path.join(root, '..', 'catalogs', 'itsp-10-033', 'catalog.json'), 'utf8'));
  const committedCatalog = JSON.parse(readFileSync(path.join(root, '..', result.file), 'utf8'));
  const { uuid } = parseItsp171(pages).catalog.catalog;
  assert.equal(uuid, committedCatalog.catalog.uuid);
  assert.notEqual(uuid, otherCatalog.catalog.uuid);
  assert.equal(uuid, parseItsp171(nestedPages).catalog.catalog.uuid);
});

test('stamps the standards-required mapping provenance', () => {
  const mapping: any = parseItsp171(pages).mapping['mapping-collection'];
  assert.deepEqual(mapping.provenance, { method: 'automation', 'matching-rationale': 'syntactic', status: 'draft', 'mapping-description': 'Identifier references parsed from the published ITSP.10.171 requirements.' });
  assert.deepEqual(validateOscal({ 'mapping-collection': mapping }, 'mapping-collection', { ours: true }), { ok: true, errors: [] });
});

test('the contractor overlay imports the catalogue with include-all and validates', () => {
  const profile = JSON.parse(readFileSync(path.join(root, '..', 'profiles', 'itsp-10-171-overlay.json'), 'utf8'));
  assert.deepEqual(profile.profile.imports, [{ href: '../catalogs/itsp-10-171/catalog.json', 'include-all': {} }]);
  assert.deepEqual(validateOscal(profile, 'profile', { ours: true }), { ok: true, errors: [] });
});
