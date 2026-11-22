// GUIDE-03, GUIDE-06. Pure: no I/O, no clock, no vscode, no package.
export const SETUP_AUDIT_EVENT_IDS = Object.freeze(['setup.guide.applied', 'setup.guide.abandoned', 'setup.discovery.scan', 'setup.discovery.approved-proposal'] as const);
export const LOCAL_MODEL_AUDIT_EVENT_IDS = Object.freeze(['local-models.installed', 'local-models.updated', 'local-models.removed', 'local-models.assigned', 'local-models.rejected', 'local-models.benchmarked'] as const);
export const AUDIT_EVENT_IDS = Object.freeze([...SETUP_AUDIT_EVENT_IDS, ...LOCAL_MODEL_AUDIT_EVENT_IDS] as const);
export type AuditEventId = (typeof AUDIT_EVENT_IDS)[number];
export interface AuditEventSpec { readonly id: AuditEventId; readonly required: readonly string[]; readonly optional: readonly string[]; readonly text?: Readonly<Record<string, number>>; }
export interface AuditEventRegistry { register(spec: AuditEventSpec): { dispose(): void }; specFor(id: AuditEventId): AuditEventSpec | undefined; }
export function createAuditEventRegistry(): AuditEventRegistry {
  const specs = new Map<AuditEventId, AuditEventSpec>();
  return {
    register(spec) {
      const { id } = spec;
      if (!AUDIT_EVENT_IDS.includes(id)) throw new Error(`Unknown audit event: ${id}`);
      if (specs.has(id)) throw new Error(`Audit event already registered: ${id}`);
      specs.set(id, spec);
      let disposed = false;
      return { dispose() {
        if (disposed) return;
        disposed = true;
        specs.delete(id);
      } };
    },
    specFor: (id) => specs.get(id),
  };
}
const isSafeString = (value: string, max: number) => value.length <= max && !value.includes('://') && !/^(?:[~/]|[A-Za-z]:|\\)/.test(value) && !value.includes('\\');
export function validateAuditBody(spec: AuditEventSpec, body: unknown): boolean { if (body === null || typeof body !== 'object' || Array.isArray(body)) return false; const value = body as Record<string, unknown>; const allowed = new Set([...spec.required, ...spec.optional]); if (Object.keys(value).some((key) => !allowed.has(key)) || spec.required.some((key) => !(key in value))) return false; const visit = (item: unknown, key?: string): boolean => typeof item === 'string' ? isSafeString(item, spec.text?.[key ?? ''] ?? 128) : Array.isArray(item) ? item.every((entry) => visit(entry)) : item !== null && typeof item === 'object' ? Object.entries(item as Record<string, unknown>).every(([nested, entry]) => visit(entry, nested)) : typeof item === 'number' || typeof item === 'boolean' || item === null; return Object.entries(value).every(([key, item]) => visit(item, key)); }
export const GUIDE_AUDIT_EVENT_SPECS: readonly AuditEventSpec[] = Object.freeze([{ id: 'setup.guide.applied', required: ['answers', 'proposedLabel', 'use', 'residency', 'viability', 'policy', 'options', 'recommendation', 'choice', 'changes', 'hostKind'], optional: ['choiceReason', 'kindOfWorkText', 'proposals', 'authorizations', 'deviceKeyId', 'earlierLocality', 'nothingChanged'], text: { kindOfWorkText: 60, choiceReason: 200 } }, { id: 'setup.guide.abandoned', required: ['answers', 'screen', 'hostKind'], optional: [] }, { id: 'setup.discovery.scan', required: ['phase', 'ranges', 'ports', 'found', 'hostKind'], optional: [] }, { id: 'setup.discovery.approved-proposal', required: ['endpointId', 'serverKind', 'pin', 'proposalId', 'outcome'], optional: [] }]);
export const CHANGE_GROUPS = Object.freeze(['label', 'connection', 'model', 'project', 'proposal'] as const); export const CHANGE_EFFECTS = Object.freeze(['added', 'changed', 'removed', 'waiting'] as const); export const CHANGE_AREAS = Object.freeze(['label', 'connection', 'model', 'project', 'policy'] as const); export const WAITS_FOR = Object.freeze(['clearance', 'approval', 'shared-project'] as const);
export interface ChangeItem { readonly id: string; readonly group: (typeof CHANGE_GROUPS)[number]; readonly area: (typeof CHANGE_AREAS)[number]; readonly text: string; readonly effect: (typeof CHANGE_EFFECTS)[number]; readonly waitsFor?: (typeof WAITS_FOR)[number]; }
export const STOP_REASONS = Object.freeze(['protected-c', 'classified', 'contract-unapproved'] as const); export type StopReason = (typeof STOP_REASONS)[number]; export interface LabelProposal { readonly label: readonly string[]; readonly reason: string; } export const APPLY_OUTCOMES = Object.freeze(['done', 'waiting', 'failed'] as const); export interface ApplyStepReport { readonly id: string; readonly outcome: (typeof APPLY_OUTCOMES)[number]; readonly message?: string; } export interface ApplyReport { readonly state: 'applied' | 'partly-applied'; readonly steps: readonly ApplyStepReport[]; } export interface ViabilitySnapshotEntry { readonly optionId: string; readonly state: string; }
