// The extension's wallet keeps its logs and lists fresh from your organization's hub (Phase 71 plan 13 Task 3; D-11, OFFL-01): HubTrustSource
// fetches over the hub connection the replica already holds, keeps only what verifies, keeps the last verified copies when a fetch fails, and the
// wallet refreshes in the background so a gate decision never waits on the network. Fictional Example Organization people; keys made at run time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TRUST_TEXT, HubTrustSource } from '../gate/hubTrustSource';
import type { HubTrustFetch } from '../gate/hubTrustSource';
import { clearancesInForce } from '../gate/clearances';
import { WALLET_SECRET_KEY, Wallet, walletStateAt } from '../gate/wallet';
import type { TrustSource } from '../gate/wallet';
import { didHostPath } from '../domain/credentials/trustExport';
import { REVOCATIONS, SUSPENSIONS, issue, list, makeWorld } from './helpers/credentialWorld';
import type { Issued, SignedList, World } from './helpers/credentialWorld';
import { MemorySecrets } from './helpers/teamHarness';
import { createHash, createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { certPinOf } from '../domain/replica/hubFile';
import { fingerprintOf } from '../domain/team/canonical';
import { HubTransport } from '../staff/replica/hubTransport';
import { FIXTURE_CERT, FakeHubServer } from './helpers/fakeHubServer';

const NOW = Date.UTC(2026, 10, 21);
const TTL_MS = 900 * 1000;

/** A fake hub reached through the replica's connection: logs by DID path and lists by name, with a switch for an unreachable hub. */
class FakeHub implements HubTrustFetch {
  public readonly logs = new Map<string, string>();
  public readonly lists = new Map<string, string>();
  public calls = 0;
  public down = false;
  public hang = false;
  public async getLog(path: string): Promise<string | undefined> {
    return this.answer(() => this.logs.get(path));
  }
  public async getList(name: string): Promise<string | undefined> {
    return this.answer(() => this.lists.get(name));
  }
  private answer(read: () => string | undefined): Promise<string | undefined> {
    this.calls += 1;
    if (this.hang) return new Promise(() => undefined);
    if (this.down) return Promise.reject(new Error('unreachable'));
    return Promise.resolve(read());
  }
}

interface Setup { w: World; role: Issued; hub: FakeHub; clock: { now: number }; source: HubTrustSource; secret: Issued }

const nameOf = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

async function setup(options: { hub?: boolean; files?: boolean } = {}): Promise<Setup> {
  const w = await makeWorld();
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const secret = await issue(w.officer.signer, w.officer.did, 'ClearanceCredential', { id: w.member.did, scale: 'ca-classified', atLeast: 'Secret' });
  const hub = new FakeHub();
  for (const p of [w.root, w.officer, w.member]) hub.logs.set(didHostPath(p.did) as string, p.log);
  for (const signed of [await list(w.revocationKey, REVOCATIONS, 'revocation'), await list(w.suspensionKey, SUSPENSIONS, 'suspension')]) hub.lists.set(nameOf(signed.id), JSON.stringify(signed.credential));
  const clock = { now: NOW };
  // The imported trust files of the same organization: its logs, its lists and the officer's role, held in memory.
  const lists = new Map<string, SignedList>([[REVOCATIONS, await list(w.revocationKey, REVOCATIONS, 'revocation')], [SUSPENSIONS, await list(w.suspensionKey, SUSPENSIONS, 'suspension')]]);
  const files: TrustSource = {
    policy: () => w.policy,
    didState: (did) => w.didState.states[did],
    list: (id) => { const found = lists.get(id); return found === undefined ? undefined : { credential: found.credential, fetchedAt: NOW }; },
    roles: (did) => (did === w.officer.did ? [role.credential] : [])
  };
  const source = new HubTrustSource({
    policy: () => w.policy,
    hub: () => (options.hub === false ? undefined : hub),
    ...(options.files === true ? {} : { roles: (did: string) => (did === w.officer.did ? [role.credential] : []) }),
    now: () => clock.now,
    ...(options.files === true ? { files } : {})
  });
  return { w, role, hub, clock, source, secret };
}

async function walletWith(s: Setup, ...credentials: Issued[]): Promise<{ wallet: Wallet; secrets: MemorySecrets }> {
  const secrets = new MemorySecrets();
  await secrets.store(WALLET_SECRET_KEY, JSON.stringify(credentials.map((item) => item.credential)));
  return { wallet: new Wallet(secrets, s.source, () => s.clock.now, s.w.member.did), secrets };
}

/** The DIDs a wallet of the member's credential needs: its issuer and its holder (the root is always fetched). */
const dids = (s: Setup): string[] => [s.w.officer.did, s.w.member.did];

const putList = (s: Setup, signed: SignedList): void => { s.hub.lists.set(nameOf(signed.id), JSON.stringify(signed.credential)); };

test('HubTrustSource fetches each list and log over the hub connection, keeps only what verifies, and the wallet checks fresh from them', async () => {
  const s = await setup();
  const { wallet } = await walletWith(s, s.secret);
  assert.equal(walletStateAt(await wallet.load(), NOW), 'unavailable', 'nothing fetched yet is unavailable, never fresh');
  assert.equal(await s.source.refresh(dids(s)), 'refreshed');
  assert.equal(s.source.list(REVOCATIONS)?.fetchedAt, NOW);
  assert.ok(s.source.didState(s.w.officer.did) !== undefined, 'the issuer\'s log was fetched and verified');
  const view = await wallet.load();
  assert.equal(walletStateAt(view, NOW), 'fresh');
  assert.deepEqual(view.clearances.map((entry) => `${entry.scale}/${entry.level}`), ['ca-classified/Secret']);

  // A list signed by another key, and a log that does not verify, are never kept: the last verified copies stay.
  const held = s.source.list(REVOCATIONS)?.credential;
  const forged = await list(s.w.suspensionKey, REVOCATIONS, 'revocation', [s.secret.revocationIndex], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  putList(s, forged);
  s.hub.logs.set(didHostPath(s.w.officer.did) as string, `${s.w.officer.log.slice(0, -10)}tampered\n`);
  s.clock.now = NOW + 60_000;
  assert.equal(await s.source.refresh(dids(s)), 'kept');
  assert.deepEqual(s.source.list(REVOCATIONS)?.credential, held, 'the forged list was not taken');
  assert.equal(s.source.list(REVOCATIONS)?.fetchedAt, NOW, 'a refused copy does not count as a fresh fetch');
  assert.ok(s.source.didState(s.w.officer.did) !== undefined, 'the verified log is kept');
});

test('a newer list that revokes replaces the held one, an older or equal copy never does, and the wallet drops the revoked credential', async () => {
  const s = await setup();
  const { wallet } = await walletWith(s, s.secret);
  await s.source.refresh(dids(s));
  assert.equal((await wallet.load()).entries.length, 1);
  putList(s, await list(s.w.revocationKey, REVOCATIONS, 'revocation', [s.secret.revocationIndex], { version: 2, validFrom: '2026-11-20T06:00:00Z' }));
  s.clock.now = NOW + 60_000;
  assert.equal(await s.source.refresh(dids(s)), 'refreshed');
  const view = await wallet.load();
  assert.equal(view.entries.length, 0, 'the revoked credential is no longer relied on');
  // The hub answering an older copy again does not roll the list back.
  putList(s, await list(s.w.revocationKey, REVOCATIONS, 'revocation', [], { version: 1 }));
  await s.source.refresh(dids(s));
  assert.equal((await wallet.load()).entries.length, 0);
});

test('a fetch failure keeps the last verified copies; the source is unavailable only when no copy covers the need', async () => {
  const empty = await setup();
  empty.hub.down = true;
  const first = await walletWith(empty, empty.secret);
  assert.equal(await empty.source.refresh(dids(empty)), 'unavailable');
  assert.equal(walletStateAt(await first.wallet.load(), NOW), 'unavailable', 'no copy held: unavailable');

  const s = await setup();
  const { wallet } = await walletWith(s, s.secret);
  await s.source.refresh(dids(s));
  s.hub.down = true;
  s.clock.now = NOW + 5 * 60_000;
  assert.equal(await s.source.refresh(dids(s)), 'kept');
  const view = await wallet.load();
  assert.equal(walletStateAt(view, s.clock.now), 'fresh', 'the copies fetched five minutes ago still cover the need');
  assert.equal(walletStateAt(view, NOW + TTL_MS), 'stale', 'once past the time to live without a fetch, the view is stale');
});

test('the wallet refreshes in the background at the time to live, and a gate decision during a refresh never waits on the network', async () => {
  const s = await setup();
  const { wallet } = await walletWith(s, s.secret);
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = [];
  const fake = {
    setTimeout: (run: () => void, ms: number): unknown => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (handle: unknown): void => { (handle as { cleared: boolean }).cleared = true; }
  };
  const running = wallet.keepFresh(s.source, fake);
  await running.settled();
  assert.equal(walletStateAt(wallet.verifiedView(), NOW), 'fresh', 'the first refresh ran at once');
  const next = timers.filter((timer) => !timer.cleared).at(-1);
  assert.ok(next !== undefined && next.ms > 0 && next.ms <= TTL_MS, `the next refresh is due within the time to live (${String(next?.ms)} ms)`);

  // The hub stops answering: a refresh starts and never ends.
  s.hub.hang = true;
  s.clock.now = NOW + TTL_MS - 1000;
  const callsBefore = s.hub.calls;
  next.run();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(s.hub.calls > callsBefore, 'the refresh asked the hub');
  const calls = s.hub.calls;
  next.run();
  await new Promise((resolve) => setImmediate(resolve));
  const decided = clearancesInForce(undefined, { credentials: s.w.section } as never, { state: walletStateAt(wallet.verifiedView(), s.clock.now), clearances: wallet.verifiedView().clearances });
  assert.equal(decided.source, 'credentials');
  assert.deepEqual(decided.clearances.map((entry) => entry.level), ['Secret'], 'the decision used the last verified view, at once');
  assert.equal(s.hub.calls, calls, 'a second timer while a refresh is in flight starts no second one');
  running.dispose();
  assert.ok(timers.every((timer) => timer.cleared), 'disposing clears every pending timer');
});

test('without a hub configured, the wallet checks against the imported trust files only, and says so', async () => {
  const s = await setup({ hub: false, files: true });
  const { wallet } = await walletWith(s, s.secret);
  assert.equal(await s.source.refresh(dids(s)), 'files-only');
  assert.equal(s.hub.calls, 0, 'no hub was asked');
  assert.equal(s.source.mode(), 'files');
  assert.equal(s.source.sentence(), HUB_TRUST_TEXT.filesOnly);
  const view = await wallet.load();
  assert.equal(walletStateAt(view, NOW), 'fresh');
  assert.equal(view.entries.length, 1);

  const hosted = await setup();
  await hosted.source.refresh(dids(hosted));
  assert.equal(hosted.source.mode(), 'hub');
  assert.equal(hosted.source.sentence(), undefined);
});

test('refresh is one at a time: calls while a fetch is in flight share it', async () => {
  const s = await setup();
  s.hub.hang = true;
  const one = s.source.refresh(dids(s));
  const two = s.source.refresh(dids(s));
  assert.equal(one, two, 'the same refresh is answered');
  assert.equal(s.hub.calls, 1, 'one fetch is in flight, not two');
});

// The fetch HubTrustSource uses in production: HubTransport's trust routes, over the one pinned connection and its session (no second HTTP client).
test('HubTransport.trustSession reads logs and lists as text over the pinned connection and its session, 404 is nothing, and only trust routes are asked', async () => {
  const sha = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), sha('trust-source/device')]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const signer = { fingerprint: fingerprintOf(raw), publicKey: raw.toString('base64url'), sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
  const project = sha('trust-source/project').toString('hex').slice(0, 32);
  const hub = createHash('sha256').update(sha('trust-source/hub')).digest('hex');
  const s = await setup();
  const listText = s.hub.lists.get('revocation-1') as string;
  const logText = s.w.officer.log;
  const officerPath = didHostPath(s.w.officer.did) as string;
  const posted: string[] = [];
  const fake = await FakeHubServer.start({
    project, hub,
    handle: (req) => {
      if (req.method === 'GET' && req.path === '/v1/trust/status/revocation-1') return { bytes: Buffer.from(listText), headers: { 'content-type': 'application/json' } };
      if (req.method === 'GET' && req.path === `/v1/trust/did/${officerPath}/did.jsonl`) return { bytes: Buffer.from(logText), headers: { 'content-type': 'text/jsonl' } };
      if (req.method === 'POST' && req.path === `/v1/trust/did/${officerPath}/did.jsonl`) { posted.push(req.body.toString('utf8')); return { status: 201, json: { stored: true } }; }
      return { status: 404, json: { error: 'not-found' } };
    }
  });
  const transport = new HubTransport({ address: fake.address, project, hub, trust: { pin: certPinOf(FIXTURE_CERT) }, signer, servername: 'localhost', now: () => new Date(NOW) });
  try {
    const session = transport.trustSession();
    assert.equal(await session.getList('revocation-1'), listText);
    assert.equal(await session.getLog(officerPath), logText);
    assert.equal(await session.getList('suspension-1'), undefined, 'a 404 is nothing held');
    assert.deepEqual(await session.postLog(officerPath, logText), { status: 201 });
    assert.deepEqual(posted, [logText]);
    await assert.rejects(() => transport.trustText('/v1/projects/x/heads'), /trust routes/);
    await assert.rejects(() => session.getLog('../escape'), /trust routes/);
    assert.equal(fake.connections, 1, 'every call went over the one pinned connection');
    assert.ok(fake.calls().every((call) => call.tokenOf === call.connection), 'every call carried the session token of its own connection');

    // The trust source on top of it verifies what the transport fetched.
    const source = new HubTrustSource({ policy: () => s.w.policy, hub: () => session, now: () => NOW });
    assert.equal(await source.refresh([s.w.officer.did]), 'unavailable', 'the suspension list is not on this hub, so no copy covers the need');
    assert.ok(source.list(REVOCATIONS) !== undefined);
    assert.ok(source.didState(s.w.officer.did) !== undefined);
  } finally {
    transport.close();
    await fake.close();
  }
});
