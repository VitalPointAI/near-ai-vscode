// G-62-5 (62-15): a lead puts a person on a card with item.assigned { id, memberId } and takes them off with item.unassigned { id }. Both are signed,
// mapped to the item.assign row (owner and lead) and checked on write and on read like every other event. The first test is the tracer over real
// git: the lead's assignment on one computer shows on the developer's computer after one sync, and a developer's own assignment is refused on
// write and rejected on read by both clones when it is forged straight into the remote. Reasons are asserted from TEAM_REJECTION_REASONS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { cloneState, serialiseState } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { TeamEvent, TeamState } from '../domain/team/types';
import type { EventIntent } from '../team/eventLog';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { NEUTRAL_IDENTITY_ENV } from '../team/runGit';
import { closeRig, confirm, createRig, enable, invite, join, openLog, publishProject, rootOf } from './helpers/teamFlowRig';
import type { OpenLog, Rig } from './helpers/teamFlowRig';
import { signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import type { MemorySecrets } from './helpers/teamHarness';

const R = TEAM_REJECTION_REASONS;
const DEVELOPER_MAY_NOT = `${R.notPermitted}: the developer role does not allow assigning items to others`;

// The two intents, built loosely so this file states the wire shape itself rather than borrowing it from the types under test.
function assignIntent(id: string, memberId: string): EventIntent {
  return { type: 'item.assigned', body: { id, memberId } } as unknown as EventIntent;
}
function unassignIntent(id: string): EventIntent {
  return { type: 'item.unassigned', body: { id } } as unknown as EventIntent;
}

// The stored assignee of an item, read without leaning on the WorkItem type so the wire contract is stated here.
function assigneeOf(state: TeamState, itemId: string): string | undefined {
  const item = state.items.get(itemId) as { assignee?: string } | undefined;
  return item?.assignee;
}

function rawGit(cwd: string, args: string[], options: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...options.env }, input: options.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// What a hostile member's git access allows: add any event file to the coordination branch and push it as an ordinary fast-forward.
function rawPush(dir: string, event: TeamEvent, message: string): void {
  rawGit(dir, ['fetch', '-q', 'origin', `+${DEFAULT_COORDINATION_REF}:refs/raw/coordination`]);
  const parent = rawGit(dir, ['rev-parse', 'refs/raw/coordination']);
  const indexFile = path.join(dir, '.git', `raw-index-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: indexFile, ...NEUTRAL_IDENTITY_ENV };
  try {
    rawGit(dir, ['read-tree', parent], { env });
    const blob = rawGit(dir, ['hash-object', '-w', '--stdin'], { env, input: canonicalize(event) });
    rawGit(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${eventPath(event)}`], { env });
    const tree = rawGit(dir, ['write-tree'], { env });
    const commit = rawGit(dir, ['commit-tree', tree, '-p', parent, '-m', message], { env });
    rawGit(dir, ['push', '-q', 'origin', `${commit}:${DEFAULT_COORDINATION_REF}`]);
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function withoutRejections(state: TeamState): string {
  const copy = cloneState(state);
  copy.rejected = [];
  return serialiseState(copy);
}

const actorOf = (opened: OpenLog, secrets: MemorySecrets): TestActor => {
  assert.ok(opened.identity !== undefined && opened.memberId !== undefined, 'the person has a device key and a member id');
  return { memberId: opened.memberId as string, identity: opened.identity as TestActor['identity'], secrets };
};

// The real membership lifecycle on three clones: the owner on a, the developer on b and the lead on c, both joined and confirmed.
async function withTeam(run: (rig: Rig, teamId: string) => Promise<void>): Promise<void> {
  const rig = await createRig({ linked: false });
  try {
    const enabled = await enable(rig);
    await publishProject(rig);
    await invite(rig, rig.dev);
    await invite(rig, rig.lead);
    await join(rig, rig.dev);
    await join(rig, rig.lead);
    await confirm(rig, rig.lead);
    await confirm(rig, rig.dev);
    await run(rig, enabled.teamFile.teamId);
  } finally {
    await closeRig(rig);
  }
}

const common = { state: 'backlog' as const, dependsOn: [] as string[], scope: [] as string[], requirements: [] as string[], mustHaves: [] as string[], tags: [] as string[] };

test('a lead assigns a plan to a developer on one computer, the developer sees it after one sync, and a developer cannot assign on write or by forging', async () => {
  await withTeam(async (rig, teamId) => {
    const owner = await openLog(rig, 'owner');
    const imported = await owner.log.append(() => [
      { type: 'item.imported', body: { ...common, id: 'milestone:v0.9.0', kind: 'milestone', title: 'Version 0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'phase:90', kind: 'phase', title: 'Alpha work', parentId: 'milestone:v0.9.0' } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-01', kind: 'plan', title: 'Alpha slice', parentId: 'phase:90', scope: ['src/a/**'], estimate: { tokens: 1000 } } },
      { type: 'item.imported', body: { ...common, id: 'plan:90-02', kind: 'plan', title: 'Beta slice', parentId: 'phase:90', scope: ['src/b/**'], estimate: { tokens: 2000 } } }
    ]);
    assert.equal(imported.ok, true, imported.ok ? '' : imported.reason);
    const lead = await openLog(rig, rig.lead);
    const developer = await openLog(rig, rig.dev);
    const developerId = developer.memberId as string;
    assert.equal(developer.log.state().members.get(developerId)?.role, 'developer');
    assert.equal(lead.log.state().members.get(lead.memberId as string)?.role, 'lead');
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), undefined);

    // The lead, on clone c, assigns the plan to the developer.
    const assigned = await lead.log.append(() => [assignIntent('plan:90-02', developerId)]);
    assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.reason);
    assert.equal(assigneeOf(lead.log.state(), 'plan:90-02'), developerId);

    // One sync on the developer's computer (clone b) is all it takes.
    const synced = await developer.log.sync();
    assert.deepEqual(synced.rejected, []);
    assert.equal(synced.accepted.length, 1);
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), developerId);
    await owner.log.sync();
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-02'), developerId);
    assert.equal(serialiseState(developer.log.state()), serialiseState(owner.log.state()));

    // The developer's own client refuses an assignment before anything is written.
    const remoteHead = owner.log.state().head;
    const own = await developer.log.append(() => [assignIntent('plan:90-01', developerId)]);
    assert.equal(own.ok, false);
    assert.equal(own.ok ? '' : own.reason, DEVELOPER_MAY_NOT);
    await owner.log.sync();
    assert.deepEqual(owner.log.state().head, remoteHead, 'nothing reached the remote');

    // The same events, validly signed by the developer's device, pushed straight to the coordination branch.
    const before = withoutRejections(owner.log.state());
    const position = { teamId, lamport: remoteHead.lamport + 1, prev: remoteHead.eventId };
    const developerActor = actorOf(developer, rig.dev.secrets);
    const forgedAssign = signed(developerActor, { ...position, type: 'item.assigned' as never, body: { id: 'plan:90-01', memberId: developerId } as never });
    const forgedUnassign = signed(developerActor, { ...position, type: 'item.unassigned' as never, body: { id: 'plan:90-02' } as never });
    rawPush(rootOf(rig, 'b'), forgedAssign, 'raw: a developer assigns themselves');
    rawPush(rootOf(rig, 'b'), forgedUnassign, 'raw: a developer takes the lead\'s assignment off');

    const syncedOwner = await owner.log.sync();
    const syncedDeveloper = await developer.log.sync();
    for (const result of [syncedOwner, syncedDeveloper]) {
      assert.deepEqual(result.accepted, []);
      assert.deepEqual(result.rejected.map((rejection) => rejection.eventId), [forgedAssign.id, forgedUnassign.id]);
      for (const rejection of result.rejected) assert.equal(rejection.reason, DEVELOPER_MAY_NOT);
    }
    assert.deepEqual(syncedOwner.rejected, syncedDeveloper.rejected, 'both clients record the very same rejections');
    assert.equal(withoutRejections(owner.log.state()), before, 'nothing changed');
    assert.equal(withoutRejections(developer.log.state()), before, 'nothing changed on the developer clone either');
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-01'), undefined);
    assert.equal(assigneeOf(owner.log.state(), 'plan:90-02'), developerId);

    // The forged files did not block the log: the lead unassigns with the next lamport and every clone follows.
    const cleared = await lead.log.append(() => [unassignIntent('plan:90-02')]);
    assert.equal(cleared.ok, true, cleared.ok ? '' : cleared.reason);
    if (cleared.ok) assert.equal((cleared.events[0] as TeamEvent).lamport, remoteHead.lamport + 1);
    const after = await developer.log.sync();
    assert.equal(after.accepted.length, 1);
    assert.deepEqual(after.rejected, []);
    assert.equal(assigneeOf(developer.log.state(), 'plan:90-02'), undefined);
  });
});
