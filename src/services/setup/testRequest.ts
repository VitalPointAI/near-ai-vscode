import type { ModelEndpoint } from '../../domain/provider/endpoint';
import { TEST_REQUEST_TIMEOUT_MS } from '../../domain/setup/servers';
import { redactSecrets } from '../../domain/redaction';
import { RouteRefusedError, SpendLimitError } from '../nearAiClient';
import { withSpendTag } from '../spendLedger';
import { withCheckTimeout } from './probe';

export const TEST_PROMPT_TEXT = 'Reply with the single word OK.';
const SPEND_LIMIT_TEXT = 'Your daily spending limit was reached';
const ROUTE_REFUSED_TEXT = 'Your rules did not allow the test request';
const TEST_TIMEOUT_TEXT = 'The server took too long to answer';
const TEST_CANCELLED_TEXT = 'The test was cancelled';
const TEST_FAILED_TEXT = 'The server could not answer the test request';

export type TestOutcome = { readonly ok: true } | { readonly ok: false; readonly cause: string };

export async function runTestRequest(
  client: Pick<ModelEndpoint, 'completeOnce'>,
  model: string,
  options: { signal?: AbortSignal; projectId?: string },
): Promise<TestOutcome> {
  try {
    const answer = await withCheckTimeout(options.signal, TEST_REQUEST_TIMEOUT_MS, (signal) =>
      withSpendTag({ kind: 'eval', ...(options.projectId ? { projectId: options.projectId } : {}) }, () =>
        client.completeOnce(model, [{ role: 'user', content: TEST_PROMPT_TEXT }], { maxTokens: 8, noThinking: true, signal })));
    if (!answer.text && !answer.reasoning) return { ok: false, cause: TEST_FAILED_TEXT };
    return { ok: true };
  } catch (error) {
    let cause = TEST_FAILED_TEXT;
    if (options.signal?.aborted) cause = TEST_CANCELLED_TEXT;
    else if (error instanceof SpendLimitError) cause = SPEND_LIMIT_TEXT;
    else if (error instanceof RouteRefusedError) cause = ROUTE_REFUSED_TEXT;
    else if (error instanceof Error && error.name === 'TimeoutError') cause = TEST_TIMEOUT_TEXT;
    // Raw service errors may carry a URL, key or response body. The cause comes from fixed copy.
    return { ok: false, cause: redactSecrets(cause).slice(0, 120) };
  }
}
