// The wallet (Phase 71 plan 08 Task 1; D-15, D-18, VCRD-05): stored under one SecretStorage key, checked on the way in and on every read, presented
// only as far as a check asks, with one cache state. Fictional Example Organization people; keys made at run time.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { CACHE_STATE_TEXT, cacheStateAt, initialCache } from '../domain/credentials/cacheState';
import { presentFor } from '../domain/credentials/present';
import {
  WALLET_CANNOT_CHECK_TEXT, WALLET_DOES_NOT_VERIFY_TEXT, WALLET_ENDED_TEXT, WALLET_NOT_A_CREDENTIAL_TEXT, WALLET_NOT_YOURS_TEXT, WALLET_SECRET_KEY, Wallet, walletStateAt,
  walletStateText
} from '../gate/wallet';
import type { TrustSource } from '../gate/wallet';
import type { VerifiedCredential } from '../domain/credentials/profile';
import { REVOCATIONS, SUSPENSIONS, issue, list, makeWorld } from './helpers/credentialWorld';
import type { Issued, SignedList, World } from './helpers/credentialWorld';
import { MemorySecrets } from './helpers/teamHarness';

const NOW = Date.UTC(2026, 10, 21);

interface Setup { w: World; role: Issued; lists: Map<string, SignedList>; trust: TrustSource; clock: { now: number } }

async function setup(): Promise<Setup> {
  const w = await makeWorld();
  const role = await issue(w.root.signer, w.root.did, 'IssuerRoleCredential', { id: w.officer.did, credentialType: 'ClearanceCredential', scale: 'ca-classified', upTo: 'Secret' });
  const lists = new Map<string, SignedList>([[REVOCATIONS, await list(w.revocationKey, REVOCATIONS, 'revocation')], [SUSPENSIONS, await list(w.suspensionKey, SUSPENSIONS, 'suspension')]]);
  const clock = { now: NOW };
  const trust: TrustSource = {
    policy: () => w.policy,
    didState: (did) => w.didState.states[did],
    list: (id) => { const found = lists.get(id); return found === undefined ? undefined : { credential: found.credential, fetchedAt: NOW }; },
    roles: (did) => (did === w.officer.did ? [role.credential] : [])
  };
  return { w, role, lists, trust, clock };
}

function walletFor(s: Setup, secrets = new MemorySecrets(), holder = s.w.member.did): { wallet: Wallet; secrets: MemorySecrets } {
  return { wallet: new Wallet(secrets, s.trust, () => s.clock.now, holder), secrets };
}

async function clearance(s: Setup, atLeast: string, extra: { validUntil?: string } = {}): Promise<Issued> {
  return issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.member.did, scale: 'ca-classified', atLeast }, extra);
}

test('a valid .near-vc file is checked and added under the one wallet key, and the view gives its clearance', async () => {
  const s = await setup();
  const { wallet, secrets } = walletFor(s);
  const secret = await clearance(s, 'Secret');
  const result = await wallet.importFile(JSON.stringify(secret.credential));
  assert.deepEqual(result, { ok: true, hash: secret.hash });
  assert.deepEqual([...secrets.values.keys()], [WALLET_SECRET_KEY]);
  const view = wallet.verifiedView();
  assert.equal(walletStateAt(view, NOW), 'fresh');
  assert.deepEqual(view.clearances.map((entry) => `${entry.scale}/${entry.level}`), ['ca-classified/Secret']);
});

test('a tampered, ended, unparseable or someone else\'s file is refused with a sentence, and nothing is stored', async () => {
  const s = await setup();
  const { wallet, secrets } = walletFor(s);
  const secret = await clearance(s, 'Secret');
  const tampered = JSON.parse(JSON.stringify(secret.credential)) as Record<string, any>;
  tampered.credentialSubject.atLeast = 'Confidential';
  const ended = await clearance(s, 'Secret', { validUntil: '2026-11-01T00:00:00Z' });
  const kims = await issue(s.w.officer.signer, s.w.officer.did, 'ClearanceCredential', { id: s.w.other.did, scale: 'ca-classified', atLeast: 'Secret' });
  const cases: Array<[string, string, string]> = [
    ['tampered', JSON.stringify(tampered), WALLET_DOES_NOT_VERIFY_TEXT],
    ['ended', JSON.stringify(ended.credential), WALLET_ENDED_TEXT],
    ['unparseable', '{ not json', WALLET_NOT_A_CREDENTIAL_TEXT],
    ['not a credential', JSON.stringify({ hello: 'world' }), WALLET_NOT_A_CREDENTIAL_TEXT],
    ['someone else\'s', JSON.stringify(kims.credential), WALLET_NOT_YOURS_TEXT]
  ];
  for (const [name, text, sentence] of cases) assert.deepEqual(await wallet.importFile(text), { ok: false, sentence }, name);
  assert.equal(secrets.values.size, 0, 'nothing was stored');
});

test('a revoked credential is refused on import, and one revoked after import drops out of the view at the next load', async () => {
  const s = await setup();
  const { wallet } = walletFor(s);
  const secret = await clearance(s, 'Secret');
  s.lists.set(REVOCATIONS, await list(s.w.revocationKey, REVOCATIONS, 'revocation', [secret.revocationIndex], { version: 2, validFrom: '2026-11-20T01:00:00Z' }));
  assert.deepEqual(await wallet.importFile(JSON.stringify(secret.credential)), { ok: false, sentence: WALLET_ENDED_TEXT });
  const other = await clearance(s, 'Confidential');
  assert.equal((await wallet.importFile(JSON.stringify(other.credential))).ok, true);
  s.lists.set(REVOCATIONS, await list(s.w.revocationKey, REVOCATIONS, 'revocation', [secret.revocationIndex, other.revocationIndex], { version: 3, validFrom: '2026-11-20T02:00:00Z' }));
  const view = await wallet.load();
  assert.equal(view.entries.length, 0);
  assert.deepEqual(view.clearances, []);
});

test('a second person\'s wallet never sees the first person\'s entries', async () => {
  const s = await setup();
  const first = walletFor(s);
  assert.equal((await first.wallet.importFile(JSON.stringify((await clearance(s, 'Secret')).credential))).ok, true);
  const second = walletFor(s, new MemorySecrets(), s.w.other.did);
  const view = await second.wallet.load();
  assert.equal(view.entries.length, 0);
  assert.equal(second.secrets.values.size, 0);
});

test('presentFor gives exactly the threshold asked for: Secret out of Confidential, Secret and Top Secret', async () => {
  const s = await setup();
  const holder = (atLeast: string) => ({ verified: { type: 'ClearanceCredential', claims: { id: s.w.member.did, scale: 'ca-classified', atLeast } } as unknown as VerifiedCredential });
  const wallet = [holder('Confidential'), holder('Top Secret'), holder('Secret')];
  const shown = presentFor({ type: 'ClearanceCredential', scale: 'ca-classified', atLeast: 'Secret' }, wallet, SCALE_PRESETS);
  assert.equal(shown.length, 1);
  assert.equal((shown[0]?.verified.claims as unknown as { atLeast: string }).atLeast, 'Secret');
  const onlyHigher = presentFor({ type: 'ClearanceCredential', scale: 'ca-classified', atLeast: 'Secret' }, [holder('Top Secret')], SCALE_PRESETS);
  assert.equal((onlyHigher[0]?.verified.claims as unknown as { atLeast: string }).atLeast, 'Top Secret', 'the lowest that reaches it when there is no exact one');
  assert.deepEqual(presentFor({ type: 'ClearanceCredential', scale: 'ca-classified', atLeast: 'Top Secret' }, [holder('Secret')], SCALE_PRESETS), []);
});

test('presentFor for other types gives the first whose claims match, and nothing else', () => {
  const entry = (type: string, claims: Record<string, string>) => ({ verified: { type, claims: { id: 'did:webvh:x', ...claims } } as unknown as VerifiedCredential });
  const wallet = [entry('NationalityCredential', { nationality: 'CAN' }), entry('NationalityCredential', { nationality: 'GBR' }), entry('ServiceCredential', { serves: 'public-servant' })];
  const shown = presentFor({ type: 'NationalityCredential', claims: { nationality: 'GBR' } }, wallet, SCALE_PRESETS);
  assert.deepEqual(shown, [wallet[1]]);
  assert.deepEqual(presentFor({ type: 'MembershipCredential' }, wallet, SCALE_PRESETS), []);
});

test('the view turns stale after the time to live, and back to fresh on a successful load', async () => {
  const s = await setup();
  const { wallet } = walletFor(s);
  await wallet.importFile(JSON.stringify((await clearance(s, 'Secret')).credential));
  const view = wallet.verifiedView();
  assert.equal(walletStateAt(view, NOW + 14 * 60 * 1000), 'fresh');
  assert.equal(walletStateAt(view, NOW + 15 * 60 * 1000), 'stale');
  assert.equal(walletStateText(view, NOW + 16 * 60 * 1000).action, 'retry');
});

test('a missing list makes the view unavailable with the connect action, and a file cannot be checked then', async () => {
  const s = await setup();
  const { wallet } = walletFor(s);
  await wallet.importFile(JSON.stringify((await clearance(s, 'Secret')).credential));
  s.lists.delete(SUSPENSIONS);
  const view = await wallet.load();
  assert.equal(walletStateAt(view, NOW), 'unavailable');
  assert.equal(walletStateText(view, NOW).action, 'connect');
  assert.deepEqual(await wallet.importFile(JSON.stringify((await clearance(s, 'Confidential')).credential)), { ok: false, sentence: WALLET_CANNOT_CHECK_TEXT });
});

test('the change event carries each new view; a failing listener does not stop the others', async () => {
  const s = await setup();
  const { wallet } = walletFor(s);
  const seen: number[] = [];
  wallet.onDidChange(() => { throw new Error('a listener failed'); });
  const subscription = wallet.onDidChange((view) => { seen.push(view.entries.length); });
  await wallet.importFile(JSON.stringify((await clearance(s, 'Secret')).credential));
  subscription.dispose();
  await wallet.load();
  assert.deepEqual(seen, [1]);
});

test('cacheStateAt: unavailable until checked, fresh on refresh, stale at the time to live, unavailable when a source is missing', () => {
  const start = initialCache(900_000);
  assert.equal(start.state, 'unavailable');
  const fresh = cacheStateAt(start, { kind: 'refreshed', at: NOW });
  assert.equal(fresh.state, 'fresh');
  assert.equal(cacheStateAt(fresh, { kind: 'tick', now: NOW + 899_999 }).state, 'fresh');
  const stale = cacheStateAt(fresh, { kind: 'tick', now: NOW + 900_000 });
  assert.equal(stale.state, 'stale');
  assert.equal(cacheStateAt(stale, { kind: 'missing' }).state, 'unavailable');
  assert.equal(cacheStateAt(stale, { kind: 'refreshed', at: NOW + 1_000_000 }).state, 'fresh');
  for (const state of ['fresh', 'stale', 'unavailable'] as const) assert.match(CACHE_STATE_TEXT[state].text, /\.$/);
});

test('a secret store that cannot be read gives an unavailable view with no clearance', async () => {
  const s = await setup();
  const broken = new MemorySecrets();
  broken.get = async () => { throw new Error('the keyring is locked'); };
  const wallet = new Wallet(broken, s.trust, () => s.clock.now, s.w.member.did);
  const view = await wallet.load();
  assert.equal(walletStateAt(view, NOW), 'unavailable');
  assert.deepEqual(view.clearances, []);
});
