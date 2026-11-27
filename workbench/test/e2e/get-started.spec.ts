// The Get Started page and the right-hand rail as the owner reviewed them in the Defence preview: every rail shortcut is there, the native
// ones open their page, each work-area card opens that work area's own page, and on the release image the Team Studio and Chat shortcuts
// show the bundled extension's pages in their webviews and a work-area page's Create button creates a work area and opens its page. Run
// by test/container/get-started.test.ts against the image, opened at 127.0.0.1 as the owner opens it.
import { expect, test, type Locator, type Page } from '@playwright/test';

const railLabels = ['Get Started', 'Portfolio', 'Chat', 'Team Studio', 'Agent Activity', 'Governance', 'Data Management', 'Model Factory',
  'Compliance', 'Documentation'];
const plannedLabels = ['Data Management', 'Model Factory'];
const nativeShortcuts = [['Portfolio', 'Portfolio Room'], ['Compliance', 'Compliance'], ['Documentation', 'Documentation'], ['Get Started', 'Get Started']];
const cards = [['Capability Development', 'capability-development'], ['Exercises & Training', 'training'], ['Planning', 'operations'],
  ['Resource Management', 'resources']];

async function openGetStarted(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 90_000 });
  // Theia asks whether to trust the workspace and makes the page inert until answered; answer it as a person would (restricted mode).
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
}

const currentTab = (page: Page) => page.locator('#theia-main-content-panel .lm-TabBar-tab.lm-mod-current .lm-TabBar-tabLabel');
const rail = (page: Page) => page.getByRole('navigation', { name: 'Sterling shortcuts' });

test('About SovAI opens from Manage and the palette with the running extension version', async ({ page }) => {
  await openGetStarted(page);
  const bundled = process.env.STERLING_BUNDLED_EXTENSION === '1';
  const expectedVersion = process.env.STERLING_BUNDLED_VERSION;
  if (bundled) expect(expectedVersion).toBeTruthy();
  const versionText = bundled ? `Version ${expectedVersion}` : 'Version unavailable';

  const palette = page.locator('.quick-input-widget input');
  const commandResults = page.locator('.quick-input-list .monaco-list-row');
  const openPalette = async (): Promise<void> => {
    await page.keyboard.press('F1');
    await expect(palette).toBeVisible();
  };
  if (bundled) {
    // Listing a manifest contribution establishes hosted registration without executing it.
    await openPalette();
    await palette.fill('>SovAI: Show Status');
    await expect(commandResults.filter({ hasText: 'Show Status' })).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }

  const start = rail(page).getByRole('button', { name: 'Get Started', exact: true });
  const manage = page.locator('.theia-sidebar-menu-item').filter({ has: page.locator('.codicon-settings-gear') });
  const dialog = page.getByRole('dialog', { name: 'About SovAI', exact: true });
  const close = dialog.getByRole('button', { name: 'Close', exact: true });

  await start.focus();
  await manage.click();
  await page.getByRole('menuitem', { name: 'About SovAI', exact: true }).click();
  await expect(dialog.getByText(versionText, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(start).toBeFocused();

  await openPalette();
  await palette.fill('>About SovAI');
  await commandResults.filter({ hasText: 'About SovAI' }).click();
  await expect(dialog.getByText(versionText, { exact: true })).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(start).toBeFocused();
});

test('the rail carries every shortcut, the planned ones disabled, and the native ones open their page', async ({ page }) => {
  await openGetStarted(page);
  const buttons = rail(page).getByRole('button');
  await expect(buttons).toHaveCount(railLabels.length);
  for (const [index, label] of railLabels.entries()) {
    const planned = plannedLabels.includes(label);
    await expect(buttons.nth(index)).toHaveAttribute('aria-label', planned ? `${label} (planned)` : label);
    if (planned) await expect(buttons.nth(index)).toHaveAttribute('aria-disabled', 'true');
    else await expect(buttons.nth(index)).not.toHaveAttribute('aria-disabled', /.*/);
  }
  for (const [label, title] of nativeShortcuts) {
    await rail(page).getByRole('button', { name: label, exact: true }).click();
    await expect(currentTab(page)).toHaveText(title);
  }
  if (process.env.STERLING_BUNDLED_EXTENSION === '0') {
    const shortcuts = rail(page);
    const chat = shortcuts.getByRole('button', { name: 'Chat', exact: true });
    const chatMessage = 'Could not open Chat. Wait a moment and try again.';
    const toasts = page.locator('.theia-notification-toasts .theia-notification-list-item');
    await chat.press('Enter');
    await expect(toasts.filter({ hasText: chatMessage })).toBeVisible();
    await expect(shortcuts.getByRole('status')).toHaveText(chatMessage);
    await expect(chat).toBeFocused();
    await expect(chat).toBeEnabled();

    await shortcuts.getByRole('button', { name: 'Team Studio', exact: true }).click();
    await expect(toasts.filter({
      hasText: 'Could not open Team Studio. Wait a moment and try again.'
    })).toBeVisible();
  }
});

test('Get Started shows the setup actions, and each work-area card opens its own page', async ({ page }) => {
  await openGetStarted(page);
  const welcome = page.locator('.sterling-welcome');
  await expect(welcome.getByRole('button', { name: 'Set up Sterling' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Open Chat' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Explore a sample agent team' })).toBeVisible();
  await expect(welcome.getByRole('heading', { name: 'Defence work areas' })).toBeVisible();
  await expect(welcome.locator('.sterling-destination')).toHaveCount(cards.length);
  for (const [card, kind] of cards) {
    await rail(page).getByRole('button', { name: 'Get Started', exact: true }).click();
    await expect(currentTab(page)).toHaveText('Get Started');
    await welcome.locator('.sterling-destination', { hasText: card }).click();
    await expect(currentTab(page)).toHaveText(card);
    await expect(page.locator(`#sterling-area-${kind} h1`)).toHaveText(card);
  }
});

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** The URL the webview's outer frame actually shows: about:blank#blocked when the browser refused its address. */
async function frameUrl(iframe: Locator): Promise<string> {
  const handle = await iframe.elementHandle({ timeout: 1_000 }).catch(() => null);
  return (await handle?.contentFrame())?.url() ?? '';
}

/** A webview's outer frame has loaded Theia's webview page from a webview origin, and its content frame shows `content`. */
async function expectWebviewPage(iframe: Locator, origin: RegExp, pageOrigin: string, content: (frame: Locator) => Locator): Promise<void> {
  await expect.poll(() => frameUrl(iframe), { message: 'the webview frame loaded Theia\'s webview page', timeout: 60_000 })
    .toMatch(/^https?:\/\/[^/]+\/webview\/index\.html\?/);
  const loaded = new URL(await frameUrl(iframe));
  expect(loaded.origin, 'the webview is served from a webview origin of the page').toMatch(origin);
  expect(loaded.origin, 'the webview origin is not the page\'s own origin').not.toBe(pageOrigin);
  await expect(content(iframe.contentFrame().locator('#active-frame'))).toBeVisible({ timeout: 60_000 });
}

// The extension's pages (Chat, Team Studio, Agent Activity, Governance) are webviews, each served by Theia from its own origin,
// `<uuid>.webview.<page host>`. At 127.0.0.1 that name is no valid host (its last label is a number), so the browser refused the frame and
// the page stayed blank (the 0.4.39 candidate); for a page at 127.0.0.1 or [::1] the workbench uses `<uuid>.webview.localhost` on the
// same port, which browsers serve from loopback.
test('on the release image, the Team Studio and Chat shortcuts show their pages in their own webview origins', async ({ page, baseURL }) => {
  test.skip(process.env.STERLING_BUNDLED_EXTENSION !== '1', 'needs the release image, which bundles the NEAR AI extension');
  let pluginsStarted = false;
  page.on('console', (message) => {
    if (/\] Start of \d+ plugins?:/.test(message.text())) pluginsStarted = true;
  });
  await openGetStarted(page);
  // The shortcuts run the extension's commands, which exist once Theia has started its plugins.
  await expect.poll(() => pluginsStarted, { message: 'Theia reported starting the bundled plugin', timeout: 90_000 }).toBe(true);
  const base = new URL(baseURL ?? '');
  const parent = base.hostname === '127.0.0.1' || base.hostname === '[::1]' ? 'localhost' : base.hostname;
  const origin = new RegExp(`^${base.protocol}//${UUID}\\.webview\\.${parent.replaceAll('.', '\\.')}${base.port ? `:${base.port}` : ''}$`);

  await rail(page).getByRole('button', { name: 'Team Studio', exact: true }).click();
  await expect(currentTab(page)).toHaveText('SovAI Team Studio', { timeout: 60_000 });
  await expectWebviewPage(page.locator('#theia-main-content-panel [id^="plugin-webview:"]').filter({ visible: true }).locator('iframe'),
    origin, base.origin, (frame) => frame.contentFrame().getByRole('heading', { name: 'Team Studio', level: 1 }));

  await rail(page).getByRole('button', { name: 'Chat', exact: true }).click();
  await expectWebviewPage(page.locator('#theia-right-content-panel [id^="plugin-webview:"]').filter({ visible: true }).locator('iframe'),
    origin, base.origin, (frame) => frame.contentFrame().getByRole('textbox', { name: 'Chat message' }));
});

// The work-area pages' Create button runs sterling.workAreas.create, which only the bundled NEAR AI extension (the VSIX in the release
// image) provides. The container suite sets STERLING_BUNDLED_EXTENSION=1 for an image that bundles it, and checks the folder on disk.
test('on the release image, Create on a work-area page creates the work area and opens its page', async ({ page }) => {
  test.skip(process.env.STERLING_BUNDLED_EXTENSION !== '1', 'needs the release image, which bundles the NEAR AI extension');
  const title = process.env.STERLING_WORK_AREA_TITLE ?? 'Winter exercise';
  await openGetStarted(page);
  await page.locator('.sterling-welcome .sterling-destination', { hasText: 'Exercises & Training' }).click();
  const landing = page.locator('#sterling-area-training');
  await expect(landing.locator('h1')).toHaveText('Exercises & Training');
  await landing.getByRole('button', { name: 'Create training work area' }).click();
  // The extension's naming dialog, then its confirmation of the location (the only folder open is the workspace, so none is asked for).
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.quick-input-widget')).toContainText('Exercise or training title');
  await input.fill(title);
  await input.press('Enter');
  const dialog = page.locator('.dialogOverlay');
  await expect(dialog).toContainText(`Create “${title}”?`);
  await expect(dialog).toContainText('/home/sterling/workspace/work-area-');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  // The page reopens on the new work area: Theia asks about trust again, and the workbench lands on that work area's own page.
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 60_000 }).then(() => decline.click(), () => undefined);
  await expect(currentTab(page)).toHaveText('Exercises & Training', { timeout: 90_000 });
  const opened = page.locator('#sterling-area-training');
  await expect(opened.locator('h1')).toHaveText('Exercises & Training');
  await expect(opened.locator('.sterling-area-record', { hasText: title })).toContainText('Open work area');
  await rail(page).getByRole('button', { name: 'Get Started', exact: true }).click();
  await expect(page.locator('.sterling-welcome .sterling-active-area')).toHaveText(`Open work area: ${title}`);
});
