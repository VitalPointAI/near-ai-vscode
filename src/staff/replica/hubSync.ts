// One exchange with your organization's sync hub (D-36, D-46, D-49, D-50, D-54, D-70; DESIGN 10.8 and 15.3). No UI and no scheduling: Phase 33 builds
// the live replicator and the sync status around syncOnce. Node I/O only through the transport and the local replica, no editor API and no Yjs, so the
// hub's own tests bundle this file with an in-memory replica (D-27). The ReplicaProject adapter (syncLocalOf) therefore lives in replicaProject.ts,
// which imports this file's types; this file never imports the project.
//
// syncOnce runs, in order: the session and heads (witnessHeads, witnessCheckpoint), the grants the hub lists that this computer lacks, the hand-back
// of hub checkpoints the hub lost (when the hub's latest is older than the newest this computer kept), the pull per writer in seq order with every
// prev checked against the stored head and every header verified against the roster, the citations still missing (heads, checkpoint heads and the
// deps of held entries, for withheld), the blobs waiting entries need, the push of every entry and grant the hub lacks (re-pushed after a rollback),
// a checkpoint ask, and the witness state saved. Nothing the witness names is stored.
//
// The end states (DESIGN 15.3) of one exchange:
//   synced     the exchange finished and the hub showed nothing that needs a person
//   offline    the hub could not be reached, the connection was lost, or the hub asked to wait (retryAfterSeconds)
//   refused    the hub does not accept this device (reason: not-admitted, quarantined, revoked and the rest of the hub's list)
//   attention  a person must act: the certificate pin or CA did not match, the hub named another hub or project, rolled back or showed a fork
// A rolled-back hub still gets every entry and grant it lacks pushed back to it (re-push) before the exchange ends in attention; a forked view or a
// wrong-project answer stops the exchange where it was found.
import { createHash } from 'node:crypto';
import { readCheckpoint, verifyCheckpoint } from '../../domain/replica/checkpoint';
import type { Checkpoint, SignedCheckpoint } from '../../domain/replica/checkpoint';
import type { Citation } from '../../domain/replica/chain';
import { GENESIS_PREV, entryHash, parseHeaderShape, sha256Hex, verifyHeader } from '../../domain/replica/entry';
import type { EntryHeader, SealedBlob, SealedEntry } from '../../domain/replica/entry';
import { UPDATE_SENTENCE } from '../../domain/replica/features';
import { createWitness, findingSentence, readWitness, readmitWitness, serializeWitness, witnessBlob, witnessCheckpoint, witnessCitations, witnessEntry, witnessHeads, witnessOwn, witnessResponse } from '../../domain/replica/hubWitness';
import type { HubFinding, HubFindingKind, WitnessResult, WitnessState } from '../../domain/replica/hubWitness';
import type { RosterView } from '../../domain/replica/rosterView';
import type { HeadSet } from '../../domain/replica/transport';
import { CHECKPOINTS_PER_ASK, HUB_TRANSPORT_FAILURES, HubTransportError, appendBatches, pushPlan } from './hubTransport';
import type { HubTransport, HubTransportFailure } from './hubTransport';
import { exchangeManaged, fetchManaged } from './managedSync';
import type { ManagedInbox, ManagedPacket, ManagedSyncHandoffs, ManagedSyncLocal, ManagedSyncRoute } from './managedSync';

/** What one exchange needs of this computer's replica. ReplicaProject provides it through syncLocalOf; the hub's tests use a memory replica. */
export interface SyncLocal {
  readonly project: string;
  /** This device's writer id. */
  readonly writer: string;
  /** The roster as this computer folded it now: device keys for headers, checkpoint signers for checkpoints. */
  roster(): Promise<RosterView>;
  /** Per stream, the head of every writer's log this computer holds. */
  heads(): Promise<HeadSet['streams']>;
  head(stream: string, writer: string): Promise<{ seq: number; hash: string } | undefined>;
  /** Which of these entry hashes this computer holds. */
  holds(hashes: readonly string[]): Promise<ReadonlySet<string>>;
  /** The entries of one writer in one stream above a seq, in seq order. */
  entriesAfter(stream: string, writer: string, seq: number): Promise<SealedEntry[]>;
  blob(hash: string): Promise<SealedBlob | undefined>;
  /** Blobs cited by entries that wait for them. */
  wantedBlobs(): Promise<string[]>;
  /** The blobs the given entries use, as append blobRefs. Entries this computer cannot open name none. */
  blobsCitedBy(hashes: readonly string[]): Promise<Array<{ entry: string; blob: string }>>;
  /** Every signed cell grant held, with its hash (sha256 of the canonical signed grant). */
  grants(): Promise<Array<{ hash: string; signed: unknown }>>;
  /** Stores entries and blobs from outside through the project's decode check. added counts entries written; notStored those not written now. */
  ingest(entries: readonly SealedEntry[], blobs: readonly SealedBlob[], packets?: readonly ManagedPacket[]): Promise<{ added: number; notStored: number; paired?: readonly string[] }>;
  putGrants(grants: readonly unknown[]): Promise<void>;
  managed?: ManagedSyncLocal;
  checkpoints(): Promise<SignedCheckpoint[]>;
  putCheckpoint(signed: SignedCheckpoint): Promise<void>;
  /** The streams the hub can checkpoint (the base cell and the cells granted with hub.grant), for the delayed finding (D-63). */
  covered?(hub: string): Promise<readonly string[] | undefined>;
  /**
   * The deps that entries this computer holds cite and it does not hold, each with the citing entry's stream (D-50, D-63). In a cell no checkpoint
   * covers, a dep is the only sign of an entry the hub withholds while no head names it. Without it only the hub's heads and checkpoint heads are cited.
   */
  missingDeps?(): Promise<Citation[]>;
  /** After each exchange: the newest checkpoint this hub's witness trusts, or undefined when it distrusts the hub (33-14, D-43). */
  trustCheckpoint?(hub: string, newest: SignedCheckpoint | undefined): void | Promise<void>;
}

/** Where the witness state of each hub and project is kept between exchanges. */
export interface HubMemory {
  load(hub: string, project: string): Promise<WitnessState>;
  save(state: WitnessState): Promise<void>;
}

/** The part of SecretStorage the memory needs. */
export interface WitnessSecrets {
  get(key: string): PromiseLike<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): PromiseLike<void> | Promise<void>;
}

export const HUB_WITNESS_SECRET_PREFIX = 'nearAi.staff.hubWitness.';

/** The secret key of one hub's witness state for one project: the prefix and sha256 of the project and the hub's writer id. */
export function hubWitnessKey(hub: string, project: string): string {
  return `${HUB_WITNESS_SECRET_PREFIX}${createHash('sha256').update(`${project}\n${hub}`, 'utf8').digest('hex')}`;
}

/**
 * The witness state kept in SecretStorage (it holds checkpoints and heads only, no secret). A saved state that does not read back for this hub and
 * project (another hub, another project, damaged) is not used: the exchange starts from a fresh witness.
 */
export function hubMemoryOf(secrets: WitnessSecrets): HubMemory {
  return {
    async load(hub, project) {
      const text = await secrets.get(hubWitnessKey(hub, project));
      if (text === undefined) return createWitness(hub, project);
      const read = readWitness(text, { hub, project });
      return read.ok ? read.state : createWitness(hub, project);
    },
    async save(state) {
      await secrets.store(hubWitnessKey(state.hub, state.project), serializeWitness(state));
    }
  };
}

export type SyncOutcome = 'synced' | 'offline' | 'refused' | 'attention' | 'needs-update';

/** What a person sees while your organization's server is in restore mode (D-32): offline-like, never attention. */
export const RESTORING_SENTENCE = 'Your organization\'s server is being restored. Your changes are kept here.';
/** A person's session key has passed its certificate's notAfter at your organization's server (Phase 33 D-62). Refused, never retried. */
export const SESSION_EXPIRED_SENTENCE = 'Your session key has ended. Sign in again.';
/** A late joiner in a part of the project your organization's server keeps no summary of (D-43, D-63). Shown as information, never as a fault. */
export const FULL_REPLAY_SENTENCE = 'Your organization\'s server keeps no summary of this part of the project, so this computer reads all of its history. Nothing is left out.';

export interface SyncReport {
  outcome: SyncOutcome;
  /** Entries this computer stored from the hub. */
  pulled: number;
  /** Entries the hub accepted from this computer. */
  pushed: number;
  /** Blobs this computer stored from the hub. */
  blobs: number;
  /** Grants this computer stored from the hub. */
  grants: number;
  /** The witness findings, one per kind, each with its sentence. */
  findings: HubFinding[];
  /** True when entries were pushed back to a hub that showed a rolled-back copy. */
  repushed: boolean;
  /** Hub checkpoints handed back to the hub. */
  handedBack: number;
  /** Entries delivered but not stored now (deferred, flooded, dropped): delivered is not stored. */
  notStored: number;
  /** Entries the hub refused, with its reason id. */
  refusedByHub: Array<{ hash: string; reason: string }>;
  /**
   * Entries not pushed because this computer does not hold a blob they use (the hub has not got it either, or the blob step would have fetched it),
   * with the rest of their writer's log. They go in a later exchange once the blob is here; the blob's author pushes them meanwhile.
   */
  heldBack: number;
  /** With startFromBase: the streams whose logs were read from their start because no trusted checkpoint covers them (FULL_REPLAY_SENTENCE). */
  readInFull: string[];
  /** The transport failure or refusal reason id, when the exchange ended on one. */
  reason?: string;
  /** One plain sentence for the outcome when it was not synced. */
  message?: string;
  retryAfterSeconds?: number;
  managed?: 'waiting' | 'complete';
}

export interface SyncOptions {
  managed?: ManagedSyncHandoffs;
  now?: () => Date;
  /**
   * A late joiner (D-43, F5): a writer log this computer holds nothing of starts at the head a trusted version 2 checkpoint of this hub names,
   * instead of seq 0, and its first pulled entry must follow that head. Without such a checkpoint the log is pulled from 0 as before.
   */
  startFromBase?: boolean;
}

/** The transport calls one exchange makes. HubTransport has them all. */
export type SyncTransport = Pick<HubTransport, 'project' | 'hub' | 'hubHeads' | 'entries' | 'append' | 'getBlob' | 'grant' | 'askCheckpoint'> & { managedRoute?: ManagedSyncRoute };

const ATTENTION_FINDINGS: ReadonlySet<HubFindingKind> = new Set(['rolled-back', 'forked-view', 'wrong-project']);
const COUNTED_BY_WITNESS: ReadonlySet<HubFindingKind> = new Set(['withheld', 'delayed', 'rolled-back']);
/** Refusals that may clear once the rest of a push is in (an admission, a grant or an earlier entry in another batch). */
// blob-missing (Phase 33 D-28): the hub refuses only that entry; the transport puts the batch's blobs and the next pass sends it again.
const RETRY_REFUSALS: ReadonlySet<string> = new Set(['not-admitted', 'unknown-stream', 'not-on-access-list', 'seq-gap', 'prev-mismatch', 'blob-missing']);
const MAX_PAGES_PER_WRITER = 10_000;
const MAX_BLOBS_PER_EXCHANGE = 256;
const PUSH_PASSES = 3;

const OUTCOME_OF: Readonly<Record<HubTransportFailure, SyncOutcome>> = {
  unreachable: 'offline',
  'rate-limited': 'offline',
  'pin-mismatch': 'attention',
  'ca-refused': 'attention',
  'wrong-hub': 'attention',
  'wrong-project': 'attention',
  'session-refused': 'refused',
  'too-large': 'attention',
  malformed: 'attention',
  'hub-error': 'attention'
};

const coverageOf = (checkpoint: Checkpoint): number => checkpoint.streams.reduce((total, stream) => total + stream.count, 0);
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Thrown inside the exchange to end it where a finding stops it. */
class Stop extends Error {}

/** The key a writer signs with: a roster device's, or a person's session key the roster fold placed a certificate for (Phase 33 D-62). */
function writerKey(roster: RosterView, writer: string): string | undefined {
  return roster.deviceKey(writer)?.publicKey ?? roster.sessionCertificate?.(writer)?.sessionKey;
}

/** One header and body checked against the roster: signed by the writer's admitted key, and the body exactly what the header names. */
function verifyDelivered(header: EntryHeader, body: unknown, roster: RosterView): string | undefined {
  const publicKey = writerKey(roster, header.writer);
  if (publicKey === undefined) return 'unknown-writer';
  if (!verifyHeader(header, publicKey)) return 'bad-signature';
  if (typeof body !== 'string' || !/^[A-Za-z0-9_-]*$/.test(body)) return 'body-mismatch';
  const bytes = Buffer.from(body, 'base64url');
  if (bytes.toString('base64url') !== body || bytes.length !== header.body.size || sha256Hex(bytes) !== header.body.hash) return 'body-mismatch';
  return undefined;
}

/**
 * One exchange with the hub. Never throws for anything the hub or the network does: every such end is an outcome in the report. It throws only for a
 * local replica that fails, or a transport and replica for different projects.
 */
export async function syncOnce(transport: SyncTransport, local: SyncLocal, memory: HubMemory, options: SyncOptions = {}): Promise<SyncReport> {
  if (local.project !== transport.project) throw new Error('The transport and the local replica are for different projects.');
  const now = options.now ?? ((): Date => new Date());
  const hub = transport.hub;
  const project = transport.project;
  const report: SyncReport = { outcome: 'synced', pulled: 0, pushed: 0, blobs: 0, grants: 0, findings: [], repushed: false, handedBack: 0, notStored: 0, refusedByHub: [], heldBack: 0, readInFull: [] };
  const noted: HubFinding[] = [];
  let state = await memory.load(hub, project);
  let rolledBack = false;
  let inbox: ManagedInbox | undefined;
  const paired = new Set<string>();
  let roster = await local.roster();
  // The lead's re-admission (D-42): each folded hub.readmit for this hub clears a distrusted witness once, before the witness is used.
  const readmit = (): void => {
    const member = roster.deviceKey(hub)?.member;
    for (const hash of member === undefined ? [] : roster.hubReadmits?.(member) ?? []) state = readmitWitness(state, hash).state;
  };
  readmit();

  const apply = (result: WitnessResult): HubFinding[] => {
    state = result.state;
    noted.push(...result.findings);
    return result.findings;
  };

  /** A checkpoint the hub sent, through the witness: kept when trusted, both kept as proof on a fork. Returns the verified checkpoint when trusted. */
  const seeCheckpoint = async (signed: unknown): Promise<Checkpoint | undefined> => {
    const result = witnessCheckpoint(state, signed, roster);
    const findings = apply(result);
    if (result.trusted && state.newest !== undefined) {
      await local.putCheckpoint(state.newest);
      return readCheckpoint(state.newest.payload);
    }
    if (findings.some((item) => item.kind === 'forked-view')) {
      if (state.proof !== undefined) {
        await local.putCheckpoint(state.proof.a);
        await local.putCheckpoint(state.proof.b);
      }
      throw new Stop();
    }
    if (findings.some((item) => item.kind === 'rolled-back')) rolledBack = true;
    return undefined;
  };

  /** Hub checkpoints this computer holds that verify for this roster, are signed by this hub and name this project. */
  const heldHubCheckpoints = async (): Promise<Array<{ signed: SignedCheckpoint; coverage: number }>> => {
    const held: Array<{ signed: SignedCheckpoint; coverage: number }> = [];
    for (const signed of await local.checkpoints()) {
      const verdict = verifyCheckpoint(signed, roster);
      if (!verdict.ok || verdict.checkpoint.signer !== hub || verdict.checkpoint.project !== project) continue;
      held.push({ signed, coverage: coverageOf(verdict.checkpoint) });
    }
    return held;
  };

  try {
    // Session and heads.
    const heads = await transport.hubHeads();
    apply(witnessResponse(state, heads, []));
    // A distrusted server cannot forge a change (every one is signed by a member's device), so its roster changes are still read: that is how
    // the lead's hub.readmit reaches this computer and clears the mark (D-42). Nothing else is taken from it until then.
    if (state.distrusted) {
      await pull(heads.streams.filter((stream) => stream.stream === project));
      roster = await local.roster();
      readmit();
    }
    if (apply(witnessHeads(state, heads, roster)).some((item) => item.kind === 'rolled-back')) rolledBack = true;
    const keptBefore = state.newest === undefined ? undefined : readCheckpoint(state.newest.payload);
    let hubLatest: Checkpoint | undefined;
    if (heads.checkpoint !== undefined) hubLatest = await seeCheckpoint(heads.checkpoint);

    // Grants the hub lists that this computer lacks: fetched by hash, checked, stored, so the roster fold can place their keys.
    const mine = new Set((await local.grants()).map((grant) => grant.hash));
    const fetched: unknown[] = [];
    for (const hash of heads.grants) {
      if (mine.has(hash)) continue;
      const grant = await transport.grant(hash);
      if (grant.kind === 'grant') fetched.push(grant.signed);
      else if (grant.kind === 'refused' && grant.reason === 'corrupt-blob') apply(witnessBlob(state, hash, ''));
      else if (grant.kind === 'refused') apply(witnessEntry(state, { hash, verified: false, reason: grant.reason }));
    }
    if (fetched.length > 0) {
      await local.putGrants(fetched);
      report.grants += fetched.length;
      roster = await local.roster();
      readmit();
    }

    // Hand-back (D-70): when the hub's latest is older than the newest this computer kept, the newer hub checkpoints it holds go back to the hub.
    const hubCoverage = hubLatest === undefined ? -1 : coverageOf(hubLatest);
    const keptCoverage = keptBefore === undefined ? -1 : coverageOf(keptBefore);
    if (keptCoverage > hubCoverage || (rolledBack && keptBefore !== undefined)) {
      const newer = (await heldHubCheckpoints()).filter((item) => item.coverage > hubCoverage).sort((a, b) => b.coverage - a.coverage).slice(0, CHECKPOINTS_PER_ASK);
      if (newer.length > 0) {
        const answer = await transport.askCheckpoint(newer.map((item) => item.signed));
        report.handedBack = newer.length;
        if (answer.checkpoint !== undefined) await seeCheckpoint(answer.checkpoint);
      }
    }

    // Buffer opaque packets so roster ingestion can make exact continuity durable before exposing its entry.
    if (!rolledBack && !state.distrusted && options.managed !== undefined && local.managed !== undefined && transport.managedRoute !== undefined) {
      inbox = await fetchManaged(options.managed, transport.managedRoute);
    }
    if (!rolledBack) await pull(heads.streams);
    if (options.managed !== undefined) report.managed = rolledBack || state.distrusted ? 'waiting' :
      await exchangeManaged(options.managed, local.managed, transport.managedRoute, inbox, paired);

    // Withheld (D-50): the hub's heads, the trusted checkpoint's heads and the deps of held entries this computer still does not hold, timed by the
    // witness. The deps are what catches withholding in a cell no checkpoint covers when the hub also leaves the entry out of its heads (D-63).
    if (!rolledBack) {
      const cited: Citation[] = [];
      for (const stream of heads.streams) {
        for (const head of stream.heads) if (writerKey(roster, head.writer) !== undefined) cited.push({ stream: stream.stream, writer: head.writer, seq: head.seq, hash: head.hash });
      }
      const newest = state.newest === undefined ? undefined : readCheckpoint(state.newest.payload);
      for (const stream of newest?.streams ?? []) for (const head of stream.heads) cited.push({ stream: stream.stream, writer: head.writer, seq: head.seq, hash: head.hash });
      if (local.missingDeps !== undefined) cited.push(...(await local.missingDeps()));
      const held = await local.holds(cited.map((item) => item.hash));
      apply(witnessCitations(state, cited, held, now()));
    }

    // Blobs that waiting entries need.
    for (const hash of (await local.wantedBlobs()).slice(0, MAX_BLOBS_PER_EXCHANGE)) {
      const blob = await transport.getBlob(hash);
      if (blob.kind === 'missing') continue;
      if (apply(witnessBlob(state, hash, blob.bytes)).length > 0) continue;
      await local.ingest([], [{ hash, bytes: blob.bytes.toString('base64url') }]);
      report.blobs += 1;
    }

    // Push every entry and grant the hub lacks.
    await push(heads.streams, new Set(heads.grants));

    // This device's own entries against the newest checkpoint (delayed), then the checkpoint ask.
    const own = (await local.heads()).map((stream) => ({ stream: stream.stream, heads: stream.heads.filter((head) => head.writer === local.writer) })).filter((stream) => stream.heads.length > 0);
    const covered = local.covered === undefined ? undefined : await local.covered(hub);
    apply(witnessOwn(state, own, now(), true, covered));
    const asked = await transport.askCheckpoint([]);
    if (asked.checkpoint !== undefined) await seeCheckpoint(asked.checkpoint);
  } catch (error) {
    if (error instanceof HubTransportError) {
      if (error.failure === 'wrong-project') apply(witnessResponse(state, error.detail.label ?? { project: '' }, []));
      report.outcome = OUTCOME_OF[error.failure];
      report.reason = error.detail.reason ?? error.failure;
      report.message = HUB_TRANSPORT_FAILURES[error.failure];
      if (error.detail.retryAfterSeconds !== undefined) report.retryAfterSeconds = error.detail.retryAfterSeconds;
      // POST-01 (D-07): this computer, or the hub, lacks a feature the shared work requires. Plain words, never attention.
      if ((error.failure === 'hub-error' || error.failure === 'session-refused') && error.detail.reason === 'needs-update') {
        report.outcome = 'needs-update';
        report.message = UPDATE_SENTENCE;
      }
      // A person's session key that has ended (D-62): refused with its own sentence, never attention.
      if (error.failure === 'session-refused' && error.detail.reason === 'session-expired') report.message = SESSION_EXPIRED_SENTENCE;
      // Restore mode at the hub (D-32): offline with the time to try again, the entries stay queued. The checkpoint ask still goes, because every
      // member's ask is what ends restore mode at the hub.
      if (error.failure === 'hub-error' && error.detail.reason === 'restoring') {
        report.outcome = 'offline';
        report.message = RESTORING_SENTENCE;
        try {
          const asked = await transport.askCheckpoint([]);
          if (asked.checkpoint !== undefined) await seeCheckpoint(asked.checkpoint);
        } catch (late) {
          if (!(late instanceof HubTransportError) && !(late instanceof Stop)) throw late;
        }
      }
    } else if (!(error instanceof Stop)) {
      await memory.save(state);
      throw error;
    }
  }
  await memory.save(state);
  // The fold of this computer uses only what the witness trusts (foldCheckpoints.ts): the newest checkpoint, or none from a distrusted hub.
  await local.trustCheckpoint?.(hub, state.distrusted || state.proof !== undefined ? undefined : state.newest);
  report.findings = collapse(noted);
  if (report.outcome === 'synced' && report.findings.some((item) => ATTENTION_FINDINGS.has(item.kind))) {
    report.outcome = 'attention';
    const first = report.findings.find((item) => ATTENTION_FINDINGS.has(item.kind)) as HubFinding;
    report.reason = first.kind;
    report.message = first.sentence;
  }
  return report;

  // ---- the pull --------------------------------------------------------------------------------------------------------------------------------

  /** Pulls every writer log the hub holds further than this computer, the base stream first, writers the roster knows only once it knows them. */
  async function pull(hubStreams: HeadSet['streams']): Promise<void> {
    const pending: Array<{ stream: string; writer: string; seq: number; hash: string }> = [];
    for (const stream of hubStreams) {
      for (const head of stream.heads) {
        const mine = await local.head(stream.stream, head.writer);
        if (mine === undefined || head.seq > mine.seq) pending.push({ stream: stream.stream, writer: head.writer, seq: head.seq, hash: head.hash });
      }
    }
    pending.sort((a, b) => Number(b.stream === project) - Number(a.stream === project) || compareText(a.stream, b.stream) || compareText(a.writer, b.writer));
    for (;;) {
      const ready = pending.filter((item) => writerKey(roster, item.writer) !== undefined);
      if (ready.length === 0) break;
      let stored = 0;
      for (const item of ready) {
        pending.splice(pending.indexOf(item), 1);
        stored += await pullWriter(item.stream, item.writer);
      }
      if (stored > 0) roster = await local.roster();
      else if (pending.every((item) => writerKey(roster, item.writer) === undefined)) break;
    }
    // A writer the roster does not know after everything was pulled: what the hub says it holds from it is not taken.
    for (const item of pending) apply(witnessEntry(state, { hash: item.hash, verified: false, reason: 'unknown-writer' }));
  }

  /** The head a trusted version 2 checkpoint of this hub names for a writer log, for a late joiner (startFromBase, D-43). */
  function baseHeadOf(stream: string, writer: string): { seq: number; hash: string } | undefined {
    if (options.startFromBase !== true || state.newest === undefined) return undefined;
    const checkpoint = readCheckpoint(state.newest.payload);
    if (checkpoint === undefined || checkpoint.v !== 2) return undefined;
    const head = checkpoint.streams.find((item) => item.stream === stream)?.heads.find((item) => item.writer === writer);
    return head === undefined ? undefined : { seq: head.seq, hash: head.hash };
  }

  /** One writer's log, page by page from this computer's head: sorted by seq, each prev checked against the head, each header verified. */
  async function pullWriter(stream: string, writer: string): Promise<number> {
    // A late joiner holds nothing of this log: it starts after the head a trusted checkpoint names (already kept by seeCheckpoint), and the first
    // entry pulled must follow exactly that head.
    const holding = await local.head(stream, writer);
    let head = holding ?? baseHeadOf(stream, writer);
    // A late joiner reads in full a log no trusted checkpoint covers (a cell your organization's server does not hold, D-63): nothing is left out.
    if (options.startFromBase === true && holding === undefined && head === undefined && !report.readInFull.includes(stream)) report.readInFull.push(stream);
    let stored = 0;
    for (let page = 0; page < MAX_PAGES_PER_WRITER; page += 1) {
      const answer = await transport.entries(stream, writer, head === undefined ? 0 : head.seq + 1);
      if (apply(witnessResponse(state, answer, stream)).length > 0) throw new Stop();
      const delivered: Array<{ header: EntryHeader; body: unknown; hash: string }> = [];
      for (const raw of answer.entries) {
        const value = typeof raw === 'object' && raw !== null ? (raw as { header?: unknown; body?: unknown }) : {};
        const shape = parseHeaderShape(value.header);
        if (!shape.ok) {
          apply(witnessEntry(state, { hash: 'unreadable', verified: false, reason: shape.reason }));
          continue;
        }
        delivered.push({ header: shape.header, body: value.body, hash: entryHash(shape.header) });
      }
      delivered.sort((a, b) => a.header.seq - b.header.seq);
      const held = await local.holds(delivered.map((item) => item.hash));
      const accepted: SealedEntry[] = [];
      const taken = new Set<string>();
      let expectSeq = head === undefined ? 0 : head.seq + 1;
      let expectPrev = head === undefined ? GENESIS_PREV : head.hash;
      let stopped = false;
      for (const item of delivered) {
        const { header, hash } = item;
        if (header.stream !== stream || header.writer !== writer) {
          apply(witnessEntry(state, { hash, verified: false, reason: 'wrong-place' }));
          continue;
        }
        if (held.has(hash) || taken.has(hash)) {
          apply(witnessEntry(state, { hash, held: true }));
          continue;
        }
        // A second entry at a place this computer already holds is the writer's fork for the store's chain stage, not this exchange.
        if (header.seq < expectSeq) continue;
        // A gap: nothing after it is taken; the hub's head stays cited and becomes withheld after the grace period.
        if (header.seq > expectSeq) { stopped = true; break; }
        const problem = verifyDelivered(header, item.body, roster);
        if (problem !== undefined) {
          apply(witnessEntry(state, { hash, verified: false, reason: problem }));
          stopped = true;
          break;
        }
        if (header.prev !== expectPrev) { stopped = true; break; }
        apply(witnessEntry(state, { hash, verified: true }));
        accepted.push({ header, body: item.body as string });
        taken.add(hash);
        expectSeq += 1;
        expectPrev = hash;
      }
      if (accepted.length > 0) {
        const packets = stream === project && !state.distrusted ? inbox?.packets.filter(({ handle }) => !paired.has(handle)) : undefined;
        const result = packets?.length ? await local.ingest(accepted, [], packets) : await local.ingest(accepted, []);
        for (const handle of result.paired ?? []) paired.add(handle);
        report.pulled += result.added;
        report.notStored += result.notStored;
        stored += result.added;
      }
      const next = await local.head(stream, writer);
      // Delivered is not stored: the next page starts from what the store holds, and a page that moved nothing ends this writer.
      if (stopped || !answer.more || next === undefined || (head !== undefined && next.seq <= head.seq)) break;
      head = next;
    }
    return stored;
  }

  // ---- the push --------------------------------------------------------------------------------------------------------------------------------

  /**
   * Every entry above the hub's head per writer (all of a log the hub lacks), and every grant the hub does not list, in batches the hub takes. Only
   * blobs this computer holds are named, and an entry using a blob it lacks waits with the rest of its log (pushPlan, WR-07), so one missing blob
   * never refuses the whole push.
   */
  async function push(hubStreams: HeadSet['streams'], hubGrants: ReadonlySet<string>): Promise<void> {
    const hubSeq = new Map<string, number>();
    for (const stream of hubStreams) for (const head of stream.heads) hubSeq.set(`${stream.stream}/${head.writer}`, head.seq);
    const localStreams = [...(await local.heads())].sort((a, b) => Number(b.stream === project) - Number(a.stream === project) || compareText(a.stream, b.stream));
    let entries: SealedEntry[] = [];
    for (const stream of localStreams) {
      // Devices before session keys (Phase 33 D-62): a session.certify in the base stream reaches the hub before the session key's own entries.
      const sessionLast = (writer: string): number => Number(roster.deviceKey(writer) === undefined);
      for (const head of [...stream.heads].sort((a, b) => sessionLast(a.writer) - sessionLast(b.writer) || compareText(a.writer, b.writer))) {
        const above = hubSeq.get(`${stream.stream}/${head.writer}`) ?? -1;
        if (head.seq > above) entries.push(...(await local.entriesAfter(stream.stream, head.writer, above)));
      }
    }
    let grants = (await local.grants()).filter((grant) => !hubGrants.has(grant.hash)).map((grant) => grant.signed);
    const hashOf = new Map(entries.map((entry) => [entry, entryHash(entry.header)] as const));
    const cited = entries.length === 0 ? [] : await local.blobsCitedBy([...hashOf.values()]);
    const heldBlobs = new Set<string>();
    for (const blob of new Set(cited.map((ref) => ref.blob))) if ((await local.blob(blob)) !== undefined) heldBlobs.add(blob);
    const plan = pushPlan(entries, cited, heldBlobs, (entry) => hashOf.get(entry) as string);
    report.heldBack = plan.heldBack.length;
    entries = plan.entries;
    const wanted = new Set(entries.map((entry) => hashOf.get(entry) as string));
    const sentAll = entries;
    const accepted = new Set<string>();
    const lastRefusal = new Map<string, string>();
    for (let pass = 0; pass < PUSH_PASSES && (entries.length > 0 || grants.length > 0); pass += 1) {
      let acceptedThisPass = 0;
      const retry: SealedEntry[] = [];
      // A grant the hub could not place yet (its cell.create was in a later append) goes again with the retried entries (IN-05).
      const retryGrants: unknown[] = [];
      for (const batch of appendBatches(entries, grants, plan.blobRefs, (entry) => hashOf.get(entry) as string)) {
        const answer = await transport.append(batch, (hash) => local.blob(hash));
        for (const hash of answer.accepted) {
          if (wanted.has(hash) && !accepted.has(hash)) acceptedThisPass += 1;
          accepted.add(hash);
          lastRefusal.delete(hash);
        }
        for (const item of answer.refused) {
          const entry = batch.entries[item.index];
          const hash = item.hash ?? (entry === undefined ? '' : hashOf.get(entry) ?? '');
          lastRefusal.set(hash, item.reason);
          if (entry !== undefined && RETRY_REFUSALS.has(item.reason)) retry.push(entry);
        }
        for (const item of answer.grantsRefused) {
          const grant = item.reason === 'grant-not-placed' ? batch.grants?.[item.index] : undefined;
          if (grant !== undefined) retryGrants.push(grant);
        }
      }
      grants = retryGrants;
      if (acceptedThisPass === 0) break;
      entries = retry;
    }
    report.pushed = [...accepted].filter((hash) => wanted.has(hash)).length;
    report.refusedByHub = [...lastRefusal].map(([hash, reason]) => ({ hash, reason }));
    if (rolledBack && report.pushed > 0) report.repushed = true;
    // The hub acknowledged holding what it accepted: those heads raise the marks, so a later copy without them is a rollback.
    const raised = new Map<string, HeadSet['streams'][number]>();
    for (const entry of sentAll) {
      const hash = hashOf.get(entry) as string;
      if (!accepted.has(hash)) continue;
      const row = raised.get(entry.header.stream) ?? { stream: entry.header.stream, heads: [] };
      const known = row.heads.find((head) => head.writer === entry.header.writer);
      if (known === undefined) row.heads.push({ writer: entry.header.writer, seq: entry.header.seq, hash });
      else if (entry.header.seq > known.seq) Object.assign(known, { seq: entry.header.seq, hash });
      raised.set(entry.header.stream, row);
    }
    if (raised.size > 0) apply(witnessHeads(state, { streams: [...raised.values()] }, roster));
  }
}

/** One finding per kind: the witness's own count for withheld, delayed and rolled-back, otherwise how often it was seen in this exchange. */
function collapse(noted: readonly HubFinding[]): HubFinding[] {
  const order: HubFindingKind[] = [];
  const first = new Map<HubFindingKind, HubFinding>();
  const times = new Map<HubFindingKind, number>();
  for (const item of noted) {
    if (!first.has(item.kind)) { first.set(item.kind, item); order.push(item.kind); }
    times.set(item.kind, (times.get(item.kind) ?? 0) + 1);
  }
  return order.map((kind) => {
    const item = first.get(kind) as HubFinding;
    if (COUNTED_BY_WITNESS.has(kind)) return item;
    return { kind, sentence: findingSentence(kind), detail: item.detail, count: times.get(kind) as number };
  });
}
