import { setTimeout as delay } from 'node:timers/promises';
import { type Page } from '@playwright/test';
import { waitForGetStartedTab } from './wait-for-get-started';

const MILESTONE_PREFIX = 'STERLING_HOSTED_STARTUP ';
const MAX_VALUE = 600_000;

const counters = [
  'pageErrors', 'failedDocuments', 'failedAssets', 'failedRequests',
  'webSocketsStarted', 'webSocketsClosed', 'webSocketErrors'
] as const;
const flags = ['domLoaded', 'shell', 'preloader', 'welcomeTab', 'trustDialog'] as const;
type Counter = typeof counters[number];
type Flag = typeof flags[number];

interface StartupMilestones extends Record<Counter, number>, Partial<Record<Flag, boolean>> {
  readonly elapsedMs: number;
  readonly readyState?: 'loading' | 'interactive' | 'complete';
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_VALUE;
}

/** Read only fixed fields from the browser test's report. Never forward child-process lines. */
export function hostedStartupMilestones(output: string): StartupMilestones | undefined {
  const line = output.split('\n').find((line) => line.startsWith(MILESTONE_PREFIX));
  if (line === undefined || line.length > 1024) return undefined;
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(line.slice(MILESTONE_PREFIX.length)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (fields === null || typeof fields !== 'object' || !isBoundedCount(fields.elapsedMs)) return undefined;
  const counts = {} as Record<Counter, number>;
  for (const key of counters) {
    const count = fields[key];
    if (!isBoundedCount(count)) return undefined;
    counts[key] = count;
  }
  const observed: Partial<Record<Flag, boolean>> = {};
  for (const key of flags) {
    const flag = fields[key];
    if (typeof flag === 'boolean') observed[key] = flag;
  }
  const readyState = fields.readyState;
  return {
    elapsedMs: fields.elapsedMs, ...counts, ...observed,
    ...(readyState === 'loading' || readyState === 'interactive' || readyState === 'complete' ? { readyState } : {})
  };
}

/** The two hosted specs use the same startup assertions. Report only counts and DOM flags if startup fails. */
export async function openHostedWorkbench(page: Page): Promise<void> {
  const started = performance.now();
  const counts: Record<Counter, number> = {
    pageErrors: 0, failedDocuments: 0, failedAssets: 0, failedRequests: 0,
    webSocketsStarted: 0, webSocketsClosed: 0, webSocketErrors: 0
  };
  let domLoaded = false;
  const failed = (kind: string): void => {
    if (kind === 'document') counts.failedDocuments += 1;
    else if (kind === 'script' || kind === 'stylesheet') counts.failedAssets += 1;
    else counts.failedRequests += 1;
  };
  page.once('domcontentloaded', () => { domLoaded = true; });
  page.on('pageerror', () => { counts.pageErrors += 1; });
  page.on('requestfailed', (request) => failed(request.resourceType()));
  page.on('response', (response) => { if (response.status() >= 400) failed(response.request().resourceType()); });
  page.on('websocket', (socket) => {
    counts.webSocketsStarted += 1;
    socket.on('close', () => { counts.webSocketsClosed += 1; });
    socket.on('socketerror', () => { counts.webSocketErrors += 1; });
  });

  try {
    await waitForGetStartedTab(page);
    const trust = page.getByRole('button', { name: 'Yes, I trust the authors' });
    await trust.waitFor({ timeout: 15_000 }).then(() => trust.click(), () => undefined);
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    const dom = await Promise.race([
      page.evaluate(() => ({
        readyState: document.readyState,
        shell: document.querySelector('.theia-ApplicationShell') !== null,
        preloader: document.querySelector('.theia-preload') !== null,
        welcomeTab: Array.from(document.querySelectorAll('.lm-TabBar-tab')).some((tab) => tab.textContent?.includes('Get Started')),
        trustDialog: Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Yes, I trust the authors')
      })).catch(() => undefined),
      delay(750, undefined, { ref: false })
    ]);
    console.log(MILESTONE_PREFIX + JSON.stringify({ elapsedMs, domLoaded, ...counts, ...dom }));
    throw error;
  }
}
