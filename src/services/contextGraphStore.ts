import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ContextGraph, MemoryAuditMetadata, MemoryScope } from '../domain/contextGraph';
import { CONTEXT_GRAPH_VERSION, cloneContext, scopeKey } from '../domain/contextGraph';

export interface ContextGraphFileSystem {
  mkdir(directory: string, options: { recursive: true }): Promise<void>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  rename(oldPath: string, newPath: string): Promise<void>;
  writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>;
  unlink?(file: string): Promise<void>;
}

const defaultFileSystem: ContextGraphFileSystem = {
  mkdir: async (directory, options) => { await fs.mkdir(directory, options); },
  readFile: (file, encoding) => fs.readFile(file, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  writeFile: (file, data, encoding) => fs.writeFile(file, data, encoding),
  unlink: (file) => fs.unlink(file)
};

export interface ContextGraphStoreOptions {
  fileSystem?: ContextGraphFileSystem;
  maxScopes?: number;
  maxNodesPerGraph?: number;
  maxEdgesPerGraph?: number;
  maxSerializedBytes?: number;
}

interface ContextGraphLedger {
  version: typeof CONTEXT_GRAPH_VERSION;
  graphs: Record<string, ContextGraph>;
}

export class ContextGraphStore {
  private readonly fileSystem: ContextGraphFileSystem;
  private readonly maxScopes: number;
  private readonly maxNodesPerGraph: number;
  private readonly maxEdgesPerGraph: number;
  private readonly maxSerializedBytes: number;
  private ledger: ContextGraphLedger = { version: CONTEXT_GRAPH_VERSION, graphs: {} };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly workspaceRoot: string, options: ContextGraphStoreOptions = {}) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.maxScopes = bounded(options.maxScopes, 1, 100, 32);
    this.maxNodesPerGraph = bounded(options.maxNodesPerGraph, 1, 1000, 200);
    this.maxEdgesPerGraph = bounded(options.maxEdgesPerGraph, 1, 2000, 400);
    this.maxSerializedBytes = bounded(options.maxSerializedBytes, 4096, 2_000_000, 500_000);
  }

  public get filePath(): string { return path.join(this.workspaceRoot, '.planning', '.near-ai', 'context-graphs.json'); }

  public async get(scope: MemoryScope): Promise<ContextGraph | undefined> {
    await this.load();
    const graph = this.ledger.graphs[scopeKey(scope)];
    return graph && sameScope(graph.scope, scope) ? cloneContext(graph) : undefined;
  }

  public async list(): Promise<ContextGraph[]> {
    await this.load();
    return Object.values(this.ledger.graphs).map(cloneContext);
  }

  public async save(graph: ContextGraph): Promise<ContextGraph> {
    await this.load();
    this.validateGraph(graph);
    const key = scopeKey(graph.scope);
    if (!this.ledger.graphs[key] && Object.keys(this.ledger.graphs).length >= this.maxScopes) throw new Error('Context graph scope limit reached.');
    this.ledger.graphs[key] = cloneContext(graph);
    await this.persist();
    return cloneContext(graph);
  }

  public async update(scope: MemoryScope, update: (graph: ContextGraph) => ContextGraph): Promise<ContextGraph> {
    const current = (await this.get(scope)) ?? emptyGraph(scope, new Date().toISOString());
    const next = update(cloneContext(current));
    if (!sameScope(next.scope, scope)) throw new Error('Context graph mutation cannot change scope.');
    return this.save(next);
  }

  public async reset(scope: MemoryScope, now: string): Promise<ContextGraph> {
    const graph = emptyGraph(scope, now);
    graph.graphVersion = ((await this.get(scope))?.graphVersion ?? 0) + 1;
    graph.resetAt = now;
    return this.save(graph);
  }

  public async delete(scope: MemoryScope): Promise<boolean> {
    await this.load();
    const key = scopeKey(scope);
    if (!this.ledger.graphs[key]) return false;
    delete this.ledger.graphs[key];
    await this.persist();
    return true;
  }

  public async export(scope: MemoryScope): Promise<string> {
    const graph = await this.get(scope);
    if (!graph) throw new Error('Unknown context graph scope.');
    return JSON.stringify({ version: CONTEXT_GRAPH_VERSION, graph });
  }

  public async appendAudit(scope: MemoryScope, record: MemoryAuditMetadata): Promise<void> {
    await this.load();
    const graph = this.ledger.graphs[scopeKey(scope)];
    if (!graph || !sameScope(graph.scope, scope)) return;
    graph.audit = [...(graph.audit ?? []), cloneContext(record)].slice(-200);
    await this.persist();
  }

  private validateGraph(graph: ContextGraph): void {
    if (graph.version !== CONTEXT_GRAPH_VERSION || !graph.scope || !['private-agent', 'team-collective', 'project', 'shared'].includes(graph.scope.kind) || typeof graph.scope.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(graph.scope.id) || !Number.isInteger(graph.graphVersion) || graph.graphVersion < 0) throw new Error('Invalid context graph envelope.');
    if (graph.nodes.length > this.maxNodesPerGraph || graph.edges.length > this.maxEdgesPerGraph) throw new Error('Context graph exceeds its bounded node or edge limit.');
    const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
    if (nodeIds.size !== graph.nodes.length || graph.edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))) throw new Error('Context graph contains duplicate or dangling records.');
    if (Buffer.byteLength(JSON.stringify(graph), 'utf8') > this.maxSerializedBytes) throw new Error('Context graph exceeds its serialized size limit.');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<ContextGraphLedger>;
      if (parsed.version !== CONTEXT_GRAPH_VERSION || !parsed.graphs || typeof parsed.graphs !== 'object') throw new Error('Unsupported context graph ledger.');
      const graphs: Record<string, ContextGraph> = {};
      for (const [key, value] of Object.entries(parsed.graphs).slice(0, this.maxScopes)) {
        try {
          if (!value || value.version !== CONTEXT_GRAPH_VERSION || scopeKey(value.scope) !== key) continue;
          this.validateGraph(value);
          graphs[key] = value;
        } catch { /* Invalid historical graph records are ignored, never widened. */ }
      }
      this.ledger = { version: CONTEXT_GRAPH_VERSION, graphs };
    } catch {
      this.ledger = { version: CONTEXT_GRAPH_VERSION, graphs: {} };
    }
  }

  private async persist(): Promise<void> {
    const payload = `${JSON.stringify(this.ledger)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > this.maxSerializedBytes * this.maxScopes) throw new Error('Context graph ledger exceeds its serialized size limit.');
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.writeQueue = this.writeQueue.then(async () => {
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.fileSystem.writeFile(temporary, payload, 'utf8');
      await this.fileSystem.rename(temporary, this.filePath);
    });
    await this.writeQueue;
  }
}

function emptyGraph(scope: MemoryScope, now: string): ContextGraph {
  return { version: CONTEXT_GRAPH_VERSION, scope: cloneContext(scope), graphVersion: 0, nodes: [], edges: [], updatedAt: now };
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return Boolean(left && right && typeof left.id === 'string' && typeof right.id === 'string' && left.id === right.id && left.kind === right.kind);
}

function bounded(value: number | undefined, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, Math.floor(value ?? fallback)));
}
