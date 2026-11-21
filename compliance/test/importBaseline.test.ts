import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { test } from 'node:test'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { parseBaselineControls } from '../src/import/baseline-controls.ts'; import { validateOscal } from '../src/validate.ts';
const root = path.dirname(fileURLToPath(import.meta.url)); const page = readFileSync(path.join(root, 'fixtures/import/baseline/baseline.html'), 'utf8');
test('imports five organizational steps and thirteen baseline controls', () => { const doc: any = parseBaselineControls(page); assert.equal(doc.catalog.groups[0].controls.length, 5); assert.equal(doc.catalog.groups[1].controls.length, 13); });
test('uses stable baseline ids and labels from its own headings', () => { const doc: any = parseBaselineControls(page); assert.equal(doc.catalog.groups[1].controls[0].id, 'bcc-3.1'); assert.equal(doc.catalog.groups[1].controls[0].props[0].value, '3.1'); });
test('stores control text under its text-authorized source', () => { const control: any = parseBaselineControls(page).catalog.groups[1].controls[0]; assert.match(control.parts[0].prose, /incident response/); });
test('creates a valid baseline catalogue', () => assert.deepEqual(validateOscal(parseBaselineControls(page), 'catalog', { ours: true }), { ok: true, errors: [] }));
