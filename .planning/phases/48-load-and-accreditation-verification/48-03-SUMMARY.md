---
phase: 48-load-and-accreditation-verification
plan: 03
subsystem: loadtest
status: complete
tags: [load-test, theia-cloud, capacity, run-file, docs-check, keycloak-test-realm]
requires: []
provides:
  - "loadtest/ harness core (no dependencies): stage controller, cluster measurement, hashed run files, CLI"
  - "docs/hosting/capacity.md generated from committed load runs (no figure yet)"
  - "docs-site/test/capacityFigures.test.mjs: refuses hand-typed capacity figures"
affects: [48-04, 48-06, 48-09]
tech-stack:
  added: []
  patterns:
    - "injected I/O (kubectl argument arrays, Prometheus query_range, fetch, clock) with in-process fakes"
    - "run file hashed with compliance canonicalize; strict spec-driven reader"
key-files:
  created:
    - loadtest/package.json
    - loadtest/package-lock.json
    - loadtest/tsconfig.json
    - loadtest/README.md
    - loadtest/config.example.json
    - loadtest/realm/loadtest-realm.json
    - loadtest/src/runfile.ts
    - loadtest/src/stages.ts
    - loadtest/src/capacity.ts
    - loadtest/src/measure.ts
    - loadtest/src/service.ts
    - loadtest/src/keycloak.ts
    - loadtest/src/cli.ts
    - loadtest/test/runfile.test.ts
    - loadtest/test/stages.test.ts
    - loadtest/test/measure.test.ts
    - loadtest/test/clients.test.ts
    - loadtest/test/fixtures/run.ts
    - loadtest/test/fixtures/fakes.ts
    - loadtest/test/fixtures/cluster.ts
    - docs/hosting/capacity.md
    - docs-site/test/capacityFigures.test.mjs
  modified: []
key-decisions:
  - "Run file schema 1 at loadtest/runs/<yyyymmddThhmmssZ>-<rig>.run.json; raw values only (integers, ascending), percentiles computed by the page"
  - "Percentiles by nearest rank; p50 from n>=1, p95 from n>=20, p99 from n>=100, else 'n too small'; 'no samples' for n=0"
  - "Capacity-figure pattern narrowed twice from real tree hits: counts must be whole numbers before a plural noun; a size must share a clause with session/person/user. No allowlist."
  - "Secret refusal on run files uses matchRules (no allow-marker opt-out) plus a JWT pattern, because scanLine honours the allow marker and has no JWT rule"
  - "First stage not reached ends the run; later stages recorded as 'not attempted'; a burst that cannot hold is not reached for that burst only"
  - "Theia Cloud app id comes from THEIA_CLOUD_APP_ID, never a file; tokens held in memory only"
metrics:
  duration: "24 min"
  completed: 2026-11-24
estimate:
  tokens: 130065
  tasks: 3
actuals:
  tokens: 43500
  tasks: 3
  commits: 6
plan_head_before: bbba39932adf4539852b4ca61820babe371ff6f7
plan_head_after: 5f90724c1e717458319a77372d02cb2e95339017
---

# Phase 48 Plan 03: Load-test harness core Summary

This plan adds a load-test harness for Theia Cloud with no dependencies. A staged ramp, steady hold and burst controller drives the Theia Cloud service through injected clients. Every figure is read from the cluster's own records (kubectl JSON) and the site's Prometheus. Each run writes one strictly validated run file, hashed over its canonical form. The capacity page is generated only from `load` runs, and a docs check fails any capacity figure typed by hand anywhere in the published docs. Everything was tested offline against fakes; no load was run against any live service.

## Tasks

| Task | Name | RED commit | GREEN commit |
| ---- | ---- | ---------- | ------------ |
| 1 | Tracer: one stage through a hashed run file to the capacity page and docs check | b7216a70 | ea928004 |
| 2 | Measurement from cluster records and metrics; full stage controller; sizing defaults | d7062fdc | 4e9aabcd |
| 3 | Service and test-realm clients, CLI commands with refusals, test realm, README | a1fde074 | 5f90724c |

Tracer gate (auto mode): Task 1 `<verify>` was re-run end to end before expanding and passed (29/29, tsc clean).

## Run-file shape (schema 1)

`loadtest/runs/<UTC start yyyymmddThhmmssZ>-<rig>.run.json`, kind `load | experiment | dry-run`:

- Top level: `schema, kind, id, rig, startedAt, endedAt, inputs, hardware, versions, peakConcurrency, stages, hash`.
- `inputs`: `stages, burst, holdMs, activityIntervalMs, pollIntervalMs, rampConcurrency, startTimeoutMs, pendingLimitMs, maxFailedPercent, idleTimeoutMinutes, activeSample, profile {id, version, sha256}, appDefinition {name, image}, sessionsPerUser, testRealm {name, differences[]}`.
- `hardware`: `nodes[] {name, role, cpuMillicores, memoryBytes, maxPods}, storageClass, imagesPreloaded, network`.
- `versions`: `workbenchImage, theiaCloud {chart, commit, operatorImage}, keycloak, openbao, ingress {kind, version}, rke2, hub`.
- `stages[]`:
  - `target, reached, reason, window {start, end}` (the window is [start, end)), `sessions`
  - `start {requested, failed, timedOut, reconcileMs, readyMs, firstResponseMs}`, where each of the three durations is `{cold[], warm[]}`
  - `burst {size, reached, reason, peakConcurrency, window, start, reconcilesPer10s[]}`
  - `perPerson {active {sessions, cpuMillicores[], memoryBytes[], volumeBytes[]}, idle {sessions, cpuMillicores[], memoryBytes[]}}`
  - `ingress {samples[] {at, bytes, rules}, propagationMs[], propagationUnmeasured}`
  - `etcd {dbSizeBytes|null, objects|null}`
  - `queries[] {name, text, from, to}`
- Every number is a non-negative safe integer (ms, bytes, millicores) and every raw array is in ascending order. Stages are in ascending order of target, and Ingress samples in time order.
- `hash` = `sha256:` + SHA-256 of `canonicalize` (compliance/src/signed.ts) over everything except `hash`. Files are written pretty-printed with sorted keys, opened with `wx` (never overwritten), capped at 5 MiB, and refused if anything secret- or token-shaped appears.
- The reader refuses unknown keys, missing fields, fractions, negatives, an id not matching `<stamp>-<rig>`, and a file name that differs from its id.

## Percentile thresholds

- Nearest rank: the value at rank ceil(p/100 × n).
- p50 needs n ≥ 1, p95 needs n ≥ 20 and p99 needs n ≥ 100. Below that the page prints "n too small", and for n = 0 it prints "no samples". The run file always keeps the raw values, so n is always available.
- Sizing defaults per site size class (up to 250, 500 and 1,000 people, plus each higher stage reached) come from the latest load run that reached that stage:
  - memory per person: the active sample's p95 working set, rounded up to a multiple of 256 MiB;
  - workspace volume: the active sample's p95 volume use, doubled and rounded up to a whole GiB;
  - idle timeout: the value in the run's inputs, shown with the idle-session memory p95 and the cold Pod-Ready p95.
- A class whose stage was not reached prints "not measured".

## Capacity-figure pattern and the sentences that narrowed it

The final rule is applied per sentence. A Markdown table row, heading or list item counts as a sentence of its own, and the generated block is skipped. A sentence is flagged if either of these holds:

- **Count:** a whole number (with optional thousands separators) is followed, optionally through concurrent, simultaneous, active or parallel, by sessions, people, persons or users. The noun must be plural.
- **Size:** a number with GiB, MiB, TiB or vCPU sits in the same clause as session(s), person(s), people or user(s). Clauses are split at `, `, `;`, `: `, parentheses and spaced dashes.

The first strict version caught three real sentences in the published docs. None of them was a capacity claim, so I narrowed the pattern rather than allowlisting them:

1. `docs/security/threat-model.md:39` ("TLS 1.3 sessions bound to the connection"): a version number before "sessions". Counts are now whole numbers only.
2. `relay/README.md:247` ("120 session openings, 10 join requests ..."): a rate limit with "session" used as an adjective. Counts now need a plural noun.
3. `SECURITY.md:2398` ("At most 200 entries and 4 MiB per append, ... per address 120 session openings ..."): hub protocol limits where the size and "session" sit in different clauses. A size now has to share a clause with the noun.

All three are kept as regression cases in `capacityFigures.test.mjs`.

The docs check scans every file that `git ls-files` lists among `README.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `docs/**`, `docs-site/content/**`, the hub, relay and workbench READMEs, and `deploy/**` Markdown. Apart from those flags, it fails when any file holding a generated block differs from what the committed run files render, or when that block names a dry-run or a run file that does not exist.

## Verification

Tests run (verification results, not tests added):

- **Task 1 verify:** tsc clean; 29/29 passed (stages, runfile, capacityFigures).
- **Task 2 verify:** tsc clean; 20/20 passed (measure 11, stages 9).
- **Task 3 verify, run under the heavy lock:** tsc clean; 59/59 passed (all `loadtest/test/*.test.ts` plus `capacityFigures.test.mjs`); `cli verify --all` reported "0 run files verify"; `cli capacity --check` reported "matches 0 run files". Exit 0.
- **Tests added by this plan:**
  - runfile.test.ts: 12
  - stages.test.ts: 9
  - measure.test.ts: 11
  - clients.test.ts: 11
  - capacityFigures.test.mjs: 16

Acceptance greps:

- `capacity:begin` appears once in `capacity.md`.
- `package.json` has no dependencies.
- `findCapacityFigures` appears in the docs test.
- `query_range` appears 3 times in `measure.ts`.
- `interrupted` appears 5 times in `stages.ts`.
- `"loadtest-client"` appears once in the realm file.
- The README has 5 `##` sections.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Run-file secret refusal does not honour the scanner's allow marker, and adds a JWT check**
- **Found during:** Task 1.
- **Issue:** `scanLine` skips any line that contains `secret-scan: allow`, and the repository's secret rules have no JWT rule. A Keycloak access token (a JWT) or an allow-marker string could therefore have reached a committed run file, which breaks T-48-12.
- **Fix:** `refuseSecrets` uses `matchRules` from the same module (the same rules, with no opt-out) plus a JWT pattern local to `runfile.ts`.
- **Files modified:** loadtest/src/runfile.ts.
- **Commit:** ea928004.

**2. [Rule 1 - Bug] Test identities are never reused after a failed start**
- **Found during:** Task 2.
- **Issue:** The Task 1 ramp sliced people from the size of the bulk set. After a failed start, that slice could restart a user who already had a session.
- **Fix:** A separate person pointer is kept. A stage with too few users is "not reached" with the reason.
- **Files modified:** loadtest/src/stages.ts.
- **Commit:** 4e9aabcd.

**3. [Rule 3 - Blocking] The precondition `npm --prefix compliance ci --ignore-scripts` had not run**
- **Fix:** I ran it under the heavy lock, as the plan's execution notes direct, before Task 1.

**4. [Rule 2 - Security] The Theia Cloud app id is read from `THEIA_CLOUD_APP_ID`**
- **Issue:** The service checks `appId` as a shared auth value (research "Auth model"), so it does not belong in a config file or a run file.
- **Fix:** It is read only from the environment, and a test asserts it never appears in a run file.
- **Commit:** 5f90724c.

There were no architectural changes.

## Known Stubs

- `loadtest/src/stages.ts` passes `active: []` to `measure.steady`. The active-sample browser hook belongs to plan 48-04, so until it lands the per-person rows print "no samples" and the sizing defaults print "no samples" (the README says so).
- `loadtest/src/cli.ts` records the profile as `{ id: 'none', version: '0', sha256: '' }` when `config.profile` is null. The activity profile file arrives in 48-04.

These are intentional boundaries of this plan. Neither one produces a figure. I did not append them to `.planning/WINDOWS.md`: that ledger is optional, and a shared `.planning` file is outside this plan's files while other plans run in parallel. The orchestrator can add them.

## Notes for later plans

- **Phase 47 lock files are not in this tree yet.** `lockedOperatorDigest` follows the format Phase 47 fixed: a `built[]` entry `sterling/theia-cloud-operator` with a digest, otherwise an `images[].ref` that ends in a digest. While the lock is missing, `--kind load` is refused and a dry-run still works.
- **Rig facts to confirm in the 48-09 shakedown:**
  - Session resource name: `sessions.theia.cloud`.
  - Session-to-Deployment link: the Deployment's `ownerReferences` Session; the Pod is found by the Deployment-name prefix.
  - Operator argument: `--sessionsPerUser`.
  - Cold start: detected from the pod's `Pulling` event.
  - Route rules: the path regex is cut at its first `(`.
  - Versions: read from the running images, and "unknown" when an image is not found.
- **The docs site also publishes `.planning/research/`** under "architecture/design". By plan design that folder is outside the docs check. It holds the DESIGN 7 capacity estimates, which are marked "[estimate]" there (D-09).

## Threat Flags

None. The new surface (calls to the service, Keycloak, Prometheus and kubectl) is the plan's load generator to rig boundary, covered by T-48-12 and T-48-13.

## TDD Gate Compliance

Each task has a `test(48-03)` RED commit followed by a `feat(48-03)` GREEN commit that descends from it. I confirmed RED by running the tests before writing each implementation (missing modules, then failing assertions).

## Self-Check: PASSED

- All 22 created files exist.
- All six commits (b7216a70, ea928004, d7062fdc, 4e9aabcd, a1fde074, 5f90724c) are ancestors of HEAD.
