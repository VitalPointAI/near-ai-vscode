---
status: awaiting_human_verify
trigger: "teamConcurrency '3 forked clients sharing one mirror directory' failed once in a full npm test: lamport list [1..11, 11, 12, 13] instead of [1..14] (two events with lamport 11). Possible data-integrity race in the git transport; blocking until proven otherwise."
created: 2026-11-04T18:44:00Z
updated: 2026-11-04T19:33:00Z
bug_class: Heisenbug (timing-dependent interleaving of processes); Concurrency checklist first
---

## Current Focus

status_note: H1 confirmed, fixed (RED 2ce4981, GREEN 3e11c0e) and verified by tests. Waiting only for the owner's confirmation; no hands-on step is needed (nothing visible changes when two windows work normally).

reasoning_checkpoint:
  hypothesis: "Two processes on one team mirror interleave because the only mutex is in-process. appendExisting stamps lamport/prev from this.current (built up to this.lastProcessed) but takes the commit parent from a fresh read of the shared refs/team/coordination. When another process moved that ref forward in between, the commit is a fast-forward of the remote head, the push succeeds, and the event carries a stale lamport and a prev that does not name its parent."
  confirming_evidence:
    - "Stress run 2: 2 failures in 50, each with exactly one logged parent-newer-than-state mismatch followed by push outcome ok with the stale lamport (10). No failure without the log line, and no mismatch that landed without a failure."
    - "Code: gitTransport.ts:669 re-reads LOCAL_REF after fetchLocked; withMirrorLock is a module Map; product mirrors live at <globalStorage>/team/<teamId>/coordination.git, shared by every window of one install."
    - "materialize.ts:526 rejects prev != head, so the landed event is rejected by every reader while append returned ok (the children's results were all ok in the failing runs)."
  falsification_test: "With the parent taken from this.lastProcessed, a writer that moves the shared ref between the fetch and the commit must make the push lose the compare-and-swap (non-fast-forward) and the append retry from fresh state. If a duplicate lamport still lands, H1 is wrong or incomplete."
  fix_rationale: "Two layers. (1) Invariants that hold whatever another process does to the mirror: the parent is the commit the state was built from (this.lastProcessed); the entries read are those up to the commit this fetch produced (not the shared ref); the trusted head for the rewrite check is read before the fetch, so another process advancing it during the fetch cannot look like a rewrite. Then the remote's own compare-and-swap guarantees lamport/prev match the parent. (2) A per-mirror cross-process lock (exclusive file in the mirror folder, refreshed while held, taken over when the holder's process is gone or it stopped refreshing) restores the one-operation-at-a-time rule D-34 meant, so the shared pin and refs only move forward and two windows do not race at all."
  blind_spots: "Two processes in different PID namespaces with the same hostname sharing one globalStorage (not a supported VS Code setup) would see each other's pid as dead; a fork of the project with a different remote and the same team id would make two remotes share one mirror (pre-existing, out of scope). A holder stopped for more than the stale time (debugger pause) is taken over; layer (1) keeps data correct then."
  candidate_causes:
    - "code: parent re-read from a shared ref (H1, confirmed)"
    - "code: readRange end re-read from the shared ref, so state can run past lastProcessed and be applied twice (same mechanism, read side)"
    - "code: the fetch window, where another process moving LOCAL_REF between this process's reads of INCOMING and LOCAL looks like a rewrite and pauses Team Mode (same mechanism, status side)"
    - "environment/test: CPU load only widens the window; the test's temp dirs are unique per run (mkdtemp) and the children deliberately share one mirror, so this is not a harness collision"
  and_gate: "yes. Two conditions must hold together: two processes on the same mirror (shared globalStorage plus same team id) AND an interleaving where one moves the shared ref between the other's fetch and commit. Load makes the second likelier; neither alone causes the failure."

next_action: owner confirms; then the session can move to .planning/debug/resolved/. Open follow-up outside this session: src/test/teamGsdImport.test.ts pins HEAD's phase list to 60..67 and fails since fa76090 added Phase 62.1 to the roadmap (proven independent of this fix, see Evidence).

## Symptoms

expected: 3 forked clients sharing one mirror append 3 events each; the branch holds lamports 1..14 in commit and file-name order, every append ok, a fresh client accepts all 14.
actual: in one full `npm test` (1949 tests, 6G cap, machine loaded) the commit-order lamport list was [1..11, 11, 12, 13]. 3 of 3 passes alone.
errors: AssertionError deepEqual on the lamport list in src/test/teamConcurrency.test.ts (commitOrder vs wanted).
reproduction: full npm test under load; not yet reproduced alone.
started: first seen in the 0.6.3 code-server re-test debug session (board-codeserver-cards-and-drag.md) full run.

## Eliminated

- hypothesis: a test-harness artefact (shared temporary folders between test files, a timer, or CPU load alone)
  evidence: every fixture folder is a fresh mkdtemp, and the three children share one mirror on purpose (that is the scenario under test). The failure needs the interleaving the race log recorded (parent read newer than the state, push ok), and the same interleaving forced deterministically without any load (teamSharedMirror) lands the same stale event. Load only widens the window.
  timestamp: 2026-11-04T18:55:00Z

- hypothesis: only the commit parent is affected (one window)
  evidence: the step-by-step exploration also found the fetch window (false rewrite pause after step 4) and the range window (entries applied twice after step 8), so the fix covers all three and the lock covers the rest.
  timestamp: 2026-11-04T18:55:00Z

## Evidence

- timestamp: 2026-11-04T18:45:00Z
  checked: src/team/gitTransport.ts withMirrorLock (lines 95-112)
  found: the only serialisation is a module-level Map keyed by path.resolve(mirrorDir); it lives in one process. D-34 (60-CONTEXT) says "serialised by an in-process mutex" and relies on git ref CAS errors for cross-process races.
  implication: two processes on one mirror are not serialised; every multi-step read of a shared ref inside one operation can see another process's write.

- timestamp: 2026-11-04T18:46:00Z
  checked: product mirror path (teamSession.ts:228, join.ts:372, enable.ts:297; teamFile.ts teamStorageDir)
  found: mirrorDir = <globalStorage>/team/<teamId>/coordination.git. globalStorage is shared by every window of one VS Code (or code-server) install, and the key is the team id, not the project folder.
  implication: two windows open on two folders of the same team (two clones, a worktree and the main checkout, a multi-root workspace) each run an extension host process on the SAME mirror and pin.json. The shared-mirror test models a real product situation.

- timestamp: 2026-11-04T18:47:00Z
  checked: src/domain/team/materialize.ts:525-529
  found: a reader requires event.prev === head.eventId (else rejects 'prev does not name the log head') and lamport > highLamport.
  implication: an event built on stale state but committed on a newer parent is rejected by every reader, including the writer itself after its post-push fetch, while append() returned ok: true. That is a silently lost write plus a permanent rejection row in the team's shared log.

- timestamp: 2026-11-04T18:52:00Z
  checked: stress run 1 (instrumented dist/team/gitTransport.js; whole file, 8 parallel x 3 rounds, 6 CPU burners, MemoryMax=6G)
  found: 24 of 24 passed; the race log held 1 line: append-parent with parent != lastProcessed (state lamport 10). The direction and push outcome were not logged yet.
  implication: the window opens under load. That occurrence did not land (most likely a later CAS loss), so the log was extended with the direction and the push outcome.

- timestamp: 2026-11-04T18:58:00Z
  checked: stress run 2 (only the shared-mirror test, 10 parallel x 5 rounds, 10 CPU burners)
  found: 48 pass, 2 fail. Both failures: commit-order lamports [1..10, 10, 11, 12, 13] (the duplicate is 10 here; it was 11 in the full run). The race log held exactly 2 mismatches, both `direction: parent-newer-than-state`, both followed by `append-push-after-mismatch outcome: ok, lamports: [10]`. No `false-pause?` or `range-end-moved` lines.
  implication: H1 is CONFIRMED with a 1:1 match between the logged window and the failures. The writer was told ok (the test checks every child result is ok before it checks lamports, and that passed).

- timestamp: 2026-11-04T18:55:00Z
  checked: new deterministic tests src/test/teamSharedMirror.test.ts against the unfixed transport (a second writer injected right after the k-th git call of an append, k = 1, 2, ... until the append has no k-th call)
  found: both tests RED. (1) Lock-free writer moving the shared refs: after step 4 (rev-parse refs/team/incoming) the append returned paused "The team's coordination log was rewritten on the remote; Team Mode is paused" and the transport stayed paused; after step 8 (update-ref refs/team/coordination) the writer's state held 1 rejection where a fresh replay held 0 (entries applied twice); after steps 9-11 (log, cat-file --batch-check, cat-file --batch) an event landed that every reader rejects ("prev does not name the log head") and the remote positions ended ...,27,27. (2) A second GitTransport on the same folder by another path: it ran git inside the first append at every step 1-29, with the same pause, double-apply and stale-event outcomes at the same windows.
  implication: three windows of the same mechanism, all reachable by two windows of one VS Code on one team: a lost write reported as saved, a false "log rewritten" pause, and entries applied twice. All three are deterministic once the interleaving is forced.

- timestamp: 2026-11-04T19:10:00Z
  checked: the fix (src/team/gitTransport.ts, new src/team/mirrorProcessLock.ts) with the RED tests plus 4 new lock tests
  found: teamSharedMirror 6 of 6, teamGitTransport 37 of 37, teamLog 20 of 20, teamConcurrency 2 of 2. Mutants on the compiled output, whole file each: M1 (parent re-read from the shared ref) fails only the lock-free test, with "an event landed that every reader rejects: prev does not name the log head" and positions ...,25,25; M2 (range read to the shared ref) fails only that test with "an entry was applied twice"; M3 (trusted head read after the fetch) fails only that test with the false "log was rewritten" pause.
  implication: each invariant is held by its own deterministic test.

- timestamp: 2026-11-04T19:15:00Z
  checked: mutants of every other part, each on the compiled output with the whole teamSharedMirror file
  found: M4 (no cross-process lock): the two-transport test and 3 lock tests fail, the lock-free invariant test still passes (the invariants do not depend on the lock). M5 (no refresh): only the refresh test fails. M6 (no process-ended check): only the crash test fails. M7 (no age check): only the stale test fails. M8 (release removes any lock): only the takeover test fails. dist restored and compared byte for byte after the run.
  implication: every part of the fix is held by its own test. The M4 run also showed a failing lock test could leave its child holding the IPC channel and hang the file; the test now races the wait against the append and kills live holders in a root after hook (with M4 it now fails in 2 s and exits).

- timestamp: 2026-11-04T19:20:00Z
  checked: stress on the fix (same scripts and caps as before)
  found: whole teamConcurrency file, 20 copies in parallel with 8 CPU burners (load average 34 on 16 cores): 20 of 20 runs, 40 of 40 tests. The configuration that failed 2 of 50 before the fix (shared-mirror test, 10 parallel x 5 rounds, 10 burners): 50 of 50.
  implication: the original failure no longer reproduces under the load that produced it.

- timestamp: 2026-11-04T19:26:00Z
  checked: team family (node --test dist/test/team*.test.js, 75 files, 6G cap) and full npm test (6G cap)
  found: team family 1185 tests: 1182 pass, 2 skipped, 1 fail. Full npm test 1955 tests: 1943 pass, 11 skipped, 1 fail. Both failures are the same test, teamGsdImport "every plan committed at HEAD parses, and HEAD gives milestone v0.6.0 with phases 60 to 67", which reads this repository's own HEAD: actual phases include '62.1'. A bare shared clone in the scratchpad, with the test's git pointed at it by GIT_DIR, gives: HEAD at 7b33bbf (before the 62.1 roadmap commit) pass; HEAD at fa76090 (docs(62.1): add the board timeline phase, ROADMAP.md plus 62.1-CONTEXT.md only) fail; HEAD at 3e11c0e fail; same compiled code each time. Every teamSharedMirror and teamConcurrency test passes in the full run.
  implication: the one failure comes from another session's roadmap commit made in this worktree during this session, not from the transport. The test's hard-coded phase list needs '62.1' (that session's follow-up).

- timestamp: 2026-11-04T19:32:00Z
  checked: full e2e on the fix (xvfb-run -a node dist/test/e2e/run.js, 6G cap, Wayland variables unset, nothing else heavy running)
  found: exit 0, 90 of 90 (project 8, plain 2, team 7, team-lead 5, team-join 7, team-confirm 4, board 57), the same as the 62 baseline; every team launch syncs, invites, joins and moves cards through the locked transport in real VS Code windows.
  implication: the lock and the invariants work in the extension host with real windows; no wait, deadlock or leftover lock showed.

## Resolution

root_cause: "Every window of one VS Code keeps a team's coordination mirror in one folder (<globalStorage>/team/<teamId>/coordination.git), so two windows open on two folders of the same team (two clones, a worktree and the main checkout) are two processes on one mirror, and GitTransport's only lock (withMirrorLock) was in-process. Its operations re-read the mirror's shared refs between steps, so another process's fetch could move them mid-operation: (1) appendExisting took the commit parent from a fresh read of refs/team/coordination after the fetch had built the state, so an event stamped from older state (lamport, prev) was committed on a newer parent; the push was a fast-forward and the remote accepted it, the writer was told ok, and every reader (the writer too) rejects it with 'prev does not name the log head': a lost write reported as saved, two events with one lamport on the branch; (2) fetchLocked read the trusted head after the fetch, so a head another process fetched later looked like a rewrite and Team Mode paused with 'the coordination log was rewritten'; (3) fetchLocked read new entries up to the shared ref instead of the commit it fetched, so the state could run past lastProcessed and the next fetch applied those entries again (extra rejections, duplicate listener entries)."
fix: "(a) Invariants that hold whatever another process does to the mirror: the append's parent is this.lastProcessed (the commit the state was built from), so the remote's compare-and-swap refuses any push whose builder did not see the remote head; new entries are read up to the commit this fetch produced; the trusted head for the rewrite check is read before the fetch. (b) A cross-process lock per mirror (src/team/mirrorProcessLock.ts): an exclusively created file inside the mirror folder, taken inside the in-process lock by fetch, readAll and append; the holder refreshes its time every 5 s; a waiter takes it over at once when the holder's process has ended on this computer, or when it has not been refreshed for 60 s; a waiter that waited 120 s in total gives up: a sync then shows offline 'Another window on this computer is still syncing this team. Team sync will try again.' and an append returns busy 'Another window on this computer is still saving to this team. Try again in a moment.', writing nothing. Release removes only its own lock."
verification: "RED 2ce4981 fails both exploration tests at all three windows; GREEN 3e11c0e passes them. teamSharedMirror 6 of 6, teamGitTransport 37 of 37, teamLog 20 of 20, teamConcurrency 2 of 2. Eight mutants (three invariants, the lock, refresh, process-ended check, age check, release ownership) each fail only their own test. Stress: 20 parallel runs of teamConcurrency under load 20 of 20; the reproducing configuration 50 of 50 (was 48 of 50). Team family 1182 of 1185 pass, 2 skipped; full npm test 1943 of 1955 pass, 11 skipped; the single failure in both is teamGsdImport's HEAD phase list, proven caused by fa76090 (Phase 62.1 added to the roadmap) and not by this fix. tsc clean. Full e2e 90 of 90."
product_impact: "Before the fix, two VS Code windows on two folders of the same team on one computer (two clones, a worktree, or a multi-root workspace) could, when their syncs overlapped: (1) lose a write that the writer's window reported as saved (a card move, claim, block, role change, invitation or removal): the event lands on the branch with a stale position and every teammate's window rejects it ('prev does not name the log head', an output-channel line only), so the change silently disappears for everyone; the team log stays consistent and the same everywhere, but the rejected row stays in it permanently; (2) pause Team Mode with the alarm that the coordination log was rewritten, until the window is reloaded, when nothing was rewritten; (3) apply entries twice in one window, adding false rejection lines and listener entries. No forged or unsigned data could be accepted: readers reject the stale event. One window per team per computer, or different computers, were never affected."
files_changed: [src/team/gitTransport.ts, src/team/mirrorProcessLock.ts, src/test/teamSharedMirror.test.ts, src/test/helpers/mirrorLockChild.ts]
