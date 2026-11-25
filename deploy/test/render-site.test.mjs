// Site storage, logs, metrics and the HQ registry, on the rendered stack (D-15, D-17, D-19, D-26, D-35): every storage class encrypts at
// rest, Fluent Bit ships to the site's own OpenSearch only, Prometheus writes nowhere else, and Harbor is behind site TLS with no internet
// scanner. Renders every release with the CI site (all releases, whatever enabledWhen says). Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { listReleases, loadSite, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';

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
