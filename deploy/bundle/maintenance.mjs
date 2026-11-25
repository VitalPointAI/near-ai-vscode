#!/usr/bin/env node
// Site maintenance checks (D-75; MA-2, MA-6, SI-2, CM-4): each runs before a risky maintenance step and refuses it before harm, rather than
// leaving a recovery for after (deploy/runbooks/maintenance.md).
//
//   node deploy/bundle/maintenance.mjs drain-check --node <name> --site <site file>
//        refuses a drain that would leave fewer Ready etcd servers than a majority, take an OpenBao server while another is not Ready, or
//        remove a Longhorn volume's only healthy replica; warns with the hubs and the number of sessions it interrupts
//   node deploy/bundle/maintenance.mjs upgrade-check --bundle <imported bundle folder> --site <site file> [--max-backup-age-hours 24] [--horizon-days 90]
//        refuses an RKE2 upgrade that is a downgrade or skips a minor version, any node not Ready or nodes on mixed versions, or backups older
//        than the limit (with the command that takes a fresh one), and includes every cert-check problem
//   node deploy/bundle/maintenance.mjs cert-check [--horizon-days 90]
//        names every cert-manager Certificate that is not Ready, overdue for renewal or within 7 days of expiry, every certificate of the site
//        CA chain (ConfigMap sterling-site-ca) and the API server's serving certificate expiring within the horizon, with what renews it
//
// One plain line per problem (exit 1 on any) and per warning (exit 0). Everything is read with kubectl -o json (KUBECTL or PATH), never by
// scraping text; the API server certificate by a TLS handshake to the kubeconfig's server with the kubeconfig's CA. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { MANIFEST, readManifest } from './lib/manifest.mjs';

const DAY = 86_400_000;
export const RKE2_ITEM = 'rke2.linux-amd64.tar.gz';
/** RKE2 renews its own certificates at start when they are within 120 days of expiry (docs.rke2.io, Certificates, since v1.33.1). */
export const RKE2_RENEWAL_DAYS = 120;

const defaultRun = (command, args) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** kubectl <args> -o json, parsed; null when the object does not exist. */
export function kubectlJson(run, args) {
  const result = run(process.env.KUBECTL || 'kubectl', [...args, '-o', 'json']);
  if (result.error) throw new Error(`kubectl could not run (${result.error.message}); set KUBECTL or put kubectl on PATH.`);
  if (result.status !== 0) {
    if (/NotFound|not found|the server doesn't have a resource type/.test(result.stderr || '')) return null;
    throw new Error(`kubectl ${args.join(' ')} failed: ${String(result.stderr).trim()}`);
  }
  return JSON.parse(result.stdout);
}
const items = (run, args) => kubectlJson(run, args)?.items ?? [];
const isReady = (object, type = 'Ready') => (object?.status?.conditions ?? []).some((condition) => condition.type === type && condition.status === 'True');
const days = (ms) => Math.floor(ms / DAY);

/** The certificates of a PEM bundle. */
export const pemCertificates = (text) => (String(text).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map((pem) => new X509Certificate(pem));

/** The API server's serving certificate, by a TLS handshake to the kubeconfig's server with the kubeconfig's CA. */
export function apiServerCertificate({ kubeconfig = process.env.KUBECONFIG || [path.join(homedir(), '.kube/config'), '/etc/rancher/rke2/rke2.yaml'].find(existsSync) } = {}) {
  if (!kubeconfig || !existsSync(kubeconfig)) throw new Error('No kubeconfig found; set KUBECONFIG.');
  const text = readFileSync(kubeconfig, 'utf8');
  const server = /^\s*server:\s*(\S+)/m.exec(text)?.[1];
  const caData = /^\s*certificate-authority-data:\s*(\S+)/m.exec(text)?.[1];
  if (!server) throw new Error(`${kubeconfig} names no server.`);
  const url = new URL(server);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), ...(isIP(url.hostname) ? {} : { servername: url.hostname }), ca: caData ? Buffer.from(caData, 'base64') : undefined }, () => {
      const peer = socket.getPeerCertificate(false);
      socket.end();
      resolve(new X509Certificate(peer.raw));
    });
    socket.on('error', reject);
  });
}

/**
 * cert-check. `apiCertificate` is the API server's X509Certificate (or null to skip it). Returns { problems, warnings }.
 */
export function certCheck({ run = defaultRun, apiCertificate, now = Date.now(), horizonDays = 90 }) {
  const problems = [];
  const warnings = [];
  const horizon = now + horizonDays * DAY;
  for (const certificate of items(run, ['get', 'certificates.cert-manager.io', '--all-namespaces'])) {
    const where = `${certificate.metadata.namespace}/${certificate.metadata.name}`;
    const notAfter = Date.parse(certificate.status?.notAfter ?? '');
    const renewal = Date.parse(certificate.status?.renewalTime ?? '');
    if (!isReady(certificate)) problems.push(`certificate ${where} is not Ready; see kubectl describe certificate -n ${certificate.metadata.namespace} ${certificate.metadata.name}.`);
    else if (renewal && renewal < now) problems.push(`certificate ${where} is overdue for renewal (renewal time ${certificate.status.renewalTime}); cert-manager has not renewed it, check its issuer.`);
    if (notAfter && notAfter - now < 7 * DAY) problems.push(`certificate ${where} expires ${certificate.status.notAfter}, within 7 days.`);
  }
  const siteCa = kubectlJson(run, ['get', 'configmap', 'sterling-site-ca', '-n', 'cert-manager']);
  if (!siteCa) warnings.push('ConfigMap sterling-site-ca is not in cert-manager yet; the site CA chain was not checked.');
  for (const certificate of pemCertificates(siteCa?.data?.['ca.crt'] ?? '')) {
    const expires = Date.parse(certificate.validTo);
    if (expires > horizon) continue;
    const root = certificate.subject === certificate.issuer;
    problems.push(`the site CA chain's ${root ? 'HQ root' : 'site intermediate'} (${certificate.subject.replace(/\n/g, ', ')}) expires ${certificate.validTo}, `
      + `in ${days(expires - now)} days (horizon ${horizonDays}): ${root ? 'renew it in HQ\'s key ceremony'
        : 'renew it through the key ceremony: pki-files.mjs csr, signed by the HQ root (key-ceremony.md)'}.`);
  }
  if (apiCertificate) {
    const expires = Date.parse(apiCertificate.validTo);
    if (expires <= horizon) {
      problems.push(`the API server certificate expires ${apiCertificate.validTo}, in ${days(expires - now)} days (horizon ${horizonDays}): restart rke2-server on each server, `
        + `one at a time (RKE2 renews certificates within ${RKE2_RENEWAL_DAYS} days of expiry when it starts), or run rke2 certificate rotate.`);
    }
  }
  return { problems, warnings };
}

/** drain-check for one node. Returns { problems, warnings }. */
export function drainCheck({ run = defaultRun, node, site }) {
  const problems = [];
  const warnings = [];
  const nodes = items(run, ['get', 'nodes']);
  const target = nodes.find((item) => item.metadata.name === node);
  if (!target) return { problems: [`there is no node ${node}.`], warnings };
  const etcd = nodes.filter((item) => item.metadata.labels?.['node-role.kubernetes.io/etcd'] === 'true');
  if (etcd.some((item) => item.metadata.name === node)) {
    const left = etcd.filter((item) => item.metadata.name !== node && isReady(item)).length;
    const majority = Math.floor(etcd.length / 2) + 1;
    if (left < majority) problems.push(`draining ${node} leaves ${left} Ready etcd server${left === 1 ? '' : 's'} of ${etcd.length}; etcd needs ${majority} to keep quorum.`);
  }
  const bao = items(run, ['get', 'pods', '-n', 'sterling-openbao', '-l', 'app.kubernetes.io/name=openbao,component=server']);
  if (bao.some((pod) => pod.spec?.nodeName === node)) {
    const notReady = bao.filter((pod) => pod.spec?.nodeName !== node && !isReady(pod)).map((pod) => pod.metadata.name);
    if (notReady.length) problems.push(`${node} runs an OpenBao server while ${notReady.join(', ')} ${notReady.length > 1 ? 'are' : 'is'} not Ready; wait until every OpenBao server is Ready.`);
  }
  if (site?.storageProvider === 'longhorn') {
    const replicas = items(run, ['get', 'replicas.longhorn.io', '-n', 'longhorn-system']);
    const healthy = (replica) => replica.status?.currentState === 'running' && !replica.spec?.failedAt;
    for (const volume of items(run, ['get', 'volumes.longhorn.io', '-n', 'longhorn-system'])) {
      const name = volume.metadata.name;
      const good = replicas.filter((replica) => replica.spec?.volumeName === name && healthy(replica));
      const here = good.filter((replica) => replica.spec?.nodeID === node);
      if (!here.length) continue;
      if (here.length === good.length) problems.push(`volume ${name} has its only healthy replica on ${node}; wait until Longhorn rebuilds a replica on another node.`);
      else if (volume.status?.robustness === 'degraded') warnings.push(`volume ${name} is degraded; it keeps ${good.length - here.length} healthy replica${good.length - here.length === 1 ? '' : 's'} elsewhere.`);
    }
  } else {
    warnings.push(`the Longhorn rule was skipped: storageProvider is ${site?.storageProvider ?? 'not set'}; check your storage's own copies before draining.`);
  }
  const hubs = items(run, ['get', 'pods', '-n', 'sterling-hubs']).filter((pod) => pod.spec?.nodeName === node).map((pod) => pod.metadata.name);
  if (hubs.length) warnings.push(`draining ${node} restarts the hub${hubs.length > 1 ? 's' : ''} ${hubs.join(', ')}.`);
  const sessions = items(run, ['get', 'pods', '-n', 'theia-cloud', '-l', 'sterling-session']).filter((pod) => pod.spec?.nodeName === node).length;
  if (sessions) warnings.push(`draining ${node} stops ${sessions} session${sessions === 1 ? '' : 's'}; tell the people first.`);
  return { problems, warnings };
}

/** An RKE2 version as [major, minor, patch, rke2r], from "v1.37.2+rke2r1" or "1.37.2+rke2r1"; null when it does not read. */
export function parseRke2Version(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+rke2r(\d+))?$/.exec(String(text ?? '').trim());
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}
export const compareVersions = (a, b) => a.map((part, index) => part - b[index]).find((difference) => difference !== 0) ?? 0;

/** upgrade-check. `manifest` is the new bundle's manifest; `apiCertificate` as for certCheck. Returns { problems, warnings }. */
export function upgradeCheck({ run = defaultRun, manifest, now = Date.now(), maxBackupAgeHours = 24, horizonDays = 90, apiCertificate }) {
  const problems = [];
  const item = (manifest?.items ?? []).find((entry) => entry.name === RKE2_ITEM);
  const next = parseRke2Version(item?.version);
  if (!next) problems.push(`the bundle's ${RKE2_ITEM} item carries no RKE2 version; it was not built by this bundle build (47-16).`);
  const nodes = items(run, ['get', 'nodes']);
  for (const node of nodes) if (!isReady(node)) problems.push(`node ${node.metadata.name} is not Ready; fix it before an upgrade.`);
  const versions = [...new Set(nodes.map((node) => node.status?.nodeInfo?.kubeletVersion))];
  if (versions.length > 1) problems.push(`nodes run different versions (${versions.join(', ')}); finish the previous upgrade first.`);
  const current = parseRke2Version(versions[0]);
  if (next && current) {
    if (compareVersions(next, current) < 0) problems.push(`the bundle's RKE2 ${item.version} is older than the nodes' ${versions[0]}; a downgrade is never done.`);
    else if (next[0] !== current[0] || next[1] > current[1] + 1) problems.push(`the bundle's RKE2 ${item.version} is more than one minor version above ${versions[0]}; upgrade one minor version per bundle.`);
  }
  const limit = maxBackupAgeHours * 3_600_000;
  const age = (time) => (time ? now - Date.parse(time) : Infinity);
  const snapshots = items(run, ['get', 'etcdsnapshotfiles.k3s.cattle.io']).map((snapshot) => snapshot.status?.creationTime).filter(Boolean).sort();
  if (age(snapshots.at(-1)) > limit) problems.push(`the newest etcd snapshot is ${snapshots.at(-1) ?? 'missing'}, older than ${maxBackupAgeHours} hours: run rke2 etcd-snapshot save on a server.`);
  for (const [namespace, name] of [['sterling-openbao', 'openbao-raft-snapshot'], ['sterling-identity', 'sterling-postgres-dump']]) {
    const job = kubectlJson(run, ['get', 'cronjob', name, '-n', namespace]);
    const last = job?.status?.lastSuccessfulTime;
    if (!job) problems.push(`CronJob ${namespace}/${name} is not installed, so there is no backup from it; install its release before an upgrade.`);
    else if (age(last) > limit) {
      problems.push(`the last successful ${name} run is ${last ?? 'none'}, older than ${maxBackupAgeHours} hours: `
        + `run kubectl create job --from=cronjob/${name} ${name}-before-upgrade -n ${namespace} and wait for it.`);
    }
  }
  problems.push(...certCheck({ run, apiCertificate, now, horizonDays }).problems);
  return { problems, warnings: [] };
}

const USAGE = `usage: node deploy/bundle/maintenance.mjs <check> [flags]   (deploy/runbooks/maintenance.md)
  drain-check   --node <name> --site <site file>
  upgrade-check --bundle <imported bundle folder> --site <site file> [--max-backup-age-hours 24] [--horizon-days 90]
  cert-check    [--horizon-days 90]`;

export async function main(argv, { run = defaultRun, log = console.log, error = console.error, apiCertificate = apiServerCertificate } = {}) {
  const [command, ...rest] = argv;
  const option = (flag, fallback) => { const index = rest.indexOf(flag); return index < 0 ? fallback : rest[index + 1]; };
  if (!['drain-check', 'upgrade-check', 'cert-check'].includes(command)) { log(USAGE); return command === '--help' ? 0 : 2; }
  try {
    const horizonDays = Number(option('--horizon-days', 90));
    let result;
    if (command === 'cert-check') {
      result = certCheck({ run, apiCertificate: await apiCertificate(), horizonDays });
    } else {
      const siteFile = option('--site');
      if (!siteFile) throw Object.assign(new Error(`${command} needs --site.\n${USAGE}`), { usage: true });
      const site = JSON.parse(readFileSync(siteFile, 'utf8'));
      if (command === 'drain-check') {
        if (!option('--node')) throw Object.assign(new Error(`drain-check needs --node.\n${USAGE}`), { usage: true });
        result = drainCheck({ run, node: option('--node'), site });
      } else {
        const bundle = option('--bundle');
        if (!bundle) throw Object.assign(new Error(`upgrade-check needs --bundle.\n${USAGE}`), { usage: true });
        const { manifest, problems } = readManifest(path.join(bundle, MANIFEST));
        if (problems.length) throw new Error(problems.join('; '));
        result = upgradeCheck({ run, manifest, apiCertificate: await apiCertificate(), horizonDays, maxBackupAgeHours: Number(option('--max-backup-age-hours', 24)) });
      }
    }
    for (const warning of result.warnings) log(`${command}: warning: ${warning}`);
    for (const problem of result.problems) error(`${command}: ${problem}`);
    if (!result.problems.length) log(`${command}: no problem found.`);
    return result.problems.length ? 1 : 0;
  } catch (problem) {
    error(problem.usage ? problem.message : `${command}: ${problem.message}`);
    return problem.usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
