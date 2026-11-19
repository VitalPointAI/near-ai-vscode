// The COP's layers and who may write each (design 10, 4.3; research note 11, 6.1; UX concept 5.10; WP-COP). Pure: no I/O, no clock, no vscode.
//
// Two kinds of layer. Product layers (operations, threat, terrain, logistics, plans) are staff products with exactly one writer each, from the WP-0
// ownership table (ownership.ts), resolved for the team's roster so a member that stands in for a job a smaller roster folds (the brigade ipb-analyst
// for the threat and terrain layers) is the writer. Everyone else proposes. Feed layers (obs/layers.ts) are views over observations: nobody writes a
// feature into one, by hand or by tool; only their settings have an owner, and others propose a settings change to that owner.
//
// The plans layer never merges into the current picture: it is drawn apart and off by default.
import type { StaffSectionId } from '../doctrine';
import { FEED_LAYERS, feedLayer, feedLayerSettingsOwner, mayWriteFeedLayerFeatures } from '../obs/layers';
import { mayWrite, proposalFolder, resolveWriter, sharedProduct, writerOf } from '../ownership';
import type { StaffMode, StaffPhase, StaffWriter } from '../ownership';
import { staffProductPath } from '../writeLimits';

export const PRODUCT_LAYERS = ['cop-operations-layer', 'cop-threat-layer', 'cop-terrain-layer', 'cop-logistics-layer', 'cop-plans-layer'] as const;
export type ProductLayer = (typeof PRODUCT_LAYERS)[number];

export const PRODUCT_LAYER_TITLES: Readonly<Record<ProductLayer, string>> = {
  'cop-operations-layer': 'Operations', 'cop-threat-layer': 'Threat', 'cop-terrain-layer': 'Terrain', 'cop-logistics-layer': 'Logistics', 'cop-plans-layer': 'Plans (COA sketches)'
};

/** The layers drawn apart from the current picture: the plans layer never merges into it (design 10, 4.3). */
export const SEPARATE_LAYERS: readonly string[] = ['cop-plans-layer'];

/** Layer ownership never changes with phase or mode in the table; the context is still passed so a later table that does change it is honoured. */
export const COP_CONTEXT: { readonly phase: StaffPhase; readonly mode: StaffMode } = { phase: 'planning', mode: 'standalone' };

export function isProductLayer(layer: string): layer is ProductLayer {
  return (PRODUCT_LAYERS as readonly string[]).includes(layer);
}

export function isCopLayer(layer: string): boolean {
  return isProductLayer(layer) || feedLayer(layer) !== undefined;
}

/** Every layer id, product layers first, in the order the map lists them. */
export function copLayerIds(): string[] {
  return [...PRODUCT_LAYERS, ...FEED_LAYERS.map((entry) => entry.layer)];
}

export function copLayerTitle(layer: string): string {
  return isProductLayer(layer) ? PRODUCT_LAYER_TITLES[layer] : feedLayer(layer)?.title ?? layer;
}

/** The table writer of a product layer (with the members that stand in for it in smaller rosters). */
function tableWriter(layer: ProductLayer): StaffWriter {
  const entry = sharedProduct(layer)!;
  const rule = entry.owners.find((owner) => (owner.phase === 'any' || owner.phase === COP_CONTEXT.phase) && (owner.mode === 'any' || owner.mode === COP_CONTEXT.mode))!;
  return rule.writer;
}

/** The section a product layer's file lives in: its writer's section. */
export function layerSection(layer: ProductLayer): StaffSectionId {
  return writerOf(layer, COP_CONTEXT)!.section;
}

/** The layer's product file, where its features are a GeoJSON FeatureCollection in a fenced block. */
export function layerPath(layer: ProductLayer): string {
  return staffProductPath(layerSection(layer), layer);
}

export function layerProposalFolder(layer: string): string {
  return proposalFolder(layer);
}

/** Who a caller is, for the access rules: a member slug in a section team, with the team's roster. The run's lead (no member) only reads. */
export interface CopCaller {
  readonly section: StaffSectionId;
  readonly member?: string;
  readonly roster: readonly string[];
}

export type LayerAccess =
  | { readonly kind: 'product'; readonly layer: ProductLayer; readonly writer: StaffWriter; readonly mayWrite: boolean }
  | { readonly kind: 'feed'; readonly layer: string; readonly settingsOwner: StaffWriter; readonly mayChangeSettings: boolean; readonly mayWrite: false }
  | { readonly kind: 'none'; readonly layer: string; readonly mayWrite: false };

/**
 * What a caller may do with a layer. A product layer: write it only as its one writer, resolved for the caller's roster when the writer is in the
 * caller's section; anyone else proposes. A feed layer: never write a feature; change its settings only as its settings owner.
 */
export function layerAccess(layer: string, caller: CopCaller): LayerAccess {
  if (isProductLayer(layer)) {
    const writer = resolveWriter(tableWriter(layer), caller.section, caller.roster);
    const may = caller.member !== undefined && mayWrite(layer, { section: caller.section, member: caller.member }, COP_CONTEXT, undefined, caller.roster);
    return { kind: 'product', layer, writer, mayWrite: may };
  }
  const entry = feedLayer(layer);
  if (!entry) return { kind: 'none', layer, mayWrite: false };
  const owner = feedLayerSettingsOwner(layer, { section: caller.section, members: caller.roster })!;
  const settings = caller.member !== undefined && owner.section === caller.section && owner.member === caller.member;
  // Feed layers are views: the contract says no one writes their features, and this module never asks anything else.
  if (mayWriteFeedLayerFeatures(layer)) throw new Error('A feed layer became writable; the COP refuses to treat a view as a product.');
  return { kind: 'feed', layer, settingsOwner: owner, mayChangeSettings: settings, mayWrite: false };
}

/** The writer of a layer as words: `j2 threat-analyst`. */
export function writerText(writer: StaffWriter): string {
  return `${writer.section} ${writer.member}`;
}
