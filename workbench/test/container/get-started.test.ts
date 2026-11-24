// The Get Started page and the right-hand rail from the Defence preview, in a real browser against the built image (test/e2e/get-started.spec.ts).
// Run it with `npm run test:container`; it is not part of `npm test`. Hygiene: test/helpers/docker.ts.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { freePort, removeOwn, runContainer, runPlaywright, testImage, waitHealthy } from '../helpers/docker';

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
  const result = await runPlaywright('get-started.spec.ts', { WORKBENCH_URL: url });
  assert.equal(result.code, 0, `Playwright failed:\n${result.stdout.slice(-4000)}\n${result.stderr.slice(-4000)}`);
  assert.match(result.stdout, /\b2 passed\b/);
});
