// The global render invariants (D-56): every release of the site stack, rendered offline with the CI site file, runs only digest-pinned images
// from the image lock, never pulls with Always, and contains none of the components the owner ruled out (an ACME issuer D-16, ingress-nginx D-07,
// k3s D-14, the AGPL Loki log store D-19). The vendored charts are hash-checked before anything renders (D-13, D-21). Needs helm ($HELM or PATH);
// it fails, never skips, when helm is missing. Run: env HELM=compliance/out/tools/linux-amd64/helm node scripts/run-tests.mjs deploy/test/*.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkVendored, vendor } from '../charts/vendor.mjs';
import { allImages, readImagesLock } from '../bundle/lib/locks.mjs';
import { checkRendered } from '../bundle/lib/invariants.mjs';
import { OPTIONAL_EMPTY, REQUIRED_SITE_SETTINGS, listReleases, loadSite, renderRelease, renderSite, splitDocs, substituteSite } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';

function helmFound() {
  const run = spawnSync(HELM, ['version', '--short'], { encoding: 'utf8' });
  return !run.error && run.status === 0;
}

test('helm is available for the render tests', () => {
  assert.ok(helmFound(), `helm was not found (${HELM}); set HELM to the helm binary (sh compliance/ci/install-tool.sh helm compliance/out/tools) or put it on PATH.`);
});

test('every vendored chart matches charts.lock.json and no unlisted tarball is present', () => {
  assert.deepEqual(checkVendored(ROOT), []);
});

test('every rendered release meets the global invariants', (t) => {
  assert.ok(helmFound(), `helm was not found (${HELM}).`);
  const rendered = renderSite(ROOT, { site: SITE, helm: HELM, all: true });
  assert.ok(rendered.length > 0, 'no release rendered');
  const { problems, imagesChecked, unpublished } = checkRendered(rendered, { lock: readImagesLock(ROOT), registry: SITE.registry });
  assert.deepEqual(problems, []);
  for (const line of unpublished) t.diagnostic(line);
  assert.ok(imagesChecked > 0, 'no image: line was found in the rendered output');
});

test('the shared invariants catch each ruled-out pattern (the same code the site preflight runs)', () => {
  const lock = readImagesLock(ROOT);
  const registry = SITE.registry;
  const good = allImages(lock, registry).find((image) => !image.unpublished).ref;
  const placeholder = allImages(lock, registry).find((image) => image.unpublished);
  const doc = (kind, body) => `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: x\n${body}\n`;
  const cases = [
    [doc('Pod', `spec:\n  containers:\n    - image: ${good.split('@')[0]}:latest`), /not pinned by a sha256 digest/],
    [doc('Pod', `spec:\n  containers:\n    - image: elsewhere.example/app@sha256:${'a'.repeat(64)}`), /is not registry\.site\.example\/<sitePath>@<digest>/],
    [doc('Pod', `spec:\n  containers:\n    - image: ${good}\n      imagePullPolicy: Always`), /imagePullPolicy Always/],
    [doc('ClusterIssuer', 'spec:\n  acme:\n    server: https://acme.example'), /an ACME issuer/],
    [doc('Ingress', 'spec:\n  ingressClassName: nginx'), /the nginx ingress class/],
    [doc('Deployment', 'metadata2: ingress-nginx'), /ingress-nginx/],
    [doc('ConfigMap', 'data:\n  runtime: k3s'), /k3s \(D-14\)/],
    [doc('Pod', 'spec:\n  containers:\n    - name: grafana/loki'), /Loki/],
  ];
  for (const [yaml, expected] of cases) {
    const { problems } = checkRendered([{ name: 'case', yaml }], { lock, registry });
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected} in ${JSON.stringify(problems)}`);
  }
  // Secret values may hold any letters by chance (harbor-core's random keys); keys and names may not.
  assert.deepEqual(checkRendered([{ name: 'case', yaml: doc('Secret', 'data:\n  key: azk3sQ==') }], { lock, registry }).problems, []);
  if (placeholder) {
    const result = checkRendered([{ name: 'case', yaml: doc('Pod', `spec:\n  containers:\n    - image: ${placeholder.ref}`) }], { lock, registry });
    assert.deepEqual(result.problems, []);
    assert.equal(result.unpublished.length, 1);
  }
});

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'render-fixture-'));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const LOCKS = {
  'deploy/charts/charts.lock.json': { charts: [] },
  'deploy/bundle/images.lock.json': { images: [{ ref: `quay.io/example/app:1.0@${DIGEST_A}`, component: 'cert-manager' }], built: [], release: [] },
  'deploy/charts/local/Chart.yaml': 'apiVersion: v2\nname: local\nversion: 0.1.0\n',
  'deploy/charts/local/templates/pod.yaml': 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: {{ .Release.Name }}\n  annotations:\n    greeting: {{ .Values.greeting | quote }}\n    instance: {{ .Values.instance.name | default "none" | quote }}\nspec:\n  containers:\n    - name: app\n      image: {{ .Values.image | quote }}\n',
  'deploy/values/local.yaml': 'greeting: "${site.siteName}"\nlist: ${site.egressAllow}\n'
};
const release = (extra) => ({ chart: 'path:deploy/charts/local', namespace: 'apps', order: 10, values: ['deploy/values/local.yaml'], images: [{ lock: 'quay.io/example/app', set: { image: 'ref' } }], ...extra });

test('the harness refuses descriptor mistakes before helm can render an upstream default', () => {
  const site = { siteName: 'ci', registry: 'registry.site.example', egressAllow: [], hubs: [{ name: 'a' }, { name: 'a' }] };
  const refuses = (files, pattern, render = (root) => renderSite(root, { site, helm: HELM, all: true })) => assert.throws(() => render(fixture({ ...LOCKS, ...files })), pattern);
  refuses({ 'deploy/values/app.release.json': release({ chart: 'no-such-chart' }) }, /chart no-such-chart is not in deploy\/charts\/charts\.lock\.json/);
  refuses({ 'deploy/values/app.release.json': release({ chart: 'path:deploy/charts/missing' }) }, /chart path:deploy\/charts\/missing is not a local chart directory/);
  refuses({ 'deploy/values/app.release.json': release({ images: [{ lock: 'quay.io/example/typo', set: { image: 'ref' } }] }) }, /release app maps the image quay\.io\/example\/typo, which is not in deploy\/bundle\/images\.lock\.json/);
  refuses({ 'deploy/values/app.release.json': release({ namespace: undefined }) }, /app\.release\.json: it has no namespace/, listReleases);
  refuses({ 'deploy/values/app.release.json': release({ image: [] }) }, /unknown field image/, listReleases);
  refuses({ 'deploy/values/hub.release.json': release({ instances: 'hubs' }) }, /names a twice; two releases would have the same name/);
  refuses({ 'deploy/values/hub.release.json': release({ instances: 'hubs' }), 'deploy/values/hub-a.release.json': release() }, /both render a release named hub-a/,
    (root) => renderSite(root, { site: { ...site, hubs: [{ name: 'a' }] }, helm: HELM, all: true }));
  refuses({ 'deploy/values/app.release.json': release(), 'deploy/values/local.yaml': 'greeting: "${site.missingKey}"\n' }, /deploy\/values\/local\.yaml: \$\{site\.missingKey\} is not set in the site file/);
  refuses({ 'deploy/values/app.release.json': release({ enabledWhen: { registryKnd: 'zot' } }) }, /enabledWhen names \$\{site\.registryKnd\}, which is not set/);
});

test('site substitution keeps JSON valid and a local chart renders once per instance with the image from the lock', () => {
  const json = substituteSite('{"a": "${site.x}", "b": "${site.n}", "c": ${site.list}, "d": "https://${site.h}/"}', { x: 'q"y', n: 30, list: ['p', 'q'], h: 'host' }, 'f.json');
  assert.deepEqual(JSON.parse(json), { a: 'q"y', b: 30, c: ['p', 'q'], d: 'https://host/' });
  assert.ok(helmFound(), `helm was not found (${HELM}).`);
  const root = fixture({ ...LOCKS, 'deploy/values/hub.release.json': release({ instances: 'hubs' }) });
  const yaml = renderRelease(root, 'hub', { site: { siteName: 'ci', registry: 'registry.site.example', egressAllow: [], hubs: [{ name: 'a' }, { name: 'b' }] }, helm: HELM });
  const pods = splitDocs(yaml);
  assert.deepEqual(pods.map((doc) => /^  name: (\S+)/m.exec(doc)[1]), ['hub-a', 'hub-b']);
  for (const doc of pods) {
    assert.match(doc, /greeting: "ci"/);
    assert.match(doc, new RegExp(`image: "registry\\.site\\.example/example/app@${DIGEST_A}"`));
  }
});

test('a required site setting left empty is refused, never rendered as an empty default (D-11)', () => {
  const ci = JSON.parse(readFileSync(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'), 'utf8'));
  const example = JSON.parse(readFileSync(path.join(ROOT, 'deploy/values/site.example.yaml'), 'utf8'));
  const write = (site) => path.join(fixture({ 'site.yaml': site }), 'site.yaml');
  for (const [key, value] of [['rpId', ''], ['requestedStorage', '  '], ['siteName', null]]) {
    assert.throws(() => loadSite(write({ ...ci, [key]: value })), new RegExp(`the site setting ${key} is missing or empty; each is required and has no default \\(D-11\\)`));
  }
  assert.throws(() => loadSite(write({ ...ci, clusterCidrs: { ...ci.clusterCidrs, nodes: '' } })), /the site setting clusterCidrs\.nodes is missing or empty/);
  const { rpId: _rpId, ...withoutRpId } = ci;
  assert.throws(() => loadSite(write(withoutRpId)), /the site setting rpId is missing or empty/);
  // The shipped example leaves every operator-chosen setting empty, so rendering it unedited stops with their names.
  assert.throws(() => loadSite(write(example)), /rpId, registry, .*clusterCidrs\.nodes, .*requestedStorage, organizationPublicKey are missing or empty/);
  assert.deepEqual(REQUIRED_SITE_SETTINGS.filter((key) => !Object.hasOwn(ci, key.split('.')[0])), [], 'every required setting is in the CI site file');
  // A values file naming an empty setting is refused too; only the settings in OPTIONAL_EMPTY may be empty.
  assert.throws(() => substituteSite('a: "${site.rpId}"\n', { rpId: '' }, 'v.yaml'), /v\.yaml: \$\{site\.rpId\} is empty in the site file; it is required/);
  assert.ok(OPTIONAL_EMPTY.has('storageEncryptionAtRest'));
  assert.equal(substituteSite('a: "${site.storageEncryptionAtRest}"\n', { storageEncryptionAtRest: '' }, 'v.yaml'), 'a: ""\n');
});

test('vendor refuses a lock entry whose file leaves deploy/charts/vendored/ before reading, downloading or writing anything', async () => {
  const bad = ['../evil.tgz', '/tmp/evil.tgz', 'deploy/charts/vendored/../../../evil.tgz', 'deploy/charts/vendored/sub/../../x.tgz', 'deploy/charts/vendored/a\\b.tgz'];
  const root = fixture({ 'deploy/charts/charts.lock.json': { charts: bad.map((file, index) => ({ name: `c${index}`, url: 'https://charts.invalid/c.tgz', sha256: 'a'.repeat(64), file })) } });
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('no network in this test'); };
  try {
    const problems = await vendor(root);
    assert.equal(problems.length, bad.length);
    for (const problem of problems) assert.match(problem, /must name a \.tgz file directly under deploy\/charts\/vendored\/; nothing written/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(fetched, 0, 'no download was attempted');
  assert.ok(!existsSync(path.join(root, '..', 'evil.tgz')) && !existsSync(path.join(root, 'x.tgz')));
  assert.equal(checkVendored(root).filter((problem) => /directly under/.test(problem)).length, bad.length);
});
