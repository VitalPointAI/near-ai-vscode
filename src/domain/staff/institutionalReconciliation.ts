import { canonicalBytes } from '../team/canonical';
import type { InstitutionalBriefBinding, InstitutionalBriefReview, InstitutionalBriefSource, PreparedInstitutionalDraft } from './institutionalBrief';
import {
  canonicalDigest, catalogueId, institutionalBriefDigest, institutionalBriefMaxBytes, list, metadataDate, metadataSource,
  record, requestedCatalogueRows, requireCatalogue, sourceReferences, type InstitutionalCatalogueSource,
} from './institutionalEvidence';
import { STAFF_SLUG } from './parse';

export const institutionalInventoryDirectory = '.planning/staff/institutional/j4/inventory-counts';
const inventoryPurpose = 'fictional-office-inventory-j4-02';
const officeItems = ['Office chairs', 'Paper packs', 'Office folders', 'Desk trays', 'Spare binders'] as const;
type OfficeItem = typeof officeItems[number];
type InventoryUnit = 'items' | 'boxes';

interface InventoryAttestation {
  readonly itemId: string;
  readonly quantity: number | null;
  readonly unit: InventoryUnit | null;
  readonly date: string | null;
  readonly cutoff: string | null;
  readonly evidence: InstitutionalCatalogueSource;
}

type QuantityComparison =
  | { readonly state: 'comparable'; readonly difference: number; readonly unit: InventoryUnit; readonly cutoff: string }
  | { readonly state: 'unresolved'; readonly reason: 'evidence-missing' | 'quantity-missing' | 'unit-missing' | 'unit-mismatch' |
      'cutoff-missing' | 'cutoff-mismatch' | 'date-missing' };

interface InventoryCountRow {
  readonly id: string;
  readonly label: OfficeItem;
  readonly custodyRole: 'fictional-office-custody-clerk' | null;
  readonly condition: 'serviceable' | 'wear-observed' | 'unknown';
  readonly count: InventoryAttestation | null;
  readonly register: InventoryAttestation | null;
  readonly quantityComparison: QuantityComparison;
  readonly unresolved: readonly ('custody-unknown' | 'condition-unknown')[];
}

interface InstitutionalInventoryReceipt {
  readonly requester: 'fictional-inventory-reviewer';
  readonly purpose: typeof inventoryPurpose;
  readonly productId: string;
  readonly policyRevision: string;
  readonly cutoffs: readonly string[];
  readonly propertyCustodian: InstitutionalCatalogueSource;
}

export interface InstitutionalInventoryEvidence extends InstitutionalInventoryReceipt {
  readonly records: readonly InventoryCountRow[];
}

export interface InstitutionalInventoryReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J4-02';
  readonly kind: 'inventory-counts';
  readonly scopeDigest: string;
  readonly policyRevision: string;
  readonly propertyCustodian: InstitutionalCatalogueSource;
  readonly custodianDecision: 'pending';
}

function inventoryAttestation(
  input: unknown, itemId: string, role: 'fictional-physical-count-attestor' | 'fictional-register-attestor',
  cutoffs: ReadonlySet<string>, sources: readonly InstitutionalBriefSource[],
): InventoryAttestation | null {
  if (input === null) return null;
  const entry = record(input, ['itemId', 'quantity', 'unit', 'date', 'cutoff', 'evidence']);
  const { quantity, unit } = entry;
  requireCatalogue(entry.itemId === itemId &&
    (quantity === null || (typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity >= 0)) &&
    (unit === null || unit === 'items' || unit === 'boxes'));
  const date = entry.date === null ? null : metadataDate(entry.date);
  const cutoff = entry.cutoff === null ? null : metadataDate(entry.cutoff);
  requireCatalogue(cutoff === null || (cutoffs.has(cutoff) && (date === null || date <= cutoff)));
  const evidence = metadataSource(sources, entry.evidence, role);
  requireCatalogue(date === null || sources.some((source) => source.id === evidence.sourceId && source.date === date));
  return { itemId, quantity, unit, date, cutoff, evidence };
}

function compareInventory(count: InventoryAttestation | null, register: InventoryAttestation | null): QuantityComparison {
  if (!count || !register) return { state: 'unresolved', reason: 'evidence-missing' };
  if (count.quantity === null || register.quantity === null) return { state: 'unresolved', reason: 'quantity-missing' };
  if (count.unit === null || register.unit === null) return { state: 'unresolved', reason: 'unit-missing' };
  if (count.unit !== register.unit) return { state: 'unresolved', reason: 'unit-mismatch' };
  if (count.cutoff === null || register.cutoff === null) return { state: 'unresolved', reason: 'cutoff-missing' };
  if (count.cutoff !== register.cutoff) return { state: 'unresolved', reason: 'cutoff-mismatch' };
  if (count.date === null || register.date === null) return { state: 'unresolved', reason: 'date-missing' };
  return { state: 'comparable', difference: count.quantity - register.quantity, unit: count.unit, cutoff: count.cutoff };
}

export function admittedInstitutionalInventory(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalInventoryEvidence {
  const { receipt, items } = record(raw, ['receipt', 'items']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'cutoffs', 'propertyCustodian', 'recordIds']);
  const { requester, purpose, policyRevision, productId } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-inventory-reviewer' && purpose === inventoryPurpose &&
    typeof policyRevision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(policyRevision) &&
    typeof productId === 'string' && STAFF_SLUG.test(productId));
  const propertyCustodian = metadataSource(sources, authorization.propertyCustodian, 'fictional-property-custodian');
  const approvedCutoffs = list(authorization.cutoffs, metadataDate, 1);
  const cutoffs = new Set(approvedCutoffs);
  const recordIds = list(authorization.recordIds, catalogueId);
  const eligible = new Set(recordIds);
  requireCatalogue(cutoffs.size === approvedCutoffs.length && eligible.size === recordIds.length);
  const records: InventoryCountRow[] = [];
  const countSources = new Set<string>();
  const registerSources = new Set<string>();
  for (const candidate of list(items, (entry) => entry)) {
    requireCatalogue(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    const { id } = candidate as { id?: unknown };
    if (typeof id !== 'string' || !eligible.has(id)) continue;
    const row = record(candidate, ['id', 'label', 'custodyRole', 'condition', 'count', 'register']);
    const { custodyRole, condition } = row;
    const label = officeItems.find((approved) => approved === row.label);
    requireCatalogue(label && (custodyRole === null || custodyRole === 'fictional-office-custody-clerk') &&
      (condition === 'unknown' || condition === 'serviceable' || condition === 'wear-observed'));
    const count = inventoryAttestation(row.count, id, 'fictional-physical-count-attestor', cutoffs, sources);
    const register = inventoryAttestation(row.register, id, 'fictional-register-attestor', cutoffs, sources);
    requireCatalogue(count || register);
    if (count) countSources.add(count.evidence.sourceId);
    if (register) registerSources.add(register.evidence.sourceId);
    const unresolved: Array<InventoryCountRow['unresolved'][number]> = [];
    if (custodyRole === null) unresolved.push('custody-unknown');
    if (condition === 'unknown') unresolved.push('condition-unknown');
    records.push({ id, label, custodyRole, condition, count, register, quantityComparison: compareInventory(count, register), unresolved });
  }
  requireCatalogue(new Set(records.map(({ id }) => id)).size === records.length &&
    !countSources.has(propertyCustodian.sourceId) && !registerSources.has(propertyCustodian.sourceId) &&
    [...countSources].every((id) => !registerSources.has(id)));
  return { requester, purpose, productId, policyRevision, propertyCustodian,
    cutoffs: approvedCutoffs.sort(), records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalInventory(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalInventoryEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.propertyCustodian.sourceId, ...records.flatMap(({ count, register }) =>
    [count?.evidence.sourceId, register?.evidence.sourceId])]);
  const identity = { ...binding, duty: 'J4-02' as const, echelon: 'L3' as const, kind: 'inventory-counts' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    propertyCustodian: accepted.propertyCustodian, custodianDecision: 'pending' as const,
    sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalInventoryDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
