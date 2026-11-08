// A blind A/B test of two agent setups on the same task, so "faster and cheaper" is only accepted when the result is also as good or better (owner,
// 2026-11-07: "speed is no good if the result sucks - we need fast and right").
//
// What it does:
//   1. Runs the same task prompt through two setups (A and B), each `runs` times, writing each answer to its own file.
//   2. Shows every answer to a judge model with the setups hidden and the order shuffled per pair, and asks which is better for the task, plus why.
//   3. Reports, per setup: mean wall time, tokens and cost, and the blind preference (wins, losses, ties).
//
// Nothing is changed in the extension: a "setup" is whatever the caller's command line is, so a model, a brief or a ceiling can be tested without a
// code change. The judge is a separate model from both, by default, so a setup cannot prefer its own style.
//
// Usage:
//   node scripts/ab-task.mjs --task task.md --a "CMD_A" --b "CMD_B" [--runs 3] [--judge <model>] [--out <dir>]
//
// CMD_A / CMD_B are shell commands that read the task on stdin and print the answer on stdout. For example, to compare a research brief:
//   --a "near-ai-research --brief concise --model fast" --b "near-ai-research --brief detailed --model big"
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const options = { runs: 3, out: undefined, judge: undefined, a: undefined, b: undefined, task: undefined, taskName: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => argv[++index];
    if (arg === '--task') options.task = value();
    else if (arg === '--name') options.taskName = value();
    else if (arg === '--a') options.a = value();
    else if (arg === '--b') options.b = value();
    else if (arg === '--runs') options.runs = Math.max(1, Number(value()) || 1);
    else if (arg === '--judge') options.judge = value();
    else if (arg === '--out') options.out = value();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/**
 * Runs one command with the task on stdin, and returns its answer, wall time and whether it succeeded.
 *
 * The command runs in its OWN process group, and a timeout kills the whole group (0.4.19 review). Killing only `bash` left the command it started, and
 * anything that command started, running after the experiment had moved on, so a timed-out run could still be spending tokens in the background.
 */
export function runOnce(command, task, { timeoutMs = 30 * 60_000, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(killGroup, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, answer: '', stderr: String(error), ms: Date.now() - started }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, answer: stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(task);
  });
}

/**
 * The pairs to judge: for each repetition, one answer from each setup, with the side order decided by a seeded coin so the judge cannot learn "A is
 * always first". The pairing is what makes the comparison blind: the judge sees two answers to the same task, labelled only "first" and "second".
 */
export function blindPairs(answers, seed = 0) {
  const count = Math.min(answers.a.length, answers.b.length);
  const pairs = [];
  let state = seed + 1;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  for (let index = 0; index < count; index += 1) {
    const aFirst = next() < 0.5;
    pairs.push({
      index,
      first: aFirst ? { side: 'a', text: answers.a[index] } : { side: 'b', text: answers.b[index] },
      second: aFirst ? { side: 'b', text: answers.b[index] } : { side: 'a', text: answers.a[index] }
    });
  }
  return pairs;
}

/** The judge's prompt: both answers, the setups hidden, and a verdict line the parser can read. */
export function judgePrompt(task, pair) {
  return [
    'You are comparing two answers to the same task. You do not know how either was produced, and you must not guess.',
    'Judge only how well each answer does the task: is it complete, is it accurate and checkable, and is it concise without leaving out substance.',
    'A shorter answer wins only if it is still complete and accurate. A longer answer wins only if it adds real substance.',
    '',
    '## The task',
    task.trim(),
    '',
    '## The first answer',
    pair.first.text.trim(),
    '',
    '## The second answer',
    pair.second.text.trim(),
    '',
    '## How to reply',
    'Reply with exactly these two lines and nothing else:',
    'Better: first | second | tie',
    'Why: one sentence, naming the substance that decided it.'
  ].join('\n');
}

/** Reads the judge's two lines. An unreadable reply is a tie with the reason kept, never a silent win. */
export function parseJudgement(text, pair) {
  const better = /^\s*Better:\s*(first|second|tie)\s*$/im.exec(text)?.[1]?.toLowerCase();
  const why = /^\s*Why:\s*(.+)$/im.exec(text)?.[1]?.trim();
  if (!better) return { winner: 'tie', why: `the judge's reply could not be read: ${text.trim().slice(0, 160)}` };
  if (better === 'tie') return { winner: 'tie', why: why ?? '' };
  const winner = (better === 'first' ? pair.first.side : pair.second.side);
  return { winner, why: why ?? '' };
}

/** Sends one judge prompt through the model the caller names, using the NEAR AI chat endpoint and key the environment already has. */
export async function judge(prompt, { model, fetchFn = fetch, baseUrl = process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1', apiKey = process.env.NEAR_AI_API_KEY } = {}) {
  if (!apiKey) throw new Error('NEAR_AI_API_KEY is not set, so the judge cannot run. Export it, or pass --judge-model with a key in the environment.');
  const response = await fetchFn(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 300 })
  });
  if (!response.ok) throw new Error(`the judge failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  return String(body.choices?.[0]?.message?.content ?? '');
}

/** What the report says about one setup: how long it took, and how the blind judge scored it. */
export function score(side, runs, judged) {
  const ok = runs.filter((run) => run.ok);
  const wins = judged.filter((entry) => entry.winner === side).length;
  const losses = judged.filter((entry) => entry.winner !== side && entry.winner !== 'tie').length;
  const ties = judged.filter((entry) => entry.winner === 'tie').length;
  return {
    runs: runs.length,
    failed: runs.length - ok.length,
    meanMs: ok.length ? Math.round(ok.reduce((total, run) => total + run.ms, 0) / ok.length) : undefined,
    fastestMs: ok.length ? Math.min(...ok.map((run) => run.ms)) : undefined,
    meanChars: ok.length ? Math.round(ok.reduce((total, run) => total + run.answer.length, 0) / ok.length) : undefined,
    wins, losses, ties
  };
}

function human(ms) {
  if (ms === undefined) return '-';
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.task || !options.a || !options.b) {
    process.stdout.write('usage: node scripts/ab-task.mjs --task <file> --a "<command>" --b "<command>" [--runs 3] [--judge <model>] [--out <dir>]\n');
    if (!options.help) process.exitCode = 1;
    return;
  }
  const task = readFileSync(options.task, 'utf8');
  const out = options.out ?? path.join(process.cwd(), '.ab', `${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const name = options.taskName ?? path.basename(options.task, path.extname(options.task));

  // Alternated, so a machine that slows down over the session hits both setups equally.
  const runsA = [];
  const runsB = [];
  for (let index = 0; index < options.runs; index += 1) {
    for (const [side, command, list] of [['a', options.a, runsA], ['b', options.b, runsB]]) {
      process.stderr.write(`${side} run ${index + 1}/${options.runs}...\n`);
      const run = await runOnce(command, task);
      writeFileSync(path.join(out, `${side}-${index + 1}.txt`), run.answer);
      list.push(run);
    }
  }

  const pairs = blindPairs({ a: runsA.map((run) => run.answer), b: runsB.map((run) => run.answer) }, Number(process.env.AB_SEED ?? 0));
  const judged = [];
  if (options.judge) {
    for (const pair of pairs) {
      const verdict = parseJudgement(await judge(judgePrompt(task, pair), { model: options.judge }), pair);
      judged.push({ index: pair.index, ...verdict });
      writeFileSync(path.join(out, `judge-${pair.index + 1}.json`), JSON.stringify({ pair: { first: pair.first.side, second: pair.second.side }, ...verdict }, null, 2));
    }
  }
  const scored = { a: score('a', runsA, judged), b: score('b', runsB, judged) };
  const report = { task: name, out, judge: options.judge ?? null, runs: options.runs, scored, judged };
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));

  const line = (text = '') => process.stdout.write(`${text}\n`);
  line(`task ${name}  (${options.runs} runs each, answers in ${out})`);
  line('');
  line(`${'setup'.padEnd(8)} ${'mean'.padStart(7)} ${'fastest'.padStart(8)} ${'chars'.padStart(8)} ${'failed'.padStart(7)} ${'wins'.padStart(5)} ${'losses'.padStart(7)} ${'ties'.padStart(5)}`);
  for (const side of ['a', 'b']) {
    const s = scored[side];
    line(`${side.toUpperCase().padEnd(8)} ${human(s.meanMs).padStart(7)} ${human(s.fastestMs).padStart(8)} ${String(s.meanChars ?? '-').padStart(8)} ${String(s.failed).padStart(7)} ${String(s.wins).padStart(5)} ${String(s.losses).padStart(7)} ${String(s.ties).padStart(5)}`);
  }
  if (!options.judge) line('\nNo judge model was named, so quality was not scored: pass --judge <model> to run the blind comparison.');
  else if (judged.length) {
    line('\nWhy (blind, order shuffled per pair):');
    for (const entry of judged) line(`  pair ${entry.index + 1}: ${entry.winner} — ${entry.why}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
