// A `node:test` custom reporter that writes one JSON line per leaf test: the per-test report scripts/run-tests.mjs writes when NEAR_AI_TEST_REPORT
// is set (Phase 44, D-22 and D-46). The compliance collectors read these lines as `TestReportRow` (compliance/src/model.ts), so the field names
// and values below are a contract: change them only together with that reader.
//
// Each line: { file, path, name, status, skip, ms }
// - file: the test file relative to the working directory, with forward slashes ('' when Node gives no file)
// - path: the names of the suites around the test, outermost first ([] at the top level)
// - name: the test's own name
// - status: 'failed' for a test that failed (cancelled tests included), otherwise 'skipped' when it was skipped, 'todo' when it is marked todo,
//   else 'passed'
// - skip: the skip reason for a skipped test given one, otherwise null
// - ms: the duration Node measured, in milliseconds
//
// Suites (describe, or a test whose subtests ran) are not rows of their own: a suite's result is the results of the tests in it.
import path from 'node:path';

/** The file as the report names it: relative to the working directory, forward slashes. */
const reportFile = (file) => (file ? path.relative(process.cwd(), file).split(path.sep).join('/') : '');

export default async function* testReportReporter(source) {
  // The names of the tests open at each nesting level, per file: files run in processes of their own and their events can interleave.
  const open = new Map();
  for await (const event of source) {
    const data = event.data;
    if (event.type === 'test:start') {
      const stack = open.get(data.file) ?? [];
      stack.length = data.nesting;
      stack.push(data.name);
      open.set(data.file, stack);
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    if (data.details?.type === 'suite') continue;
    const stack = open.get(data.file) ?? [];
    const status = event.type === 'test:fail' ? 'failed' : data.skip ? 'skipped' : data.todo ? 'todo' : 'passed';
    const row = {
      file: reportFile(data.file),
      path: stack.slice(0, data.nesting),
      name: data.name,
      status,
      skip: status === 'skipped' && typeof data.skip === 'string' ? data.skip : null,
      ms: typeof data.details?.duration_ms === 'number' ? data.details.duration_ms : 0,
    };
    yield `${JSON.stringify(row)}\n`;
  }
}
