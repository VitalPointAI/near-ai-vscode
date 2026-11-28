import { expect, type Page } from '@playwright/test';

/**
 * Open the workbench root and wait for the Get Started tab.
 * Under CI load, Theia's initial browser connection can occasionally stall on
 * the preloader. Waiting 30 s and reloading once before the remaining 60 s
 * budget recovers from cold-start hiccups while keeping genuine startup
 * regressions failing within the same 90 s total timeout.
 */
export async function waitForGetStartedTab(page: Page, initialTimeoutMs = 30_000, retryTimeoutMs = 60_000): Promise<void> {
  const tab = page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first();
  await page.goto('/');
  const ready = await tab.waitFor({ state: 'visible', timeout: initialTimeoutMs }).then(() => true, () => false);
  if (!ready) {
    await page.reload();
    await expect(tab).toBeVisible({ timeout: retryTimeoutMs });
  }
}
