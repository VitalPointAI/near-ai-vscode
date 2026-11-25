// Phase 71, D-25 (owner decision 2026-11-25, closing G466): a person binds their own computer by claiming its status list places in their own
// session, through a narrow create-only path under their own entity, at most 5 computers at once. The KV fake below answers the way the
// sterling-workbench policy does (deploy/openbao/policies/sterling-workbench.hcl, whose rules deploy/test/openbao.test.mjs checks): create and
// read on the person's own slot-1 to slot-5, create only on device places and on their own lost-computer request, and 403 for anything else
// or for a second write. The identity engine is the real code; every key and DID is made at run time. Flat file name (H-71-01).
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { test } from 'node:test';
import * as realEngine from '../tools/identity-entry.ts';
import { didKeyFromPublicKey } from '../../src/domain/did/didKey.ts';
import { IDENTITY_TEXT } from '../extension/src/common/identity.ts';
import { KEY_SERVICE_TEXT } from '../extension/src/common/key-service.ts';
import { ok, refused } from '../extension/src/common/service-result.ts';
import { createIdentityService, type IdentityEngine, type IdentityKv } from '../extension/src/node/credentials/identity-service.ts';
import {
  DEVICE_INDEX_FROM, MAX_COMPUTERS, deviceSlotAllocator, listComputers, reportLostComputer, slotPath, subjectOf,
} from '../extension/src/node/credentials/device-slots.ts';

const ENTITY = '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c';
const OTHER = '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';
const SUB = 'kc-alex';
const NOW = Date.parse('2026-11-25T09:00:00.000Z');
const REVOCATIONS = 'https://hq.example.org/v1/trust/status/revocation-1';
const SUSPENSIONS = 'https://hq.example.org/v1/trust/status/suspension-1';
const engine = realEngine as unknown as IdentityEngine;

class Forbidden extends Error {
  readonly status = 403;
}

/** KV as the person's session token sees it under the sterling-workbench policy. */
function policyKv(entityName = `keycloak-${SUB}`) {
  const data = new Map<string, Record<string, unknown>>();
  const writes: string[] = [];
  const own = (path: string): boolean => path.startsWith(`users/${ENTITY}/`) || path === `site/people/${ENTITY}`;
  const slot = (path: string): boolean => new RegExp(`^site/device-slots/${ENTITY}/slot-[1-5]$`).test(path);
  const createOnly = (path: string): boolean => path.startsWith('site/status-index/device-') || path.startsWith(`site/revocation-requests/${entityName}-computer-lost-`);
  const kv: IdentityKv & { data: typeof data; writes: string[] } = {
    data, writes,
    async read(path) {
      if (!own(path) && !slot(path)) throw new Forbidden('403');
      return data.get(path);
    },
    async create(path, value) {
      if (!own(path) && !slot(path) && !createOnly(path)) return 'exists';
      writes.push(path);
      if (data.has(path)) return 'exists';
      data.set(path, structuredClone(value));
      return 'created';
    },
    async write(path, value) {
      if (!own(path)) throw new Forbidden('403');
      data.set(path, structuredClone(value));
    },
    async list() { return []; },
    async remove(path) { if (!own(path)) throw new Forbidden('403'); data.delete(path); },
  };
  return kv;
}

function fakeKeys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  const state = { fresh: true };
  return {
    state,
    keys: {
      personPublicKey: async () => ok({ publicKey: publicRaw.toString('base64url'), keyVersion: 1 }),
      sign: async (message: string) => (state.fresh
        ? ok({ signature: edSign(null, Buffer.from(message, 'base64'), privateKey).toString('base64'), keyVersion: 1 })
        : refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm)),
    },
  };
}

const computer = (): string => {
  const { publicKey } = generateKeyPairSync('ed25519');
  return didKeyFromPublicKey('Ed25519', new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')));
};
const wordsOf = (did: string): string => realEngine.deviceIdentityWords(did).join(' ');

async function person(kv = policyKv()) {
  const keys = fakeKeys();
  let next = 0;
  const allocator = deviceSlotAllocator({ kv, entityId: () => ENTITY, lists: () => ({ revocation: REVOCATIONS, suspension: SUSPENSIONS }), now: () => NOW, randomIndex: () => next++ });
  const identity = createIdentityService({
    keys: keys.keys, kv, entityId: () => ENTITY, engine: () => engine, domain: 'hq.example.org', now: () => NOW, randomId: () => 'x7k2p9a1b2c3d4e5', statusAllocator: allocator,
  });
  assert.equal((await identity.ensurePersonDid()).state, 'ready');
  return { kv, keys, identity };
}

test('binding a computer claims the person\'s first slot and two device places, and the binding carries them', async () => {
  const { kv, identity } = await person();
  const did = computer();
  const bound = await identity.bindComputer(did, wordsOf(did), 'personal');
  assert.equal(bound.kind, 'ok');
  if (bound.kind !== 'ok') return;
  const credential = JSON.parse(bound.value.text) as { credentialStatus: Array<{ statusListIndex: string; statusListCredential: string }> };
  assert.deepEqual(credential.credentialStatus.map((entry) => [entry.statusListCredential, Number(entry.statusListIndex)]), [[REVOCATIONS, DEVICE_INDEX_FROM], [SUSPENSIONS, DEVICE_INDEX_FROM + 1]]);
  const record = kv.data.get(slotPath(ENTITY, 1)) as Record<string, unknown>;
  assert.equal(record.device, realEngine.deviceFingerprint(did));
  assert.deepEqual(record.revocation, { list: REVOCATIONS, index: DEVICE_INDEX_FROM });
  assert.ok(kv.data.has(`site/status-index/device-revocation-revocation-1/${String(DEVICE_INDEX_FROM)}`));
  assert.ok(kv.data.has(`site/status-index/device-suspension-suspension-1/${String(DEVICE_INDEX_FROM + 1)}`));
  assert.deepEqual(await listComputers({ kv, entityId: () => ENTITY }), ok([{ slot: 1, device: realEngine.deviceFingerprint(did), claimedAt: '2026-11-25T09:00:00Z' }]));
});

test('the cap: five computers bind, the sixth is refused with a plain sentence, and nothing more is claimed or changed', async () => {
  const { kv, identity } = await person();
  for (let count = 1; count <= MAX_COMPUTERS; count += 1) {
    const did = computer();
    assert.equal((await identity.bindComputer(did, wordsOf(did), 'managed')).kind, 'ok', `computer ${String(count)}`);
  }
  const before = structuredClone([...kv.data]);
  const sixth = computer();
  assert.deepEqual(await identity.bindComputer(sixth, wordsOf(sixth), 'managed'), refused(IDENTITY_TEXT.tooManyComputers));
  assert.deepEqual([...kv.data], before, 'no place claimed and no slot changed');
  assert.ok(!kv.writes.some((path) => path.endsWith('/slot-6')), 'there is no sixth slot to try');
});

test('a slot is never overwritten: one another session took a moment ago keeps its computer, and the binding takes the next', async () => {
  const kv = policyKv();
  const { identity } = await person(kv);
  const taken = { format: 'sterling-device-slot/1', device: `dev-${'a'.repeat(32)}`, revocation: { list: REVOCATIONS, index: 120_000 }, suspension: { list: SUSPENSIONS, index: 120_001 }, claimedAt: '2026-11-25T08:00:00Z' };
  kv.data.set(slotPath(ENTITY, 1), structuredClone(taken));
  const did = computer();
  assert.equal((await identity.bindComputer(did, wordsOf(did), 'personal')).kind, 'ok');
  assert.deepEqual(kv.data.get(slotPath(ENTITY, 1)), taken, 'slot 1 unchanged');
  assert.equal((kv.data.get(slotPath(ENTITY, 2)) as { device: string }).device, realEngine.deviceFingerprint(did));
});

test('a person never claims a slot under another entity: every slot write is their own, and another person\'s slots are not reached', async () => {
  const kv = policyKv();
  kv.data.set(slotPath(OTHER, 1), { format: 'sterling-device-slot/1', device: `dev-${'b'.repeat(32)}` });
  const { identity } = await person(kv);
  const did = computer();
  assert.equal((await identity.bindComputer(did, wordsOf(did), 'personal')).kind, 'ok');
  assert.deepEqual(kv.writes.filter((path) => path.startsWith('site/device-slots/')), [slotPath(ENTITY, 1)]);
  assert.equal(kv.data.get(slotPath(OTHER, 1))?.device, `dev-${'b'.repeat(32)}`);
  // An allocator pointed at someone else's entity gets nothing: the policy has no path for it.
  const borrowed = deviceSlotAllocator({ kv, entityId: () => OTHER, lists: () => ({ revocation: REVOCATIONS, suspension: SUSPENSIONS }), now: () => NOW });
  await assert.rejects(borrowed.allocate(realEngine.deviceFingerprint(did)) as Promise<unknown>, Forbidden);
  assert.equal(kv.data.get(slotPath(OTHER, 2)), undefined);
});

test('a binding stopped at the step-up uses the same slot again, so it never uses up one of the five', async () => {
  const { kv, keys, identity } = await person();
  const did = computer();
  keys.state.fresh = false;
  assert.deepEqual(await identity.bindComputer(did, wordsOf(did), 'personal'), refused(KEY_SERVICE_TEXT.stepUpNeeded, KEY_SERVICE_TEXT.confirm));
  keys.state.fresh = true;
  assert.equal((await identity.bindComputer(did, wordsOf(did), 'personal')).kind, 'ok');
  assert.ok(kv.data.has(slotPath(ENTITY, 1)));
  assert.ok(!kv.data.has(slotPath(ENTITY, 2)), 'still one slot');
});

test('without your organization\'s status lists in this session nothing is claimed and binding says why', async () => {
  const kv = policyKv();
  const keys = fakeKeys();
  const identity = createIdentityService({
    keys: keys.keys, kv, entityId: () => ENTITY, engine: () => engine, domain: 'hq.example.org', now: () => NOW,
    statusAllocator: deviceSlotAllocator({ kv, entityId: () => ENTITY, lists: () => undefined }),
  });
  await identity.ensurePersonDid();
  const did = computer();
  assert.deepEqual(await identity.bindComputer(did, wordsOf(did), 'personal'), refused(IDENTITY_TEXT.noStatusLists));
  assert.equal(kv.writes.filter((path) => path.startsWith('site/')).length, 1, 'only the directory entry the identity made');
});

test('a lost computer is reported once, under the person\'s own entity name; a guest\'s report goes under their guest name', async () => {
  const { kv, identity } = await person();
  const did = computer();
  await identity.bindComputer(did, wordsOf(did), 'personal');
  const deps = { kv, entityId: () => ENTITY, subject: () => SUB, now: () => NOW };
  assert.deepEqual(await reportLostComputer(deps, 1), ok({ filed: true }));
  const request = kv.data.get(`site/revocation-requests/keycloak-${SUB}-computer-lost-1`) as Record<string, unknown>;
  assert.deepEqual(request, {
    format: 'sterling-revocation-request/1', entity: `keycloak-${SUB}`, keycloakId: SUB, reason: 'computer-lost', slot: 1,
    device: realEngine.deviceFingerprint(did), seenAt: '2026-11-25T09:00:00Z', job: 'workbench: a lost computer',
  });
  assert.deepEqual(await reportLostComputer(deps, 1), ok({ filed: false }), 'once');
  assert.deepEqual(await reportLostComputer(deps, 2), refused(IDENTITY_TEXT.noComputer));
  const guest = await person(policyKv(`guest-${SUB}`));
  const guestDid = computer();
  await guest.identity.bindComputer(guestDid, wordsOf(guestDid), 'personal');
  assert.deepEqual(await reportLostComputer({ ...deps, kv: guest.kv }, 1), ok({ filed: true }));
  assert.ok(guest.kv.data.has(`site/revocation-requests/guest-${SUB}-computer-lost-1`));
  assert.equal(subjectOf(`h.${Buffer.from(JSON.stringify({ sub: SUB })).toString('base64url')}.s`), SUB);
});
