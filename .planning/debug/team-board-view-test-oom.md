---
status: awaiting_human_verify
trigger: "Unbounded memory growth when the whole compiled test file dist/test/teamBoardView.test.js runs: a child process runs out of memory at about the 18th real-git test under a 1536 MB heap cap; every test passes alone and in partitions; reproduced on the 62-12 code, so it predates 62-13."
created: 2026-11-02T22:00:00Z
updated: 2026-11-02T23:35:00Z
---

## Current Focus

bug_class: Bohrbug (deterministic: the same exact command dies at the same test every run)
hypothesis: CONFIRMED. The process does not run out of memory; it runs out of address space. The 4 GiB PROT_NONE reservation V8 makes for the first WebAssembly memory (undici's llhttp parser, created by the first fetch to the fake NEAR server in createRig) takes 4 of the 5.72 GiB that ulimit -v 6000000 allows; the rest of a normal node process (about 1.4 GB of reserved code range, heap cages and thread stacks) leaves about 270 MB, and V8's ordinary young-generation growth around test 17-18 cannot be mapped
next_action: owner confirms the capped full-file run (and, if wanted, the capped full suite) in their own VS Code session; then archive this session to resolved/ and append the knowledge-base entry

reasoning_checkpoint:
  hypothesis: "Under ulimit -v 6000000 the per-file test process for teamBoardView.test.js dies because V8 reserves 4 GiB of address space (65536 wasm pages) for undici's llhttp memory on the first fetch to the fake NEAR server, so the normal heap growth step at test 17-18 (heapTotal 90 -> 150 MB) fails to mmap and V8 reports a heap OOM; the heap itself is bounded and no test object is retained."
  confirming_evidence:
    - "At death: last GC 42.4 -> 19.3 MB live, RSS 165 MB, VmSize 5,995,176 kB against a 6,000,000 kB limit"
    - "/proc/self/maps: a 4096 MB ---p mapping appears on the first successful fetch (and on the first WebAssembly.Memory in a bare process); --wasm-max-mem-pages=16384 makes it 1024 MB"
    - "Same caps, same file, only the wasm page limit lowered: all 27 tests pass, VmSize 2.7-2.85 GB, RSS 186-227 MB"
    - "Heap snapshots after tests 2/14/27: no disposed session, board, scheduler, transport or log retained; heap after full GC 13.4 -> 16.9 MB (JIT code); no active handles between tests"
  falsification_test: "With the page limit set in the shared harness, the exact mandated command (ulimit -v 6000000, heap 1536 MB, node --test) must pass all tests of teamBoardView.test.js. If it still dies, or VmSize still creeps toward the cap test by test, the hypothesis is wrong and something does grow."
  fix_rationale: "The failure needs the address-space cap plus the 4 GiB reservation; the cap is the owner's safety rule and stays. The reservation is an unbacked up-front reservation sized by --wasm-max-mem-pages, not memory the parser uses (it works with 16 pages); lowering it in the test process before the first fetch gives the heap the room the cap intends, for every rig-based test file, without hiding real growth (the cap still bounds heap and RSS)."
  blind_spots: "A test that needs a WebAssembly memory larger than 128 MiB (resvg-wasm in agent graphics) would now fail with a RangeError if it imported the team harness; none does today. v8.setFlagsFromString after start-up depends on Node not freezing V8 flags (Node 24 keeps them writable); the tripwire test would show a change. Non-team test files that fetch still reserve 4 GiB; they are small today."
  candidate_causes:
    - "environment: ulimit -v caps address space, not memory, and V8 reserves 4 GiB for a wasm memory with no declared maximum"
    - "code (test harness): the rig's fetch to the fake NEAR server instantiates llhttp in every rig-based test process"
    - "code (product, ruled out): sessions, boards, schedulers or timers not released after dispose"
    - "data (ruled out): large failing-assertion output (boardDetail pattern)"
  and_gate: "yes: the crash needs (1) an address-space cap AND (2) the 4 GiB wasm reservation AND (3) enough tests in one process for V8 to grow its heap to its working size. (1) is the owner's safety rule, (3) is normal, so (2) is the one to change."

## Symptoms

expected: dist/test/teamBoardView.test.js runs all 27 tests with bounded memory under a 1536 MB heap cap
actual: 17 or 18 tests pass, then a child process dies with "Committing semi space failed. Allocation failed - JavaScript heap out of memory" during "a card that is not on the board is refused ..."; same with --max-old-space-size=3000
errors: "Committing semi space failed. Allocation failed - JavaScript heap out of memory"
reproduction: (ulimit -v 6000000; NODE_OPTIONS=--max-old-space-size=1536 timeout 300 node --test dist/test/teamBoardView.test.js)
started: before 62-13 (reproduced with the 62-12 boardView.ts); each test alone passes; skipping the first 4 or the 8 move-prompt tests passes

## Eliminated

- hypothesis: a TeamSession, board controller, sync scheduler, mirror or LiveTimers from earlier tests stays alive and accumulates (undisposed, or held by the vscode stub, a listener or a timer)
  evidence: heap snapshots after tests 2, 14 and 27 hold at most the current test's instance and none after the last test; no active handles after any test; heap after full GC stays 13-17 MB over 27 tests
  timestamp: 2026-11-02T22:25:00Z

- hypothesis: a helper child process (fake NEAR server, un-awaited git in closeRig) grows
  evidence: the process that dies is the per-file test process itself (node --test spawns one per file); its RSS is 165 MB at death and no handle survives a test
  timestamp: 2026-11-02T22:28:00Z

- hypothesis: a failing assertion prints a huge object (the boardDetail pattern)
  evidence: every test passes up to the crash, the crash comes between tests during ordinary heap growth, and the heap is 19 MB live at the last GC
  timestamp: 2026-11-02T22:28:00Z

## Evidence

- timestamp: 2026-11-02T22:05:00Z
  checked: whole file run directly (node --test-reporter=spec, in-process) under ulimit -v 6000000 and heap 1536 MB, sampling /proc/<pid>/status every 0.5 s and /usr/bin/time -v
  found: 16 tests pass, then "FATAL ERROR: Committing semi space failed. Allocation failed - JavaScript heap out of memory" at 45.8 s. Last GC line "Scavenge 42.4 (88.7) -> 19.3 (88.7) MB". Max RSS 165,624 KB. VmSize jumps from 1.45 GB to 5.74 GB within the first test, then creeps to 5.99 GB (the 6,000,000 KB ulimit) by test 17
  implication: the heap is 19 MB live and RSS is 165 MB when it dies; it is the virtual address space limit (ulimit -v) that runs out, not memory. That is also why --max-old-space-size=3000 failed the same way

- timestamp: 2026-11-02T22:08:00Z
  checked: preload probe reading /proc/self/maps; a bare node process; a node process that does one successful fetch() to a local http server
  found: bare node 1,375 MB VmSize; after the first successful fetch 5,550 MB with a new 4096 MB ---p (reserved, no access) mapping; a second fetch adds nothing. The tracer test shows the same 4096 MB ---p mapping by 0.5 s
  implication: undici (Node's fetch) instantiates its llhttp WebAssembly parser on the first connection and V8 reserves a 4 GB guarded wasm memory cage for trap-handler bounds checks. It is a one-time reservation with no RSS, but under ulimit -v 6000000 it leaves only about 400 MB of address space for everything else. The rig's fake NEAR server is reached with fetch (createRig -> NearOrgClient.createKey), so every real-git test file that uses the rig pays it

- timestamp: 2026-11-02T22:12:00Z
  checked: WebAssembly.Memory({initial:1}) in a bare process under several flags; --disable-wasm-trap-handler on the command line and in NODE_OPTIONS; --wasm-max-mem-pages=16384; require('node:v8').setFlagsFromString('--wasm-max-mem-pages=2048') at run time, then fetches of a 5 MB response and 20 x 3 MB POST bodies
  found: the first WebAssembly.Memory with no declared maximum reserves 4096 MB ---p whatever the trap-handler flags; a second memory with maximum 16 adds 1 MB. --wasm-max-mem-pages=16384 makes the reservation 1024 MB. Setting --wasm-max-mem-pages=2048 at run time before the first fetch makes it 128 MB and every fetch still works (VmSize 1,376 -> 1,618 MB)
  implication: V8 reserves the whole growth range of a wasm memory up front (the flag's page limit, 65536 pages = 4 GiB by default), so the reservation is controlled by --wasm-max-mem-pages and can be set from inside the test process before the first fetch

- timestamp: 2026-11-02T22:20:00Z
  checked: whole file in-process under the same caps with node --wasm-max-mem-pages=16384, a preload that logs after every test (with and without --expose-gc full GCs) heapUsed, heapTotal, RSS, VmSize, mappings and active handles
  found: all 27 tests pass (1:14). With full GCs heapUsed after GC goes 13.4 MB (test 1) -> 16.9 MB (test 27); without forced GC heapUsed swings 18-70 MB and heapTotal steps 33 -> 83 (test 10) -> 149 MB (test 18) then flat at 150-156 MB. VmSize 2,725 -> 2,854 MB, the growth matching the heapTotal steps. Active handles after every test: none (no timers, sockets, servers or child processes survive a test). Max RSS 186,500 KB (forced GC) and 226,760 KB (no forced GC)
  implication: memory is bounded. The step at test 17-18 is V8 growing the young generation to its normal working size; with only about 270 MB of address space left above the 4 GiB reservation that step's mmap fails, which V8 reports as "Committing semi space failed ... heap out of memory"

- timestamp: 2026-11-02T22:25:00Z
  checked: heap snapshots after tests 2, 14 and 27 (after a full GC), counted by constructor and diffed by self size
  found: TeamSession/BoardController/SyncScheduler/GitTransport/TeamLog: 3-4 nodes after tests 2 and 14 (one live instance plus the class and prototype), 2 after test 27 (class and prototype only, no instance). Total self size 18.5 MB -> 20.3 MB (2 -> 14) -> 20.6 MB (14 -> 27); the growth is JIT code (FeedbackVector, instruction streams, BytecodeArray). PerformanceResourceTiming entries from fetch: 101 (Node caps that buffer at 250)
  implication: no disposed session, board, scheduler, transport or log is retained; the vscode stub keeps at most the current test's objects. The suspects (undisposed sessions, timers, listeners, stub accumulation, growing buffers) are ruled out

- timestamp: 2026-11-02T22:28:00Z
  checked: the exact mandated command (ulimit -v 6000000; NODE_OPTIONS=--max-old-space-size=1536 timeout 300 /usr/bin/time -v node --test dist/test/teamBoardView.test.js) before any change
  found: 18 tests pass, then FATAL ERROR: Committing semi space failed in the file's child process at 48.6 s; peak RSS of any process 165,792 KB
  implication: reproduced exactly; the "child process" in the earlier note is the per-file process node --test spawns, not git or a helper

- timestamp: 2026-11-02T22:40:00Z
  checked: new src/test/teamHarnessAddressSpace.test.ts (imports the team harness, fetches a 4 MB response from a local server, then reads /proc/self/maps) before the fix
  found: RED in 70 ms at 126 MB RSS: "the largest reservations are 4096 MiB ---p, 512 MiB rwxp, 256 MiB ---p, 128 MiB ---p"
  implication: the tripwire reproduces the root cause directly and fails small and fast

- timestamp: 2026-11-02T22:45:00Z
  checked: after the fix (src/test/helpers/addressSpace.ts sets --wasm-max-mem-pages=2048 at load; imported first by teamHarness.ts and fakeNear.ts): the tripwire, the exact mandated command on the whole file, and the per-test probe
  found: tripwire GREEN (0.34 s, 123 MB). Exact command: 27 of 27 pass in 1:17, peak RSS 222,852 KB, exit 0. Per-test VmSize 1,829 -> 1,955 MB (was 5,738 -> 5,995 MB and dead), heapTotal flat at about 153 MB from test 18 on
  implication: the file now has about 3.9 GB of address-space headroom under the cap; the falsification test (whole file under the exact cap) passed

- timestamp: 2026-11-02T22:55:00Z
  checked: new guard test in teamBoardView.test.ts ("a replaced session is released while the board stays open"): one board for the whole test, session 1 on real unref'd timers, move and detail through the page, dispose and replace with session 2 the way restartSession does, full GC, WeakRef to session 1. Then two mutants on the compiled code: TeamSession.dispose without scheduler.stop(), and BoardController.sessionChanged without ensureSubscribed()
  found: GREEN on the real code (3.0 s, 114 MB); RED on both mutants ("the replaced session was released"); dist restored after each
  implication: a session left reachable by an armed poll timer or by the board's subscription (the two ways a long-running window could keep every session it ever had) now fails a test in 3 s, with a one-line message

- timestamp: 2026-11-02T23:30:00Z
  checked: every dist/test/team*.test.js alone (56 files) under the exact caps with /usr/bin/time -v, plus a NODE_OPTIONS preload that records each process's VmPeak and VmHWM at exit
  found: 55 files pass, highest peak RSS 225,952 KB (teamBoardView, 28 tests, 1:16.7), next teamImport 184,900 KB and teamMemberCommands 164,704 KB; no file comes near 1 GB. Highest VmPeak 2,023,140 kB (teamImport); no file process passes 3 GB, so none is still near the 6 GB cap. One failure: teamBoardLive tracer "the listener got the one new entry" (actual 0), which passed in 4 of 4 reruns
  implication: no other team file shows growth. The teamBoardLive failure is a separate race and has nothing to do with memory: GitTransport.syncLocked applies entries to this.current (src/team/gitTransport.ts:557), awaits savePin (line 560) and only then notifies listeners (line 561), so the test's until() on session.state() (teamBoardLive.test.ts:100) can see the block before the onStateChange listener ran (line 103). Recorded as its own deferred item

## Resolution

root_cause: "Not a leak: address-space exhaustion under the test cap. ulimit -v 6000000 limits reserved address space, and V8 reserves the whole growth range of a WebAssembly memory when it is made, 65536 pages = 4 GiB for a memory with no declared maximum. Node's fetch makes undici's llhttp parser (wasm) on its first connection; every rig-based team test fetches the fake NEAR server (src/test/helpers/teamFlowRig.ts createRig -> NearOrgClient.createKey, and enable/join for linked teams), so the per-file test process reserved 4 GiB at its first test. With node's own 1.4 GB of reservations that left about 270 MB under the cap, and V8's normal young-generation growth at test 17-18 (heapTotal 90 -> 150 MB) could not be mapped: 'Committing semi space failed ... JavaScript heap out of memory' with 19 MB live heap and 165 MB RSS."
fix: "src/test/helpers/addressSpace.ts calls v8.setFlagsFromString('--wasm-max-mem-pages=2048') at load (128 MiB reservation; the parser works with 16 pages). src/test/helpers/teamHarness.ts and src/test/helpers/fakeNear.ts import it first, so it runs before anything can fetch in every team test process. No product change: no session, board, scheduler or timer is retained (heap snapshots), and VS Code runs without an address-space cap."
oracle_type: specified (address-space bound on the largest reservation after a fetch; WeakRef plus full GC for the replaced session)
verification:
  regression_test: "src/test/teamHarnessAddressSpace.test.ts: RED before the fix (largest reservation 4096 MiB ---p, 70 ms, 126 MB RSS), GREEN after (0.24-0.34 s, 120-123 MB)"
  guard_test: "teamBoardView.test.ts 'a replaced session is released while the board stays open: no board subscription, listener or poll timer keeps it': GREEN on the real code, RED on two mutants (dispose without scheduler.stop(); sessionChanged without ensureSubscribed())"
  whole_file_before: "exact command: 18 of 27 pass, FATAL at 48.6 s, peak RSS 165,792 KB, VmSize 5,995,176 kB at death"
  whole_file_after: "exact command: 28 of 28 pass in 1:16.7, peak RSS 225,952 KB, VmPeak 2,006,012 kB; per-test VmSize 1,829 -> 1,955 MB, heapTotal flat about 153 MB"
  neighbours: "all 56 team*.test.js files alone under the caps: 55 pass, max peak RSS 225,952 KB, max VmPeak 2,023,140 kB; teamBoardLive's one failure is an unrelated pre-existing race (passed 4 of 4 reruns)"
  revert_check: "the before runs are the revert: the tripwire fails at once and the whole file dies at test 19 without addressSpace.ts"
  guardrail_verdict: accepted
files_changed: [src/test/helpers/addressSpace.ts, src/test/helpers/teamHarness.ts, src/test/helpers/fakeNear.ts, src/test/teamHarnessAddressSpace.test.ts, src/test/teamBoardView.test.ts]
