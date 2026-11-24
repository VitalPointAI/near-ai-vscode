// The browser half of the D-34 evidence: the workbench built on UBI 9 with Node 26 serves Get Started to a real browser.
import { expect, test } from '@playwright/test';

test('Get Started opens with its Sterling heading', async ({ page }) => {
  await page.goto('/');
  // The Get Started tab in the main area, and the page's own heading.
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('#sterling-title')).toBeVisible();
  await expect(page.locator('#sterling-title')).toHaveText(/Sterling\s*Sovereign AI/);
});
