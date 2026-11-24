// The Get Started page and the right-hand rail as the owner reviewed them in the Defence preview: every rail shortcut is there, the native
// ones open their page, and each work-area card opens that work area's own page. Run by test/container/get-started.test.ts against the image.
import { expect, test, type Page } from '@playwright/test';

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
