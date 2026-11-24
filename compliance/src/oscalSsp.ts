import { createHash } from 'node:crypto';
import { pinText, type InventoryEntry } from './inventory.ts';
import { NS, OSCAL_VERSION, STATE_WORDS, type ComponentInput, type Responsibility, type State } from './model.ts';

export const TO_BE_COMPLETED = 'To be completed by your organization';

type Level = Readonly<{ id: string; title: string; profile: string; components: readonly string[] }>;
type DashboardComponent = Readonly<{ component: string; responsibility: Responsibility; state: string; statement?: string; inheritedFrom?: string }>;
type DashboardRow = Readonly<{ level: string; control: string; state: string; reasonText: string; components: readonly DashboardComponent[] }>;
export interface SspInput {
  readonly level: Level; readonly rows: readonly DashboardRow[]; readonly components: readonly ComponentInput[]; readonly generatedAt?: string;
  /** The component inventory (compliance/resources.json with its pins, inventory.ts); entries of components outside the level are left out. */
  readonly inventory?: readonly InventoryEntry[];
}

/** A stable UUID is easier to review than a new random identifier on each rebuild. */
export const stableOscalUuid = (seed: string): string => {
  const value = createHash('sha256').update(seed).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${(Number.parseInt(value[16], 16) & 0x3 | 0x8).toString(16)}${value.slice(17, 20)}-${value.slice(20, 32)}`;
};
const uuid = stableOscalUuid;
const implementation = (state: string) => ({ state: state === 'met' ? 'implemented' : state === 'partly-met' ? 'partial' : state === 'not-applicable' ? 'not-applicable' : 'planned' });

const SUPPLIER_PARTY = 'party:product-maintainers';
const ORGANIZATION_PARTY = 'party:your-organization';

/**
 * The SSP inventory items: one per register entry whose architecture component is in the level, each linked to that component. Product
 * maintainers select, pin and review every entry; your organization owns what it deploys (runtime scope). Props carry our namespace only.
 */
export function inventoryItems(levelId: string, entries: readonly InventoryEntry[], componentUuids: ReadonlyMap<string, string>): Record<string, unknown>[] {
  return entries.filter((entry) => componentUuids.has(entry.component)).map((entry) => {
    const prop = (name: string, value: string) => ({ name, ns: NS, value });
    const deployed = entry.scope === 'runtime';
    return {
      uuid: uuid(`${levelId}:inventory:${entry.id}`),
      description: `${entry.purpose} Why it is needed: ${entry.role}`,
      props: [
        prop('resource-id', entry.id), prop('resource-kind', entry.kind), prop('pinned-version', pinText(entry)), prop('licence', entry.licence),
        prop('architecture-area', entry.architectureArea), prop('scope', entry.scope), prop('deployed', deployed ? 'yes' : 'no'),
        prop('compliance-fit', entry.fit), prop('crypto', entry.crypto), prop('air-gap', entry.airGap), prop('reviewed-at', entry.reviewedAt),
        ...(entry.roleNeedsReview ? [prop('role-needs-owner-review', 'yes')] : [])
      ],
      'responsible-parties': [
        { 'role-id': 'maintainer', 'party-uuids': [uuid(SUPPLIER_PARTY)] },
        ...(deployed ? [{ 'role-id': 'asset-owner', 'party-uuids': [uuid(ORGANIZATION_PARTY)] }] : [])
      ],
      'implemented-components': [{ 'component-uuid': componentUuids.get(entry.component) }],
      remarks: `Controls: ${entry.controls.join(', ')}. ${entry.conditions.length ? `Conditions: ${entry.conditions.join(' ')}` : 'No conditions.'} ${deployed ? `${TO_BE_COMPLETED}: confirm the installed version matches this pin.` : 'Build or test only: not deployed.'}`
    };
  });
}

/** Build an assessor-facing SSP draft. Product statements and organization actions remain distinct. */
export function buildSsp(input: SspInput): Record<string, unknown> {
  const generatedAt = input.generatedAt ?? '2026-11-21T00:00:00.000Z';
  const componentUuids = new Map(input.level.components.map((id) => [id, uuid(`${input.level.id}:component:${id}`)]));
  const boundaryUuid = uuid(`${input.level.id}:authorization-boundary`);
  let needsBoundary = false;
  const rows = input.rows.filter((row) => row.level === input.level.id).sort((a, b) => a.control.localeCompare(b.control));
  const requirements = rows.map((row) => {
    const byComponents = row.components.filter((component) => componentUuids.has(component.component)).map((component) => {
      const exported = uuid(`${input.level.id}:${row.control}:${component.component}:provided`);
      return {
        'component-uuid': componentUuids.get(component.component), uuid: uuid(`${input.level.id}:${row.control}:${component.component}`),
        description: component.statement ?? 'No product statement is available yet.', 'implementation-status': implementation(component.state),
        export: { description: component.statement ?? 'No product statement is available yet.', provided: [{ uuid: exported, description: component.statement ?? 'No product statement is available yet.' }], responsibilities: [{ uuid: uuid(`${input.level.id}:${row.control}:${component.component}:responsibility`), 'provided-uuid': exported, description: component.responsibility === 'your-organization' ? TO_BE_COMPLETED : 'Your organization confirms the shared responsibility.' }] },
        ...(component.responsibility === 'inherited' ? { inherited: [{ uuid: uuid(`${input.level.id}:${row.control}:${component.component}:inherited`), 'provided-uuid': exported, description: component.inheritedFrom ?? 'Inherited service to be completed by your organization.' }] } : {}),
        remarks: `${TO_BE_COMPLETED}: confirm how this implementation is used in your authorization boundary.`
      };
    });
    if (byComponents.length === 0) {
      needsBoundary = true;
      return {
        uuid: uuid(`${input.level.id}:requirement:${row.control}`), 'control-id': row.control,
        'by-components': [{
          'component-uuid': boundaryUuid, uuid: uuid(`${input.level.id}:${row.control}:authorization-boundary`),
          description: TO_BE_COMPLETED, 'implementation-status': implementation(row.state === 'not-applicable' ? row.state : 'planned')
        }],
        remarks: `Evidence state: ${STATE_WORDS[row.state as State] ?? row.state}. ${row.reasonText}`
      };
    }
    const state = STATE_WORDS[row.state as State] ?? row.state;
    return { uuid: uuid(`${input.level.id}:requirement:${row.control}`), 'control-id': row.control, 'by-components': byComponents, remarks: `Evidence state: ${state}. ${row.reasonText}` };
  });
  const inventory = inventoryItems(input.level.id, input.inventory ?? [], componentUuids);
  const parties = inventory.length ? {
    roles: [{ id: 'maintainer', title: 'Product maintainers: select, pin and review the component' }, { id: 'asset-owner', title: 'Asset owner: installs and operates the component' }],
    parties: [{ uuid: uuid(SUPPLIER_PARTY), type: 'organization', name: 'Product maintainers' }, { uuid: uuid(ORGANIZATION_PARTY), type: 'organization', name: 'Your organization', remarks: TO_BE_COMPLETED }]
  } : {};
  return {
    'system-security-plan': {
      uuid: uuid(`ssp:${input.level.id}`),
      metadata: { title: `NEAR AI ${input.level.title} system security plan draft`, 'last-modified': generatedAt, version: '1.0.0', 'oscal-version': OSCAL_VERSION, ...parties, remarks: `Draft only. ${TO_BE_COMPLETED}.` },
      'import-profile': { href: input.level.profile },
      'system-characteristics': {
        'system-ids': [{ 'identifier-type': 'https://near.ai', id: `near-ai-${input.level.id}` }], 'system-name': 'NEAR AI for VS Code',
        description: `A draft for ${input.level.title}; ${TO_BE_COMPLETED}.`, 'system-information': { 'information-types': [{ uuid: uuid(`${input.level.id}:product-evidence`), title: 'Product evidence', description: 'Redacted evidence identifiers, counts, hashes, and timestamps.' }] },
        status: { state: 'operational' }, 'authorization-boundary': { description: TO_BE_COMPLETED }
      },
      'system-implementation': { components: [
        ...input.level.components.map((id) => ({ uuid: componentUuids.get(id), type: 'software', title: id, description: `Product component ${id}.`, status: { state: 'operational' }, props: [{ name: 'component-id', ns: NS, value: id }] })),
        ...(needsBoundary ? [{ uuid: boundaryUuid, type: 'this-system', title: 'Authorization boundary', description: TO_BE_COMPLETED, status: { state: 'under-development' } }] : [])
      ], ...(inventory.length ? { 'inventory-items': inventory } : {}) },
      'control-implementation': { description: 'Evidence-driven draft control implementation; your organization decides whether evidence is sufficient.', 'implemented-requirements': requirements }
    }
  };
}
