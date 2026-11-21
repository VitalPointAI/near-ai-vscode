import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertNoSecrets, redactObservation } from '../src/redact.ts';

const observation = { collector: 'settings', subject: 'required-checks', passed: true, collectedAt: '2026-11-21T00:00:00.000Z', commit: 'a'.repeat(40), runUrl: 'https://github.com/owner/repo/actions/runs/1', counts: { checks: 1 } };
test('redaction keeps exactly the allowed observation fields', () => assert.deepEqual(redactObservation({ ...observation, log: 'private' } as any), observation));
test('redaction drops a non-GitHub run address', () => assert.equal(redactObservation({ ...observation, runUrl: 'https://example.test/run' }).runUrl, undefined));
test('redaction refuses unsafe collector ids', () => assert.throws(() => redactObservation({ ...observation, collector: 'bad value' })));
test('redaction refuses unsafe subjects', () => assert.throws(() => redactObservation({ ...observation, subject: '../secret' })));
test('redaction refuses unsafe hashes', () => assert.throws(() => redactObservation({ ...observation, hash: 'not-a-hash' })));
test('redaction refuses unsafe count keys', () => assert.throws(() => redactObservation({ ...observation, counts: { 'Upper': 1 } })));
test('redaction refuses unsafe count values', () => assert.throws(() => redactObservation({ ...observation, counts: { checks: -1 } })));
test('secret scanning examines every output line', () => { const dir = mkdtempSync(path.join(tmpdir(), 'near-ai-redact-')); const fake = ['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join(''); writeFileSync(path.join(dir, 'bundle.json'), `${fake}\n`); assert.throws(() => assertNoSecrets(dir)); });
