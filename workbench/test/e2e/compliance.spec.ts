// The Compliance view in a real browser against the built image (48.2-16; D-05, D-17, D-18, D-22, D-25, D-26): the one focused browser
// check of its honesty rules. Each test is one case; test/container/compliance.test.ts starts a container with that case's mounts, makes
// the signed fixture folders (signed as cosign key mode signs, with throwaway keys), and runs the case by name. The words checked are the approved
// UI-SPEC's (48.2-UI-SPEC.md, Copywriting Contract). Screenshots for the owner go to COMPLIANCE_SHOTS when it is set.
import { renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// A tall window: Theia fits its layout to the window, so the whole view is in one screenshot.
test.use({ viewport: { width: 1440, height: 2000 } });

const RELEASE_ONLY_LINE = 'This is the release’s own evidence. Nothing here shows how your site runs it.';
const SITE_NONE_SINGLE = 'This computer is not part of a site, so there is no site evidence. The release evidence is shown alone.';
const NO_KEY_SITE = 'Not verified: your site’s trust settings are missing, so no state here is counted as met. Ask your organization’s administrator.';
const ANCHOR_MISMATCH = 'The site key in this session’s evidence settings is not your organization’s site key, the one your site checks every image against. Ask your organization’s administrator.';
const NONE_VERIFIED = 'No controls to show: no evidence source verified.';
const PROJECTION_NOT_VERIFIED = 'Not verified: checked on the computer that wrote it, but not signed. Its states are never counted.';
const RELEASE_NONE = 'This workbench carries no release evidence. Images from a release carry their own; a development build does not.';
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

/** A refusal: the card shows only the Did not verify badge and its reason, no facts. */
async function expectDidNotVerify(source: Locator, reason: string | RegExp): Promise<void> {
  await expect(badge(source)).toHaveAttribute('data-verification', 'did-not-verify');
  await expect(badge(source)).toHaveText('Did not verify');
  await expect(source.locator('dl')).toHaveCount(0);
  await expect(source.locator('.sterling-evidence-source-message').first()).toHaveText(reason);
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

test('Site layered', async ({ page }) => {
  const staged = process.env.COMPLIANCE_SITE_STAGED;
  const mount = process.env.COMPLIANCE_SITE_MOUNT;
  expect(staged && mount, 'the driver names the staged site files and the mounted folder').toBeTruthy();
  const view = await openCompliance(page);
  // At a site with no site key mounted yet: the release is Not verified and says so; nothing counts as Met.
  await expect(badge(card(view, 'release'))).toHaveText('Not verified');
  await expect(card(view, 'release')).toContainText(NO_KEY_SITE);
  await expect(view.locator('.sterling-evidence-controls [data-state="met"]')).toHaveCount(0);
  await shot(page, 'S4-site-no-key');
  // The site's files land in the mounted folder while the page is open; a marker on the window proves there is no reload.
  await page.evaluate(() => { (window as unknown as { sterlingNoReload: boolean }).sterlingNoReload = true; });
  for (const name of readdirSync(staged!)) renameSync(path.join(staged!, name), path.join(mount!, name));
  const landed = Date.now();
  const site = card(view, 'site');
  await expect(badge(site)).toHaveText('Verified', { timeout: 40_000 });
  await expect(badge(card(view, 'release'))).toHaveText('Verified', { timeout: 40_000 - (Date.now() - landed) });
  await expect(view.locator('[data-key="unclassified/au-05"] .sterling-evidence-source')).toHaveText(/^(Your site|Release and your site)$/, { timeout: 40_000 - (Date.now() - landed) });
  expect(Date.now() - landed).toBeLessThanOrEqual(40_000);
  expect(await page.evaluate(() => (window as unknown as { sterlingNoReload?: boolean }).sterlingNoReload)).toBe(true);
  await expect(site.locator('dl')).toContainText('site-a');
  await expect(card(view, 'release').locator('dl')).toContainText('your organization’s site key');
  await expect(view.locator('.sterling-evidence-only-line')).toHaveCount(0);
  await expectFacts(view, 'Verified');
  await shot(page, 'S1-site-layered');
});

test('Tampered', async ({ page }) => {
  const view = await openCompliance(page);
  await expectDidNotVerify(card(view, 'release'), 'sbom/sterling-image.cdx.json has changed since the evidence was signed.');
  await expect(view.locator('.sterling-evidence-notice[data-tone="error"]')).toHaveText(
    'The release evidence did not verify: sbom/sterling-image.cdx.json has changed since the evidence was signed. Nothing from it is shown.');
  await expect(view.locator('.sterling-evidence-results')).toContainText(NONE_VERIFIED);
  await expect(rows(view)).toHaveCount(0);
  await expect(view.locator('[data-key]')).toHaveCount(0);
  await shot(page, 'S6-tampered');
});

test('Anchor mismatch', async ({ page }) => {
  const view = await openCompliance(page);
  await expectDidNotVerify(card(view, 'release'), ANCHOR_MISMATCH);
  await expectDidNotVerify(card(view, 'site'), ANCHOR_MISMATCH);
  // One shared notice naming both sources, never two identical ones.
  const notices = view.locator('.sterling-evidence-notice[data-tone="error"]');
  await expect(notices).toHaveCount(1);
  await expect(notices).toHaveText(`The release evidence and your site’s evidence did not verify: ${ANCHOR_MISMATCH.charAt(0).toLowerCase()}${ANCHOR_MISMATCH.slice(1)} Nothing from them is shown.`);
  await expect(view.locator('.sterling-evidence-results')).toContainText(NONE_VERIFIED);
  await expect(view.locator('[data-key]')).toHaveCount(0);
  await shot(page, 'S6c-anchor-mismatch');
});

test('Projection', async ({ page }) => {
  const view = await openCompliance(page);
  await expect(card(view, 'release')).toContainText(RELEASE_NONE);
  const projection = card(view, 'projection');
  await expect(badge(projection)).toHaveText('Not verified');
  await expect(projection).toContainText(PROJECTION_NOT_VERIFIED);
  await expect(projection.locator('dl')).toContainText('your copy of the published dashboard');
  // Its rows are shown, every one Not verified with the Published projection source, and nothing is counted as Met. The fixture's rows
  // carry no results, so each reads No evidence and has no as-of time.
  const count = await rows(view).count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const row = rows(view).nth(index);
    await expect(row).toHaveAttribute('data-state', 'not-verified');
    await expect(row.locator('.sterling-evidence-badge')).toHaveText('Not verified');
    await expect(row.locator('.sterling-evidence-source')).toHaveText('Published projection');
    await expect(row.locator('.sterling-evidence-freshness')).toHaveText('No evidence');
    await expect(row.locator('.sterling-evidence-verification')).toHaveText('Not verified');
  }
  await expect(view.locator('.sterling-evidence-badge[data-state="met"]')).toHaveCount(0);
  const totals = view.locator('.sterling-evidence-summary tfoot tr');
  await expect(totals.locator('td').nth(1)).toHaveText('0');
  await shot(page, 'S9-projection');

  const summary = view.locator('.sterling-evidence-summary-region');
  for (const width of [1140, 460]) {
    await page.setViewportSize({ width, height: 2000 });
    await expect.poll(() => summary.evaluate(region => {
      const headers = Array.from(region.querySelectorAll('thead th'));
      return headers.map(header => {
        const text = document.createRange();
        text.selectNodeContents(header);
        return text.getClientRects().length;
      });
    })).toEqual([1, 1, 1, 1, 1, 1, 1]);
    const layout = await summary.evaluate(region => ({
      tableScrolls: region.scrollWidth > region.clientWidth,
      pageScrolls: region.closest('.sterling-compliance')!.scrollWidth > region.closest('.sterling-compliance')!.clientWidth,
    }));
    expect(layout).toEqual({ tableScrolls: width === 460, pageScrolls: false });
  }
});
