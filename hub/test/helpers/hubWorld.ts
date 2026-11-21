// A Yjs-free test world for the hub (Phase 32, plan 19): devices whose keys come from a label, a project genesis with the base cell's founding grant,
// the hub admitted with hub.admit, hub.grant and a base cell grant to its X25519 key (D-64), members admitted with a base cell grant, label cells with
// their founding grants, and entries in any stream, including a second header at a used place for the equivocation tests.
//
// The extension's src/test/helpers/replicaRosterWorld.ts cannot be used here: it imports replicaWorld.ts, which loads Yjs. This file mirrors its
// shapes with hub-side modules only. No key literal lives in any file: every device key is derived from a label, and the hub's own keys are fresh
// random key lines from generateKeyFile, as the operator makes them. All names and data are fictional.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { buildGrant, grantHash, unwrapEpochKey, wrapEpochKey, x25519BindingBytes, x25519PrivateFromSeed, x25519PublicRaw } from '@ext/domain/replica/cellKeys';
import type { CellGrant } from '@ext/domain/replica/cellKeys';
import { GENESIS_PREV, buildEntry, writerIdOf } from '@ext/domain/replica/entry';
import type { Actor, Dep, SealedBlob, SealedEntry } from '@ext/domain/replica/entry';
import { enrolmentMac, spkiPin } from '@ext/domain/replica/hubFile';
import type { HubFilePayload } from '@ext/domain/replica/hubFile';
import { ORIGIN_ROSTER } from '@ext/domain/replica/roster';
import type { RosterAnchor } from '@ext/domain/replica/roster';
import type { KeyRing } from '@ext/domain/replica/rosterView';
import { fingerprintOf } from '@ext/domain/team/canonical';
import type { PayloadSigner, SignedPayload } from '@ext/domain/team/signedPayload';
import { hubIdentityOf } from '../../src/enrol';
import type { HubIdentity } from '../../src/enrol';
import { generateKeyFile, readEncryptionKey, readSigningKey } from '../../src/keys';

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();
// The 16-byte PKCS8 prefix of an Ed25519 private key; the 32-byte seed follows it. A DER header, not a key.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const WORLD_NOW = '2026-11-19T12:00:00.000Z';
export const WORLD_AT = '2026-11-19T11:00:00.000Z';
export const NOW_MS = Date.parse(WORLD_NOW);
export const INVITE_EXPIRES = '2026-11-26T11:00:00.000Z';
export const DEMO_CLEARANCE = { scale: 'demo', level: 'OFFICIAL', compartments: [], releasability: [] };
export const HUB_ADDRESS = 'hub.example.org:8443';

export const streamOf = (label: string): string => sha256(`hub-world/stream/${label}`).toString('hex').slice(0, 32);

export interface DeviceDescriptor { writer: string; publicKey: string; x25519: string; x25519Sig: string; slot: number }

export interface WorldDevice {
  label: string;
  member: string;
  signer: PayloadSigner;
  publicKey: string;
  writer: string;
  x25519: string;
  x25519Private: KeyObject;
  x25519Sig: string;
  descriptor(slot: number): DeviceDescriptor;
}

/** A device whose Ed25519 and X25519 keys come from the label alone. */
export function worldDevice(label: string, member: string): WorldDevice {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, sha256(`hub-world/signer/${label}`)]), format: 'der', type: 'pkcs8' });
  const raw = Buffer.from(createPublicKey(privateKey).export({ format: 'jwk' }).x as string, 'base64url');
  const publicKey = raw.toString('base64url');
  const signer: PayloadSigner = { fingerprint: fingerprintOf(raw), publicKey, sign: (bytes: Buffer): string => edSign(null, bytes, privateKey).toString('base64url') };
  const writer = writerIdOf(publicKey);
  const x25519Private = x25519PrivateFromSeed(sha256(`hub-world/x25519/${label}`));
  const x25519 = x25519PublicRaw(x25519Private).toString('base64url');
  const x25519Sig = signer.sign(x25519BindingBytes(x25519, writer));
  return { label, member, signer, publicKey, writer, x25519, x25519Private, x25519Sig, descriptor: (slot) => ({ writer, publicKey, x25519, x25519Sig, slot }) };
}

/** A hub identity with fresh key lines (as --generate-key makes them) and the pin of a fresh EC key standing in for its certificate key. */
export function makeHubIdentity(address: string | undefined = HUB_ADDRESS): HubIdentity {
  const signing = readSigningKey(generateKeyFile('signing'));
  const encryption = readEncryptionKey(generateKeyFile('encryption'), signing);
  const certificateKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  return hubIdentityOf(signing, encryption, certificateKey, address);
}

/** Another certificate key's pin, for the wrong-pin refusal. */
export function otherCertPin(): string {
  return spkiPin(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey);
}

export interface Written { entry: SealedEntry; hash: string; stream: string; writer: string; seq: number; blobs: SealedBlob[] }

export interface WriteOptions {
  kind: string;
  data: unknown;
  stream?: string;
  /** The roster the body cites; the world's head when absent. */
  roster?: string;
  epoch?: number;
  /** The key the body is sealed with; the world's key for the stream and epoch when absent. */
  key?: Buffer;
  at?: string;
  actor?: Actor;
  /** An explicit place: the chain is not advanced (a second header at a used seq, or a gap). */
  seq?: number;
  prev?: string;
  /** The body's deps (none when absent). */
  deps?: Dep[];
  /** The body's lamport; when absent the world's counter, or with causalLamport one more than the largest of prev and deps. */
  lamport?: number;
}

export interface RosterOptions { rosterPrev?: string; advance?: boolean; at?: string; actor?: Actor }
export interface GrantOptions { cell?: string; epoch?: number; roster: string; to: ReadonlyArray<{ writer: string; x25519: string }>; key?: Buffer }

export interface EnrolRequest { enrolment: string; project: string; entries: SealedEntry[]; grants: unknown[]; blobs: SealedBlob[]; rosterHead: string; mac: string }

export interface HubWorld {
  project: string;
  lead: WorldDevice;
  genesisHash: string;
  /** The roster head as the world believes it: the last roster entry written with advance (the default). */
  head: string;
  entries: SealedEntry[];
  grants: Array<SignedPayload<CellGrant>>;
  blobs: Map<string, SealedBlob>;
  device(label: string, member: string): WorldDevice;
  keyOf(cell: string, epoch: number): Buffer;
  write(device: WorldDevice, options: WriteOptions): Written;
  rosterEntry(device: WorldDevice, kind: string, data: Record<string, unknown>, options?: RosterOptions): Written;
  grant(signer: WorldDevice, options: GrantOptions): SignedPayload<CellGrant>;
  anchor(): RosterAnchor;
  ringFor(device: { writer: string; x25519Private: KeyObject }): KeyRing;
  /** hub.admit, hub.grant for the base cell, then the base cell grant to the hub's X25519 key (D-64). Each part can be changed or left out. */
  admitHub(identity: HubIdentity, options?: { slot?: number; certPin?: string; device?: Partial<DeviceDescriptor>; hubGrant?: boolean; baseGrant?: boolean }): { admit: Written; hubGrant?: Written; grant?: SignedPayload<CellGrant> };
  /** member.invite and member.admit for the device's member, then a base cell grant to it unless baseGrant is false. */
  admitMember(device: WorldDevice, options?: { slot?: number; roles?: string[]; baseGrant?: boolean }): { invite: Written; admit: Written; grant?: SignedPayload<CellGrant> };
  /** cell.create for a new label cell with its founding grant to the given devices. */
  labelCell(label: string, to: readonly WorldDevice[]): { cell: string; entry: Written; grant: SignedPayload<CellGrant> };
  /** The enrolment request the lead's device sends: every base-stream entry, every grant, every blob, the head and the MAC. */
  enrolRequest(file: Pick<HubFilePayload, 'enrolment' | 'enrolmentSecret' | 'hub'>, options?: Partial<EnrolRequest>): EnrolRequest;
}

/** causalLamport (32-22): every lamport is one more than the largest of its prev and deps, as the chain stage of a client's fold requires. */
export function createHubWorld(options: { projectLabel?: string; leadLabel?: string; causalLamport?: boolean } = {}): HubWorld {
  const project = streamOf(options.projectLabel ?? 'northwind');
  const lead = worldDevice(options.leadLabel ?? 'LEAD', 'mbr-lead');
  const entries: SealedEntry[] = [];
  const grants: Array<SignedPayload<CellGrant>> = [];
  const blobs = new Map<string, SealedBlob>();
  const chains = new Map<string, { seq: number; prev: string }>();
  let lamport = 0;
  const lamports = new Map<string, number>();
  let nextSlot = 2;
  let inviteCount = 0;
  const keyOf = (cell: string, epoch: number): Buffer => sha256(`hub-world/epoch/${cell}/${epoch}`);

  const write = (device: WorldDevice, writeOptions: WriteOptions): Written => {
    const stream = writeOptions.stream ?? project;
    const epoch = writeOptions.epoch ?? 1;
    const chainKey = `${stream}/${device.writer}`;
    const chain = chains.get(chainKey) ?? { seq: -1, prev: GENESIS_PREV };
    const explicit = writeOptions.seq !== undefined;
    const seq = writeOptions.seq ?? chain.seq + 1;
    const prev = writeOptions.prev ?? (explicit ? (seq === 0 ? GENESIS_PREV : chain.prev) : chain.prev);
    lamport += 1;
    const deps = writeOptions.deps ?? [];
    const causal = 1 + Math.max(0, ...[prev, ...deps.map((dep) => dep.hash)].map((hash) => lamports.get(hash) ?? 0));
    const own = writeOptions.lamport ?? (options.causalLamport === true ? causal : lamport);
    const built = buildEntry({
      signer: device.signer,
      key: writeOptions.key ?? keyOf(stream, epoch),
      stream,
      seq,
      prev,
      epoch,
      body: { deps, roster: writeOptions.roster ?? world.head, lamport: own, at: writeOptions.at ?? WORLD_AT, actor: writeOptions.actor ?? { kind: 'person' }, kind: writeOptions.kind, data: writeOptions.data }
    });
    if (!explicit) chains.set(chainKey, { seq, prev: built.hash });
    lamports.set(built.hash, own);
    entries.push(built.entry);
    for (const blob of built.blobs) blobs.set(blob.hash, blob);
    return { entry: built.entry, hash: built.hash, stream, writer: device.writer, seq, blobs: built.blobs };
  };

  const grant = (signer: WorldDevice, grantOptions: GrantOptions): SignedPayload<CellGrant> => {
    const cell = grantOptions.cell ?? project;
    const epoch = grantOptions.epoch ?? 1;
    const key = grantOptions.key ?? keyOf(cell, epoch);
    const wraps = grantOptions.to.map((device) => ({ writer: device.writer, wrap: wrapEpochKey({ cell, epoch, writer: device.writer, recipient: device.x25519, epochKey: key }) }));
    const signed = buildGrant(signer.signer, { cell, epoch, roster: grantOptions.roster, labelSealed: '', wraps });
    grants.push(signed);
    return signed;
  };

  const rosterEntry = (device: WorldDevice, kind: string, data: Record<string, unknown>, rosterOptions: RosterOptions = {}): Written => {
    const rosterPrev = rosterOptions.rosterPrev ?? world.head;
    const written = write(device, { kind, data: { ...data, rosterPrev }, roster: rosterPrev, ...(rosterOptions.at === undefined ? {} : { at: rosterOptions.at }), ...(rosterOptions.actor === undefined ? {} : { actor: rosterOptions.actor }) });
    if (rosterOptions.advance !== false) world.head = written.hash;
    return written;
  };

  const world: HubWorld = {
    project,
    lead,
    genesisHash: '',
    head: ORIGIN_ROSTER,
    entries,
    grants,
    blobs,
    device: worldDevice,
    keyOf,
    write,
    rosterEntry,
    grant,
    anchor: () => ({ genesisHash: world.genesisHash, project, lead: { member: lead.member, writer: lead.writer, publicKey: lead.publicKey, x25519: lead.x25519 } }),
    ringFor(device) {
      const ring = new Map<string, Buffer>();
      for (const signed of grants) {
        const mine = signed.payload.wraps.find((item) => item.writer === device.writer);
        if (mine === undefined) continue;
        const opened = unwrapEpochKey({ cell: signed.payload.cell, epoch: signed.payload.epoch, writer: device.writer, privateKey: device.x25519Private, wrap: mine.wrap });
        if (opened !== undefined) ring.set(`${signed.payload.cell}/${signed.payload.epoch}`, opened);
      }
      return (stream, epoch) => ring.get(`${stream}/${epoch}`);
    },
    admitHub(identity, hubOptions = {}) {
      const slot = hubOptions.slot ?? nextSlot++;
      const device = { writer: identity.writer, publicKey: identity.publicKey, x25519: identity.x25519, x25519Sig: identity.x25519Sig, slot, ...hubOptions.device };
      const admit = rosterEntry(lead, 'hub.admit', { hub: identity.hub, device, certPin: hubOptions.certPin ?? identity.certPin, ceiling: DEMO_CLEARANCE });
      const result: { admit: Written; hubGrant?: Written; grant?: SignedPayload<CellGrant> } = { admit };
      if (hubOptions.hubGrant !== false) result.hubGrant = rosterEntry(lead, 'hub.grant', { hub: identity.hub, cell: project });
      if (hubOptions.baseGrant !== false) result.grant = grant(lead, { roster: world.head, to: [{ writer: device.writer, x25519: device.x25519 }] });
      return result;
    },
    admitMember(device, memberOptions = {}) {
      inviteCount += 1;
      const invite = `inv-${inviteCount}`;
      const roles = memberOptions.roles ?? ['member'];
      const inviteEntry = rosterEntry(lead, 'member.invite', { invite, name: `Member ${device.label}`, seat: 'j2-analyst', roles, clearance: DEMO_CLEARANCE, expiresAt: INVITE_EXPIRES, secretHash: sha256(`hub-world/invite/${invite}`).toString('hex') });
      const admit = rosterEntry(lead, 'member.admit', { member: device.member, invite, name: `Member ${device.label}`, seat: 'j2-analyst', roles, clearance: DEMO_CLEARANCE, device: device.descriptor(memberOptions.slot ?? nextSlot++) });
      const result: { invite: Written; admit: Written; grant?: SignedPayload<CellGrant> } = { invite: inviteEntry, admit };
      if (memberOptions.baseGrant !== false) result.grant = grant(lead, { roster: world.head, to: [device] });
      return result;
    },
    labelCell(label, to) {
      const cell = streamOf(`cell/${label}`);
      const founding = grant(lead, { cell, roster: world.head, to });
      const entry = rosterEntry(lead, 'cell.create', { cell, epoch: 1, grant: grantHash(founding) });
      return { cell, entry, grant: founding };
    },
    enrolRequest(file, overrides = {}) {
      const base = entries.filter((entry) => entry.header.stream === project);
      const rosterHead = overrides.rosterHead ?? world.head;
      const fields = { enrolment: file.enrolment, hub: file.hub, project, genesisHash: world.genesisHash, rosterHead };
      return {
        enrolment: file.enrolment,
        project,
        entries: base,
        grants: [...grants],
        blobs: [...blobs.values()],
        rosterHead,
        mac: enrolmentMac(file.enrolmentSecret, fields),
        ...overrides
      };
    }
  };

  // The genesis: the base cell's founding grant to the lead, cited by the genesis, with the lead's device at slot 1.
  const founding = grant(lead, { roster: ORIGIN_ROSTER, to: [lead] });
  const genesis = write(lead, {
    kind: 'project.genesis',
    roster: ORIGIN_ROSTER,
    data: {
      project,
      name: 'Exercise Northwind',
      profile: 'j2',
      labelMapHash: sha256('hub-world/label-map').toString('hex'),
      lead: { member: lead.member, writer: lead.writer, device: lead.descriptor(1) },
      cells: [{ cell: project, epoch: 1, grant: grantHash(founding) }]
    }
  });
  world.genesisHash = genesis.hash;
  world.head = genesis.hash;
  return world;
}
