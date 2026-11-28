// The architecture illustration and README screenshots are bundled images. The architecture flows remain searchable text,
// follow the Workbench theme, and load no remote resources. The container suite runs this against the built image.
import { expect, test, type Page } from '@playwright/test';

const RAW = ['![', '<figure', '<img', '```mermaid', 'flowchart LR', 'SystemArchitecture'];
const MISSION_HUB_STEP = 'Mission hub validates sealed changes';

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
  await page.locator('.sterling-documentation nav').getByRole('button', { name: title, exact: true }).click();
  await expect(page.locator('.sterling-documentation nav button[aria-current="page"]')).toHaveText(title);
}

async function expectNoRawSyntax(page: Page): Promise<void> {
  const visible = await page.locator('.sterling-documentation article').innerText();
  for (const raw of RAW) expect(visible, `visible text holds ${raw}`).not.toContain(raw);
}

test('bundled figures and architecture flows render offline and remain usable across layouts and themes', async ({ page, baseURL }) => {
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
  const article = page.locator('.sterling-documentation article');
  const illustration = article.getByRole('img', { name: /^System blueprint of Sterling Sovereign AI/ });
  const physicalLayout = article.getByRole('img', { name: /^Physical deployment of Sterling Sovereign AI/ });
  const flows = article.locator('table').filter({ hasText: MISSION_HUB_STEP });
  await expect(physicalLayout).toHaveCount(1);
  await expect(physicalLayout).toHaveAttribute('src', /^sterling-documentation\/[0-9a-f]{16}\.webp$/);
  await expect(illustration).toHaveCount(1);
  await expect(illustration).toHaveAttribute('src', /^sterling-documentation\/[0-9a-f]{16}\.webp$/);
  await expect(flows.locator('tbody tr')).toHaveCount(9);
  await expectNoRawSyntax(page);

  for (const width of [1600, 640]) {
    await page.setViewportSize({ width, height: 900 });
    for (const blueprint of [physicalLayout, illustration]) {
      await blueprint.scrollIntoViewIfNeeded();
      await expect(blueprint).toBeVisible();
      await expect.poll(() => blueprint.evaluate((node) => {
        const image = node as HTMLImageElement;
        if (!image.complete || image.naturalWidth === 0) return false;
        const box = image.getBoundingClientRect();
        const container = image.closest('article')!.getBoundingClientRect();
        return box.width > 0 && box.left >= container.left - 1 && box.right <= container.right + 1;
      }), { message: `the bundled blueprint loads and fits at ${width}px` }).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1600, height: 900 });

  for (const [blueprint, name, height] of [
    [physicalLayout, /^Physical deployment .*Open full-size image$/, 2090],
    [illustration, /^System blueprint .*Open full-size image$/, 2280],
  ] as const) {
    const link = article.getByRole('link', { name });
    const asset = await blueprint.getAttribute('src');
    expect(new URL((await link.getAttribute('href'))!, baseURL).href).toBe(new URL(asset!, baseURL).href);
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    try {
      expect(new URL(popup.url()).origin).toBe(origin);
      const image = popup.locator('img');
      await expect(image).toHaveJSProperty('naturalWidth', 3500);
      await expect(image).toHaveJSProperty('naturalHeight', height);
    } finally {
      await popup.close();
    }
  }

  await article.getByRole('link', { name: 'Generated component catalogue' }).first().click();
  await expect(page.locator('.sterling-documentation nav button[aria-current="page"]')).toHaveText('Component catalogue');

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

  // Links between pages still open the architecture topic in the view.
  await openTopic(page, 'Welcome');
  await article.getByRole('link', { name: 'Architecture overview' }).first().click();
  const topics = page.locator('.sterling-documentation nav button');
  await expect(page.locator('.sterling-documentation nav button[aria-current="page"]')).toHaveText('Architecture overview');
  await expect(illustration).toHaveCount(1);

  const search = page.locator('.sterling-documentation input[type="search"]');
  await search.fill(MISSION_HUB_STEP);
  await expect(topics).toContainText(['Architecture overview']);
  await expect(topics.filter({ hasText: 'Welcome' })).toHaveCount(0);
  await search.fill('');

  const flowTextColour = async (theme: string): Promise<string> => {
    await runCommand(page, 'Preferences: Color Theme', theme);
    await openTopic(page, 'Architecture overview');
    const colour = await flows.getByRole('cell', { name: MISSION_HUB_STEP, exact: true })
      .evaluate((node) => getComputedStyle(node).color);
    const foreground = await page.locator('.sterling-documentation').evaluate((node) => getComputedStyle(node).color);
    expect(colour, `flow text inherits the documentation foreground in ${theme}`).toEqual(foreground);
    await expectNoRawSyntax(page);
    return colour;
  };
  expect(await flowTextColour('Dark (Theia)')).not.toEqual(await flowTextColour('Light (Theia)'));

  await page.waitForLoadState('networkidle');
  expect(elsewhere, 'requests to another origin').toEqual([]);
});
