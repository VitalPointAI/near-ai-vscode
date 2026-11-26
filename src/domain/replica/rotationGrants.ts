import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import { isRecord } from '../team/validate';
import { MAX_GRANT_PAGES, MAX_GRANT_WRAPS, readGrant } from './cellKeys';
import { readGrantPages } from './grantPages';
import { verifiedCellAccess } from './rotationProof';
import type { AccessRevision } from './rotationProof';

const HASH = /^[0-9a-f]{64}$/;
const CELL = /^[0-9a-f]{32}$/;
const MAX_GRANTS = 4096;
const MAX_EVIDENCE_HASHES = 8192;
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value);

export interface GrantCommitment {
  hash: string;
  pages: readonly string[];
  recipients: readonly string[];
}

export interface GrantEvidence {
  project: string;
  cell: string;
  epoch: number;
  policy: string | null;
  grants: readonly GrantCommitment[];
  excluded: readonly string[];
}

function orderedHashes(value: unknown, maximum: number): value is readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  let previous = '';
  for (const hash of value) {
    if (!isHash(hash) || hash <= previous) return false;
    previous = hash;
  }
  return true;
}

function grantShape(value: unknown): value is GrantCommitment {
  return isRecord(value) && Object.keys(value).length === 3 && isHash(value.hash) &&
    orderedHashes(value.pages, MAX_GRANT_PAGES) && orderedHashes(value.recipients, MAX_GRANT_WRAPS) && value.recipients.length > 0;
}

function evidenceShape(value: unknown): value is GrantEvidence {
  if (!isRecord(value) || Object.keys(value).length !== 6 || typeof value.project !== 'string' || !CELL.test(value.project) ||
      typeof value.cell !== 'string' || !CELL.test(value.cell) || typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 1 ||
      (value.policy !== null && !isHash(value.policy)) || !orderedHashes(value.excluded, MAX_GRANT_WRAPS) ||
      !Array.isArray(value.grants) || value.grants.length > MAX_GRANTS) return false;
  let previous = '';
  let hashes = value.excluded.length;
  const pages = new Set<string>();
  const heads = new Set<string>();
  for (const grant of value.grants) {
    if (!grantShape(grant) || grant.hash <= previous) return false;
    hashes += 1 + grant.pages.length + grant.recipients.length;
    if (hashes > MAX_EVIDENCE_HASHES) return false;
    previous = grant.hash;
    heads.add(grant.hash);
    for (const page of grant.pages) pages.add(page);
  }
  return [...heads].every((hash) => !pages.has(hash));
}

/** Digest of the private manifest placed in the salted cell leaf. Do not send this value to a blind relay. */
export function grantEvidenceHash(value: unknown): string | undefined {
  return evidenceShape(value) ? createHash('sha256').update('near-ai/cell-access/1/grant-evidence\n').update(canonicalBytes(value)).digest('hex') : undefined;
}

function sameGrant(a: GrantCommitment, b: GrantCommitment): boolean {
  return a.hash === b.hash && a.pages.length === b.pages.length && a.pages.every((page, index) => page === b.pages[index]) &&
    a.recipients.length === b.recipients.length && a.recipients.every((writer, index) => writer === b.recipients[index]);
}

/** Call with the head hash, page hashes and recipient union of a completely verified grant. */
export function matchesGrantEvidence(evidence: GrantEvidence, grant: GrantCommitment): boolean {
  return evidenceShape(evidence) && grantShape(grant) && evidence.grants.some((item) => sameGrant(item, grant));
}

/** Resolves a private grant opening against an entry already selected by the roster fold. */
export function openGrantEvidence(project: string, revisions: ReadonlyMap<string, AccessRevision>, value: unknown):
  { entry: string; evidence: GrantEvidence } | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 4 || !isHash(value.entry) ||
    !evidenceShape(value.evidence) || value.evidence.project !== project) return undefined;
  const revision = revisions.get(value.entry);
  if (revision === undefined) return undefined;
  const decision = verifiedCellAccess(revision, value.commitment, value.cell, value.evidence.cell);
  const excluded = new Set(value.evidence.excluded);
  if (decision?.decision === 'continues' && value.evidence.grants.some((grant) => grant.recipients.some((writer) => excluded.has(writer)))) return undefined;
  return decision !== undefined && decision.epoch === value.evidence.epoch && decision.evidence === grantEvidenceHash(value.evidence)
    ? { entry: value.entry, evidence: value.evidence } : undefined;
}

/** Verify the grant and its pages before staging a confidential handoff. The signed roster may still be in transit. */
export function readGrantDelivery(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !isRecord(value.opening) || !evidenceShape(value.opening.evidence) ||
      !Array.isArray(value.grants) || value.grants.length === 0 || value.grants.length > MAX_GRANT_PAGES + 1) return undefined;
  const [head, ...pages]: unknown[] = value.grants;
  const read = pages.length === 0 ? readGrant(head) : readGrantPages(head, pages);
  if (!read.ok || (read.grant.pages?.length ?? 0) !== pages.length) return undefined;
  const { cell, epoch } = read.grant;
  const evidence = value.opening.evidence;
  const recipients = read.grant.wraps.map(({ writer }) => writer).sort();
  return cell === evidence.cell && epoch === evidence.epoch &&
    matchesGrantEvidence(evidence, { hash: read.hash, pages: read.grant.pages ?? [], recipients })
    ? { opening: value.opening, grants: value.grants as readonly unknown[], project: evidence.project, recipients } : undefined;
}

export interface GrantEvidenceDelta {
  epoch: number;
  grants: readonly GrantCommitment[];
  excluded: readonly string[];
  policy?: string | null;
}

/** Retain all prior issuances within the epoch and retain pending exclusions across retries. */
export function advanceGrantEvidence(prior: GrantEvidence, delta: GrantEvidenceDelta): GrantEvidence | undefined {
  if (!evidenceShape(prior) || !orderedHashes(delta.excluded, MAX_GRANT_WRAPS)) return undefined;
  const rotates = delta.epoch === prior.epoch + 1;
  if (delta.epoch !== prior.epoch && !rotates) return undefined;
  if (rotates && delta.grants.length !== 1) return undefined;
  const exclusions = new Set([...prior.excluded, ...delta.excluded]);
  const pending = !rotates && prior.grants.some((grant) => grant.recipients.some((writer) => exclusions.has(writer)));
  const grants = new Map((rotates ? [] : prior.grants).map((grant) => [grant.hash, grant]));
  for (const grant of delta.grants) {
    if (!grantShape(grant)) return undefined;
    const known = grants.get(grant.hash);
    if (known !== undefined) {
      if (!sameGrant(known, grant)) return undefined;
      continue;
    }
    if (pending || grant.recipients.some((writer) => exclusions.has(writer))) return undefined;
    grants.set(grant.hash, grant);
  }
  const next: GrantEvidence = { ...prior, epoch: delta.epoch, policy: delta.policy === undefined ? prior.policy : delta.policy, excluded: [...exclusions].sort(),
    grants: [...grants.values()].sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0) };
  return evidenceShape(next) ? next : undefined;
}
