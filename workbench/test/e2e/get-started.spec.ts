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
  await declineWorkspaceTrust(page);
}

async function declineWorkspaceTrust(page: Page): Promise<void> {
  // Theia asks whether to trust the workspace and makes the page inert until answered; answer it as a person would (restricted mode).
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
}

const currentTab = (page: Page) => page.locator('#theia-main-content-panel .lm-TabBar-tab.lm-mod-current .lm-TabBar-tabLabel');
const rail = (page: Page) => page.getByRole('navigation', { name: 'Sterling shortcuts' });

async function openLanguageSetting(page: Page): Promise<Locator> {
  await page.keyboard.press('F1');
  const palette = page.locator('.quick-input-widget input');
  await expect(palette).toBeVisible();
  await palette.fill('>Open User Settings');
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Open User Settings' }).click();
  const search = page.getByPlaceholder('Search settings');
  await expect(search).toBeVisible();
  await search.fill('sterling.displayLanguage');
  const selection = page.locator('[data-pref-id="sterling.displayLanguage"] .theia-select-component');
  await expect(selection, 'the Canadian language enum is offered in User Settings').toBeVisible({ timeout: 10_000 });
  return selection;
}

async function pickLanguage(selection: Locator, direction: 'ArrowDown' | 'ArrowUp', name: string): Promise<void> {
  await selection.press('Enter');
  await selection.press(direction);
  await selection.press('Enter');
  await expect(selection).toContainText(name);
  await expect(selection).toBeFocused();
}

test('About SovAI opens from Manage and the palette with the running extension version', async ({ page, context }) => {
  test.setTimeout(180_000);
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
  const englishMenuItem = page.getByRole('menuitem', { name: 'About SovAI', exact: true });
  await expect(englishMenuItem).toHaveCount(1);
  await englishMenuItem.click();
  await expect(dialog.getByText(versionText, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(start).toBeFocused();

  await openPalette();
  await palette.fill('>About SovAI');
  const englishResult = commandResults.filter({ hasText: 'About SovAI' });
  await expect(englishResult).toHaveCount(1);
  await englishResult.click();
  await expect(dialog.getByText(versionText, { exact: true })).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(start).toBeFocused();

  const settings = await openLanguageSetting(page);
  const settingsPage = await context.newPage();
  try {
    await settingsPage.goto('/');
    await expect(settingsPage.locator('.sterling-welcome')).toBeVisible({ timeout: 90_000 });
    await declineWorkspaceTrust(settingsPage);
    const otherSettings = await openLanguageSetting(settingsPage);
    try {
      await pickLanguage(settings, 'ArrowDown', 'Français (Canada)');
      await expect(page.locator('.sterling-welcome')).toHaveAttribute('lang', 'fr-CA');
      const frenchTitle = 'À propos de SovAI';
      const frenchDialog = page.getByRole('dialog', { name: frenchTitle, exact: true });
      const frenchClose = frenchDialog.getByRole('button', { name: 'Fermer', exact: true });
      const frenchVersion = bundled ? versionText : 'Version indisponible';
      const frenchStart = page.getByRole('navigation', { name: 'Raccourcis Sterling' }).getByRole('button', { name: 'Premiers pas', exact: true });

      await frenchStart.focus();
      await manage.click();
      const frenchMenuItem = page.getByRole('menuitem', { name: frenchTitle, exact: true });
      await expect(frenchMenuItem).toHaveCount(1, { timeout: 5_000 });
      await frenchMenuItem.click();
      await expect(frenchDialog).toHaveAttribute('lang', 'fr-CA');
      await expect(frenchDialog.getByText(frenchVersion, { exact: true })).toBeVisible();
      await expect(frenchClose).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(frenchDialog).toBeHidden();
      await expect(frenchStart).toBeFocused();

      await openPalette();
      await palette.fill(`>${frenchTitle}`);
      const frenchResult = commandResults.filter({ hasText: frenchTitle });
      await expect(frenchResult).toHaveCount(1);
      await frenchResult.click();
      await expect(frenchClose).toBeFocused();
      const originalDialog = await frenchDialog.elementHandle();

      await expect(otherSettings).toContainText('Français (Canada)');
      await pickLanguage(otherSettings, 'ArrowUp', 'English (Canada)');
      await expect(dialog).toHaveAttribute('lang', 'en-CA');
      expect(await dialog.evaluate((node, original) => node === original, originalDialog)).toBe(true);
      await expect(dialog.getByText(versionText, { exact: true })).toBeVisible();
      await expect(close).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeHidden();
      await expect(start).toBeFocused();
    } finally {
      if ((await otherSettings.innerText()).includes('Français (Canada)')) {
        await pickLanguage(otherSettings, 'ArrowUp', 'English (Canada)');
      }
    }
  } finally {
    await settingsPage.close();
  }
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

test('Get Started switches Canadian language live through User Settings and keeps it on reopen', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  await openGetStarted(page);
  const welcome = page.locator('.sterling-welcome');
  const shellUrl = page.url();
  const original = await welcome.elementHandle();
  await welcome.getByRole('button', { name: 'Pause hero animation' }).click();

  const selection = await openLanguageSetting(page);
  await expect(selection).toContainText('English (Canada)');
  await pickLanguage(selection, 'ArrowDown', 'Français (Canada)');
  await expect(welcome).toHaveAttribute('lang', 'fr-CA');
  await expect(selection).toBeFocused();
  expect(page.url()).toBe(shellUrl);
  expect(await welcome.evaluate((node, before) => node === before, original)).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Raccourcis Sterling' }).getByRole('button', { name: 'Premiers pas' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Raccourcis Sterling' }).getByRole('button', { name: 'Premiers pas' }).click();
  await expect(currentTab(page).filter({ hasText: /^Premiers pas$/ })).toBeVisible();
  await expect(welcome.getByRole('heading', { name: 'Espaces de travail de la défense' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Configurer Sterling' })).toBeVisible();
  await expect(welcome.getByRole('button', { name: 'Reprendre l’animation' })).toBeVisible();

  const otherContext = await browser.newContext({ baseURL, viewport: { width: 670, height: 760 }, reducedMotion: 'reduce' });
  try {
    const reopened = await otherContext.newPage();
    await reopened.goto('/');
    await expect(reopened.locator('.sterling-welcome')).toHaveAttribute('lang', 'fr-CA', { timeout: 90_000 });
    await declineWorkspaceTrust(reopened);
    const reopenedWelcome = reopened.locator('.sterling-welcome');
    const expectActionsFit = async (): Promise<void> => {
      const actions = reopenedWelcome.locator('.sterling-actions');
      await expect(actions).toBeVisible();
      expect(await actions.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        return Array.from(node.querySelectorAll('button')).every((button) => {
          const control = button.getBoundingClientRect();
          return control.left >= bounds.left - 1 && control.right <= bounds.right + 1 &&
            button.scrollWidth <= button.clientWidth + 1;
        });
      })).toBe(true);
    };
    await expect(reopenedWelcome.getByRole('button', { name: 'Configurer Sterling' })).toBeVisible();
    await expectActionsFit();
    const reopenedSelection = await openLanguageSetting(reopened);
    await expect(reopenedSelection).toContainText('Français (Canada)');
    await pickLanguage(reopenedSelection, 'ArrowUp', 'English (Canada)');
    await expect(reopenedWelcome).toHaveAttribute('lang', 'en-CA');
    await expect(reopenedSelection).toBeFocused();
    await rail(reopened).getByRole('button', { name: 'Get Started', exact: true }).click();
    await expect(currentTab(reopened).filter({ hasText: /^Get Started$/ })).toBeVisible();
    await expect(reopenedWelcome.getByRole('button', { name: 'Set up Sterling' })).toBeVisible();
    await expectActionsFit();
  } finally {
    await otherContext.close();
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

test('Team Studio staff setup previews the selected project in the User language', async ({ page, browser, baseURL }) => {
  test.skip(process.env.STERLING_BUNDLED_EXTENSION !== '1', 'needs the bundled extension');
  test.setTimeout(180_000);
  await openGetStarted(page);
  const selection = await openLanguageSetting(page);
  await expect(selection).toContainText('English (Canada)');
  await pickLanguage(selection, 'ArrowDown', 'Français (Canada)');
  await expect(page.locator('.sterling-welcome')).toHaveAttribute('lang', 'fr-CA');
  await page.close();

  const reopenedContext = await browser.newContext({ baseURL });
  try {
    const workbench = await reopenedContext.newPage();
    let pluginsStarted = false;
    workbench.on('console', (message) => {
      if (/\] Start of \d+ plugins?:/.test(message.text())) pluginsStarted = true;
    });
    await workbench.goto('/');
    await expect(workbench.getByRole('menubar')).toBeVisible({ timeout: 90_000 });
    // The hosted plug-in waits for the workspace trust choice before it reports startup.
    await declineWorkspaceTrust(workbench);
    await expect.poll(() => pluginsStarted, { timeout: 90_000 }).toBe(true);
    await workbench.keyboard.press('F1');
    const palette = workbench.locator('.quick-input-widget input');
    await expect(palette).toBeVisible();
    await palette.fill('>SovAI: Team Studio');
    await workbench.getByRole('option', { name: 'SovAI: Team Studio', exact: true }).click({ timeout: 60_000 });
    const studioTab = workbench.locator('#theia-main-content-panel .lm-TabBar-tab').filter({ hasText: 'SovAI Team Studio' });
    await expect(currentTab(workbench)).toHaveText('SovAI Team Studio', { timeout: 60_000 });
    const frame = workbench.locator('#theia-main-content-panel [id^="plugin-webview:"]').filter({ visible: true })
      .locator('iframe').contentFrame().locator('#active-frame').contentFrame();
    const frenchEntry = frame.getByRole('button', { name: 'Configurer l’état-major', exact: true });
    const frenchHeading = frame.getByRole('heading', { name: 'Aperçu de la configuration de l’état-major', exact: true });
    const project = process.env.STERLING_STAFF_PROJECT_NAME ?? 'workspace';
    await frenchEntry.click({ timeout: 60_000 });
    await expect(frenchHeading).toBeFocused();
    await expect(frame.getByRole('heading', { name: project, exact: true })).toBeVisible();

    await expect(frame.getByRole('heading', { name: 'Logistique', exact: true })).toBeVisible();
    await expect(frame.getByRole('heading', { name: /[JGS]-?4 Logistique/ })).toHaveCount(0);
    await expect(frame.getByRole('button', { name: 'Ouvrir la configuration existante' })).toBeVisible();
    await workbench.setViewportSize({ width: 510, height: 900 });
    const frenchProfile = frame.getByRole('button', { name: 'OTAN (termes canadiens)', exact: true });
    await frenchProfile.press('Enter');
    await expect(frenchProfile).toHaveAttribute('aria-pressed', 'true');
    const levelGroup = frame.getByRole('group', { name: 'Niveau organisationnel' });
    await expect(levelGroup.getByRole('button')).toHaveCount(5);
    for (const level of await levelGroup.getByRole('button').all()) await expect(level).toBeEnabled();
    const frenchBrigade = levelGroup.getByRole('button', { name: 'L3 Brigade', exact: true });
    await frenchBrigade.press('Enter');
    await expect(frenchBrigade).toBeFocused();
    await expect(frenchBrigade).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.getByRole('heading', { name: 'G4 Logistique', exact: true })).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Ouvrir la configuration existante' })).toHaveCount(0);
    const coverage = frame.getByRole('region', { name: 'Aperçu de la configuration de l’état-major' });
    expect(await coverage.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);

    await workbench.setViewportSize({ width: 1280, height: 900 });
    const liveSelection = await openLanguageSetting(workbench);
    await expect(liveSelection).toContainText('Français (Canada)');
    await pickLanguage(liveSelection, 'ArrowUp', 'English (Canada)');
    await studioTab.click();
    const englishHeading = frame.getByRole('heading', { name: 'Staff setup preview', exact: true });
    await expect(englishHeading).toBeVisible();
    await expect(frame.getByRole('button', { name: 'L3 Brigade', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(frame.getByRole('heading', { name: 'G4 Logistics', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'US Joint', exact: true }).click();
    const joint = frame.getByRole('button', { name: 'L1 Joint headquarters', exact: true });
    const strategic = frame.getByRole('button', { name: 'L0 Strategic joint headquarters', exact: true });
    await joint.click();
    await expect(joint).toHaveAttribute('aria-pressed', 'true');
    await expect(strategic).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.getByRole('heading', { name: 'J-4 Logistics', exact: true })).toBeVisible();
    await strategic.click();
    await expect(strategic).toHaveAttribute('aria-pressed', 'true');
    await expect(joint).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.getByRole('heading', { name: 'J-4 Logistics', exact: true })).toBeVisible();
    await joint.click();
    await expect(joint).toHaveAttribute('aria-pressed', 'true');
    await expect(strategic).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.getByText('No designation verified for this doctrine and level.', { exact: true }).first()).toBeVisible();
    await expect(frame.getByRole('button', { name: /Continue to section setup/ })).toHaveCount(0);
    await frame.getByRole('button', { name: 'Back to doctrine choices', exact: true }).click();
    const doctrine = frame.getByRole('button', { name: 'US Joint', exact: true });
    await expect(doctrine).toBeFocused();
    await expect(doctrine).toHaveAttribute('aria-pressed', 'false');
    await expect(frame.getByRole('button', { name: 'L1 Joint headquarters', exact: true })).toHaveCount(0);
    await doctrine.press('Escape');
    const englishEntry = frame.getByRole('button', { name: 'Set up staff', exact: true });
    await expect(englishEntry).toBeFocused();
    await englishEntry.click();
    await expect(frame.getByRole('heading', { name: 'Logistics', exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Open existing staff setup', exact: true }).click();
    await frame.getByRole('button', { name: 'J4 Logistics', exact: true }).click();
    await frame.getByRole('button', { name: 'Continue to section setup', exact: true }).click();
    const questions = workbench.locator('.quick-input-widget').filter({ visible: true });
    await expect(questions.getByText('US Joint', { exact: true })).toBeVisible();
    await workbench.keyboard.press('Escape');
    await expect(questions).toBeHidden();
  } finally {
    await reopenedContext.close();
  }
});

// The work-area pages' Create button runs sterling.workAreas.create, which only the bundled NEAR AI extension (the VSIX in the release
// image) provides. The container suite sets STERLING_BUNDLED_EXTENSION=1 for an image that bundles it, and checks the folder on disk.
test('on the release image, Create on a work-area page creates the work area and opens its page', async ({ page }) => {
  test.skip(process.env.STERLING_BUNDLED_EXTENSION !== '1', 'needs the release image, which bundles the NEAR AI extension');
  const title = process.env.STERLING_WORK_AREA_TITLE ?? 'Winter exercise';
  await openGetStarted(page);
  const welcome = page.locator('.sterling-welcome');
  await expect(welcome, 'the release profile is in English before creating the training work area').toHaveAttribute('lang', 'en-CA');
  await welcome.locator('.sterling-destination', { hasText: 'Exercises & Training' }).click();
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
