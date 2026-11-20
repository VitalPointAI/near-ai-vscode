// The `people` section of policy bundle v2 (people@1, FND-01, FND-04, FND-07, Phase 41 D-04, D-15, D-31, D-39, D-40). Pure: no I/O, no clock, no vscode, no package.
// `clearances` is the v1 `clearances` list, read with the v1 rules (self-declared on the personal layer). `signers` lists the people your organization lets
// sign authorizations, with their keys (D-31; only your organization's layer may set it, D-19). `organization` is how your organization works: the mode,
// the modes a project may use, whether a project may choose, and settings that may only tighten what a mode allows (D-40). Every key stays optional, so
// `{ v: 1 }` parses, and any key this section does not name is refused.
// Imported values are used only inside functions, never at module load.
import { MAX_CLEARANCES, clearanceKey, parseSetList } from '../gate/bundle';
import { parsePolicySigners } from '../gate/authorizations';
import type { PolicySigner } from '../gate/authorizations';
import { parseClearance } from '../gate/labels';
import type { Clearance, ScaleTable } from '../gate/labels';
import { checkKeys, childPath, isRecord, isSafeIntegerInRange, ownValue, refused } from '../gate/shape';
import type { Parsed } from '../gate/shape';
import { MODE_IDS } from './modes';
import type { ModeId } from './modes';

/** The settings of people.organization as parsed: the two numbers always filled with their defaults, each boolean only when written (D-40). */
export interface OrganizationSettings {
  /** How many times posting authority may be passed on: 0 (the default) means delegates may not delegate again (portfolio O2). */
  readonly maxDelegationDepth: number;
  /** Days after the start date before an unreported posting is overdue (portfolio D4). */
  readonly overdueDays: number;
}

/** How your organization works (D-40): `mode` is the default for everything under the policy and is always one of `allowedModes`. */
export interface OrganizationBlock {
  readonly mode: ModeId;
  /** Sorted and unique, never empty. */
  readonly allowedModes: readonly ModeId[];
  /** Whether a project may pick its own mode from `allowedModes`. */
  readonly projectMayChoose: boolean;
  /** Always present after parsing, so a document is its own wire form with every default filled. */
  readonly settings: OrganizationSettings;
}

export interface PeopleSection {
  readonly v: 1;
  /** v1 `clearances`: on the personal layer the person's own declaration (D-27 of Phase 70); absent when the section does not set it. */
  readonly clearances?: readonly Clearance[];
  /** Who may sign authorizations (D-31), sorted by fingerprint; absent when the section does not set it. */
  readonly signers?: readonly PolicySigner[];
  /** How your organization works (D-40); absent when the section does not set it. */
  readonly organization?: OrganizationBlock;
}

const PEOPLE_OPTIONAL = ['clearances', 'signers', 'organization'] as const;
const ORGANIZATION_REQUIRED = ['mode', 'allowedModes', 'projectMayChoose'] as const;
const ORGANIZATION_OPTIONAL = ['settings'] as const;
const DEFAULT_MAX_DELEGATION_DEPTH = 0;
const DEFAULT_OVERDUE_DAYS = 2;

function parseModeId(value: unknown, path: string): Parsed<ModeId> {
  return typeof value === 'string' && (MODE_IDS as readonly string[]).includes(value) ? { ok: true, value: value as ModeId } : refused('wrong-type', path);
}

function parseSettings(value: unknown, path: string): Parsed<OrganizationSettings> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, [], ['maxDelegationDepth', 'overdueDays']);
  if (keys !== undefined) return keys;
  const number = (key: string, min: number, max: number, fallback: number): Parsed<number> => {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: true, value: fallback };
    const found = ownValue(value, key);
    return isSafeIntegerInRange(found, min, max) ? { ok: true, value: found } : refused('wrong-type', childPath(path, key));
  };
  const maxDelegationDepth = number('maxDelegationDepth', 0, 2, DEFAULT_MAX_DELEGATION_DEPTH);
  if (!maxDelegationDepth.ok) return maxDelegationDepth;
  const overdueDays = number('overdueDays', 1, 30, DEFAULT_OVERDUE_DAYS);
  if (!overdueDays.ok) return overdueDays;
  return { ok: true, value: Object.freeze({ maxDelegationDepth: maxDelegationDepth.value, overdueDays: overdueDays.value }) };
}

function parseOrganizationBlock(value: unknown, path: string): Parsed<OrganizationBlock> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const keys = checkKeys(value, path, ORGANIZATION_REQUIRED, ORGANIZATION_OPTIONAL);
  if (keys !== undefined) return keys;
  const mode = parseModeId(ownValue(value, 'mode'), childPath(path, 'mode'));
  if (!mode.ok) return mode;
  const allowedPath = childPath(path, 'allowedModes');
  const allowedValue = ownValue(value, 'allowedModes');
  if (Array.isArray(allowedValue) && allowedValue.length === 0) return refused('empty-list', allowedPath);
  const allowedModes = parseSetList(allowedValue, allowedPath, MODE_IDS.length, parseModeId, (id) => id);
  if (!allowedModes.ok) return allowedModes;
  if (!allowedModes.value.includes(mode.value)) return refused('not-allowed-here', childPath(path, 'mode'));
  const projectMayChoose = ownValue(value, 'projectMayChoose');
  if (typeof projectMayChoose !== 'boolean') return refused('wrong-type', childPath(path, 'projectMayChoose'));
  const settings = parseSettings(Object.prototype.hasOwnProperty.call(value, 'settings') ? ownValue(value, 'settings') : {}, childPath(path, 'settings'));
  if (!settings.ok) return settings;
  return { ok: true, value: Object.freeze({ mode: mode.value, allowedModes: allowedModes.value, projectMayChoose, settings: settings.value }) };
}

export function parsePeopleSection(value: unknown, scales: ScaleTable, path = 'people'): Parsed<PeopleSection> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== 1) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v'], PEOPLE_OPTIONAL);
  if (keys !== undefined) return keys;
  if (v !== 1) return refused('wrong-type', childPath(path, 'v'));
  const out: { v: 1; clearances?: readonly Clearance[]; signers?: readonly PolicySigner[]; organization?: OrganizationBlock } = { v: 1 };
  if (Object.prototype.hasOwnProperty.call(value, 'clearances')) {
    const clearances = parseSetList(
      ownValue(value, 'clearances'), childPath(path, 'clearances'), MAX_CLEARANCES, (item, where) => parseClearance(item, scales, where), clearanceKey
    );
    if (!clearances.ok) return clearances;
    out.clearances = clearances.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'signers')) {
    const signers = parsePolicySigners(ownValue(value, 'signers'), childPath(path, 'signers'));
    if (!signers.ok) return signers;
    out.signers = signers.value;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'organization')) {
    const organization = parseOrganizationBlock(ownValue(value, 'organization'), childPath(path, 'organization'));
    if (!organization.ok) return organization;
    out.organization = organization.value;
  }
  return { ok: true, value: Object.freeze(out) };
}
