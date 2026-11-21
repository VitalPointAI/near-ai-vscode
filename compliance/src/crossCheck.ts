import { parse } from 'yaml';
import { normalizeId } from './import/lib/cyberHtml.ts';

type Doc = any;
const canonical = (id: string): string => {
  if (/^[a-z]{2}-\d{2}(?:\.\d+)?$/.test(id)) return id;
  const match = /^([a-z]{2})-(\d+)(?:\.(\d+)|\((\d+)\))?$/i.exec(id);
  if (!match) throw new Error(`invalid cross-check control id ${id}`);
  return normalizeId(`${match[1]}-${match[2]}${match[3] ?? match[4] ? `(${match[3] ?? match[4]})` : ''}`);
};
const controls = (doc: Doc): any[] => doc.catalog?.controls ?? doc.catalog?.groups?.flatMap((group: any) => group.controls ?? []) ?? [];
const selected = (profile: Doc): string[] => profile.profile?.imports?.flatMap((item: any) => item['include-controls']?.flatMap((include: any) => include['with-ids'] ?? []) ?? []) ?? [];
const normalized = (ids: readonly string[]) => [...new Set(ids.map(canonical))].sort();
const tokenSet = (text: string) => new Set(text.toLowerCase().replace(/^\s*[-*]\s*/gm, '').replace(/\s+/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []);
const similarity = (a: string, b: string) => { const left = tokenSet(a); const right = tokenSet(b); const union = new Set([...left, ...right]); return union.size === 0 ? 1 : [...left].filter((word) => right.has(word)).length / union.size; };
const difference = (left: readonly string[], right: readonly string[]) => left.filter((item) => !right.includes(item)).sort();
export interface CrossCheckResult { readonly selectionOnlyOurs: readonly string[]; readonly selectionOnlyAws: readonly string[]; readonly awsControls: readonly string[]; readonly textDiffers: readonly { readonly control: string; readonly similarity: number }[]; readonly onlyItsp: readonly string[]; readonly onlyNist: readonly string[]; readonly cisoMissing: readonly string[]; readonly cisoExtra: readonly string[] }
/** Compares unofficial conversions without copying their descriptions into output. */
export function crossCheck(input: { readonly ours: { readonly catalog: Doc; readonly profile: Doc }; readonly aws: { readonly catalog: Doc; readonly profile: Doc }; readonly ciso: string; readonly nist: Doc }): CrossCheckResult {
  if (Buffer.byteLength(input.ciso, 'utf8') > 8 * 1024 * 1024) throw new Error('CISO YAML is above the 8 MiB cap');
  const ciso = parse(input.ciso, { maxAliasCount: 100 }) as { requirement_nodes?: readonly { ref_id?: string; description?: string }[] };
  const ours = new Map(controls(input.ours.catalog).map((control) => [canonical(control.id), String(control.parts?.map((part: any) => part.prose ?? '').join(' ') ?? '')]));
  const awsControls = normalized(controls(input.aws.catalog).map((control) => String(control.id)));
  const oursSelected = normalized(selected(input.ours.profile)); const awsSelected = normalized(selected(input.aws.profile));
  const cisoRows = (ciso.requirement_nodes ?? []).filter((node) => node.ref_id && node.description).map((node) => ({ control: canonical(node.ref_id!), description: node.description! }));
  const cisoIds = normalized(cisoRows.map((row) => row.control));
  const textDiffers = cisoRows.flatMap((row) => { const oursText = ours.get(row.control); return oursText !== undefined && similarity(oursText, row.description) < 1 ? [{ control: row.control, similarity: similarity(oursText, row.description) }] : []; }).sort((a, b) => a.control.localeCompare(b.control));
  const nist = normalized(controls(input.nist).map((control) => String(control.id)));
  return { selectionOnlyOurs: difference(oursSelected, awsSelected), selectionOnlyAws: difference(awsSelected, oursSelected), awsControls, textDiffers, onlyItsp: difference([...ours.keys()].sort(), nist), onlyNist: difference(nist, [...ours.keys()].sort()), cisoMissing: difference([...ours.keys()].sort(), cisoIds), cisoExtra: difference(cisoIds, [...ours.keys()].sort()) };
}
/** Reports only identifiers, counts, and similarity—not conversion text. */
export const markdownSummary = (result: CrossCheckResult): string => `# Cross-check\n\n- Selection only ours: ${result.selectionOnlyOurs.join(', ')}\n- Selection only AWS: ${result.selectionOnlyAws.join(', ')}\n- Text differences: ${result.textDiffers.map((item) => `${item.control} (${item.similarity.toFixed(2)})`).join(', ')}`;
