// Ask to join (Phase 61 plan 28, G-61-9): an invite in reverse over real git. The requester's computer (clone b, team.json present, no device
// key) makes the single-use code, keeps it in SecretStorage and hands over only a signed request with the derived public key. The owner on
// clone a accepts it, which writes a normal member.invited for that key, and clone b then joins by itself with the existing code proof.
// Emails use .invalid addresses.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalBytes, canonicalize } from '../domain/team/canonical';
import { DEFAULT_INVITE_TTL_SECONDS, INVITE_SKEW_SECONDS } from '../domain/team/invite';
import type { TeamFile } from '../domain/team/types';
import { pushCodeBranch } from '../team/enable';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { createDeviceIdentity, deviceKeySecretName, emailHash, loadDeviceIdentity, newMemberId, newTeamId, sealKeySecretName } from '../team/identity';
import { INVITE_FILE, readInviteDirectory } from '../team/invite';
import { deriveInviteKey, generateInviteCode, parseInviteCode } from '../team/inviteCode';
import { catchUpCopy } from '../team/joinCatchUp';
import { TEAM_FILE_REL, readTeamFile } from '../team/teamFile';
import {
  ACCEPTED_REQUESTS_FILE, JOIN_REQUEST_PREFIX, JoinRequestError, acceptJoinRequest, cancelJoinRequest, completeJoinRequest, createJoinRequest, parseJoinRequest,
  readPendingRequest, requestCheckCode, wasAcceptedHere
} from '../team/joinRequest';
import type { AcceptResult, CompleteOutcome, JoinRequest } from '../team/joinRequest';
import {
  GIGA, LEAD_EMAIL, closeRig, confirm, createRig, enable, invite, join, link, openLog, publishProject, remoteEventCount, remove, rootOf, storageOf, teamIdOf
} from './helpers/teamFlowRig';
import type { Participant, Rig, RigOptions } from './helpers/teamFlowRig';
import { inviteCodeForms, makeCanaries, scanFiles, scanGitObjects } from './helpers/teamCanary';
import type { Needle } from './helpers/teamCanary';
import { MemorySecrets, gitIn } from './helpers/teamHarness';

const requestSecretName = (teamId: string): string => `nearAi.team.joinRequest.${teamId}`;

async function withRig(options: RigOptions, run: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = await createRig(options);
  try {
    await run(rig);
  } finally {
    await closeRig(rig);
  }
}

// The owner turned Team Mode on and published it, so clones b and c hold team.json; nobody but the owner has a device key.
async function sharedTeam(rig: Rig): Promise<TeamFile> {
  await enable(rig);
  await publishProject(rig);
  return rig.teamFile as TeamFile;
}

function ask(rig: Rig, person: Participant, extra: { name?: string; email?: string } = {}): ReturnType<typeof createJoinRequest> {
  return createJoinRequest({ secrets: person.secrets, teamFile: rig.teamFile as TeamFile, name: extra.name ?? person.name, ...(extra.email === undefined ? { email: person.email } : { email: extra.email }) });
}

type AcceptOverrides = Partial<Omit<Parameters<typeof acceptJoinRequest>[0], 'request'>> & { by?: 'owner' | Participant };

async function accept(rig: Rig, request: JoinRequest, email: string, overrides: AcceptOverrides = {}): Promise<AcceptResult> {
  const { by = 'owner', ...rest } = overrides;
  const opened = await openLog(rig, by);
  const globalStorageDir = by === 'owner' ? rig.owner.globalStorageDir : by.globalStorageDir;
  const clone = by === 'owner' ? 'a' : by.clone;
  return acceptJoinRequest({
    projectRoot: rootOf(rig, clone), globalStorageDir, teamFile: rig.teamFile as TeamFile, log: opened.log, request, email,
    role: 'developer', allocationNanoUsd: 5 * GIGA, ttlSeconds: DEFAULT_INVITE_TTL_SECONDS,
    ...(by === 'owner' && rig.owner.org !== undefined ? { org: rig.owner.org } : {}),
    ...rest
  });
}

async function complete(rig: Rig, person: Participant, overrides: Partial<Parameters<typeof completeJoinRequest>[0]> = {}): Promise<CompleteOutcome> {
  const opened = await openLog(rig, person);
  return completeJoinRequest({
    projectRoot: rootOf(rig, person.clone), globalStorageDir: person.globalStorageDir, teamFile: rig.teamFile as TeamFile, secrets: person.secrets,
    state: opened.log.state(), nearBaseUrl: rig.fake.baseUrl, ...overrides
  });
}

function hasTeamKeys(rig: Rig, person: Participant): boolean {
  const teamId = teamIdOf(rig);
  return person.secrets.values.has(deviceKeySecretName(teamId)) || person.secrets.values.has(sealKeySecretName(teamId));
}

// ---- Task 1: the tracer ----------------------------------------------------------------------------------------------------------------------

test('tracer: a person with a copy asks, the owner accepts, and the copy joins by itself with no code travelling', async () => {
  await withRig({ linked: false }, async (rig) => {
    await sharedTeam(rig);
    const teamId = teamIdOf(rig);
    const dev = rig.dev;

    // On clone b: the request text and the check code; the code itself stays in SecretStorage.
    const asked = await ask(rig, dev);
    assert.ok(asked.text.startsWith(JOIN_REQUEST_PREFIX), 'the request text has the join-request prefix');
    assert.match(asked.checkCode, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/, 'the check code is 8 characters in two groups');
    assert.ok(dev.secrets.values.has(requestSecretName(teamId)), 'the request is kept in SecretStorage for this team');
    const again = await ask(rig, dev);
    assert.deepEqual(again, asked, 'asking again gives the stored request back');
    const pending = await readPendingRequest(dev.secrets, teamId);
    assert.deepEqual(pending, { text: asked.text, checkCode: asked.checkCode, memberId: asked.memberId, name: dev.name });

    // Before any accept there is nothing to join and nothing changes.
    assert.deepEqual(await complete(rig, dev), { kind: 'not-yet' });
    assert.equal(hasTeamKeys(rig, dev), false, 'no device or seal key before the accept');

    // On clone a: the owner reads the request and accepts it.
    const request = parseJoinRequest(asked.text);
    assert.equal(request.team, teamId);
    assert.equal(request.member, asked.memberId);
    assert.equal(request.name, dev.name);
    assert.equal(request.email, dev.email);
    assert.equal(requestCheckCode(request), asked.checkCode, 'both people see the same check code');
    const accepted = await accept(rig, request, dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    assert.equal(accepted.ok && accepted.memberId, asked.memberId);
    assert.equal(accepted.ok && accepted.nearInvitation, 'not-applicable');
    assert.equal('bundle' in accepted, false, 'an accepted request hands back no invite text');
    const owner = await openLog(rig, 'owner');
    const invited = owner.log.state().members.get(asked.memberId);
    assert.equal(invited?.status, 'invited');
    assert.equal(invited?.invite?.publicKey, request.key, 'the invitation is bound to the key the request carried');
    assert.equal(invited?.pendingRole, 'developer');
    assert.equal(invited?.name, dev.name);

    // Back on clone b: it finds its invitation and joins by itself.
    const done = await complete(rig, dev);
    assert.equal(done.kind, 'joined', JSON.stringify(done));
    if (done.kind !== 'joined') return;
    assert.equal(done.result.memberId, asked.memberId);
    assert.equal(done.result.role, 'observer', 'the person joins as an observer until confirmed');
    assert.equal(done.result.pendingRole, 'developer');
    const identity = await loadDeviceIdentity(dev.secrets, teamId);
    assert.ok(identity !== undefined, 'clone b made its own device key');
    await owner.log.sync();
    const joined = owner.log.state().members.get(asked.memberId);
    assert.equal(joined?.status, undefined, 'the invitation is used');
    assert.equal(joined?.role, 'observer');
    assert.equal(joined?.pendingRole, 'developer');
    assert.equal(owner.log.state().deviceIndex.get(identity?.fingerprint as string), asked.memberId, 'the join is signed by clone b\'s new device key');
    assert.equal(owner.log.state().refused, undefined);
    assert.equal(dev.secrets.values.has(requestSecretName(teamId)), false, 'the stored request is forgotten after the join');
    assert.equal(await readPendingRequest(dev.secrets, teamId), undefined);
    assert.deepEqual(await complete(rig, dev), { kind: 'none' }, 'a second completion has nothing to do');
  });
});

// ---- Task 2: every refusal ---------------------------------------------------------------------------------------------------------------

const NOT_A_REQUEST = /^This is not a NEAR AI request to join\. /;
const TOO_LARGE = /^This request is far larger than a real one/;
const DAMAGED = /^This request is damaged or was changed after it was made\. /;
const NEWER = /^This request was made by a newer version of NEAR AI\. /;
const HOLDS_SECRET = /^This request holds something that looks like a key or token/;

function offlineTeamFile(teamId: string = newTeamId(), ref: string = DEFAULT_COORDINATION_REF): TeamFile {
  return { teamId, coordination: { transport: 'git', ref, remote: 'origin' } } as unknown as TeamFile;
}

function payloadOf(text: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(text.slice(JOIN_REQUEST_PREFIX.length), 'base64url').toString('utf8')) as Record<string, unknown>;
}

function wire(fields: Record<string, unknown>): string {
  return `${JOIN_REQUEST_PREFIX}${Buffer.from(canonicalize(fields), 'utf8').toString('base64url')}`;
}

// A request with any fields at all, correctly self-signed (or signed by another key), so each field rule is tested on its own.
function forge(fields: { team?: string; ref?: string; member?: string; name?: string; email?: string }, options: { signWithOther?: boolean } = {}): string {
  const team = fields.team ?? newTeamId();
  const member = fields.member ?? newMemberId();
  const own = deriveInviteKey(generateInviteCode().bytes, TEAM_ID.test(team) ? team : newTeamId(), MEMBER_ID.test(member) ? member : newMemberId());
  const other = deriveInviteKey(generateInviteCode().bytes, newTeamId(), newMemberId());
  const body: Record<string, unknown> = { v: 1, team, ref: fields.ref ?? DEFAULT_COORDINATION_REF, member, name: fields.name ?? 'Rita Requester', key: own.publicKey };
  if (fields.email !== undefined) body['email'] = fields.email;
  const signer = options.signWithOther === true ? other : own;
  const sig = signer.sign(canonicalBytes({ purpose: 'near-ai.team.join-request', ...body }));
  return wire({ ...body, sig });
}

const TEAM_ID = /^team-[0-9a-f]{32}$/;
const MEMBER_ID = /^mbr-[0-9a-f]{16}$/;

function refusedWith(text: string, pattern: RegExp, mustNotContain: string[] = []): void {
  assert.throws(() => parseJoinRequest(text), (error: unknown) => {
    assert.ok(error instanceof JoinRequestError, 'a JoinRequestError');
    assert.match(error.message, pattern);
    for (const piece of [...mustNotContain, text.slice(JOIN_REQUEST_PREFIX.length, JOIN_REQUEST_PREFIX.length + 12)]) {
      if (piece.length >= 4) assert.equal(error.message.includes(piece), false, 'the sentence never repeats the input');
    }
    return true;
  });
}

test('parseJoinRequest refuses another prefix, an oversized or damaged text and a non-canonical spelling, with fixed sentences', async () => {
  const made = await createJoinRequest({ secrets: new MemorySecrets(), teamFile: offlineTeamFile(), name: 'Rita Requester', email: 'rita@example.invalid' });
  assert.equal(parseJoinRequest(`  ${made.text}\n`).name, 'Rita Requester', 'surrounding whitespace from a paste is dropped');
  const payload = made.text.slice(JOIN_REQUEST_PREFIX.length);
  refusedWith(`near-ai-invite-v1.${payload}`, NOT_A_REQUEST);
  refusedWith(payload, NOT_A_REQUEST);
  refusedWith(`near-ai-join-request-v2.${payload}`, NEWER);
  refusedWith(`${made.text}${'A'.repeat(2048)}`, TOO_LARGE);
  refusedWith(`${made.text}=`, DAMAGED);
  refusedWith(`${JOIN_REQUEST_PREFIX}${Buffer.from('{not json', 'utf8').toString('base64url')}`, DAMAGED);
  refusedWith(wire({ ...payloadOf(made.text), v: 2 }), NEWER);
  refusedWith(wire({ ...payloadOf(made.text), extra: 'unsigned' }), DAMAGED);
  // The same bytes spelled with a different final character (the spare bits of base64url) are one request with two spellings: refused.
  let spelled = made.text;
  for (const name of ['Rita R', 'Rita Re', 'Rita Req', 'Rita Requ']) {
    if (spelled.slice(JOIN_REQUEST_PREFIX.length).length % 4 !== 0) break;
    spelled = (await createJoinRequest({ secrets: new MemorySecrets(), teamFile: offlineTeamFile(), name })).text;
  }
  const body = spelled.slice(JOIN_REQUEST_PREFIX.length);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const twin = [...alphabet].map((character) => `${body.slice(0, -1)}${character}`)
    .find((candidate) => candidate !== body && Buffer.from(candidate, 'base64url').equals(Buffer.from(body, 'base64url')));
  assert.ok(twin !== undefined, 'a second spelling of the same bytes exists');
  refusedWith(`${JOIN_REQUEST_PREFIX}${twin as string}`, DAMAGED);
});

test('parseJoinRequest refuses bad ids, a bad name or email, a secret-shaped field, a changed field and another key\'s signature', () => {
  assert.equal(parseJoinRequest(forge({ email: 'rita@example.invalid' })).email, 'rita@example.invalid', 'a forged request with good fields is read');
  assert.equal(parseJoinRequest(forge({})).email, undefined, 'the email is optional');
  refusedWith(forge({ member: 'mbr-NOTHEX0000000000' }), DAMAGED, ['NOTHEX']);
  refusedWith(forge({ team: 'team-short' }), DAMAGED, ['team-short']);
  refusedWith(forge({ ref: 'refs/tags/x' }), DAMAGED);
  refusedWith(forge({ name: 'R'.repeat(81) }), DAMAGED, ['RRRR']);
  refusedWith(forge({ name: 'Rita\nRequester' }), DAMAGED, ['Rita']);
  refusedWith(forge({ name: ' Rita' }), DAMAGED, ['Rita']);
  refusedWith(forge({ email: 'not-an-email' }), DAMAGED, ['not-an-email']);
  refusedWith(forge({ email: 'rita @example.invalid' }), DAMAGED, ['rita']);
  const canaries = makeCanaries();
  refusedWith(forge({ name: canaries.apiKey }), HOLDS_SECRET, [canaries.apiKey]);
  refusedWith(forge({ email: `${canaries.refreshToken}@example.invalid` }), HOLDS_SECRET, [canaries.refreshToken]);

  const good = forge({ name: 'Rita Requester', email: 'rita@example.invalid' });
  refusedWith(wire({ ...payloadOf(good), name: 'Mallory' }), DAMAGED, ['Mallory']);
  refusedWith(wire({ ...payloadOf(good), email: 'mallory@example.invalid' }), DAMAGED, ['mallory']);
  const { email: _email, ...withoutEmail } = payloadOf(good);
  refusedWith(wire(withoutEmail), DAMAGED);
  refusedWith(wire({ ...payloadOf(good), member: newMemberId() }), DAMAGED);
  refusedWith(forge({ name: 'Rita Requester' }, { signWithOther: true }), DAMAGED);
  refusedWith(wire({ ...payloadOf(good), key: payloadOf(forge({})).key }), DAMAGED);
});

test('createJoinRequest checks the name and email it is given and refuses a computer that already has a key for the team', async () => {
  const teamFile = offlineTeamFile();
  await assert.rejects(createJoinRequest({ secrets: new MemorySecrets(), teamFile, name: '   ' }), /name must be 1 to 80 characters/);
  await assert.rejects(createJoinRequest({ secrets: new MemorySecrets(), teamFile, name: 'Rita', email: 'nope' }), /email address is not valid/);
  await assert.rejects(createJoinRequest({ secrets: new MemorySecrets(), teamFile, name: makeCanaries().apiKey }), /looks like a key or token/);
  const noEmail = await createJoinRequest({ secrets: new MemorySecrets(), teamFile, name: '  Rita  ', email: '  ' });
  assert.equal(parseJoinRequest(noEmail.text).name, 'Rita');
  assert.equal(parseJoinRequest(noEmail.text).email, undefined, 'an empty email is left out');
  const keyed = new MemorySecrets();
  await createDeviceIdentity(keyed, teamFile.teamId);
  await assert.rejects(createJoinRequest({ secrets: keyed, teamFile, name: 'Rita' }), /already has a key for this team/);
  assert.equal(await readPendingRequest(keyed, teamFile.teamId), undefined);
});

test('accepting refuses a request for another team or team record, a second accept and a developer, and writes nothing', async () => {
  await withRig({ linked: false }, async (rig) => {
    const teamFile = await sharedTeam(rig);
    const before = remoteEventCount(rig);
    const otherTeam = parseJoinRequest((await createJoinRequest({ secrets: new MemorySecrets(), teamFile: offlineTeamFile(), name: 'Rita' })).text);
    const otherTeamResult = await accept(rig, otherTeam, 'rita@example.invalid');
    assert.equal(otherTeamResult.ok, false);
    assert.match(otherTeamResult.ok ? '' : otherTeamResult.message, /different team than the one open in this project/);
    const otherRef = parseJoinRequest((await createJoinRequest({ secrets: new MemorySecrets(), teamFile: offlineTeamFile(teamFile.teamId, 'refs/near-ai/other'), name: 'Rita' })).text);
    const otherRefResult = await accept(rig, otherRef, 'rita@example.invalid');
    assert.equal(otherRefResult.ok, false);
    assert.match(otherRefResult.ok ? '' : otherRefResult.message, /different team record/);
    // A request object changed after it was read is refused like a changed paste.
    const asked = parseJoinRequest((await ask(rig, rig.lead)).text);
    const changed = await accept(rig, { ...asked, name: 'Mallory' }, rig.lead.email);
    assert.equal(changed.ok, false);
    assert.match(changed.ok ? '' : changed.message, DAMAGED);
    assert.equal(remoteEventCount(rig), before, 'nothing was written for the refused requests');
    assert.equal(await wasAcceptedHere(storageOf(rig, 'owner'), asked.member), false);

    const first = await accept(rig, asked, rig.lead.email);
    assert.equal(first.ok, true, first.ok ? '' : first.message);
    const afterFirst = remoteEventCount(rig);
    const second = await accept(rig, asked, rig.lead.email);
    assert.equal(second.ok, false);
    assert.equal(second.ok ? '' : second.code, 'refused');
    assert.match(second.ok ? '' : second.message, /already accepted/);
    assert.equal(remoteEventCount(rig), afterFirst, 'a second accept writes nothing');

    // A confirmed developer may not accept: the log's write-side permission check refuses member.invited.
    await invite(rig, rig.dev);
    await join(rig, rig.dev);
    await confirm(rig, rig.dev);
    const thirdPerson = { ...rig.dev, secrets: new MemorySecrets() };
    const fromStranger = parseJoinRequest((await createJoinRequest({ secrets: thirdPerson.secrets, teamFile, name: 'Sam Stranger', email: 'sam@example.invalid' })).text);
    const beforeDev = remoteEventCount(rig);
    const byDeveloper = await accept(rig, fromStranger, 'sam@example.invalid', { by: rig.dev });
    assert.equal(byDeveloper.ok, false);
    assert.equal(byDeveloper.ok ? '' : byDeveloper.code, 'refused');
    assert.equal(remoteEventCount(rig), beforeDev, 'a developer\'s accept writes nothing');
    assert.equal(await wasAcceptedHere(storageOf(rig, rig.dev), fromStranger.member), false);
  });
});

test('an accepted request whose invitation expired or was cancelled is reported plainly and leaves no team key on the requester\'s computer', async () => {
  await withRig({ linked: false }, async (rig) => {
    await sharedTeam(rig);
    const teamId = teamIdOf(rig);

    // Expired: the owner gave one hour, and the requester's computer looks after it ran out.
    const asked = await ask(rig, rig.dev);
    const accepted = await accept(rig, parseJoinRequest(asked.text), rig.dev.email, { ttlSeconds: 3600 });
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    const late = (): number => Date.now() + (3600 + INVITE_SKEW_SECONDS + 600) * 1000;
    const expired = await complete(rig, rig.dev, { now: late });
    assert.equal(expired.kind, 'expired', JSON.stringify(expired));
    assert.match(expired.kind === 'expired' ? expired.message : '', /has expired\. Ask to join again, or cancel the request\./);
    assert.equal(hasTeamKeys(rig, rig.dev), false, 'no device or seal key was kept');
    assert.ok(await readPendingRequest(rig.dev.secrets, teamId) !== undefined, 'the stored request stays, so it can be asked again or cancelled');

    // Cancelled: the owner removes the invitation made from the request.
    const lead = rig.lead;
    const leadAsked = await ask(rig, lead);
    const leadAccepted = await accept(rig, parseJoinRequest(leadAsked.text), lead.email);
    assert.equal(leadAccepted.ok, true, leadAccepted.ok ? '' : leadAccepted.message);
    lead.memberId = leadAsked.memberId;
    await remove(rig, 'owner', lead);
    const cancelled = await complete(rig, lead);
    assert.equal(cancelled.kind, 'cancelled', JSON.stringify(cancelled));
    assert.match(cancelled.kind === 'cancelled' ? cancelled.message : '', /was cancelled\. Ask to join again, or cancel the request\./);
    assert.equal(hasTeamKeys(rig, lead), false, 'no device or seal key was kept');

    // The requester cancels: the code is gone from this computer, so the invitation made from it can never be used by anyone.
    await cancelJoinRequest(rig.dev.secrets, teamId);
    assert.equal(rig.dev.secrets.values.has(requestSecretName(teamId)), false);
    assert.equal(await readPendingRequest(rig.dev.secrets, teamId), undefined);
    assert.deepEqual(await complete(rig, rig.dev), { kind: 'none' });
    assert.equal(hasTeamKeys(rig, rig.dev), false);
    // Asking again after a cancel is a new request with a new member id.
    const again = await ask(rig, rig.dev);
    assert.notEqual(again.memberId, asked.memberId);
  });
});

test('a lead request in a linked team sends the invitation to your organization to the email given at accept, and the lead joins by itself', async () => {
  await withRig({ linked: true }, async (rig) => {
    await enable(rig);
    await link(rig);
    await publishProject(rig);
    const lead = rig.lead;
    const asked = await ask(rig, lead, { email: '' });
    const request = parseJoinRequest(asked.text);
    assert.equal(request.email, undefined, 'the request left the email out');
    assert.equal(rig.fake.emailedToken(LEAD_EMAIL), undefined);
    const accepted = await accept(rig, request, LEAD_EMAIL, { role: 'lead', allocationNanoUsd: 20 * GIGA });
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    assert.equal(accepted.ok && accepted.nearInvitation, 'sent');
    assert.ok(rig.fake.emailedToken(LEAD_EMAIL) !== undefined, 'NEAR holds a pending invitation for the email the lead gave at accept');
    const owner = await openLog(rig, 'owner');
    assert.deepEqual(owner.log.state().members.get(asked.memberId)?.emailHashes, [emailHash(teamIdOf(rig), LEAD_EMAIL)], 'the invitation has that one email hash');
    assert.ok((await readInviteDirectory(storageOf(rig, 'owner'))).some((entry) => entry.memberId === asked.memberId && entry.email === LEAD_EMAIL), 'the owner\'s invitation list has the person');

    const done = await complete(rig, lead, { signIn: async () => ({ ...(lead.nearTokens as { accessToken: string; refreshToken: string }) }) });
    assert.equal(done.kind, 'joined', JSON.stringify(done));
    assert.equal(done.kind === 'joined' && done.result.pendingRole, 'lead');
    assert.equal(done.kind === 'joined' && done.result.nearInvitation, 'accepted', 'the lead accepted the invitation to your organization');
  });
});

test('the accepting computer notes only member ids, names and event ids, and only it knows it accepted', async () => {
  await withRig({ linked: false }, async (rig) => {
    await sharedTeam(rig);
    const asked = await ask(rig, rig.dev);
    const accepted = await accept(rig, parseJoinRequest(asked.text), rig.dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    assert.equal(await wasAcceptedHere(storageOf(rig, 'owner'), asked.memberId), true);
    assert.equal(await wasAcceptedHere(storageOf(rig, rig.dev), asked.memberId), false);
    assert.equal(await wasAcceptedHere(storageOf(rig, 'owner'), newMemberId()), false);
    const file = JSON.parse(await fs.readFile(path.join(storageOf(rig, 'owner'), ACCEPTED_REQUESTS_FILE), 'utf8')) as { version: number; accepted: Array<Record<string, unknown>> };
    assert.equal(file.version, 1);
    assert.equal(file.accepted.length, 1);
    assert.deepEqual(Object.keys(file.accepted[0] ?? {}).sort(), ['invitedEvent', 'memberId', 'name']);
    assert.equal(file.accepted[0]?.['memberId'], asked.memberId);
    assert.equal(file.accepted[0]?.['name'], rig.dev.name);
    const owner = await openLog(rig, 'owner');
    assert.equal(file.accepted[0]?.['invitedEvent'], owner.log.state().members.get(asked.memberId)?.invitedEvent);
  });
});

test('a copy that is behind (no team.json yet) is brought up to date with no team id and can then ask; with no team online it is told so', async () => {
  await withRig({ linked: false }, async (rig) => {
    await enable(rig);
    const b = rootOf(rig, 'b');
    const head = gitIn(b, ['rev-parse', 'HEAD']);
    assert.deepEqual(await catchUpCopy({ projectRoot: b, remote: 'origin' }), { ok: false, reason: 'not-shared' }, 'the online version has no team.json yet');
    assert.equal(gitIn(b, ['rev-parse', 'HEAD']), head, 'nothing in the copy changed');

    const pushed = await pushCodeBranch(rootOf(rig, 'a'), 'origin', 'main');
    assert.equal(pushed.ok, true, pushed.ok ? '' : pushed.message);
    const caught = await catchUpCopy({ projectRoot: b, remote: 'origin' });
    assert.deepEqual(caught, { ok: true, updated: true, branch: 'main' });
    const teamFile = await readTeamFile(b);
    assert.equal(teamFile?.teamId, teamIdOf(rig));

    const asked = await createJoinRequest({ secrets: rig.dev.secrets, teamFile: teamFile as TeamFile, name: rig.dev.name, email: rig.dev.email });
    const accepted = await accept(rig, parseJoinRequest(asked.text), rig.dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    const done = await complete(rig, rig.dev);
    assert.equal(done.kind, 'joined', JSON.stringify(done));
  });
});

// ---- Task 3: nothing leaks, and the signed log format is the one invites already write ------------------------------------------------------

async function filesUnder(target: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: string[] = [];
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(child));
    else if (entry.isFile()) found.push(child);
  }
  return found;
}

async function mirrorsUnder(storage: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of await filesUnder(storage)) if (path.basename(file) === 'HEAD' && path.basename(path.dirname(file)).endsWith('.git')) found.push(path.dirname(file));
  return found;
}

const labelsIn = (text: string, needles: Needle[]): string[] => needles.filter((needle) => text.includes(needle.value)).map((needle) => needle.label);

test('privacy: after a request, an accept and the join, the code is nowhere but the requester\'s secure storage, and then nowhere at all', async () => {
  const canaries = makeCanaries();
  await withRig({ linked: false, keySecretPrefix: canaries.apiKey }, async (rig) => {
    await sharedTeam(rig);
    const teamId = teamIdOf(rig);
    const dev = rig.dev;
    const output: string[] = [];

    const asked = await ask(rig, dev);
    // The code is read from SecretStorage, where it is meant to be, before the join forgets it.
    const stored = dev.secrets.values.get(requestSecretName(teamId));
    assert.ok(stored !== undefined, 'control: the stored request is in SecretStorage');
    const codeText = (JSON.parse(stored as string) as { code: string }).code;
    const codeBytes = parseInviteCode(codeText);
    assert.ok(codeBytes !== undefined, 'the stored code is a readable code');
    const forms = inviteCodeForms(codeText, Buffer.from(codeBytes as Buffer));
    (codeBytes as Buffer).fill(0);
    assert.ok(forms.length >= 5, 'the code in at least five renderings');
    const codeNeedles: Needle[] = forms.map((value, index) => ({ label: `request code form ${index}`, value }));
    assert.deepEqual(labelsIn(stored as string, codeNeedles).length > 0, true, 'control: the scan sees the code where it is meant to be');

    const accepted = await accept(rig, parseJoinRequest(asked.text), dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    if (accepted.ok && accepted.notice !== undefined) output.push(accepted.notice);
    const done = await complete(rig, dev, { pasteOwnKey: async () => dev.ownKey });
    assert.equal(done.kind, 'joined', JSON.stringify(done));
    if (done.kind === 'joined') output.push(...done.result.notices);
    assert.ok(dev.ownKey?.startsWith(canaries.apiKey), 'the person\'s own key carries the run-time canary');
    assert.ok([...dev.secrets.values.values()].some((value) => value.includes(dev.ownKey as string)), 'control: the pasted key is held by SecretStorage');

    const needles: Needle[] = [...codeNeedles, ...canaries.labelled(), { label: 'own key', value: dev.ownKey as string }];
    assert.deepEqual(labelsIn(asked.text, needles), [], 'the request text');
    assert.deepEqual(labelsIn(Buffer.from(asked.text.slice(JOIN_REQUEST_PREFIX.length), 'base64url').toString('utf8'), needles), [], 'the decoded request');
    assert.deepEqual(labelsIn([...dev.secrets.values.values()].join('\n'), codeNeedles), [], 'the code is forgotten after the join');
    assert.deepEqual(labelsIn(output.join('\n'), needles), [], 'every sentence the flows handed back');

    const planted = path.join(rig.fixture.storageDir('b'), 'planted-control.txt');
    await fs.writeFile(planted, `before ${forms[0] as string} after`, 'utf8');
    try {
      assert.deepEqual((await scanFiles([rig.fixture.storageDir('b')], needles)).map((hit) => hit.split(': ')[1]), ['request code form 0'], 'control: a planted code is found in a storage folder');
    } finally {
      await fs.rm(planted, { force: true });
    }

    assert.deepEqual(await scanGitObjects(rig.fixture.remote, needles), [], 'bare remote: every coordination blob and object');
    for (const name of ['a', 'b'] as const) {
      const mirrors = await mirrorsUnder(rig.fixture.storageDir(name));
      assert.ok(mirrors.length >= 1, `storage ${name} has a coordination mirror`);
      for (const mirror of mirrors) assert.deepEqual(await scanGitObjects(mirror, needles), [], `mirror of clone ${name}`);
      assert.deepEqual(await scanFiles([path.join(rootOf(rig, name), TEAM_FILE_REL)], needles), [], `team.json of clone ${name}`);
      assert.deepEqual(await scanFiles([path.join(rootOf(rig, name), '.planning')], needles), [], `.planning of clone ${name}`);
      assert.deepEqual(await scanFiles([rig.fixture.storageDir(name)], needles), [], `every file in the storage folder of clone ${name}`);
    }
    const ownerStorage = storageOf(rig, 'owner');
    assert.ok((await fs.stat(path.join(ownerStorage, ACCEPTED_REQUESTS_FILE))).isFile(), 'accepted-requests.json was scanned');
    assert.ok((await fs.stat(path.join(ownerStorage, INVITE_FILE))).isFile(), 'invites.json was scanned');
    assert.deepEqual(labelsIn(await fs.readFile(path.join(ownerStorage, ACCEPTED_REQUESTS_FILE), 'utf8'), [{ label: 'email', value: dev.email }, { label: 'key', value: parseJoinRequest(asked.text).key }]), [], 'accepted-requests.json holds no email and no key');
  });
});

function eventBodies(rig: Rig, type: string): Array<Record<string, unknown>> {
  const names = gitIn(rig.fixture.remote, ['ls-tree', '-r', '--name-only', DEFAULT_COORDINATION_REF]).split('\n').filter((name) => name.startsWith('events/'));
  return names
    .map((name) => JSON.parse(gitIn(rig.fixture.remote, ['show', `${DEFAULT_COORDINATION_REF}:${name}`])) as { type: string; body: Record<string, unknown> })
    .filter((event) => event.type === type)
    .map((event) => event.body);
}

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf((value as Record<string, unknown>)[key])]));
  return typeof value;
}

test('an accepted request writes member.invited and member.joined in exactly the shape an invite and its join write', async () => {
  await withRig({ linked: false }, async (rig) => {
    await sharedTeam(rig);
    await invite(rig, rig.lead);
    await join(rig, rig.lead);
    const asked = await ask(rig, rig.dev);
    const accepted = await accept(rig, parseJoinRequest(asked.text), rig.dev.email);
    assert.equal(accepted.ok, true, accepted.ok ? '' : accepted.message);
    const done = await complete(rig, rig.dev);
    assert.equal(done.kind, 'joined', JSON.stringify(done));

    const invited = eventBodies(rig, 'member.invited');
    const viaInvite = invited.find((body) => body['memberId'] === rig.lead.memberId);
    const viaRequest = invited.find((body) => body['memberId'] === asked.memberId);
    assert.ok(viaInvite !== undefined && viaRequest !== undefined, 'both invitations are on the remote');
    assert.deepEqual(shapeOf(viaRequest), shapeOf(viaInvite), 'member.invited has the same keys and types');
    const joined = eventBodies(rig, 'member.joined').filter((body) => body['invite'] !== undefined);
    const joinViaInvite = joined.find((body) => body['memberId'] === rig.lead.memberId);
    const joinViaRequest = joined.find((body) => body['memberId'] === asked.memberId);
    assert.ok(joinViaInvite !== undefined && joinViaRequest !== undefined, 'both joins are on the remote');
    assert.deepEqual(shapeOf(joinViaRequest), shapeOf(joinViaInvite), 'member.joined has the same keys and types');
    assert.deepEqual(Object.keys(viaRequest ?? {}).sort(), ['allocationNanoUsd', 'emailHashes', 'invite', 'memberId', 'name', 'role', 'ttlSeconds']);
  });
});
