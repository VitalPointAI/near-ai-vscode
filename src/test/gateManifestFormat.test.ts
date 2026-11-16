// Tool and MCP manifests v1 (GATE-02, GATE-03, D-05, D-06, D-07, D-38): the format, how the gate fills effects from a call, the restrictive and legacy MCP
// defaults, the shorthand a manifest implies, and the plain words built from the same declaration. No key material or token literal is written here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { effectsFor, parseToolManifest } from '../domain/gate/manifest';
import type { ToolManifest } from '../domain/gate/manifest';
import { describeManifest } from '../domain/gate/words';

const EM_DASH = String.fromCharCode(0x2014);

const WRITE = {
  manifestVersion: 1,
  tool: 'Write',
  effects: [{ verb: 'workspaceWrite', paths: [{ from: 'input', field: 'file_path', as: 'path' }] }],
  hosts: [],
  credentials: [],
  contexts: ['interactive', 'unattended'],
  untrusted: false,
  runsOn: 'this-machine'
};

function parsed(value: unknown): ToolManifest {
  const result = parseToolManifest(value);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

test('tracer: the Write manifest parses, fills its path from one call and is described in plain words', () => {
  const manifest = parsed(WRITE);
  assert.equal(manifest.tool, 'Write');
  const filled = effectsFor(manifest, { file_path: 'src/a.ts' });
  assert.deepEqual(filled.ok && filled.value, [{ verb: 'workspaceWrite', paths: ['src/a.ts'] }]);
  const missing = effectsFor(manifest, {});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing-field');
  const words = describeManifest(manifest);
  assert.ok(words.includes('Can change files in this project'));
  assert.ok(words.includes('Can also run when nobody is watching'));
  for (const sentence of words) {
    assert.equal(sentence.includes(EM_DASH), false);
    assert.equal(sentence.includes('NEAR organization'), false);
  }
});
