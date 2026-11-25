// What the hub holds as your organization's trust host (Phase 71, 71-09; D-14, D-16): people's did:webvh logs, the signed status lists and, per
// member, the status entries of the credentials their entries cited. The tables are in hub.db (schema v4) and their rules are in the schema too: a
// log only grows and is never deleted, a list version is kept only as exactly one above the newest of its list, and nothing is ever deleted.
//
// Every write is verified first with the extension's own pure code: a log only when verifyWebvhLog accepts the whole log, a list only when it is
// signed by the key your organization's policy names for it, newer than the one held and keeping every revocation the held one has. The policy is
// your organization's signed layer from the hub's configuration (HUB_ORGANIZATION_POLICY, checked against HUB_ORGANIZATION_KEY); without a policy
// that verifies and holds a credentials section, nothing here is served or stored and the hub judges no evidence.
//
// The hub's own copy is the source its members read, so the hub never "fetches" a list: its newest copy counts as fetched now (freshness.ts).
import type { CredentialsSection, StatusListPolicy } from '@ext/domain/gate/credentialsSection';
import type { ScaleTable } from '@ext/domain/gate/labels';
import { verifyOrganizationLayer } from '@ext/domain/gate/enrolment';
import { decodePublicKeyMultibase } from '@ext/domain/credentials/multibase';
import type { NewestList } from '@ext/domain/credentials/freshness';
import { keepsRevocations, newerThan, statusAt, verifyStatusList } from '@ext/domain/credentials/statusList';
import type { StatusListState } from '@ext/domain/credentials/statusList';
import { WEBVH_FAILURES, parseWebvhDid, verifyWebvhLog } from '@ext/domain/did/didWebvh';
import type { WebvhState } from '@ext/domain/did/didWebvh';
import { computerSlotsOf } from '@ext/domain/credentials/computerSlots';
import type { ComputerSlot } from '@ext/domain/credentials/computerSlots';
import { readDidDocument } from '@ext/domain/did/didDocument';
import type { HubStore } from './hubStore';

/** How long a verified policy is reused before it is checked again (its expiry included). */
const POLICY_RECHECK_MS = 60_000;
/** A status list body the hub keeps: a 262,144-entry list compressed is far below this. */
export const MAX_STATUS_LIST_BYTES = 128 * 1024;
export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_WITNESS_BYTES = 256 * 1024;
/** The path the hub serves a status list at: the policy's list id must be this path on any host. */
export const STATUS_ROUTE_PREFIX = '/v1/trust/status/';

export const TRUST_REFUSALS = {
  'no-policy': 'This hub has no valid copy of your organization\'s rules with credentials, so it cannot host identities or status lists. Ask your organization\'s administrator.',
  'wrong-path': 'This DID log is for another address on the hub.',
  'wrong-scid': 'This DID log is for another identity than the one the hub holds at this address.',
  'not-an-extension': 'This DID log does not start with the history the hub holds, so it was not stored.',
  'not-in-policy': 'Your organization\'s rules name no status list at this address.',
  'not-newer': 'This status list is not a newer copy of the one the hub holds.',
  'revocation-cleared': 'This status list clears a revocation, and a revocation can never be undone.',
  'version-conflict': 'Another copy of this status list was stored first. Read the newest copy, then make the change again.',
  'computer-slots': 'This identity lists its computers in a way that is not allowed: at most five, each with two places for computers, none used twice.',
  'computer-place-taken': 'A computer this identity lists uses a status list place another person\'s computer already uses. Bind that computer again.',
} as const;
export type TrustRefusal = keyof typeof TRUST_REFUSALS;

/** The computer slots of a log's newest document (none for a deactivated DID or one with no computers), or 'invalid' (D-25). */
function latestComputerSlots(state: WebvhState): readonly ComputerSlot[] | 'invalid' {
  const version = state.versions[state.versions.length - 1];
  if (version === undefined || version.deactivated) return [];
  const read = readDidDocument(version.document, version.did);
  return read.ok ? computerSlotsOf(read.document) : [];
}

export type TrustPolicy = { ok: true; section: CredentialsSection; scales: ScaleTable } | { ok: false };

export type PutResult = { ok: true; stored: boolean } | { ok: false; status: 409 | 422 | 503; reason: string; message: string };

export interface StoredLog {
  path: string;
  did: string;
  scid: string;
  log: string;
  witness: string | undefined;
}

export interface StoredList {
  id: string;
  version: number;
  hash: string;
  validFrom: string;
  body: string;
  storedAt: number;
}

/** One status entry a member's entry relied on: the list, the index and its purpose. */
export interface CitedStatus {
  list: string;
  index: number;
  purpose: 'revocation' | 'suspension';
}

export interface OrganizationSource {
  /** The signed layer's text, read from HUB_ORGANIZATION_POLICY at start; undefined when the setting is absent or the file could not be read. */
  text: string | undefined;
  /** The issuer's public key (base64url) from HUB_ORGANIZATION_KEY. */
  key: string | undefined;
}

const refuse = (status: 409 | 422 | 503, reason: TrustRefusal): PutResult => ({ ok: false, status, reason, message: TRUST_REFUSALS[reason] });

/** The hub path a DID's log lives at: its path segments joined with '/', or '.well-known' for a DID with no path (did:webvh DID-to-HTTPS). */
export function hostPathOf(did: string): string | undefined {
  const parsed = parseWebvhDid(did);
  if (!parsed.ok) return undefined;
  return parsed.value.path.length === 0 ? '.well-known' : parsed.value.path.join('/');
}

export class TrustStore {
  private checked: { at: number; policy: TrustPolicy } | undefined;
  private readonly lists = new Map<string, StatusListState>();
  private states: { at: number; states: Record<string, WebvhState> } | undefined;

  constructor(
    private readonly store: HubStore,
    private readonly organization: OrganizationSource,
  ) {}

  /** Your organization's credentials section and scales, verified at most a minute ago; ok false when there is none that verifies now. */
  policy(now: number): TrustPolicy {
    if (this.checked !== undefined && now - this.checked.at >= 0 && now - this.checked.at < POLICY_RECHECK_MS) return this.checked.policy;
    let policy: TrustPolicy = { ok: false };
    const { text, key } = this.organization;
    if (text !== undefined && key !== undefined) {
      const read = verifyOrganizationLayer(text, { issuerPublicKey: key, now });
      if (read.ok && read.document.credentials !== undefined) policy = { ok: true, section: read.document.credentials, scales: read.document.labels.scales };
    }
    this.checked = { at: now, policy };
    return policy;
  }

  /** The policy's entry for a list served at STATUS_ROUTE_PREFIX + name: the list whose id is that path on its host. */
  listEntry(now: number, name: string): StatusListPolicy | undefined {
    const policy = this.policy(now);
    if (!policy.ok) return undefined;
    return policy.section.statusLists.find((entry) => {
      try {
        return new URL(entry.uri).pathname === `${STATUS_ROUTE_PREFIX}${name}`;
      } catch {
        return false;
      }
    });
  }

  getLog(path: string): StoredLog | undefined {
    const row = this.store.trustTransaction((sql) => sql('SELECT path, did, scid, log, witness FROM trust_logs WHERE path = ?').get(path)) as
      | { path: string; did: string; scid: string; log: string; witness: string | null }
      | undefined;
    return row === undefined ? undefined : { path: row.path, did: row.did, scid: row.scid, log: row.log, witness: row.witness ?? undefined };
  }

  /**
   * Stores a DID log at a path when verifyWebvhLog accepts the whole log (with the witness file given, or the one held), its latest DID lives at
   * that path, and it extends the log held there for the same identity. The same log again is not stored twice.
   */
  putLog(path: string, log: string, witness: string | undefined, now: number): PutResult {
    if (!this.policy(now).ok) return refuse(503, 'no-policy');
    const held = this.getLog(path);
    const witnessFile = witness ?? held?.witness;
    const verified = verifyWebvhLog(log, { now, ...(witnessFile === undefined ? {} : { witnessFile }) });
    if (!verified.ok) return { ok: false, status: 422, reason: verified.reason, message: WEBVH_FAILURES[verified.reason] };
    if (hostPathOf(verified.state.did) !== path) return refuse(422, 'wrong-path');
    // D-25, G467: the newest document lists at most five computers, in the computer places, none sharing a place with another person's computer.
    const slots = latestComputerSlots(verified.state);
    if (slots === 'invalid') return refuse(422, 'computer-slots');
    if (slots.length > 0) {
      const mine = new Set(slots.flatMap((slot) => [slot.revocation, slot.suspension]));
      for (const state of Object.values(this.didStates(now))) {
        if (state.scid === verified.state.scid) continue;
        const theirs = latestComputerSlots(state);
        if (theirs !== 'invalid' && theirs.some((slot) => mine.has(slot.revocation) || mine.has(slot.suspension))) return refuse(422, 'computer-place-taken');
      }
    }
    if (held !== undefined) {
      if (verified.state.scid !== held.scid) return refuse(422, 'wrong-scid');
      if (!log.startsWith(held.log)) return refuse(422, 'not-an-extension');
      if (log === held.log && witnessFile === held.witness) return { ok: true, stored: false };
    }
    this.store.trustTransaction((sql) => {
      if (held === undefined) {
        sql('INSERT INTO trust_logs (path, scid, did, log, witness, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(path, verified.state.scid, verified.state.did, log, witnessFile ?? null, now);
      } else {
        sql('UPDATE trust_logs SET did = ?, log = ?, witness = ?, updated_at = ? WHERE path = ?').run(verified.state.did, log, witnessFile ?? null, now, path);
      }
    });
    this.states = undefined;
    return { ok: true, stored: true };
  }

  /** Stores a witness file for a log the hub holds, when the held log still verifies with it. */
  putWitness(path: string, witness: string, now: number): PutResult {
    if (!this.policy(now).ok) return refuse(503, 'no-policy');
    const held = this.getLog(path);
    if (held === undefined) return refuse(422, 'wrong-path');
    const verified = verifyWebvhLog(held.log, { now, witnessFile: witness });
    if (!verified.ok) return { ok: false, status: 422, reason: verified.reason, message: WEBVH_FAILURES[verified.reason] };
    if (witness === held.witness) return { ok: true, stored: false };
    this.store.trustTransaction((sql) => sql('UPDATE trust_logs SET witness = ?, updated_at = ? WHERE path = ?').run(witness, now, path));
    this.states = undefined;
    return { ok: true, stored: true };
  }

  /** The verified state of every log the hub holds, by its latest DID; a log that no longer verifies (a future-dated entry) is left out. */
  didStates(now: number): Readonly<Record<string, WebvhState>> {
    if (this.states !== undefined && now - this.states.at >= 0 && now - this.states.at < POLICY_RECHECK_MS) return this.states.states;
    const rows = this.store.trustTransaction((sql) => sql('SELECT log, witness FROM trust_logs').all()) as Array<{ log: string; witness: string | null }>;
    const states: Record<string, WebvhState> = {};
    for (const row of rows) {
      const verified = verifyWebvhLog(row.log, { now, ...(row.witness === null ? {} : { witnessFile: row.witness }) });
      if (verified.ok) states[verified.state.did] = verified.state;
    }
    this.states = { at: now, states };
    return states;
  }

  newestList(id: string): StoredList | undefined {
    const row = this.store.trustTransaction((sql) =>
      sql('SELECT id, version, hash, valid_from, body, stored_at FROM trust_lists WHERE id = ? ORDER BY version DESC LIMIT 1').get(id),
    ) as { id: string; version: number; hash: string; valid_from: string; body: string; stored_at: number } | undefined;
    return row === undefined ? undefined : { id: row.id, version: row.version, hash: row.hash, validFrom: row.valid_from, body: row.body, storedAt: row.stored_at };
  }

  /** A list version by its hash (an entry cites the list it was checked with by hash), as its parsed JSON. */
  listByHash(hash: string): unknown {
    const row = this.store.trustTransaction((sql) => sql('SELECT body FROM trust_lists WHERE hash = ?').get(hash)) as { body: string } | undefined;
    return row === undefined ? undefined : (JSON.parse(row.body) as unknown);
  }

  /** The newest copy of every list your organization's policy names, as freshness.ts reads it (the hub's own copy counts as fetched now). */
  newest(now: number): Record<string, NewestList> {
    const policy = this.policy(now);
    const out: Record<string, NewestList> = {};
    if (!policy.ok) return out;
    for (const entry of policy.section.statusLists) {
      const held = this.newestList(entry.uri);
      if (held !== undefined) out[entry.uri] = { validFrom: held.validFrom, fetchedAt: now };
    }
    return out;
  }

  /** The parsed state of a stored list version, verified once against the policy's key for it. */
  private stateOf(entry: StatusListPolicy, held: StoredList): StatusListState | undefined {
    const cached = this.lists.get(held.hash);
    if (cached !== undefined) return cached;
    const verified = verifyStatusList(JSON.parse(held.body) as unknown, decodePublicKeyMultibase(entry.key));
    if (!verified.ok) return undefined;
    this.lists.set(held.hash, verified.list);
    return verified.list;
  }

  /**
   * Stores a signed list under the policy's entry: signed by the key the policy names (no other path, D-14), valid now, of that id and purpose,
   * and, when the hub holds one, exactly one version above it, newer, and keeping every revocation it has. The first copy may be any version, so a
   * hub can start from a site's existing lists.
   */
  putStatusList(entry: StatusListPolicy, value: unknown, body: string, now: number, options: { exactNext?: boolean } = {}): PutResult {
    const verified = verifyStatusList(value, decodePublicKeyMultibase(entry.key), now);
    if (!verified.ok) return { ok: false, status: 422, reason: verified.reason, message: verified.message };
    if (verified.list.id !== entry.uri || verified.list.purpose !== entry.purpose) return refuse(422, 'not-in-policy');
    const held = this.newestList(entry.uri);
    if (held !== undefined) {
      if (held.hash === verified.hash) return { ok: true, stored: false };
      if (options.exactNext !== false && verified.list.version !== held.version + 1) return refuse(409, 'version-conflict');
      const heldState = this.stateOf(entry, held);
      if (heldState === undefined || !newerThan(verified.list, heldState)) return refuse(422, 'not-newer');
      if (!keepsRevocations(verified.list, heldState)) return refuse(422, 'revocation-cleared');
    }
    try {
      this.store.trustTransaction((sql) =>
        sql('INSERT INTO trust_lists (id, version, hash, valid_from, body, stored_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          entry.uri,
          verified.list.version,
          verified.hash,
          verified.list.validFrom,
          body,
          now,
        ),
      );
    } catch {
      // The schema's own compare-and-swap: another copy took this version first.
      return refuse(409, 'version-conflict');
    }
    this.lists.set(verified.hash, verified.list);
    return { ok: true, stored: true };
  }

  /** Every log the hub holds, for the trust export (71-11). */
  allLogs(): StoredLog[] {
    const rows = this.store.trustTransaction((sql) => sql('SELECT path, did, scid, log, witness FROM trust_logs ORDER BY path').all()) as Array<{
      path: string;
      did: string;
      scid: string;
      log: string;
      witness: string | null;
    }>;
    return rows.map((row) => ({ path: row.path, did: row.did, scid: row.scid, log: row.log, witness: row.witness ?? undefined }));
  }

  /** The newest version of every list the hub holds, for the trust export (71-11). */
  newestLists(): StoredList[] {
    const ids = this.store.trustTransaction((sql) => sql('SELECT DISTINCT id FROM trust_lists ORDER BY id').all()) as Array<{ id: string }>;
    return ids.flatMap((row) => {
      const held = this.newestList(row.id);
      return held === undefined ? [] : [held];
    });
  }

  /** The parsed newest copy of a list the policy names, as an edge's import compares against (71-11). */
  heldListState(entry: StatusListPolicy): StatusListState | undefined {
    const held = this.newestList(entry.uri);
    return held === undefined ? undefined : this.stateOf(entry, held);
  }

  /** Keeps the status entries a member's entry relied on (once each). */
  recordCited(project: string, member: string, cited: readonly CitedStatus[]): void {
    if (cited.length === 0) return;
    this.store.trustTransaction((sql) => {
      const insert = sql('INSERT OR IGNORE INTO trust_cited (project, member, list, idx, purpose) VALUES (?, ?, ?, ?, ?)');
      for (const item of cited) insert.run(project, member, item.list, item.index, item.purpose);
    });
  }

  citedOf(project: string, member: string): CitedStatus[] {
    const rows = this.store.trustTransaction((sql) => sql('SELECT list, idx, purpose FROM trust_cited WHERE project = ? AND member = ?').all(project, member)) as Array<{
      list: string;
      idx: number;
      purpose: 'revocation' | 'suspension';
    }>;
    return rows.map((row) => ({ list: row.list, index: row.idx, purpose: row.purpose }));
  }

  /**
   * Whether the hub's newest copy of a list sets a bit for a credential this member's entries cited (D-16). A revocation never clears, so its
   * refusal stays; a suspension cleared by a newer list lets the member in again. A list the hub does not hold proves nothing.
   */
  underReview(project: string, member: string, now: number): boolean {
    const policy = this.policy(now);
    if (!policy.ok) return false;
    for (const cited of this.citedOf(project, member)) {
      const entry = policy.section.statusLists.find((item) => item.uri === cited.list);
      const held = entry === undefined ? undefined : this.newestList(cited.list);
      if (entry === undefined || held === undefined) continue;
      const state = this.stateOf(entry, held);
      if (state !== undefined && statusAt(state, cited.index, cited.purpose) === true) return true;
    }
    return false;
  }
}
