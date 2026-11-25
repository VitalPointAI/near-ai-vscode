// Phase 74.1-03 (D-13): every model request carries its real use. A route made from a gate runtime takes the runtime's context and the project's facts,
// a sub-agent's route starts at its parent's use, and the session's project reaches the route policy, so a risk acceptance scoped to one project covers
// that project only. Fake runtimes and folders only; no network, no model, no key.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { projectScopeId } from '../domain/contextGraph';
import type { GateRuntime } from '../domain/gate/decide';
import { SCALE_PRESETS } from '../domain/gate/labels';
import { DEFAULT_ROUTING, decideRoute } from '../domain/gate/routing';
import type { RouteFacts, RoutePolicy, VerifiedAuthorization } from '../domain/gate/routing';
import { GateHost } from '../gate/host';
import { sessionRouteFrom, sessionUseOf, withSessionRoute } from '../gate/sessionMark';
import type { SessionRoute } from '../gate/sessionMark';
import { routeFactsFor } from '../services/privateRoute';
import { testGateRuntime } from './helpers/gatedRuns';
import { FIXED_NOW, authorizationFor } from './helpers/policyFixtures';
import { MemorySecrets } from './helpers/teamHarness';

const NEAR = 'https://cloud-api.near.ai/v1';
const INPUT = {
  clientRoute: 'near' as const, host: NEAR, info: { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' as const }, attestation: 'unproven' as const,
  fact: { state: 'unknown' as const, host: NEAR }, now: FIXED_NOW, localModelAvailable: false, sessionless: false
};

/** The use the next request inside `route` is checked at. */
const useIn = (route: SessionRoute): string | undefined => withSessionRoute(route, () => routeFactsFor(INPUT).use);

function runtimeWith(extra: Partial<GateRuntime>): GateRuntime {
  return { ...testGateRuntime(), ...extra };
}

test('T-74.1-09: a route made from an unattended runtime is agent work with no options; an interactive one is chat you review', () => {
  assert.equal(useIn(sessionRouteFrom(testGateRuntime({ context: 'unattended' }))), 'T2');
  assert.equal(useIn(sessionRouteFrom(testGateRuntime({ context: 'relay' }))), 'T2');
  assert.equal(useIn(sessionRouteFrom(testGateRuntime({ context: 'interactive' }))), 'T1');
  assert.deepEqual(sessionRouteFrom(testGateRuntime()).useOf?.(), { context: 'interactive' });
});

test('D-13: a run route built with tools is agent work, and its own facts win over the runtime\'s context only to add', () => {
  assert.equal(useIn(sessionRouteFrom(testGateRuntime(), { use: { tools: true } })), 'T2');
  assert.equal(useIn(sessionRouteFrom(testGateRuntime(), { use: () => ({ writesFiles: true }) })), 'T2');
  assert.deepEqual(sessionRouteFrom(testGateRuntime(), { use: { tools: true } }).useOf?.(), { context: 'interactive', tools: true });
});

test('T-74.1-09: a sub-agent\'s route starts at its parent\'s use even when its own facts would give chat you review', () => {
  const parent = sessionRouteFrom(testGateRuntime(), { use: { tools: true } });
  assert.equal(useIn(parent), 'T2');
  const child = sessionRouteFrom(testGateRuntime(), { parent });
  assert.equal(sessionUseOf(child), 'T2', 'seeded from the parent');
  assert.equal(useIn(child), 'T2');
  // A parent that has made no request yet still passes on the use its own facts give.
  const fresh = sessionRouteFrom(testGateRuntime({ context: 'unattended' }));
  assert.equal(useIn(sessionRouteFrom(testGateRuntime(), { parent: fresh })), 'T2');
  // Without a parent the same child facts are chat you review.
  assert.equal(useIn(sessionRouteFrom(testGateRuntime())), 'T1');
});

test('D-13: a staff project is operational work; with the signed exercise attribute it is agent work; with no project nothing changes', () => {
  assert.equal(useIn(sessionRouteFrom(runtimeWith({ project: { id: 'project-a', kind: 'staff' } }))), 'T3');
  assert.equal(useIn(sessionRouteFrom(runtimeWith({ project: { id: 'project-a', kind: 'staff', exercise: true } }))), 'T2');
  assert.equal(useIn(sessionRouteFrom(runtimeWith({ project: { id: 'project-a' } }))), 'T1');
  assert.equal(useIn(sessionRouteFrom(testGateRuntime())), 'T1');
});

test('T-74.1-10: the host gives each runtime its project id and kind, and its route policy names that project', async () => {
  const storage = await mkdtemp(path.join(tmpdir(), 'near-ai-request-use-'));
  const software = await mkdtemp(path.join(tmpdir(), 'near-ai-request-use-software-'));
  const staff = await mkdtemp(path.join(tmpdir(), 'near-ai-request-use-staff-'));
  await mkdir(path.join(staff, '.planning', '.near-ai'), { recursive: true });
  await writeFile(path.join(staff, '.planning', '.near-ai', 'project.json'), JSON.stringify({ staff: { profile: 'example' } }));
  const host = new GateHost({ globalStorageDir: storage, secrets: new MemorySecrets(), productVersion: '0.4.40-test' });
  await host.start();
  const request = { actor: { kind: 'agent' as const, sessionId: 'request-use', agentLabel: 'agent' }, presence: 'person' as const, context: 'interactive' as const };
  const plain = await host.runtimeFor({ ...request, root: software });
  assert.deepEqual(plain.project, { id: projectScopeId(software) });
  assert.equal(plain.routePolicy?.(host.now())?.project, projectScopeId(software));
  const staffRuntime = await host.runtimeFor({ ...request, root: staff });
  assert.deepEqual(staffRuntime.project, { id: projectScopeId(staff), kind: 'staff' });
  assert.equal(useIn(sessionRouteFrom(staffRuntime)), 'T3');
  // No folder: no project.
  const none = await host.runtimeFor(request);
  assert.equal(none.project, undefined);
  assert.equal(none.routePolicy?.(host.now())?.project, undefined);
  await host.flush();
});

test('T-74.1-10: a t1-risk authorization scoped to the session\'s project covers a chat request there, and one naming another project does not', () => {
  const project = projectScopeId('/example/projects/northern-example');
  const facts: RouteFacts = { clientRoute: 'near', host: NEAR, nearEndpoint: true, model: { id: 'z-ai/glm-5.3', privacyBoundary: 'tee' }, attestationFailed: false, now: FIXED_NOW, use: 'T1' };
  const accepted = (projects: string[]): VerifiedAuthorization => ({ body: authorizationFor({ kind: 't1-risk', subject: { model: 'z-ai/glm' }, scope: { projects, uses: ['t1'] } }), selfSigned: false });
  const policy = (authorization: VerifiedAuthorization): RoutePolicy => ({
    endpoints: [], authorizations: [authorization], scales: SCALE_PRESETS, mappings: [], clearances: [], organization: true, requireAccreditedDevice: false, now: FIXED_NOW, project,
    models: { v: 1, mode: 'enforce', unknownMaxTier: 'T0', passports: [] }
  });
  const mark = [{ scale: 'org', level: 'Public', compartments: [], releasability: [], handling: [] }];
  assert.equal(decideRoute(mark, DEFAULT_ROUTING, facts, undefined, undefined, policy(accepted([project]))).allowed, true);
  const other = decideRoute(mark, DEFAULT_ROUTING, facts, undefined, undefined, policy(accepted([projectScopeId('/example/projects/other')])));
  assert.deepEqual({ allowed: other.allowed, passportGap: other.passportGap }, { allowed: false, passportGap: 'acceptance-missing' });
});

test('D-13: projectScopeId is the project memory scope\'s id, the same for the same folder however it is written', () => {
  assert.match(projectScopeId('/example/projects/a'), /^project-[0-9a-f]{32}$/);
  assert.equal(projectScopeId('/example/projects/a'), projectScopeId('/example/projects/b/../a'));
  assert.notEqual(projectScopeId('/example/projects/a'), projectScopeId('/example/projects/b'));
});
