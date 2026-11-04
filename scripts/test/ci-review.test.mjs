// The CI review's two helpers: the prompt built from gathered artifacts, and the model call. Both
// sit between the gate and a model, so their contract is tested rather than assumed. The model is
// faked with a local HTTP server, so nothing leaves the machine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseReview, reviewDecision } from '../lib/workflow.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const servers = [];
after(() => { for (const server of servers) server.close(); });

function gathered(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-review-'));
  const head = 'a'.repeat(40);
  writeFileSync(path.join(dir, 'pr.json'), JSON.stringify({ title: 'A change', body: 'What it does.', headRefOid: head, ...overrides }));
  writeFileSync(path.join(dir, 'checks.json'), '[]');
  writeFileSync(path.join(dir, 'files.txt'), 'src/a.ts');
  writeFileSync(path.join(dir, 'diff.patch'), '+ added a line\n');
  return { dir, head };
}

/** Runs a script and resolves its output. Async, so the fake model can answer while it runs. */
function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** A local endpoint that answers like an OpenAI-compatible chat completion. */
function fakeModel(reply, status = 200) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.on('data', () => {});
      request.on('end', () => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
  });
}

test('the prompt carries the PR, the checks, the diff, and the reply format', async () => {
  const { dir, head } = gathered();
  const result = await run('ci-review-prompt.mjs', ['11', '--dir', dir]);
  assert.equal(result.status, 0, result.stderr);
  const prompt = result.stdout;
  assert.match(prompt, /# Pull request #11: A change/);
  assert.match(prompt, /What it does\./);
  assert.match(prompt, /\+ added a line/, 'the diff is included');
  assert.match(prompt, /Reply with a markdown list of findings/);
  assert.match(prompt, new RegExp(`Head-SHA: ${head}`), 'the head is pre-filled, so the model cannot invent one');
  assert.match(prompt, /\[BLOCKER\], \[MAJOR\], \[MINOR\] or \[NIT\]/);
});

test('the prompt shows the CI results, so the model judges a green tree', async () => {
  const { dir } = gathered();
  writeFileSync(path.join(dir, 'checks.json'), '[{"name":"lint","state":"success"}]');
  const prompt = (await run('ci-review-prompt.mjs', ['11', '--dir', dir])).stdout;
  assert.match(prompt, /"name":"lint","state":"success"/);
});

test('the model call prints the reply, and the gate accepts a well-formed one', async () => {
  const { dir, head } = gathered();
  writeFileSync(path.join(dir, 'prompt.md'), (await run('ci-review-prompt.mjs', ['11', '--dir', dir])).stdout);
  const reply = `- [NIT] src/a.ts:1 a small thing\n\nVerdict: PASS\nHead-SHA: ${head}`;
  const server = await fakeModel(reply);
  const result = await run('ci-review-call.mjs', [path.join(dir, 'prompt.md')], {
    REVIEW_MODEL_API_KEY: 'test-key',
    REVIEW_MODEL: 'test-model',
    REVIEW_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), reply);

  // What the workflow does next: the gate parses the reply and decides from it.
  const review = parseReview(result.stdout);
  assert.equal(review.verdict, 'PASS');
  assert.equal(reviewDecision(review, head).state, 'success');
});

test('a reply with an open BLOCKER is refused by the gate even if it claims PASS', async () => {
  const { dir, head } = gathered();
  const promptPath = path.join(dir, 'prompt.md');
  writeFileSync(promptPath, 'prompt');
  const reply = `- [BLOCKER] src/a.ts:2 broken\n\nVerdict: PASS\nHead-SHA: ${head}`;
  const server = await fakeModel(reply);
  const out = (await run('ci-review-call.mjs', [promptPath], {
    REVIEW_MODEL_API_KEY: 'k', REVIEW_MODEL: 'm', REVIEW_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`
  })).stdout;
  const decision = reviewDecision(parseReview(out), head);
  assert.equal(decision.state, 'failure');
  assert.match(decision.reasons.join(' '), /open BLOCKER/);
});

test('the model call fails clearly when the key or the model is missing', async () => {
  const missingKey = await run('ci-review-call.mjs', ['p'], { REVIEW_MODEL_API_KEY: '', REVIEW_MODEL: 'm' });
  assert.notEqual(missingKey.status, 0);
  assert.match(missingKey.stderr, /REVIEW_MODEL_API_KEY is not set/);

  const missingModel = await run('ci-review-call.mjs', ['p'], { REVIEW_MODEL_API_KEY: 'k', REVIEW_MODEL: '' });
  assert.notEqual(missingModel.status, 0);
  assert.match(missingModel.stderr, /REVIEW_MODEL is not set/);
});

test('a 4xx from the endpoint is reported, not retried three times', async () => {
  const { dir } = gathered();
  const promptPath = path.join(dir, 'prompt.md');
  writeFileSync(promptPath, 'prompt');
  const server = await fakeModel('nope', 401);
  const result = await run('ci-review-call.mjs', [promptPath], {
    REVIEW_MODEL_API_KEY: 'bad', REVIEW_MODEL: 'm', REVIEW_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 401/);
});

test('an empty reply is an error, not an empty review', async () => {
  const { dir } = gathered();
  const promptPath = path.join(dir, 'prompt.md');
  writeFileSync(promptPath, 'prompt');
  const server = await fakeModel('');
  const result = await run('ci-review-call.mjs', [promptPath], {
    REVIEW_MODEL_API_KEY: 'k', REVIEW_MODEL: 'm', REVIEW_MODEL_BASE_URL: `http://127.0.0.1:${server.address().port}`
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /empty reply/);
});
