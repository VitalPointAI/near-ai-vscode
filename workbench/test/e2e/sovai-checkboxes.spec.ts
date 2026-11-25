// The checkbox render test (74.1-UI-SPEC "Checkboxes" and "Acceptance items", owner 2026-11-25: "make sure the checkboxes line up/are centered vertically
// with the text next to them on the right"). It renders the extension's own stylesheets (media/shared/base.css, then media/policy/policy.css) in Chromium,
// with the S11 draft card's checkbox rows (Projects it covers, Labels it covers, Conditions, one label long enough to wrap), in the light and the dark
// theme, and measures every row: the box's vertical centre within 1px of the centre of its label's first text line, an 8px gap, a 16 by 16 box, a row at
// least 24px high, and a click on the label text toggles the box. It needs no workbench: the page is set from the files, so it runs wherever Playwright
// and its Chromium do (the container suite in CI). 74.1-19 adds the Model policy page's Stop dialog here when it lands.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';

const REPO = path.resolve(__dirname, '..', '..', '..');
const css = (file: string): string => readFileSync(path.join(REPO, 'media', ...file.split('/')), 'utf8');

const THEMES: Record<string, Record<string, string>> = {
  'vscode-light': { '--vscode-foreground': '#3b3b3b', '--vscode-editor-background': '#ffffff', '--vscode-editorWidget-background': '#f8f8f8', '--vscode-descriptionForeground': '#717171', '--vscode-panel-border': '#e5e5e5' },
  'vscode-dark': { '--vscode-foreground': '#cccccc', '--vscode-editor-background': '#1f1f1f', '--vscode-editorWidget-background': '#202020', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-panel-border': '#2b2b2b' }
};

function page(theme: string): string {
  const vars = Object.entries({ ...THEMES[theme], '--vscode-font-family': 'system-ui, sans-serif', '--vscode-font-size': '13px' }).map(([name, value]) => `${name}: ${value};`).join(' ');
  const row = (name: string, text: string, checked = false) => `<label class="check-row"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}><span>${text}</span></label>`;
  return `<!doctype html><html><head><style>${css('shared/base.css')}</style><style>${css('policy/policy.css')}</style>
<style>:root { ${vars} } body { font-size: var(--vscode-font-size); background: var(--vscode-editor-background); color: var(--vscode-foreground); width: 320px; }</style></head>
<body class="${theme}"><div id="exceptions"><section class="rules exceptions"><div class="lifted raised exception-card">
<fieldset><legend class="strong">Projects it covers</legend><div class="check-rows">${row('projects', 'Harrow Ridge')}${row('projects', 'Northern Watch')}</div></fieldset>
<fieldset><legend class="strong">Labels it covers</legend><div class="check-rows"><p class="muted scale-name">Organization</p>${row('labels', 'org/Internal')}${row('labels', 'org/Public')}</div></fieldset>
<fieldset><legend class="strong">Conditions</legend><div class="check-rows">${row('conditions', 'A person reviews every answer', true)}${row('conditions', 'No tools', true)}${row('conditions', 'A model of another family checks the answers, and a person in your organization reads every answer before it is used anywhere', true)}</div></fieldset>
</div></section></div></body></html>`;
}

for (const theme of Object.keys(THEMES)) {
  test(`checkbox rows line up with their labels in the ${theme === 'vscode-dark' ? 'dark' : 'light'} theme`, async ({ page: browser }) => {
    await browser.setViewportSize({ width: 360, height: 900 });
    await browser.setContent(page(theme));
    const rows = await browser.$$eval('label:has(> input[type=checkbox])', (labels) => labels.map((label) => {
      const box = (label.querySelector('input') as HTMLInputElement).getBoundingClientRect();
      const span = label.querySelector('span') as HTMLSpanElement;
      // The first text line is the label's first line box: its top is the text's top, its height the line height. (A glyph's own box depends on which
      // installed font draws it, so it is not the measure.)
      const lineHeight = parseFloat(getComputedStyle(span).lineHeight);
      const textTop = span.getBoundingClientRect().top;
      const lines = Math.round(span.getBoundingClientRect().height / lineHeight);
      return {
        text: span.textContent ?? '', boxCentre: box.top + box.height / 2, lineCentre: textTop + lineHeight / 2, gap: span.getBoundingClientRect().left - box.right,
        width: box.width, height: box.height, rowHeight: label.getBoundingClientRect().height, lines
      };
    }));
    expect(rows.length).toBe(7);
    expect(rows.some((row) => row.lines > 1), 'one label wraps, so the first-line rule is exercised').toBe(true);
    for (const row of rows) {
      expect(Math.abs(row.boxCentre - row.lineCentre), `${row.text}: box centred on the first line`).toBeLessThanOrEqual(1);
      expect(Math.round(row.gap), `${row.text}: 8px gap`).toBe(8);
      expect([row.width, row.height], `${row.text}: 16 by 16 box`).toEqual([16, 16]);
      expect(row.rowHeight, `${row.text}: row at least 24px`).toBeGreaterThanOrEqual(24);
    }
    // A click on the label text toggles the box.
    const first = browser.locator('label:has(> input[type=checkbox])').first();
    await first.locator('span').click();
    await expect(first.locator('input')).toBeChecked();
  });
}
