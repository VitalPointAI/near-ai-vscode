export const portfolioSnapshotDirectory = '.planning/.near-ai';
export const portfolioSnapshotName = 'portfolio.snapshot.json';
export const portfolioSnapshotLimit = 512 * 1024;

export const portfolioLevels = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] as const;
export type PortfolioLevel = typeof portfolioLevels[number];
export const portfolioStatuses = ['green', 'amber', 'red'] as const;
export type PortfolioStatus = typeof portfolioStatuses[number];
export const portfolioStatusLabels: Record<PortfolioStatus, string> = {
  green: 'On track', amber: 'At risk', red: 'Off track'
};

export interface PortfolioNode {
  id: string;
  parentId?: string;
  level: PortfolioLevel;
  name: string;
  status?: PortfolioStatus;
  asOf?: string;
  reason?: string;
}

export interface PortfolioSnapshot {
  source: string;
  generatedAt: string;
  nodes: PortfolioNode[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isName(value: unknown, limit = 120): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value.replace(/(\d\d:\d\d:\d\d)Z$/, '$1.000Z');
}

function isNode(value: unknown): value is PortfolioNode {
  return isRecord(value)
    && isId(value.id)
    && (value.parentId === undefined || isId(value.parentId))
    && portfolioLevels.some(level => level === value.level)
    && isName(value.name)
    && (value.status === undefined || portfolioStatuses.some(status => status === value.status))
    && (value.asOf === undefined || isTimestamp(value.asOf))
    && (value.reason === undefined || isName(value.reason, 400));
}

/** Parse this preview's read-only export. The snapshot is not the signed publication feed. */
export function parsePortfolioSnapshot(text: string): PortfolioSnapshot | undefined {
  if (text.length > portfolioSnapshotLimit) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isName(value.source) || !isTimestamp(value.generatedAt)
    || !Array.isArray(value.nodes) || value.nodes.length > 1200 || !value.nodes.every(isNode)) return undefined;
  const nodes: PortfolioNode[] = value.nodes;
  const index = new Map(nodes.map(node => [node.id, node]));
  if (index.size !== nodes.length || nodes.filter(node => node.level === 'L0').length > 1) return undefined;
  for (const node of nodes) {
    const level = portfolioLevels.indexOf(node.level);
    if (level === 0) {
      if (node.parentId !== undefined) return undefined;
    } else {
      const parent = node.parentId === undefined ? undefined : index.get(node.parentId);
      if (parent?.level !== portfolioLevels[level - 1]) return undefined;
    }
  }
  return {
    source: value.source,
    generatedAt: value.generatedAt,
    nodes: nodes.map(({ id, parentId, level, name, status, asOf, reason }) => ({ id, parentId, level, name, status, asOf, reason }))
  };
}

/** Give parent followed by descendants. All nodes in a parsed snapshot have a parent at the preceding level. */
export function orderedPortfolioNodes(nodes: readonly PortfolioNode[]): PortfolioNode[] {
  const children = new Map<string | undefined, PortfolioNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const ordered: PortfolioNode[] = [];
  const visit = (parentId?: string): void => {
    const siblings = children.get(parentId) ?? [];
    for (const node of siblings.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))) {
      ordered.push(node);
      visit(node.id);
    }
  };
  visit();
  return ordered;
}
