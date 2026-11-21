// A world of people's computers for the live replicator tests (Phase 33, D-34): each person has an install of their own (project folder, extension
// storage, secret storage, so a device key of their own made by the usual identity flow and kept only in that secret store), the lead makes the
// shared project and declares a clearance, connects it to your organization's server from the operator's hub file when one is given, and brings
// every other person in by the Phase 31 flow (invitation, join request, admission with the words confirmed, welcome file). Nothing writes a roster
// entry by hand. Clocks follow the real time, because a real hub checks session answers and hub files against its own clock.
//
// FakeTimers is a manual clock with setTimeout and clearTimeout for the replicator's timers (Task 2). Fictional people and data only; no key text.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { entryHash } from '../../domain/replica/entry';
import type { SealedEntry } from '../../domain/replica/entry';
import { readHubFile } from '../../domain/replica/hubFile';
import { hubMemoryOf } from '../../staff/replica/hubSync';
import type { HubMemory, SyncLocal } from '../../staff/replica/hubSync';
import { connectProjectToHub } from '../../staff/replica/hubMembership';
import { LiveReplicator } from '../../staff/replica/liveReplicator';
import type { LiveReplicatorOptions, LiveTimers } from '../../staff/replica/liveReplicator';
import { admitJoinRequest, cellOrderHook, inviteToProject, joinFromInvite, openWelcome, updateMember } from '../../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../../staff/replica/membership';
import { ReplicaProject, isProjectRefused, syncLocalOf } from '../../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../../staff/replica/replicaProject';
import { MemorySecrets, orgClearance } from './labelCellWorld';
import { createFakeTransport } from './replicaFakeTransport';

export interface LiveInstall { root: string; global: string; secrets: MemorySecrets; deps: ReplicaProjectDeps }

/** One install of one person, on its own folders and secret store, with the real clock. */
export function liveInstall(label: string): LiveInstall {
  const base = mkdtempSync(path.join(tmpdir(), `near-ai-live-${label}-`));
  const secrets = new MemorySecrets();
  const global = path.join(base, 'global');
  const now = (): Date => new Date();
  return { root: path.join(base, 'project'), global, secrets, deps: { secrets, globalStorageDir: global, now, cellOrder: cellOrderHook({ now }) } };
}

/** The hub a world is connected to, as its hub file names it. */
export interface LiveHub { id: string; writer: string; certPin: string; address: string }

export interface LiveDevice {
  label: string;
  name: string;
  member: string;
  at: LiveInstall;
  project: ReplicaProject;
  host: SharedProjectHost;
  local: SyncLocal;
  memory: HubMemory;
}

export interface LiveWorld {
  devices: LiveDevice[];
  lead: LiveDevice;
  hub: LiveHub | undefined;
  /** A replicator for one device, connected to the world's hub (its address unless told otherwise), with the options given. */
  replicator(device: LiveDevice, options?: Partial<LiveReplicatorOptions>): LiveReplicator;
  /** Stops every replicator made and closes every project. */
  close(): Promise<void>;
}

export const LIVE_LEAD_MEMBER = 'mbr-lead';

function done<T extends MembershipResult>(result: T, what: string): T {
  assert.equal(result.ok, true, `${what}: ${result.reason ?? ''} ${result.message}`);
  return result;
}

function opened(value: ReplicaProject | ProjectRefused | undefined, what: string): ReplicaProject {
  assert.ok(value instanceof ReplicaProject, `${what} (${isProjectRefused(value) ? value.refused : String(value)})`);
  return value;
}

function fileText(result: MembershipResult): string {
  assert.ok(result.file !== undefined, 'the result carries a file');
  return result.file.text;
}

/**
 * The lead (the first person) and everyone else, brought in by the Phase 31 flow. With a hub file, the lead connects the project to your
 * organization's server (admit and enrol) before anyone else joins, so every welcome already names the hub.
 */
export async function createLiveWorld(options: { people: ReadonlyArray<{ label: string; name: string }>; hub?: { fileText: string } }): Promise<LiveWorld> {
  assert.ok(options.people.length >= 1, 'a world has at least the lead');
  const [first, ...others] = options.people;
  const leadAt = liveInstall(first.label);
  const leadProject = opened(await ReplicaProject.createSharedProject(leadAt.root, leadAt.deps, {
    name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LIVE_LEAD_MEMBER }
  }), 'the lead makes the shared project');
  const leadHost: SharedProjectHost = { project: leadProject, deps: leadAt.deps };
  done(await updateMember(leadHost, { member: LIVE_LEAD_MEMBER, roles: ['member', 'section_lead:j4'], clearance: orgClearance('Confidential') }), 'the lead declares a clearance');
  const device = (label: string, name: string, member: string, at: LiveInstall, project: ReplicaProject): LiveDevice => ({
    label, name, member, at, project, host: { project, deps: at.deps }, local: syncLocalOf(project), memory: hubMemoryOf(at.secrets)
  });
  const lead = device(first.label, first.name, LIVE_LEAD_MEMBER, leadAt, leadProject);

  let hub: LiveHub | undefined;
  if (options.hub !== undefined) {
    const read = readHubFile(options.hub.fileText, new Date());
    assert.ok(read.ok, read.ok ? '' : read.message);
    done(await connectProjectToHub(leadHost, options.hub.fileText, { ceiling: orgClearance('Internal') }), 'the lead connects the project to your organization\'s server');
    hub = { id: read.hubFile.hub, writer: read.hubFile.writer, certPin: read.hubFile.certPin, address: read.hubFile.address };
  }

  const devices: LiveDevice[] = [lead];
  for (const person of others) {
    const at = liveInstall(person.label);
    const invited = done(await inviteToProject(leadHost, { name: person.name, seat: 'j4-planner', clearance: orgClearance('Internal') }), `invite ${person.name}`);
    const joined = done(await joinFromInvite(at.root, at.deps, fileText(invited), { name: person.name }), `${person.name} answers`);
    const admitted = done(await admitJoinRequest(leadHost, fileText(joined), { codeMatched: true }), `admit ${person.name}`);
    const welcomed = done(await openWelcome(at.root, at.deps, fileText(admitted)), `${person.name} opens the welcome`);
    devices.push(device(person.label, person.name, admitted.member as string, at, opened(welcomed.project, `${person.name}'s project opens`)));
  }

  const replicators: LiveReplicator[] = [];
  return {
    devices,
    lead,
    hub,
    replicator(target, extra = {}) {
      const address = hub?.address;
      const replicator = new LiveReplicator({
        local: target.local,
        memory: target.memory,
        hub: hub === undefined ? undefined : { id: hub.id, writer: hub.writer, certPin: hub.certPin },
        address: () => Promise.resolve(address),
        signer: target.project.signer,
        ...extra
      });
      replicators.push(replicator);
      return replicator;
    },
    async close() {
      for (const replicator of replicators) await replicator.stop();
      for (const item of devices) await item.project.close();
    }
  };
}

/**
 * Carries one device's own entries of one stream to another device through the fake transport (pushed, then pulled), leaving out the entries whose
 * hash is in `withhold`, and stores them on the other device through its decode check. A test holds back an entry to deliver it later.
 */
export async function carryThroughFake(from: LiveDevice, to: LiveDevice, stream: string, withhold: ReadonlySet<string> = new Set()): Promise<void> {
  const writer = from.project.deviceWriter;
  const entries = (await from.project.entriesAfter(stream, writer, -1)).filter((entry) => !withhold.has(entryHash(entry.header)));
  const transport = createFakeTransport();
  const pushed = await transport.push(entries, []);
  assert.equal(pushed.refused.length, 0, 'the fake transport takes every entry');
  const pulled: SealedEntry[] = [];
  for await (const item of transport.pull([{ stream, writer, fromSeq: 0 }])) if ('header' in item) pulled.push(item);
  assert.equal(pulled.length, entries.length);
  const stored = await to.project.ingestForeign(pulled, []);
  assert.ok(!isProjectRefused(stored), 'the entries are taken');
}

/** A manual clock: timers run only when the test advances time, in deadline order. */
export class FakeTimers implements LiveTimers {
  private current: number;
  private nextId = 1;
  private readonly due = new Map<number, { at: number; run: () => void }>();

  public constructor(start = Date.parse('2026-11-21T09:00:00.000Z')) {
    this.current = start;
  }

  public now(): number {
    return this.current;
  }

  public date(): Date {
    return new Date(this.current);
  }

  public setTimeout(run: () => void, ms: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.due.set(id, { at: this.current + Math.max(0, ms), run });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.due.delete(handle);
  }

  /** How many timers wait. */
  public get pending(): number {
    return this.due.size;
  }

  /** The time the next timer is due, or undefined. */
  public get nextAt(): number | undefined {
    let first: number | undefined;
    for (const item of this.due.values()) if (first === undefined || item.at < first) first = item.at;
    return first;
  }

  /** Moves the clock forward by ms, running each timer that falls due on the way (and the promise work it starts) in order. */
  public async advance(ms: number): Promise<void> {
    const until = this.current + ms;
    for (;;) {
      let pick: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.due) if (entry[1].at <= until && (pick === undefined || entry[1].at < pick[1].at)) pick = entry;
      if (pick === undefined) break;
      this.due.delete(pick[0]);
      this.current = Math.max(this.current, pick[1].at);
      pick[1].run();
      await settle();
    }
    this.current = until;
    await settle();
  }
}

/** Lets promise work started by a timer run to its next real wait. */
export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
