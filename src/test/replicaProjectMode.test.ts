// Turning positions on (Phase 33.1 plan 03; D-05, D-11, D-22, D-26, D-39; POST-01): the positions@1 feature on Phase 33's roster.require, the shared
// project's signed way of working (project.mode) that every replica folds the same way, the lead's one action that writes both, and the plain
// invitation refused in an assignment mode. Each person has an install of their own. Fictional people, positions and keys only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { KNOWN_REPLICA_FEATURES, POSITIONS_FEATURE, UPDATE_SENTENCE, VERIFIED_CLEARANCE_FEATURE } from '../domain/replica/features';
import { validateData } from '../domain/replica/kinds';
import { ROSTER_REFUSALS, positionSettingsAt, projectModeAt, projectRequiresCredentials } from '../domain/replica/roster';
import type { RosterState } from '../domain/replica/roster';
import { term } from '../domain/org/terms';
import { inviteToProject } from '../staff/replica/membership';
import {
  INVITE_NOT_IN_MODE_TEXT, POSITIONS_REFUSALS, changeMode, inviteNotInModeText, requireVerifiedClearance, settingsLooserThan, turnOnPositions
} from '../staff/replica/positionsActivation';
import type { PositionsRules } from '../staff/replica/positionsActivation';
import { ReplicaProject, ReplicaProjectError } from '../staff/replica/replicaProject';
import { WORLD_NOW, bringIn, leadWith, orgClearance, project, streamEntries, syncTo } from './helpers/labelCellWorld';
import type { Seat } from './helpers/labelCellWorld';

const POLICY = createHash('sha256').update('policy/example-organization').digest('hex');
const RULES: PositionsRules = { mode: 'military', allowedModes: ['corporate', 'military'], settings: { overdueDays: 3 }, policy: POLICY };
const WITH_CREDENTIALS: PositionsRules = { ...RULES, credentials: { v: 1, issuers: [] } };

const head = (roster: RosterState): number => roster.positions.length - 1;
const baseCount = (seat: Seat): number => streamEntries(seat.at, seat.p.projectId).length;
const refusedIn = (roster: RosterState, hash: string): string | undefined => roster.refused.find((item) => item.hash === hash)?.reason;

async function appended(seat: Seat, kind: string, data: Record<string, unknown>, options: Parameters<ReplicaProject['appendOwn']>[2] = {}): Promise<string> {
  const written = await seat.p.appendOwn(kind, data, options);
  assert.ok('ok' in written, 'ok' in written ? undefined : written.message);
  return written.hash;
}

const modeData = (mode: string, settings: Record<string, unknown> = {}): Record<string, unknown> => ({ mode, settings, policy: POLICY, reason: 'Fictional exercise way of working' });

// ---- Task 1: the feature and the fold ------------------------------------------------------------------------------------------------------------

test('tracer: the lead turns positions on; positions@1 then project.mode fold the same on the lead\'s and a member\'s computer', async () => {
  const lead = await leadWith({ label: 'mode-tracer-lead' });
  const pat = await bringIn(lead, 'mode-tracer-pat', 'Pat Analyst', orgClearance('Internal'));
  const before = await lead.p.state();
  assert.equal(projectModeAt(before.roster, head(before.roster)), 'corporate', 'no signed mode folds as Corporate (portfolio D12)');
  assert.deepEqual(positionSettingsAt(before.roster, head(before.roster)), {});
  const turned = await turnOnPositions(lead.p, RULES);
  assert.ok(turned.ok, turned.ok ? undefined : turned.message);
  assert.equal(turned.written.length, 2, 'the requirement, then the mode');
  await syncTo(lead, pat);
  for (const seat of [lead, pat]) {
    const { roster } = await seat.p.state();
    assert.ok(roster.required.includes(POSITIONS_FEATURE));
    assert.equal(projectModeAt(roster, head(roster)), 'military');
    assert.deepEqual(positionSettingsAt(roster, head(roster)), { overdueDays: 3 });
    assert.equal(roster.positions[head(roster)], turned.written[1], 'the mode is the roster head');
    assert.equal(projectModeAt(roster, head(roster) - 1), 'corporate', 'answered at the roster an entry cites');
    assert.deepEqual(roster.refused, []);
  }
  assert.ok(KNOWN_REPLICA_FEATURES.includes(POSITIONS_FEATURE) && KNOWN_REPLICA_FEATURES.includes(VERIFIED_CLEARANCE_FEATURE));
});

test('a computer whose version does not fold positions@1 stops the shared work with the update sentence and keeps every entry', async () => {
  const lead = await leadWith({ label: 'mode-older-lead' });
  const pat = await bringIn(lead, 'mode-older-pat', 'Pat Analyst', orgClearance('Internal'));
  assert.ok((await turnOnPositions(lead.p, RULES)).ok);
  await syncTo(lead, pat);
  const older = project(await ReplicaProject.open(pat.at.root, { ...pat.at.deps, knownFeatures: KNOWN_REPLICA_FEATURES.filter((id) => id !== POSITIONS_FEATURE) }));
  await assert.rejects(older.state(), (error: unknown) => error instanceof ReplicaProjectError && error.refusal.refused === 'needs-update' && error.refusal.message === UPDATE_SENTENCE);
  assert.equal(baseCount(pat), baseCount(lead), 'every entry the lead wrote is kept');
});

test('project.mode is refused before positions@1 is required, by a member who is not the lead, by an agent, and with settings looser than its mode', async () => {
  const lead = await leadWith({ label: 'mode-refusals-lead' });
  const pat = await bringIn(lead, 'mode-refusals-pat', 'Pat Analyst', orgClearance('Internal'));
  const early = await appended(lead, 'project.mode', modeData('military'));
  assert.equal(refusedIn((await lead.p.state()).roster, early), 'positions-not-required');
  assert.ok((await turnOnPositions(lead.p, { ...RULES, mode: 'corporate' })).ok);
  await syncTo(lead, pat);
  const byMember = await appended(pat, 'project.mode', modeData('military'));
  const byAgent = await appended(lead, 'project.mode', modeData('military'), { actor: { kind: 'agent', member: lead.member, run: 'run-fictional-1' } });
  const looser = await appended(lead, 'project.mode', modeData('military', { mayDecline: true }));
  const unknown = await appended(lead, 'project.mode', modeData('directorate'));
  await syncTo(pat, lead);
  const { roster } = await lead.p.state();
  assert.equal(refusedIn(roster, byMember), 'mode-not-allowed');
  assert.equal(refusedIn(roster, byAgent), 'person-only');
  assert.equal(refusedIn(roster, looser), 'settings-looser-than-mode');
  assert.equal(refusedIn(roster, unknown), 'unknown-mode');
  assert.equal(projectModeAt(roster, head(roster)), 'corporate', 'none of them changed the mode');
  for (const reason of ['positions-not-required', 'mode-not-allowed', 'settings-looser-than-mode', 'unknown-mode', 'mode-change-pending', 'invite-not-in-mode']) {
    assert.ok(reason in ROSTER_REFUSALS, reason);
  }
  // A delegation depth past the limit never reaches the fold: the closed schema refuses it at verification.
  assert.equal(validateData('project.mode', { ...modeData('military', { maxDelegationDepth: 3 }), rosterPrev: 'a'.repeat(64) }).ok, false);
});

test('a project.mode written right after the genesis folds like any other (D-26), and every positions kind waits for positions@1', async () => {
  const lead = await leadWith({ label: 'mode-genesis-lead' });
  const create = await appended(lead, 'position.create', {
    position: 'watch-officer-night', title: 'Watch Officer, night', section: 'j3', decides: [], clearance: orgClearance('Internal'), keyGroups: [], acting: false, dualHat: false
  });
  assert.equal(refusedIn((await lead.p.state()).roster, create), 'positions-not-required');
  const turned = await turnOnPositions(lead.p, { ...RULES, settings: {} });
  assert.ok(turned.ok);
  const { roster } = await lead.p.state();
  assert.equal(projectModeAt(roster, head(roster)), 'military');
  assert.deepEqual(positionSettingsAt(roster, head(roster)), {});
});

test('verified-clearance@1: projectRequiresCredentials turns true at the lead\'s requirement, on every computer, and a computer without it stops', async () => {
  const lead = await leadWith({ label: 'mode-credentials-lead' });
  const pat = await bringIn(lead, 'mode-credentials-pat', 'Pat Analyst', orgClearance('Internal'));
  assert.ok((await turnOnPositions(lead.p, RULES)).ok);
  assert.equal(projectRequiresCredentials((await lead.p.state()).roster), false);
  const required = await requireVerifiedClearance(lead.p);
  assert.ok(required.ok && required.written.length === 1);
  await syncTo(lead, pat);
  for (const seat of [lead, pat]) assert.equal(projectRequiresCredentials((await seat.p.state()).roster), true);
  const older = project(await ReplicaProject.open(pat.at.root, { ...pat.at.deps, knownFeatures: KNOWN_REPLICA_FEATURES.filter((id) => id !== VERIFIED_CLEARANCE_FEATURE) }));
  await assert.rejects(older.state(), (error: unknown) => error instanceof ReplicaProjectError && error.refusal.message === UPDATE_SENTENCE);
});

// ---- Task 2: turning positions on once, changing the mode, no invitation in an assignment mode ---------------------------------------------------

test('turnOnPositions writes the requirement and the mode once: after an interruption only the mode is written, and a third call writes nothing', async () => {
  const lead = await leadWith({ label: 'mode-once-lead' });
  // An earlier call stopped after its first entry was stored.
  const first = await lead.p.appendOwn('roster.require', { features: [POSITIONS_FEATURE] });
  assert.ok('ok' in first);
  const count = baseCount(lead);
  const second = await turnOnPositions(lead.p, RULES);
  assert.ok(second.ok);
  assert.equal(second.written.length, 1, 'only the mode');
  assert.equal(baseCount(lead), count + 1);
  const third = await turnOnPositions(lead.p, RULES);
  assert.deepEqual(third, { ok: true, written: [] });
  assert.equal(baseCount(lead), count + 1, 'nothing more');
  assert.equal((await lead.p.findOwnAll('roster.require', (data) => (data as { features: string[] }).features.includes(POSITIONS_FEATURE))).length, 1);
});

test('a mode outside your organization\'s allowed modes is refused before anything is signed, and a member\'s computer cannot turn positions on', async () => {
  const lead = await leadWith({ label: 'mode-allowed-lead' });
  const pat = await bringIn(lead, 'mode-allowed-pat', 'Pat Analyst', orgClearance('Internal'));
  const count = baseCount(lead);
  const outside = await turnOnPositions(lead.p, { ...RULES, mode: 'capital' });
  assert.deepEqual(outside, { ok: false, refused: 'mode-not-allowed-here', message: POSITIONS_REFUSALS['mode-not-allowed-here'] });
  assert.equal(baseCount(lead), count, 'nothing was written');
  const looser = await turnOnPositions(lead.p, { ...RULES, settings: { mayDecline: true } });
  assert.equal(looser.ok ? undefined : looser.refused, 'settings-looser-than-mode');
  assert.equal(baseCount(lead), count);
  const byMember = await turnOnPositions(pat.p, RULES);
  assert.equal(byMember.ok ? undefined : byMember.refused, 'not-the-lead');
});

test('changeMode is refused while an invitation is open or a posting is ordered and not yet in effect, with the DESIGN 5.7 reason', async () => {
  const lead = await leadWith({ label: 'mode-change-lead' });
  assert.ok((await turnOnPositions(lead.p, { ...RULES, mode: 'corporate' })).ok);
  const invited = await inviteToProject(lead.host, { name: 'Quinn Planner', seat: 'j4-planner', clearance: orgClearance('Internal') });
  assert.equal(invited.ok, true, invited.message);
  const blocked = await changeMode(lead.p, RULES, 'The exercise moves to assignment');
  assert.deepEqual(blocked, { ok: false, refused: 'mode-change-pending', message: POSITIONS_REFUSALS['mode-change-pending'] });
  // The same rule in the fold: a mode change written anyway is refused there too.
  const forced = await appended(lead, 'project.mode', modeData('military'));
  assert.equal(refusedIn((await lead.p.state()).roster, forced), 'mode-change-pending');
});

test('a posting ordered and not yet reported blocks a mode change; once nothing is pending the lead changes the mode', async () => {
  const lead = await leadWith({ label: 'mode-posting-lead' });
  assert.ok((await turnOnPositions(lead.p, RULES)).ok);
  await appended(lead, 'position.create', {
    position: 'watch-officer-night', title: 'Watch Officer, night', section: 'j3', decides: [], clearance: orgClearance('Internal'), keyGroups: [], acting: false, dualHat: false
  });
  const now = WORLD_NOW.toISOString();
  const order = await appended(lead, 'posting.order', {
    posting: 'pst-watch-night-1', position: 'watch-officer-night', person: { member: lead.member }, evidence: [POLICY], status: [{ list: 'urn:example:status:1', hash: POLICY, validFrom: now }],
    kind: 'substantive', start: now, policy: POLICY, stages: []
  });
  assert.equal(refusedIn((await lead.p.state()).roster, order), undefined, 'the order folds');
  assert.equal((await changeMode(lead.p, { ...RULES, mode: 'corporate' }, 'Back to invitation')).ok, false);
  await appended(lead, 'posting.report', { posting: 'pst-watch-night-1' });
  const changed = await changeMode(lead.p, { ...RULES, mode: 'corporate' }, 'Back to invitation');
  assert.ok(changed.ok, changed.ok ? undefined : changed.message);
  const { roster } = await lead.p.state();
  assert.equal(projectModeAt(roster, head(roster)), 'corporate');
});

test('in an assignment mode a plain invitation is refused with the mode\'s words, and the fold refuses one written anyway; a device invitation still works', async () => {
  const lead = await leadWith({ label: 'mode-invite-lead' });
  assert.ok((await turnOnPositions(lead.p, RULES)).ok);
  const count = baseCount(lead);
  const invited = await inviteToProject(lead.host, { name: 'Quinn Planner', seat: 'j4-planner', clearance: orgClearance('Internal') });
  assert.equal(invited.ok, false);
  assert.equal(invited.reason, 'invite-not-in-mode');
  assert.equal(invited.message, inviteNotInModeText('military'));
  assert.equal(invited.message, INVITE_NOT_IN_MODE_TEXT.replace('{join}', term('join', 'military').toLowerCase()).replace('{tasker}', term('tasker', 'military').toLowerCase()));
  assert.equal(baseCount(lead), count, 'nothing was signed');
  const forced = await appended(lead, 'member.invite', {
    invite: 'inv-fictional01', name: 'Quinn Planner', seat: 'j4-planner', roles: ['member'], clearance: orgClearance('Internal'),
    expiresAt: new Date(WORLD_NOW.getTime() + 86_400_000).toISOString(), secretHash: 'e'.repeat(64)
  });
  assert.equal(refusedIn((await lead.p.state()).roster, forced), 'invite-not-in-mode');
  const device = await appended(lead, 'member.invite', {
    invite: 'inv-fictional02', name: 'Lead laptop', seat: 'lead-laptop', roles: ['member'], clearance: orgClearance('Internal'),
    expiresAt: new Date(WORLD_NOW.getTime() + 86_400_000).toISOString(), secretHash: 'f'.repeat(64), forMember: lead.member
  });
  assert.equal(refusedIn((await lead.p.state()).roster, device), undefined, 'a person\'s own other computer is not a joining');
});

test('settingsLooserThan names each signed setting looser than the person\'s own rules, and nothing when they match', () => {
  assert.deepEqual(settingsLooserThan({}, {}), []);
  assert.deepEqual(settingsLooserThan({ overdueDays: 3, acting: false }, { overdueDays: 3, acting: false }), []);
  assert.deepEqual(settingsLooserThan({ maxDelegationDepth: 2, overdueDays: 5 }, { maxDelegationDepth: 1, overdueDays: 2 }), ['maxDelegationDepth', 'overdueDays']);
  assert.deepEqual(settingsLooserThan({}, { acting: false, guests: false, enrolAtReport: true }), ['acting', 'enrolAtReport', 'guests']);
  assert.deepEqual(settingsLooserThan({ acting: false, enrolAtReport: true }, { acting: false, enrolAtReport: true, overdueDays: 9 }), []);
});

test('with a credentials@1 section the turn-on requires positions@1 and verified-clearance@1 in one entry; requireVerifiedClearance writes once; changeMode requires it first', async () => {
  const lead = await leadWith({ label: 'mode-creds-lead' });
  const turned = await turnOnPositions(lead.p, WITH_CREDENTIALS);
  assert.ok(turned.ok);
  const requires = await lead.p.findOwnAll('roster.require', () => true);
  assert.deepEqual((requires[requires.length - 1]?.data as { features: string[] }).features, [POSITIONS_FEATURE, VERIFIED_CLEARANCE_FEATURE], 'one entry names both');
  assert.equal(projectRequiresCredentials((await lead.p.state()).roster), true);
  assert.deepEqual(await requireVerifiedClearance(lead.p), { ok: true, written: [] }, 'already required: nothing is written');

  const other = await leadWith({ label: 'mode-creds-change' });
  assert.ok((await turnOnPositions(other.p, { ...RULES, mode: 'corporate' })).ok);
  assert.equal(projectRequiresCredentials((await other.p.state()).roster), false);
  const changed = await changeMode(other.p, WITH_CREDENTIALS, 'Your organization now issues credentials');
  assert.ok(changed.ok && changed.written.length === 2, 'the requirement first, then the mode');
  const { roster } = await other.p.state();
  assert.equal(projectRequiresCredentials(roster), true);
  assert.equal(projectModeAt(roster, head(roster)), 'military');
  const off = await leadWith({ label: 'mode-creds-off' });
  assert.equal((await requireVerifiedClearance(off.p)).ok, false, 'positions are not on');
});
