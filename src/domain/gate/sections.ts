// The sections of policy bundle v2 that hold today's v1 fields and the small Phase 41 sections (FND-02, FND-05, Phase 41 D-04, D-05, D-08, D-28, D-33, D-34,
// D-60, D-63). Pure: no I/O, no clock, no vscode, no package.
// Every section is an object with its own `v: 1`; another number is `unknown-version` at `<section>.v`, which reads as "update the extension". Keys are exact
// (checkKeys), values are read as own properties and never spread, every result is frozen, and set-like lists are sorted and unique so two documents that
// mean the same thing hash the same. Optional keys with a stated default are filled, so a parsed section is its own v2 wire form.
// Imported values are used only inside functions, never at module load, so a later cycle through routing.ts stays safe.
import type { ActionPolicyMode } from '../policy';
import {
  MAX_ANCHOR_ROOTS, MAX_MAPPINGS, MAX_STATUS_LISTS, mappingKey, parseAnchorRoot, parseContexts, parseList, parseMaxMode, parseMaxOfflineAge,
  parseMcpLabelCeilings, parseScales, parseServerIds, parseSetList, parseStatusList
} from './bundle';
import type { AnchorRoot, GateContextName, StatusListRef } from './bundle';
import { parseLabel, parseMapping } from './labels';
import type { Clearance, Label, ScaleMapping, ScaleTable } from './labels';
import { parseRouting } from './routing';
import type { RoutingTable } from './routing';
import { checkKeys, childPath, isRecord, ownValue, refused } from './shape';
import type { Fields, Parsed, Refusal } from './shape';
import type { CapabilityVerb } from './vocabulary';

export const SECTION_VERSION = 1;

/** The section's `v`: 1, another number `unknown-version` (update the extension), anything else `wrong-type`. Undefined when it is 1. */
export function checkSectionVersion(value: Fields, path: string): Refusal | undefined {
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== SECTION_VERSION) return refused('unknown-version', childPath(path, 'v'));
  return v === SECTION_VERSION ? undefined : refused('wrong-type', childPath(path, 'v'));
}

/** The opening every section parser shares: an object, `v` read before the keys (so a newer section with new keys says "update"), then the exact keys. */
export function openSection(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Parsed<Fields> {
  if (!isRecord(value)) return refused('wrong-type', path);
  const v = ownValue(value, 'v');
  if (typeof v === 'number' && v !== SECTION_VERSION) return refused('unknown-version', childPath(path, 'v'));
  const keys = checkKeys(value, path, ['v', ...required], optional) ?? checkSectionVersion(value, path);
  return keys ?? { ok: true, value };
}

export function has(value: Fields, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// labels (labels@1): scales, mappings, the default label and the routing table without localHosts (D-04; localHosts became endpoints, D-27)

/** The routing table of a v2 document: today's table without `localHosts`, whose entries are endpoints now. */
export type LabelsRouting = Omit<RoutingTable, 'localHosts'>;

export interface LabelsSection {
  readonly v: 1;
  readonly scales: ScaleTable;
  readonly mappings: readonly ScaleMapping[];
  readonly defaultLabel: Label;
  readonly routing: LabelsRouting;
}

/** labels: every key required, read with the v1 rules. Its scales feed every other section, so the document reads it first. */
export function parseLabelsSection(value: unknown, path = 'labels'): Parsed<LabelsSection> {
  const section = openSection(value, path, ['scales', 'mappings', 'defaultLabel', 'routing']);
  if (!section.ok) return section;
  const opened = section.value;
  const scales = parseScales(ownValue(opened, 'scales'), childPath(path, 'scales'));
  if (!scales.ok) return scales;
  const mappings = parseSetList(
    ownValue(opened, 'mappings'), childPath(path, 'mappings'), MAX_MAPPINGS, (item, where) => parseMapping(item, scales.value, where), mappingKey
  );
  if (!mappings.ok) return mappings;
  const defaultLabel = parseLabel(ownValue(opened, 'defaultLabel'), scales.value, childPath(path, 'defaultLabel'));
  if (!defaultLabel.ok) return defaultLabel;
  const routingPath = childPath(path, 'routing');
  const routingValue = ownValue(opened, 'routing');
  if (!isRecord(routingValue)) return refused('wrong-type', routingPath);
  const routingKeys = checkKeys(routingValue, routingPath, ['levels', 'handling', 'compartments']);
  if (routingKeys !== undefined) return routingKeys;
  // Rebuilt from own values with no local hosts, so the v1 table parser reads exactly these three keys and nothing a prototype could add.
  const rebuilt = { levels: ownValue(routingValue, 'levels'), handling: ownValue(routingValue, 'handling'), compartments: ownValue(routingValue, 'compartments'), localHosts: [] };
  const routing = parseRouting(rebuilt, scales.value, routingPath);
  if (!routing.ok) return routing;
  return {
    ok: true,
    value: Object.freeze({
      v: 1,
      scales: scales.value,
      mappings: mappings.value,
      defaultLabel: defaultLabel.value,
      routing: Object.freeze({ levels: routing.value.levels, handling: routing.value.handling, compartments: routing.value.compartments })
    })
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// agents (agents@1): today's ceiling, with the MCP lists under `mcp` and the accredited-device switch (D-04, D-34)

export interface AgentsMcp {
  /** MCP servers allowed in unattended runs, by id (v1 `ceiling.unattendedMcp`). */
  readonly unattended: readonly string[];
  /** v1 `ceiling.mcpLabelCeilings`; absent when the policy names none. */
  readonly labelCeilings?: Readonly<Record<string, Clearance>>;
}

export interface AgentsSection {
  readonly v: 1;
  readonly maxMode: Readonly<Record<GateContextName, ActionPolicyMode>>;
  readonly contexts: Readonly<Partial<Record<CapabilityVerb, readonly GateContextName[]>>>;
  readonly mcp: AgentsMcp;
  /**
   * D-34: refuse classified and Protected C work on a computer with no accredited-device authorization. Only an organization layer's `true` turns
   * refusal on; the default `false` keeps today's report-only behaviour.
   */
  readonly requireAccreditedDevice: boolean;
}

export function parseAgentsSection(value: unknown, scales: ScaleTable, path = 'agents'): Parsed<AgentsSection> {
  const section = openSection(value, path, ['maxMode', 'contexts', 'mcp'], ['requireAccreditedDevice']);
  if (!section.ok) return section;
  const opened = section.value;
  const maxMode = parseMaxMode(ownValue(opened, 'maxMode'), childPath(path, 'maxMode'));
  if (!maxMode.ok) return maxMode;
  const contexts = parseContexts(ownValue(opened, 'contexts'), childPath(path, 'contexts'));
  if (!contexts.ok) return contexts;
  const mcpPath = childPath(path, 'mcp');
  const mcpValue = ownValue(opened, 'mcp');
  if (!isRecord(mcpValue)) return refused('wrong-type', mcpPath);
  const mcpKeys = checkKeys(mcpValue, mcpPath, ['unattended'], ['labelCeilings']);
  if (mcpKeys !== undefined) return mcpKeys;
  const unattended = parseServerIds(ownValue(mcpValue, 'unattended'), childPath(mcpPath, 'unattended'));
  if (!unattended.ok) return unattended;
  let mcp: AgentsMcp = Object.freeze({ unattended: unattended.value });
  if (has(mcpValue, 'labelCeilings')) {
    const ceilings = parseMcpLabelCeilings(ownValue(mcpValue, 'labelCeilings'), scales, childPath(mcpPath, 'labelCeilings'));
    if (!ceilings.ok) return ceilings;
    mcp = Object.freeze({ unattended: unattended.value, labelCeilings: ceilings.value });
  }
  let requireAccreditedDevice = false;
  if (has(opened, 'requireAccreditedDevice')) {
    const flag = ownValue(opened, 'requireAccreditedDevice');
    if (typeof flag !== 'boolean') return refused('wrong-type', childPath(path, 'requireAccreditedDevice'));
    requireAccreditedDevice = flag;
  }
  return { ok: true, value: Object.freeze({ v: 1, maxMode: maxMode.value, contexts: contexts.value, mcp, requireAccreditedDevice }) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// reserved (no feature id): today's reserved v1 fields, validated for shape and ignored (D-12 of Phase 70, unchanged meaning)

export interface ReservedSection {
  readonly v: 1;
  readonly anchorRoots: readonly AnchorRoot[];
  readonly statusLists: readonly StatusListRef[];
  readonly maxOfflineAge: Readonly<Record<string, number>>;
}

export function parseReservedSection(value: unknown, scales: ScaleTable, path = 'reserved'): Parsed<ReservedSection> {
  const section = openSection(value, path, ['anchorRoots', 'statusLists', 'maxOfflineAge']);
  if (!section.ok) return section;
  const opened = section.value;
  const anchorRoots = parseList(ownValue(opened, 'anchorRoots'), childPath(path, 'anchorRoots'), MAX_ANCHOR_ROOTS, parseAnchorRoot);
  if (!anchorRoots.ok) return anchorRoots;
  const statusLists = parseList(ownValue(opened, 'statusLists'), childPath(path, 'statusLists'), MAX_STATUS_LISTS, parseStatusList);
  if (!statusLists.ok) return statusLists;
  const maxOfflineAge = parseMaxOfflineAge(ownValue(opened, 'maxOfflineAge'), scales, childPath(path, 'maxOfflineAge'));
  if (!maxOfflineAge.ok) return maxOfflineAge;
  return { ok: true, value: Object.freeze({ v: 1, anchorRoots: anchorRoots.value, statusLists: statusLists.value, maxOfflineAge: maxOfflineAge.value }) };
}
