// The browser side of the no-egress proof (46-03; D-26, D-28): from the first navigation, every request the page, its frames and its service
// workers make, and every WebSocket it opens, while Get Started and the Team preview open and through a fixed window once the workbench is
// ready, is same-origin with WORKBENCH_URL, a data: URL or a blob: URL. The container suite (test/container/egress.test.ts) starts the image
// under the outbound recording hook, checks the backend side, and sets STERLING_EXPECT_PLUGINS to the number of plugins the image bundles.
//
// Ready means Get Started and the Team preview are shown and, when the image bundles plugins, Theia has reported starting them (its "Start of
// N plugin(s)" line comes after the plugin host started them and ran their onStartupFinished activations). It is not Playwright's
// networkidle: on the release image the bundled extension's webview frame attaches after the page first went quiet, which clears
// Playwright's idle state, and a page that stays quiet never sets it again (46-08), so that wait timed out before any check ran.
import { expect, test } from '@playwright/test';

/** How long the ready page is watched; every request in that window is checked with the rest. */
const OBSERVE_MS = 10_000;

test('Get Started and the Team preview make only same-origin, data: or blob: requests', async ({ page, context, baseURL }) => {
  const expectedPlugins = Number.parseInt(process.env.STERLING_EXPECT_PLUGINS ?? '', 10);
  expect(expectedPlugins, 'STERLING_EXPECT_PLUGINS is the number of plugins the image bundles (the container suite sets it)').toBeGreaterThanOrEqual(0);
  const base = new URL(baseURL ?? '');
  const socketProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const elsewhere: string[] = [];
  let sameOrigin = 0;
  // The context reports service worker requests as well, which page.on('request') never does; WebSockets are not requests at all.
  context.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin === base.origin) sameOrigin += 1;
    else elsewhere.push(url);
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.protocol !== socketProtocol || url.host !== base.host) elsewhere.push(socket.url());
  });
  let pluginsStarted = '';
  page.on('console', (message) => {
    if (/\] Start of \d+ plugins?:/.test(message.text())) pluginsStarted = message.text();
  });

  await page.goto('/');
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#sterling-title')).toBeVisible();

  // Theia asks whether to trust the new workspace and makes the page inert until answered (46-01 deviation 4).
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill('>SovAI: Open Team Studio Preview');
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Open Team Studio Preview' }).first().click();
  await expect(page.locator('.near-team-member').first()).toBeVisible({ timeout: 30_000 });
  if (expectedPlugins > 0) {
    await expect.poll(() => pluginsStarted, { message: `Theia reported starting the ${expectedPlugins} bundled plugin(s)`, timeout: 60_000 })
      .toMatch(new RegExp(`\\] Start of ${expectedPlugins} plugins?:`));
  }
  await page.waitForTimeout(OBSERVE_MS);

  expect(sameOrigin, 'the recorder saw the page\'s own requests').toBeGreaterThan(0);
  expect(elsewhere, 'requests to another origin').toEqual([]);
});
