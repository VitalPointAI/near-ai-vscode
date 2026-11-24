// Playwright against the started workbench container (FND-T-07, D-28): one worker, list reporter, the URL from WORKBENCH_URL.
// The container suite (test/container/smoke.test.ts) starts the image and runs this; browsers come from Playwright's CDN, or from a
// mirrored copy named by PLAYWRIGHT_BROWSERS_PATH in an air-gapped run.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.WORKBENCH_URL, trace: 'off' },
});
