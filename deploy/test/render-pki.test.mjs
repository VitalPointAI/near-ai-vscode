// Certificates, issuers, trust and the ingress on the rendered stack (D-07, D-16, D-32, D-44, D-50): every certificate comes from the site
// PKI (OpenBao's pki_int through the vault-type issuers), the bootstrap CA issues only OpenBao's first certificate, no other issuer and no
// ACME issuer exists, every namespace that verifies site TLS gets the site chain, the hubs are never behind the ingress, and HAProxy is the
// default ingress on node ports with the smart-card settings only when the site turns them on. Renders every release with the CI site.
// Needs helm ($HELM or PATH).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { CERT_MANAGER, DEFAULT_CRL_EXPIRY, POLICIES, planApply } from '../openbao/apply.mjs';
import { listReleases, loadSite, renderRelease, renderSite, splitDocs } from '../bundle/lib/render.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = loadSite(path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml'));
const HELM = process.env.HELM || 'helm';
const SCRATCH = mkdtempSync(path.join(tmpdir(), 'render-pki-'));
let rendered;

const kindOf = (doc) => /^kind:[ \t]*(\S+)/m.exec(doc)?.[1];
/** metadata.name and metadata.namespace: the indented lines right under the top-level metadata: line (read line by line). */
function meta(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => /^metadata:[ \t]*$/.test(line));
  const found = {};
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!/^[ \t]/.test(line)) break;
    const match = /^ {2}(name|namespace):[ \t]*"?([^\s"]+)"?/.exec(line);
    if (match && !found[match[1]]) found[match[1]] = match[2];
  }
  return found;
}
/** Every rendered document as { release, kind, name, namespace, doc }. */
const documents = (list) => list.flatMap(({ name: release, yaml }) => splitDocs(yaml).map((doc) => ({ release, kind: kindOf(doc), ...meta(doc), doc })));
/** The issuerRef name of a Certificate: the name line among the lines indented under issuerRef: (read line by line). */
function issuerOf(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line === '  issuerRef:');
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    const match = /^ {4}name:[ \t]*(\S+)$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}
/** The list items under a two-space key of spec (for example dnsNames), unquoted. */
const listUnder = (doc, key) => {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line === `  ${key}:`);
  const items = [];
  for (const line of start < 0 ? [] : lines.slice(start + 1)) {
    const match = /^ {4}- "?([^"]+)"?$/.exec(line);
    if (!match) break;
    items.push(match[1]);
  }
  return items;
};
/** A values file in the scratch folder, as a path the render reads relative to the repository. */
function scratchValues(name, text) {
  const file = path.join(SCRATCH, name);
  writeFileSync(file, text);
  return path.relative(ROOT, file);
}
/** One release rendered with extra values files layered after its own (as a per-site file would be). */
function renderWith(release, ...extra) {
  const descriptor = listReleases(ROOT).find((item) => item.name === release);
  const values = [...descriptor.values, ...(descriptor.site ? [descriptor.site] : []), ...extra];
  return documents([{ name: release, yaml: renderRelease(ROOT, { ...descriptor, site: undefined, values }, { site: SITE, helm: HELM, all: true }) }]);
}

before(() => { rendered = documents(renderSite(ROOT, { site: SITE, helm: HELM, all: true })); });
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

test('every Certificate is issued by site-pki or site-pki-hub; the bootstrap CA issues only OpenBao\'s first certificate, which site-pki re-issues', () => {
  const certificates = rendered.filter((item) => item.kind === 'Certificate');
  assert.ok(certificates.length >= 6, 'the stack renders its certificates');
  const issuerNames = new Set(rendered.filter((item) => /^(Cluster)?Issuer$/.test(item.kind)).map((item) => item.name));
  for (const { release, name, doc } of certificates) {
    const issuer = issuerOf(doc);
    if (release === 'theia-cloud-base' && name === 'theia-cloud-ca-certificate') {
      // An unconditional template of the upstream base chart; its issuer (issuerca) is off, so nothing ever issues it.
      assert.ok(!issuerNames.has(issuer), `theia-cloud-base: ${name} names ${issuer}, which must not be rendered`);
      continue;
    }
    if (release === 'sterling-pki-bootstrap') {
      assert.equal(name, 'openbao-tls', `${release}: the bootstrap CA issues only OpenBao's first certificate`);
      assert.equal(issuer, 'site-bootstrap-ca');
    } else {
      assert.ok(['site-pki', 'site-pki-hub'].includes(issuer), `${release}: Certificate ${name} is issued by ${issuer}`);
    }
    assert.match(doc, /^ {4}kind: ClusterIssuer$/m, `${release}: Certificate ${name} names a ClusterIssuer`);
  }
  const first = certificates.find((item) => item.release === 'sterling-pki-bootstrap');
  const again = certificates.find((item) => item.release === 'sterling-pki' && item.name === 'openbao-tls');
  assert.ok(again, 'sterling-pki re-issues openbao-tls');
  assert.equal(issuerOf(again.doc), 'site-pki');
  assert.equal(again.namespace, first.namespace);
  assert.deepEqual(listUnder(again.doc, 'dnsNames'), listUnder(first.doc, 'dnsNames'), 'the re-issued certificate serves the same names');
  const pki = certificates.filter((item) => item.release === 'sterling-pki').map((item) => `${item.namespace}/${item.name}`).sort();
  assert.deepEqual(pki, ['sterling-identity/keycloak-tls', 'sterling-logging/opensearch-tls', 'sterling-openbao/openbao-tls', 'sterling-registry/zot-tls']);
  // Harbor's certificate comes from its Ingress annotation; every annotation that asks cert-manager names site-pki.
  for (const { release, kind, name, doc } of rendered.filter((item) => item.kind === 'Ingress')) {
    const annotation = /cert-manager\.io\/(?:cluster-)?issuer:[ \t]*"?([^\s"]+)/.exec(doc)?.[1];
    if (annotation) assert.equal(annotation, 'site-pki', `${release}: ${kind} ${name} asks cert-manager for ${annotation}`);
  }
});

test('the only issuers are site-bootstrap-ca (CA type) and the vault-type site-pki and site-pki-hub, which sign only through pki_int', () => {
  const all = rendered.filter((item) => /^(Cluster)?Issuer$/.test(item.kind));
  // theia-cloud-base always renders a CA-type issuer on Secret theia-cloud-ca-key-pair; only its own CA certificate would fill that Secret,
  // and that certificate's issuer is off (previous test), so the issuer stays empty and can never sign.
  const upstream = all.filter((item) => item.release === 'theia-cloud-base');
  assert.deepEqual(upstream.map((item) => item.name), ['theia-cloud-selfsigned-issuer']);
  assert.match(upstream[0].doc, /^ {2}ca:\n {4}secretName: theia-cloud-ca-key-pair$/m);
  const filled = rendered.filter((item) => item.kind === 'Certificate' && /^ {2}secretName: theia-cloud-ca-key-pair$/m.test(item.doc));
  assert.deepEqual(filled.map((item) => item.name), ['theia-cloud-ca-certificate']);
  const issuers = all.filter((item) => item.release !== 'theia-cloud-base');
  assert.deepEqual(issuers.map((item) => `${item.kind} ${item.name}`).sort(), ['ClusterIssuer site-bootstrap-ca', 'ClusterIssuer site-pki', 'ClusterIssuer site-pki-hub']);
  for (const { name, doc } of all) {
    assert.doesNotMatch(doc, /^[ \t]*acme:/m, `${name}: an ACME issuer (D-16)`);
    assert.doesNotMatch(doc, /^[ \t]*selfSigned:/m, `${name}: a self-signed issuer`);
  }
  for (const { name, doc } of issuers) {
    if (name === 'site-bootstrap-ca') { assert.match(doc, /^ {2}ca:\n {4}secretName: site-bootstrap-ca$/m); continue; }
    assert.match(doc, /^ {2}vault:$/m, `${name} is a vault-type issuer (the intermediate's key stays in OpenBao)`);
    assert.match(doc, new RegExp(`^ {4}path: pki_int/sign/${name === 'site-pki' ? 'ingress' : 'hub'}$`, 'm'));
    assert.match(doc, /^ {4}server: https:\/\/openbao\.sterling-openbao\.svc:8200$/m);
    assert.match(doc, new RegExp(`^ {8}role: ${CERT_MANAGER.role}$`, 'm'), `${name} logs in to the role apply.mjs writes`);
    assert.match(doc, new RegExp(`^ {10}name: ${CERT_MANAGER.serviceAccount}$`, 'm'));
    assert.match(doc, new RegExp(`^ {12}- ${CERT_MANAGER.audience}$`, 'm'));
  }
  const account = rendered.find((item) => item.kind === 'ServiceAccount' && item.name === CERT_MANAGER.serviceAccount);
  assert.equal(account?.namespace, CERT_MANAGER.namespace);
  const binding = rendered.find((item) => item.kind === 'RoleBinding' && item.name === `${CERT_MANAGER.serviceAccount}-token`);
  assert.match(binding.doc, /^ {4}name: cert-manager$/m, 'only the cert-manager controller may request the issuer account\'s token');
  // OpenBao side: the policy grants the two sign paths and nothing else.
  assert.ok(POLICIES.includes('cert-manager'));
  const hcl = readFileSync(path.join(ROOT, 'deploy/openbao/policies/cert-manager.hcl'), 'utf8');
  assert.deepEqual([...hcl.matchAll(/^path "([^"]+)"/gm)].map((match) => match[1]), ['pki_int/sign/ingress', 'pki_int/sign/hub']);
  assert.deepEqual([...hcl.matchAll(/capabilities = (\[[^\]]*\])/g)].map((match) => match[1]), ['["update"]', '["update"]']);
});

test('ConfigMap sterling-site-ca is in every namespace that verifies site TLS, and the issuers trust the same chain', () => {
  const values = readFileSync(path.join(ROOT, 'deploy/values/sterling-pki.yaml'), 'utf8');
  const listed = [...values.split('backendNamespaces:')[0].matchAll(/^ {4}- (\S+)$/gm)].map((match) => match[1]);
  const network = readFileSync(path.join(ROOT, 'deploy/values/sterling-network.yaml'), 'utf8');
  for (const namespace of listed) assert.match(network, new RegExp(`- name: ${namespace}$`, 'm'), `${namespace} is a namespace of the stack`);
  for (const namespace of ['theia-cloud', 'sterling-identity', 'sterling-openbao', 'sterling-hubs', 'sterling-logging', 'sterling-log-shipper',
    'sterling-registry', 'kyverno', 'haproxy-controller', 'cert-manager']) assert.ok(listed.includes(namespace), `${namespace} gets the site chain`);
  const maps = rendered.filter((item) => item.kind === 'ConfigMap' && item.name === 'sterling-site-ca');
  assert.deepEqual(maps.map((item) => item.namespace).sort(), [...listed].sort());
  for (const { doc } of maps) {
    assert.match(doc, /^ {2}ca\.crt: ""$/m, 'the example has no chain, so nothing verifies (fails closed)');
    assert.match(doc, /^ {2}truststore\.p12: ""$/m);
  }
  // With a chain and the bootstrap CA still in use: every namespace and both issuers trust exactly those certificates.
  const root = '-----BEGIN CERTIFICATE-----\nUk9PVA==\n-----END CERTIFICATE-----';
  const intermediate = '-----BEGIN CERTIFICATE-----\nSU5U\n-----END CERTIFICATE-----';
  const bootstrap = '-----BEGIN CERTIFICATE-----\nQk9PVA==\n-----END CERTIFICATE-----';
  const withChain = renderWith('sterling-pki', scratchValues('chain.yaml', JSON.stringify({ siteCaChain: `${root}\n${intermediate}\n`, bootstrapCaCertificate: `${bootstrap}\n` })));
  const expected = `${root}\n${intermediate}\n${bootstrap}\n`;
  for (const { doc } of withChain.filter((item) => item.kind === 'ConfigMap')) assert.ok(doc.includes(`ca.crt: ${JSON.stringify(expected)}`));
  for (const { name, doc } of withChain.filter((item) => item.kind === 'ClusterIssuer')) {
    assert.equal(Buffer.from(/^ {4}caBundle: (\S+)$/m.exec(doc)?.[1] ?? '', 'base64').toString(), expected, `${name} trusts the chain`);
  }
  // After retire-bootstrap the bootstrap CA is trusted nowhere.
  const retired = renderWith('sterling-pki', scratchValues('retired.yaml', JSON.stringify({ siteCaChain: `${root}\n${intermediate}\n`, bootstrapCaCertificate: '' })));
  for (const { doc } of retired) assert.ok(!doc.includes('Qk9PVA') && !doc.includes(Buffer.from(bootstrap).toString('base64')), 'the retired bootstrap CA is gone');
});

test('the hubs\' certificates come from site-pki-hub and no Ingress routes to a hub', () => {
  const hubs = rendered.filter((item) => item.release === 'sterling-hub');
  const certificates = hubs.filter((item) => item.kind === 'Certificate');
  assert.equal(certificates.length, SITE.hubs.length);
  for (const { name, doc } of certificates) assert.equal(issuerOf(doc), 'site-pki-hub', `${name}`);
  for (const { release, name, namespace, doc } of rendered.filter((item) => item.kind === 'Ingress')) {
    assert.notEqual(namespace, 'sterling-hubs', `${release}: Ingress ${name} in the hubs' namespace`);
    assert.doesNotMatch(doc, /^ +name: hub-/m, `${release}: Ingress ${name} routes to a hub (D-44: the hub ends TLS itself)`);
  }
});

test('HAProxy is the default ingress class on node ports, and the client-certificate settings render only when the site turns smart cards on', () => {
  const ingress = rendered.filter((item) => item.release === 'kubernetes-ingress');
  const ingressClass = ingress.find((item) => item.kind === 'IngressClass');
  assert.equal(ingressClass?.name, 'haproxy');
  assert.match(ingressClass.doc, /ingressclass\.kubernetes\.io\/is-default-class: "true"/);
  assert.deepEqual(rendered.filter((item) => item.kind === 'IngressClass').map((item) => item.name), ['haproxy'], 'no other ingress class');
  const service = ingress.find((item) => item.kind === 'Service' && item.name === 'kubernetes-ingress');
  assert.match(service.doc, /^ {2}type: NodePort$/m);
  assert.match(service.doc, /nodePort: 30443/);
  assert.doesNotMatch(service.doc, /name: (quic|stat|admin)$/m, 'only HTTP and HTTPS are published');
  const config = ingress.find((item) => item.kind === 'ConfigMap' && item.name === 'kubernetes-ingress').doc;
  assert.match(config, /ssl-redirect: "true"/);
  // HAProxy replaces every forwarded header a client could send (oauth2-proxy matches its sign-in exemptions against X-Forwarded-Uri) and
  // does not append to a client's X-Forwarded-For. An Ingress with its own request-set-header list must repeat the four.
  const forwarded = ['X-Forwarded-For %[src]', 'X-Forwarded-Host %[req.hdr(host)]', 'X-Forwarded-Proto %[ssl_fc,iif(https,http)]', 'X-Forwarded-Uri %[url]'];
  assert.match(config, /forwarded-for: "false"/);
  for (const header of forwarded) assert.ok(config.split('\n').includes(`    ${header}`), `the controller sets ${header}`);
  for (const { namespace, name, doc } of rendered.filter((item) => item.kind === 'Ingress' && /haproxy\.org\/request-set-header/.test(item.doc))) {
    for (const header of forwarded) assert.ok(doc.includes(header), `${namespace}/${name} replaces the controller's list without ${header.split(' ')[0]}`);
  }
  assert.doesNotMatch(config, /client-ca|client-crt-optional/, 'smart cards are off by default');
  for (const { doc } of rendered.filter((item) => item.kind === 'Ingress')) assert.match(doc, /ingressClassName: "?haproxy"?$/m, 'every Ingress is served by HAProxy');
  const on = renderWith('kubernetes-ingress', scratchValues('smart-cards.yaml', JSON.stringify({ smartCards: { enabled: true, caSecret: 'smart-card-ca' } })));
  const onConfig = on.find((item) => item.kind === 'ConfigMap' && item.name === 'kubernetes-ingress').doc;
  assert.match(onConfig, /^ {2}client-ca: haproxy-controller\/smart-card-ca$/m);
  assert.match(onConfig, /^ {2}client-crt-optional: "true"$/m, 'a browser without a card still connects (passkeys, sessions)');
  assert.throws(() => renderWith('kubernetes-ingress', scratchValues('no-ca.yaml', JSON.stringify({ smartCards: { enabled: true, caSecret: '' } }))), /smartCards\.caSecret/);
  // Only the Keycloak Ingress forwards the certificate, and it always overwrites what a browser sent.
  const forwarding = rendered.filter((item) => item.kind === 'Ingress' && /Client-Cert/.test(item.doc));
  assert.deepEqual(forwarding.map((item) => `${item.namespace}/${item.name}`), ['sterling-identity/keycloakx']);
  const keycloak = forwarding[0].doc;
  assert.match(keycloak, /Client-Cert %\[ssl_c_der,base64\]/);
  assert.ok(keycloak.includes(`host: "keycloak.${SITE.domain}"`), `the Keycloak Ingress serves keycloak.${SITE.domain}`);
  assert.match(keycloak, /secretName: keycloak-tls/);
  assert.match(keycloak, /haproxy\.org\/server-ca: "sterling-identity\/sterling-site-ca"/, 'HAProxy verifies Keycloak with the site chain');
  assert.ok(rendered.some((item) => item.kind === 'Secret' && item.name === 'sterling-site-ca' && item.namespace === 'sterling-identity'));
});

test('the intermediate\'s revocation list outlasts the media trip to an edge site: 30 days unless the site sets at least a day', () => {
  const crl = (site) => planApply(site, { jwtPubkey: 'test' }).find((operation) => operation.write === 'pki_int/config/crl').body.expiry;
  const { crlExpiry: _unset, ...withoutSetting } = SITE;
  assert.equal(DEFAULT_CRL_EXPIRY, '720h');
  assert.equal(crl(withoutSetting), '720h', 'not OpenBao\'s 72-hour default');
  assert.equal(crl({ ...SITE, crlExpiry: '2160h' }), '2160h');
  assert.throws(() => crl({ ...SITE, crlExpiry: '12h' }), /crlExpiry/);
});
