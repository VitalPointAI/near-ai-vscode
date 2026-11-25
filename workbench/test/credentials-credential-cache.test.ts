// Phase 71, plan 13, task 1 (D-18; research 4.1 and 4.3): the session's credential state. The cache checks the person's hosted wallet with the
// extension's own Wallet and keeps it fresh from your organization's hub; the session says fresh, stale (Retry) or unavailable (connect, then
// Retry), and the key release check stops once the session ends or OpenBao refuses the person's token. The engine is the built staff bundle;
// the hub, OpenBao and the clock are fakes. Fictional Example Organization people; keys made at run time. Flat file name (H-71-01).
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadStaffEngine } from '../extension/src/node/staff/staff-engine.ts';
import {
  CREDENTIAL_ACTION_TEXT, createCredentialCache, identityStatusWith, type CacheHubFetch, type CacheSession, type CredentialCache, type CredentialEngine,
} from '../extension/src/node/credentials/credential-cache.ts';
import { REVOCATIONS, SUSPENSIONS, issue, list, makeWorld, type World } from '../../src/test/helpers/credentialWorld.ts';
import { issuerKey, policyDocumentFor } from '../../src/test/helpers/policyFixtures.ts';
import { buildOrganizationLayer } from '../../src/domain/gate/enrolment.ts';
import { CACHE_STATE_TEXT } from '../../src/domain/credentials/cacheState.ts';
import { didHostPath } from '../../src/domain/credentials/trustExport.ts';

const workbenchRoot = fileURLToPath(new URL('../..', import.meta.url));
const engine = loadStaffEngine<CredentialEngine>(workbenchRoot);
const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const TTL_MS = 900 * 1000;
const ENTITY = '3a9e7c1b-5d2f-4e8a-9b6c-0d1e2f3a4b5c';
const SECRET = { scale: 'ca-classified', level: 'Secret', compartments: [], releasability: [], handling: [] };

/** OpenBao KV for the person's own token: a refusal switch stands for a disabled entity or a revoked token (403). */
class OwnKv {
  readonly data = new Map<string, Record<string, unknown>>();
  refused = false;
  async read(path: string): Promise<Record<string, unknown> | undefined> {
    if (this.refused) throw Object.assign(new Error('permission denied'), { status: 403 });
    return this.data.get(path);
  }
  async list(folder: string): Promise<readonly string[]> {
    if (this.refused) throw Object.assign(new Error('permission denied'), { status: 403 });
    return [...this.data.keys()].filter((key) => key.startsWith(folder)).map((key) => key.slice(folder.length));
  }
}

/** The hub through the replica's connection: logs and lists, and a switch for an unreachable hub. */
class Hub implements CacheHubFetch {
  readonly logs = new Map<string, string>();
  readonly lists = new Map<string, string>();
  down = false;
  async getLog(path: string): Promise<string | undefined> { if (this.down) throw new Error('unreachable'); return this.logs.get(path); }
  async getList(name: string): Promise<string | undefined> { if (this.down) throw new Error('unreachable'); return this.lists.get(name); }
}

interface Setup { w: World; kv: OwnKv; hub: Hub; clock: { now: number }; session: { current: CacheSession | undefined }; cache: CredentialCache }

const TOKEN = { sub: 'f1e2d3c4-0000-4000-8000-000000000001', acr: 'gold', authTime: NOW / 1000 - 60, exp: NOW / 1000 + 3600 };

async function setup(options: { rules?: 'none' | 'no-credentials'; hubDown?: boolean; noHolder?: boolean } = {}): Promise<Setup> {
  const w = await makeWorld();
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const secret = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const issuer = issuerKey();
  const doc = policyDocumentFor({ key: issuer });
  const sections: Record<string, unknown> = { labels: doc.labels, agents: doc.agents, ...(options.rules === 'no-credentials' ? {} : { credentials: JSON.parse(JSON.stringify(w.section)) }) };
  const layer = buildOrganizationLayer(issuer, sections, { now: NOW - DAY, days: 90 });
  const kv = new OwnKv();
  kv.data.set(`users/${ENTITY}/credentials-wallet/${secret.hash}`, { format: 'sterling-wallet-item/1', credential: secret.credential, roles: [role.credential] });
  const hub = new Hub();
  hub.down = options.hubDown === true;
  for (const p of [w.root, w.officer, w.member]) hub.logs.set(didHostPath(p.did) as string, p.log);
  for (const signed of [await list(w.revocationKey, REVOCATIONS, 'revocation'), await list(w.suspensionKey, SUSPENSIONS, 'suspension')]) {
    hub.lists.set(signed.id.slice(signed.id.lastIndexOf('/') + 1), JSON.stringify(signed.credential));
  }
  const clock = { now: NOW };
  const session: { current: CacheSession | undefined } = { current: { token: TOKEN, entityId: ENTITY, space: 'users' } };
  const cache = createCredentialCache({
    engine: () => engine,
    rules: () => (options.rules === 'none' ? undefined : { text: JSON.stringify(layer), key: issuer.publicKey }),
    kv,
    session: () => session.current,
    holder: async () => (options.noHolder === true ? undefined : w.member.did),
    hub: () => hub,
    now: () => clock.now,
    timers: { setTimeout: () => ({}), clearTimeout: () => undefined },
  });
  return { w, kv, hub, clock, session, cache };
}

test('without your organization\'s rules, or rules with no credentials section, the session has no credential state and every key is released', async () => {
  for (const rules of ['none', 'no-credentials'] as const) {
    const s = await setup({ rules });
    await s.cache.start();
    assert.equal(s.cache.state(), undefined, rules);
    assert.equal(s.cache.policy(), undefined, rules);
    assert.deepEqual(s.cache.keyRelease().check('cell', SECRET), { ok: true }, rules);
    assert.deepEqual(identityStatusWith({ state: 'not-configured' }, s.cache), { state: 'not-configured' }, 'the status carries nothing extra');
  }
});

test('fresh after the first refresh: the wallet item and the role beside it check, the rules are verified, and a Secret cell\'s key is released', async () => {
  const s = await setup();
  assert.equal(s.cache.state()?.state, 'unavailable', 'nothing checked yet is unavailable, never fresh');
  await s.cache.start();
  assert.deepEqual(s.cache.state(), { state: 'fresh', message: CACHE_STATE_TEXT.fresh.text });
  assert.equal(s.cache.policy()?.section.root.did, s.w.root.did);
  assert.deepEqual(s.cache.keyRelease().check('cell', SECRET), { ok: true });
  assert.deepEqual(identityStatusWith({ state: 'ready', did: s.w.member.did, published: true }, s.cache),
    { state: 'ready', did: s.w.member.did, published: true, credentials: { state: 'fresh', message: CACHE_STATE_TEXT.fresh.text } });
});

test('stale at the time to live: protected keys wait with the stale sentence and Retry, and a successful Retry makes it fresh again', async () => {
  const s = await setup();
  await s.cache.start();
  const changes: number[] = [];
  s.cache.onDidChange(() => changes.push(s.clock.now));
  s.clock.now = NOW + TTL_MS;
  assert.deepEqual(s.cache.state(), { state: 'stale', message: CACHE_STATE_TEXT.stale.text, action: CREDENTIAL_ACTION_TEXT });
  assert.deepEqual(s.cache.keyRelease().check('cell', SECRET), { ok: false, reason: 'stale', sentence: CACHE_STATE_TEXT.stale.text, action: 'retry' });
  assert.deepEqual(await s.cache.refresh(), { state: 'fresh', message: CACHE_STATE_TEXT.fresh.text });
  assert.ok(changes.length > 0, 'the change event fired, so the key rings ask again');
  assert.deepEqual(s.cache.keyRelease().check('cell', SECRET), { ok: true });
});

test('unavailable when the hub is unreachable and no verified copy covers the need: connect, then Retry; Retry once it answers makes it fresh', async () => {
  const s = await setup({ hubDown: true });
  await s.cache.start();
  assert.deepEqual(s.cache.state(), { state: 'unavailable', message: CACHE_STATE_TEXT.unavailable.text, action: CREDENTIAL_ACTION_TEXT });
  assert.equal(s.cache.keyRelease().check('cell', SECRET).ok, false);
  s.hub.down = false;
  assert.equal((await s.cache.refresh())?.state, 'fresh');
});

test('a hub that stops answering keeps the last verified copies: fresh until the time to live, then stale, never stuck', async () => {
  const s = await setup();
  await s.cache.start();
  s.hub.down = true;
  s.clock.now = NOW + 5 * 60_000;
  assert.equal((await s.cache.refresh())?.state, 'fresh', 'the copies fetched five minutes ago still cover the need');
  s.clock.now = NOW + TTL_MS;
  assert.equal(s.cache.state()?.state, 'stale');
});

test('before the person\'s DID exists nothing is checked: unavailable with Retry, and no key above the lowest level is released', async () => {
  const s = await setup({ noHolder: true });
  await s.cache.start();
  assert.deepEqual(s.cache.state(), { state: 'unavailable', message: CACHE_STATE_TEXT.unavailable.text, action: CREDENTIAL_ACTION_TEXT });
  assert.equal(s.cache.keyRelease().check('cell', SECRET).ok, false);
  assert.deepEqual(s.cache.keyRelease().check('base', undefined), { ok: true }, 'an unmarked cell is not held back by a missing check');
});

test('once the session ends or OpenBao refuses the person\'s token, no key is released, the base cell included, even after a fresh check', async () => {
  const ended = await setup();
  await ended.cache.start();
  assert.deepEqual(ended.cache.keyRelease().check('cell', SECRET), { ok: true });
  ended.session.current = undefined;
  assert.equal(ended.cache.keyRelease().check('cell', SECRET).ok, false);
  assert.equal((ended.cache.keyRelease().check('base', undefined) as { reason?: string }).reason, 'session-ended');

  const disabled = await setup();
  await disabled.cache.start();
  disabled.kv.refused = true;
  await disabled.cache.refresh();
  assert.equal((disabled.cache.keyRelease().check('base', undefined) as { reason?: string }).reason, 'session-ended');
  assert.equal(disabled.cache.state()?.state, 'unavailable');

  const stopped = await setup();
  await stopped.cache.start();
  stopped.cache.stop();
  assert.equal((stopped.cache.keyRelease().check('base', undefined) as { reason?: string }).reason, 'session-ended');
});
