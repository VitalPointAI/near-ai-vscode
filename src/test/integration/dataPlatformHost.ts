import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DataMapItem, DataMapSnapshot } from './dataMapFixture';
import { joinLabels } from '../../domain/gate/dominance';
import { parseLabel } from '../../domain/gate/labels';
import type { Label, ScaleTable } from '../../domain/gate/labels';
import { canonicalize } from '../../domain/team/canonical';

/** A verified, exact item-label scope for the synthetic catalogue. The request never supplies this authority. */
export interface CatalogueScope {
  readonly tenant: string;
  readonly subject: string;
  readonly mission: string;
  readonly sourceId: string;
  readonly policyRevision: string;
  /** Unix seconds, interpreted by the transaction verifier as well as the host. */
  readonly expiresAt: number;
  readonly label: Label;
}

export interface DataMapHostDependencies {
  verifyRequest(request: IncomingMessage): Promise<CatalogueScope | undefined>;
  /** Open a transaction and install a verified read scope on that connection before querying. */
  readCatalogue(scope: CatalogueScope): Promise<readonly DataMapItem[]>;
}

const DATA_MAP_PATH = '/v1/data-map';
const EMPTY_SNAPSHOT: DataMapSnapshot = Object.freeze({ items: Object.freeze([]) });
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 255
    && !/[\u0000-\u001f\u007f/\\]/u.test(value);
}

function isCurrent(scope: CatalogueScope): boolean {
  return Number.isSafeInteger(scope.expiresAt) && scope.expiresAt > Date.now() / 1000;
}

function isKnownScope(scope: CatalogueScope): boolean {
  return isCurrent(scope) && [scope.tenant, scope.subject, scope.mission, scope.sourceId, scope.policyRevision].every(isIdentifier);
}

function copyLabel(label: Label): Label {
  return Object.freeze({
    scale: label.scale, level: label.level, compartments: Object.freeze([...label.compartments]),
    releasability: Object.freeze([...label.releasability]), handling: Object.freeze([...label.handling]),
  });
}

function snapshotScope(scope: CatalogueScope): CatalogueScope {
  const { tenant, subject, mission, sourceId, policyRevision, expiresAt, label } = scope;
  return Object.freeze({ tenant, subject, mission, sourceId, policyRevision, expiresAt, label: copyLabel(label) });
}

async function readSnapshot(
  request: IncomingMessage, query: string, dependencies: DataMapHostDependencies,
): Promise<DataMapSnapshot> {
  if (query.length > 1024) return EMPTY_SNAPSHOT;
  const params = new URLSearchParams(query);
  const selections = params.getAll('mission');
  if ([...params.keys()].some((key) => key !== 'mission') || selections.length > 1) return EMPTY_SNAPSHOT;
  const requested = selections[0];
  if (requested !== undefined && !isIdentifier(requested)) return EMPTY_SNAPSHOT;

  const verified = await dependencies.verifyRequest(request);
  if (!verified) return EMPTY_SNAPSHOT;
  const scope = snapshotScope(verified);
  if (!isKnownScope(scope) || (requested !== undefined && requested !== scope.mission)) return EMPTY_SNAPSHOT;

  const authorizedLabel = canonicalize(scope.label);
  const rows = await dependencies.readCatalogue(scope);
  if (!isCurrent(scope)) return EMPTY_SNAPSHOT;

  const items = rows.filter((row) => row.sourceId === scope.sourceId && isIdentifier(row.itemId)
      && isDisplayName(row.name) && canonicalize(row.label) === authorizedLabel)
    .map(({ itemId, sourceId, name, label }) => ({ itemId, sourceId, name, label: copyLabel(label) }));
  return { items };
}

function respond(response: ServerResponse, status: number, body: DataMapSnapshot | { error: string }): void {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

/** HTTP listener only. The synthetic harness owns the socket and injects the verifier and database port. */
export function createDataMapHandler(dependencies: DataMapHostDependencies) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const target = request.url ?? '';
    if (request.method !== 'GET' || !(target === DATA_MAP_PATH || target.startsWith(`${DATA_MAP_PATH}?`))) {
      respond(response, 404, { error: 'not-found' });
      return;
    }

    let snapshot: DataMapSnapshot;
    try {
      snapshot = await readSnapshot(request, target.slice(DATA_MAP_PATH.length + 1), dependencies);
    } catch {
      respond(response, 503, { error: 'unavailable' });
      return;
    }
    respond(response, 200, snapshot);
  };
}

export interface SyntheticIntakePolicy {
  readonly revision: string;
  readonly scales: ScaleTable;
  readonly ingestDefault: Label;
  readonly sourceMarks: Readonly<Record<string, Label>>;
}

export interface SyntheticFolderItem {
  readonly key: string;
  readonly sourceVersion: string;
  readonly name: string;
  /** A null mark explicitly means unmarked. Any supplied mark needs an exact policy match. */
  readonly sourceMark: string | null;
}

export interface LabelLifecycleFact extends DataMapItem {
  readonly operation: 'record';
  readonly tenant: string;
  readonly mission: string;
  readonly policyRevision: string;
  readonly sourceVersion: string;
}

export interface CatalogueRecord {
  readonly itemId: string;
  readonly sourceVersion: string;
  readonly name: string;
  readonly label: Label;
  readonly signedFact: { readonly payload: LabelLifecycleFact; readonly sig: string };
}

export interface SyntheticRecordDependencies {
  readonly policy: SyntheticIntakePolicy | undefined;
  /** The harness confines this adapter to one declared synthetic root, with no content capability. */
  observeMetadata(): Promise<SyntheticFolderItem>;
  /** The harness supplies its own signer, fixture domain and key. */
  signTransition(fact: LabelLifecycleFact): Promise<string>;
  /** Install the write scope and commit the record, checkpoint, receipt, signed fact and outbox together. */
  recordCatalogue(scope: CatalogueScope, record: CatalogueRecord): Promise<'recorded' | 'duplicate'>;
}

function resolveIntakeLabel(policy: SyntheticIntakePolicy, mark: string | null): Label | undefined {
  const base = parseLabel(policy.ingestDefault, policy.scales);
  if (!base.ok) return undefined;
  if (mark === null) return base.value;

  if (!isIdentifier(mark) || !Object.prototype.hasOwnProperty.call(policy.sourceMarks, mark)) return undefined;
  const mapped = parseLabel(policy.sourceMarks[mark], policy.scales);
  return mapped.ok ? joinLabels(base.value, mapped.value, policy.scales) : undefined;
}

/** Internal synthetic ingestion entry. There is no HTTP mutation route. */
export async function recordSyntheticObservation(
  verified: CatalogueScope, dependencies: SyntheticRecordDependencies,
): Promise<'recorded' | 'duplicate' | 'refused'> {
  const policy = dependencies.policy;
  const scope = snapshotScope(verified);
  if (!policy || policy.revision !== scope.policyRevision || !isKnownScope(scope)) return 'refused';

  const { key, sourceVersion, name, sourceMark } = await dependencies.observeMetadata();
  if (!isIdentifier(key) || !isIdentifier(sourceVersion) || !isDisplayName(name)) return 'refused';
  const label = resolveIntakeLabel(policy, sourceMark);
  if (!label || canonicalize(label) !== canonicalize(scope.label) || !isCurrent(scope)) return 'refused';

  const itemId = createHash('sha256').update(canonicalize(['phase88-item-v1', scope.tenant, scope.mission, scope.sourceId, key])).digest('hex');
  const payload: LabelLifecycleFact = Object.freeze({
    operation: 'record', tenant: scope.tenant, mission: scope.mission, policyRevision: scope.policyRevision,
    sourceId: scope.sourceId, itemId, sourceVersion, name, label,
  });
  const sig = await dependencies.signTransition(payload);
  if (typeof sig !== 'string' || sig.length === 0 || !isCurrent(scope)) return 'refused';
  return dependencies.recordCatalogue(scope, { itemId, sourceVersion, name, label, signedFact: { payload, sig } });
}
