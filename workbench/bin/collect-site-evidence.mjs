#!/usr/bin/env node
// The site collector (48.2-09, D-08, D-20, D-21): one run of the sterling-site-evidence CronJob (48.2-11), in the signed workbench image.
// It reads in-cluster sources only (OpenBao's seal status, Prometheus's rules and alerts, Kyverno's image policies and policy reports, the
// node count), builds the live feed sterling-site-evidence/1 with each fact group's own collectedAt, has OpenBao Transit sign it for
// site-evidence-live at the key version the installed trust document lists last, and writes only ConfigMap sterling-site-evidence-live (key
// live.json), which every session verifies (48.2-08). A source that fails keeps its previous group and time from the current feed (only when
// that feed still verifies with a listed key), never re-dated. The collector holds no long-term key: it logs in to OpenBao with its projected
// service-account token, signs, and revokes the token before it exits; no token is ever printed or written.
//
// Settings (the chart sets them, 48.2-11): STERLING_SITE_ID, STERLING_EVIDENCE_NAMESPACE, STERLING_OPENBAO_ADDR, STERLING_OPENBAO_CA_FILE,
// STERLING_PROMETHEUS_ADDR, STERLING_OPENBAO_K8S_MOUNT (kubernetes), STERLING_EVIDENCE_K8S_ROLE (site-evidence), STERLING_EVIDENCE_TRANSIT_MOUNT
// (transit), STERLING_EVIDENCE_TRANSIT_KEY (site-evidence), STERLING_EVIDENCE_OPENBAO_JWT_FILE (/var/run/secrets/sterling/openbao-token), and
// the API server from KUBERNETES_SERVICE_HOST and KUBERNETES_SERVICE_PORT. Every address must be a cluster service (*.svc, *.svc.cluster.local)
// or the API server; anything else stops the run before any request. Exit 0 when the feed is written (one line per failed source), 1 with one
// line otherwise.
import { readFile as readFileAsync } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_CONFIGMAP = 'sterling-site-evidence-live';
export const TRUST_CONFIGMAP = 'sterling-evidence-trust';
export const LIVE_KEY = 'live.json';
export const TRUST_KEY = 'trust.json';
const SOURCE_TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
const STALE_RULE_MS = 5 * 60_000;
const ALERT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SEAL_TYPES = new Set(['pkcs11', 'shamir', 'transit']);
const KUBE_CA = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';
const KUBE_TOKEN = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** One plain line for a refused setting or a failed step; never a token, a header or an answer body. */
class CollectorError extends Error {}

/** A cluster service address (*.svc or *.svc.cluster.local), http or https, with no user, query or fragment. */
function serviceAddress(value, name) {
  let url;
  try { url = new URL(value ?? ''); } catch { throw new CollectorError(`${name} is not an address`); }
  const host = url.hostname;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !(/^[a-z0-9-]+(\.[a-z0-9-]+)*\.svc$/.test(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.svc\.cluster\.local$/.test(host))) {
    throw new CollectorError(`${name} must be a cluster service address (*.svc or *.svc.cluster.local)`);
  }
  return url.origin;
}

/** The API server from the in-cluster variables: an IP address, or kubernetes.default.svc. */
function apiServer(env) {
  const host = env.KUBERNETES_SERVICE_HOST ?? '';
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!(net.isIP(host) !== 0 || /^kubernetes\.default\.svc(\.cluster\.local)?$/.test(host)) || !/^\d{1,5}$/.test(port)) {
    throw new CollectorError('KUBERNETES_SERVICE_HOST must be the API server (an IP address or kubernetes.default.svc)');
  }
  return `https://${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/** The settings, all checked before any request. */
export function readSettings(env) {
  const namespace = env.STERLING_EVIDENCE_NAMESPACE ?? '';
  const site = env.STERLING_SITE_ID ?? '';
  if (!NAME.test(namespace)) throw new CollectorError('STERLING_EVIDENCE_NAMESPACE must be the sessions namespace');
  if (!/^[a-z0-9][a-z0-9._/@:-]{0,127}$/.test(site)) throw new CollectorError('STERLING_SITE_ID must be the plain site id');
  const plain = (value, fallback, name) => {
    const text = value || fallback;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(text)) throw new CollectorError(`${name} must be a plain name`);
    return text;
  };
  return {
    site, namespace,
    openbao: serviceAddress(env.STERLING_OPENBAO_ADDR, 'STERLING_OPENBAO_ADDR'),
    prometheus: serviceAddress(env.STERLING_PROMETHEUS_ADDR, 'STERLING_PROMETHEUS_ADDR'),
    api: apiServer(env),
    openbaoCa: env.STERLING_OPENBAO_CA_FILE || undefined,
    authMount: plain(env.STERLING_OPENBAO_K8S_MOUNT, 'kubernetes', 'STERLING_OPENBAO_K8S_MOUNT'),
    role: plain(env.STERLING_EVIDENCE_K8S_ROLE, 'site-evidence', 'STERLING_EVIDENCE_K8S_ROLE'),
    transitMount: plain(env.STERLING_EVIDENCE_TRANSIT_MOUNT, 'transit', 'STERLING_EVIDENCE_TRANSIT_MOUNT'),
    transitKey: plain(env.STERLING_EVIDENCE_TRANSIT_KEY, 'site-evidence', 'STERLING_EVIDENCE_TRANSIT_KEY'),
    jwtFile: env.STERLING_EVIDENCE_OPENBAO_JWT_FILE || '/var/run/secrets/sterling/openbao-token',
  };
}

/** The real transport: node:http(s), the given CA, a timeout and an answer cap. Errors name the method and path only. */
export function nodeRequest(url, { method = 'GET', headers = {}, body, ca, timeoutMs = SOURCE_TIMEOUT_MS } = {}) {
  const target = new URL(url);
  const shown = `${method} ${target.pathname}`;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(target, {
      method, timeout: timeoutMs, ...(ca ? { ca } : {}),
      headers: { Accept: 'application/json', ...headers, ...(payload ? { 'Content-Type': headers['Content-Type'] ?? 'application/json', 'Content-Length': payload.length } : {}) },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_ANSWER_BYTES) { request.destroy(); reject(new CollectorError(`${shown} answered more than allowed`)); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, json });
      });
    });
    request.on('timeout', () => request.destroy(new CollectorError(`${shown} did not answer in time`)));
    request.on('error', () => reject(new CollectorError(`${shown} did not answer`)));
    if (payload) request.write(payload);
    request.end();
  });
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const iso = (ms) => new Date(ms).toISOString();

/**
 * One collector run. `request(url, init)` answers { status, json } and throws when there is no answer; `readFile` reads the token and CA
 * files; `engine` is engine/compliance.cjs. Returns the exit code.
 * @param {{ env?: Record<string, string | undefined>, request?: (url: string, init?: any) => Promise<{ status: number, json?: any }>, readFile?: (file: string) => Promise<string | Buffer>,
 *   now?: () => number, engine?: any, stdout?: (line: string) => unknown, stderr?: (line: string) => unknown }} [options]
 * @returns {Promise<number>}
 */
export async function run({ env = process.env, request = nodeRequest, readFile = (file) => readFileAsync(file, 'utf8'), now = () => Date.now(), engine, stdout = (line) => process.stdout.write(`${line}\n`), stderr = (line) => process.stderr.write(`${line}\n`) } = {}) {
  let token;
  let settings;
  let openbaoCa;
  try {
    settings = readSettings(env);
    const compliance = engine ?? createRequire(import.meta.url)(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'compliance.cjs'));
    const kubeToken = String(await readFile(KUBE_TOKEN)).trim();
    const kubeCa = await readFile(KUBE_CA).catch(() => undefined);
    openbaoCa = settings.openbaoCa ? await readFile(settings.openbaoCa) : undefined;
    const kube = (pathname, init = {}) => request(`${settings.api}${pathname}`, { ...init, ca: kubeCa, headers: { Authorization: `Bearer ${kubeToken}`, ...(init.headers ?? {}) } });
    const configMap = (name) => `/api/v1/namespaces/${settings.namespace}/configmaps/${name}`;

    // The trust document chooses the key version (D-20); without it nothing is signed.
    let trust;
    try {
      const answer = await kube(configMap(TRUST_CONFIGMAP));
      trust = answer.status === 200 && isRecord(answer.json?.data) ? compliance.parseTrustDocument(JSON.parse(answer.json.data[TRUST_KEY])) : undefined;
    } catch {
      trust = undefined;
    }
    if (!trust) throw new CollectorError(`no readable trust document in ConfigMap ${TRUST_CONFIGMAP}; nothing was signed`);
    const keyVersion = compliance.collectorKeyVersion(trust);
    const collector = trust.signers.find(({ role }) => role === 'collector');
    const listed = collector?.versions ?? [];
    const publicKey = listed.find(({ version }) => version === keyVersion)?.publicKey;
    if (keyVersion === undefined || !publicKey) throw new CollectorError('the trust document lists no collector key version; nothing was signed');

    // The current feed, kept only when it still verifies with a listed key, so a failed source keeps its group and time.
    let previous = {};
    try {
      const answer = await kube(configMap(LIVE_CONFIGMAP));
      const text = answer.status === 200 && isRecord(answer.json?.data) ? answer.json.data[LIVE_KEY] : undefined;
      if (typeof text === 'string') {
        const envelope = JSON.parse(text);
        const keys = listed.map((entry) => ({ fingerprint: compliance.fingerprintOf(Buffer.from(entry.publicKey, 'base64url')), publicKey: entry.publicKey }));
        const verdict = compliance.verifyEnvelope(envelope, { purpose: compliance.SITE_LIVE_PURPOSE, keys, now: new Date(now()) });
        if (verdict.ok) previous = compliance.parseLiveFeed(verdict.payload).groups;
      }
    } catch {
      previous = {};
    }

    // Each source on its own: a failure never blocks the others, and never re-dates a kept group.
    const collectedAt = iso(now());
    const get = async (url, init) => {
      const answer = await request(url, init);
      if (answer.status !== 200) throw new CollectorError(`${new URL(url).pathname} answered ${answer.status}`);
      return answer.json;
    };
    const list = async (pathname) => {
      const answer = await kube(pathname);
      if (answer.status === 404) return [];
      if (answer.status !== 200 || !Array.isArray(answer.json?.items)) throw new CollectorError(`${pathname} answered ${answer.status}`);
      return answer.json.items;
    };
    const sources = {
      openbao: async () => {
        const status = await get(`${settings.openbao}/v1/sys/seal-status`, { ca: openbaoCa });
        if (!isRecord(status) || typeof status.sealed !== 'boolean') throw new CollectorError('seal status');
        return { collectedAt, sealed: status.sealed, type: SEAL_TYPES.has(status.type) ? status.type : 'other' };
      },
      prometheus: async () => {
        const rules = await get(`${settings.prometheus}/api/v1/rules`, { ca: openbaoCa });
        const alerts = await get(`${settings.prometheus}/api/v1/alerts`, { ca: openbaoCa });
        const groups = Array.isArray(rules?.data?.groups) ? rules.data.groups : undefined;
        if (!groups || !Array.isArray(alerts?.data?.alerts)) throw new CollectorError('prometheus answer');
        const all = groups.flatMap((group) => (Array.isArray(group?.rules) ? group.rules : []));
        const stale = all.filter((rule) => { const at = Date.parse(rule?.lastEvaluation ?? ''); return Number.isNaN(at) || now() - at > STALE_RULE_MS; }).length;
        const unhealthy = groups.filter((group) => (Array.isArray(group?.rules) ? group.rules : []).some((rule) => rule?.health !== 'ok')).length;
        const firing = [...new Set(alerts.data.alerts.filter((alert) => alert?.state === 'firing').map((alert) => alert?.labels?.alertname).filter((name) => typeof name === 'string' && ALERT_NAME.test(name)))].sort();
        return { collectedAt, ruleGroups: groups.length, unhealthyRuleGroups: unhealthy, staleRules: stale, firingAlerts: firing };
      },
      admission: async () => {
        const kinds = (items, kind) => items.map((item) => ({ ...item, kind }));
        const policies = compliance.readKyvernoPolicies({ items: [
          ...kinds(await list('/apis/policies.kyverno.io/v1/imagevalidatingpolicies'), 'ImageValidatingPolicy'),
          ...kinds(await list('/apis/kyverno.io/v1/clusterpolicies'), 'ClusterPolicy'),
        ] }, 'kyverno policies');
        const reports = compliance.readPolicyReports({ items: [
          ...kinds(await list('/apis/wgpolicyk8s.io/v1alpha2/policyreports'), 'PolicyReport'),
          ...kinds(await list('/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports'), 'ClusterPolicyReport'),
        ] }, policies, 'kyverno policy reports');
        return { collectedAt, enforcingImagePolicies: policies.enforcingImagePolicies, refusedImageResults: reports.unsignedImageResults };
      },
      nodes: async () => ({ collectedAt, count: (await list('/api/v1/nodes')).length }),
    };
    const groups = {};
    const failed = [];
    for (const [name, gather] of Object.entries(sources)) {
      try {
        groups[name] = await gather();
      } catch {
        failed.push(name);
        if (isRecord(previous[name])) groups[name] = previous[name];
      }
    }
    // A kept group from another source (the release record, 47-32, once collected) stays as it was.
    for (const [name, group] of Object.entries(previous)) if (!(name in groups) && !(name in sources)) groups[name] = group;
    if (Object.keys(groups).length === 0) throw new CollectorError('no source answered and there is no earlier feed to keep; nothing was signed');

    // Sign inside OpenBao: log in with the projected token, sign at the listed key version, revoke.
    const feed = compliance.buildLiveFeed({ site: settings.site, generatedAt: collectedAt, keyVersion, groups });
    const { unsigned, bytes } = compliance.liveSigningInput(feed, publicKey);
    const jwt = String(await readFile(settings.jwtFile)).trim();
    const login = await request(`${settings.openbao}/v1/auth/${settings.authMount}/login`, { method: 'POST', ca: openbaoCa, body: { role: settings.role, jwt } });
    token = login.status === 200 ? login.json?.auth?.client_token : undefined;
    if (typeof token !== 'string' || token === '') throw new CollectorError(`the OpenBao login for role ${settings.role} was refused`);
    const signed = await request(`${settings.openbao}/v1/${settings.transitMount}/sign/${settings.transitKey}`, { method: 'POST', ca: openbaoCa, headers: { 'X-Vault-Token': token }, body: { input: bytes.toString('base64'), key_version: keyVersion } });
    const signature = signed.status === 200 ? signed.json?.data?.signature : undefined;
    const match = typeof signature === 'string' ? /^vault:v(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(signature) : null;
    if (!match || Number(match[1]) !== keyVersion) throw new CollectorError(`OpenBao Transit did not sign with key version ${keyVersion}`);
    const envelope = compliance.attachLiveSignature(unsigned, Buffer.from(match[2], 'base64'));
    await revoke(request, settings, openbaoCa, token);
    token = undefined;

    const written = await kube(configMap(LIVE_CONFIGMAP), { method: 'PATCH', headers: { 'Content-Type': 'application/merge-patch+json' }, body: { data: { [LIVE_KEY]: JSON.stringify(envelope) } } });
    if (written.status !== 200) throw new CollectorError(`ConfigMap ${LIVE_CONFIGMAP} could not be written (${written.status})`);
    if (failed.length) stderr(`collect-site-evidence: kept the earlier facts of ${failed.join(', ')}, which did not answer`);
    stdout(`Live site evidence written: ${Object.keys(groups).sort().join(', ')} (key version ${keyVersion}).`);
    return 0;
  } catch (error) {
    if (token !== undefined) await revoke(request, settings, openbaoCa, token).catch(() => undefined);
    stderr(`collect-site-evidence: ${error instanceof CollectorError ? error.message : 'the run failed'}`);
    return 1;
  }
}

async function revoke(request, settings, ca, token) {
  await request(`${settings.openbao}/v1/auth/token/revoke-self`, { method: 'POST', ca, headers: { 'X-Vault-Token': token } });
}

if (process.argv[1] && path.basename(process.argv[1]) === 'collect-site-evidence.mjs' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
