// The browser side of the no-egress proof (46-03; D-26, D-28): from the first navigation, every request the page, its frames and its service
// workers make, and every WebSocket it opens, while Get Started, the Team preview and (on the release image) the bundled NEAR AI chat open,
// and through a fixed window once the workbench is ready, goes to the page's own origin, one of its webview origins, a data: URL or a blob:
// URL. A webview origin is Theia's default endpoint for the page's host, `<uuid>.webview.<host>` on the same scheme and port, where a page
// at 127.0.0.1 or [::1] uses localhost as its host (no subdomain of an address is a valid name; extension/src/common/webview-origin.ts);
// nothing wider. The container suite (test/container/egress.test.ts) opens the page at 127.0.0.1 and at localhost (Chromium serves every
// *.localhost name from loopback). It starts the image under the outbound recording hook, with no model servers configured, checks the
// backend side, and sets STERLING_EXPECT_PLUGINS to the number of plugins the image bundles.
//
// Ready means Get Started and the Team preview are shown and, when the image bundles plugins (the release image bundles only the NEAR AI
// extension), Theia has reported starting them (its "Start of N plugin(s)" line comes after the plugin host started them and ran their
// onStartupFinished activations) and the NEAR AI chat's own message box is shown inside its webview. It is not Playwright's networkidle: on
// the release image the chat's webview frame attaches after the page first went quiet, which clears Playwright's idle state, and a page that
// stays quiet never sets it again (46-08), so that wait timed out before any check ran.
import { expect, test } from '@playwright/test';
import { waitForGetStartedTab } from './wait-for-get-started';

/** How long the ready page is watched; every request in that window is checked with the rest. */
const OBSERVE_MS = 10_000;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

test('Get Started, the Team preview and the bundled NEAR AI chat request only the page\'s own origin and its webview origins', async ({ page, context, baseURL }) => {
  const expectedPlugins = Number.parseInt(process.env.STERLING_EXPECT_PLUGINS ?? '', 10);
  expect(expectedPlugins, 'STERLING_EXPECT_PLUGINS is the number of plugins the image bundles (the container suite sets it)').toBeGreaterThanOrEqual(0);
  const base = new URL(baseURL ?? '');
  const parent = base.hostname === '127.0.0.1' || base.hostname === '[::1]' ? 'localhost' : base.hostname;
  const webviewHost = new RegExp(`^${UUID}\\.webview\\.${parent.replaceAll('.', '\\.')}$`);
  const socketProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const elsewhere: string[] = [];
  const seen = { page: 0, webview: 0 };
  // The context reports service worker requests as well, which page.on('request') never does; WebSockets are not requests at all.
  context.on('request', (request) => {
    const raw = request.url();
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return;
    const url = new URL(raw);
    if (url.origin === base.origin) seen.page += 1;
    else if (url.protocol === base.protocol && url.port === base.port && webviewHost.test(url.hostname)) seen.webview += 1;
    else elsewhere.push(raw);
  });
  page.on('websocket', (socket) => {
    const url = new URL(socket.url());
    if (url.protocol !== socketProtocol || url.host !== base.host) elsewhere.push(socket.url());
  });
  let pluginsStarted = '';
  page.on('console', (message) => {
    if (/\] Start of \d+ plugins?:/.test(message.text())) pluginsStarted = message.text();
  });

  await waitForGetStartedTab(page);
  await expect(page.locator('#sterling-title')).toBeVisible();

  // Theia asks whether to trust the new workspace and makes the page inert until answered (46-01 deviation 4).
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
  const palette = page.locator('.quick-input-widget input');
  const runCommand = async (title: string): Promise<void> => {
    await page.keyboard.press('F1');
    await expect(palette).toBeVisible();
    await palette.fill(`>${title}`);
    await page.locator('.quick-input-list .monaco-list-row', { hasText: title }).first().click();
  };
  await runCommand('SovAI: Open Team Studio Preview');
  await expect(page.locator('.near-team-member').first()).toBeVisible({ timeout: 30_000 });
  if (expectedPlugins > 0) {
    await expect.poll(() => pluginsStarted, { message: `Theia reported starting the ${expectedPlugins} bundled plugin(s)`, timeout: 60_000 })
      .toMatch(new RegExp(`\\] Start of ${expectedPlugins} plugins?:`));
    // The chat is the part of the extension that talks to model servers: open it as a person would and wait for its own content.
    await runCommand('SovAI: Open Chat');
    const chat = page.frameLocator('[id^="plugin-webview:"] iframe').frameLocator('#active-frame');
    await expect(chat.getByRole('textbox', { name: 'Chat message' })).toBeVisible({ timeout: 60_000 });
  }
  await page.waitForTimeout(OBSERVE_MS);

  expect(seen.page, 'the recorder saw the page\'s own requests').toBeGreaterThan(0);
  if (expectedPlugins > 0) expect(seen.webview, 'the recorder saw the chat webview\'s requests').toBeGreaterThan(0);
  expect(elsewhere, 'requests outside the page\'s origin and its webview origins').toEqual([]);
});
