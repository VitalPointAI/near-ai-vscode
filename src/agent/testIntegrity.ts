import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { RunCheckpoints } from './checkpoints';

// Weakening a test the agent was given (deleting an assertion, skipping a case) makes failing work
// look finished. In the model eval a cheaper model did exactly that, so the loop checks every test
// file an agent edits against its state before the run, and says so when it got weaker.

const TEST_FILE = /(?:^|[\\/])(?:tests?|__tests__|spec)[\\/]|[._-](?:test|spec)\.[cm]?[jt]sx?$|(?:^|[\\/])test_[^\\/]+\.py$|_test\.(?:py|go)$|Tests?\.(?:java|kt|cs)$/i;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

export interface TestStrength { tests: number; assertions: number; skipped: number }

/** Counts test cases, assertions, and skipped cases; only comparisons between versions of one file mean anything. */
export function testStrength(source: string): TestStrength {
  const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
  return {
    tests: count(/\b(?:test|it)(?:\.(?:only|concurrent|each\b[^(]*))?\s*\(|^\s*(?:async\s+)?def test_\w*|\bfunc Test\w*\(|#\[test\]|@Test\b/gm),
    assertions: count(/\b(?:assert\w*|expect|should)\b|\bt\.(?:is|not|equal|deepEqual|ok|true|false|throws\w*|regex|snapshot)\b/g),
    skipped: count(/\b(?:test|it|describe)\.(?:skip|todo)\b|\bx(?:it|describe|test)\s*\(|@(?:pytest\.mark\.skip|Disabled|Ignore)\b|\bt\.Skip\(|\{\s*skip\s*:\s*true/g)
  };
}

export interface WeakenedTest { file: string; before: TestStrength; after: TestStrength }

export function weakened(before: TestStrength, after: TestStrength): boolean {
  return after.tests < before.tests || after.assertions < before.assertions || after.skipped > before.skipped;
}

/** Test files among `files` that existed before the run and now have fewer tests or assertions, or more skipped. */
export async function weakenedTests(checkpoints: RunCheckpoints, files: Iterable<string>): Promise<WeakenedTest[]> {
  const found: WeakenedTest[] = [];
  for (const file of files) {
    if (!isTestFile(file)) continue;
    const original = checkpoints.original(file);
    if (original === undefined || original === null) continue;
    const now = await readFile(file, 'utf8').catch(() => '');
    const before = testStrength(original);
    const after = testStrength(now);
    if (weakened(before, after)) found.push({ file, before, after });
  }
  return found;
}

export function describeWeakened(found: WeakenedTest[], root: string): string {
  return found.map(({ file, before, after }) => {
    const changes = [
      after.tests < before.tests ? `tests ${before.tests} → ${after.tests}` : '',
      after.assertions < before.assertions ? `assertions ${before.assertions} → ${after.assertions}` : '',
      after.skipped > before.skipped ? `skipped ${before.skipped} → ${after.skipped}` : ''
    ].filter(Boolean).join(', ');
    return `${path.relative(root, file) || file} (${changes})`;
  }).join('; ');
}
