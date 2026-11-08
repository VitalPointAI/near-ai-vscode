// Every script the webviews load must be valid JavaScript (owner, 2026-11-07). A TypeScript cast (`x as Element`) was written into media/chat/chat.js
// during the between-steps picker work: it compiled, linted and passed every unit test, and then broke the whole sidebar in a real window because the
// page could not parse it. The e2e caught it; this catches it in seconds, before a push.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const MEDIA = path.join(__dirname, '..', '..', 'media');

function scriptsIn(folder: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(folder)) {
    const full = path.join(folder, name);
    if (statSync(full).isDirectory()) found.push(...scriptsIn(full));
    else if (name.endsWith('.js')) found.push(full);
  }
  return found;
}

test('every webview script parses as JavaScript, so a page can never break on a stray TypeScript cast', () => {
  const scripts = scriptsIn(MEDIA);
  assert.ok(scripts.length >= 10, `the scan reads the webview scripts (${scripts.length} found)`);
  const broken: string[] = [];
  for (const file of scripts) {
    const source = readFileSync(file, 'utf8');
    try {
      // Compiling is enough: running them needs a DOM, but parsing is what the browser does first and what failed.
      new vm.Script(source, { filename: file });
    } catch (error) {
      broken.push(`${path.relative(MEDIA, file)}: ${(error as Error).message}`);
    }
  }
  assert.deepEqual(broken, [], `every script must parse:\n${broken.join('\n')}`);
});
