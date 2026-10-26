import { createHash, randomUUID } from 'node:crypto';
import type {
  ConflictState, ContextEdgeType, ContextGraph, ContextGraphEdge, ContextGraphEdgeDto, ContextGraphNode, ContextGraphNodeDto, ContextGraphPreviewDto, ContextGraphNode as GraphNode,
  ContextNodeType, FreshnessPolicy, MemoryApprovalDescriptor, MemoryAuditMetadata, MemoryProvenance, MemoryRecordState, MemoryScope, MemorySlice, MemorySliceRequest, ProvenanceKind, TensionPolarity
} from '../domain/contextGraph';
import { CONTEXT_GRAPH_VERSION, cloneContext, scopeKey } from '../domain/contextGraph';
import { ContextGraphStore } from './contextGraphStore';
import { HostMemoryApprovalAuthorization, isHostMemoryApproval } from './memoryApproval';

export type ContextGraphErrorCode = 'invalid-scope' | 'unsafe-content' | 'invalid-provenance' | 'invalid-capability' | 'invalid-edge' | 'stale-version' | 'conflict' | 'retracted' | 'local-only' | 'scope-denied' | 'approval-required' | 'approval-mismatch' | 'limit' | 'cancelled' | 'unknown-node';

export class ContextGraphError extends Error {
  public constructor(public readonly code: ContextGraphErrorCode, message: string) { super(message); this.name = 'ContextGraphError'; }
}

export interface ContextGraphMemoryOptions {
  store?: ContextGraphStore;
  clock?: () => string;
  maxNodesPerGraph?: number;
  maxEdgesPerGraph?: number;
  maxSliceNodes?: number;
  maxSliceEdges?: number;
  maxSliceBytes?: number;
  trustedActorIds?: string[];
  hostActorId?: string;
  emergencyStop?: () => boolean;
  onAudit?: (record: MemoryAuditMetadata) => void | Promise<void>;
}

export interface MemoryFactInput {
  scope: MemoryScope;
  label: string;
  summary: string;
  provenance: MemoryProvenance;
  authoringActorId: string;
  confidence?: number;
  freshness?: Partial<FreshnessPolicy>;
  expectedGraphVersion?: number;
  signal?: AbortSignal;
}

export interface MemoryNodeInput extends MemoryFactInput { type: ContextNodeType; }

export interface MemoryEdgeInput {
  scope: MemoryScope;
  type: ContextEdgeType;
  fromNodeId: string;
  toNodeId: string;
  polarity?: TensionPolarity;
  weight?: number;
  explanation: string;
  provenance: MemoryProvenance;
  authoringActorId: string;
  confidence?: number;
  freshness?: Partial<FreshnessPolicy>;
  expectedGraphVersion?: number;
  signal?: AbortSignal;
}

export interface MemoryCorrectionInput {
  scope: MemoryScope;
  nodeId: string;
  expectedGraphVersion: number;
  label?: string;
  summary: string;
  provenance: MemoryProvenance;
  authoringActorId: string;
  confidence?: number;
  signal?: AbortSignal;
}

export interface MemoryMergeInput {
  scope: MemoryScope;
  targetNodeId: string;
  sourceNodeIds: string[];
  expectedGraphVersion: number;
  summary?: string;
  provenance: MemoryProvenance;
  authoringActorId: string;
  signal?: AbortSignal;
}

const nodeTypes: ContextNodeType[] = ['fact', 'actor', 'function', 'capability', 'artifact', 'task'];
const edgeTypes: ContextEdgeType[] = ['supports', 'contradicts', 'depends-on', 'authored-by', 'derived-from', 'relates-to', 'fulfills', 'requires', 'has-capability', 'affects', 'assigned-to', 'cites', 'supersedes'];
const provenanceEvidence: Record<ProvenanceKind, MemoryProvenance['evidenceClass'][]> = {
  user: ['user-assertion', 'observation'], agent: ['observation', 'derived-metadata'], provider: ['provider-output'], derived: ['derived-metadata'], imported: ['imported-record'], system: ['system-record', 'observation']
};
const scopeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const recordId = /^[A-Za-z][A-Za-z0-9._:-]{1,159}$/;
const sha256 = /^[a-f0-9]{64}$/;
const unsafe = /(?:api[_ -]?key|access[_ -]?token|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private\s+prompt|raw\s+(?:context|media|prompt)|secret|password|seed\s+phrase|private\s+key|data:[^\s,;]+|file:\/\/|(?:^|[\s"'`])(?:\/|[A-Za-z]:\\)|\b(?:rm\s+-|curl\s+|wget\s+|powershell\s|bash\s+-|sh\s+-|execute\s+command|run\s+shell)\b)/i;

export class ContextGraphMemory {
  private readonly store: ContextGraphStore;
  private readonly clock: () => string;
  private readonly maxNodesPerGraph: number;
  private readonly maxEdgesPerGraph: number;
  private readonly maxSliceNodes: number;
  private readonly maxSliceEdges: number;
  private readonly maxSliceBytes: number;
  private readonly trustedActorIds: Set<string>;
  private readonly hostActorId: string;
  private readonly onAudit?: ContextGraphMemoryOptions['onAudit'];
  private readonly emergencyStop?: () => boolean;

  public constructor(workspaceRoot: string, options: ContextGraphMemoryOptions = {}) {
    this.store = options.store ?? new ContextGraphStore(workspaceRoot, { maxNodesPerGraph: options.maxNodesPerGraph, maxEdgesPerGraph: options.maxEdgesPerGraph });
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.maxNodesPerGraph = Math.min(1000, Math.max(1, Math.floor(options.maxNodesPerGraph ?? 200)));
    this.maxEdgesPerGraph = Math.min(2000, Math.max(1, Math.floor(options.maxEdgesPerGraph ?? 400)));
    this.maxSliceNodes = Math.min(100, Math.max(1, Math.floor(options.maxSliceNodes ?? 24)));
    this.maxSliceEdges = Math.min(200, Math.max(1, Math.floor(options.maxSliceEdges ?? 48)));
    this.maxSliceBytes = Math.min(100_000, Math.max(4096, Math.floor(options.maxSliceBytes ?? 24_000)));
    this.hostActorId = options.hostActorId ?? 'host-memory-service';
    this.trustedActorIds = new Set([this.hostActorId, 'user', ...(options.trustedActorIds ?? [])]);
    this.onAudit = options.onAudit;
    this.emergencyStop = options.emergencyStop;
  }

  public async addFact(input: MemoryFactInput): Promise<ContextGraphNode> { return this.addNode({ ...input, type: 'fact' }); }

  public async addNode(input: MemoryNodeInput): Promise<ContextGraphNode> {
    this.checkSignal(input.signal);
    this.validateScope(input.scope);
    this.validateNodeInput(input);
    const now = this.clock();
    const node: ContextGraphNode = {
      version: CONTEXT_GRAPH_VERSION,
      nodeId: `${input.type}-${hash(`${scopeKey(input.scope)}:${input.label}:${now}:${randomUUID()}`).slice(0, 20)}`,
      type: input.type,
      label: safeText(input.label, 120),
      summary: safeText(input.summary, 480),
      scope: cloneContext(input.scope),
      provenance: normalizeProvenance(input.provenance),
      confidence: boundedConfidence(input.confidence),
      freshness: normalizeFreshness(input.freshness, now),
      state: 'active',
      conflict: emptyConflict(),
      authoringActorId: this.validateActor(input.authoringActorId, input.provenance.kind),
      createdAt: now,
      updatedAt: now
    };
    const result = await this.mutate(input.scope, input.expectedGraphVersion, input.signal, (graph) => {
      if (graph.nodes.length >= this.maxNodesPerGraph) throw new ContextGraphError('limit', 'Context graph node limit reached.');
      const conflicting = graph.nodes.filter((existing) => existing.type === 'fact' && existing.state === 'active' && existing.label === node.label && existing.summary !== node.summary);
      if (conflicting.length) {
        node.conflict = { status: 'conflicted', conflictIds: conflicting.map((existing) => existing.nodeId), explanation: 'Multiple active evidence records use the same fact label.' };
        for (const existing of conflicting) existing.conflict = { status: 'conflicted', conflictIds: [...new Set([...existing.conflict.conflictIds, node.nodeId])], explanation: 'Multiple active evidence records use the same fact label.' };
      }
      graph.nodes.push(node);
      return graph;
    });
    await this.audit({ operation: 'write', scope: input.scope, graphVersion: result.graphVersion, nodeIds: [node.nodeId], edgeIds: [], outcome: 'allowed', provenanceKinds: [node.provenance.kind] });
    return cloneContext(result.nodes.find((candidate) => candidate.nodeId === node.nodeId) as ContextGraphNode);
  }

  public async addEdge(input: MemoryEdgeInput): Promise<ContextGraphEdge> {
    this.checkSignal(input.signal);
    this.validateScope(input.scope);
    this.validateProvenance(input.provenance);
    this.validateActor(input.authoringActorId, input.provenance.kind);
    if (!edgeTypes.includes(input.type) || !recordId.test(input.fromNodeId) || !recordId.test(input.toNodeId) || input.fromNodeId === input.toNodeId) throw new ContextGraphError('invalid-edge', 'Typed edge endpoints or type are invalid.');
    safeText(input.explanation, 240);
    const polarity = input.polarity ?? 'neutral';
    if (!['positive', 'negative', 'neutral'].includes(polarity)) throw new ContextGraphError('invalid-edge', 'Edge tension polarity is invalid.');
    const weight = input.weight ?? 0;
    if (!Number.isFinite(weight) || weight < -1 || weight > 1) throw new ContextGraphError('invalid-edge', 'Edge tension weight must be between -1 and 1.');
    if (polarity === 'positive' && weight < 0 || polarity === 'negative' && weight > 0) throw new ContextGraphError('invalid-edge', 'Edge tension polarity and weight disagree.');
    const now = this.clock();
    const edge: ContextGraphEdge = { version: CONTEXT_GRAPH_VERSION, edgeId: `edge-${hash(`${scopeKey(input.scope)}:${input.fromNodeId}:${input.toNodeId}:${now}:${randomUUID()}`).slice(0, 20)}`, type: input.type, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, scope: cloneContext(input.scope), polarity, weight: Math.max(-1, Math.min(1, weight)), explanation: safeText(input.explanation, 240), provenance: normalizeProvenance(input.provenance), confidence: boundedConfidence(input.confidence), freshness: normalizeFreshness(input.freshness, now), state: 'active', conflict: emptyConflict(), authoringActorId: input.authoringActorId, createdAt: now, updatedAt: now };
    const result = await this.mutate(input.scope, input.expectedGraphVersion, input.signal, (graph) => {
      if (graph.edges.length >= this.maxEdgesPerGraph) throw new ContextGraphError('limit', 'Context graph edge limit reached.');
      const from = graph.nodes.find((node) => node.nodeId === edge.fromNodeId);
      const to = graph.nodes.find((node) => node.nodeId === edge.toNodeId);
      if (!from || !to) throw new ContextGraphError('unknown-node', 'Typed edge references an unknown node.');
      if (!sameScope(from.scope, input.scope) || !sameScope(to.scope, input.scope)) throw new ContextGraphError('scope-denied', 'Edges cannot cross graph scopes.');
      if (from.state === 'retracted' || to.state === 'retracted') throw new ContextGraphError('retracted', 'Retracted evidence cannot receive new edges.');
      graph.edges.push(edge);
      if (edge.type === 'contradicts' || edge.polarity === 'negative') {
        from.conflict = { status: 'conflicted', conflictIds: [...new Set([...from.conflict.conflictIds, to.nodeId])], explanation: edge.explanation };
        to.conflict = { status: 'conflicted', conflictIds: [...new Set([...to.conflict.conflictIds, from.nodeId])], explanation: edge.explanation };
        edge.conflict = { status: 'conflicted', conflictIds: [from.nodeId, to.nodeId], explanation: edge.explanation };
      }
      return graph;
    });
    await this.audit({ operation: 'edge', scope: input.scope, graphVersion: result.graphVersion, nodeIds: [edge.fromNodeId, edge.toNodeId], edgeIds: [edge.edgeId], outcome: 'allowed', provenanceKinds: [edge.provenance.kind] });
    return cloneContext(result.edges.find((candidate) => candidate.edgeId === edge.edgeId) as ContextGraphEdge);
  }

  public async slice(request: MemorySliceRequest): Promise<MemorySlice> {
    this.checkSignal(request.signal);
    if (!safeText(request.task, 480) || unsafe.test(request.task)) throw new ContextGraphError('unsafe-content', 'Task context is unsafe or contains raw private content.');
    const scopes = this.authorizeScopes(request);
    const boundary = request.providerBoundary ?? 'local';
    const localOnly = request.localOnly === true;
    if ((localOnly || boundary !== 'local') && boundary !== 'local' && (!request.outboundApproved || !validFingerprint(request.approvalFingerprint))) {
      const code: ContextGraphErrorCode = localOnly ? 'local-only' : 'scope-denied';
      await this.audit({ operation: 'slice', scope: scopes[0], graphVersion: 0, nodeIds: [], edgeIds: [], outcome: 'denied', reason: code });
      throw new ContextGraphError(code, localOnly ? 'Local-only memory cannot cross a non-local provider boundary without exact approval.' : 'A graph slice crossing the provider boundary requires exact outbound approval.');
    }
    const maxNodes = Math.min(this.maxSliceNodes, Math.max(1, Math.floor(request.maxNodes ?? this.maxSliceNodes)));
    const maxEdges = Math.min(this.maxSliceEdges, Math.max(0, Math.floor(request.maxEdges ?? this.maxSliceEdges)));
    const maxBytes = Math.min(this.maxSliceBytes, Math.max(4096, Math.floor(request.maxBytes ?? this.maxSliceBytes)));
    const graphs = await Promise.all(scopes.map((scope) => this.store.get(scope)));
    const nodes = graphs.flatMap((graph) => graph?.nodes ?? []).filter((node) => node.state !== 'retracted' && node.state !== 'merged');
    const edges = graphs.flatMap((graph) => graph?.edges ?? []).filter((edge) => edge.state !== 'retracted' && edge.state !== 'merged');
    const now = Date.parse(this.clock());
    const taskTokens = tokenize(request.task);
    const ranked = nodes.map((node) => ({ node, score: relevance(node, taskTokens, now) })).sort((left, right) => right.score - left.score || left.node.nodeId.localeCompare(right.node.nodeId)).slice(0, maxNodes);
    const selectedNodes = ranked.map(({ node }) => node);
    const selectedIds = new Set(selectedNodes.map((node) => node.nodeId));
    const selectedEdges = edges.filter((edge) => selectedIds.has(edge.fromNodeId) && selectedIds.has(edge.toNodeId)).sort((left, right) => right.weight - left.weight || left.edgeId.localeCompare(right.edgeId)).slice(0, maxEdges);
    let slice: MemorySlice = { version: CONTEXT_GRAPH_VERSION, sliceId: `slice-${hash(`${request.taskId ?? request.task}:${scopes.map(scopeKey).join('|')}:${graphs.map((graph) => graph?.graphVersion ?? 0).join('|')}`).slice(0, 20)}`, taskId: safeId(request.taskId ?? `task-${hash(request.task).slice(0, 16)}`), scopes: cloneContext(scopes), graphVersions: Object.fromEntries(scopes.map((scope, index) => [scopeKey(scope), graphs[index]?.graphVersion ?? 0])), nodeIds: selectedNodes.map((node) => node.nodeId), edgeIds: selectedEdges.map((edge) => edge.edgeId), nodes: cloneContext(selectedNodes), edges: cloneContext(selectedEdges), factIds: selectedNodes.filter((node) => node.type === 'fact').map((node) => node.nodeId), privacy: { localOnly, providerBoundary: boundary, outboundApproved: request.outboundApproved === true }, suppliedAt: this.clock() };
    while (Buffer.byteLength(JSON.stringify(slice), 'utf8') > maxBytes && slice.nodes.length > 1) {
      slice.nodes.pop();
      const ids = new Set(slice.nodes.map((node) => node.nodeId));
      slice.edges = slice.edges.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId));
      slice.nodeIds = slice.nodes.map((node) => node.nodeId); slice.edgeIds = slice.edges.map((edge) => edge.edgeId); slice.factIds = slice.nodes.filter((node) => node.type === 'fact').map((node) => node.nodeId);
    }
    if (Buffer.byteLength(JSON.stringify(slice), 'utf8') > maxBytes) throw new ContextGraphError('limit', 'Task graph slice exceeds its serialized size limit.');
    await this.audit({ operation: 'slice', scope: scopes[0], graphVersion: Math.max(...graphs.map((graph) => graph?.graphVersion ?? 0), 0), nodeIds: slice.nodeIds, edgeIds: slice.edgeIds, outcome: 'allowed', provenanceKinds: [...new Set(slice.nodes.map((node) => node.provenance.kind))] });
    return slice;
  }

  public promptContext(slice: MemorySlice): string { return slice.nodes.filter((node) => node.type === 'fact').map((node) => `[${node.nodeId}] ${node.summary} (confidence ${node.confidence.toFixed(2)}; ${node.conflict.status}; ${node.state})`).join('\n').slice(0, 6000); }

  public async inspect(scope: MemoryScope, options: { localOnly?: boolean; signal?: AbortSignal } = {}): Promise<ContextGraphPreviewDto> {
    this.checkSignal(options.signal); this.validateScope(scope);
    const graph = await this.store.get(scope);
    if (!graph) throw new ContextGraphError('unknown-node', 'Unknown context graph scope.');
    const dto = preview(graph, options.localOnly === true);
    await this.audit({ operation: 'inspect', scope, graphVersion: graph.graphVersion, nodeIds: graph.nodes.map((node) => node.nodeId).slice(0, 100), edgeIds: graph.edges.map((edge) => edge.edgeId).slice(0, 100), outcome: 'allowed' });
    return dto;
  }

  public async search(scope: MemoryScope, query: string, options: { type?: ContextNodeType; localOnly?: boolean; signal?: AbortSignal } = {}): Promise<ContextGraphNodeDto[]> {
    this.checkSignal(options.signal); this.validateScope(scope); safeText(query, 160);
    if (unsafe.test(query)) throw new ContextGraphError('unsafe-content', 'Search query contains forbidden private or executable content.');
    const graph = await this.store.get(scope); if (!graph) return [];
    const tokens = tokenize(query); const result = graph.nodes.filter((node) => node.state !== 'retracted' && (!options.type || node.type === options.type) && relevance(node, tokens, Date.parse(this.clock())) > 0).sort((a, b) => a.nodeId.localeCompare(b.nodeId)).slice(0, 100).map((node) => nodeDto(node, Date.parse(this.clock())));
    await this.audit({ operation: 'search', scope, graphVersion: graph.graphVersion, nodeIds: result.map((node) => node.nodeId), edgeIds: [], outcome: 'allowed' });
    return result;
  }

  public async correct(input: MemoryCorrectionInput, approval: HostMemoryApprovalAuthorization): Promise<ContextGraphNode> {
    this.requireApproval(approval, { operation: 'correct', scope: input.scope, expectedGraphVersion: input.expectedGraphVersion, nodeIds: [input.nodeId], sourceNodeIds: [], summary: input.summary, localOnly: true, providerBoundary: 'local', ...approvalIdentity(approval) });
    this.checkSignal(input.signal); this.validateScope(input.scope); this.validateProvenance(input.provenance); this.validateActor(input.authoringActorId, input.provenance.kind); safeText(input.summary, 480); if (input.label !== undefined) safeText(input.label, 120);
    const result = await this.mutate(input.scope, input.expectedGraphVersion, input.signal, (graph) => {
      const prior = requireNode(graph, input.nodeId); if (prior.state === 'retracted') throw new ContextGraphError('retracted', 'Retracted evidence cannot be corrected.');
      prior.state = 'corrected'; prior.updatedAt = this.clock(); const replacement: ContextGraphNode = { ...prior, nodeId: `fact-${hash(`${input.nodeId}:${this.clock()}:${randomUUID()}`).slice(0, 20)}`, label: safeText(input.label ?? prior.label, 120), summary: safeText(input.summary, 480), provenance: normalizeProvenance(input.provenance), confidence: boundedConfidence(input.confidence ?? prior.confidence), freshness: normalizeFreshness(undefined, this.clock()), state: 'active', conflict: emptyConflict(), authoringActorId: input.authoringActorId, createdAt: this.clock(), updatedAt: this.clock(), correctedFromNodeId: prior.nodeId, retractedAt: undefined };
      if (graph.nodes.length >= this.maxNodesPerGraph) throw new ContextGraphError('limit', 'Context graph node limit reached.'); graph.nodes.push(replacement); return graph;
    });
    const replacement = result.nodes.find((node) => node.correctedFromNodeId === input.nodeId && node.state === 'active'); if (!replacement) throw new ContextGraphError('unknown-node', 'Correction was not retained.');
    await this.audit({ operation: 'correct', scope: input.scope, graphVersion: result.graphVersion, nodeIds: [input.nodeId, replacement.nodeId], edgeIds: [], outcome: 'allowed', provenanceKinds: [replacement.provenance.kind], approvalOutcome: 'consumed' }); return cloneContext(replacement);
  }

  public async merge(input: MemoryMergeInput, approval: HostMemoryApprovalAuthorization): Promise<ContextGraphNode> {
    this.requireApproval(approval, { operation: 'merge', scope: input.scope, expectedGraphVersion: input.expectedGraphVersion, nodeIds: [input.targetNodeId], sourceNodeIds: input.sourceNodeIds, ...(input.summary === undefined ? {} : { summary: input.summary }), localOnly: true, providerBoundary: 'local', ...approvalIdentity(approval) });
    this.checkSignal(input.signal); this.validateScope(input.scope); this.validateProvenance(input.provenance); this.validateActor(input.authoringActorId, input.provenance.kind);
    if (!input.sourceNodeIds.length || input.sourceNodeIds.length > 8 || new Set(input.sourceNodeIds).size !== input.sourceNodeIds.length) throw new ContextGraphError('invalid-edge', 'Merge source list is outside the supported bound.');
    const result = await this.mutate(input.scope, input.expectedGraphVersion, input.signal, (graph) => {
      const target = requireNode(graph, input.targetNodeId); const sourceNodes = input.sourceNodeIds.map((id) => requireNode(graph, id));
      if ([target, ...sourceNodes].some((node) => node.state === 'retracted')) throw new ContextGraphError('retracted', 'Retracted evidence cannot be merged.');
      const merged: ContextGraphNode = { ...target, nodeId: `fact-${hash(`${input.targetNodeId}:${input.sourceNodeIds.join('|')}:${this.clock()}:${randomUUID()}`).slice(0, 20)}`, summary: safeText(input.summary ?? target.summary, 480), provenance: normalizeProvenance(input.provenance), state: 'active', conflict: emptyConflict(), authoringActorId: input.authoringActorId, createdAt: this.clock(), updatedAt: this.clock(), mergedFromNodeIds: [target.nodeId, ...sourceNodes.map((node) => node.nodeId)], correctedFromNodeId: undefined, retractedAt: undefined };
      for (const node of [target, ...sourceNodes]) { node.state = 'merged'; node.updatedAt = this.clock(); }
      if (graph.nodes.length >= this.maxNodesPerGraph) throw new ContextGraphError('limit', 'Context graph node limit reached.'); graph.nodes.push(merged); return graph;
    });
    const merged = result.nodes.find((node) => node.mergedFromNodeIds?.includes(input.targetNodeId) && node.state === 'active'); if (!merged) throw new ContextGraphError('unknown-node', 'Merge was not retained.');
    await this.audit({ operation: 'merge', scope: input.scope, graphVersion: result.graphVersion, nodeIds: [input.targetNodeId, ...input.sourceNodeIds, merged.nodeId], edgeIds: [], outcome: 'allowed', provenanceKinds: [merged.provenance.kind], approvalOutcome: 'consumed' }); return cloneContext(merged);
  }

  public async retract(scope: MemoryScope, nodeId: string, expectedGraphVersion: number, approval: HostMemoryApprovalAuthorization, signal?: AbortSignal): Promise<ContextGraph> {
    this.requireApproval(approval, { operation: 'retract', scope, expectedGraphVersion, nodeIds: [nodeId], sourceNodeIds: [], localOnly: true, providerBoundary: 'local', ...approvalIdentity(approval) });
    this.checkSignal(signal); this.validateScope(scope); const result = await this.mutate(scope, expectedGraphVersion, signal, (graph) => { const node = requireNode(graph, nodeId); node.state = 'retracted'; node.retractedAt = this.clock(); node.updatedAt = node.retractedAt; for (const edge of graph.edges.filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId)) { edge.state = 'retracted'; edge.retractedAt = node.retractedAt; edge.updatedAt = node.retractedAt; } return graph; }); await this.audit({ operation: 'retract', scope, graphVersion: result.graphVersion, nodeIds: [nodeId], edgeIds: result.edges.filter((edge) => edge.state === 'retracted').map((edge) => edge.edgeId), outcome: 'allowed', approvalOutcome: 'consumed' }); return result;
  }

  public async reset(scope: MemoryScope, expectedGraphVersion: number, approval: HostMemoryApprovalAuthorization, signal?: AbortSignal): Promise<ContextGraph> {
    this.requireApproval(approval, { operation: 'reset', scope, expectedGraphVersion, nodeIds: [], sourceNodeIds: [], localOnly: true, providerBoundary: 'local', ...approvalIdentity(approval) });
    this.checkSignal(signal); this.validateScope(scope); const current = await this.store.get(scope); if (!current) throw new ContextGraphError('unknown-node', 'Unknown context graph scope.'); if (current.graphVersion !== expectedGraphVersion) throw new ContextGraphError('stale-version', 'Graph changed; refresh before resetting memory.'); const result = await this.store.reset(scope, this.clock()); await this.audit({ operation: 'reset', scope, graphVersion: result.graphVersion, nodeIds: [], edgeIds: [], outcome: 'allowed', approvalOutcome: 'consumed' }); return result;
  }

  public async export(scope: MemoryScope, options: { expectedGraphVersion: number; approval: HostMemoryApprovalAuthorization; signal?: AbortSignal }): Promise<string> {
    this.requireApproval(options.approval, { operation: 'export', scope, expectedGraphVersion: options.expectedGraphVersion, nodeIds: [], sourceNodeIds: [], localOnly: true, providerBoundary: 'local', ...approvalIdentity(options.approval) });
    this.checkSignal(options.signal); this.validateScope(scope); const graph = await this.store.get(scope); if (!graph) throw new ContextGraphError('unknown-node', 'Unknown context graph scope.'); if (options.expectedGraphVersion !== graph.graphVersion) throw new ContextGraphError('stale-version', 'Graph changed; refresh before exporting memory.'); const safe = cloneContext(graph); safe.nodes = safe.nodes.map((node) => ({ ...node, summary: safeText(node.summary, 480), label: safeText(node.label, 120) })); const payload = JSON.stringify({ version: CONTEXT_GRAPH_VERSION, exportedAt: this.clock(), scope: cloneContext(scope), graph: safe }); await this.audit({ operation: 'export', scope, graphVersion: graph.graphVersion, nodeIds: graph.nodes.map((node) => node.nodeId).slice(0, 100), edgeIds: graph.edges.map((edge) => edge.edgeId).slice(0, 100), outcome: 'allowed', approvalOutcome: 'consumed' }); return payload;
  }

  public async getAudit(): Promise<MemoryAuditMetadata[]> { const graphs = await this.store.list(); return graphs.flatMap((graph) => graph.audit ?? []).slice(-200).map(cloneContext); }

  private async mutate(scope: MemoryScope, expectedGraphVersion: number | undefined, signal: AbortSignal | undefined, operation: (graph: ContextGraph) => ContextGraph): Promise<ContextGraph> {
    this.checkSignal(signal); const graph = (await this.store.get(scope)) ?? { version: CONTEXT_GRAPH_VERSION, scope: cloneContext(scope), graphVersion: 0, nodes: [], edges: [], updatedAt: this.clock(), audit: [] };
    if (expectedGraphVersion !== undefined && expectedGraphVersion !== graph.graphVersion) throw new ContextGraphError('stale-version', 'Graph changed; refresh before editing memory.');
    const next = operation(cloneContext(graph)); this.checkSignal(signal); next.graphVersion = graph.graphVersion + 1; next.updatedAt = this.clock(); return this.store.save(next);
  }

  private async audit(record: Omit<MemoryAuditMetadata, 'timestamp'>): Promise<void> { const boundedRecord: MemoryAuditMetadata = { ...cloneContext(record), timestamp: this.clock(), nodeIds: record.nodeIds.slice(0, 100), edgeIds: record.edgeIds.slice(0, 100) }; await this.store.appendAudit(record.scope, boundedRecord); if (this.onAudit) await this.onAudit(boundedRecord); }
  private requireApproval(actual: HostMemoryApprovalAuthorization, expected: MemoryApprovalDescriptor): void {
    if (!isHostMemoryApproval(actual)) throw new ContextGraphError('approval-required', 'A host-created exact memory approval is required.');
    const descriptor = actual.descriptor;
    const same = JSON.stringify(descriptor) === JSON.stringify({ ...expected, nodeIds: [...expected.nodeIds].sort(), sourceNodeIds: [...expected.sourceNodeIds].sort(), ...(expected.summary === undefined ? {} : { summary: expected.summary.trim().replace(/[\r\n\t]+/g, ' ') }) });
    if (!same || descriptor.localOnly !== true || descriptor.providerBoundary !== 'local') throw new ContextGraphError('approval-mismatch', 'Memory approval does not match the exact local operation.');
  }
  private authorizeScopes(request: MemorySliceRequest): MemoryScope[] {
    if (!Array.isArray(request.scopes) || request.scopes.length < 1 || request.scopes.length > 4) throw new ContextGraphError('scope-denied', 'A task slice must name one to four explicit memory scopes.');
    const allowed: MemoryScope[] = []; if (request.agentId) allowed.push({ kind: 'private-agent', id: request.agentId }); if (request.teamId) allowed.push({ kind: 'team-collective', id: request.teamId }); if (request.projectId) allowed.push({ kind: 'project', id: request.projectId }); if (request.sharedId) allowed.push({ kind: 'shared', id: request.sharedId });
    for (const scope of request.scopes) { this.validateScope(scope); if (!allowed.some((candidate) => sameScope(candidate, scope))) throw new ContextGraphError('scope-denied', `Memory scope ${scopeKey(scope)} is not authorized for this task.`); }
    return request.scopes.map(cloneContext);
  }
  private validateScope(scope: MemoryScope): void { if (!scope || !['private-agent', 'team-collective', 'project', 'shared'].includes(scope.kind) || typeof scope.id !== 'string' || !scopeId.test(scope.id) || unsafe.test(scope.id)) throw new ContextGraphError('invalid-scope', 'Memory scope is invalid or sensitive.'); }
  private validateNodeInput(input: MemoryNodeInput): void { if (!nodeTypes.includes(input.type)) throw new ContextGraphError('invalid-capability', 'Context node type is not allowlisted.'); safeText(input.label, 120); safeText(input.summary, 480); this.validateProvenance(input.provenance); if (input.type === 'capability' && !['user', 'system'].includes(input.provenance.kind)) throw new ContextGraphError('invalid-capability', 'Agent or imported evidence cannot grant a capability.'); this.validateActor(input.authoringActorId, input.provenance.kind); }
  private validateProvenance(provenance: MemoryProvenance): void { if (!provenance || !['user', 'agent', 'provider', 'derived', 'imported', 'system'].includes(provenance.kind) || !recordId.test(provenance.sourceId) || !sha256.test(provenance.sourceHash) || typeof provenance.capturedAt !== 'string' || Number.isNaN(Date.parse(provenance.capturedAt)) || !provenanceEvidence[provenance.kind].includes(provenance.evidenceClass) || (provenance.actorId !== undefined && !recordId.test(provenance.actorId))) throw new ContextGraphError('invalid-provenance', 'Provenance is missing, forged, or outside the evidence allowlist.'); if (unsafe.test(provenance.sourceId)) throw new ContextGraphError('invalid-provenance', 'Provenance source contains sensitive material.'); }
  private validateActor(actorId: string, kind: ProvenanceKind): string { if (!recordId.test(actorId) || unsafe.test(actorId)) throw new ContextGraphError('invalid-provenance', 'Authoring actor is invalid.'); if (kind === 'agent' && !this.trustedActorIds.has(actorId)) throw new ContextGraphError('invalid-provenance', 'Agent provenance is not host-authorized.'); return actorId; }
  private checkSignal(signal?: AbortSignal): void { if (signal?.aborted || this.emergencyStop?.() === true) throw new ContextGraphError('cancelled', 'Memory operation was cancelled or stopped before commit.'); }
}

function requireNode(graph: ContextGraph, nodeId: string): ContextGraphNode { const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId); if (!node) throw new ContextGraphError('unknown-node', 'Unknown graph node.'); return node; }
function safeText(value: string, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max || unsafe.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new ContextGraphError('unsafe-content', 'Graph text is empty, oversized, sensitive, or executable.'); return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max); }
function safeId(value: string): string { if (!recordId.test(value) || unsafe.test(value)) throw new ContextGraphError('invalid-scope', 'Task identity is invalid.'); return value; }
function normalizeProvenance(value: MemoryProvenance): MemoryProvenance { return { kind: value.kind, sourceId: value.sourceId, sourceHash: value.sourceHash, capturedAt: value.capturedAt, evidenceClass: value.evidenceClass, actorId: value.actorId }; }
function normalizeFreshness(value: Partial<FreshnessPolicy> | undefined, now: string): FreshnessPolicy { const observedAt = value?.observedAt ?? now; const updatedAt = value?.updatedAt ?? now; const halfLifeDays = value?.halfLifeDays ?? 30; if (Number.isNaN(Date.parse(observedAt)) || Number.isNaN(Date.parse(updatedAt)) || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0 || halfLifeDays > 3650 || (value?.expiresAfterDays !== undefined && (!Number.isFinite(value.expiresAfterDays) || value.expiresAfterDays <= 0 || value.expiresAfterDays > 3650))) throw new ContextGraphError('unsafe-content', 'Freshness policy is invalid.'); return { observedAt, updatedAt, halfLifeDays, expiresAfterDays: value?.expiresAfterDays }; }
function boundedConfidence(value: number | undefined): number { if (value === undefined) return 0.5; if (!Number.isFinite(value) || value < 0 || value > 1) throw new ContextGraphError('unsafe-content', 'Confidence must be between 0 and 1.'); return value; }
function emptyConflict(): ConflictState { return { status: 'none', conflictIds: [] }; }
function sameScope(left: MemoryScope, right: MemoryScope): boolean { return left.kind === right.kind && left.id === right.id; }
function approvalIdentity(value: HostMemoryApprovalAuthorization): { sessionId: string; projectId: string } { return isHostMemoryApproval(value) ? { sessionId: value.descriptor.sessionId, projectId: value.descriptor.projectId } : { sessionId: 'invalid-approval', projectId: 'invalid-approval' }; }
function validFingerprint(value: string | undefined): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function tokenize(value: string): string[] { return value.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2).slice(0, 32); }
function relevance(node: ContextGraphNode, tokens: string[], now: number): number { const haystack = `${node.label} ${node.summary}`.toLocaleLowerCase(); const matches = tokens.filter((token) => haystack.includes(token)).length; const ageDays = Math.max(0, (now - Date.parse(node.freshness.updatedAt)) / 86_400_000); const decay = Math.pow(0.5, ageDays / node.freshness.halfLifeDays); const expired = node.freshness.expiresAfterDays !== undefined && ageDays > node.freshness.expiresAfterDays; return expired ? 0 : (matches ? 1 + matches : 0.1) * node.confidence * decay * (node.conflict.status === 'conflicted' ? 0.8 : 1); }
function nodeDto(node: ContextGraphNode, now: number): ContextGraphNodeDto { const ageDays = Math.max(0, (now - Date.parse(node.freshness.updatedAt)) / 86_400_000); return { nodeId: node.nodeId, type: node.type, label: node.label, summary: node.summary, scope: cloneContext(node.scope), confidence: node.confidence, freshness: { observedAt: node.freshness.observedAt, updatedAt: node.freshness.updatedAt, decayed: ageDays >= node.freshness.halfLifeDays, expiresAt: node.freshness.expiresAfterDays === undefined ? undefined : new Date(Date.parse(node.freshness.updatedAt) + node.freshness.expiresAfterDays * 86_400_000).toISOString() }, provenance: { kind: node.provenance.kind, sourceId: node.provenance.sourceId, evidenceClass: node.provenance.evidenceClass, actorId: node.provenance.actorId }, state: node.state, conflict: cloneContext(node.conflict), version: node.version }; }
function edgeDto(edge: ContextGraphEdge): ContextGraphEdgeDto { return { edgeId: edge.edgeId, type: edge.type, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId, polarity: edge.polarity, weight: edge.weight, explanation: edge.explanation, scope: cloneContext(edge.scope), state: edge.state, conflict: cloneContext(edge.conflict), version: edge.version }; }
function preview(graph: ContextGraph, localOnly: boolean): ContextGraphPreviewDto { const now = Date.parse(graph.updatedAt); const nodes = graph.nodes.map((node) => nodeDto(node, now)); const edges = graph.edges.map(edgeDto); return { version: CONTEXT_GRAPH_VERSION, scope: cloneContext(graph.scope), graphVersion: graph.graphVersion, nodes, edges, counts: { nodes: nodes.length, edges: edges.length, facts: nodes.filter((node) => node.type === 'fact').length, conflicts: nodes.filter((node) => node.conflict.status === 'conflicted').length, retracted: nodes.filter((node) => node.state === 'retracted').length }, accessibleOutline: nodes.slice(0, 100).map((node) => `${node.type}: ${node.label} · ${node.state} · confidence ${node.confidence.toFixed(2)} · provenance ${node.provenance.kind}`), localOnly }; }
