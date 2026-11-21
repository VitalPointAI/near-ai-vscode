// Product content checks for Phase 44.  The dashboard computes a state; these
// checks keep its source material tied to real catalogues and real evidence.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPONENTS = path.join(ROOT, 'compliance', 'components');

test('the phase supplies the extension component definition', () => {
  assert.ok(existsSync(path.join(COMPONENTS, 'extension.json')), 'extension statements must be present before a dashboard can make a control met');
});

test('the responsibility table is present for controls without statements', () => {
  assert.ok(existsSync(path.join(ROOT, 'compliance', 'responsibility', 'families.json')), 'family responsibilities must be present');
});

test('the extension evidence file names a real gate decision test', () => {
  const file = path.join(ROOT, 'compliance', 'evidence-rules', 'extension.json');
  assert.ok(existsSync(file), 'extension evidence rules must be present');
  assert.match(readFileSync(file, 'utf8'), /src\/test\/gateDecide\.test\.ts/, 'a dashboard rule must name its source test');
});
