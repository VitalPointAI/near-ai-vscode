import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function command(page: Page, name: string): Promise<void> {
  await page.keyboard.press('F1');
  const palette = page.locator('.quick-input-widget input');
  await expect(palette).toBeVisible();
  await palette.fill(`>${name}`);
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).click();
}

test('Resource Inventory shows a local infrastructure report', async ({ browser, baseURL }) => {
  const fixture = process.env.STERLING_INVENTORY_FIXTURE;
  test.skip(!fixture, 'needs the disposable two-root inventory fixture');
  if (!fixture) return;
  test.setTimeout(180_000);

  const restrictedContext = await browser.newContext({ baseURL });
  try {
    const page = await restrictedContext.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: "No, I don't trust the authors" }).click({ timeout: 60_000 });
    await command(page, 'Resource Inventory');
    const inventory = page.locator('.sterling-resource-inventory');
    await expect(inventory.getByText('Trust this workspace to view its inventory.')).toBeVisible();
    await expect(inventory.getByText('Fictional standalone worker', { exact: true })).toHaveCount(0);
  } finally {
    await restrictedContext.close();
  }

  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Yes, I trust the authors' }).click({ timeout: 60_000 });
    await command(page, 'Resource Inventory');
    const inventory = page.locator('.sterling-resource-inventory');
    const folders = inventory.getByLabel('Inventory folder');
    const standalone = inventory.getByRole('button', { name: /Fictional standalone worker/ });
    const cluster = inventory.getByRole('button', { name: /Fictional cluster pool/ });
    await folders.selectOption({ label: 'infrastructure' });
    await expect(inventory.getByText('Local infrastructure planning report. Availability and permissions have not been verified.')).toBeVisible();
    await standalone.click();
    await expect(inventory.getByText('0 devices', { exact: true })).toBeVisible();
    await expect(inventory.getByText('AMD accelerator', { exact: true })).toBeVisible();
    await inventory.getByLabel('Category').selectOption('cluster-compute');
    await expect(standalone).toHaveCount(0);
    await cluster.click();
    await expect(inventory.getByText('Unknown', { exact: true })).toBeVisible();
    await expect(inventory.getByText('NVIDIA accelerator', { exact: true })).toBeVisible();
    const search = inventory.getByRole('searchbox', { name: 'Search resources' });
    await search.fill('AMD');
    await expect(cluster).toHaveCount(0);
    await search.clear();
    await expect(cluster).toBeVisible();
    await expect(inventory.getByRole('button', { name: /Copy reference|Edit entry|Add catalogue entry|Archive entry|Link resource/ })).toHaveCount(0);
    await expect(inventory.getByLabel('Resource reference')).toHaveCount(0);

    await folders.selectOption({ label: 'stock' });
    await expect(inventory.getByRole('button', { name: /Fictional stock kit/ })).toBeVisible();
    await expect(inventory.getByRole('button', { name: 'Copy reference' })).toBeVisible();
    await expect(cluster).toHaveCount(0);

    await folders.selectOption({ label: 'infrastructure' });
    await expect(cluster).toBeVisible();
    const original = await readFile(fixture);
    try {
      await writeFile(fixture, '{}\n');
      await inventory.getByRole('button', { name: 'Refresh' }).click();
      await expect(inventory.getByText('The file does not contain a valid resource inventory snapshot.')).toBeVisible();
      await expect(cluster).toHaveCount(0);
    } finally {
      await writeFile(fixture, original);
    }
    await inventory.getByRole('button', { name: 'Refresh' }).click();
    await expect(cluster).toBeVisible();

    await command(page, 'Get Started');
    await page.locator('.sterling-welcome').getByRole('button', { name: /Resource Management/ }).click();
    await page.getByRole('button', { name: 'Link a resource to Fictional infrastructure work area' }).click();
    await expect(inventory.getByText('Infrastructure planning reports cannot be linked.')).toBeVisible();
    await expect(standalone).toHaveCount(0);
    await expect(cluster).toHaveCount(0);
    await expect(inventory.getByRole('button', { name: /Copy reference|Link resource/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});
