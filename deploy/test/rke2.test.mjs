// The RKE2 node files and the namespace egress coverage (D-14, D-26, D-41, D-01). Reads the node files as text: the audit policy records
// Theia Cloud records and never a Secret body, Pod Security is restricted with exactly six exempt namespaces, the server config keeps the CIS
// profile, Canal, no bundled ingress and secrets encryption, registries.yaml mirrors only to the site registry, and k3s never appears in
// production files. The coverage test renders sterling-network and fails when a release's namespace has no egress policy (needs helm).
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');
const HELM = process.env.HELM || 'helm';

/** The lines of a YAML file with comments and blank lines removed. */
const lines = (text) => text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));

/** The audit rules as [{ level, block }] where block is the rule's own lines (each rule starts with "  - level:"). */
function auditRules(text) {
  const rules = [];
  for (const line of lines(text)) {
    const start = /^ {2}- level:[ \t]*(\S+)/.exec(line);
    if (start) rules.push({ level: start[1], block: [] });
    else if (rules.length && line.startsWith('    ')) rules.at(-1).block.push(line.trim());
  }
  return rules;
}

test('the audit policy records Theia Cloud writes at Request and Secrets and ConfigMaps at Metadata only', () => {
  const text = read('deploy/rke2/audit-policy.yaml');
  assert.match(text, /^omitStages:\n {2}- RequestReceived$/m);
  const rules = auditRules(text);
  const theia = rules.find((rule) => rule.block.includes('- group: theia.cloud'));
  assert.ok(theia, 'a rule for the theia.cloud group');
  assert.equal(theia.level, 'Request');
  for (const resource of ['sessions', 'workspaces', 'appdefinitions']) assert.ok(theia.block.some((line) => line.includes(resource)), `theia.cloud ${resource}`);
  assert.ok(theia.block.some((line) => /verbs:.*create.*update.*patch.*delete/.test(line)), 'the theia.cloud rule covers writes');
  const secrets = rules.find((rule) => rule.block.some((line) => /resources:.*\bsecrets\b/.test(line)));
  assert.ok(secrets, 'a rule for secrets');
  assert.equal(secrets.level, 'Metadata', 'a Secret body is never recorded');
  assert.ok(secrets.block.some((line) => /\bconfigmaps\b/.test(line)) && secrets.block.some((line) => /\btokenreviews\b/.test(line)));
  // Secrets match nothing before their Metadata rule that could record more (rules apply in order, first match wins).
  for (const rule of rules.slice(0, rules.indexOf(secrets))) {
    assert.ok(rule.level === 'None' || rule.block.some((line) => line.startsWith('- group:')), `rule ${rule.level} before the secrets rule must be a narrow group rule`);
  }
  assert.equal(rules.at(-1).level, 'Metadata', 'everything else at Metadata');
  assert.equal(rules.at(-1).block.length, 0, 'the last rule matches everything');
});

test('Pod Security enforces restricted everywhere except exactly six namespaces', () => {
  const text = read('deploy/rke2/psa.yaml');
  for (const mode of ['enforce', 'audit', 'warn']) {
    assert.match(text, new RegExp(`^ +${mode}: restricted$`, 'm'));
    assert.match(text, new RegExp(`^ +${mode}-version: latest$`, 'm'));
  }
  const listed = /^ +namespaces: \[([^\]]*)\]$/m.exec(text);
  assert.ok(listed, 'the exemption namespaces are one flow list');
  const namespaces = listed[1].split(',').map((name) => name.trim()).filter(Boolean);
  assert.deepEqual(namespaces.sort(), ['cis-operator-system', 'kube-system', 'longhorn-system', 'sterling-log-shipper', 'sterling-monitoring', 'tigera-operator']);
  assert.match(text, /^ +usernames: \[\]$/m);
  assert.match(text, /^ +runtimeClasses: \[\]$/m);
});

test('the server config keeps the CIS profile, Canal, no bundled ingress, secrets encryption, audit, Pod Security and snapshots', () => {
  const config = lines(read('deploy/rke2/config.yaml'));
  for (const setting of ['profile: cis', 'cni: canal', 'ingress-controller: none', 'secrets-encryption: true', 'disable-default-registry-endpoint: true',
    'audit-policy-file: /etc/rancher/rke2/audit-policy.yaml', 'pod-security-admission-config-file: /etc/rancher/rke2/psa.yaml']) {
    assert.ok(config.includes(setting), `config.yaml: ${setting}`);
  }
  assert.ok(config.some((line) => /^etcd-snapshot-schedule-cron: "[^"]+"$/.test(line)));
  assert.ok(config.some((line) => /^etcd-snapshot-retention: \d+$/.test(line)));
  for (const arg of ['audit-log-path=', 'audit-log-maxage=', 'audit-log-maxbackup=', 'audit-log-maxsize=']) {
    assert.ok(config.some((line) => line.includes(`"${arg}`)), `kube-apiserver-arg ${arg}`);
  }
});

test('registries.yaml mirrors only to the site registry', () => {
  const text = read('deploy/rke2/registries.yaml');
  const endpoints = lines(text).filter((line) => /^ +- "/.test(line)).map((line) => line.trim());
  assert.deepEqual(endpoints, ['- "https://${site.registry}"']);
  assert.match(text, /^ {2}"\$\{site\.registry\}":$/m);
  assert.doesNotMatch(text, /docker\.io|quay\.io|ghcr\.io|registry-1\./);
});

test('k3s appears in no production node or values file (D-14)', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      const file = `${dir}/${name}`;
      if (statSync(path.join(ROOT, file)).isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk('deploy/rke2');
  walk('deploy/values');
  assert.ok(files.length > 10);
  for (const file of files) assert.doesNotMatch(read(file), /k3s/i, `${file} names k3s`);
});

/** The namespaces listed in deploy/values/sterling-network.yaml, read line by line (`  - name: <ns>`). */
function networkNamespaces() {
  return lines(read('deploy/values/sterling-network.yaml')).map((line) => /^ {2}- name: ([a-z0-9-]+)$/.exec(line)?.[1]).filter(Boolean);
}

test('every namespace a release uses has an egress policy entry (D-01)', () => {
  const listed = new Set(networkNamespaces());
  const missing = listReleases(ROOT).map((release) => release.namespace).filter((namespace) => !listed.has(namespace));
  assert.deepEqual([...new Set(missing)], [], 'release namespaces missing from deploy/values/sterling-network.yaml');
});

test('the rendered network release has one site-only egress policy per namespace and no open rule', () => {
  const site = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
  const docs = splitDocs(renderRelease(ROOT, 'sterling-network', { site, helm: HELM }));
  const policies = docs.filter((doc) => /^kind: NetworkPolicy$/m.test(doc));
  const namespaces = networkNamespaces();
  assert.ok(namespaces.length >= 12);
  assert.equal(policies.length, namespaces.length);
  for (const namespace of namespaces) {
    const policy = policies.find((doc) => doc.includes(`  namespace: ${namespace}\n`));
    assert.ok(policy, `an egress policy in ${namespace}`);
    assert.match(policy, /^ {2}name: egress-site-only$/m);
    assert.match(policy, /^ {2}podSelector: \{\}$/m);
    assert.match(policy, /^ {2}policyTypes:\n {4}- Egress$/m);
    assert.doesNotMatch(policy, /0\.0\.0\.0\/0|::\/0/, `${namespace}: an open egress rule`);
    const cidrs = [...policy.matchAll(/cidr: "?([^"\s]+)"?/g)].map((match) => match[1]);
    assert.deepEqual(cidrs.sort(), [site.clusterCidrs.pod, site.clusterCidrs.service, site.clusterCidrs.nodes, ...site.egressAllow].sort());
  }
  const created = docs.filter((doc) => /^kind: Namespace$/m.test(doc));
  assert.ok(!created.some((doc) => /name: sterling-registry$/m.test(doc)), 'sterling-registry exists before this release');
  const exempt = new Set(['longhorn-system', 'sterling-log-shipper', 'sterling-monitoring']);
  for (const doc of created) {
    const name = /^ {2}name: (\S+)$/m.exec(doc)[1];
    const level = exempt.has(name) ? 'privileged' : 'restricted';
    assert.match(doc, new RegExp(`pod-security\\.kubernetes\\.io/enforce: "?${level}"?$`, 'm'), `${name} Pod Security ${level}`);
  }
});

test('admission exempts only the Zot pod, by its exact pinned digest in its own namespace, never on a Harbor site, and refuses a wider exception', () => {
  const site = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
  const render = (siteFile = site) => splitDocs(renderRelease(ROOT, 'sterling-admission', { site: siteFile, helm: HELM }));
  const named = (docs, name) => docs.find((doc) => new RegExp(`^ {2}name: ${name}$`, 'm').test(doc));
  // The registry pod as the zot release renders it: the one reference the exception may name.
  const zot = splitDocs(renderRelease(ROOT, 'zot', { site, helm: HELM })).find((doc) => /^kind: StatefulSet$/m.test(doc));
  const zotImages = [...zot.matchAll(/^\s+image: "?([^\s"]+)"?$/gm)].map((match) => match[1]);
  assert.equal(zotImages.length, 1);
  assert.ok(zotImages[0].startsWith(`${site.registry}/`), 'served by the site registry');
  assert.match(zotImages[0], /@sha256:[0-9a-f]{64}$/);
  const docs = render();
  const signed = named(docs, 'site-images-signed');
  assert.equal((signed.match(/^ {2}matchConditions:$/gm) ?? []).length, 1);
  const conditions = [...signed.matchAll(/^ {6}expression: (".*")$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(conditions.length, 1, 'one match condition');
  const [condition] = conditions;
  assert.deepEqual([...condition.matchAll(/request\.namespace == '([^']*)'/g)].map((match) => match[1]), ['sterling-registry'], 'exactly one namespace');
  assert.deepEqual([...condition.matchAll(/c\.image == '([^']*)'/g)].map((match) => match[1]), zotImages, 'exactly the one pinned Zot image');
  assert.ok(condition.startsWith("!(request.namespace == 'sterling-registry' && object.spec.containers.all(c, c.image == '"), 'skipped only when every container is that image');
  assert.ok(condition.includes('(!has(object.spec.initContainers) || size(object.spec.initContainers) == 0)'), 'no init container rides along');
  assert.ok(condition.includes('(!has(object.spec.ephemeralContainers) || size(object.spec.ephemeralContainers) == 0)'), 'no ephemeral container rides along');
  assert.equal((condition.match(/\|\|/g) ?? []).length, 2, 'the only alternatives are the two empty-list checks');
  assert.doesNotMatch(condition, /startsWith|endsWith|matches\(|contains\(|\*/, 'equality only, no pattern');
  // The signature check itself and the registry-only policy are unchanged.
  assert.match(signed, /validationActions: \[Deny\]\n\s+failurePolicy: Fail/);
  assert.match(signed, /verifyImageSignatures\(image, \[attestors\.organization\]\)/);
  assert.doesNotMatch(named(docs, 'site-registry-only'), /matchConditions/);
  // A Harbor site has no exception at all.
  assert.ok(!render({ ...site, registryKind: 'harbor' }).some((doc) => doc.includes('matchConditions')), 'Harbor: no exception');
  // A reference without a digest, outside the site registry or with a pattern, or an excluded namespace, stops the render.
  const descriptor = listReleases(ROOT).find((item) => item.name === 'sterling-admission');
  const split = zotImages[0].lastIndexOf(':', zotImages[0].indexOf('@'));
  const [name, tagAtDigest] = [zotImages[0].slice(0, split), zotImages[0].slice(split + 1)];
  const scratch = mkdtempSync(path.join(tmpdir(), 'admission-'));
  try {
    for (const [index, registryPod] of [
      { image: { name, tagAtDigest: tagAtDigest.split('@')[0] } },
      { image: { name: name.replace(site.registry, 'docker.io'), tagAtDigest } },
      { image: { name: `${name}*`, tagAtDigest } },
      { namespace: 'kube-system', image: { name, tagAtDigest } },
    ].entries()) {
      const file = path.join(scratch, `pod-${index}.yaml`);
      writeFileSync(file, JSON.stringify({ registryPod }));
      const values = [...descriptor.values, path.relative(ROOT, file)];
      assert.throws(() => renderRelease(ROOT, { ...descriptor, images: [], values }, { site, helm: HELM }), /registryPod/, JSON.stringify(registryPod));
    }
    // The same values with the lock's own reference render (so each refusal above is the change it names).
    const good = path.join(scratch, 'pod-good.yaml');
    writeFileSync(good, JSON.stringify({ registryPod: { image: { name, tagAtDigest } } }));
    assert.match(renderRelease(ROOT, { ...descriptor, images: [], values: [...descriptor.values, path.relative(ROOT, good)] }, { site, helm: HELM }), /matchConditions/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
