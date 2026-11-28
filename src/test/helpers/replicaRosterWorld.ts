// A small world for the roster and key tests (Phase 31 WP-R1): devices with deterministic Ed25519 and X25519 keys, a generic signed entry writer with
// per-(stream, writer) chains, roster entries that cite rosterPrev, cell grants, the pinned anchor, foldRoster and a ReplicaContext over the real roster
// view. No key literal lives in any file: every key is derived from a label. Plans 31-14 to 31-17 build on this file without editing it in wave 6;
// builders they need beyond it live in their own test files.
import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { GENESIS_PREV, buildEntry, writerIdOf } from '../../domain/replica/entry';
import type { Actor, Dep, NewBody, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { buildGrant, grantHash, unwrapEpochKey, wrapEpochKey, x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '../../domain/replica/cellKeys';
import type { CellGrant } from '../../domain/replica/cellKeys';
import { ORIGIN_ROSTER, foldRoster, rosterView } from '../../domain/replica/roster';
import type { RosterAnchor, RosterState } from '../../domain/replica/roster';
import type { KeyRing, ReplicaContext } from '../../domain/replica/rosterView';
import type { PayloadSigner, SignedPayload } from '../../domain/team/signedPayload';
import { WORLD_AT, WORLD_NOW, epochKey, fixedSigner, streamId } from './replicaWorld';
import type { Written } from './replicaWorld';

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

export const ROSTER_NOW = WORLD_NOW;
export const ROSTER_AT = WORLD_AT;
// An invitation written at ROSTER_AT expires a week later (D-14 default).
export const INVITE_EXPIRES = '2026-11-26T11:00:00.000Z';
export const DEMO_CLEARANCE = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };

export interface DeviceDescriptor { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot: number }

export interface RosterDevice {
  label: string;
  member: string;
  signer: PayloadSigner;
  publicKey: string;
  writer: string;
  // The raw X25519 public key as base64url, and the private key the device keeps (in tests only; the host keeps it in SecretStorage).
  x25519: string;
  x25519Private: KeyObject;
  // The device's Ed25519 signature binding its X25519 key to its writer id (D-19).
  x25519Sig: string;
  descriptor(slot: number): DeviceDescriptor;
}

/** A synthetic device with a label-derived encryption key and an optional fixture identity. */
export function rosterDevice(label: string, member: string, signer = fixedSigner(label).signer): RosterDevice {
  const { publicKey } = signer;
  const writer = writerIdOf(publicKey);
  const x25519Private = x25519PrivateFromSeed(sha256(`x25519/${label}`));
  const x25519 = x25519PublicRaw(x25519Private).toString('base64url');
  const x25519Sig = signer.sign(x25519BindingBytes(x25519, writer));
  return {
    label,
    member,
    signer,
    publicKey,
    writer,
    x25519,
    x25519Private,
    x25519Sig,
    descriptor: (slot) => ({ writer, publicKey, x25519, x25519Sig, slot })
  };
}

export interface RosterWriteOptions { kind: string; data: unknown; roster: string; stream?: string; epoch?: number; at?: string; actor?: Actor; deps?: readonly Written[] }
export interface GrantOptions { cell?: string; epoch?: number; roster: string; to: readonly RosterDevice[]; key?: Buffer }

export interface RosterWorld {
  project: string;
  projectName: string;
  lead: RosterDevice;
  // Every entry and grant written so far, in order of writing.
  entries: SealedEntry[];
  blobs: Map<string, SealedBlob>;
  grants: Array<SignedPayload<CellGrant>>;
  device(label: string, member: string): RosterDevice;
  // The epoch key the lead made for a cell and epoch (the base cell is the project).
  epochKeyOf(cell: string, epoch: number): Buffer;
  write(device: RosterDevice, options: RosterWriteOptions): Written;
  // A roster entry: data.rosterPrev and body.roster are both rosterPrev.
  rosterEntry(device: RosterDevice, kind: string, data: Record<string, unknown>, rosterPrev: string, options?: Partial<RosterWriteOptions>): Written;
  grant(signer: RosterDevice, options: GrantOptions): SignedPayload<CellGrant>;
  // The founding grant of the base cell (wrapped to the lead) and the genesis that commits to it, with the lead's device at slot 1.
  genesis(): { entry: Written; grant: SignedPayload<CellGrant> };
  anchor(): RosterAnchor;
  // The key ring a device opens from the grants addressed to it, with its own X25519 private key.
  ringFor(device: RosterDevice, grants?: ReadonlyArray<SignedPayload<CellGrant>>): KeyRing;
  foldRoster(options?: { entries?: readonly unknown[]; grants?: readonly unknown[]; keys?: KeyRing }): RosterState;
  ctxFor(state: RosterState, keys: KeyRing): ReplicaContext;
}

export function createRosterWorld(options: { leadLabel?: string; leadMember?: string; projectLabel?: string; leadSigner?: PayloadSigner } = {}): RosterWorld {
  const project = streamId(options.projectLabel ?? 'roster-project');
  const lead = rosterDevice(options.leadLabel ?? 'LEAD', options.leadMember ?? 'mbr-lead', options.leadSigner);
  const entries: SealedEntry[] = [];
  const blobs = new Map<string, SealedBlob>();
  const grants: Array<SignedPayload<CellGrant>> = [];
  const chains = new Map<string, { seq: number; prev: string; lamport: number }>();
  const lamports = new Map<string, number>();
  let genesisHash: string | undefined;
  const keyOf = (cell: string, epoch: number): Buffer => epochKey(`roster-world/${cell}/${epoch}`);

  const write = (device: RosterDevice, writeOptions: RosterWriteOptions): Written => {
    const stream = writeOptions.stream ?? project;
    const epoch = writeOptions.epoch ?? 1;
    const chainKey = `${stream}/${device.writer}`;
    const chain = chains.get(chainKey) ?? { seq: -1, prev: GENESIS_PREV, lamport: 0 };
    const deps = writeOptions.deps ?? [];
    const lamport = 1 + Math.max(chain.lamport, ...deps.map((dep) => lamports.get(dep.hash) ?? 0));
    const depList: Dep[] = deps.map((dep) => ({ writer: dep.writer, seq: dep.seq, hash: dep.hash }));
    const body: NewBody = { deps: depList, roster: writeOptions.roster, lamport, at: writeOptions.at ?? ROSTER_AT, actor: writeOptions.actor ?? { kind: 'person' }, kind: writeOptions.kind, data: writeOptions.data };
    const seq = chain.seq + 1;
    const built = buildEntry({ signer: device.signer, key: keyOf(stream, epoch), stream, seq, prev: chain.prev, epoch, body });
    chains.set(chainKey, { seq, prev: built.hash, lamport });
    entries.push(built.entry);
    for (const blob of built.blobs) blobs.set(blob.hash, blob);
    lamports.set(built.hash, lamport);
    return { entry: built.entry, hash: built.hash, stream, writer: device.writer, seq, lamport };
  };

  const grant = (signer: RosterDevice, grantOptions: GrantOptions): SignedPayload<CellGrant> => {
    const cell = grantOptions.cell ?? project;
    const epoch = grantOptions.epoch ?? 1;
    const key = grantOptions.key ?? keyOf(cell, epoch);
    const wraps = grantOptions.to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
    const signed = buildGrant(signer.signer, { cell, epoch, roster: grantOptions.roster, labelSealed: '', wraps });
    grants.push(signed);
    return signed;
  };

  const world: RosterWorld = {
    project,
    projectName: 'Exercise Northwind',
    lead,
    entries,
    blobs,
    grants,
    device: rosterDevice,
    epochKeyOf: keyOf,
    write,
    rosterEntry: (device, kind, data, rosterPrev, extra = {}) => write(device, { ...extra, kind, data: { ...data, rosterPrev }, roster: rosterPrev }),
    grant,
    genesis() {
      const founding = grant(lead, { roster: ORIGIN_ROSTER, to: [lead] });
      const entry = write(lead, {
        kind: 'project.genesis',
        roster: ORIGIN_ROSTER,
        data: {
          project,
          name: 'Exercise Northwind',
          profile: 'j2',
          labelMapHash: sha256('label-map/roster-world').toString('hex'),
          lead: { member: lead.member, writer: lead.writer, device: lead.descriptor(1) },
          cells: [{ cell: project, epoch: 1, grant: grantHash(founding) }]
        }
      });
      genesisHash = entry.hash;
      return { entry, grant: founding };
    },
    anchor() {
      if (genesisHash === undefined) throw new Error('Write the genesis before asking for the anchor.');
      return { genesisHash, project, lead: { member: lead.member, writer: lead.writer, publicKey: lead.publicKey, x25519: lead.x25519 } };
    },
    ringFor(device, from = grants) {
      const ring = new Map<string, Buffer>();
      for (const signed of from) {
        const payload = signed.payload;
        const mine = payload.wraps.find((item) => item.writer === device.writer);
        if (mine === undefined) continue;
        const opened = unwrapEpochKey({ cell: payload.cell, epoch: payload.epoch, writer: device.writer, privateKey: device.x25519Private, wrap: mine.wrap });
        if (opened !== undefined) ring.set(`${payload.cell}/${payload.epoch}`, opened);
      }
      return (stream, epoch) => ring.get(`${stream}/${epoch}`);
    },
    foldRoster(foldOptions = {}) {
      return foldRoster({
        entries: foldOptions.entries ?? entries,
        anchor: world.anchor(),
        keys: foldOptions.keys ?? world.ringFor(lead),
        blobs: (hash) => blobs.get(hash),
        grants: foldOptions.grants ?? grants,
        now: new Date(ROSTER_NOW)
      });
    },
    ctxFor: (state, keys) => ({ roster: rosterView(state), keys, blobs: (hash) => blobs.get(hash), now: new Date(ROSTER_NOW) })
  };
  return world;
}
