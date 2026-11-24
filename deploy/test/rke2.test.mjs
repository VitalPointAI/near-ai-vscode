// The RKE2 node files and the namespace egress coverage (D-14, D-26, D-41, D-01). Reads the node files as text: the audit policy records
// Theia Cloud records and never a Secret body, Pod Security is restricted with exactly six exempt namespaces, the server config keeps the CIS
// profile, Canal, no bundled ingress and secrets encryption, registries.yaml mirrors only to the site registry, and k3s never appears in
// production files. The coverage test renders sterling-network and fails when a release's namespace has no egress policy (needs helm).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8');

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
