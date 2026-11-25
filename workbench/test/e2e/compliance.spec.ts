// The Compliance view in a real browser against the built image (48.2-16; D-05, D-17, D-18, D-22, D-25, D-26): the one focused browser
// check of its honesty rules. Each test is one case; test/container/compliance.test.ts starts a container with that case's mounts, makes
// the signed fixture folders with the pinned cosign and throwaway keys, and runs the case by name. The words checked are the approved
// UI-SPEC's (48.2-UI-SPEC.md, Copywriting Contract). Screenshots for the owner go to COMPLIANCE_SHOTS when it is set.
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// A tall window: Theia fits its layout to the window, so the whole view is in one screenshot.
test.use({ viewport: { width: 1440, height: 2000 } });

const RELEASE_ONLY_LINE = 'This is the release’s own evidence. Nothing here shows how your site runs it.';
const SITE_NONE_SINGLE = 'This computer is not part of a site, so there is no site evidence. The release evidence is shown alone.';
const FRESHNESS = /\b(Current|Ageing|Out of date|Unknown)\b/;

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.COMPLIANCE_SHOTS;
  if (dir) await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

/** Opens the workbench, answers the trust question in Restricted Mode, and opens the Compliance view from the rail. */
async function openCompliance(page: Page): Promise<Locator> {
  await page.goto('/');
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 90_000 });
  // Theia asks whether to trust the workspace; the person declines, so the session runs in Restricted Mode (D-05).
  await page.getByRole('button', { name: 'No, I don\'t trust the authors' }).click({ timeout: 60_000 });
  await page.getByRole('navigation', { name: 'Sterling shortcuts' }).getByRole('button', { name: 'Compliance', exact: true }).click();
  const view = page.locator('.sterling-compliance');
  await expect(view.locator('h1')).toHaveText('Compliance');
  await expect(view.locator('.sterling-evidence-live')).toContainText('Live', { timeout: 30_000 });
  return view;
}

const card = (view: Locator, layer: 'release' | 'site' | 'projection') => view.locator(`.sterling-evidence-source[data-layer="${layer}"]`);
const badge = (source: Locator) => source.locator('.sterling-evidence-verification');
const rows = (view: Locator) => view.locator('.sterling-evidence-controls > li > button');

/** Every row shows its four facts: a source, an as-of time, a freshness word and its verification. */
async function expectFacts(view: Locator, verification: 'Verified' | 'Not verified'): Promise<void> {
  const count = await rows(view).count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const facts = rows(view).nth(index).locator('.sterling-evidence-facts');
    await expect(facts.locator('.sterling-evidence-source')).not.toBeEmpty();
    await expect(facts.locator('.sterling-evidence-asof')).toContainText(/^as of \d{1,2} [A-Za-z]{3,4} \d{4} \d{2}:\d{2}/);
    await expect(facts.locator('.sterling-evidence-freshness')).toHaveText(FRESHNESS);
    await expect(facts.locator('.sterling-evidence-verification')).toHaveText(verification);
  }
}

test('Restricted, release only', async ({ page }) => {
  const view = await openCompliance(page);
  await expect(page.locator('#theia-statusBar')).toContainText('Restricted Mode');
  // No notice at all: a refusal would name its reason here.
  await expect(view.locator('.sterling-evidence-notice')).toHaveCount(0);
  const release = card(view, 'release');
  await expect(badge(release)).toHaveAttribute('data-verification', 'verified');
  await expect(badge(release)).toHaveText('Verified');
  await expect(release.locator('dl')).toContainText('Sterling Sovereign AI 0.5.0');
  await expect(release.locator('dl')).toContainText('the release key you configured');
  await expect(card(view, 'site')).toContainText(SITE_NONE_SINGLE);
  await expect(view.locator('.sterling-evidence-only-line')).toHaveText(RELEASE_ONLY_LINE);
  await expectFacts(view, 'Verified');
  // Release test results come from the release; the observation row from the supplier's reference site, never "Your site".
  await expect(view.locator('[data-key="unclassified/cm-08"] .sterling-evidence-source')).toHaveText('Release');
  await expect(view.locator('[data-key="unclassified/au-05"] .sterling-evidence-source')).toHaveText('Supplier reference site');
  await expect(view.locator('.sterling-evidence-controls .sterling-evidence-source', { hasText: 'Your site' })).toHaveCount(0);
  // The original theme with lifted cards (owner direction 2026-11-24): 12px radius and a shadow on the source cards.
  const lift = await release.evaluate((node) => { const style = getComputedStyle(node); return { radius: style.borderTopLeftRadius, shadow: style.boxShadow }; });
  expect(lift.radius).toBe('12px');
  expect(lift.shadow).not.toBe('none');
  await shot(page, 'S2-restricted-release-only');
});
