---
status: awaiting_human_verify
trigger: "Unbounded memory growth: node dist/test/boardDetail.test.js (all 14 tests) hits a 400 MB heap OOM in about 5 s; the OOM killer took VS Code down several times. Each test alone does not OOM."
created: 2026-11-02T21:10:00Z
updated: 2026-11-02T21:32:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic: the same single test grows to GBs every run)
hypothesis: CONFIRMED. A failing strict assertion with a FakeNode operand makes Node 24 inspect the node at depth 1000 and myers-diff the lines; FakeNode's enumerable doc/parentNode/childNodes links made that output quadratic in page size, and myersDiff is quadratic in lines, so memory exploded
next_action: owner confirms that the board test files (or the full suite, capped) run in their VS Code without memory growth; then archive this session to resolved/ and append the knowledge-base entry
fix_commit: 2ea8397 (harness and regression test); trigger removed in 7d0cd27 (Edit absent for imported items); plan 62-12 closed in 13457b4 and 96df8cf

reasoning_checkpoint:
  hypothesis: "The OOM is the AssertionError for assert.equal(buttonNamed(drawer(h), 'Edit'), undefined, ...) in the 'facts are a definition list' test. detail.js keeps a hidden Edit button for an imported item (detail.js:112), so actual is a FakeNode; Node 24 inspects it with depth 1000 and getters, FakeNode's enumerable doc/parentNode/childNodes (fakeDom.ts:138-145, 159) pull the whole document in again from every node on the path, giving hundreds of thousands to millions of lines, and myersDiff clones an Int32Array(2L+1) per diff level, about 8 x L^2 bytes."
  confirming_evidence:
    - "Step replay of the hog test with no assertions stays at 59-82 MB RSS; the only mismatch is the hidden Edit node"
    - "Node 24 strict assert with a custom message still appends the inspect diff (direct experiment)"
    - "util.inspect of FakeNodes with the AssertionError options: 1,509 lines (detached button), 374,757 lines / 21 MB (95-node page)"
    - "Node's myers_diff.js:47-51 allocates and clones Int32Array(2*max+1) per level, no size guard; the failure is 'Array buffer allocation failed' with 'external memory pressure'"
  falsification_test: "After making the links non-enumerable, the same failing assertion (hidden Edit node vs undefined) must produce a message of a few dozen lines and the hog test must stay under about 100 MB RSS while still failing on its assertion. If RSS still climbs, the hypothesis is wrong."
  fix_rationale: "The amplifier is the harness: any failing assertion on any FakeNode in any board test can take the machine down, and TDD RED phases fail assertions on purpose. Hiding the tree links from util.inspect (non-enumerable own properties; assert's inspect uses showHidden false and customInspect false, so util.inspect.custom cannot help) bounds the message to the node's own fields. The trigger (Edit hidden instead of absent) is fixed separately as Task 2 behaviour."
  blind_spots: "Other objects that hold nodes enumerably (FakeDocument.html/head/body/activeElement, FakeEvent.target) are still inspectable, but each node they reach is now small. deepStrictEqual of two distinct FakeNodes would now ignore the hidden links; no board test compares distinct nodes structurally (grep)."
  candidate_causes:
    - "code (test harness): FakeNode enumerable graph links make util.inspect output quadratic in page size"
    - "environment: Node v24 assert inspects and myers-diffs actual even with a custom message, with no size guard, and allocates O(L^2) ArrayBuffers"
    - "code (product, trigger only): detail.js hides Edit for imported items instead of leaving it out, so the RED assertion fails with a node operand"
  and_gate: "yes: the explosion needs (1) a failing strict assertion with a FakeNode operand AND (2) the harness's enumerable links AND (3) Node 24's unguarded inspect plus myers diff. (3) cannot be changed; (1) happens on purpose in TDD; (2) is the one to fix. The product trigger is fixed too as part of Task 2."

## Symptoms

expected: dist/test/boardDetail.test.js runs all 14 tests to completion with bounded memory
actual: 400 MB heap OOM in about 5 s ("external memory pressure", heap retained about 200 MB)
errors: V8 heap out of memory under --max-old-space-size=400
reproduction: (ulimit -v 4000000; NODE_OPTIONS=--max-old-space-size=400 timeout 60 node dist/test/boardDetail.test.js)
started: with the uncommitted Task 2 work in media/board/detail.js (plan 62-12)

## Eliminated

- hypothesis: leaked harness timers from earlier tests keep firing and growing state
  evidence: the fake timers only run inside h.advance(); no boardDetail test calls advance. Each test is its own vm context; 13 of 14 tests alone peak at 56-84 MB and the hog test alone reproduces the growth, so nothing is carried between tests
  timestamp: 2026-11-02T21:16:00Z

- hypothesis: board.js place() loop (board.js:104) never terminates because remove() does not detach
  evidence: FakeNode.remove() calls parent.detach(this), which splices it out of parent.childNodes; the node taken from parent.children always has that parent. The step replay drew, opened and closed with flat 59-82 MB RSS
  timestamp: 2026-11-02T21:16:00Z

- hypothesis: detail.js render listener re-renders or appends nodes on every render (or focus handlers re-render)
  evidence: detail.js onRender only calls renderHead, post, close(false), syncSelection and focus; none calls render(). board.js focusin only calls applyRoving. The step replay through the whole hog test stays at 82 MB
  timestamp: 2026-11-02T21:16:00Z

## Evidence

- timestamp: 2026-11-02T21:14:00Z
  checked: each of the 14 tests alone, capped (ulimit -v 4000000, heap 400 MB), with /usr/bin/time max RSS
  found: 13 tests peak at 56-84 MB RSS in about 0.1 s. "facts are a definition list..." alone peaks at 2,636,204 KB RSS and takes 4.72 s, then reports a plain assertion failure (exit 1, no OOM because the growth is mostly outside the 400 MB V8 old space)
  implication: the growth is inside one test, not state carried between tests; the full-file OOM is this test's spike plus the heap kept by the tests before it. The earlier "needs several tests" reading was wrong.

- timestamp: 2026-11-02T21:15:00Z
  checked: the hog test alone with the TAP reporter, then the spec reporter, capped
  found: TAP run ends "RangeError: Array buffer allocation failed" thrown inside the test after 5.5 s; the spec run aborts with "Mark-Compact 200.1 -> 200.1 MB ... external memory pressure ... JavaScript heap out of memory"
  implication: the growth is ArrayBuffer (external) memory plus about 200 MB of live heap, created inside the test body

- timestamp: 2026-11-02T21:16:00Z
  checked: scratch script replaying every step of the hog test without assertions, printing RSS after each step
  found: RSS stays 59-82 MB through every step (world, draw, open chore, Edit click, Escape, open plan:90-01, observer). The only deviation from the test's expectations is "edit2 present? true hidden? true": for the imported plan detail.js keeps the Edit button in the DOM with hidden set (detail.js:112), so buttonNamed(drawer, 'Edit') returns a FakeNode
  implication: product code does not grow memory; the failing assertion assert.equal(<hidden Edit FakeNode>, undefined, 'imported items are not edited here') is where the test blows up

- timestamp: 2026-11-02T21:17:00Z
  checked: node -e assert.equal({a:1,b:{c:2}}, undefined, 'custom message') on Node v24.22.2
  found: the message is "custom message\n+ actual - expected\n\n+ {\n+   a: 1, ..." so strict assert inspects and diffs actual even when a custom message is given
  implication: every failing strict assertion with a FakeNode operand inspects that node

- timestamp: 2026-11-02T21:18:00Z
  checked: util.inspect(FakeNode) with the exact AssertionError options (depth 1000, getters true, customInspect false, compact false, sorted true, maxArrayLength Infinity)
  found: detached button with one child in a bare harness: 1,509 lines. Button under #root, nothing loaded (6 nodes): 2,031 lines. #detail with board.js/menu.js/detail.js loaded but no model (95 nodes): 21,344,608 chars, 374,757 lines, 229 MB RSS. Drawn board has 299 element nodes, depth 16. Own enumerable keys of every FakeNode include doc, parentNode, childNodes, listeners
  implication: inspect output is superlinear (about quadratic) in page size because every node's enumerable doc and parentNode links pull the whole document back in from a fresh path (util.inspect only marks ancestors on the current path as Circular)

- timestamp: 2026-11-02T21:19:00Z
  checked: Node's internal/assert/assertion_error.js createErrDiff (lines 185-235) and internal/assert/myers_diff.js (lines 34-75)
  found: createErrDiff always inspects both sides and, unless the diff is "simple", calls myersDiff(lines). myersDiff allocates v = new Int32Array(2*max+1) and pushes a clone of it for every diff level (line 51); with "undefined" (1 line) on the other side the number of levels is about the number of actual lines. No size guard exists
  implication: memory is about 8 x L^2 bytes for L inspected lines: 18 MB at L=1,509, 1.1 TB requested at L=374,757. That is the external memory growth, the 2.6 GB RSS and "Array buffer allocation failed". Any failing assertion with a FakeNode operand in any board test file (focus checks such as assert.equal(h.focused(), opener) are everywhere) can do this, and an uncapped node --test runs files in parallel, which is how the OOM killer reached VS Code

## Resolution

root_cause: "src/test/helpers/fakeDom.ts FakeNode (fields at lines 138-145 and doc at line 163 before the fix) exposed its tree links doc, parentNode and childNodes as enumerable own properties. Node 24's strict assert prints a failed comparison's operands with util.inspect (depth 1000, getters true, customInspect false) even when a custom message is given, and diffs the lines with myersDiff, which clones an Int32Array(2L+1) per diff level (about 8 x L^2 bytes). Through the enumerable links one node printed the whole page again from every node on its path, so a single failing assertion with a node operand needed gigabytes. The trigger in this incident: the Task 2 RED assertion assert.equal(buttonNamed(drawer(h), 'Edit'), undefined, 'imported items are not edited here') in boardDetail.test.ts, failing because media/board/detail.js:112 hides the Edit button for imported items instead of leaving it out."
fix: "fakeDom.ts makes doc, parentNode, childNodes, listeners and onText non-enumerable own properties (same values, writable, configurable) at the end of the FakeNode constructor. Behaviour is unchanged; a failed assertion now prints about 30 lines of the node's own fields and attributes. The trigger is removed as part of plan 62-12 Task 2 (Edit is left out of the DOM unless the viewer may edit a board item)."
oracle_type: specified (line-count bound on the inspect output and the AssertionError message, plus the structural check that the links are not enumerable)
verification:
  regression_test: "src/test/fakeDom.test.ts: RED before the fix (2 of 2 fail, 56 MB RSS, 0.08 s), GREEN after (2 of 2 pass, 70 MB, 0.13 s)"
  hog_test_alone: "before: 2,636,204 KB RSS, 4.72 s, RangeError Array buffer allocation failed; after: 83,196 KB, 0.17 s, ordinary AssertionError naming the hidden secondary detail-edit button"
  full_file: "before: fatal heap OOM at 400 MB in about 5 s; after: 14 tests complete in 1.19 s at 119 MB (6 Task 2 RED assertion failures, expected at that point)"
  neighbours: "boardClient 24/24, boardMenu 13/13, boardDrag 16/16 pass under the cap after the harness change"
  revert_check: "the RED run of fakeDom.test.ts is the revert check: with the old harness the tripwire fails in milliseconds"
  guardrail_verdict: accepted
files_changed: [src/test/helpers/fakeDom.ts, src/test/fakeDom.test.ts]
commit: 2ea8397
