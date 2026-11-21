import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { importSource } from '../src/import/cgp.ts';

const pageUrl = 'https://laws-lois.justice.gc.ca/eng/acts/D-1.5/page-3.html#h-419174';
const fixture = readFileSync(new URL('./fixtures/import/cgp/dpa-part-2.html', import.meta.url), 'utf8');

test('imports CGP-37-2 from the Act subsection selected by number', async () => {
  const result = await importSource({ offlinePages: { [pageUrl]: fixture } });
  const controls = (result.catalog as { catalog: { groups: Array<{ controls: Array<{ id: string; title: string; parts: Array<{ prose: string }>; links: Array<{ href: string }> }> }> } }).catalog.groups.flatMap((group) => group.controls);
  const requirement = controls.find((control) => control.id === 'cgp-37-2');
  assert.ok(requirement, 'CGP-37-2 is a requirement, not a definition');
  assert.equal(requirement.title, 'CGP-37-2');
  assert.match(requirement.parts[0].prose, /designated official/i);
  assert.equal(requirement.links[0].href, pageUrl);
});

test('does not turn subsection 37(3) definitions into requirements', async () => {
  const result = await importSource({ offlinePages: { [pageUrl]: fixture } });
  const serialized = JSON.stringify(result.catalog);
  assert.doesNotMatch(serialized, /cgp-37-3/);
});

test('stamps source provenance and an accurate-reproduction notice', async () => {
  const result = await importSource({ offlinePages: { [pageUrl]: fixture } });
  const catalog = (result.catalog as unknown as { catalog: { metadata: { props: Array<{ name: string; value: string }>; 'last-modified': string } } }).catalog;
  assert.equal(catalog.metadata.props.find((prop) => prop.name === 'source-id')?.value, 'defence-production-act');
  assert.ok(catalog.metadata['last-modified']);
  assert.match(JSON.stringify(result), /Accurate reproduction, not the official version\./);
});

test('the Controlled goods profile imports every generated CGP requirement', () => {
  const profile = JSON.parse(readFileSync(new URL('../profiles/overlay-cgp.json', import.meta.url), 'utf8')) as { profile: { imports: Array<{ href: string; 'include-all': Record<string, never> }> } };
  assert.deepEqual(profile.profile.imports, [{ href: '../catalogs/cgp/catalog.json', 'include-all': {} }]);
});
