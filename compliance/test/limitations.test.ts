import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MIN_LIMITATION_PREFIX, matchLimitation, parseKnownLimitations } from '../src/limitations.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rows = [{ limitation: 'A limitation with sufficient unique words in its row that makes forty characters.', plan: 'Plan A' }, { limitation: 'Another different limitation with enough words to make a second unique row.', plan: 'Plan B' }];
test('matches a forty-character unique prefix and ignores whitespace', () => assert.equal(matchLimitation(' A   limitation with sufficient unique words in ', rows).plan, 'Plan A'));
test('refuses a short prefix', () => assert.throws(() => matchLimitation(rows[0].limitation.slice(0, MIN_LIMITATION_PREFIX - 1), rows), /at least/));
test('refuses a shared prefix', () => assert.throws(() => matchLimitation('A limitation with sufficient unique words in its row that makes forty characters.', [rows[0], { limitation: rows[0].limitation, plan: 'duplicate' }]), /more than one/));
test('parses a Markdown fixture table', () => assert.equal(parseKnownLimitations(readFileSync(path.join(root, 'compliance', 'test', 'fixtures', 'status', 'limitations-table.md'), 'utf8')).length, 1));
test('parses the real SECURITY known-limitations table', () => assert.ok(parseKnownLimitations(readFileSync(path.join(root, 'SECURITY.md'), 'utf8')).length >= 20));
