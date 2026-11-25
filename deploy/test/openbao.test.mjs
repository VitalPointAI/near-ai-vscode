// OpenBao as code (D-33, D-34, D-38 to D-41): the enrolment gate (two distinct passwordless keys before any OpenBao call), what the
// policies grant, the key-move Control Groups, the rendered seal, plugin and TLS configuration, and the roles apply.mjs writes. enrolPerson
// runs against injected Keycloak and OpenBao fakes, so no server is needed; policy files are read as text. The render tests need helm
// ($HELM or PATH).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listReleases, loadSite, renderRelease } from '../bundle/lib/render.mjs';
import { countPasswordlessKeys, enrolPerson, rebindPerson } from '../openbao/enrol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const POLICY_DIR = path.join(ROOT, 'deploy/openbao/policies');
const policy = (name) => readFileSync(path.join(POLICY_DIR, `${name}.hcl`), 'utf8');

/** The path blocks of a policy as [{ path, body }], read line by line (a block ends at a line that is only "}"). */
function pathBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    const start = /^path "([^"]+)" \{$/.exec(line);
    if (start) { current = { path: start[1], body: [] }; blocks.push(current); continue; }
    if (current && line === '}') { current = null; continue; }
    if (current) current.body.push(line.trim());
  }
  return blocks;
}

const credential = (id, type = 'webauthn-passwordless') => ({ id: `record-${id}-${Math.random()}`, type, credentialData: JSON.stringify({ credentialId: id }) });

/** An in-memory OpenBao that answers the calls enrolment makes, recording every call. */
function fakeBao() {
  const calls = [];
  const entities = new Map();
  const aliases = new Map();
  const keys = new Map();
  let next = 0;
  const reply = (status, data) => ({ status, data: data === undefined ? null : { data } });
  const request = async (method, apiPath, body) => {
    calls.push({ method, path: apiPath, body });
    if (method === 'GET' && apiPath === 'sys/auth') return reply(200, { 'jwt/': { type: 'jwt', accessor: 'auth_jwt_1' } });
    if (apiPath === 'identity/lookup/entity') {
      const alias = [...aliases.values()].find((entry) => entry.name === body.alias_name && entry.mount_accessor === body.alias_mount_accessor);
      return alias ? reply(200, { id: alias.canonical_id, aliases: [alias] }) : { status: 204, data: null };
    }
    if (apiPath === 'identity/entity') { next += 1; const id = `entity-${next}`; entities.set(id, body); return reply(200, { id }); }
    if (apiPath === 'identity/entity-alias') { next += 1; const id = `alias-${next}`; aliases.set(id, { id, ...body }); return reply(200, { id }); }
    if (apiPath.startsWith('identity/entity-alias/id/')) { const id = apiPath.split('/').pop(); aliases.set(id, { id, ...body }); return reply(200, { id }); }
    if (apiPath.startsWith('transit/keys/')) {
      const name = apiPath.slice('transit/keys/'.length);
      if (method === 'GET') return keys.has(name) ? reply(200, keys.get(name)) : { status: 404, data: { errors: [] } };
      keys.set(name, body);
      return { status: 204, data: null };
    }
    return { status: 404, data: { errors: [`unexpected ${method} ${apiPath}`] } };
  };
  return { request, calls, keys, aliases, writes: () => calls.filter((call) => call.method === 'POST' && call.path !== 'identity/lookup/entity') };
}

const keycloak = (users) => ({
  findUser: async (username) => users[username]?.user,
  credentials: async (id) => Object.values(users).find((entry) => entry.user.id === id)?.credentials ?? []
});

test('one registered passwordless key is refused before any OpenBao call', async () => {
  const bao = fakeBao();
  const users = { ana: { user: { id: 'kc-ana' }, credentials: [credential('key-1'), credential('otp', 'otp')] } };
  await assert.rejects(enrolPerson({ username: 'ana', keycloak: keycloak(users), bao: bao.request }), /has 1 registered passwordless key; enrolment needs two registered keys/);
  assert.equal(bao.calls.length, 0);
});

test('two passwordless records with one credential id count as one key and are refused', async () => {
  const bao = fakeBao();
  const users = { ana: { user: { id: 'kc-ana' }, credentials: [credential('same'), credential('same')] } };
  assert.equal(countPasswordlessKeys(users.ana.credentials), 1);
  await assert.rejects(enrolPerson({ username: 'ana', keycloak: keycloak(users), bao: bao.request }), /needs two registered keys/);
  assert.equal(bao.calls.length, 0);
});

test('two distinct keys: entity, alias on the jwt mount and both non-exportable Transit keys; a second run changes nothing', async () => {
  const bao = fakeBao();
  const users = { ana: { user: { id: 'kc-ana' }, credentials: [credential('key-1'), credential('key-2')] } };
  const first = await enrolPerson({ username: 'ana', keycloak: keycloak(users), bao: bao.request });
  assert.deepEqual(first.created, ['entity', 'alias', `person-${first.entityId}`, `kek-${first.entityId}`]);
  const alias = [...bao.aliases.values()][0];
  assert.deepEqual({ name: alias.name, mount: alias.mount_accessor, entity: alias.canonical_id }, { name: 'kc-ana', mount: 'auth_jwt_1', entity: first.entityId });
  assert.deepEqual(bao.keys.get(`person-${first.entityId}`), { type: 'ed25519', exportable: false, allow_plaintext_backup: false });
  assert.deepEqual(bao.keys.get(`kek-${first.entityId}`), { type: 'aes256-gcm96', exportable: false, allow_plaintext_backup: false });
  const writes = bao.writes().length;
  const second = await enrolPerson({ username: 'ana', keycloak: keycloak(users), bao: bao.request });
  assert.equal(second.entityId, first.entityId);
  assert.deepEqual(second.created, []);
  assert.equal(bao.writes().length, writes, 'the second run wrote nothing');
});

test('re-enrolment moves the alias to the new Keycloak account, so the same entity keeps its keys', async () => {
  const bao = fakeBao();
  const users = { ana: { user: { id: 'kc-ana' }, credentials: [credential('key-1'), credential('key-2')] } };
  const { entityId } = await enrolPerson({ username: 'ana', keycloak: keycloak(users), bao: bao.request });
  const renewed = { ana: { user: { id: 'kc-ana-2' }, credentials: [credential('key-3')] } };
  await assert.rejects(rebindPerson({ username: 'ana', fromSub: 'kc-ana', keycloak: keycloak(renewed), bao: bao.request }), /needs two registered keys/);
  renewed.ana.credentials.push(credential('key-4'));
  const moved = await rebindPerson({ username: 'ana', fromSub: 'kc-ana', keycloak: keycloak(renewed), bao: bao.request });
  assert.equal(moved.entityId, entityId);
  assert.deepEqual([...bao.aliases.values()].map((alias) => alias.name), ['kc-ana-2']);
});

/** A block's capabilities, from its `capabilities = [...]` line. */
const capabilitiesOf = (block) => {
  const line = block.body.find((item) => item.startsWith('capabilities'));
  return line ? JSON.parse(line.slice(line.indexOf('['))) : [];
};

const escape = (text) => text.replace(/[.*?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a token holding these policies, for the entity `entity`, may use `capability` on `apiPath`, by OpenBao's ACL path rules: the
 * entity templates are filled in (the id with `entity`, the name with `keycloak-<entity>` as enrol.mjs names staff entities), a path matches
 * exactly, a trailing "*" matches any rest, and "+" matches one segment. These policies have no deny blocks, so any matching block that lists
 * the capability allows it.
 */
function allows(policies, entity, capability, apiPath) {
  return policies.flatMap((name) => pathBlocks(policy(name))).some((block) => {
    const filled = block.path.replaceAll('{{identity.entity.id}}', entity).replaceAll('{{identity.entity.name}}', `keycloak-${entity}`);
    const glob = filled.endsWith('*');
    const pattern = (glob ? filled.slice(0, -1) : filled).split('+').map(escape).join('[^/]+');
    return new RegExp(`^${pattern}${glob ? '.*' : ''}$`).test(apiPath) && capabilitiesOf(block).includes(capability);
  });
}

const SESSION_POLICIES = ['sterling-workbench', 'sterling-workbench-sign'];
const ADA = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b';
const BEN = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

test('a session token reads only its own signing key under transit/keys/, and signing is only in the step-up policy', () => {
  const base = pathBlocks(policy('sterling-workbench'));
  const sign = pathBlocks(policy('sterling-workbench-sign'));
  const keyBlocks = [...base, ...sign].filter((block) => block.path.startsWith('transit/keys'));
  // Exactly one: the person's own signing key, by the name enrol.mjs creates (person-<entity id>), read only.
  assert.deepEqual(keyBlocks.map((block) => [block.path, capabilitiesOf(block)]), [['transit/keys/person-{{identity.entity.id}}', ['read']]]);
  assert.ok(!sign.some((block) => block.path.startsWith('transit/keys')), 'the step-up policy reads no key');
  assert.ok(!base.some((block) => block.path.startsWith('transit/sign/')), 'the base policy cannot sign');
  assert.deepEqual(sign.map((block) => block.path), ['transit/sign/person-{{identity.entity.id}}']);
  assert.deepEqual(base.map((block) => block.path).sort(), ['auth/token/lookup-self', 'auth/token/renew-self', 'auth/token/revoke-self',
    'kv/data/site/people/{{identity.entity.id}}',
    ...[1, 2, 3, 4, 5].map((slot) => `kv/data/site/device-slots/{{identity.entity.id}}/slot-${slot}`),
    'kv/data/site/status-index/device-*', 'kv/data/site/revocation-requests/{{identity.entity.name}}-computer-lost-*',
    'kv/data/users/{{identity.entity.id}}/*', 'kv/metadata/users/{{identity.entity.id}}/*', 'transit/datakey/wrapped/kek-{{identity.entity.id}}',
    'transit/decrypt/kek-{{identity.entity.id}}', 'transit/keys/person-{{identity.entity.id}}'].sort());
  // No glob anywhere under transit/ in a session policy.
  for (const block of [...base, ...sign].filter((item) => item.path.startsWith('transit/'))) assert.doesNotMatch(block.path, /[*+]/, `${block.path} is a glob`);
});

test('71-10: a session creates and reads only its own people directory entry: no other person\'s, no wildcard, no update, list or delete', () => {
  const base = pathBlocks(policy('sterling-workbench'));
  const people = base.filter((block) => block.path.includes('site/people'));
  assert.deepEqual(people.map((block) => [block.path, capabilitiesOf(block)]), [['kv/data/site/people/{{identity.entity.id}}', ['create', 'read']]]);
  for (const block of people) assert.doesNotMatch(block.path, /[*+]/, 'no wildcard under site/people');
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/people/${ADA}`), true);
  assert.equal(allows(SESSION_POLICIES, ADA, 'read', `kv/data/site/people/${ADA}`), true);
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/people/${BEN}`), false, 'nobody claims another person\'s DID');
  assert.equal(allows(SESSION_POLICIES, ADA, 'read', `kv/data/site/people/${BEN}`), false);
  for (const capability of ['update', 'delete', 'list']) assert.equal(allows(SESSION_POLICIES, ADA, capability, `kv/data/site/people/${ADA}`), false, capability);
  assert.equal(allows(SESSION_POLICIES, ADA, 'list', 'kv/metadata/site/people/'), false);
});

test('the read reaches no other key: not another person\'s, not the KEK, not a longer name, and no list, export, rotate, config or change', () => {
  assert.equal(allows(SESSION_POLICIES, ADA, 'read', `transit/keys/person-${ADA}`), true, 'the person reads their own signing key');
  // Another person's key, and the person's own KEK.
  assert.equal(allows(SESSION_POLICIES, ADA, 'read', `transit/keys/person-${BEN}`), false);
  assert.equal(allows(SESSION_POLICIES, ADA, 'read', `transit/keys/kek-${ADA}`), false);
  // A wildcard or another name never matches the exact path.
  for (const name of ['person-*', '*', '+', `person-${ADA}-other`, `person-${ADA}x`, 'person-', `person-${ADA.slice(0, 8)}`]) {
    assert.equal(allows(SESSION_POLICIES, ADA, 'read', `transit/keys/${name}`), false, name);
  }
  // Listing the key names (LIST transit/keys and transit/keys/), or under the person's key.
  for (const listPath of ['transit/keys', 'transit/keys/', `transit/keys/person-${ADA}`]) assert.equal(allows(SESSION_POLICIES, ADA, 'list', listPath), false, listPath);
  // Export, backup, rotate, config, trim, import: other paths, none granted with any capability.
  for (const other of [`transit/export/signing-key/person-${ADA}`, `transit/export/public-key/person-${ADA}`, `transit/backup/person-${ADA}`,
    `transit/keys/person-${ADA}/rotate`, `transit/keys/person-${ADA}/config`, `transit/keys/person-${ADA}/trim`, `transit/keys/person-${ADA}/import`]) {
    for (const capability of ['read', 'create', 'update', 'list', 'delete']) assert.equal(allows(SESSION_POLICIES, ADA, capability, other), false, `${capability} ${other}`);
  }
  // Create, change or delete the key itself.
  for (const capability of ['create', 'update', 'delete', 'sudo']) assert.equal(allows(SESSION_POLICIES, ADA, capability, `transit/keys/person-${ADA}`), false, capability);
  // Signing still needs the step-up policy, and only with the person's own key; decrypt and rewrap are not granted on the signing key.
  assert.equal(allows(['sterling-workbench'], ADA, 'update', `transit/sign/person-${ADA}`), false);
  assert.equal(allows(SESSION_POLICIES, ADA, 'update', `transit/sign/person-${BEN}`), false);
  for (const verb of ['decrypt', 'rewrap', 'encrypt', 'hmac']) assert.equal(allows(SESSION_POLICIES, ADA, 'update', `transit/${verb}/person-${ADA}`), false, verb);
  assert.equal(allows(SESSION_POLICIES, ADA, 'update', `transit/rewrap/kek-${ADA}`), false);
});

test('every key-move path needs two approvals from key-custodians', () => {
  const blocks = pathBlocks(policy('key-move'));
  assert.deepEqual(blocks.map((block) => block.path).sort(), ['transit/backup/*', 'transit/export/*', 'transit/keys/+/config', 'transit/keys/+/import',
    'transit/keys/+/import_version', 'transit/restore/*'].sort());
  for (const block of blocks) {
    const body = block.body.join('\n');
    assert.match(body, /^control_group = \{$/m, `${block.path}: control_group`);
    assert.match(body, /^group_names = \["key-custodians"\]$/m, `${block.path}: approvers are key-custodians`);
    assert.match(body, /^approvals = 2$/m, `${block.path}: two approvals`);
  }
});

test('every per-person path is templated on the entity and no policy names a literal entity id', () => {
  const files = readdirSync(POLICY_DIR).filter((name) => name.endsWith('.hcl'));
  assert.ok(files.length >= 4);
  // The two paths that are not one person's own, by design, each with exactly this capability (71-12, D-14, D-15): an officer creates an inbox item
  // for another person (never reads, changes or deletes one), and signs with the site's status-list key, which belongs to no person.
  const notPerPerson = { 'credential-issuers.hcl': { 'kv/data/users/+/credentials-inbox/*': ['create'], 'transit/sign/status-list-${site.siteName}': ['update'] } };
  for (const file of files) {
    const text = readFileSync(path.join(POLICY_DIR, file), 'utf8');
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, `${file} names a literal id`);
    for (const block of pathBlocks(text)) {
      const allowed = notPerPerson[file]?.[block.path];
      if (allowed !== undefined) {
        assert.deepEqual(capabilitiesOf(block), allowed, `${file}: ${block.path} grants exactly ${allowed.join(', ')}`);
        continue;
      }
      if (/^(kv\/(data|metadata)\/users\/|transit\/(sign|datakey|decrypt)\/)/.test(block.path)) {
        assert.match(block.path, /\{\{identity\.entity\.id\}\}/, `${file}: ${block.path} is a per-person path without the entity template`);
      }
    }
  }
  assert.ok(pathBlocks(policy('enrolment')).every((block) => !block.path.startsWith('kv/')), 'the enrolment operator cannot read secrets');
});

const SITE_FILE = path.join(ROOT, 'deploy/test/fixtures/site.ci.yaml');
const HELM = process.env.HELM || 'helm';
const openbao = () => listReleases(ROOT).find((release) => release.name === 'openbao');

test('the rendered server configuration has the kms-pkcs11 plugin, its seal, TLS on, and no injector, CSI or HashiCorp image', () => {
  const yaml = renderRelease(ROOT, openbao(), { site: loadSite(SITE_FILE), helm: HELM });
  const plugin = /plugin "kms" "([a-z0-9-]+)" \{/.exec(yaml);
  const seal = /seal "([a-z0-9-]+)" \{/.exec(yaml);
  assert.ok(plugin && seal, 'a kms plugin and a seal stanza');
  assert.equal(seal[1], plugin[1], 'the seal is named after the plugin');
  assert.match(yaml, /plugin_directory = "\/openbao\/plugins"/);
  assert.match(yaml, /command {3}= "openbao-plugin-kms-pkcs11"/);
  assert.match(yaml, /sha256sum = "[0-9a-f]{64}"/);
  assert.match(yaml, /audit "file" "stdout" \{/);
  assert.match(yaml, /name: BAO_HSM_PIN/);
  assert.doesNotMatch(yaml, /tls_disable[ \t]*=/);
  assert.match(yaml, /tls_cert_file {6}= "\/openbao\/userconfig\/openbao-tls\/tls\.crt"/);
  assert.doesNotMatch(yaml, /hashicorp\//, 'no HashiCorp image (D-04)');
  assert.doesNotMatch(yaml, /agent-injector|csi-provider/, 'injector and CSI provider off');
  assert.equal((yaml.match(/retry_join \{/g) ?? []).length, 3, 'one retry_join per node of the 3-node example');
});

test('with a Shamir site file no seal stanza renders, and a missing seal choice stops the render', () => {
  const site = loadSite(SITE_FILE);
  const yaml = renderRelease(ROOT, { ...openbao(), site: 'deploy/test/fixtures/openbao-shamir.yaml' }, { site, helm: HELM });
  assert.match(yaml, /plugin "kms" "pkcs11"/);
  assert.doesNotMatch(yaml, /seal "/);
  assert.equal((yaml.match(/retry_join \{/g) ?? []).length, 1);
  assert.throws(() => renderRelease(ROOT, { ...openbao(), site: undefined }, { site, helm: HELM }), /sterling\.seal must be pkcs11 or shamir/);
});

test('apply.mjs gives only the step-up role the signing policy, bound to the step-up acr and capped at the step-up window', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'deploy/openbao/apply.mjs'), '--site', SITE_FILE, '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const operations = JSON.parse(run.stdout);
  const site = loadSite(SITE_FILE);
  const role = (name) => operations.find((operation) => operation.write === `auth/jwt/role/${name}`)?.body;
  const stepUp = role('sterling-workbench-stepup');
  const base = role('sterling-workbench');
  assert.deepEqual(stepUp.bound_claims, { acr: site.stepUpAcr });
  assert.equal(stepUp.token_explicit_max_ttl, site.stepUpMaxAgeSeconds);
  assert.equal(stepUp.token_max_ttl, site.stepUpMaxAgeSeconds);
  assert.deepEqual(stepUp.token_policies, ['sterling-workbench', 'sterling-workbench-sign']);
  assert.deepEqual(base.token_policies, ['sterling-workbench']);
  for (const body of [base, stepUp]) {
    assert.deepEqual(body.bound_audiences, ['sterling-sessions']);
    assert.equal(body.user_claim, 'sub');
    assert.equal(body.token_no_default_policy, true);
  }
  const config = operations.find((operation) => operation.write === 'auth/jwt/config').body;
  assert.equal(config.oidc_discovery_url, `https://keycloak.${site.domain}/realms/sterling`);
  for (const where of ['sys/mounts/kv', 'sys/mounts/transit', 'sys/mounts/pki_int', 'pki_int/roles/ingress', 'pki_int/roles/hub', 'identity/group/name/key-custodians']) {
    assert.ok(operations.some((operation) => operation.write === where), `apply writes ${where}`);
  }
});

test('the install policy reaches only the static application secrets under kv/data/apps/', () => {
  assert.deepEqual(pathBlocks(policy('install')).map((block) => block.path), ['kv/data/apps/*']);
});

// Phase 71, plan 12, task 1 (D-14, D-15, D-22): the status-list key, the issuer step-up role and the credential-issuers policy.
const ISSUERS_SITE = () => ({ ...loadSite(SITE_FILE), credentialIssuers: ['kc-officer-a', 'kc-officer-b'] });
const operationAt = (operations, write) => operations.find((operation) => operation.write === write);
/** Whether credential-issuers, with the site name filled in, lets a token use `capability` on `apiPath` (the same path rules as allows()). */
const issuerAllows = (capability, apiPath, siteName = 'ci') => pathBlocks(policy('credential-issuers')).some((block) => {
  const filled = block.path.replaceAll('${site.siteName}', siteName);
  const glob = filled.endsWith('*');
  const pattern = (glob ? filled.slice(0, -1) : filled).split('+').map(escape).join('[^/]+');
  return new RegExp(`^${pattern}${glob ? '.*' : ''}$`).test(apiPath) && capabilitiesOf(block).includes(capability);
});

test('71-12: planApply makes the non-exportable ed25519 key status-list-<site>, the credential-issuers policy and the issuer step-up role', async () => {
  const { planApply } = await import('../openbao/apply.mjs');
  const site = ISSUERS_SITE();
  const operations = planApply(site);
  assert.deepEqual(operationAt(operations, `transit/keys/status-list-${site.siteName}`)?.body, { type: 'ed25519', exportable: false, allow_plaintext_backup: false });
  const written = operationAt(operations, 'sys/policies/acl/credential-issuers')?.body.policy;
  assert.match(written, new RegExp(`^path "transit/sign/status-list-${site.siteName}" \\{$`, 'm'), 'the site name is filled in');
  assert.doesNotMatch(written, /\$\{site\./, 'no placeholder is left in what OpenBao receives');
  const role = operationAt(operations, 'auth/jwt/role/sterling-issuer-stepup')?.body;
  assert.deepEqual(role.bound_claims, { acr: site.stepUpAcr, sub: ['kc-officer-a', 'kc-officer-b'] });
  assert.equal(role.bound_claims_type, 'string');
  for (const ttl of ['token_ttl', 'token_max_ttl', 'token_explicit_max_ttl']) assert.equal(role[ttl], site.stepUpMaxAgeSeconds, ttl);
  assert.equal(role.token_period, 0);
  assert.deepEqual(role.token_policies, ['sterling-workbench', 'sterling-workbench-sign', 'credential-issuers']);
  assert.deepEqual(role.bound_audiences, ['sterling-sessions']);
  assert.equal(role.user_claim, 'sub');
  assert.equal(role.token_no_default_policy, true);
  // Only the issuer role holds the policy: not the session role, not the person's own step-up role.
  for (const name of ['sterling-workbench', 'sterling-workbench-stepup']) {
    assert.ok(!operationAt(operations, `auth/jwt/role/${name}`).body.token_policies.includes('credential-issuers'), name);
  }
});

test('71-12: officer subjects come only from the site file, and a bad list or site name stops the plan', async () => {
  const { planApply } = await import('../openbao/apply.mjs');
  const site = loadSite(SITE_FILE);
  for (const credentialIssuers of ['kc-officer-a', [''], ['kc-a', 'kc-a'], [42]]) {
    assert.throws(() => planApply({ ...site, credentialIssuers }), /credentialIssuers/, JSON.stringify(credentialIssuers));
  }
  assert.throws(() => planApply({ ...ISSUERS_SITE(), siteName: 'Bad Name/..' }), /siteName/);
});

test('71-12: without credentialIssuers the key and policy are made but no issuer role, and the dry run says so', async () => {
  const { planApply } = await import('../openbao/apply.mjs');
  const operations = planApply(loadSite(SITE_FILE));
  assert.ok(operationAt(operations, 'transit/keys/status-list-ci'));
  assert.ok(operationAt(operations, 'sys/policies/acl/credential-issuers'));
  assert.equal(operationAt(operations, 'auth/jwt/role/sterling-issuer-stepup'), undefined);
  const run = spawnSync(process.execPath, [path.join(ROOT, 'deploy/openbao/apply.mjs'), '--site', SITE_FILE, '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /no jwt role sterling-issuer-stepup: the site file names no credentialIssuers, so nobody can sign status lists yet/);
});

test('71-12: credential-issuers signs only with the status-list key, creates inbox items and never reads, changes or deletes one', () => {
  assert.equal(issuerAllows('update', 'transit/sign/status-list-ci'), true);
  assert.equal(issuerAllows('update', 'transit/sign/status-list-other'), false, 'only this site\'s key');
  for (const other of [`transit/sign/person-${ADA}`, 'transit/keys/status-list-ci', 'transit/keys/status-list-ci/rotate', 'transit/keys/status-list-ci/config',
    'transit/export/signing-key/status-list-ci', 'transit/backup/status-list-ci', 'transit/keys/', 'sys/policies/acl/credential-issuers']) {
    for (const capability of ['read', 'create', 'update', 'delete', 'list', 'sudo']) assert.equal(issuerAllows(capability, other), false, `${capability} ${other}`);
  }
  const inbox = `kv/data/users/${ADA}/credentials-inbox/${'0f'.repeat(32)}`;
  assert.equal(issuerAllows('create', inbox), true);
  for (const capability of ['read', 'update', 'delete', 'list', 'patch']) {
    assert.equal(issuerAllows(capability, inbox), false, capability);
    assert.equal(issuerAllows(capability, inbox.replace('/data/', '/metadata/')), false, `metadata ${capability}`);
  }
  // Nothing else of a person's own: not their wallet, not their identity record, not a deeper folder that merely ends the same way.
  for (const other of [`kv/data/users/${ADA}/credentials-wallet/0f`, `kv/data/users/${ADA}/identity/did-webvh`, `kv/data/users/${ADA}/x/credentials-inbox/0f`]) {
    for (const capability of ['create', 'read', 'update']) assert.equal(issuerAllows(capability, other), false, `${capability} ${other}`);
  }
  assert.equal(issuerAllows('read', `kv/data/site/people/${ADA}`), true);
  assert.equal(issuerAllows('list', 'kv/metadata/site/people/'), true);
  for (const capability of ['create', 'update', 'delete']) assert.equal(issuerAllows(capability, `kv/data/site/people/${ADA}`), false, capability);
});

test('71-12: the revocation inbox is read and deleted, never written, and the issued register is create and read only', () => {
  const request = 'kv/data/site/revocation-requests/keycloak-kc-1-disabled';
  const requestMeta = 'kv/metadata/site/revocation-requests/keycloak-kc-1-disabled';
  assert.equal(issuerAllows('read', request), true);
  assert.equal(issuerAllows('list', 'kv/metadata/site/revocation-requests/'), true);
  assert.equal(issuerAllows('delete', requestMeta), true);
  for (const capability of ['create', 'update', 'patch']) {
    assert.equal(issuerAllows(capability, request), false, `${capability}: requests come only from 47-20 and 47-31`);
    assert.equal(issuerAllows(capability, requestMeta), false, `metadata ${capability}`);
  }
  assert.equal(issuerAllows('delete', request), false, 'a soft delete would leave the request listed');
  assert.equal(issuerAllows('read', 'identity/entity/name/keycloak-kc-1'), true);
  for (const capability of ['create', 'update', 'delete', 'list']) assert.equal(issuerAllows(capability, 'identity/entity/name/keycloak-kc-1'), false, capability);
  assert.equal(issuerAllows('read', `identity/entity/id/${ADA}`), false);
  const issued = `kv/data/site/issued/${ADA}/${'a'.repeat(64)}`;
  assert.equal(issuerAllows('create', issued), true);
  assert.equal(issuerAllows('read', issued), true);
  assert.equal(issuerAllows('list', `kv/metadata/site/issued/${ADA}/`), true);
  for (const capability of ['update', 'delete', 'patch']) assert.equal(issuerAllows(capability, issued), false, capability);
  assert.equal(issuerAllows('delete', issued.replace('/data/', '/metadata/')), false, 'the register is never deleted');
  assert.equal(issuerAllows('create', 'kv/data/site/status-index/revocation/1234'), true, 'an index is claimed once');
  for (const capability of ['read', 'update', 'delete']) assert.equal(issuerAllows(capability, 'kv/data/site/status-index/revocation/1234'), false, capability);
  for (const other of ['kv/data/apps/keycloak', 'kv/data/site/other/x']) for (const capability of ['read', 'create', 'list']) assert.equal(issuerAllows(capability, other), false, `${capability} ${other}`);
});

test('71-12: a second run against the recorded state writes nothing', async () => {
  const { applyPlan, planApply } = await import('../openbao/apply.mjs');
  const state = new Map();
  const request = async (method, apiPath, body) => {
    if (method === 'POST') { state.set(apiPath, body); return { status: 204, data: null }; }
    const under = (prefix) => Object.fromEntries([...state].filter(([where]) => where.startsWith(prefix)).map(([where, value]) => [`${where.slice(prefix.length)}/`, value]));
    if (apiPath === 'sys/mounts') return { status: 200, data: { data: under('sys/mounts/') } };
    if (apiPath === 'sys/auth') return { status: 200, data: { data: under('sys/auth/') } };
    return state.has(apiPath) ? { status: 200, data: { data: state.get(apiPath) } } : { status: 404, data: null };
  };
  const first = await applyPlan(request, planApply(ISSUERS_SITE()));
  assert.ok(first.every((item) => item.result === 'written'));
  assert.ok(first.some((item) => item.what === 'jwt role sterling-issuer-stepup'));
  const second = await applyPlan(request, planApply(ISSUERS_SITE()));
  assert.deepEqual(second.filter((item) => item.result !== 'unchanged'), []);
});

// Phase 71, D-25 (owner decision 2026-11-25, closing G466): a person claims their own computer's status list place through a narrow create-only
// path, under their own entity only, at most 5 computers; they never claim another person's slot, change a claimed one or sign a status list.
test('D-25: a person creates and reads only their own five computer slots, never a sixth, never another person\'s, and never changes one', () => {
  for (let slot = 1; slot <= 5; slot += 1) {
    const own = `kv/data/site/device-slots/${ADA}/slot-${slot}`;
    assert.equal(allows(SESSION_POLICIES, ADA, 'create', own), true, own);
    assert.equal(allows(SESSION_POLICIES, ADA, 'read', own), true, own);
    for (const capability of ['update', 'delete', 'patch', 'list']) assert.equal(allows(SESSION_POLICIES, ADA, capability, own), false, `${capability} ${own}: a claimed slot is never changed`);
    assert.equal(allows(SESSION_POLICIES, ADA, 'delete', `kv/metadata/site/device-slots/${ADA}/slot-${slot}`), false, 'nor removed by the person');
    assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/device-slots/${BEN}/slot-${slot}`), false, 'never under another entity');
    assert.equal(allows(SESSION_POLICIES, ADA, 'read', `kv/data/site/device-slots/${BEN}/slot-${slot}`), false);
  }
  // The cap is the five names: a sixth slot, any other name or a deeper path has no create.
  for (const other of ['slot-6', 'slot-0', 'slot-10', 'slot-1x', 'slot-1/x', 'slot', 'x']) {
    assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/device-slots/${ADA}/${other}`), false, other);
  }
  assert.equal(allows(SESSION_POLICIES, ADA, 'list', `kv/metadata/site/device-slots/${ADA}/`), false);
});

test('D-25: a person claims device places only, once each, never an officer\'s place, never a list signature, and reports only their own lost computer', () => {
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', 'kv/data/site/status-index/device-revocation-revocation-1/120000'), true);
  for (const capability of ['read', 'update', 'delete', 'list']) assert.equal(allows(SESSION_POLICIES, ADA, capability, 'kv/data/site/status-index/device-revocation-revocation-1/120000'), false, capability);
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', 'kv/data/site/status-index/revocation-revocation-1/4000'), false, 'officers\' places are theirs');
  for (const key of ['transit/sign/status-list-ci', 'transit/sign/status-list-site']) assert.equal(allows(SESSION_POLICIES, ADA, 'update', key), false, key);
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/revocation-requests/keycloak-${ADA}-computer-lost-2`), true);
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/revocation-requests/keycloak-${BEN}-computer-lost-2`), false, 'never about another person');
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/site/revocation-requests/keycloak-${ADA}-disabled`), false, 'only a lost computer');
  for (const capability of ['read', 'update', 'delete', 'list']) assert.equal(allows(SESSION_POLICIES, ADA, capability, `kv/data/site/revocation-requests/keycloak-${ADA}-computer-lost-2`), false, capability);
});

test('D-25: officers read people\'s computer slots and free one by removing it; they never create or change one', () => {
  const slot = `kv/data/site/device-slots/${ADA}/slot-3`;
  assert.equal(issuerAllows('read', slot), true);
  assert.equal(issuerAllows('delete', slot.replace('/data/', '/metadata/')), true);
  assert.equal(issuerAllows('list', `kv/metadata/site/device-slots/${ADA}/`), true);
  for (const capability of ['create', 'update', 'delete']) assert.equal(issuerAllows(capability, slot), false, capability);
});
