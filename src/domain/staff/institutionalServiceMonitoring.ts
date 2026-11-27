import { canonicalBytes } from '../team/canonical';
import type { InstitutionalBriefBinding, InstitutionalBriefReview, InstitutionalBriefSource, PreparedInstitutionalDraft } from './institutionalBrief';
import {
  canonicalDigest, institutionalBriefDigest, institutionalBriefMaxBytes, institutionalSourceHash, metadataSource, record,
  requestedCatalogueRows, requireCatalogue, sourceReferences, type InstitutionalCatalogueSource,
} from './institutionalEvidence';

export const institutionalServiceMonitoringDirectory = '.planning/staff/institutional/j1/service-monitoring';

const minimumFixtureCell = 5;
const fixturePin = Object.freeze({
  approval: 'office-help-fixture-r1',
  purpose: 'fictional-office-help-j1-05',
  requester: 'fictional-service-monitoring-reviewer',
  productId: 'office-help-aggregate',
  recordId: 'item-1b000001',
  basis: Object.freeze({ period: '2026-11', cutoff: '2026-11-30', clockBasis: 'utc-day-close', partition: 'closed-or-unresolved' }),
  counts: Object.freeze({ closed: 67, unresolved: 53, intake: 120 }),
});
const fixtureProofs = {
  supervisor: ['office-help-validation', 'fictional-hr-services-supervisor'],
  feedCustodian: ['office-help-custody', 'fictional-feed-custodian'],
  aggregate: ['office-help-snapshot', 'fictional-aggregate-attestor'],
  availability: ['office-help-availability', 'fictional-feed-availability-attestor'],
} as const;

interface ServiceMonitoringSnapshot {
  readonly id: string;
  readonly basis: typeof fixturePin.basis;
  readonly counts: { readonly closed: number; readonly unresolved: number; readonly intake: number };
  readonly resolvedFraction: { readonly numerator: number; readonly denominator: number };
  readonly evidence: InstitutionalCatalogueSource;
}

export type InstitutionalServiceMonitoringEvidence =
  | { readonly state: 'unavailable' | 'unknown'; readonly records: readonly [] }
  | {
    readonly state: 'available';
    readonly productId: string;
    readonly reportingKey: string;
    readonly supervisor: InstitutionalCatalogueSource;
    readonly feedCustodian: InstitutionalCatalogueSource;
    readonly records: readonly [ServiceMonitoringSnapshot];
  };

export interface InstitutionalServiceMonitoringReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J1-05';
  readonly kind: 'service-monitoring';
  readonly reportingKey: string;
  readonly supervisor: InstitutionalCatalogueSource;
  readonly feedCustodian: InstitutionalCatalogueSource;
  readonly validation: 'pending';
}

function fixtureProof(
  input: unknown, kind: keyof typeof fixtureProofs, project: string, sources: readonly InstitutionalBriefSource[],
): InstitutionalCatalogueSource {
  const [id, role] = fixtureProofs[kind];
  const proof = metadataSource(sources, input, role);
  const text = `Fictional office-help fixture proof for ${id}.`;
  const approved: InstitutionalBriefSource = {
    id, revision: 'r1', date: fixturePin.basis.cutoff, label: 'org/Public', project, text,
    spans: [{ start: 0, end: text.length }],
  };
  requireCatalogue(proof.sourceId === id && proof.hash === institutionalSourceHash(approved));
  return proof;
}

function fixtureCount(value: unknown): number {
  requireCatalogue(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  return value;
}

export function admittedInstitutionalServiceMonitoring(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalServiceMonitoringEvidence {
  try {
    const { receipt: rawReceipt, sample } = record(raw, ['receipt', 'sample']);
    const receipt = record(rawReceipt, ['project', 'directory', 'purpose', 'productId', 'recordId', 'period', 'cutoff', 'clockBasis',
      'partition', 'requester', 'approval', 'supervisor', 'feedCustodian']);
    const { basis, approval } = fixturePin;
    requireCatalogue(receipt.project === binding.project && receipt.directory === binding.directory &&
      receipt.purpose === fixturePin.purpose && receipt.requester === fixturePin.requester && receipt.approval === approval &&
      receipt.productId === fixturePin.productId && receipt.recordId === fixturePin.recordId &&
      receipt.period === basis.period && receipt.cutoff === basis.cutoff && receipt.clockBasis === basis.clockBasis &&
      receipt.partition === basis.partition);
    const supervisor = fixtureProof(receipt.supervisor, 'supervisor', binding.project, sources);
    const feedCustodian = fixtureProof(receipt.feedCustodian, 'feedCustodian', binding.project, sources);
    if (sample && typeof sample === 'object' && 'state' in sample && sample.state === 'missing') {
      const missing = record(sample, ['state', 'evidence']);
      fixtureProof(missing.evidence, 'availability', binding.project, sources);
      return { state: 'unknown', records: [] };
    }

    const snapshot = record(sample, ['state', 'closed', 'unresolved', 'intake', 'evidence']);
    requireCatalogue(snapshot.state === 'available');
    const closed = fixtureCount(snapshot.closed);
    const unresolved = fixtureCount(snapshot.unresolved);
    const intake = fixtureCount(snapshot.intake);
    requireCatalogue(intake > 0 && Number.isSafeInteger(closed + unresolved) && closed + unresolved === intake &&
      closed >= minimumFixtureCell && unresolved >= minimumFixtureCell &&
      closed === fixturePin.counts.closed && unresolved === fixturePin.counts.unresolved && intake === fixturePin.counts.intake);
    const evidence = fixtureProof(snapshot.evidence, 'aggregate', binding.project, sources);
    const reportingKey = canonicalDigest({ project: binding.project, ...basis });
    return {
      state: 'available', productId: fixturePin.productId, reportingKey, supervisor, feedCustodian,
      records: [{ id: fixturePin.recordId, basis, counts: fixturePin.counts, resolvedFraction: { numerator: closed, denominator: intake }, evidence }],
    };
  } catch {
    return { state: 'unavailable', records: [] };
  }
}

export function readInstitutionalServiceMonitoring(accepted: InstitutionalServiceMonitoringEvidence, id: string): ServiceMonitoringSnapshot | { state: 'unknown' } {
  requireCatalogue(id === fixturePin.recordId);
  if (accepted.state === 'unknown') return { state: 'unknown' };
  requireCatalogue(accepted.state === 'available');
  return accepted.records[0];
}

export function prepareInstitutionalServiceMonitoring(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalServiceMonitoringEvidence,
): PreparedInstitutionalDraft {
  requireCatalogue(accepted.state === 'available');
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.supervisor.sourceId, accepted.feedCustodian.sourceId, records[0].evidence.sourceId]);
  const identity = { ...binding, duty: 'J1-05' as const, echelon: 'L3' as const, kind: 'service-monitoring' as const,
    productId: accepted.productId, reportingKey: accepted.reportingKey, supervisor: accepted.supervisor, feedCustodian: accepted.feedCustodian,
    validation: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalServiceMonitoringDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
