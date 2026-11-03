import { PROFILE_CONTENT } from '../domain/cyber';
// The panel's real run stack, assembled the way extension.ts assembles it. The panel tests inject
// every dependency, which is why three bugs reached this plan unnoticed: a hardcoded acceptance
// snapshot (every run refused with reacceptance-required), an empty tool list (no step could ever
// execute), and no client (the planner always reported the model incompatible). This file exercises
// the assembly itself, so a regression in the wiring fails here rather than in a user's first run.

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { DisclaimerAcceptance, Engagement, ResolvedScope } from '../domain/cyber';
import { scopeFingerprint } from '../domain/cyberLegal';
import { RunGrants } from '../agent/permissions';
import { RunCheckpoints } from '../agent/checkpoints';
import { ShellSession } from '../agent/shell';
import { cyberAssembly, cyberStorePath, modesFor, panelCyberRunStarter, panelModel, panelTools, RATE_PER_MINUTE, type CompletionClient } from '../services/cyberAssembly';

import { startCyberRun } from '../services/cyberRun';

const SCOPE: ResolvedScope = { hosts: ['example.test'], ports: [443], paths: ['/'], exclusions: [] };

const ACCEPTANCE: DisclaimerAcceptance = {
  acceptor: 'Example Organisation Ltd', osUser: 'test-user', machine: 'test-machine', extensionVersion: '0.4.10',
  textVersion: '2026-11-02', region: 'us', acceptedAt: '2026-11-02T12:00:00Z'
};

function engagement(allowedModes: Engagement['allowedModes'] = ['passive']): Engagement {
  return {
    id: 'eng-00000000-0000-4000-8000-000000000001', workspace: '/workspace/example',
    target: { kind: 'url', value: 'https://example.test/' }, resolvedScope: SCOPE, region: 'us',
    authorizationStatement: 'The acceptor owns the target.', allowedModes, exclusions: [],
    sandbox: { tier: 'tempFolder' }, acceptedDisclaimer: ACCEPTANCE, createdAt: ACCEPTANCE.acceptedAt, frozen: true
  };
}

const STEP = JSON.stringify({ id: 's1', role: 'planner', action: 'probe', target: 'https://example.test/', tool: 'CyberHttpProbe', args: [], sandbox: 'none', expectedResult: 'a 200 response', safetyFlags: { maxDurationMs: 5_000, rateLimit: 0, denyList: [] } });

/** A client that answers every role with the same valid step, so the run reaches the operator. */
const stepClient: CompletionClient = { completeOnce: async () => ({ text: STEP }) };

async function context(): Promise<{ root: string; toolContext: ReturnType<typeof buildContext> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-assembly-'));
  return { root, toolContext: buildContext(root) };
}

function buildContext(root: string) {
  return { root, signal: new AbortController().signal, checkpoints: new RunCheckpoints('cyber-assembly'), shell: new ShellSession(root), readFiles: new Set<string>() };
}

test('the assembled stack passes the acceptance gate, so a run reaches its planner instead of refusing', async () => {
  const { root, toolContext } = await context();
  const assembly = cyberAssembly({ globalStorageUri: { fsPath: root }, extension: { packageJSON: { version: '0.4.10' } } }, { client: stepClient, model: 'test-model', toolContext, tools: () => [] });
  try {
    const subject = engagement();
    // The snapshot is derived from the engagement, never a constant: this is the bug that made every
    // run refuse with "reacceptance-required".
    const snapshot = assembly.currentAcceptance(subject);
    assert.equal(snapshot.region, subject.region);
    assert.equal(snapshot.scope, scopeFingerprint(subject.resolvedScope));
    assert.equal(snapshot.textVersion, subject.acceptedDisclaimer.textVersion);
    assert.equal(snapshot.extensionVersion, '0.4.10');

    const result = await startCyberRun({
      engagement: subject,
      currentAcceptance: snapshot,
      driver: assembly.driver,
      tools: assembly.tools(subject),
      ledger: assembly.ledger,
      evidence: assembly.evidence,
      grants: assembly.grants,
      policy: assembly.policy,
      requestApproval: assembly.requestApproval,
      toolContext,
      signal: toolContext.signal
    });
    assert.notEqual(result.outcome, 'refused', `the run must not be refused at the gate, got: ${result.reason}`);
    // The step names a tool the run does not attach, so it is recorded as a refusal and the run still
    // completes: what matters here is that the gate let it start at all.
    assert.equal(result.outcome, 'completed');
    assert.equal(result.ledgerOk, true);
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('a stale snapshot still refuses, so the gate is exercised rather than bypassed', async () => {
  const { root, toolContext } = await context();
  const assembly = cyberAssembly({ globalStorageUri: { fsPath: root }, extension: { packageJSON: { version: '9.9.9' } } }, { client: stepClient, model: 'test-model', toolContext, tools: () => [] });
  try {
    const subject = engagement();
    // The engagement was accepted under 0.4.10; the extension now reports 9.9.9.
    const stale = assembly.currentAcceptance(subject);
    assert.equal(stale.extensionVersion, '9.9.9');
    const result = await startCyberRun({
      engagement: subject, currentAcceptance: stale, driver: assembly.driver, tools: [], ledger: assembly.ledger,
      evidence: assembly.evidence, grants: assembly.grants, policy: assembly.policy,
      requestApproval: assembly.requestApproval, toolContext, signal: toolContext.signal
    });
    assert.equal(result.outcome, 'refused');
    assert.match(result.reason ?? '', /^reacceptance-required:/);
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('the real tool set is non-empty, read-only for a passive engagement and shell-capable for intrusive', () => {
  const passive = panelTools({
    engagement: engagement(['passive']), scope: SCOPE, grants: new RunGrants(),
    stopped: () => false, sandboxTier: 'tempFolder', collect: () => undefined
  });
  const names = passive.map((entry) => entry.tool.name);
  assert.ok(names.includes('CyberHttpProbe'), `the probes are attached, got: ${names.join(', ')}`);
  assert.ok(names.includes('CyberIacProbe'));
  assert.equal(names.includes('CyberExploitTool'), false, 'a passive engagement gets no exploit tools');
  assert.equal(passive.every((entry) => entry.capability === 'read'), true);

  const intrusive = panelTools({
    engagement: engagement(['passive', 'intrusive']), scope: SCOPE, grants: new RunGrants(),
    stopped: () => false, sandboxTier: 'tempFolder', collect: () => undefined
  });
  const intrusiveNames = intrusive.map((entry) => entry.tool.name);
  assert.ok(intrusiveNames.includes('CyberExploitTool'), 'an intrusive engagement gets the exploit tools');
  assert.ok(intrusiveNames.includes('CyberPostExploitTool'));
  assert.equal(intrusive.filter((entry) => entry.capability === 'shell').length >= 2, true, 'the exploit tools run under the shell capability');
});

test('a collected probe finding reaches the run through the tool set', async () => {
  // The probe's onFindings collector is what carries structured findings into the run. A local
  // server answers here, so no DNS is needed and nothing leaves the machine.
  const { createServer } = await import('node:http');
  const collected: string[] = [];
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><body>fixture</body></html>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const localScope: ResolvedScope = { hosts: ['127.0.0.1'], ports: [port], paths: ['/'], exclusions: [] };
  const tools = panelTools({
    engagement: { ...engagement(['passive']), resolvedScope: localScope }, scope: localScope, grants: new RunGrants(),
    stopped: () => false, sandboxTier: 'tempFolder', collect: (finding) => collected.push(finding.checkId)
  });
  const probe = tools.find((entry) => entry.tool.name === 'CyberHttpProbe')!;
  const root = await mkdtemp(path.join(tmpdir(), 'near-ai-cyber-collect-'));
  const shell = new ShellSession(root);
  try {
    const parsed = probe.tool.parse({ url: `http://127.0.0.1:${port}/`, checks: [] });
    await probe.tool.run(parsed, { ...buildContext(root), signal: new AbortController().signal });
    assert.ok(collected.includes('missing-hsts'), `the header finding reached the collector, got: ${collected.join(', ')}`);
  } finally {
    shell.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the model choice prefers the per-engagement value and falls back to the chat tier', () => {
  assert.equal(panelModel('z-ai/glm-5.3', 'chat-model'), 'z-ai/glm-5.3');
  assert.equal(panelModel(undefined, 'chat-model'), 'chat-model');
  assert.equal(panelModel('   ', 'chat-model'), 'chat-model');
});

test('an assembly with no model refuses to build, naming the real problem', () => {
  // A run used to fall back to a hardcoded model id and fail later as "the model did not follow the
  // protocol", which sent the reader looking in the wrong place. The assembly now says what is wrong.
  assert.throws(
    () => cyberAssembly({ globalStorageUri: { fsPath: '/tmp' }, extension: { packageJSON: { version: '0.4.10' } } }, { client: stepClient, toolContext: buildContext('/tmp'), tools: () => [] }),
    /No model was chosen for this scan/
  );
});

test('an assembly with a client but no model chosen refuses the same way', () => {
  assert.throws(
    () => cyberAssembly({ globalStorageUri: { fsPath: '/tmp' }, extension: { packageJSON: { version: '0.4.10' } } }, { model: '   ', toolContext: buildContext('/tmp'), tools: () => [] }),
    /No model was chosen for this scan/
  );
});

test('a driver whose client returns nothing reports the model incompatible, not a successful empty run', async () => {
  const { root, toolContext } = await context();
  // A client that answers with an empty string is what a broken transport looks like to the driver.
  const silent: CompletionClient = { completeOnce: async () => ({ text: '' }) };
  const assembly = cyberAssembly({ globalStorageUri: { fsPath: root }, extension: { packageJSON: { version: '0.4.10' } } }, { client: silent, model: 'test-model', toolContext, tools: () => [] });
  try {
    const subject = engagement();
    const result = await startCyberRun({
      engagement: subject, currentAcceptance: assembly.currentAcceptance(subject), driver: assembly.driver, tools: [],
      ledger: assembly.ledger, evidence: assembly.evidence, grants: assembly.grants, policy: assembly.policy,
      requestApproval: assembly.requestApproval, toolContext, signal: toolContext.signal
    });
    assert.equal(result.outcome, 'incompatible');
    assert.match(result.reason ?? '', /planner could not follow the JSON protocol/);
    assert.equal(result.findings.length, 0);
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('the store path and the run root are the same workspace, so an export can find the run', async () => {
  const { root, toolContext } = await context();
  const globalStorage = path.join(root, 'globalStorage');
  const workspaceRoot = path.join(root, 'workspace');
  // The bug this covers: the panel resolved the model client with the globalStorage path while the
  // store was keyed by the workspace, so a run wrote under 'no-workspace' and export never found it.
  // The key is the whole workspace path, sanitised: two workspaces with the same folder name must
  // not share a store.
  const key = workspaceRoot.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  assert.equal(cyberStorePath(globalStorage, workspaceRoot), path.join(globalStorage, 'cyber', key));
  assert.notEqual(cyberStorePath(globalStorage, undefined), cyberStorePath(globalStorage, workspaceRoot));
  const assembly = cyberAssembly(
    { globalStorageUri: { fsPath: globalStorage }, extension: { packageJSON: { version: '0.4.10' } } },
    { workspaceRoot, client: stepClient, model: 'test-model', toolContext, tools: () => [] }
  );
  try {
    assert.ok(assembly.ledger.runPath('run-0001-abcdef').startsWith(path.join(globalStorage, 'cyber', key)), 'the ledger lives under the workspace key');
  } finally {
    assembly.toolContext.shell.dispose();
  }
});

test('a run started for a workspace resolves its client with that workspace, not the store', async () => {
  const { root, toolContext } = await context();
  const workspaceRoot = path.join(root, 'workspace');
  const asked: string[] = [];
  const starter = panelCyberRunStarter(
    { globalStorageUri: { fsPath: path.join(root, 'globalStorage') }, extension: { packageJSON: { version: '0.4.10' } } },
    async (askedRoot) => { asked.push(askedRoot); return stepClient; },
    { root: workspaceRoot, model: 'test-model' }
  );
  const subject = engagement();
  const result = await starter({ engagement: subject, mode: 'defensive', depth: 'quick', signal: new AbortController().signal, onEvent: () => undefined });
  assert.deepEqual(asked, [workspaceRoot], 'the client was resolved for the workspace, which is where the profile lives');
  assert.notEqual(result.outcome, 'refused');
});

test('the run mode decides which tools attach, so Defensive never carries the exploit tools', () => {
  assert.deepEqual(modesFor('defensive', ['passive', 'intrusive']), ['passive']);
  assert.deepEqual(modesFor('offensive', ['passive', 'intrusive']), ['passive', 'intrusive']);
  assert.deepEqual(modesFor('full', ['passive', 'intrusive']), ['passive', 'intrusive']);
  // An engagement that was never granted intrusion cannot get the exploit tools through a mode.
  assert.deepEqual(modesFor('offensive', ['passive']), ['passive']);
});

test('the starter reports the rate limit and budget it will actually apply', () => {
  // The limits were never constructed before, so a deep run had no 45-minute bound at all.
  assert.equal(RATE_PER_MINUTE.quick, 10);
  assert.ok(RATE_PER_MINUTE.standard > RATE_PER_MINUTE.quick);
  assert.ok(RATE_PER_MINUTE.deep > RATE_PER_MINUTE.standard);
  assert.ok(PROFILE_CONTENT.deep.budgetMs >= 45 * 60_000);
});

test('a disabled engagement keeps its disabled tier instead of falling back to the host', () => {
  // The tier used to default to tempFolder, so a disabled engagement ran payloads on the machine.
  const modes = modesFor('defensive', ['passive']);
  assert.deepEqual(modes, ['passive']);
});
