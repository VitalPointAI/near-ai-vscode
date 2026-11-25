// Alerts as code (48.1-02, D-16; AU-5, SI-4(5)), on the rendered stack: Alertmanager runs from the lock by digest and mails only the site's own
// mail server; the rules in deploy/values/prometheus-alerts.yaml (JSON syntax) alert on OpenBao sealed or its audit device failing and on
// audit shipping failures, each with a severity, a summary and a runbook link; and every alert input has a guard, so a missing or renamed
// input raises an alert instead of leaving its rule silent. Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Every RegExp metacharacter escaped, backslash included, so a site value is matched literally. */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const ALERTS_FILE = 'deploy/values/prometheus-alerts.yaml';
const RUNBOOK = 'docs/security/hosted-audit.md';
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
const nameOf = (doc) => /^ {2}name:[ \t]*(\S+)/m.exec(doc)?.[1];
const render = (name) => splitDocs(renderRelease(ROOT, listReleases(ROOT).find((release) => release.name === name), { site: SITE, helm: HELM }));
const alertsFile = () => JSON.parse(readFileSync(path.join(ROOT, ALERTS_FILE), 'utf8'));
const rulesOf = (doc) => doc.serverFiles['alerting_rules.yml'].groups.flatMap((group) => group.rules.map((rule) => ({ ...rule, group: group.name })));

/**
 * The guard invariant (D-16): every source an alert reads has a guard rule (labels.guard "true") on the source's scrape target (an expression
 * over `up{...}`), or absent() on a series listed in startSeries (gauges present from start). absent() never names any other series, because
 * a counter that appears after its first event would make it fire on a healthy site.
 */
function guardProblems(doc) {
  const problems = [];
  const start = new Set(Object.keys(doc.startSeries ?? {}));
  const rules = rulesOf(doc);
  for (const rule of rules) {
    if (!rule.labels?.source) problems.push(`${rule.alert}: no source label`);
    for (const match of rule.expr.matchAll(/absent\(\s*([a-zA-Z_:][a-zA-Z0-9_:]*)/g)) {
      if (match[1] !== 'up' && !start.has(match[1])) problems.push(`${rule.alert}: absent() on ${match[1]}, which is not a series present from start`);
    }
    if (rule.labels?.guard === 'true' && !/\bup\{/.test(rule.expr) && ![...rule.expr.matchAll(/absent\(\s*([a-zA-Z_:][a-zA-Z0-9_:]*)/g)].some((match) => start.has(match[1]))) {
      problems.push(`${rule.alert}: a guard must test the scrape target (up) or the absence of a series present from start`);
    }
  }
  for (const source of new Set(rules.filter((rule) => rule.labels?.guard !== 'true').map((rule) => rule.labels?.source))) {
    if (!rules.some((rule) => rule.labels?.guard === 'true' && rule.labels?.source === source)) problems.push(`source ${source} has no guard rule`);
  }
  return problems;
}

let prometheus;
let openbao;
let fluentBit;
before(() => { prometheus = render('prometheus'); openbao = render('openbao'); fluentBit = render('fluent-bit'); });

test('one Alertmanager runs from the lock by digest, and its only receiver mails the site mail server', () => {
  const lock = resolveImage(readImagesLock(ROOT), 'quay.io/prometheus/alertmanager', SITE.registry);
  assert.ok(lock, 'the Alertmanager image is in the lock');
  const workloads = prometheus.filter((doc) => /^kind: (StatefulSet|Deployment)$/m.test(doc) && /alertmanager/.test(nameOf(doc) ?? ''));
  assert.equal(workloads.length, 1, 'exactly one Alertmanager workload');
  assert.ok(workloads[0].includes(`image: "${lock.registry}/${lock.repository}:${lock.tag}@${lock.digest}"`), 'the Alertmanager image by digest from the site registry');
  const config = prometheus.filter((doc) => kindOf(doc) === 'ConfigMap' && /alertmanager/.test(nameOf(doc) ?? '')).join('\n');
  const realm = JSON.parse(readFileSync(path.join(ROOT, 'deploy/values/site.example/sterling-keycloak-realm.yaml'), 'utf8'));
  const mailServer = `${realm.smtp.host.replace('${site.domain}', SITE.domain)}:${realm.smtp.port}`;
  assert.match(config, new RegExp(`smtp_smarthost: ${escapeRegExp(mailServer)}`), 'the smarthost is the realm mail server of the site');
  assert.match(config, /smtp_require_tls: true/);
  const kinds = [...config.matchAll(/^[\s-]+([a-z0-9]+)_configs:/gm)].map((match) => match[1]);
  assert.deepEqual([...new Set(kinds)], ['email'], 'email is the only receiver kind: no webhook, chat or remote receiver');
  assert.match(config, new RegExp(`\\bto: ${escapeRegExp(SITE.alertRecipients)}$`, 'm'), 'mail goes to the site file\'s recipients');
  assert.match(config, /receiver: site-security-operators/);
});

test('a site file without alert recipients is refused, never sent nowhere', () => {
  const { alertRecipients: _recipients, ...without } = SITE;
  assert.throws(() => renderRelease(ROOT, listReleases(ROOT).find((release) => release.name === 'prometheus'), { site: without, helm: HELM }), /alertRecipients/);
});

test('OpenBao sealed and its audit device failing raise alerts with a severity, a summary and the review runbook', () => {
  const rules = rulesOf(alertsFile());
  for (const name of ['OpenBaoSealed', 'OpenBaoAuditDeviceFailing']) {
    const rule = rules.find((entry) => entry.alert === name);
    assert.ok(rule, name);
    assert.match(rule.labels.severity, /^(critical|warning)$/, `${name} severity`);
    assert.ok(rule.annotations.summary, `${name} summary`);
    assert.ok(rule.annotations.runbook.startsWith(RUNBOOK), `${name} runbook`);
  }
  assert.match(rules.find((entry) => entry.alert === 'OpenBaoSealed').expr, /vault_core_unsealed\b.*== 0/);
  assert.match(rules.find((entry) => entry.alert === 'OpenBaoAuditDeviceFailing').expr, /vault_audit_log_request_failure/);
  // The rules reach the rendered Prometheus configuration through the release descriptor.
  const server = prometheus.find((doc) => kindOf(doc) === 'ConfigMap' && nameOf(doc) === 'prometheus-server');
  for (const rule of rules) assert.match(server, new RegExp(`alert: ${rule.alert}\\b`), `${rule.alert} is rendered`);
  assert.match(server, /alerting:\n\s+alertmanagers:/, 'Prometheus sends alerts to Alertmanager');
});

test('every alert source has a guard, and absent() is never used on a series that appears only after an event', () => {
  const doc = alertsFile();
  assert.deepEqual(guardProblems(doc), []);
  const sources = new Set(rulesOf(doc).map((rule) => rule.labels.source));
  for (const source of ['openbao', 'fluent-bit']) assert.ok(sources.has(source), source);
  // The check itself reports an unguarded source and absent() on an event counter.
  const unguarded = { serverFiles: { 'alerting_rules.yml': { groups: [{ name: 'x', rules: [{ alert: 'A', expr: 'foo == 0', labels: { source: 'x' } }] }] } } };
  assert.match(guardProblems(unguarded).join('\n'), /source x has no guard rule/);
  const counter = { startSeries: {}, serverFiles: { 'alerting_rules.yml': { groups: [{ name: 'x', rules: [
    { alert: 'A', expr: 'increase(vault_audit_log_request_failure[5m]) > 0', labels: { source: 'x' } },
    { alert: 'B', expr: 'absent(vault_audit_log_request_failure)', labels: { source: 'x', guard: 'true' } }] }] } } };
  assert.match(guardProblems(counter).join('\n'), /absent\(\) on vault_audit_log_request_failure/);
});

test('OpenBao turns telemetry on for a metrics-only TLS listener, and the site Prometheus reads it with the site CA', () => {
  const config = openbao.filter((doc) => kindOf(doc) === 'ConfigMap').join('\n');
  assert.match(config, /telemetry \{\n\s+prometheus_retention_time\s+= "[0-9]+[smh]"\n\s+disable_hostname\s+= true/);
  const listener = /listener "tcp" \{\s*address\s+= "\[::\]:9101"[\s\S]*?\n\s*\}\n\s*\}/.exec(config)?.[0] ?? '';
  assert.match(listener, /metrics_only\s+= true/, 'the metrics listener serves metrics only');
  assert.match(listener, /unauthenticated_metrics_access = true/);
  assert.match(listener, /tls_cert_file\s+= "\/openbao\/userconfig\/openbao-tls\/tls\.crt"/, 'the metrics listener keeps TLS');
  const server = prometheus.find((doc) => kindOf(doc) === 'ConfigMap' && nameOf(doc) === 'prometheus-server');
  const job = /- job_name: openbao\n([\s\S]*?)(?=\n {4}- job_name:|\n {2}[a-z_]+\.yml:|$)/.exec(server)?.[1] ?? '';
  assert.match(job, /scheme: https/);
  assert.match(job, /ca_file: \/etc\/sterling-site-ca\/ca\.crt/);
  assert.doesNotMatch(job, /insecure_skip_verify: true/);
  assert.match(job, /format:\n\s+- prometheus/);
  const deployment = prometheus.find((doc) => kindOf(doc) === 'Deployment' && nameOf(doc) === 'prometheus-server');
  assert.match(deployment, /mountPath: \/etc\/sterling-site-ca/);
  const pki = JSON.stringify(readFileSync(path.join(ROOT, 'deploy/values/sterling-pki.yaml'), 'utf8'));
  assert.match(pki, /- sterling-monitoring/, 'the site CA ConfigMap reaches the monitoring namespace');
});

test('Fluent Bit output failures and audit records not reaching the store raise alerts guarded by the scrape target', () => {
  const rules = rulesOf(alertsFile());
  const failing = rules.find((rule) => rule.alert === 'FluentBitOutputFailing');
  const still = rules.find((rule) => rule.alert === 'AuditRecordsNotReachingStore');
  assert.ok(failing && still);
  assert.match(failing.expr, /fluentbit_output_errors_total/);
  assert.match(failing.expr, /fluentbit_output_retries_failed_total/);
  assert.match(still.expr, /fluentbit_output_proc_records_total\{[^}]*name="site_opensearch"[^}]*\}\[30m\]/);
  assert.match(still.expr, /fluentbit_input_records_total\{[^}]*name="audit_kubernetes"[^}]*\}\[30m\]/);
  for (const rule of [failing, still]) assert.equal(rule.labels.source, 'fluent-bit');
  const guards = rules.filter((rule) => rule.labels.source === 'fluent-bit' && rule.labels.guard === 'true');
  assert.ok(guards.length >= 1 && guards.every((rule) => /\bup\{[^}]*namespace="sterling-log-shipper"/.test(rule.expr)), 'target-up guards only (the error counters appear after the first error)');
});

test('Fluent Bit exposes metrics on its built-in HTTP server with scrape annotations, and names its audit input and its one output', () => {
  const daemonSet = fluentBit.find((doc) => kindOf(doc) === 'DaemonSet');
  assert.match(daemonSet, /prometheus\.io\/scrape: "true"/);
  assert.match(daemonSet, /prometheus\.io\/port: "2020"/);
  assert.match(daemonSet, /prometheus\.io\/path: \/api\/v2\/metrics\/prometheus/);
  const config = fluentBit.filter((doc) => kindOf(doc) === 'ConfigMap').join('\n');
  assert.match(config, /HTTP_Server +On/);
  assert.match(config, /HTTP_Port +2020/);
  assert.match(config, /Alias +audit_kubernetes/);
  assert.match(config, /Alias +site_opensearch/);
  assert.doesNotMatch(config, /Hot_Reload +On/i, 'no reload endpoint');
});

test('D-26 (G467): a session blocked for claiming too many computer places raises an alert from OpenBao\'s own violation counter', async () => {
  const { COMPUTER_PLACES_QUOTA } = await import('../openbao/apply.mjs');
  const rule = rulesOf(alertsFile()).find((entry) => entry.alert === 'ComputerPlaceClaimsLimited');
  assert.ok(rule, 'the rule exists');
  assert.match(rule.expr, new RegExp(`vault_quota_rate_limit_violation\\{[^}]*name="${COMPUTER_PLACES_QUOTA.name}"`));
  assert.match(rule.expr, /increase\(/, 'a counter that appears after its first violation, read with increase()');
  assert.doesNotMatch(rule.expr, /absent\(/);
  assert.equal(rule.labels.source, 'openbao', 'guarded by the OpenBao scrape target guards');
  assert.ok(rule.annotations.runbook.startsWith(RUNBOOK));
  assert.match(rule.annotations.description, new RegExp(`more than ${COMPUTER_PLACES_QUOTA.rate} computer places in an hour`));
  assert.deepEqual(guardProblems(alertsFile()), []);
  assert.match(prometheus.join('\n'), /alert: ComputerPlaceClaimsLimited\b/, 'rendered into the site Prometheus');
});
