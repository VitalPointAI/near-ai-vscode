// Site storage, logs, metrics and the HQ registry, on the rendered stack (D-15, D-17, D-19, D-26, D-35): every storage class encrypts at
// rest, Fluent Bit ships to the site's own OpenSearch only, Prometheus writes nowhere else, and Harbor is behind site TLS with no internet
// scanner. Renders every release with the CI site (all releases, whatever enabledWhen says). Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { chronyConf } from '../bundle/lib/clock.mjs';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';
import { expandInstances, isEnabled, listReleases, loadSite, releaseInputs, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';
import { NOTICE_MESSAGE, prepareRealm } from '../keycloak/apply.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
let rendered;
const docsOf = (name) => splitDocs(rendered.find((release) => release.name === name)?.yaml ?? '');
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];

before(() => { rendered = renderSite(ROOT, { site: SITE, helm: HELM, all: true }); });

test('every rendered StorageClass is a Longhorn class encrypted with the class key', () => {
  const classes = rendered.flatMap(({ name, yaml }) => splitDocs(yaml).filter((doc) => kindOf(doc) === 'StorageClass').map((doc) => ({ name, doc })));
  assert.ok(classes.length >= 1);
  for (const { name, doc } of classes) {
    const where = `${name}: StorageClass ${/^ {2}name: (\S+)/m.exec(doc)?.[1]}`;
    assert.match(doc, /^provisioner: driver\.longhorn\.io$/m, `${where} is not a Longhorn class`);
    assert.match(doc, /^ {2}encrypted: "true"$/m, `${where} is not encrypted at rest`);
    for (const stage of ['provisioner', 'node-publish', 'node-stage', 'node-expand']) {
      assert.match(doc, new RegExp(`csi\\.storage\\.k8s\\.io/${stage}-secret-name: longhorn-crypto`), `${where}: ${stage} key`);
    }
  }
  const ours = docsOf('sterling-storage').filter((doc) => kindOf(doc) === 'StorageClass');
  assert.equal(ours.length, 1);
  assert.match(ours[0], new RegExp(`^ {2}name: ${SITE.storageClass}$`, 'm'));
  assert.match(ours[0], /^reclaimPolicy: Retain$/m);
  assert.equal(docsOf('sterling-storage').filter((doc) => kindOf(doc) === 'RecurringJob').length, 2, 'a daily snapshot and a daily backup');
});

/** The [OUTPUT] sections of a Fluent Bit configuration, each as a map of its keys (read line by line). */
function fluentOutputs(text) {
  const outputs = [];
  let current = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^\[[A-Z]+\]$/.test(trimmed)) { current = trimmed === '[OUTPUT]' ? {} : null; if (current) outputs.push(current); continue; }
    if (current && trimmed) {
      const space = trimmed.search(/\s/);
      if (space > 0) current[trimmed.slice(0, space).toLowerCase()] = trimmed.slice(space).trim();
    }
  }
  return outputs;
}

test('Fluent Bit ships the API audit log and every container log to the site OpenSearch, and nowhere else', () => {
  const config = docsOf('fluent-bit').filter((doc) => kindOf(doc) === 'ConfigMap').join('\n');
  assert.match(config, /Path +\/var\/lib\/rancher\/rke2\/server\/logs\/audit\.log/);
  assert.match(config, /Path +\/var\/log\/containers\/\*\.log/);
  const outputs = fluentOutputs(config);
  assert.equal(outputs.length, 1, 'exactly one output');
  assert.equal(outputs[0].name, 'opensearch');
  assert.match(outputs[0].host, /^[a-z0-9-]+\.sterling-logging\.svc$/);
  assert.equal(outputs[0]['tls.verify'], 'On');
  assert.ok(rendered.some((release) => release.name === 'fluent-bit' && release.release.namespace === 'sterling-log-shipper'));
});

test('Prometheus writes and reads nowhere outside the site, and OpenSearch runs with its security plugin', () => {
  const prometheus = docsOf('prometheus').join('\n');
  assert.doesNotMatch(prometheus, /remote_write|remote_read/);
  const opensearch = docsOf('opensearch').join('\n');
  assert.match(opensearch, /plugins\.security\.ssl\.http\.enabled: true/);
  assert.doesNotMatch(opensearch, /plugins\.security\.disabled: true|DISABLE_SECURITY_PLUGIN/);
  assert.match(opensearch, /audit-writer:/);
  assert.match(opensearch, /"delete": \{\}/, 'the retention policy deletes old indices');
});

/** The text of a rendered ConfigMap's block-scalar key (`  key: |`, then lines indented four spaces). */
const configMapText = (docs, name, key) => {
  const doc = docs.find((item) => kindOf(item) === 'ConfigMap' && new RegExp(`^ {2}name: ${name}$`, 'm').test(item));
  assert.ok(doc, `ConfigMap ${name}`);
  const lines = doc.split('\n');
  const start = lines.indexOf(`  ${key}: |`);
  assert.ok(start >= 0, `${name} has ${key}`);
  const out = [];
  for (const line of lines.slice(start + 1)) { if (line && !line.startsWith('    ')) break; out.push(line.slice(4)); }
  return out.join('\n');
};

test('the audit and log indices are snapshotted to a repository on the encrypted class, without the security index, kept 1,825 days (D-73, D-82)', () => {
  const docs = docsOf('opensearch');
  const opensearch = docs.join('\n');
  const claim = docs.find((doc) => kindOf(doc) === 'PersistentVolumeClaim' && /name: opensearch-snapshots/.test(doc));
  assert.ok(claim, 'PVC opensearch-snapshots');
  assert.match(claim, new RegExp(`storageClassName: "${SITE.storageClass}"`));
  assert.match(claim, /accessModes: \[ReadWriteMany\]/, 'several nodes share one repository (the example has three)');
  assert.match(claim, /helm\.sh\/resource-policy: keep/);
  assert.match(opensearch, /path\.repo: \["\/usr\/share\/opensearch\/snapshots"\]/);
  assert.match(opensearch, /- mountPath: \/usr\/share\/opensearch\/snapshots\n\s+name: snapshots/, 'every node mounts the repository at path.repo');
  const repository = JSON.parse(configMapText(docs, 'opensearch-snapshot-repository', 'repository.json'));
  assert.deepEqual(repository, { type: 'fs', settings: { location: '/usr/share/opensearch/snapshots', compress: true } });
  const policy = JSON.parse(configMapText(docs, 'opensearch-snapshot-policy', 'policy.json'));
  assert.equal(policy.snapshot_config.repository, 'sterling-snapshots');
  assert.equal(policy.snapshot_config.indices, 'audit-*,logs-*');
  assert.equal(policy.snapshot_config.include_global_state, false, 'the security index is never in a snapshot');
  assert.equal(policy.snapshot_config.ignore_unavailable, true);
  assert.equal(policy.creation.schedule.cron.timezone, 'UTC');
  assert.deepEqual(policy.deletion.condition, { max_age: '1825d', min_count: 7 });
});

test('the snapshot check reads the volume only, holds no credentials, and a render that keeps snapshots under 1,825 days stops (H-08)', () => {
  const job = docsOf('opensearch').find((doc) => kindOf(doc) === 'CronJob' && /name: opensearch-snapshot-check/.test(doc));
  assert.ok(job, 'CronJob opensearch-snapshot-check');
  assert.match(job, /- name: snapshots\n\s+mountPath: \/snapshots\n\s+readOnly: true/);
  assert.match(job, /claimName: opensearch-snapshots\n\s+readOnly: true/);
  assert.match(job, /automountServiceAccountToken: false/);
  assert.doesNotMatch(job, /secretKeyRef|secretName|password|BAO_|OPENSEARCH_/i, 'no credentials');
  assert.match(job, /readOnlyRootFilesystem: true/);
  assert.match(job, /value: "2160"/);
  const opensearch = listReleases(ROOT).find((release) => release.name === 'opensearch');
  assert.throws(() => renderRelease(ROOT, opensearch, { site: SITE, helm: HELM, sets: ['sterling.snapshots.maxAgeDays=1824'] }), /maxAgeDays must be at least 1825/);
  assert.doesNotThrow(() => renderRelease(ROOT, opensearch, { site: SITE, helm: HELM, sets: ['sterling.snapshots.maxAgeDays=3650'] }));
  const single = renderRelease(ROOT, opensearch, { site: SITE, helm: HELM, sets: ['singleNode=true'] });
  assert.match(single, /accessModes: \[ReadWriteOnce\]/, 'one node: ReadWriteOnce');
  assert.match(single, /podAffinity:\n\s+requiredDuringSchedulingIgnoredDuringExecution:\n\s+- topologyKey: kubernetes\.io\/hostname/, 'the check runs on the OpenSearch node');
});

test('Harbor is behind HTTPS on the HAProxy ingress, with no Trivy scanner and none of the chart\'s public default credentials', () => {
  const harbor = docsOf('harbor');
  const text = harbor.join('\n');
  assert.match(text, /https:\/\/registry\.site\.example/);
  const ingresses = harbor.filter((doc) => kindOf(doc) === 'Ingress');
  assert.ok(ingresses.length > 0);
  for (const doc of ingresses) assert.match(doc, /ingressClassName: haproxy/);
  // No Trivy workload or image (its vulnerability database is an internet download); the core configuration may still name the setting.
  for (const doc of harbor.filter((entry) => /^kind: (Deployment|StatefulSet|DaemonSet)$/m.test(entry))) assert.doesNotMatch(/^ {2}name: (\S+)$/m.exec(doc)?.[1] ?? '', /trivy/i);
  assert.doesNotMatch(text, /image: \S*trivy/i);
  assert.match(text, /WITH_TRIVY: "false"/);
  for (const sample of ['Harbor12345', 'not-a-secure-key', 'harbor_registry_password', 'changeit']) {
    assert.ok(!text.includes(sample) && !text.includes(Buffer.from(sample).toString('base64')), `the public default ${sample} is rendered`);
  }
});

test('the lab template requires its own public key and renders the offline lab configuration', (t) => {
  const template = path.join(ROOT, 'deploy/lab/site.lab.yaml');
  const siteDir = path.join(ROOT, 'deploy/lab/site.lab');
  const rawSite = JSON.parse(readFileSync(template, 'utf8'));
  assert.throws(() => loadSite(template), /organizationPublicKey is missing or empty/);
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-lab-site-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const siteFile = path.join(scratch, 'site.lab.yaml');
  writeFileSync(siteFile, JSON.stringify({ ...rawSite, organizationPublicKey: SITE.organizationPublicKey }));
  const site = loadSite(siteFile);
  const options = { site, siteDir, helm: HELM };

  const chrony = chronyConf(site);
  assert.match(chrony, /^refclock PHC \/dev\/ptp0 poll 2$/m);
  assert.doesNotMatch(chrony, /^(server|pool)\s/m);
  assert.deepEqual(site.egressAllow, []);
  assert.equal(site.storageProvider, 'lab-static');
  assert.equal(site.storageEncryptionAtRest, 'LUKS-encrypted VM disk');
  const releases = new Map(listReleases(ROOT).map((release) => [release.name, release]));
  assert.equal(isEnabled(releases.get('zot'), site), true);
  assert.equal(isEnabled(releases.get('harbor'), site), false);
  assert.equal(isEnabled(releases.get('longhorn'), site), false);
  assert.equal(expandInstances(releases.get('sterling-hub'), site).length, 1);

  const sessions = releaseInputs(ROOT, 'sterling-sessions', options).texts.map(({ text }) => text).join('\n');
  const warning = Number(/^  notifyAfterMinutes: (\d+)$/m.exec(sessions)?.[1]);
  assert.ok(warning > 0 && warning < site.sessionTimeoutMinutes, 'idle warning precedes the configured stop');
  const app = splitDocs(renderRelease(ROOT, 'sterling-sessions', options)).find((doc) => kindOf(doc) === 'AppDefinition');
  const placeholder = resolveImage(readImagesLock(ROOT), 'registry.access.redhat.com/ubi9/nginx-126', site.registry);
  assert.ok(app.includes(`image: "${placeholder.ref}"`));
  assert.doesNotMatch(app, /^  monitor:/m, 'the placeholder does not expose a Workbench activity tracker');

  const openbao = splitDocs(renderRelease(ROOT, 'openbao', options));
  const bao = openbao.find((doc) => kindOf(doc) === 'StatefulSet');
  assert.match(bao, /^  replicas: 1$/m);
  assert.match(bao, /claimName: openbao-lab-tokens/);
  assert.match(bao, /mountPath: \/var\/lib\/softhsm\/tokens/);
  assert.match(bao, /secretName: openbao-tls/, 'the lab retains the TLS secret volume');
  assert.match(openbao.join('\n'), /lib\s*= "\/usr\/lib64\/softhsm\/libsofthsm2\.so"/);

  const realmSite = JSON.parse(readFileSync(path.join(siteDir, 'sterling-keycloak-realm.yaml'), 'utf8'));
  const { realm, problems } = prepareRealm({ site, realmSite });
  assert.deepEqual(problems, []);
  assert.equal(realm.webAuthnPolicyPasswordlessRpId, site.domain);
  assert.equal(realm.webAuthnPolicyPasswordlessAttestationConveyancePreference, 'none');
  assert.deepEqual(realm.clients.find(({ clientId }) => clientId === 'sterling-sessions').redirectUris, [
    `https://*.ws.${site.domain}/oauth2/callback`,
    `https://sessions.${site.domain}/*`,
  ]);
  for (const locale of ['en', 'fr']) assert.ok(realm.localizationTexts[locale][NOTICE_MESSAGE]);
  assert.match(realm.smtpServer.host, /\.invalid$/);
  const realmJob = splitDocs(renderRelease(ROOT, 'sterling-keycloak-realm', options)).find((doc) => kindOf(doc) === 'Job');
  assert.ok(realmJob, 'the lab values render the normal realm apply job');

  const theia = renderRelease(ROOT, 'theia-cloud', options);
  for (const prefix of ['sessions', 'sessions-api', 'ws']) assert.ok(theia.includes(`${prefix}.${site.domain}`), prefix);
  assert.ok(theia.includes(site.storageClass), 'Theia requests the lab static storage class');
});

test('the lab preview CLI validates every selected release and keeps its staging private and temporary', (t) => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-lab-preview-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const staging = path.join(scratch, 'staging');
  mkdirSync(staging);
  const preview = (key, helm = HELM) => spawnSync(process.execPath, [
    path.join(ROOT, 'deploy/lab/render.mjs'), '--public-key', key,
  ], { encoding: 'utf8', env: { ...process.env, HELM: helm, TMPDIR: staging } });

  const publicFile = path.join(scratch, 'public.pem');
  writeFileSync(publicFile, SITE.organizationPublicKey);
  const result = preview(publicFile);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes(SITE.organizationPublicKey.split('\n')[1]), 'the report omits the input key');
  const report = JSON.parse(result.stdout);
  assert.equal(report.preview, 'lab-core');
  assert.equal(report.registry, 'registry.lab.sterling.test:30500');
  assert.deepEqual(report.releases, [
    'zot', 'sterling-network', 'kyverno', 'sterling-admission', 'cert-manager', 'sterling-pki-bootstrap',
    'kubernetes-ingress', 'openbao', 'sterling-pki', 'sterling-postgres', 'sterling-keycloak-theme', 'keycloakx',
    'sterling-keycloak-realm', 'theia-cloud-crds', 'theia-cloud-base', 'theia-cloud', 'sterling-sessions', 'sterling-hub',
  ]);
  assert.equal(report.unpublishedImages.includes('sterling/openbao'),
    resolveImage(readImagesLock(ROOT), 'sterling/openbao', report.registry).unpublished);
  assert.match(report.unverified.join('\n'), /signed lab-only OpenBao/i);
  assert.match(report.unverified.join('\n'), /VM storage capacity/i);
  assert.match(report.unverified.join('\n'), /live install/i);
  assert.deepEqual(readdirSync(staging), [], 'successful preview removes its staging');

  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  for (const pem of [privatePem, 'fixture text that must stay private', SITE.organizationPublicKey.repeat(2)]) {
    const refusedFile = path.join(scratch, 'refused.pem');
    writeFileSync(refusedFile, pem, { mode: 0o600 });
    const refused = preview(refusedFile);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /one valid public PEM/i);
    for (const line of pem.trim().split('\n')) assert.ok(!refused.stderr.includes(line));
    assert.deepEqual(readdirSync(staging), [], 'invalid input leaves no staging');
  }

  const failedRender = preview(publicFile, path.join(scratch, 'missing-helm'));
  assert.equal(failedRender.status, 1);
  assert.equal(failedRender.stdout, '');
  assert.match(failedRender.stderr, /helm was not found/i);
  assert.deepEqual(readdirSync(staging), [], 'render failure removes its staging');
});

function labStorageFixture(t) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-lab-storage-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const publicFile = path.join(scratch, 'public.pem');
  const budgetFile = path.join(scratch, 'budget.json');
  writeFileSync(publicFile, SITE.organizationPublicKey);
  const budget = {
    usableMiB: 136,
    reserveMiB: 20,
    volumesMiB: {
      registry: 11, secrets: 12, secretSnapshots: 13, secretTokens: 14,
      identity: 15, identityDumps: 16, hub: 17, workspace: 18,
    },
  };
  const run = (value = budget, helm = HELM) => {
    writeFileSync(budgetFile, JSON.stringify(value));
    return spawnSync(process.execPath, [
      path.join(ROOT, 'deploy/lab/render.mjs'), '--public-key', publicFile, '--storage-plan', budgetFile,
    ], { encoding: 'utf8', env: { ...process.env, HELM: helm } });
  };
  return { budget, run, scratch };
}

test('the lab storage preview accounts for rendered requests and manual reservations at the budget boundary', (t) => {
  const { run } = labStorageFixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.storage, {
    usableMiB: 136, reserveMiB: 20, volumeMiB: 116, unallocatedMiB: 0,
    allocations: [
      { id: 'registry', namespace: 'sterling-registry', claim: 'zot-pvc-zot-0', miB: 11, source: 'rendered' },
      { id: 'secrets', namespace: 'sterling-openbao', claim: 'data-openbao-0', miB: 12, source: 'rendered' },
      { id: 'secretSnapshots', namespace: 'sterling-openbao', claim: 'openbao-snapshots', miB: 13, source: 'rendered' },
      { id: 'secretTokens', namespace: 'sterling-openbao', claim: 'openbao-lab-tokens', miB: 14, source: 'manual' },
      { id: 'identity', namespace: 'sterling-identity', claim: 'data-sterling-postgres-0', miB: 15, source: 'rendered' },
      { id: 'identityDumps', namespace: 'sterling-identity', claim: 'sterling-postgres-dumps', miB: 16, source: 'rendered' },
      { id: 'hub', namespace: 'sterling-hubs', claim: 'state-hub-lab-0', miB: 17, source: 'rendered' },
    ],
    reservation: { id: 'workspace', namespace: 'theia-cloud', miB: 18, retainedWorkspaces: 1 },
  });
  assert.match(report.unverified.join('\n'), /VM storage capacity/i);
  assert.match(report.unverified.join('\n'), /volume binding/i);
});

test('the lab storage preview refuses incomplete, oversized and underfunded plans before invoking Helm', (t) => {
  const { budget, run, scratch } = labStorageFixture(t);
  const noHelm = path.join(scratch, 'missing-helm');
  const { secretTokens, ...incomplete } = budget.volumesMiB;
  assert.equal(secretTokens, 14);
  for (const [value, message] of [
    [{ ...budget, volumesMiB: incomplete }, /storage plan.*volumesMiB/i],
    [{ ...budget, volumesMiB: { ...budget.volumesMiB, registry: 2 ** 43 } }, /storage plan.*registry/i],
    [{ ...budget, usableMiB: 135 }, /storage plan.*exceeds.*usable/i],
  ]) {
    const refused = run(value, noHelm);
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, message);
    assert.doesNotMatch(refused.stderr, /helm was not found/i);
  }
});

test('the lab storage preview refuses an unexpected rendered PVC reference', (t) => {
  const { run, scratch } = labStorageFixture(t);
  const fixtureHelm = path.join(scratch, 'fixture-helm');
  writeFileSync(fixtureHelm, [
    `#!${process.execPath}`,
    "const { spawnSync } = require('node:child_process');",
    `const result = spawnSync(${JSON.stringify(HELM)}, process.argv.slice(2), { encoding: 'utf8' });`,
    "process.stdout.write(result.stdout.replace('claimName: openbao-lab-tokens', 'claimName: unbudgeted-test-volume'));",
    "process.stderr.write(result.stderr);",
    "process.exitCode = result.status;",
  ].join('\n'), { mode: 0o700 });
  const refused = run(undefined, fixtureHelm);
  assert.equal(refused.status, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /unbudgeted-test-volume/);
});
