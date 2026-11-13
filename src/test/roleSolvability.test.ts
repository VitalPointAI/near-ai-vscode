// Every role's task must be SOLVABLE: a correct answer must score full marks on the real grader. This is the test the fixture bug needed and did not have: the
// shop tests demanded the discount at exactly the threshold while the brief demanded strictly above, so the implementer task was unsatisfiable and every model
// was measured on an impossible task (0.4.19 review).
//
// Each case below is a golden answer written by hand, the way a good agent would answer, and graded by the SAME grader the comparison uses. If a task becomes
// contradictory again, this fails.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gradeRoleAnswer } from '../benchmark/roleGraders';
import { ROLE_TASKS } from '../benchmark/roleTasks';

/** A folder holding the task's own fixtures, plus the answer this test writes over them. */
async function solve(taskRole: string, answers: Record<string, string>): Promise<{ root: string; files: Record<string, string> }> {
  const task = ROLE_TASKS.find((entry) => entry.role === taskRole);
  assert.ok(task, `${taskRole} has a task`);
  const root = await mkdtemp(path.join(tmpdir(), `near-ai-solve-${taskRole}-`));
  for (const [name, content] of Object.entries(task.files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  for (const [name, content] of Object.entries(answers)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return { root, files: task.files };
}

const solves: Array<[string, Record<string, string>]> = [
  ['planner', {
    'plan.md': '1. In shop.js, apply the discount to the subtotal before tax rather than to the taxed total (line 4 to line 6).\n2. In shop.js, change the threshold test from >= to > so exactly at the threshold gets no discount (line 5).\n'
  }],
  ['implementer', {
    // A correct fix: discount the SUBTOTAL, only when strictly above the threshold, and round once at the end.
    'shop.js': 'export function totalAfterTax(items, taxRate, discountThreshold) {\n  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n  const discounted = subtotal > discountThreshold ? subtotal * 0.9 : subtotal;\n  return Math.round(discounted * (1 + taxRate) * 100) / 100;\n}\n'
  }],
  ['reviewer', {
    'review.md': '1. High: shop.js line 4 discounts `taxed`, so the discount is applied AFTER tax; BRIEF.md requires the subtotal to be discounted before tax.\n2. Medium: shop.js line 5 uses `>= discountThreshold`, so an order exactly at the threshold is discounted, which BRIEF.md forbids.\n'
  }],
  ['security', {
    'findings.md': '1. Critical: server.js line 3 runs `execSync(\'ping -c 1 \' + host)` with the `host` query parameter, so a value like `; rm -rf /` runs arbitrary commands. Fix: validate the host or use execFile with an argument array.\n2. High: server.js line 6 hardcodes the secret `sk-live-...` in source. Fix: read it from the environment.\n'
  }],
  ['researcher', {
    'brief.md': 'The Port of Kestrel handled 4.2 million TEU in 2025, up 6 percent on 2024 [s1-ministry.md]. Berth B7 opened in March 2025 [s1-ministry.md]. The sources disagree on the volume: Trade Weekly reports 3.1 million TEU for last year [s2-trade-weekly.md], against the ministry figure [s1-ministry.md]. Halden Ports announced a 1.5 billion euro expansion to finish by 2028 [s2-trade-weekly.md]. The football source is unrelated to the port [s3-sport.md].\n'
  }],
  ['analyst', {
    'analysis.md': 'Recommendation: choose Vendor A. The decisive reason is that certified for medical use is mandatory, and only Vendor A is certified. What is uncertain is Vendor B\'s speed, which is the vendor\'s own marketing rather than an independent test. Confidence: high on the certification, low on the relative speed.\n'
  }],
  ['writer', {
    'proposal.md': 'The contract requires delivery within 90 days [c1]. Only two suppliers hold the certification [c2]. The budget ceiling is GBP 240,000 [c1].\n'
  }],
  ['editor', {
    'edited.md': '# Proposal\n\nThe system processes a request in 1.4 seconds, from the September benchmark. It is SOC 2 Type II compliant. The contract award is expected in November.\n',
    'changes.md': 'Corrected the processing time to 1.4 seconds, replaced the unsupported "fully compliant with all applicable regulations" with the SOC 2 Type II certification the sources support, and softened the award date to expected.\n'
  }],
  ['plagiarism-checker', {
    'INTEGRITY-CHECK.md': '# Integrity check of draft.md\n\n1. Verbatim: "Engineers designed the barrier to withstand a one-in-two-hundred-year flood event while allowing river traffic to pass freely during normal conditions" is copied word for word from sources/s1-agency.md, unquoted and with no note. Fix: quote it with a note, or rewrite it in your own words and cite it.\n2. Note [^2] is a bare URL, not a Chicago 18 note: it needs the author, title, site, date, and URL, and the source must be checked. Fix: write the full note.\n\nNOT CLEAN\n'
  }],
  ['red-team', {
    'attacks.md': '1. A input with no unit, such as "30", makes the regex return null and the function throws, so a request for parseDuration with "30" returns a 500.\n2. An unknown unit, such as "30x", multiplies by undefined and returns NaN, so a query parameter can return NaN to the caller.\n'
  }]
];

for (const [role, answers] of solves) {
  test(`the ${role} task is solvable: a correct answer scores full marks`, async () => {
    const task = ROLE_TASKS.find((entry) => entry.role === role)!;
    const { root, files } = await solve(role, answers);
    const grade = gradeRoleAnswer(role, root, files, task.kind, task.role);
    assert.deepEqual(grade.misses, [], `a correct ${role} answer must pass every check; it missed: ${grade.misses.join(', ')}`);
    assert.equal(grade.score, grade.outOf);
  });
}

test('the tester task is solvable by adding the tests that catch both bugs, without fixing the code', async () => {
  const task = ROLE_TASKS.find((entry) => entry.role === 'tester')!;
  const extra = `${task.files['shop.test.js'] as string}\ntest('does not discount at exactly the threshold', () => {\n  assert.equal(totalAfterTax([{ price: 50, quantity: 2 }], 0, 100), 100);\n});\ntest('discounts the subtotal before tax, at 120', () => {\n  assert.equal(totalAfterTax([{ price: 120, quantity: 1 }], 0.1, 100), 118.8);\n});\n`;
  const { root, files } = await solve('tester', { 'shop.test.js': extra });
  const grade = gradeRoleAnswer('tester', root, files, task.kind, task.role);
  assert.deepEqual(grade.misses, [], `missed: ${grade.misses.join(', ')}`);
});
