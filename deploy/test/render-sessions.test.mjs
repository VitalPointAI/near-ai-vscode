// The workbench sessions (D-25, D-29, hardening 13): the AppDefinition carries the site's lifecycle values and the workbench image from the
// lock, the site environment has exactly its eleven names and no secret, and the session environment policy refuses everything a launch
// request could add. Renders with the CI site; needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';
import { listReleases, loadSite, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
const release = (name) => listReleases(ROOT).find((entry) => entry.name === name);
const sessions = () => splitDocs(renderRelease(ROOT, release('sterling-sessions'), { site: SITE, helm: HELM }));
const policy = () => sessions().find((doc) => kindOf(doc) === 'ValidatingPolicy' && /^ {2}name: sterling-session-env$/m.test(doc));

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
  assert.ok(theia.some((doc) => kindOf(doc) === 'Ingress' && new RegExp(`^ {2}name: ${ingressName}$`, 'm').test(doc)), `theia-cloud renders no Ingress ${ingressName}`);
});

test('the lab placeholder replaces the image only when the site asks for it', () => {
  const descriptor = release('sterling-sessions');
  const yaml = renderRelease(ROOT, { ...descriptor, site: 'deploy/test/fixtures/sessions-placeholder.yaml' }, { site: SITE, helm: HELM });
  const placeholder = resolveImage(readImagesLock(ROOT), 'registry.access.redhat.com/ubi9/nginx-126', SITE.registry);
  assert.ok(yaml.includes(`image: "${placeholder.ref}"`));
  assert.match(yaml, /^ {2}port: 8080$/m);
  assert.doesNotMatch(yaml, /activityTracker/);
});

test('sterling-site-env has exactly the eleven names and no secret', () => {
  const env = sessions().find((doc) => kindOf(doc) === 'ConfigMap' && /^ {2}name: sterling-site-env$/m.test(doc));
  const keys = env.split('\n').map((line) => /^ {2}(STERLING_[A-Z_]+):/.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(keys.sort(), ['STERLING_MODEL_SERVERS', 'STERLING_OPENBAO_ADDR', 'STERLING_OPENBAO_CA_FILE', 'STERLING_OPENBAO_JWT_MOUNT', 'STERLING_OPENBAO_JWT_ROLE',
    'STERLING_OPENBAO_KV_MOUNT', 'STERLING_OPENBAO_TRANSIT_MOUNT', 'STERLING_OPEN_VSX_URL', 'STERLING_ORGANIZATION_PUBLIC_KEY', 'STERLING_STEPUP_ACR', 'STERLING_STEPUP_MAX_AGE_SECONDS'].sort());
  assert.doesNotMatch(env, /PRIVATE KEY/);
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

// 48.2-17 (D-17): every session gets your organization's site key from the same site value the admission chart renders for image
// verification, so a session can check the trust anchor it is given against the key admission already trusts.
test('same key: STERLING_ORGANIZATION_PUBLIC_KEY is the key admission verifies every image with; a site without it stops the render', () => {
  const env = siteEnvValues(renderRelease(ROOT, release('sterling-sessions'), { site: SITE, helm: HELM }));
  const admission = splitDocs(renderRelease(ROOT, release('sterling-admission'), { site: SITE, helm: HELM })).find((doc) => /^ {2}name: site-images-signed$/m.test(doc) || /attestors:/.test(doc));
  const block = /key:\n\s+data: \|\n((?:\s{12}.*\n?)+)/.exec(admission)[1];
  const admissionKey = block.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  assert.ok(env.STERLING_ORGANIZATION_PUBLIC_KEY.includes('-----BEGIN PUBLIC KEY-----'));
  assert.equal(env.STERLING_ORGANIZATION_PUBLIC_KEY.trim(), admissionKey);
  assert.equal(env.STERLING_ORGANIZATION_PUBLIC_KEY.trim(), SITE.organizationPublicKey.trim());
  assert.throws(() => renderRelease(ROOT, release('sterling-sessions'), { site: { ...SITE, organizationPublicKey: '' }, helm: HELM }), /organizationPublicKey/);
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

// ---- 48.2-17 (D-17, D-21, D-23): only the install identity may write the trust anchor ----

const NAMESPACE = 'theia-cloud';
const INSTALL = `system:serviceaccount:${NAMESPACE}:sterling-evidence-install`;
const NAMESPACE_CONTROLLER = 'system:serviceaccount:kube-system:namespace-controller';
const PROTECTED = ['sterling-evidence-trust', 'sterling-release-evidence'];
const named = (kind, name) => sessions().find((doc) => kindOf(doc) === kind && new RegExp(`^ {2}name: ${name}$`, 'm').test(doc));
/** The rules of a rendered Role in the form this chart writes them: each `- apiGroups` item with its resources, resourceNames and verbs. */
function roleRules(doc) {
  return doc.split(/\n {2}- /).slice(1).map((item) => ({
    resources: JSON.parse(/resources: (\[.*\])/.exec(item)[1].replace(/([a-z][a-z-]*)/g, '"$1"')),
    resourceNames: /resourceNames: (\[.*\])/.exec(item) ? JSON.parse(/resourceNames: (\[.*\])/.exec(item)[1].replace(/([a-z][a-z-]*)/g, '"$1"')) : undefined,
    verbs: JSON.parse(/verbs: (\[.*\])/.exec(item)[1].replace(/([a-z*][a-z-]*|\*)/g, '"$1"')),
  }));
}

test('identities: the install and publish ServiceAccounts mount no token; the install Role creates and writes only the two anchors; publish writes only its own', () => {
  for (const name of ['sterling-evidence-install', 'sterling-evidence-publish']) {
    const account = named('ServiceAccount', name);
    assert.ok(account, `ServiceAccount ${name}`);
    assert.match(account, /^automountServiceAccountToken: false$/m);
    const binding = named('RoleBinding', name);
    assert.match(binding, new RegExp(`kind: Role\\n\\s+name: ${name}`));
    assert.match(binding, new RegExp(`kind: ServiceAccount\\n\\s+name: ${name}\\n\\s+namespace: ${NAMESPACE}`));
  }
  assert.deepEqual(roleRules(named('Role', 'sterling-evidence-install')), [
    { resources: ['configmaps'], resourceNames: undefined, verbs: ['create'] },
    { resources: ['configmaps'], resourceNames: PROTECTED, verbs: ['get', 'update', 'patch', 'delete'] },
  ]);
  assert.deepEqual(roleRules(named('Role', 'sterling-evidence-publish')), [
    { resources: ['configmaps'], resourceNames: ['sterling-site-evidence-operator'], verbs: ['get', 'update', 'patch'] },
    { resources: ['configmaps'], resourceNames: ['sterling-evidence-trust'], verbs: ['get'] },
  ]);
  for (const name of PROTECTED) assert.ok(!sessions().some((doc) => kindOf(doc) === 'ConfigMap' && new RegExp(`^ {2}name: ${name}$`, 'm').test(doc)), `the chart never creates ${name}`);
});

const ALLOW = `request.userInfo.username == '${INSTALL}' || (request.operation == 'DELETE' && request.userInfo.username == '${NAMESPACE_CONTROLLER}')`;
const APPLIES = "(object != null ? object.metadata.name : oldObject.metadata.name) in ['sterling-evidence-trust', 'sterling-release-evidence']";

test('policy: sterling-evidence-trust-writes denies, failing closed, every write of the two anchors but the install identity\'s', () => {
  const doc = named('ValidatingPolicy', 'sterling-evidence-trust-writes');
  assert.ok(doc);
  assert.match(doc, /validationActions: \[Deny\]/);
  assert.match(doc, /failurePolicy: Fail/);
  assert.match(doc, /operations: \[CREATE, UPDATE, DELETE\]/);
  assert.match(doc, /resources: \[configmaps\]/);
  assert.match(doc, new RegExp(`kubernetes\\.io/metadata\\.name: ${NAMESPACE}`));
  assert.ok(doc.includes(`expression: ${JSON.stringify(APPLIES)}`), 'the match condition, exactly');
  assert.ok(doc.includes(`expression: ${JSON.stringify(ALLOW)}`), 'the allow rule, exactly');
  assert.equal([...doc.matchAll(/expression:/g)].length, 2, 'no other condition or rule');
});

/** The allow rule above, as a predicate, held equal to the CEL text the policy is asserted to carry. */
const allows = ({ operation, username }) => username === INSTALL || (operation === 'DELETE' && username === NAMESPACE_CONTROLLER);
const OTHERS = ['kubernetes-admin', 'system:serviceaccount:theia-cloud:sterling-evidence-publish', 'system:serviceaccount:theia-cloud:sterling-site-collector',
  'system:serviceaccount:kube-system:generic-garbage-collector', 'system:serviceaccount:kube-system:namespace-controller-x'];

test('namespace deletion: the namespace controller may DELETE and nothing else; the install identity may create, update and delete', () => {
  assert.equal(ALLOW.includes(`'${INSTALL}'`) && ALLOW.includes(`'${NAMESPACE_CONTROLLER}'`), true, 'the predicate mirrors the policy text');
  assert.equal(allows({ operation: 'DELETE', username: NAMESPACE_CONTROLLER }), true);
  for (const operation of ['CREATE', 'UPDATE']) assert.equal(allows({ operation, username: NAMESPACE_CONTROLLER }), false, `${operation} (a PATCH is an UPDATE) by the namespace controller`);
  for (const operation of ['CREATE', 'UPDATE', 'DELETE']) assert.equal(allows({ operation, username: INSTALL }), true, `${operation} by the install identity`);
});

test('no one else: a cluster administrator, the publish and collector identities and look-alike names are denied every write', () => {
  for (const username of OTHERS) for (const operation of ['CREATE', 'UPDATE', 'DELETE']) assert.equal(allows({ operation, username }), false, `${operation} by ${username}`);
  const doc = named('ValidatingPolicy', 'sterling-evidence-trust-writes');
  assert.doesNotMatch(doc, /userInfo\.groups|startsWith|matches\(|endsWith|\*/, 'no group match and no prefix or wildcard match on usernames');
});

test('no other writer: across every rendered chart, only the install Role may write the anchors, and publish may create or delete no ConfigMap', () => {
  const docs = renderSite(ROOT, { site: SITE, helm: HELM, all: true }).flatMap(({ yaml }) => splitDocs(yaml));
  const roles = docs.filter((doc) => kindOf(doc) === 'Role' || kindOf(doc) === 'ClusterRole');
  assert.ok(roles.length > 0);
  for (const doc of roles) {
    if (!PROTECTED.some((name) => doc.includes(name))) continue;
    const name = /^ {2}name: (\S+)$/m.exec(doc)[1];
    if (name === 'sterling-evidence-install') continue;
    // Any other Role naming an anchor may only read it.
    for (const rule of roleRules(doc)) {
      if (!(rule.resourceNames ?? []).some((item) => PROTECTED.includes(item))) continue;
      assert.deepEqual(rule.verbs, ['get'], `${name} may only read ${rule.resourceNames}`);
    }
  }
  for (const rule of roleRules(named('Role', 'sterling-evidence-publish'))) {
    assert.ok(!rule.verbs.some((verb) => ['create', 'delete', 'deletecollection', '*'].includes(verb)), 'publish creates or deletes no ConfigMap');
  }
});

