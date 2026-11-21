import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PAYLOAD_DOMAIN, verifyEnvelope } from '../src/signed.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const extensionSource = readFileSync(path.join(root, 'src', 'domain', 'team', 'signedPayload.ts'), 'utf8');
const fixture = JSON.parse(readFileSync(path.join(root, 'compliance', 'test', 'fixtures', 'signed', 'extension-envelope.json'), 'utf8'));
const sourceDomain = /export const PAYLOAD_DOMAIN = '([^']+)'/.exec(extensionSource)?.[1];

test('the compliance verifier uses the extension signing domain', () => assert.equal(PAYLOAD_DOMAIN, sourceDomain));
test('an envelope produced by the compiled extension signer verifies here', () => assert.equal(verifyEnvelope(fixture, { purpose: 'policy-authorization', keys: [fixture.signer], now: new Date('2026-11-21T12:00:00.000Z') }).ok, true));
test('one changed payload byte fails the extension-envelope signature', () => {
  const changed = { ...fixture, payload: { ...fixture.payload, note: 'changed' } };
  const verdict = verifyEnvelope(changed, { purpose: 'policy-authorization', keys: [fixture.signer], now: new Date('2026-11-21T12:00:00.000Z') });
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.reason, 'bad-signature');
});
