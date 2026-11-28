// The model-request records the AI bill of materials tests build from (74.1-15): GLM in the research workspace, gpt-oss-120b at agent work, and a
// Nemotron 3 Super request, each written by the gate's own record builder at fixed times. compliance/test/fixtures/ai-bom.sample.json is aiBomFor of
// these records (the drift test checks it). The file has no .test suffix on purpose.
import { SHIPPED_DEFAULT_LABEL } from '../../domain/gate/bundle';
import { resolvePassport } from '../../domain/gate/models';
import type { ResolvedPassport } from '../../domain/gate/models';
import type { DecisionRecord } from '../../domain/gate/record';
import { DEFAULT_ROUTING } from '../../domain/gate/routing';
import type { RouteDecision } from '../../domain/gate/routing';
import { routeRecordFor, sessionRouteFrom } from '../../gate/sessionMark';
import { testGateRuntime } from './gatedRuns';

export const AI_BOM_NOW = Date.parse('2026-11-25T12:00:00Z');
export const AI_BOM_PROJECT = 'Harrow Ridge';

/** The approval a model id resolves to at the fixture's time, from the shipped approvals. */
export function fixtureResolve(model: string): ResolvedPassport | undefined {
  return resolvePassport(undefined, model, AI_BOM_NOW);
}

function recordAt(time: number, model: string, use: 'T0' | 'T2', lane: boolean, index: number): DecisionRecord {
  const runtime = { ...testGateRuntime(), clock: () => time, newRecordId: () => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, productVersion: '0.4.39' };
  const route = sessionRouteFrom(runtime, lane ? { use: { lane: 'research' } } : { use: { tools: true } });
  const resolved = fixtureResolve(model);
  const decision: RouteDecision = {
    allowed: true, tier: 'attested-cloud', rule: 'route.any-cloud', useTier: use,
    ...(resolved === undefined ? {} : { passport: { id: resolved.passport.id, hash: resolved.hash } })
  };
  const facts = { clientRoute: 'near' as const, host: 'https://cloud-api.near.ai/v1', nearEndpoint: true, model: { id: model, privacyBoundary: 'tee' as const }, attestationFailed: false };
  return routeRecordFor(route, decision, facts, { model }, { mark: [], defaultLabel: SHIPPED_DEFAULT_LABEL, bundleHash: 'a'.repeat(64), routing: DEFAULT_ROUTING });
}

/** The fixture's records, oldest first. */
export function aiBomRecords(): DecisionRecord[] {
  return [
    recordAt(AI_BOM_NOW - 3 * 3_600_000, 'z-ai/glm-5.3', 'T0', true, 1),
    recordAt(AI_BOM_NOW - 2 * 3_600_000, 'openai/gpt-oss-120b', 'T2', false, 2),
    recordAt(AI_BOM_NOW - 3_600_000, 'z-ai/glm-5.3', 'T0', true, 3),
    recordAt(AI_BOM_NOW - 1_800_000, 'nvidia/NVIDIA-Nemotron-3-Super-120B', 'T2', false, 4),
    recordAt(AI_BOM_NOW, 'openai/gpt-oss-120b', 'T2', false, 5)
  ];
}
