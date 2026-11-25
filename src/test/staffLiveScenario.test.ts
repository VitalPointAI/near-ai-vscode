// The live scenarios of Phase 33 (D-24, D-34, D-46, D-60 to D-62; criterion 3): two and three people's computers, each with its own store folder and
// device key, share one real hub started as a child process on Node 26 with a temporary state directory and loopback TLS. The replicator, the editor
// binding core, the version acts and the folds run as they do in the product, without the editor UI. In every scenario one person is
// hosted-style: their device certifies a session key, the session key signs their ordinary work and the session answer, and their decisions go
// through an asynchronous person signer. Waits are on status and fold state, never a fixed sleep, except where the hub signs a checkpoint on its own
// timing (an ask at least 10 s after its last ask-signed one). Fictional people and data only.
//
// The real-hub tests follow the D-46 rule: they run with NEAR_AI_HUB_NODE, are skipped with the printed reason without it, and fail in GitHub Actions
// without it. Two defects found in 33-24 are covered end to end here: a proposal's text blob reaches the other computers (every scenario's decision
// needs it), and a device that has not folded a roster change yet does not judge the hub's checkpoint at the new roster head (the roster change).
// A late joiner starts from the hub's checkpoint and a compaction, and once the earlier history is served it folds to what the others fold.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Actor, SealedBlob, SealedEntry } from '../domain/replica/entry';
import { entryHash } from '../domain/replica/entry';
import { rosterView } from '../domain/replica/roster';
import { COMPACTION_WINDOW } from '../domain/replica/textFold';
import type { ProductTextOutput } from '../domain/replica/textFold';
import type { ProductVersions, VersionView } from '../domain/replica/versions';
import { refusalSentence } from '../domain/staff/liveSentences';
import { contestedCards } from '../staff/replica/contested';
import { compactAfterCheckpoint } from '../staff/replica/compactor';
import { EditorBinding } from '../staff/replica/editorBinding';
import { grantCellToHub } from '../staff/replica/hubMembership';
import { SESSION_EXPIRED_SENTENCE } from '../staff/replica/hubSync';
import { appendProductEntry } from '../staff/replica/labelCells';
import type { LiveReplicator, LiveStatus } from '../staff/replica/liveReplicator';
import { ProductEditor } from '../staff/replica/productEditing';
import { productOutput } from '../staff/replica/productFeed';
import type { ReplicaProject } from '../staff/replica/replicaProject';
import { VersionActs } from '../staff/replica/versionActs';
import { FakeBoundDocument } from './helpers/fakeBoundDocument';
import { hubNodeOrSkip, startHubChild } from './helpers/hubChild';
import { createLiveWorld } from './helpers/liveWorld';
import type { LiveDevice, LivePerson, LiveWorld } from './helpers/liveWorld';
import { rng, shuffled } from './helpers/replicaWorld';

const PRODUCT = 'intel-estimate';
const LABEL = 'org/Internal';
const ROLES = { owner: 'j4-planner', sectionLead: 'j4-lead', releaseGuard: 'j4-guard' };
const HEADER = '---\nproduct: intel-estimate\n---\n\n';
const PERSON: Actor = { kind: 'person' };
const OWNER: Actor = { kind: 'agent', member: ROLES.owner, run: 'owner-run' };
const GUARD: Actor = { kind: 'agent', member: ROLES.releaseGuard, run: 'guard-run' };
const HUB_NODE_VERSION = 'v26.13.1';
const WAIT_MS = 30_000;

// ---- waits ----------------------------------------------------------------------------------------------------------------------------------------

/** Resolves when the replicator's status passes the check, or fails after ms with the status it last had. */
function reaches(replicator: LiveReplicator, check: (status: LiveStatus) => boolean, what: string, ms = WAIT_MS): Promise<LiveStatus> {
  return new Promise((resolve, reject) => {
    if (check(replicator.status)) { resolve(replicator.status); return; }
    const timer = setTimeout(() => { listener.dispose(); reject(new Error(`${what}: not within ${ms} ms; last status ${JSON.stringify(replicator.status)}`)); }, ms);
    const listener = replicator.onStatus((status) => {
      if (!check(status)) return;
      clearTimeout(timer);
      listener.dispose();
      resolve(status);
    });
  });
}

const live = (replicator: LiveReplicator, what: string): Promise<LiveStatus> => reaches(replicator, (status) => status.state === 'live', `${what} live`);

/** Polls a read of the local state until it passes the check, or fails after ms with what it last read. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = WAIT_MS): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: not within ${ms} ms; last ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---- reads ----------------------------------------------------------------------------------------------------------------------------------------

async function versionsOn(project: ReplicaProject, stream: string): Promise<ProductVersions | undefined> {
  const { fold } = await project.state();
  return ((fold.families.versions as ProductVersions[] | undefined) ?? []).find((item) => item.product === PRODUCT && item.stream === stream);
}

/** The version with this hash on this computer, once the fold has it. */
async function versionOn(project: ReplicaProject, stream: string, hash: string): Promise<VersionView | undefined> {
  return (await versionsOn(project, stream))?.versions.find((item) => item.hash === hash);
}

/** Waits until the version is in the given state on every computer named. */
async function versionReaches(devices: readonly LiveDevice[], stream: string, hash: string, check: (version: VersionView) => boolean, what: string): Promise<void> {
  for (const device of devices) await eventually(() => versionOn(device.project, stream, hash), (version) => version !== undefined && check(version), `${device.name}: ${what}`);
}

async function textOn(project: ReplicaProject, stream: string): Promise<ProductTextOutput | undefined> {
  return productOutput((await project.state()).fold, stream, PRODUCT);
}

async function digestsOf(project: ReplicaProject): Promise<Record<string, string>> {
  return { ...(await project.state()).fold.digests };
}

/** The contested cards of this computer, with names from its own roster. */
async function contestedOn(project: ReplicaProject) {
  const { fold, roster } = await project.state();
  const view = rosterView(roster);
  return contestedCards((fold.families.versions as ProductVersions[] | undefined) ?? [], (member, at) => view.memberName(member, at));
}

// ---- the world -------------------------------------------------------------------------------------------------------------------------------------

/** The real hub child (its Node version printed and checked) and a world of people connected to it. Skipped by the D-46 rule. */
async function realHub(t: TestContext, people: readonly LivePerson[], run: (world: LiveWorld, hubFile: () => Promise<string>) => Promise<void>): Promise<void> {
  const node = hubNodeOrSkip(t);
  if (node === undefined) return;
  const version = spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim();
  console.log(`the hub child runs on Node ${version}`);
  assert.equal(version, HUB_NODE_VERSION, 'the hub runs on Node 26.13.1');
  const server = await startHubChild(node);
  try {
    const world = await createLiveWorld({ people, hub: { fileText: await server.hubFileText() } });
    try {
      await run(world, () => server.hubFileText());
    } catch (error) {
      console.log(`hub output:\n${server.output().slice(-4000)}`);
      throw error;
    } finally {
      await world.close();
    }
  } finally {
    await server.dispose();
  }
}

/** The product in the Internal label cell, made by the lead; returns its stream. */
async function makeProduct(lead: LiveDevice): Promise<string> {
  const created = await appendProductEntry(lead.host, 'product.create', { product: PRODUCT, section: 'j4', roles: ROLES, title: 'Intelligence estimate' }, { label: LABEL });
  assert.ok(created.ok, created.ok ? undefined : created.message);
  return created.stream;
}

/** One replicator per device, started in order, each live and through its first exchange before the next starts. */
async function goLive(world: LiveWorld, devices: readonly LiveDevice[], extra: (device: LiveDevice) => Parameters<LiveWorld['replicator']>[1] = () => ({})): Promise<LiveReplicator[]> {
  const made: LiveReplicator[] = [];
  for (const device of devices) {
    const log: string[] = [];
    const replicator = world.replicator(device, { log: (line) => log.push(line), ...extra(device) });
    await replicator.start();
    await live(replicator, device.name);
    await eventually(async () => log.includes('exchange stream-open done synced'), Boolean, `${device.name}'s first exchange`);
    made.push(replicator);
  }
  return made;
}

/** The lead types the text through the editing core, proposes it, clears it as the release guard and submits it for the commander's decision. */
async function awaitingDecision(lead: LiveDevice, stream: string, text: string): Promise<string> {
  const editor = await ProductEditor.open(lead.project, { stream, product: PRODUCT, actor: PERSON });
  try {
    editor.insert(0, text);
    assert.deepEqual(await editor.flush(), { appended: 1, queued: 0 });
  } finally {
    editor.close();
  }
  const proposed = await new VersionActs(lead.project, PERSON, { deps: lead.at.deps }).propose({ product: PRODUCT, header: { kind: 'estimate', profile: 'j4', level: 'official' } });
  assert.ok(proposed.ok, proposed.ok ? undefined : proposed.message);
  const cleared = await new VersionActs(lead.project, GUARD).verdict({ product: PRODUCT, hash: proposed.version, gate: 'guard', verdict: 'CLEARED', reasons: ['Checked against the collection plan.'] });
  assert.ok(cleared.ok, cleared.ok ? undefined : cleared.message);
  const submitted = await new VersionActs(lead.project, OWNER).submit({ product: PRODUCT, hash: proposed.version, decisionFor: 'commander' });
  assert.ok(submitted.ok, submitted.ok ? undefined : submitted.message);
  return proposed.version;
}

const ok = <T extends { ok: boolean }>(result: T, what: string): Extract<T, { ok: true }> => {
  assert.ok(result.ok, `${what}: ${(result as { message?: string }).message ?? ''}`);
  return result as Extract<T, { ok: true }>;
};

// ---- Task 1: the tracer ---------------------------------------------------------------------------------------------------------------------------

test('tracer: two people type into bound documents of one product over a real hub, propose, guard and approve on the other\'s computer, and end with equal digests', (t) =>
  realHub(t, [
    { label: 'avery', name: 'Avery Lead' },
    { label: 'blake', name: 'Blake Rivers', roles: ['member', 'decision_for:commander'], agentSeats: [ROLES.releaseGuard] }
  ], async (world) => {
    const started = Date.now();
    const a = world.devices[0];
    const b = await world.hostedStyle(world.devices[1]);
    const stream = await makeProduct(a);
    const [ra, rb] = await goLive(world, [a, b]);
    await eventually(() => versionsOn(b.project, stream), (product) => product !== undefined, 'Blake has the product');

    // Both bind a document of the product, and type interleaved sentences: each round both type before either has the other's change.
    const target = (device: LiveDevice) => ({ project: device.project, stream, product: PRODUCT, actor: PERSON, header: () => HEADER });
    const docA = new FakeBoundDocument(HEADER);
    const docB = new FakeBoundDocument(HEADER);
    const bindA = await EditorBinding.open(docA, target(a), { onAppended: () => ra.localAppended() });
    const bindB = await EditorBinding.open(docB, target(b), { onAppended: () => rb.localAppended() });
    try {
      const sentences: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        const fromA = `Avery ${round}: the bridge is held. `;
        const fromB = `Blake ${round}: the ford is clear. `;
        sentences.push(fromA, fromB);
        docA.type({ offset: docA.getText().length, length: 0, text: fromA });
        docB.type({ offset: HEADER.length, length: 0, text: fromB });
        await Promise.all([bindA.flush(), bindB.flush()]);
        const both = async () => [(await textOn(a.project, stream))?.text, (await textOn(b.project, stream))?.text];
        await eventually(both, ([x, y]) => x !== undefined && x === y && sentences.every((item) => x.includes(item)), `round ${round} converges`);
        await Promise.all([bindA.refresh(), bindB.refresh()]);
      }
      const text = (await textOn(a.project, stream))?.text as string;
      assert.equal(ra.status.state, 'live');
      assert.equal(rb.status.state, 'live');
      assert.equal(docA.getText(), HEADER + text, 'Avery\'s document');
      assert.equal(docB.getText(), HEADER + text, 'Blake\'s document');
      assert.equal(bindA.text(), text, 'Avery\'s shared text');
      assert.equal(bindB.text(), text, 'Blake\'s shared text');
      assert.equal((await textOn(b.project, stream))?.text, text);
      console.log(`two people co-edited ${sentences.length} sentences in ${Date.now() - started} ms`);

      // Avery proposes v1 from the live text; Blake, the release guard, clears it on Blake's computer; Avery submits; Blake, the decision holder,
      // approves on Blake's computer. Every step waits for the other computer to fold the one before, so the proposal's text crossed the hub.
      const proposed = ok(await new VersionActs(a.project, PERSON, { deps: a.at.deps }).propose({ product: PRODUCT, header: { kind: 'estimate', profile: 'j4', level: 'official' } }), 'propose');
      ra.localAppended();
      const hash = proposed.version;
      await versionReaches([b], stream, hash, (version) => version.state === 'draft', 'v1 proposed');
      ok(await new VersionActs(b.project, GUARD).verdict({ product: PRODUCT, hash, gate: 'guard', verdict: 'CLEARED', reasons: ['Sources checked.'] }), 'clear');
      rb.localAppended();
      await versionReaches([a], stream, hash, (version) => version.state === 'guard-checked', 'v1 cleared');
      ok(await new VersionActs(a.project, OWNER).submit({ product: PRODUCT, hash, decisionFor: 'commander' }), 'submit');
      ra.localAppended();
      await versionReaches([b], stream, hash, (version) => version.state === 'awaiting-decision', 'v1 submitted');
      const personCalls = b.session?.person.calls ?? 0;
      const approved = ok(await new VersionActs(b.project, PERSON).decide({ product: PRODUCT, hash, outcome: 'approve', reasons: ['Ready for the commander.'] }), 'approve');
      rb.localAppended();
      assert.equal((b.session?.person.calls ?? 0) - personCalls, 1, 'the decision asked the person signer once');
      await versionReaches([a, b], stream, hash, (version) => version.state === 'approved', 'v1 approved');

      // Equal on both computers: the version record and every stream's state digest.
      assert.deepEqual((await versionsOn(a.project, stream))?.versions, (await versionsOn(b.project, stream))?.versions);
      await eventually(async () => [await digestsOf(a.project), await digestsOf(b.project)], ([x, y]) => JSON.stringify(x) === JSON.stringify(y), 'equal digests');
      // Blake's typing was signed by the session key, Blake's decision by the person key (Blake's device here).
      const own = await b.project.findOwnAll('doc.update', () => true);
      assert.equal(own.length, 0, 'the session key, not the device, signed Blake\'s typing');
      const decision = (await a.project.entriesAfter(stream, b.project.deviceWriter, -1)).find((entry) => entryHash(entry.header) === approved.hash);
      assert.ok(decision, 'Avery holds the decision under Blake\'s person key');
      assert.ok((await a.project.entriesAfter(stream, b.session?.writer as string, -1)).length > 0, 'Avery holds the session key\'s entries');
      console.log(`tracer done in ${Date.now() - started} ms`);
    } finally {
      await bindA.close();
      await bindB.close();
    }
  }));

test('a hosted person whose session key has ended at the real hub shows session-expired, and a decision made then never reaches the others', (t) =>
  realHub(t, [
    { label: 'avery', name: 'Avery Lead', roles: ['member', 'section_lead:j4'], agentSeats: [ROLES.releaseGuard] },
    { label: 'blake', name: 'Blake Rivers', roles: ['member', 'decision_for:commander'] }
  ], async (world) => {
    const a = world.devices[0];
    const stream = await makeProduct(a);
    const hash = await awaitingDecision(a, stream, 'Two companies hold the crossing.');
    const lifetimeMs = 8000;
    const b = await world.hostedStyle(world.devices[1], lifetimeMs);
    const notAfter = Date.parse(b.session?.notAfter as string);
    const [ra, rb] = await goLive(world, [a, b]);
    await versionReaches([b], stream, hash, (version) => version.state === 'awaiting-decision', 'v1 awaiting a decision');
    const pushedBefore = rb.status.pushed;

    // Past the certificate's notAfter by the hub's clock (the real time).
    while (Date.now() <= notAfter + 500) await new Promise((resolve) => setTimeout(resolve, 100));
    const decided = ok(await new VersionActs(b.project, PERSON).decide({ product: PRODUCT, hash, outcome: 'approve', reasons: ['Ready.'] }), 'the decision is kept on Blake\'s computer');
    rb.localAppended();
    rb.syncNow();
    const refused = await reaches(rb, (status) => status.state === 'refused', 'Blake refused');
    assert.equal(refused.reason, 'session-expired');
    assert.equal(refusalSentence(refused.reason), SESSION_EXPIRED_SENTENCE);
    assert.equal(rb.status.pushed, pushedBefore, 'nothing more was pushed');

    // Avery exchanges again: the decision is not at the hub, so v1 still waits for a decision on Avery's computer.
    const synced = ra.status.lastSyncedAt ?? 0;
    ra.syncNow();
    await reaches(ra, (status) => (status.lastSyncedAt ?? 0) > synced, 'Avery exchanged again');
    assert.deepEqual([...await a.project.holds([decided.hash])], []);
    assert.equal((await versionOn(a.project, stream, hash))?.state, 'awaiting-decision');
    // A session that has ended waits for the person to sign in again: it does not try again by itself.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(rb.status.state, 'refused');
    assert.equal(rb.status.retryAt, undefined);
  }));

// ---- Task 2: three people; a roster change under a checkpoint -----------------------------------------------------------------------------------

test('contested: an approval made offline and a rejection made online show contested with both names and reasons on all three computers until a fresh decision settles it everywhere', (t) =>
  realHub(t, [
    { label: 'avery', name: 'Avery Lead', roles: ['member', 'section_lead:j4', 'decision_for:commander'], agentSeats: [ROLES.releaseGuard] },
    { label: 'blake', name: 'Blake Rivers', roles: ['member', 'decision_for:commander'] },
    { label: 'casey', name: 'Casey Moor', roles: ['member', 'decision_for:commander'] }
  ], async (world) => {
    const started = Date.now();
    const a = world.devices[0];
    const b = world.devices[1];
    const c = await world.hostedStyle(world.devices[2]);
    const stream = await makeProduct(a);
    const hash = await awaitingDecision(a, stream, 'Resupply by road before the thaw.');
    const [ra, rb, rc] = await goLive(world, [a, b, c]);
    const everyone = [a, b, c];
    await versionReaches(everyone, stream, hash, (version) => version.state === 'awaiting-decision', 'v1 awaiting a decision');

    // Avery goes offline for real and approves; Blake, online, rejects. Neither saw the other's decision.
    await world.goOffline(a);
    assert.equal(ra.status.state, 'single-machine');
    ok(await new VersionActs(a.project, PERSON).decide({ product: PRODUCT, hash, outcome: 'approve', reasons: ['The road is open.'] }), 'Avery approves offline');
    ok(await new VersionActs(b.project, PERSON).decide({ product: PRODUCT, hash, outcome: 'reject', reasons: ['The bridge is out.'] }), 'Blake rejects online');
    rb.localAppended();
    await versionReaches([c], stream, hash, (version) => version.state === 'rejected', 'Casey sees the rejection');
    await world.goOnline(a);
    await live(ra, 'Avery again');

    const contested = (version: VersionView): boolean => version.decision.status === 'contested';
    await versionReaches(everyone, stream, hash, contested, 'v1 contested');
    for (const device of everyone) {
      const [card, ...more] = await contestedOn(device.project);
      assert.equal(more.length, 0);
      assert.ok(card, `${device.name} has the contested card`);
      assert.deepEqual(card.decisions.map((item) => [item.name, item.outcome, item.reasons]).sort(), [
        ['Avery Lead', 'approve', ['The road is open.']],
        ['Blake Rivers', 'reject', ['The bridge is out.']]
      ], `${device.name}'s card`);
    }

    // Casey, a decision holder in a hosted session, settles it with a fresh approval that lists both decisions.
    const disputed = (await versionOn(c.project, stream, hash))?.decision.contested ?? [];
    const calls = c.session?.person.calls ?? 0;
    const settled = ok(await new VersionActs(c.project, PERSON).decide({ product: PRODUCT, hash, outcome: 'approve', reasons: ['The road is open; the bridge is not needed.'], settle: true }), 'Casey settles');
    assert.equal((c.session?.person.calls ?? 0) - calls, 1);
    const written = (await c.project.entriesAfter(stream, c.project.deviceWriter, -1)).find((entry) => entryHash(entry.header) === settled.hash);
    assert.ok(written, 'the settlement is signed by Casey\'s person key');
    const [mine] = await c.project.findOwnAll('version.decide', () => true);
    assert.deepEqual([...(mine?.data as { decisionsSeen: string[] }).decisionsSeen].sort(), [...disputed].sort(), 'the settlement lists both decisions');
    rc.localAppended();
    await versionReaches(everyone, stream, hash, (version) => version.state === 'approved' && version.decision.status === 'effective', 'v1 approved and settled');
    for (const device of everyone) assert.deepEqual(await contestedOn(device.project), [], `${device.name} has no contested card`);
    await eventually(async () => Promise.all(everyone.map((device) => digestsOf(device.project))), (all) => all.every((item) => JSON.stringify(item) === JSON.stringify(all[0])), 'equal digests on all three');
    console.log(`contested and settled in ${Date.now() - started} ms`);
  }));

test('roster change: a person admitted while two others are live, then a checkpoint at the new roster head, leaves every computer live with no finding', (t) =>
  realHub(t, [{ label: 'avery', name: 'Avery Lead' }, { label: 'blake', name: 'Blake Rivers' }], async (world) => {
    const a = world.devices[0];
    const b = await world.hostedStyle(world.devices[1]);
    const hub = world.hub as NonNullable<LiveWorld['hub']>;
    const [ra, rb] = await goLive(world, [a, b]);
    await world.join({ label: 'casey', name: 'Casey Moor' });
    ra.localAppended();
    const head = async (): Promise<string | undefined> => (await a.project.state()).roster.positions.at(-1);
    const newest = async (device: LiveDevice): Promise<string | undefined> => (await device.memory.load(hub.writer, device.project.projectId)).newest?.payload.rosterHead;
    // Each exchange asks for a checkpoint; the hub signs one at least 10 s after its last ask-signed one.
    const started = Date.now();
    const deadline = Date.now() + 40_000;
    while ((await newest(b)) !== (await head())) {
      if (Date.now() > deadline) assert.fail(`no checkpoint at the new roster head reached Blake; ${JSON.stringify(rb.status)}`);
      ra.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log(`a checkpoint at the new roster head reached Blake ${Date.now() - started} ms after the admission`);
    for (const [replicator, name] of [[ra, 'Avery'], [rb, 'Blake']] as const) {
      replicator.syncNow();
      await live(replicator, name);
      assert.deepEqual(replicator.status.findings, [], `${name} has no finding`);
    }
  }));

test('late joiner: after 60 accepted updates and a hub checkpoint the compactor writes doc.compact; a person who joins starts from the checkpoint, pulls fewer entries than the full history and holds nothing back, and once the earlier history is served has the same text, digests and roster', (t) =>
  realHub(t, [
    { label: 'avery', name: 'Avery Lead' },
    { label: 'blake', name: 'Blake Rivers' }
  ], async (world) => {
    const started = Date.now();
    const a = world.devices[0];
    const b = await world.hostedStyle(world.devices[1]);
    const hub = world.hub as NonNullable<LiveWorld['hub']>;
    const stream = await makeProduct(a);
    // The lead gives the server the product's cell (the trade-off confirmed, D-40): the server checkpoints only the cells it holds, and a
    // compaction is made from a checkpointed prefix, so a late joiner starts from a compaction only in such a cell (D-43, D-63).
    const granted = await grantCellToHub(a.host, { cell: stream, confirmed: true });
    assert.ok(granted.ok, granted.message);
    // Avery's computer runs the compactor after each newer checkpoint, as the live engine does.
    const compacted: string[] = [];
    const holder: { ra?: LiveReplicator } = {};
    const [ra, rb] = await goLive(world, [a, b], (device) => (device !== a ? {} : {
      onCheckpoint: () => {
        void compactAfterCheckpoint(a.project, { hub: hub.writer, memory: a.memory }).then((result) => {
          compacted.push(...result.compacted);
          if (result.compacted.length > 0) holder.ra?.localAppended();
        });
      }
    }));
    holder.ra = ra;

    // Sixty accepted updates of the product, one at a time, in one editing session.
    const first = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON }, { onAppended: () => ra.localAppended() });
    try {
      for (let index = 0; index < 60; index += 1) {
        first.insert(first.text().length, `Line ${index}: the column moves at dawn. `);
        assert.deepEqual(await first.flush(), { appended: 1, queued: 0 });
      }
    } finally {
      first.close();
    }
    assert.ok(60 >= COMPACTION_WINDOW);
    const sixty = (await textOn(a.project, stream))?.text as string;
    await eventually(async () => (await textOn(b.project, stream))?.text, (text) => text === sixty, 'Blake has the sixty updates');

    // The hub signs a checkpoint on an ask at least 10 s after its last ask-signed one; each exchange asks. Wait for Avery's doc.compact.
    const waitStarted = Date.now();
    const deadline = Date.now() + 90_000;
    while ((await a.project.findOwnAll('doc.compact', () => true)).length === 0) {
      if (Date.now() > deadline) assert.fail(`no doc.compact within 90 s; ${JSON.stringify(ra.status)}`);
      ra.syncNow();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    console.log(`doc.compact written ${Date.now() - waitStarted} ms after the sixtieth update`);
    assert.deepEqual(compacted, [PRODUCT]);
    await eventually(async () => (await textOn(b.project, stream))?.compactions.length ?? 0, (count) => count >= 1, 'Blake has the compaction');

    // A later editing session (it registers its own client id after the compaction) adds three more lines, and a checkpoint covers them.
    const later = await ProductEditor.open(a.project, { stream, product: PRODUCT, actor: PERSON }, { onAppended: () => ra.localAppended() });
    try {
      for (let index = 60; index < 63; index += 1) {
        later.insert(later.text().length, `Line ${index}: the river is fordable. `);
        await later.flush();
      }
    } finally {
      later.close();
    }
    const finalText = (await textOn(a.project, stream))?.text as string;
    await eventually(async () => (await textOn(b.project, stream))?.text, (text) => text === finalText, 'Blake has the later updates');

    // Dana joins by the Phase 31 flow; once Avery's replicator has pushed the admission, Dana's replicator starts from the checkpoint base.
    const pushed = ra.status.pushed;
    const d = await world.join({ label: 'dana', name: 'Dana Late' });
    ra.localAppended();
    await reaches(ra, (status) => status.pushed > pushed, 'Avery pushed the admission');
    const joinedAt = Date.now();
    const rd = world.replicator(d, { startFromBase: true });
    await rd.start();
    await live(rd, 'Dana');
    // Dana's logs of the product cell start at the checkpoint's heads: the compaction, the later session's registration and its three updates.
    await eventually(async () => (await textOn(d.project, stream))?.accepted.length ?? 0, (count) => count === 3, 'Dana holds the later updates');
    const full = (await a.project.heads()).reduce((sum, row) => sum + row.heads.reduce((inner, head) => inner + head.seq + 1, 0), 0);
    console.log(`late joiner: pulled ${rd.status.pulled} entries of ${full} in the full history, in ${Date.now() - joinedAt} ms`);
    assert.ok(rd.status.pulled < full, `Dana pulled ${rd.status.pulled} entries, the full history is ${full}`);
    const joined = await d.project.state();
    assert.equal(joined.fold.held.filter((item) => item.stage === 'chain').length, 0, 'nothing waits for an earlier entry: the checkpoint is the base');
    assert.ok(joined.fold.checkpoint !== null, 'Dana folds under the hub\'s checkpoint');
    assert.deepEqual(joined.roster.positions, (await a.project.state()).roster.positions, 'Dana has the whole roster');
    // The compaction's text names clients registered before the checkpoint, so it counts only once their registrations arrive (D-42, CR-01): the
    // text is complete when the earlier history is served below (G430).

    // The earlier history is served afterwards, in shuffled pieces: Dana then folds the same entries to the same digests and roster as Avery.
    await rd.stop();
    const missing: SealedEntry[] = [];
    for (const row of await a.project.heads()) {
      for (const head of row.heads) {
        const log = await a.project.entriesAfter(row.stream, head.writer, -1);
        const held = await d.project.holds(log.map((entry) => entryHash(entry.header)));
        missing.push(...log.filter((entry) => !held.has(entryHash(entry.header))));
      }
    }
    const cited = await a.project.blobsCitedBy(missing.map((entry) => entryHash(entry.header)));
    const blobs: SealedBlob[] = [];
    for (const hash of new Set(cited.map((item) => item.blob))) {
      const blob = await a.project.blob(hash);
      if (blob !== undefined) blobs.push(blob);
    }
    const pieces = shuffled(missing, rng(33));
    const third = Math.ceil(pieces.length / 3);
    for (let at = 0; at < pieces.length; at += third) await d.project.ingestForeign(pieces.slice(at, at + third), blobs);
    const [aState, dState] = [await a.project.state(), await d.project.state()];
    assert.deepEqual(dState.roster.positions, aState.roster.positions, 'the same roster');
    for (const [name, digest] of Object.entries(dState.fold.digests)) assert.equal(digest, aState.fold.digests[name], `the digest of ${name === stream ? 'the product cell' : name}`);
    assert.equal(dState.fold.digests[stream], aState.fold.digests[stream]);
    assert.equal(dState.fold.checkpoint, aState.fold.checkpoint, 'both fold under the same checkpoint');
    const served = productOutput(dState.fold, stream, PRODUCT);
    assert.equal(served?.text, finalText, 'the same text');
    assert.ok((served?.compactions.length ?? 0) >= 1, 'with the compaction');

    for (const [replicator, name] of [[ra, 'Avery'], [rb, 'Blake']] as const) {
      replicator.syncNow();
      await live(replicator, name);
      assert.deepEqual(replicator.status.findings, [], `${name} has no finding`);
    }
    console.log(`late joiner scenario done in ${Date.now() - started} ms`);
  }));
