// The hosted-mode session view in a real browser (46-08; D-21 to D-24, D-28). The container suite (test/container/hosted-e2e.test.ts) starts
// the workbench in hosted mode against a dev OpenBao and plays oauth2-proxy: every request carries the forwarded sign-in headers. SPEC_STEP:
//   active    the person the session was started for: no status entry once the check is done, and the step-up command goes to the
//             same-origin /oauth2/start link with the step-up acr and max_age=0
//   mismatch  someone else's headers: the entry reads "Sign-in check failed" and the notification gives the person-mismatch reason
//   retry     the right person's headers in a new browser: choose Retry, and the entry goes away
import { expect, test, type Page } from '@playwright/test';
import { openHostedWorkbench } from './hosted-startup';

const STEP = process.env.SPEC_STEP ?? '';
const ENTRY = '#status-bar-sterling-session-identity';
const MISMATCH = 'This session was started for someone else. Sign in as that person, then choose Retry.';

// Always one host name (127.0.0.1) and always the page first: Theia's connection-token cookie and Origin check (research pitfall 3).
test.use({
  extraHTTPHeaders: {
    'X-Forwarded-Access-Token': process.env.WORKBENCH_TOKEN ?? '',
    'X-Auth-Request-Email': process.env.WORKBENCH_EMAIL ?? '',
    'X-Auth-Request-User': process.env.WORKBENCH_USER ?? '',
  },
});

async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill(`>${label}`);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().click();
}

test('the session view for this step', async ({ page }) => {
  await openHostedWorkbench(page);
  if (STEP === 'active') {
    // The view polls every 5 s while the check runs; two rounds later there is still no entry.
    await page.waitForTimeout(11_000);
    await expect(page.locator(ENTRY)).toHaveCount(0);
    await expect(page.locator('#status-bar-sterling-secret-store')).toHaveCount(0);
    const acr = process.env.WORKBENCH_STEPUP_ACR ?? '';
    let stepUp = '';
    await page.route('**/oauth2/start**', async (route) => {
      stepUp = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'the identity provider would ask for a passkey or security key here' });
    });
    await runCommand(page, 'Confirm with your passkey or security key');
    await expect.poll(() => stepUp, { timeout: 30_000 }).not.toBe('');
    const url = new URL(stepUp);
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe('/oauth2/start');
    expect(url.searchParams.get('acr_values')).toBe(acr);
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('rd')?.startsWith('/')).toBe(true);
    return;
  }
  if (STEP === 'mismatch') {
    await expect(page.locator(ENTRY)).toContainText('Sign-in check failed', { timeout: 30_000 });
    await expect(page.locator('.theia-notification-list-item', { hasText: MISMATCH }).first()).toBeVisible({ timeout: 30_000 });
    return;
  }
  if (STEP === 'retry') {
    await expect(page.locator(ENTRY)).toContainText('Sign-in check failed', { timeout: 30_000 });
    await runCommand(page, 'Retry the sign-in check');
    await expect(page.locator(ENTRY)).toHaveCount(0, { timeout: 30_000 });
    return;
  }
  throw new Error(`unknown SPEC_STEP ${JSON.stringify(STEP)}`);
});
