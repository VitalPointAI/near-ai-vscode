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

export const institutionalBudgetDirectory = '.planning/staff/institutional/j8/budget-evidence';
const budgetPurpose = 'fictional-office-budget-j8-02';
const budgetUnit = 'fictional-budget-points';
const budgetCategories = ['authorized-balance', 'commitment', 'actual', 'accrual'] as const;
type BudgetCategory = typeof budgetCategories[number];

interface BudgetAttestation {
  readonly category: BudgetCategory;
  readonly quantity: number | null;
  readonly period: string | null;
  readonly unit: typeof budgetUnit | 'other-fixture-points' | null;
  readonly confirmation: 'verified' | 'disputed' | 'unconfirmed';
  readonly evidence: InstitutionalCatalogueSource | null;
}

type BudgetComparison =
  | { readonly state: 'comparable'; readonly difference: number; readonly unit: typeof budgetUnit; readonly period: string }
  | { readonly state: 'unresolved'; readonly reason: 'category-incompatible' | 'unit-incompatible' | 'period-incompatible' |
      'comparable-basis-missing' | 'duplicate-evidence' | 'disputed-evidence' | 'confirmation-missing' };

interface BudgetReconciliationRow {
  readonly id: string;
  readonly category: BudgetCategory;
  readonly comparison: BudgetComparison;
  readonly status?: Omit<BudgetAttestation, 'unit'> & { readonly unit: typeof budgetUnit | null };
  readonly control?: Omit<BudgetAttestation, 'unit'> & { readonly unit: typeof budgetUnit | null };
  readonly statusEvidence?: InstitutionalCatalogueSource | null;
  readonly controlEvidence?: InstitutionalCatalogueSource | null;
}

interface InstitutionalBudgetReceipt {
  readonly requester: 'fictional-budget-reviewer';
  readonly purpose: typeof budgetPurpose;
  readonly productId: string;
  readonly policyRevision: string;
  readonly period: string;
  readonly asOf: string;
  readonly unit: typeof budgetUnit;
  readonly reportingOfficer: InstitutionalCatalogueSource;
  readonly comptroller: InstitutionalCatalogueSource;
}

export interface InstitutionalBudgetEvidence extends InstitutionalBudgetReceipt {
  readonly evidenceDigest: string;
  readonly records: readonly BudgetReconciliationRow[];
}

export interface InstitutionalBudgetReview extends Omit<InstitutionalBriefReview, 'duty' | 'kind'> {
  readonly duty: 'J8-02';
  readonly kind: 'budget-evidence';
  readonly policyRevision: string;
  readonly scopeDigest: string;
  readonly period: string;
  readonly asOf: string;
  readonly reportingOfficer: InstitutionalCatalogueSource;
  readonly comptroller: InstitutionalCatalogueSource;
  readonly validation: 'pending';
  readonly release: 'pending';
}

function budgetPeriod(input: unknown): string {
  requireCatalogue(typeof input === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(input));
  return input;
}

function budgetCategory(input: unknown): BudgetCategory {
  const category = budgetCategories.find((approved) => approved === input);
  requireCatalogue(category);
  return category;
}

function budgetAttestation(
  input: unknown, role: 'fictional-budget-status-attestor' | 'fictional-budget-control-attestor',
  asOf: string, sources: readonly InstitutionalBriefSource[],
): BudgetAttestation {
  const entry = record(input, ['category', 'quantity', 'period', 'unit', 'confirmation', 'evidence']);
  const { quantity, unit, confirmation } = entry;
  requireCatalogue((quantity === null || (typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity >= 0)) &&
    (unit === null || unit === budgetUnit || unit === 'other-fixture-points') &&
    (confirmation === 'verified' || confirmation === 'disputed' || confirmation === 'unconfirmed'));
  const evidence = entry.evidence === null ? null : metadataSource(sources, entry.evidence, role);
  requireCatalogue(!evidence || sources.some(({ id, date }) => id === evidence.sourceId && date <= asOf));
  return { category: budgetCategory(entry.category), quantity, unit, period: entry.period === null ? null : budgetPeriod(entry.period), confirmation, evidence };
}

function compareBudget(status: BudgetAttestation, control: BudgetAttestation, category: BudgetCategory, period: string): BudgetComparison {
  if (status.category !== category || control.category !== category) return { state: 'unresolved', reason: 'category-incompatible' };
  if ([status, control].some((entry) => entry.unit !== null && entry.unit !== budgetUnit)) return { state: 'unresolved', reason: 'unit-incompatible' };
  if ([status, control].some((entry) => entry.period !== null && entry.period !== period)) return { state: 'unresolved', reason: 'period-incompatible' };
  if (status.evidence && status.evidence.sourceId === control.evidence?.sourceId) return { state: 'unresolved', reason: 'duplicate-evidence' };
  if (status.confirmation === 'disputed' || control.confirmation === 'disputed') return { state: 'unresolved', reason: 'disputed-evidence' };
  if (!status.evidence || !control.evidence || status.confirmation !== 'verified' || control.confirmation !== 'verified') {
    return { state: 'unresolved', reason: 'confirmation-missing' };
  }
  if (status.quantity === null || control.quantity === null || status.unit === null || control.unit === null ||
      status.period === null || control.period === null) return { state: 'unresolved', reason: 'comparable-basis-missing' };
  return { state: 'comparable', difference: status.quantity - control.quantity, unit: budgetUnit, period };
}

function visibleBudgetAttestation(entry: BudgetAttestation): NonNullable<BudgetReconciliationRow['status']> {
  const unit = entry.unit === budgetUnit ? budgetUnit : null;
  return { ...entry, unit, quantity: unit && entry.period ? entry.quantity : null };
}

export function admittedInstitutionalBudget(
  raw: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[],
): InstitutionalBudgetEvidence {
  const { receipt, rows } = record(raw, ['receipt', 'rows']);
  const authorization = record(receipt, ['project', 'directory', 'requester', 'purpose', 'policyRevision', 'productId', 'period',
    'asOf', 'reportingOfficer', 'comptroller', 'recordIds']);
  const { requester, purpose, policyRevision, productId } = authorization;
  requireCatalogue(authorization.project === binding.project && authorization.directory === binding.directory &&
    requester === 'fictional-budget-reviewer' && purpose === budgetPurpose &&
    typeof policyRevision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(policyRevision) &&
    typeof productId === 'string' && STAFF_SLUG.test(productId));
  const period = budgetPeriod(authorization.period);
  const asOf = metadataDate(authorization.asOf);
  requireCatalogue(asOf.slice(0, 7) === period);
  const reportingOfficer = metadataSource(sources, authorization.reportingOfficer, 'fictional-finance-reporting-officer');
  const comptroller = metadataSource(sources, authorization.comptroller, 'fictional-comptroller');
  requireCatalogue(reportingOfficer.sourceId !== comptroller.sourceId);
  const humanSources = new Set([reportingOfficer.sourceId, comptroller.sourceId]);
  const recordIds = list(authorization.recordIds, catalogueId);
  const eligible = new Set(recordIds);
  requireCatalogue(eligible.size === recordIds.length);
  const records: BudgetReconciliationRow[] = [];
  const proofs = new Map<string, readonly (InstitutionalCatalogueSource | null)[]>();
  for (const candidate of list(rows, (entry) => entry)) {
    requireCatalogue(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
    const { id } = candidate as { id?: unknown };
    if (typeof id !== 'string' || !eligible.has(id)) continue;
    const row = record(candidate, ['id', 'category', 'status', 'control']);
    const category = budgetCategory(row.category);
    const status = budgetAttestation(row.status, 'fictional-budget-status-attestor', asOf, sources);
    const control = budgetAttestation(row.control, 'fictional-budget-control-attestor', asOf, sources);
    requireCatalogue([status, control].every(({ evidence }) => !evidence || !humanSources.has(evidence.sourceId)));
    proofs.set(id, [status.evidence, control.evidence]);
    const comparison = compareBudget(status, control, category, period);
    if (comparison.state === 'comparable' || comparison.reason === 'comparable-basis-missing') {
      records.push({ id, category, comparison, status: visibleBudgetAttestation(status), control: visibleBudgetAttestation(control) });
    } else if (comparison.reason === 'duplicate-evidence' || comparison.reason === 'disputed-evidence' ||
        comparison.reason === 'confirmation-missing') {
      records.push({ id, category, comparison, statusEvidence: status.evidence, controlEvidence: control.evidence });
    } else {
      records.push({ id, category, comparison });
    }
  }
  requireCatalogue(proofs.size === records.length && new Set(records.map(({ category }) => category)).size === records.length);
  return { requester, purpose, productId, policyRevision, period, asOf, unit: budgetUnit, reportingOfficer, comptroller,
    evidenceDigest: canonicalDigest([...proofs.entries()].sort(([a], [b]) => a.localeCompare(b))),
    records: records.sort((a, b) => a.id.localeCompare(b.id)) };
}

export function prepareInstitutionalBudget(
  input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[], accepted: InstitutionalBudgetEvidence,
): PreparedInstitutionalDraft {
  const records = requestedCatalogueRows(input, accepted);
  const evidenceIds = new Set([accepted.reportingOfficer.sourceId, accepted.comptroller.sourceId,
    ...records.flatMap(({ status, control, statusEvidence, controlEvidence }) =>
      [status?.evidence?.sourceId, control?.evidence?.sourceId, statusEvidence?.sourceId, controlEvidence?.sourceId])]);
  const identity = { ...binding, duty: 'J8-02' as const, echelon: 'L3' as const, kind: 'budget-evidence' as const,
    productId: accepted.productId, policyRevision: accepted.policyRevision, scopeDigest: canonicalDigest(accepted),
    period: accepted.period, asOf: accepted.asOf, reportingOfficer: accepted.reportingOfficer, comptroller: accepted.comptroller,
    validation: 'pending' as const, release: 'pending' as const, sources: sourceReferences(sources.filter(({ id }) => evidenceIds.has(id))) };
  const bytes = canonicalBytes({ schema: 1, ...identity, body: { records } });
  requireCatalogue(bytes.length <= institutionalBriefMaxBytes);
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalBudgetDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
