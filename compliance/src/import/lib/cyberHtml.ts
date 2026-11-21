import { parse } from 'parse5';
import type { DefaultTreeAdapterTypes } from 'parse5';
type Node = DefaultTreeAdapterTypes.Node; type Element = DefaultTreeAdapterTypes.Element;
const element = (node: Node): node is Element => 'tagName' in node;
const kids = (node: Node): Node[] => 'childNodes' in node ? node.childNodes : [];
const text = (node: Node): string => ('value' in node ? node.value : kids(node).map(text).join('')).replace(/\s+/g, ' ').trim();
const attr = (node: Element, name: string) => node.attrs.find((item) => item.name === name)?.value;
export const parseHtml = (html: string) => parse(html);
export function mainOf(document: Node): Element { const stack=[document]; while(stack.length){const node=stack.shift()!; if(element(node)&&node.tagName==='main') return node; stack.push(...kids(node));} throw new Error('page has no main'); }
export function controlSections(main: Node): Element[] { const out: Element[]=[]; const stack=[main]; while(stack.length){const node=stack.shift()!; if(element(node)&&node.tagName==='h2'&&/^\d+\.\d+-[A-Z]{2}-\d+$/.test(attr(node,'id')??'')) out.push(node); stack.push(...kids(node));} return out; }
export function subSections(section: Node): Readonly<Record<string,string>> { const out: Record<string,string>={}; let label=''; const parent = element(section) ? section.parentNode : null; for(const child of parent ? kids(parent) : []){if(child===section) {label=''; continue;} if(element(child)&&child.tagName==='h2') break; if(element(child)&&child.tagName==='h3') label=text(child).replace(/:$/,''); else if(label) out[label]=(out[label] ? out[label]+' ' : '')+text(child); } return out; }
export const listItems = (node: Node): string[] => { const out:string[]=[]; const walk=(n:Node)=>{if(element(n)&&n.tagName==='li') out.push(text(n)); else kids(n).forEach(walk);}; walk(node); return out; };
export const parseParameters=(value:string)=>[...value.matchAll(/\[(?:Assignment|Selection(?: \(1 or more\))?):\s*([^\]]+)\]/g)].map(match=>match[1].trim());
export function normalizeId(id:string):string { const m=/^([A-Za-z]{2})-(\d+)(?:\((\d+)\))?$/.exec(id); if(!m) throw new Error(`invalid control id ${id}`); return `${m[1].toLowerCase()}-${m[2].padStart(2,'0')}${m[3]?'.'+m[3].padStart(2,'0'):''}`; }
export function labelOf(id:string):string { const m=/^([a-z]{2})-(\d+)(?:\.(\d+))?$/.exec(id); if(!m) throw new Error(`invalid normalized id ${id}`); return `${m[1].toUpperCase()}-${m[2]}${m[3]?'('+m[3]+')':''}`; }
export function nistIdOf(id:string):string { const m=/^([a-z]{2})-(\d+)(?:\.(\d+))?$/.exec(id); if(!m) throw new Error(`invalid normalized id ${id}`); return `${m[1]}-${Number(m[2])}${m[3]?'.'+Number(m[3]):''}`; }
