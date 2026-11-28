// The browser half of the D-34 evidence, and the one refusal shown end to end (D-16): the workbench built on UBI 9 with Node 26 serves
// Get Started to a real browser, and the Team preview's invalid sample shows the parser's own message, unchanged across the RPC.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { waitForGetStartedTab } from './wait-for-get-started';

// The same engine bundle the image carries (scripts/build.mjs builds it before the container suite runs this spec).
const workbenchRoot = path.resolve(__dirname, '..', '..');
const engineFile = path.join(workbenchRoot, 'engine', 'teams.cjs');

function parserMessage(fixture: string): string {
  const { parseTeam } = createRequire(engineFile)(engineFile) as { parseTeam(text: string, file: string): unknown };
  try {
    parseTeam(readFileSync(path.join(workbenchRoot, 'extension', 'fixtures', fixture), 'utf8'), fixture);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`the parser accepted ${fixture}`);
}

async function openGetStarted(page: Page): Promise<void> {
  await waitForGetStartedTab(page);
}

/** Theia asks whether to trust the new workspace and makes the page inert until answered; answer it as a person would (restricted mode). */
async function declineWorkspaceTrust(page: Page): Promise<void> {
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
}

test('Get Started opens with its Sterling heading', async ({ page }) => {
  await openGetStarted(page);
  await expect(page.locator('#sterling-title')).toBeVisible();
  await expect(page.locator('#sterling-title')).toHaveText(/Sterling\s*Sovereign AI/);
});

test('the Team preview shows a sample team, and the invalid sample shows the parser\'s own message', async ({ page }) => {
  const expected = parserMessage('invalid.md');
  await openGetStarted(page);
  await declineWorkspaceTrust(page);
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill('>SovAI: Open Team Studio Preview');
  await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Open Team Studio Preview' }).first().click();

  const picker = page.locator('.near-project-select');
  await expect(picker).toBeEnabled({ timeout: 30_000 });
  await picker.selectOption({ label: 'Orchard sample' });
  await expect(page.locator('.near-team-member', { hasText: 'schedule-reviewer' })).toBeVisible();

  await picker.selectOption({ label: 'Sample with an invalid agent team' });
  await expect(page.locator('.near-team-status')).toHaveText(expected);
});
