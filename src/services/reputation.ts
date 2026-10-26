import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentProfile, AgentRole } from '../domain/agents';
import type { ReputationDecayConfig, ReputationEvidence, ReputationEvidenceKind, ReputationScore } from '../domain/routing';

interface ReputationFileSystem { mkdir(directory: string, options: { recursive: true }): Promise<void>; readFile(file: string, encoding: 'utf8'): Promise<string>; rename(oldPath: string, newPath: string): Promise<void>; writeFile(file: string, data: string, encoding: 'utf8'): Promise<void>; }
const defaultFileSystem: ReputationFileSystem = { mkdir: async (d, o) => { await fs.mkdir(d, o); }, readFile: (f, e) => fs.readFile(f, e), rename: async (a, b) => { await fs.rename(a, b); }, writeFile: async (f, d, e) => { await fs.writeFile(f, d, e); } };
const KINDS: ReputationEvidenceKind[] = ['verifiedOutcome', 'rework', 'reliability', 'latency', 'costEfficiency', 'userFeedback'];
const ROLES: AgentRole[] = ['planner', 'implementer', 'reviewer', 'security', 'tester', 'researcher'];
const DEFAULT_CONFIG: ReputationDecayConfig = { halfLifeDays: 30, explorationRate: 0.2, minimumEligibility: 0.05 };
const weights: Record<ReputationEvidenceKind, number> = { verifiedOutcome: 0.35, rework: -0.2, reliability: 0.2, latency: 0.1, costEfficiency: 0.1, userFeedback: 0.15 };

export interface ReputationStoreOptions { clock?: () => string; config?: Partial<ReputationDecayConfig>; fileSystem?: ReputationFileSystem; maxEvidence?: number; }
interface Ledger { version: 1; evidence: ReputationEvidence[]; optedOut: string[]; }

export class ReputationStore {
  private readonly clock: () => string;
  private readonly config: ReputationDecayConfig;
  private readonly fileSystem: ReputationFileSystem;
  private readonly maxEvidence: number;
  private ledger: Ledger = { version: 1, evidence: [], optedOut: [] };
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  public constructor(private readonly workspaceRoot?: string, options: ReputationStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.config = { ...DEFAULT_CONFIG, ...options.config, halfLifeDays: clamp(options.config?.halfLifeDays ?? DEFAULT_CONFIG.halfLifeDays, 1, 3650), explorationRate: clamp(options.config?.explorationRate ?? DEFAULT_CONFIG.explorationRate, 0, 1), minimumEligibility: clamp(options.config?.minimumEligibility ?? DEFAULT_CONFIG.minimumEligibility, 0, 1) };
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.maxEvidence = Math.max(20, Math.min(1000, options.maxEvidence ?? 300));
  }
  public get filePath(): string | undefined { return this.workspaceRoot ? path.join(this.workspaceRoot, '.planning', '.near-ai', 'reputation.json') : undefined; }
  public async record(input: Omit<ReputationEvidence, 'version'>): Promise<ReputationEvidence> {
    await this.load();
    validateEvidence(input);
    const evidence: ReputationEvidence = { ...input, version: 1, value: clamp(input.value, -1, 1), role: input.role };
    if (this.ledger.evidence.some((row) => row.evidenceId === evidence.evidenceId)) return this.ledger.evidence.find((row) => row.evidenceId === evidence.evidenceId)!;
    this.ledger.evidence = [evidence, ...this.ledger.evidence].slice(0, this.maxEvidence);
    await this.persist();
    return clone(evidence);
  }
  public recordEvidence(input: Omit<ReputationEvidence, 'version'>): Promise<ReputationEvidence> { return this.record(input); }
  public async score(profileId: string, role: AgentRole, now = this.clock()): Promise<ReputationScore> {
    await this.load();
    const rows = this.ledger.evidence.filter((row) => row.profileId === profileId && row.role === role);
    const components = Object.fromEntries(KINDS.map((kind) => [kind, round(rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + decay(row.value, row.recordedAt, now, this.config.halfLifeDays), 0))])) as Record<ReputationEvidenceKind, number>;
    const score = clamp(round(0.5 + KINDS.reduce((sum, kind) => sum + components[kind] * weights[kind], 0)), 0, 1);
    return { profileId, role, score, components, evidenceCount: rows.length, decayedAt: now, optedOut: this.ledger.optedOut.includes(profileId) };
  }
  public getScore(profileId: string, role: AgentRole, now = this.clock()): Promise<ReputationScore> { return this.score(profileId, role, now); }
  public async scores(profiles: AgentProfile[], role: AgentRole, now = this.clock()): Promise<ReputationScore[]> { return Promise.all(profiles.map((profile) => this.score(profile.identity.profileId, role, now))); }
  public async reset(profileId: string): Promise<void> { await this.load(); this.ledger.evidence = this.ledger.evidence.filter((row) => row.profileId !== profileId); this.ledger.optedOut = this.ledger.optedOut.filter((id) => id !== profileId); await this.persist(); }
  public async setOptOut(profileId: string, optedOut: boolean): Promise<void> { await this.load(); this.ledger.optedOut = optedOut ? [...new Set([...this.ledger.optedOut, profileId])] : this.ledger.optedOut.filter((id) => id !== profileId); await this.persist(); }
  public async isOptedOut(profileId: string): Promise<boolean> { await this.load(); return this.ledger.optedOut.includes(profileId); }
  public async list(): Promise<ReputationEvidence[]> { await this.load(); return this.ledger.evidence.map(clone); }
  public getConfig(): ReputationDecayConfig { return { ...this.config }; }
  public evidenceId(seed: string): string { return `evidence-${createHash('sha256').update(seed).digest('hex').slice(0, 16)}`; }
  private async load(): Promise<void> { if (this.loaded || !this.filePath) { this.loaded = true; return; } this.loaded = true; try { const parsed = JSON.parse(await this.fileSystem.readFile(this.filePath, 'utf8')) as Partial<Ledger>; if (parsed.version === 1 && Array.isArray(parsed.evidence)) this.ledger = { version: 1, evidence: parsed.evidence.map(sanitizeEvidence).filter((row): row is ReputationEvidence => Boolean(row)).slice(0, this.maxEvidence), optedOut: Array.isArray(parsed.optedOut) ? parsed.optedOut.filter((id): id is string => safeId(id)).slice(0, 100) : [] }; } catch { this.ledger = { version: 1, evidence: [], optedOut: [] }; } }
  private async persist(): Promise<void> { if (!this.filePath) return; const file = this.filePath; const payload = `${JSON.stringify(this.ledger)}\n`; const temporary = `${file}.tmp-${process.pid}`; this.writeQueue = this.writeQueue.then(async () => { await this.fileSystem.mkdir(path.dirname(file), { recursive: true }); await this.fileSystem.writeFile(temporary, payload, 'utf8'); await this.fileSystem.rename(temporary, file); }); await this.writeQueue; }
}

function validateEvidence(input: Omit<ReputationEvidence, 'version'>): void { if (!safeId(input.evidenceId) || !safeId(input.profileId) || !ROLES.includes(input.role) || !KINDS.includes(input.kind) || !Number.isFinite(input.value) || !['runtime', 'user'].includes(input.source) || !/^\d{4}-\d{2}-\d{2}T/.test(input.recordedAt) || (input.capabilityRequirementId !== undefined && !safeId(input.capabilityRequirementId)) || (input.capabilitySnapshotId !== undefined && !safeId(input.capabilitySnapshotId))) throw new Error('Invalid reputation evidence.'); }
function sanitizeEvidence(value: unknown): ReputationEvidence | undefined { if (!value || typeof value !== 'object') return undefined; const row = value as ReputationEvidence; try { validateEvidence(row); return { version: 1, evidenceId: row.evidenceId.slice(0, 80), profileId: row.profileId.slice(0, 80), role: row.role, kind: row.kind, value: clamp(row.value, -1, 1), recordedAt: row.recordedAt.slice(0, 40), source: row.source, outcome: row.outcome, capabilityRequirementId: safeOptionalId(row.capabilityRequirementId), capabilitySnapshotId: safeOptionalId(row.capabilitySnapshotId) }; } catch { return undefined; } }
function decay(value: number, recordedAt: string, now: string, halfLifeDays: number): number { const age = Math.max(0, Date.parse(now) - Date.parse(recordedAt)); return value * Math.pow(0.5, age / (halfLifeDays * 86400000)); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function round(value: number): number { return Math.round(value * 10000) / 10000; }
function safeId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value); }
function safeOptionalId(value: unknown): string | undefined { return value === undefined ? undefined : safeId(value) ? value.slice(0, 120) : undefined; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
