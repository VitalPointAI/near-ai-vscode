// The maintenance checks (47-28, D-75) on kubectl fixtures: cert-check, drain-check and upgrade-check refuse before harm. No cluster; the
// test certificates are made with the host's openssl.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { certCheck, compareVersions, drainCheck, parseRke2Version, upgradeCheck } from '../bundle/maintenance.mjs';

const NOW = Date.parse('2026-11-24T12:00:00Z');
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(NOW + offsetDays * DAY).toISOString();

/** A self-signed test certificate valid `days` days from now (openssl), as PEM. */
function certificate(days, subject = '/CN=Sterling test CA') {
  const dir = mkdtempSync(path.join(tmpdir(), 'maint-cert-'));
  const run = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', path.join(dir, 'k'),
    '-out', path.join(dir, 'c'), '-days', String(days), '-subj', subject], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return readFileSync(path.join(dir, 'c'), 'utf8');
}

/** A fake kubectl answering `get <kind>` from `world` ({ kind: object or { items } }); missing kinds answer NotFound. */
function kubectl(world) {
  const calls = [];
  const run = (command, args) => {
    calls.push(args);
    const key = args[1] === 'cronjob' || args[1] === 'configmap' ? `${args[1]}/${args[2]}` : args[1];
    if (!(key in world)) return { status: 1, stdout: '', stderr: `Error from server (NotFound): ${key} not found` };
    const value = world[key];
    return { status: 0, stdout: JSON.stringify(value.items || !Array.isArray(value) ? value : { items: value }), stderr: '' };
  };
  return { run, calls };
}
const ready = (status = 'True') => ({ conditions: [{ type: 'Ready', status }] });
const cert = (name, status) => ({ metadata: { name, namespace: 'sterling-identity' }, status: { ...ready(), notAfter: iso(60), renewalTime: iso(20), ...status } });

test('cert-check passes a Ready certificate that renews in time', () => {
  const { run } = kubectl({ 'certificates.cert-manager.io': [cert('keycloak-tls')], 'configmap/sterling-site-ca': { data: { 'ca.crt': certificate(400) } } });
  assert.deepEqual(certCheck({ run, now: NOW, apiCertificate: null }).problems, []);
});

test('cert-check names a certificate that is not Ready', () => {
  const { run } = kubectl({ 'certificates.cert-manager.io': [cert('keycloak-tls', ready('False'))], 'configmap/sterling-site-ca': { data: { 'ca.crt': '' } } });
  assert.match(certCheck({ run, now: NOW }).problems.join('\n'), /certificate sterling-identity\/keycloak-tls is not Ready/);
});

test('cert-check names a certificate overdue for renewal and one within 7 days of expiry', () => {
  const { run } = kubectl({ 'certificates.cert-manager.io': [cert('hub-a-tls', { renewalTime: iso(-1), notAfter: iso(3) })], 'configmap/sterling-site-ca': { data: { 'ca.crt': '' } } });
  const text = certCheck({ run, now: NOW }).problems.join('\n');
  assert.match(text, /hub-a-tls is overdue for renewal/);
  assert.match(text, /hub-a-tls expires .* within 7 days/);
});

test('cert-check names a site CA chain certificate inside the horizon with the key ceremony action', () => {
  // A 30-day intermediate signed by a 400-day root, and a 40-day root on its own.
  const dir = mkdtempSync(path.join(tmpdir(), 'maint-chain-'));
  const at = (name) => path.join(dir, name);
  const openssl = (args) => assert.equal(spawnSync('openssl', args, { encoding: 'utf8' }).status, 0, args.join(' '));
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', at('root.key'), '-out', at('root.crt'), '-days', '400', '-subj', '/CN=HQ root']);
  openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', at('int.key'), '-out', at('int.csr'), '-subj', '/CN=Sterling site intermediate']);
  openssl(['x509', '-req', '-in', at('int.csr'), '-CA', at('root.crt'), '-CAkey', at('root.key'), '-CAcreateserial', '-days', '30', '-out', at('int.crt')]);
  const chain = readFileSync(at('int.crt'), 'utf8') + readFileSync(at('root.crt'), 'utf8');
  const { run } = kubectl({ 'certificates.cert-manager.io': [], 'configmap/sterling-site-ca': { data: { 'ca.crt': chain } } });
  const at90 = certCheck({ run, now: Date.now(), horizonDays: 90 }).problems;
  assert.equal(at90.length, 1);
  assert.match(at90[0], /site intermediate \(CN=Sterling site intermediate\) expires .* in (29|30) days \(horizon 90\): renew it through the key ceremony: pki-files\.mjs csr/);
  assert.deepEqual(certCheck({ run, now: Date.now(), horizonDays: 10 }).problems, []);
  const root = kubectl({ 'certificates.cert-manager.io': [], 'configmap/sterling-site-ca': { data: { 'ca.crt': certificate(40, '/CN=HQ root') } } });
  assert.match(certCheck({ run: root.run, now: Date.now(), horizonDays: 90 }).problems[0], /HQ root \(CN=HQ root\) .*renew it in HQ's key ceremony/);
});

test('cert-check names the API server certificate inside the horizon with the RKE2 renewal action', () => {
  const { run } = kubectl({ 'certificates.cert-manager.io': [], 'configmap/sterling-site-ca': { data: { 'ca.crt': '' } } });
  const api = new X509Certificate(certificate(60, '/CN=kube-apiserver'));
  const problems = certCheck({ run, now: Date.now(), apiCertificate: api, horizonDays: 90 }).problems;
  assert.match(problems.join('\n'), /API server certificate expires .*restart rke2-server on each server, one at a time .*within 120 days.*rke2 certificate rotate/);
  assert.deepEqual(certCheck({ run, now: Date.now(), apiCertificate: api, horizonDays: 30 }).problems, []);
});

const node = (name, { etcd = true, isReady = true, version = 'v1.37.2+rke2r1' } = {}) => ({
  metadata: { name, labels: etcd ? { 'node-role.kubernetes.io/etcd': 'true' } : {} }, status: { ...ready(isReady ? 'True' : 'False'), nodeInfo: { kubeletVersion: version } },
});
const pod = (name, nodeName, isReady = true) => ({ metadata: { name }, spec: { nodeName }, status: ready(isReady ? 'True' : 'False') });
const LONGHORN = { storageProvider: 'longhorn' };
const world = (extra = {}) => ({
  nodes: [node('n1'), node('n2'), node('n3')], pods: [], 'replicas.longhorn.io': [], 'volumes.longhorn.io': [], ...extra,
});

test('drain-check refuses breaking etcd quorum and allows a drain that keeps a majority', () => {
  assert.deepEqual(drainCheck({ run: kubectl(world()).run, node: 'n1', site: LONGHORN }).problems, []);
  const down = drainCheck({ run: kubectl(world({ nodes: [node('n1'), node('n2', { isReady: false }), node('n3')] })).run, node: 'n1', site: LONGHORN });
  assert.match(down.problems.join('\n'), /draining n1 leaves 1 Ready etcd server of 3; etcd needs 2 to keep quorum/);
  assert.match(drainCheck({ run: kubectl(world({ nodes: [node('solo')] })).run, node: 'solo', site: LONGHORN }).problems[0], /leaves 0 Ready etcd servers of 1/);
});

test('drain-check refuses taking an OpenBao server while another is not Ready', () => {
  const pods = [pod('openbao-0', 'n1'), pod('openbao-1', 'n2', false), pod('openbao-2', 'n3')];
  const fake = kubectl(world({ pods }));
  assert.match(drainCheck({ run: fake.run, node: 'n1', site: LONGHORN }).problems.join('\n'), /n1 runs an OpenBao server while openbao-1 is not Ready/);
  assert.ok(fake.calls.some((args) => args.join(' ').startsWith('get pods -n sterling-openbao -l app.kubernetes.io/name=openbao,component=server')));
  assert.deepEqual(drainCheck({ run: kubectl(world({ pods: [pod('openbao-0', 'n1'), pod('openbao-1', 'n2')] })).run, node: 'n1', site: LONGHORN }).problems, []);
});

test('drain-check refuses removing a volume\'s only healthy replica, warns for a degraded one, and skips Longhorn on other storage', () => {
  const replica = (volumeName, nodeID, state = 'running', failedAt = '') => ({ metadata: { name: `${volumeName}-${nodeID}` }, spec: { volumeName, nodeID, failedAt }, status: { currentState: state } });
  const replicas = [replica('only', 'n1'), replica('only', 'n2', 'stopped'), replica('deg', 'n1'), replica('deg', 'n2'), replica('deg', 'n3', 'error', iso(-1))];
  const volumes = [{ metadata: { name: 'only' }, status: { robustness: 'degraded' } }, { metadata: { name: 'deg' }, status: { robustness: 'degraded' } }];
  const result = drainCheck({ run: kubectl(world({ 'replicas.longhorn.io': replicas, 'volumes.longhorn.io': volumes })).run, node: 'n1', site: LONGHORN });
  assert.deepEqual(result.problems, ['volume only has its only healthy replica on n1; wait until Longhorn rebuilds a replica on another node.']);
  assert.ok(result.warnings.includes('volume deg is degraded; it keeps 1 healthy replica elsewhere.'));
  const other = drainCheck({ run: kubectl(world()).run, node: 'n1', site: { storageProvider: 'ceph' } });
  assert.match(other.warnings.join('\n'), /the Longhorn rule was skipped: storageProvider is ceph/);
});

test('drain-check warns with the hubs and the number of sessions the drain interrupts', () => {
  const run = (command, args) => {
    if (args.includes('sterling-hubs')) return { status: 0, stdout: JSON.stringify({ items: [pod('sterling-hub-hub-a-0', 'n1'), pod('sterling-hub-hub-b-0', 'n2')] }) };
    if (args.includes('theia-cloud')) return { status: 0, stdout: JSON.stringify({ items: [pod('s1', 'n1'), pod('s2', 'n1'), pod('s3', 'n2')] }) };
    return kubectl(world()).run(command, args);
  };
  const { warnings, problems } = drainCheck({ run, node: 'n1', site: LONGHORN });
  assert.deepEqual(problems, []);
  assert.ok(warnings.includes('draining n1 restarts the hub sterling-hub-hub-a-0.'));
  assert.ok(warnings.includes('draining n1 stops 2 sessions; tell the people first.'));
});

const manifest = (version) => ({ items: [{ kind: 'tool', name: 'rke2.linux-amd64.tar.gz', digest: `sha256:${'a'.repeat(64)}`, ...(version ? { version } : {}) }] });
const fresh = {
  'etcdsnapshotfiles.k3s.cattle.io': [{ status: { creationTime: iso(-0.1) } }],
  'cronjob/openbao-raft-snapshot': { status: { lastSuccessfulTime: iso(-0.2) } },
  'cronjob/sterling-postgres-dump': { status: { lastSuccessfulTime: iso(-0.3) } },
  'certificates.cert-manager.io': [], 'configmap/sterling-site-ca': { data: { 'ca.crt': '' } },
};

test('upgrade-check refuses a missing version, a downgrade, a skipped minor version, a node not Ready and mixed versions', () => {
  const check = (version, extra = {}) => upgradeCheck({ run: kubectl(world({ ...fresh, ...extra })).run, manifest: manifest(version), now: NOW }).problems.join('\n');
  assert.equal(check('1.38.0+rke2r1'), '');
  assert.equal(check('1.37.3+rke2r2'), '');
  assert.match(check(undefined), /carries no RKE2 version/);
  assert.match(check('1.37.1+rke2r1'), /older than the nodes' v1\.37\.2\+rke2r1; a downgrade is never done/);
  assert.match(check('1.37.2+rke2r0'), /older than the nodes'/, 'the rke2r number counts');
  assert.match(check('1.39.0+rke2r1'), /more than one minor version above/);
  assert.match(check('1.38.0+rke2r1', { nodes: [node('n1'), node('n2', { isReady: false })] }), /node n2 is not Ready/);
  assert.match(check('1.38.0+rke2r1', { nodes: [node('n1'), node('n2', { version: 'v1.36.9+rke2r1' })] }), /nodes run different versions/);
  assert.equal(compareVersions(parseRke2Version('v1.37.10+rke2r1'), parseRke2Version('1.37.9+rke2r1')) > 0, true, 'compared as numbers, not text');
});

test('upgrade-check refuses backups older than the limit and prints the command that takes a fresh one', () => {
  const old = { ...fresh, 'etcdsnapshotfiles.k3s.cattle.io': [{ status: { creationTime: iso(-2) } }], 'cronjob/openbao-raft-snapshot': { status: { lastSuccessfulTime: iso(-3) } } };
  delete old['cronjob/sterling-postgres-dump'];
  const text = upgradeCheck({ run: kubectl(world(old)).run, manifest: manifest('1.38.0+rke2r1'), now: NOW }).problems.join('\n');
  assert.match(text, /newest etcd snapshot .* older than 24 hours: run rke2 etcd-snapshot save on a server/);
  assert.match(text, /last successful openbao-raft-snapshot run .* kubectl create job --from=cronjob\/openbao-raft-snapshot openbao-raft-snapshot-before-upgrade -n sterling-openbao/);
  assert.match(text, /CronJob sterling-identity\/sterling-postgres-dump is not installed, so there is no backup from it/);
  assert.equal(upgradeCheck({ run: kubectl(world(old)).run, manifest: manifest('1.38.0+rke2r1'), now: NOW, maxBackupAgeHours: 96 }).problems.length, 1, 'the limit is the flag\'s');
});

test('upgrade-check includes every cert-check problem', () => {
  const run = kubectl(world({ ...fresh, 'certificates.cert-manager.io': [cert('openbao-tls', ready('False'))] })).run;
  assert.match(upgradeCheck({ run, manifest: manifest('1.38.0+rke2r1'), now: NOW }).problems.join('\n'), /certificate sterling-identity\/openbao-tls is not Ready/);
});
