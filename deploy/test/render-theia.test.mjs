// The Theia Cloud stack as rendered offline with the CI site (D-56, D-20 to D-25, hardening 1 to 5, 7, 8): oauth2-proxy verifies TLS, sets
// secure cookies, reads its secrets from files and forwards the token and the signed-in person through its alpha configuration; the operator
// runs one persistent session per person on the site's class and size; every Ingress certificate comes from site-pki; every workload is one
// of our images and passes Pod Security restricted. Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { readImagesLock, resolveImage } from '../bundle/lib/locks.mjs';
import { listReleases, loadSite, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const RELEASES = ['theia-cloud-crds', 'theia-cloud-base', 'theia-cloud'];
const SAMPLE_SECRETS = ['publicbutoauth2proxywantsasecret', 'OQINaROshtE9TcZkNAm5Zs2Pv3xaWytBmc5W7sPX7ws='];
let docs;

const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
/** metadata.name: the first `  name:` line among the lines indented under the top-level metadata: line (read line by line). */
function nameOf(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line === 'metadata:');
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!line.startsWith(' ')) break;
    const match = /^ {2}name:[ \t]*"?([^\s"]+)"?$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}
/** The text of a ConfigMap key written as a block scalar (`  <key>: |...`): its lines indented by four spaces, unindented. */
function blockOf(doc, key) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  ${key}: |`));
  if (start < 0) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('    ')) break;
    body.push(line.slice(4));
  }
  return body.join('\n');
}
const settings = (cfg) => cfg.split('\n').filter((line) => line && !line.startsWith('#'));

before(() => {
  docs = renderSite(ROOT, { site: SITE, helm: HELM, all: true }).filter(({ name }) => RELEASES.includes(name))
    .flatMap(({ name, yaml }) => splitDocs(yaml).map((doc) => ({ release: name, kind: kindOf(doc), name: nameOf(doc), doc })));
});

test('oauth2-proxy verifies TLS, sets secure cookies, reads its secrets from files, and its alpha configuration carries step-up and the forwarded identity', () => {
  const configMap = docs.find((item) => item.kind === 'ConfigMap' && item.name === 'oauth2-proxy-config').doc;
  const cfg = settings(blockOf(configMap, 'oauth2-proxy.cfg'));
  for (const wanted of ['ssl_insecure_skip_verify=false', 'cookie_secure="true"', 'cookie_secret_file="/etc/oauth2-proxy-secrets/cookie-secret"',
    `trusted_proxy_ips=${JSON.stringify([SITE.clusterCidrs.pod])}`]) {
    assert.ok(cfg.includes(wanted), `oauth2-proxy.cfg sets ${wanted}`);
  }
  // With --alpha-config, oauth2-proxy v7.15.6 loads this file with its core options only and refuses legacy keys.
  for (const legacy of ['provider', 'client_id', 'client_secret', 'cookie_secret', 'oidc_issuer_url', 'upstreams', 'http_address', 'pass_access_token', 'set_xauthrequest']) {
    assert.ok(!cfg.some((line) => line.startsWith(`${legacy}=`)), `oauth2-proxy.cfg sets the legacy option ${legacy}`);
  }
  const alpha = blockOf(configMap, 'oauth2-proxy-alpha.yaml');
  assert.match(alpha, /clientSecretFile: \/etc\/oauth2-proxy-secrets\/client-secret/);
  assert.match(alpha, /caFiles:\n\s+- \/etc\/ssl\/site-ca\/ca\.crt/);
  assert.match(alpha, /useSystemTrustStore: false/);
  assert.match(alpha, /issuerURL: "https:\/\/keycloak\.site\.example\/realms\/sterling"/);
  assert.match(alpha, /uri: "http:\/\/127\.0\.0\.1:3000\/"\n\s+passHostHeader: true/);
  assert.match(alpha, /- name: max_age\n\s+allow:\n\s+- pattern: '\^\[0-9\]\+\$'/);
  assert.match(alpha, new RegExp(`- name: acr_values\\n\\s+allow:\\n\\s+- value: "${SITE.stepUpAcr}"`));
  assert.match(alpha, /- name: prompt\n\s+allow:\n\s+- value: login/);
  for (const [header, claim] of [['X-Forwarded-Access-Token', 'access_token'], ['X-Auth-Request-User', 'user'], ['X-Auth-Request-Email', 'email']]) {
    assert.match(alpha, new RegExp(`- name: ${header}\\n\\s+preserveRequestValue: false\\n\\s+values:\\n\\s+- claimSource:\\n\\s+claim: ${claim}`), `${header} from ${claim}`);
  }
  // The session pod template mounts exactly these two keys (47-09).
  const template = readFileSync(path.join(ROOT, 'deploy/images/theia-cloud-operator/templates/templateDeployment.yaml'), 'utf8');
  for (const key of ['oauth2-proxy.cfg', 'oauth2-proxy-alpha.yaml']) assert.match(template, new RegExp(`subPath: ${key.replace('.', '\\.')}$`, 'm'));
  // No secret anywhere in the Theia Cloud releases' ConfigMaps, and none of the chart's public samples anywhere.
  for (const { release, kind, name, doc } of docs) {
    for (const sample of SAMPLE_SECRETS) assert.ok(!doc.includes(sample), `${release}: ${kind} ${name} has the public sample secret`);
  }
  const service = docs.find((item) => item.kind === 'Deployment' && item.name === 'service-deployment').doc;
  assert.match(service, /- name: KEYCLOAK_CLIENTSECRET\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: oauth2-proxy-secrets\n\s+key: client-secret/);
});

test('the operator runs one session per person, no eager start, on the site class and size, with our oauth2-proxy by digest', () => {
  const operator = docs.find((item) => item.kind === 'Deployment' && item.name === 'operator-deployment').doc;
  const arg = (flag) => new RegExp(`- "?${flag}"?\\n\\s+- "?([^"\\n]*)"?`).exec(operator)?.[1];
  assert.equal(arg('--sessionsPerUser'), '1');
  assert.doesNotMatch(operator, /--eagerStart/);
  assert.equal(arg('--storageClassName'), SITE.storageClass);
  assert.equal(arg('--requestedStorage'), SITE.requestedStorage);
  assert.equal(arg('--oAuth2ProxyVersion'), resolveImage(readImagesLock(ROOT), 'sterling/oauth2-proxy', SITE.registry).ref);
  // A site that leaves requestedStorage empty is refused before anything renders (no 250Mi default, D-11).
  assert.throws(() => renderRelease(ROOT, 'theia-cloud', { site: { ...SITE, requestedStorage: '' }, helm: HELM }), /requestedStorage/);
});

test('the start page keeps persistence on and starts the workbench AppDefinition', () => {
  const config = docs.find((item) => item.kind === 'ConfigMap' && item.name === 'landing-page-config').doc;
  assert.match(config, /useEphemeralStorage: false,/);
  assert.match(config, /appDefinition: "sterling-workbench",/);
  assert.match(config, /useKeycloak: true,/);
  // Our UBI 9 nginx image serves /opt/app-root/src; a config mounted anywhere else is never read (spike S7: the page ran its demo settings).
  const page = docs.find((item) => item.kind === 'Deployment' && item.name === 'landing-page-deployment').doc;
  assert.match(page, /mountPath: \/opt\/app-root\/src\/config\.js$/m);
  assert.doesNotMatch(page, /\/usr\/share\/nginx\/html/);
});

test('every Theia Cloud Ingress is HAProxy\'s with a site-pki certificate, and no Theia Cloud chart renders a working issuer', () => {
  const ingresses = docs.filter((item) => item.kind === 'Ingress');
  assert.ok(ingresses.length >= 3);
  for (const { name, doc } of ingresses) {
    assert.match(doc, /cert-manager\.io\/cluster-issuer: "?site-pki"?$/m, `Ingress ${name}`);
    assert.match(doc, /ingressClassName: "?haproxy"?$/m, `Ingress ${name}`);
    assert.match(doc, /^ {2}tls:$/m, `Ingress ${name} serves TLS`);
  }
  const issuers = docs.filter((item) => /Issuer$/.test(item.kind));
  assert.deepEqual(issuers.map((item) => item.name), ['theia-cloud-selfsigned-issuer'], 'only the base chart\'s unconditional CA issuer, which nothing fills (render-pki)');
  const webhook = docs.find((item) => item.kind === 'Certificate' && item.name === 'conversion-webhook-certificate').doc;
  assert.match(webhook, /name: site-pki\n\s+kind: ClusterIssuer/);
});

test('every Theia Cloud workload is one of our images by digest, pulled IfNotPresent, and passes Pod Security restricted', () => {
  const lock = readImagesLock(ROOT);
  const ours = new Set(['theia-cloud-operator', 'theia-cloud-service', 'theia-cloud-landing-page', 'theia-cloud-conversion-webhook']
    .map((name) => resolveImage(lock, `sterling/${name}`, SITE.registry).ref));
  const workloads = docs.filter((item) => item.kind === 'Deployment');
  assert.deepEqual(workloads.map((item) => item.name).sort(), ['conversion-webhook', 'landing-page-deployment', 'operator-deployment', 'service-deployment']);
  for (const { name, doc } of workloads) {
    const images = [...doc.matchAll(/^\s+image: "?([^\s"]+)"?$/gm)].map((match) => match[1]);
    assert.equal(images.length, 1, `${name} runs one container`);
    assert.ok(ours.has(images[0]), `${name} runs ${images[0]}, not one of our rebuilt images`);
    assert.match(doc, /imagePullPolicy: IfNotPresent/, `${name} pull policy`);
    assert.match(doc, /^ {6}securityContext:\n {8}runAsNonRoot: true\n {8}seccompProfile:\n {10}type: RuntimeDefault$/m, `${name} pod security context`);
    assert.match(doc, /securityContext:\n\s+allowPrivilegeEscalation: false\n\s+capabilities:\n\s+drop: \[ALL\]/, `${name} container security context`);
  }
});

test('no client-supplied header can change the path oauth2-proxy authorizes: trusted proxies from the site, sessions reachable only from HAProxy and the operator', () => {
  // The site's trusted addresses are required: none, or "everyone", stops the render (fails closed).
  const scratch = mkdtempSync(path.join(tmpdir(), 'render-theia-'));
  try {
    const descriptor = listReleases(ROOT).find((item) => item.name === 'theia-cloud');
    for (const [index, cidrs] of [[], ['0.0.0.0/0'], ['::/0']].entries()) {
      const file = path.join(scratch, `trusted-${index}.yaml`);
      writeFileSync(file, JSON.stringify({ sterling: { trustedProxyIps: cidrs } }));
      const values = [...descriptor.values, descriptor.site, path.relative(ROOT, file)];
      assert.throws(() => renderRelease(ROOT, { ...descriptor, site: undefined, values }, { site: SITE, helm: HELM }), /trustedProxyIps/, JSON.stringify(cidrs));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const sessions = renderSite(ROOT, { site: SITE, helm: HELM, all: true }).find(({ name }) => name === 'sterling-sessions').yaml;
  const policy = splitDocs(sessions).find((doc) => kindOf(doc) === 'NetworkPolicy' && nameOf(doc) === 'sterling-session-ingress');
  assert.ok(policy, 'sterling-sessions renders the session NetworkPolicy');
  assert.match(policy, /podSelector:\n\s+matchLabels:\n\s+sterling-session: "true"/);
  assert.match(policy, /policyTypes:\n\s+- Ingress/);
  assert.match(policy, /kubernetes\.io\/metadata\.name: haproxy-controller/);
  assert.match(policy, /- podSelector:\n\s+matchLabels:\n\s+app: operator/);
  assert.equal((policy.match(/^ {4}- from:$/gm) ?? []).length, 1, 'one rule: HAProxy or the operator, nothing else');
});
