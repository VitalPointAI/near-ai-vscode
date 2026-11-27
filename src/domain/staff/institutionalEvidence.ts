import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import type { InstitutionalBriefReview, InstitutionalBriefSource } from './institutionalBrief';

export const institutionalBriefMaxBytes = 128 * 1024;

export const institutionalCatalogueUnavailable = 'This catalogue metadata is unavailable.';

export interface InstitutionalCatalogueSource {
  readonly role: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly hash: string;
}

export function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(value, field))) throw new Error('The decision brief fields do not match the institutional draft form.');
  return value as Record<string, unknown>;
}

export function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('The decision brief contains missing or invalid text.');
  }
  return value;
}

export function list<T>(value: unknown, parse: (entry: unknown) => T, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > 12) throw new Error('The decision brief contains an invalid list.');
  return value.map(parse);
}

export function requireCatalogue(condition: unknown): asserts condition {
  if (!condition) throw new Error(institutionalCatalogueUnavailable);
}

export function isInstitutionalCatalogueRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^item-[a-f0-9]{8}$/.test(value);
}

export function catalogueId(value: unknown): string {
  requireCatalogue(isInstitutionalCatalogueRecordId(value));
  return value;
}

export function metadataSource(sources: readonly InstitutionalBriefSource[], entry: unknown, role: string): InstitutionalCatalogueSource {
  const evidence = record(entry, ['sourceId', 'revision', 'role']);
  const source = sources.find(({ id, revision }) => id === evidence.sourceId && revision === evidence.revision);
  requireCatalogue(source && evidence.role === role);
  return { role, sourceId: source.id, revision: source.revision, hash: institutionalSourceHash(source) };
}

export function metadataDate(value: unknown): string {
  const date = text(value, 10);
  requireCatalogue(/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date);
  return date;
}

export function requestedCatalogueRows<Row extends { id: string }>(
  input: unknown, accepted: { readonly productId: string; readonly records: readonly Row[] },
): Row[] {
  const request = record(input, ['productId', 'recordIds']);
  requireCatalogue(request.productId === accepted.productId);
  const ids = list(request.recordIds, catalogueId, 1);
  requireCatalogue(new Set(ids).size === ids.length);
  return ids.sort().map((id) => {
    const row = accepted.records.find((entry) => entry.id === id);
    requireCatalogue(row);
    return row;
  });
}

export function canonicalDigest(value: unknown): string {
  return institutionalBriefDigest(canonicalBytes(value));
}

export function institutionalBriefDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function institutionalSourceHash(source: InstitutionalBriefSource): string {
  return institutionalBriefDigest(canonicalBytes(source));
}

export function sourceReferences(sources: readonly InstitutionalBriefSource[]): InstitutionalBriefReview['sources'] {
  return [...sources].sort((a, b) => a.id.localeCompare(b.id)).map((source) => ({
    id: source.id, revision: source.revision, date: source.date, label: source.label, hash: institutionalSourceHash(source),
  }));
}
