import assert from 'node:assert/strict';
import test from 'node:test';
import { list } from '@ext/test/helpers/credentialWorld';
import { MAX_LOG_BYTES, MAX_STATUS_LIST_BYTES } from '../src/store/trustStore';
import type { HubConnection, HubResponse } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, OpenedSession } from './helpers/hubHarness';
import { createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { REVOCATIONS, REVOCATION_ROUTE, SUSPENSIONS, SUSPENSION_ROUTE, TRUST_NOW, makeTrustWorld, personLog } from './helpers/trustWorld';
import type { TrustWorld } from './helpers/trustWorld';

// Phase 71, plan 09, task 1 (D-14, D-16, DCAC-06): the hub hosts your organization's did:webvh logs and signed status lists for staff members of
// the site only. A log is stored only when the whole log verifies and grows the one held; a list only when signed by the key the policy names and
// exactly one version above the one held (compare-and-swap). Observers and guests are refused every trust route. Without your organization's rules
// the trust routes answer 503 and the projects keep syncing. All names, DIDs and keys are fictional and made at run time.

const ALEX_LOG = '/v1/trust/did/people/alex/did.jsonl';

interface Site {
  hub: Hub;
  world: HubWorld;
  trust: TrustWorld;
  staff: OpenedSession;
  member: WorldDevice;
  observer: WorldDevice;
}

async function site(hub: Hub, trust: TrustWorld): Promise<Site> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-SAM', 'mbr-sam');
  world.admitMember(member);
  const observer = world.device('OBSERVER-KIM', 'mbr-kim');
  world.admitMember(observer, { roles: ['observer'] });
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return { hub, world, trust, staff: await hub.openSession(world.lead, world.project), member, observer };
}

const withSite = (body: (site: Site) => Promise<void>, options: { organization?: boolean } = {}) => async (): Promise<void> => {
  const trust = await makeTrustWorld();
  await withHub({ now: TRUST_NOW, ...(options.organization === false ? {} : { organization: trust.organization }) }, async (hub) => body(await site(hub, trust)));
};

const postText = (connection: HubConnection, target: string, text: string, token: string): Promise<HubResponse> =>
  connection.call('POST', target, { bytes: Buffer.from(text, 'utf8'), token });
const putJson = (connection: HubConnection, target: string, value: unknown, token: string): Promise<HubResponse> =>
  connection.call('PUT', target, { bytes: Buffer.from(JSON.stringify(value), 'utf8'), token });

const errorOf = (response: HubResponse): string => response.json<{ error: string }>().error;

test('tracer: a staff member posts Alex\'s genesis log, reads it back byte for byte, and an extension by the committed key is stored', withSite(async ({ staff }) => {
  const alex = await personLog(['people', 'alex']);
  const first = await postText(staff.connection, ALEX_LOG, alex.log, staff.token);
  assert.equal(first.status, 201, first.text);
  const read = await staff.connection.get(ALEX_LOG, staff.token);
  assert.equal(read.status, 200);
  assert.equal(read.text, alex.log);
  assert.match(String(read.headers['content-type']), /^text\/jsonl/);

  const extended = await alex.extend();
  const second = await postText(staff.connection, ALEX_LOG, extended, staff.token);
  assert.equal(second.status, 201, second.text);
  assert.equal((await staff.connection.get(ALEX_LOG, staff.token)).text, extended);
  const again = await postText(staff.connection, ALEX_LOG, extended, staff.token);
  assert.equal(again.status, 200, 'the same log again is held, not stored twice');
  assert.deepEqual(again.json(), { stored: false });
}));

test('a broken chain, a wrong SCID and an update by a key outside nextKeyHashes are refused 422 and the held log does not change', withSite(async ({ staff }) => {
  const alex = await personLog(['people', 'alex']);
  assert.equal((await postText(staff.connection, ALEX_LOG, alex.log, staff.token)).status, 201);
  const extended = await alex.extend();
  const lines = extended.split('\n');
  const tampered = `${lines[0]}\n${(lines[1] as string).replace('2026-11-10T00:00:00Z', '2026-11-11T00:00:00Z')}\n`;
  const broken = await postText(staff.connection, ALEX_LOG, tampered, staff.token);
  assert.equal(broken.status, 422, broken.text);

  const impostor = await personLog(['people', 'alex']);
  const wrongScid = await postText(staff.connection, ALEX_LOG, impostor.log, staff.token);
  assert.equal(wrongScid.status, 422);
  assert.equal(errorOf(wrongScid), 'wrong-scid');

  const hijack = await alex.extend(alex.issuing);
  const outside = await postText(staff.connection, ALEX_LOG, hijack, staff.token);
  assert.equal(outside.status, 422);
  assert.equal(errorOf(outside), 'pre-rotation');
  assert.equal((await staff.connection.get(ALEX_LOG, staff.token)).text, alex.log, 'nothing changed');
}));

test('a log is stored only at its own DID\'s path; an unknown log is 404 and no route deletes one', withSite(async ({ staff }) => {
  const kim = await personLog(['people', 'kim']);
  const elsewhere = await postText(staff.connection, ALEX_LOG, kim.log, staff.token);
  assert.equal(elsewhere.status, 422);
  assert.equal(errorOf(elsewhere), 'wrong-path');
  assert.equal((await staff.connection.get(ALEX_LOG, staff.token)).status, 404);
  assert.equal((await postText(staff.connection, '/v1/trust/did/people/kim/did.jsonl', kim.log, staff.token)).status, 201);
  const removal = await staff.connection.call('DELETE', '/v1/trust/did/people/kim/did.jsonl', { token: staff.token });
  assert.equal(removal.status, 405);
  assert.equal((await staff.connection.call('DELETE', REVOCATION_ROUTE, { token: staff.token })).status, 405);
  assert.equal((await staff.connection.get('/v1/trust/did/people/kim/did.jsonl', staff.token)).text, kim.log);
}));

test('a status list at version 1 is stored and served; version 3 is refused 409; version 2 then follows', withSite(async ({ staff, trust }) => {
  const key = trust.world.revocationKey;
  const v1 = await list(key, REVOCATIONS, 'revocation', [], { version: 1, validFrom: '2026-11-20T00:00:00Z' });
  const stored = await putJson(staff.connection, REVOCATION_ROUTE, v1.credential, staff.token);
  assert.equal(stored.status, 201, stored.text);
  const read = await staff.connection.get(REVOCATION_ROUTE, staff.token);
  assert.equal(read.status, 200);
  assert.deepEqual(read.json(), v1.credential);

  const v3 = await list(key, REVOCATIONS, 'revocation', [7], { version: 3, validFrom: '2026-11-22T00:00:00Z' });
  const skipped = await putJson(staff.connection, REVOCATION_ROUTE, v3.credential, staff.token);
  assert.equal(skipped.status, 409);
  assert.equal(errorOf(skipped), 'version-conflict');
  const v2 = await list(key, REVOCATIONS, 'revocation', [7], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  assert.equal((await putJson(staff.connection, REVOCATION_ROUTE, v2.credential, staff.token)).status, 201);
  assert.deepEqual((await staff.connection.get(REVOCATION_ROUTE, staff.token)).json(), v2.credential);
}));

test('a list signed by any key other than the policy\'s status-list key is refused 422, and nothing changes', withSite(async ({ staff, trust }) => {
  const forged = await list(trust.world.suspensionKey, REVOCATIONS, 'revocation', [], { version: 1 });
  const refused = await putJson(staff.connection, REVOCATION_ROUTE, forged.credential, staff.token);
  assert.equal(refused.status, 422);
  assert.equal(errorOf(refused), 'status-list-signer');
  const officerSigned = await list(trust.world.officer.issuing, REVOCATIONS, 'revocation', [], { version: 1 });
  assert.equal((await putJson(staff.connection, REVOCATION_ROUTE, officerSigned.credential, staff.token)).status, 422);
  assert.equal((await staff.connection.get(REVOCATION_ROUTE, staff.token)).status, 404, 'no list is held');
  const wrongPlace = await list(trust.world.revocationKey, REVOCATIONS, 'revocation', [], { version: 1 });
  const atSuspensions = await putJson(staff.connection, SUSPENSION_ROUTE, wrongPlace.credential, staff.token);
  assert.equal(atSuspensions.status, 422, 'a list put at another list\'s address is refused');
}));

test('two concurrent version-2 puts store exactly one; the other is refused 409', withSite(async ({ hub, staff, world, trust }) => {
  const key = trust.world.revocationKey;
  assert.equal((await putJson(staff.connection, REVOCATION_ROUTE, (await list(key, REVOCATIONS, 'revocation', [], { version: 1 })).credential, staff.token)).status, 201);
  const a = await list(key, REVOCATIONS, 'revocation', [11], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  const b = await list(key, REVOCATIONS, 'revocation', [12], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  const other = await hub.openSession(world.lead, world.project);
  const answers = await Promise.all([putJson(staff.connection, REVOCATION_ROUTE, a.credential, staff.token), putJson(other.connection, REVOCATION_ROUTE, b.credential, other.token)]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409]);
  const winner = answers[0]?.status === 201 ? a : b;
  assert.deepEqual((await staff.connection.get(REVOCATION_ROUTE, staff.token)).json(), winner.credential);
  assert.equal(hub.trust.newestList(REVOCATIONS)?.version, 2);
}));

test('a newer revocation list that clears a revoked bit is refused; a newer suspension list may clear one', withSite(async ({ staff, trust }) => {
  const revoked = await list(trust.world.revocationKey, REVOCATIONS, 'revocation', [5], { version: 1 });
  assert.equal((await putJson(staff.connection, REVOCATION_ROUTE, revoked.credential, staff.token)).status, 201);
  const cleared = await list(trust.world.revocationKey, REVOCATIONS, 'revocation', [], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  const refused = await putJson(staff.connection, REVOCATION_ROUTE, cleared.credential, staff.token);
  assert.equal(refused.status, 422);
  assert.equal(errorOf(refused), 'revocation-cleared');

  const suspended = await list(trust.world.suspensionKey, SUSPENSIONS, 'suspension', [5], { version: 1 });
  assert.equal((await putJson(staff.connection, SUSPENSION_ROUTE, suspended.credential, staff.token)).status, 201);
  const lifted = await list(trust.world.suspensionKey, SUSPENSIONS, 'suspension', [], { version: 2, validFrom: '2026-11-21T00:00:00Z' });
  assert.equal((await putJson(staff.connection, SUSPENSION_ROUTE, lifted.credential, staff.token)).status, 201);
}));

test('an unauthenticated call is refused 401 on logs and lists alike', withSite(async ({ hub }) => {
  const connection = await hub.connect();
  for (const target of [ALEX_LOG, REVOCATION_ROUTE]) {
    const answer = await connection.get(target);
    assert.equal(answer.status, 401, target);
  }
  const post = await connection.call('POST', ALEX_LOG, { bytes: Buffer.from('{}') });
  assert.equal(post.status, 401);
}));

test('logs and lists over the size limits are refused 413 before their bodies are read', withSite(async ({ staff }) => {
  const bigLog = await staff.connection.call('POST', ALEX_LOG, { declaredLength: MAX_LOG_BYTES + 1, token: staff.token });
  assert.equal(bigLog.status, 413);
}));

test('a status list over its size limit is refused 413', withSite(async ({ hub, world }) => {
  const session = await hub.openSession(world.lead, world.project);
  const bigList = await session.connection.call('PUT', REVOCATION_ROUTE, { declaredLength: MAX_STATUS_LIST_BYTES + 1, token: session.token });
  assert.equal(bigList.status, 413);
}));

test('an observer\'s session is refused 403 on every trust route with a body that names no DID and no key; a staff member is served', withSite(async ({ hub, world, staff, member, observer, trust }) => {
  const alex = await personLog(['people', 'alex']);
  assert.equal((await postText(staff.connection, ALEX_LOG, alex.log, staff.token)).status, 201);
  assert.equal((await putJson(staff.connection, REVOCATION_ROUTE, (await list(trust.world.revocationKey, REVOCATIONS, 'revocation', [], { version: 1 })).credential, staff.token)).status, 201);

  const watching = await hub.openSession(observer, world.project);
  for (const target of [ALEX_LOG, '/v1/trust/did/people/alex/did-witness.json', REVOCATION_ROUTE, SUSPENSION_ROUTE]) {
    const answer = await watching.connection.get(target, watching.token);
    assert.equal(answer.status, 403, target);
    assert.equal(answer.json<{ reason: string }>().reason, 'not-staff');
    assert.ok(!answer.text.includes('did:') && !answer.text.includes(alex.state.scid) && !answer.text.includes('z6Mk'), 'no DID and no key');
  }
  const posting = await postText(watching.connection, ALEX_LOG, alex.log, watching.token);
  assert.equal(posting.status, 403);

  const sam = await hub.openSession(member, world.project);
  assert.equal((await sam.connection.get(ALEX_LOG, sam.token)).text, alex.log);
  assert.equal((await sam.connection.get(REVOCATION_ROUTE, sam.token)).status, 200);
}));

test('without your organization\'s rules the trust routes answer 503 with one sentence, and the project routes keep working', withSite(async ({ staff, world }) => {
  const alex = await personLog(['people', 'alex']);
  for (const answer of [await staff.connection.get(ALEX_LOG, staff.token), await postText(staff.connection, ALEX_LOG, alex.log, staff.token), await staff.connection.get(REVOCATION_ROUTE, staff.token)]) {
    assert.equal(answer.status, 503);
    const body = answer.json<{ error: string; message: string }>();
    assert.equal(body.error, 'no-policy');
    assert.equal(body.message.split('. ').length <= 2 && body.message.endsWith('.'), true);
  }
  const heads = await staff.connection.get(`/v1/projects/${world.project}/heads`, staff.token);
  assert.equal(heads.status, 200, heads.text);
}, { organization: false }));

test('rules signed by another key, or with no credentials section, leave the trust routes at 503', async () => {
  const trust = await makeTrustWorld();
  const other = await makeTrustWorld();
  await withHub({ now: TRUST_NOW, organization: { text: trust.organization.text, key: (other.organization.key as string).replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } }, async (hub) => {
    const { staff } = await site(hub, trust);
    assert.equal((await staff.connection.get(REVOCATION_ROUTE, staff.token)).status, 503);
  });
  await withHub({ now: TRUST_NOW, organization: { text: '{"not":"rules"}', key: trust.organization.key } }, async (hub) => {
    const { staff } = await site(hub, trust);
    assert.equal((await staff.connection.get(ALEX_LOG, staff.token)).status, 503);
  });
});

test('a list name the policy does not have is 404, and an address outside the trust routes is 404', withSite(async ({ staff }) => {
  assert.equal((await staff.connection.get('/v1/trust/status/revocation-9', staff.token)).status, 404);
  assert.equal((await staff.connection.get('/v1/trust/did/people/../did.jsonl', staff.token)).status, 404);
  assert.equal((await staff.connection.get('/v1/trust/other', staff.token)).status, 404);
}));
