// Phase 46 verification gap (the Interface with Phase 47, item 4): every STERLING_* value Phase 47's sterling-site-env ConfigMap renders must
// be read by the workbench's own settings readers, as the workbench would read it at start. The values come from
// test/fixtures/site-env.rendered.json, which deploy/test/render-sessions.test.mjs checks against the chart render; a format change on
// either side fails one of the two tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readHostingConfig } from '../extension/src/node/hosting-config.ts';
import { readOutboundSettings } from '../extension/src/node/egress.ts';
import { readEvidenceSettings } from '../extension/src/node/sterling-evidence-service.ts';

// This file is bundled to workbench/dist/test/site-env-contract.test.js.
const workbenchRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const fixture = JSON.parse(readFileSync(path.join(workbenchRoot, 'test', 'fixtures', 'site-env.rendered.json'), 'utf8')) as {
  renders: Record<string, Record<string, string>>;
};

/** The STERLING_* names readHostingConfig and readOutboundSettings read; the site must render nothing else. */
const READ_BY_SETTINGS = new Set([
  'STERLING_OPENBAO_ADDR', 'STERLING_OPENBAO_CA_FILE', 'STERLING_OPENBAO_JWT_MOUNT', 'STERLING_OPENBAO_JWT_ROLE', 'STERLING_OPENBAO_STEPUP_ROLE',
  'STERLING_OPENBAO_KV_MOUNT', 'STERLING_OPENBAO_TRANSIT_MOUNT', 'STERLING_STEPUP_ACR', 'STERLING_STEPUP_MAX_AGE_SECONDS',
  'STERLING_OPEN_VSX_URL', 'STERLING_MODEL_SERVERS',
  // readEvidenceSettings (48.2-04, 48.2-17): your organization's site key, checked against the trust anchor the session is given.
  'STERLING_ORGANIZATION_PUBLIC_KEY',
]);

const EXPECTED_MODEL_SERVERS: Record<string, string[]> = {
  'site-example': [],
  'model-servers': ['https://models.site.example:8443/v1', 'https://inference.site.example/v1,beta'],
};

test('the fixture holds the site example and a site with model servers', () => {
  assert.deepEqual(Object.keys(fixture.renders).sort(), Object.keys(EXPECTED_MODEL_SERVERS).sort());
});

for (const [name, rendered] of Object.entries(fixture.renders)) {
  test(`every STERLING_* value the ${name} render gives the pod is read by the workbench's settings readers`, () => {
    for (const key of Object.keys(rendered)) assert.ok(READ_BY_SETTINGS.has(key), `${key} is rendered but the workbench reads no such setting`);
    // The operator sets THEIACLOUD_SESSION_USER per session; it is not a site value.
    const env = { ...rendered, THEIACLOUD_SESSION_USER: 'person@site.example' };

    const hosting = readHostingConfig(env);
    assert.equal(hosting.mode, 'hosted');
    if (hosting.mode !== 'hosted') return;
    assert.equal(hosting.addr, new URL(rendered.STERLING_OPENBAO_ADDR).origin);
    assert.equal(hosting.caFile, rendered.STERLING_OPENBAO_CA_FILE);
    assert.equal(hosting.jwtMount, rendered.STERLING_OPENBAO_JWT_MOUNT);
    assert.equal(hosting.jwtRole, rendered.STERLING_OPENBAO_JWT_ROLE);
    assert.equal(hosting.kvMount, rendered.STERLING_OPENBAO_KV_MOUNT);
    assert.equal(hosting.transitMount, rendered.STERLING_OPENBAO_TRANSIT_MOUNT);
    assert.equal(hosting.stepUpAcr, rendered.STERLING_STEPUP_ACR);
    assert.equal(String(hosting.stepUpMaxAgeSeconds), rendered.STERLING_STEPUP_MAX_AGE_SECONDS);

    const evidence = readEvidenceSettings(env);
    assert.equal(evidence.organizationPublicKey, rendered.STERLING_ORGANIZATION_PUBLIC_KEY, 'read as one ECDSA P-256 public key');

    const outbound = readOutboundSettings(env);
    assert.equal(outbound.openVsxUrl?.href, new URL(rendered.STERLING_OPEN_VSX_URL).href);
    assert.deepEqual(outbound.modelServers.map(String), EXPECTED_MODEL_SERVERS[name]);
  });
}
