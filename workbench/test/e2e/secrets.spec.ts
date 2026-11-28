// A VS Code extension's SecretStorage in a real browser against the built image (46-08; D-04, D-17, D-18, D-28, D-36). The fixture
// extension test/fixtures/secret-probe is mounted at /plugins; the container suite (test/container/hosted-e2e.test.ts) runs this with
// SPEC_STEP:
//   save         hosted: "Secret probe: Save" shows "Saved"
//   read         hosted, in a new container: "Secret probe: Read" shows the saved value
//   unavailable  local mode in the image: the status entry reads "Secrets are unavailable" and saving shows an error, not "Saved"
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
    await expect(page.locator('#status-bar-sterling-secret-store')).toContainText('Secrets are unavailable', { timeout: 30_000 });
    await runCommand(page, 'Secret probe: Save');
    await expect(notification(page, /Not saved/)).toBeVisible({ timeout: 60_000 });
    await expect(notification(page, /\bSaved\b/)).toHaveCount(0);
    return;
  }
  throw new Error(`unknown SPEC_STEP ${JSON.stringify(STEP)}`);
});
