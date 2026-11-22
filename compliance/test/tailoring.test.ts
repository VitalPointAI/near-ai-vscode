import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTailoring, notApplicableFor, removalsFor } from '../src/tailoring.ts';

const file = (dir: string, name: string, value: unknown) => writeFileSync(path.join(dir, name), `${JSON.stringify(value)}\n`);
test('loads a reviewed tailoring record and exposes its lookups', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tailoring-'));
  file(dir, 'a.json', { level: 'protected-a', notApplicable: [{ control: 'ac-01', component: 'extension', reason: 'Outside scope.', reviewer: 'Owner', reviewedAt: '2026-11-20' }], removals: [{ control: 'ac-02', reason: 'Removed.', reviewer: 'Owner', reviewedAt: '2026-11-20' }], parameters: [] });
  const tailoring = loadTailoring(dir);
  assert.equal(notApplicableFor(tailoring, 'protected-a', 'ac-01', 'extension')?.reason, 'Outside scope.');
  assert.equal(removalsFor(tailoring, 'protected-a')[0]?.control, 'ac-02');
});
test('refuses duplicate records for one level, control and component', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tailoring-'));
  file(dir, 'a.json', { level: 'protected-a', notApplicable: [{ control: 'ac-01', component: 'extension', reason: 'one', reviewer: 'Owner', reviewedAt: '2026-11-20' }], removals: [], parameters: [] });
  file(dir, 'b.json', { level: 'protected-a', notApplicable: [{ control: 'ac-01', component: 'extension', reason: 'two', reviewer: 'Owner', reviewedAt: '2026-11-20' }], removals: [], parameters: [] });
  assert.throws(() => loadTailoring(dir), /duplicate/);
});
test('the six shipped tailoring files are valid empty decision lists', () => {
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tailoring');
  assert.equal(readdirSync(dir).filter((file) => file.endsWith('.json')).length, 6);
  assert.deepEqual(loadTailoring(dir), { notApplicable: [], removals: [] });
});
