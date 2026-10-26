import { createHash, randomUUID } from 'node:crypto';
import type {
  MemoryApprovalAuditMetadata,
  MemoryApprovalDescriptor,
  MemoryApprovalOperation,
  MemoryApprovalPreviewDto,
  MemoryProviderBoundary
} from '../domain/contextGraph';
import { cloneContext, scopeKey } from '../domain/contextGraph';

const fingerprintPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z][A-Za-z0-9._:-]{1,159}$/;
const scopeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const memoryTextUnsafe = /(?:api[_ -]?key|access[_ -]?token|refresh[-_ ]?token|bearer\s|authorization\s*[:=]|private\s+prompt|raw\s+(?:context|media|prompt)|secret|password|seed\s+phrase|private\s+key|data:[^\s,;]+|file:\/\/|(?:^|[\s"'`])(?:\/|[A-Za-z]:\\)|\b(?:rm\s+-|curl\s+|wget\s+|powershell\s|bash\s+-|sh\s+-|execute\s+command|run\s+shell)\b)/i;

export const MEMORY_APPROVAL_AUTHORIZATION = Symbol('host-memory-approval-authorization');

export interface HostMemoryApprovalAuthorization {
  readonly [MEMORY_APPROVAL_AUTHORIZATION]: true;
  readonly fingerprint: string;
  readonly descriptor: MemoryApprovalDescriptor;
  readonly consumedAt: string;
}

export interface MemoryApprovalRegistryOptions {
  clock?: () => number;
  ttlMs?: number;
  maxPending?: number;
  onAudit?: (record: MemoryApprovalAuditMetadata) => void;
}

export class MemoryApprovalError extends Error {
  public constructor(public readonly code: 'invalid' | 'expired' | 'replayed' | 'mismatch' | 'limit', message: string) {
    super(message);
    this.name = 'MemoryApprovalError';
  }
}

type PendingApproval = {
  descriptor: MemoryApprovalDescriptor;
  preview: MemoryApprovalPreviewDto;
  expiresAtMs: number;
};

export class MemoryApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly consumed = new Map<string, number>();
  private readonly audits: MemoryApprovalAuditMetadata[] = [];
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly onAudit?: MemoryApprovalRegistryOptions['onAudit'];

  public constructor(options: MemoryApprovalRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttlMs = Math.min(15 * 60_000, Math.max(1, Math.floor(options.ttlMs ?? 5 * 60_000)));
    this.maxPending = Math.min(256, Math.max(1, Math.floor(options.maxPending ?? 64)));
    this.onAudit = options.onAudit;
  }

  public create(input: MemoryApprovalDescriptor): MemoryApprovalPreviewDto {
    this.purge();
    if (this.pending.size >= this.maxPending) throw new MemoryApprovalError('limit', 'Too many pending memory approvals; finish or wait for an existing preview to expire.');
    const descriptor = canonicalDescriptor(input);
    const expiresAtMs = this.clock() + this.ttlMs;
    const previewId = `memory-preview-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const nonce = randomUUID().replaceAll('-', '');
    const fingerprint = createHash('sha256').update(`${canonicalJson(descriptor)}|${previewId}|${nonce}`).digest('hex');
    const preview: MemoryApprovalPreviewDto = {
      version: 1,
      previewId,
      operation: descriptor.operation,
      scope: cloneContext(descriptor.scope),
      expectedGraphVersion: descriptor.expectedGraphVersion,
      nodeIds: [...descriptor.nodeIds],
      sourceNodeIds: [...descriptor.sourceNodeIds],
      ...(descriptor.summary === undefined ? {} : { summaryLength: descriptor.summary.length, summaryDigest: digest(descriptor.summary) }),
      localOnly: descriptor.localOnly,
      providerBoundary: descriptor.providerBoundary,
      sessionId: descriptor.sessionId,
      projectId: descriptor.projectId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      approvalFingerprint: fingerprint
    };
    this.pending.set(fingerprint, { descriptor, preview, expiresAtMs });
    this.record({ operation: descriptor.operation, scope: descriptor.scope, graphVersion: descriptor.expectedGraphVersion, nodeIds: descriptor.nodeIds, sourceNodeIds: descriptor.sourceNodeIds, outcome: 'created' });
    return cloneContext(preview);
  }

  public consume(fingerprint: string, expected?: MemoryApprovalDescriptor): HostMemoryApprovalAuthorization {
    this.purgeConsumed();
    if (!fingerprintPattern.test(fingerprint)) throw new MemoryApprovalError('invalid', 'Memory approval fingerprint is invalid.');
    const pending = this.pending.get(fingerprint);
    if (!pending) {
      const outcome = this.consumed.has(fingerprint) ? 'replayed' : 'invalid';
      this.recordUnknown(fingerprint, outcome);
      throw new MemoryApprovalError(outcome === 'replayed' ? 'replayed' : 'invalid', outcome === 'replayed' ? 'Memory approval was already consumed.' : 'Memory approval was not created by this host.');
    }
    if (pending.expiresAtMs <= this.clock()) {
      this.pending.delete(fingerprint);
      this.record({ operation: pending.descriptor.operation, scope: pending.descriptor.scope, graphVersion: pending.descriptor.expectedGraphVersion, nodeIds: pending.descriptor.nodeIds, sourceNodeIds: pending.descriptor.sourceNodeIds, outcome: 'expired' });
      throw new MemoryApprovalError('expired', 'Memory approval has expired.');
    }
    if (expected && canonicalJson(pending.descriptor) !== canonicalJson(canonicalDescriptor(expected))) {
      this.record({ operation: pending.descriptor.operation, scope: pending.descriptor.scope, graphVersion: pending.descriptor.expectedGraphVersion, nodeIds: pending.descriptor.nodeIds, sourceNodeIds: pending.descriptor.sourceNodeIds, outcome: 'mismatch', reason: 'Requested operation does not match the host-created preview.' });
      throw new MemoryApprovalError('mismatch', 'Memory approval does not match the host-created operation.');
    }
    this.pending.delete(fingerprint);
    this.consumed.set(fingerprint, pending.expiresAtMs);
    this.record({ operation: pending.descriptor.operation, scope: pending.descriptor.scope, graphVersion: pending.descriptor.expectedGraphVersion, nodeIds: pending.descriptor.nodeIds, sourceNodeIds: pending.descriptor.sourceNodeIds, outcome: 'consumed' });
    return { [MEMORY_APPROVAL_AUTHORIZATION]: true, fingerprint, descriptor: cloneContext(pending.descriptor), consumedAt: new Date(this.clock()).toISOString() };
  }

  public getAudit(): MemoryApprovalAuditMetadata[] { return cloneContext(this.audits); }

  public pendingCount(): number { this.purge(); return this.pending.size; }

  private purge(): void {
    const now = this.clock();
    for (const [fingerprint, pending] of this.pending) {
      if (pending.expiresAtMs <= now) {
        this.pending.delete(fingerprint);
        this.record({ operation: pending.descriptor.operation, scope: pending.descriptor.scope, graphVersion: pending.descriptor.expectedGraphVersion, nodeIds: pending.descriptor.nodeIds, sourceNodeIds: pending.descriptor.sourceNodeIds, outcome: 'expired' });
      }
    }
    this.purgeConsumed();
  }

  private purgeConsumed(): void {
    const now = this.clock();
    for (const [fingerprint, expiresAt] of this.consumed) if (expiresAt <= now) this.consumed.delete(fingerprint);
  }

  private record(input: Omit<MemoryApprovalAuditMetadata, 'timestamp'>): void {
    const record: MemoryApprovalAuditMetadata = { ...cloneContext(input), timestamp: new Date(this.clock()).toISOString(), nodeIds: input.nodeIds.slice(0, 100), sourceNodeIds: input.sourceNodeIds.slice(0, 8) };
    this.audits.push(record);
    while (this.audits.length > 200) this.audits.shift();
    this.onAudit?.(cloneContext(record));
  }

  private recordUnknown(fingerprint: string, outcome: 'invalid' | 'replayed'): void {
    const suffix = fingerprint.slice(0, 12);
    this.record({ operation: 'export', scope: { kind: 'project', id: `unknown-${suffix}` }, graphVersion: 0, nodeIds: [], sourceNodeIds: [], outcome: outcome === 'replayed' ? 'replayed' : 'denied', reason: outcome === 'replayed' ? 'One-shot approval replay.' : 'Unknown host approval fingerprint.' });
  }
}

export function isHostMemoryApproval(value: unknown): value is HostMemoryApprovalAuthorization {
  if (!value || typeof value !== 'object') return false;
  const approval = value as HostMemoryApprovalAuthorization;
  return approval[MEMORY_APPROVAL_AUTHORIZATION] === true && fingerprintPattern.test(approval.fingerprint) && Boolean(approval.descriptor) && typeof approval.consumedAt === 'string';
}

export function canonicalMemoryApprovalDescriptor(input: MemoryApprovalDescriptor): MemoryApprovalDescriptor { return canonicalDescriptor(input); }

function canonicalDescriptor(input: MemoryApprovalDescriptor): MemoryApprovalDescriptor {
  if (!input || !['correct', 'merge', 'retract', 'reset', 'export'].includes(input.operation)) throw new MemoryApprovalError('invalid', 'Memory approval operation is not allowlisted.');
  if (!input.scope || !['private-agent', 'team-collective', 'project', 'shared'].includes(input.scope.kind) || typeof input.scope.id !== 'string' || !scopeIdPattern.test(input.scope.id) || memoryTextUnsafe.test(input.scope.id)) throw new MemoryApprovalError('invalid', 'Memory approval scope is invalid.');
  if (!Number.isInteger(input.expectedGraphVersion) || input.expectedGraphVersion < 0 || input.expectedGraphVersion > 2_147_483_647) throw new MemoryApprovalError('invalid', 'Memory approval graph version is invalid.');
  const nodeIds = boundedIds(input.nodeIds, 'node');
  const sourceNodeIds = boundedIds(input.sourceNodeIds, 'source');
  if (input.operation === 'correct' && nodeIds.length !== 1) throw new MemoryApprovalError('invalid', 'Correction approvals require one target node.');
  if (input.operation === 'merge' && (nodeIds.length !== 1 || sourceNodeIds.length < 1 || sourceNodeIds.length > 8)) throw new MemoryApprovalError('invalid', 'Merge approvals require one target and one to eight source nodes.');
  if ((input.operation === 'retract' && nodeIds.length !== 1) || (['reset', 'export'].includes(input.operation) && (nodeIds.length !== 0 || sourceNodeIds.length !== 0))) throw new MemoryApprovalError('invalid', 'Memory approval IDs do not match the operation.');
  if (input.summary !== undefined && (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 480 || memoryTextUnsafe.test(input.summary) || /[\u0000-\u001f]/.test(input.summary))) throw new MemoryApprovalError('invalid', 'Memory approval summary is unsafe or oversized.');
  if (typeof input.localOnly !== 'boolean' || !['local', 'cloud', 'tee', 'unknown'].includes(input.providerBoundary)) throw new MemoryApprovalError('invalid', 'Memory approval privacy boundary is invalid.');
  if (typeof input.sessionId !== 'string' || !identifierPattern.test(input.sessionId) || memoryTextUnsafe.test(input.sessionId) || typeof input.projectId !== 'string' || !identifierPattern.test(input.projectId) || memoryTextUnsafe.test(input.projectId)) throw new MemoryApprovalError('invalid', 'Memory approval identity is invalid.');
  return { operation: input.operation, scope: { kind: input.scope.kind, id: input.scope.id }, expectedGraphVersion: input.expectedGraphVersion, nodeIds, sourceNodeIds, ...(input.summary === undefined ? {} : { summary: input.summary.trim().replace(/[\r\n\t]+/g, ' ') }), localOnly: input.localOnly, providerBoundary: input.providerBoundary, sessionId: input.sessionId, projectId: input.projectId };
}

function boundedIds(values: string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > (label === 'source' ? 8 : 2) || values.some((value) => typeof value !== 'string' || !identifierPattern.test(value) || memoryTextUnsafe.test(value))) throw new MemoryApprovalError('invalid', `Memory approval ${label} IDs are invalid.`);
  const unique = [...new Set(values)].sort();
  if (unique.length !== values.length) throw new MemoryApprovalError('invalid', `Memory approval ${label} IDs must be unique.`);
  return unique;
}

function canonicalJson(value: MemoryApprovalDescriptor): string {
  return JSON.stringify({ operation: value.operation, scope: value.scope, expectedGraphVersion: value.expectedGraphVersion, nodeIds: value.nodeIds, sourceNodeIds: value.sourceNodeIds, summary: value.summary ?? null, localOnly: value.localOnly, providerBoundary: value.providerBoundary, sessionId: value.sessionId, projectId: value.projectId });
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function isMemoryFingerprint(value: unknown): value is string { return typeof value === 'string' && fingerprintPattern.test(value); }

export function isMemoryDigest(value: unknown): value is string { return typeof value === 'string' && digestPattern.test(value); }

export function memoryScopeKey(scope: MemoryApprovalDescriptor['scope']): string { return scopeKey(scope); }

export type { MemoryApprovalOperation, MemoryProviderBoundary };
