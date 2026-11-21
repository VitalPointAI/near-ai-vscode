#!/usr/bin/env node
// Makes the per-test report fixtures of the tests collector (44-07) with the repository's real runner and reporter, so the fixtures have exactly
// the shape scripts/test-report-reporter.mjs writes (44-02).
//
//   node compliance/test/fixtures/collectors/tests/make-report.mjs [out-dir]
//
// It copies ../checkout/src/test/sample.test.ts into a scratch package as compiled files would sit (dist/test/sample.test.js for the root report;
// dist/test/a.test.js and dist/test/container/b.test.js for the relay report), runs scripts/run-tests.mjs there with NEAR_AI_TEST_REPORT set, and
// writes root.ndjson and relay.ndjson into out-dir (default: this folder). The runs exit 1 because the sample holds a test that fails on purpose;
// a run that wrote no rows is an error. The ms field is set to 0 so the fixtures do not change between runs.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const runner = path.join(repoRoot, 'scripts', 'run-tests.mjs');
const sample = path.join(here, '..', 'checkout', 'src', 'test', 'sample.test.ts');
const outDir = path.resolve(process.argv[2] ?? here);

/** Runs the sample at each of the given compiled paths inside a scratch package and returns the report text. */
function report(compiledPaths) {
  const scratch = mkdtempSync(path.join(tmpdir(), 'near-ai-compliance-report-'));
  try {
    writeFileSync(path.join(scratch, 'package.json'), '{ "type": "module" }\n');
    for (const rel of compiledPaths) {
      mkdirSync(path.dirname(path.join(scratch, rel)), { recursive: true });
      copyFileSync(sample, path.join(scratch, rel));
    }
    const reportFile = path.join(scratch, 'out', 'report.ndjson');
    const env = { ...process.env, NEAR_AI_TEST_REPORT: reportFile };
    // This generator is itself run from a test. scripts/run-tests.mjs gives its test children a
    // disposable TMPDIR; a nested runner must not create its own run directory under that parent,
    // because its cleanup can race the fixture report read below. Let the nested runner use the OS
    // temporary location, then this generator still removes its own scratch directory in finally.
    delete env.TMPDIR;
    delete env.TEMP;
    delete env.TMP;
    delete env.NEAR_AI_SAMPLE_EXTRA;
    const run = spawnSync(process.execPath, [runner, ...compiledPaths], { cwd: scratch, env, encoding: 'utf8' });
    if (run.error) throw run.error;
    const lines = readFileSync(reportFile, 'utf8').split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) throw new Error(`the run of ${compiledPaths.join(', ')} wrote no report rows (exit ${run.status})`);
    const rows = lines.map((line) => ({ ...JSON.parse(line), ms: 0 }));
    // Files run in processes of their own, so their rows can interleave; sort by file and keep each file's own order.
    rows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    return rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'root.ndjson'), report(['dist/test/sample.test.js']));
writeFileSync(path.join(outDir, 'relay.ndjson'), report(['dist/test/a.test.js', 'dist/test/container/b.test.js']));
console.log(`Wrote root.ndjson and relay.ndjson to ${outDir}`);
