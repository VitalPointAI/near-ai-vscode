import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHubJoin, buildInvite, buildJoinRequest, checkHubJoinMac, hubJoinCheckKey, hubJoinMac, joinRequestHash, newJoinSecret, readHubJoin } from '@ext/domain/replica/invite';
import type { InvitePayload, JoinRequestPayload } from '@ext/domain/replica/invite';
import type { SignedPayload } from '@ext/domain/team/signedPayload';
import { HubTransport, HubTransportError } from '@ext/staff/replica/hubTransport';
import { JOIN_REFUSALS, JOIN_REQUEST_KEEP_MS } from '../src/join';
import type { JoinChecks } from '../src/join';
import { LIMITS } from '../src/limits';
import { withHub } from './helpers/hubHarness';
import type { Hub, StartOptions } from './helpers/hubHarness';
import { HUB_ADDRESS, createHubWorld } from './helpers/hubWorld';
import type { HubWorld, WorldDevice } from './helpers/hubWorld';

// Phase 33, plan 02 (D-30, IN-06): your organization's server keeps at most 8 pending join requests per invitation and 64 per project. Beyond that it
// refuses with invite-full and one plain sentence, before any signature is checked. Only distinct requests received within the 7-day keep count, and
// the very same request sent again stays held, never refused and never counted twice. The desk is driven in process (no address bucket), and one post
// goes over HTTPS through the client transport. All names and data are fictional.

const DAY_MS = 24 * 60 * 60 * 1000;
let inviteCount = 0;
let joinerCount = 0;

interface Invitation {
  payload: InvitePayload;
  checkKey: string;
}

interface JoinPost {
  join: unknown;
  request: SignedPayload<JoinRequestPayload>;
}

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

const withCapHub = (options: StartOptions, body: (hub: Hub) => Promise<void>): Promise<void> => withHub({ checkpoints: false, ...options }, body);

/** The world's project with the hub admitted, enrolled over HTTPS. */
async function project(hub: Hub): Promise<HubWorld> {
  const world = createHubWorld();
  world.admitHub(hub.identity);
  const enrolled = await hub.enrolProject(world);
  assert.equal(enrolled?.status, 201, enrolled?.text ?? 'no answer');
  return world;
}

/** An invitation the lead's device makes and registers with the hub's desk. */
async function registered(hub: Hub, world: HubWorld, expiresInDays = 30): Promise<Invitation> {
  inviteCount += 1;
  const secret = newJoinSecret();
  const invite = `inv-cap-${inviteCount}`;
  const signed = buildInvite(world.lead.signer, {
    genesisHash: world.genesisHash,
    project: world.project,
    name: 'Exercise Northwind',
    lead: { member: world.lead.member, x25519: world.lead.x25519, publicKey: world.lead.publicKey },
    invite,
    secret,
    expiresAt: new Date(hub.now() + expiresInDays * DAY_MS).toISOString(),
    now: new Date(hub.now()),
    hub: { address: HUB_ADDRESS, certPin: hub.identity.certPin, writer: hub.identity.writer },
  });
  const checkKey = hubJoinCheckKey(secret, invite);
  const outcome = await hub.join.register(world.project, world.lead.writer, { invite, expiresAt: signed.payload.expiresAt, checkKey });
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason);
  return { payload: signed.payload, checkKey };
}

/** A new joining device's post for the invitation, made as the client makes it. */
function joinPost(hub: Hub, world: HubWorld, invite: Invitation): JoinPost {
  joinerCount += 1;
  const joiner: WorldDevice = world.device(`JOINER-${joinerCount}`, `mbr-joiner-${joinerCount}`);
  const request = buildJoinRequest(joiner.signer, invite.payload, { name: `Person ${joinerCount}`, x25519: joiner.x25519, now: new Date(hub.now()) });
  const fields = { hub: hub.identity.writer, project: invite.payload.project, invite: invite.payload.invite, request: joinRequestHash(request) };
  const join = buildHubJoin(joiner.signer, { hub: fields.hub, project: fields.project, request, hubMac: hubJoinMac(invite.checkKey, fields), now: new Date(hub.now()) });
  return { join, request };
}

async function accepted(hub: Hub, post: JoinPost, what: string): Promise<boolean> {
  const outcome = await hub.join.join(post);
  assert.equal(outcome.ok, true, `${what}: ${outcome.ok ? '' : outcome.reason}`);
  return outcome.ok && outcome.held;
}

async function refusedFull(hub: Hub, post: JoinPost): Promise<void> {
  const outcome = await hub.join.join(post);
  assert.equal(outcome.ok, false, 'refused');
  if (outcome.ok) return;
  assert.equal(outcome.reason, 'invite-full');
  assert.equal(outcome.status, 403);
  assert.equal(outcome.message, 'This invitation has too many people waiting. Ask the staff lead for a new one.');
}

test('LIMITS holds the D-30 caps and JOIN_REFUSALS the invite-full sentence word for word', () => {
  assert.equal(LIMITS.pendingJoinsPerInvite, 8);
  assert.equal(LIMITS.pendingJoinsPerProject, 64);
  assert.equal(JOIN_REFUSALS['invite-full'], 'This invitation has too many people waiting. Ask the staff lead for a new one.');
});

test('per invitation: eight distinct requests are accepted, the ninth is refused invite-full before any signature is checked, and nothing more is kept', () => {
  const { checks, counts } = countingChecks();
  return withCapHub({ joinChecks: checks }, async (hub) => {
    const world = await project(hub);
    const invite = await registered(hub, world);
    for (let round = 1; round <= LIMITS.pendingJoinsPerInvite; round += 1) assert.equal(await accepted(hub, joinPost(hub, world, invite), `request ${round}`), false);
    assert.equal(hub.store.joinRequests(world.project).length, 8);
    const before = { ...counts };
    await refusedFull(hub, joinPost(hub, world, invite));
    assert.deepEqual(counts, before, 'no signature or MAC was checked for the refused post');
    assert.equal(hub.store.joinRequests(world.project).length, 8, 'the ninth is not kept');
    assert.equal(hub.store.invite(world.project, invite.payload.invite)?.failures, 0, 'a full invitation counts no failure');
    assert.ok(hub.joinLogs.some((line) => line.event === 'join.refused' && line.fields.reason === 'invite-full' && line.fields.invite === invite.payload.invite));
    // Another invitation of the same project still takes requests: the per-invitation cap is per invitation.
    const other = await registered(hub, world);
    assert.equal(await accepted(hub, joinPost(hub, world, other), 'a request on another invitation'), false);
  });
});

test('per invitation: the very same eighth request sent again is held, not refused and not counted twice', () =>
  withCapHub({}, async (hub) => {
    const world = await project(hub);
    const invite = await registered(hub, world);
    let eighth: JoinPost | undefined;
    for (let round = 1; round <= 8; round += 1) {
      eighth = joinPost(hub, world, invite);
      await accepted(hub, eighth, `request ${round}`);
    }
    assert.equal(await accepted(hub, eighth as JoinPost, 'the eighth again'), true, 'held');
    assert.equal(await accepted(hub, eighth as JoinPost, 'the eighth a third time'), true, 'held again');
    assert.equal(hub.store.joinRequests(world.project).length, 8, 'kept once');
    await refusedFull(hub, joinPost(hub, world, invite));
  }));

test('per project: 64 accepted requests across eight invitations, and the 65th on a fresh invitation is refused invite-full', () =>
  withCapHub({}, async (hub) => {
    const world = await project(hub);
    const invites: Invitation[] = [];
    for (let made = 0; made < LIMITS.pendingJoinsPerProject / LIMITS.pendingJoinsPerInvite; made += 1) invites.push(await registered(hub, world));
    let last: JoinPost | undefined;
    for (const invite of invites) {
      for (let round = 1; round <= LIMITS.pendingJoinsPerInvite; round += 1) {
        last = joinPost(hub, world, invite);
        await accepted(hub, last, `${invite.payload.invite} request ${round}`);
      }
    }
    assert.equal(hub.store.joinRequests(world.project).length, 64);
    const fresh = await registered(hub, world);
    await refusedFull(hub, joinPost(hub, world, fresh));
    assert.equal(hub.store.joinRequests(world.project).length, 64, 'the 65th is not kept');
    assert.equal(await accepted(hub, last as JoinPost, 'a repeat at the project cap'), true, 'a repeat is held at the project cap too');
  }));

test('7 days: a request received more than 7 days ago no longer counts, so the invitation takes a new one even before the hourly removal runs', () =>
  withCapHub({}, async (hub) => {
    const world = await project(hub);
    const invite = await registered(hub, world, 30);
    for (let round = 1; round <= 8; round += 1) await accepted(hub, joinPost(hub, world, invite), `request ${round}`);
    hub.advance(JOIN_REQUEST_KEEP_MS - 1);
    await refusedFull(hub, joinPost(hub, world, invite));
    hub.advance(2);
    assert.equal(hub.store.joinRequests(world.project).length, 8, 'the old rows are still stored: the removal has not run');
    assert.equal(await accepted(hub, joinPost(hub, world, invite), 'a request after the keep'), false);
    assert.equal(hub.store.joinRequests(world.project).length, 9);
  }));

test('over HTTPS: the client transport hears the ninth refused 403 invite-full, so the person\'s computer can say it plainly', () =>
  withCapHub({ limits: { joinPerMinute: 100 } }, async (hub) => {
    const world = await project(hub);
    const invite = await registered(hub, world);
    for (let round = 1; round <= 8; round += 1) await accepted(hub, joinPost(hub, world, invite), `request ${round}`);
    const joiner = world.device('JOINER-OVER', 'mbr-joiner-over');
    const transport = new HubTransport({
      address: `127.0.0.1:${hub.port}`,
      project: world.project,
      hub: hub.identity.writer,
      trust: { pin: hub.identity.certPin },
      signer: joiner.signer,
      now: () => new Date(hub.now()),
    });
    try {
      await assert.rejects(transport.postJoin(joinPost(hub, world, invite)), (error: unknown) => error instanceof HubTransportError && error.failure === 'hub-error' && error.status === 403 && error.reason === 'invite-full');
    } finally {
      transport.close();
    }
  }));
