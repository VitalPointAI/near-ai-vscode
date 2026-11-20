// The layout probe (media/shared/layout-probe.js) clicks buttons by selector and drives the map on a message ('layout-click', 'layout-act'). It is
// test-only: the hosts load it only under the extension-host tests (NEAR_AI_E2E=1, src/services/layoutProbe.ts), and it is left out of the package.
// This test asks vsce itself which files the published extension holds, so a change to .vscodeignore, a `files` list or a new copy of the handlers
// in a shipped script cannot put them in front of a real user (#124 review).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.join(__dirname, '..', '..');
const PROBE_MESSAGES = /['"]layout-(click|act|stress)['"]/;

function packagedFiles(): string[] {
  const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
  const out = execFileSync(process.execPath, [vsce, 'ls', '--no-dependencies'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

test('the packaged extension holds no layout probe and no script that answers its click or act messages', () => {
  const files = packagedFiles();
  assert.ok(files.includes('package.json') && files.includes('media/shared/base.css'), `vsce listed the package (${files.length} files)`);
  assert.ok(!files.some((file) => /layout-probe/.test(file)), 'the layout probe is not packaged');
  const scripts = files.filter((file) => /\.(c|m)?js$|\.html$/.test(file));
  assert.ok(scripts.some((file) => file.startsWith('media/')), 'the page scripts are checked');
  const answering = scripts.filter((file) => PROBE_MESSAGES.test(readFileSync(path.join(ROOT, file), 'utf8')));
  assert.deepEqual(answering, [], 'no packaged script handles layout-click, layout-act or layout-stress');
});

test('the probe answers its messages only when it is loaded, which only the extension-host tests do', () => {
  const probe = readFileSync(path.join(ROOT, 'media', 'shared', 'layout-probe.js'), 'utf8');
  assert.match(probe, PROBE_MESSAGES, 'the handlers live in the probe, the one file that is never packaged');
  assert.match(readFileSync(path.join(ROOT, 'src', 'services', 'layoutProbe.ts'), 'utf8'), /return layoutProbeEnabled\(\) \? webview\.asWebviewUri\(/);
});
