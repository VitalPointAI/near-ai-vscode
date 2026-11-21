import { loadJson, validateOurs } from './validate.ts';
import { RESPONSIBILITIES, type Responsibility } from './model.ts';

export interface ResponsibilityTable { readonly families: Readonly<Record<string, { readonly responsibility: Responsibility; readonly reason: string }>>; readonly exceptions: readonly { readonly control: string; readonly component?: string; readonly responsibility: Responsibility; readonly reason: string }[]; }

/** Read a strict table which can only allocate responsibility, never a compliance state. */
export function loadResponsibilityTable(file: string): ResponsibilityTable {
  const table = loadJson(file) as ResponsibilityTable;
  const result = validateOurs(table, 'responsibility');
  if (!result.ok) throw new Error(`invalid responsibility table: ${result.errors.join('; ')}`);
  return table;
}

export function resolveResponsibility(control: string, component: string | undefined, table: ResponsibilityTable, implemented?: Responsibility): { value: Responsibility; source: 'implemented' | 'exception' | 'family' } {
  if (implemented) return { value: implemented, source: 'implemented' };
  const exception = table.exceptions.find((item) => item.control === control && (item.component === undefined || item.component === component));
  if (exception) return { value: exception.responsibility, source: 'exception' };
  const family = table.families[control.split('-')[0]];
  if (!family || !RESPONSIBILITIES.includes(family.responsibility)) throw new Error(`no responsibility for ${control}`);
  return { value: family.responsibility, source: 'family' };
}
