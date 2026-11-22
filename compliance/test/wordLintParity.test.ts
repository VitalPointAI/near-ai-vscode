import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COMPLIANCE_CLAIMS, NEGATION } from '../src/wordLint.ts';
const source = readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/test/helpers/copyLintScan.ts'), 'utf8');
test('copies the Phase 41 claim phrases exactly', () => { const match = source.match(/COMPLIANCE_CLAIMS:[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/); assert.ok(match, 'could not find COMPLIANCE_CLAIMS array literal'); const values = [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1]); assert.deepEqual([...COMPLIANCE_CLAIMS], values); });
test('copies the Phase 41 negation regex exactly', () => { const match = source.match(/const NEGATION = (\/.+?\/[a-z]*);/); assert.ok(match, 'could not find NEGATION regex literal'); assert.equal(NEGATION.toString(), match[1]); });
