// The browser side of the no-egress proof (46-03; D-26, D-28): from the first navigation, every request the page makes while Get Started and
// the Team preview open is same-origin with WORKBENCH_URL, a data: URL or a blob: URL. The container suite (test/container/egress.test.ts)
// starts the image under the outbound recording hook and checks the backend side.
import { expect, test } from '@playwright/test';

test('Get Started and the Team preview make only same-origin, data: or blob: requests', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? '').origin;
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== origin) elsewhere.push(url);
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
  await page.waitForLoadState('networkidle');

  expect(elsewhere, 'requests to another origin').toEqual([]);
});
