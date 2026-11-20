import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { SealedEntry } from '@ext/domain/replica/entry';
import { buildHubJoin, buildInvite, buildJoinRequest, checkHubJoinMac, checkJoinRequest, hubJoinCheckKey, hubJoinMac, joinRequestHash, joinSecretHash, newJoinSecret, readHubJoin } from '@ext/domain/replica/invite';
import type { InvitePayload, JoinRequestPayload } from '@ext/domain/replica/invite';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { HubTransport, HubTransportError } from '@ext/staff/replica/hubTransport';
import { JoinDesk } from '../src/join';
import type { JoinChecks } from '../src/join';
import type { HubConnection } from './helpers/hubClient';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { DEMO_CLEARANCE, HUB_ADDRESS, INVITE_EXPIRES, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';
import { EventClient, ManualScheduler } from './helpers/sseReader';

// Phase 32, plan 25 (D-37, D-39, D-47, D-48, D-58, D-60): join requests through your organization's hub. The lead's device registers an invitation
// with the hub over its session, sending only the check key derived from the join secret; a joining device posts its signed join request with a hub
// MAC under that key; the hub checks it, keeps it for 7 days and tells the lead's and deputy's devices at once. The lead's device still checks the
// Phase 31 MAC with the real secret before anyone is admitted. Every invitation state on the hub has a test. All names and data are fictional.

const DAY_MS = 24 * 60 * 60 * 1000;
let inviteCount = 0;

interface Team {
  world: HubWorld;
  member: WorldDevice;
  deputy?: WorldDevice;
}

/** The world's project with the hub admitted, a member, and (when asked) a deputy lead, enrolled over HTTPS. */
async function team(hub: Hub, options: { deputy?: boolean; label?: string } = {}): Promise<Team> {
  const world = createHubWorld(options.label === undefined ? {} : { projectLabel: options.label });
  world.admitHub(hub.identity);
  const member = world.device('MEMBER-B', 'mbr-b');
  world.admitMember(member);
  let deputy: WorldDevice | undefined;
  if (options.deputy === true) {
    deputy = world.device('DEPUTY-D', 'mbr-deputy');
    world.admitMember(deputy);
    world.rosterEntry(world.lead, 'deputy.name', { member: deputy.member });
  }
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return deputy === undefined ? { world, member } : { world, member, deputy };
}

function transportFor(hub: Hub, world: HubWorld, device: WorldDevice): HubTransport {
  return new HubTransport({
    address: `127.0.0.1:${hub.port}`,
    project: world.project,
    hub: hub.identity.writer,
    trust: { pin: hub.identity.certPin },
    signer: device.signer,
    now: () => new Date(hub.now()),
  });
}

interface Invitation {
  payload: InvitePayload;
  secret: string;
  checkKey: string;
}

/** An invitation the lead's device makes for a project on the hub: a fresh join secret and the invitation's hub field. */
function invitation(hub: Hub, world: HubWorld, options: { expiresAt?: string; invite?: string } = {}): Invitation {
  inviteCount += 1;
  const secret = newJoinSecret();
  const invite = options.invite ?? `inv-hub-${inviteCount}`;
  const signed = buildInvite(world.lead.signer, {
    genesisHash: world.genesisHash,
    project: world.project,
    name: 'Exercise Northwind',
    lead: { member: world.lead.member, x25519: world.lead.x25519, publicKey: world.lead.publicKey },
    invite,
    secret,
    expiresAt: options.expiresAt ?? new Date(hub.now() + 7 * DAY_MS).toISOString(),
    now: new Date(hub.now()),
    hub: { address: HUB_ADDRESS, certPin: hub.identity.certPin, writer: hub.identity.writer },
  });
  return { payload: signed.payload, secret, checkKey: hubJoinCheckKey(secret, invite) };
}

interface JoinPost {
  join: unknown;
  request: SignedPayload<JoinRequestPayload>;
}

/** The joining device's post, made as the client makes it: a join request from the invitation, the hub MAC under the check key, the envelope. */
function joinPost(hub: Hub, invite: Invitation, joiner: WorldDevice, options: { hub?: string; project?: string; checkKey?: string; tamperMac?: boolean } = {}): JoinPost {
  const request = buildJoinRequest(joiner.signer, invite.payload, { name: `Person ${joiner.label}`, x25519: joiner.x25519, now: new Date(hub.now()) });
  const fields = { hub: options.hub ?? hub.identity.writer, project: options.project ?? invite.payload.project, invite: invite.payload.invite, request: joinRequestHash(request) };
  let hubMac = hubJoinMac(options.checkKey ?? invite.checkKey, fields);
  if (options.tamperMac === true) {
    const bytes = Buffer.from(hubMac, 'base64url');
    bytes[0] = (bytes[0] as number) ^ 1;
    hubMac = bytes.toString('base64url');
  }
  const join = buildHubJoin(joiner.signer, { hub: fields.hub, project: fields.project, request, hubMac, now: new Date(hub.now()) });
  return { join, request };
}

async function register(hub: Hub, world: HubWorld, device: WorldDevice, invite: Invitation): Promise<void> {
  const transport = transportFor(hub, world, device);
  try {
    await transport.registerInvite({ invite: invite.payload.invite, expiresAt: invite.payload.expiresAt, checkKey: invite.checkKey });
  } finally {
    transport.close();
  }
}

/** POST /v1/join on a fresh connection with no session, as any address may. */
async function postRaw(hub: Hub, body: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string; headers: Record<string, unknown> }> {
  const connection = await hub.connect();
  try {
    const answer = await connection.post('/v1/join', body);
    return { status: answer.status, json: answer.text === '' ? {} : answer.json(), text: answer.text, headers: answer.headers };
  } finally {
    connection.close();
  }
}

/** Every file of the hub's state directory, read as bytes (the database, its WAL and blobs). */
function stateBytes(hub: Hub): Buffer {
  const parts: Buffer[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else parts.push(readFileSync(full));
    }
  };
  walk(hub.dir);
  return Buffer.concat(parts);
}

const withJoinHub = (options: StartOptions, body: (hub: Hub, scheduler: ManualScheduler) => Promise<void>): Promise<void> => {
  const scheduler = new ManualScheduler();
  return withHub({ checkpoints: false, ...options, scheduler }, async (hub) => {
    scheduler.onAdvance = (ms) => hub.advance(ms);
    await body(hub, scheduler);
  });
};

// ---- Task 1: the tracer -------------------------------------------------------------------------------------------------------------------------

test('tracer: the lead registers an invitation, a new device posts its join request through the hub, and the hub accepts it', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const post = joinPost(hub, invite, joiner);
    const transport = transportFor(hub, world, joiner);
    try {
      const answer = await transport.postJoin(post);
      assert.deepEqual(answer, { project: world.project, invite: invite.payload.invite, held: false });
    } finally {
      transport.close();
    }
  }));

test('tracer: the lead hears one join-request event, a member hears none, and the lead lists the request, which the real secret accepts', () =>
  withJoinHub({}, async (hub) => {
    const { world, member } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const leadReader = await EventClient.open(hub, world.lead, world.project);
    const leadStream = await leadReader.events();
    const memberReader = await EventClient.open(hub, member, world.project);
    const memberStream = await memberReader.events();
    await leadStream.until((item) => item.retries.length === 1, 'the lead stream open');
    await memberStream.until((item) => item.retries.length === 1, 'the member stream open');

    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const post = joinPost(hub, invite, joiner);
    assert.equal((await postRaw(hub, post)).status, 202);

    const frame = await leadStream.frame(1);
    assert.deepEqual(frame, { event: 'join-request', id: '1', data: { project: world.project, invite: invite.payload.invite } });
    // A presence-free, append-free world: anything the member hears would be a frame now. A second join post from another device reaches the
    // lead too, so the member's stream has had time to see the first.
    const second = joinPost(hub, invite, world.device('JOINER-K', 'mbr-joiner-k'));
    assert.equal((await postRaw(hub, second)).status, 202);
    await leadStream.frame(2);
    assert.equal(memberStream.frames.length, 0, 'a member hears no join request');

    const lead = transportFor(hub, world, world.lead);
    try {
      const pending = await lead.joinRequests();
      assert.equal(pending.length, 2);
      const first = pending.find((item) => JSON.parse(item.request).payload.publicKey === joiner.publicKey);
      assert.ok(first !== undefined, 'the first request is listed');
      assert.equal(first.invite, invite.payload.invite);
      const checked = checkJoinRequest(first.request, { invite: invite.payload, secret: invite.secret, now: new Date(hub.now()) });
      assert.equal(checked.ok, true, checked.ok ? '' : checked.reason);
    } finally {
      lead.close();
      leadReader.close();
      memberReader.close();
    }
  }));

test('tracer: the hub keeps the check key and the request, never the join secret (byte search of the state directory)', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    assert.equal((await postRaw(hub, post)).status, 202);
    const record = hub.store.invite(world.project, invite.payload.invite);
    assert.equal(record?.checkKey, invite.checkKey, 'the check key is kept');
    assert.equal(hub.store.joinRequests(world.project).length, 1, 'the request is kept');
    hub.store.durability();
    const bytes = stateBytes(hub);
    const secretBytes = Buffer.from(invite.secret, 'base64url');
    for (const form of [invite.secret, secretBytes.toString('hex'), secretBytes.toString('base64')]) {
      assert.equal(bytes.includes(Buffer.from(form, 'utf8')), false, 'no form of the join secret is on the hub');
    }
    assert.equal(bytes.includes(secretBytes), false, 'nor its raw bytes');
  }));

test('tracer: a post the client builds passes the hub\'s own check, and the same post with one byte of the hub MAC changed is refused wrong-secret and counted', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const post = joinPost(hub, invite, joiner);
    const read = readHubJoin(post.join, post.request);
    assert.ok(read.ok, 'readHubJoin reads the client envelope');
    assert.equal(checkHubJoinMac(invite.checkKey, { hub: hub.identity.writer, project: world.project, invite: invite.payload.invite, request: read.join.request }, read.join.hubMac), true);

    const tampered = joinPost(hub, invite, joiner, { tamperMac: true });
    const refused = await postRaw(hub, tampered);
    assert.equal(refused.status, 403);
    assert.equal(refused.json.error, 'wrong-secret');
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 1, 'the failure is counted');
    assert.equal(hub.store.joinRequests(world.project).length, 0, 'nothing is kept');

    const transport = transportFor(hub, world, joiner);
    try {
      await assert.rejects(transport.postJoin(tampered), (error: unknown) => error instanceof HubTransportError && error.failure === 'hub-error' && error.reason === 'wrong-secret');
    } finally {
      transport.close();
    }
  }));

// ---- Task 2: every invitation state on the hub, the lock, who may read, and the 7 day removal ---------------------------------------------------

/** Counts every call of the two checks that cost a signature or a MAC. */
function countingChecks(): { checks: JoinChecks; counts: { read: number; mac: number } } {
  const counts = { read: 0, mac: 0 };
  return {
    counts,
    checks: {
      readHubJoin: (join, request) => {
        counts.read += 1;
        return readHubJoin(join, request);
      },
      checkHubJoinMac: (key, fields, mac) => {
        counts.mac += 1;
        return checkHubJoinMac(key, fields, mac);
      },
    },
  };
}

/** Sends roster entries (and their grants) the lead's device wrote after enrolment to the hub. */
async function pushRoster(hub: Hub, world: HubWorld, written: ReadonlyArray<{ entry: SealedEntry }>, grants: readonly unknown[] = []): Promise<void> {
  const transport = transportFor(hub, world, world.lead);
  try {
    const answer = await transport.append({ entries: written.map((item) => item.entry), grants });
    assert.equal(answer.accepted.length, written.length, JSON.stringify(answer.refused));
  } finally {
    transport.close();
  }
}

/** A refusal answer: its status and id, and that it names nothing from the request (the joiner's name and keys, the MAC). */
function assertRefused(answer: { status: number; json: Record<string, unknown>; text: string }, status: number, error: string, post?: JoinPost): void {
  assert.equal(answer.status, status, answer.text);
  assert.equal(answer.json.error, error);
  assert.deepEqual(Object.keys(answer.json).sort(), ['error', 'message']);
  if (post !== undefined) {
    const request = post.request.payload;
    for (const value of [request.name, request.publicKey, request.x25519, request.mac, request.nonce]) assert.equal(answer.text.includes(value), false, 'nothing from the request is echoed');
  }
}

/** A session token of a device, on a connection of its own, for raw calls. */
async function rawSession(hub: Hub, device: WorldDevice, project: string): Promise<{ connection: HubConnection; token: string }> {
  const opened = await hub.openSession(device, project);
  return { connection: opened.connection, token: opened.token };
}

test('unknown: a post for an invitation the hub never registered is refused unknown-invite, and nothing from the request is echoed', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    assertRefused(await postRaw(hub, post), 404, 'unknown-invite', post);
    assert.equal(hub.store.joinRequests(world.project).length, 0);
  }));

test('unknown: a post naming a project this hub does not hold is refused unknown-invite before any signature is checked', () => {
  const { checks, counts } = countingChecks();
  return withJoinHub({ joinChecks: checks }, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const other = createHubWorld({ projectLabel: 'other-exercise' });
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'), { project: other.project });
    assertRefused(await postRaw(hub, post), 404, 'unknown-invite', post);
    assert.deepEqual(counts, { read: 0, mac: 0 });
  });
});

test('expired: once the hub\'s clock passes the invitation\'s expiry a correct post is refused invite-expired and no failure is counted', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world, { expiresAt: new Date(hub.now() + DAY_MS).toISOString() });
    await register(hub, world, world.lead, invite);
    hub.advance(DAY_MS + 1);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    assertRefused(await postRaw(hub, post), 403, 'invite-expired', post);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 0);
  }));

test('expired: an invitation registered with an expiry already past is refused invite-expired and nothing is kept', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const session = await rawSession(hub, world.lead, world.project);
    try {
      const invite = invitation(hub, world);
      const answer = await session.connection.post(`/v1/projects/${world.project}/invites`, { invite: invite.payload.invite, expiresAt: new Date(hub.now() - 1).toISOString(), checkKey: invite.checkKey }, session.token);
      assert.equal(answer.status, 403);
      assert.equal(answer.json().error, 'invite-expired');
      assert.equal(hub.store.invite(world.project, invite.payload.invite), undefined);
    } finally {
      session.connection.close();
    }
  }));

test('used: once the roster records member.admit naming the invitation, a correct post is refused invite-used', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    // admitMember writes member.invite inv-2 and member.admit naming it (the world numbers its invitations).
    const invite = invitation(hub, world, { invite: 'inv-2' });
    await register(hub, world, world.lead, invite);
    const officer = world.device('OFFICER-C', 'mbr-officer');
    const admitted = world.admitMember(officer);
    assert.equal(admitted.invite.entry.header.stream, world.project);
    await pushRoster(hub, world, [admitted.invite, admitted.admit], admitted.grant === undefined ? [] : [admitted.grant]);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    assertRefused(await postRaw(hub, post), 403, 'invite-used', post);
    assert.equal(hub.store.joinRequests(world.project).length, 0);
  }));

test('voided: once the roster records invite.void, a correct post is refused invite-voided', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const made = world.rosterEntry(world.lead, 'member.invite', {
      invite: invite.payload.invite, name: 'Person J', seat: 'j2-analyst', roles: ['member'], clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: joinSecretHash(invite.secret),
    });
    const voided = world.rosterEntry(world.lead, 'invite.void', { invite: invite.payload.invite });
    await pushRoster(hub, world, [made, voided]);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    assertRefused(await postRaw(hub, post), 403, 'invite-voided', post);
  }));

test('locked: after 5 posts with a wrong hub MAC the invitation is locked, and a sixth with the right MAC is refused locked', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    for (let round = 1; round <= 5; round += 1) {
      const wrong = joinPost(hub, invite, joiner, { tamperMac: true });
      assertRefused(await postRaw(hub, wrong), 403, 'wrong-secret', wrong);
      assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, round);
    }
    const record = hub.store.invite(world.project, invite.payload.invite);
    assert.ok(record?.lockedAt !== undefined, 'the fifth failure locks the invitation');
    const right = joinPost(hub, invite, joiner);
    assertRefused(await postRaw(hub, right), 403, 'invite-locked', right);
    assert.equal(hub.store.joinRequests(world.project).length, 0);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 5, 'a refusal for a locked invitation counts nothing more');
    assert.ok(hub.joinLogs.some((line) => line.event === 'invite.locked' && line.fields.invite === invite.payload.invite));
  }));

test('locked: a wrong check key (a guessed secret) is a wrong MAC and counts toward the lock', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const guessed = hubJoinCheckKey(newJoinSecret(), invite.payload.invite);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'), { checkKey: guessed });
    assertRefused(await postRaw(hub, post), 403, 'wrong-secret', post);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 1);
  }));

test('a post naming another hub\'s writer id is refused wrong-hub; one whose request answers another project is refused wrong-project; neither is counted', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const otherHub = createHash('sha256').update('another hub', 'utf8').digest('hex');
    const elsewhere = joinPost(hub, invite, joiner, { hub: otherHub });
    assertRefused(await postRaw(hub, elsewhere), 403, 'wrong-hub', elsewhere);

    // An invitation of another project (another genesis) under an invite id this project registered.
    const foreign = invitation(hub, createHubWorld({ projectLabel: 'other-exercise' }), { invite: 'inv-foreign' });
    const local = { ...foreign, payload: { ...foreign.payload, project: world.project } };
    await register(hub, world, world.lead, local);
    const crossed = joinPost(hub, local, joiner);
    assertRefused(await postRaw(hub, crossed), 403, 'wrong-project', crossed);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 0);
    assert.equal(hub.store.invite(world.project, 'inv-foreign')?.failures, 0);
  }));

test('signatures: an envelope or a join request whose signature does not verify is refused bad-signature; an envelope from another device wrong-device', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    const post = joinPost(hub, invite, joiner);
    const envelope = post.join as SignedPayload<Record<string, unknown>>;
    const badEnvelope = { ...envelope, sig: flipFirst(envelope.sig) };
    assertRefused(await postRaw(hub, { join: badEnvelope, request: post.request }), 403, 'bad-signature');
    const badRequest = { ...post.request, sig: flipFirst(post.request.sig) };
    assertRefused(await postRaw(hub, { join: post.join, request: badRequest }), 403, 'bad-signature');
    // The envelope of another device naming this request.
    const stranger = world.device('STRANGER-S', 'mbr-stranger');
    const read = readHubJoin(post.join, post.request);
    assert.ok(read.ok);
    const strangers = { ...post.join as object, signer: { ...(envelope.signer as object), publicKey: stranger.publicKey } };
    assertRefused(await postRaw(hub, { join: strangers, request: post.request }), 403, 'wrong-device');
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 0);
    assert.equal(hub.store.joinRequests(world.project).length, 0);
  }));

test('a join body over 64 KiB is refused 413 before it is read or parsed, and no check runs', () => {
  const { checks, counts } = countingChecks();
  return withJoinHub({ joinChecks: checks }, async (hub) => {
    await team(hub);
    const connection = await hub.connect();
    try {
      const answer = await connection.call('POST', '/v1/join', { declaredLength: 64 * 1024 + 1, headers: { 'content-type': 'application/json' } });
      assert.equal(answer.status, 413);
      assert.equal(answer.json().error, 'too-large');
    } finally {
      connection.close();
    }
    const big = await postRaw(hub, { join: 'x'.repeat(70 * 1024), request: {} });
    assert.equal(big.status, 413);
    assert.deepEqual(counts, { read: 0, mac: 0 });
  });
});

test('429: the 11th join post from one address within a minute is refused with Retry-After before any signature is checked', () => {
  const { checks, counts } = countingChecks();
  return withJoinHub({ joinChecks: checks }, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    for (let round = 1; round <= 10; round += 1) assert.equal((await postRaw(hub, post)).status, 202, `post ${round}`);
    const before = { ...counts };
    const refused = await postRaw(hub, post);
    assert.equal(refused.status, 429);
    assert.equal(refused.json.error, 'rate-limited');
    assert.ok(Number(refused.headers['retry-after']) >= 1, 'Retry-After is given');
    assert.deepEqual(counts, before, 'the verifier was not called for the refused post');
    hub.advance(60_000);
    assert.equal((await postRaw(hub, post)).status, 202, 'the bucket refills');
  });
});

test('registration: a member\'s device is refused 403, a check key of the wrong length 400, and only the lead or deputy device registers', () =>
  withJoinHub({}, async (hub) => {
    const { world, member, deputy } = await team(hub, { deputy: true });
    const invite = invitation(hub, world);
    const body = { invite: invite.payload.invite, expiresAt: invite.payload.expiresAt, checkKey: invite.checkKey };
    const asMember = await rawSession(hub, member, world.project);
    try {
      const refused = await asMember.connection.post(`/v1/projects/${world.project}/invites`, body, asMember.token);
      assert.equal(refused.status, 403);
      assert.equal(refused.json().error, 'forbidden');
      assert.equal(hub.store.invite(world.project, invite.payload.invite), undefined);
    } finally {
      asMember.connection.close();
    }
    const asLead = await rawSession(hub, world.lead, world.project);
    try {
      const short = await asLead.connection.post(`/v1/projects/${world.project}/invites`, { ...body, checkKey: Buffer.alloc(31, 1).toString('base64url') }, asLead.token);
      assert.equal(short.status, 400);
      assert.equal(short.json().error, 'malformed');
      const extra = await asLead.connection.post(`/v1/projects/${world.project}/invites`, { ...body, secret: invite.secret }, asLead.token);
      assert.equal(extra.status, 400, 'a body with any other field, a secret included, is refused');
      assert.equal(hub.store.invite(world.project, invite.payload.invite), undefined);
    } finally {
      asLead.connection.close();
    }
    await register(hub, world, deputy as WorldDevice, invite);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.registeredBy, (deputy as WorldDevice).writer);
  }));

test('registration: the same invitation again keeps the first; with the same check key it is held, with another it is refused and the first stays', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    const lead = transportFor(hub, world, world.lead);
    try {
      const first = await lead.registerInvite({ invite: invite.payload.invite, expiresAt: invite.payload.expiresAt, checkKey: invite.checkKey });
      assert.equal(first.held, false);
      const again = await lead.registerInvite({ invite: invite.payload.invite, expiresAt: invite.payload.expiresAt, checkKey: invite.checkKey });
      assert.equal(again.held, true);
      const other = hubJoinCheckKey(newJoinSecret(), invite.payload.invite);
      await assert.rejects(lead.registerInvite({ invite: invite.payload.invite, expiresAt: invite.payload.expiresAt, checkKey: other }), (error: unknown) => error instanceof HubTransportError && error.status === 409 && error.reason === 'invite-exists');
      assert.equal(hub.store.invite(world.project, invite.payload.invite)?.checkKey, invite.checkKey, 'the first check key stays');
    } finally {
      lead.close();
    }
  }));

test('the same accepted request posted twice is kept once, is not a failure, and the lead hears of it once', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const reader = await EventClient.open(hub, world.lead, world.project);
    const stream = await reader.events();
    await stream.until((item) => item.retries.length === 1, 'the stream open');
    const post = joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner'));
    const first = await postRaw(hub, post);
    assert.equal(first.status, 202);
    assert.equal(first.json.held, false);
    await stream.frame(1);
    const second = await postRaw(hub, post);
    assert.equal(second.status, 202);
    assert.equal(second.json.held, true);
    assert.equal(hub.store.joinRequests(world.project).length, 1);
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 0);
    // A post for a second invitation: frames on one stream arrive in order, so once its frame is here a frame for the duplicate would be too.
    const marker = invitation(hub, world);
    await register(hub, world, world.lead, marker);
    assert.equal((await postRaw(hub, joinPost(hub, marker, world.device('JOINER-K', 'mbr-joiner-k')))).status, 202);
    await stream.until((item) => item.frames.some((frame) => (frame.data as { invite?: string }).invite === marker.payload.invite), 'the marker frame');
    assert.deepEqual(stream.frames.map((frame) => (frame.data as { invite: string }).invite), [invite.payload.invite, marker.payload.invite], 'the duplicate sent no event');
    reader.close();
  }));

test('who may read: the deputy\'s device hears the join-request event and lists the requests; a member\'s device is refused 403', () =>
  withJoinHub({}, async (hub) => {
    const { world, member, deputy } = await team(hub, { deputy: true });
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const reader = await EventClient.open(hub, deputy as WorldDevice, world.project);
    const stream = await reader.events();
    await stream.until((item) => item.retries.length === 1, 'the stream open');
    assert.equal((await postRaw(hub, joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner')))).status, 202);
    assert.deepEqual((await stream.frame(1)).data, { project: world.project, invite: invite.payload.invite });
    reader.close();
    const asDeputy = transportFor(hub, world, deputy as WorldDevice);
    const asMember = transportFor(hub, world, member);
    try {
      assert.equal((await asDeputy.joinRequests()).length, 1);
      await assert.rejects(asMember.joinRequests(), (error: unknown) => error instanceof HubTransportError && error.status === 403 && error.reason === 'forbidden');
    } finally {
      asDeputy.close();
      asMember.close();
    }
  }));

test('7 days: an accepted request is listed until 7 days after it was accepted, then the hourly removal takes it from the list and the database; the invitation stays', () =>
  withJoinHub({}, async (hub, scheduler) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world, { expiresAt: new Date(hub.now() + 30 * DAY_MS).toISOString() });
    await register(hub, world, world.lead, invite);
    assert.equal((await postRaw(hub, joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner')))).status, 202);
    scheduler.advance(7 * DAY_MS - 60 * 60 * 1000);
    const lead = transportFor(hub, world, world.lead);
    try {
      assert.equal((await lead.joinRequests()).length, 1, 'still listed just before 7 days');
      assert.equal(hub.store.joinRequests(world.project).length, 1);
      scheduler.advance(2 * 60 * 60 * 1000);
      assert.equal(hub.store.joinRequests(world.project).length, 0, 'removed from the database by the hourly sweep');
      assert.equal((await lead.joinRequests()).length, 0, 'and gone from the list');
    } finally {
      lead.close();
    }
    assert.ok(hub.store.invite(world.project, invite.payload.invite) !== undefined, 'the invitation record is never removed');
    assert.ok(hub.joinLogs.some((line) => line.event === 'join.removed' && line.fields.removed === 1));
  }));

test('7 days: the removal also runs when the hub starts, so requests accepted before a long stop are gone at once', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world, { expiresAt: new Date(hub.now() + 30 * DAY_MS).toISOString() });
    await register(hub, world, world.lead, invite);
    assert.equal((await postRaw(hub, joinPost(hub, invite, world.device('JOINER-J', 'mbr-joiner')))).status, 202);
    hub.advance(8 * DAY_MS);
    // A second desk over the same store, as a restarted hub builds one, removes the old request when it starts.
    const restarted = new JoinDesk({ store: hub.store, cache: hub.cache, identity: hub.identity, events: hub.events, now: () => hub.now() });
    const scheduler = new ManualScheduler();
    restarted.start(scheduler);
    assert.equal(hub.store.joinRequests(world.project).length, 0);
    assert.equal(scheduler.pending, 1, 'and the hourly timer is set');
    restarted.stop();
    assert.equal(scheduler.pending, 0);
  }));

test('log lines of the join desk carry the project id, the invite id and a reason word only', () =>
  withJoinHub({}, async (hub) => {
    const { world } = await team(hub);
    const invite = invitation(hub, world);
    await register(hub, world, world.lead, invite);
    const joiner = world.device('JOINER-J', 'mbr-joiner');
    await postRaw(hub, joinPost(hub, invite, joiner, { tamperMac: true }));
    const post = joinPost(hub, invite, joiner);
    await postRaw(hub, post);
    assert.ok(hub.joinLogs.length >= 3);
    for (const line of hub.joinLogs) {
      assert.ok(Object.keys(line.fields).every((key) => ['project', 'invite', 'reason', 'removed'].includes(key)), JSON.stringify(line.fields));
      const text = JSON.stringify(line);
      for (const value of [invite.secret, invite.checkKey, post.request.payload.mac, post.request.payload.publicKey, post.request.payload.name]) assert.equal(text.includes(value), false);
    }
  }));

function flipFirst(text: string): string {
  const bytes = Buffer.from(text, 'base64url');
  bytes[0] = (bytes[0] as number) ^ 1;
  return bytes.toString('base64url');
}
