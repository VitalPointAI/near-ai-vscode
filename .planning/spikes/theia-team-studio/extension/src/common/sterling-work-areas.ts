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

export interface WorkAreaRecord {
  readonly kind: WorkAreaKind;
  readonly title: string;
  readonly detail?: string;
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

export function parseWorkArea(text: string): WorkAreaRecord | undefined {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  if (!record(data) || data.version !== 1) return undefined;
  const title = titleOf(data.title);
  const kind = workAreaKind(data.kind);
  if (!title || !kind) return undefined;
  if (data.kind === 'projects') {
    if (!componentKind(data.category) || data.category === 'program') return undefined;
    return { kind, title, detail: componentLabels[data.category] };
  }
  if (kind === 'capability-development') {
    const components = data.components;
    if (!Array.isArray(components) || components.length > 50 || !components.every(item =>
      record(item) && componentKind(item.kind) && Boolean(titleOf(item.title)))) return undefined;
    return { kind, title, detail: `${components.length} ${components.length === 1 ? 'component' : 'components'}` };
  }
  return { kind, title };
}
