// The workbench sessions (D-25, D-29, hardening 13): the AppDefinition carries the site's lifecycle values and the workbench image from the
// lock, the site environment has exactly its ten names and no secret, and the session environment policy refuses everything a launch
// request could add. Renders with the CI site; needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';
import { listReleases, loadSite, renderRelease, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
const release = (name) => listReleases(ROOT).find((entry) => entry.name === name);
const sessions = () => splitDocs(renderRelease(ROOT, release('sterling-sessions'), { site: SITE, helm: HELM }));
const policy = () => sessions().find((doc) => kindOf(doc) === 'ValidatingPolicy');

test('the AppDefinition: no prewarm pool, the site capacity and idle values, IfNotPresent, the workbench image from the lock', (t) => {
  const app = sessions().find((doc) => kindOf(doc) === 'AppDefinition');
  assert.match(app, /^ {2}name: sterling-workbench$/m);
  assert.match(app, /^ {2}minInstances: 0$/m);
  assert.match(app, /^ {2}maxInstances: 400$/m);
  assert.match(app, /^ {2}imagePullPolicy: IfNotPresent$/m);
  assert.match(app, /^ {2}timeout: 0$/m, 'no hard limit by default: Theia Cloud\'s timeout counts from creation, not idleness');
  assert.match(app, new RegExp(`^ {6}timeoutAfter: ${SITE.sessionTimeoutMinutes}$`, 'm'), 'the idle stop is the site setting');
  assert.match(app, /^ {6}notifyAfter: 25$/m);
  assert.match(app, /^ {2}port: 3000$/m);
  const image = resolveImage(readImagesLock(ROOT), 'sterling/sterling-workbench', SITE.registry);
  assert.ok(app.includes(`image: "${image.ref}"`));
  if (image.unpublished) t.diagnostic('sterling/sterling-workbench is not published yet (reserved digest)');
  // The ingress named is the one the theia-cloud chart creates for session hosts.
  const theia = splitDocs(renderRelease(ROOT, release('theia-cloud'), { site: SITE, helm: HELM, all: true }));
  const ingressName = /^ {2}ingressname: "([^"]+)"$/m.exec(app)[1];
  const ingress = theia.find((doc) => kindOf(doc) === 'Ingress' && new RegExp(`^ {2}name: ${ingressName}$`, 'm').test(doc));
  assert.ok(ingress, `theia-cloud renders no Ingress ${ingressName}`);
  // The workbench's webviews come from Theia's default <uuid>.webview.<session host>: the operator adds each session's path under that
  // prefix too, and the instances Ingress has the wildcard host as a rule and as a name on its site-pki certificate.
  assert.match(app, /^ {2}ingressHostnamePrefixes:\n {4}- "\*\.webview\."$/m);
  const webviews = `*.webview.${/^ {4}- host: ([^\s"]+)$/m.exec(ingress)[1]}`;
  assert.equal(webviews, `*.webview.ws.${SITE.domain}`);
  assert.ok(ingress.includes(`\n    - host: "${webviews}"\n`), `the instances Ingress has a rule for ${webviews}`);
  assert.ok(/^ {2}tls:\n {2}- hosts:\n(?: {4}- .+\n)+/m.exec(ingress)[0].includes(`    - "${webviews}"\n`), `the certificate names ${webviews}`);
});

test('the lab placeholder replaces the image only when the site asks for it', () => {
  const descriptor = release('sterling-sessions');
  const yaml = renderRelease(ROOT, { ...descriptor, site: 'deploy/test/fixtures/sessions-placeholder.yaml' }, { site: SITE, helm: HELM });
  const placeholder = resolveImage(readImagesLock(ROOT), 'registry.access.redhat.com/ubi9/nginx-126', SITE.registry);
  assert.ok(yaml.includes(`image: "${placeholder.ref}"`));
  assert.match(yaml, /^ {2}port: 8080$/m);
  assert.doesNotMatch(yaml, /activityTracker/);
});

test('sterling-site-env has exactly the ten names and no secret', () => {
  const env = sessions().find((doc) => kindOf(doc) === 'ConfigMap' && /^ {2}name: sterling-site-env$/m.test(doc));
  const keys = env.split('\n').map((line) => /^ {2}(STERLING_[A-Z_]+):/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(keys.sort(), ['STERLING_MODEL_SERVERS', 'STERLING_OPENBAO_ADDR', 'STERLING_OPENBAO_CA_FILE', 'STERLING_OPENBAO_JWT_MOUNT', 'STERLING_OPENBAO_JWT_ROLE',
    'STERLING_OPENBAO_KV_MOUNT', 'STERLING_OPENBAO_TRANSIT_MOUNT', 'STERLING_OPEN_VSX_URL', 'STERLING_STEPUP_ACR', 'STERLING_STEPUP_MAX_AGE_SECONDS'].sort());
  assert.match(env, new RegExp(`STERLING_STEPUP_ACR: "${SITE.stepUpAcr}"`));
  assert.match(env, new RegExp(`STERLING_STEPUP_MAX_AGE_SECONDS: "${SITE.stepUpMaxAgeSeconds}"`));
  assert.match(env, /STERLING_OPENBAO_ADDR: "https:\/\/openbao\.sterling-openbao\.svc:8200"/);
  assert.doesNotMatch(env, /signInKeys|SIGN_IN/i);
  assert.ok(!sessions().some((doc) => kindOf(doc) === 'Secret'));
});

// The site-env contract with the workbench (Phase 46 interface item 4): the STERLING_* values this chart renders, for the site example and for
// a site with two model servers, must equal the committed fixture that workbench/test/site-env-contract.test.ts feeds to the workbench's own
// settings readers. A format change on this side fails here; on the workbench side it fails there. After an intended change, regenerate the
// fixture with STERLING_WRITE_SITE_ENV_FIXTURE=1 and run both tests.
const SITE_ENV_FIXTURE = path.join(ROOT, 'workbench/test/fixtures/site-env.rendered.json');

/** The STERLING_* values of the rendered sterling-site-env ConfigMap, each decoded from its YAML scalar (helm's quote, or a plain word). */
function siteEnvValues(yaml) {
  const env = splitDocs(yaml).find((doc) => kindOf(doc) === 'ConfigMap' && /^ {2}name: sterling-site-env$/m.test(doc));
  const values = {};
  for (const line of env.split('\n')) {
    const match = /^ {2}(STERLING_[A-Z_]+): (.*)$/.exec(line);
    if (!match) continue;
    assert.ok(!/^['|>&*!{[]/.test(match[2]), `${match[1]} is rendered in a YAML form this test does not decode: ${match[2]}`);
    values[match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
  }
  return values;
}

test('the rendered site environment matches the fixture the workbench reads it from', () => {
  const descriptor = release('sterling-sessions');
  const renders = {
    'site-example': siteEnvValues(renderRelease(ROOT, descriptor, { site: SITE, helm: HELM })),
    'model-servers': siteEnvValues(renderRelease(ROOT, { ...descriptor, site: 'deploy/test/fixtures/sessions-model-servers.yaml' }, { site: SITE, helm: HELM })),
  };
  assert.equal(renders['site-example'].STERLING_MODEL_SERVERS, '[]');
  assert.deepEqual(JSON.parse(renders['model-servers'].STERLING_MODEL_SERVERS), ['https://models.site.example:8443/v1', 'https://inference.site.example/v1,beta']);
  const fixture = {
    note: 'Generated by deploy/test/render-sessions.test.mjs (STERLING_WRITE_SITE_ENV_FIXTURE=1) from the sterling-sessions chart with deploy/test/fixtures/site.ci.yaml; read by workbench/test/site-env-contract.test.ts. Do not edit by hand.',
    renders,
  };
  if (process.env.STERLING_WRITE_SITE_ENV_FIXTURE === '1') writeFileSync(SITE_ENV_FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(SITE_ENV_FIXTURE, 'utf8')), fixture,
    'workbench/test/fixtures/site-env.rendered.json no longer matches the chart render; regenerate it and run the workbench contract test');
});

test('a modelServers left empty renders [], and one that is not a list of URLs stops the render', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sterling-sessions-site-'));
  try {
    const render = (modelServers) => {
      const file = path.join(dir, 'sessions.yaml');
      writeFileSync(file, `appDefinition:\n  maxInstances: 5\nsiteEnv:\n  openVsxUrl: "https://open-vsx.site.example"\n  modelServers: ${modelServers}\n`);
      return renderRelease(ROOT, { ...release('sterling-sessions'), site: path.relative(ROOT, file) }, { site: SITE, helm: HELM });
    };
    assert.equal(siteEnvValues(render('')).STERLING_MODEL_SERVERS, '[]');
    for (const value of ['"https://a.site.example,https://b.site.example"', '[1]']) {
      assert.throws(() => render(value), /siteEnv\.modelServers must be a list of URLs/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the session proxy lets only the activity tracker\'s two paths through without sign-in, anchored (oauth2-proxy matches unanchored)', () => {
  const template = readFileSync(path.join(ROOT, 'deploy/images/theia-cloud-operator/templates/templateDeployment.yaml'), 'utf8');
  const routes = [...template.matchAll(/--skip-auth-route=(\S+)/g)].map((match) => match[1]);
  assert.deepEqual(routes, ['^/monitor/activity/(lastActivity|popup)$']);
  const exempt = new RegExp(routes[0]);
  for (const route of ['/monitor/activity/lastActivity', '/monitor/activity/popup']) assert.ok(exempt.test(route), route);
  for (const route of ['/', '/monitor/message', '/files/monitor/x', '/x/monitor/activity/lastActivity', '/monitor/activity/lastActivity/x']) assert.ok(!exempt.test(route), route);
});

test('the session environment policy selects only labelled session Deployments and Pods in theia-cloud, and fails closed', () => {
  const doc = policy();
  assert.match(doc, /^ {2}name: sterling-session-env$/m);
  assert.match(doc, /validationActions: \[Deny\]/);
  assert.match(doc, /failurePolicy: Fail/);
  assert.match(doc, /resources: \[deployments\]/);
  assert.match(doc, /resources: \[pods\]/);
  assert.match(doc, /objectSelector:\n\s+matchLabels:\n\s+sterling-session: "true"/);
  assert.match(doc, /kubernetes\.io\/metadata\.name: theia-cloud/);
});

test('the policy refuses envFrom other than sterling-site-env, any Secret or ConfigMap key in env, and names outside the allow-list', () => {
  const doc = policy();
  assert.ok(doc.includes("e.configMapRef.name == 'sterling-site-env'"));
  assert.ok(doc.includes('!has(v.valueFrom.secretKeyRef) && !has(v.valueFrom.configMapKeyRef)'));
  assert.ok(doc.includes('v.name in variables.allowedNames'));
  const allowed = JSON.parse(JSON.parse(/name: allowedNames\n\s+expression: (".*")$/m.exec(doc)[1]));
  // Exactly the names our operator template sets on the workbench container (the 13 THEIACLOUD_ names and STERLING_LISTEN_HOST), no more
  // and no fewer; the launch request adds none.
  const template = readFileSync(path.join(ROOT, 'deploy/images/theia-cloud-operator/templates/templateDeployment.yaml'), 'utf8');
  const templateNames = [...template.matchAll(/^ {10}- name: ([A-Z][A-Z0-9_]*)$/gm)].map((match) => match[1]);
  assert.equal(templateNames.length, 14);
  assert.deepEqual([...allowed].sort(), [...templateNames].sort());
  assert.equal(allowed.filter((name) => name.startsWith('THEIACLOUD_')).length, 13);
  // The workbench binds loopback (for the sidecar) and the pod IP (for the operator's activity monitor).
  assert.match(template, /- name: STERLING_LISTEN_HOST\n\s+value: "0\.0\.0\.0"$/m);
});

test('STERLING_LISTEN_HOST is "0.0.0.0" in the template, and the policy accepts only that or the pod IP from the downward API', () => {
  const template = readFileSync(path.join(ROOT, 'deploy/images/theia-cloud-operator/templates/templateDeployment.yaml'), 'utf8');
  assert.equal([...template.matchAll(/- name: STERLING_LISTEN_HOST\n/g)].length, 1);
  const doc = policy();
  assert.ok(doc.includes("v.name != 'STERLING_LISTEN_HOST' || (has(v.value) && v.value == '0.0.0.0' && !has(v.valueFrom)) || (!has(v.value) && has(v.valueFrom) && has(v.valueFrom.fieldRef) && v.valueFrom.fieldRef.fieldPath == 'status.podIP')"));
  assert.match(doc, /STERLING_LISTEN_HOST may only be 0\.0\.0\.0 or the pod IP/);
});

test('the policy allows only the oauth2-proxy-secrets Secret volume, and only in the oauth2-proxy container', () => {
  const doc = policy();
  assert.ok(doc.includes("v.secret.secretName == 'oauth2-proxy-secrets'"));
  assert.ok(doc.includes('v.projected.sources.all(s, !has(s.secret))'));
  assert.ok(doc.includes("c.name == 'oauth2-proxy' || !has(c.volumeMounts) || c.volumeMounts.all(m, !(m.name in variables.secretVolumes))"));
});
