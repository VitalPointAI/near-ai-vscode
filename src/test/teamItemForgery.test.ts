// BOARD-03 on real git: item events that a hostile client writes straight to the coordination branch (bypassing TeamLog) are rejected with
// the same reason by every client, never change the board, and never block the honest events that follow. The team is the real membership
// lifecycle (owner, a joined developer, a joined lead who is then made an observer), so every author here is a real signing device.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { canonicalize, eventPath } from '../domain/team/canonical';
import { cloneState, serialiseState } from '../domain/team/materialize';
import { TEAM_REJECTION_REASONS } from '../domain/team/types';
import type { ImplementedEventBodies, ImplementedEventType, Rejection, TeamEvent, TeamState } from '../domain/team/types';
import { DEFAULT_COORDINATION_REF } from '../team/gitTransport';
import { createDeviceIdentity, ulid } from '../team/identity';
import { NEUTRAL_IDENTITY_ENV } from '../team/runGit';
import { closeRig, confirm, createRig, enable, invite, join, openLog, publishProject, rootOf } from './helpers/teamFlowRig';
import type { OpenLog, Rig } from './helpers/teamFlowRig';
import { signed } from './helpers/teamEvents';
import type { TestActor } from './helpers/teamEvents';
import { MemorySecrets } from './helpers/teamHarness';

const R = TEAM_REJECTION_REASONS;

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

function itemsText(state: TeamState): string {
  return canonicalize(JSON.parse(serialiseState(state)).items);
}

const actorOf = (opened: OpenLog, secrets: MemorySecrets): TestActor => {
  assert.ok(opened.identity !== undefined && opened.memberId !== undefined, 'the person has a device key and a member id');
  return { memberId: opened.memberId as string, identity: opened.identity as TestActor['identity'], secrets };
};

type Body<T extends ImplementedEventType> = ImplementedEventBodies[T];

interface Forgery { label: string; event: TeamEvent; reason: string; prefix?: boolean }

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

test('forged item events written straight to the coordination branch are rejected with their reasons on both clones and change no state', async () => {
  await withTeam(async (rig, teamId) => {
    const owner = await openLog(rig, 'owner');
    const ownerActor = actorOf(owner, rig.owner.secrets);
    const imported = await owner.log.append(() => [
      { type: 'item.imported', body: { id: 'milestone:v1.0.0', kind: 'milestone', title: 'Version 1', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [] } },
      { type: 'item.imported', body: { id: 'phase:1', kind: 'phase', title: 'Phase 1', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'milestone:v1.0.0' } },
      { type: 'item.imported', body: { id: 'plan:1-01', kind: 'plan', title: 'First plan', state: 'backlog', dependsOn: [], scope: ['src/**'], requirements: [], mustHaves: [], tags: [], parentId: 'phase:1', estimate: { tokens: 1000 } } }
    ]);
    assert.equal(imported.ok, true, imported.ok ? '' : imported.reason);

    // The lead becomes an observer, and the developer gets a second device that is then revoked: both are ordinary honest events.
    const lead = await openLog(rig, rig.lead);
    const leadActor = actorOf(lead, rig.lead.secrets);
    const demoted = await owner.log.append(() => [{ type: 'member.role-changed', body: { memberId: lead.memberId as string, role: 'observer' } }]);
    assert.equal(demoted.ok, true, demoted.ok ? '' : demoted.reason);
    const developer = await openLog(rig, rig.dev);
    const developerActor = actorOf(developer, rig.dev.secrets);
    const spare = await createDeviceIdentity(new MemorySecrets(), teamId);
    const added = await owner.log.append(() => [{ type: 'device.added', body: { memberId: developer.memberId as string, device: { fingerprint: spare.fingerprint, publicKey: spare.publicKey } } }]);
    assert.equal(added.ok, true, added.ok ? '' : added.reason);
    const revoked = await owner.log.append(() => [{ type: 'device.revoked', body: { memberId: developer.memberId as string, fingerprint: spare.fingerprint } }]);
    assert.equal(revoked.ok, true, revoked.ok ? '' : revoked.reason);

    await developer.log.sync();
    await lead.log.sync();
    const beforeOwner = withoutRejections(owner.log.state());
    const beforeDeveloper = withoutRejections(developer.log.state());
    const itemsBefore = itemsText(owner.log.state());
    assert.equal(beforeOwner, beforeDeveloper);
    assert.deepEqual(owner.log.state().rejected, []);
    assert.deepEqual(developer.log.state().rejected, []);
    assert.equal(owner.log.state().members.get(lead.memberId as string)?.role, 'observer');

    const head = owner.log.state().head;
    const position = { teamId, lamport: head.lamport + 1, prev: head.eventId };
    const sign = <T extends ImplementedEventType>(actor: TestActor, type: T, body: Body<T>): TeamEvent<T> => signed(actor, { ...position, type, body });
    const sneaky: Body<'item.created'> = { id: `item:${ulid()}`, kind: 'chore', title: 'Created by someone who may not', scope: [], requirements: [], mustHaves: [] };
    const honest = sign(ownerActor, 'item.created', { ...sneaky, id: `item:${ulid()}`, title: 'Signed, then changed' });
    const spareActor: TestActor = { memberId: developer.memberId as string, identity: spare, secrets: new MemorySecrets() };
    const forgeries: Forgery[] = [
      { label: 'a developer holds an imported plan', event: sign(developerActor, 'item.updated', { id: 'plan:1-01', changes: { hold: true } }), reason: `${R.notPermitted}: `, prefix: true },
      { label: 'an observer creates an item', event: sign(leadActor, 'item.created', sneaky), reason: `${R.notPermitted}: `, prefix: true },
      { label: 'an import reuses an existing id', event: sign(ownerActor, 'item.imported', { id: 'plan:1-01', kind: 'plan', title: 'Again', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'phase:1' }), reason: R.itemExists },
      { label: 'an import names a parent that is not there', event: sign(ownerActor, 'item.imported', { id: 'plan:1-02', kind: 'plan', title: 'Orphan', state: 'backlog', dependsOn: [], scope: [], requirements: [], mustHaves: [], tags: [], parentId: 'phase:77' }), reason: TEAM_REJECTION_REASONS.itemParent },
      { label: 'a backlog item is reopened', event: sign(ownerActor, 'item.reopened', { id: 'plan:1-01' }), reason: R.itemState },
      { label: 'a revoked device blocks an item', event: sign(spareActor, 'item.blocked', { id: 'plan:1-01', reason: 'blocked by a revoked device' }), reason: R.revokedDevice },
      { label: 'an item is created and then changed after signing', event: { ...honest, body: { ...honest.body, title: 'Changed after signing' } }, reason: R.badSignature },
      { label: 'an update carries an unknown key', event: sign(ownerActor, 'item.updated', { id: 'plan:1-01', changes: { title: 'Fine', nope: 1 } as never }), reason: `${R.invalidBody}: `, prefix: true }
    ];
    for (const forgery of forgeries) rawPush(rootOf(rig, 'c'), forgery.event, `raw: ${forgery.label}`);

    const syncedOwner = await owner.log.sync();
    const syncedDeveloper = await developer.log.sync();
    for (const synced of [syncedOwner, syncedDeveloper]) {
      assert.deepEqual(synced.accepted, []);
      assert.equal(synced.rejected.length, forgeries.length);
      forgeries.forEach((forgery, index) => {
        const found: Rejection | undefined = synced.rejected[index];
        assert.equal(found?.eventId, forgery.event.id, forgery.label);
        if (forgery.prefix === true) assert.ok(found?.reason.startsWith(forgery.reason), `${forgery.label}: ${found?.reason}`);
        else assert.equal(found?.reason, forgery.reason, forgery.label);
      });
    }
    assert.deepEqual(syncedOwner.rejected, syncedDeveloper.rejected, 'both clients record the very same rejections');

    assert.equal(itemsText(owner.log.state()), itemsBefore, 'the owner board is byte-identical');
    assert.equal(itemsText(developer.log.state()), itemsBefore, 'the developer board is byte-identical');
    assert.equal(withoutRejections(owner.log.state()), beforeOwner);
    assert.equal(withoutRejections(developer.log.state()), beforeDeveloper);
    assert.equal(serialiseState(owner.log.state()), serialiseState(developer.log.state()));
    for (const client of [owner, developer]) {
      const report = await client.log.verifyAll();
      assert.equal(report.rejected.length, forgeries.length);
      assert.deepEqual(report.head, head);
    }

    // The forged files did not block the log: the next honest owner event takes the very next lamport and the developer accepts it.
    const next = await owner.log.append(() => [{ type: 'item.updated', body: { id: 'plan:1-01', changes: { hold: true } } }]);
    assert.equal(next.ok, true, next.ok ? '' : next.reason);
    if (next.ok) assert.equal((next.events[0] as TeamEvent).lamport, head.lamport + 1);
    const after = await developer.log.sync();
    assert.equal(after.accepted.length, 1);
    assert.deepEqual(after.rejected, []);
    assert.equal(developer.log.state().items.get('plan:1-01')?.hold, true);
    assert.equal(serialiseState(owner.log.state()), serialiseState(developer.log.state()));
  });
});
