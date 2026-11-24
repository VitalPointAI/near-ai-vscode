// The stateful workloads (D-18, D-42 to D-44): each sync hub is a single-writer StatefulSet with the Compose hardening, reached over TLS it
// ends itself, and Keycloak's Postgres is one TLS-only replica with a nightly dump. Renders with the CI site; needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listReleases, loadSite, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
const hubRelease = () => listReleases(ROOT).find((release) => release.name === 'sterling-hub');
const renderHubs = (hubs) => splitDocs(renderRelease(ROOT, hubRelease(), { site: { ...SITE, hubs }, helm: HELM }));
const TWO = [
  { name: 'north', publicAddress: 'hub-north.site.example:30843', nodePort: 30843, storage: '20Gi' },
  { name: 'south', publicAddress: 'hub-south.site.example', nodePort: 30844, storage: '50Gi' }
];

test('each hub is a StatefulSet of one with the Compose hardening, its secret files and its own volume', () => {
  const docs = renderHubs(SITE.hubs);
  const sets = docs.filter((doc) => kindOf(doc) === 'StatefulSet');
  assert.equal(sets.length, 1);
  const set = sets[0];
  for (const expected of [/^ {2}replicas: 1$/m, /runAsUser: 65532/, /runAsGroup: 65532/, /fsGroup: 65532/, /runAsNonRoot: true/, /type: RuntimeDefault/,
    /readOnlyRootFilesystem: true/, /allowPrivilegeEscalation: false/, /drop: \[ALL\]/, /memory: 512Mi/, /medium: Memory/, /sizeLimit: 16Mi/,
    /automountServiceAccountToken: false/, /imagePullPolicy: IfNotPresent/, /storageClassName: "sterling-encrypted"/, /storage: "20Gi"/]) {
    assert.match(set, expected);
  }
  assert.equal((set.match(/"\/nodejs\/bin\/node", "\/app\/bin\.mjs", "--healthcheck"/g) ?? []).length, 2, 'liveness and readiness run the health check');
  for (const [name, value] of [['HUB_HOST', '"0.0.0.0"'], ['HUB_PORT', '"8443"'], ['HUB_STATE_DIR', '/var/lib/near-ai-hub'], ['HUB_PUBLIC_ADDRESS', '"hub-a.site.example:30843"'],
    ['HUB_TLS_CERT_FILE', '/run/secrets/hub/tls.crt'], ['HUB_TLS_KEY_FILE', '/run/secrets/hub/tls.key'], ['HUB_SIGNING_KEY_FILE', '/run/secrets/hub/signing.key'],
    ['HUB_ENCRYPTION_KEY_FILE', '/run/secrets/hub/encryption.key']]) {
    assert.ok(set.includes(`{ name: ${name}, value: ${value} }`), `${name} = ${value}`);
  }
  assert.match(set, /defaultMode: 0440/);
  assert.match(set, /name: hub-hub-a-tls/);
  assert.match(set, /name: hub-hub-a-keys/);
  assert.doesNotMatch(set, /HorizontalPodAutoscaler/);
  assert.ok(!docs.some((doc) => kindOf(doc) === 'HorizontalPodAutoscaler'));
});

test('two hubs in a site render two StatefulSets with their own volumes, and no Ingress routes to any hub', () => {
  const docs = renderHubs(TWO);
  const sets = docs.filter((doc) => kindOf(doc) === 'StatefulSet');
  assert.equal(sets.length, 2);
  assert.deepEqual(sets.map((doc) => /^ {2}name: (\S+)$/m.exec(doc)[1]).sort(), ['hub-north', 'hub-south']);
  assert.match(sets.find((doc) => doc.includes('hub-south')), /storage: "50Gi"/);
  const everything = renderSite(ROOT, { site: { ...SITE, hubs: TWO }, helm: HELM, all: true });
  for (const { name, yaml } of everything) {
    for (const doc of splitDocs(yaml).filter((entry) => kindOf(entry) === 'Ingress')) assert.doesNotMatch(doc, /hub-(north|south)/, `${name} routes an Ingress to a hub`);
  }
});
