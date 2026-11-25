// A world of people's computers for the live replicator tests (Phase 33, D-34): each person has an install of their own (project folder, extension
// storage, secret storage, so a device key of their own made by the usual identity flow and kept only in that secret store), the lead makes the
// shared project and declares a clearance, connects it to your organization's server from the operator's hub file when one is given, and brings
// every other person in by the Phase 31 flow (invitation, join request, admission with the words confirmed, welcome file). Nothing writes a roster
// entry by hand. Clocks follow the real time, because a real hub checks session answers and hub files against its own clock.
//
// FakeTimers is a manual clock with setTimeout and clearTimeout for the replicator's timers (Task 2). Fictional people and data only; no key text.
//
// The scenarios of 33-14 add: roles and agent seats per person, a person brought in after the world was made (the late joiner), a person going
// offline for real (the replicator stopped and every transport call refused unreachable) and back, and a hosted-style person (D-60 to D-62): the
// person's own device certifies a session key, the session key signs ordinary work and the session answer, and decisions go through an
// asynchronous person signer over the device key, with no OpenBao.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { entryHash } from '../../domain/replica/entry';
import type { SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { sessionCertifyData } from '../../domain/replica/sessionKeys';
import type { AsyncPayloadSigner, PayloadSigner } from '../../domain/team/signedPayload';
import { readHubFile } from '../../domain/replica/hubFile';
import { hubMemoryOf } from '../../staff/replica/hubSync';
import type { HubMemory, SyncLocal } from '../../staff/replica/hubSync';
import { connectProjectToHub } from '../../staff/replica/hubMembership';
import { HubTransport, HubTransportError } from '../../staff/replica/hubTransport';
import type { HubTransportOptions } from '../../staff/replica/hubTransport';
import { LiveReplicator } from '../../staff/replica/liveReplicator';
import type { LiveReplicatorOptions, LiveTimers, LiveTransport } from '../../staff/replica/liveReplicator';
import { admitJoinRequest, cellOrderHook, inviteToProject, joinFromInvite, openWelcome, updateMember } from '../../staff/replica/membership';
import type { MembershipResult, SharedProjectHost } from '../../staff/replica/membership';
import { ReplicaProject, isProjectRefused, syncLocalOf } from '../../staff/replica/replicaProject';
import type { ProjectRefused, ReplicaProjectDeps } from '../../staff/replica/replicaProject';
import { MemorySecrets, orgClearance } from './labelCellWorld';
import { createFakeTransport } from './replicaFakeTransport';
import { fixedSigner } from './replicaWorld';

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
  /** A hosted-style person's session key and its certificate (D-62); absent for a device on its own key. */
  session?: LiveSession;
}

/** A hosted-style person's session: the session key, its session.certify entry, its notAfter, and the person signer's call count. */
export interface LiveSession { signer: PayloadSigner; writer: string; certificate: SealedEntry; notAfter: string; person: AsyncPayloadSigner & { calls: number } }

/** One person of a world: roles and agent seats are written by the lead once the person is in (the lead's own replace its defaults). */
export interface LivePerson { label: string; name: string; roles?: string[]; agentSeats?: string[] }

export interface LiveWorld {
  devices: LiveDevice[];
  lead: LiveDevice;
  hub: LiveHub | undefined;
  /** A replicator for one device, connected to the world's hub (its address unless told otherwise), with the options given. */
  replicator(device: LiveDevice, options?: Partial<LiveReplicatorOptions>): LiveReplicator;
  /** Brings one more person in by the Phase 31 flow, after the world was made (a late joiner). */
  join(person: LivePerson): Promise<LiveDevice>;
  /** Offline for real: the device's replicators stop, and every transport call it makes refuses unreachable until goOnline. */
  goOffline(device: LiveDevice): Promise<void>;
  /** Back online: the device's replicators start again. */
  goOnline(device: LiveDevice): Promise<void>;
  /**
   * Makes a person hosted-style: their device certifies a session key valid for lifetimeMs, and the project is opened again over the same folder with
   * the session key for ordinary work and an asynchronous person signer over the device key for decisions. The device is replaced in devices.
   */
  hostedStyle(device: LiveDevice, lifetimeMs?: number): Promise<LiveDevice>;
  /** Stops every replicator made and closes every project. */
  close(): Promise<void>;
}

/** An asynchronous person signer over a key, counting its calls (D-60: your organization's key store signs over the network). */
export function asyncPersonSigner(signer: PayloadSigner): AsyncPayloadSigner & { calls: number } {
  const wrapped = {
    calls: 0,
    fingerprint: signer.fingerprint,
    publicKey: signer.publicKey,
    sign: async (bytes: Buffer): Promise<string> => {
      wrapped.calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return signer.sign(bytes);
    }
  };
  return wrapped;
}

/** A transport whose every call refuses unreachable: the computer is offline. */
function unreachable(options: HubTransportOptions): LiveTransport {
  const refuse = (): Promise<never> => Promise.reject(new HubTransportError('unreachable'));
  return {
    project: options.project, hub: options.hub, hubHeads: refuse, entries: refuse, append: refuse, getBlob: refuse, grant: refuse, askCheckpoint: refuse,
    events: refuse, postPresence: refuse, leavePresence: refuse, close: () => undefined
  } as unknown as LiveTransport;
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
export async function createLiveWorld(options: { people: readonly LivePerson[]; hub?: { fileText: string } }): Promise<LiveWorld> {
  assert.ok(options.people.length >= 1, 'a world has at least the lead');
  const [first, ...others] = options.people;
  const leadAt = liveInstall(first.label);
  const leadProject = opened(await ReplicaProject.createSharedProject(leadAt.root, leadAt.deps, {
    name: 'Exercise Northwind', profile: 'j4', level: 'official', labelMapHash: 'c'.repeat(64), lead: { member: LIVE_LEAD_MEMBER }
  }), 'the lead makes the shared project');
  const leadHost: SharedProjectHost = { project: leadProject, deps: leadAt.deps };
  done(await updateMember(leadHost, {
    member: LIVE_LEAD_MEMBER, name: first.name, roles: first.roles ?? ['member', 'section_lead:j4'], clearance: orgClearance('Confidential'),
    ...(first.agentSeats === undefined ? {} : { agentSeats: first.agentSeats })
  }), 'the lead declares a clearance');
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
  const bringIn = async (person: LivePerson): Promise<LiveDevice> => {
    const at = liveInstall(person.label);
    const invited = done(await inviteToProject(leadHost, { name: person.name, seat: 'j4-planner', clearance: orgClearance('Internal') }), `invite ${person.name}`);
    const joined = done(await joinFromInvite(at.root, at.deps, fileText(invited), { name: person.name }), `${person.name} answers`);
    const admitted = done(await admitJoinRequest(leadHost, fileText(joined), { codeMatched: true }), `admit ${person.name}`);
    const member = admitted.member as string;
    if (person.roles !== undefined || person.agentSeats !== undefined) {
      done(await updateMember(leadHost, {
        member, ...(person.roles === undefined ? {} : { roles: person.roles }), ...(person.agentSeats === undefined ? {} : { agentSeats: person.agentSeats })
      }), `${person.name}'s roles`);
    }
    const welcomed = done(await openWelcome(at.root, at.deps, fileText(admitted)), `${person.name} opens the welcome`);
    const made = device(person.label, person.name, member, at, opened(welcomed.project, `${person.name}'s project opens`));
    devices.push(made);
    return made;
  };
  for (const person of others) await bringIn(person);

  const replicators: Array<{ label: string; replicator: LiveReplicator }> = [];
  const offline = new Set<string>();
  const replaced: ReplicaProject[] = [];
  const mine = (target: LiveDevice): LiveReplicator[] => replicators.filter((item) => item.label === target.label).map((item) => item.replicator);
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
        signer: target.session?.signer ?? target.project.signer,
        ...(target.session === undefined ? {} : { certificate: target.session.certificate }),
        open: (settings) => (offline.has(target.label) ? unreachable(settings) : new HubTransport(settings)),
        ...extra
      });
      replicators.push({ label: target.label, replicator });
      return replicator;
    },
    join: bringIn,
    async goOffline(target) {
      offline.add(target.label);
      for (const replicator of mine(target)) await replicator.stop();
    },
    async goOnline(target) {
      offline.delete(target.label);
      for (const replicator of mine(target)) await replicator.start();
    },
    async hostedStyle(target, lifetimeMs = 12 * 60 * 60 * 1000) {
      const { roster } = await target.project.state();
      const slot = roster.members.devices.get(target.project.deviceWriter)?.find((record) => record.slot !== undefined)?.slot;
      assert.ok(slot !== undefined, `${target.name}'s device has a slot`);
      const key = fixedSigner(`LIVE-SESSION-${target.label}-${Date.now()}`);
      const notAfter = new Date(Date.now() + lifetimeMs).toISOString();
      const data = sessionCertifyData({ project: target.project.projectId, member: target.member, device: target.project.deviceWriter, sessionKey: key.publicKey, slot, notAfter },
        (bytes) => key.signer.sign(bytes));
      const certified = await target.project.appendOwn('session.certify', data);
      assert.ok('ok' in certified, 'ok' in certified ? '' : certified.message);
      const person = asyncPersonSigner(target.project.signer);
      const hosted = opened(await ReplicaProject.open(target.at.root, { ...target.at.deps, sessionSigner: key.signer, personSigner: person }), `${target.name}'s hosted session opens`);
      replaced.push(target.project);
      const made: LiveDevice = {
        ...device(target.label, target.name, target.member, target.at, hosted),
        session: { signer: key.signer, writer: key.writer, certificate: certified.built.entry, notAfter, person }
      };
      devices[devices.indexOf(target)] = made;
      return made;
    },
    async close() {
      for (const { replicator } of replicators) await replicator.stop();
      for (const item of [...devices.map((entry) => entry.project), ...replaced]) await item.close();
    }
  };
}

/**
 * Carries one device's own entries and their blobs to another device through the fake transport, leaving out the entries whose
 * hash is in `withhold`, and stores them on the other device through its decode check. A test holds back an entry to deliver it later.
 */
export async function carryThroughFake(from: LiveDevice, to: LiveDevice, stream: string, withhold: ReadonlySet<string> = new Set()): Promise<void> {
  const writer = from.project.deviceWriter;
  const entries = (await from.project.entriesAfter(stream, writer, -1)).filter((entry) => !withhold.has(entryHash(entry.header)));
  const transport = createFakeTransport();
  const references = await from.project.blobsCitedBy(entries.map((entry) => entryHash(entry.header)));
  const blobs: SealedBlob[] = [];
  for (const hash of new Set(references.map(({ blob }) => blob))) {
    const blob = await from.project.blob(hash);
    assert.ok(blob, 'the sender holds its cited blob');
    blobs.push(blob);
  }
  const pushed = await transport.push(entries, blobs);
  assert.equal(pushed.refused.length, 0, 'the fake transport takes every entry');
  const pulled: SealedEntry[] = [];
  const pulledBlobs: SealedBlob[] = [];
  for await (const item of transport.pull([{ stream, writer, fromSeq: 0 }])) {
    if ('header' in item) pulled.push(item);
    else pulledBlobs.push(item);
  }
  assert.equal(pulled.length, entries.length);
  const stored = await to.project.ingestForeign(pulled, pulledBlobs);
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
