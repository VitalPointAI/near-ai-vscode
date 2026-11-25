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
import { POLICIES, planApply } from '../openbao/apply.mjs';
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
      return alias ? reply(200, { id: alias.canonical_id, name: entities.get(alias.canonical_id)?.name, aliases: [alias] }) : { status: 204, data: null };
    }
    if (method === 'GET' && apiPath.startsWith('identity/entity/name/')) {
      const name = apiPath.slice('identity/entity/name/'.length);
      const entry = [...entities.entries()].find(([, value]) => value.name === name);
      return entry ? reply(200, { id: entry[0], ...entry[1] }) : { status: 404, data: { errors: [] } };
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
  return { request, calls, keys, aliases, entities, writes: () => calls.filter((call) => call.method === 'POST' && call.path !== 'identity/lookup/entity') };
}

const keycloak = (users) => ({
  findUser: async (username) => users[username]?.user,
  credentials: async (id) => Object.values(users).find((entry) => entry.user.id === id)?.credentials ?? [],
  groups: async (id) => Object.values(users).find((entry) => entry.user.id === id)?.groups ?? []
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
 * entity template is filled in, a path matches exactly, a trailing "*" matches any rest, and "+" matches one segment. A "deny" on a matching
 * block wins over every grant (guest-account denies the staff KV path on exactly the path sterling-workbench grants, so OpenBao merges the
 * two into one rule and the deny wins); otherwise any matching block that lists the capability allows it.
 */
function allows(policies, entity, capability, apiPath) {
  const matching = policies.flatMap((name) => pathBlocks(policy(name))).filter((block) => {
    const filled = block.path.replaceAll('{{identity.entity.id}}', entity);
    const glob = filled.endsWith('*');
    const pattern = (glob ? filled.slice(0, -1) : filled).split('+').map(escape).join('[^/]+');
    return new RegExp(`^${pattern}${glob ? '.*' : ''}$`).test(apiPath);
  });
  if (matching.some((block) => capabilitiesOf(block).includes('deny'))) return false;
  return matching.some((block) => capabilitiesOf(block).includes(capability));
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

/** The one policy block allowed to reach another person's KV path (D-84): list and delete of guests' secrets, in the officer's step-up role only. */
const PER_PERSON_EXCEPTION = Object.freeze({ file: 'guest-secrets-removal.hcl', path: 'kv/metadata/guests/*' });

test('every per-person path is templated on the entity and no policy names a literal entity id', () => {
  const exceptions = [];
  const files = readdirSync(POLICY_DIR).filter((name) => name.endsWith('.hcl'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const text = readFileSync(path.join(POLICY_DIR, file), 'utf8');
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, `${file} names a literal id`);
    for (const block of pathBlocks(text)) {
      if (/^(kv\/(data|metadata)\/(users|guests)\/|transit\/(sign|datakey|decrypt)\/)/.test(block.path)) {
        // The one exception (D-84, owner 2026-11-25): the security officer's step-up role removes ended guests' secrets.
        if (file === PER_PERSON_EXCEPTION.file && block.path === PER_PERSON_EXCEPTION.path) { exceptions.push(file); continue; }
        assert.match(block.path, /\{\{identity\.entity\.id\}\}/, `${file}: ${block.path} is a per-person path without the entity template`);
      }
    }
  }
  assert.deepEqual(exceptions, [PER_PERSON_EXCEPTION.file], 'exactly one exception, and it is there');
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

// Guest accounts (D-62, D-63, 47-19): the automatic end can only disable guest entities and file a create-only revocation request; every
// removal of a guest's records needs two key custodians; the operator's guest token reaches only what guests.mjs uses.
const shape = (name) => pathBlocks(policy(name)).map((block) => [block.path, capabilitiesOf(block), block.body.filter((line) => !line.startsWith('capabilities')).join(' ')]);

test('guest-expiry reads and disables guest entities only, files create-only revocation requests, and holds nothing else', () => {
  assert.deepEqual(shape('guest-expiry'), [
    ['identity/entity/name/guest-*', ['read', 'update'], 'allowed_parameters = { "disabled" = [true] }'],
    ['kv/data/site/revocation-requests/guest-*', ['create'], ''],
    ['kv/data/site/guest-ended/guest-*', ['create'], ''],
    ['sys/capabilities-self', ['update'], ''],
    ['auth/token/lookup-self', ['read'], ''],
    ['auth/token/revoke-self', ['update'], '']
  ]);
  const expiry = ['guest-expiry'];
  assert.equal(allows(expiry, ADA, 'update', 'identity/entity/name/guest-kc-1'), true);
  assert.equal(allows(expiry, ADA, 'update', 'identity/entity/name/keycloak-kc-1'), false, 'never a staff entity');
  for (const capability of ['read', 'update', 'delete', 'list']) assert.equal(allows(expiry, ADA, capability, 'kv/data/site/revocation-requests/guest-kc-1-guest-ended'), false, capability);
  assert.equal(allows(expiry, ADA, 'create', 'kv/data/site/revocation-requests/keycloak-kc-1-disabled'), false, 'only guest requests');
  assert.equal(allows(expiry, ADA, 'read', `kv/data/users/${ADA}/mail/work`), false);
});

test('guest-removal grants only delete, each behind two key-custodians approvals, and reaches no person\'s KV path', () => {
  const blocks = pathBlocks(policy('guest-removal'));
  assert.deepEqual(blocks.map((block) => [block.path, capabilitiesOf(block)]), [
    ['identity/entity/name/guest-*', ['delete']], ['transit/keys/person-*', ['delete']], ['transit/keys/kek-*', ['delete']]]);
  assert.ok(!blocks.some((block) => block.path.startsWith('kv/')), 'a person\'s KV data is reached only through the entity template');
  for (const block of blocks) {
    const body = block.body.join('\n');
    assert.match(body, /^control_group = \{$/m, `${block.path}: control_group`);
    assert.match(body, /^group_names = \["key-custodians"\]$/m, `${block.path}: approvers are key-custodians`);
    assert.match(body, /^approvals = 2$/m, `${block.path}: two approvals`);
  }
});

test('guest-operator reads approvers\' entities and the people directory, enables or disables guest entities, and files create-only requests', () => {
  assert.deepEqual(shape('guest-operator'), [
    ['identity/entity/name/keycloak-*', ['read'], ''],
    ['kv/data/site/people/*', ['read'], ''],
    ['identity/entity/name/guest-*', ['read', 'update'], 'allowed_parameters = { "disabled" = [] }'],
    ['kv/data/site/revocation-requests/guest-*', ['create'], ''],
    ['kv/data/site/guest-ended/guest-*', ['create'], ''],
    ['sys/capabilities-self', ['update'], '']
  ]);
  assert.equal(allows(['guest-operator'], ADA, 'update', 'identity/entity/name/keycloak-kc-1'), false, 'the operator never changes a staff entity');
  assert.equal(allows(['guest-operator'], ADA, 'read', `kv/data/users/${ADA}/mail/work`), false, 'and never reads a person\'s secrets');
});

test('apply.mjs plans the guest policies and the jwt role guest-expiry: its own audience and azp, the expiry policy only, 300 s, no default policy', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'deploy/openbao/apply.mjs'), '--site', SITE_FILE, '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const operations = JSON.parse(run.stdout);
  for (const what of ['policy guest-expiry', 'policy guest-removal', 'policy guest-operator', 'jwt role guest-expiry']) assert.ok(operations.some((operation) => operation.what === what), what);
  assert.deepEqual(operations.find((operation) => operation.write === 'auth/jwt/role/guest-expiry').body, {
    role_type: 'jwt', bound_audiences: ['sterling-guest-expiry'], bound_claims: { azp: 'sterling-guest-expiry' }, bound_claims_type: 'string', user_claim: 'sub',
    token_no_default_policy: true, token_policies: ['guest-expiry'], token_ttl: 300, token_max_ttl: 300, token_explicit_max_ttl: 300, token_period: 0
  });
});

// Raft snapshots (D-73, CP-9; 47-24): a scheduled job whose token can take a snapshot and do nothing else.
test('raft-snapshot grants exactly one path, sys/storage/raft/snapshot, with exactly the read capability', () => {
  assert.deepEqual(pathBlocks(policy('raft-snapshot')).map((block) => [block.path, capabilitiesOf(block), block.body.length]), [['sys/storage/raft/snapshot', ['read'], 1]]);
});

test('apply.mjs binds the kubernetes role raft-snapshot to ServiceAccount openbao-snapshot only, with the snapshot policy only and a short token', () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'deploy/openbao/apply.mjs'), '--site', SITE_FILE, '--dry-run'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const operations = JSON.parse(run.stdout);
  assert.ok(operations.some((operation) => operation.what === 'policy raft-snapshot'));
  const role = operations.find((operation) => operation.write === 'auth/kubernetes/role/raft-snapshot')?.body;
  assert.ok(role, 'kubernetes role raft-snapshot');
  assert.deepEqual(role.bound_service_account_names, ['openbao-snapshot']);
  assert.deepEqual(role.bound_service_account_namespaces, ['sterling-openbao']);
  assert.deepEqual(role.token_policies, ['raft-snapshot']);
  assert.equal(role.token_no_default_policy, true);
  assert.ok(role.token_ttl <= 600 && role.token_max_ttl <= 600, 'at most 10 minutes');
  assert.equal(role.audience, 'sterling-openbao-snapshot', 'a token for this audience only, never the API server\'s');
  const mount = operations.findIndex((operation) => operation.write === 'sys/auth/kubernetes');
  assert.ok(operations.findIndex((operation) => operation.write === 'auth/kubernetes/role/raft-snapshot') > mount, 'after the kubernetes mount 47-13 enables');
});

test('the rendered openbao release has CronJob openbao-raft-snapshot, ServiceAccount openbao-snapshot and PVC openbao-snapshots on the site class', () => {
  const site = loadSite(SITE_FILE);
  const yaml = renderRelease(ROOT, openbao(), { site, helm: HELM });
  const docs = yaml.split(/^---[ \t]*$/m);
  const job = docs.find((doc) => /^kind: CronJob$/m.test(doc) && /name: openbao-raft-snapshot/.test(doc));
  assert.ok(job, 'CronJob openbao-raft-snapshot');
  assert.match(job, /concurrencyPolicy: Forbid/);
  assert.match(job, /restartPolicy: OnFailure/);
  const server = /image: "([^"]+)"/.exec(docs.find((doc) => /^kind: StatefulSet$/m.test(doc)))[1];
  assert.match(server, /@sha256:[0-9a-f]{64}$/);
  assert.ok(job.includes(`image: "${server}"`), 'the server image by digest');
  assert.match(job, /imagePullPolicy: IfNotPresent/);
  assert.match(job, /runAsNonRoot: true/);
  assert.match(job, /seccompProfile:\n\s+type: RuntimeDefault/);
  assert.match(job, /allowPrivilegeEscalation: false/);
  assert.match(job, /readOnlyRootFilesystem: true/);
  assert.match(job, /drop: \[ALL\]/);
  assert.match(job, /serviceAccountName: openbao-snapshot/);
  assert.match(job, /automountServiceAccountToken: false/, 'only the projected token for OpenBao\'s audience');
  assert.match(job, /audience: sterling-openbao-snapshot/);
  assert.match(job, /name: sterling-site-ca/);
  assert.match(job, /value: https:\/\/openbao\.sterling-openbao\.svc:8200/);
  assert.ok(docs.some((doc) => /^kind: ServiceAccount$/m.test(doc) && /name: openbao-snapshot$/m.test(doc)), 'ServiceAccount openbao-snapshot');
  const claim = docs.find((doc) => /^kind: PersistentVolumeClaim$/m.test(doc) && /name: openbao-snapshots/.test(doc));
  assert.ok(claim, 'PVC openbao-snapshots');
  assert.match(claim, new RegExp(`storageClassName: "${site.storageClass}"`));
});

test('the snapshot script logs in with the ServiceAccount token, saves a UTC-timestamped file, keeps the newest, and never prints the token', () => {
  const yaml = renderRelease(ROOT, openbao(), { site: loadSite(SITE_FILE), helm: HELM });
  const job = yaml.split(/^---[ \t]*$/m).find((doc) => /name: openbao-raft-snapshot/.test(doc) && /^kind: CronJob$/m.test(doc));
  assert.match(job, /bao write -field=token auth\/kubernetes\/login role=raft-snapshot jwt=@\/var\/run\/secrets\/openbao\/token/);
  assert.match(job, /bao operator raft snapshot save "\/snapshots\/openbao-\$\(date -u \+%Y%m%dT%H%M%SZ\)\.snap"|bao operator raft snapshot save "\$file"/);
  assert.match(job, /date -u \+%Y%m%dT%H%M%SZ/);
  assert.match(job, /KEEP/);
  assert.match(job, /value: "28"/, 'keep from the site file');
  assert.doesNotMatch(job, /set -x|echo[^\n]*BAO_TOKEN|printenv|env\b[^:]/, 'the token is never printed');
});

// Removing ended guests' secrets (D-84, 47-34): the officer's step-up role is the only holder of the delete; the check job and the notice read.
test('guest-secrets-removal lists and reads the end and removal records, reads guest entities, and lists and deletes KV secrets', () => {
  assert.deepEqual(shape('guest-secrets-removal'), [
    ['kv/metadata/site/guest-ended/', ['list'], ''],
    ['kv/data/site/guest-ended/*', ['read'], ''],
    ['kv/metadata/site/guest-secrets-removed/', ['list'], ''],
    ['kv/data/site/guest-secrets-removed/guest-*', ['create', 'read'], ''],
    ['identity/entity/name/guest-*', ['read'], ''],
    ['kv/metadata/guests/*', ['list', 'delete'], ''],
    ['auth/token/lookup-self', ['read'], ''],
    ['auth/token/revoke-self', ['update'], '']
  ]);
  const officer = ['guest-secrets-removal'];
  for (const capability of ['read', 'create', 'update']) assert.equal(allows(officer, ADA, capability, `kv/data/users/${BEN}/mail/work`), false, `no ${capability} of anyone's secret values`);
  assert.equal(allows(officer, ADA, 'update', 'kv/data/site/guest-secrets-removed/guest-kc-1-20261124T120000Z'), false, 'a removal record is never changed');
  assert.equal(allows(officer, ADA, 'update', 'identity/entity/name/guest-kc-1'), false);
  for (const name of POLICIES.filter((item) => item !== 'guest-secrets-removal')) {
    assert.equal(allows([name], ADA, 'delete', `kv/metadata/users/${BEN}/mail/work`), false, `${name} cannot delete another person's secrets`);
    assert.equal(allows([name], ADA, 'delete', `kv/metadata/guests/${BEN}/mail/work`), false, `${name} cannot delete a guest's secrets`);
  }
  // The officer reaches guests' secrets (kv/guests/) and never a staff member's (kv/users/), not even by a hand-made request.
  assert.equal(allows(officer, ADA, 'delete', `kv/metadata/guests/${BEN}/mail/work`), true);
  assert.equal(allows(officer, ADA, 'list', `kv/metadata/guests/${BEN}/`), true);
  for (const capability of ['list', 'delete']) assert.equal(allows(officer, ADA, capability, `kv/metadata/users/${BEN}/mail/work`), false, `no ${capability} of a staff member's secrets`);
  for (const capability of ['read', 'create', 'update']) assert.equal(allows(officer, ADA, capability, `kv/data/guests/${BEN}/mail/work`), false, `no ${capability} of a guest's secret values`);
});

test('guest-account: a guest\'s session keeps its secrets under kv/guests/<own entity>, is denied kv/users/, and staff never reach kv/guests/', () => {
  assert.ok(POLICIES.includes('guest-account'), 'apply.mjs writes the policy');
  assert.deepEqual(shape('guest-account'), [
    ['kv/data/users/{{identity.entity.id}}/*', ['deny'], ''],
    ['kv/metadata/users/{{identity.entity.id}}/*', ['deny'], ''],
    ['kv/data/guests/{{identity.entity.id}}/*', ['create', 'read', 'update', 'delete', 'list'], ''],
    ['kv/metadata/guests/{{identity.entity.id}}/*', ['create', 'read', 'update', 'delete', 'list'], '']
  ]);
  // A guest's token: the session policies plus the entity's guest-account.
  const guest = [...SESSION_POLICIES, 'guest-account'];
  for (const capability of ['create', 'read', 'update', 'delete', 'list']) {
    assert.equal(allows(guest, ADA, capability, `kv/data/users/${ADA}/mail/work`), false, `a guest cannot ${capability} under kv/users/`);
    assert.equal(allows(guest, ADA, capability, `kv/metadata/users/${ADA}/mail/work`), false, `a guest cannot ${capability} under kv/metadata/users/`);
    assert.equal(allows(guest, ADA, capability, `kv/data/guests/${ADA}/mail/work`), true, `a guest can ${capability} their own`);
    assert.equal(allows(guest, ADA, capability, `kv/data/guests/${BEN}/mail/work`), false, `not another guest's (${capability})`);
  }
  // Staff (no guest-account) keep kv/users/<own> and never reach kv/guests/.
  assert.equal(allows(SESSION_POLICIES, ADA, 'create', `kv/data/users/${ADA}/mail/work`), true);
  for (const capability of ['create', 'read', 'list', 'delete']) assert.equal(allows(SESSION_POLICIES, ADA, capability, `kv/data/guests/${ADA}/mail/work`), false, capability);
  // The rest of the guest's session (their own keys, the people directory) is unchanged.
  assert.equal(allows(guest, ADA, 'read', `transit/keys/person-${ADA}`), true);
  assert.equal(allows(guest, ADA, 'create', `kv/data/site/people/${ADA}`), true);
});

test('the retention check reads the records and writes only the notice; officers read only the notice', () => {
  assert.deepEqual(shape('guest-retention-check'), [
    ['kv/metadata/site/guest-ended/', ['list'], ''],
    ['kv/data/site/guest-ended/*', ['read'], ''],
    ['kv/metadata/site/guest-secrets-removed/', ['list'], ''],
    ['identity/entity/name/guest-*', ['read'], ''],
    ['kv/data/site/notices/guest-secrets-removal', ['create', 'update'], '']
  ]);
  assert.deepEqual(shape('security-officer-notices'), [['kv/data/site/notices/guest-secrets-removal', ['read'], '']]);
});

const OFFICERS = ['5f7c2a1e-0b3d-4c6e-8a9f-1b2c3d4e5f60', '6a8d3b2f-1c4e-4d7f-9b0a-2c3d4e5f6a71'];
const roleBody = (operations, where) => operations.find((operation) => operation.write === where)?.body;

test('apply.mjs binds the removal role to the step-up acr and the named officers for the step-up window, and the notice role to the officers', () => {
  const site = { ...loadSite(SITE_FILE), securityOfficers: OFFICERS };
  const operations = planApply(site);
  for (const what of ['policy guest-secrets-removal', 'policy guest-retention-check', 'policy security-officer-notices']) assert.ok(operations.some((operation) => operation.what === what), what);
  assert.deepEqual(roleBody(operations, 'auth/jwt/role/guest-secrets-removal'), {
    role_type: 'jwt', bound_audiences: ['sterling-sessions'], user_claim: 'sub', token_no_default_policy: true,
    bound_claims: { acr: site.stepUpAcr, sub: OFFICERS }, bound_claims_type: 'string', token_policies: ['guest-secrets-removal'],
    token_ttl: site.stepUpMaxAgeSeconds, token_max_ttl: site.stepUpMaxAgeSeconds, token_explicit_max_ttl: site.stepUpMaxAgeSeconds, token_period: 0
  });
  assert.deepEqual(roleBody(operations, 'auth/jwt/role/security-officer-notices'), {
    role_type: 'jwt', bound_audiences: ['sterling-sessions'], user_claim: 'sub', token_no_default_policy: true,
    bound_claims: { sub: OFFICERS }, bound_claims_type: 'string', token_policies: ['security-officer-notices'],
    token_ttl: 60, token_max_ttl: 60, token_explicit_max_ttl: 60, token_period: 0
  });
  const check = roleBody(operations, 'auth/kubernetes/role/guest-retention-check');
  assert.deepEqual([check.bound_service_account_names, check.bound_service_account_namespaces, check.audience, check.token_policies, check.token_no_default_policy, check.token_ttl],
    [['guest-retention-check'], ['sterling-openbao'], 'sterling-openbao-guest-retention', ['guest-retention-check'], true, 300]);
  // No officer named: both jwt roles bind a subject no sign-in token has, so a stale list never stays admitted.
  const none = planApply({ ...loadSite(SITE_FILE), securityOfficers: [] });
  assert.deepEqual(roleBody(none, 'auth/jwt/role/guest-secrets-removal').bound_claims.sub, ['not-set']);
  assert.deepEqual(roleBody(none, 'auth/jwt/role/security-officer-notices').bound_claims.sub, ['not-set']);
  assert.throws(() => planApply({ ...loadSite(SITE_FILE), securityOfficers: ['ops-team'] }), /securityOfficers/);
  // The staff roles are unchanged.
  assert.deepEqual(roleBody(operations, 'auth/jwt/role/sterling-workbench-stepup').token_policies, ['sterling-workbench', 'sterling-workbench-sign']);
});

test('CronJob guest-retention-check reads, writes only the notice, alerts through Alertmanager and deletes nothing (D-84)', () => {
  const yaml = renderRelease(ROOT, openbao(), { site: loadSite(SITE_FILE), helm: HELM });
  const docs = yaml.split(/^---[ \t]*$/m);
  const job = docs.find((doc) => /^kind: CronJob$/m.test(doc) && /name: guest-retention-check/.test(doc));
  assert.ok(job, 'CronJob guest-retention-check');
  const server = /image: "([^"]+)"/.exec(docs.find((doc) => /^kind: StatefulSet$/m.test(doc)))[1];
  assert.ok(job.includes(`image: "${server}"`), 'the server image by digest');
  for (const setting of [/concurrencyPolicy: Forbid/, /serviceAccountName: guest-retention-check/, /automountServiceAccountToken: false/, /audience: sterling-openbao-guest-retention/,
    /readOnlyRootFilesystem: true/, /runAsNonRoot: true/, /drop: \[ALL\]/, /seccompProfile:\n\s+type: RuntimeDefault/]) assert.match(job, setting);
  assert.match(job, /auth\/kubernetes\/login role=guest-retention-check/);
  assert.match(job, /bao write kv\/data\/site\/notices\/guest-secrets-removal -/);
  assert.equal((job.match(/bao write /g) ?? []).length, 2, 'the login and the notice are its only writes');
  assert.doesNotMatch(job, /bao delete|-X DELETE|kv\/metadata\/users|kv\/data\/users/, 'it deletes nothing and reads no person\'s secrets');
  assert.match(job, /value: http:\/\/prometheus-alertmanager\.sterling-monitoring\.svc:9093/);
  assert.match(job, /"alertname":"GuestSecretsAwaitRemoval"/);
  assert.doesNotMatch(job, /echo[^\n]*(\$key|\$entity|BAO_TOKEN)/, 'it prints the count only');
  assert.ok(docs.some((doc) => /^kind: ServiceAccount$/m.test(doc) && /name: guest-retention-check$/m.test(doc)));
});
