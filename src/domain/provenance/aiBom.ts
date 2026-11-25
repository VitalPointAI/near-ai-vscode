// The AI bill of materials (74.1 D-24, MPRV-10): which models a project used, built from its model-request records, in CycloneDX 1.6 JSON. One
// machine-learning-model component per model: supplier, licence, artifact hash when known, pedigree ancestors (the base and each teacher, with origin), and
// properties for origin, approval id and hash, place class, uses served, lane, and first and last use. Pure: no clock (the time is the last record's),
// no file, and never any prompt or answer text (a record holds none). Deterministic: the same records give the same bytes.
import { createHash } from 'node:crypto';
import type { DecisionRecord } from '../gate/record';
import type { Passport, ResolvedPassport } from '../gate/models';
import { ROUTE_RULES } from '../gate/routing';

const ROUTE_RULE_SET: ReadonlySet<string> = new Set<string>(ROUTE_RULES);

export const AI_BOM_SPEC_VERSION = '1.6';
/** The licence ids CycloneDX takes as SPDX ids; any other licence is named. Only ids the shipped approvals use and the SPDX list has. */
const SPDX_IDS: ReadonlySet<string> = new Set(['Apache-2.0', 'MIT', 'CC-BY-4.0', 'BSD-3-Clause']);
const PROPERTY = 'sovai';

interface Seen {
  readonly model: string;
  readonly provider: string;
  passport?: { readonly id: string; readonly hash: string };
  readonly uses: Set<string>;
  lane: boolean;
  first: number;
  last: number;
}

/** A license entry: an SPDX id when it is one, its name otherwise. */
function licenceOf(passport: Passport): Record<string, unknown> {
  return SPDX_IDS.has(passport.licence.id) ? { license: { id: passport.licence.id } } : { license: { name: passport.licence.id } };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Where the model ran, as a place class: this computer, NEAR AI's private hardware, or a forwarding provider. */
function placeClass(seen: Seen, passport: Passport | undefined): string {
  if (seen.provider === 'local') return 'local';
  if (seen.provider === 'near-ai') return passport?.hosting.includes('nearai-tee') === true ? 'nearai-tee' : 'forwarded';
  return 'unknown';
}

/** The model records of a project's log, by model: allowed infer records only (a refused request used no model). */
function seenModels(records: readonly DecisionRecord[]): Seen[] {
  const byModel = new Map<string, Seen>();
  for (const record of records) {
    const nearAi = record.unmapped.nearAi;
    const capability = nearAi.capability as { verb?: string; model?: string; provider?: string };
    if (capability.verb !== 'infer' || record.action_id !== 1) continue;
    // A model request's own record (a route rule), not an event about a session's routing.
    const rule = record.authorizations[0]?.policy.name ?? '';
    if (!ROUTE_RULE_SET.has(rule)) continue;
    const model = capability.model ?? '';
    if (model === '' || model === 'unknown-model') continue;
    const found = byModel.get(model) ?? { model, provider: capability.provider ?? 'unknown', uses: new Set<string>(), lane: false, first: record.time, last: record.time };
    if (nearAi.passport !== undefined && nearAi.passportHash !== undefined) found.passport = { id: nearAi.passport, hash: nearAi.passportHash };
    if (nearAi.useTier !== undefined) found.uses.add(nearAi.useTier);
    if (nearAi.lane === 't0') { found.lane = true; found.uses.add('T0'); }
    found.first = Math.min(found.first, record.time);
    found.last = Math.max(found.last, record.time);
    byModel.set(model, found);
  }
  return [...byModel.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
}

function component(seen: Seen, resolved: ResolvedPassport | undefined): Record<string, unknown> {
  const passport = resolved?.passport;
  const properties: Array<{ name: string; value: string }> = [];
  const add = (name: string, value: string | undefined): void => { if (value !== undefined && value !== '') properties.push({ name: `${PROPERTY}:${name}`, value }); };
  add('origin', passport?.origin);
  add('passport', seen.passport?.id ?? passport?.id);
  add('passportHash', seen.passport?.hash ?? resolved?.hash);
  add('endpointClass', placeClass(seen, passport));
  add('usesServed', [...seen.uses].sort().join(','));
  if (seen.lane) add('lane', 't0');
  add('firstUse', iso(seen.first));
  add('lastUse', iso(seen.last));
  const ancestors = passport === undefined ? [] : [
    { type: 'machine-learning-model', name: passport.lineage.base, properties: [{ name: `${PROPERTY}:origin`, value: passport.origin }, { name: `${PROPERTY}:relation`, value: 'base' }] },
    ...passport.lineage.teachers.map((teacher) => ({
      type: 'machine-learning-model', name: teacher.model,
      properties: [{ name: `${PROPERTY}:origin`, value: teacher.origin }, { name: `${PROPERTY}:relation`, value: `teacher (${teacher.method})` }]
    }))
  ];
  return {
    type: 'machine-learning-model',
    'bom-ref': `model:${seen.model}`,
    name: seen.model,
    ...(passport === undefined ? {} : { supplier: { name: passport.developer } }),
    ...(passport === undefined ? {} : { licenses: [licenceOf(passport)] }),
    ...(passport?.artifact === undefined ? {} : { hashes: [{ alg: 'SHA-256', content: passport.artifact.sha256 }] }),
    ...(ancestors.length === 0 ? {} : { pedigree: { ancestors } }),
    properties
  };
}

/**
 * The bill of materials of one project's model-request records. `resolve` gives the approval a model id resolves to now (resolvePassport over the
 * effective rules); a model with none is listed with no supplier, licence or pedigree. The metadata time is the last use, so a second export of the same
 * records gives the same bytes.
 */
export function aiBomFor(records: readonly DecisionRecord[], options: { readonly project: string; readonly resolve: (model: string) => ResolvedPassport | undefined }): Record<string, unknown> {
  const seen = seenModels(records);
  const components = seen.map((entry) => component(entry, options.resolve(entry.model)));
  const last = seen.reduce((latest, entry) => Math.max(latest, entry.last), 0);
  const body = { components, project: options.project };
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const serial = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX',
    specVersion: AI_BOM_SPEC_VERSION,
    serialNumber: serial,
    version: 1,
    metadata: {
      ...(last === 0 ? {} : { timestamp: iso(last) }),
      tools: { components: [{ type: 'application', name: 'SovAI' }] },
      component: { type: 'application', 'bom-ref': 'project', name: options.project }
    },
    components
  };
}

/** The models a bill lists, and its first and last use, for the export's message. */
export function aiBomSummary(bom: Record<string, unknown>): { readonly models: number; readonly first?: string; readonly last?: string } {
  const components = (bom['components'] as Array<{ properties?: Array<{ name: string; value: string }> }> | undefined) ?? [];
  const times = (name: string) => components.map((entry) => entry.properties?.find((property) => property.name === `${PROPERTY}:${name}`)?.value).filter((value): value is string => value !== undefined).sort();
  const first = times('firstUse')[0];
  const last = times('lastUse').at(-1);
  return { models: components.length, ...(first === undefined ? {} : { first }), ...(last === undefined ? {} : { last }) };
}
