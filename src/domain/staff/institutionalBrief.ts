import { createHash } from 'node:crypto';
import { canonicalBytes } from '../team/canonical';
import { STAFF_SLUG } from './parse';

export const institutionalBriefDirectory = '.planning/staff/institutional/command/briefs';
export const institutionalBriefMaxBytes = 128 * 1024;

export interface InstitutionalBriefSource {
  readonly id: string;
  readonly revision: string;
  readonly date: string;
  readonly label: 'org/Public';
  readonly project: string;
  readonly text: string;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
  readonly dissentAttribution?: string;
}

export interface InstitutionalBriefBinding {
  readonly project: string;
  readonly directory: string;
  readonly team: string;
  readonly teamVersion: string;
  readonly skillVersion: string;
}

export interface InstitutionalDraftScope {
  readonly root: string;
  readonly binding: InstitutionalBriefBinding;
  readonly bindingIsCurrent: () => Promise<boolean>;
  readonly stagedIsCurrent: () => boolean;
  readonly currentSources: () => readonly InstitutionalBriefSource[];
  readonly withStableParents: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface InstitutionalCitation {
  readonly sourceId: string;
  readonly revision: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

export interface InstitutionalBriefReview {
  readonly project: string;
  readonly directory: string;
  readonly team: string;
  readonly teamVersion: string;
  readonly skillVersion: string;
  readonly duty: 'CG-07';
  readonly echelon: 'L3';
  readonly kind: 'brief';
  readonly productId: string;
  readonly version: string;
  readonly sources: readonly { readonly id: string; readonly revision: string; readonly date: string; readonly label: 'org/Public'; readonly hash: string }[];
}

export interface PreparedInstitutionalBrief {
  readonly path: string;
  readonly text: string;
  readonly review: InstitutionalBriefReview;
}

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !fields.every((field) => Object.hasOwn(value, field))) throw new Error('The decision brief fields do not match the institutional draft form.');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error('The decision brief contains missing or invalid text.');
  }
  return value;
}

function list<T>(value: unknown, parse: (entry: unknown) => T, min = 0): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > 12) throw new Error('The decision brief contains an invalid list.');
  return value.map(parse);
}

export function institutionalBriefDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Trait checks are limited to the admitted fictional public scope of this tracer. */
export function validateInstitutionalBriefSource(source: InstitutionalBriefSource, project: string): boolean {
  return source.project === project && source.label === 'org/Public' && STAFF_SLUG.test(source.id) &&
    typeof source.revision === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(source.revision) &&
    typeof source.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(source.date) && Number.isFinite(Date.parse(source.date)) &&
    new Date(source.date).toISOString().slice(0, 10) === source.date &&
    typeof source.text === 'string' && source.text.length > 0 && source.text.length <= 4000 &&
    (source.dissentAttribution === undefined || (typeof source.dissentAttribution === 'string' && source.dissentAttribution.trim().length > 0 && source.dissentAttribution.length <= 100)) &&
    Array.isArray(source.spans) && source.spans.length > 0 && source.spans.length <= 12 &&
    source.spans.every(({ start, end }) => Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end <= source.text.length && start < end);
}

export function institutionalSourceHash(source: InstitutionalBriefSource): string {
  return institutionalBriefDigest(canonicalBytes(source));
}

/** Prepare a single canonical payload and the exact gate path derived from it. */
export function prepareInstitutionalBrief(input: unknown, binding: InstitutionalBriefBinding, sources: readonly InstitutionalBriefSource[]): PreparedInstitutionalBrief {
  const value = record(input, ['productId', 'decisionRequested', 'facts', 'alternatives', 'assumptions', 'dissent', 'dependencies']);
  if (typeof value.productId !== 'string' || !STAFF_SLUG.test(value.productId)) throw new Error('The decision brief needs a stable product identifier.');
  const cited = new Map<string, InstitutionalBriefSource>();
  function citation(input: unknown): InstitutionalCitation {
    const { sourceId, revision, start, end, quote } = record(input, ['sourceId', 'revision', 'start', 'end', 'quote']);
    const source = sources.find((entry) => entry.id === sourceId);
    if (!source || source.revision !== revision || !source.spans.some((span) => span.start === start && span.end === end) ||
        source.text.slice(start as number, end as number) !== quote) throw new Error('A citation does not match an admitted source revision and span.');
    cited.set(source.id, source);
    return { sourceId: source.id, revision: source.revision, start: start as number, end: end as number, quote: quote as string };
  }
  const fact = (entry: unknown) => {
    const item = record(entry, ['text', 'evidence']);
    return { text: text(item.text), evidence: list(item.evidence, citation, 1) };
  };
  const dissent = list(value.dissent, (entry) => {
    const item = record(entry, ['attribution', 'text', 'evidence']);
    return { attribution: text(item.attribution, 100), text: text(item.text), evidence: list(item.evidence, citation, 1) };
  });
  for (const source of sources) {
    if (source.dissentAttribution !== undefined && !dissent.some((entry) => entry.attribution === source.dissentAttribution &&
        entry.evidence.some((evidence) => evidence.sourceId === source.id))) throw new Error('The brief must preserve attributed disagreement from the admitted evidence.');
  }
  const body = {
    decisionRequested: text(value.decisionRequested), facts: list(value.facts, fact, 1),
    alternatives: list(value.alternatives, (entry) => text(entry), 2),
    assumptions: list(value.assumptions, (entry) => text(entry)), dissent,
    dependencies: list(value.dependencies, (entry) => text(entry)),
  };
  const evidence = [...cited.values()].sort((a, b) => a.id.localeCompare(b.id)).map((source) => ({
    id: source.id, revision: source.revision, date: source.date, label: source.label, hash: institutionalSourceHash(source),
  }));
  const identity = { ...binding, duty: 'CG-07' as const, echelon: 'L3' as const, kind: 'brief' as const, productId: value.productId, sources: evidence };
  const bytes = canonicalBytes({ schema: 1, ...identity, body });
  if (bytes.length > institutionalBriefMaxBytes) throw new Error('The canonical decision brief exceeds the 128 KiB draft limit.');
  const version = institutionalBriefDigest(bytes);
  return { path: `${institutionalBriefDirectory}/${version}.json`, text: bytes.toString('utf8'), review: { ...identity, version } };
}
