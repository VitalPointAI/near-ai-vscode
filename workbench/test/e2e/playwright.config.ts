// Playwright against the started workbench container (FND-T-07, D-28): one worker, list reporter, the URL from WORKBENCH_URL.
// The container suite (test/container/smoke.test.ts) starts the image and runs this; browsers come from Playwright's CDN, or from a
// mirrored copy named by PLAYWRIGHT_BROWSERS_PATH in an air-gapped run.
import assert from 'node:assert/strict';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const arm64Evidence = process.env.WORKBENCH_ARM64_BROWSER_EVIDENCE === '1';
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
if (arm64Evidence) {
  assert.ok(process.platform === 'linux' && process.arch === 'arm64', 'ARM64 browser evidence requires Linux ARM64');
  assert.ok(!process.env.PW_TEST_CONNECT_WS_ENDPOINT && !process.env.SELENIUM_REMOTE_URL, 'ARM64 browser evidence requires a local browser');
  assert.ok(executablePath && path.isAbsolute(executablePath), 'ARM64 browser evidence requires the checked Headless Shell path');
  assert.ok(statSync(executablePath).isFile(), 'The Headless Shell path must name a file');
  accessSync(executablePath, constants.X_OK);
}

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.WORKBENCH_URL,
    trace: 'off',
    ...(arm64Evidence ? { launchOptions: { executablePath }, headless: true, video: 'off' as const } : {}),
  },
});
