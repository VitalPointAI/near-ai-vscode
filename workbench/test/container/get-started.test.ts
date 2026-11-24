// The Get Started page and the right-hand rail from the Defence preview, in a real browser against the built image (test/e2e/get-started.spec.ts).
// On an image that bundles the NEAR AI extension (the release target), a work-area page's Create button also creates a work area: the spec
// drives it, and this suite checks what was written to the workspace. The Release workflow runs it against the archived release image.
// Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { containerName, freePort, mustRun, removeOwn, runContainer, runPlaywright, testImage, waitHealthy } from '../helpers/docker';

let image = '';

before(async () => {
  image = await testImage();
});

after(async () => {
  await removeOwn();
});

test('the rail shortcuts and the Get Started work-area cards are present and open their pages', async () => {
  const port = await freePort();
  const started = await runContainer('get-started', ['-d', '-p', `127.0.0.1:${port}:3000`,
    '-e', 'STERLING_LISTEN_HOST=0.0.0.0', '-e', 'STERLING_PREVIEW_NO_SIGN_IN=accept', image]);
  assert.equal(started.code, 0, started.stderr);
  const url = `http://127.0.0.1:${port}`;
  await waitHealthy('get-started', url);
  const name = containerName('get-started');
  const bundled = (await mustRun('docker', ['exec', name, 'node', '-e', "console.log(require('fs').existsSync('/plugins/extension/package.json') ? 1 : 0)"])).stdout.trim() === '1';
  const title = 'Winter exercise';
  const result = await runPlaywright('get-started.spec.ts', { WORKBENCH_URL: url, STERLING_BUNDLED_EXTENSION: bundled ? '1' : '0', STERLING_WORK_AREA_TITLE: title });
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  if (!bundled) {
    assert.match(result.stdout, /\b2 passed\b/);
    assert.match(result.stdout, /\b1 skipped\b/, 'the development image has no extension to create a work area with');
    return;
  }
  assert.match(result.stdout, /\b3 passed\b/);
  // On disk: one new work-area-<hex> folder in the workspace and nothing else, holding only the marker and its .gitignore, with the kind
  // and the title the person typed.
  const listing = await mustRun('docker', ['exec', name, 'node', '-e', `
    const fs = require('fs'), path = require('path');
    const root = '/home/sterling/workspace';
    const top = fs.readdirSync(root).filter((entry) => !entry.startsWith('.theia'));
    const area = path.join(root, top[0] ?? '');
    const near = path.join(area, '.planning', '.near-ai');
    console.log(JSON.stringify({ top, planning: fs.readdirSync(path.join(area, '.planning')), near: fs.readdirSync(near).sort(),
      marker: JSON.parse(fs.readFileSync(path.join(near, 'work-area.json'), 'utf8')) }));`]);
  const found = JSON.parse(listing.stdout) as { top: string[]; planning: string[]; near: string[]; marker: unknown };
  assert.equal(found.top.length, 1, `the workspace holds only the new work area: ${found.top.join(', ')}`);
  assert.match(found.top[0], /^work-area-[0-9a-f]{16}$/);
  assert.deepEqual(found.planning, ['.near-ai']);
  assert.deepEqual(found.near, ['.gitignore', 'work-area.json']);
  assert.deepEqual(found.marker, { version: 1, kind: 'training', title });
});
