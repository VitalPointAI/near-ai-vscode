import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildHubJoin, buildInvite, buildJoinRequest, checkHubJoinMac, checkJoinRequest, hubJoinCheckKey, hubJoinMac, joinRequestHash, newJoinSecret, readHubJoin } from '@ext/domain/replica/invite';
import type { InvitePayload, JoinRequestPayload } from '@ext/domain/replica/invite';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { HubTransport, HubTransportError } from '@ext/staff/replica/hubTransport';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
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
