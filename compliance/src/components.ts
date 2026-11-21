import { readdirSync } from 'node:fs';
import path from 'node:path';
import { NS, RESPONSIBILITIES, type ComponentInput, type Responsibility, type Statement } from './model.ts';
import { loadJson, validateOscal } from './validate.ts';

type Prop = { name?: unknown; ns?: unknown; value?: unknown };
const ours = (props: readonly Prop[] | undefined, name: string): Prop[] => (props ?? []).filter((prop) => prop.ns === NS && prop.name === name);
const text = (prop: Prop | undefined): string | undefined => typeof prop?.value === 'string' ? prop.value : undefined;

/** Load each OSCAL component definition, retaining only this project's namespaced props. */
export function loadComponents(dir: string): { components: ComponentInput[]; errors: string[] } {
  const components: ComponentInput[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    try {
      const doc = loadJson(file) as any;
      const valid = validateOscal(doc, 'component-definition', { ours: true });
      if (!valid.ok) throw new Error(valid.errors.join('; '));
      for (const component of doc['component-definition'].components ?? []) {
        const allProps = component.props as Prop[] | undefined;
        const ids = ours(allProps, 'component-id');
        if (ids.length !== 1 || !text(ids[0])) throw new Error(`${entry.name}: component-id must occur exactly once`);
        const id = text(ids[0])!;
        if (components.some((item) => item.id === id)) throw new Error(`${entry.name}: duplicate component id ${id}`);
        const implemented: ComponentInput['implemented'][number][] = [];
        for (const implementation of component['control-implementations'] ?? []) for (const requirement of implementation['implemented-requirements'] ?? []) {
          const control = requirement['control-id'];
          const props = requirement.props as Prop[] | undefined;
          if (!props?.every((prop) => prop.name !== 'responsibility' || prop.ns === NS)) throw new Error(`${entry.name}: ${control}: responsibility must use ${NS}`);
          const responsibilities = ours(props, 'responsibility');
          const responsibility = text(responsibilities[0]);
          if (responsibilities.length !== 1 || !responsibility || !RESPONSIBILITIES.includes(responsibility as Responsibility)) throw new Error(`${entry.name}: ${control}: exactly one valid responsibility is required`);
          const statements: Statement[] = (requirement.statements ?? []).map((statement: any) => ({
            id: statement['statement-id'], description: statement.description,
            ...(typeof statement.remarks === 'string' ? { yourOrganizationDoes: statement.remarks } : {}),
            ...(text(ours(statement.props, 'limitation')[0]) ? { limitation: text(ours(statement.props, 'limitation')[0]) } : {}),
            ...(text(ours(statement.props, 'unsettled')[0]) ? { unsettled: text(ours(statement.props, 'unsettled')[0]) } : {}),
            ...(text(ours(statement.props, 'requires-official-signature')[0]) === 'true' ? { requiresOfficialSignature: true } : {})
          }));
          const inheritedFrom = text(ours(props, 'inherited-from')[0]);
          implemented.push({ control, responsibility: responsibility as Responsibility, statements, ...(inheritedFrom ? { inheritedFrom } : {}) });
        }
        components.push({ id, implemented });
      }
    } catch (error) { errors.push(error instanceof Error ? error.message : `${entry.name}: unable to load`); }
  }
  return { components, errors };
}
