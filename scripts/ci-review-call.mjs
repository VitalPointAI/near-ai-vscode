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
import { fail, parseArgs } from './lib/gh.mjs';

const usage = 'usage: ci-review-call.mjs <prompt.md>';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 180_000;

async function call(prompt, { baseUrl, apiKey, model }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      // Enough for a long finding list plus the diff's context; the reply is a list, not an essay.
      max_tokens: 4_000,
      messages: [
        { role: 'system', content: 'You are a skeptical code reviewer. Reply with findings and the required verdict lines, and nothing else.' },
        { role: 'user', content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`the model endpoint returned HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('the model returned an empty reply');
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
  if (!model) fail('REVIEW_MODEL is not set; say which model should review.');

  const prompt = readFileSync(promptPath, 'utf8');
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      process.stdout.write(`${await call(prompt, { baseUrl, apiKey, model })}\n`);
      process.exit(0);
    } catch (error) {
      lastError = error;
      // A retry is worth it for a transient 5xx or a timeout; a 401 will fail the same way three times.
      console.error(`attempt ${attempt} failed: ${error.message}`);
      if (/HTTP 4\d\d/.test(error.message)) break;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
    }
  }
  fail(`the review model could not produce a review: ${lastError?.message ?? 'unknown error'}`);
} catch (error) {
  fail(error.message);
}
