// The trust export (Phase 71, 71-11; D-17, research 4.2): the identities and revocations an edge needs, carried from HQ in one .near-trust-export
// file beside 47-14's signed user export (never inside it). The file is a bundle of objects that each verify on their own: did:webvh logs, signed
// status lists and your organization's signed policy layer that holds credentials@1. Nothing new is signed and nothing is trusted for being in the
// file: an edge takes an object only when it verifies and is newer than what the edge holds, and every refusal is named in the report. Offline age
// counts from each list's own validFrom (freshness.ts), never from the file's time. Pure: no I/O and no clock; the caller passes `now`.
import { canonicalize } from '../team/canonical';
import type { CredentialsSection } from '../gate/credentialsSection';
import { verifyOrganizationLayer } from '../gate/enrolment';
import { WEBVH_FAILURES, parseWebvhDid, verifyWebvhLog } from '../did/didWebvh';
import { decodePublicKeyMultibase } from './multibase';
import { keepsRevocations, newerThan, verifyStatusList } from './statusList';
import type { StatusListState } from './statusList';

export const TRUST_EXPORT_EXTENSION = '.near-trust-export';
export const TRUST_EXPORT_FORMAT = 'near-trust-export/1';
/** The largest file read: well above HQ's expected logs and lists, and checked before parsing. */
export const MAX_TRUST_EXPORT_BYTES = 64 * 1024 * 1024;

export type TrustObjectKind = 'policy-layer' | 'did-log' | 'status-list';

export interface ExportedLog {
  /** Where the log lives on a hub: the DID's path segments joined with '/', or '.well-known'. */
  readonly path: string;
  readonly log: string;
  readonly witness?: string;
}

export interface TrustExportInput {
  readonly policyLayer: unknown;
  readonly logs: readonly ExportedLog[];
  /** Signed status list credentials, the newest version of each. */
  readonly lists: readonly unknown[];
  /** ISO time the file was made; shown to the operator only, never used to judge age. */
  readonly exportedAt: string;
}

export const TRUST_IMPORT_REFUSALS = {
  'unreadable': 'This file is not a trust export this version reads.',
  'unknown-kind': 'This object is of a kind a trust export does not carry, so it was not taken.',
  'policy-invalid': 'Your organization\'s rules in this file do not verify with your organization\'s key, so they were not taken.',
  'policy-older': 'Your organization\'s rules in this file are older than the ones here, so they were not taken.',
  'no-policy': 'No rules of your organization are here or in the file, so no status list could be checked.',
  'list-not-in-policy': 'Your organization\'s rules name no status list with this id, so it was not taken.',
  'list-invalid': 'This status list does not verify with the key your organization\'s rules name for it, so it was not taken.',
  'older': 'This status list is not newer than the copy here, so it was not taken.',
  'revocation-cleared': 'This status list clears a revocation the copy here has, so it was not taken.',
  'log-invalid': 'This identity log does not verify, so it was not taken.',
  'wrong-path': 'This identity log is filed under another address than its own, so it was not taken.',
  'log-conflict': 'This identity log is not a continuation of the one here, so it was not taken.'
} as const;
export type TrustImportRefusal = keyof typeof TRUST_IMPORT_REFUSALS;

export interface HeldTrust {
  /** Your organization's policy issuer key (base64url): the only key a policy layer in the file may be signed by. */
  readonly issuerPublicKey: string;
  /** The credentials section and the issue time of the policy layer the edge holds, when it holds one. */
  readonly policy?: { readonly section: CredentialsSection; readonly issuedAt: string };
  /** The lists the edge holds, by id. */
  readonly lists: Readonly<Record<string, StatusListState>>;
  /** The logs the edge holds, by path. */
  readonly logs: Readonly<Record<string, { readonly log: string; readonly scid: string }>>;
}

export interface TakenList { readonly id: string; readonly value: unknown; readonly state: StatusListState; readonly hash: string }

export interface TrustImport {
  readonly take: {
    readonly policyLayer?: { readonly value: unknown; readonly section: CredentialsSection; readonly issuedAt: string };
    readonly logs: readonly (ExportedLog & { readonly did: string; readonly scid: string })[];
    readonly lists: readonly TakenList[];
  };
  readonly refused: readonly { readonly index: number; readonly kind: string; readonly reason: TrustImportRefusal | string; readonly message: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The hub path of a did:webvh DID, or undefined for anything else. */
export function didHostPath(did: string): string | undefined {
  const parsed = parseWebvhDid(did);
  if (!parsed.ok) return undefined;
  return parsed.value.path.length === 0 ? '.well-known' : parsed.value.path.join('/');
}

/** The file's text: canonical JSON of the format, the time and the objects (the policy layer first, then logs, then lists). */
export function buildTrustExport(input: TrustExportInput): string {
  const objects: Record<string, unknown>[] = [{ kind: 'policy-layer', layer: input.policyLayer }];
  for (const log of input.logs) objects.push({ kind: 'did-log', path: log.path, log: log.log, ...(log.witness === undefined ? {} : { witness: log.witness }) });
  for (const list of input.lists) objects.push({ kind: 'status-list', list });
  return canonicalize({ format: TRUST_EXPORT_FORMAT, exportedAt: input.exportedAt, objects });
}

/**
 * Reads a trust export against what the edge holds, at `now`. The policy layer is read first: it must verify with the edge's issuer key and not be
 * older than the edge's; lists are then checked against the keys of the newest policy (the file's, when taken, otherwise the edge's). A list is
 * taken only when newer than the edge's copy and keeping every revocation it has; a log only when it verifies whole, lives at its own path and
 * continues the edge's log. Each refused object is named; the rest is still taken. Never throws.
 */
export function readTrustExport(text: string, held: HeldTrust, now: number): TrustImport {
  const refused: { index: number; kind: string; reason: TrustImportRefusal | string; message: string }[] = [];
  const logs: (ExportedLog & { did: string; scid: string })[] = [];
  const lists: TakenList[] = [];
  const refuse = (index: number, kind: string, reason: TrustImportRefusal): void => { refused.push({ index, kind, reason, message: TRUST_IMPORT_REFUSALS[reason] }); };
  let file: unknown;
  try {
    file = typeof text === 'string' && text.length <= MAX_TRUST_EXPORT_BYTES ? JSON.parse(text) : undefined;
  } catch {
    file = undefined;
  }
  if (!isRecord(file) || file.format !== TRUST_EXPORT_FORMAT || !Array.isArray(file.objects)) {
    refuse(-1, 'file', 'unreadable');
    return { take: { logs, lists }, refused };
  }
  const objects = file.objects as unknown[];

  let policyLayer: TrustImport['take']['policyLayer'];
  let section = held.policy?.section;
  objects.forEach((object, index) => {
    if (!isRecord(object) || object.kind !== 'policy-layer') return;
    const read = verifyOrganizationLayer(object.layer, { issuerPublicKey: held.issuerPublicKey, now, ...(held.policy === undefined ? {} : { lastIssuedAt: held.policy.issuedAt }) });
    if (!read.ok) return refuse(index, 'policy-layer', read.reason === 'older' ? 'policy-older' : 'policy-invalid');
    if (read.document.credentials === undefined) return refuse(index, 'policy-layer', 'policy-invalid');
    if (policyLayer === undefined || read.issuedAt > policyLayer.issuedAt) {
      policyLayer = { value: object.layer, section: read.document.credentials, issuedAt: read.issuedAt };
      section = read.document.credentials;
    }
  });

  objects.forEach((object, index) => {
    if (!isRecord(object) || typeof object.kind !== 'string') return refuse(index, 'unknown', 'unknown-kind');
    if (object.kind === 'policy-layer') return;
    if (object.kind === 'status-list') {
      if (section === undefined) return refuse(index, 'status-list', 'no-policy');
      const id = isRecord(object.list) ? object.list.id : undefined;
      const entry = section.statusLists.find((item) => item.uri === id);
      if (entry === undefined) return refuse(index, 'status-list', 'list-not-in-policy');
      const verified = verifyStatusList(object.list, decodePublicKeyMultibase(entry.key), now);
      if (!verified.ok || verified.list.purpose !== entry.purpose) return refuse(index, 'status-list', 'list-invalid');
      const mine = held.lists[entry.uri];
      const earlier = lists.find((item) => item.id === entry.uri)?.state;
      for (const before of [mine, earlier]) {
        if (before === undefined) continue;
        if (!newerThan(verified.list, before)) return refuse(index, 'status-list', 'older');
        if (!keepsRevocations(verified.list, before)) return refuse(index, 'status-list', 'revocation-cleared');
      }
      const kept = lists.filter((item) => item.id !== entry.uri);
      lists.length = 0;
      lists.push(...kept, { id: entry.uri, value: object.list, state: verified.list, hash: verified.hash });
      return;
    }
    if (object.kind === 'did-log') {
      const { path, log, witness } = object;
      if (typeof path !== 'string' || typeof log !== 'string' || (witness !== undefined && typeof witness !== 'string')) return refuse(index, 'did-log', 'log-invalid');
      const verified = verifyWebvhLog(log, { now, ...(witness === undefined ? {} : { witnessFile: witness }) });
      if (!verified.ok) {
        refused.push({ index, kind: 'did-log', reason: verified.reason, message: `${TRUST_IMPORT_REFUSALS['log-invalid']} ${WEBVH_FAILURES[verified.reason]}` });
        return;
      }
      if (didHostPath(verified.state.did) !== path) return refuse(index, 'did-log', 'wrong-path');
      const mine = held.logs[path];
      if (mine !== undefined) {
        if (mine.scid !== verified.state.scid || !log.startsWith(mine.log)) return refuse(index, 'did-log', 'log-conflict');
        if (log === mine.log) return;
      }
      logs.push({ path, log, ...(witness === undefined ? {} : { witness: witness as string }), did: verified.state.did, scid: verified.state.scid });
      return;
    }
    return refuse(index, object.kind.slice(0, 40), 'unknown-kind');
  });
  return { take: { ...(policyLayer === undefined ? {} : { policyLayer }), logs, lists }, refused };
}
