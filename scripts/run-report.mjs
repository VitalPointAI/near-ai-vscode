// PERF-07: prints where a project's agent runs spent their time, from its activity history (.planning/.near-ai/activity.json).
//
// Usage (after `npm run compile`):
//   npm run report:runs -- <path/to/activity.json> [more.json …]
//   npm run report:runs -- --json <path/to/activity.json>
//
// Reads only; never writes the log. The same report opens in VS Code with "NEAR AI: Show Run Performance Report".
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { runPerformanceReport, formatRunReport } = require(path.join(here, '..', 'dist', 'services', 'runReport.js'));

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => arg !== '--json');
if (!files.length) {
  console.error('Usage: npm run report:runs -- [--json] <activity.json> [more.json …]');
  process.exit(2);
}
for (const file of files) {
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const project = ledger.sessions?.[0]?.project ?? path.basename(path.dirname(path.dirname(path.dirname(path.resolve(file)))));
  const report = runPerformanceReport(ledger, project);
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatRunReport(report)}\n`);
}
