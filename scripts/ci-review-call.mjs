#!/usr/bin/env node
// Sends the review prompt to a model and prints its reply. The review needs judgement, so this is
// the one step CI cannot do deterministically; everything else (gate, gate outcome, whether a PR
// merges) stays mechanical.
//
//   node scripts/ci-review-call.mjs <prompt.md>
//
// Reads the endpoint and key from the environment, so the workflow keeps them in a protected
// environment and nothing sensitive reaches the checkout:
//   REVIEW_MODEL_BASE_URL  default https://cloud-api.near.ai/v1
//   REVIEW_MODEL_API_KEY   a NEAR AI Cloud key
//   REVIEW_MODEL           the model id to ask
//
// It is deliberately a plain fetch rather than a dependency: this repository keeps its runtime
// dependency list empty, and one POST to an OpenAI-compatible endpoint needs nothing else.
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT } from './lib/ci-review.mjs';
import { fail, parseArgs } from './lib/gh.mjs';

const usage = 'usage: ci-review-call.mjs <prompt.md>';

const MAX_ATTEMPTS = 3;

/** The key goes only to https, or to plain http on this machine (tests, a local proxy). */
function isAllowedEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch {
    return false;
  }
}
// Reasoning models think before they answer, and the thinking counts against max_tokens, so a large
// pull request needs room (and time) for both. REVIEW_MAX_TOKENS can raise or lower the cap.
const TIMEOUT_MS = 480_000;
const DEFAULT_MAX_TOKENS = 32_000;

function maxTokens() {
  const raw = process.env.REVIEW_MAX_TOKENS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_TOKENS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 400_000) fail('REVIEW_MAX_TOKENS must be a whole number from 1000 to 400000.');
  return value;
}

/** Reads a streamed (server-sent events) reply, or a whole JSON reply from an endpoint that ignores `stream`. */
async function readReply(response) {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const body = await response.json();
    const choice = body?.choices?.[0];
    return { text: choice?.message?.content, finishReason: choice?.finish_reason };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let finishReason;
  const take = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    const choice = event?.choices?.[0];
    if (typeof choice?.delta?.content === 'string') text += choice.delta.content;
    const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (typeof reasoning === 'string') thinking += reasoning.length;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  };
  // Progress on stderr every 30 seconds, so a person (or a CI log) can see the model is working.
  // Only counts, never content: the reply is printed once, at the end.
  let thinking = 0;
  const started = Date.now();
  const progress = setInterval(() => {
    const seconds = Math.round((Date.now() - started) / 1000);
    console.error(text ? `still writing the review: ${text.length} characters after ${seconds}s` : `still thinking: ${thinking} characters of reasoning after ${seconds}s`);
  }, 30_000);
  progress.unref();
  try {
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      take(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
    }
  }
  if (buffer) take(buffer);
  } finally {
    clearInterval(progress);
  }
  return { text, finishReason };
}

/** A network failure names its cause (for example a headers timeout or a reset), never the request. */
function describe(error) {
  const cause = error?.cause;
  const detail = cause?.code ?? cause?.name;
  return detail && error.message === 'fetch failed' ? `fetch failed (${detail})` : error.message;
}

async function call(prompt, { baseUrl, apiKey, model }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens(),
      // Streamed, so the first bytes arrive within seconds: a non-streamed reply from a reasoning
      // model can take longer than Node's five-minute wait for response headers, which fails as a
      // bare "fetch failed" before our own timeout is reached.
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    }),
    // Never follow a redirect with the key attached.
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    // Only the status code: an error body can echo the request, and CI logs are public.
    await response.body?.cancel().catch(() => {});
    throw new Error(`the model endpoint returned HTTP ${response.status}`);
  }
  const { text, finishReason } = await readReply(response);
  const choice = { finish_reason: finishReason };
  if (typeof text !== 'string' || !text.trim()) {
    // A reasoning model that spends its whole allowance thinking answers with nothing and says why.
    if (choice?.finish_reason === 'length') throw new Error('the model ran out of room before it answered (it stopped at its token limit); raise REVIEW_MAX_TOKENS');
    throw new Error('the model returned an empty reply');
  }
  return text.trim();
}

try {
  const { positional } = parseArgs(process.argv.slice(2), { string: [] });
  const [promptPath] = positional;
  if (!promptPath) fail(usage);

  const baseUrl = process.env.REVIEW_MODEL_BASE_URL || 'https://cloud-api.near.ai/v1';
  const apiKey = process.env.REVIEW_MODEL_API_KEY;
  const model = process.env.REVIEW_MODEL;
  if (!apiKey) fail('REVIEW_MODEL_API_KEY is not set; the review cannot ask a model.');
  if (!isAllowedEndpoint(baseUrl)) fail('REVIEW_MODEL_BASE_URL must be an https:// URL (http:// only for localhost); the key is not sent elsewhere.');
  if (!model) fail('REVIEW_MODEL is not set; say which model should review.');

  const prompt = readFileSync(promptPath, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      process.stdout.write(`${await call(prompt, { baseUrl, apiKey, model })}\n`);
      process.exit(0);
    } catch (error) {
      lastError = new Error(describe(error));
      // A retry is worth it for a transient 5xx, a timeout, 408 or 429; a 401 will fail the same
      // way three times.
      console.error(`attempt ${attempt} failed: ${lastError.message}`);
      if (/HTTP 4\d\d/.test(lastError.message) && !/HTTP (408|429)\b/.test(lastError.message)) break;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  fail(`the review model could not produce a review: ${lastError?.message ?? 'unknown error'}`);
} catch (error) {
  fail(error.message);
}
