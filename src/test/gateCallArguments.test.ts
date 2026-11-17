// PR #74 review round 2: a call's arguments are put in the manifest's shape once. readCallPaths ran the tool's manifestInput, rewrote a trusted-folder read
// in the model's own arguments, and the effects ran manifestInput again over them: for a tool whose manifestInput renames a field, the rewrite landed on a
// name the second pass did not read, so a trusted-folder read became "effects unknown". Every folder here is under the test run's temporary folder.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gateToolCall, readCallPaths } from '../agent/gateAdapter';
import { DEFAULT_RULES, RunGrants } from '../agent/permissions';
import { declareManifest, fromArgument, INTERACTIVE_AND_UNATTENDED, readTool } from '../agent/tools';
import type { AgentTool } from '../agent/tools';
import { testGateRuntime } from './helpers/gatedRuns';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'near-ai-callargs-')));
const ROOT = path.join(base, 'project');
const TRUSTED = path.join(base, 'trusted-runtime');
mkdirSync(ROOT);
mkdirSync(path.join(TRUSTED, 'docs'), { recursive: true });
writeFileSync(path.join(TRUSTED, 'docs', 'guide.md'), 'guide');

let calls = 0;
/** A read tool whose model-facing field is `file` and whose manifest reads `file_path`: its manifestInput renames one to the other. */
const renaming: AgentTool<{ file: string }> = {
  ...readTool,
  name: 'RenamingRead',
  manifest: declareManifest({ tool: 'RenamingRead', effects: [{ verb: 'read', paths: [fromArgument('file_path')] }], contexts: INTERACTIVE_AND_UNATTENDED }),
  manifestInput: (raw: Record<string, unknown>) => {
    calls += 1;
    const { file, ...rest } = raw;
    return { ...rest, file_path: file };
  },
  parse: (raw: Record<string, unknown>) => ({ file: String(raw.file) })
} as unknown as AgentTool<{ file: string }>;

test('a renaming tool\'s read in a trusted folder is a known read, and its manifestInput runs once per call', async () => {
  calls = 0;
  const raw = { file: path.join(TRUSTED, 'docs', 'guide.md') };
  const paths = await readCallPaths(renaming, raw, ROOT, [TRUSTED]);
  assert.deepEqual(paths.trustedReads, ['trusted-runtime/docs/guide.md']);
  calls = 0;
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw, root: ROOT, callId: 'c1', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES, grants: new RunGrants(),
    readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.equal(calls, 1, 'manifestInput ran once for the whole decision');
  assert.deepEqual(gated.effects, [{ verb: 'read', paths: ['**'] }], 'a known read, not unknown effects');
  assert.equal(gated.decision.outcome, 'allow', `not ${gated.decision.rule}`);
});

test('a renaming tool\'s read outside the project and every trusted folder still has unknown effects', async () => {
  const outside = path.join(base, 'elsewhere.md');
  writeFileSync(outside, 'x');
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw: { file: outside }, root: ROOT, callId: 'c2', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    grants: new RunGrants(), readOnlyRoots: [TRUSTED], buildAuto: async () => undefined
  });
  assert.deepEqual(gated.effects, []);
  assert.equal(gated.decision.rule, 'manifest.effects-unknown');
});

test('a renaming tool\'s read inside the project is the project path', async () => {
  writeFileSync(path.join(ROOT, 'notes.md'), 'n');
  const gated = await gateToolCall(testGateRuntime({ presence: 'none', context: 'unattended' }), {
    tool: renaming, raw: { file: path.join(ROOT, 'notes.md') }, root: ROOT, callId: 'c3', policy: { mode: 'fully-autonomous', emergencyStop: false }, rules: DEFAULT_RULES,
    grants: new RunGrants(), buildAuto: async () => undefined
  });
  assert.deepEqual(gated.effects, [{ verb: 'read', paths: ['notes.md'] }]);
});
