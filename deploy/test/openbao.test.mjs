// OpenBao as code (D-33, D-34, D-38 to D-41): the enrolment gate (two distinct passwordless keys before any OpenBao call), what the
// policies grant, and the key-move Control Groups. enrolPerson runs against injected Keycloak and OpenBao fakes, so no server is needed;
// policy files are read as text.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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

test('no policy a session token can hold grants any transit/keys/ path, and signing is only in the step-up policy', () => {
  const base = pathBlocks(policy('sterling-workbench'));
  const sign = pathBlocks(policy('sterling-workbench-sign'));
  for (const block of [...base, ...sign]) assert.doesNotMatch(block.path, /^transit\/keys\//, `${block.path} would let a session manage keys`);
  assert.ok(!base.some((block) => block.path.startsWith('transit/sign/')), 'the base policy cannot sign');
  assert.deepEqual(sign.map((block) => block.path), ['transit/sign/person-{{identity.entity.id}}']);
  assert.deepEqual(base.map((block) => block.path).sort(), ['auth/token/lookup-self', 'auth/token/renew-self', 'auth/token/revoke-self',
    'kv/data/users/{{identity.entity.id}}/*', 'kv/metadata/users/{{identity.entity.id}}/*', 'transit/datakey/wrapped/kek-{{identity.entity.id}}',
    'transit/decrypt/kek-{{identity.entity.id}}'].sort());
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
