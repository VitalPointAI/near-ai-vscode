import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { scanLine } from '../../scripts/lib/workflow.mjs';
import type { Observation, TestReportRow } from './model.ts';

const ID = /^[a-z0-9][a-z0-9._/@:-]{0,127}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const COUNT = /^[a-z][a-z0-9-]{0,31}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const githubRun = (value: unknown): value is string => typeof value === 'string' && value.startsWith('https://github.com/');

/** Reduce an observation to the D-24 allow-list, refusing malformed identifiers. */
export function redactObservation(value: Observation): Observation {
  if (!ID.test(value.collector) || !ID.test(value.subject) || !ISO.test(value.collectedAt)) throw new Error('observation contains an unsafe id, subject, or time');
  if (value.commit !== undefined && !COMMIT.test(value.commit)) throw new Error('observation contains an unsafe commit');
  if (value.hash !== undefined && !HASH.test(value.hash)) throw new Error('observation contains an unsafe hash');
  const counts = value.counts === undefined ? undefined : Object.fromEntries(Object.entries(value.counts).map(([key, count]) => {
    if (!COUNT.test(key) || !Number.isSafeInteger(count) || count < 0) throw new Error('observation contains an unsafe count'); return [key, count];
  }));
  return { collector: value.collector, subject: value.subject, passed: value.passed === true, collectedAt: value.collectedAt,
    ...(value.commit ? { commit: value.commit } : {}), ...(githubRun(value.runUrl) ? { runUrl: value.runUrl } : {}), ...(counts ? { counts } : {}), ...(value.hash ? { hash: value.hash } : {}) };
}

export function redactTestRow(value: TestReportRow): TestReportRow {
  if (!value || typeof value.file !== 'string' || !value.file || typeof value.name !== 'string' || !value.name ||
    !Array.isArray(value.path) || !value.path.every((part) => typeof part === 'string') ||
    !['passed', 'failed', 'skipped', 'todo'].includes(value.status) ||
    (value.skip !== null && typeof value.skip !== 'string') || !Number.isFinite(value.ms)) {
    throw new Error('unsafe test row');
  }
  return { file: value.file, path: [...value.path], name: value.name, status: value.status, skip: value.skip, ms: value.ms };
}

/** Scan every output line with the repository's secret detector. */
export function assertNoSecrets(dir: string): void {
  const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name); if (entry.isDirectory()) return walk(file); if (!entry.isFile() || entry.isSymbolicLink()) return []; return [file];
  });
  for (const file of walk(dir)) for (const [index, line] of readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    const finding = scanLine(line); if (finding.length > 0) throw new Error(`${path.relative(dir, file)}:${index + 1}: secret rule ${finding.join(', ')}`);
  }
}
