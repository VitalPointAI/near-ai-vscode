---
phase: 60
review: 60-REVIEW.md
titles: json
findings:
  - id: CR-01
    severity: critical
    disposition: open
    title: "`runGit` does not settle on timeout when git leaves a child process holding its pipes, which wedges all Team sync"
  - id: WR-01
    severity: warning
    disposition: open
    title: "Enable deletes the device key when an ambiguous push could not be confirmed either way"
  - id: WR-02
    severity: warning
    disposition: open
    title: "A throw from `transport.append` during Enable leaves the device key and mirror behind"
  - id: WR-03
    severity: warning
    disposition: open
    title: "One unexpected throw permanently poisons the `TeamSession.sync` chain"
  - id: WR-04
    severity: warning
    disposition: open
    title: "A failed snapshot write loses the entries the same sync already applied"
  - id: WR-05
    severity: warning
    disposition: open
    title: "Roster audit entries record the author's final role, not the role at that log position"
  - id: WR-06
    severity: warning
    disposition: open
    title: "A refused coordination log still shows a healthy \"Team: name\" status"
  - id: WR-07
    severity: warning
    disposition: open
    title: "The snapshot state hash covers version-dependent fields, so mixed-version teams will reject each other's snapshots"
  - id: WR-08
    severity: warning
    disposition: open
    title: "The signed `prev` field is never checked, so it adds no integrity"
  - id: WR-09
    severity: warning
    disposition: open
    title: "Enable fails with a misleading error for valid git branch names, and the two branch validators disagree"
  - id: WR-10
    severity: warning
    disposition: open
    title: "A missing coordination branch on the remote is reported as healthy even after a trusted log existed"
  - id: WR-11
    severity: warning
    disposition: open
    title: "The audit mirror progress mark lives in per-team global storage, so a second clone of the same team never receives roster entries"
  - id: WR-12
    severity: warning
    disposition: open
    title: "The remote URL, which may embed credentials, is passed on git's command line"
  - id: IN-01
    severity: info
    disposition: open
    title: "Event timestamps are format-checked only, and the audit mirror records the author's claimed time"
  - id: IN-02
    severity: info
    disposition: open
    title: "Email hashes are salted with a public value, so they can be confirmed by dictionary"
  - id: IN-03
    severity: info
    disposition: open
    title: "Reads use the push URL"
  - id: IN-04
    severity: info
    disposition: open
    title: "`update-ref LOCAL_REF` has no old-value guard across windows"
  - id: IN-05
    severity: info
    disposition: open
    title: "The status tooltip blames the remote for any sync failure"
  - id: IN-06
    severity: info
    disposition: open
    title: "`commitFiles` drops the original failure when cleanup also fails"
open: 19
total: 19
recorded: 2026-11-01T14:05:26.178Z
---

# Phase 60: Code Review Disposition

| Finding | Severity | Disposition | Source |
|---------|----------|-------------|--------|
| CR-01 | critical | open | - |
| WR-01 | warning | open | - |
| WR-02 | warning | open | - |
| WR-03 | warning | open | - |
| WR-04 | warning | open | - |
| WR-05 | warning | open | - |
| WR-06 | warning | open | - |
| WR-07 | warning | open | - |
| WR-08 | warning | open | - |
| WR-09 | warning | open | - |
| WR-10 | warning | open | - |
| WR-11 | warning | open | - |
| WR-12 | warning | open | - |
| IN-01 | info | open | - |
| IN-02 | info | open | - |
| IN-03 | info | open | - |
| IN-04 | info | open | - |
| IN-05 | info | open | - |
| IN-06 | info | open | - |

Dispositions: `open` (recorded, not yet triaged), `fixed`, `skipped`, `deferred`.
Set `deferred` by hand and put the reason in the Source cell; both are preserved. A `|` in the reason is kept as prose and escaped on the next run.
Re-running the gate keeps every row it can. A row the current review no longer reports is kept and its Source cell flagged, so a finding does not leave this record silently. ONE exception: when a finding id is REUSED by a different finding, the earlier decision cannot keep a row — the id is taken — and it is dropped. A RECORDED decision (anything but `open`) is named on the console when that happens; a row still at `open` is replaced silently, because `open` records no decision to lose.
