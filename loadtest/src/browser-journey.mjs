// Loaded by the one-shot fixture command. The Playwright dependency comes from the Workbench lockfile.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const terminalMarker = '.sovai-fixture-terminal-final.ok';
const terminalValue = 'SOVAI_FIXTURE_TERMINAL_OK';

async function timed(run) {
  const start = performance.now();
  await run();
  return Math.round(performance.now() - start);
}

async function eventually(matches, message) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (matches()) return;
    await delay(150);
  }
  assert.fail(message);
}

export async function routeFixtureRequest(route, site, permits) {
  const request = route.request();
  if (!permits(request.url(), site, Boolean(request.redirectedFrom()))) {
    await route.abort();
    return;
  }
  // Playwright routes the first URL in a redirect chain. Refuse the redirect before Chromium sees it.
  const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 12_000 })
    .catch(() => undefined);
  if (!response) {
    await route.abort();
    return;
  }
  try {
    const status = response.status();
    if (status >= 300 && status < 400 && status !== 304) await route.abort();
    else await route.fulfill({ response });
  } finally {
    await response.dispose();
  }
}

async function fixturePage(browser, site, permits) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => routeFixtureRequest(route, site, permits));
  await context.routeWebSocket('**/*', async socket => {
    if (permits(socket.url(), site)) socket.connectToServer();
    else await socket.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  page.setDefaultNavigationTimeout(12_000);
  return { context, page };
}

async function workbenchSample({ browser, workspace, profile, workbenchOrigin, permitsFixtureRequest }) {
  const { context, page } = await fixturePage(browser, 'workbench', permitsFixtureRequest);
  try {
    const getStartedMs = await timed(async () => {
      const response = await page.goto(workbenchOrigin, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.status(), 200);
      await page.locator('.sterling-welcome').first().waitFor({ state: 'visible', timeout: 40_000 });
      const trust = page.getByRole('button', { name: 'Yes, I trust the authors', exact: true });
      const prompted = await trust.waitFor({ state: 'visible', timeout: 3_500 })
        .then(() => true, error => {
          if (error.name !== 'TimeoutError') throw error;
          return false;
        });
      if (prompted) await trust.click();
    });

    const [open, edit, , idle] = profile.steps;
    const quickInput = page.locator('.quick-input-widget input:visible').first();
    const openedMs = await timed(async () => {
      for (const file of open.files) {
        await page.keyboard.press('Control+p');
        await quickInput.fill(file);
        await page.getByText(file, { exact: true }).filter({ visible: true }).last().waitFor();
        await quickInput.press('Enter');
        await page.locator('.lm-TabBar-tab.lm-mod-current').getByText(file, { exact: true }).first().waitFor();
      }
    });
    const editMs = await timed(async () => {
      const file = join(workspace, edit.file);
      const before = readFileSync(file, 'utf8');
      await page.locator('.lm-TabBar-tab').getByText(edit.file, { exact: true }).first().click();
      await page.locator('.lm-TabBar-tab.lm-mod-current').getByText(edit.file, { exact: true }).first().waitFor();
      await page.locator('.monaco-editor:visible .view-lines').first().click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(`\n${edit.text}`);
      await page.keyboard.press('Control+s');
      await eventually(() => readFileSync(file, 'utf8').trimEnd() === `${before.trimEnd()}\n${edit.text}`,
        'The synthetic edit was not saved');
    });
    const terminalMs = await timed(async () => {
      const marker = join(workspace, terminalMarker);
      assert(!existsSync(marker), 'Expected an unused synthetic terminal fixture');
      await page.locator('.lm-MenuBar-itemLabel').getByText('Terminal', { exact: true }).first().click();
      await page.locator('.lm-Menu-itemLabel').getByText('New Terminal', { exact: true }).first().click();
      const terminal = page.locator('.xterm:visible').first();
      await terminal.click();
      await page.keyboard.type(`echo ${terminalValue} > /home/sterling/workspace/${terminalMarker}`);
      await page.keyboard.press('Enter');
      await eventually(() => existsSync(marker) && readFileSync(marker, 'utf8').trim() === terminalValue,
        'The fixed synthetic terminal action did not write its marker');
    });
    const idleMs = await timed(() => delay(Math.min(idle.durationMs, 1000)));
    return { getStartedMs, stepMs: [openedMs, editMs, terminalMs, idleMs] };
  } finally {
    await context.close();
  }
}

async function passkeySample({ browser, passkeyOrigin, permitsFixtureRequest }) {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/' || request.headers.host !== 'localhost:3001') {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>Synthetic passkey fixture</title><h1>Synthetic passkey fixture</h1>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(3001, '127.0.0.1', resolve);
  });
  try {
    const { context, page } = await fixturePage(browser, 'passkey', permitsFixtureRequest);
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
          isUserVerified: true, automaticPresenceSimulation: true,
        },
      });
      const response = await page.goto(passkeyOrigin, { waitUntil: 'domcontentloaded' });
      assert.equal(response?.status(), 200);
      return await timed(async () => {
        const verified = await page.evaluate(async () => {
          const credential = await navigator.credentials.create({ publicKey: {
            challenge: new Uint8Array(32).fill(7), rp: { id: 'localhost', name: 'Synthetic Workbench fixture' },
            user: { id: new Uint8Array([1, 2, 3]), name: 'fixture', displayName: 'Fixture' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { userVerification: 'required' }, timeout: 8000,
          } });
          if (!credential) return false;
          const assertion = await navigator.credentials.get({ publicKey: {
            challenge: new Uint8Array(32).fill(8), rpId: 'localhost',
            allowCredentials: [{ type: 'public-key', id: credential.rawId }], userVerification: 'required', timeout: 8000,
          } });
          return assertion?.id === credential.id;
        });
        assert.equal(verified, true);
      });
    } finally {
      await context.close();
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export async function runJourney({ chromium, executablePath, verifyBrowser, ...fixture }) {
  const server = await chromium.launchServer({
    executablePath, headless: true, host: '127.0.0.1', port: 0, timeout: 10_000,
    args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
  });
  const deadline = setTimeout(() => { void server.close().catch(() => {}); }, 75_000).unref();
  try {
    verifyBrowser(server.process().pid);
    const endpoint = new URL(server.wsEndpoint());
    assert(endpoint.protocol === 'ws:' && endpoint.hostname === '127.0.0.1' && !endpoint.username && !endpoint.password,
      'Expected a local Chromium control socket');
    const browser = await chromium.connect(endpoint.href, { timeout: 5_000 });
    try {
      const workbench = await workbenchSample({ ...fixture, browser });
      const signInMs = await passkeySample({ ...fixture, browser });
      return { ...workbench, signInMs };
    } finally {
      await browser.close();
    }
  } finally {
    clearTimeout(deadline);
    await server.close();
  }
}
