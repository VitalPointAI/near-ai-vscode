import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setProjectLabel } from '../../domain/gate/labelMap';
import type { GuideOutbound } from '../../domain/setup/guideMessages';
import { createAuditEventRegistry, GUIDE_AUDIT_EVENT_SPECS } from '../../domain/setup/records';
import type { ViabilityResult } from '../../domain/setup/viability';
import { projectLogKey } from '../../gate/decisionLog';
import { GateHost } from '../../gate/host';
import { SetupAuditLog } from '../../gate/setupAuditLog';
import type { GuideControllerDeps } from '../../services/setup/guideController';
import { singleMachineSink } from '../../services/setup/projectLayerSink';
import { createProjectLayerSource } from '../../services/setup/projectStore';
import { MemorySecrets } from './teamHarness';

export const at = Date.parse('2026-11-22T22:13:07.034Z');
export const local: ViabilityResult = {
  optionId: 'this-computer', kind: 'this-computer', state: 'not-detected', models: [],
  hostKind: 'container', sentence: 'No local AI server was found. This computer has 16 GB of memory.'
};
const url = 'https://cloud-api.near.ai/v1';
export const near: ViabilityResult = {
  optionId: 'near-private', kind: 'near-private', state: 'viable', models: [], hostKind: 'container',
  answeredAt: at, routeFacts: { clientRoute: 'near', host: url, model: { id: 'fixture', privacyBoundary: 'tee' },
    binding: { state: 'bound', host: url, checkedAt: at } }
};

export async function setup(options: { results?: readonly ViabilityResult[]; initialLabel?: { scale: string; level: string } } = {}) {
  let time = at;
  const root = await mkdtemp(path.join(tmpdir(), 'near-guide-host-'));
  const storage = await mkdtemp(path.join(tmpdir(), 'near-guide-storage-'));
  const host = new GateHost({ globalStorageDir: storage, projectRoot: root, secrets: new MemorySecrets(), productVersion: '0.4.36', now: () => new Date(time) });
  await host.start();
  const label = host.labelPolicy().defaultLabel;
  await host.changeLabels(root, (map) => setProjectLabel(map, { ...label, ...(options.initialLabel ?? { scale: 'org', level: 'Public' }) }));
  const source = createProjectLayerSource({ readFileSync, statSync, scales: () => host.labelPolicy().scales, now: () => time });
  host.useProjectLayerSource(source.read);
  const registry = createAuditEventRegistry();
  for (const spec of GUIDE_AUDIT_EVENT_SPECS) registry.register(spec);
  const audit = new SetupAuditLog({ globalStorageDir: storage, projectRoot: root, projectKey: projectLogKey(root), registry, clock: () => time, onWriteFailure: assert.fail });
  const runtime = await host.runtimeFor({ root, actor: { kind: 'person', sessionId: 'setup-test' }, presence: 'person', context: 'interactive' });
  const posted: GuideOutbound[] = [];
  const calls = { checks: 0, lands: 0 };
  const deps: GuideControllerDeps = {
    root, hostKind: 'container', machine: 'test host', clock: () => time,
    readPolicy: async (now) => {
      const state = runtime.bundleState();
      const layers = host.policyLayers();
      const route = runtime.routePolicy?.(now);
      return state.state === 'valid' && route ? {
        view: { effective: layers.effective, organization: layers.organization.state, startingRules: true, issuedHere: false },
        route, hash: state.hash, routing: state.bundle.routing, defaultLabel: state.bundle.defaultLabel,
        floor: undefined, projectLabel: (await host.labelsFor(root).view(state.bundle.scales)).resolve('', state.bundle.defaultLabel).mark[0]
      } : { view: { organization: 'failed', startingRules: false, issuedHere: false } };
    },
    check: async (snapshot, progress) => {
      calls.checks++;
      const results = (options.results ?? [local, near]).map((result) => ({ ...result,
        answeredAt: result.state === 'viable' ? time : result.answeredAt, policyHash: snapshot.hash,
        ...(result.routeFacts?.binding ? { routeFacts: { ...result.routeFacts, binding: { ...result.routeFacts.binding, checkedAt: time } } } : {})
      }));
      results.forEach(progress);
      return { results, stillChecking: [], dispose() {} };
    },
    apply: {
      labelHost: host, sink: singleMachineSink(root, { effective: () => host.policyLayers().effective, source }), audit,
      connection: () => ({ changeId: 'connection', alreadyDone: async () => true, run: async () => assert.fail('saved connection does not need changing') })
    },
    landing: { async land() { calls.lands++; } },
    post: (message) => posted.push(message)
  };
  return { root, storage, host, audit, deps, posted, calls, setTime(value: number) { time = value; } };
}
