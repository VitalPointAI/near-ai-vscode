// The Documentation view shows figures, not their source: the architecture overview's diagrams are SVG drawn at build time and the
// README's screenshots are bundled images, in the dark and the light theme, and the view still makes only same-origin, data: or blob:
// requests (46-03). The container suite (test/container/smoke.test.ts) starts the image and runs this.
import { expect, test, type Page } from '@playwright/test';

const RAW = ['![', '<figure', '<img', '```mermaid', 'flowchart LR'];

async function runCommand(page: Page, label: string, pick?: string): Promise<void> {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input');
  await expect(input).toBeVisible();
  await input.fill(`>${label}`);
  await page.locator('.quick-input-list .monaco-list-row', { hasText: label }).first().click();
  if (pick) {
    await input.fill(pick);
    await page.locator('.quick-input-list .monaco-list-row', { hasText: pick }).first().click();
  }
}

async function openTopic(page: Page, title: string): Promise<void> {
  await page.locator('.sterling-documentation nav button', { hasText: title }).click();
  await expect(page.locator('.sterling-documentation nav button[aria-current="page"]')).toHaveText(title);
}

async function expectNoRawSyntax(page: Page): Promise<void> {
  const visible = await page.locator('.sterling-documentation article').innerText();
  for (const raw of RAW) expect(visible, `visible text holds ${raw}`).not.toContain(raw);
}

test('figures and diagrams render as images and SVG, never as source, and load only from the workbench', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? '').origin;
  const elsewhere: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== origin) elsewhere.push(url);
  });

  await page.goto('/');
  await expect(page.locator('.lm-TabBar-tab', { hasText: 'Get Started' }).first()).toBeVisible({ timeout: 90_000 });
  const decline = page.getByRole('button', { name: 'No, I don\'t trust the authors' });
  await decline.waitFor({ timeout: 30_000 }).then(() => decline.click(), () => undefined);
  await runCommand(page, 'SovAI: Documentation');
  await expect(page.locator('.sterling-documentation nav button').first()).toBeVisible({ timeout: 30_000 });

  await openTopic(page, 'Architecture overview');
  const diagrams = page.locator('.sterling-documentation article figure.sterling-doc-diagram svg');
  await expect(diagrams).toHaveCount(3);
  await expect(diagrams.first()).toBeVisible();
  await expectNoRawSyntax(page);

  await openTopic(page, 'Features and settings');
  const screenshots = page.locator('.sterling-documentation article img');
  await expect(screenshots).toHaveCount(4);
  await screenshots.first().scrollIntoViewIfNeeded();
  await expect(screenshots.first()).toBeVisible();
  for (const image of await screenshots.all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await image.getAttribute('src')).toMatch(/^sterling-documentation\/[0-9a-f]{16}\.png$/);
  }
  await expectNoRawSyntax(page);

  // Links between pages still open the page in the view, and search still finds a diagram's words.
  await openTopic(page, 'Welcome');
  await page.locator('.sterling-documentation article a', { hasText: 'Architecture overview' }).first().click();
  await expect(page.locator('.sterling-documentation nav button[aria-current="page"]')).toHaveText('Architecture overview');
  await expect(diagrams).toHaveCount(3);
  await page.locator('.sterling-documentation input[type="search"]').fill('Keycloak sign-in, no passwords');
  await expect(page.locator('.sterling-documentation nav button')).toContainText(['Architecture overview']);
  await page.locator('.sterling-documentation input[type="search"]').fill('');

  // The diagrams follow the theme: in the dark and the light theme their text takes that theme's editor colour.
  const diagramText = async (theme: string): Promise<string> => {
    await runCommand(page, 'Preferences: Color Theme', theme);
    await openTopic(page, 'Architecture overview');
    const fill = await diagrams.first().locator('g.node text').first().evaluate((node) => getComputedStyle(node).fill);
    const foreground = await page.locator('.sterling-documentation').evaluate((node) => getComputedStyle(node).color);
    expect(fill, `diagram text in ${theme}`).toEqual(foreground);
    await expectNoRawSyntax(page);
    return fill;
  };
  expect(await diagramText('Dark (Theia)')).not.toEqual(await diagramText('Light (Theia)'));

  await page.waitForLoadState('networkidle');
  expect(elsewhere, 'requests to another origin').toEqual([]);
});
