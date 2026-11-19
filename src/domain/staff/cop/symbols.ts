// Military symbols on the COP (design 10, 6.2; research note 11, 6.2; UX concept 5.10; WP-COP): the 20-digit symbol identification code (SIDC) of
// MIL-STD-2525D (2014) and APP-6(D) (2017), which milsymbol 3.0.5 draws in the 2525E and APP-6E look. Pure: no I/O, no clock, no vscode.
//
// A code is built from words, never typed from memory: a standard identity, a symbol set, an entity, an echelon and the headquarters and anticipated
// flags. The context digit is always 0 (reality): in the standard's exercise context the hostile digit means "faker" and draws a friendly frame, so an
// exercise adversary could not be shown as hostile. That the data is an exercise is said by the scenario's marking and the SIM badge instead. Joker and
// faker, the two exercise identities, are the only codes with the exercise context.
//
// Affiliation on the COP is the J2's assessment, never a feed's claim (note 11, 6.2): the features module allows a non-friendly identity only on the
// threat layer.
import { ECHELONS, STANDARD_IDENTITIES, SYMBOL_SETS } from '../doctrine';
import type { Echelon, StandardIdentity, SymbolSet } from '../doctrine';
import type { PartySide } from '../scenario';

/** The SIDC version digits: 10 is MIL-STD-2525D and APP-6(D), the number form milsymbol draws. */
export const SIDC_VERSION = '10';
export const SIDC_PATTERN = /^[0-9]{20}$/;

/** Standard identity digit (position 4) and context digit (position 3) for each identity. */
const IDENTITY_DIGITS: Readonly<Record<StandardIdentity, { readonly context: string; readonly digit: string }>> = {
  pending: { context: '0', digit: '0' }, unknown: { context: '0', digit: '1' }, 'assumed-friend': { context: '0', digit: '2' }, friend: { context: '0', digit: '3' },
  neutral: { context: '0', digit: '4' }, suspect: { context: '0', digit: '5' }, hostile: { context: '0', digit: '6' },
  joker: { context: '1', digit: '5' }, faker: { context: '1', digit: '6' }
};

/** Echelon amplifier digits (positions 9 and 10) for land units. */
const ECHELON_DIGITS: Readonly<Record<Echelon, string>> = {
  team: '11', squad: '12', section: '13', platoon: '14', company: '15', battalion: '16', regiment: '17', brigade: '18',
  division: '21', corps: '22', army: '23', 'army-group': '24', theatre: '25'
};

/**
 * The entities a COP symbol may use, with their names as the standard writes them. The list is the starter scenario's forces and the common staff
 * entities around them; a code outside it is refused, so an agent cannot put a symbol on the map that draws as a bare frame or as something it did not
 * mean. A new entity is one line here with its name from the standard.
 */
export const SYMBOL_ENTITIES: Readonly<Record<SymbolSet, Readonly<Record<string, string>>>> = {
  air: { '110000': 'Military', '110100': 'Fixed wing', '110200': 'Rotary wing', '110300': 'Unmanned aircraft' },
  'land-unit': {
    '110000': 'Command and control', '120500': 'Armour', '120700': 'Aviation, composite', '120800': 'Aviation, fixed wing', '121100': 'Infantry',
    '121101': 'Infantry, amphibious', '121102': 'Infantry, armoured or mechanized', '121104': 'Infantry, motorized', '121300': 'Reconnaissance',
    '121900': 'Unmanned systems', '130300': 'Field artillery', '140700': 'Engineer', '141200': 'Military police', '150500': 'Electronic warfare',
    '151000': 'Military intelligence', '160000': 'Sustainment', '160600': 'Combat service support', '200700': 'Law enforcement'
  },
  'land-equipment': {},
  'land-installation': {},
  'sea-surface': {
    '000000': 'Surface contact, not yet identified', '120200': 'Surface combatant, line', '120300': 'Amphibious warfare ship', '120307': 'Landing ship',
    '120308': 'Landing craft', '120400': 'Mine warfare vessel', '120405': 'Mine countermeasures', '120500': 'Patrol', '120800': 'Military speedboat',
    '121003': 'Navy task group', '140100': 'Merchant ship, general', '140101': 'Cargo, general', '140300': 'Law enforcement vessel'
  },
  'sea-subsurface': { '110000': 'Military submarine' }
};

export interface SymbolSpec {
  readonly identity: StandardIdentity;
  readonly set: SymbolSet;
  readonly entity: string;
  readonly echelon?: Echelon;
  readonly headquarters?: boolean;
  /** Planned or anticipated: drawn with a dashed frame (UX 5.10). */
  readonly anticipated?: boolean;
}

export type SymbolParsed = { readonly ok: true; readonly value: SymbolSpec } | { readonly ok: false; readonly message: string };

const setOfDigits = (digits: string): SymbolSet | undefined => (Object.keys(SYMBOL_SETS) as SymbolSet[]).find((set) => SYMBOL_SETS[set] === digits);

/** Builds the code for a spec. Throws for an entity the table does not hold, or an echelon on a symbol set that has none. */
export function buildSidc(spec: SymbolSpec): string {
  const name = SYMBOL_ENTITIES[spec.set][spec.entity];
  if (name === undefined) throw new Error(`Entity ${spec.entity} is not a ${spec.set} entity the COP draws.`);
  if (spec.echelon !== undefined && spec.set !== 'land-unit') throw new Error('Only a land unit carries an echelon.');
  const identity = IDENTITY_DIGITS[spec.identity];
  return `${SIDC_VERSION}${identity.context}${identity.digit}${SYMBOL_SETS[spec.set]}${spec.anticipated ? '1' : '0'}${spec.headquarters ? '2' : '0'}${spec.echelon ? ECHELON_DIGITS[spec.echelon] : '00'}${spec.entity}0000`;
}

/** Reads a code strictly: version 10, a known identity and set, present or anticipated, no or HQ, a known echelon, an entity from the table, no modifiers. */
export function parseSidc(code: unknown): SymbolParsed {
  if (typeof code !== 'string' || !SIDC_PATTERN.test(code)) return { ok: false, message: 'A symbol code is 20 digits (MIL-STD-2525D or APP-6(D) number form).' };
  if (code.slice(0, 2) !== SIDC_VERSION) return { ok: false, message: 'A symbol code starts with 10 (MIL-STD-2525D or APP-6(D)).' };
  const identity = (Object.keys(IDENTITY_DIGITS) as StandardIdentity[]).find((key) => IDENTITY_DIGITS[key].context === code[2] && IDENTITY_DIGITS[key].digit === code[3]);
  if (!identity) return { ok: false, message: 'The context and identity digits (3 and 4) name no standard identity; the COP uses reality context, or exercise context for joker and faker only.' };
  const set = setOfDigits(code.slice(4, 6));
  if (!set) return { ok: false, message: `Symbol set ${code.slice(4, 6)} is not one the COP draws (air 01, land unit 10, land equipment 15, land installation 20, sea surface 30, sea subsurface 35).` };
  if (code[6] !== '0' && code[6] !== '1') return { ok: false, message: 'The status digit (7) is 0 for present or 1 for planned or anticipated.' };
  if (code[7] !== '0' && code[7] !== '2') return { ok: false, message: 'The headquarters digit (8) is 0, or 2 for a headquarters.' };
  const echelonDigits = code.slice(8, 10);
  const echelon = (Object.keys(ECHELON_DIGITS) as Echelon[]).find((key) => ECHELON_DIGITS[key] === echelonDigits);
  if (echelonDigits !== '00' && (!echelon || set !== 'land-unit')) return { ok: false, message: `Echelon digits ${echelonDigits} are not an echelon of a land unit.` };
  const entity = code.slice(10, 16);
  if (SYMBOL_ENTITIES[set][entity] === undefined) return { ok: false, message: `Entity ${entity} is not a ${set} entity the COP draws.` };
  if (code.slice(16) !== '0000') return { ok: false, message: 'The COP draws no sector modifiers: positions 17 to 20 are 0000.' };
  return { ok: true, value: { identity, set, entity, ...(echelon ? { echelon } : {}), ...(code[7] === '2' ? { headquarters: true } : {}), ...(code[6] === '1' ? { anticipated: true } : {}) } };
}

const SET_WORDS: Readonly<Record<SymbolSet, string>> = {
  air: 'air', 'land-unit': 'land unit', 'land-equipment': 'land equipment', 'land-installation': 'land installation', 'sea-surface': 'sea surface', 'sea-subsurface': 'sea subsurface'
};
const IDENTITY_WORDS: Readonly<Record<StandardIdentity, string>> = {
  pending: 'Pending', unknown: 'Unknown', 'assumed-friend': 'Assumed friend', friend: 'Friend', neutral: 'Neutral', suspect: 'Suspect', hostile: 'Hostile',
  joker: 'Joker (exercise)', faker: 'Faker (exercise)'
};

/** A code in words, as a symbol's card shows it: affiliation in words, never colour alone (UX 5.10). */
export function describeSymbol(spec: SymbolSpec): string {
  const parts = [`${IDENTITY_WORDS[spec.identity]} ${SET_WORDS[spec.set]}`, SYMBOL_ENTITIES[spec.set][spec.entity].toLowerCase()];
  if (spec.echelon) parts.push(spec.echelon.replace('-', ' '));
  if (spec.headquarters) parts.push('headquarters');
  if (spec.anticipated) parts.push('planned or anticipated');
  return parts.join(', ');
}

/** The identity a scenario party's side gives its forces' symbols. An unidentified contact stays unknown until the J2 assesses it. */
export const PARTY_SIDE_IDENTITY: Readonly<Record<PartySide, StandardIdentity>> = {
  friendly: 'friend', 'host-nation': 'friend', adversary: 'hostile', neutral: 'neutral', unknown: 'unknown'
};

/**
 * The symbol each force kind in the starter scenario takes (Exercise IRON LANTERN): the kind as the scenario writes it, the symbol set and entity, and
 * whether it is a headquarters. The echelon comes from the force's own `echelon` field. A force whose kind is not here gets no symbol and is listed as
 * such, never guessed.
 */
export const FORCE_KIND_SYMBOLS: Readonly<Record<string, { readonly set: SymbolSet; readonly entity: string; readonly headquarters?: true }>> = {
  'Joint task force headquarters': { set: 'land-unit', entity: '110000', headquarters: true },
  'Mechanized infantry brigade headquarters': { set: 'land-unit', entity: '121102', headquarters: true },
  'Mechanized infantry battalion': { set: 'land-unit', entity: '121102' },
  'Infantry battalion': { set: 'land-unit', entity: '121100' },
  'Armour squadron': { set: 'land-unit', entity: '120500' },
  'Armour company': { set: 'land-unit', entity: '120500' },
  'Reconnaissance squadron': { set: 'land-unit', entity: '121300' },
  'Field artillery regiment': { set: 'land-unit', entity: '130300' },
  'Artillery battalion': { set: 'land-unit', entity: '130300' },
  'Coastal battery': { set: 'land-unit', entity: '130300' },
  'Combat service support battalion': { set: 'land-unit', entity: '160600' },
  'Amphibious task group': { set: 'sea-surface', entity: '121003' },
  'Amphibious infantry battalion': { set: 'land-unit', entity: '121101' },
  'Mine countermeasures detachment': { set: 'sea-surface', entity: '120405' },
  'Air detachment': { set: 'land-unit', entity: '120700' },
  'Coast guard flotilla': { set: 'sea-surface', entity: '120500' },
  Police: { set: 'land-unit', entity: '200700' },
  'Coastal brigade headquarters': { set: 'land-unit', entity: '110000', headquarters: true },
  'Uncrewed aircraft platoon': { set: 'land-unit', entity: '121900' },
  'Electronic warfare detachment': { set: 'land-unit', entity: '150500' },
  'Local militia aligned with Dravic': { set: 'land-unit', entity: '121100' },
  'Small fast surface contact': { set: 'sea-surface', entity: '000000' },
  'Merchant vessel (bulk carrier)': { set: 'sea-surface', entity: '140101' }
};

/** The code for a scenario force, or undefined when its kind has no symbol in FORCE_KIND_SYMBOLS. */
export function forceSidc(force: { readonly kind: string; readonly echelon?: string }, side: PartySide): string | undefined {
  const symbol = FORCE_KIND_SYMBOLS[force.kind];
  if (!symbol) return undefined;
  const echelon = symbol.set === 'land-unit' && force.echelon && (ECHELONS as readonly string[]).includes(force.echelon) ? (force.echelon as Echelon) : undefined;
  return buildSidc({ identity: PARTY_SIDE_IDENTITY[side], set: symbol.set, entity: symbol.entity, ...(echelon ? { echelon } : {}), ...(symbol.headquarters ? { headquarters: true } : {}) });
}

/** Whether a standard identity is one only the J2 assesses (anything but friend and assumed friend). */
export function isAssessedIdentity(identity: StandardIdentity): boolean {
  return identity !== 'friend' && identity !== 'assumed-friend';
}

export { STANDARD_IDENTITIES };
