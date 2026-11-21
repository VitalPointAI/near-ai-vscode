import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadComponents } from '../src/components.ts';

const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'components');
const read = (name: string): any => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const withDoc = (doc: any): ReturnType<typeof loadComponents> => { const dir = mkdtempSync(path.join(tmpdir(), 'components-')); writeFileSync(path.join(dir, 'item.json'), JSON.stringify(doc)); return loadComponents(dir); };

test('loads OSCAL extension and relay fixtures into component inputs', () => { const loaded = loadComponents(fixtures); assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.components.map((item) => item.id), ['extension', 'relay']); assert.equal(loaded.components[0].implemented[0].statements[0].yourOrganizationDoes, 'Organization action.'); });
test('preserves statement props and inherited provider', () => { const loaded = loadComponents(fixtures); const relay = loaded.components.find((item) => item.id === 'relay')!; assert.equal(relay.implemented[0].inheritedFrom, 'Example Provider'); assert.equal(relay.implemented[0].statements[0].unsettled, 'relay-question'); assert.equal(relay.implemented[0].statements[0].requiresOfficialSignature, true); });
test('refuses missing responsibility', () => { const doc = read('extension.json'); delete doc['component-definition'].components[0]['control-implementations'][0]['implemented-requirements'][0].props; assert.match(withDoc(doc).errors[0], /responsibility/); });
test('refuses two responsibilities and bad responsibility', () => { const doc = read('extension.json'); const props = doc['component-definition'].components[0]['control-implementations'][0]['implemented-requirements'][0].props; props.push({ ...props[0] }); assert.match(withDoc(doc).errors[0], /responsibility/); props.splice(1); props[0].value = 'magic'; assert.match(withDoc(doc).errors[0], /responsibility/); });
test('refuses a responsibility under another namespace', () => { const doc = read('extension.json'); doc['component-definition'].components[0]['control-implementations'][0]['implemented-requirements'][0].props[0].ns = 'urn:other'; assert.match(withDoc(doc).errors[0], /responsibility/); });
test('refuses a missing or duplicate component id', () => { const doc = read('extension.json'); delete doc['component-definition'].components[0].props; assert.match(withDoc(doc).errors[0], /component-id/); const duplicate = mkdtempSync(path.join(tmpdir(), 'components-')); writeFileSync(path.join(duplicate, 'a.json'), JSON.stringify(read('extension.json'))); writeFileSync(path.join(duplicate, 'b.json'), JSON.stringify(read('extension.json'))); assert.match(loadComponents(duplicate).errors[0], /duplicate/); });
