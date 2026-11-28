export const inventoryDirectory = '.planning/.near-ai';
export const inventoryFileName = 'resource-inventory.snapshot.json';
export const inventoryMediaDirectory = 'resource-inventory-media';
export const inventoryImageSizeLimit = 5 * 1024 * 1024;
export const inventorySizeLimit = 512 * 1024;
export const inventoryStatuses = {
  available: 'Available',
  allocated: 'Allocated',
  unavailable: 'Unavailable'
} as const;
export type InventoryStatus = keyof typeof inventoryStatuses;

export interface InventoryRecord {
  id: string;
  name: string;
  category: string;
  quantity?: number;
  unit?: string;
  status?: InventoryStatus;
  asOf?: string;
  assetDid?: string;
  usagePolicyRef?: string;
  stockNumber?: string;
  description?: string;
  imageRef?: string;
  imageDigest?: string;
  sourceRef?: string;
  lifecycle?: string;
  reviewNote?: string;
  archived?: true;
}

export interface InventorySnapshot {
  sourceId: string;
  source: string;
  generatedAt: string;
  catalogueOnly?: true;
  resources: InventoryRecord[];
}

export const infrastructureCategories = {
  'standalone-compute': 'Standalone compute',
  'cluster-compute': 'Cluster compute',
  inference: 'Inference',
  storage: 'Storage',
  registry: 'Registry'
} as const;

export interface InfrastructureRecord {
  id: string;
  name: string;
  category: keyof typeof infrastructureCategories;
  owner?: string;
  capability?: string;
  capacity?: number;
  capacityUnit?: string;
  asOf?: string;
}

export interface InfrastructureReport {
  kind: 'infrastructure';
  sourceId: string;
  source: string;
  generatedAt: string;
  resources: InfrastructureRecord[];
}

/** Stable identifier passed to a native work-area association action. */
export interface InventoryResourceReference {
  readonly sourceId: string;
  readonly resourceId: string;
}

export interface InventoryLinkRequest {
  readonly rootUri: string;
  readonly onSelect: (reference: InventoryResourceReference) => Promise<void>;
}

const idPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

function label(value: unknown, limit = 120): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0
    && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value.replace(/(\d\d:\d\d:\d\d)Z$/, '$1.000Z');
}

function assetDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256
    && /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/.test(value)
    && !value.endsWith(':') && !/%(?![0-9a-f]{2})/i.test(value);
}

function catalogueStockNumber(value: unknown): value is string {
  return typeof value === 'string' && /^(?:\d{13}|\d{4}-\d{2}-\d{3}-\d{4})$/.test(value);
}

function resource(value: unknown): value is InventoryRecord {
  return record(value) && id(value.id) && label(value.name) && label(value.category, 80)
    && (value.quantity === undefined || (typeof value.quantity === 'number' && Number.isSafeInteger(value.quantity) && value.quantity >= 0))
    && (value.unit === undefined || (value.quantity !== undefined && label(value.unit, 32)))
    && (value.status === undefined || (typeof value.status === 'string' && Object.hasOwn(inventoryStatuses, value.status)))
    && (value.asOf === undefined || timestamp(value.asOf))
    && (value.assetDid === undefined || (assetDid(value.assetDid) && (value.quantity === undefined || Number(value.quantity) <= 1)))
    && (value.usagePolicyRef === undefined || label(value.usagePolicyRef, 192))
    && (value.stockNumber === undefined || catalogueStockNumber(value.stockNumber))
    && (value.description === undefined || label(value.description, 400))
    && (value.imageRef === undefined || label(value.imageRef, 192))
    && (value.imageDigest === undefined || (typeof value.imageDigest === 'string' && /^[0-9a-f]{64}$/.test(value.imageDigest)))
    && (value.sourceRef === undefined || label(value.sourceRef, 300))
    && (value.lifecycle === undefined || label(value.lifecycle, 80))
    && (value.reviewNote === undefined || label(value.reviewNote, 400))
    && (value.archived === undefined || value.archived === true);
}

/** Read only the approved fields in a bounded local export. Source and status are claims supplied by the file. */
export function parseInventorySnapshot(text: string): InventorySnapshot | undefined {
  if (text.length > inventorySizeLimit) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!record(value) || value.schemaVersion !== 1 || !id(value.sourceId) || !label(value.source) || !timestamp(value.generatedAt)
    || !Array.isArray(value.resources) || value.resources.length > 1200 || !value.resources.every(resource)) return undefined;
  const resources: InventoryRecord[] = value.resources;
  if (value.catalogueOnly !== undefined && (value.catalogueOnly !== true || resources.some(item =>
    !item.sourceRef || !item.lifecycle || item.quantity !== undefined || item.status !== undefined
    || item.assetDid !== undefined || item.usagePolicyRef !== undefined))) return undefined;
  if (value.catalogueOnly !== true && resources.some(item => item.archived)) return undefined;
  if (new Set(resources.map(item => item.id)).size !== resources.length) return undefined;
  const reportedDids = resources.flatMap(item => item.assetDid === undefined ? [] : [item.assetDid]);
  if (new Set(reportedDids).size !== reportedDids.length) return undefined;
  return {
    sourceId: value.sourceId,
    source: value.source,
    generatedAt: value.generatedAt,
    ...(value.catalogueOnly === true ? { catalogueOnly: true } : {}),
    resources: resources.map(({
      id, name, category, quantity, unit, status, asOf, assetDid, usagePolicyRef, stockNumber, description, imageRef, imageDigest, sourceRef, lifecycle, reviewNote, archived
    }) => ({ id, name, category, quantity, unit, status, asOf, assetDid, usagePolicyRef, stockNumber, description, imageRef, imageDigest,
      sourceRef, lifecycle, reviewNote, archived }))
  };
}

const infrastructureEnvelopeKeys = new Set(['schemaVersion', 'kind', 'sourceId', 'source', 'generatedAt', 'resources']);
const infrastructureRowKeys = new Set(['id', 'name', 'category', 'owner', 'capability', 'capacity', 'capacityUnit', 'asOf']);

function infrastructureRecord(value: unknown): value is InfrastructureRecord {
  return record(value) && Object.keys(value).every(key => infrastructureRowKeys.has(key))
    && id(value.id) && label(value.name)
    && typeof value.category === 'string' && Object.hasOwn(infrastructureCategories, value.category)
    && (value.owner === undefined || label(value.owner))
    && (value.capability === undefined || label(value.capability))
    && (value.asOf === undefined || timestamp(value.asOf))
    && (value.capacity === undefined
      ? value.capacityUnit === undefined
      : typeof value.capacity === 'number' && Number.isSafeInteger(value.capacity)
        && value.capacity >= 0 && label(value.capacityUnit, 32));
}

/** A local planning report carries only reported fields and supplies no stock reference or mission authority. */
export function parseInfrastructureReport(text: string): InfrastructureReport | undefined {
  if (text.length > inventorySizeLimit || new TextEncoder().encode(text).length > inventorySizeLimit) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!record(value) || !Object.keys(value).every(key => infrastructureEnvelopeKeys.has(key))
    || value.schemaVersion !== 2 || value.kind !== 'infrastructure'
    || !id(value.sourceId) || !label(value.source) || !timestamp(value.generatedAt)
    || !Array.isArray(value.resources) || value.resources.length > 1200 || !value.resources.every(infrastructureRecord)) return undefined;
  if (new Set(value.resources.map(item => item.id)).size !== value.resources.length) return undefined;
  return { kind: value.kind, sourceId: value.sourceId, source: value.source, generatedAt: value.generatedAt, resources: value.resources };
}

/** Coalesce ordinary reads. A final link check waits for them and then starts a new current read. */
export async function readInventoryOnce<T>(
  source: { readTask?: Promise<void> }, current: () => boolean, read: () => Promise<T>,
  present: (result: T) => void, fresh = false
): Promise<void> {
  while (source.readTask) {
    await source.readTask;
    if (!fresh || !current()) return;
  }
  if (!current()) return;
  const task = (async () => {
    const result = await read();
    if (current()) present(result);
  })();
  source.readTask = task;
  try {
    await task;
  } finally {
    if (source.readTask === task) source.readTask = undefined;
  }
}

/** This identifier names a record in a published namespace. It contains no workspace paths or credentials. */
export function inventoryReference(snapshot: InventorySnapshot, record: InventoryRecord): string {
  return `resource:${snapshot.sourceId}/${record.id}`;
}
