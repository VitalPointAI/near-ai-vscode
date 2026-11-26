#!/usr/bin/env node
// The site install from the imported bundle (DEP-01, DEP-06, DEP-12; D-11, D-16, D-41, D-47, D-54, D-56, D-71, D-73). One script on the
// import host, the same for the first install and every update (an update is the same commands with a newer bundle). The steps, in order
// (deploy/runbooks/site-install.md):
//
//   node-files       --site <file> --out <dir> --ca <site CA pem> [--artifacts <dir>] [--bundle <install dir>]
//                    the folder an operator copies to each node: the substituted RKE2 files, install-node.sh, escrow-node.sh, the clock
//                    files (chrony.conf, clock.env, check-time.sh), pins.sha256, the RKE2 artifacts, and images/registry-images.tar
//   bootstrap-ca     --site <file> --state <dir>       a 90-day bootstrap CA and the registry's certificate (D-16), kept 0600 in the state
//                                                      folder until registry and apply load them as Secrets; retire-bootstrap removes them
//   registry         --site <file> --site-dir <dir> --state <dir>   the registry namespace, zot-tls, the import account (zot-htpasswd) and release
//   import           --site <file> --state <dir> --bundle <checked bundle> --public-key <cosign pub> --out <install dir>
//   preflight        --site <file> --site-dir <dir> --bundle <install dir> [--lab]   every refusal, before anything is installed
//   secrets          --site <file> --site-dir <dir> --state <dir> <OpenBao flags>    static application secrets from OpenBao kv/apps
//   apply            --site <file> --site-dir <dir> --state <dir> <OpenBao flags> [--from <order>] [--release <name>]
//                    every enabled release in order, stopping at the two key ceremonies; resumes with --from
//   status           [<OpenBao flags>]                 releases, pods, OpenBao seal state, certificates
//   retire-bootstrap --site <file> --state <dir>       removes the bootstrap CA and the Keycloak bootstrap administrator once site-pki serves
//
// OpenBao flags: --bao <https://openbao address> --ca-file <site CA pem> --token-file <file>. Secret values travel on stdin or through files
// in the 0700 state folder only, never on a command line (D-41); per-person secrets are never written here. kubectl is RKE2's (KUBECTL or
// PATH), helm the bundled pin (HELM or PATH). Node built-ins only.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeClockFiles } from './lib/clock.mjs';
import { readImagesLock, readToolPins, resolveImage } from './lib/locks.mjs';
import { MANIFEST } from './lib/manifest.mjs';
import { preflight } from './lib/preflight.mjs';
import { REGISTRY_IMAGES, nameForSite } from './lib/registry-images.mjs';
import { helmEnv, listReleases, loadSite, isEnabled, releaseInputs, renderRelease, renderSite, splitDocs, substituteSite, writeValues } from './lib/render.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SUBCOMMANDS = Object.freeze(['node-files', 'bootstrap-ca', 'registry', 'import', 'preflight', 'secrets', 'apply', 'status', 'retire-bootstrap']);
export const RUNBOOKS = Object.freeze({ unseal: 'deploy/runbooks/key-ceremony.md (OpenBao initialisation and unseal)', intermediate: 'deploy/runbooks/key-ceremony.md (a site intermediate)' });
const STATE_FILE = 'install-state.json';
const REGISTRY_AUTH = 'registry-auth.json';
/** The OpenSearch objects the opensearch release renders as ConfigMaps, and where each goes (47-10, 47-24). */
export const OPENSEARCH_OBJECTS = Object.freeze([
  { configMap: 'opensearch-retention-policy', path: '_plugins/_ism/policies/sterling-retention' },
  { configMap: 'opensearch-snapshot-repository', path: '_snapshot/sterling-snapshots' },
  { configMap: 'opensearch-snapshot-policy', path: '_plugins/_sm/policies/sterling-audit' },
]);

const tool = (name, fallback) => process.env[name] || fallback;
/** The default runner: no shell, stdin for every secret. Returns spawnSync's result. */
export const defaultRun = (command, args, { input, env } = {}) => spawnSync(command, args, { encoding: 'utf8', input, env, maxBuffer: 256 * 1024 * 1024 });
const must = (result, what) => {
  if (result.error) throw new Error(`${what} could not run (${result.error.message}).`);
  if (result.status !== 0) throw new Error(`${what} failed: ${String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ')}`);
  return result.stdout ?? '';
};
const b64 = (text) => Buffer.from(String(text)).toString('base64');
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

// ---- state --------------------------------------------------------------------------------------------------------------------------

/** The install state folder (0700): what has been installed, where the import stands, and the bootstrap material until it is retired. */
export function readState(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = path.join(dir, STATE_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { installed: {}, importAllSigned: false, admissionDeny: false, bootstrapRemoved: false };
}
export function writeState(dir, state) {
  const scratch = mkdtempSync(path.join(dir, '.install-state-'));
  try {
    const file = path.join(scratch, STATE_FILE);
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(file, path.join(dir, STATE_FILE));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
const writePrivate = (file, text) => { writeFileSync(file, text, { mode: 0o600 }); chmodSync(file, 0o600); };

// ---- kubectl and helm -----------------------------------------------------------------------------------------------------------------

/** kubectl apply -f - with the manifest on stdin. */
export function applyManifest(run, manifest, what) {
  must(run(tool('KUBECTL', 'kubectl'), ['apply', '-f', '-'], { input: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) }), `kubectl apply ${what}`);
}
const kubectlJson = (run, args, what) => JSON.parse(must(run(tool('KUBECTL', 'kubectl'), [...args, '-o', 'json']), `kubectl ${what}`));
const namespaceManifest = (name, level = 'restricted') => ({
  apiVersion: 'v1', kind: 'Namespace',
  metadata: { name, labels: { 'pod-security.kubernetes.io/enforce': level, 'pod-security.kubernetes.io/enforce-version': 'latest' } },
});
/** A Secret manifest; the values are base64 in data, sent only on stdin. */
export const secretManifest = (name, namespace, data, type = 'Opaque') => ({
  apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type,
  data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, b64(value)])),
});

/** helm upgrade --install of one release with the same values and image injection as the render harness. Returns the instance names. */
export function installRelease({ root, release, site, siteDir, run, sets = [], wait = true }) {
  const { descriptor, chart, sets: imageSets, instances, texts } = releaseInputs(root, release, { site, siteDir });
  const scratch = mkdtempSync(path.join(tmpdir(), 'sterling-install-'));
  try {
    const env = helmEnv(path.join(scratch, 'helm-home'));
    const files = writeValues(scratch, texts);
    for (const { name, instance } of instances) {
      const args = ['upgrade', '--install', name, chart, '--namespace', descriptor.namespace, '--create-namespace', ...files, ...imageSets,
        ...sets.flatMap((set) => ['--set-string', set]), ...(instance ? ['--set-json', `instance=${JSON.stringify(instance)}`] : []), ...(wait ? ['--wait', '--timeout', '20m'] : [])];
      must(run(tool('HELM', 'helm'), args, { env }), `helm upgrade --install ${name}`);
    }
    return instances.map((instance) => instance.name);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- preflight ------------------------------------------------------------------------------------------------------------------------

/** Reads the bundle manifest from an install folder (the import copies it there) or a checked bundle folder; null when absent. */
export function readBundleManifest(dir) {
  const file = dir ? path.join(dir, MANIFEST) : '';
  return file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

/** The preflight for a site: { problems, notes }. */
export function sitePreflight({ root = ROOT, site, siteDir, bundle, lab = false, run = defaultRun, helm }) {
  return preflight({
    site, siteDir, lab, run, lock: readImagesLock(root), manifest: readBundleManifest(bundle),
    renderAll: () => renderSite(root, { site, siteDir, helm }),
  });
}

// ---- node files -----------------------------------------------------------------------------------------------------------------------

/** The pinned RKE2 artifacts as [{ name, sha256 }] from compliance/ci/tool-pins.json (the copy that came in the signed bundle). */
export function rke2Pins(root) {
  const pin = readToolPins(root).rke2;
  return [{ url: pin.url, sha256: pin.sha256 }, ...(pin.assets ?? [])]
    .map((item) => ({ name: decodeURIComponent(new URL(item.url).pathname.split('/').pop()), sha256: item.sha256 }));
}

/** Writes the node folder (see the top of this file). Returns { out, files, missing } where missing names artifacts still to copy. */
export function nodeFiles({ root = ROOT, site, out, ca, artifacts, bundle }) {
  if (!ca || !existsSync(ca)) throw new Error('node-files needs --ca <site CA pem> (bootstrap-ca writes site-ca.crt in the state folder).');
  mkdirSync(out, { recursive: true });
  const rke2Dir = path.join(root, 'deploy/rke2');
  for (const name of readdirSync(rke2Dir).filter((file) => file.endsWith('.yaml')).sort()) {
    writeFileSync(path.join(out, name), substituteSite(readFileSync(path.join(rke2Dir, name), 'utf8'), site, `deploy/rke2/${name}`));
  }
  for (const name of ['install-node.sh', 'escrow-node.sh']) copyFileSync(path.join(rke2Dir, name), path.join(out, name));
  copyFileSync(ca, path.join(out, 'site-ca.crt'));
  writeClockFiles(site, out);
  const pins = rke2Pins(root);
  const lines = pins.map((pin) => `${pin.sha256}  ${pin.name}`);
  const missing = [];
  for (const { name } of pins) {
    const from = artifacts ? path.join(artifacts, name) : '';
    if (from && existsSync(from)) copyFileSync(from, path.join(out, name));
    else missing.push(name);
  }
  // The registry's own images (Pitfall 8): the bundle's site-neutral archive, checked against the signed manifest, named for this registry.
  const registryItem = readBundleManifest(bundle)?.items?.find((item) => item.name === REGISTRY_IMAGES);
  const archive = artifacts ? path.join(artifacts, REGISTRY_IMAGES) : '';
  if (registryItem && archive && existsSync(archive)) {
    if (`sha256:${sha256Of(archive)}` !== registryItem.digest) throw new Error(`${archive} does not match its digest in the bundle manifest; import the bundle again.`);
    const named = nameForSite(archive, site.registry, path.join(out, 'images', REGISTRY_IMAGES));
    lines.push(`${sha256Of(named)}  images/${REGISTRY_IMAGES}`);
  } else if (registryItem) {
    missing.push(`${REGISTRY_IMAGES} (give --artifacts the install folder the import wrote)`);
  }
  writeFileSync(path.join(out, 'pins.sha256'), `${lines.join('\n')}\n`);
  return { out, files: readdirSync(out).sort(), missing };
}

// ---- bootstrap CA -------------------------------------------------------------------------------------------------------------------

/** The registry host without its port. */
export const registryHost = (registry) => {
  const value = String(registry);
  if (value.startsWith('[')) return value.slice(1, value.indexOf(']'));
  return value.split(':').length === 2 ? value.split(':')[0] : value;
};

/** Makes the bootstrap CA and the registry certificate with the host's openssl (D-16). Refuses to replace an existing one. */
export function bootstrapCa({ site, state: stateDir, run = defaultRun, days = 90 }) {
  readState(stateDir);
  const dir = path.join(stateDir, 'bootstrap');
  if (existsSync(path.join(dir, 'site-bootstrap-ca.secret.json'))) throw new Error(`${dir} already holds a bootstrap CA; it is made once per site.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(path.join(dir, 'work-'));
  try {
    const at = (name) => path.join(work, name);
    const host = registryHost(site.registry);
    const ext = `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n`;
    writePrivate(at('registry.ext'), ext);
    const openssl = (args, what) => must(run('openssl', args), `openssl ${what}`);
    openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', at('ca.key'), '-out', at('ca.crt'),
      '-days', String(days), '-subj', `/CN=${site.siteName} bootstrap CA`, '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], 'bootstrap CA');
    openssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', at('registry.key'), '-out', at('registry.csr'),
      '-subj', `/CN=${host}`], 'registry key');
    openssl(['x509', '-req', '-in', at('registry.csr'), '-CA', at('ca.crt'), '-CAkey', at('ca.key'), '-CAcreateserial', '-days', String(days),
      '-out', at('registry.crt'), '-extfile', at('registry.ext')], 'registry certificate');
    const read = (name) => readFileSync(at(name), 'utf8');
    writePrivate(path.join(dir, 'site-bootstrap-ca.secret.json'), JSON.stringify(secretManifest('site-bootstrap-ca', 'cert-manager',
      { 'tls.crt': read('ca.crt'), 'tls.key': read('ca.key') }, 'kubernetes.io/tls')));
    writePrivate(path.join(dir, 'zot-tls.secret.json'), JSON.stringify(secretManifest('zot-tls', 'sterling-registry',
      { 'tls.crt': read('registry.crt'), 'tls.key': read('registry.key'), 'ca.crt': read('ca.crt') }, 'kubernetes.io/tls')));
    writeFileSync(path.join(stateDir, 'site-ca.crt'), read('ca.crt'), { mode: 0o644 });
    return { caFile: path.join(stateDir, 'site-ca.crt'), dir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- registry and import ------------------------------------------------------------------------------------------------------------

/** The registry: namespace, TLS, the import account, then the zot or harbor release. */
export function installRegistry({ root = ROOT, site, siteDir, state: stateDir, run = defaultRun }) {
  readState(stateDir);
  const tls = path.join(stateDir, 'bootstrap/zot-tls.secret.json');
  if (!existsSync(tls)) throw new Error('The registry certificate is missing; run install.mjs bootstrap-ca first.');
  applyManifest(run, namespaceManifest('sterling-registry'), 'namespace sterling-registry');
  applyManifest(run, readFileSync(tls, 'utf8'), 'Secret zot-tls');
  const authFile = path.join(stateDir, REGISTRY_AUTH);
  if (!existsSync(authFile)) writePrivate(authFile, JSON.stringify({ username: 'import', password: randomBytes(32).toString('base64url') }));
  const auth = JSON.parse(readFileSync(authFile, 'utf8'));
  // htpasswd from the site's OS repository (httpd-tools) makes the bcrypt line; the password goes on stdin (-i), never on the command line.
  const line = must(run('htpasswd', ['-niB', auth.username], { input: `${auth.password}\n` }), 'htpasswd (httpd-tools from the site\'s OS repository)').trim();
  if (!line.startsWith(`${auth.username}:$2`)) throw new Error('htpasswd did not print a bcrypt line.');
  applyManifest(run, secretManifest('zot-htpasswd', 'sterling-registry', { htpasswd: `${line}\n` }), 'Secret zot-htpasswd');
  const release = listReleases(root).find((candidate) => candidate.name === site.registryKind && isEnabled(candidate, site));
  if (!release) throw new Error(`No registry release is enabled for registryKind ${site.registryKind}.`);
  return installRelease({ root, release, site, siteDir, run });
}

/** Imports the checked bundle with import.mjs; on success records that every signature is present (the admission switch reads it). */
export function importStep({ root = ROOT, site, state: stateDir, bundle, publicKey, out, run = defaultRun }) {
  const state = readState(stateDir);
  const authFile = path.join(stateDir, REGISTRY_AUTH);
  const args = [path.join(root, 'deploy/bundle/import.mjs'), '--bundle', bundle, '--public-key', publicKey, '--registry', site.registry, '--out', out,
    '--registry-kind', site.registryKind, '--registry-ca', path.join(stateDir, 'site-ca.crt'), ...(existsSync(authFile) ? ['--registry-auth', authFile] : [])];
  must(run(process.execPath, args), 'import.mjs');
  for (const name of [MANIFEST, `${MANIFEST}.sigstore.json`]) if (existsSync(path.join(bundle, name))) copyFileSync(path.join(bundle, name), path.join(out, name));
  state.importAllSigned = true;
  state.importedAt = new Date().toISOString();
  writeState(stateDir, state);
  return state;
}

// ---- OpenBao ---------------------------------------------------------------------------------------------------------------------------

/** A minimal OpenBao client over node:https with the site CA; the token comes from a file. */
export function baoClient({ addr, caFile, tokenFile }) {
  if (!addr || !caFile || !tokenFile) throw new Error('OpenBao flags: --bao <address> --ca-file <site CA pem> --token-file <file>.');
  const ca = readFileSync(caFile);
  const token = readFileSync(tokenFile, 'utf8').trim();
  const call = (method, apiPath, body) => new Promise((resolve, reject) => {
    const request = https.request(new URL(`/v1/${apiPath}`, addr), { method, ca, headers: { 'x-vault-token': token, 'content-type': 'application/json' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
  return {
    async read(kvPath) {
      const { status, body } = await call('GET', `kv/data/${kvPath}`);
      if (status === 404) return null;
      if (status !== 200) throw new Error(`OpenBao read kv/${kvPath}: HTTP ${status}`);
      return { data: body.data.data, version: body.data.metadata.version };
    },
    async write(kvPath, data, cas) {
      const { status } = await call('POST', `kv/data/${kvPath}`, { options: { cas }, data });
      if (status !== 200 && status !== 204) throw new Error(`OpenBao write kv/${kvPath}: HTTP ${status} (cas ${cas})`);
    },
    async sealStatus() {
      const { status, body } = await call('GET', 'sys/seal-status');
      if (status !== 200) throw new Error(`OpenBao seal-status: HTTP ${status}`);
      return { initialized: body.initialized === true, sealed: body.sealed !== false };
    },
    async intermediateSigned() {
      const { status, body } = await call('GET', 'pki_int/cert/ca');
      return status === 200 && typeof body?.data?.certificate === 'string' && body.data.certificate.includes('BEGIN CERTIFICATE');
    },
  };
}

// ---- secrets ----------------------------------------------------------------------------------------------------------------------------

/** The generators a `secrets` key may name. hub-key runs the hub image's own generator once as a Job and reads its one line from the log. */
export async function generateValue(spec, { run, site, root, job }) {
  if (spec.generate === 'random-32') return randomBytes(32).toString('base64url');
  const hub = /^hub-key:(signing|encryption)$/.exec(spec.generate ?? '');
  if (hub) {
    const image = resolveImage(readImagesLock(root), 'sterling/near-ai-hub', site.registry);
    const name = `sterling-hub-key-${randomBytes(4).toString('hex')}`;
    applyManifest(run, {
      apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace: job.namespace },
      spec: { backoffLimit: 0, template: { spec: {
        restartPolicy: 'Never', automountServiceAccountToken: false,
        securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
        containers: [{ name: 'generate', image: image.ref, imagePullPolicy: 'IfNotPresent', args: ['/app/bin.mjs', '--generate-key', hub[1]],
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } } }],
      } } },
    }, `Job ${name}`);
    const kubectl = tool('KUBECTL', 'kubectl');
    try {
      must(run(kubectl, ['wait', '-n', job.namespace, '--for=condition=complete', '--timeout=300s', `job/${name}`]), `wait for Job ${name}`);
      const line = must(run(kubectl, ['logs', '-n', job.namespace, `job/${name}`]), `logs of Job ${name}`).trim().split('\n').pop();
      if (!line) throw new Error(`Job ${name} printed no key.`);
      return line;
    } finally {
      run(kubectl, ['delete', 'job', '-n', job.namespace, name, '--ignore-not-found']);
    }
  }
  throw new Error(`no generator ${spec.generate ?? '(none)'}; the key ceremony or the operator writes this value into OpenBao first.`);
}

/** A Secret's decoded values, read into memory; null when it does not exist. */
export function clusterSecret(run, name, namespace) {
  const result = run(tool('KUBECTL', 'kubectl'), ['get', 'secret', name, '-n', namespace, '-o', 'json']);
  if (result.status !== 0) {
    if (/NotFound|not found/.test(result.stderr || '')) return null;
    throw new Error(`kubectl get secret ${namespace}/${name} failed: ${String(result.stderr).trim()}`);
  }
  const data = JSON.parse(result.stdout).data ?? {};
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()]));
}

/**
 * Bootstrap secrets (`bootstrap: true`) are needed before OpenBao runs: longhorn-crypto opens every encrypted volume, OpenBao's own among
 * them. Before such a release is installed, a missing Secret is made in memory and applied on stdin; the secrets step later copies the
 * cluster's value into OpenBao kv/apps, and it is escrowed (escrow.mjs). An existing Secret is never replaced.
 */
export async function ensureBootstrapSecrets({ root = ROOT, site, release, run = defaultRun, log = console.log }) {
  for (const entry of (release.secrets ?? []).filter((candidate) => candidate.bootstrap)) {
    const namespace = entry.namespace ?? release.namespace;
    if (clusterSecret(run, entry.secret, namespace)) continue;
    const data = {};
    for (const [key, spec] of Object.entries(entry.keys)) {
      data[key] = spec.value !== undefined ? String(spec.value) : await generateValue(spec, { run, site, root, job: { namespace } });
    }
    // The namespace exists already: sterling-network (order 15) makes every namespace with its Pod Security labels.
    applyManifest(run, secretManifest(entry.secret, namespace, data, entry.type ?? 'Opaque'), `Secret ${entry.secret}`);
    log(`apply: ${namespace}/${entry.secret} generated before OpenBao; the secrets step copies it into kv/apps/${entry.kv}. Escrow it (escrow.mjs export).`);
  }
}

/**
 * Static application secrets (D-41): for each `secrets` entry of every enabled descriptor, read kv/apps/<kv>, generate a missing field once,
 * refuse a value shorter than its minLength, then apply the Kubernetes Secret on stdin. Per-person secrets are never written here.
 * Entry: { secret, kv, namespace?, type?, keys: { <Secret key>: { field?, value? | generate?, minLength? } } }.
 */
export async function writeSecrets({ root = ROOT, site, bao, run = defaultRun, log = console.log, stateDir }) {
  const written = [];
  for (const release of listReleases(root).filter((candidate) => isEnabled(candidate, site))) {
    for (const entry of release.secrets ?? []) {
      const kvPath = `apps/${entry.kv}`;
      const existing = await bao.read(kvPath);
      const fields = { ...(existing?.data ?? {}) };
      let changed = false;
      const data = {};
      // A bootstrap secret was made in the cluster before OpenBao existed (ensureBootstrapSecrets): OpenBao takes the cluster's value.
      const inCluster = entry.bootstrap ? clusterSecret(run, entry.secret, entry.namespace ?? release.namespace) : null;
      for (const [key, spec] of Object.entries(entry.keys)) {
        if (spec.value !== undefined) { data[key] = String(spec.value); continue; }
        const field = spec.field ?? key;
        if (fields[field] === undefined || fields[field] === '') {
          fields[field] = inCluster?.[key] ?? await generateValue(spec, { run, site, root, job: { namespace: entry.namespace ?? release.namespace } });
          changed = true;
        }
        if (spec.minLength && String(fields[field]).length < spec.minLength) {
          throw new Error(`kv/${kvPath} ${field} is shorter than ${spec.minLength} characters; it must be a random value made by this script, never typed. `
            + 'Generating a new one would lock existing data, so replace it under the key ceremony.');
        }
        data[key] = String(fields[field]);
      }
      if (changed) await bao.write(kvPath, fields, existing ? existing.version : 0);
      applyManifest(run, secretManifest(entry.secret, entry.namespace ?? release.namespace, data, entry.type ?? 'Opaque'), `Secret ${entry.secret}`);
      written.push(`${entry.namespace ?? release.namespace}/${entry.secret}`);
      log(`secrets: ${entry.namespace ?? release.namespace}/${entry.secret} from kv/${kvPath}${changed ? ' (generated)' : ''}`);
    }
  }
  // The registry import account made by `registry` moves into OpenBao; the state file is removed once it is there.
  const authFile = stateDir ? path.join(stateDir, REGISTRY_AUTH) : '';
  if (authFile && existsSync(authFile)) {
    const existing = await bao.read('apps/registry');
    if (!existing) await bao.write('apps/registry', JSON.parse(readFileSync(authFile, 'utf8')), 0);
    rmSync(authFile, { force: true });
    log('secrets: the registry import account is in kv/apps/registry; its state file is removed.');
  }
  return written;
}

// ---- apply ------------------------------------------------------------------------------------------------------------------------------

/**
 * A one-line YAML scalar as text. Single-quoted: every character is literal (backslashes too) and '' is one quote. Double-quoted: YAML's
 * escapes, which for the values helm renders are JSON's. Plain: as written.
 */
export function yamlScalarValue(rest) {
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) return rest.slice(1, -1).replaceAll("''", "'");
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return JSON.parse(rest);
  return rest;
}

/** The data of a rendered ConfigMap as { key: text } (block scalars | and |-, and quoted or plain one-line values). */
export function configMapData(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => /^data:\s*$/.test(line));
  const data = {};
  if (start < 0) return data;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/^\s/.test(line)) break;
    const match = /^(\s+)([A-Za-z0-9._-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, key, rest] = match;
    if (/^\|-?\s*$/.test(rest)) {
      const body = [];
      let bodyIndent = null;
      while (index + 1 < lines.length && (lines[index + 1].trim() === '' || lines[index + 1].search(/\S/) > indent.length)) {
        index += 1;
        const next = lines[index];
        if (bodyIndent === null && next.trim()) bodyIndent = next.search(/\S/);
        body.push(next.slice(bodyIndent ?? 0));
      }
      data[key] = `${body.join('\n').replace(/\s+$/, '')}${rest.startsWith('|-') ? '' : '\n'}`;
    } else {
      data[key] = yamlScalarValue(rest);
    }
  }
  return data;
}

/** A curl config line value, quoted with curl's escapes. */
const curlQuote = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;

/** The response version OpenSearch requires for updating either existing policy. */
function policyVersionQuery(policy, what) {
  if (!Number.isSafeInteger(policy._seq_no) || policy._seq_no < 0 ||
      !Number.isSafeInteger(policy._primary_term) || policy._primary_term < 1) {
    throw new Error(`OpenSearch ${what} returned no usable policy version.`);
  }
  return `?if_seq_no=${policy._seq_no}&if_primary_term=${policy._primary_term}`;
}

/**
 * Applies the rendered OpenSearch settings from inside the first OpenSearch pod. Credentials and bodies are sent on stdin.
 * Each retry reads the policy versions again, including when a previous request succeeded without delivering its response.
 */
export function putOpenSearchObjects({ root = ROOT, site, siteDir, run = defaultRun, log = console.log, rendered }) {
  const yaml = rendered ?? renderRelease(root, 'opensearch', { site, siteDir });
  const docs = splitDocs(yaml).filter((doc) => /^kind:\s*ConfigMap\s*$/m.test(doc));
  const objects = OPENSEARCH_OBJECTS.map((object) => {
    const matches = docs.filter((doc) => new RegExp(`^\\s+name:\\s*${object.configMap}\\s*$`, 'm').test(doc));
    let body;
    let value;
    try {
      const values = matches.length === 1 ? Object.values(configMapData(matches[0])) : [];
      if (values.length === 1) {
        [body] = values;
        value = JSON.parse(body);
      }
    } catch {
      // Report the offending ConfigMap without printing the body.
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`OpenSearch requires one JSON object body for ${object.configMap}.`);
    }
    return { ...object, body };
  });

  const kubectl = tool('KUBECTL', 'kubectl');
  const secret = kubectlJson(run, ['get', 'secret', 'opensearch-admin', '-n', 'sterling-logging'], 'get secret opensearch-admin');
  const user = Buffer.from(secret.data.username, 'base64').toString();
  const password = Buffer.from(secret.data.password, 'base64').toString();
  const pod = kubectlJson(run, ['get', 'pods', '-n', 'sterling-logging', '-l', 'app.kubernetes.io/name=opensearch'], 'get opensearch pods').items?.[0]?.metadata?.name;
  if (!pod) throw new Error('No OpenSearch pod was found in sterling-logging.');

  const request = (method, target, body) => {
    const input = [
      `url = ${curlQuote(`https://localhost:9200/${target}`)}`, `request = ${curlQuote(method)}`,
      `user = ${curlQuote(`${user}:${password}`)}`, `cacert = ${curlQuote('/usr/share/opensearch/config/certs/ca.crt')}`,
      `write-out = ${curlQuote('\n%{http_code}')}`, 'silent', 'show-error',
    ];
    if (body !== undefined) input.push(`header = ${curlQuote('Content-Type: application/json')}`, `data-binary = ${curlQuote(body)}`);
    const result = run(kubectl, ['exec', '-i', '-n', 'sterling-logging', pod, '--', 'curl', '--config', '-'], { input: input.join('\n') });
    const what = `OpenSearch ${method} ${target}`;
    if (result.error || result.status !== 0) throw new Error(`${what} did not complete.`);
    const stdout = result.stdout ?? '';
    const suffix = /\n([1-5]\d{2})$/.exec(stdout);
    if (!suffix) throw new Error(`${what} returned no HTTP status.`);
    const status = Number(suffix[1]);
    let value;
    try { value = JSON.parse(stdout.slice(0, suffix.index)); } catch { throw new Error(`${what} returned invalid JSON (HTTP ${status}).`); }
    return { status, value };
  };

  const put = [];
  for (const object of objects) {
    let target = object.path;
    let method = 'PUT';
    if (object.configMap === 'opensearch-retention-policy') {
      // ISM returns the search hit count separately, including hits it could not parse as policies.
      const { status, value } = request('GET', '_plugins/_ism/policies?queryString=%22sterling-retention%22&size=2');
      const count = value?.total_policies;
      const policies = value?.policies;
      if (status !== 200 || (count !== 0 && count !== 1) || !Array.isArray(policies) || policies.length !== count) {
        throw new Error(`OpenSearch retention policy lookup returned an unexpected result (HTTP ${status}).`);
      }
      if (count === 1) {
        const [existing] = policies;
        if (existing?._id !== 'sterling-retention' || existing.policy?.policy_id !== 'sterling-retention') {
          throw new Error('OpenSearch retention policy lookup returned the wrong policy.');
        }
        target += policyVersionQuery(existing, 'retention policy lookup');
      }
    } else if (object.configMap === 'opensearch-snapshot-policy') {
      const { status, value } = request('GET', target);
      if (status === 200 && value?._id === 'sterling-audit-sm-policy' && value.sm_policy?.name === 'sterling-audit') {
        target += policyVersionQuery(value, 'snapshot policy lookup');
      } else if (status === 404 && value?.status === 404 && value.error?.type === 'status_exception' &&
          ['Snapshot management config index not found', 'Snapshot management policy not found'].includes(value.error.reason)) {
        method = 'POST';
      } else {
        throw new Error(`OpenSearch snapshot policy lookup returned an unexpected result (HTTP ${status}).`);
      }
    }
    const { status, value } = request(method, target, object.body);
    if (status !== 200 && status !== 201) throw new Error(`OpenSearch ${method} ${object.path} failed (HTTP ${status}).`);
    if (object.configMap === 'opensearch-snapshot-repository' && value?.acknowledged !== true) {
      throw new Error('OpenSearch did not acknowledge the snapshot repository.');
    }
    put.push(object.path);
    log(`apply: OpenSearch ${object.path} from ConfigMap ${object.configMap}`);
  }
  return put;
}

/**
 * Installs every enabled release in descriptor order (D-47, D-54), stopping at the two key ceremonies with the runbook to follow, and
 * resuming with `from`. `checks` gives OpenBao's state ({ sealStatus, intermediateSigned }); `steps` runs the as-code scripts. Returns
 * { installed, stopped } where stopped is null or { release, runbook, message }.
 */
export async function applySite({ root = ROOT, site, siteDir, state: stateDir, from = -Infinity, only, run = defaultRun, checks, steps, log = console.log }) {
  const state = readState(stateDir);
  const installed = [];
  const releases = listReleases(root).filter((release) => isEnabled(release, site) && release.order >= from && (!only || release.name === only));
  if (state.openSearchPending && (!only || only === 'opensearch') && !releases.some(({ name }) => name === 'opensearch')) {
    throw new Error('OpenSearch settings are pending. Resume apply from the OpenSearch release or earlier.');
  }
  const stop = (release, runbook, message, where = 'before') => {
    writeState(stateDir, state);
    log(`apply: stopped ${where} ${release.name}. ${message} Follow ${runbook}, then run install.mjs apply --from ${release.order}.`);
    return { installed, stopped: { release: release.name, order: release.order, runbook, message } };
  };
  for (const release of releases) {
    if (['zot', 'harbor'].includes(release.name)) continue; // the registry is installed by install.mjs registry, before the import
    if (release.name === 'sterling-pki-bootstrap' && state.bootstrapRemoved) continue;
    if (release.name === 'sterling-pki') {
      if (!(await checks.intermediateSigned())) return stop(release, RUNBOOKS.intermediate, 'pki_int has no signed intermediate yet.');
      if (!state.bootstrapRemoved && state.installed['sterling-pki-bootstrap'] !== undefined) {
        must(run(tool('HELM', 'helm'), ['uninstall', 'sterling-pki-bootstrap', '--namespace', 'cert-manager']), 'helm uninstall sterling-pki-bootstrap');
        state.bootstrapRemoved = true;
        delete state.installed['sterling-pki-bootstrap'];
      }
    }
    if (release.name === 'opensearch') {
      state.openSearchPending = true;
      delete state.installed.opensearch;
      writeState(stateDir, state);
    }
    await ensureBootstrapSecrets({ root, site, release, run, log });
    if (release.name === 'sterling-keycloak-realm') {
      steps.keycloakRealm();
    } else {
      const sets = release.name === 'sterling-admission' ? [`admission.mode=${state.admissionDeny ? 'Deny' : 'Audit'}`] : [];
      // OpenBao's pods are Ready only once it is initialised and unsealed, so its install does not wait for readiness.
      installRelease({ root, release, site, siteDir, run, sets, wait: release.name !== 'openbao' });
    }
    if (release.name === 'opensearch') {
      await steps.openSearchObjects();
      delete state.openSearchPending;
    }
    state.installed[release.name] = release.order;
    installed.push(release.name);
    writeState(stateDir, state);
    log(`apply: ${release.name} installed (order ${release.order})`);
    if (release.name === 'openbao') {
      const status = await checks.sealStatus();
      if (!status.initialized || status.sealed) return stop(release, RUNBOOKS.unseal, `OpenBao is ${status.initialized ? 'sealed' : 'not initialised'}.`, 'after');
      steps.openbaoApply();
      // The static application secrets (and the bootstrap ones, into OpenBao) before the releases that use them.
      await steps.secrets();
    }
  }
  // The admission switch comes last, and only when the import re-verified every image signature in the registry (D-48).
  if (!only && !state.admissionDeny) {
    const admission = listReleases(root).find((release) => release.name === 'sterling-admission');
    if (state.importAllSigned) {
      installRelease({ root, release: admission, site, siteDir, run, sets: ['admission.mode=Deny'] });
      state.admissionDeny = true;
      log('apply: admission switched to Deny (every imported image signature was present).');
    } else {
      log('apply: admission stays in Audit: the import has not reported every image signature present. Run install.mjs import, then apply again.');
    }
  }
  writeState(stateDir, state);
  return { installed, stopped: null };
}

// ---- status and retirement ------------------------------------------------------------------------------------------------------------

/** One line per release, per not-ready pod, OpenBao's seal state and each certificate. Returns { lines, problems }. */
export async function siteStatus({ run = defaultRun, bao }) {
  const lines = [];
  let problems = 0;
  const releases = JSON.parse(must(run(tool('HELM', 'helm'), ['list', '--all-namespaces', '-o', 'json']), 'helm list'));
  for (const release of releases) {
    lines.push(`release ${release.namespace}/${release.name}: ${release.status} (revision ${release.revision})`);
    if (release.status !== 'deployed') problems += 1;
  }
  for (const pod of kubectlJson(run, ['get', 'pods', '--all-namespaces'], 'get pods').items ?? []) {
    const ready = (pod.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    if (!ready && pod.status?.phase !== 'Succeeded') { lines.push(`pod ${pod.metadata.namespace}/${pod.metadata.name}: not ready (${pod.status?.phase})`); problems += 1; }
  }
  if (bao) {
    const status = await bao.sealStatus();
    lines.push(`openbao: ${status.initialized ? (status.sealed ? 'sealed' : 'unsealed') : 'not initialised'}`);
    if (!status.initialized || status.sealed) problems += 1;
  }
  for (const certificate of kubectlJson(run, ['get', 'certificates.cert-manager.io', '--all-namespaces'], 'get certificates').items ?? []) {
    const ready = (certificate.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    lines.push(`certificate ${certificate.metadata.namespace}/${certificate.metadata.name}: ${ready ? 'ready' : 'not ready'} (issuer ${certificate.spec?.issuerRef?.name})`);
    if (!ready) problems += 1;
  }
  return { lines, problems };
}

/**
 * Retires the bootstrap material once site-pki serves (D-16): refuses unless openbao-tls and zot-tls are Ready Certificates issued by site-pki;
 * then deletes Secret site-bootstrap-ca, the Keycloak bootstrap administrator (through `keycloak`) and Secret keycloak-admin-bootstrap, and
 * the bootstrap key files in the state folder.
 */
export async function retireBootstrap({ run = defaultRun, keycloak, state: stateDir, log = console.log }) {
  const certificates = kubectlJson(run, ['get', 'certificates.cert-manager.io', '--all-namespaces'], 'get certificates').items ?? [];
  for (const name of ['openbao-tls', 'zot-tls']) {
    const certificate = certificates.find((item) => item.metadata.name === name);
    const ready = (certificate?.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    if (!certificate || certificate.spec?.issuerRef?.name !== 'site-pki' || !ready) {
      throw new Error(`${name} is not yet a Ready certificate issued by site-pki; the bootstrap CA still serves it. Finish install.mjs apply first.`);
    }
  }
  const kubectl = tool('KUBECTL', 'kubectl');
  must(run(kubectl, ['delete', 'secret', 'site-bootstrap-ca', '-n', 'cert-manager', '--ignore-not-found']), 'delete Secret site-bootstrap-ca');
  await keycloak.deleteBootstrapAdmin();
  must(run(kubectl, ['delete', 'secret', 'keycloak-admin-bootstrap', '-n', 'sterling-identity', '--ignore-not-found']), 'delete Secret keycloak-admin-bootstrap');
  if (stateDir) {
    rmSync(path.join(stateDir, 'bootstrap'), { recursive: true, force: true });
    const state = readState(stateDir);
    state.bootstrapRetired = new Date().toISOString();
    writeState(stateDir, state);
  }
  log('retire-bootstrap: the bootstrap CA and the Keycloak bootstrap administrator are removed.');
}

/** Keycloak's admin API over node:https with the site CA, signed in as the bootstrap administrator from its Secret (read into memory). */
export function keycloakBootstrapClient({ site, caFile, run = defaultRun }) {
  const secret = kubectlJson(run, ['get', 'secret', 'keycloak-admin-bootstrap', '-n', 'sterling-identity'], 'get secret keycloak-admin-bootstrap');
  const username = Buffer.from(secret.data.username, 'base64').toString();
  const password = Buffer.from(secret.data.password, 'base64').toString();
  const base = `https://keycloak.${site.domain}`;
  const ca = readFileSync(caFile);
  const call = (method, apiPath, { body, form, token } = {}) => new Promise((resolve, reject) => {
    const payload = form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : null;
    const request = https.request(new URL(apiPath, base), { method, ca, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
  return {
    async deleteBootstrapAdmin() {
      const login = await call('POST', '/realms/master/protocol/openid-connect/token', { form: { grant_type: 'password', client_id: 'admin-cli', username, password } });
      if (login.status !== 200) throw new Error(`Keycloak refused the bootstrap administrator's sign-in (HTTP ${login.status}); it may already be removed.`);
      const token = login.body.access_token;
      const users = (await call('GET', '/admin/realms/master/users?max=100', { token })).body ?? [];
      const me = users.find((user) => user.username === username);
      if (!me) return;
      if (!users.some((user) => user.username !== username && user.enabled)) {
        throw new Error('The master realm has no other enabled administrator; create your permanent administrator first (site-install.md).');
      }
      const removed = await call('DELETE', `/admin/realms/master/users/${me.id}`, { token });
      if (removed.status !== 204) throw new Error(`Keycloak did not delete the bootstrap administrator (HTTP ${removed.status}).`);
    },
  };
}

// ---- CLI ------------------------------------------------------------------------------------------------------------------------------

const USAGE = `usage: node deploy/bundle/install.mjs <step> [flags]   (deploy/runbooks/site-install.md)
  node-files       --site <file> --out <dir> --ca <site CA pem> [--artifacts <dir>] [--bundle <install dir>]
  bootstrap-ca     --site <file> --state <dir>
  registry         --site <file> --site-dir <dir> --state <dir>
  import           --site <file> --state <dir> --bundle <bundle dir> --public-key <cosign pub> --out <install dir>
  preflight        --site <file> --site-dir <dir> --bundle <install dir> [--lab]
  secrets          --site <file> --site-dir <dir> --state <dir> --bao <addr> --ca-file <pem> --token-file <file>
  apply            --site <file> --site-dir <dir> --state <dir> --bao <addr> --ca-file <pem> --token-file <file> [--from <order>] [--release <name>]
  status           [--bao <addr> --ca-file <pem> --token-file <file>]
  retire-bootstrap --site <file> --state <dir> --ca-file <site CA pem>`;

export async function main(argv, { run = defaultRun, log = console.log, error = console.error } = {}) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || !SUBCOMMANDS.includes(command)) { log(USAGE); return command === '--help' ? 0 : 2; }
  const option = (flag) => { const index = rest.indexOf(flag); return index < 0 ? undefined : rest[index + 1]; };
  const need = (flag) => { const value = option(flag); if (!value) throw Object.assign(new Error(`${command} needs ${flag}.\n${USAGE}`), { usage: true }); return value; };
  const site = () => loadSite(need('--site'));
  const bao = () => baoClient({ addr: need('--bao'), caFile: need('--ca-file'), tokenFile: need('--token-file') });
  try {
    if (command === 'preflight') {
      const { problems, notes } = sitePreflight({ site: site(), siteDir: need('--site-dir'), bundle: option('--bundle'), lab: rest.includes('--lab'), run });
      for (const note of notes) log(note);
      for (const problem of problems) error(problem);
      if (problems.length) return 1;
      log('preflight: the site is ready to install.');
      return 0;
    }
    if (command === 'node-files') {
      const result = nodeFiles({ site: site(), out: need('--out'), ca: need('--ca'), artifacts: option('--artifacts'), bundle: option('--bundle') });
      log(`node-files: wrote ${result.files.join(', ')} in ${result.out}`);
      if (result.missing.length) log(`node-files: copy these from the imported bundle before using the folder: ${result.missing.join(', ')}`);
      return 0;
    }
    if (command === 'bootstrap-ca') {
      const { caFile } = bootstrapCa({ site: site(), state: need('--state'), run });
      log(`bootstrap-ca: the bootstrap CA certificate is ${caFile}; node-files takes it as --ca.`);
      return 0;
    }
    if (command === 'registry') {
      installRegistry({ site: site(), siteDir: need('--site-dir'), state: need('--state'), run });
      log('registry: installed.');
      return 0;
    }
    if (command === 'import') {
      importStep({ site: site(), state: need('--state'), bundle: need('--bundle'), publicKey: need('--public-key'), out: need('--out'), run });
      log('import: every image is in the site registry with its signature verified.');
      return 0;
    }
    if (command === 'secrets') {
      await writeSecrets({ site: site(), bao: bao(), run, log, stateDir: need('--state') });
      return 0;
    }
    if (command === 'apply') {
      const settings = site();
      const siteDir = need('--site-dir');
      const client = bao();
      const flags = ['--addr', need('--bao'), '--ca-file', need('--ca-file'), '--token-file', need('--token-file'), '--site', need('--site')];
      const { stopped } = await applySite({
        site: settings, siteDir, state: need('--state'), from: option('--from') === undefined ? -Infinity : Number(option('--from')), only: option('--release'), run, log,
        checks: client,
        steps: {
          openbaoApply: () => must(run(process.execPath, [path.join(ROOT, 'deploy/openbao/apply.mjs'), ...flags]), 'deploy/openbao/apply.mjs'),
          keycloakRealm: () => must(run(process.execPath, [path.join(ROOT, 'deploy/keycloak/apply.mjs'), '--site', need('--site'),
            '--realm-site', path.join(siteDir, 'sterling-keycloak-realm.yaml'), '--keycloakx-site', path.join(siteDir, 'keycloakx.yaml')]), 'deploy/keycloak/apply.mjs'),
          openSearchObjects: () => putOpenSearchObjects({ site: settings, siteDir, run, log }),
          secrets: () => writeSecrets({ site: settings, bao: client, run, log, stateDir: need('--state') }),
        },
      });
      return stopped ? 3 : 0;
    }
    if (command === 'status') {
      const { lines, problems } = await siteStatus({ run, bao: option('--bao') ? bao() : null });
      for (const line of lines) log(line);
      return problems ? 1 : 0;
    }
    const settings = site();
    await retireBootstrap({ run, state: need('--state'), keycloak: keycloakBootstrapClient({ site: settings, caFile: need('--ca-file'), run }), log });
    return 0;
  } catch (problem) {
    error(problem.usage ? problem.message : `install: ${problem.message}`);
    return problem.usage ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
