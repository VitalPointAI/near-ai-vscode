// The site install (47-16): every preflight refusal, the node folder, the bootstrap CA, secret handling with a spawn spy, and the ordered
// apply with its ceremony stops, resume, admission switch, OpenSearch objects and bootstrap retirement, all with a fake runner (no cluster).
// Needs helm ($HELM or PATH) for the CI-site renders and openssl for the bootstrap CA.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  OPENSEARCH_OBJECTS, applySite, bootstrapCa, configMapData, installRegistry, main, nodeFiles, putOpenSearchObjects, readState,
  retireBootstrap, writeSecrets, writeState,
} from '../bundle/install.mjs';
import { preflight } from '../bundle/lib/preflight.mjs';
import { recordDigests } from '../bundle/record-digests.mjs';
import { UNPUBLISHED_DIGEST, readImagesLock } from '../bundle/lib/locks.mjs';
import { nameForSite, writeRegistryLayout } from '../bundle/lib/registry-images.mjs';
import { isEnabled, listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CI_FILE = path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml');
const CI = loadSite(CI_FILE);
const temp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const LOCK = readImagesLock(ROOT);
const tracking = (name) => readFileSync(path.join(ROOT, `deploy/test/fixtures/chrony/${name}.csv`), 'utf8');
const chronyc = (name) => () => ({ status: 0, stdout: tracking(name), stderr: '' });
const MANIFEST = { version: '1.0.0', items: [{ kind: 'image', name: 'jetstack/cert-manager-controller', digest: `sha256:${'a'.repeat(64)}` }], omitted: [] };

/** A copy of the per-site example folder with `edits` ({ file: (text) => text }) applied. */
function siteDir(edits = {}) {
  const dir = temp('site-dir-');
  cpSync(path.join(ROOT, 'deploy/values/site.example'), dir, { recursive: true });
  for (const [file, edit] of Object.entries(edits)) writeFileSync(path.join(dir, file), edit(readFileSync(path.join(dir, file), 'utf8')));
  return dir;
}
const check = (overrides = {}) => preflight({
  site: CI, siteDir: siteDir(), manifest: MANIFEST, renderAll: () => [], lock: LOCK, lab: false, run: chronyc('synced'), ...overrides,
});
const rules = (result) => result.problems.map((problem) => problem.split(':')[0]);

test('preflight: the CI site with a published bundle and a synchronised import host passes', () => {
  const result = check({ renderAll: () => [] });
  assert.deepEqual(result.problems, []);
});

test('preflight refuses each unsafe site setting before anything changes (D-08, D-11, D-17, D-31, D-57)', () => {
  const cases = [
    [{ requestedStorage: '' }, 'requested-storage'],
    [{ signInKeys: 'password' }, 'sign-in-keys'],
    [{ signInKeys: 'hardware-only', acceptableAaguids: [] }, 'aaguid-allowlist'],
    [{ rpId: 'other.example' }, 'rp-id'],
    [{ rpId: 'site.example.evil' }, 'rp-id'],
    [{ storageProvider: 'nfs', storageEncryptionAtRest: '' }, 'storage-encryption'],
    [{ organizationPublicKey: 'not a key' }, 'organization-key'],
  ];
  for (const [change, rule] of cases) assert.deepEqual(rules(check({ site: { ...CI, ...change } })), [rule], JSON.stringify(change));
  assert.deepEqual(rules(check({ site: { ...CI, rpId: 'example', domain: 'site.example' } })), [], 'a parent of the domain is accepted');
  assert.deepEqual(rules(check({ site: { ...CI, storageProvider: 'nfs', storageEncryptionAtRest: 'array encryption' } })), []);
});

test('preflight refuses unpublished images, omitted items and the lab placeholder unless --lab (D-12, D-55)', () => {
  const unpublished = { ...MANIFEST, items: [{ kind: 'image', name: 'sterling/openbao', digest: UNPUBLISHED_DIGEST }] };
  assert.deepEqual(rules(check({ manifest: unpublished })), ['unpublished-image']);
  assert.deepEqual(rules(check({ manifest: { ...MANIFEST, omitted: ['sterling/sterling-workbench'] } })), ['omitted-items']);
  const placeholder = siteDir({ 'sterling-sessions.yaml': (text) => text.replace('usePlaceholder: false', 'usePlaceholder: true') });
  assert.deepEqual(rules(check({ siteDir: placeholder })), ['lab-placeholder']);
  assert.deepEqual(rules(check({ manifest: null })), ['bundle']);
  const lab = check({ lab: true, siteDir: placeholder, manifest: { ...unpublished, omitted: ['sterling/sterling-workbench'] }, run: chronyc('unsynced') });
  assert.deepEqual(lab.problems, []);
  assert.deepEqual(lab.notes, ['host-clock: skipped (--lab).']);
});

test('preflight refuses a site file with no time source and an import host whose clock fails (D-71)', () => {
  assert.deepEqual(rules(check({ site: { ...CI, time: { ...CI.time, servers: [], refclocks: [] } } })), ['time-settings']);
  for (const name of ['unsynced', 'local', 'far']) assert.deepEqual([...new Set(rules(check({ run: chronyc(name) })))], ['host-clock'], name);
  const missing = check({ run: () => ({ error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) });
  assert.match(missing.problems[0], /^host-clock: the import host: chronyc is not installed/);
});

test('preflight refuses SoftHSM2 as the OpenBao seal outside the lab (softhsm-seal-token, D-38)', () => {
  const softhsm = siteDir({ 'openbao.yaml': (text) => text.replace('lib: /usr/lib64/site-hsm/libpkcs11.so', 'lib: /usr/lib64/softhsm/libsofthsm2.so') });
  assert.deepEqual(rules(check({ siteDir: softhsm })), ['softhsm-seal-token']);
  assert.deepEqual(rules(check({ renderAll: () => [{ name: 'openbao', yaml: '' }, { name: 'openbao', yaml: 'kind: Pod\nmetadata:\n  name: x\n' }] })), []);
  const image = `${CI.registry}/sterling/openbao-softhsm@${UNPUBLISHED_DIGEST}`;
  assert.deepEqual(rules(check({ renderAll: () => [{ name: 'openbao', yaml: `kind: Pod\nmetadata:\n  name: x\nspec:\n  containers:\n    - image: ${image}\n` }] })),
    ['softhsm-seal-token']);
  assert.deepEqual(rules(check({ siteDir: softhsm, lab: true })), []);
});

test('preflight runs the CI hardening invariants on the site\'s own render (D-56)', () => {
  const bad = [{ name: 'x', yaml: 'kind: Pod\nmetadata:\n  name: x\nspec:\n  containers:\n    - image: quay.io/x/y:latest\n' }];
  assert.deepEqual(rules(check({ renderAll: () => bad })), ['render']);
  assert.deepEqual(rules(check({ renderAll: () => { throw new Error('helm template failed'); } })), ['render']);
});

test('install.mjs preflight on the CI site reports the omitted workbench unless --lab', async () => {
  const bundle = temp('bundle-');
  writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ ...MANIFEST, omitted: ['sterling/sterling-workbench'] }));
  const run = async (extra) => {
    const lines = [];
    const code = await main(['preflight', '--site', CI_FILE, '--site-dir', path.join(ROOT, 'deploy/values/site.example'), '--bundle', bundle, ...extra],
      { run: chronyc('synced'), log: (line) => lines.push(line), error: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  };
  const production = await run([]);
  assert.equal(production.code, 1);
  assert.match(production.text, /^omitted-items: the bundle leaves out sterling\/sterling-workbench/m);
  const lab = await run(['--lab']);
  assert.equal(lab.code, 0, lab.text);
  assert.match(lab.text, /host-clock: skipped \(--lab\)\.\npreflight: the site is ready to install\./);
});

test('node-files writes the clock files, the pins and the RKE2 files; chrony.conf names only the CI site servers', () => {
  const out = temp('node-');
  const ca = path.join(temp('ca-'), 'ca.crt');
  writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n');
  const { files, missing } = nodeFiles({ site: CI, out, ca });
  for (const name of ['chrony.conf', 'clock.env', 'check-time.sh', 'install-node.sh', 'escrow-node.sh', 'config.yaml', 'registries.yaml', 'audit-policy.yaml',
    'psa.yaml', 'site-ca.crt', 'pins.sha256']) assert.ok(files.includes(name), name);
  const servers = readFileSync(path.join(out, 'chrony.conf'), 'utf8').split('\n').filter((line) => /^(server|pool|refclock) /.test(line));
  assert.deepEqual(servers, ['server time1.site.example iburst', 'server time2.site.example iburst']);
  assert.doesNotMatch(readFileSync(path.join(out, 'config.yaml'), 'utf8'), /\$\{site\./);
  assert.match(readFileSync(path.join(out, 'pins.sha256'), 'utf8'), /^[0-9a-f]{64} {2}rke2\.linux-amd64\.tar\.gz$/m);
  assert.ok(missing.includes('rke2.linux-amd64.tar.gz'), 'artifacts not given are listed to copy');
});

test('the registry images archive is site-neutral in the bundle and named for the site registry by node-files (Pitfall 8)', () => {
  const store = temp('store-');
  mkdirSync(path.join(store, 'blobs/sha256'), { recursive: true });
  const blob = (text) => { const hex = createHash('sha256').update(text).digest('hex'); writeFileSync(path.join(store, 'blobs/sha256', hex), text); return `sha256:${hex}`; };
  const config = blob('{"architecture":"amd64"}');
  const layer = blob('layer bytes');
  const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { digest: config, size: 24 }, layers: [{ digest: layer, size: 11 }] });
  const digest = blob(manifest);
  const archive = writeRegistryLayout(store, [{ path: 'project-zot/zot', tag: 'v2.1.23', digest }], path.join(temp('bundle-'), 'registry-images.tar'));
  const neutral = spawnSync('tar', ['-xOf', archive, './index.json'], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(neutral, /io\.containerd\.image\.name/);
  // node-files checks the archive against the signed manifest's digest before naming it.
  const install = temp('install-');
  cpSync(archive, path.join(install, 'registry-images.tar'));
  const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(path.join(install, 'manifest.json'), JSON.stringify({ ...MANIFEST, items: [{ kind: 'file', name: 'registry-images.tar', digest: `sha256:${sha}` }] }));
  const ca = path.join(install, 'ca.crt');
  writeFileSync(ca, 'ca');
  const out = temp('node-');
  nodeFiles({ site: CI, out, ca, artifacts: install, bundle: install });
  const named = JSON.parse(spawnSync('tar', ['-xOf', path.join(out, 'images/registry-images.tar'), './index.json'], { encoding: 'utf8' }).stdout);
  assert.deepEqual(named.manifests.map((entry) => entry.annotations['io.containerd.image.name']),
    [`${CI.registry}/project-zot/zot:v2.1.23`, `${CI.registry}/project-zot/zot@${digest}`]);
  assert.ok(named.manifests.every((entry) => entry.digest === digest), 'the manifest is the bundle\'s, byte for byte');
  const pinned = readFileSync(path.join(out, 'pins.sha256'), 'utf8');
  assert.match(pinned, new RegExp(`^${createHash('sha256').update(readFileSync(path.join(out, 'images/registry-images.tar'))).digest('hex')}  images/registry-images\\.tar$`, 'm'));
  writeFileSync(path.join(install, 'registry-images.tar'), 'changed');
  assert.throws(() => nodeFiles({ site: CI, out: temp('node-'), ca, artifacts: install, bundle: install }), /does not match its digest in the bundle manifest/);
  assert.ok(nameForSite);
});

test('bootstrap-ca makes a 90-day CA and the registry certificate, kept 0600 in a 0700 state folder, once (D-16)', () => {
  const state = temp('state-');
  const { caFile, dir } = bootstrapCa({ site: CI, state });
  assert.equal(statSync(state).mode & 0o777, 0o700);
  const ca = new X509Certificate(readFileSync(caFile));
  assert.equal(ca.ca, true);
  assert.ok(Date.parse(ca.validTo) - Date.now() <= 91 * 86_400_000);
  for (const name of ['site-bootstrap-ca.secret.json', 'zot-tls.secret.json']) assert.equal(statSync(path.join(dir, name)).mode & 0o777, 0o600, name);
  const tls = JSON.parse(readFileSync(path.join(dir, 'zot-tls.secret.json'), 'utf8'));
  assert.deepEqual([tls.metadata.namespace, tls.type], ['sterling-registry', 'kubernetes.io/tls']);
  const leaf = new X509Certificate(Buffer.from(tls.data['tls.crt'], 'base64'));
  assert.match(leaf.subjectAltName, /DNS:registry\.site\.example/);
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.throws(() => bootstrapCa({ site: CI, state }), /already holds a bootstrap CA/);
});

/** A fake runner: records every call; answers kubectl and helm from `answers` (a function of args), otherwise succeeds with empty output. */
function fakeRun(answers = () => null) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, input: options.input });
    const answer = answers(command, args, options);
    if (answer) return answer;
    // A Secret the test did not set up does not exist in the fake cluster.
    if (args[0] === 'get' && args[1] === 'secret') return { status: 1, stdout: '', stderr: `Error from server (NotFound): secrets "${args[2]}" not found` };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}
const argvText = (calls) => calls.map((call) => [call.command, ...call.args].join(' ')).join('\n');

/** A fake OpenBao KV store. */
function fakeBao(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, data]) => [key, { data, version: 1 }]));
  const writes = [];
  return {
    store, writes,
    async read(kvPath) { return store.get(kvPath) ?? null; },
    async write(kvPath, data, cas) { writes.push({ kvPath, cas }); store.set(kvPath, { data: { ...data }, version: (store.get(kvPath)?.version ?? 0) + 1 }); },
  };
}

test('secrets: values travel only on stdin, kv is written only when absent, and a short volume key is refused (D-41, G420)', async () => {
  const { run, calls } = fakeRun();
  const bao = fakeBao();
  await writeSecrets({ site: CI, bao, run, log: () => {} });
  assert.deepEqual(bao.writes.map((write) => `${write.kvPath} cas ${write.cas}`).sort(),
    ['apps/keycloak-bootstrap cas 0', 'apps/postgres cas 0', 'apps/storage cas 0']);
  const key = bao.store.get('apps/storage').data.CRYPTO_KEY_VALUE;
  assert.ok(key.length >= 43, 'at least 256 random bits');
  const values = [key, bao.store.get('apps/postgres').data['keycloak-password'], bao.store.get('apps/keycloak-bootstrap').data.password];
  for (const value of values) assert.ok(!argvText(calls).includes(value), 'no secret value in any argv');
  const applied = calls.filter((call) => call.args.join(' ') === 'apply -f -').map((call) => JSON.parse(call.input));
  assert.deepEqual(applied.map((secret) => `${secret.metadata.namespace}/${secret.metadata.name}`),
    ['longhorn-system/longhorn-crypto', 'sterling-identity/postgres-superuser', 'sterling-identity/keycloak-db', 'sterling-identity/keycloak-admin-bootstrap']);
  const crypto = applied[0];
  assert.equal(Buffer.from(crypto.data.CRYPTO_KEY_VALUE, 'base64').toString(), key);
  assert.equal(Buffer.from(applied[2].data.password, 'base64').toString(), values[1], 'Keycloak and Postgres share the password');
  // A second run reads what is there and writes nothing to OpenBao.
  bao.writes.length = 0;
  await writeSecrets({ site: CI, bao, run: fakeRun().run, log: () => {} });
  assert.deepEqual(bao.writes, []);
  // A volume key that is not a generated random value is refused, never silently replaced.
  const weak = fakeBao({ 'apps/storage': { CRYPTO_KEY_VALUE: 'password123' } });
  await assert.rejects(writeSecrets({ site: CI, bao: weak, run: fakeRun().run, log: () => {} }), /CRYPTO_KEY_VALUE is shorter than 43 characters/);
});

test('registry: the import password reaches htpasswd and the cluster on stdin only', () => {
  const state = temp('state-');
  bootstrapCa({ site: CI, state });
  const { run, calls } = fakeRun((command) => (command === 'htpasswd' ? { status: 0, stdout: 'import:$2y$05$abcdefghijklmnopqrstuuJ0ZqTpZq1v8Qm7eS9bWlK2s0xq3m4yC\n', stderr: '' } : null));
  installRegistry({ site: CI, siteDir: path.join(ROOT, 'deploy/values/site.example'), state, run });
  const password = JSON.parse(readFileSync(path.join(state, 'registry-auth.json'), 'utf8')).password;
  assert.equal(statSync(path.join(state, 'registry-auth.json')).mode & 0o777, 0o600);
  assert.ok(!argvText(calls).includes(password));
  assert.equal(calls.find((call) => call.command === 'htpasswd').input, `${password}\n`);
  assert.ok(calls.some((call) => call.args.slice(0, 3).join(' ') === 'upgrade --install zot'), 'the zot release is installed');
});

/** The fake checks and steps for apply. */
const ready = { sealStatus: async () => ({ initialized: true, sealed: false }), intermediateSigned: async () => true };
function steps() {
  const done = [];
  return { done, openbaoApply: () => done.push('openbao-apply'), secrets: async () => { done.push('secrets'); }, keycloakRealm: () => done.push('realm'),
    openSearchObjects: () => done.push('opensearch-objects') };
}
const helmInstalls = (calls) => calls.filter((call) => call.args[0] === 'upgrade').map((call) => call.args[2]);
const siteExample = path.join(ROOT, 'deploy/values/site.example');

test('apply installs the enabled releases in descriptor order, running the as-code steps between them', async () => {
  const state = temp('state-');
  const { run, calls } = fakeRun();
  const done = steps();
  const { stopped } = await applySite({ site: CI, siteDir: siteExample, state, run, checks: ready, steps: done, log: () => {} });
  assert.equal(stopped, null);
  const expected = listReleases(ROOT).filter((release) => isEnabled(release, CI) && !['zot', 'harbor', 'sterling-keycloak-realm'].includes(release.name))
    .flatMap((release) => (release.instances ? CI[release.instances].map((item) => `${release.name}-${item.name}`) : [release.name]));
  assert.deepEqual(helmInstalls(calls), expected);
  assert.deepEqual(done.done, ['openbao-apply', 'secrets', 'realm', 'opensearch-objects']);
  assert.ok(!calls.some((call) => call.args[0] === 'upgrade' && call.args[2] === 'openbao' && call.args.includes('--wait')), 'OpenBao is Ready only once unsealed');
  assert.ok(calls.some((call) => call.args.join(' ') === 'uninstall sterling-pki-bootstrap --namespace cert-manager'), 'the bootstrap release goes before sterling-pki');
});

test('apply stops at the unseal ceremony and before an unsigned intermediate, then resumes with --from', async () => {
  const state = temp('state-');
  const logs = [];
  let sealed = true;
  let signed = false;
  const checks = { sealStatus: async () => ({ initialized: !sealed, sealed }), intermediateSigned: async () => signed };
  const first = fakeRun();
  const one = await applySite({ site: CI, siteDir: siteExample, state, run: first.run, checks, steps: steps(), log: (line) => logs.push(line) });
  assert.equal(helmInstalls(first.calls).at(-1), 'openbao');
  assert.match(one.stopped.runbook, /key-ceremony\.md \(OpenBao initialisation and unseal\)/);
  assert.match(logs.at(-1), /stopped after openbao\. OpenBao is not initialised\..*install\.mjs apply --from 40/);
  sealed = false;
  const second = fakeRun();
  const two = await applySite({ site: CI, siteDir: siteExample, state, from: one.stopped.order, run: second.run, checks, steps: steps(), log: (line) => logs.push(line) });
  assert.deepEqual(helmInstalls(second.calls), ['openbao'], 'the resume re-applies OpenBao, then stops before sterling-pki');
  assert.equal(two.stopped.release, 'sterling-pki');
  assert.match(two.stopped.runbook, /a site intermediate/);
  signed = true;
  const third = fakeRun();
  const three = await applySite({ site: CI, siteDir: siteExample, state, from: two.stopped.order, run: third.run, checks, steps: steps(), log: () => {} });
  assert.equal(three.stopped, null);
  assert.equal(helmInstalls(third.calls)[0], 'sterling-pki');
});

test('apply again on an installed site only upgrades; admission goes to Deny only after the import found every signature', async () => {
  const state = temp('state-');
  const admissionModes = (calls) => calls.filter((call) => call.args[2] === 'sterling-admission')
    .map((call) => call.args[call.args.indexOf('admission.mode=Audit') >= 0 ? call.args.indexOf('admission.mode=Audit') : call.args.indexOf('admission.mode=Deny')]);
  const first = fakeRun();
  await applySite({ site: CI, siteDir: siteExample, state, run: first.run, checks: ready, steps: steps(), log: () => {} });
  assert.deepEqual(admissionModes(first.calls), ['admission.mode=Audit']);
  assert.equal(readState(state).admissionDeny, false);
  const recorded = readState(state);
  writeState(state, { ...recorded, importAllSigned: true });
  const second = fakeRun();
  await applySite({ site: CI, siteDir: siteExample, state, run: second.run, checks: ready, steps: steps(), log: () => {} });
  assert.deepEqual(admissionModes(second.calls), ['admission.mode=Audit', 'admission.mode=Deny'], 'Deny is the last step');
  assert.ok(second.calls.filter((call) => call.command.endsWith('helm') || call.command === 'helm').every((call) => call.args[0] === 'upgrade'), 'only upgrades');
  assert.ok(!helmInstalls(second.calls).includes('sterling-pki-bootstrap'), 'the bootstrap release is not reinstalled');
  const third = fakeRun();
  await applySite({ site: CI, siteDir: siteExample, state, run: third.run, checks: ready, steps: steps(), log: () => {} });
  assert.deepEqual(admissionModes(third.calls), ['admission.mode=Deny']);
});

test('retire-bootstrap waits for site-pki to serve openbao-tls and zot-tls, then removes the bootstrap CA and administrator', async () => {
  const certificate = (name, issuer, ready = true) => ({ metadata: { name, namespace: 'x' }, spec: { issuerRef: { name: issuer } },
    status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] } });
  const answer = (items) => (command, args) => (args[0] === 'get' ? { status: 0, stdout: JSON.stringify({ items }), stderr: '' } : null);
  let removed = 0;
  const keycloak = { deleteBootstrapAdmin: async () => { removed += 1; } };
  const early = fakeRun(answer([certificate('openbao-tls', 'site-bootstrap-ca'), certificate('zot-tls', 'site-pki')]));
  await assert.rejects(retireBootstrap({ run: early.run, keycloak, log: () => {} }), /openbao-tls is not yet a Ready certificate issued by site-pki/);
  assert.equal(early.calls.filter((call) => call.args[0] === 'delete').length, 0);
  const late = fakeRun(answer([certificate('openbao-tls', 'site-pki'), certificate('zot-tls', 'site-pki')]));
  const state = temp('state-');
  bootstrapCa({ site: CI, state });
  await retireBootstrap({ run: late.run, keycloak, state, log: () => {} });
  assert.deepEqual(late.calls.filter((call) => call.args[0] === 'delete').map((call) => call.args.slice(1, 4).join(' ')),
    ['secret site-bootstrap-ca -n', 'secret keycloak-admin-bootstrap -n']);
  assert.equal(removed, 1);
  assert.throws(() => statSync(path.join(state, 'bootstrap')), /ENOENT/, 'the bootstrap key files are gone');
});

test('apply keeps OpenSearch pending until its objects finish and cannot resume past a failure', async () => {
  const state = temp('state-');
  const release = listReleases(ROOT).find(({ name }) => name === 'opensearch');
  writeState(state, { ...readState(state), installed: { opensearch: release.order }, importAllSigned: true });
  const logs = [];
  const options = { site: CI, siteDir: siteExample, state, checks: ready, log: (line) => logs.push(line) };
  const failed = fakeRun((_, args) => {
    if (args[0] === 'upgrade' && args[2] === 'opensearch') {
      assert.equal(readState(state).openSearchPending, true, 'the marker precedes Helm');
      assert.equal(readState(state).installed.opensearch, undefined);
    }
    return null;
  });
  const interrupted = { ...steps(), openSearchObjects: () => { throw new Error('snapshot repository write failed'); } };
  await assert.rejects(applySite({ ...options, from: release.order, run: failed.run, steps: interrupted }), /snapshot repository write failed/);
  assert.deepEqual(helmInstalls(failed.calls), ['opensearch']);
  assert.equal(readState(state).openSearchPending, true);
  assert.equal(readState(state).admissionDeny, false);
  assert.ok(!logs.some((line) => line.includes('opensearch installed')));

  const skipped = fakeRun();
  await assert.rejects(applySite({ ...options, from: release.order + 1, run: skipped.run, steps: steps() }), /OpenSearch.*pending/i);
  await assert.rejects(applySite({ ...options, only: 'opensearch', from: release.order + 1, run: skipped.run, steps: steps() }), /OpenSearch.*pending/i);
  assert.deepEqual(skipped.calls, []);
  await applySite({ ...options, only: 'prometheus', run: skipped.run, steps: steps() });
  assert.deepEqual(helmInstalls(skipped.calls), ['prometheus']);
  assert.equal(readState(state).openSearchPending, true);
  assert.equal(readState(state).admissionDeny, false);

  const retry = fakeRun();
  const recovered = { ...steps(), openSearchObjects: async () => {
    await Promise.resolve();
    assert.equal(readState(state).openSearchPending, true);
    assert.equal(readState(state).installed.opensearch, undefined);
  } };
  const applied = await applySite({ ...options, from: release.order, run: retry.run, steps: recovered });
  assert.equal(applied.installed[0], 'opensearch');
  assert.equal(readState(state).installed.opensearch, release.order);
  assert.equal(readState(state).openSearchPending, undefined);
  assert.equal(readState(state).admissionDeny, true);
});

const openSearchPassword = 'opensearch-admin-password-not-real';
const http = (status, body) => ({ status: 0, stdout: JSON.stringify(body) + '\n' + status, stderr: '' });
const missingSnapshot = (reason) => http(404, { error: { type: 'status_exception', reason }, status: 404 });
const retentionPolicy = { _id: 'sterling-retention', _seq_no: 0, _primary_term: 1, policy: { policy_id: 'sterling-retention' } };
const snapshotPolicy = { _id: 'sterling-audit-sm-policy', _seq_no: 5, _primary_term: 2, sm_policy: { name: 'sterling-audit' } };

function fakeOpenSearch(answer) {
  return fakeRun((_, args, { input }) => {
    if (args[0] === 'get' && args[1] === 'secret') return { status: 0, stdout: JSON.stringify({ data: { username: Buffer.from('admin').toString('base64'), password: Buffer.from(openSearchPassword).toString('base64') } }), stderr: '' };
    if (args[0] === 'get' && args[1] === 'pods') return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: 'opensearch-cluster-master-0' } }] }), stderr: '' };
    const target = /^url = "https:\/\/localhost:9200\/([^"]+)"/m.exec(input)?.[1];
    const method = /^request = "([A-Z]+)"/m.exec(input)?.[1] ?? 'GET';
    return answer(target, method);
  });
}

test('a retry reconciles both OpenSearch policies after a write succeeds but its response is lost', () => {
  const rendered = renderRelease(ROOT, 'opensearch', { site: CI, siteDir: siteExample });
  assert.ok(OPENSEARCH_OBJECTS.every((object) => rendered.includes(`name: ${object.configMap}`)), 'all required objects render');
  let retentionCreated = false;
  let snapshotCreated = false;
  const { run, calls } = fakeOpenSearch((target, method) => {
    if (target.startsWith('_plugins/_ism/policies?') && method === 'GET') {
      assert.match(target, /^_plugins\/_ism\/policies\?queryString=%22sterling-retention%22&size=2$/);
      return http(200, { policies: retentionCreated ? [retentionPolicy] : [], total_policies: Number(retentionCreated) });
    }
    if (target.startsWith('_plugins/_ism/policies/sterling-retention') && method === 'PUT') {
      assert.equal(target, '_plugins/_ism/policies/sterling-retention' + (retentionCreated ? '?if_seq_no=0&if_primary_term=1' : ''));
      retentionCreated = true;
      return http(201, retentionPolicy);
    }
    if (target === '_snapshot/sterling-snapshots' && method === 'PUT') return http(200, { acknowledged: true });
    if (target === '_plugins/_sm/policies/sterling-audit' && method === 'GET') {
      return snapshotCreated ? http(200, snapshotPolicy) : missingSnapshot('Snapshot management policy not found');
    }
    if (target === '_plugins/_sm/policies/sterling-audit' && method === 'POST' && !snapshotCreated) {
      snapshotCreated = true;
      return { status: 1, stdout: '', stderr: 'connection closed' };
    }
    assert.equal(target, '_plugins/_sm/policies/sterling-audit?if_seq_no=5&if_primary_term=2');
    assert.equal(method, 'PUT');
    return http(200, snapshotPolicy);
  });
  const options = { site: CI, siteDir: siteExample, run, log: () => {}, rendered };
  assert.throws(() => putOpenSearchObjects(options), /OpenSearch POST/);
  assert.equal(retentionCreated, true);
  assert.equal(snapshotCreated, true);
  assert.deepEqual(putOpenSearchObjects(options), OPENSEARCH_OBJECTS.map(({ path }) => path));
  assert.ok(!argvText(calls).includes(openSearchPassword), 'the credential is never in an argv');
  const writes = calls.filter((call) => call.args.includes('exec') && /request = "(PUT|POST)"/.test(call.input ?? ''));
  assert.equal(writes.length, OPENSEARCH_OBJECTS.length * 2);
  for (const call of writes) {
    assert.deepEqual(call.args.slice(0, 6), ['exec', '-i', '-n', 'sterling-logging', 'opensearch-cluster-master-0', '--']);
    assert.match(call.input, new RegExp(`user = "admin:${openSearchPassword}"`));
  }
  const retention = writes.find((call) => call.input.includes('_plugins/_ism/policies/sterling-retention'));
  assert.match(retention.input, /data-binary = "\{\\n {2}\\"policy\\": \{/);
  assert.equal(configMapData('kind: ConfigMap\ndata:\n  a: |\n    {"x": 1}\n  b: "two"\n').a, '{"x": 1}\n');
});

test('OpenSearch stops on ambiguous policy lookups and unacknowledged writes', () => {
  const rendered = renderRelease(ROOT, 'opensearch', { site: CI, siteDir: siteExample });
  const snapshotMap = /name: opensearch-snapshot-policy$/m;
  const incomplete = splitDocs(rendered).filter((doc) => !snapshotMap.test(doc)).join('\n---\n');
  const malformed = `${incomplete}\n---\nkind: ConfigMap\nmetadata:\n  name: opensearch-snapshot-policy\ndata:\n  policy.json: broken\n`;
  const noAccess = fakeRun();
  for (const invalid of [incomplete, malformed]) {
    assert.throws(() => putOpenSearchObjects({ site: CI, siteDir: siteExample, run: noAccess.run, rendered: invalid }), /JSON object body for opensearch-snapshot-policy/);
  }
  assert.deepEqual(noAccess.calls, [], 'validate all required objects before contacting the site');

  const cases = [
    ['retention', http(200, { policies: [], total_policies: 1 }), /retention|ISM/i],
    ['repository', http(200, { acknowledged: false }), /snapshot repository|sterling-snapshots/i],
    ['repository', http(302, { acknowledged: true }), /sterling-snapshots/i],
    ['snapshot', http(404, { error: 'no handler found', status: 404 }), /snapshot|sterling-audit/i],
    ['snapshot', http(401, { error: openSearchPassword }), /snapshot|sterling-audit/i],
    ['snapshot', { status: 7, stdout: '', stderr: openSearchPassword }, /snapshot|sterling-audit/i],
    ['snapshot', http(200, { ...snapshotPolicy, _primary_term: undefined }), /snapshot|sterling-audit/i],
  ];
  for (const [boundary, response, summary] of cases) {
    const { run, calls } = fakeOpenSearch((target, method) => {
      if (target.startsWith('_plugins/_ism/policies?')) {
        return boundary === 'retention' ? response : http(200, { policies: [], total_policies: 0 });
      }
      if (target === '_plugins/_ism/policies/sterling-retention') return http(201, retentionPolicy);
      if (target === '_snapshot/sterling-snapshots') return boundary === 'repository' ? response : http(200, { acknowledged: true });
      assert.equal(method, 'GET');
      return response;
    });
    assert.throws(() => putOpenSearchObjects({ site: CI, siteDir: siteExample, run, log: () => {}, rendered }), (error) => {
      assert.match(error.message, summary);
      assert.ok(!error.message.includes(openSearchPassword));
      return true;
    });
    const writes = calls.filter((call) => /request = "(PUT|POST)"/.test(call.input ?? ''));
    assert.equal(writes.length, boundary === 'retention' ? 0 : 2, boundary);
  }
});

test('ConfigMap values decode YAML quoting exactly, backslashes included', () => {
  const data = configMapData([
    'kind: ConfigMap', 'data:',
    String.raw`  single: 'C:\path\to "x" and it''s'`,
    String.raw`  trailing: 'ends with \'`,
    String.raw`  double: "tab\tand \\ and \"q\""`,
    '  plain: just text',
  ].join('\n'));
  assert.equal(data.single, String.raw`C:\path\to "x" and it's`);
  assert.equal(data.trailing, 'ends with \\');
  assert.equal(data.double, 'tab\tand \\ and "q"');
  assert.equal(data.plain, 'just text');
});

test('install.mjs --help lists every step', async () => {
  const lines = [];
  assert.equal(await main(['--help'], { log: (line) => lines.push(line) }), 0);
  for (const step of ['preflight', 'node-files', 'bootstrap-ca', 'registry', 'import', 'secrets', 'apply', 'status', 'retire-bootstrap']) assert.match(lines.join('\n'), new RegExp(`^  ${step} `, 'm'));
});

test('record-digests writes a published digest only after its signature verifies, for names the lock lists', () => {
  const digest = `sha256:${'b'.repeat(64)}`;
  const ok = () => ({ ok: true, reason: '' });
  const checked = [];
  const lock = recordDigests({ built: { 'sterling/openbao': digest }, ciRegistry: 'ghcr.io/example', verify: (ref) => { checked.push(ref); return ok(); }, write: false });
  assert.equal(lock.built.find((entry) => entry.name === 'sterling/openbao').digest, digest);
  assert.deepEqual(checked, [`ghcr.io/example/sterling/openbao@${digest}`]);
  assert.throws(() => recordDigests({ built: { 'sterling/unknown': digest }, ciRegistry: 'ghcr.io/example', verify: ok, write: false }), /not a built image/);
  assert.throws(() => recordDigests({ built: { 'sterling/openbao': digest }, ciRegistry: 'ghcr.io/example', verify: () => ({ ok: false, reason: 'no signature' }), write: false }),
    /did not verify with your organization's key/);
  assert.throws(() => recordDigests({ releases: [{ name: 'sterling/sterling-workbench', ref: `ghcr.io/someone/else@${digest}` }], verify: ok, write: false }),
    /is not ghcr\.io\/vitalpointai\/near-ai-vscode@sha256/);
});

test('apply makes the bootstrap volume key before the storage class, on stdin only, and never replaces an existing one', async () => {
  const state = temp('state-');
  const { run, calls } = fakeRun();
  await applySite({ site: CI, siteDir: siteExample, state, run, checks: ready, steps: steps(), log: () => {} });
  const made = calls.filter((call) => call.args.join(' ') === 'apply -f -').map((call) => JSON.parse(call.input)).filter((object) => object.kind === 'Secret');
  assert.deepEqual(made.map((secret) => `${secret.metadata.namespace}/${secret.metadata.name}`), ['longhorn-system/longhorn-crypto']);
  const key = Buffer.from(made[0].data.CRYPTO_KEY_VALUE, 'base64').toString();
  assert.ok(key.length >= 43);
  assert.ok(!argvText(calls).includes(key));
  const order = calls.map((call) => (call.input?.includes('longhorn-crypto') ? 'secret' : call.args[0] === 'upgrade' ? call.args[2] : null)).filter(Boolean);
  assert.ok(order.indexOf('secret') < order.indexOf('sterling-storage') && order.indexOf('secret') < order.indexOf('openbao'));
  // Present already: kept as it is.
  const existing = fakeRun((command, args) => (args.join(' ').startsWith('get secret longhorn-crypto')
    ? { status: 0, stdout: JSON.stringify({ data: { CRYPTO_KEY_VALUE: Buffer.from('k'.repeat(43)).toString('base64') } }), stderr: '' } : null));
  await applySite({ site: CI, siteDir: siteExample, state: temp('state-'), run: existing.run, checks: ready, steps: steps(), log: () => {} });
  assert.ok(!existing.calls.some((call) => call.input?.includes('"longhorn-crypto"')), 'an existing volume key is never replaced');
  // The secrets step copies the cluster's value into OpenBao instead of generating a new one.
  const bao = fakeBao();
  await writeSecrets({ site: CI, bao, run: existing.run, log: () => {} });
  assert.equal(bao.store.get('apps/storage').data.CRYPTO_KEY_VALUE, 'k'.repeat(43));
});
