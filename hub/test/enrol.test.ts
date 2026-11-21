import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '@ext/domain/replica/cellKeys';
import { readHubFile } from '@ext/domain/replica/hubFile';
import type { HubFilePayload } from '@ext/domain/replica/hubFile';
import { RosterCache } from '../src/append/rosterCache';
import { ENROL_REFUSALS, ISSUE_REFUSALS, enrolProject, issueHubFile, secretHashOf } from '../src/enrol';
import type { EnrolContext, EnrolResult, HubIdentity } from '../src/enrol';
import { RateLimits } from '../src/limits';
import { openHubStore } from '../src/store/hubStore';
import type { HubStore } from '../src/store/hubStore';
import { WORLD_NOW, createHubWorld, makeHubIdentity, otherCertPin } from './helpers/hubWorld';
import type { HubWorld } from './helpers/hubWorld';

// Phase 32, plan 19 (D-41, D-64, D-58): enrolment is the only way a project reaches the hub. The operator's hub file carries a one-time secret whose
// hash the hub keeps; the staff lead's device sends the roster through hub.admit, hub.grant and the base cell grant with an HMAC under that secret.
// Every refusal is a named test with its id exact and nothing stored. All names and data are fictional.

const NOW = new Date(WORLD_NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

async function withStore(body: (store: HubStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'near-ai-hub-enrol-'));
  const store = await openHubStore(dir);
  try {
    await body(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function issue(store: HubStore, identity: HubIdentity, days = 7, now = NOW): HubFilePayload {
  const issued = issueHubFile(store, identity, { days, now });
  if (!issued.ok) throw new Error(issued.message);
  return issued.file.payload;
}

/** The refusal has this id and its sentence, the project is not on the hub and the enrolment is still unused. */
function expectRefused(store: HubStore, result: EnrolResult, reason: keyof typeof ENROL_REFUSALS, project: string, enrolment?: string): void {
  assert.deepEqual(result.ok ? 'ok' : result.reason, reason);
  if (result.ok) return;
  assert.equal(result.message, ENROL_REFUSALS[reason]);
  if (reason !== 'project-exists') assert.equal(store.project(project), undefined);
  if (reason !== 'project-exists') assert.deepEqual(store.heads(project), []);
  if (enrolment !== undefined && reason !== 'enrolment-used' && store.enrolment(enrolment) !== undefined) assert.equal(store.enrolment(enrolment)?.usedAt, undefined);
}

interface Setup {
  identity: HubIdentity;
  world: HubWorld;
  file: HubFilePayload;
  ctx: EnrolContext;
}

/** A hub identity, a world (prepared as the test needs) and a hub file issued now. */
function setup(store: HubStore, prepare: (world: HubWorld, identity: HubIdentity) => void = (world, identity) => { world.admitHub(identity); }): Setup {
  const identity = makeHubIdentity();
  const world = createHubWorld();
  prepare(world, identity);
  return { identity, world, file: issue(store, identity), ctx: { store, identity, now: NOW } };
}

test('a hub file is issued, then used once: the project and its roster are stored and the enrolment is marked used', () =>
  withStore(async (store) => {
    const { identity, world, file, ctx } = setup(store);
    assert.equal(store.enrolment(file.enrolment)?.usedAt, undefined);
    assert.equal(store.enrolment(file.enrolment)?.secretHash, secretHashOf(file.enrolmentSecret));
    assert.equal(store.enrolment(file.enrolment)?.expiresAt, NOW.getTime() + 7 * DAY_MS);
    let verified = 0;
    const cache = new RosterCache(store, identity);
    const result = await enrolProject({ ...ctx, cache, verify: () => { verified += 1; return true; } }, world.enrolRequest(file));
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    assert.equal(verified, world.entries.length);
    assert.equal(store.enrolment(file.enrolment)?.usedAt, NOW.getTime());
    assert.equal(store.enrolment(file.enrolment)?.project, world.project);
    assert.equal(store.project(world.project)?.genesisHash, world.genesisHash);
    assert.equal(store.grants(world.project).length, world.grants.length);
    assert.equal(cache.peek(world.project)?.head, world.head);
    // The hub follows the roster it stored: a fresh load agrees.
    const loaded = await new RosterCache(store, identity).get(world.project);
    assert.equal(loaded.head, world.head);
    assert.equal(loaded.standing(identity.writer), 'admitted');
    // Used once: the same file again is refused, and the project stays as it was.
    const again = await enrolProject(ctx, world.enrolRequest(file));
    assert.deepEqual(again.ok ? 'ok' : [again.reason, again.message], ['enrolment-used', ENROL_REFUSALS['enrolment-used']]);
    assert.equal(store.project(world.project)?.genesisHash, world.genesisHash);
  }));

test('malformed: a request that is not an enrolment is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    const good = world.enrolRequest(file);
    for (const bad of [undefined, 'enrol', {}, { ...good, extra: true }, { ...good, entries: [] }, { ...good, entries: [{ header: good.entries[0]?.header, body: 'AAAA' }] }, { ...good, entries: good.entries.slice(1) }]) {
      expectRefused(store, await enrolProject(ctx, bad), 'malformed', world.project, file.enrolment);
    }
    // A blob whose bytes do not hash to its name.
    expectRefused(store, await enrolProject(ctx, { ...good, blobs: [{ hash: 'a'.repeat(64), bytes: 'AAAA' }] }), 'malformed', world.project, file.enrolment);
  }));

test('enrolment-unknown: an enrolment id the hub never issued is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    expectRefused(store, await enrolProject(ctx, world.enrolRequest({ ...file, enrolment: 'enr-0000000000000000' })), 'enrolment-unknown', world.project);
  }));

test('enrolment-unknown: a hub file issued under an earlier encryption key cannot be used, because its secret can no longer be derived', () =>
  withStore(async (store) => {
    const { identity, world, file } = setup(store);
    const rotated: HubIdentity = { ...identity, x25519Private: x25519PrivateFromSeed(createHash('sha256').update('another encryption key').digest()) };
    expectRefused(store, await enrolProject({ store, identity: rotated, now: NOW }, world.enrolRequest(file)), 'enrolment-unknown', world.project, file.enrolment);
  }));

test('enrolment-expired: an expired hub file is never usable', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    const expiry = NOW.getTime() + 7 * DAY_MS;
    for (const at of [expiry + 1, expiry + 30 * DAY_MS]) {
      expectRefused(store, await enrolProject({ ...ctx, now: new Date(at) }, world.enrolRequest(file)), 'enrolment-expired', world.project, file.enrolment);
    }
    // At the expiry instant it is still good.
    const atExpiry = await enrolProject({ ...ctx, now: new Date(expiry) }, world.enrolRequest(file));
    assert.equal(atExpiry.ok, true);
  }));

test('enrolment-used: a second project with one enrolment is refused', () =>
  withStore(async (store) => {
    const { identity, world, file, ctx } = setup(store);
    assert.equal((await enrolProject(ctx, world.enrolRequest(file))).ok, true);
    const second = createHubWorld({ projectLabel: 'second exercise' });
    second.admitHub(identity);
    expectRefused(store, await enrolProject(ctx, second.enrolRequest(file)), 'enrolment-used', second.project);
  }));

test('bad-mac: an enrolment made without the hub file\'s secret is refused before any roster work', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    let verified = 0;
    const counting = { ...ctx, verify: (): boolean => { verified += 1; return true; } };
    expectRefused(store, await enrolProject(counting, world.enrolRequest({ ...file, enrolmentSecret: randomBytes(32).toString('base64url') })), 'bad-mac', world.project, file.enrolment);
    // A MAC over another claimed head than the one sent.
    const request = world.enrolRequest(file);
    expectRefused(store, await enrolProject(counting, { ...request, rosterHead: world.genesisHash }), 'bad-mac', world.project, file.enrolment);
    expectRefused(store, await enrolProject(counting, { ...request, mac: 'not-a-mac' }), 'bad-mac', world.project, file.enrolment);
    assert.equal(verified, 0);
  }));

test('roster-mismatch: a claimed head that is not the head of the fold is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    expectRefused(store, await enrolProject(ctx, world.enrolRequest(file, { rosterHead: world.genesisHash })), 'roster-mismatch', world.project, file.enrolment);
  }));

test('genesis-unreadable: a base cell grant whose key does not open the genesis is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store, (world, identity) => {
      world.admitHub(identity, { baseGrant: false });
      world.grant(world.lead, { roster: world.head, to: [identity], key: createHash('sha256').update('a key that seals nothing').digest() });
    });
    expectRefused(store, await enrolProject(ctx, world.enrolRequest(file)), 'genesis-unreadable', world.project, file.enrolment);
  }));

test('not-admitted: a roster with no hub.admit in force for this hub is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store, (world, identity) => {
      world.admitHub(identity);
      world.rosterEntry(world.lead, 'hub.revoke', { hub: identity.hub });
    });
    expectRefused(store, await enrolProject(ctx, world.enrolRequest(file)), 'not-admitted', world.project, file.enrolment);
  }));

test('wrong-pin: a roster that admits this hub with a pin from another certificate key is refused', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store, (world, identity) => { world.admitHub(identity, { certPin: otherCertPin() }); });
    expectRefused(store, await enrolProject(ctx, world.enrolRequest(file)), 'wrong-pin', world.project, file.enrolment);
  }));

test('wrong-key: a roster that admits this hub with another X25519 key is refused, whichever key the grant was wrapped to', () =>
  withStore(async (store) => {
    const other = x25519PrivateFromSeed(createHash('sha256').update('an older encryption key').digest());
    const otherX25519 = x25519PublicRaw(other).toString('base64url');
    const device = (identity: HubIdentity): { x25519: string; x25519Sig: string } => ({ x25519: otherX25519, x25519Sig: identity.signer.sign(x25519BindingBytes(otherX25519, identity.writer)) });
    // The lead wrapped the base cell key to the key the roster names: the hub cannot open it.
    const wrappedToOther = setup(store, (world, identity) => { world.admitHub(identity, { device: device(identity) }); });
    expectRefused(store, await enrolProject(wrappedToOther.ctx, wrappedToOther.world.enrolRequest(wrappedToOther.file)), 'wrong-key', wrappedToOther.world.project, wrappedToOther.file.enrolment);
    // The grant reached the hub's real key, but the roster still names another one.
    const wrappedToHub = setup(store, (world, identity) => {
      world.admitHub(identity, { device: device(identity), baseGrant: false });
      world.grant(world.lead, { roster: world.head, to: [identity] });
    });
    expectRefused(store, await enrolProject(wrappedToHub.ctx, wrappedToHub.world.enrolRequest(wrappedToHub.file)), 'wrong-key', wrappedToHub.world.project, wrappedToHub.file.enrolment);
  }));

test('no-base-grant: a roster that never gives this hub the base cell key is refused', () =>
  withStore(async (store) => {
    const none = setup(store, (world, identity) => { world.admitHub(identity, { baseGrant: false }); });
    expectRefused(store, await enrolProject(none.ctx, none.world.enrolRequest(none.file)), 'no-base-grant', none.world.project, none.file.enrolment);
    // A grant named at a roster where the hub was not admitted yet does not count: the roster never places it.
    const early = setup(store, (world, identity) => {
      world.grant(world.lead, { roster: world.genesisHash, to: [identity] });
      world.admitHub(identity, { baseGrant: false });
    });
    expectRefused(store, await enrolProject(early.ctx, early.world.enrolRequest(early.file)), 'no-base-grant', early.world.project, early.file.enrolment);
  }));

test('project-exists: a project already on the hub is refused with a second hub file', () =>
  withStore(async (store) => {
    const { identity, world, file, ctx } = setup(store);
    assert.equal((await enrolProject(ctx, world.enrolRequest(file))).ok, true);
    const second = issue(store, identity);
    const result = await enrolProject(ctx, world.enrolRequest(second));
    expectRefused(store, result, 'project-exists', world.project);
    assert.equal(store.enrolment(second.enrolment)?.usedAt, undefined);
  }));

test('rate-limited: enrol calls from one address past 10 a minute are refused before the request is read', () =>
  withStore(async (store) => {
    const { world, file, ctx } = setup(store);
    const limits = new RateLimits({ enrolPerMinute: 1 });
    const limited = { ...ctx, limits, address: '203.0.113.7' };
    expectRefused(store, await enrolProject(limited, {}), 'malformed', world.project);
    const refused = await enrolProject(limited, world.enrolRequest(file));
    expectRefused(store, refused, 'rate-limited', world.project, file.enrolment);
    if (!refused.ok) assert.ok((refused.retryAfterSeconds ?? 0) >= 1 && (refused.retryAfterSeconds ?? 0) <= 60);
  }));

test('issueHubFile refuses 0 and 31 days and a hub with no public address, and stores nothing', () =>
  withStore(async (store) => {
    const identity = makeHubIdentity();
    for (const days of [0, 31, 1.5, Number.NaN]) {
      const result = issueHubFile(store, identity, { days, now: NOW });
      assert.deepEqual(result.ok ? 'ok' : [result.reason, result.message], ['days', ISSUE_REFUSALS.days]);
    }
    const { address: _dropped, ...withoutAddress } = identity;
    const result = issueHubFile(store, withoutAddress, { days: 7, now: NOW });
    assert.deepEqual(result.ok ? 'ok' : [result.reason, result.message], ['address', ISSUE_REFUSALS.address]);
    assert.equal(issueHubFile(store, withoutAddress, { days: 7, now: NOW, address: 'not an address' }).ok, false);
    // 1 and 30 days are the edges that work, and the file reads back with its expiry.
    for (const days of [1, 30]) {
      const issued = issueHubFile(store, identity, { days, now: NOW });
      assert.equal(issued.ok, true);
      if (!issued.ok) continue;
      const read = readHubFile(issued.text, NOW);
      assert.equal(read.ok, true);
      if (read.ok) assert.equal(read.hubFile.expiresAt, new Date(NOW.getTime() + days * DAY_MS).toISOString());
      assert.equal(issued.text.includes(issued.file.payload.enrolmentSecret), true);
      assert.equal(JSON.stringify(store.enrolment(issued.file.payload.enrolment)).includes(issued.file.payload.enrolmentSecret), false);
    }
  }));

test('no refusal sentence holds a value, a hash or a key', () => {
  for (const [id, sentence] of Object.entries({ ...ENROL_REFUSALS, ...ISSUE_REFUSALS })) {
    assert.match(sentence, /^[A-Z].*\.$/, id);
    assert.doesNotMatch(sentence, /[0-9a-f]{16}/, id);
    assert.equal(sentence.includes('\u2014'), false, id);
  }
});

