// Deployment collector (48-02, D-13, D-16, VER-05, VER-06): a site's signed export becomes counts-only observations dated at the export's signed
// time, and only when a key in the site trust list signed it for the site-evidence purpose. Keys are generated when the tests run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyEnvelope } from '../src/signed.ts';
import { SITE_EXPORT_PURPOSE, deploymentCollector } from '../src/collectors/deployment.ts';
import { buildUnsignedExport, readKeycloakRealm, signExport } from '../src/siteExport.ts';
import { redactObservation } from '../src/redact.ts';
import { windowForCollector } from '../src/rules.ts';
import { DEPLOYMENT_FIXTURES, fileContext, freshKey, signersText, tempDir } from './fixtures/collectors/deployment/helpers.ts';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const COMMIT = 'c'.repeat(40);
const HOUR_MS = 60 * 60 * 1000;
const realmFixture = (): any => JSON.parse(readFileSync(path.join(DEPLOYMENT_FIXTURES, 'keycloak-realm.json'), 'utf8'));

test('the realm reader counts enabled password and OTP executions in the flows the realm binds only', () => {
  const realm = realmFixture();
  assert.equal(readKeycloakRealm(realm).passwordAuthenticators, 0);
  assert.equal(readKeycloakRealm(realm).otpAuthenticators, 0);
  realm.flowExecutions['sterling-browser'].push({ id: 'e99', requirement: 'ALTERNATIVE', displayName: 'Username Password Form', providerId: 'auth-username-password-form', level: 1, index: 1 });
  assert.equal(readKeycloakRealm(realm).passwordAuthenticators, 1);
  assert.equal(readKeycloakRealm(realm).otpAuthenticators, 0);
});

test('a built export signed with an Ed25519 key verifies for the site-evidence purpose and that key only', () => {
  const key = freshKey();
  const generatedAt = new Date(NOW.getTime() - HOUR_MS).toISOString();
  const envelope = signExport(buildUnsignedExport('fixture-site', generatedAt, { keycloak: readKeycloakRealm(realmFixture()) }, key.publicKey), key.privateKeyPem);
  const verdict = verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys: [key], now: NOW });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.signedAt, generatedAt);
  assert.equal(verifyEnvelope(envelope, { purpose: 'compliance-risk-acceptance', keys: [key], now: NOW }).ok, false);
  assert.equal(verifyEnvelope(envelope, { purpose: SITE_EXPORT_PURPOSE, keys: [freshKey()], now: NOW }).ok, false);
});

test('the collector turns a trusted export into a counts-only observation dated at the signed time', async () => {
  const key = freshKey();
  const dir = tempDir();
  const generatedAt = new Date(NOW.getTime() - HOUR_MS).toISOString();
  const envelope = signExport(buildUnsignedExport('fixture-site', generatedAt, { keycloak: readKeycloakRealm(realmFixture()) }, key.publicKey), key.privateKeyPem);
  writeFileSync(path.join(dir, 'export.json'), JSON.stringify(envelope));
  writeFileSync(path.join(dir, 'site-signers.json'), signersText(key));
  const observations = await deploymentCollector.collect({ file: path.join(dir, 'export.json'), signersFile: path.join(dir, 'site-signers.json') }, fileContext(NOW, COMMIT));
  const observation = observations.find((row) => row.subject === 'keycloak/no-password-authenticator');
  assert.deepEqual(observation, { collector: 'deployment', subject: 'keycloak/no-password-authenticator', passed: true, collectedAt: generatedAt, commit: COMMIT, counts: { 'password-authenticators': 0 } });
  assert.deepEqual(redactObservation(observation!), observation);
  assert.equal(deploymentCollector.window, 'settings');
  assert.equal(windowForCollector('deployment'), 'settings');
});
