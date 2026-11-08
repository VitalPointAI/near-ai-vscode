// Reports what a set of runs cost in time and tokens, from the spend ledgers the extension already keeps, so a change to models, briefs or routing is
// judged on numbers instead of impressions (owner, 2026-11-07: "run some experiments that show whether we can reduce cost without reducing effectiveness").
//
// Usage:
//   node scripts/spend-report.mjs                       # the last 7 days of every ledger this machine has
//   node scripts/spend-report.mjs --days 30
//   node scripts/spend-report.mjs --dir <globalStorage>/spend
//   node scripts/spend-report.mjs --since 2026-11-07    # a cutoff an A/B experiment can compare against
//
// The ledger is append-only JSONL, one pair of lines per model request: an opening line (model, kind, agent, run, estimate) and a closing line
// (input, cached input, output tokens, end time). Nothing here writes anything.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const COST_DIVISOR = 1e9;

function parseArgs(argv) {
  const options = { days: 7, dir: undefined, since: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--days') options.days = Number(argv[++index]);
    else if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--since') options.since = argv[++index];
    else if (arg === '--help' || arg === '-h') { options.help = true; }
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/** Every spend ledger this machine has, newest folder first, unless one is named. */
function ledgerFiles(options) {
  if (options.dir) {
    return readdirSync(options.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readdirSync(path.join(options.dir, entry.name))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => path.join(options.dir, entry.name, name)));
  }
  const candidates = [
    path.join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'vitalpoint.near-ai-vscode', 'spend'),
    path.join(homedir(), '.config', 'Code - Insiders', 'User', 'globalStorage', 'vitalpoint.near-ai-vscode', 'spend'),
    path.join(homedir(), '.local', 'share', 'code-server', 'User', 'globalStorage', 'vitalpoint.near-ai-vscode', 'spend'),
    path.join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'vitalpoint.near-ai-vscode', 'spend'),
    path.join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'vitalpoint.near-ai-vscode', 'spend')
  ];
  const found = [];
  for (const folder of candidates) {
    let entries;
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      for (const name of readdirSync(path.join(folder, entry.name))) {
        if (name.endsWith('.jsonl')) found.push(path.join(folder, entry.name, name));
      }
    }
  }
  return found;
}

/** One record per model request: opened by line v1, closed by line v2. */
export function readRequests(files) {
  const requests = new Map();
  const files_ = [];
  for (const file of files) {
    files_.push({ file, mtime: statSync(file).mtimeMs });
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.t !== 'e' || typeof row.id !== 'string') continue;
      const entry = requests.get(row.id) ?? { id: row.id };
      if (row.v === 1) {
        entry.at = row.at;
        entry.model = row.model;
        entry.kind = row.kind ?? 'main';
        entry.run = row.run;
        entry.agent = row.agent;
        entry.estimate = row.est;
      } else {
        entry.end = row.end;
        entry.status = row.st;
        entry.input = row.in ?? 0;
        entry.cached = row.cin ?? 0;
        entry.output = row.out ?? 0;
        if (row.est !== undefined) entry.estimate = row.est;
      }
      requests.set(row.id, entry);
    }
  }
  return { requests: [...requests.values()], files: files_ };
}

const sum = (list, key) => list.reduce((total, item) => total + (item[key] ?? 0), 0);
const minutes = (ms) => ms / 60_000;
const share = (part, whole) => (whole ? `${((100 * part) / whole).toFixed(1)}%` : '-');

/** The report, as plain data, so tests can assert on it and an experiment can diff two of them. */
export function summarise(requests, options = {}) {
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  const days = options.days ?? 7;
  const cutoff = since ?? (days === Infinity ? 0 : Date.now() - days * 86_400_000);
  const done = requests.filter((entry) => entry.at !== undefined && entry.end !== undefined && entry.at >= cutoff);
  const by = (key) => {
    const groups = new Map();
    for (const entry of done) {
      const name = entry[key] ?? '?';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(entry);
    }
    return [...groups.entries()].map(([name, list]) => ({
      name,
      requests: list.length,
      input: sum(list, 'input'),
      cached: sum(list, 'cached'),
      output: sum(list, 'output'),
      cost: sum(list, 'estimate') / COST_DIVISOR,
      modelMs: sum(list, 'end') > 0 ? list.reduce((total, entry) => total + (entry.end - entry.at), 0) : 0
    })).sort((a, b) => b.cost - a.cost);
  };
  const finished = done.length === 0 ? 1 : done.length;
  return {
    window: { cutoff: new Date(cutoff).toISOString(), requests: done.length },
    totals: {
      input: sum(done, 'input'),
      cached: sum(done, 'cached'),
      output: sum(done, 'output'),
      cost: sum(done, 'estimate') / COST_DIVISOR,
      modelMinutes: minutes(done.reduce((total, entry) => total + (entry.end - entry.at), 0)),
      meanSeconds: done.reduce((total, entry) => total + (entry.end - entry.at), 0) / finished / 1000,
      secondsPerThousandOutput: (() => {
        const withOutput = done.filter((entry) => entry.output > 0);
        if (!withOutput.length) return undefined;
        const rates = withOutput.map((entry) => ((entry.end - entry.at) / 1000 / entry.output) * 1000).sort((a, b) => a - b);
        return rates[Math.floor(rates.length / 2)];
      })()
    },
    byKind: by('kind'),
    byModel: by('model'),
    byRun: by('run').slice(0, 15)
  };
}

function print(report, sources) {
  const { totals } = report;
  const line = (text = '') => process.stdout.write(`${text}\n`);
  line(`window  ${report.window.requests} finished requests since ${report.window.cutoff}`);
  line(`ledgers ${sources.length}`);
  line();
  line(`total        $${totals.cost.toFixed(2)}`);
  line(`input        ${totals.input.toLocaleString()} tokens, ${totals.cached.toLocaleString()} of them cached (${share(totals.cached, totals.input)})`);
  line(`output       ${totals.output.toLocaleString()} tokens`);
  line(`model time   ${totals.modelMinutes.toFixed(0)} min, mean ${totals.meanSeconds.toFixed(1)}s per request`);
  if (totals.secondsPerThousandOutput !== undefined) line(`speed        ${totals.secondsPerThousandOutput.toFixed(1)}s per 1,000 output tokens (median)`);
  line();
  for (const [title, rows] of [['by kind', report.byKind], ['by model', report.byModel], ['by run', report.byRun]]) {
    line(`--- ${title} ---`);
    line(`${'name'.padEnd(30)} ${'reqs'.padStart(5)} ${'$'.padStart(8)} ${'input'.padStart(12)} ${'cached'.padStart(7)} ${'output'.padStart(10)} ${'min'.padStart(6)}`);
    for (const row of rows) {
      line(`${String(row.name).slice(0, 30).padEnd(30)} ${String(row.requests).padStart(5)} ${row.cost.toFixed(2).padStart(8)} ${row.input.toLocaleString().padStart(12)} ${share(row.cached, row.input).padStart(7)} ${row.output.toLocaleString().padStart(10)} ${minutes(row.modelMs).toFixed(0).padStart(6)}`);
    }
    line();
  }
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('node scripts/spend-report.mjs [--days N] [--dir <spend folder>] [--since YYYY-MM-DD]\n');
  } else {
    const files = ledgerFiles(options);
    if (!files.length) {
      process.stderr.write('No spend ledgers found. Pass --dir with the extension\'s globalStorage/spend folder.\n');
      process.exitCode = 1;
    } else {
      const { requests } = readRequests(files);
      print(summarise(requests, options), files);
    }
  }
}
