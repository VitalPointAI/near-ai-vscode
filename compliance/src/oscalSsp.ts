import { createHash } from 'node:crypto';
import { NS, OSCAL_VERSION, STATE_WORDS, type ComponentInput, type Responsibility, type State } from './model.ts';

export const TO_BE_COMPLETED = 'To be completed by your organization';

type Level = Readonly<{ id: string; title: string; profile: string; components: readonly string[] }>;
type DashboardComponent = Readonly<{ component: string; responsibility: Responsibility; state: string; statement?: string; inheritedFrom?: string }>;
type DashboardRow = Readonly<{ level: string; control: string; state: string; reasonText: string; components: readonly DashboardComponent[] }>;
export interface SspInput { readonly level: Level; readonly rows: readonly DashboardRow[]; readonly components: readonly ComponentInput[]; readonly generatedAt?: string }

/** A stable UUID is easier to review than a new random identifier on each rebuild. */
const uuid = (seed: string): string => {
  const value = createHash('sha256').update(seed).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${(Number.parseInt(value[16], 16) & 0x3 | 0x8).toString(16)}${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const implementation = (state: string) => ({ state: state === 'met' ? 'implemented' : state === 'partly-met' ? 'partial' : state === 'not-applicable' ? 'not-applicable' : 'planned' });

/** Build an assessor-facing SSP draft. Product statements and organization actions remain distinct. */
export function buildSsp(input: SspInput): Record<string, unknown> {
  const generatedAt = input.generatedAt ?? '2026-11-21T00:00:00.000Z';
  const componentUuids = new Map(input.level.components.map((id) => [id, uuid(`${input.level.id}:component:${id}`)]));
  const rows = input.rows.filter((row) => row.level === input.level.id).sort((a, b) => a.control.localeCompare(b.control));
  const requirements = rows.map((row) => {
    const byComponents = row.components.filter((component) => componentUuids.has(component.component)).map((component) => {
      const exported = uuid(`${input.level.id}:${row.control}:${component.component}:provided`);
      return {
        'component-uuid': componentUuids.get(component.component), uuid: uuid(`${input.level.id}:${row.control}:${component.component}`),
        description: component.statement ?? 'No product statement is available yet.', 'implementation-status': implementation(component.state),
        export: { description: component.statement ?? 'No product statement is available yet.', provided: [{ uuid: exported, description: component.statement ?? 'No product statement is available yet.' }], responsibilities: [{ uuid: uuid(`${input.level.id}:${row.control}:${component.component}:responsibility`), description: component.responsibility === 'your-organization' ? TO_BE_COMPLETED : 'Your organization confirms the shared responsibility.' }] },
        ...(component.responsibility === 'inherited' ? { inherited: [{ uuid: uuid(`${input.level.id}:${row.control}:${component.component}:inherited`), 'provided-uuid': exported, description: component.inheritedFrom ?? 'Inherited service to be completed by your organization.' }] } : {}),
        remarks: `${TO_BE_COMPLETED}: confirm how this implementation is used in your authorization boundary.`
      };
    });
    const state = STATE_WORDS[row.state as State] ?? row.state;
    return { uuid: uuid(`${input.level.id}:requirement:${row.control}`), 'control-id': row.control, ...(byComponents.length ? { 'by-components': byComponents } : {}), remarks: `Evidence state: ${state}. ${row.reasonText}` };
  });
  return {
    'system-security-plan': {
      uuid: uuid(`ssp:${input.level.id}`),
      metadata: { title: `NEAR AI ${input.level.title} system security plan draft`, 'last-modified': generatedAt, version: '1.0.0', 'oscal-version': OSCAL_VERSION, remarks: `Draft only. ${TO_BE_COMPLETED}.` },
      'import-profile': { href: input.level.profile },
      'system-characteristics': {
        'system-ids': [{ 'identifier-type': 'https://near.ai', id: `near-ai-${input.level.id}` }], 'system-name': 'NEAR AI for VS Code',
        description: `A draft for ${input.level.title}; ${TO_BE_COMPLETED}.`, 'system-information': { 'information-types': [{ title: 'Product evidence', description: 'Redacted evidence identifiers, counts, hashes, and timestamps.' }] },
        status: { state: 'operational' }, 'authorization-boundary': { description: TO_BE_COMPLETED }
      },
      'system-implementation': { components: input.level.components.map((id) => ({ uuid: componentUuids.get(id), type: 'software', title: id, description: `Product component ${id}.`, status: { state: 'operational' }, props: [{ name: 'component-id', ns: NS, value: id }] })) },
      'control-implementation': { description: 'Evidence-driven draft control implementation; your organization decides whether evidence is sufficient.', 'implemented-requirements': requirements }
    }
  };
}
