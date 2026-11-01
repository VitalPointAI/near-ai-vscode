---
status: diagnosed
trigger: "UAT G-60-1: Team status bar does not reliably move to 'Team sync paused: remote unreachable' on refused/stalled remote and back to 'Team: <name>' on recovery (3 automated real-window runs, inconsistent)"
created: 2026-11-01T16:00:00Z
updated: 2026-11-01T16:30:00Z
goal: find_root_cause_only
---

## Current Focus

hypothesis: CONFIRMED. The sync cadence follows SyncScheduler.focusedNow, a flag cached at construction/start() and changed only by onDidChangeWindowState events. In the automated real window those events report focus loss (and later active-only changes), so the session drops to the 120 s unfocused base (240 s / 480 s / 600 s once runs fail), longer than the harness waits (90/150/180 s). The status bar is not wrong, it is not polled. The harness flag UAT_FORCE_FOCUS only replaces vscode.window.state, which the scheduler reads only at construction and start(), so it cannot hold the 5 s cadence.
test: falsification run done (real window, focus-loss events ignored by the session): every step passes
expecting: n/a
next_action: return diagnosis (ROOT CAUSE FOUND) to the coordinator

## Symptoms

expected: With nearAi.team.pollSeconds=5 and the window focused, a refused remote shows "Team sync paused: remote unreachable" within a poll or two; a stalled remote shows it within ~60-75 s; restoring returns to "Team: <name>" within a poll or two.
actual: Run 1 (B not reported focused): refused paused 5 s; restored -> still paused after 120 s; stall listener got 0 connections in the next 3 min. Run 2 (UAT_FORCE_FOCUS=1): refused paused 5 s -> restored healthy 10 s -> stalled paused after 65 s (1 conn) -> restored STILL paused after 180 s. Run 3 (same settings): refused: stayed "Team: clone-a" 90 s; stalled: stayed "Team: clone-a" 150 s although 1 connection accepted and held; restored ok.
errors: None shown. Output channel in run 3 had only start lines + Verify report. No "Team sync failed" lines.
reproduction: Test 1 in UAT (automated real-window harness dist/test/e2e/teamUat.js, scenario B)
started: UAT 2026-11-01 after code-review fix pass (CR-01, WR-03, WR-06, WR-10, WR-12)

## Eliminated

- hypothesis: scheduler in-flight/follow-up state gets stuck after a failing or timed-out run
  evidence: node-level repro (real TeamSession, real timers, real git, focus always true) ran refused->restored->stalled->restored with 5 s / 10 s / 65 s / 10 s; a timer is pending after every run
  timestamp: 2026-11-01T16:05Z
- hypothesis: remote URL cached / set-url not seen / WR-12 GIT_CONFIG_* env stale
  evidence: every fetch spawn in every trace carries the CURRENT url in GIT_CONFIG_VALUE_0 (remoteUrl() runs git remote get-url --push on each call, gitTransport.ts:354-359, used at :511)
  timestamp: 2026-11-01T16:05Z
- hypothesis: backoff grows without reset / mirror lock never released after a timed-out op
  evidence: failures 1 -> 0 on the first healthy run; after the 60 s timeout the next fetch ran 10 s (or 20 s) later and succeeded, so withMirrorLock was released and the killed git left no state
  timestamp: 2026-11-01T16:05Z
- hypothesis: showStatus skipped when the state did not change / reason not mapped
  evidence: teamSession.ts:321 calls statusBar.update before the key comparison; every BAR update line in the traces matches the status; statusText maps every non-ok state to a paused text
  timestamp: 2026-11-01T16:05Z
- hypothesis: stale/disposed status bar item read by the harness
  evidence: trace shows a single TeamSession, BAR update lines always hit the item the harness reads, and the bar changed exactly when a sync ran
  timestamp: 2026-11-01T16:10Z

## Evidence

- timestamp: 2026-11-01T16:03Z
  checked: node-level repro, real TeamSession + real timers + real git, session focused throughout (dbg/r1-earlier-session.log)
  found: refused paused at 5.4 s, recovered 15.4 s (10 s backoff), stalled paused at 80.3 s (60 s git timeout, CR-01 kill works), recovered 90.3 s
  implication: transport, status mapping, backoff and CR-01 behave exactly per spec while the session believes the window is focused
- timestamp: 2026-11-01T15:53Z
  checked: instrumented real VS Code 1.144.0 run, unpatched scheduler (dbg2/real1-trace-earlier-session.log)
  found: 15:53:18.665 onDidChangeWindowState focused=false active=true -> focusChanged(false) -> schedule delay=120000. 15:54:12.063 a second event focused=false active=false -> focusChanged(false) again -> schedule delay=120000 again (pending poll pushed from 15:55:18 to 15:56:12). No timer fired and no git spawn from 15:53:18 to harness end 15:55:48; stalled step TIMED OUT at 150 s with "Team: clone-a" and 0 connections. Same signature as run 3.
  implication: status bar not polled, not wrong
- timestamp: 2026-11-01T16:09Z
  checked: FALSIFICATION real-window run, session ignores focus=false (dbg2/real2-trace-falsification.log)
  found: refused paused 5.01 s, restored 10.02 s, stalled paused 65.1 s, restored 20.5 s (all steps ok). Real window still lost focus at 16:11:13.244 (focused=false active=false) while a 20 s timer was pending with failures=2; unpatched that event would have set delay 480 s (nextDelay with focusedNow=false and 2 failures = 480000, verified) and the recovery step (90 s wait) would have timed out, which is run 2. The 20 s (not 10 s) is the follow-up run caused by a focus=true event at 16:11:00.232 arriving mid-fetch (followUp, second failed run, failures=2).
  implication: hypothesis confirmed by removing the cause
- timestamp: 2026-11-01T16:12Z
  checked: node-level focus-loss experiment with real timers (dbg2/r2-earlier-session.log): focusChanged(false) while a stalled fetch is in flight, then remote restored
  found: after the 8 s (shortened) timeout "TIMER set 240000 ms"; 60 s later still paused; a repeated focusChanged(false) did TIMER clear + TIMER set 240000 (re-armed); focusChanged(true) cleared the timer, fetched at once (0.1 s) and the bar returned to "Team: clone-a" in 0.3 s
  implication: run 2 reproduced; focus gain reliably forces a fresh run
- timestamp: 2026-11-01T16:20Z
  checked: fake-clock script on the compiled scheduler (dbg2/starve.js)
  found: (A) unfocused, no events, 1 h: 31 runs (every 120 s). (B) focusChanged(false) every 100 s for 1 h: 1 run (only the start run). (C) failing + unfocused delay 240 s, focusChanged(false) every 200 s for 1 h: 1 run. (D) focusChanged(true) x10 in 10 s while already focused: 11 runs (one fetch per event). (E) focusChanged(true) at 100 s while waiting for a 240 s timer: run at 100 s. (F) focused() callback true but no event: nextDelay stays 120000.
  implication: unchanged-focus events act as a trailing debounce on the poll timer (starvation possible); focusChanged(true) is a reliable immediate trigger but is also unthrottled for unchanged focus
- timestamp: 2026-11-01T16:22Z
  checked: vscode.d.ts (node_modules/@types/vscode/index.d.ts:11155-11159, 10974-10986) and vscodeStub fireWindowState
  found: onDidChangeWindowState fires "when the focus or activity state of the current window changes"; WindowState carries focused AND active. The stub (src/test/helpers/vscodeStub.ts:136) fires only {focused}, so no test ever delivers an event whose focus did not change
  implication: that is why the unit and session suites never saw the re-arm

## Resolution

root_cause: |
  Primary (explains all three runs): the poll cadence is a cached, event-driven focus flag. SyncScheduler.focusedNow (src/team/syncScheduler.ts:49) is read from the focused() callback only in the constructor (:54) and start() (:65); afterwards only focusChanged() writes it (:81-82), fed by vscode.window.onDidChangeWindowState (src/services/team/teamSession.ts:413). When the window is not focused, nextDelay() (:97-102) returns UNFOCUSED_POLL_MS (120 s), doubled per failed run (240/480/600 s). The automated real window loses OS focus (events at 15:53:18 and 16:11:13) so the session polls slower than the harness waits. UAT_FORCE_FOCUS replaces vscode.window.state only, which nothing reads after start(), so it has no effect on the cadence.
  Contributing product defect (real, small): focusChanged() (syncScheduler.ts:81-92) does not compare with the previous value. onDidChangeWindowState also fires for active-only changes (focused unchanged), and teamSession.ts:413 forwards every event. focusChanged(false) with unchanged focus clears and re-arms the pending poll for a full new interval (:90-91), a trailing debounce: a stream of events more often than the delay starves polling (fake-clock proof: 1 run in 1 h). focusChanged(true) with unchanged focus forces an immediate unthrottled run (11 runs for 10 events).
  Latent defects: (1) the window-state listener is registered only after `await TeamSession.start` (teamSession.ts:395-413), and start awaits the first sync (:197) which can take 60 s on a stalled remote, so a focus gain in that window is lost and focusedNow stays false because nothing re-reads focused(); (2) the cached flag can never self-correct.
  By design (documented and unit-tested): 120 s unfocused base (D-19, teamScheduler.test.ts:98), doubling per failure from that base up to 10 min (D-25, teamScheduler.test.ts:130), immediate run on focus gain (teamScheduler.test.ts:150, teamSession.test.ts:392).
fix: (not applied, root-cause-only)
verification: falsification real-window run with focus-loss ignored passed every step (5.0 / 10.0 / 65.1 / 20.5 s)
files_changed: []
