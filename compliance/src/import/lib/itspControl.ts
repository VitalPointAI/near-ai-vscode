import type { DefaultTreeAdapterTypes } from 'parse5';
import { NS } from '../../model.ts';
import { labelOf, normalizeId } from './cyberHtml.ts';
import { proseWithParams } from './oscalBuild.ts';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type Lang = 'en' | 'fr';
const isElement = (node: Node): node is Element => 'tagName' in node;
const children = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const text = (node: Node): string => ('value' in node ? node.value : children(node).map(text).join('')).replace(/\s+/g, ' ').trim();
const direct = (node: Node, tag: string) => children(node).filter((child): child is Element => isElement(child) && child.tagName === tag);
const labels = new Map<string, string>([
  ['control', 'control'], ['contrôle', 'control'], ['activity', 'activity'], ['activité', 'activity'],
  ['discussion', 'discussion'], ['discussion within the gc', 'gc-discussion'], ['discussion au sein du gc', 'gc-discussion'],
  ['related controls and activities', 'related'], ['contrôles et activités connexes', 'related'],
  ['references', 'references']
]);

export interface ParsedControl { readonly id: string; readonly control: Record<string, unknown>; readonly enhancements: number; readonly canadaSpecific: number; readonly unknownEnhancements: readonly string[]; }

function untilNextSection(section: Element): Node[] {
  const parent = section.parentNode;
  if (!parent) return [];
  const after = children(parent).slice(children(parent).indexOf(section) + 1);
  const next = after.findIndex((node) => isElement(node) && node.tagName === 'h2');
  return next === -1 ? after : after.slice(0, next);
}

function listText(node: Node): string[] {
  return direct(node, 'li').map(text).filter(Boolean);
}

function contentByHeading(section: Element): Readonly<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  let heading = '';
  for (const node of untilNextSection(section)) {
    if (isElement(node) && node.tagName === 'h3') heading = labels.get(text(node).replace(/:$/, '').toLowerCase()) ?? '';
    else if (heading && isElement(node) && ['ol', 'ul'].includes(node.tagName)) out[heading] = [...(out[heading] ?? []), ...listText(node)];
    else if (heading) { const value = text(node); if (value) out[heading] = [...(out[heading] ?? []), value]; }
  }
  return out;
}

/** Converts a measured ITSP h2 section into one OSCAL base control; no HTML reaches OSCAL prose. */
function enhancementList(section: Element): Element[] {
  let seen = false;
  const lists: Element[] = [];
  for (const node of untilNextSection(section)) {
    if (isElement(node) && node.tagName === 'h3') seen = /enhancement|amélioration/i.test(text(node));
    else if (seen && isElement(node) && ['ol', 'ul'].includes(node.tagName)) lists.push(node);
  }
  return lists;
}

export function controlFromSection(section: Element, lang: Lang): ParsedControl {
  const rawId = section.attrs.find((item) => item.name === 'id')?.value.match(/([A-Z]{2}-\d+(?:\(\d+\))?)$/)?.[1];
  if (!rawId) throw new Error('control heading has no ITSP id');
  const id = normalizeId(rawId);
  const title = text(section).replace(new RegExp(`^${rawId.replace(/[()]/g, '\\$&')}\\s*`), '');
  const content = contentByHeading(section);
  const klass = content.activity ? 'activity' : 'control';
  const statements = content[klass] ?? [];
  const rendered = proseWithParams(statements.join('\n'), id);
  const props: Record<string, string>[] = [{ name: 'label', value: labelOf(id) }];
  if (/-4\d\d$/.test(id)) props.push({ name: 'canada-specific', ns: NS, value: 'true' });
  const parts: Record<string, unknown>[] = [{ id: `${id}_smt`, name: 'statement', prose: rendered.prose }];
  if (content.discussion?.length) parts.push({ id: `${id}_guidance`, name: 'guidance', prose: content.discussion.join('\n') });
  if (content['gc-discussion']?.length) parts.push({ id: `${id}_gc`, name: 'gc-discussion', ns: NS, prose: content['gc-discussion'].join('\n') });
  if (content.references?.length) parts.push({ id: `${id}_references`, name: 'references', prose: content.references.join('\n') });
  const related = (content.related ?? []).flatMap((value) => value.match(/[A-Z]{2}-\d+(?:\(\d+\))?/g) ?? []).map((relatedId) => ({ rel: 'related', href: `#${normalizeId(relatedId)}` }));
  const control: Record<string, unknown> = { id, title, class: klass, props, parts, ...(related.length ? { links: related } : {}) };
  if (rendered.params.length) control.params = rendered.params.map((parameter, index) => ({ id: parameter, label: content[klass]?.join(' ').match(/\[(?:Assignment|Selection(?: \(1 or more\))?):\s*([^\]]+)\]/g)?.[index] ?? parameter }));
  const enhancements = enhancementsFrom(enhancementList(section), id);
  if (enhancements.controls.length) control.controls = enhancements.controls;
  return { id, control, enhancements: enhancements.controls.length, canadaSpecific: props.some((prop) => prop.name === 'canada-specific') ? 1 + enhancements.controls.filter((item: any) => item.props.some((prop: any) => prop.name === 'canada-specific')).length : enhancements.controls.filter((item: any) => item.props.some((prop: any) => prop.name === 'canada-specific')).length, unknownEnhancements: enhancements.unknown };
}

/** Parses the two official enhancement title variants; callers retain unknown list entries for reconciliation. */
export function enhancementsFrom(list: readonly Node[], parentId = ''): { readonly controls: readonly Record<string, unknown>[]; readonly unknown: readonly string[] } {
  const controls: Record<string, unknown>[] = [];
  const unknown: string[] = [];
  for (const listNode of list) for (const item of direct(listNode, 'li')) {
    const heading = [...direct(item, 'strong'), ...direct(item, 'h4')][0];
    const match = heading && /^\((\d+)\)\s*(.+)$/.exec(text(heading));
    if (!match || !parentId) { unknown.push(text(item)); continue; }
    const id = `${parentId}.${match[1].padStart(2, '0')}`;
    const props: Record<string, string>[] = [{ name: 'label', value: labelOf(id) }];
    if (/-4\d\d(?:\.400)?$/.test(parentId) || match[1] === '400') props.push({ name: 'canada-specific', ns: NS, value: 'true' });
    const prose = text(item).replace(text(heading), '').trim() || match[2];
    controls.push({ id, title: match[2], class: 'enhancement', props, parts: [{ id: `${id}_smt`, name: 'statement', prose }] });
  }
  return { controls, unknown };
}

/** Returns ids present in only one language and pairs all common ids without relying on page order. */
export function pairFrench(englishControls: readonly ParsedControl[], frenchControls: readonly ParsedControl[]) {
  const english = new Map(englishControls.map((control) => [control.id, control]));
  const french = new Map(frenchControls.map((control) => [control.id, control]));
  return { pairs: [...english.keys()].filter((id) => french.has(id)).map((id) => ({ english: english.get(id)!, french: french.get(id)! })), frenchOnly: [...french.keys()].filter((id) => !english.has(id)), englishOnly: [...english.keys()].filter((id) => !french.has(id)) };
}
