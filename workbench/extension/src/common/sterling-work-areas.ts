export const workAreaKinds = ['capability-development', 'training', 'operations', 'resources'] as const;
export type WorkAreaKind = typeof workAreaKinds[number];

const componentLabels = {
  'program': 'Program',
  'major-capital': 'Major capital project',
  'minor-capital': 'Minor capital project',
  'initiative': 'Initiative',
  'product': 'Product'
} as const;

type ComponentKind = keyof typeof componentLabels;

export interface WorkAreaResourceRef {
  readonly sourceId: string;
  readonly resourceId: string;
}

const resourceId = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** One part of a capability (a program, a project, an initiative or a product), as Get Started lists it: its kind's label and its title. */
export interface WorkAreaComponent {
  readonly label: string;
  readonly title: string;
}

export interface WorkAreaRecord {
  readonly kind: WorkAreaKind;
  readonly title: string;
  readonly detail?: string;
  readonly components?: readonly WorkAreaComponent[];
  readonly resourceRefs?: readonly WorkAreaResourceRef[];
}

export function workAreaKind(value: unknown): WorkAreaKind | undefined {
  if (value === 'projects') return 'capability-development';
  return workAreaKinds.find(kind => kind === value);
}

function titleOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || value !== value.trim() ||
    value.length > 100 || /[\p{Cc}\u2028\u2029]/u.test(value)) return undefined;
  return value;
}

function componentKind(value: unknown): value is ComponentKind {
  return typeof value === 'string' && Object.hasOwn(componentLabels, value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resourceReference(value: unknown): value is WorkAreaResourceRef {
  return record(value) && typeof value.sourceId === 'string' && resourceId.test(value.sourceId) &&
    typeof value.resourceId === 'string' && resourceId.test(value.resourceId);
}

export function parseWorkArea(text: string): WorkAreaRecord | undefined {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  if (!record(data) || data.version !== 1) return undefined;
  const title = titleOf(data.title);
  const kind = workAreaKind(data.kind);
  if (!title || !kind) return undefined;
  const refs = data.resourceRefs;
  if (refs !== undefined && (!Array.isArray(refs) || refs.length > 50 || !refs.every(resourceReference))) return undefined;
  const metadata = { kind, title, ...(refs ? { resourceRefs: refs.map(({ sourceId, resourceId }) => ({ sourceId, resourceId })) } : {}) };
  if (data.kind === 'projects') {
    if (!componentKind(data.category) || data.category === 'program') return undefined;
    return { ...metadata, detail: componentLabels[data.category] };
  }
  if (kind === 'capability-development') {
    const components = data.components;
    if (!Array.isArray(components) || components.length > 50 || !components.every(item =>
      record(item) && componentKind(item.kind) && Boolean(titleOf(item.title)))) return undefined;
    return {
      ...metadata,
      detail: `${components.length} ${components.length === 1 ? 'component' : 'components'}`,
      components: components.map(item => ({ label: componentLabels[item.kind as ComponentKind], title: item.title as string }))
    };
  }
  return metadata;
}
