import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { test } from 'node:test'; import { fileURLToPath } from 'node:url'; import path from 'node:path';
import { parseBaselineControls } from '../src/import/baseline-controls.ts'; import { validateOscal } from '../src/validate.ts';
const root = path.dirname(fileURLToPath(import.meta.url)); const page = readFileSync(path.join(root, 'fixtures/import/baseline/baseline.html'), 'utf8');
test('imports five organizational steps and thirteen baseline controls', () => { const doc: any = parseBaselineControls(page); assert.equal(doc.catalog.groups[0].controls.length, 5); assert.equal(doc.catalog.groups[1].controls.length, 13); });
test('uses stable baseline ids and labels from its own headings', () => { const doc: any = parseBaselineControls(page); assert.equal(doc.catalog.groups[1].controls[0].id, 'bcc-3.1'); assert.equal(doc.catalog.groups[1].controls[0].props[0].value, '3.1'); });
test('stores control text under its text-authorized source', () => { const control: any = parseBaselineControls(page).catalog.groups[1].controls[0]; assert.match(control.parts[0].prose, /incident response/); });
test('renders nested prose and footnote markers once', () => {
  const nested = '<main><h2>3 Baseline controls</h2><h3>3.1 Incident response</h3><div><p><strong>To summarize:</strong> assign roles.<sup id="fn7-rf"><a><span class="wb-inv">Footnote </span>7</a></sup></p></div></main>';
  const control = parseBaselineControls(nested).catalog.groups[1].controls[0];
  assert.equal(control.parts[0].prose, 'To summarize: assign roles. [Footnote 7]');
});
test('creates a valid baseline catalogue', () => assert.deepEqual(validateOscal(parseBaselineControls(page), 'catalog', { ours: true }), { ok: true, errors: [] }));
