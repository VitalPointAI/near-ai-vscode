// The stateful workloads (D-18, D-42 to D-44): each sync hub is a single-writer StatefulSet with the Compose hardening, reached over TLS it
// ends itself, and Keycloak's Postgres is one TLS-only replica with a nightly dump. Renders with the CI site; needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

// G540: the hub refuses a key file that group or others can read (hub/src/secrets.ts), and the kubelet's Secret files are root's and at least 0440
// under fsGroup. hub/test/secrets.test.ts runs deploy/hub/files/stage-secrets.cjs and loads its copies with the hub's loader; this checks the chart
// runs exactly that file, as the hub's user, and that the hub reads only its copies.
test('G540: the hub reads owner-only (0400) copies of its key files, made as its own user by an init container from the Secret volume', () => {
  const [set] = renderHubs(SITE.hubs).filter((doc) => kindOf(doc) === 'StatefulSet');
  const between = (from, to) => {
    const start = set.indexOf(`\n${from}`);
    const end = set.indexOf(`\n${to}`, start + 1);
    assert.ok(start >= 0 && end > start, `${from.trim()} comes before ${to.trim()}`);
    return set.slice(start, end);
  };
  const pod = between('      securityContext:', '      initContainers:');
  const init = between('      initContainers:', '      containers:');
  const hub = between('      containers:', '      volumes:');
  const volumes = between('      volumes:', '  volumeClaimTemplates:');
  // One user for both containers: the pod's, overridden by neither, so the copies belong to the user the hub runs as.
  for (const expected of [/runAsUser: 65532/, /runAsGroup: 65532/, /fsGroup: 65532/, /runAsNonRoot: true/]) assert.match(pod, expected);
  for (const container of [init, hub]) assert.doesNotMatch(container, /runAsUser|runAsGroup|runAsNonRoot/);
  // The hub image's own Node, hardened like the hub, runs the chart's staging file from the Secret volume into the memory volume.
  assert.deepEqual([...init.matchAll(/^ {8}- name: (\S+)/gm)].map((match) => match[1]), ['stage-secrets']);
  assert.equal(/^ {10}image: (\S+)$/m.exec(init)?.[1], /^ {10}image: (\S+)$/m.exec(hub)?.[1]);
  for (const expected of [/readOnlyRootFilesystem: true/, /allowPrivilegeEscalation: false/, /drop: \[ALL\]/]) assert.match(init, expected);
  const args = JSON.parse(/^ {10}args: (\[.*\])$/m.exec(init)?.[1] ?? 'null');
  assert.deepEqual(args, ['-e', readFileSync(path.join(ROOT, 'deploy/hub/files/stage-secrets.cjs'), 'utf8'), '/run/secrets/hub-source', '/run/secrets/hub']);
  assert.ok(init.includes('{ name: secret-files, mountPath: /run/secrets/hub-source, readOnly: true }'));
  assert.ok(init.includes('{ name: secrets, mountPath: /run/secrets/hub }'));
  // The hub mounts only the copies, read-only.
  assert.ok(hub.includes('{ name: secrets, mountPath: /run/secrets/hub, readOnly: true }'));
  assert.doesNotMatch(hub, /secret-files/);
  assert.match(volumes, /\n {8}- name: secrets\n {10}emptyDir:\n {12}medium: Memory\n/);
  const projected = /\n {8}- name: secret-files\n {10}projected:\n {12}defaultMode: 0440\n([\s\S]*?)(?=\n {8}- name:|$)/.exec(volumes);
  assert.ok(projected, 'secret-files projects the two Secrets');
  const files = [...projected[1].matchAll(/path: (\S+) \}/g)].map((match) => match[1]).sort();
  assert.deepEqual(files, ['encryption.key', 'signing.key', 'tls.crt', 'tls.key']);
  // Each HUB_*_FILE setting names one of those files among the copies, and every file is named.
  assert.deepEqual([...hub.matchAll(/\{ name: HUB_\w+_FILE, value: \/run\/secrets\/hub\/(\S+) \}/g)].map((match) => match[1]).sort(), files);
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

test('71-11: a hub item naming your organization\'s rules and key mounts the rules read-only and passes both settings to the hub', () => {
  const key = 'A'.repeat(43);
  const [set] = renderHubs([{ ...TWO[0], organizationPolicy: { configMap: 'organization-rules', key: 'organization.near-org-rules' }, organizationKey: key }])
    .filter((doc) => kindOf(doc) === 'StatefulSet');
  assert.match(set, /name: HUB_ORGANIZATION_POLICY, value: \/run\/organization\/organization\.near-org-rules/);
  assert.ok(set.includes(`name: HUB_ORGANIZATION_KEY, value: "${key}"`));
  assert.match(set, /name: organization-policy, mountPath: \/run\/organization, readOnly: true/);
  assert.match(set, /configMap:\n\s+name: "organization-rules"/);
  assert.match(set, /key: "organization\.near-org-rules", path: organization\.near-org-rules/);
  const [fromSecret] = renderHubs([{ ...TWO[0], organizationPolicy: { secret: 'organization-rules', key: 'rules' }, organizationKey: key }])
    .filter((doc) => kindOf(doc) === 'StatefulSet');
  assert.match(fromSecret, /secret:\n\s+secretName: "organization-rules"/);
});

test('71-11: without the rules and key a hub renders with its trust routes off, and naming only one of them stops the render', () => {
  const [plain] = renderHubs([TWO[0]]).filter((doc) => kindOf(doc) === 'StatefulSet');
  assert.doesNotMatch(plain, /HUB_ORGANIZATION_/);
  assert.doesNotMatch(plain, /organization-policy/);
  assert.throws(() => renderHubs([{ ...TWO[0], organizationKey: 'A'.repeat(43) }]), /organizationPolicy and organizationKey must be set together/);
  assert.throws(() => renderHubs([{ ...TWO[0], organizationPolicy: { configMap: 'x', key: 'y' }, organizationKey: 'not a key' }]), /43 base64url characters/);
});

test('sessions reach a hub by its cluster address and members by its node port, both plain TCP to the hub\'s own TLS', () => {
  const docs = renderHubs(TWO);
  const services = docs.filter((doc) => kindOf(doc) === 'Service');
  assert.equal(services.length, 4);
  const internal = services.find((doc) => /^ {2}name: hub-north$/m.test(doc));
  const external = services.find((doc) => /^ {2}name: hub-north-external$/m.test(doc));
  assert.match(internal, /type: ClusterIP/);
  assert.match(external, /type: NodePort/);
  assert.match(external, /nodePort: 30843/);
  for (const doc of [internal, external]) {
    assert.match(doc, /port: 8443/);
    assert.match(doc, /protocol: TCP/);
  }
  const certificate = docs.find((doc) => kindOf(doc) === 'Certificate' && doc.includes('hub-north-tls'));
  assert.match(certificate, /kind: ClusterIssuer\n\s+name: site-pki-hub/);
  for (const name of ['"hub-north.site.example"', 'hub-north.sterling-hubs.svc', 'hub-north.sterling-hubs.svc.cluster.local']) assert.ok(certificate.includes(`- ${name}`), name);
  assert.match(certificate, /- server auth/);
  assert.throws(() => renderHubs([{ ...TWO[0], nodePort: undefined }]), /nodePort is not set/);
});

test('Keycloak\'s Postgres is one TLS-only replica with its certificate, a nightly dump, and both volumes on the site class', () => {
  const docs = splitDocs(renderRelease(ROOT, listReleases(ROOT).find((release) => release.name === 'sterling-postgres'), { site: SITE, helm: HELM }));
  const set = docs.find((doc) => kindOf(doc) === 'StatefulSet');
  assert.match(set, /^ {2}replicas: 1$/m);
  assert.match(set, /readOnlyRootFilesystem: true/);
  assert.match(set, /runAsUser: 26/);
  assert.match(set, /storageClassName: "sterling-encrypted"/);
  assert.ok(set.includes(`{ name: POSTGRES_ALLOW_CIDRS, value: "${SITE.clusterCidrs.pod}" }`), 'only the pod range may connect');
  assert.match(set, /pg_isready/);
  const certificate = docs.find((doc) => kindOf(doc) === 'Certificate');
  assert.match(certificate, /secretName: sterling-postgres-tls/);
  assert.match(certificate, /kind: ClusterIssuer\n\s+name: site-pki$/m);
  assert.match(certificate, /- sterling-postgres\.sterling-identity\.svc$/m);
  const dump = docs.find((doc) => kindOf(doc) === 'CronJob');
  assert.ok(dump, 'a nightly dump');
  assert.match(dump, /sslmode=verify-full/);
  const claim = docs.find((doc) => kindOf(doc) === 'PersistentVolumeClaim');
  assert.match(claim, /storageClassName: "sterling-encrypted"/);
  assert.ok(docs.some((doc) => kindOf(doc) === 'Service' && /^ {2}name: sterling-postgres$/m.test(doc)));
});
