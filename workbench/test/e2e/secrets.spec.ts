// A VS Code extension's SecretStorage in a real browser against the built image (46-08; D-04, D-17, D-18, D-28, D-36). The fixture
// extension test/fixtures/secret-probe is mounted at /plugins; the container suite (test/container/hosted-e2e.test.ts) runs this with
// SPEC_STEP:
//   save         hosted: "Secret probe: Save" shows "Saved"
//   read         hosted, in a new container: "Secret probe: Read" shows the saved value
//   unavailable  local mode in the image: the guide explains limited mode and the secret probe still cannot save
import { expect, test, type Page } from '@playwright/test';
import { openHostedWorkbench } from './hosted-startup';

const STEP = process.env.SPEC_STEP ?? '';
const PROBE_VALUE = process.env.PROBE_VALUE ?? '';

test.use({
  extraHTTPHeaders: process.env.WORKBENCH_TOKEN
    ? {
      'X-Forwarded-Access-Token': process.env.WORKBENCH_TOKEN,
      'X-Auth-Request-Email': process.env.WORKBENCH_EMAIL ?? '',
      'X-Auth-Request-User': process.env.WORKBENCH_USER ?? '',
    }
    : {},
});

async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill(`>${label}`);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().click({ timeout: 60_000 });
}

// Regular expressions, because a string hasText matches case-insensitively and "Saved" would match "Not saved".
const notification = (page: Page, text: RegExp) => page.locator('.theia-notification-list-item', { hasText: text }).first();

test('the secret probe for this step', async ({ page }) => {
  await openHostedWorkbench(page);
  if (STEP === 'save') {
    await runCommand(page, 'Secret probe: Save');
    await expect(notification(page, /\bSaved\b/)).toBeVisible({ timeout: 60_000 });
    await expect(notification(page, /Not saved/)).toHaveCount(0);
    return;
  }
  if (STEP === 'read') {
    await runCommand(page, 'Secret probe: Read');
    await expect(notification(page, new RegExp(`Read: ${PROBE_VALUE}`))).toBeVisible({ timeout: 60_000 });
    return;
  }
  if (STEP === 'unavailable') {
    const statusEntry = page.getByRole('button', { name: 'Secrets are unavailable' });
    const guide = page.getByRole('region', { name: 'Set up secret storage' });
    const heading = guide.getByRole('heading', { name: 'Set up secret storage' });
    const continueButton = guide.getByRole('button', { name: 'Continue without secret storage' });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    await expect(statusEntry).toBeVisible();
    await expect(guide.getByRole('status')).toHaveText('This Workbench has no usable secret store.');
    await expect(guide).toContainText('system keyring module or its native binding');
    await expect(guide).toContainText('approved authenticated OpenBao integration');
    await expect(guide).toContainText('restart the Workbench backend and reopen this browser tab');
    await expect(guide).toContainText('Profiles that depend on saved API keys or provider credentials cannot save or retrieve them.');
    await expect(guide).toContainText('verify and display the active signed Standing Orders or sign and apply a change');
    await expect(guide).toContainText('Shared staff projects cannot open in this local mode.');
    await expect(guide).toContainText('Documentation and trusted local Resource Inventory remain available');

    await continueButton.focus();
    await page.keyboard.press('Enter');
    await expect(guide).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Set up Sterling' })).toBeVisible();
    await expect(statusEntry).toHaveAttribute('tabindex', '0');
    await statusEntry.focus();
    await page.keyboard.press('Enter');
    await expect(heading).toBeFocused();
    await expect(guide).toHaveCount(1);
    const checkAgain = guide.getByRole('button', { name: 'Check again' });
    await checkAgain.focus();
    await page.keyboard.press('Enter');
    await expect(checkAgain).toHaveAttribute('aria-disabled', 'false');
    await expect(checkAgain).toBeFocused();
    await expect(guide.getByRole('status')).toHaveText('This Workbench has no usable secret store.');

    await continueButton.focus();
    await page.keyboard.press('Space');
    await expect(guide).toHaveCount(0);
    await expect(statusEntry).toBeFocused();

    await page.keyboard.press('F1');
    const input = page.locator('.quick-input-widget input');
    await expect(input).toBeVisible();
    await input.fill('>SovAI: Secret storage setup');
    await expect(page.locator('.quick-input-list .monaco-list-row', { hasText: 'Secret storage setup' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(heading).toBeFocused();
    await expect(guide).toHaveCount(1);
    const openGuide = await guide.elementHandle();
    await statusEntry.press('Enter');
    await expect(heading).toBeFocused();
    expect(await openGuide?.evaluate(node => node.isConnected)).toBe(true);
    await expect(guide).toHaveCount(1);
    const documentation = guide.getByRole('button', { name: 'Open Documentation' });
    await documentation.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lm-TabBar-tab', { hasText: 'Documentation' }).first()).toBeVisible();
    await continueButton.focus();
    await page.keyboard.press('Enter');
    await expect(guide).toHaveCount(0);

    await runCommand(page, 'Secret probe: Save');
    await expect(notification(page, /Not saved: .*has no secret store/)).toBeVisible({ timeout: 60_000 });
    await expect(notification(page, /\bSaved\b/)).toHaveCount(0);
    return;
  }
  throw new Error(`unknown SPEC_STEP ${JSON.stringify(STEP)}`);
});
