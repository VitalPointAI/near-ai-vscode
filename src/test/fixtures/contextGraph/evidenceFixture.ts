// Fictional acceptance corpus for replay through the future governed graph.
import { dominates } from '../../../domain/gate/dominance';
import type { DominanceContext } from '../../../domain/gate/dominance';
import type { Clearance, Label } from '../../../domain/gate/labels';

type Span = readonly [start: number, end: number];

interface Citation {
  readonly sourceId: string;
  readonly version: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface SourceVersion {
  readonly sourceId: string;
  readonly version: string;
  readonly label: Label;
  readonly text: string;
  readonly mentions: readonly { readonly entityId: string; readonly span: Span }[];
  readonly relations: readonly { readonly from: string; readonly to: string; readonly span: Span }[];
}

interface FixtureReader {
  readonly clearance: Clearance;
  readonly sourceIds: readonly string[];
}

const context: DominanceContext = {
  scales: { fixture: { name: 'Fictional graph fixture', levels: ['Internal'] } },
  mappings: [],
  now: 0,
};

const alpha: Label = {
  scale: 'fixture', level: 'Internal', compartments: ['ALPHA'], releasability: [], handling: [],
};
const bravo: Label = { ...alpha, compartments: ['BRAVO'] };

const registryFirst: SourceVersion = {
  sourceId: 'registry', version: 'v1', label: alpha,
  text: 'Lumen Co funds Project Fern. Bay Office.',
  mentions: [
    { entityId: 'bay', span: [29, 39] },
    { entityId: 'fern', span: [15, 27] },
    { entityId: 'lumen', span: [0, 8] },
  ],
  relations: [{ from: 'lumen', to: 'fern', span: [0, 28] }],
};
const registrySecond: SourceVersion = {
  sourceId: 'registry', version: 'v2', label: alpha,
  text: 'Lumen Co supports Project Fern.',
  mentions: [
    { entityId: 'fern', span: [18, 30] },
    { entityId: 'lumen', span: [0, 8] },
  ],
  relations: [{ from: 'lumen', to: 'fern', span: [0, 31] }],
};
const review: SourceVersion = {
  sourceId: 'review', version: 'v1', label: bravo,
  text: 'Lumen Holdings coordinates with Bay Office. Project Moss.',
  mentions: [
    { entityId: 'bay', span: [32, 42] },
    { entityId: 'lumen', span: [0, 14] },
    { entityId: 'moss', span: [44, 56] },
  ],
  relations: [{ from: 'lumen', to: 'bay', span: [0, 43] }],
};
const withheld: SourceVersion = {
  sourceId: 'withheld', version: 'v1', label: alpha,
  text: 'Lumen Hidden directs Project Fern. Loft Unit.',
  mentions: [
    { entityId: 'fern', span: [21, 33] },
    { entityId: 'loft', span: [35, 44] },
    { entityId: 'lumen', span: [0, 12] },
  ],
  relations: [{ from: 'lumen', to: 'fern', span: [0, 34] }],
};

export const fixtureCorpus: readonly SourceVersion[] = [registryFirst, registrySecond, review, withheld];
export const fixtureVisibleCorpora = {
  alpha: [registryFirst, registrySecond],
  both: [registryFirst, registrySecond, review],
} as const;

export const fixtureReaders: Readonly<Record<'alpha' | 'both', FixtureReader>> = {
  alpha: {
    clearance: { scale: 'fixture', level: 'Internal', compartments: ['ALPHA'], releasability: [] },
    sourceIds: ['registry', 'review'],
  },
  both: {
    clearance: { scale: 'fixture', level: 'Internal', compartments: ['ALPHA', 'BRAVO'], releasability: [] },
    sourceIds: ['registry', 'review'],
  },
};

export const fixtureCitations: Readonly<Record<'first' | 'second' | 'bravo' | 'sourceDenied', Citation>> = {
  first: { sourceId: 'registry', version: 'v1', start: 0, end: 28, text: 'Lumen Co funds Project Fern.' },
  second: { sourceId: 'registry', version: 'v2', start: 0, end: 31, text: 'Lumen Co supports Project Fern.' },
  bravo: { sourceId: 'review', version: 'v1', start: 0, end: 43, text: 'Lumen Holdings coordinates with Bay Office.' },
  sourceDenied: { sourceId: 'withheld', version: 'v1', start: 0, end: 34, text: 'Lumen Hidden directs Project Fern.' },
};

interface EvidenceEdge {
  readonly from: string;
  readonly to: string;
  readonly evidence: readonly Citation[];
}

interface EvidenceGraph {
  readonly entities: readonly { readonly id: string; readonly names: readonly string[] }[];
  readonly edges: readonly EvidenceEdge[];
  readonly counts: { readonly entities: number; readonly edges: number };
}

// Explicit expectations can be reused without running the reference projection.
export const expectedFixtureGraphs: Readonly<Record<'alpha' | 'both', EvidenceGraph>> = {
  alpha: {
    entities: [
      { id: 'bay', names: ['Bay Office'] },
      { id: 'fern', names: ['Project Fern'] },
      { id: 'lumen', names: ['Lumen Co'] },
    ],
    edges: [{ from: 'lumen', to: 'fern', evidence: [fixtureCitations.first, fixtureCitations.second] }],
    counts: { entities: 3, edges: 1 },
  },
  both: {
    entities: [
      { id: 'bay', names: ['Bay Office'] },
      { id: 'fern', names: ['Project Fern'] },
      { id: 'lumen', names: ['Lumen Co', 'Lumen Holdings'] },
      { id: 'moss', names: ['Project Moss'] },
    ],
    edges: [
      { from: 'lumen', to: 'bay', evidence: [fixtureCitations.bravo] },
      { from: 'lumen', to: 'fern', evidence: [fixtureCitations.first, fixtureCitations.second] },
    ],
    counts: { entities: 4, edges: 2 },
  },
};

function visibleSources(corpus: readonly SourceVersion[], reader: FixtureReader): readonly SourceVersion[] {
  return corpus.filter(({ label, sourceId }) =>
    dominates(reader.clearance, label, context) && reader.sourceIds.includes(sourceId));
}

function readSpan(source: SourceVersion, start: number, end: number): string | undefined {
  // Half-open UTF-16 offsets in this fixture.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > source.text.length) {
    return undefined;
  }
  return source.text.slice(start, end);
}

export function openFixtureCitation(
  corpus: readonly SourceVersion[],
  reader: FixtureReader,
  citation: Citation,
): { status: 'found'; text: string } | { status: 'not-found' } {
  const source = visibleSources(corpus, reader).find(({ sourceId, version }) =>
    sourceId === citation.sourceId && version === citation.version);
  const text = source && readSpan(source, citation.start, citation.end);
  return text !== undefined && text === citation.text ? { status: 'found', text } : { status: 'not-found' };
}

export function projectFixtureGraph(corpus: readonly SourceVersion[], reader: FixtureReader): EvidenceGraph {
  const visible = visibleSources(corpus, reader);
  const namesById = new Map<string, Set<string>>();
  for (const source of visible) {
    for (const { entityId, span } of source.mentions) {
      const name = readSpan(source, ...span);
      if (name === undefined) continue;
      const names = namesById.get(entityId) ?? new Set<string>();
      names.add(name);
      namesById.set(entityId, names);
    }
  }
  const edgesByKey = new Map<string, { from: string; to: string; evidence: Citation[] }>();
  for (const source of visible) {
    for (const { from, to, span: [start, end] } of source.relations) {
      const text = readSpan(source, start, end);
      if (text === undefined || !namesById.has(from) || !namesById.has(to)) continue;
      const key = `${from}\0${to}`;
      const edge = edgesByKey.get(key) ?? { from, to, evidence: [] };
      edge.evidence.push({ sourceId: source.sourceId, version: source.version, start, end, text });
      edgesByKey.set(key, edge);
    }
  }
  const entities = [...namesById].sort(([left], [right]) => left.localeCompare(right))
    .map(([id, names]) => ({ id, names: [...names].sort() }));
  const edges = [...edgesByKey.values()].sort((left, right) =>
    left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return { entities, edges, counts: { entities: entities.length, edges: edges.length } };
}
