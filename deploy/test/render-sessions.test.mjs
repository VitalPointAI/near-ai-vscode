// The workbench sessions (D-25, D-29, hardening 13): the AppDefinition carries the site's lifecycle values and the workbench image from the
// lock, the site environment has exactly its ten names and no secret, and the session environment policy refuses everything a launch
// request could add. Renders with the CI site; needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
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
