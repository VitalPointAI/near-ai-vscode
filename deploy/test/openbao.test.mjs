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
 * entity template is filled in, a path matches exactly, a trailing "*" matches any rest, and "+" matches one segment. These policies have no
 * deny blocks, so any matching block that lists the capability allows it.
 */
function allows(policies, entity, capability, apiPath) {
  return policies.flatMap((name) => pathBlocks(policy(name))).some((block) => {
    const filled = block.path.replaceAll('{{identity.entity.id}}', entity);
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
    'kv/data/users/{{identity.entity.id}}/*', 'kv/metadata/users/{{identity.entity.id}}/*', 'transit/datakey/wrapped/kek-{{identity.entity.id}}',
    'transit/decrypt/kek-{{identity.entity.id}}', 'transit/keys/person-{{identity.entity.id}}'].sort());
  // No glob anywhere under transit/ in a session policy.
  for (const block of [...base, ...sign].filter((item) => item.path.startsWith('transit/'))) assert.doesNotMatch(block.path, /[*+]/, `${block.path} is a glob`);
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
  for (const file of files) {
    const text = readFileSync(path.join(POLICY_DIR, file), 'utf8');
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, `${file} names a literal id`);
    for (const block of pathBlocks(text)) {
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
